import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { isIndianaNativePacEnabled } from "../../config/featureFlags.js";
import { inCheck } from "./indianaNativeProtocol.js";
import {
  loadIndianaNativeReceiver,
  type IndianaNativeReceiver,
} from "./indianaNativeReceiver.js";
import {
  isVerifiedIndianaNativePacPacket,
  validateIndianaNativePacClosure,
  validateIndianaNativePacFacts,
  type IndianaNativePacPacket,
  type IndianaNativePacGroup,
  type IndianaNativePacFacts,
  type IndianaNativePacControls,
} from "./indianaNativePacSource.js";

export function readIndianaNativeStoredPac(
  source: Record<string, unknown>,
  donors: readonly Record<string, unknown>[],
  receiver: IndianaNativeReceiver,
): IndianaNativePacPacket {
  const groups: IndianaNativePacGroup[] = donors
    .map((d) => ({
      key: String(d.donor_key),
      name: String(d.reported_name),
      cashCents: Number(d.cash_cents),
      inKindCents: Number(d.in_kind_cents),
      occurrences: Number(d.occurrence_count),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const controls = source.aggregation_controls as IndianaNativePacControls,
    facts = source.source_facts as IndianaNativePacFacts;
  inCheck(
    source.link_id === receiver.linkId &&
      Number(source.election_year) === receiver.electionYear &&
      source.candidate_id === receiver.candidateId &&
      source.election_id === receiver.electionId &&
      isDeepStrictEqual(source.receiver_context, receiver),
    "stored_native_pac_context_changed",
  );
  validateIndianaNativePacClosure(controls, groups);
  validateIndianaNativePacFacts(facts);
  inCheck(
    new Date(String(source.source_observed_at)).toISOString() ===
      facts.observedAt &&
      new Date(String(source.source_completed_at)).toISOString() ===
        facts.completedAt &&
      Date.parse(String(source.last_synced_at)) >=
        Date.parse(facts.completedAt),
    "stored_native_pac_clock_conflict",
  );
  return { receiver, groups, controls, facts };
}
/** Only fully source-branded packets enter this transaction. Any failed gate
 * or SQL operation preserves all prior components and legacy direct money. */
export async function writeIndianaNativePac(input: {
  db: Pick<Pool, "query" | "connect">;
  packet: IndianaNativePacPacket;
}) {
  inCheck(isIndianaNativePacEnabled(), "native_pac_disabled");
  const p = input.packet;
  inCheck(isVerifiedIndianaNativePacPacket(p), "unverified_native_pac_packet");
  validateIndianaNativePacClosure(p.controls, p.groups);
  validateIndianaNativePacFacts(p.facts);
  const c = await input.db.connect();
  let begun = false;
  try {
    await c.query("BEGIN");
    begun = true;
    const current = await loadIndianaNativeReceiver(c, p.receiver.linkId, true);
    inCheck(
      current && isDeepStrictEqual(current, p.receiver),
      "native_pac_canonical_context_changed",
    );
    const existing = await c.query<Record<string, unknown>>(
      "SELECT to_jsonb(s) AS stored FROM public.in_native_pac_sources s WHERE link_id=$1 AND election_year=$2 FOR UPDATE",
      [current.linkId, current.electionYear],
    );
    if (existing.rows.length) {
      const old = existing.rows[0]!.stored as Record<string, unknown>;
      inCheck(
        Date.parse(String(old.source_observed_at)) <=
          Date.parse(p.facts.observedAt),
        "native_pac_source_regression",
      );
      const donors = await c.query<Record<string, unknown>>(
        "SELECT * FROM public.in_native_pac_donors WHERE link_id=$1 AND election_year=$2 ORDER BY donor_key",
        [current.linkId, current.electionYear],
      );
      let stored: IndianaNativePacPacket | null = null;
      try {
        stored = readIndianaNativeStoredPac(old, donors.rows, current);
      } catch {
        /* A qualified source can repair a corrupt component atomically. */
      }
      if (stored && isDeepStrictEqual(stored, p)) {
        await c.query("COMMIT");
        begun = false;
        return { groups: p.groups.length, idempotent: true };
      }
    }
    await c.query(
      `INSERT INTO public.in_native_pac_sources(link_id,election_year,candidate_id,election_id,receiver_context,source_facts,aggregation_controls,source_observed_at,source_completed_at,last_synced_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10)
      ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiver_context=EXCLUDED.receiver_context,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,source_completed_at=EXCLUDED.source_completed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [
        current.linkId,
        current.electionYear,
        current.candidateId,
        current.electionId,
        JSON.stringify(current),
        JSON.stringify(p.facts),
        JSON.stringify(p.controls),
        p.facts.observedAt,
        p.facts.completedAt,
        new Date().toISOString(),
      ],
    );
    await c.query(
      "DELETE FROM public.in_native_pac_donors WHERE link_id=$1 AND election_year=$2",
      [current.linkId, current.electionYear],
    );
    if (p.groups.length)
      await c.query(
        `INSERT INTO public.in_native_pac_donors(link_id,election_year,donor_key,reported_name,cash_cents,in_kind_cents,occurrence_count)
      SELECT $1::uuid,$2::int,x.key,x.name,x.cash_cents,x.in_kind_cents,x.occurrences FROM jsonb_to_recordset($3::jsonb) x(key text,name text,cash_cents bigint,in_kind_cents bigint,occurrences int)`,
        [
          current.linkId,
          current.electionYear,
          JSON.stringify(
            p.groups.map((g) => ({
              key: g.key,
              name: g.name,
              cash_cents: g.cashCents,
              in_kind_cents: g.inKindCents,
              occurrences: g.occurrences,
            })),
          ),
        ],
      );
    await c.query("COMMIT");
    begun = false;
    return { groups: p.groups.length, idempotent: false };
  } catch (e) {
    if (begun) await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

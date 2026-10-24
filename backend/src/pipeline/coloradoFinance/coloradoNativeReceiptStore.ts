import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  isColoradoNativeReceiptsEnabled,
  isColoradoCampaignFinanceSyncEnabled,
} from "../../config/featureFlags.js";
import { coloradoReceiptCheck as check } from "./coloradoNativeReceiptReports.js";
import { coloradoReportDate } from "./coloradoTracerReports.js";
import { coloradoSourceDay } from "./coloradoTracerObservations.js";
import {
  coloradoIeNativeDistrict,
  coloradoIeNativeOffice,
  coloradoPartyKey,
} from "./coloradoNativeCandidateIdentity.js";
import {
  lockColoradoIeReceiver,
  validateColoradoIeReceiverIdentity,
  type ColoradoIeReceiver,
} from "./coloradoReportedIeReceiver.js";
import { validateColoradoNativeReceiptClosure } from "./coloradoNativeReceiptAggregation.js";
import {
  CO_NATIVE_RECEIPTS_REVISION,
  isVerifiedColoradoNativeReceiptsPacket,
  type ColoradoNativeReceiptsPacket,
} from "./coloradoNativeReceiptSource.js";
import type { ColoradoSourceFacts } from "./coloradoReportedIeSource.js";
const iso = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export function validateColoradoReceiptFacts(
  f: ColoradoSourceFacts,
  max: number,
): void {
  check(
    f &&
      /^packet-[a-f0-9-]{36}$/u.test(f.packetDirectory) &&
      /^[a-f0-9]{64}$/u.test(f.manifestSha256) &&
      iso(f.observedAt) &&
      iso(f.completedAt) &&
      f.observedAt <= f.completedAt &&
      Date.parse(f.completedAt) <= Date.now() + 300000 &&
      Date.parse(f.completedAt) - Date.parse(f.observedAt) <= 7200000 &&
      Array.isArray(f.originals) &&
      f.originals.length > 0 &&
      f.originals.length <= max,
    "receipt_stored_source_facts",
  );
  let edge = f.observedAt;
  for (const [i, r] of f.originals.entries()) {
    check(
      r &&
        r.file === `${String(i + 1).padStart(4, "0")}.response` &&
        /^[a-f0-9]{64}$/u.test(r.sha256) &&
        Number.isSafeInteger(r.bytes) &&
        r.bytes >= 0 &&
        r.bytes <= 64 * 1024 * 1024 &&
        iso(r.startedAt) &&
        iso(r.completedAt) &&
        r.startedAt >= edge &&
        r.completedAt >= r.startedAt &&
        r.completedAt <= f.completedAt,
      "receipt_stored_original_facts",
    );
    edge = r.completedAt;
  }
  check(
    f.originals[0]!.startedAt === f.observedAt && edge === f.completedAt,
    "receipt_stored_source_clocks",
  );
}
export function validateColoradoNativeReceiptPacket(
  p: ColoradoNativeReceiptsPacket,
): void {
  const { receiver: r, identity: i, facts: f, controls: c } = p;
  validateColoradoIeReceiverIdentity(r, i);
  validateColoradoNativeReceiptClosure(p);
  check(
    f?.revision === CO_NATIVE_RECEIPTS_REVISION &&
      i.receivingId === r.receivingId &&
      (!r.tracerCandidateId || i.candidateId === r.tracerCandidateId) &&
      /^[1-9]\d{0,19}$/u.test(i.candidateId) &&
      i.cycleYear === r.electionYear &&
      i.officeName === r.officeName &&
      i.party === coloradoPartyKey(r.party),
    "receipt_stored_native_identity",
  );
  const district = coloradoIeNativeDistrict(r);
  check(
    !district ||
      (i.districtName === district &&
        i.nativeOfficeName === coloradoIeNativeOffice(r.officeName)),
    "receipt_stored_native_district",
  );
  check(
    coloradoReportDate(i.cycleStart) === i.cycleStart &&
      coloradoReportDate(i.cycleEnd) === i.cycleEnd &&
      i.cycleStart >= `${r.electionYear - 4}-01-01` &&
      i.cycleStart <= r.electionDate &&
      i.cycleEnd >= r.electionDate &&
      Number(i.cycleEnd.slice(0, 4)) === r.electionYear &&
      f.cycleStart === i.cycleStart &&
      coloradoReportDate(f.regularThrough) === f.regularThrough &&
      coloradoReportDate(f.sourceThrough) === f.sourceThrough &&
      f.cycleStart <= f.regularThrough &&
      f.regularThrough <= f.sourceThrough &&
      f.regularThrough <= i.cycleEnd,
    "receipt_stored_cycle",
  );
  validateColoradoReceiptFacts(f.registry, 256);
  validateColoradoReceiptFacts(f.receipts, 2048);
  check(
    f.registry.originals.length >= 219 &&
      f.receipts.originals.length >=
        31 + 14 * c.regularReports + 12 * c.coveredNotices &&
      f.sourceThrough === coloradoSourceDay(f.registry.observedAt) &&
      f.sourceThrough === coloradoSourceDay(f.receipts.observedAt),
    "receipt_stored_complete_observations",
  );
}
const clock = (v: unknown) =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
export function readColoradoNativeReceiptPacket(
  s: Record<string, unknown>,
  donors: readonly Record<string, unknown>[],
  receiver: ColoradoIeReceiver,
): ColoradoNativeReceiptsPacket {
  check(
    s.link_id === receiver.linkId &&
      Number(s.election_year) === receiver.electionYear &&
      s.candidate_id === receiver.candidateId &&
      s.election_id === receiver.electionId &&
      isDeepStrictEqual(s.receiver_context, receiver),
    "receipt_stored_context_changed",
  );
  const p: ColoradoNativeReceiptsPacket = {
    receiver,
    identity: s.native_identity as ColoradoNativeReceiptsPacket["identity"],
    facts: s.source_facts as ColoradoNativeReceiptsPacket["facts"],
    controls:
      s.aggregation_controls as ColoradoNativeReceiptsPacket["controls"],
    groups: donors
      .map((d) => ({
        key: String(d.reported_key),
        name: String(d.reported_name),
        cashCents: Number(d.cash_cents),
        occurrences: Number(d.occurrence_count),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
  validateColoradoNativeReceiptPacket(p);
  const observed = [
      p.facts.registry.observedAt,
      p.facts.receipts.observedAt,
    ].sort()[0]!,
    completed = [p.facts.registry.completedAt, p.facts.receipts.completedAt]
      .sort()
      .at(-1)!;
  check(
    clock(s.source_observed_at) === observed &&
      clock(s.source_completed_at) === completed &&
      Date.parse(clock(s.last_synced_at)) >= Date.parse(completed) &&
      Date.parse(clock(s.last_synced_at)) <= Date.now() + 300000,
    "receipt_stored_clock_conflict",
  );
  return p;
}
export async function writeColoradoNativeReceipts(input: {
  db: Pick<Pool, "connect">;
  packet: ColoradoNativeReceiptsPacket;
}) {
  check(
    isColoradoNativeReceiptsEnabled() && isColoradoCampaignFinanceSyncEnabled(),
    "native_receipt_write_disabled",
  );
  const p = input.packet;
  check(
    isVerifiedColoradoNativeReceiptsPacket(p),
    "unverified_native_receipt_packet",
  );
  validateColoradoNativeReceiptPacket(p);
  const observed = [
      p.facts.registry.observedAt,
      p.facts.receipts.observedAt,
    ].sort()[0]!,
    completed = [p.facts.registry.completedAt, p.facts.receipts.completedAt]
      .sort()
      .at(-1)!;
  check(
    Date.now() - Date.parse(observed) <= 36 * 3600000,
    "stale_native_receipt_write_source",
  );
  const c = await input.db.connect();
  let begun = false;
  try {
    await c.query("BEGIN");
    begun = true;
    await lockColoradoIeReceiver(c, p.receiver);
    const r = p.receiver;
    const old = (
      await c.query<Record<string, unknown>>(
        "SELECT * FROM public.co_native_receipt_sources WHERE link_id=$1 AND election_year=$2 FOR UPDATE",
        [r.linkId, r.electionYear],
      )
    ).rows[0];
    if (old) {
      const previous =
        old.source_facts as ColoradoNativeReceiptsPacket["facts"];
      check(
        previous?.registry?.observedAt <= p.facts.registry.observedAt &&
          previous?.registry?.completedAt <= p.facts.registry.completedAt &&
          previous?.receipts?.observedAt <= p.facts.receipts.observedAt &&
          previous?.receipts?.completedAt <= p.facts.receipts.completedAt,
        "receipt_source_regression",
      );
      const donors = (
        await c.query<Record<string, unknown>>(
          "SELECT * FROM public.co_native_receipt_donors WHERE link_id=$1 AND election_year=$2 ORDER BY reported_key",
          [r.linkId, r.electionYear],
        )
      ).rows;
      let prior: ColoradoNativeReceiptsPacket | undefined;
      try {
        prior = readColoradoNativeReceiptPacket(old, donors, r);
      } catch {
        /* A complete source can repair the component atomically. */
      }
      if (prior && isDeepStrictEqual(prior, p)) {
        await c.query("COMMIT");
        begun = false;
        return { groups: p.groups.length, idempotent: true };
      }
    }
    await c.query(
      `INSERT INTO public.co_native_receipt_sources(link_id,election_year,candidate_id,election_id,receiver_context,native_identity,source_facts,aggregation_controls,source_observed_at,source_completed_at,last_synced_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
      ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiver_context=EXCLUDED.receiver_context,native_identity=EXCLUDED.native_identity,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,source_completed_at=EXCLUDED.source_completed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [
        r.linkId,
        r.electionYear,
        r.candidateId,
        r.electionId,
        JSON.stringify(r),
        JSON.stringify(p.identity),
        JSON.stringify(p.facts),
        JSON.stringify(p.controls),
        observed,
        completed,
        new Date().toISOString(),
      ],
    );
    await c.query(
      "DELETE FROM public.co_native_receipt_donors WHERE link_id=$1 AND election_year=$2",
      [r.linkId, r.electionYear],
    );
    if (p.groups.length)
      await c.query(
        `INSERT INTO public.co_native_receipt_donors(link_id,election_year,reported_key,reported_name,cash_cents,occurrence_count)
      SELECT $1::uuid,$2::integer,x.key,x.name,x.cash,x.occurrences FROM jsonb_to_recordset($3::jsonb) x(key text,name text,cash bigint,occurrences integer)`,
        [
          r.linkId,
          r.electionYear,
          JSON.stringify(
            p.groups.map((g) => ({
              key: g.key,
              name: g.name,
              cash: g.cashCents,
              occurrences: g.occurrences,
            })),
          ),
        ],
      );
    await c.query("COMMIT");
    begun = false;
    return { groups: p.groups.length, idempotent: false };
  } catch (error) {
    if (begun)
      try {
        await c.query("ROLLBACK");
      } catch {
        /* Preserve the original failure. */
      }
    throw error;
  } finally {
    c.release();
  }
}

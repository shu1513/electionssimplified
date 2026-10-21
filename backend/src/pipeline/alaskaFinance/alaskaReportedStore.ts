import { akManifestHash } from "./alaskaReportedOriginals.js";
import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { akAdd, akCheck, akKey, akPublicUrl } from "./alaskaReportedNative.js";
import { akPersonMatches } from "./alaskaReportedNative.js";
import { akCanonicalHouseDistrict } from "./alaskaReportedReceiver.js";
import type {
  AlaskaReportedReceiver,
  AlaskaReportedReceivingContext,
} from "./alaskaReportedReceiver.js";
import {
  isVerifiedAlaskaReportedPacket,
  type AlaskaReportedPacket,
  type AlaskaReportedSourceFacts,
  type AlaskaReportedControls,
} from "./alaskaReportedSource.js";
import { loadAlaskaReportedReceiver } from "./alaskaReportedEligibility.js";

export const AK_REPORTED_REVISION = "ak-current-native-v3";
export type AlaskaReportedComponent = "committee" | "ie";
export type AlaskaStoredGroup = {
  key: string;
  reportedName: string;
  stance: "committee" | "support" | "oppose";
  amountCents: number;
  occurrenceCount: number;
};
export type AlaskaStoredControls = AlaskaReportedControls;
export type AlaskaStoredFacts = {
  revision: string;
  year: number;
  component: AlaskaReportedComponent;
  source: AlaskaReportedSourceFacts;
};
export type AlaskaStoredComponent = {
  receiver: AlaskaReportedReceiver;
  receiving: AlaskaReportedReceivingContext;
  facts: AlaskaStoredFacts;
  controls: AlaskaStoredControls;
  groups: AlaskaStoredGroup[];
  observedAt: string;
  completedAt: string;
  syncedAt: string;
};
const integer = (n: unknown, positive = false): n is number =>
  Number.isSafeInteger(n) && Number(n) >= (positive ? 1 : 0);
const iso = (s: unknown): s is string =>
  typeof s === "string" &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString() === s;
export function validateAlaskaStoredClosure(
  kind: AlaskaReportedComponent,
  controls: AlaskaStoredControls,
  groups: readonly AlaskaStoredGroup[],
): void {
  const keys = [
    "totalAmountCents",
    "occurrenceCount",
    "sourceRows",
    "excludedRows",
    "debtRows",
    "supportCents",
    "opposeCents",
  ];
  akCheck(
    controls &&
      isDeepStrictEqual(Object.keys(controls).sort(), keys.sort()) &&
      Object.values(controls).every((n) => integer(n)),
    "stored_controls",
  );
  const seen = new Set<string>();
  let total = 0,
    count = 0,
    support = 0,
    oppose = 0;
  for (const g of groups) {
    akCheck(
      g &&
        typeof g.reportedName === "string" &&
        g.reportedName.length > 0 &&
        g.reportedName.length <= 4000 &&
        g.key === akKey(g.reportedName) &&
        integer(g.amountCents) &&
        integer(g.occurrenceCount, true) &&
        (kind === "committee"
          ? g.stance === "committee"
          : ["support", "oppose"].includes(g.stance)),
      "stored_group",
    );
    const key = `${g.stance}:${g.key}`;
    akCheck(!seen.has(key), "duplicate_stored_group");
    seen.add(key);
    total = akAdd(total, g.amountCents);
    count = akAdd(count, g.occurrenceCount);
    if (g.stance === "support") support = akAdd(support, g.amountCents);
    if (g.stance === "oppose") oppose = akAdd(oppose, g.amountCents);
  }
  akCheck(
    total === controls.totalAmountCents &&
      count === controls.occurrenceCount &&
      support === controls.supportCents &&
      oppose === controls.opposeCents &&
      controls.sourceRows ===
        akAdd(akAdd(count, controls.excludedRows), controls.debtRows),
    "stored_full_closure",
  );
  akCheck(
    kind === "committee"
      ? controls.debtRows === 0 && support === 0 && oppose === 0
      : controls.excludedRows === 0,
    "stored_metric_scope",
  );
}
function validateFacts(f: AlaskaReportedSourceFacts): void {
  akCheck(
    f &&
      /^[a-f0-9]{64}$/.test(f.manifestSha256) &&
      iso(f.observedAt) &&
      iso(f.completedAt) &&
      f.completedAt >= f.observedAt &&
      Array.isArray(f.observations) &&
      f.observations.length > 0 &&
      f.observations.length <= 50000,
    "stored_source_facts",
  );
  for (const o of f.observations) {
    akPublicUrl(o.url, o.url);
    akCheck(
      ["GET", "POST"].includes(o.method) &&
        o.status === 200 &&
        o.eof === true &&
        integer(o.bytes) &&
        o.bytes <= 128 * 1024 * 1024 &&
        /^[a-f0-9]{64}$/.test(o.sha256) &&
        typeof o.contentType === "string" &&
        /^(?:text\/|application\/(?:octet-stream|csv|vnd\.ms-excel))/i.test(
          o.contentType,
        ) &&
        iso(o.startedAt) &&
        iso(o.completedAt) &&
        o.completedAt >= o.startedAt &&
        o.startedAt >= f.observedAt &&
        o.completedAt <= f.completedAt,
      "stored_source_observation",
    );
  }
  akCheck(
    f.observations.map((o) => o.startedAt).sort()[0] === f.observedAt &&
      f.observations
        .map((o) => o.completedAt)
        .sort()
        .at(-1) === f.completedAt,
    "stored_source_clock_closure",
  );
  akCheck(
    akManifestHash(f.observations) === f.manifestSha256,
    "stored_manifest_integrity",
  );
}
export function validateAlaskaStoredComponent(
  value: AlaskaStoredComponent,
  expected: AlaskaReportedReceiver,
  kind: AlaskaReportedComponent,
): void {
  akCheck(
    isDeepStrictEqual(value.receiver, expected),
    "stored_receiving_context_changed",
  );
  const c = value.receiving,
    d = akCanonicalHouseDistrict(expected);
  akCheck(
    expected.activeCandidateOwnerCount === 1 &&
      expected.linkOfficeName === expected.officeName &&
      c &&
      c.receivingId === expected.receivingId &&
      c.officeName === expected.officeName &&
      c.district === d &&
      c.electionYear === expected.electionYear &&
      akPersonMatches(expected.candidateAliases, c.candidateName, [
        expected.firstName,
      ]) &&
      typeof c.committeeName === "string" &&
      c.committeeName.length > 0,
    "stored_native_receiving_context",
  );
  akCheck(
    value.facts?.revision === AK_REPORTED_REVISION &&
      value.facts.year === expected.electionYear &&
      value.facts.component === kind,
    "stored_source_scope",
  );
  validateFacts(value.facts.source);
  const observed = value.facts.source.observedAt,
    completed = value.facts.source.completedAt;
  akCheck(
    value.observedAt === observed &&
      value.completedAt === completed &&
      iso(value.syncedAt) &&
      value.syncedAt >= completed &&
      Date.parse(value.syncedAt) <= Date.now(),
    "stored_component_clock",
  );
  validateAlaskaStoredClosure(kind, value.controls, value.groups);
}
export function buildAlaskaReportedComponent(
  receiver: AlaskaReportedReceiver,
  packet: AlaskaReportedPacket,
): AlaskaStoredComponent {
  akCheck(
    isVerifiedAlaskaReportedPacket(packet) &&
      isDeepStrictEqual(receiver, packet.receiver),
    "unverified_source",
  );
  const result: AlaskaStoredComponent = {
    receiver,
    receiving: packet.receiving,
    facts: {
      revision: AK_REPORTED_REVISION,
      year: receiver.electionYear,
      component: packet.component,
      source: packet.source,
    },
    controls: packet.controls,
    groups: packet.groups,
    observedAt: packet.source.observedAt,
    completedAt: packet.source.completedAt,
    syncedAt: new Date().toISOString(),
  };
  validateAlaskaStoredComponent(result, receiver, packet.component);
  return result;
}
export function readAlaskaReportedComponent(
  row: Record<string, unknown>,
  groupRows: Record<string, unknown>[],
  receiver: AlaskaReportedReceiver,
  kind: AlaskaReportedComponent,
): AlaskaStoredComponent {
  const result: AlaskaStoredComponent = {
    receiver: row.receiver_context as AlaskaReportedReceiver,
    receiving: row.receiving_context as AlaskaReportedReceivingContext,
    facts: row.source_facts as AlaskaStoredFacts,
    controls: row.aggregation_controls as AlaskaStoredControls,
    groups: groupRows.map((g) => ({
      key: g.group_key as string,
      reportedName: g.reported_name as string,
      stance: g.stance as AlaskaStoredGroup["stance"],
      amountCents: Number(g.amount_cents),
      occurrenceCount: Number(g.occurrence_count),
    })),
    observedAt: new Date(row.source_observed_at as string).toISOString(),
    completedAt: new Date(row.source_completed_at as string).toISOString(),
    syncedAt: new Date(row.last_synced_at as string).toISOString(),
  };
  akCheck(
    row.link_id === receiver.linkId &&
      row.candidate_id === receiver.candidateId &&
      row.election_id === receiver.electionId &&
      row.election_year === receiver.electionYear &&
      row.component === kind,
    "stored_component_binding",
  );
  akCheck(
    groupRows.every(
      (g) =>
        g.link_id === receiver.linkId &&
        g.election_year === receiver.electionYear &&
        g.component === kind,
    ),
    "stored_group_binding",
  );
  validateAlaskaStoredComponent(result, receiver, kind);
  return result;
}
export async function writeAlaskaReportedComponent(input: {
  db: Pick<Pool, "connect">;
  receiver: AlaskaReportedReceiver;
  packet: AlaskaReportedPacket;
}) {
  const v = buildAlaskaReportedComponent(input.receiver, input.packet),
    kind = v.facts.component,
    c = await input.db.connect(),
    key = [v.receiver.linkId, v.receiver.electionYear, kind];
  let begun = false;
  try {
    await c.query("BEGIN");
    begun = true;
    const current = await loadAlaskaReportedReceiver(
      c,
      v.receiver.linkId,
      true,
    );
    akCheck(
      current && isDeepStrictEqual(current, v.receiver),
      "canonical_receiving_context_changed",
    );
    const old = (
      await c.query(
        `SELECT * FROM public.ak_reported_finance_components WHERE link_id=$1::uuid AND election_year=$2 AND component=$3 FOR UPDATE`,
        key,
      )
    ).rows[0];
    if (old) {
      const oldClock = new Date(old.source_observed_at).toISOString(),
        oldFacts = old.source_facts as AlaskaStoredFacts;
      akCheck(
        oldClock <= v.observedAt &&
          oldFacts.source.observedAt <= v.facts.source.observedAt,
        "older_source",
      );
      // Same originals under a changed canonical receiver (alias, legacy name,
      // owner count) are rewritten below; the stored row would otherwise fail
      // its receiver binding on every read until the cached packets expire.
      if (
        oldFacts.revision === AK_REPORTED_REVISION &&
        oldFacts.source.observedAt === v.facts.source.observedAt &&
        isDeepStrictEqual(old.receiver_context, v.receiver)
      ) {
        const rows = (
          await c.query(
            `SELECT * FROM public.ak_reported_finance_groups WHERE link_id=$1::uuid AND election_year=$2 AND component=$3`,
            key,
          )
        ).rows;
        const prior = readAlaskaReportedComponent(old, rows, v.receiver, kind),
          sort = (gs: AlaskaStoredGroup[]) =>
            [...gs].sort((a, b) =>
              `${a.stance}:${a.key}`.localeCompare(`${b.stance}:${b.key}`),
            );
        akCheck(
          isDeepStrictEqual(prior.facts, v.facts) &&
            isDeepStrictEqual(prior.controls, v.controls) &&
            isDeepStrictEqual(prior.receiving, v.receiving) &&
            isDeepStrictEqual(sort(prior.groups), sort(v.groups)),
          "equal_source_conflict",
        );
        await c.query("COMMIT");
        begun = false;
        return { groups: v.groups.length, idempotent: true };
      }
    }
    await c.query(
      `INSERT INTO public.ak_reported_finance_components(link_id,election_year,component,candidate_id,election_id,receiver_context,receiving_context,source_facts,aggregation_controls,source_observed_at,source_completed_at,last_synced_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)
      ON CONFLICT(link_id,election_year,component) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
      receiver_context=EXCLUDED.receiver_context,receiving_context=EXCLUDED.receiving_context,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,
      source_observed_at=EXCLUDED.source_observed_at,source_completed_at=EXCLUDED.source_completed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [
        ...key,
        v.receiver.candidateId,
        v.receiver.electionId,
        JSON.stringify(v.receiver),
        JSON.stringify(v.receiving),
        JSON.stringify(v.facts),
        JSON.stringify(v.controls),
        v.observedAt,
        v.completedAt,
        v.syncedAt,
      ],
    );
    await c.query(
      `DELETE FROM public.ak_reported_finance_groups WHERE link_id=$1::uuid AND election_year=$2 AND component=$3`,
      key,
    );
    if (v.groups.length)
      await c.query(
        `INSERT INTO public.ak_reported_finance_groups(link_id,election_year,component,group_key,reported_name,stance,amount_cents,occurrence_count)
      SELECT $1::uuid,$2,$3,x.key,x."reportedName",x.stance,x."amountCents",x."occurrenceCount" FROM jsonb_to_recordset($4::jsonb)
      AS x(key text,"reportedName" text,stance text,"amountCents" bigint,"occurrenceCount" integer)`,
        [...key, JSON.stringify(v.groups)],
      );
    await c.query("COMMIT");
    begun = false;
    return { groups: v.groups.length, idempotent: false };
  } catch (e) {
    if (begun) await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

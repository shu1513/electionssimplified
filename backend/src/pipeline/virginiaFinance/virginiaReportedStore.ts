import { vaManifestHash } from "./virginiaReportedOriginals.js";
import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  vaAdd,
  vaCheck,
  vaKey,
  vaPublicUrl,
} from "./virginiaReportedNative.js";
import { vaPersonMatches } from "./virginiaReportedNative.js";
import { vaCanonicalHouseDistrict } from "./virginiaReportedReceiver.js";
import type {
  VirginiaReportedReceiver,
  VirginiaReportedReceivingContext,
} from "./virginiaReportedReceiver.js";
import {
  isVerifiedVirginiaReportedPacket,
  type VirginiaReportedPacket,
  type VirginiaReportedSourceFacts,
  type VirginiaReportedControls,
} from "./virginiaReportedSource.js";
import { loadVirginiaReportedReceiver } from "./virginiaReportedEligibility.js";

export const VA_REPORTED_REVISION = "va-current-native-v1";
export type VirginiaReportedComponent = "committee" | "ie";
export type VirginiaStoredGroup = {
  key: string;
  reportedName: string;
  stance: "committee" | "support" | "oppose";
  amountCents: number;
  occurrenceCount: number;
};
export type VirginiaStoredControls = VirginiaReportedControls;
export type VirginiaStoredFacts = {
  revision: string;
  year: number;
  component: VirginiaReportedComponent;
  source: VirginiaReportedSourceFacts;
};
export type VirginiaStoredComponent = {
  receiver: VirginiaReportedReceiver;
  receiving: VirginiaReportedReceivingContext;
  facts: VirginiaStoredFacts;
  controls: VirginiaStoredControls;
  groups: VirginiaStoredGroup[];
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
export function validateVirginiaStoredClosure(
  kind: VirginiaReportedComponent,
  controls: VirginiaStoredControls,
  groups: readonly VirginiaStoredGroup[],
): void {
  const keys = [
    "totalAmountCents",
    "occurrenceCount",
    "sourceRows",
    "excludedRows",
    "debtRows",
    "unverifiedPacRows",
    "supportCents",
    "opposeCents",
  ];
  vaCheck(
    controls &&
      isDeepStrictEqual(Object.keys(controls).sort(), keys.sort()) &&
      Object.entries(controls).every(([key, n]) =>
        key.endsWith("Cents") ? Number.isSafeInteger(n) : integer(n),
      ),
    "stored_controls",
  );
  const seen = new Set<string>();
  let total = 0,
    count = 0,
    support = 0,
    oppose = 0;
  for (const g of groups) {
    vaCheck(
      g &&
        typeof g.reportedName === "string" &&
        g.reportedName.length > 0 &&
        g.reportedName.length <= 4000 &&
        g.key === vaKey(g.reportedName) &&
        Number.isSafeInteger(g.amountCents) &&
        integer(g.occurrenceCount, true) &&
        (kind === "committee"
          ? g.stance === "committee"
          : ["support", "oppose"].includes(g.stance)),
      "stored_group",
    );
    const key = `${g.stance}:${g.key}`;
    vaCheck(!seen.has(key), "duplicate_stored_group");
    seen.add(key);
    total = vaAdd(total, g.amountCents);
    count = vaAdd(count, g.occurrenceCount);
    if (g.stance === "support") support = vaAdd(support, g.amountCents);
    if (g.stance === "oppose") oppose = vaAdd(oppose, g.amountCents);
  }
  vaCheck(
    total === controls.totalAmountCents &&
      count === controls.occurrenceCount &&
      support === controls.supportCents &&
      oppose === controls.opposeCents &&
      controls.sourceRows ===
        vaAdd(vaAdd(count, controls.excludedRows), controls.debtRows),
    "stored_full_closure",
  );
  vaCheck(
    kind === "committee"
      ? controls.debtRows === 0 && support === 0 && oppose === 0
      : controls.excludedRows === 0,
    "stored_metric_scope",
  );
  vaCheck(
    controls.unverifiedPacRows <= controls.excludedRows &&
      (kind === "committee" || controls.unverifiedPacRows === 0),
    "stored_unverified_scope",
  );
}
function validateFacts(f: VirginiaReportedSourceFacts): void {
  vaCheck(
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
    vaPublicUrl(o.url, o.url);
    vaCheck(
      ["GET", "POST"].includes(o.method) &&
        o.status === 200 &&
        o.eof === true &&
        integer(o.bytes) &&
        o.bytes <= 128 * 1024 * 1024 &&
        /^[a-f0-9]{64}$/.test(o.sha256) &&
        typeof o.contentType === "string" &&
        /^(?:text\/|application\/(?:octet-stream|csv|xml|vnd\.ms-excel|vnd\.openxmlformats-officedocument.spreadsheetml.sheet))/i.test(
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
  vaCheck(
    f.observations.map((o) => o.startedAt).sort()[0] === f.observedAt &&
      f.observations
        .map((o) => o.completedAt)
        .sort()
        .at(-1) === f.completedAt,
    "stored_source_clock_closure",
  );
  vaCheck(
    vaManifestHash(f.observations) === f.manifestSha256,
    "stored_manifest_integrity",
  );
}
export function validateVirginiaStoredComponent(
  value: VirginiaStoredComponent,
  expected: VirginiaReportedReceiver,
  kind: VirginiaReportedComponent,
): void {
  vaCheck(
    isDeepStrictEqual(value.receiver, expected),
    "stored_receiving_context_changed",
  );
  const c = value.receiving,
    d = vaCanonicalHouseDistrict(expected);
  vaCheck(
    expected.activeCandidateOwnerCount === 1 &&
      expected.linkOfficeName === expected.officeName &&
      c &&
      c.receivingId === expected.receivingId &&
      c.officeName === expected.officeName &&
      c.district === d &&
      c.electionYear === expected.electionYear &&
      vaPersonMatches(expected.candidateAliases, c.candidateName, [
        expected.firstName,
      ]) &&
      typeof c.committeeName === "string" &&
      c.committeeName.length > 0,
    "stored_native_receiving_context",
  );
  vaCheck(
    value.facts?.revision === VA_REPORTED_REVISION &&
      value.facts.year === expected.electionYear &&
      value.facts.component === kind,
    "stored_source_scope",
  );
  validateFacts(value.facts.source);
  const observed = value.facts.source.observedAt,
    completed = value.facts.source.completedAt;
  vaCheck(
    value.observedAt === observed &&
      value.completedAt === completed &&
      iso(value.syncedAt) &&
      value.syncedAt >= completed &&
      Date.parse(value.syncedAt) <= Date.now(),
    "stored_component_clock",
  );
  validateVirginiaStoredClosure(kind, value.controls, value.groups);
}
export function buildVirginiaReportedComponent(
  receiver: VirginiaReportedReceiver,
  packet: VirginiaReportedPacket,
): VirginiaStoredComponent {
  vaCheck(
    isVerifiedVirginiaReportedPacket(packet) &&
      isDeepStrictEqual(receiver, packet.receiver),
    "unverified_source",
  );
  const result: VirginiaStoredComponent = {
    receiver,
    receiving: packet.receiving,
    facts: {
      revision: VA_REPORTED_REVISION,
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
  validateVirginiaStoredComponent(result, receiver, packet.component);
  return result;
}
export function readVirginiaReportedComponent(
  row: Record<string, unknown>,
  groupRows: Record<string, unknown>[],
  receiver: VirginiaReportedReceiver,
  kind: VirginiaReportedComponent,
): VirginiaStoredComponent {
  const result: VirginiaStoredComponent = {
    receiver: row.receiver_context as VirginiaReportedReceiver,
    receiving: row.receiving_context as VirginiaReportedReceivingContext,
    facts: row.source_facts as VirginiaStoredFacts,
    controls: row.aggregation_controls as VirginiaStoredControls,
    groups: groupRows.map((g) => ({
      key: g.group_key as string,
      reportedName: g.reported_name as string,
      stance: g.stance as VirginiaStoredGroup["stance"],
      amountCents: Number(g.amount_cents),
      occurrenceCount: Number(g.occurrence_count),
    })),
    observedAt: new Date(row.source_observed_at as string).toISOString(),
    completedAt: new Date(row.source_completed_at as string).toISOString(),
    syncedAt: new Date(row.last_synced_at as string).toISOString(),
  };
  vaCheck(
    row.link_id === receiver.linkId &&
      row.candidate_id === receiver.candidateId &&
      row.election_id === receiver.electionId &&
      row.election_year === receiver.electionYear &&
      row.component === kind,
    "stored_component_binding",
  );
  vaCheck(
    groupRows.every(
      (g) =>
        g.link_id === receiver.linkId &&
        g.election_year === receiver.electionYear &&
        g.component === kind,
    ),
    "stored_group_binding",
  );
  validateVirginiaStoredComponent(result, receiver, kind);
  return result;
}
export async function writeVirginiaReportedComponent(input: {
  db: Pick<Pool, "connect">;
  receiver: VirginiaReportedReceiver;
  packet: VirginiaReportedPacket;
}) {
  const v = buildVirginiaReportedComponent(input.receiver, input.packet),
    kind = v.facts.component,
    c = await input.db.connect(),
    key = [v.receiver.linkId, v.receiver.electionYear, kind];
  let begun = false;
  try {
    await c.query("BEGIN");
    begun = true;
    const current = await loadVirginiaReportedReceiver(
      c,
      v.receiver.linkId,
      true,
    );
    vaCheck(
      current && isDeepStrictEqual(current, v.receiver),
      "canonical_receiving_context_changed",
    );
    const old = (
      await c.query(
        `SELECT * FROM public.va_reported_finance_components WHERE link_id=$1::uuid AND election_year=$2 AND component=$3 FOR UPDATE`,
        key,
      )
    ).rows[0];
    if (old) {
      const oldClock = new Date(old.source_observed_at).toISOString(),
        oldFacts = old.source_facts as VirginiaStoredFacts;
      vaCheck(
        oldClock <= v.observedAt &&
          oldFacts.source.observedAt <= v.facts.source.observedAt &&
          oldFacts.source.completedAt <= v.facts.source.completedAt,
        "older_source",
      );
      // The oldest observation is often a reused saved original (roster,
      // registry), so equal observedAt does not mean the same snapshot; only
      // an equal manifest does. A changed canonical receiver (alias, legacy
      // name, owner count) over the same originals is rewritten below; the
      // stored row would otherwise fail its receiver binding on every read.
      if (
        oldFacts.revision === VA_REPORTED_REVISION &&
        oldFacts.source.manifestSha256 === v.facts.source.manifestSha256 &&
        isDeepStrictEqual(old.receiver_context, v.receiver)
      ) {
        const rows = (
          await c.query(
            `SELECT * FROM public.va_reported_finance_groups WHERE link_id=$1::uuid AND election_year=$2 AND component=$3`,
            key,
          )
        ).rows;
        const prior = readVirginiaReportedComponent(
            old,
            rows,
            v.receiver,
            kind,
          ),
          sort = (gs: VirginiaStoredGroup[]) =>
            [...gs].sort((a, b) =>
              `${a.stance}:${a.key}`.localeCompare(`${b.stance}:${b.key}`),
            );
        vaCheck(
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
      `INSERT INTO public.va_reported_finance_components(link_id,election_year,component,candidate_id,election_id,receiver_context,receiving_context,source_facts,aggregation_controls,source_observed_at,source_completed_at,last_synced_at)
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
      `DELETE FROM public.va_reported_finance_groups WHERE link_id=$1::uuid AND election_year=$2 AND component=$3`,
      key,
    );
    if (v.groups.length)
      await c.query(
        `INSERT INTO public.va_reported_finance_groups(link_id,election_year,component,group_key,reported_name,stance,amount_cents,occurrence_count)
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

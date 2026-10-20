import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  neAdd,
  neCheck,
  neKey,
  NEBRASKA_NATIVE_URLS,
} from "./nebraskaReportedNative.js";
import {
  aggregateNebraskaReportedCommittee,
  aggregateNebraskaReportedOutside,
} from "./nebraskaReportedAggregation.js";
import {
  neCanonicalDistrict,
  nePersonMatches,
  qualifyNebraskaReportedReceiver,
  type NebraskaReportedReceiver,
  type NebraskaReportedReceivingContext,
} from "./nebraskaReportedReceiver.js";
import {
  isVerifiedNebraskaReportedSource,
  type NebraskaReportedSourcePacket,
  type NebraskaReportedSourceFacts,
} from "./nebraskaReportedSource.js";
import { loadNebraskaReportedReceiver } from "./nebraskaReportedEligibility.js";

export const NE_REPORTED_REVISION = "ne-current-native-v1";
export type NebraskaReportedComponent = "committee" | "ie";
export type NebraskaStoredGroup = {
  key: string;
  reportedName: string;
  stance: "committee" | "support" | "oppose";
  amountCents: number;
  occurrenceCount: number;
};
export type NebraskaStoredControls = Record<string, number>;
export type NebraskaStoredFacts = {
  revision: string;
  year: number;
  component: NebraskaReportedComponent;
  registry: NebraskaReportedSourceFacts;
  financial: NebraskaReportedSourceFacts;
};
export type NebraskaStoredComponent = {
  receiver: NebraskaReportedReceiver;
  receiving: NebraskaReportedReceivingContext;
  facts: NebraskaStoredFacts;
  controls: NebraskaStoredControls;
  groups: NebraskaStoredGroup[];
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
export function validateNebraskaStoredClosure(
  kind: NebraskaReportedComponent,
  controls: NebraskaStoredControls,
  groups: readonly NebraskaStoredGroup[],
): void {
  const keys =
    kind === "committee"
      ? [
          "totalAmountCents",
          "contributionCount",
          "sourceReceivingRows",
          "excludedRows",
        ]
      : [
          "supportCents",
          "opposeCents",
          "allocationCount",
          "unattributedSourceRows",
        ];
  neCheck(
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
    neCheck(
      g &&
        typeof g.reportedName === "string" &&
        g.reportedName.length > 0 &&
        g.reportedName.length <= 4000 &&
        g.key === neKey(g.reportedName) &&
        integer(g.amountCents, true) &&
        integer(g.occurrenceCount, true) &&
        (kind === "committee"
          ? g.stance === "committee"
          : ["support", "oppose"].includes(g.stance)),
      "stored_group",
    );
    const key = `${g.stance}:${g.key}`;
    neCheck(!seen.has(key), "duplicate_stored_group");
    seen.add(key);
    total = neAdd(total, g.amountCents);
    count = neAdd(count, g.occurrenceCount);
    if (g.stance === "support") support = neAdd(support, g.amountCents);
    if (g.stance === "oppose") oppose = neAdd(oppose, g.amountCents);
  }
  if (kind === "committee")
    neCheck(
      total === controls.totalAmountCents &&
        count === controls.contributionCount &&
        controls.sourceReceivingRows === neAdd(count, controls.excludedRows!),
      "stored_committee_closure",
    );
  else
    neCheck(
      support === controls.supportCents &&
        oppose === controls.opposeCents &&
        count === controls.allocationCount &&
        (count > 0 || controls.unattributedSourceRows === 0),
      "stored_ie_closure",
    );
}
function validateFacts(
  f: NebraskaReportedSourceFacts,
  kind: "registry" | NebraskaReportedComponent,
): void {
  neCheck(
    f &&
      /^[a-f0-9]{64}$/.test(f.manifestSha256) &&
      iso(f.observedAt) &&
      iso(f.completedAt) &&
      f.completedAt >= f.observedAt &&
      Array.isArray(f.observations) &&
      f.observations.length > 0 &&
      f.observations.length <= 5000,
    "stored_source_facts",
  );
  let prior = f.observedAt;
  for (const o of f.observations) {
    neCheck(
      o &&
        o.url === NEBRASKA_NATIVE_URLS[kind] &&
        ["GET", "POST"].includes(o.method) &&
        typeof o.role === "string" &&
        /^[a-z0-9:_-]{1,150}$/.test(o.role) &&
        o.status === 200 &&
        o.eof === true &&
        integer(o.bytes) &&
        o.bytes <= 64 * 1024 * 1024 &&
        /^[a-f0-9]{64}$/.test(o.sha256) &&
        typeof o.contentType === "string" &&
        /^(?:text\/|application\/(?:octet-stream|csv|vnd\.ms-excel))/i.test(
          o.contentType,
        ) &&
        iso(o.startedAt) &&
        iso(o.completedAt) &&
        o.startedAt >= prior &&
        o.completedAt >= o.startedAt,
      "stored_source_observation",
    );
    prior = o.completedAt;
  }
  neCheck(
    f.observations[0]!.startedAt === f.observedAt && prior === f.completedAt,
    "stored_source_clock_closure",
  );
}
export function validateNebraskaStoredComponent(
  value: NebraskaStoredComponent,
  expected: NebraskaReportedReceiver,
  kind: NebraskaReportedComponent,
): void {
  neCheck(
    isDeepStrictEqual(value.receiver, expected),
    "stored_receiving_context_changed",
  );
  const c = value.receiving,
    d = neCanonicalDistrict(expected);
  neCheck(
    expected.activeCandidateOwnerCount === 1 &&
      expected.linkOfficeName === expected.officeName &&
      c &&
      c.receivingId === expected.receivingId &&
      c.officeName === expected.officeName &&
      c.district === d &&
      c.electionYear === expected.electionYear &&
      nePersonMatches(expected.candidateAliases, c.candidateName) &&
      typeof c.committeeName === "string" &&
      c.committeeName.length > 0,
    "stored_native_receiving_context",
  );
  neCheck(
    value.facts?.revision === NE_REPORTED_REVISION &&
      value.facts.year === expected.electionYear &&
      value.facts.component === kind,
    "stored_source_scope",
  );
  validateFacts(value.facts.registry, "registry");
  validateFacts(value.facts.financial, kind);
  const observed = [
      value.facts.registry.observedAt,
      value.facts.financial.observedAt,
    ].sort()[0]!,
    completed = [
      value.facts.registry.completedAt,
      value.facts.financial.completedAt,
    ]
      .sort()
      .at(-1)!;
  neCheck(
    value.observedAt === observed &&
      value.completedAt === completed &&
      iso(value.syncedAt) &&
      value.syncedAt >= completed &&
      Date.parse(value.syncedAt) <= Date.now(),
    "stored_component_clock",
  );
  validateNebraskaStoredClosure(kind, value.controls, value.groups);
}
export function buildNebraskaReportedComponent(
  receiver: NebraskaReportedReceiver,
  registry: NebraskaReportedSourcePacket,
  financial: NebraskaReportedSourcePacket,
): NebraskaStoredComponent {
  neCheck(
    isVerifiedNebraskaReportedSource(registry) &&
      isVerifiedNebraskaReportedSource(financial) &&
      registry.kind === "registry" &&
      ["committee", "ie"].includes(financial.kind) &&
      registry.year === receiver.electionYear &&
      financial.year === receiver.electionYear &&
      registry.registrations,
    "unverified_source",
  );
  const receiving = qualifyNebraskaReportedReceiver(
      receiver,
      registry.registrations,
    ),
    kind = financial.kind as NebraskaReportedComponent;
  let controls: NebraskaStoredControls, groups: NebraskaStoredGroup[];
  if (kind === "committee") {
    neCheck(financial.receipts, "missing_committee_rows");
    const { groups: rows, ...rest } = aggregateNebraskaReportedCommittee({
      receiver,
      context: receiving,
      receipts: financial.receipts,
    });
    controls = rest;
    groups = rows.map(({ contributionCount, ...g }) => ({
      ...g,
      stance: "committee",
      occurrenceCount: contributionCount,
    }));
  } else {
    neCheck(financial.allocations, "missing_ie_rows");
    const { groups: rows, ...rest } = aggregateNebraskaReportedOutside({
      receiver,
      context: receiving,
      registrations: registry.registrations,
      allocations: financial.allocations,
    });
    controls = rest;
    groups = rows.map(({ allocationCount, ...g }) => ({
      ...g,
      occurrenceCount: allocationCount,
    }));
  }
  const facts: NebraskaStoredFacts = {
      revision: NE_REPORTED_REVISION,
      year: receiver.electionYear,
      component: kind,
      registry: registry.source,
      financial: financial.source,
    },
    observedAt = [
      registry.source.observedAt,
      financial.source.observedAt,
    ].sort()[0]!,
    completedAt = [registry.source.completedAt, financial.source.completedAt]
      .sort()
      .at(-1)!;
  const result = {
    receiver,
    receiving,
    facts,
    controls,
    groups,
    observedAt,
    completedAt,
    syncedAt: new Date().toISOString(),
  };
  validateNebraskaStoredComponent(result, receiver, kind);
  return result;
}
export function readNebraskaReportedComponent(
  row: Record<string, unknown>,
  groupRows: Record<string, unknown>[],
  receiver: NebraskaReportedReceiver,
  kind: NebraskaReportedComponent,
): NebraskaStoredComponent {
  const result: NebraskaStoredComponent = {
    receiver: row.receiver_context as NebraskaReportedReceiver,
    receiving: row.receiving_context as NebraskaReportedReceivingContext,
    facts: row.source_facts as NebraskaStoredFacts,
    controls: row.aggregation_controls as NebraskaStoredControls,
    groups: groupRows.map((g) => ({
      key: g.group_key as string,
      reportedName: g.reported_name as string,
      stance: g.stance as NebraskaStoredGroup["stance"],
      amountCents: Number(g.amount_cents),
      occurrenceCount: Number(g.occurrence_count),
    })),
    observedAt: new Date(row.source_observed_at as string).toISOString(),
    completedAt: new Date(row.source_completed_at as string).toISOString(),
    syncedAt: new Date(row.last_synced_at as string).toISOString(),
  };
  neCheck(
    row.link_id === receiver.linkId &&
      row.candidate_id === receiver.candidateId &&
      row.election_id === receiver.electionId &&
      row.election_year === receiver.electionYear &&
      row.component === kind,
    "stored_component_binding",
  );
  neCheck(
    groupRows.every(
      (g) =>
        g.link_id === receiver.linkId &&
        g.election_year === receiver.electionYear &&
        g.component === kind,
    ),
    "stored_group_binding",
  );
  validateNebraskaStoredComponent(result, receiver, kind);
  return result;
}
export async function writeNebraskaReportedComponent(input: {
  db: Pick<Pool, "connect">;
  receiver: NebraskaReportedReceiver;
  registry: NebraskaReportedSourcePacket;
  financial: NebraskaReportedSourcePacket;
}) {
  const v = buildNebraskaReportedComponent(
      input.receiver,
      input.registry,
      input.financial,
    ),
    kind = v.facts.component,
    c = await input.db.connect(),
    key = [v.receiver.linkId, v.receiver.electionYear, kind];
  let begun = false;
  try {
    await c.query("BEGIN");
    begun = true;
    const current = await loadNebraskaReportedReceiver(
      c,
      v.receiver.linkId,
      true,
    );
    neCheck(
      current && isDeepStrictEqual(current, v.receiver),
      "canonical_receiving_context_changed",
    );
    const old = (
      await c.query(
        `SELECT * FROM public.ne_reported_finance_components WHERE link_id=$1::uuid AND election_year=$2 AND component=$3 FOR UPDATE`,
        key,
      )
    ).rows[0];
    if (old) {
      const oldClock = new Date(old.source_observed_at).toISOString(),
        oldFacts = old.source_facts as NebraskaStoredFacts;
      neCheck(
        oldClock <= v.observedAt &&
          oldFacts.registry.observedAt <= v.facts.registry.observedAt &&
          oldFacts.financial.observedAt <= v.facts.financial.observedAt,
        "older_source",
      );
      // Same originals under a changed canonical receiver (alias, legacy name,
      // owner count) are rewritten below; the stored row would otherwise fail
      // its receiver binding on every read until the cached packets expire.
      if (
        oldFacts.registry.observedAt === v.facts.registry.observedAt &&
        oldFacts.financial.observedAt === v.facts.financial.observedAt &&
        isDeepStrictEqual(old.receiver_context, v.receiver)
      ) {
        const rows = (
          await c.query(
            `SELECT * FROM public.ne_reported_finance_groups WHERE link_id=$1::uuid AND election_year=$2 AND component=$3`,
            key,
          )
        ).rows;
        const prior = readNebraskaReportedComponent(
            old,
            rows,
            v.receiver,
            kind,
          ),
          sort = (gs: NebraskaStoredGroup[]) =>
            [...gs].sort((a, b) =>
              `${a.stance}:${a.key}`.localeCompare(`${b.stance}:${b.key}`),
            );
        neCheck(
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
      `INSERT INTO public.ne_reported_finance_components(link_id,election_year,component,candidate_id,election_id,receiver_context,receiving_context,source_facts,aggregation_controls,source_observed_at,source_completed_at,last_synced_at)
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
      `DELETE FROM public.ne_reported_finance_groups WHERE link_id=$1::uuid AND election_year=$2 AND component=$3`,
      key,
    );
    if (v.groups.length)
      await c.query(
        `INSERT INTO public.ne_reported_finance_groups(link_id,election_year,component,group_key,reported_name,stance,amount_cents,occurrence_count)
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

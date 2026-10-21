import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  isNewMexicoReportedCommitteeEnabled,
  isNewMexicoReportedIeEnabled,
} from "../../config/featureFlags.js";
import {
  NM_REPORTED_ORIGIN,
  NM_REPORTED_PATHS,
  nmAdd,
  nmCheck,
  nmKey,
  nmString,
} from "./newMexicoReportedNative.js";
import {
  aggregateNewMexicoReportedCommittee,
  aggregateNewMexicoReportedIe,
  qualifyNewMexicoReportedContext,
  type NewMexicoReportedContext,
  type NewMexicoReportedControls,
  type NewMexicoReportedGroup,
} from "./newMexicoReportedAggregation.js";
import { loadNewMexicoReportedReceiver } from "./newMexicoReportedEligibility.js";
import { nmSourceScope } from "./newMexicoReportedOriginals.js";
import {
  isVerifiedNewMexicoReportedSource,
  type NewMexicoReportedSourceFacts,
  type NewMexicoReportedSourcePacket,
} from "./newMexicoReportedSource.js";
import {
  nmOfficeName,
  nmPersonMatches,
  qualifyNewMexicoReportedReceiver,
  type NewMexicoReportedReceiver,
} from "./newMexicoReportedReceiver.js";

export const NM_REPORTED_REVISION = "nm-native-cycle-target-v1";
export type NewMexicoReportedComponent = "committee" | "ie";
type SourceReference = {
  scope: NewMexicoReportedSourcePacket["scope"];
  source: NewMexicoReportedSourceFacts;
};
export type NewMexicoStoredFacts = {
  revision: string;
  year: number;
  component: NewMexicoReportedComponent;
  registry: SourceReference;
  receiver: SourceReference;
  financial: SourceReference;
};
export type NewMexicoStoredComponent = {
  receiver: NewMexicoReportedReceiver;
  context: NewMexicoReportedContext;
  facts: NewMexicoStoredFacts;
  controls: NewMexicoReportedControls;
  groups: NewMexicoReportedGroup[];
  observedAt: string;
  completedAt: string;
  syncedAt: string;
};
export const nmComponentEnabled = (
  kind: NewMexicoReportedComponent,
): boolean =>
  kind === "committee"
    ? isNewMexicoReportedCommitteeEnabled()
    : isNewMexicoReportedIeEnabled();
const integer = (value: unknown, positive = false): value is number =>
  Number.isSafeInteger(value) && Number(value) >= (positive ? 1 : 0);
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export function validateNewMexicoStoredClosure(
  kind: NewMexicoReportedComponent,
  controls: NewMexicoReportedControls,
  groups: readonly NewMexicoReportedGroup[],
): void {
  const keys =
    kind === "committee"
      ? [
          "totalAmountCents",
          "contributionCount",
          "sourceReceivingRows",
          "sourceReceivingAmountCents",
          "currentCycleRows",
          "financialCycleId",
          "excludedRows",
          "excludedAmountCents",
        ]
      : [
          "supportCents",
          "opposeCents",
          "allocationCount",
          "sourceAllocationRows",
          "excludedAllocationRows",
        ];
  nmCheck(
    controls &&
      isDeepStrictEqual(Object.keys(controls).sort(), keys.sort()) &&
      Object.entries(controls).every(([key, value]) =>
        ["sourceReceivingAmountCents", "excludedAmountCents"].includes(key)
          ? Number.isSafeInteger(value)
          : integer(value),
      ),
    "stored_controls",
  );
  const seen = new Set<string>();
  let total = 0,
    count = 0,
    support = 0,
    oppose = 0;
  for (const group of groups) {
    nmCheck(
      group &&
        typeof group.reportedName === "string" &&
        group.reportedName.length > 0 &&
        group.reportedName.length <= 4000 &&
        group.key === nmKey(group.reportedName) &&
        group.key.length <= 4000 &&
        integer(group.amountCents, true) &&
        integer(group.occurrenceCount, true) &&
        (kind === "committee"
          ? group.stance === "committee"
          : ["support", "oppose"].includes(group.stance)),
      "stored_group",
    );
    const key = `${group.stance}:${group.key}`;
    nmCheck(!seen.has(key), "duplicate_stored_group");
    seen.add(key);
    total = nmAdd(total, group.amountCents);
    count = nmAdd(count, group.occurrenceCount);
    if (group.stance === "support") support = nmAdd(support, group.amountCents);
    if (group.stance === "oppose") oppose = nmAdd(oppose, group.amountCents);
  }
  if (kind === "committee")
    nmCheck(
      total === controls.totalAmountCents &&
        count === controls.contributionCount &&
        count + controls.excludedRows! === controls.sourceReceivingRows &&
        nmAdd(total, controls.excludedAmountCents!) ===
          controls.sourceReceivingAmountCents &&
        integer(controls.financialCycleId, true) &&
        integer(controls.currentCycleRows, true) &&
        controls.currentCycleRows! <= controls.sourceReceivingRows!,
      "stored_committee_closure",
    );
  else
    nmCheck(
      support === controls.supportCents &&
        oppose === controls.opposeCents &&
        count === controls.allocationCount &&
        count + controls.excludedAllocationRows! ===
          controls.sourceAllocationRows,
      "stored_ie_closure",
    );
}
function sourceFacts(
  reference: SourceReference,
  kind: string,
  year: number,
): void {
  nmSourceScope(reference.scope);
  const facts = reference.source;
  nmCheck(
    reference.scope.kind === kind &&
      reference.scope.year === year &&
      facts &&
      /^[a-f0-9]{64}$/.test(facts.manifestSha256) &&
      iso(facts.observedAt) &&
      iso(facts.completedAt) &&
      Array.isArray(facts.observations) &&
      facts.observations.length > 0 &&
      facts.observations.length <= 20000,
    "stored_source_facts",
  );
  for (const original of facts.observations) {
    const url = new URL(original.url);
    nmCheck(
      url.origin === NM_REPORTED_ORIGIN &&
        !url.username &&
        !url.password &&
        !url.hash &&
        Object.values(NM_REPORTED_PATHS).includes(
          url.pathname as typeof NM_REPORTED_PATHS.registry,
        ) &&
        original.status === 200 &&
        original.eof === true &&
        integer(original.bytes) &&
        original.bytes <= 128 * 1024 * 1024 &&
        /^[a-f0-9]{64}$/.test(original.sha256) &&
        typeof original.contentType === "string" &&
        /^(?:application\/json|text\/plain)(?:\s*;|$)/i.test(
          original.contentType,
        ) &&
        iso(original.startedAt) &&
        iso(original.completedAt) &&
        original.startedAt <= original.completedAt,
      "stored_original_facts",
    );
  }
  nmCheck(
    facts.observedAt === facts.observations.map((x) => x.startedAt).sort()[0] &&
      facts.completedAt ===
        facts.observations
          .map((x) => x.completedAt)
          .sort()
          .at(-1),
    "stored_original_clock_closure",
  );
}
export function validateNewMexicoStoredComponent(
  value: NewMexicoStoredComponent,
): void {
  const { facts, receiver, context } = value;
  nmCheck(
    facts.revision === NM_REPORTED_REVISION &&
      facts.year === receiver.electionYear &&
      ["committee", "ie"].includes(facts.component),
    "stored_revision_scope",
  );
  qualifyNewMexicoReportedReceiver(receiver, [context.registration]);
  nmCheck(
    context.detail.electionYear === receiver.electionYear &&
      nmOfficeName(context.detail.officeName) === receiver.officeName &&
      nmPersonMatches(
        [...receiver.candidateAliases, context.registration.candidateName],
        context.detail.candidateName,
      ),
    "stored_native_identity_scope",
  );
  nmString(context.detail.memberId, "stored_native_member_locator");
  sourceFacts(facts.registry, "registry", receiver.electionYear);
  sourceFacts(facts.receiver, "receiver", receiver.electionYear);
  sourceFacts(facts.financial, facts.component, receiver.electionYear);
  nmCheck(
    facts.receiver.scope.selector === context.registration.locator &&
      (facts.component === "ie"
        ? facts.financial.scope.selector === null
        : facts.financial.scope.selector === context.detail.candidateName &&
          facts.financial.scope.memberId === context.detail.memberId),
    "stored_native_request_scope",
  );
  const all = [facts.registry, facts.receiver, facts.financial];
  nmCheck(
    iso(value.observedAt) &&
      iso(value.completedAt) &&
      iso(value.syncedAt) &&
      value.observedAt === facts.financial.source.observedAt &&
      value.completedAt ===
        all
          .map((x) => x.source.completedAt)
          .sort()
          .at(-1) &&
      value.completedAt <= value.syncedAt &&
      value.syncedAt <= new Date().toISOString(),
    "stored_component_clocks",
  );
  validateNewMexicoStoredClosure(facts.component, value.controls, value.groups);
}
function timestamp(value: unknown): string {
  nmCheck(
    value instanceof Date || typeof value === "string",
    "stored_timestamp",
  );
  const date = value instanceof Date ? value : new Date(value);
  nmCheck(Number.isFinite(date.getTime()), "stored_timestamp");
  return date.toISOString();
}
export function readNewMexicoReportedComponent(
  stored: Record<string, unknown>,
  rows: Record<string, unknown>[],
  receiver: NewMexicoReportedReceiver,
  kind: NewMexicoReportedComponent,
): NewMexicoStoredComponent {
  nmCheck(
    stored.link_id === receiver.linkId &&
      stored.candidate_id === receiver.candidateId &&
      stored.election_id === receiver.electionId &&
      stored.election_year === receiver.electionYear &&
      stored.component === kind &&
      isDeepStrictEqual(stored.receiver_context, receiver),
    "stored_canonical_context",
  );
  const groups = rows.map((row) => {
    nmCheck(
      row.link_id === receiver.linkId &&
        row.election_year === receiver.electionYear &&
        row.component === kind &&
        typeof row.amount_cents === "string" &&
        /^[1-9]\d*$/.test(row.amount_cents),
      "stored_group_scope",
    );
    return {
      key: row.group_key as string,
      reportedName: row.reported_name as string,
      stance: row.stance as NewMexicoReportedGroup["stance"],
      amountCents: Number(row.amount_cents),
      occurrenceCount: Number(row.occurrence_count),
    };
  });
  const result = {
    receiver,
    context: stored.receiving_context as NewMexicoReportedContext,
    facts: stored.source_facts as NewMexicoStoredFacts,
    controls: stored.aggregation_controls as NewMexicoReportedControls,
    groups,
    observedAt: timestamp(stored.source_observed_at),
    completedAt: timestamp(stored.source_completed_at),
    syncedAt: timestamp(stored.last_synced_at),
  };
  validateNewMexicoStoredComponent(result);
  return result;
}
export async function writeNewMexicoReportedComponent(input: {
  db: Pick<Pool, "query" | "connect">;
  receiver: NewMexicoReportedReceiver;
  component: NewMexicoReportedComponent;
  registry: NewMexicoReportedSourcePacket;
  identity: NewMexicoReportedSourcePacket;
  financial: NewMexicoReportedSourcePacket;
}): Promise<{ groups: number; idempotent: boolean }> {
  nmCheck(nmComponentEnabled(input.component), "component_disabled");
  for (const packet of [input.registry, input.identity, input.financial])
    nmCheck(
      isVerifiedNewMexicoReportedSource(packet) &&
        packet.scope.year === input.receiver.electionYear,
      "unverified_source_packet",
    );
  nmCheck(
    input.registry.scope.kind === "registry" &&
      input.identity.scope.kind === "receiver" &&
      input.financial.scope.kind === input.component &&
      input.registry.registrations &&
      input.identity.receiver,
    "source_packet_roles",
  );
  const context = qualifyNewMexicoReportedContext(
    input.receiver,
    input.registry.registrations,
    input.identity.receiver,
  );
  nmCheck(
    input.identity.scope.selector === context.registration.locator &&
      (input.component === "ie"
        ? input.financial.scope.selector === null
        : input.financial.scope.selector === context.detail.candidateName &&
          input.financial.scope.memberId === context.detail.memberId),
    "source_receiving_request_scope",
  );
  const aggregation =
    input.component === "committee"
      ? aggregateNewMexicoReportedCommittee({
          receiver: input.receiver,
          context,
          financial: input.financial,
        })
      : aggregateNewMexicoReportedIe({
          receiver: input.receiver,
          context,
          registrations: input.registry.registrations,
          financial: input.financial,
        });
  const reference = (
    packet: NewMexicoReportedSourcePacket,
  ): SourceReference => ({ scope: packet.scope, source: packet.source });
  const facts: NewMexicoStoredFacts = {
    revision: NM_REPORTED_REVISION,
    year: input.receiver.electionYear,
    component: input.component,
    registry: reference(input.registry),
    receiver: reference(input.identity),
    financial: reference(input.financial),
  };
  const value: NewMexicoStoredComponent = {
    receiver: input.receiver,
    context,
    facts,
    controls: aggregation.controls,
    groups: aggregation.groups,
    observedAt: facts.financial.source.observedAt,
    completedAt: [facts.registry, facts.receiver, facts.financial]
      .map((x) => x.source.completedAt)
      .sort()
      .at(-1)!,
    syncedAt: new Date().toISOString(),
  };
  validateNewMexicoStoredComponent(value);
  const client = await input.db.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const current = await loadNewMexicoReportedReceiver(
      client,
      input.receiver.linkId,
      true,
    );
    nmCheck(
      current && isDeepStrictEqual(current, input.receiver),
      "canonical_receiving_context_changed",
    );
    const selected = await client.query(
      `SELECT * FROM public.nm_reported_finance_components WHERE link_id=$1 AND election_year=$2 AND component=$3 FOR UPDATE`,
      [current.linkId, current.electionYear, input.component],
    );
    if (selected.rows.length) {
      const rows = await client.query(
        `SELECT *,amount_cents::text FROM public.nm_reported_finance_groups WHERE link_id=$1 AND election_year=$2 AND component=$3 ORDER BY stance,group_key`,
        [current.linkId, current.electionYear, input.component],
      );
      const old = selected.rows[0],
        oldClock = timestamp(old.source_observed_at);
      nmCheck(
        value.observedAt >= oldClock &&
          value.completedAt >= timestamp(old.source_completed_at),
        "stale_source_observation",
      );
      for (const key of ["registry", "receiver", "financial"] as const) {
        const oldSourceClock = old.source_facts?.[key]?.source?.observedAt;
        if (iso(oldSourceClock))
          nmCheck(
            value.facts[key].source.observedAt >= oldSourceClock,
            "stale_source_observation",
          );
      }
      let previous: NewMexicoStoredComponent | null = null;
      try {
        previous = readNewMexicoReportedComponent(
          old,
          rows.rows,
          old.receiver_context as NewMexicoReportedReceiver,
          input.component,
        );
      } catch {
        /* A fully qualified current graph can repair invalid stored data. */
      }
      // Each packet replays its saved originals for seven days on its own
      // clock, so a refreshed registry or receiver packet beside a reused
      // financial packet keeps the old observedAt. Only equal manifests for
      // all three packets mean the same snapshot.
      if (
        previous &&
        (["registry", "receiver", "financial"] as const).every(
          (key) =>
            previous!.facts[key].source.manifestSha256 ===
            value.facts[key].source.manifestSha256,
        )
      ) {
        const order = (groups: NewMexicoReportedGroup[]) =>
          [...groups].sort(
            (a, b) =>
              a.stance.localeCompare(b.stance) || a.key.localeCompare(b.key),
          );
        nmCheck(
          isDeepStrictEqual(
            {
              context: value.context,
              facts: value.facts,
              controls: value.controls,
              groups: order(value.groups),
            },
            {
              context: previous.context,
              facts: previous.facts,
              controls: previous.controls,
              groups: order(previous.groups),
            },
          ),
          "equal_clock_payload_conflict",
        );
        if (isDeepStrictEqual(previous.receiver, current)) {
          await client.query("COMMIT");
          begun = false;
          return { groups: previous.groups.length, idempotent: true };
        }
      }
    }
    await client.query(
      `INSERT INTO public.nm_reported_finance_components(link_id,election_year,component,candidate_id,election_id,receiver_context,receiving_context,source_facts,aggregation_controls,source_observed_at,source_completed_at,last_synced_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12) ON CONFLICT(link_id,election_year,component) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiver_context=EXCLUDED.receiver_context,receiving_context=EXCLUDED.receiving_context,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,source_completed_at=EXCLUDED.source_completed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [
        current.linkId,
        current.electionYear,
        input.component,
        current.candidateId,
        current.electionId,
        JSON.stringify(current),
        JSON.stringify(value.context),
        JSON.stringify(value.facts),
        JSON.stringify(value.controls),
        value.observedAt,
        value.completedAt,
        value.syncedAt,
      ],
    );
    await client.query(
      `DELETE FROM public.nm_reported_finance_groups WHERE link_id=$1 AND election_year=$2 AND component=$3`,
      [current.linkId, current.electionYear, input.component],
    );
    for (const group of value.groups)
      await client.query(
        `INSERT INTO public.nm_reported_finance_groups(link_id,election_year,component,group_key,reported_name,stance,amount_cents,occurrence_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          current.linkId,
          current.electionYear,
          input.component,
          group.key,
          group.reportedName,
          group.stance,
          String(group.amountCents),
          group.occurrenceCount,
        ],
      );
    const stored = await client.query(
      `SELECT * FROM public.nm_reported_finance_components WHERE link_id=$1 AND election_year=$2 AND component=$3`,
      [current.linkId, current.electionYear, input.component],
    );
    const groups = await client.query(
      `SELECT *,amount_cents::text FROM public.nm_reported_finance_groups WHERE link_id=$1 AND election_year=$2 AND component=$3`,
      [current.linkId, current.electionYear, input.component],
    );
    readNewMexicoReportedComponent(
      stored.rows[0],
      groups.rows,
      current,
      input.component,
    );
    await client.query("COMMIT");
    begun = false;
    return { groups: value.groups.length, idempotent: false };
  } catch (error) {
    if (begun) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

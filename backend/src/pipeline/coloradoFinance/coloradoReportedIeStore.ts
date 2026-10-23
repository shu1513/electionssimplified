import { coloradoSourceDay } from "./coloradoTracerObservations.js";
import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  isColoradoCampaignFinanceSyncEnabled,
  isColoradoReportedIeEnabled,
} from "../../config/featureFlags.js";
import {
  ColoradoReportError,
  coloradoReportedNameKey,
} from "./coloradoTracerReports.js";
import {
  coloradoPartyKey,
  coloradoIeNativeDistrict,
  coloradoIeNativeOffice,
  type ColoradoNativeCandidateProof,
} from "./coloradoNativeCandidateIdentity.js";
import {
  lockColoradoIeReceiver,
  validateColoradoIeReceiverIdentity,
  type ColoradoIeReceiver,
} from "./coloradoReportedIeReceiver.js";
import {
  isVerifiedColoradoIeDataset,
  isVerifiedColoradoIeCandidateSource,
  type ColoradoIeDataset,
  type ColoradoIeCandidateSource,
  type ColoradoSourceFacts,
} from "./coloradoReportedIeSource.js";
import {
  aggregateColoradoReportedIe,
  type ColoradoReportedIeProjection,
} from "./coloradoReportedIeAggregation.js";
export const CO_IE_REVISION = "native-ie-v1";
export const CO_LEGISLATIVE_IE_REVISION = "native-ie-legislative-v1";
export const coloradoIeRevision = (
  receiver: Pick<ColoradoIeReceiver, "officeName" | "districtName">,
) =>
  coloradoIeNativeDistrict(receiver)
    ? CO_LEGISLATIVE_IE_REVISION
    : CO_IE_REVISION;
export type ColoradoIeStoredFacts = {
  revision: typeof CO_IE_REVISION | typeof CO_LEGISLATIVE_IE_REVISION;
  startDate: string;
  endDate: string;
  dataset: ColoradoSourceFacts;
  candidate: ColoradoSourceFacts;
};
function check(v: unknown, code: string): asserts v {
  if (!v) throw new ColoradoReportError(code);
}
function iso(v: unknown): v is string {
  return (
    typeof v === "string" &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
  );
}
function sourceFacts(v: ColoradoSourceFacts): void {
  check(
    v &&
      /^packet-[a-f0-9-]{36}$/u.test(v.packetDirectory) &&
      /^[a-f0-9]{64}$/u.test(v.manifestSha256) &&
      iso(v.observedAt) &&
      iso(v.completedAt) &&
      v.observedAt <= v.completedAt &&
      Date.parse(v.completedAt) <= Date.now() + 300000 &&
      Date.parse(v.completedAt) - Date.parse(v.observedAt) <= 7200000 &&
      Array.isArray(v.originals) &&
      v.originals.length > 0 &&
      v.originals.length <= 256,
    "stored_ie_source_facts",
  );
  let edge = v.observedAt;
  for (const [i, r] of v.originals.entries()) {
    check(
      r.file === `${String(i + 1).padStart(4, "0")}.response` &&
        /^[a-f0-9]{64}$/u.test(r.sha256) &&
        Number.isSafeInteger(r.bytes) &&
        r.bytes >= 0 &&
        r.bytes <= 64 * 1024 * 1024 &&
        iso(r.startedAt) &&
        iso(r.completedAt) &&
        r.startedAt >= edge &&
        r.completedAt >= r.startedAt &&
        r.completedAt <= v.completedAt,
      "stored_ie_original_facts",
    );
    edge = r.completedAt;
  }
  check(
    v.originals[0]!.startedAt === v.observedAt && edge === v.completedAt,
    "stored_ie_source_clocks",
  );
}
export function validateColoradoIeStored(
  receiver: ColoradoIeReceiver,
  identity: ColoradoNativeCandidateProof,
  facts: ColoradoIeStoredFacts,
  projection: ColoradoReportedIeProjection,
): void {
  check(
    facts?.revision === coloradoIeRevision(receiver) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(facts.startDate) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(facts.endDate) &&
      facts.startDate === `${receiver.electionYear - 4}-01-01` &&
      facts.startDate <= identity.cycleStart &&
      facts.endDate >= identity.cycleStart,
    "stored_ie_window",
  );
  sourceFacts(facts.dataset);
  sourceFacts(facts.candidate);
  check(
    facts.dataset.originals.length >= 41 &&
      facts.candidate.originals.length >= 8 &&
      facts.endDate === coloradoSourceDay(facts.dataset.observedAt),
    "stored_ie_source_scope",
  );
  validateColoradoIeReceiverIdentity(receiver, identity);
  const nativeDistrict = coloradoIeNativeDistrict(receiver);
  check(
    !nativeDistrict ||
      (identity.districtName === nativeDistrict &&
        identity.nativeOfficeName ===
          coloradoIeNativeOffice(receiver.officeName) &&
        Number.isSafeInteger(identity.peerCandidateCount) &&
        identity.peerCandidateCount! > 0 &&
        Number.isSafeInteger(identity.peerCampaignCount) &&
        identity.peerCampaignCount! >= identity.peerCandidateCount! &&
        facts.candidate.originals.length >= 15),
    "stored_ie_legislative_identity",
  );
  check(
    identity.receivingId === receiver.receivingId &&
      (!receiver.tracerCandidateId ||
        identity.candidateId === receiver.tracerCandidateId) &&
      identity.cycleYear === receiver.electionYear &&
      identity.officeName === receiver.officeName &&
      identity.party === coloradoPartyKey(receiver.party) &&
      identity.cycleStart <= receiver.electionDate &&
      identity.cycleEnd >= receiver.electionDate,
    "stored_ie_identity",
  );
  const c = projection.controls;
  check(
    !nativeDistrict ||
      (Number.isSafeInteger(c.ambiguousCandidateParents) &&
        c.ambiguousCandidateParents! >= 0),
    "stored_ie_legislative_controls",
  );
  for (const [k, v] of Object.entries(c)) {
    if (k === "sourceSignedParentMicros") {
      check(typeof v === "string" && /^-?\d+$/u.test(v), "stored_ie_controls");
      continue;
    }
    if (k === "sourceSignedParentCents" && v === null) continue;
    check(
      typeof v === "number" &&
        Number.isSafeInteger(v) &&
        (k === "sourceSignedParentCents" || v >= 0),
      "stored_ie_controls",
    );
  }
  const sourceMicros = BigInt(c.sourceSignedParentMicros);
  check(
    c.sourceSignedParentCents ===
      (sourceMicros % 10000n === 0n ? Number(sourceMicros / 10000n) : null) &&
      c.sourceTargets >= c.sourceParents &&
      c.sourceFractionalCentParents <= c.sourceParents &&
      c.sourceUnidentifiedTargets <= c.sourceTargets &&
      c.outsideCycleParents +
        c.sharedCandidateParents +
        c.allocatedParents +
        (c.ambiguousCandidateParents ?? 0) <=
        c.sourceParents,
    "stored_ie_controls",
  );
  const seen = new Set<string>();
  let support = 0n,
    oppose = 0n,
    occurrences = 0;
  for (const g of projection.groups) {
    check(
      g &&
        ["support", "oppose"].includes(g.stance) &&
        typeof g.reportedName === "string" &&
        g.reportedName.trim().length > 0 &&
        g.key === coloradoReportedNameKey(g.reportedName) &&
        !seen.has(`${g.stance}:${g.key}`) &&
        Number.isSafeInteger(g.amountCents) &&
        g.amountCents > 0 &&
        Number.isSafeInteger(g.occurrenceCount) &&
        g.occurrenceCount > 0,
      "stored_ie_group",
    );
    seen.add(`${g.stance}:${g.key}`);
    if (g.stance === "support") support += BigInt(g.amountCents);
    else oppose += BigInt(g.amountCents);
    occurrences += g.occurrenceCount;
  }
  check(
    support === BigInt(c.supportCents) &&
      oppose === BigInt(c.opposeCents) &&
      occurrences <= c.allocatedParents,
    "stored_ie_group_closure",
  );
}
export async function writeColoradoReportedIe(input: {
  db: Pick<Pool, "connect">;
  receiver: ColoradoIeReceiver;
  dataset: ColoradoIeDataset;
  candidate: ColoradoIeCandidateSource;
}) {
  check(
    isColoradoReportedIeEnabled() && isColoradoCampaignFinanceSyncEnabled(),
    "colorado_ie_write_disabled",
  );
  const { receiver, dataset, candidate } = input;
  check(
    isVerifiedColoradoIeDataset(dataset) &&
      isVerifiedColoradoIeCandidateSource(candidate),
    "unverified_colorado_ie_source",
  );
  for (const key of [
    "candidateName",
    "party",
    "officeName",
    "electionYear",
    "electionDate",
    "receivingId",
    "receivingName",
    "tracerCandidateId",
    "districtName",
  ] as const)
    check(
      candidate.expected[key] === receiver[key],
      "ie_expected_context_changed",
    );
  const projection = aggregateColoradoReportedIe(dataset, candidate),
    facts: ColoradoIeStoredFacts = {
      revision: coloradoIeRevision(receiver),
      startDate: dataset.startDate,
      endDate: dataset.endDate,
      dataset: dataset.source,
      candidate: candidate.source,
    };
  validateColoradoIeStored(receiver, candidate.identity, facts, projection);
  const observedAt = [
      facts.dataset.observedAt,
      facts.candidate.observedAt,
    ].sort()[0]!,
    completedAt = [facts.dataset.completedAt, facts.candidate.completedAt]
      .sort()
      .at(-1)!;
  check(
    Date.now() - Date.parse(observedAt) <= 36 * 3600000,
    "stale_ie_write_source",
  );
  const client = await input.db.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await lockColoradoIeReceiver(client, receiver);
    const old = (
      await client.query(
        `SELECT * FROM public.co_reported_ie_sources WHERE link_id=$1 AND election_year=$2 FOR UPDATE`,
        [receiver.linkId, receiver.electionYear],
      )
    ).rows[0];
    if (old) {
      const previous = old.source_facts as ColoradoIeStoredFacts;
      check(
        previous?.dataset?.observedAt <= facts.dataset.observedAt &&
          previous?.dataset?.completedAt <= facts.dataset.completedAt &&
          previous?.candidate?.observedAt <= facts.candidate.observedAt &&
          previous?.candidate?.completedAt <= facts.candidate.completedAt,
        "ie_source_regression",
      );
      if (
        isDeepStrictEqual(old.receiver_context, receiver) &&
        isDeepStrictEqual(old.native_identity, candidate.identity) &&
        isDeepStrictEqual(old.source_facts, facts) &&
        isDeepStrictEqual(old.aggregation_controls, projection.controls)
      ) {
        const groups = (
          await client.query(
            `SELECT reported_key key,reported_name "reportedName",stance,amount_cents::float8 "amountCents",occurrence_count "occurrenceCount" FROM public.co_reported_ie_groups WHERE link_id=$1 AND election_year=$2 ORDER BY stance,reported_key`,
            [receiver.linkId, receiver.electionYear],
          )
        ).rows;
        const sorted = [...projection.groups].sort(
          (a, b) =>
            a.stance.localeCompare(b.stance) || a.key.localeCompare(b.key),
        );
        if (
          isDeepStrictEqual(
            groups.sort(
              (a, b) =>
                a.stance.localeCompare(b.stance) || a.key.localeCompare(b.key),
            ),
            sorted,
          )
        ) {
          await client.query("COMMIT");
          begun = false;
          return { groups: groups.length, idempotent: true };
        }
      }
    }
    await client.query(
      `INSERT INTO public.co_reported_ie_sources(link_id,election_year,candidate_id,election_id,receiver_context,native_identity,source_facts,aggregation_controls,source_observed_at,source_completed_at,last_synced_at)
   VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
   ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiver_context=EXCLUDED.receiver_context,native_identity=EXCLUDED.native_identity,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,source_completed_at=EXCLUDED.source_completed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [
        receiver.linkId,
        receiver.electionYear,
        receiver.candidateId,
        receiver.electionId,
        JSON.stringify(receiver),
        JSON.stringify(candidate.identity),
        JSON.stringify(facts),
        JSON.stringify(projection.controls),
        observedAt,
        completedAt,
        new Date().toISOString(),
      ],
    );
    await client.query(
      "DELETE FROM public.co_reported_ie_groups WHERE link_id=$1 AND election_year=$2",
      [receiver.linkId, receiver.electionYear],
    );
    if (projection.groups.length)
      await client.query(
        `INSERT INTO public.co_reported_ie_groups(link_id,election_year,reported_key,reported_name,stance,amount_cents,occurrence_count) SELECT $1::uuid,$2::int,x.key,x."reportedName",x.stance,x."amountCents",x."occurrenceCount" FROM jsonb_to_recordset($3::jsonb) x(key text,"reportedName" text,stance text,"amountCents" bigint,"occurrenceCount" int)`,
        [
          receiver.linkId,
          receiver.electionYear,
          JSON.stringify(projection.groups),
        ],
      );
    await client.query("COMMIT");
    begun = false;
    return { groups: projection.groups.length, idempotent: false };
  } catch (e) {
    if (begun) await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

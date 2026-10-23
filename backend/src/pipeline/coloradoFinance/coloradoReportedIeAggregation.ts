import {
  ColoradoReportError,
  coloradoReportedNameKey,
} from "./coloradoTracerReports.js";
import {
  coloradoIePersonMatches,
  coloradoPartyKey,
} from "./coloradoNativeCandidateIdentity.js";
import { coloradoTargetHasUniqueNativeCycle } from "./coloradoNativePeerIdentity.js";
import type {
  ColoradoIeCandidateSource,
  ColoradoIeDataset,
} from "./coloradoReportedIeSource.js";

export type ColoradoReportedIeGroup = {
  key: string;
  reportedName: string;
  stance: "support" | "oppose";
  amountCents: number;
  occurrenceCount: number;
};
export type ColoradoReportedIeProjection = {
  groups: ColoradoReportedIeGroup[];
  controls: {
    sourceParents: number;
    sourceTargets: number;
    sourceSignedParentMicros: string;
    sourceSignedParentCents: number | null;
    sourceFractionalCentParents: number;
    sourceUnidentifiedTargets: number;
    outsideCycleParents: number;
    sharedCandidateParents: number;
    allocatedParents: number;
    supportCents: number;
    opposeCents: number;
    ambiguousCandidateParents?: number;
  };
};
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ColoradoReportError(code);
}
function cents(micros: bigint): number {
  check(micros % 10_000n === 0n, "non_cent_candidate_group");
  const value = Number(micros / 10_000n);
  check(Number.isSafeInteger(value), "unsafe_candidate_sum");
  return value;
}
/** Pure metric projection. The protected writer separately requires verified,
 * immutable original-backed packets and rechecks current canonical intent. */
export function aggregateColoradoReportedIe(
  dataset: Pick<
    ColoradoIeDataset,
    "electionYear" | "startDate" | "endDate" | "reports" | "registry"
  >,
  candidate: Pick<ColoradoIeCandidateSource, "identity" | "expected" | "peers">,
): ColoradoReportedIeProjection {
  const { identity } = candidate;
  const legislative = !!identity.districtName,
    nativeOffice = identity.nativeOfficeName ?? identity.officeName;
  check(
    !legislative ||
      (candidate.peers &&
        candidate.peers.length > 0 &&
        candidate.peers.length === identity.peerCandidateCount &&
        candidate.peers.reduce((n, p) => n + p.campaigns.length, 0) ===
          identity.peerCampaignCount),
    "missing_native_legislative_peers",
  );
  check(
    dataset.electionYear === identity.cycleYear &&
      dataset.startDate <= identity.cycleStart &&
      dataset.endDate >= identity.cycleStart,
    "incomplete_native_cycle_coverage",
  );
  const knownReporters = new Set(
    dataset.registry.map((r) => coloradoReportedNameKey(r.name)),
  );
  const groups = new Map<
    string,
    {
      key: string;
      reportedName: string;
      stance: "support" | "oppose";
      micros: bigint;
      occurrenceCount: number;
    }
  >();
  const controls: ColoradoReportedIeProjection["controls"] = {
    sourceParents: 0,
    sourceTargets: 0,
    sourceSignedParentMicros: "0",
    sourceSignedParentCents: 0,
    sourceFractionalCentParents: 0,
    sourceUnidentifiedTargets: 0,
    outsideCycleParents: 0,
    sharedCandidateParents: 0,
    allocatedParents: 0,
    supportCents: 0,
    opposeCents: 0,
    ...(legislative ? { ambiguousCandidateParents: 0 } : {}),
  };
  let sourceTotal = 0n;
  for (const report of dataset.reports) {
    check(
      report.startDate === dataset.startDate &&
        report.endDate === dataset.endDate &&
        report.parentCount === report.expenses.length &&
        report.targetCount ===
          report.expenses.reduce((n, e) => n + e.targets.length, 0),
      "native_report_population_changed",
    );
    const reportMicros = report.expenses.reduce(
      (n, e) => n + BigInt(e.amountMicros),
      0n,
    );
    check(
      reportMicros === BigInt(report.signedParentMicros),
      "native_report_money_changed",
    );
    sourceTotal += reportMicros;
    controls.sourceParents += report.parentCount;
    controls.sourceTargets += report.targetCount;
    controls.sourceFractionalCentParents += report.fractionalCentParents;
    for (const expense of report.expenses) {
      controls.sourceUnidentifiedTargets += expense.targets.filter(
        (t) =>
          !t.name ||
          !t.stance ||
          !coloradoPartyKey(t.party) ||
          !t.office ||
          t.office.toUpperCase() === "UNSPECIFIED",
      ).length;
      if (
        expense.date < identity.cycleStart ||
        expense.date > identity.cycleEnd
      ) {
        controls.outsideCycleParents++;
        continue;
      }
      const matches = expense.targets.filter(
        (t) =>
          t.name &&
          coloradoIePersonMatches(identity.candidateName, t.name) &&
          coloradoReportedNameKey(t.office) ===
            coloradoReportedNameKey(nativeOffice) &&
          (!legislative ||
            !coloradoPartyKey(t.party) ||
            coloradoPartyKey(t.party) === identity.party),
      );
      if (!matches.length) continue;
      check(
        matches.every(
          (t) =>
            !coloradoPartyKey(t.party) ||
            coloradoPartyKey(t.party) === identity.party,
        ),
        "ie_target_party_conflict",
      );
      if (!matches.some((t) => coloradoPartyKey(t.party) === identity.party))
        continue;
      if (expense.targets.length !== 1) {
        controls.sharedCandidateParents++;
        continue;
      }
      const target = matches[0]!;
      check(target.stance, "unresolved_ie_stance");
      if (
        legislative &&
        !coloradoTargetHasUniqueNativeCycle({
          target,
          date: expense.date,
          profiles: candidate.peers!,
          candidateId: identity.candidateId,
          cycleYear: identity.cycleYear,
          party: identity.party,
          officeName: nativeOffice,
          districtName: identity.districtName!,
        })
      ) {
        controls.ambiguousCandidateParents!++;
        continue;
      }
      const key = coloradoReportedNameKey(expense.reportedName);
      check(knownReporters.has(key), "unverified_ie_reporting_name");
      const groupKey = `${target.stance}:${key}`,
        existing = groups.get(groupKey) ?? {
          key,
          reportedName: expense.reportedName,
          stance: target.stance,
          micros: 0n,
          occurrenceCount: 0,
        };
      existing.micros += BigInt(expense.amountMicros);
      existing.occurrenceCount++;
      controls.allocatedParents++;
      if (expense.reportedName < existing.reportedName)
        existing.reportedName = expense.reportedName;
      groups.set(groupKey, existing);
    }
  }
  controls.sourceSignedParentMicros = String(sourceTotal);
  controls.sourceSignedParentCents =
    sourceTotal % 10_000n === 0n ? cents(sourceTotal) : null;
  const result: ColoradoReportedIeGroup[] = [];
  let support = 0n,
    oppose = 0n;
  for (const group of groups.values()) {
    check(group.micros >= 0n, "negative_net_ie_group");
    const amountCents = cents(group.micros);
    if (group.stance === "support") support += group.micros;
    else oppose += group.micros;
    if (amountCents === 0) continue;
    result.push({
      key: group.key,
      reportedName: group.reportedName,
      stance: group.stance,
      amountCents,
      occurrenceCount: group.occurrenceCount,
    });
  }
  controls.supportCents = cents(support);
  controls.opposeCents = cents(oppose);
  result.sort(
    (a, b) =>
      b.amountCents - a.amountCents ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      (a.stance < b.stance ? -1 : a.stance > b.stance ? 1 : 0),
  );
  return { groups: result, controls };
}

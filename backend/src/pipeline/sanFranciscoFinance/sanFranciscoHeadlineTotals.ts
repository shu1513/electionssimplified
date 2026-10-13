// Headline totals from the SFEC dashboard manifest (plan Phase 4): the
// manifest's reconciled figures ARE the headline — total_raised = funds and
// total_spent = expenses per candidate (both verified against the rendered
// dashboards to the cent in Phase 0), and the outside support/oppose totals
// are the sums of the candidate's manifest relations by direction. The raw
// DataSF path never reproduces expenses or outside tagging (Phase 0 result),
// so nothing here consults it.
import type {
  SanFranciscoContestManifest,
  SanFranciscoManifestCandidate,
} from "./sanFranciscoDashboardManifestClient.js";
import {
  sanFranciscoCandidateNameMatches,
  sanFranciscoSyntheticSpenderId,
} from "./sanFranciscoCandidateCommitteeResolver.js";

export type SanFranciscoOutsideGroup = {
  /** Real FPPC id, or the synthetic "name:…" identity for id-less spenders. */
  spenderId: string;
  spenderName: string;
  supportOppose: "support" | "oppose";
  amountCents: number;
  sourceUrl: string;
};

export type SanFranciscoHeadlineTotals = {
  totalRaisedCents: number;
  totalSpentCents: number;
  outsideSupportCents: number;
  outsideOpposeCents: number;
  groups: SanFranciscoOutsideGroup[];
};

function checkedCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("San Francisco dashboard headline has invalid money");
  return value;
}

function addCents(left: number, right: number): number {
  return checkedCents(checkedCents(left) + checkedCents(right));
}

export function aggregateSanFranciscoHeadlineTotals(input: {
  manifest: SanFranciscoContestManifest;
  candidate: SanFranciscoManifestCandidate;
}): SanFranciscoHeadlineTotals {
  // Revalidate cached/runtime input before filtering. A malformed relation
  // must not silently disappear from the direction totals or become zero.
  if (!Array.isArray(input.manifest.outsideRelations))
    throw new Error(
      "San Francisco dashboard headline has no outside relations list",
    );
  for (const relation of input.manifest.outsideRelations) {
    if (
      !relation ||
      (relation.position !== "support" && relation.position !== "oppose") ||
      typeof relation.candidateName !== "string" ||
      !relation.candidateName.trim() ||
      typeof relation.spenderName !== "string" ||
      !relation.spenderName.trim() ||
      (relation.candidateFppcId !== null &&
        !/^\d{4,12}$/.test(relation.candidateFppcId)) ||
      (relation.spenderFppcId !== null &&
        !/^\d{4,12}$/.test(relation.spenderFppcId))
    )
      throw new Error(
        "San Francisco dashboard headline has an invalid outside relation",
      );
    checkedCents(relation.amountCents);
  }
  // A relation targets this candidate by controlled-committee FPPC id when
  // the manifest carries one, by name otherwise — the same order the Phase 3
  // auto-link uses. An id that names a DIFFERENT committee is decisive; the
  // name fallback never overrides it.
  const targeted = input.manifest.outsideRelations.filter((relation) =>
    relation.candidateFppcId !== null
      ? relation.candidateFppcId === input.candidate.fppcId
      : sanFranciscoCandidateNameMatches(
          relation.candidateName,
          input.candidate.candidateName,
        ),
  );
  // One committee may legitimately support one candidate and oppose another,
  // so grouping is per (spender, direction). Duplicate manifest rows for the
  // same pair sum rather than shadow.
  const groups = new Map<string, SanFranciscoOutsideGroup>();
  for (const relation of targeted) {
    const spenderId =
      relation.spenderFppcId ??
      sanFranciscoSyntheticSpenderId(relation.spenderName);
    const key = `${spenderId}\u0000${relation.position}`;
    const current = groups.get(key) ?? {
      spenderId,
      spenderName: relation.spenderName,
      supportOppose: relation.position,
      amountCents: 0,
      sourceUrl: input.manifest.sourceUrl,
    };
    current.amountCents = addCents(current.amountCents, relation.amountCents);
    groups.set(key, current);
  }
  const sorted = [...groups.values()].sort(
    (a, b) =>
      b.amountCents - a.amountCents ||
      a.spenderName.localeCompare(b.spenderName),
  );
  return {
    totalRaisedCents: checkedCents(input.candidate.fundsCents),
    totalSpentCents: checkedCents(input.candidate.expensesCents),
    outsideSupportCents: sorted
      .filter((group) => group.supportOppose === "support")
      .reduce((sum, group) => addCents(sum, group.amountCents), 0),
    outsideOpposeCents: sorted
      .filter((group) => group.supportOppose === "oppose")
      .reduce((sum, group) => addCents(sum, group.amountCents), 0),
    groups: sorted,
  };
}

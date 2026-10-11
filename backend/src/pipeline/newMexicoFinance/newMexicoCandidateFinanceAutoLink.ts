import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceMissingLinksQuery,
  type StandardStateFinanceMissingLinkCandidateElection,
  type StandardStateFinanceMissingLinksQuery,
} from "../finance/standardStateFinanceMissingLinksQuery.js";

import {
  normalizeNewMexicoCandidateNameKeys,
  resolveNewMexicoCandidateCommittee,
  type NewMexicoCandidateCommitteeResolution,
} from "./newMexicoCandidateCommitteeResolver.js";
import { NEW_MEXICO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./newMexicoFinanceEligibleOffices.js";
import { upsertNewMexicoFinanceLink } from "./newMexicoFinanceWriter.js";
import type { NewMexicoCfisContributionRow } from "./newMexicoCfisArtifactReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type NewMexicoFinanceAutoLinkCandidateElection = StandardStateFinanceMissingLinkCandidateElection;

export type NewMexicoFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: NewMexicoCandidateCommitteeResolution["status"] | "linked";
      committeeId?: string;
      reason?: string;
    }
  | {
      candidateId: string;
      electionId: string;
      status: "error";
      reason: "auto_link_failed";
      error: string;
    };

const NEW_MEXICO_FINANCE_AUTO_LINK_OFFICE_KEYS = NEW_MEXICO_FINANCE_ELIGIBLE_OFFICE_KEYS.filter((key) =>
  key.startsWith("statewide::")
);

function canAutoLinkFromContributionRows(
  candidateElection: Pick<NewMexicoFinanceAutoLinkCandidateElection, "officeScope">
): boolean {
  return candidateElection.officeScope === "statewide";
}

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeNewMexicoCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function contributionCandidateName(row: NewMexicoCfisContributionRow): string {
  return [
    row["Candidate First Name"],
    row["Candidate Middle Name"],
    row["Candidate Last Name"],
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

export function buildNewMexicoCandidateNamePredicate(
  candidates: readonly NewMexicoFinanceAutoLinkCandidateElection[]
): (row: NewMexicoCfisContributionRow) => boolean {
  // The pre-filter must admit every row the resolver could match, so it
  // carries the same one-sided nickname keys ("Sam Kane" → SAMUEL KANE);
  // keyed literally it would drop the rows before resolution.
  const candidateNameKeys = new Set<string>();
  for (const candidate of candidates) {
    for (const key of normalizeNewMexicoCandidateNameKeys(candidate.candidateName, { expandNicknames: true })) {
      candidateNameKeys.add(key);
    }
  }

  return (row) => {
    for (const rowKey of normalizeNewMexicoCandidateNameKeys(contributionCandidateName(row))) {
      if (candidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

export const listNewMexicoCandidateElectionsMissingFinanceLinks: StandardStateFinanceMissingLinksQuery =
  createStandardStateFinanceMissingLinksQuery({
    state: "NM",
    linksTable: "nm_candidate_finance_links",
    eligibleOfficeKeys: [...NEW_MEXICO_FINANCE_AUTO_LINK_OFFICE_KEYS],
  });

export async function autoLinkNewMexicoCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: NewMexicoFinanceAutoLinkCandidateElection;
  contributionRows: readonly NewMexicoCfisContributionRow[];
  sourceUrl: string | null;
  now: Date;
}): Promise<NewMexicoFinanceAutoLinkResult> {
  if (!canAutoLinkFromContributionRows(input.candidateElection)) {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: "unmatched",
      reason: "unsupported_office",
    };
  }

  const resolution = resolveNewMexicoCandidateCommittee({
    candidateName: input.candidateElection.candidateName,
    officeScope: input.candidateElection.officeScope,
    officeName: input.candidateElection.officeName,
    electionYear: input.candidateElection.electionYear,
    district: input.candidateElection.district,
    contributionRows: input.contributionRows,
    sourceUrl: input.sourceUrl,
  });

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertNewMexicoFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.district,
      committeeId: resolution.committeeId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "cfis_bulk",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    committeeId: resolution.committeeId,
  };
}

export async function autoLinkMissingNewMexicoCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  contributionRowsByYear: ReadonlyMap<number, readonly NewMexicoCfisContributionRow[]>;
  sourceUrlByYear?: ReadonlyMap<number, string>;
  candidateElections?: readonly NewMexicoFinanceAutoLinkCandidateElection[];
}): Promise<NewMexicoFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listNewMexicoCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: NewMexicoFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkNewMexicoCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          contributionRows: input.contributionRowsByYear.get(candidateElection.electionYear) ?? [],
          sourceUrl: input.sourceUrlByYear?.get(candidateElection.electionYear) ?? null,
          now: input.now,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("New Mexico finance auto-link failed for candidate election; continuing:", {
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        electionYear: candidateElection.electionYear,
        error: message,
      });
      results.push({
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        status: "error",
        reason: "auto_link_failed",
        error: message,
      });
    }
  }
  return results;
}

import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceMissingLinksQuery,
  type StandardStateFinanceMissingLinkCandidateElection,
  type StandardStateFinanceMissingLinksQuery,
} from "../finance/standardStateFinanceMissingLinksQuery.js";

import {
  maineCandidateFirstLastKeys,
  normalizeMaineCandidateNameForStorage,
  normalizeMaineCandidateNameKeys,
  resolveMaineCandidateCommittee,
  type MaineCandidateCommitteeResolution,
} from "./maineCandidateCommitteeResolver.js";
import { MAINE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./maineFinanceEligibleOffices.js";
import { upsertMaineFinanceLink } from "./maineFinanceWriter.js";
import type { MaineCfisContributionRow } from "./maineCfisArtifactReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MaineFinanceAutoLinkCandidateElection = StandardStateFinanceMissingLinkCandidateElection;

export type MaineFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: MaineCandidateCommitteeResolution["status"] | "linked";
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

function contributionCandidateName(row: MaineCfisContributionRow): string {
  return row["Candidate Name"].trim();
}

// The pre-filter must admit every row the resolver could match. The resolver
// matches full-name keys and, through its middle-evidence fallback, any
// first+last alignment, including a nickname first name ("David G. Haggan" vs
// "Haggan, David"; "Mike" vs "MICHAEL"). Keyed on full names only, those rows
// were dropped before resolution. Nicknames expand on the VoteApp side only.
export function buildMaineCandidateNamePredicate(
  candidates: readonly MaineFinanceAutoLinkCandidateElection[]
): (row: MaineCfisContributionRow) => boolean {
  const candidateNameKeys = new Set<string>();
  const candidateFirstLastKeys = new Set<string>();
  for (const candidate of candidates) {
    for (const key of normalizeMaineCandidateNameKeys(candidate.candidateName)) {
      candidateNameKeys.add(key);
    }
    for (const key of maineCandidateFirstLastKeys(candidate.candidateName, { expandNicknames: true })) {
      candidateFirstLastKeys.add(key);
    }
  }

  return (row) => {
    const rowName = contributionCandidateName(row);
    for (const rowKey of normalizeMaineCandidateNameKeys(rowName)) {
      if (candidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    for (const rowKey of maineCandidateFirstLastKeys(rowName)) {
      if (candidateFirstLastKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

export const listMaineCandidateElectionsMissingFinanceLinks: StandardStateFinanceMissingLinksQuery =
  createStandardStateFinanceMissingLinksQuery({
    state: "ME",
    linksTable: "me_candidate_finance_links",
    eligibleOfficeKeys: [...MAINE_FINANCE_ELIGIBLE_OFFICE_KEYS],
  });

export async function autoLinkMaineCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: MaineFinanceAutoLinkCandidateElection;
  contributionRows: readonly MaineCfisContributionRow[];
  sourceUrl: string | null;
  now: Date;
}): Promise<MaineFinanceAutoLinkResult> {
  const resolution = resolveMaineCandidateCommittee({
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

  await upsertMaineFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeMaineCandidateNameForStorage(input.candidateElection.candidateName),
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

export async function autoLinkMissingMaineCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  contributionRowsByYear: ReadonlyMap<number, readonly MaineCfisContributionRow[]>;
  sourceUrlByYear?: ReadonlyMap<number, string>;
  candidateElections?: readonly MaineFinanceAutoLinkCandidateElection[];
}): Promise<MaineFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listMaineCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: MaineFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkMaineCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          contributionRows: input.contributionRowsByYear.get(candidateElection.electionYear) ?? [],
          sourceUrl: input.sourceUrlByYear?.get(candidateElection.electionYear) ?? null,
          now: input.now,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Maine finance auto-link failed for candidate election; continuing:", {
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

import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceMissingLinksQuery,
  type StandardStateFinanceMissingLinkCandidateElection,
  type StandardStateFinanceMissingLinksQuery,
} from "../finance/standardStateFinanceMissingLinksQuery.js";

import {
  normalizeIndianaCandidateNameKeys,
  resolveIndianaCandidateCommittee,
  type IndianaCandidateCommitteeResolution,
} from "./indianaCandidateCommitteeResolver.js";
import { INDIANA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./indianaFinanceEligibleOffices.js";
import { upsertIndianaFinanceLink } from "./indianaFinanceWriter.js";
import type { IndianaCampaignFinanceContributionRow } from "./indianaCampaignFinanceReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type IndianaFinanceAutoLinkCandidateElection = StandardStateFinanceMissingLinkCandidateElection;

export type IndianaFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: IndianaCandidateCommitteeResolution["status"] | "linked";
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

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeIndianaCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

export function buildIndianaCandidateNamePredicate(
  candidates: readonly IndianaFinanceAutoLinkCandidateElection[]
): (row: IndianaCampaignFinanceContributionRow) => boolean {
  const candidateNameKeys = new Set<string>();
  for (const candidate of candidates) {
    // The pre-filter must admit every row the resolver could match, so it
    // carries the same one-sided nickname keys ("Greg Ballard" → GREGORY
    // BALLARD); keyed literally it would drop the rows before resolution.
    for (const key of normalizeIndianaCandidateNameKeys(candidate.candidateName, { expandNicknames: true })) {
      candidateNameKeys.add(key);
    }
  }

  return (row) => {
    for (const rowKey of normalizeIndianaCandidateNameKeys(row.CandidateName)) {
      if (candidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

export const listIndianaCandidateElectionsMissingFinanceLinks: StandardStateFinanceMissingLinksQuery =
  createStandardStateFinanceMissingLinksQuery({
    state: "IN",
    linksTable: "in_candidate_finance_links",
    eligibleOfficeKeys: [...INDIANA_FINANCE_ELIGIBLE_OFFICE_KEYS],
  });

export async function autoLinkIndianaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: IndianaFinanceAutoLinkCandidateElection;
  contributionRows: readonly IndianaCampaignFinanceContributionRow[];
  sourceUrl: string | null;
  now: Date;
}): Promise<IndianaFinanceAutoLinkResult> {
  const resolution = resolveIndianaCandidateCommittee({
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

  await upsertIndianaFinanceLink({
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
      linkSource: "public_bulk",
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

export async function autoLinkMissingIndianaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  contributionRowsByYear: ReadonlyMap<number, readonly IndianaCampaignFinanceContributionRow[]>;
  sourceUrlByYear?: ReadonlyMap<number, string>;
  candidateElections?: readonly IndianaFinanceAutoLinkCandidateElection[];
}): Promise<IndianaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listIndianaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: IndianaFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkIndianaCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          contributionRows: input.contributionRowsByYear.get(candidateElection.electionYear) ?? [],
          sourceUrl: input.sourceUrlByYear?.get(candidateElection.electionYear) ?? null,
          now: input.now,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Indiana finance auto-link failed for candidate election; continuing:", {
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

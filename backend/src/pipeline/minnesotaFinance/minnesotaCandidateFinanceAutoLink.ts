import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceMissingLinksQuery,
  type StandardStateFinanceMissingLinkCandidateElection,
  type StandardStateFinanceMissingLinksQuery,
} from "../finance/standardStateFinanceMissingLinksQuery.js";

import {
  normalizeMinnesotaCandidateNameKeys,
  parseMinnesotaPccRecipient,
  resolveMinnesotaCandidateCommittee,
  type MinnesotaCandidateCommitteeResolution,
} from "./minnesotaCandidateCommitteeResolver.js";
import { MINNESOTA_FINANCE_AUTO_LINK_OFFICE_KEYS } from "./minnesotaFinanceEligibleOffices.js";
import { upsertMinnesotaFinanceLink } from "./minnesotaFinanceWriter.js";
import type { MinnesotaCampaignFinanceCsvRow } from "./minnesotaCampaignFinanceArtifactReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MinnesotaFinanceAutoLinkCandidateElection = StandardStateFinanceMissingLinkCandidateElection;

export type MinnesotaFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: MinnesotaCandidateCommitteeResolution["status"] | "linked";
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

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeMinnesotaCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function candidateNameFromContributionRow(row: MinnesotaCampaignFinanceCsvRow): string {
  if (row["Recipient"]?.trim()) {
    return parseMinnesotaPccRecipient(row)?.candidateName ?? "";
  }
  const candidates = [
    row["Candidate"],
    row["Candidate Name"],
    row["candidate"],
    row["candidate_name"],
  ];
  for (const value of candidates) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "";
}

export function buildMinnesotaCandidateNamePredicate(
  candidates: readonly MinnesotaFinanceAutoLinkCandidateElection[]
): (row: MinnesotaCampaignFinanceCsvRow) => boolean {
  // The pre-filter must admit every row the resolver could match, so it
  // carries the same one-sided nickname keys ("Ron Latz" → RONALD LATZ);
  // keyed literally it would drop the rows before resolution.
  const candidateNameKeys = new Set<string>();
  for (const candidate of candidates) {
    for (const key of normalizeMinnesotaCandidateNameKeys(candidate.candidateName, { expandNicknames: true })) {
      candidateNameKeys.add(key);
    }
  }

  return (row) => {
    const rawName = candidateNameFromContributionRow(row);
    if (!rawName) {
      return false;
    }
    for (const rowKey of normalizeMinnesotaCandidateNameKeys(rawName)) {
      if (candidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

export const listMinnesotaCandidateElectionsMissingFinanceLinks: StandardStateFinanceMissingLinksQuery =
  createStandardStateFinanceMissingLinksQuery({
    state: "MN",
    linksTable: "mn_candidate_finance_links",
    eligibleOfficeKeys: [...MINNESOTA_FINANCE_AUTO_LINK_OFFICE_KEYS],
  });

export async function autoLinkMinnesotaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: MinnesotaFinanceAutoLinkCandidateElection;
  contributionRows: readonly MinnesotaCampaignFinanceCsvRow[];
  sourceUrl?: string | null;
  now: Date;
}): Promise<MinnesotaFinanceAutoLinkResult> {
  const resolution = resolveMinnesotaCandidateCommittee({
    candidateName: input.candidateElection.candidateName,
    officeScope: input.candidateElection.officeScope,
    officeName: input.candidateElection.officeName,
    electionYear: input.candidateElection.electionYear,
    district: input.candidateElection.district,
    candidateRows: input.contributionRows,
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

  await upsertMinnesotaFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: requireNonEmpty(input.candidateElection.officeName, "office name"),
      district: input.candidateElection.district,
      committeeId: resolution.committeeId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "mn_board",
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

export async function autoLinkMissingMinnesotaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly MinnesotaFinanceAutoLinkCandidateElection[];
  contributionRows: readonly MinnesotaCampaignFinanceCsvRow[];
  sourceUrl?: string | null;
}): Promise<MinnesotaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listMinnesotaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: MinnesotaFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkMinnesotaCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          contributionRows: input.contributionRows,
          sourceUrl: input.sourceUrl,
          now: input.now,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Minnesota finance auto-link failed for candidate election; continuing:", {
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

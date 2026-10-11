import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceMissingLinksQuery,
  type StandardStateFinanceMissingLinkCandidateElection,
  type StandardStateFinanceMissingLinksQuery,
} from "../finance/standardStateFinanceMissingLinksQuery.js";

import {
  normalizeMarylandCandidateNameForStorage,
  normalizeMarylandCandidateNameKeys,
  resolveMarylandCandidateCommittee,
  type MarylandCandidateCommitteeResolution,
} from "./marylandCandidateCommitteeResolver.js";
import type { MarylandCfsCommitteeRow } from "./marylandCfsArtifactReader.js";
import { MARYLAND_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./marylandFinanceEligibleOffices.js";
import { upsertMarylandFinanceLink } from "./marylandFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MarylandFinanceAutoLinkCandidateElection = StandardStateFinanceMissingLinkCandidateElection;

export type MarylandFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: MarylandCandidateCommitteeResolution["status"] | "linked";
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

function committeeCandidateName(row: MarylandCfsCommitteeRow): string {
  return [
    row["Candidate First Name"],
    row["Candidate Middle Name"],
    row["Candidate LastName"],
    row["Candidate Suffix"],
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

export function buildMarylandCandidateNamePredicate(
  candidates: readonly MarylandFinanceAutoLinkCandidateElection[]
): (row: MarylandCfsCommitteeRow) => boolean {
  // The pre-filter must admit every row the resolver could match: the
  // resolver also matches on committee-name tokens ("Moore, Wes For
  // Maryland" beside candidate fields "WESTLEY MOORE"), so rows are kept by
  // surname token in either place and the resolver decides.
  const surnames = new Set<string>();
  for (const candidate of candidates) {
    for (const key of normalizeMarylandCandidateNameKeys(candidate.candidateName)) {
      const tokens = key.split(" ").filter(Boolean);
      if (tokens.length >= 2) {
        surnames.add(tokens[tokens.length - 1]!);
      }
    }
  }

  return (row) => {
    for (const text of [committeeCandidateName(row), row["Committee Name"] ?? ""]) {
      for (const key of normalizeMarylandCandidateNameKeys(text)) {
        for (const token of key.split(" ")) {
          if (token && surnames.has(token)) {
            return true;
          }
        }
      }
    }
    return false;
  };
}

export const listMarylandCandidateElectionsMissingFinanceLinks: StandardStateFinanceMissingLinksQuery =
  createStandardStateFinanceMissingLinksQuery({
    state: "MD",
    linksTable: "md_candidate_finance_links",
    eligibleOfficeKeys: [...MARYLAND_FINANCE_ELIGIBLE_OFFICE_KEYS],
  });

export async function autoLinkMarylandCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: MarylandFinanceAutoLinkCandidateElection;
  committeeRows: readonly MarylandCfsCommitteeRow[];
  sourceUrl: string | null;
  now: Date;
}): Promise<MarylandFinanceAutoLinkResult> {
  const resolution = resolveMarylandCandidateCommittee({
    candidateName: input.candidateElection.candidateName,
    officeScope: input.candidateElection.officeScope,
    officeName: input.candidateElection.officeName,
    electionYear: input.candidateElection.electionYear,
    district: input.candidateElection.district,
    committeeRows: input.committeeRows,
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

  await upsertMarylandFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeMarylandCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.district,
      committeeId: resolution.committeeId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "cfs_public_export",
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

export async function autoLinkMissingMarylandCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  committeeRowsByYear: ReadonlyMap<number, readonly MarylandCfsCommitteeRow[]>;
  sourceUrlByYear?: ReadonlyMap<number, string>;
  candidateElections?: readonly MarylandFinanceAutoLinkCandidateElection[];
}): Promise<MarylandFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listMarylandCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: MarylandFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkMarylandCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          committeeRows: input.committeeRowsByYear.get(candidateElection.electionYear) ?? [],
          sourceUrl: input.sourceUrlByYear?.get(candidateElection.electionYear) ?? null,
          now: input.now,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Maryland finance auto-link failed for candidate election; continuing:", {
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

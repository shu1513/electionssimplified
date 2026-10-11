import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceMissingLinksQuery,
  type StandardStateFinanceMissingLinkCandidateElection,
  type StandardStateFinanceMissingLinksQuery,
} from "../finance/standardStateFinanceMissingLinksQuery.js";

import {
  canonicalOklahomaCandidateOfficeName,
  normalizeOklahomaCandidateDistrict,
  normalizeOklahomaCandidateNameKeys,
  oklahomaCandidateNameMiddleConflict,
  resolveOklahomaCandidateCommittee,
  type OklahomaCandidateCommitteeResolution,
} from "./oklahomaCandidateCommitteeResolver.js";
import { OKLAHOMA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./oklahomaFinanceEligibleOffices.js";
import { upsertOklahomaFinanceLink } from "./oklahomaFinanceWriter.js";
import {
  fetchOklahomaGuardianCandidateDetail,
  type OklahomaGuardianCandidateDetail,
} from "./oklahomaGuardianCandidateDetail.js";
import type { OklahomaGuardianContributionRow } from "./oklahomaGuardianContributionReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type OklahomaGuardianCandidateDetailFetcher = (input: {
  organizationId: string;
}) => Promise<OklahomaGuardianCandidateDetail>;

export type OklahomaFinanceAutoLinkCandidateElection = StandardStateFinanceMissingLinkCandidateElection;

export type OklahomaFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: OklahomaCandidateCommitteeResolution["status"] | "linked";
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
  const keys = normalizeOklahomaCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function candidateNameKeysIntersect(left: string, right: string): boolean {
  // `right` is the app candidate, so it alone gets nickname keys.
  const rightKeys = normalizeOklahomaCandidateNameKeys(right, { expandNicknames: true });
  for (const leftKey of normalizeOklahomaCandidateNameKeys(left)) {
    if (rightKeys.has(leftKey)) {
      // `right` is the app candidate; `left` is the Guardian detail page name.
      return !oklahomaCandidateNameMiddleConflict(right, left);
    }
  }
  return false;
}

function guardianDetailMatchesCandidateElection(input: {
  detail: OklahomaGuardianCandidateDetail;
  candidateElection: OklahomaFinanceAutoLinkCandidateElection;
}): boolean {
  if (!candidateNameKeysIntersect(input.detail.candidateName, input.candidateElection.candidateName)) {
    return false;
  }
  const expectedOffice = canonicalOklahomaCandidateOfficeName(input.candidateElection.officeName);
  const detailOffice = canonicalOklahomaCandidateOfficeName(input.detail.officeName);
  if (!expectedOffice || detailOffice !== expectedOffice) {
    return false;
  }
  if (!input.detail.electionYears.includes(input.candidateElection.electionYear)) {
    return false;
  }
  if (input.candidateElection.officeScope === "state_upper" || input.candidateElection.officeScope === "state_lower") {
    const expectedDistrict = normalizeOklahomaCandidateDistrict(input.candidateElection.district);
    const detailDistrict = normalizeOklahomaCandidateDistrict(input.detail.district);
    return Boolean(expectedDistrict) && detailDistrict === expectedDistrict;
  }
  return true;
}

async function disambiguateOklahomaCandidateCommittee(input: {
  resolution: Extract<OklahomaCandidateCommitteeResolution, { status: "ambiguous" }>;
  candidateElection: OklahomaFinanceAutoLinkCandidateElection;
  fetchCandidateDetail: OklahomaGuardianCandidateDetailFetcher;
}): Promise<OklahomaCandidateCommitteeResolution> {
  let details: OklahomaGuardianCandidateDetail[];
  try {
    details = await Promise.all(
      input.resolution.matches.map((match) => input.fetchCandidateDetail({ organizationId: match.committeeId }))
    );
  } catch (error) {
    console.warn("Oklahoma Guardian candidate-detail lookup failed; preserving ambiguous committee resolution:", {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      committeeIds: input.resolution.matches.map((match) => match.committeeId),
      error: error instanceof Error ? error.message : String(error),
    });
    return input.resolution;
  }

  const matches = input.resolution.matches.filter((match, index) => {
    const detail = details[index];
    return (
      detail?.organizationId === match.committeeId &&
      guardianDetailMatchesCandidateElection({ detail, candidateElection: input.candidateElection })
    );
  });
  if (matches.length !== 1) {
    return input.resolution;
  }

  return { status: "matched", ...matches[0]! };
}

export function buildOklahomaCandidateNamePredicate(
  candidates: readonly OklahomaFinanceAutoLinkCandidateElection[]
): (row: OklahomaGuardianContributionRow) => boolean {
  // The pre-filter must admit every row the resolver could match, so it
  // carries the same one-sided nickname keys ("Josh Cantrell" → JOSHUA
  // CANTRELL); keyed literally it would drop the rows before resolution.
  const candidateNameKeys = new Set<string>();
  for (const candidate of candidates) {
    for (const key of normalizeOklahomaCandidateNameKeys(candidate.candidateName, { expandNicknames: true })) {
      candidateNameKeys.add(key);
    }
  }

  return (row) => {
    for (const rowKey of normalizeOklahomaCandidateNameKeys(row["Candidate Name"])) {
      if (candidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

export const listOklahomaCandidateElectionsMissingFinanceLinks: StandardStateFinanceMissingLinksQuery =
  createStandardStateFinanceMissingLinksQuery({
    state: "OK",
    linksTable: "ok_candidate_finance_links",
    eligibleOfficeKeys: [...OKLAHOMA_FINANCE_ELIGIBLE_OFFICE_KEYS],
  });

export async function autoLinkOklahomaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: OklahomaFinanceAutoLinkCandidateElection;
  contributionRows: readonly OklahomaGuardianContributionRow[];
  sourceUrl: string | null;
  now: Date;
  fetchCandidateDetail?: OklahomaGuardianCandidateDetailFetcher;
}): Promise<OklahomaFinanceAutoLinkResult> {
  let resolution = resolveOklahomaCandidateCommittee({
    candidateName: input.candidateElection.candidateName,
    officeScope: input.candidateElection.officeScope,
    officeName: input.candidateElection.officeName,
    electionYear: input.candidateElection.electionYear,
    district: input.candidateElection.district,
    contributionRows: input.contributionRows,
    sourceUrl: input.sourceUrl,
  });

  if (resolution.status === "ambiguous") {
    resolution = await disambiguateOklahomaCandidateCommittee({
      resolution,
      candidateElection: input.candidateElection,
      fetchCandidateDetail: input.fetchCandidateDetail ?? fetchOklahomaGuardianCandidateDetail,
    });
  }

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertOklahomaFinanceLink({
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
      linkSource: "guardian_bulk",
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

export async function autoLinkMissingOklahomaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  contributionRowsByYear: ReadonlyMap<number, readonly OklahomaGuardianContributionRow[]>;
  sourceUrlByYear?: ReadonlyMap<number, string>;
  candidateElections?: readonly OklahomaFinanceAutoLinkCandidateElection[];
  fetchCandidateDetail?: OklahomaGuardianCandidateDetailFetcher;
}): Promise<OklahomaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listOklahomaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  const fetchCandidateDetail = input.fetchCandidateDetail ?? fetchOklahomaGuardianCandidateDetail;
  const candidateDetailByOrganizationId = new Map<string, Promise<OklahomaGuardianCandidateDetail>>();
  const fetchCandidateDetailOnce: OklahomaGuardianCandidateDetailFetcher = ({ organizationId }) => {
    const existing = candidateDetailByOrganizationId.get(organizationId);
    if (existing) {
      return existing;
    }
    const pending = fetchCandidateDetail({ organizationId });
    candidateDetailByOrganizationId.set(organizationId, pending);
    return pending;
  };

  const results: OklahomaFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkOklahomaCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          contributionRows: input.contributionRowsByYear.get(candidateElection.electionYear) ?? [],
          sourceUrl: input.sourceUrlByYear?.get(candidateElection.electionYear) ?? null,
          now: input.now,
          fetchCandidateDetail: fetchCandidateDetailOnce,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Oklahoma finance auto-link failed for candidate election; continuing:", {
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

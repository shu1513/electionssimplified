import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceMissingLinksQuery,
  type StandardStateFinanceMissingLinkCandidateElection,
  type StandardStateFinanceMissingLinksQuery,
} from "../finance/standardStateFinanceMissingLinksQuery.js";

import {
  fetchVirginiaCampaignFinanceReport,
  fetchVirginiaCommitteeReportList,
  searchVirginiaCandidateCommittees,
  type VirginiaCampaignFinanceClientOptions,
  type VirginiaReportHeader,
} from "./virginiaCampaignFinanceClient.js";
import {
  normalizeVirginiaCandidateNameKeys,
  resolveVirginiaCandidateCommittee,
  resolveVirginiaCandidateCommitteeAcrossSearches,
  type VirginiaCandidateCommitteeResolution,
} from "./virginiaCandidateCommitteeResolver.js";
import { VIRGINIA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./virginiaFinanceEligibleOffices.js";
import { upsertVirginiaFinanceLink } from "./virginiaFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type VirginiaFinanceAutoLinkCandidateElection = StandardStateFinanceMissingLinkCandidateElection;

export type VirginiaFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: VirginiaCandidateCommitteeResolution["status"] | "linked";
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

export type VirginiaCandidateCommitteeResolver = (
  input: {
    candidateName: string;
    officeScope: string;
    officeName: string;
    electionYear: number;
  },
  options?: VirginiaCampaignFinanceClientOptions
) => Promise<VirginiaCandidateCommitteeResolution>;

const DEFAULT_MAX_REPORT_HEADERS_PER_COMMITTEE = 3;

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeVirginiaCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeDistrict(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function fetchReportHeadersForCommittee(input: {
  committeeId: string;
  options?: VirginiaCampaignFinanceClientOptions;
  maxReportHeadersPerCommittee?: number;
}): Promise<VirginiaReportHeader[]> {
  const reportList = await fetchVirginiaCommitteeReportList(input.committeeId, input.options);
  const maxReportHeadersPerCommittee = input.maxReportHeadersPerCommittee ?? DEFAULT_MAX_REPORT_HEADERS_PER_COMMITTEE;
  const reportIds = reportList.scheduledReportIds.slice(0, maxReportHeadersPerCommittee);
  const headers: VirginiaReportHeader[] = [];
  for (const reportId of reportIds) {
    const report = await fetchVirginiaCampaignFinanceReport(reportId, input.options);
    headers.push(report.header);
  }
  return headers;
}

export async function searchAndResolveVirginiaCandidateCommitteeWithReportHeaders(
  input: {
    candidateName: string;
    officeScope: string;
    officeName: string;
    electionYear: number;
    maxReportHeadersPerCommittee?: number;
  },
  options?: VirginiaCampaignFinanceClientOptions
): Promise<VirginiaCandidateCommitteeResolution> {
  // The surname retry returns the full-name committees again; fetch each
  // committee's report headers once.
  const reportHeadersByCommitteeId = new Map<string, VirginiaReportHeader[]>();

  return resolveVirginiaCandidateCommitteeAcrossSearches({
    candidateName: input.candidateName,
    search: (query) => searchVirginiaCandidateCommittees({ committeeName: query }, options),
    resolve: async (committeeResults) => {
      const reportHeaders: VirginiaReportHeader[] = [];
      for (const result of committeeResults) {
        let headers = reportHeadersByCommitteeId.get(result.committeeId);
        if (!headers) {
          try {
            headers = await fetchReportHeadersForCommittee({
              committeeId: result.committeeId,
              options,
              maxReportHeadersPerCommittee: input.maxReportHeadersPerCommittee,
            });
          } catch (error) {
            console.warn(
              "Virginia finance committee report metadata lookup failed; continuing without this committee's headers:",
              {
                committeeId: result.committeeId,
                error: error instanceof Error ? error.message : String(error),
              }
            );
            headers = [];
          }
          reportHeadersByCommitteeId.set(result.committeeId, headers);
        }
        reportHeaders.push(...headers);
      }

      return resolveVirginiaCandidateCommittee({
        candidateName: input.candidateName,
        officeScope: input.officeScope,
        officeName: input.officeName,
        electionYear: input.electionYear,
        committeeResults,
        ...(reportHeaders.length > 0 ? { reportHeaders } : {}),
      });
    },
  });
}

export const listVirginiaCandidateElectionsMissingFinanceLinks: StandardStateFinanceMissingLinksQuery =
  createStandardStateFinanceMissingLinksQuery({
    state: "VA",
    linksTable: "va_candidate_finance_links",
    eligibleOfficeKeys: [...VIRGINIA_FINANCE_ELIGIBLE_OFFICE_KEYS],
  });

export async function autoLinkVirginiaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: VirginiaFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: VirginiaCandidateCommitteeResolver;
  clientOptions?: VirginiaCampaignFinanceClientOptions;
}): Promise<VirginiaFinanceAutoLinkResult> {
  const resolveCandidateCommittee =
    input.resolveCandidateCommittee ?? searchAndResolveVirginiaCandidateCommitteeWithReportHeaders;
  const resolution = await resolveCandidateCommittee(
    {
      candidateName: input.candidateElection.candidateName,
      officeScope: input.candidateElection.officeScope,
      officeName: input.candidateElection.officeName,
      electionYear: input.candidateElection.electionYear,
    },
    input.clientOptions
  );

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertVirginiaFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.district,
      committeeId: resolution.committeeId,
      committeeCode: resolution.committeeCode,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "cfreports_search",
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

export async function autoLinkMissingVirginiaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly VirginiaFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: VirginiaCandidateCommitteeResolver;
  clientOptions?: VirginiaCampaignFinanceClientOptions;
}): Promise<VirginiaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listVirginiaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: VirginiaFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkVirginiaCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
          clientOptions: input.clientOptions,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Virginia finance auto-link failed for candidate election; continuing:", {
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

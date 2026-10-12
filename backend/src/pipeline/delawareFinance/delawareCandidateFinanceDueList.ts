// Delaware finance due list — the standard link-gated staleness query
// (active links whose summary is missing or older than staleAfterDays, for
// eligible offices inside the election window, never-synced first) narrowed
// to general-stage elections. election_date rides along for the window
// resolver; link_source is carried through so the sync writes the link back
// unchanged. The CFRS id is stored in committee_id and surfaces as cfId.

import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueListQuery,
  type StandardStateFinanceDueListInput,
} from "../finance/standardStateFinanceDueListQuery.js";
import { DELAWARE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./delawareFinanceEligibleOffices.js";
import type { DelawareFinanceLinkSource } from "./delawareFinanceWriter.js";

export type DelawareCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionDate: string;
  officeScope: string;
  officeName: string;
  district: string | null;
  cfId: string;
  committeeName: string;
  linkSource: DelawareFinanceLinkSource;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

const queryDueDelawareCandidateFinanceSyncRows: StandardStateFinanceDueListQuery<DelawareCandidateFinanceDueRow> =
  createStandardStateFinanceDueListQuery({
    state: "DE",
    tables: {
      links: "de_candidate_finance_links",
      summaries: "de_candidate_finance_summaries",
    },
    // The office-key constant is a Set; the builder binds a readonly array.
    eligibleOfficeKeys: [...DELAWARE_FINANCE_ELIGIBLE_OFFICE_KEYS],
    electionStage: "general",
    selectElectionDate: true,
    linkColumns: ["committee_id", "committee_name", "link_source"],
    mapRow: (row) => ({
      candidateId: row.candidate_id,
      electionId: row.election_id,
      candidateName: row.candidate_name,
      electionYear: row.election_year,
      electionDate: (row.election_date as string).slice(0, 10),
      officeScope: row.office_scope,
      officeName: row.office_name,
      district: row.district,
      cfId: row.committee_id as string,
      committeeName: row.committee_name as string,
      linkSource: row.link_source as DelawareFinanceLinkSource,
      sourceUrl: row.source_url,
      lastSyncedAt: row.last_synced_at,
    }),
  });

/** Validated before either live orchestration or the due SQL can run. */
export function validateDelawareFinanceSyncScope(
  input: Pick<StandardStateFinanceDueListInput, "candidateId" | "electionYear" | "refresh">
): void {
  if (
    input.candidateId !== undefined &&
    (typeof input.candidateId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.candidateId))
  ) {
    throw new Error("Invalid Delaware finance candidateId: expected UUID");
  }
  if (
    input.electionYear !== undefined &&
    (!Number.isSafeInteger(input.electionYear) || input.electionYear < 2026 || input.electionYear > 2100)
  ) {
    throw new Error("Invalid Delaware finance electionYear: expected 2026..2100");
  }
  if (input.refresh !== undefined && typeof input.refresh !== "boolean") {
    throw new Error("Invalid Delaware finance refresh: expected boolean");
  }
}

export const listDueDelawareCandidateFinanceSyncRows: StandardStateFinanceDueListQuery<
  DelawareCandidateFinanceDueRow
> = async (db, input) => {
  validateDelawareFinanceSyncScope(input);
  return queryDueDelawareCandidateFinanceSyncRows(db, input);
};

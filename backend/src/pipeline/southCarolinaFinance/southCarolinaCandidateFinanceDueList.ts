// South Carolina finance due list — the standard link-gated staleness query
// (active links whose summary is missing or older than staleAfterDays, for
// eligible offices inside the election window, never-synced first) narrowed
// to general-stage elections. The link identity is the Ethics filer id plus
// filer name; election_date rides along so the sync can derive the statutory
// cycle dates; link_source is carried through so the sync writes the link
// back unchanged.

import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueListQuery,
} from "../finance/standardStateFinanceDueListQuery.js";
import { SOUTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./southCarolinaFinanceEligibleOffices.js";
import type { SouthCarolinaFinanceLinkSource } from "./southCarolinaFinanceWriter.js";

export type SouthCarolinaCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionDate: string;
  officeScope: string;
  officeName: string;
  district: string | null;
  candidateFilerId: number;
  filerName: string;
  linkSource: SouthCarolinaFinanceLinkSource;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

function parseStoredFilerId(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid stored South Carolina candidate filer ID: ${value}`);
  }
  return parsed;
}

export const listDueSouthCarolinaCandidateFinanceSyncRows: StandardStateFinanceDueListQuery<SouthCarolinaCandidateFinanceDueRow> =
  createStandardStateFinanceDueListQuery({
    state: "SC",
    tables: {
      links: "sc_candidate_finance_links",
      summaries: "sc_candidate_finance_summaries",
    },
    eligibleOfficeKeys: SOUTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS,
    electionStage: "general",
    selectElectionDate: true,
    linkColumns: ["candidate_filer_id", "candidate_filer_name", "link_source"],
    mapRow: (row) => ({
      candidateId: row.candidate_id,
      electionId: row.election_id,
      candidateName: row.candidate_name,
      electionYear: row.election_year,
      electionDate: (row.election_date as string).slice(0, 10),
      officeScope: row.office_scope,
      officeName: row.office_name,
      district: row.district,
      candidateFilerId: parseStoredFilerId(row.candidate_filer_id as string),
      filerName: row.candidate_filer_name as string,
      linkSource: row.link_source as SouthCarolinaFinanceLinkSource,
      sourceUrl: row.source_url,
      lastSyncedAt: row.last_synced_at,
    }),
  });

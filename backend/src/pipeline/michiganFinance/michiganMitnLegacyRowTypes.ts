// The canonical row shape for the Michigan finance pipeline. The column names
// come from the legacy MiTN bulk-export CSV schema, which was frozen when
// Michigan launched the new MiTN system in April 2025. The archive-ingestion
// code is gone, but the row shape lives on: the MiTN public-search client maps
// its export rows onto this schema, and every aggregator and the committee
// resolver consume it.

export const MICHIGAN_MITN_LEGACY_CONTRIBUTION_COLUMNS = [
  "doc_seq_no",
  "page_no",
  "contribution_id",
  "cont_detail_id",
  "doc_stmnt_year",
  "doc_type_desc",
  "com_legal_name",
  "common_name",
  "cfr_com_id",
  "com_type",
  "can_first_name",
  "can_last_name",
  "contribtype",
  "f_name",
  "l_name_or_org",
  "address",
  "city",
  "state",
  "zip",
  "occupation",
  "employer",
  "received_date",
  "amount",
  "aggregate",
  "extra_desc",
] as const;

export const MICHIGAN_MITN_LEGACY_EXPENDITURE_COLUMNS = [
  "doc_seq_no",
  "doc_stmnt_year",
  "doc_type_desc",
  "com_legal_name",
  "common_name",
  "cfr_com_id",
  "com_type",
  "schedule_desc",
  "supp_opp",
  "can_or_ballot",
  "_column_29",
  "amount",
] as const;

export type MichiganMitnLegacyContributionRow = Record<
  (typeof MICHIGAN_MITN_LEGACY_CONTRIBUTION_COLUMNS)[number],
  string
>;
export type MichiganMitnLegacyExpenditureRow = Record<
  (typeof MICHIGAN_MITN_LEGACY_EXPENDITURE_COLUMNS)[number],
  string
> & {
  /** Modern MiTN explicitly names a target committee rather than a person. */
  target_committee_name?: string;
  target_office?: string;
};

// The legacy CFR bulk export was frozen when Michigan launched the new MiTN
// system in April 2025: the 2025 archive was the final one, so election years
// after it are served by the MiTN public search.
export const MICHIGAN_MITN_LEGACY_FINAL_ARCHIVE_YEAR = 2025;

export function normalizeMichiganMitnLegacyArchiveYear(year: number): number {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error(`Invalid Michigan MiTN legacy archive year: ${year}`);
  }
  return year;
}

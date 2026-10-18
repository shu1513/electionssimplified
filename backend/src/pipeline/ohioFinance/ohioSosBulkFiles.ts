import {
  normalizeOhioSosText,
  normalizeOhioSosTextOrNull,
  parseOhioSosAmountCents,
  parseOhioSosCsvFile,
  parseOhioSosDateIso,
  type OhioSosCsvRowSeparator,
} from "./ohioSosCsv.js";

// Pinned schemas + typed row mappers for every Ohio SoS bulk export the
// pipeline consumes (docs/plans/ohio_plan.md "Required artifacts per cycle Y"). Headers
// were captured byte-for-byte from the 2026-08-04 acquisition spike files;
// the parser compares them after whitespace/underscore normalization, so
// drift like CAC_EXP's "CANDIDATE FIRST NAME" (spaces, not underscores)
// still matches while a real column change fails loudly.

export type OhioSosBulkFileFamilyKey =
  | "candidate_list"
  | "pac_list"
  | "candidate_cover"
  | "pac_cover"
  | "party_cover"
  | "candidate_contributions"
  | "pac_contributions"
  | "party_contributions"
  | "candidate_expenditures"
  | "pac_expenditures"
  | "party_expenditures";

// Resolves a pinned column index at module load; throws immediately if a
// header constant and its mapper drift apart. `occurrence` handles the
// active-candidate list's duplicated OFFICE column (the second one holds the
// party — spike-verified: "…,HOUSE,87,REPUBLICAN,").
function col(header: readonly string[], name: string, occurrence = 0): number {
  let seen = 0;
  for (let index = 0; index < header.length; index += 1) {
    if (header[index] === name) {
      if (seen === occurrence) {
        return index;
      }
      seen += 1;
    }
  }
  throw new Error(`Ohio SoS header is missing column ${name} (occurrence ${occurrence})`);
}

function text(row: readonly string[], index: number): string {
  return normalizeOhioSosText(row[index]);
}

function textOrNull(row: readonly string[], index: number): string | null {
  return normalizeOhioSosTextOrNull(row[index]);
}

function yearOrNull(row: readonly string[], index: number): number | null {
  const value = normalizeOhioSosText(row[index]);
  return /^\d{4}$/.test(value) ? Number(value) : null;
}

function centsOrNull(row: readonly string[], index: number): number | null {
  return parseOhioSosAmountCents(row[index]);
}

// --- Committee lists -------------------------------------------------------

export const OHIO_SOS_CANDIDATE_LIST_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "COM_ADDRESS",
  "COM_CITY",
  "COM_STATE",
  "COM_ZIP",
  "TREA_FIRST_NAME",
  "TREA_LAST_NAME",
  "TREA_MIDDLE_NAME",
  "TREA_SUFFIX",
  "TREA_ADDRESS",
  "TREA_CITY",
  "TREA_STATE",
  "TREA_ZIP",
  "DEP_FIRST_NAME",
  "DEP_LAST_NAME",
  "CANDIDATE_FIRST_NAME",
  "CANDIDATE_LAST_NAME",
  "OFFICE",
  "DISTRICT",
  "OFFICE",
  "SPONSOR",
] as const;

export type OhioSosCandidateCommitteeListRow = {
  committeeName: string;
  masterKey: string;
  candidateFirstName: string | null;
  candidateLastName: string | null;
  office: string | null;
  district: string | null;
  // Second OFFICE column; actually the candidate's party.
  party: string | null;
};

const CANDIDATE_LIST = {
  committeeName: col(OHIO_SOS_CANDIDATE_LIST_HEADER, "COM_NAME"),
  masterKey: col(OHIO_SOS_CANDIDATE_LIST_HEADER, "MASTER_KEY"),
  candidateFirstName: col(OHIO_SOS_CANDIDATE_LIST_HEADER, "CANDIDATE_FIRST_NAME"),
  candidateLastName: col(OHIO_SOS_CANDIDATE_LIST_HEADER, "CANDIDATE_LAST_NAME"),
  office: col(OHIO_SOS_CANDIDATE_LIST_HEADER, "OFFICE", 0),
  district: col(OHIO_SOS_CANDIDATE_LIST_HEADER, "DISTRICT"),
  party: col(OHIO_SOS_CANDIDATE_LIST_HEADER, "OFFICE", 1),
};

export const OHIO_SOS_PAC_LIST_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "COM_ADDRESS",
  "COM_CITY",
  "COM_STATE",
  "COM_ZIP",
  "PAC_REG_NO",
  "TREA_FIRST_NAME",
  "TREA_LAST_NAME",
  "TREA_MIDDLE_NAME",
  "TREA_SUFFIX",
  "TREA_ADDRESS",
  "TREA_CITY",
  "TREA_STATE",
  "TREA_ZIP",
  "DEP_FIRST_NAME",
  "DEP_LAST_NAME",
  "SPONSOR",
] as const;

export type OhioSosPacCommitteeListRow = {
  committeeName: string;
  masterKey: string;
  pacRegNo: string | null;
  sponsor: string | null;
};

const PAC_LIST = {
  committeeName: col(OHIO_SOS_PAC_LIST_HEADER, "COM_NAME"),
  masterKey: col(OHIO_SOS_PAC_LIST_HEADER, "MASTER_KEY"),
  pacRegNo: col(OHIO_SOS_PAC_LIST_HEADER, "PAC_REG_NO"),
  sponsor: col(OHIO_SOS_PAC_LIST_HEADER, "SPONSOR"),
};

// --- Cover pages ------------------------------------------------------------

const COVER_MONEY_COLUMNS = [
  "AMT_FORWARD",
  "TOTAL_CONTRIBUTIONS",
  "TOTAL_OTHER_INCOME",
  "TOTAL_FUNDS",
  "TOTAL_EXPENDITURES",
  "BALANCE_ON_HAND",
  "VALUE_INKIND_RECEIVED",
  "VALUE_INKIND_MADE",
  "OUTSTANDING_LOANS_OWED",
  "OUTSTANDING_DEBT_OWED",
  "OUTSTANDING_LOANS_TO",
  "VALUE_IND_EXPENDITURES",
] as const;

export const OHIO_SOS_CANDIDATE_COVER_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "CANDIDATE_FIRST_NAME",
  "CANDIDATE_LAST_NAME",
  "REPORT_KEY",
  "RPT_YEAR",
  "REPORT_DESCRIPTION",
  "DATE_REPORT_FILED",
  ...COVER_MONEY_COLUMNS,
] as const;

export const OHIO_SOS_PAC_COVER_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "REPORT_KEY",
  "RPT_YEAR",
  "REPORT_DESCRIPTION",
  "DATE_REPORT_FILED",
  "PAC_REG_NO",
  ...COVER_MONEY_COLUMNS,
] as const;

export const OHIO_SOS_PARTY_COVER_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "REPORT_KEY",
  "RPT_YEAR",
  "REPORT_DESCRIPTION",
  "DATE_REPORT_FILED",
  ...COVER_MONEY_COLUMNS,
] as const;

export type OhioSosCoverPageRow = {
  committeeName: string;
  masterKey: string;
  // Historical PAC covers preserve registrations absent from the active list.
  pacRegNo?: string | null;
  // Candidate cover pages only; null for PAC/party covers.
  candidateFirstName: string | null;
  candidateLastName: string | null;
  reportKey: string;
  reportYear: number | null;
  reportDescription: string | null;
  dateReportFiledIso: string | null;
  amountForwardCents: number | null;
  totalContributionsCents: number | null;
  totalOtherIncomeCents: number | null;
  totalFundsCents: number | null;
  totalExpendituresCents: number | null;
  // Negative on ~1% of real rows (decision 1) — the sign is preserved here
  // and handled at the writer, never clamped.
  balanceOnHandCents: number | null;
  valueInkindReceivedCents: number | null;
  valueInkindMadeCents: number | null;
  outstandingLoansOwedCents: number | null;
  outstandingDebtOwedCents: number | null;
  outstandingLoansToCents: number | null;
  valueIndependentExpendituresCents: number | null;
};

function coverPageMapper(
  header: readonly string[],
  input: { hasCandidateColumns: boolean }
): (row: readonly string[]) => OhioSosCoverPageRow {
  const indexes = {
    committeeName: col(header, "COM_NAME"),
    masterKey: col(header, "MASTER_KEY"),
    pacRegNo: header.indexOf("PAC_REG_NO"),
    candidateFirstName: input.hasCandidateColumns ? col(header, "CANDIDATE_FIRST_NAME") : null,
    candidateLastName: input.hasCandidateColumns ? col(header, "CANDIDATE_LAST_NAME") : null,
    reportKey: col(header, "REPORT_KEY"),
    reportYear: col(header, "RPT_YEAR"),
    reportDescription: col(header, "REPORT_DESCRIPTION"),
    dateReportFiled: col(header, "DATE_REPORT_FILED"),
    money: COVER_MONEY_COLUMNS.map((name) => col(header, name)),
  };
  return (row) => {
    const [
      amountForwardCents,
      totalContributionsCents,
      totalOtherIncomeCents,
      totalFundsCents,
      totalExpendituresCents,
      balanceOnHandCents,
      valueInkindReceivedCents,
      valueInkindMadeCents,
      outstandingLoansOwedCents,
      outstandingDebtOwedCents,
      outstandingLoansToCents,
      valueIndependentExpendituresCents,
    ] = indexes.money.map((index) => centsOrNull(row, index));
    return {
      committeeName: text(row, indexes.committeeName),
      masterKey: text(row, indexes.masterKey),
      ...(indexes.pacRegNo >= 0 ? { pacRegNo: textOrNull(row, indexes.pacRegNo) } : {}),
      candidateFirstName: indexes.candidateFirstName === null ? null : textOrNull(row, indexes.candidateFirstName),
      candidateLastName: indexes.candidateLastName === null ? null : textOrNull(row, indexes.candidateLastName),
      reportKey: text(row, indexes.reportKey),
      reportYear: yearOrNull(row, indexes.reportYear),
      reportDescription: textOrNull(row, indexes.reportDescription),
      dateReportFiledIso: parseOhioSosDateIso(row[indexes.dateReportFiled]),
      amountForwardCents: amountForwardCents ?? null,
      totalContributionsCents: totalContributionsCents ?? null,
      totalOtherIncomeCents: totalOtherIncomeCents ?? null,
      totalFundsCents: totalFundsCents ?? null,
      totalExpendituresCents: totalExpendituresCents ?? null,
      balanceOnHandCents: balanceOnHandCents ?? null,
      valueInkindReceivedCents: valueInkindReceivedCents ?? null,
      valueInkindMadeCents: valueInkindMadeCents ?? null,
      outstandingLoansOwedCents: outstandingLoansOwedCents ?? null,
      outstandingDebtOwedCents: outstandingDebtOwedCents ?? null,
      outstandingLoansToCents: outstandingLoansToCents ?? null,
      valueIndependentExpendituresCents: valueIndependentExpendituresCents ?? null,
    };
  };
}

// --- Contributions ----------------------------------------------------------

export const OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "REPORT_DESCRIPTION",
  "RPT_YEAR",
  "REPORT_KEY",
  "SHORT_DESCRIPTION",
  "FIRST_NAME",
  "MIDDLE_NAME",
  "LAST_NAME",
  "SUFFIX_NAME",
  "NON_INDIVIDUAL",
  "PAC_REG_NO",
  "ADDRESS",
  "CITY",
  "STATE",
  "ZIP",
  "FILE_DATE",
  "AMOUNT",
  "EVENT_DATE",
  "EMP_OCCUPATION",
  "INKIND_DESCRIPTION",
  "OTHER_INCOME_TYPE",
  "RCV_EVENT",
  "CANDIDATE_FIRST_NAME",
  "CANDIDATE_LAST_NAME",
  "OFFICE",
  "DISTRICT",
  "PARTY",
] as const;

export const OHIO_SOS_PAC_CONTRIBUTIONS_HEADER = [
  "COM_NAME",
  "PAC_REG_NO",
  "MASTER_KEY",
  "RPT_YEAR",
  "REPORT_KEY",
  "REPORT_DESCRIPTION",
  "SHORT_DESCRIPTION",
  "FIRST_NAME",
  "MIDDLE_NAME",
  "LAST_NAME",
  "SUFFIX_NAME",
  "NON_INDIVIDUAL",
  "ADDRESS",
  "CITY",
  "STATE",
  "ZIP",
  "FILE_DATE",
  "AMOUNT",
  "EVENT_DATE",
  "EMP_OCCUPATION",
  "INKIND_DESCRIPTION",
  "OTHER_INCOME_TYPE",
  "RCV_EVENT",
] as const;

export const OHIO_SOS_PARTY_CONTRIBUTIONS_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "RPT_YEAR",
  "REPORT_KEY",
  "REPORT_DESCRIPTION",
  "SHORT_DESCRIPTION",
  "FIRST_NAME",
  "MIDDLE_NAME",
  "LAST_NAME",
  "SUFFIX_NAME",
  "NON_INDIVIDUAL",
  "PAC_REG_NO",
  "ADDRESS",
  "CITY",
  "STATE",
  "ZIP",
  "FILE_DATE",
  "AMOUNT",
  "EVENT_DATE",
  "EMP_OCCUPATION",
  "INKIND_DESCRIPTION",
  "OTHER_INCOME_TYPE",
  "RCV_EVENT",
] as const;

export type OhioSosContributionRow = {
  committeeName: string;
  masterKey: string;
  reportYear: number | null;
  reportKey: string;
  reportDescription: string | null;
  shortDescription: string | null;
  contributorFirstName: string | null;
  contributorMiddleName: string | null;
  contributorLastName: string | null;
  contributorSuffix: string | null;
  nonIndividual: string | null;
  pacRegNo: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  fileDateIso: string | null;
  amountCents: number | null;
  eventDateIso: string | null;
  // Combined employer/occupation free text — diagnostics only, never an
  // occupation breakdown (decision 6: Ohio launches without occupations).
  empOccupation: string | null;
  inkindDescription: string | null;
  otherIncomeType: string | null;
  rcvEvent: string | null;
  // Candidate contribution files only; null for PAC/party files.
  candidateFirstName: string | null;
  candidateLastName: string | null;
  office: string | null;
  district: string | null;
  party: string | null;
};

function contributionMapper(
  header: readonly string[],
  input: { hasCandidateColumns: boolean }
): (row: readonly string[]) => OhioSosContributionRow {
  const indexes = {
    committeeName: col(header, "COM_NAME"),
    masterKey: col(header, "MASTER_KEY"),
    reportYear: col(header, "RPT_YEAR"),
    reportKey: col(header, "REPORT_KEY"),
    reportDescription: col(header, "REPORT_DESCRIPTION"),
    shortDescription: col(header, "SHORT_DESCRIPTION"),
    contributorFirstName: col(header, "FIRST_NAME"),
    contributorMiddleName: col(header, "MIDDLE_NAME"),
    contributorLastName: col(header, "LAST_NAME"),
    contributorSuffix: col(header, "SUFFIX_NAME"),
    nonIndividual: col(header, "NON_INDIVIDUAL"),
    pacRegNo: col(header, "PAC_REG_NO"),
    address: col(header, "ADDRESS"),
    city: col(header, "CITY"),
    state: col(header, "STATE"),
    zip: col(header, "ZIP"),
    fileDate: col(header, "FILE_DATE"),
    amount: col(header, "AMOUNT"),
    eventDate: col(header, "EVENT_DATE"),
    empOccupation: col(header, "EMP_OCCUPATION"),
    inkindDescription: col(header, "INKIND_DESCRIPTION"),
    otherIncomeType: col(header, "OTHER_INCOME_TYPE"),
    rcvEvent: col(header, "RCV_EVENT"),
    candidateFirstName: input.hasCandidateColumns ? col(header, "CANDIDATE_FIRST_NAME") : null,
    candidateLastName: input.hasCandidateColumns ? col(header, "CANDIDATE_LAST_NAME") : null,
    office: input.hasCandidateColumns ? col(header, "OFFICE") : null,
    district: input.hasCandidateColumns ? col(header, "DISTRICT") : null,
    party: input.hasCandidateColumns ? col(header, "PARTY") : null,
  };
  return (row) => ({
    committeeName: text(row, indexes.committeeName),
    masterKey: text(row, indexes.masterKey),
    reportYear: yearOrNull(row, indexes.reportYear),
    reportKey: text(row, indexes.reportKey),
    reportDescription: textOrNull(row, indexes.reportDescription),
    shortDescription: textOrNull(row, indexes.shortDescription),
    contributorFirstName: textOrNull(row, indexes.contributorFirstName),
    contributorMiddleName: textOrNull(row, indexes.contributorMiddleName),
    contributorLastName: textOrNull(row, indexes.contributorLastName),
    contributorSuffix: textOrNull(row, indexes.contributorSuffix),
    nonIndividual: textOrNull(row, indexes.nonIndividual),
    pacRegNo: textOrNull(row, indexes.pacRegNo),
    address: textOrNull(row, indexes.address),
    city: textOrNull(row, indexes.city),
    state: textOrNull(row, indexes.state),
    zip: textOrNull(row, indexes.zip),
    fileDateIso: parseOhioSosDateIso(row[indexes.fileDate]),
    amountCents: centsOrNull(row, indexes.amount),
    eventDateIso: parseOhioSosDateIso(row[indexes.eventDate]),
    empOccupation: textOrNull(row, indexes.empOccupation),
    inkindDescription: textOrNull(row, indexes.inkindDescription),
    otherIncomeType: textOrNull(row, indexes.otherIncomeType),
    rcvEvent: textOrNull(row, indexes.rcvEvent),
    candidateFirstName: indexes.candidateFirstName === null ? null : textOrNull(row, indexes.candidateFirstName),
    candidateLastName: indexes.candidateLastName === null ? null : textOrNull(row, indexes.candidateLastName),
    office: indexes.office === null ? null : textOrNull(row, indexes.office),
    district: indexes.district === null ? null : textOrNull(row, indexes.district),
    party: indexes.party === null ? null : textOrNull(row, indexes.party),
  });
}

// --- Expenditures -----------------------------------------------------------

export const OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "RPT_YEAR",
  "REPORT_KEY",
  "REPORT_DESCRIPTION",
  "SHORT_DESCRIPTION",
  "FIRST_NAME",
  "MIDDLE_NAME",
  "LAST_NAME",
  "SUFFIX_NAME",
  "NON_INDIVIDUAL",
  "ADDRESS",
  "CITY",
  "STATE",
  "ZIP",
  "EXPEND_DATE",
  "AMOUNT",
  "EVENT_DATE",
  "PURPOSE",
  "INKIND",
  // Published with spaces instead of underscores; normalization makes the
  // two spellings equivalent.
  "CANDIDATE FIRST NAME",
  "CANDIDATE LAST NAME",
  "OFFICE",
  "DISTRICT",
  "PARTY",
] as const;

export const OHIO_SOS_PAC_EXPENDITURES_HEADER = [
  "COM_NAME",
  "MASTER_KEY",
  "RPT_YEAR",
  "REPORT_KEY",
  "REPORT_DESCRIPTION",
  "SHORT_DESCRIPTION",
  "FIRST_NAME",
  "MIDDLE_NAME",
  "LAST_NAME",
  "SUFFIX_NAME",
  "NON_INDIVIDUAL",
  "ADDRESS",
  "CITY",
  "STATE",
  "ZIP",
  "EXPEND_DATE",
  "AMOUNT",
  "EVENT_DATE",
  "PURPOSE",
] as const;

// The PPC_EXP captures from the 2026-08-04 spike carry exactly the PAC
// expenditure columns plus a trailing PARTY column; both the 2025 and 2026
// files parsed against this pinned header with zero malformed rows. The
// spread records that observation, not an assumption — the strict header
// check fails loudly if the portal ever diverges the two schemas.
export const OHIO_SOS_PARTY_EXPENDITURES_HEADER = [
  ...OHIO_SOS_PAC_EXPENDITURES_HEADER,
  "PARTY",
] as const;

// SHORT_DESCRIPTION prefix that marks an independent-expenditure row in the
// annual files (decision 4: those rows are discovery/reconciliation data
// only — target candidate, office, and direction live in the per-report
// detail export).
export const OHIO_SOS_31U_SHORT_DESCRIPTION_PREFIX = "31-U";

export type OhioSosExpenditureRow = {
  committeeName: string;
  masterKey: string;
  reportYear: number | null;
  reportKey: string;
  reportDescription: string | null;
  shortDescription: string | null;
  payeeFirstName: string | null;
  payeeMiddleName: string | null;
  payeeLastName: string | null;
  payeeSuffix: string | null;
  nonIndividual: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  expendDateIso: string | null;
  amountCents: number | null;
  eventDateIso: string | null;
  purpose: string | null;
  // Candidate expenditure files only.
  inkind: string | null;
  candidateFirstName: string | null;
  candidateLastName: string | null;
  office: string | null;
  district: string | null;
  // Candidate + party expenditure files.
  party: string | null;
};

export function isOhioSos31uExpenditureRow(row: Pick<OhioSosExpenditureRow, "shortDescription">): boolean {
  return row.shortDescription?.startsWith(OHIO_SOS_31U_SHORT_DESCRIPTION_PREFIX) ?? false;
}

function expenditureMapper(
  header: readonly string[],
  input: { hasCandidateColumns: boolean; hasPartyColumn: boolean }
): (row: readonly string[]) => OhioSosExpenditureRow {
  const indexes = {
    committeeName: col(header, "COM_NAME"),
    masterKey: col(header, "MASTER_KEY"),
    reportYear: col(header, "RPT_YEAR"),
    reportKey: col(header, "REPORT_KEY"),
    reportDescription: col(header, "REPORT_DESCRIPTION"),
    shortDescription: col(header, "SHORT_DESCRIPTION"),
    payeeFirstName: col(header, "FIRST_NAME"),
    payeeMiddleName: col(header, "MIDDLE_NAME"),
    payeeLastName: col(header, "LAST_NAME"),
    payeeSuffix: col(header, "SUFFIX_NAME"),
    nonIndividual: col(header, "NON_INDIVIDUAL"),
    address: col(header, "ADDRESS"),
    city: col(header, "CITY"),
    state: col(header, "STATE"),
    zip: col(header, "ZIP"),
    expendDate: col(header, "EXPEND_DATE"),
    amount: col(header, "AMOUNT"),
    eventDate: col(header, "EVENT_DATE"),
    purpose: col(header, "PURPOSE"),
    inkind: input.hasCandidateColumns ? col(header, "INKIND") : null,
    candidateFirstName: input.hasCandidateColumns ? col(header, "CANDIDATE FIRST NAME") : null,
    candidateLastName: input.hasCandidateColumns ? col(header, "CANDIDATE LAST NAME") : null,
    office: input.hasCandidateColumns ? col(header, "OFFICE") : null,
    district: input.hasCandidateColumns ? col(header, "DISTRICT") : null,
    party: input.hasCandidateColumns || input.hasPartyColumn ? col(header, "PARTY") : null,
  };
  return (row) => ({
    committeeName: text(row, indexes.committeeName),
    masterKey: text(row, indexes.masterKey),
    reportYear: yearOrNull(row, indexes.reportYear),
    reportKey: text(row, indexes.reportKey),
    reportDescription: textOrNull(row, indexes.reportDescription),
    shortDescription: textOrNull(row, indexes.shortDescription),
    payeeFirstName: textOrNull(row, indexes.payeeFirstName),
    payeeMiddleName: textOrNull(row, indexes.payeeMiddleName),
    payeeLastName: textOrNull(row, indexes.payeeLastName),
    payeeSuffix: textOrNull(row, indexes.payeeSuffix),
    nonIndividual: textOrNull(row, indexes.nonIndividual),
    address: textOrNull(row, indexes.address),
    city: textOrNull(row, indexes.city),
    state: textOrNull(row, indexes.state),
    zip: textOrNull(row, indexes.zip),
    expendDateIso: parseOhioSosDateIso(row[indexes.expendDate]),
    amountCents: centsOrNull(row, indexes.amount),
    eventDateIso: parseOhioSosDateIso(row[indexes.eventDate]),
    purpose: textOrNull(row, indexes.purpose),
    inkind: indexes.inkind === null ? null : textOrNull(row, indexes.inkind),
    candidateFirstName: indexes.candidateFirstName === null ? null : textOrNull(row, indexes.candidateFirstName),
    candidateLastName: indexes.candidateLastName === null ? null : textOrNull(row, indexes.candidateLastName),
    office: indexes.office === null ? null : textOrNull(row, indexes.office),
    district: indexes.district === null ? null : textOrNull(row, indexes.district),
    party: indexes.party === null ? null : textOrNull(row, indexes.party),
  });
}

// --- Family registry + streaming reader -------------------------------------

export type OhioSosBulkFileFamily<T> = {
  key: OhioSosBulkFileFamilyKey;
  label: string;
  header: readonly string[];
  mapRow: (row: readonly string[]) => T;
  // Column indexes feeding the manifest's min/max transaction dates.
  dateColumns: readonly number[];
  // Transaction-amount column, where the family has a single one; cover
  // pages carry twelve money columns and set this to null.
  amountColumn: number | null;
  // The multi-million-row transaction files tolerate (skip + count) rows
  // with a damaged column count; on the small list/cover files a wrong
  // count can only mean schema drift, so those throw.
  tolerateMalformedRows: boolean;
  // Set on expenditure families: report keys of 31-U rows drive the
  // two-stage detail fetch (decision 4).
  collect31uReportKeys?: {
    shortDescriptionColumn: number;
    reportKeyColumn: number;
  };
};

function family<T>(input: OhioSosBulkFileFamily<T>): OhioSosBulkFileFamily<T> {
  return input;
}

export const OHIO_SOS_CANDIDATE_LIST_FAMILY = family<OhioSosCandidateCommitteeListRow>({
  key: "candidate_list",
  label: "active candidate list",
  header: OHIO_SOS_CANDIDATE_LIST_HEADER,
  mapRow: (row) => ({
    committeeName: text(row, CANDIDATE_LIST.committeeName),
    masterKey: text(row, CANDIDATE_LIST.masterKey),
    candidateFirstName: textOrNull(row, CANDIDATE_LIST.candidateFirstName),
    candidateLastName: textOrNull(row, CANDIDATE_LIST.candidateLastName),
    office: textOrNull(row, CANDIDATE_LIST.office),
    district: textOrNull(row, CANDIDATE_LIST.district),
    party: textOrNull(row, CANDIDATE_LIST.party),
  }),
  dateColumns: [],
  amountColumn: null,
  tolerateMalformedRows: false,
});

export const OHIO_SOS_PAC_LIST_FAMILY = family<OhioSosPacCommitteeListRow>({
  key: "pac_list",
  label: "active PAC list",
  header: OHIO_SOS_PAC_LIST_HEADER,
  mapRow: (row) => ({
    committeeName: text(row, PAC_LIST.committeeName),
    masterKey: text(row, PAC_LIST.masterKey),
    pacRegNo: textOrNull(row, PAC_LIST.pacRegNo),
    sponsor: textOrNull(row, PAC_LIST.sponsor),
  }),
  dateColumns: [],
  amountColumn: null,
  tolerateMalformedRows: false,
});

export const OHIO_SOS_CANDIDATE_COVER_FAMILY = family<OhioSosCoverPageRow>({
  key: "candidate_cover",
  label: "candidate cover pages",
  header: OHIO_SOS_CANDIDATE_COVER_HEADER,
  mapRow: coverPageMapper(OHIO_SOS_CANDIDATE_COVER_HEADER, { hasCandidateColumns: true }),
  dateColumns: [col(OHIO_SOS_CANDIDATE_COVER_HEADER, "DATE_REPORT_FILED")],
  amountColumn: null,
  tolerateMalformedRows: false,
});

export const OHIO_SOS_PAC_COVER_FAMILY = family<OhioSosCoverPageRow>({
  key: "pac_cover",
  label: "PAC cover pages",
  header: OHIO_SOS_PAC_COVER_HEADER,
  mapRow: coverPageMapper(OHIO_SOS_PAC_COVER_HEADER, { hasCandidateColumns: false }),
  dateColumns: [col(OHIO_SOS_PAC_COVER_HEADER, "DATE_REPORT_FILED")],
  amountColumn: null,
  tolerateMalformedRows: false,
});

export const OHIO_SOS_PARTY_COVER_FAMILY = family<OhioSosCoverPageRow>({
  key: "party_cover",
  label: "party cover pages",
  header: OHIO_SOS_PARTY_COVER_HEADER,
  mapRow: coverPageMapper(OHIO_SOS_PARTY_COVER_HEADER, { hasCandidateColumns: false }),
  dateColumns: [col(OHIO_SOS_PARTY_COVER_HEADER, "DATE_REPORT_FILED")],
  amountColumn: null,
  tolerateMalformedRows: false,
});

export const OHIO_SOS_CANDIDATE_CONTRIBUTIONS_FAMILY = family<OhioSosContributionRow>({
  key: "candidate_contributions",
  label: "candidate contributions",
  header: OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER,
  mapRow: contributionMapper(OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER, { hasCandidateColumns: true }),
  dateColumns: [col(OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER, "FILE_DATE")],
  amountColumn: col(OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER, "AMOUNT"),
  tolerateMalformedRows: true,
});

export const OHIO_SOS_PAC_CONTRIBUTIONS_FAMILY = family<OhioSosContributionRow>({
  key: "pac_contributions",
  label: "PAC contributions",
  header: OHIO_SOS_PAC_CONTRIBUTIONS_HEADER,
  mapRow: contributionMapper(OHIO_SOS_PAC_CONTRIBUTIONS_HEADER, { hasCandidateColumns: false }),
  dateColumns: [col(OHIO_SOS_PAC_CONTRIBUTIONS_HEADER, "FILE_DATE")],
  amountColumn: col(OHIO_SOS_PAC_CONTRIBUTIONS_HEADER, "AMOUNT"),
  tolerateMalformedRows: true,
});

export const OHIO_SOS_PARTY_CONTRIBUTIONS_FAMILY = family<OhioSosContributionRow>({
  key: "party_contributions",
  label: "party contributions",
  header: OHIO_SOS_PARTY_CONTRIBUTIONS_HEADER,
  mapRow: contributionMapper(OHIO_SOS_PARTY_CONTRIBUTIONS_HEADER, { hasCandidateColumns: false }),
  dateColumns: [col(OHIO_SOS_PARTY_CONTRIBUTIONS_HEADER, "FILE_DATE")],
  amountColumn: col(OHIO_SOS_PARTY_CONTRIBUTIONS_HEADER, "AMOUNT"),
  tolerateMalformedRows: true,
});

export const OHIO_SOS_CANDIDATE_EXPENDITURES_FAMILY = family<OhioSosExpenditureRow>({
  key: "candidate_expenditures",
  label: "candidate expenditures",
  header: OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER,
  mapRow: expenditureMapper(OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER, {
    hasCandidateColumns: true,
    hasPartyColumn: true,
  }),
  dateColumns: [col(OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER, "EXPEND_DATE")],
  amountColumn: col(OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER, "AMOUNT"),
  collect31uReportKeys: {
    shortDescriptionColumn: col(OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER, "SHORT_DESCRIPTION"),
    reportKeyColumn: col(OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER, "REPORT_KEY"),
  },
  tolerateMalformedRows: true,
});

export const OHIO_SOS_PAC_EXPENDITURES_FAMILY = family<OhioSosExpenditureRow>({
  key: "pac_expenditures",
  label: "PAC expenditures",
  header: OHIO_SOS_PAC_EXPENDITURES_HEADER,
  mapRow: expenditureMapper(OHIO_SOS_PAC_EXPENDITURES_HEADER, {
    hasCandidateColumns: false,
    hasPartyColumn: false,
  }),
  dateColumns: [col(OHIO_SOS_PAC_EXPENDITURES_HEADER, "EXPEND_DATE")],
  amountColumn: col(OHIO_SOS_PAC_EXPENDITURES_HEADER, "AMOUNT"),
  collect31uReportKeys: {
    shortDescriptionColumn: col(OHIO_SOS_PAC_EXPENDITURES_HEADER, "SHORT_DESCRIPTION"),
    reportKeyColumn: col(OHIO_SOS_PAC_EXPENDITURES_HEADER, "REPORT_KEY"),
  },
  tolerateMalformedRows: true,
});

export const OHIO_SOS_PARTY_EXPENDITURES_FAMILY = family<OhioSosExpenditureRow>({
  key: "party_expenditures",
  label: "party expenditures",
  header: OHIO_SOS_PARTY_EXPENDITURES_HEADER,
  mapRow: expenditureMapper(OHIO_SOS_PARTY_EXPENDITURES_HEADER, {
    hasCandidateColumns: false,
    hasPartyColumn: true,
  }),
  dateColumns: [col(OHIO_SOS_PARTY_EXPENDITURES_HEADER, "EXPEND_DATE")],
  amountColumn: col(OHIO_SOS_PARTY_EXPENDITURES_HEADER, "AMOUNT"),
  collect31uReportKeys: {
    shortDescriptionColumn: col(OHIO_SOS_PARTY_EXPENDITURES_HEADER, "SHORT_DESCRIPTION"),
    reportKeyColumn: col(OHIO_SOS_PARTY_EXPENDITURES_HEADER, "REPORT_KEY"),
  },
  tolerateMalformedRows: true,
});

// A cover row whose every money column is blank carries no data at all —
// rare e-filing damage (3 of 1,673 cycle rows on the real 2026 candidate
// cover file). Consumers skip such rows instead of reading their blanks as
// zeroes; a blank cell on an otherwise-FILLED row is different and provably
// means zero (all 583 real rows with a blank TOTAL_CONTRIBUTIONS satisfy
// TOTAL_FUNDS = AMT_FORWARD + TOTAL_OTHER_INCOME exactly).
export function isBlankOhioSosCoverPageRow(row: OhioSosCoverPageRow): boolean {
  return (
    row.amountForwardCents === null &&
    row.totalContributionsCents === null &&
    row.totalOtherIncomeCents === null &&
    row.totalFundsCents === null &&
    row.totalExpendituresCents === null &&
    row.balanceOnHandCents === null &&
    row.valueInkindReceivedCents === null &&
    row.valueInkindMadeCents === null &&
    row.outstandingLoansOwedCents === null &&
    row.outstandingDebtOwedCents === null &&
    row.outstandingLoansToCents === null &&
    row.valueIndependentExpendituresCents === null
  );
}

// Ohio's published bulk data starts in 1990 (earliest real cover page:
// 1990-01-22). Filers mistype the year often enough to poison a naive
// min/max — the 2026 candidate-contribution file alone carries 0202, 0206,
// 2926, 3026, and 3036 — so manifest date ranges ignore dates outside a
// plausible window and count them instead.
export const OHIO_SOS_MIN_PLAUSIBLE_DATE_ISO = "1990-01-01";

function maxPlausibleDateIso(now: Date): string {
  return `${now.getUTCFullYear() + 1}-12-31`;
}

export type OhioSosBulkFileStats = {
  rowCount: number;
  malformedRowCount: number;
  rowSeparator: OhioSosCsvRowSeparator | null;
  minTransactionDateIso: string | null;
  maxTransactionDateIso: string | null;
  // Rows whose date parsed but fell outside the plausible window — filer
  // typos, reported as a diagnostic rather than silently widening the range.
  implausibleDateRowCount: number;
  // Rows whose date column was blank or unparseable.
  missingDateRowCount: number;
  // Rows whose AMOUNT was blank or unparseable. Real and rare (11 rows
  // across the 305 MB 2026 cycle): blank in-kind amounts and test rows.
  // Never treated as zero.
  missingAmountRowCount: number;
  // Sorted report keys of 31-U rows; empty for non-expenditure families.
  reportKeys31u: string[];
};

// Streams a bulk file through its family schema. The ~90 MB contribution
// files must never be read whole (decision 10), so this is the only read
// path; `visit` may be omitted when only the stats are needed (manifests).
export async function streamOhioSosBulkFile<T>(input: {
  path: string;
  family: OhioSosBulkFileFamily<T>;
  visit?: (row: T) => void;
  onMalformedRow?: (malformed: { line: number; columnCount: number; row: readonly string[] }) => void;
  // Upper bound of the plausible-date window; defaults to now.
  now?: Date;
}): Promise<OhioSosBulkFileStats> {
  const { family: fileFamily, visit } = input;
  const maxPlausible = maxPlausibleDateIso(input.now ?? new Date());
  let rowCount = 0;
  let malformedRowCount = 0;
  let implausibleDateRowCount = 0;
  let missingDateRowCount = 0;
  let missingAmountRowCount = 0;
  let minTransactionDateIso: string | null = null;
  let maxTransactionDateIso: string | null = null;
  const reportKeys31u = new Set<string>();

  const result = await parseOhioSosCsvFile(input.path, {
    label: fileFamily.label,
    expectedHeader: fileFamily.header,
    onMalformedRow: fileFamily.tolerateMalformedRows
      ? (malformed) => {
          malformedRowCount += 1;
          input.onMalformedRow?.(malformed);
        }
      : undefined,
    visit: (row) => {
      rowCount += 1;
      for (const dateColumn of fileFamily.dateColumns) {
        const iso = parseOhioSosDateIso(row[dateColumn]);
        if (iso === null) {
          missingDateRowCount += 1;
        } else if (iso < OHIO_SOS_MIN_PLAUSIBLE_DATE_ISO || iso > maxPlausible) {
          implausibleDateRowCount += 1;
        } else {
          if (minTransactionDateIso === null || iso < minTransactionDateIso) {
            minTransactionDateIso = iso;
          }
          if (maxTransactionDateIso === null || iso > maxTransactionDateIso) {
            maxTransactionDateIso = iso;
          }
        }
      }
      if (fileFamily.amountColumn !== null && parseOhioSosAmountCents(row[fileFamily.amountColumn]) === null) {
        missingAmountRowCount += 1;
      }
      if (fileFamily.collect31uReportKeys) {
        const shortDescription = normalizeOhioSosText(row[fileFamily.collect31uReportKeys.shortDescriptionColumn]);
        if (shortDescription.startsWith(OHIO_SOS_31U_SHORT_DESCRIPTION_PREFIX)) {
          const reportKey = normalizeOhioSosText(row[fileFamily.collect31uReportKeys.reportKeyColumn]);
          if (reportKey) {
            reportKeys31u.add(reportKey);
          }
        }
      }
      visit?.(fileFamily.mapRow(row));
    },
  });

  return {
    rowCount,
    malformedRowCount,
    rowSeparator: result.rowSeparator,
    minTransactionDateIso,
    maxTransactionDateIso,
    implausibleDateRowCount,
    missingDateRowCount,
    missingAmountRowCount,
    reportKeys31u: [...reportKeys31u].sort(),
  };
}

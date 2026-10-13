import {
  parseMaineMapLightCsvRecords,
  parseMaineMapLightCivilDate,
  parseMaineMapLightCents,
  parseMaineMapLightSourceId,
  requireMaineMapLightIdentityText,
} from "./maineMapLightCsvPrimitives.js";

export const MAINE_MAPLIGHT_ALL_FILER_HEADERS = [
  "Transaction ID",
  "Filer ID",
  "Filer Name",
  "First Name",
  "Last Name",
  "Filer Office",
  "Filer District",
  "Filer County",
  "Transaction Type",
  "Transaction Date",
  "Amount",
  "Election",
  "Description",
  "Contact Type",
  "Contact Name",
  "Contact Street Address 1",
  "Contact Street Address 2",
  "Contact City",
  "Contact State",
  "Contact Zip",
  "Occupation",
  "Occupation Other",
  "Employer Name",
  "Purpose",
  "Expenditure Targets",
] as const;

export const MAINE_MAPLIGHT_ALL_FILER_SOURCE_ROLES = [
  "contribution - monetary",
  "contribution - in_kind",
  "contribution - bank_interest",
  "contribution - previous_campaign_transfer",
  "contribution - treasury_transfer",
  "expenditure - expenditure",
  "independent_expenditure - independent_expenditure",
  "returned - returned_monetary",
  "returned - returned_expenditure",
  "returned - returned_in_kind",
  "debt - debt",
  "debt - debt_payment",
  "loan - loan",
  "loan - loan_payment",
  "loan - loan_forgiveness",
  "mcea - mcea_payment",
  "mcea - mcea_funds_return",
] as const;

export type MaineMapLightAllFilerSourceRole =
  (typeof MAINE_MAPLIGHT_ALL_FILER_SOURCE_ROLES)[number];
type Column = (typeof MAINE_MAPLIGHT_ALL_FILER_HEADERS)[number];

export interface MaineMapLightAllFilerTransaction {
  occurrence: number;
  transactionId: string;
  filerId: string;
  filerName: string;
  filerFirstName: string;
  filerLastName: string;
  filerOffice: string;
  filerDistrict: string;
  filerCounty: string;
  sourceRole: MaineMapLightAllFilerSourceRole;
  transactionDate: string;
  amount: string;
  /** Signed as published: returned roles do not implicitly negate this amount. */
  amountCents: number;
  election: string;
  description: string;
  counterpartyClass: string;
  /** A reported name, not a public legal filer identity. May be blank as published. */
  counterpartyName: string;
  purpose: string;
  /** Literal source content; no target, stance, or allocation is inferred. */
  expenditureTargets: string;
}

function fail(message: string): never {
  throw new Error(`Maine MapLight all-filer CSV: ${message}`);
}

/**
 * Decodes filed-transaction snapshot facts, not current cash or a reconciled ledger.
 * No original-return reference, version, filing status or donor legal ID is invented.
 * Contact addresses, employer, occupation and other contact details are not exported.
 */
export function parseMaineMapLightAllFilerCsv(
  csv: string,
): MaineMapLightAllFilerTransaction[] {
  const records = parseMaineMapLightCsvRecords(
    csv.replace(/^\uFEFF/, ""),
    fail,
  );
  const headers = records.shift();
  if (
    !headers ||
    headers.length !== MAINE_MAPLIGHT_ALL_FILER_HEADERS.length ||
    headers.some(
      (header, index) => header !== MAINE_MAPLIGHT_ALL_FILER_HEADERS[index],
    )
  ) {
    fail("unexpected 25-column header");
  }
  const roles: ReadonlySet<string> = new Set(
    MAINE_MAPLIGHT_ALL_FILER_SOURCE_ROLES,
  );
  const transactionIds = new Set<string>();
  const filerIdentities = new Map<string, string>();
  return records.map((cells, index): MaineMapLightAllFilerTransaction => {
    if (cells.length !== headers.length) fail("unexpected data-record width");
    const raw = Object.fromEntries(
      headers.map((header, cell) => [header, cells[cell]]),
    ) as Record<Column, string>;
    const sourceRole = raw["Transaction Type"];
    if (!roles.has(sourceRole)) fail("unsupported source role");
    const transactionId = parseMaineMapLightSourceId(
      raw["Transaction ID"],
      "a",
      fail,
    );
    if (transactionIds.has(transactionId)) fail("duplicate transaction ID");
    transactionIds.add(transactionId);
    const filerId = parseMaineMapLightSourceId(raw["Filer ID"], "f", fail);
    const filerName = requireMaineMapLightIdentityText(raw["Filer Name"], fail);
    const identity = JSON.stringify(cells.slice(2, 8));
    if (
      filerIdentities.has(filerId) &&
      filerIdentities.get(filerId) !== identity
    )
      fail("conflicting filer identity");
    filerIdentities.set(filerId, identity);
    return {
      occurrence: index + 1,
      transactionId,
      filerId,
      filerName,
      filerFirstName: raw["First Name"],
      filerLastName: raw["Last Name"],
      filerOffice: raw["Filer Office"],
      filerDistrict: raw["Filer District"],
      filerCounty: raw["Filer County"],
      sourceRole: sourceRole as MaineMapLightAllFilerSourceRole,
      transactionDate: parseMaineMapLightCivilDate(
        raw["Transaction Date"],
        fail,
      ),
      amount: raw.Amount,
      amountCents: parseMaineMapLightCents(raw.Amount, fail),
      election: raw.Election,
      description: raw.Description,
      counterpartyClass: raw["Contact Type"],
      counterpartyName: raw["Contact Name"],
      purpose: raw.Purpose,
      expenditureTargets: raw["Expenditure Targets"],
    };
  });
}

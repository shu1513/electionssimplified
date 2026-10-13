// Operator-curated independent expenditures from the Phoenix channels the
// portal grids cannot measure (plan "Outside spending", channels 2–4):
//
//   standing_pac  — SOS-registered standing PACs file finance reports ONLY
//                   with the AZ Secretary of State. Verified live 2026-08-12:
//                   Spotlight's IE grid puts the VENDOR in its name field and
//                   discloses candidate targets only in free-text memos
//                   (often blank, truncated in the grid), and its
//                   CandidateName search returns nothing for city candidates
//                   — so city-race targets are NOT machine-readable and this
//                   channel is curated, not systematic.
//   ie_entity     — non-committee IE filers (A.R.S. §16-901(31)) file
//                   fillable report forms with the Clerk by email/mail;
//                   scanned PDFs, never OCR'd.
//   efd           — Election Funding Disclosure ("dark money" ordinance)
//                   filings; the Clerk publishes a list of reports filed.
//
// Each entry is a human-verified transcription of one expenditure from one
// filing, fed through the outside aggregator's normal target-matching and
// veto pipeline (a mistyped target simply matches no roster candidate).
//
// Maintenance contract:
// - Add an entry only after reading the filing itself; cite it in sourceNote.
// - `electionYear` is the ELECTION year the expenditure targets (sync's
//   cycle filter key), not the calendar year of the expenditure.
// - `filingReference` uniquely identifies the source filing; one filing may
//   name several candidates (one entry per candidate), never the same
//   candidate twice.

export type PhoenixOutsideSupplementChannel = "standing_pac" | "ie_entity" | "efd";

export type PhoenixOutsideSupplement = {
  /** Election year the expenditure targets — sync's cycle filter key. */
  electionYear: number;
  channel: PhoenixOutsideSupplementChannel;
  /** Spender identifier: COP ID for standing PACs (they ARE registered in
   * the portal), AZ SOS committee id, or the filing's own reference for
   * id-less IE-entity/EFD spenders. */
  spenderFilerId: string;
  spenderName: string;
  /** Target exactly as the filing names the candidate. */
  candidateName: string;
  /** Office as disclosed ("City Council", "Mayor"); the aggregator's office
   * veto runs on it. */
  officeSought: string;
  /** Council district as disclosed; null when the filing leaves it blank. */
  districtNumber: number | null;
  direction: "support" | "oppose";
  amountCents: number;
  /** Expenditure (or filing) date, ISO. */
  expenditureDate: string;
  /** Unique identifier of the source filing (report id, EFD list row, …). */
  filingReference: string;
  /** How the entry was verified — cite the filing and any corroboration. */
  sourceNote: string;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CHANNELS: ReadonlySet<string> = new Set(["standing_pac", "ie_entity", "efd"]);

/** Throws on the first defective entry — curated data fails loud, not quiet. */
export function validatePhoenixOutsideSupplements(
  entries: readonly PhoenixOutsideSupplement[],
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const label = `Phoenix outside supplement ${entry.filingReference} (${entry.candidateName})`;
    if (
      !Number.isInteger(entry.electionYear) ||
      entry.electionYear < 2000 ||
      entry.electionYear > 2100
    ) {
      throw new Error(`${label}: implausible electionYear ${entry.electionYear}`);
    }
    if (!CHANNELS.has(entry.channel)) {
      throw new Error(`${label}: unknown channel "${entry.channel}"`);
    }
    for (const [field, value] of [
      ["spenderFilerId", entry.spenderFilerId],
      ["spenderName", entry.spenderName],
      ["candidateName", entry.candidateName],
      ["officeSought", entry.officeSought],
      ["filingReference", entry.filingReference],
      ["sourceNote", entry.sourceNote],
    ] as const) {
      if (value.trim() === "") throw new Error(`${label}: ${field} is blank`);
    }
    if (entry.direction !== "support" && entry.direction !== "oppose") {
      throw new Error(`${label}: direction must be support or oppose`);
    }
    if (
      entry.districtNumber !== null &&
      (!Number.isInteger(entry.districtNumber) ||
        entry.districtNumber < 1 ||
        entry.districtNumber > 8)
    ) {
      throw new Error(`${label}: districtNumber must be 1-8 or null`);
    }
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0) {
      throw new Error(`${label}: amountCents must be a positive integer`);
    }
    if (!ISO_DATE_PATTERN.test(entry.expenditureDate)) {
      throw new Error(`${label}: expenditureDate is not an ISO date`);
    }
    // Round-trip through UTC so calendar-invalid dates (2026-02-29) fail too.
    const [year, month, day] = entry.expenditureDate.split("-").map(Number);
    const roundTrip = new Date(Date.UTC(year!, month! - 1, day!));
    if (
      roundTrip.getUTCFullYear() !== year ||
      roundTrip.getUTCMonth() !== month! - 1 ||
      roundTrip.getUTCDate() !== day
    ) {
      throw new Error(`${label}: expenditureDate is not a calendar date`);
    }
    const key = JSON.stringify([
      entry.filingReference,
      entry.candidateName.trim().toUpperCase(),
    ]);
    if (seen.has(key)) throw new Error(`${label}: duplicate entry`);
    seen.add(key);
  }
}

/**
 * No accepted curated filings. The October 12, 2026 bounded source audit
 * queried all 13 city-listed standing IE-authorized PAC names: 31 native
 * expenditure occurrences, without a proved current council allocation.
 * Spotlight counterparty names and search-filter stance are not financial
 * beneficiary authority. These name queries do not establish all-channel zero.
 *
 * The inspected city page exposes noncommittee IE forms but no linked filed
 * inventory. Its public EFD list ends November 5, 2024; missing current rows
 * mean unavailable coverage, not no filings. Fresh official reports and
 * complete current allocation evidence are required before adding supplements.
 * Preserve earlier known groups while these channels remain unavailable.
 */
export const PHOENIX_OUTSIDE_SUPPLEMENTS: readonly PhoenixOutsideSupplement[] = [];

validatePhoenixOutsideSupplements(PHOENIX_OUTSIDE_SUPPLEMENTS);

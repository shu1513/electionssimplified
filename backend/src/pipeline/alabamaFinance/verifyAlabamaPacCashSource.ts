import type { AlabamaCashRow } from "./alabamaFcpaCsv.js";
import type { AlabamaCommitteeFilingRow, AlabamaCommitteeRegistryRow, AlabamaNativeContributionRow } from "./alabamaFcpaClient.js";
import { aggregateAlabamaPacDonors, type AlabamaPacDonorAggregationResult } from "./alabamaPacDonorAggregator.js";

/** Original CSV fragments are required for named people; the legacy parsed row loses MI/suffix. */
export type AlabamaPacCashSourceRow = AlabamaCashRow & { middleName?: string; suffix?: string };
export type AlabamaPacCashSourceInput = {
  cashRows: readonly AlabamaPacCashSourceRow[];
  committeeRegistryRows: readonly AlabamaCommitteeRegistryRow[];
  fcpaCommitteeNumber: string;
  internalCommitteeId: number;
  windowStart: string;
  windowEnd: string;
  nativeAllBefore: readonly AlabamaNativeContributionRow[];
  nativeAllAfter: readonly AlabamaNativeContributionRow[];
  nativePacBefore: readonly AlabamaNativeContributionRow[];
  nativePacAfter: readonly AlabamaNativeContributionRow[];
  filingsBefore: readonly AlabamaCommitteeFilingRow[];
  filingsAfter: readonly AlabamaCommitteeFilingRow[];
  coversCashCents: number;
  authoritativeCoverCount: number;
};
const CASH = new Set(["Cash (Itemized)", "Cash (Non-Itemized)", "Non-Itemized Employee Payroll Contribution"]);
const IN_KIND = new Set(["In-Kind (Itemized)", "In-Kind (Non-Itemized)"]);
// Literal native labels independently observed in complete saved public ledgers.
const NON_CASH = new Set(["Interest", "Loan", "Other (Itemized)", "Other (Non-Itemized)"]);
const name = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
const organizationName = (value: string): string => value.normalize("NFKC").toUpperCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const positiveId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
function date(value: string): string | null {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ?? (us ? [us[0], us[3], us[1], us[2]] : null);
  if (!parts) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  return year >= 1900 && month >= 1 && month <= 12 && day >= 1
    && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    ? `${parts[1]}-${parts[2]}-${parts[3]}` : null;
}
function cents(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!match) return null;
  const result = (Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"))) * (match[1] ? -1 : 1);
  return Number.isSafeInteger(result) ? result : null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function indexed<T>(rows: readonly T[], id: (row: T) => number): Map<number, T> | null {
  const result = new Map<number, T>();
  for (const row of rows) {
    const key = id(row);
    if (!positiveId(key) || result.has(key)) return null;
    result.set(key, row);
  }
  return result;
}
function same<T>(a: Map<number, T>, b: Map<number, T>): boolean {
  return a.size === b.size && [...a].every(([id, row]) => b.has(id) && canonical(row) === canonical(b.get(id)));
}

/** Caller establishes artifact generation, complete acquisition and quarantine isolation; no acquisition or writes occur here. */
export function verifyAlabamaPacCashSource(input: AlabamaPacCashSourceInput): AlabamaPacDonorAggregationResult {
  const fail = (reason: string): AlabamaPacDonorAggregationResult => ({ diagnostics: [reason] });
  const start = date(input.windowStart), end = date(input.windowEnd);
  if (!start || !end || start !== input.windowStart || end !== input.windowEnd || start > end
    || !/^[1-9]\d*$/.test(input.fcpaCommitteeNumber) || !positiveId(Number(input.fcpaCommitteeNumber))
    || !positiveId(input.internalCommitteeId)) return fail("Invalid Alabama PAC source receiver or term window");
  if (!input.committeeRegistryRows.some((row) => row.committeeId === input.fcpaCommitteeNumber
    && row.id === input.internalCommitteeId && row.committeeType === "1")) return fail("Alabama PAC source receiver registry namespaces disagree");
  const allBefore = indexed(input.nativeAllBefore, (row) => row.TRANSACTIONID);
  const allAfter = indexed(input.nativeAllAfter, (row) => row.TRANSACTIONID);
  const pacBefore = indexed(input.nativePacBefore, (row) => row.TRANSACTIONID);
  const pacAfter = indexed(input.nativePacAfter, (row) => row.TRANSACTIONID);
  const filingsBefore = indexed(input.filingsBefore, (row) => row.ID);
  const filingsAfter = indexed(input.filingsAfter, (row) => row.ID);
  if (!allBefore || !allAfter || !pacBefore || !pacAfter || !filingsBefore || !filingsAfter) return fail("Repeated or invalid Alabama native source IDs");
  if (!same(allBefore, allAfter) || !same(pacBefore, pacAfter) || !same(filingsBefore, filingsAfter)) return fail("Alabama native receipt or filing metadata changed during source verification");
  for (const [id, row] of pacBefore) {
    if (!allBefore.has(id) || canonical(row) !== canonical(allBefore.get(id))) return fail("Alabama native PAC filter is not an identical full-ledger subset");
  }
  const currentFiledCount = input.filingsBefore.filter((filing) => {
    const begin = filing.PERIODBEGIN ? date(filing.PERIODBEGIN) : null;
    const status = (filing as AlabamaCommitteeFilingRow & { STATUS?: unknown }).STATUS;
    return begin && begin >= start && begin <= end && typeof filing.FILEDDATE === "string" && filing.FILEDDATE.trim()
      && (status === undefined || status === "Filed");
  }).length;
  if (!Number.isSafeInteger(input.coversCashCents) || input.coversCashCents < 0
    || !positiveId(input.authoritativeCoverCount) || input.authoritativeCoverCount !== currentFiledCount) return fail("Missing or unsafe authoritative Alabama current cash covers");

  const nativeCash = new Map<string, AlabamaNativeContributionRow>();
  for (const row of input.nativeAllBefore) {
    if (row.COMMITTEEID !== input.internalCommitteeId || typeof row.TRANSACTIONDATE !== "string"
      || typeof row.CONTRIBUTIONTYPE !== "string"
      || (typeof row.CONTRIBUTOR !== "string"
        && !(row.CONTRIBUTOR === null && row.CONTRIBUTIONTYPE === "Cash (Non-Itemized)"))
      || typeof row.RECIPIENTNAME !== "string" || typeof row.FILINGDATE !== "string") return fail("Invalid Alabama native receiving or transaction identity");
    const when = date(row.TRANSACTIONDATE);
    if (!when) return fail("Invalid Alabama native transaction date");
    if (when < start || when > end) continue;
    if (row.CONTRIBUTOR === null) return fail("Unresolved Alabama current non-itemized donor identity");
    const category = row.CONTRIBUTIONTYPE.trim();
    if (IN_KIND.has(category) || NON_CASH.has(category)) continue;
    if (!CASH.has(category)) return fail("Unresolved Alabama native cash, refund or return category");
    const amount = cents(row.AMOUNT);
    if (amount === null || amount < 0 || /\b(return|refund|reversal|offset)\b/i.test(row.DESCRIPTION ?? "")) return fail("Unsafe or unresolved Alabama native signed/returned cash");
    nativeCash.set(String(row.TRANSACTIONID), row);
  }
  const bulkCash = new Map<string, AlabamaPacCashSourceRow>();
  for (const row of input.cashRows) {
    if (row.committeeId !== input.fcpaCommitteeNumber) continue;
    const when = date(row.contributionDate);
    if (!when) return fail("Invalid Alabama cached contribution date");
    if (when < start || when > end) continue;
    const category = row.contributionType.trim();
    if (IN_KIND.has(category)) continue;
    if (!CASH.has(category) || row.contributorType.trim() === "Returned (Cash Only)"
      || !Number.isSafeInteger(row.amountCents) || row.amountCents < 0) return fail("Unsafe or unresolved Alabama cached signed/returned cash");
    if (!/^[1-9]\d*$/.test(row.contributionId) || !positiveId(Number(row.contributionId))
      || bulkCash.has(row.contributionId)) return fail("Repeated or invalid Alabama cached cash IDs");
    bulkCash.set(row.contributionId, row);
  }
  if (nativeCash.size !== bulkCash.size || [...nativeCash.keys()].some((id) => !bulkCash.has(id))) return fail("Alabama current native and cached cash ID sets disagree");
  let sum = 0;
  for (const [id, bulk] of bulkCash) {
    const native = nativeCash.get(id)!;
    if (native.CONTRIBUTOR === null) return fail("Unresolved Alabama current non-itemized donor identity");
    if (cents(native.AMOUNT) !== bulk.amountCents || date(native.TRANSACTIONDATE) !== date(bulk.contributionDate)
      || native.CONTRIBUTIONTYPE.trim() !== bulk.contributionType.trim()) return fail("Alabama current cash date, category or cents disagree");
    const isPac = bulk.contributorType.trim() === "PAC";
    if (pacBefore.has(Number(id)) !== isPac) return fail("Alabama cached donor PAC type disagrees with current native filter");
    let displayed: string;
    if (bulk.contributorType.trim() === "Individual") {
      if (typeof bulk.middleName !== "string" || typeof bulk.suffix !== "string") return fail("Missing original Alabama individual MI/suffix identity");
      displayed = [bulk.firstName, bulk.middleName, bulk.lastName, bulk.suffix].filter((fragment) => fragment.trim()).join(" ");
    } else {
      if (bulk.firstName.trim()) return fail("Unresolved Alabama organization display-name fragments");
      displayed = bulk.lastName;
    }
    // Actual current organization exports omit native comma punctuation; preserve raw fingerprints above.
    // Individuals retain their strict original MI/suffix display check.
    const normalizeDisplay = ["PAC", "Group/Business/Corporation"].includes(bulk.contributorType.trim())
      ? organizationName : name;
    if (normalizeDisplay(displayed) !== normalizeDisplay(native.CONTRIBUTOR)) {
      return fail(`Alabama current cash donor displayed names disagree: contribution ${id}, cached donor ${displayed}, native donor ${native.CONTRIBUTOR}`);
    }
    sum += bulk.amountCents;
    if (!Number.isSafeInteger(sum)) return fail("Unsafe Alabama current cash sum");
  }
  if (sum !== input.coversCashCents) return fail("Alabama complete current cash does not exactly reconcile to covers");
  return aggregateAlabamaPacDonors({ cashRows: input.cashRows, committeeRegistryRows: input.committeeRegistryRows,
    fcpaCommitteeNumber: input.fcpaCommitteeNumber, windowStart: start, windowEnd: end });
}

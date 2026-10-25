import type { EfileCalContributionRow } from "../efileCalFinance/efileCalWorkbookParser.js";
import type { SanDiegoCityDirectFinanceAggregate } from "./sanDiegoCityDirectFinanceAggregator.js";

export type SanDiegoCityCommitteeCash = {
  officeName: "Mayor" | "City Council Member"; seatNumber: number | null;
  receivingFppcId: string; canonicalFilingCount: number; amountCents: number;
  contributionCount: number; reportedThrough: string | null;
  donors: { committeeKey: string; committeeId: string | null; committeeName: string;
    contributorType: "COM" | "PTY" | "SCC"; amountCents: number; contributionCount: number }[];
};
export function normalizeSanDiegoCommitteeName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
export function sanDiegoCommitteeKey(id: string | null, name: string): string {
  if (id !== null && !/^\d{4,12}$/.test(id)) throw new Error("Invalid San Diego reported donor committee ID");
  const normalized = normalizeSanDiegoCommitteeName(name);
  if (!normalized) throw new Error("Missing San Diego reported committee name");
  return id ? `id:${id}` : `reported:${normalized}`;
}
function day(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0,10) !== value) throw new Error("Invalid San Diego committee cash date");
  return value;
}
/** Gross non-memo Schedule A receipts, only native COM/PTY/SCC types.
 * Canonical filing winners are exactly those used by the direct aggregator.
 * Loans, noncash, unitemized and standalone 497 notices are never inputs.
 */
export function aggregateSanDiegoCityCommitteeCash(input: {
  officeName: "Mayor" | "City Council Member"; seatNumber: number | null;
  filerId: string; filings: SanDiegoCityDirectFinanceAggregate["filings"];
  scheduleA: readonly EfileCalContributionRow[]; reportedThrough: string | null;
}): SanDiegoCityCommitteeCash {
  if (!/^\d{4,12}$/.test(input.filerId)) throw new Error("Invalid San Diego receiving ID");
  const filings = new Map(input.filings.map(f => [f.eFilingId, f]));
  if (filings.size !== input.filings.length) throw new Error("Duplicate San Diego canonical filing");
  const rows = input.scheduleA.filter(row => row.filerId === input.filerId && filings.has(row.eFilingId));
  const ownNames = new Set(rows.map(row => normalizeSanDiegoCommitteeName(row.filerName)));
  const seen = new Set<string>(), groups = new Map<string, SanDiegoCityCommitteeCash["donors"][number]>();
  let amountCents = 0, contributionCount = 0;
  for (const row of rows) {
    const nativeKey = `${row.eFilingId}|${row.tranId}`;
    if (!row.tranId || seen.has(nativeKey)) throw new Error("Duplicate or missing San Diego native Schedule A occurrence");
    seen.add(nativeKey);
    if (row.memo || !["COM","PTY","SCC"].includes(row.entityCd ?? "")) continue;
    const name = [row.contributorLastName, row.contributorFirstName].filter(Boolean).join(" ").trim();
    const id = row.contributorCommitteeId?.trim() || null;
    const key = sanDiegoCommitteeKey(id, name);
    if (id === input.filerId || ownNames.has(normalizeSanDiegoCommitteeName(name))) continue;
    if (row.formType !== "A") throw new Error("San Diego committee cash is not a Schedule A monetary receipt");
    const filing = filings.get(row.eFilingId)!;
    if (row.fromDate !== filing.fromDate || row.thruDate !== filing.thruDate || row.reportNum !== filing.reportNum ||
      day(row.receiptDate) < day(filing.fromDate) || day(row.receiptDate) > day(filing.thruDate))
      throw new Error("San Diego committee cash conflicts with its canonical filing period");
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0)
      throw new Error("Signed or imprecise San Diego committee cash requires review");
    if (!row.amountCents) continue;
    const group = groups.get(key) ?? { committeeKey:key,committeeId:id,committeeName:name,
      contributorType:row.entityCd as "COM"|"PTY"|"SCC",amountCents:0,contributionCount:0 };
    if (group.contributorType !== row.entityCd) throw new Error("Conflicting San Diego reported donor types");
    if (name.length > group.committeeName.length || name.length === group.committeeName.length && name.localeCompare(group.committeeName) < 0)
      group.committeeName = name;
    group.amountCents += row.amountCents; group.contributionCount++; amountCents += row.amountCents; contributionCount++;
    if (!Number.isSafeInteger(group.amountCents) || !Number.isSafeInteger(amountCents)) throw new Error("San Diego committee cash exceeds safe cents");
    groups.set(key,group);
  }
  if (input.reportedThrough !== null) day(input.reportedThrough);
  if (groups.size && input.reportedThrough === null) throw new Error("San Diego committee cash lacks report date");
  return {officeName:input.officeName,seatNumber:input.seatNumber,receivingFppcId:input.filerId,canonicalFilingCount:filings.size,amountCents,contributionCount,
    reportedThrough:input.reportedThrough,donors:[...groups.values()].sort((a,b)=>b.amountCents-a.amountCents||a.committeeKey.localeCompare(b.committeeKey))};
}

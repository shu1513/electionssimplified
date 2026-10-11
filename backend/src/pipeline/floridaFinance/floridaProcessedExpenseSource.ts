import { createHash } from "node:crypto";
import {
  decodeFloridaCommitteeDetail,
  fingerprintFloridaCommitteeDetailSemantics,
  type FloridaCommitteeDetail,
} from "./floridaCommitteeRegistrySource.js";
import {
  decodeFloridaEfsExpenditureElectionContext,
  decodeFloridaNativeExpenditureTsv,
  type FloridaEfsExpenditureElectionContext,
  type FloridaNativeExpenditure,
} from "./floridaExplicitIndependentExpenditure.js";
import { decodeFloridaExpenditureDiscoveryTsv } from "./floridaIndependentExpenditureDiscovery.js";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";

export type FloridaProcessedExpenseContext = {
  payerAccount: string;
  payerName: string;
  payerType: "PAC" | "IXO";
  electionYear: number;
  electionType: "general" | "special";
  electionDescription: string;
  electionSelector: string;
  genericPayerLabel: string;
};
export type FloridaProcessedExpensePacket = {
  ownership: FloridaProcessedRawEvidence;
  activity: FloridaProcessedRawEvidence;
  currentReports: readonly FloridaProcessedRawEvidence[];
  periodExports: readonly FloridaProcessedRawEvidence[];
  allDatesExport: FloridaProcessedRawEvidence;
  genericExport: FloridaProcessedRawEvidence;
};
export type FloridaExpenseCover = {
  nativeSequence: number | null;
  periodStart: string;
  periodEnd: string;
  waiver: boolean;
  expenseCents: number;
  otherCents: number;
  transferCents: number;
  sourceCells: readonly string[];
};
export type FloridaProcessedExpenseProof = {
  version: 1;
  authority: "current_processed_expense_ledger";
  scope: "positive_reports_single_account_election";
  candidateWideZeroAuthority: false;
  context: FloridaProcessedExpenseContext;
  owner: FloridaCommitteeDetail;
  reports: readonly { current: FloridaEfsExpenditureElectionContext; cover: FloridaExpenseCover }[];
  rows: readonly FloridaNativeExpenditure[];
  financialFingerprint: string;
  sourceMetadata: readonly (Omit<FloridaProcessedRawEvidence, "bytesRaw"> & {
    phase: "before" | "after";
    byteCount: number;
  })[];
};
const DOS = "https://dos.elections.myflorida.com";
const EFS = "https://efs.dos.state.fl.us/PrintReportSubmitted.aspx";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const display = (value: string) => value.trim().replace(/\s+/gu, " ");
const exact = (value: string) => display(value).toUpperCase();
function fail(reason: string): never { throw new Error(`Florida processed expenses: ${reason}`); }
function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const key = match[1]!.toLowerCase();
    if (key in result) fail("duplicate source attribute");
    result[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}
function text(value: string): string {
  const named: Record<string, string> = { amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">" };
  return display(value.replace(/<[^>]*>/g, " ").replace(/&([a-z]+|#\d+|#x[\da-f]+);/gi, (_, token: string) => {
    if (!token.startsWith("#")) return named[token.toLowerCase()] ?? fail("unknown source entity");
    const code = token.toLowerCase().startsWith("#x") ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail("invalid entity");
    return String.fromCodePoint(code);
  }));
}
function civil(raw: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!match) fail("invalid cover date");
  const date = `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail("invalid cover date");
  return date;
}
function cents(value: string): number {
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(value)) fail("invalid cover cents");
  const [whole, fraction] = value.replace(/^-/, "").replace(/,/g, "").split(".");
  const result = (value.startsWith("-") ? -1 : 1) * (Number(whole) * 100 + Number(fraction));
  if (!Number.isSafeInteger(result)) fail("unsafe cover cents");
  return result;
}
function sum(values: readonly number[]): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result)) fail("unsafe expense total");
  return result;
}
function integer(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail("missing/invalid source count");
  return Number(value);
}
function fieldsEqual(a: Readonly<Record<string, string>> | null, b: Readonly<Record<string, string>> | null): boolean {
  return JSON.stringify(a && Object.entries(a).sort()) === JSON.stringify(b && Object.entries(b).sort());
}
function rawText(raw: FloridaProcessedRawEvidence, url: string, method: "GET" | "POST",
  fields: Readonly<Record<string, string>> | null): string {
  if (!(raw.bytesRaw instanceof Uint8Array) || !raw.bytesRaw.length || raw.bytesRaw.length > 4 * 1024 * 1024 ||
    raw.status !== 200 || raw.url !== url || raw.method !== method || !fieldsEqual(raw.financeFields, fields) ||
    !/^[a-f0-9]{64}$/.test(raw.sha256) || sha(raw.bytesRaw) !== raw.sha256 ||
    typeof raw.contentType !== "string" || !raw.contentType.trim()) fail("invalid request-bound source envelope");
  const start = Date.parse(raw.startedAt), end = Date.parse(raw.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) fail("invalid capture times");
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(raw.bytesRaw); }
  catch { return fail("unsupported source encoding"); }
  if (/access denied|runtime error|overflow error|invalid date range|internal server error/i.test(body)) fail("source error response");
  return body;
}
function requireHtml(html: string): void {
  if (!/<\/body\s*>/i.test(html) || !/<\/html\s*>/i.test(html) || /<input[^>]+type=["']?password/i.test(html))
    fail("incomplete/login source HTML");
}

/** Source-observed committee cover: three contribution columns followed by
 * Expend, Other and Transfers. No receipt total substitutes for expense money. */
export function decodeFloridaCommitteeExpenseCover(html: string, account: string): {
  periods: FloridaExpenseCover[]; totals: readonly string[];
} {
  requireHtml(html);
  const inputs = [...html.matchAll(/<input\b([^>]*)>/gi)].map(match => attributes(match[1]!));
  const accounts = inputs.filter(input => input.name === "account");
  if (accounts.length !== 1 || accounts[0]!.value !== account) fail("wrong activity account");
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].filter(match =>
    /<th\b[^>]*>[\s\S]*?Filing Period/i.test(match[1]!));
  if (tables.length !== 1) fail("missing/ambiguous expense cover table");
  const table = tables[0]![1]!;
  const rawRows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rawRows.length < 4 || rawRows.length !== (table.match(/<tr\b/gi) ?? []).length) fail("incomplete expense cover rows");
  const header = [...rawRows[0]![1]!.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match => text(match[1]!));
  const subheader = [...rawRows[1]![1]!.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match => text(match[1]!));
  if (JSON.stringify(header) !== JSON.stringify(["", "Filing Period", "Contributions", "Expend", "Other", "Transfers"]) ||
    JSON.stringify(subheader) !== JSON.stringify(["Monetary", "Loans", "InKind"])) fail("unproven expense cover columns");
  const periods: FloridaExpenseCover[] = [];
  let totals: string[] | undefined;
  const seen = new Set<string>();
  for (const raw of rawRows.slice(2)) {
    const cells = [...raw[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]!);
    if (cells.length !== 8 || cells.length !== (raw[1]!.match(/<td\b/gi) ?? []).length) fail("invalid expense cover width");
    const sourceCells = cells.map(text);
    sourceCells.slice(2).forEach(cents);
    const radios = [...cells[0]!.matchAll(/<input\b([^>]*)>/gi)].map(match => attributes(match[1]!));
    if (sourceCells[1] === "All Dates (Totals)") {
      if (totals || radios.length !== 1 || radios[0]!.name !== "seqnum" || radios[0]!.value !== "0") fail("invalid all-date totals");
      totals = sourceCells;
      continue;
    }
    const dates = sourceCells[1]!.split(" - ");
    if (dates.length !== 2) fail("invalid cover period");
    const periodStart = civil(dates[0]!), periodEnd = civil(dates[1]!);
    if (periodStart > periodEnd || seen.has(`${periodStart}/${periodEnd}`)) fail("duplicate/reversed cover period");
    seen.add(`${periodStart}/${periodEnd}`);
    const waiver = sourceCells[0] === "W";
    let nativeSequence: number | null = null;
    if (waiver) {
      if (radios.length || sourceCells.slice(2).some(value => cents(value) !== 0)) fail("contradictory waiver cover");
    } else {
      if (sourceCells[0] !== "" || radios.length !== 1 || radios[0]!.name !== "seqnum" ||
        radios[0]!.type?.toLowerCase() !== "radio" || !/^[1-9]\d*$/.test(radios[0]!.value ?? "") ||
        !Number.isSafeInteger(Number(radios[0]!.value))) fail("invalid actual native sequence");
      nativeSequence = Number(radios[0]!.value);
    }
    periods.push({
      nativeSequence, periodStart, periodEnd, waiver, sourceCells,
      expenseCents: cents(sourceCells[5]!), otherCents: cents(sourceCells[6]!), transferCents: cents(sourceCells[7]!)
    });
  }
  if (!periods.length || !totals || new Set(periods.filter(p => !p.waiver).map(p => p.nativeSequence)).size !==
    periods.filter(p => !p.waiver).length) fail("incomplete/duplicate cover sequences");
  for (let column = 2; column < 8; column++) {
    if (sum(periods.map(p => cents(p.sourceCells[column]!))) !== cents(totals[column]!)) fail("cover totals mismatch");
  }
  return { periods, totals };
}
function allRaw(packet: FloridaProcessedExpensePacket): FloridaProcessedRawEvidence[] {
  return [packet.ownership, packet.activity, ...packet.currentReports, ...packet.periodExports,
  packet.allDatesExport, packet.genericExport];
}
function nativeFields(account: string, sequence: number) {
  return { account, seqnum: String(sequence), queryfor: "2", queryorder: "DAT", queryoutput: "2", query: "Submit Query Now" };
}
function tuple(row: FloridaNativeExpenditure): readonly unknown[] {
  return [row.date, row.amountCents, display(row.payeeName), display(row.address),
  display(row.cityStateZip), display(row.purpose), row.typeAndReimbursement];
}
function multiset(rows: readonly unknown[]): string {
  return JSON.stringify(rows.map(row => JSON.stringify(row)).sort());
}
function verifyPacket(packet: FloridaProcessedExpensePacket, context: FloridaProcessedExpenseContext) {
  rawText(packet.ownership, `${DOS}/committees/ComDetail.asp?account=${context.payerAccount}`, "GET", null);
  const owner = decodeFloridaCommitteeDetail(packet.ownership, { committeeId: context.payerAccount });
  if (exact(owner.committeeName) !== exact(context.payerName) || owner.committeeType !== context.payerType)
    fail("wrong legal payer identity/type");
  const activity = rawText(packet.activity, `${DOS}/cgi-bin/TreSel.exe`, "POST", {
    account: context.payerAccount, election: "All", submit: "Campaign Finance Activity",
  });
  const cover = decodeFloridaCommitteeExpenseCover(activity, context.payerAccount);
  if (cover.periods.some(p => p.otherCents !== 0 || p.transferCents !== 0)) fail("unjoined Other/Transfers activity");
  const financialPeriods = cover.periods.filter(p => !p.waiver);
  if (financialPeriods.some(p => p.expenseCents <= 0)) fail("unsupported nonpositive current expense period");
  if (cover.periods.length !== packet.currentReports.length || financialPeriods.length !== packet.periodExports.length)
    fail("missing/extra full current expense reports");
  const reports = packet.currentReports.map(raw => {
    const html = rawText(raw, raw.url, "GET", null);
    requireHtml(html);
    const report = decodeFloridaEfsExpenditureElectionContext(html);
    if (raw.url !== `${EFS}?AcctNum=${context.payerAccount}&SeqNum=${report.sequence}` ||
      report.account !== context.payerAccount || exact(String(report.fullMetadata.lblFullName)) !== exact(context.payerName) ||
      report.electionYear !== context.electionYear || report.electionType !== context.electionType ||
      report.electionDescription !== context.electionDescription || report.fileStatus !== "Filed Report" ||
      report.reviewStatus !== "Reviewed" || report.queued !== 0 ||
      (report.waiver
        ? report.completeness !== "No Detail Records Found" || report.expenseCount !== 0 ||
          integer(report.fullMetadata.lblCntCon) !== 0
        : report.completeness !== "Complete Detail Records" || report.expenseCount <= 0)) fail("unproved current report ownership/status/context");
    if (integer(report.fullMetadata.lblCntXfr) !== 0 || integer(report.fullMetadata.lblCntOth) !== 0)
      fail("unjoined current report Other/Transfers records");
    return report;
  });
  if (new Set(reports.map(r => r.sequence)).size !== reports.length ||
    new Set(reports.map(r => `${r.reportYear}/${r.reportType}`)).size !== reports.length)
    fail("ambiguous current report keys");
  const usedExports = new Set<FloridaProcessedRawEvidence>();
  const union: FloridaNativeExpenditure[] = [];
  const joinedReports = cover.periods.map(period => {
    const matching = reports.filter(r => r.periodStart === period.periodStart && r.periodEnd === period.periodEnd);
    if (matching.length !== 1) fail("ambiguous current coverage mapping");
    const current = matching[0]!;
    if (current.waiver !== period.waiver) fail("contradictory current waiver status coverage");
    if (period.waiver) return { current, cover: period };
    const exports = packet.periodExports.filter(raw => raw.financeFields?.seqnum === String(period.nativeSequence));
    if (exports.length !== 1 || usedExports.has(exports[0]!)) fail("missing/duplicate actual native period export");
    const raw = exports[0]!;
    usedExports.add(raw);
    const rows = decodeFloridaNativeExpenditureTsv(rawText(raw, `${DOS}/cgi-bin/TreFin.exe`, "POST",
      nativeFields(context.payerAccount, period.nativeSequence!)));
    if (rows.length !== current.expenseCount || sum(rows.map(r => r.amountCents)) !== period.expenseCents)
      fail("whole expense count/Expend cover mismatch");
    if (rows.some(row => row.reportYear !== current.reportYear || row.reportType !== current.reportType ||
      row.date < current.periodStart || row.date > current.periodEnd || row.amountCents <= 0 ||
      !["IEC", "MON"].includes(row.typeAndReimbursement))) fail("unsupported current row report/date/signed/type identity");
    union.push(...rows);
    return { current, cover: period };
  });
  const allDates = decodeFloridaNativeExpenditureTsv(rawText(packet.allDatesExport, `${DOS}/cgi-bin/TreFin.exe`, "POST",
    nativeFields(context.payerAccount, 0)));
  const nativeIdentity = (row: FloridaNativeExpenditure) => [row.reportYear, row.reportType, ...tuple(row)];
  if (!allDates.length || multiset(allDates.map(nativeIdentity)) !== multiset(union.map(nativeIdentity)))
    fail("whole/period occurrence union mismatch");
  const genericFields = packet.genericExport.financeFields;
  const expectedGeneric = {
    election: context.electionSelector, search_on: "4", CanFName: "", CanLName: "", CanNameSrch: "2",
    office: "All", cdistrict: "", cgroup: "", party: "All", ComName: context.payerName, ComNameSrch: "2",
    committee: "All", cfname: "", clname: "", namesearch: "2", ccity: "", cstate: "", czipcode: "",
    cpurpose: "", cdollar_minimum: "", cdollar_maximum: "", rowlimit: genericFields?.rowlimit ?? "",
    csort1: "DAT", csort2: "CAN", cdatefrom: "", cdateto: "", queryformat: "2", Submit: "Submit",
  };
  if (!/^[1-9]\d*$/.test(expectedGeneric.rowlimit) || Number(expectedGeneric.rowlimit) > 100000 ||
    !Number.isSafeInteger(Number(expectedGeneric.rowlimit))) fail("invalid generic application cap");
  const generic = decodeFloridaExpenditureDiscoveryTsv(rawText(packet.genericExport, `${DOS}/cgi-bin/expend.exe`, "POST", expectedGeneric));
  if (generic.length >= Number(expectedGeneric.rowlimit) || generic.some(row => row.payerLabel !== context.genericPayerLabel))
    fail("wrong/capped generic payer scope");
  const genericTuples = generic.map(row => [row.date, row.amountCents, display(row.payeeName), display(row.address),
  display(row.cityStateZip), display(row.purpose), row.sourceType]);
  if (multiset(genericTuples) !== multiset(allDates.map(tuple))) fail("generic/native full financial occurrence mismatch");
  return { owner, reports: joinedReports, rows: allDates, financialFingerprint: sha(multiset(allDates.map(nativeIdentity))) };
}

/** A source proof for whole positive reports. Never candidate-wide completeness,
 * zero authority, target allocation, historical deletion recovery, or gift dedupe. */
export function verifyFloridaProcessedExpenseSource(input: {
  context: FloridaProcessedExpenseContext;
  before: FloridaProcessedExpensePacket;
  after: FloridaProcessedExpensePacket;
}): { proof?: FloridaProcessedExpenseProof; diagnostics: string[] } {
  try {
    input = structuredClone(input);
    const context = input.context;
    if (!/^[1-9]\d*$/.test(context.payerAccount) || !Number.isSafeInteger(Number(context.payerAccount)) ||
      !context.payerName.trim() || !["PAC", "IXO"].includes(context.payerType) || context.electionYear !== 2026 ||
      context.genericPayerLabel !== `${context.payerName} (${context.payerType})` ||
      !(context.electionType === "general" && context.electionSelector === "20261103-GEN" &&
        context.electionDescription === "2026 General Election") &&
      !(context.electionType === "special" && context.electionSelector === "20260324-S01" &&
        context.electionDescription === "2026 Special Election - Senate 14 & House 87")) fail("unsupported exact payer/election context");
    const before = verifyPacket(input.before, context), after = verifyPacket(input.after, context);
    if (Math.max(...allRaw(input.before).map(raw => Date.parse(raw.completedAt))) >
      Math.min(...allRaw(input.after).map(raw => Date.parse(raw.startedAt)))) fail("closing predates completed opening");
    const semantic = (result: ReturnType<typeof verifyPacket>) => ({
      owner: fingerprintFloridaCommitteeDetailSemantics(result.owner),
      reports: result.reports.map(r => JSON.stringify(r)).sort(), fingerprint: result.financialFingerprint,
    });
    if (JSON.stringify(semantic(before)) !== JSON.stringify(semantic(after))) fail("changed current expense generation");
    return {
      proof: {
        version: 1, authority: "current_processed_expense_ledger", scope: "positive_reports_single_account_election",
        candidateWideZeroAuthority: false, context, ...after,
        sourceMetadata: (["before", "after"] as const).flatMap(phase => allRaw(input[phase]).map(({ bytesRaw, ...raw }) =>
          ({ ...raw, phase, byteCount: bytesRaw.length }))),
      },
      diagnostics: ["Verified current positive report occurrences only; no candidate-wide zero or target allocation authority."],
    };
  } catch (error) {
    return { diagnostics: [error instanceof Error ? error.message : "Expense source proof failed."] };
  }
}

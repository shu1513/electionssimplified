import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { IllinoisCandidateFinanceDueRow } from "./illinoisCandidateFinanceBatchSync.js";
import type { IllinoisFinanceOutsideReportEvidence, IllinoisFinancePacDonorInput } from "./illinoisFinanceWriter.js";
import type { IllinoisSbeD2ReportSummary } from "./illinoisSbeNormalizedArtifact.js";
import { parseIllinoisSbeTsv } from "./illinoisSbeTsvParser.js";
import { createIllinoisSbeLegalCommitteeDonorMatcher, decodeIllinoisSbeLegalCommitteeRegistry,
  decodeIllinoisSbeWindows1252 } from "./illinoisSbeLegalCommitteeDonorMatcher.js";
import { resolveIllinoisSbeExpenditureTarget, type IllinoisSbeTargetCandidate,
  type IllinoisSbeTargetElection, type IllinoisSbeTargetCommitteeCandidateLink } from "./illinoisSbeTargetResolver.js";
import { readIllinoisSbeQuarterlyManifestAndTotals, type IllinoisSbeQuarterlyDocument,
  type IllinoisSbeQuarterlyManifestAndTotals, type IllinoisSbeQuarterlyReport } from "./illinoisSbeQuarterlyReportReader.js";
import { parseIllinoisSbeContributionRecordsCsv, parseIllinoisSbeExpenditureRecordsCsv, parseIllinoisSbeCsvRows,
  type IllinoisSbeContributionRecord, type IllinoisSbeExpenditureRecord } from "./illinoisSbeCsvReader.js";
import { decodeIllinoisSbeText, ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL,
  ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL } from "./illinoisSbeClient.js";

const BULK_URL = "https://www.elections.il.gov/CampaignDisclosure/DownloadCDDataFiles.aspx";
const CANDIDATE_HEADER = ["ID", "LastName", "FirstName", "Address1", "Address2", "City", "State", "Zip", "Office", "DistrictType", "District", "ResidenceCounty", "PartyAffiliation", "RedactionRequested"];
const ELECTION_HEADER = ["ID", "CandidateID", "ElectionType", "ElectionYear", "IncChallOpen", "WonLost", "FairCampaign", "LimitsOff", "LimitsOffReason"];
const LINK_HEADER = ["ID", "CommitteeID", "CandidateID"];
export type IllinoisSbeVerifiedQuarterlyConfig = {
  committeeRegistryPath: string; candidatesPath: string; candidateElectionsPath: string;
  committeeCandidateLinksPath: string; filedDocumentsPath: string; d2TotalsPath: string;
  afterFiledDocumentsPath: string; coverageYears: readonly number[];
  contributionCsvPathsByCommitteeId?: Readonly<Record<string, string>>;
  outsideExpendituresCsvPath?: string;
  outsideQueryWindow?: { fromDate: string; toDate: string };
};
export type IllinoisSbeVerifiedSource = { path: string; sha256: string; bytes: number; rowCount?: number };
export type IllinoisSbeVerifiedQuarterlyCandidateData = {
  directContributionRecords?: readonly IllinoisSbeContributionRecord[];
  pacDonors?: readonly IllinoisFinancePacDonorInput[];
  d2ReportSummaries?: readonly IllinoisSbeD2ReportSummary[];
  outsideExpenditureRecords?: readonly IllinoisSbeExpenditureRecord[];
  outsideReportEvidence?: readonly IllinoisFinanceOutsideReportEvidence[];
  directContributionSourceUrl?: string;
  outsideExpenditureSourceUrl?: string;
  diagnostics: string[];
};
export type IllinoisSbeVerifiedQuarterlyDataSet = {
  sources: Record<string, IllinoisSbeVerifiedSource>;
  quarterlyManifest: IllinoisSbeQuarterlyManifestAndTotals;
  diagnostics: { direct: Map<string, string[]>; outside: Map<string, string[]> };
  acceptedIEReports: readonly IllinoisFinanceOutsideReportEvidence[];
  loadCandidateData(row: IllinoisCandidateFinanceDueRow): IllinoisSbeVerifiedQuarterlyCandidateData;
};
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function id(value: string): boolean { return /^[1-9]\d*$/.test(value); }
function day(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  const iso = m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(iso + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}
function cents(amount: number): number {
  const rounded = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(rounded) || Math.abs(amount * 100 - rounded) > 0.00001)
    throw new Error("Money is not exact safe cents");
  return rounded;
}
function key(document: { committeeId: string; periodStart: string | null; periodEnd: string | null; receivedDay: string | null }): string {
  return JSON.stringify([document.committeeId, "Quarterly", document.periodStart, document.periodEnd, document.receivedDay]);
}
function manifestFingerprints(manifest: IllinoisSbeQuarterlyManifestAndTotals): Map<string, string> {
  const documents = new Map<string, IllinoisSbeQuarterlyDocument[]>();
  for (const doc of manifest.documentsById.values()) {
    const rows = documents.get(doc.committeeId) ?? []; rows.push(doc); documents.set(doc.committeeId, rows);
  }
  return new Map([...documents].map(([committee, rows]) => [committee,
    digest(JSON.stringify(rows.sort((a, b) => a.documentId.localeCompare(b.documentId))))]));
}
function overlap(reports: readonly IllinoisSbeQuarterlyReport[]): boolean {
  return reports.some((a, i) => reports.some((b, j) => i < j &&
    a.document.periodStart! <= b.document.periodEnd! && b.document.periodStart! <= a.document.periodEnd!));
}
async function immutable(path: string, maxBytes?: number): Promise<{ bytes: Buffer; source: IllinoisSbeVerifiedSource }> {
  const before = await stat(path);
  if (!before.isFile() || !before.size || (maxBytes !== undefined && before.size > maxBytes)) throw new Error("Invalid or oversized source " + path);
  const bytes = await readFile(path), after = await stat(path);
  if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Source changed during reading " + path);
  return { bytes, source: { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
}
function csvText(bytes: Buffer): string { return decodeIllinoisSbeText(Uint8Array.from(bytes).buffer); }
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Accepted current regular reports only; absent/ambiguous components are diagnosed and omitted. */
export async function loadIllinoisSbeVerifiedQuarterlyDataSet(config: IllinoisSbeVerifiedQuarterlyConfig): Promise<IllinoisSbeVerifiedQuarterlyDataSet> {
  if (resolve(config.filedDocumentsPath) === resolve(config.afterFiledDocumentsPath)) throw new Error("Independent after FiledDocs snapshot is required");
  const firstStat = await stat(config.filedDocumentsPath), afterStat = await stat(config.afterFiledDocumentsPath);
  if (firstStat.dev === afterStat.dev && firstStat.ino === afterStat.ino) throw new Error("Independent after FiledDocs snapshot is required");
  const sources: Record<string, IllinoisSbeVerifiedSource> = {};
  const registryRaw = await immutable(config.committeeRegistryPath);
  const registry = decodeIllinoisSbeLegalCommitteeRegistry(registryRaw.bytes);
  sources.registry = { ...registryRaw.source, rowCount: registry.length };
  const donorMatch = createIllinoisSbeLegalCommitteeDonorMatcher(registry);
  const sourceCommittees = registry.map((r) => ({ committeeId: r.committeeId, committeeName: r.legalName, committeeType: r.committeeType, committeeStatus: r.status }));
  const sourceCandidates: IllinoisSbeTargetCandidate[] = [], sourceElections: IllinoisSbeTargetElection[] = [];
  const sourceLinks: IllinoisSbeTargetCommitteeCandidateLink[] = [];
  for (const [label, path, header, visit] of [
    ["candidates", config.candidatesPath, CANDIDATE_HEADER, (r: string[]) => sourceCandidates.push({ candidateId: r[0]!, candidateName: `${r[2]} ${r[1]}`.trim(), office: r[8]!.trim(), districtType: r[9]!.trim(), district: r[10]!.trim() })],
    ["elections", config.candidateElectionsPath, ELECTION_HEADER, (r: string[]) => sourceElections.push({ candidateId: r[1]!, electionType: r[2]!.trim(), electionYear: Number(r[3]!.trim()) })],
    ["links", config.committeeCandidateLinksPath, LINK_HEADER, (r: string[]) => sourceLinks.push({ committeeId: r[1]!, candidateId: r[2]! })],
  ] as const) {
    const raw = await immutable(path); let count = 0; const seen = new Set<string>();
    parseIllinoisSbeTsv(decodeIllinoisSbeWindows1252(raw.bytes), label, header, (r) => {
      if (!id(r[0]!) || (label !== "candidates" && !id(r[1]!)) || (label === "links" && !id(r[2]!)))
        throw new Error("Invalid " + label + " source ID");
      if (seen.has(r[0]!)) throw new Error("Duplicate " + label + " source ID");
      seen.add(r[0]!); count++; visit(r);
    });
    if (!count) throw new Error("Empty source identity table " + label);
    sources[label] = { ...raw.source, rowCount: count };
  }
  const before = await readIllinoisSbeQuarterlyManifestAndTotals({ ...config });
  sources.filedDocuments = before.sources.filedDocuments; sources.d2Totals = before.sources.d2Totals;
  const allDayKeys = new Map<string, IllinoisSbeQuarterlyDocument[]>();
  const archivedByPeriod = new Map<string, string[]>();
  const periodKey = (doc: { committeeId: string; periodStart: string | null; periodEnd: string | null }) => JSON.stringify([doc.committeeId, doc.periodStart, doc.periodEnd]);
  for (const doc of before.documentsById.values()) {
    const records = allDayKeys.get(key(doc)) ?? []; records.push(doc); allDayKeys.set(key(doc), records);
    if (doc.archived === true) { const ids = archivedByPeriod.get(periodKey(doc)) ?? []; ids.push(doc.documentId); archivedByPeriod.set(periodKey(doc), ids); }
  }
  const directDiagnostics = new Map<string, string[]>(), outsideDiagnostics = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, committee: string, message: string) => {
    const errors = map.get(committee) ?? []; if (!errors.includes(message)) errors.push(message); map.set(committee, errors);
  };
  const reportsFor = (committee: string) => before.currentReportsByCommitteeId.get(committee) ?? [];
  const currentReportById = new Map([...before.currentReportsByCommitteeId.values()].flat().map((r) => [r.document.documentId, r]));
  const rowReport = (row: IllinoisSbeContributionRecord | IllinoisSbeExpenditureRecord, transaction: string | null): IllinoisSbeQuarterlyReport => {
    const transactionDay = day(transaction), start = day(row.reportingPeriodStart), end = day(row.reportingPeriodEnd), receivedDay = day(row.reportReceivedDate);
    if (!row.committeeId || !id(row.committeeId) || !transactionDay || !start || !end || !receivedDay || start > end || transactionDay < start || transactionDay > end)
      throw new Error("Invalid Quarterly row identity/date/period");
    const matches = allDayKeys.get(key({ committeeId: row.committeeId, periodStart: start, periodEnd: end, receivedDay })) ?? [];
    if (matches.length !== 1) throw new Error("Quarterly row has missing or ambiguous all-version day identity");
    const doc = matches[0]!;
    if (doc.archived) throw new Error("archived_row");
    const report = currentReportById.get(doc.documentId);
    if (!report) throw new Error("Quarterly row lacks accepted current D2 coverage");
    return report;
  };
  const cashByCommittee = new Map<string, IllinoisSbeContributionRecord[]>();
  for (const [committee, path] of Object.entries(config.contributionCsvPathsByCommitteeId ?? {})) {
    try {
      const raw = await immutable(path, 32 * 1024 * 1024);
      const records = parseIllinoisSbeContributionRecordsCsv(csvText(raw.bytes), ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL);
      sources["cash:" + committee] = { ...raw.source, rowCount: records.length };
      if (records.some((r) => r.committeeId !== committee)) throw new Error("Contribution export receiving committee mismatch");
      const accepted: IllinoisSbeContributionRecord[] = [];
      for (const row of records) {
        if (row.documentName !== "Quarterly") continue;
        if (!["Individual Contribution", "Transfer In"].includes(row.contributionType ?? "")) continue;
        const received = day(row.receivedDate);
        if (!received) throw new Error("Invalid cash transaction date");
        if (!config.coverageYears.includes(Number(received.slice(0, 4)))) continue;
        try { const report = rowReport(row, row.receivedDate); accepted.push({ ...row, sourceDocumentId: report.document.documentId }); }
        catch (e) { if (reason(e) !== "archived_row") throw e; }
      }
      const reports = reportsFor(committee);
      if (!reports.length || before.unknownCommittees.has(committee) || overlap(reports)) throw new Error("Missing, ambiguous or overlapping current Quarterly cash coverage");
      for (const report of reports) {
        if (!report.d2.components.cashItemized) throw new Error("Current cash schedule is not exact cents");
        const rows = accepted.filter((r) => r.sourceDocumentId === report.document.documentId);
        const individual = rows.filter((r) => r.contributionType === "Individual Contribution").reduce((s, r) => s + cents(r.amount), 0);
        const transfers = rows.filter((r) => r.contributionType === "Transfer In").reduce((s, r) => s + cents(r.amount), 0);
        if (!Number.isSafeInteger(individual + transfers) || individual !== report.d2.amountsCents.IndivContribI || transfers !== report.d2.amountsCents.XferInI)
          throw new Error("Current Quarterly cash itemized schedule mismatch");
        const raised = report.d2.amountsCents.TotalReceipts;
        if (raised !== null && individual + transfers > raised) throw new Error("Cash itemized receipts exceed reported Raised");
      }
      cashByCommittee.set(committee, accepted);
    } catch (error) { add(directDiagnostics, committee, reason(error)); }
  }
  const acceptedIE: IllinoisSbeExpenditureRecord[] = [], acceptedIEReports: IllinoisFinanceOutsideReportEvidence[] = [];
  if (config.outsideExpendituresCsvPath) {
    const start = day(config.outsideQueryWindow?.fromDate), end = day(config.outsideQueryWindow?.toDate);
    if (!start || !end || start > end) throw new Error("Complete all-target outside query window is required");
    try {
      const raw = await immutable(config.outsideExpendituresCsvPath, 32 * 1024 * 1024);
      const text = csvText(raw.bytes);
      const rows = parseIllinoisSbeExpenditureRecordsCsv(text, ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL);
      const nativeRows = parseIllinoisSbeCsvRows(text);
      const nativeIdentities = new WeakMap<IllinoisSbeExpenditureRecord, string>();
      sources.outside = { ...raw.source, rowCount: rows.length };
      const byReport = new Map<string, IllinoisSbeExpenditureRecord[]>();
      for (const [index, row] of rows.entries()) {
        if (row.documentName !== "Quarterly") continue;
        const committee = row.committeeId ?? "unknown";
        try {
          if (row.expenditureType !== "Independent Expenditure") throw new Error("Unexpected Quarterly expenditure type");
          const report = rowReport(row, row.expendedDate);
          const list = byReport.get(report.document.documentId) ?? [];
          const accepted = { ...row, sourceDocumentId: report.document.documentId };
          // Preserve every native field (including separate Purpose/Beneficiary) and equal-row multiplicity.
          nativeIdentities.set(accepted, JSON.stringify(Object.entries(nativeRows[index]!).sort(([a], [b]) => a.localeCompare(b))));
          list.push(accepted); byReport.set(report.document.documentId, list);
        } catch (e) { if (reason(e) !== "archived_row") add(outsideDiagnostics, committee, reason(e)); }
      }
      for (const [committee, reports] of before.currentReportsByCommitteeId) {
        if (before.unknownCommittees.has(committee)) {
          add(outsideDiagnostics, committee, "Incomplete or ambiguous whole-spender Quarterly coverage"); continue;
        }
        if (outsideDiagnostics.has(committee)) continue;
        if (overlap(reports)) { add(outsideDiagnostics, committee, "Overlapping current Quarterly periods"); continue; }
        const localRows: IllinoisSbeExpenditureRecord[] = [], proofs: IllinoisFinanceOutsideReportEvidence[] = [];
        try {
          for (const report of reports) {
            const doc = report.document;
            if (doc.periodStart! < start || doc.periodEnd! > end) throw new Error("Outside query does not cover whole current report period");
            if (!report.d2.components.independentExpenditures) throw new Error("Current IE schedules are not exact cents");
            const list = byReport.get(doc.documentId) ?? [];
            if (list.some((r) => r.amount < 0)) throw new Error("Signed IE expenses require a separate net spending policy");
            const sum = list.reduce((s, r) => s + cents(r.amount), 0);
            if (!Number.isSafeInteger(sum) || sum !== report.d2.amountsCents.IndependentExpI) throw new Error("Current whole-report IE itemized schedule mismatch");
            const identities = list.map((r) => nativeIdentities.get(r)!).sort();
            proofs.push({ committeeId: committee, filedDocId: doc.documentId, periodStart: doc.periodStart!, periodEnd: doc.periodEnd!, receivedAt: doc.receivedAtRaw,
              fingerprint: digest(JSON.stringify(identities)), supersededDocumentIds: [...(archivedByPeriod.get(periodKey(doc)) ?? [])].sort() });
            localRows.push(...list);
          }
          acceptedIE.push(...localRows); acceptedIEReports.push(...proofs);
        } catch (e) { add(outsideDiagnostics, committee, reason(e)); }
      }
    } catch (e) { add(outsideDiagnostics, "*", reason(e)); }
  } else add(outsideDiagnostics, "*", "Outside CSV source not supplied");
  // This independently acquired snapshot closes the source-version bracket around all CSV reads.
  const after = await readIllinoisSbeQuarterlyManifestAndTotals({ filedDocumentsPath: config.afterFiledDocumentsPath, d2TotalsPath: config.d2TotalsPath, coverageYears: config.coverageYears });
  sources.afterFiledDocuments = after.sources.filedDocuments;
  const changedCommittees = new Set<string>();
  const beforeFingerprints = manifestFingerprints(before), afterFingerprints = manifestFingerprints(after);
  const relevant = new Set([...before.currentReportsByCommitteeId.keys(), ...cashByCommittee.keys(), ...acceptedIEReports.map((r) => r.committeeId)]);
  for (const committee of relevant) {
    if (beforeFingerprints.get(committee) !== afterFingerprints.get(committee) || after.unknownCommittees.has(committee)) {
      changedCommittees.add(committee);
      cashByCommittee.delete(committee); add(directDiagnostics, committee, "Quarterly manifest changed between source snapshots");
      add(outsideDiagnostics, committee, "Quarterly manifest changed between source snapshots");
    }
  }
  const finalIE = acceptedIE.filter((r) => !outsideDiagnostics.has(r.committeeId!));
  const finalReports = acceptedIEReports.filter((r) => !outsideDiagnostics.has(r.committeeId));
  return { sources, quarterlyManifest: before, diagnostics: { direct: directDiagnostics, outside: outsideDiagnostics }, acceptedIEReports: finalReports,
    loadCandidateData(row) {
      const data: IllinoisSbeVerifiedQuarterlyCandidateData = { diagnostics: [] };
      const committee = /^SBE:([1-9]\d*)$/.exec(row.committeeKey)?.[1];
      const source = registry.find((r) => r.committeeId === committee), candidate = sourceCandidates.find((c) => c.candidateId === row.sbeCandidateId);
      const targetOffice = candidate?.districtType === "Representative" || candidate?.districtType === "Senate" ? `${candidate.office} District ${candidate.district}` : candidate?.office ?? "";
      const target = { candidateId: row.sbeCandidateId ?? "", candidateName: row.candidateName, electionYear: row.electionYear, electionType: "GE" as const,
        officeScope: row.officeScope, officeName: row.officeName, district: row.district };
      const resolveTarget = (name: string, office: string) => resolveIllinoisSbeExpenditureTarget({ targetName: name, targetOffice: office, target,
        sourceCandidates, sourceElections, sourceCommittees, sourceCommitteeCandidateLinks: sourceLinks });
      const ownership = resolveTarget(source?.legalName ?? "", targetOffice);
      if (!committee || !source || source.committeeType !== "Candidate" || ownership.status !== "matched" || ownership.committeeId !== committee) {
        data.diagnostics.push("Receiving candidate ownership/name/election/seat is unverified"); return data;
      }
      const low = `${row.electionYear - 1}-01-01`, high = `${row.electionYear}-12-31`;
      const intersectingReports = reportsFor(committee).filter((r) => r.document.periodStart! <= high && r.document.periodEnd! >= low);
      const reports = intersectingReports.filter((r) => r.document.periodStart! >= low && r.document.periodEnd! <= high);
      const errors = directDiagnostics.get(committee) ?? before.unknownCommittees.get(committee);
      if (errors) data.diagnostics.push(...errors);
      const directCoverage = config.coverageYears.includes(row.electionYear - 1) && config.coverageYears.includes(row.electionYear) &&
        reports.length > 0 && reports.length === intersectingReports.length && !overlap(reports);
      if (!directCoverage) data.diagnostics.push("Whole election-cycle current Quarterly coverage is unavailable");
      if (directCoverage && !before.unknownCommittees.has(committee) && !changedCommittees.has(committee) && reports.every((r) => r.d2.components.raised)) {
        const allExpenses = reports.every((r) => r.d2.amountsCents.TotalExpend !== null);
        const latest = reports.reduce((a, b) => a.document.periodEnd! > b.document.periodEnd! ? a : b);
        data.d2ReportSummaries = reports.map((r) => ({ reportId: r.document.documentId, committeeId: committee, periodStart: r.document.periodStart!, periodEnd: r.document.periodEnd!,
          filedAt: r.document.receivedAtRaw, totalReceipts: r.d2.amountsCents.TotalReceipts! / 100,
          totalDisbursements: allExpenses ? r.d2.amountsCents.TotalExpend! / 100 : null,
          cashOnHand: r === latest && r.d2.amountsCents.EndFundsAvail !== null ? r.d2.amountsCents.EndFundsAvail / 100 : null,
          debtsOwed: r === latest && r.d2.amountsCents.TotalDebts !== null ? r.d2.amountsCents.TotalDebts / 100 : null, sourceUrl: BULK_URL }));
      } else data.diagnostics.push("All current Quarterly Raised values are required; summary omitted");
      const cash = directCoverage ? cashByCommittee.get(committee) : undefined;
      if (cash) {
        const selected = cash.filter((r) => day(r.receivedDate)! >= low && day(r.receivedDate)! <= high);
        const donors = new Map<string, IllinoisFinancePacDonorInput>();
        for (const receipt of selected) {
          const match = donorMatch({ donorName: receipt.contributorName ?? "", recipientCommitteeIds: [committee] });
          if (match.status !== "matched") continue;
          const donor = donors.get(match.committeeId) ?? { committeeId: match.committeeId, committeeName: match.legalName, committeeType: match.committeeType, totalAmount: 0, contributionCount: 0, sourceUrl: receipt.sourceUrl };
          donor.totalAmount = (cents(donor.totalAmount) + cents(receipt.amount)) / 100;
          if (receipt.amount > 0) donor.contributionCount++; donors.set(match.committeeId, donor);
        }
        const values = [...donors.values()];
        if (values.some((d) => d.totalAmount < 0 || (d.totalAmount > 0 && !d.contributionCount))) data.diagnostics.push("Negative or invalid committee donor net; cash component omitted");
        else {
          const positive = values.filter((d) => d.totalAmount > 0);
          const raised = data.d2ReportSummaries?.reduce((s, r) => s + cents(r.totalReceipts!), 0);
          if (raised !== undefined && positive.reduce((s, d) => s + cents(d.totalAmount), 0) > raised) data.diagnostics.push("PAC cash exceeds verified Raised");
          else { data.pacDonors = positive; data.directContributionRecords = selected; data.directContributionSourceUrl = ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL; }
        }
      } else data.diagnostics.push("Verified complete cash CSV is unavailable");
      if (outsideDiagnostics.has("*")) data.diagnostics.push(...outsideDiagnostics.get("*")!);
      const inCycle = finalIE.filter((r) => r.amount > 0 && day(r.expendedDate)! >= low && day(r.expendedDate)! <= high)
        .map((row) => ({ row, status: resolveTarget(row.candidateName ?? "", row.officeDistrict ?? "").status }));
      const outside = inCycle.filter((e) => e.status === "matched" && e.row.supportOppose !== null).map((e) => e.row);
      // A row about this candidate with a blank stance, or one whose target is ambiguous, cannot be classified;
      // replacing the stored groups without it would understate the headline, so the stored money stays.
      const unresolved = inCycle.some((e) => e.status === "ambiguous" || (e.status === "matched" && e.row.supportOppose === null));
      if (unresolved) data.diagnostics.push("Unresolved candidate-targeted Quarterly outside rows; outside replacement omitted");
      else if (!outside.length) data.diagnostics.push("No verified positive Quarterly outside records; outside replacement omitted");
      if (outside.length && !unresolved && !outsideDiagnostics.has("*")) {
        data.outsideExpenditureRecords = outside; data.outsideReportEvidence = finalReports;
        data.outsideExpenditureSourceUrl = ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL;
      }
      return data;
    },
  };
}

export function loadIllinoisFinanceDataForDueRowFromVerifiedQuarterly(input: {
  row: IllinoisCandidateFinanceDueRow; artifacts: IllinoisSbeVerifiedQuarterlyDataSet;
}): IllinoisSbeVerifiedQuarterlyCandidateData { return input.artifacts.loadCandidateData(input.row); }

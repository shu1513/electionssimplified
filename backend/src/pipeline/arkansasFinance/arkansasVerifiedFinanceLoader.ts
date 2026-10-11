import type { ArkansasFinanceLinkInput } from "./arkansasFinanceWriter.js";
import { arkansasCfisOfficeNameForOffice } from "./arkansasFinanceEligibleOffices.js";
import { arkansasDistrictNumberFromDistrictName, arkansasRegistrationDistrictNumber } from "./arkansasCandidateFilerResolver.js";
import {
  createArkansasVerifiedSourceClient, fingerprintArkansasVerifiedRawRows,
  type ArkansasVerifiedCollection, type ArkansasVerifiedRegistryRow,
  type ArkansasVerifiedCurrentReportRow, type ArkansasVerifiedRawResponse,
  type ArkansasVerifiedSourceClientOptions,
} from "./arkansasVerifiedSourceClient.js";
import {
  verifyArkansasCurrentOriginalCashSource, verifyArkansasCurrentOriginalIeSource,
  type ArkansasFinancialSourceIdentity, type ArkansasVerifiedCurrentCashProof,
  type ArkansasVerifiedCurrentIeProof, type ArkansasFinancialPdfSource,
  type ArkansasCurrentOriginalFinancialInput,
} from "./arkansasCurrentOriginalFinancialSource.js";
import { extractArkansasFinancialPdf, parseArkansasFinancialReportPdf, arkansasFinancialDate } from "./arkansasFinancialReportPdfParser.js";
import { aggregateArkansasVerifiedPacDonors } from "./arkansasVerifiedPacDonorAggregator.js";
import type { ArkansasFinancePacDonor, ArkansasPacSourceProvenance } from "./arkansasPacSourceEvidence.js";

export type ArkansasVerifiedAcquisitionPhase = "registry_before" | "registry_after" | "reports_before" | "native_before" | "detail" | "pdf" | "native_after" | "reports_after";
export type ArkansasVerifiedAcquisitionCapture = {
  component: "pac" | "outside" | "identity";
  phase: ArkansasVerifiedAcquisitionPhase;
  electionYear: number;
  registrationGuid?: string;
  entityId?: string;
  raw: ArkansasVerifiedRawResponse;
};
export type ArkansasVerifiedFinanceLoaderOptions = {
  clientOptions?: Omit<ArkansasVerifiedSourceClientOptions, "onRawResponse">;
  onRawResponse?: (capture: ArkansasVerifiedAcquisitionCapture) => void | Promise<void>;
  /** Fresh budget per public operation, checked before issuing a request. */
  maxTotalRequests?: number;
  maxPayers?: number;
  maxReportsPerRegistration?: number;
};
export type ArkansasVerifiedCandidateFinanceInput = {
  link: ArkansasFinanceLinkInput;
  officeScope: string;
  priorPacSourceProvenance?: unknown;
};
export type ArkansasVerifiedCandidateFinanceData = {
  cashProof?: ArkansasVerifiedCurrentCashProof;
  pacDonors?: readonly ArkansasFinancePacDonor[];
  pacSourceProvenance?: ArkansasPacSourceProvenance;
  registryBefore?: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  registryAfter?: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  diagnostics: readonly string[];
};
export type ArkansasVerifiedIndependentSpendingData = {
  ieProofs?: readonly ArkansasVerifiedCurrentIeProof[];
  registryBefore?: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  registryAfter?: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  scope: "current_original_ief_reports";
  attemptedRegistrationGuids: readonly string[];
  unverifiedRegistrationGuids: readonly string[];
  diagnostics: readonly string[];
};
export type ArkansasVerifiedCandidateIdentityData = {
  identity?: ArkansasFinancialSourceIdentity;
  registryBefore?: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  registryAfter?: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  reportsBefore?: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>;
  reportsAfter?: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>;
  pdf?: ArkansasFinancialPdfSource;
  diagnostics: readonly string[];
};

function reject(message: string): never { throw new Error("Arkansas verified acquisition: " + message); }
function electionYear(value: number): number {
  if (!Number.isSafeInteger(value) || value < 2026 || value > 2100) reject("unsupported election year");
  return value;
}
function normalized(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/** Full source comma-order formatting only: keep every middle/suffix token. */
function fullPersonName(value: string): string {
  const parts = value.split(",");
  if (parts.length === 2 && parts.every(p => p.trim()) && !/^(?:JR|SR|II|III|IV)\.?$/i.test(parts[1]!.trim())) {
    return normalized(parts[1]! + " " + parts[0]!);
  }
  return normalized(value);
}
function district(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  const result = arkansasRegistrationDistrictNumber(value) ?? arkansasDistrictNumberFromDistrictName(value);
  if (result === null) reject("unresolved district");
  return result;
}
function identity(row: ArkansasVerifiedRegistryRow, year: number): ArkansasFinancialSourceIdentity {
  const sourceName = row.filerTypeCode === "CAN" ? row.filerName : row.committeeName || row.filerName;
  if (!sourceName?.trim()) reject("missing source owner name");
  return { entityId: String(row.filerEntityId), registrationGuid: row.registrationGuid, sourceName,
    electionYear: year, officeName: row.office, district: row.officeDistrictName };
}
function candidateRegistration(
  rows: readonly ArkansasVerifiedRegistryRow[],
  input: { entityId: number; year: number; office: string; district: string | null }
): ArkansasVerifiedRegistryRow {
  const matches = rows.filter(row => row.filerEntityId === input.entityId && row.filerTypeCode === "CAN" &&
    row.electionYear === input.year && row.office === input.office &&
    arkansasRegistrationDistrictNumber(row.officeDistrictName) === input.district);
  if (matches.length !== 1) reject("missing/ambiguous exact candidate registration/year/office/district");
  const row = matches[0]!;
  if (row.filerType !== "Candidate" || row.isPaperFiler !== false) reject("unknown/paper or contradictory candidate source class");
  return row;
}
function unchangedRegistration(
  row: ArkansasVerifiedRegistryRow, after: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>
): void {
  const matches = after.rows.filter(r => r.registrationGuid === row.registrationGuid);
  if (matches.length !== 1 || fingerprintArkansasVerifiedRawRows([row]) !== fingerprintArkansasVerifiedRawRows(matches)) {
    reject("receiver/payer registration changed inside source bracket");
  }
}
function applicableReports(
  reports: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>, start: string, end: string, cap: number
): ArkansasVerifiedCurrentReportRow[] {
  if (reports.rows.length > cap) reject("registration report bound exceeded");
  return reports.rows.filter(report => {
    if (!report.startDate || !report.endDate) reject("unknown current report period");
    return arkansasFinancialDate(report.endDate) >= start && arkansasFinancialDate(report.startDate) <= end;
  });
}
function originalReports(rows: readonly ArkansasVerifiedCurrentReportRow[]): void {
  if (!rows.length) reject("no applicable current original reports");
  for (const r of rows) {
    if (r.filerReportVersionId !== 1 || r.reportStatus !== "Original" || r.reportVersion !== "Original" ||
      r.hasChild !== false || r.isPaperFile !== false || !r.filePath || !r.filedDate) reject("unsupported amended/paper/current report " + r.filerReportGuid);
  }
}

export function createArkansasVerifiedFinanceLoader(options: ArkansasVerifiedFinanceLoaderOptions = {}) {
  const caps = {
    requests: options.maxTotalRequests ?? 2000,
    payers: options.maxPayers ?? 64,
    reports: options.maxReportsPerRegistration ?? 128,
  };
  for (const [name, value] of Object.entries(caps)) if (!Number.isSafeInteger(value) || value < 1) reject("invalid " + name + " bound");

  function operation(component: ArkansasVerifiedAcquisitionCapture["component"], year: number) {
    let requests = 0;
    let phase: ArkansasVerifiedAcquisitionPhase = "registry_before";
    let sourceIdentity: ArkansasFinancialSourceIdentity | undefined;
    const baseFetch = options.clientOptions?.fetchImpl ?? fetch;
    const client = createArkansasVerifiedSourceClient({
      ...options.clientOptions,
      fetchImpl: ((url, init) => {
        if (++requests > caps.requests) reject("total operation request bound exceeded");
        return baseFetch(url, init);
      }) as typeof fetch,
      onRawResponse: raw => options.onRawResponse?.({
        component, phase, electionYear: year, registrationGuid: sourceIdentity?.registrationGuid,
        entityId: sourceIdentity?.entityId, raw,
      }),
    });
    async function stage<T>(name: ArkansasVerifiedAcquisitionPhase, fn: () => Promise<T>): Promise<T> {
      phase = name;
      return fn();
    }
    function context(value: ArkansasFinancialSourceIdentity | undefined) { sourceIdentity = value; }
    async function pdf(report: ArkansasVerifiedCurrentReportRow): Promise<ArkansasFinancialPdfSource> {
      const source = await stage("pdf", () => client.fetchStoredReport({
        filerReportGuid: report.filerReportGuid, fileName: report.reportName + " V" + report.filerReportVersionId,
      }));
      const parsed = parseArkansasFinancialReportPdf(await extractArkansasFinancialPdf(source.bytesRaw));
      if (parsed.sha256 !== source.sha256 || parsed.byteCount !== source.request.bytes) reject("parsed PDF/raw source mismatch");
      return { reportGuid: report.filerReportGuid, parsed, request: source.request };
    }
    async function financial(source: ArkansasFinancialSourceIdentity, type: "TCON" | "TEXP"): Promise<ArkansasCurrentOriginalFinancialInput> {
      context(source);
      const windowStart = (year - 1) + "-01-01", windowEnd = year + "-12-31";
      const reportsBefore = await stage("reports_before", () => client.fetchCurrentReports({ registrationGuid: source.registrationGuid }));
      const nativeBefore = await stage("native_before", () => client.fetchTransactions({ registrationGuid: source.registrationGuid, transactionTypeCode: type }));
      const reports = applicableReports(reportsBefore, windowStart, windowEnd, caps.reports);
      originalReports(reports);
      const pdfs: ArkansasFinancialPdfSource[] = [];
      for (const report of reports) pdfs.push(await pdf(report));
      const details: ArkansasCurrentOriginalFinancialInput["details"][number][] = [];
      for (const row of nativeBefore.rows) {
        const date = arkansasFinancialDate(row.transactionDate);
        if (date < windowStart || date > windowEnd) continue;
        if (type === "TEXP" || (row.transactionSource === "Political Action Committee" && row.transactionSubTypeDescription === "Itemized Monetary")) {
          details.push(await stage("detail", () => client.fetchTransactionDetail({ transactionGuid: row.guid })));
        }
      }
      const nativeAfter = await stage("native_after", () => client.fetchTransactions({ registrationGuid: source.registrationGuid, transactionTypeCode: type }));
      const reportsAfter = await stage("reports_after", () => client.fetchCurrentReports({ registrationGuid: source.registrationGuid }));
      return { identity: source, windowStart, windowEnd, reportsBefore, reportsAfter, nativeBefore, nativeAfter, details, pdfs };
    }
    return { client, stage, context, pdf, financial };
  }
  function diagnostic(error: unknown): string { return error instanceof Error ? error.message : String(error); }

  return {
    async loadCandidate(input: ArkansasVerifiedCandidateFinanceInput): Promise<ArkansasVerifiedCandidateFinanceData> {
      let registryBefore: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow> | undefined;
      let registryAfter: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow> | undefined;
      try {
        const year = electionYear(input.link.electionYear), op = operation("pac", year);
        registryBefore = await op.stage("registry_before", () => op.client.fetchRegistry());
        const office = arkansasCfisOfficeNameForOffice({ officeScope: input.officeScope, officeCanonicalName: input.link.officeName });
        if (office === null) reject("unsupported canonical office");
        const receiver = candidateRegistration(registryBefore.rows, {
          entityId: input.link.filingEntityId, year, office, district: district(input.link.district),
        });
        if (!receiver.filerName || fullPersonName(receiver.filerName) !== fullPersonName(input.link.filerName) ||
            fullPersonName(receiver.filerName) !== fullPersonName(input.link.candidateNameNormalized)) {
          reject("linked local full candidate/owner name disagrees with source");
        }
        const source = await op.financial(identity(receiver, year), "TCON");
        op.context(undefined);
        registryAfter = await op.stage("registry_after", () => op.client.fetchRegistry());
        unchangedRegistration(receiver, registryAfter);
        const verified = verifyArkansasCurrentOriginalCashSource(source);
        if (!verified.proof) return { registryBefore, registryAfter, diagnostics: verified.diagnostics };
        const pac = aggregateArkansasVerifiedPacDonors({
          link: input.link, financialEvidence: verified.proof, registryBefore, registryAfter,
          priorPacSourceProvenance: input.priorPacSourceProvenance,
        });
        return { cashProof: verified.proof, pacDonors: pac.pacDonors, pacSourceProvenance: pac.pacSourceProvenance,
          registryBefore, registryAfter, diagnostics: [...verified.diagnostics, ...pac.diagnostics] };
      } catch (error) {
        return { registryBefore, registryAfter, diagnostics: ["PAC source preserved: " + diagnostic(error)] };
      }
    },

    async loadIndependentSpending(input: { electionYear: number }): Promise<ArkansasVerifiedIndependentSpendingData> {
      const result: ArkansasVerifiedIndependentSpendingData = {
        scope: "current_original_ief_reports", attemptedRegistrationGuids: [], unverifiedRegistrationGuids: [], diagnostics: [],
      };
      const attempted: string[] = [], unverified: string[] = [], diagnostics: string[] = [];
      try {
        const year = electionYear(input.electionYear), op = operation("outside", year);
        const registryBefore = await op.stage("registry_before", () => op.client.fetchRegistry());
        result.registryBefore = registryBefore;
        const allIef = registryBefore.rows.filter(r => r.filerTypeCode === "IEF");
        const payers = allIef.filter(r => r.filingYear === year - 1 || r.filingYear === year);
        for (const row of allIef) if (row.filingYear === null) {
          unverified.push(row.registrationGuid);
          diagnostics.push("IEF unknown filing-year discovery scope " + row.registrationGuid);
        }
        if (payers.length > caps.payers) reject("full scoped IEF payer bound exceeded; no truncated harvest");
        const accepted: { row: ArkansasVerifiedRegistryRow; proof: ArkansasVerifiedCurrentIeProof }[] = [];
        for (const payer of payers) {
          attempted.push(payer.registrationGuid);
          try {
            // Registry null remains unknown; explicit electronic status is required for every current report below.
            if (payer.isPaperFiler === true) reject("paper IEF registration");
            const source = await op.financial(identity(payer, year), "TEXP");
            const verified = verifyArkansasCurrentOriginalIeSource(source);
            diagnostics.push(...verified.diagnostics.map(d => payer.registrationGuid + ": " + d));
            if (verified.proof) accepted.push({ row: payer, proof: verified.proof });
            else unverified.push(payer.registrationGuid);
          } catch (error) {
            unverified.push(payer.registrationGuid);
            diagnostics.push(payer.registrationGuid + ": IE source preserved: " + diagnostic(error));
          }
        }
        op.context(undefined);
        const registryAfter = await op.stage("registry_after", () => op.client.fetchRegistry());
        result.registryAfter = registryAfter;
        if (registryBefore.fingerprint !== registryAfter.fingerprint) reject("full IEF/target registry changed inside outside acquisition");
        for (const candidate of accepted) unchangedRegistration(candidate.row, registryAfter);
        // Empty accepted set is unknown outside, never a financial-zero publication.
        if (accepted.length) result.ieProofs = accepted.map(candidate => candidate.proof);
      } catch (error) {
        diagnostics.push("Outside source preserved: " + diagnostic(error));
        result.ieProofs = undefined;
      }
      return { ...result, attemptedRegistrationGuids: attempted, unverifiedRegistrationGuids: unverified, diagnostics };
    },

    async loadCandidateIdentity(input: {
      entityId: number; electionYear: number; officeName: string; district: string | null; reportGuid: string;
    }): Promise<ArkansasVerifiedCandidateIdentityData> {
      let registryBefore: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow> | undefined;
      let registryAfter: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow> | undefined;
      let reportsBefore: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow> | undefined;
      let reportsAfter: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow> | undefined;
      try {
        const year = electionYear(input.electionYear), op = operation("identity", year);
        registryBefore = await op.stage("registry_before", () => op.client.fetchRegistry());
        const row = candidateRegistration(registryBefore.rows, {
          entityId: input.entityId, year, office: input.officeName, district: district(input.district),
        });
        const source = identity(row, year);
        op.context(source);
        reportsBefore = await op.stage("reports_before", () => op.client.fetchCurrentReports({ registrationGuid: row.registrationGuid }));
        if (reportsBefore.rows.length > caps.reports) reject("identity report bound exceeded");
        const matches = reportsBefore.rows.filter(r => r.filerReportGuid === input.reportGuid);
        if (matches.length !== 1) reject("requested identity report not uniquely current");
        const report = matches[0]!;
        if (report.isPaperFile !== false || !report.filePath || !report.filedDate) reject("unsupported identity paper/metadata");
        const pdf = await op.pdf(report);
        reportsAfter = await op.stage("reports_after", () => op.client.fetchCurrentReports({ registrationGuid: row.registrationGuid }));
        op.context(undefined);
        registryAfter = await op.stage("registry_after", () => op.client.fetchRegistry());
        if (registryBefore.fingerprint !== registryAfter.fingerprint || reportsBefore.fingerprint !== reportsAfter.fingerprint) reject("identity registry/current report changed");
        unchangedRegistration(row, registryAfter);
        const parsed = pdf.parsed;
        // Expanded identity-only owner names remain raw; root's finite target authority owns any alias.
        if (parsed.kind !== "candidate" || parsed.electionYear !== year || parsed.officeName !== input.officeName ||
            district(parsed.district) !== district(input.district) || parsed.filerId !== null && parsed.filerId !== String(input.entityId) ||
            parsed.periodStart !== arkansasFinancialDate(report.startDate ?? "") || parsed.periodEnd !== arkansasFinancialDate(report.endDate ?? "") ||
            parsed.filedAt !== report.filedDate.slice(0, 19)) reject("identity cover does not match exact current source context");
        return { identity: source, registryBefore, registryAfter, reportsBefore, reportsAfter, pdf, diagnostics: [] };
      } catch (error) {
        return { registryBefore, registryAfter, reportsBefore, reportsAfter, diagnostics: ["Identity source preserved: " + diagnostic(error)] };
      }
    },
  };
}
export type ArkansasVerifiedFinanceLoader = ReturnType<typeof createArkansasVerifiedFinanceLoader>;

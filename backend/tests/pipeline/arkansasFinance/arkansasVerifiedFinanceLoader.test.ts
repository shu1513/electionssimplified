import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArkansasVerifiedFinanceLoader, type ArkansasVerifiedAcquisitionCapture } from "../../../src/pipeline/arkansasFinance/arkansasVerifiedFinanceLoader.js";
import type { ArkansasFinanceLinkInput } from "../../../src/pipeline/arkansasFinance/arkansasFinanceWriter.js";
import type { ArkansasCurrentOriginalFinancialInput } from "../../../src/pipeline/arkansasFinance/arkansasCurrentOriginalFinancialSource.js";
import type { ArkansasParsedFinancialReport } from "../../../src/pipeline/arkansasFinance/arkansasFinancialReportPdfParser.js";

const mocks = vi.hoisted(() => ({ cash: vi.fn(), ie: vi.fn(), pac: vi.fn(), extract: vi.fn(), parse: vi.fn() }));
vi.mock("../../../src/pipeline/arkansasFinance/arkansasCurrentOriginalFinancialSource.js", () => ({
  verifyArkansasCurrentOriginalCashSource: mocks.cash, verifyArkansasCurrentOriginalIeSource: mocks.ie,
}));
vi.mock("../../../src/pipeline/arkansasFinance/arkansasVerifiedPacDonorAggregator.js", () => ({ aggregateArkansasVerifiedPacDonors: mocks.pac }));
vi.mock("../../../src/pipeline/arkansasFinance/arkansasFinancialReportPdfParser.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/pipeline/arkansasFinance/arkansasFinancialReportPdfParser.js")>(),
  extractArkansasFinancialPdf: mocks.extract, parseArkansasFinancialReportPdf: mocks.parse,
}));
const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAN = 7243, IEF = 1085;
const link: ArkansasFinanceLinkInput = {
  candidateId: guid(900001), electionId: guid(900002), electionYear: 2026,
  candidateNameNormalized: "ALAN CLARK", officeName: "State Senator", district: "State Senate District 7; Arkansas",
  filingEntityId: CAN, filerName: "Alan Clark", linkSource: "manual",
};
type Raw = Record<string, unknown>;
function registry(id: number, type = "CAN", overrides: Raw = {}): Raw {
  return { filerName: type === "CAN" ? "Clark, Alan" : "Example " + id,
    office: type === "CAN" ? "State Senate" : null, officeDistrictName: type === "CAN" ? "7" : null,
    filerEntityVersionID: 1, filerEntityID: id, filerType: type === "CAN" ? "Candidate" : type === "IEF" ? "Independent Expenditure Filer (Committee)" : "Political Action Committee",
    politicalParty: null, filerStatus: "Active", totalRaised: 500, totalSpent: 0, balanceofFunds: 500,
    electionYear: type === "CAN" ? "2026" : "", guid: guid(id), filerTypeCode: type, filerTypeDesc: type,
    filingYear: "2026", committeeName: type === "CAN" ? null : "Example " + id,
    firstName: type === "CAN" ? "Alan" : null, lastName: type === "CAN" ? "Clark" : null, suffix: null,
    balanceofFundsNew: "500", totalRaisedNew: "500", totalSpentNew: "0", filingTypeCode: type,
    isPaperFiler: false, jurisdictionName: type === "CAN" ? "Arkansas" : null, totalRows: 1, ...overrides };
}
function report(id: number, overrides: Raw = {}): Raw {
  return { reportName: "2026 April Monthly Report", dueDate: "2026-05-20T00:00:00",
    startDate: "2026-03-04T00:00:00", endDate: "2026-04-30T00:00:00", filedDate: "2026-05-19T10:50:12",
    filerFilingCalendarGuid: guid(id * 10 + 1), reportStatus: "Original", reportVersion: "Original",
    reportType: "Scheduled Financial Report", filerReportGuid: guid(id * 10), isPaperFile: false,
    electionTypeCode: id === CAN ? "GRNELEC" : "NOELEC", reportElectionType: null,
    filePath: "Reports\\00000000-0000-4000-8000-000000000099.pdf", hasChild: false,
    filerReportVersionID: 1, totalRows: 1, ...overrides };
}
function native(id: number, overrides: Raw = {}): Raw {
  return { guid: guid(id * 100), filerName: id === CAN ? "Clark, Alan" : "Example " + id,
    transactionAmount: 500, transactionDate: "04/22/2026", sourceName: "Example 700",
    employerName: null, occupation: null, sourceAddress: "Exact published address",
    transactionSource: id === CAN ? "Political Action Committee" : "Business",
    reportName: "2026 April Monthly Report", transactionSubTypeDesc: "Itemized Monetary", hasChild: false,
    filerRegistrationGuid: guid(id), transactionCategory: null, totalRows: 1, ...overrides };
}
function detail(id: number, overrides: Raw = {}): Raw {
  return { transactionID: id * 100, transactionVersionID: 1, guid: guid(id * 100),
    transactionSubTypeCode: "ITMY", electionTypeCode: id === CAN ? "GRNELEC" : "PRMELEC",
    transactionDate: "2026-04-22T00:00:00", transactionSourceTypeCode: id === CAN ? "TPAC" : "TBSN",
    contributor: "Example 700", valueOfNonMoneyItem: 500, transactionSubTypeDesc: "Itemized Monetary",
    electionTypeDesc: "General", transactionSourceTypeDesc: "Political Action Committee", comments: null,
    transactionTypeCode: id === CAN ? "TCON" : "TEXP", transactionSource: "Political Action Committee",
    transactionTypeDescription: "Contribution", otherCategory: null, transactionCategoryDesc: null,
    filerName: id === CAN ? "Clark, Alan" : "Example " + id, electionYear: "2025", ...overrides };
}
function page(rows: Raw[]): Response {
  return json({ data: { items: rows.map(row => ({ ...row, totalRows: rows.length })), totalItems: rows.length, pageNumber: 0, pageSize: 0 }, succeeded: true, error: null });
}
function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
function proof(input: ArkansasCurrentOriginalFinancialInput) {
  return { version: 1, receiver: input.identity, windowStart: input.windowStart, windowEnd: input.windowEnd,
    monetaryCashCents: 50000, reports: [], cashRows: [], sourceFingerprints: {
      reportsBefore: input.reportsBefore.fingerprint, reportsAfter: input.reportsAfter.fingerprint,
      nativeBefore: input.nativeBefore.fingerprint, nativeAfter: input.nativeAfter.fingerprint,
    }, rawResponseHashes: [] };
}
type ServerOptions = {
  registryRows?: Raw[]; registryAfter?: Raw[]; reports?: (id: number, call: number) => Raw[];
  nativeRows?: (id: number, call: number) => Raw[]; failClosingRegistry?: boolean;
  failDetail?: boolean; detailOverride?: Raw;
};
function server(options: ServerOptions = {}) {
  const log: { endpoint: string; body: Raw }[] = [];
  const counts = new Map<string, number>();
  const rows = options.registryRows ?? [registry(CAN), registry(700, "PAC"), registry(IEF, "IEF")];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const endpoint = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)) as Raw;
    log.push({ endpoint, body });
    const countKey = endpoint + "|" + String(body.filerRegistrationGuid ?? body.transactionGuid ?? "");
    const call = (counts.get(countKey) ?? 0) + 1; counts.set(countKey, call);
    if (endpoint === "GetCandidateCommitteDetails") {
      if (call === 2 && options.failClosingRegistry) return new Response("failed", { status: 503 });
      return page(call === 2 && options.registryAfter ? options.registryAfter : rows);
    }
    const id = Number(String(body.filerRegistrationGuid ?? "").slice(-12));
    if (endpoint === "GetPublicFilerProfileFiling") return page(options.reports?.(id, call) ?? [report(id)]);
    if (endpoint === "GetTransactionDetails") return page(options.nativeRows?.(id, call) ?? [native(id)]);
    if (endpoint === "GetTransactionDetailsByGuid") {
      if (options.failDetail) return new Response("failed", { status: 503 });
      return json({ data: detail(Number(String(body.transactionGuid).slice(-12)) / 100, options.detailOverride), succeeded: true, error: null });
    }
    if (endpoint === "DownloadDocument") {
      return new Response("%PDF-1.7\nSynthetic source-order test only\n%%EOF\n", { headers: { "content-type": "application/pdf" } });
    }
    throw new Error("unexpected request");
  }) as unknown as typeof fetch;
  return { fetchImpl, log };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cash.mockImplementation((input: ArkansasCurrentOriginalFinancialInput) => ({ proof: proof(input), diagnostics: [] }));
  mocks.ie.mockImplementation((input: ArkansasCurrentOriginalFinancialInput) => ({ proof: { ...proof(input), payer: input.identity, expenditureCents: 50000, expenseRows: [], coverElectionConflicts: [] }, diagnostics: [] }));
  mocks.pac.mockImplementation(() => ({ pacDonors: [{ committeeId: "700", committeeName: "Example 700", committeeType: "Political Action Committee", amount: 500, contributionCount: 1, sourceUrl: "public source" }], diagnostics: [] }));
  mocks.extract.mockImplementation(async (bytes: Uint8Array) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), byteCount: bytes.length, pages: [] }));
  mocks.parse.mockImplementation((extraction: { sha256: string; byteCount: number }) => ({
    ...extraction, kind: "candidate", ownerName: "Alan Clark", filerId: String(CAN),
    officeName: "State Senate", district: "7", reportLabel: "2026 April Monthly Report - General",
    periodStart: "2026-03-04", periodEnd: "2026-04-30", filedAt: "2026-05-19T10:50:12",
    electionTypeRaw: "General", electionYear: 2026, electionDateRaw: null, currentCashCents: 50000,
    currentLoanCents: 0, currentExpenseCents: 0, noActivity: "unchecked", amendment: "unchecked",
    returnedCashCents: 0, cashRows: [], nonmoneyRows: [], expenseRows: [], sectionTotals: {}, sections: [],
  } satisfies ArkansasParsedFinancialReport));
});

describe("Arkansas verified finance loader acquisition", () => {
  it("acquires complete actual openings/PDF/detail/closings then forwards independent PAC proof", async () => {
    const source = server(), captures: ArkansasVerifiedAcquisitionCapture[] = [];
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl },
      onRawResponse: capture => { captures.push(capture); } }).loadCandidate({ link, officeScope: "state_upper" });
    expect(result.cashProof?.monetaryCashCents).toBe(50000);
    expect(result.pacDonors?.[0]?.amount).toBe(500);
    expect(source.log.map(r => r.endpoint)).toEqual([
      "GetCandidateCommitteDetails", "GetPublicFilerProfileFiling", "GetTransactionDetails",
      "DownloadDocument", "GetTransactionDetailsByGuid", "GetTransactionDetails", "GetPublicFilerProfileFiling", "GetCandidateCommitteDetails",
    ]);
    expect(captures.map(r => r.phase)).toEqual(["registry_before", "reports_before", "native_before", "pdf", "detail", "native_after", "reports_after", "registry_after"]);
    expect(captures[3]).toMatchObject({ component: "pac", entityId: String(CAN), registrationGuid: guid(CAN), electionYear: 2026 });
    expect(captures[0]!.raw).not.toHaveProperty("headers");
    const financial = mocks.cash.mock.calls[0]![0] as ArkansasCurrentOriginalFinancialInput;
    expect(financial.identity.sourceName).toBe("Clark, Alan");
    expect(financial.details[0]!.row.electionYear).toBe(2025);
    expect(financial.nativeBefore.rows).toHaveLength(1);
    expect(mocks.pac.mock.calls[0]![0]).toMatchObject({ link, registryBefore: result.registryBefore, registryAfter: result.registryAfter });
  });

  it("preserves PAC but retains valid cash evidence when donor/prior authority independently rejects", async () => {
    mocks.pac.mockReturnValue({ diagnostics: ["PAC preserved: prior report missing"] });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: server().fetchImpl } })
      .loadCandidate({ link, officeScope: "state_upper", priorPacSourceProvenance: { retained: true } });
    expect(result.cashProof).toBeDefined(); expect(result.pacDonors).toBeUndefined();
    expect(mocks.pac.mock.calls[0]![0].priorPacSourceProvenance).toEqual({ retained: true });
    expect(result.diagnostics).toContain("PAC preserved: prior report missing");
  });
  it("preserves source failures rather than returning a financial empty", async () => {
    for (const source of [server({ failDetail: true }), server({ failClosingRegistry: true })]) {
      const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } })
        .loadCandidate({ link, officeScope: "state_upper" });
      expect(result.cashProof).toBeUndefined(); expect(result.pacDonors).toBeUndefined();
      expect(result.diagnostics.join(" ")).toMatch(/preserved/);
    }
  });
  it("preserves an amended current candidate without scanning an old Original instead", async () => {
    const source = server({ reports: id => [report(id, { reportVersion: "Amended", reportStatus: "Amended", filerReportVersionID: 2, hasChild: true })] });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } }).loadCandidate({ link, officeScope: "state_upper" });
    expect(result.pacDonors).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/unsupported amended/);
    expect(source.log.some(r => r.endpoint === "DownloadDocument")).toBe(false);
    expect(mocks.cash).not.toHaveBeenCalled();
  });
  it.each([
    ["wrong full local person", { ...link, candidateNameNormalized: "ALAN T CLARK" }, [registry(CAN)], "state_upper"],
    ["wrong linked name", { ...link, filerName: "John Clark" }, [registry(CAN)], "state_upper"],
    ["wrong office", link, [registry(CAN, "CAN", { office: "State Representative" })], "state_upper"],
    ["wrong district", link, [registry(CAN, "CAN", { officeDistrictName: "8" })], "state_upper"],
    ["yearless", link, [registry(CAN, "CAN", { electionYear: "" })], "state_upper"],
    ["ambiguous registrations", link, [registry(CAN), registry(CAN, "CAN", { guid: guid(555) })], "state_upper"],
    ["unknown paper", link, [registry(CAN, "CAN", { isPaperFiler: null })], "state_upper"],
    ["unsupported local office", link, [registry(CAN)], "county"],
  ] as const)("preserves exact receiver context failure: %s", async (_label, candidateLink, registryRows, scope) => {
    const source = server({ registryRows: [...registryRows] });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } }).loadCandidate({ link: candidateLink, officeScope: scope });
    expect(result.cashProof).toBeUndefined(); expect(result.pacDonors).toBeUndefined();
    expect(source.log).toHaveLength(1);
  });
  it("rejects changed receiver registry despite same native totals", async () => {
    const before = [registry(CAN), registry(700, "PAC")], after = [registry(CAN, "CAN", { filerName: "Clark, John" }), registry(700, "PAC")];
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: server({ registryRows: before, registryAfter: after }).fetchImpl } })
      .loadCandidate({ link, officeScope: "state_upper" });
    expect(result.cashProof).toBeUndefined(); expect(result.diagnostics.join(" ")).toMatch(/registration changed/);
    expect(mocks.cash).not.toHaveBeenCalled();
  });
  it("passes full native ledger to verifier, fetching details only for eligible itemized source PAC rows", async () => {
    const cash = native(CAN), other = native(CAN, { guid: guid(9999), transactionSource: "Individual", sourceName: "Other Full Name", transactionSubTypeDesc: "Itemized Nonmoney", transactionAmount: 10 });
    const source = server({ nativeRows: () => [cash, other] });
    await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } }).loadCandidate({ link, officeScope: "state_upper" });
    expect((mocks.cash.mock.calls[0]![0] as ArkansasCurrentOriginalFinancialInput).nativeBefore.rows).toHaveLength(2);
    expect(source.log.filter(r => r.endpoint === "GetTransactionDetailsByGuid")).toHaveLength(1);
  });
  it("omits cash/PAC when the whole financial verifier rejects names/returns even with equal totals", async () => {
    mocks.cash.mockReturnValue({ diagnostics: ["unknown returned source"] });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: server().fetchImpl } }).loadCandidate({ link, officeScope: "state_upper" });
    expect(result.cashProof).toBeUndefined(); expect(result.pacDonors).toBeUndefined();
    expect(result.diagnostics).toEqual(["unknown returned source"]); expect(mocks.pac).not.toHaveBeenCalled();
  });
  it("enforces per-operation cap before source request and resets it across independent candidate calls", async () => {
    const source = server(), loader = createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl }, maxTotalRequests: 8 });
    await expect(loader.loadCandidate({ link, officeScope: "state_upper" })).resolves.toHaveProperty("cashProof");
    await expect(loader.loadCandidate({ link, officeScope: "state_upper" })).resolves.toHaveProperty("cashProof");
    expect(source.log).toHaveLength(16);
    const limited = server();
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: limited.fetchImpl }, maxTotalRequests: 7 }).loadCandidate({ link, officeScope: "state_upper" });
    expect(result.cashProof).toBeUndefined(); expect(limited.log).toHaveLength(7);
    expect(result.diagnostics.join(" ")).toMatch(/request bound/);
  });
  it("fails whole source operation on report bound rather than truncating source", async () => {
    const source = server({ reports: id => [report(id), report(id + 1)] });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl }, maxReportsPerRegistration: 1 }).loadCandidate({ link, officeScope: "state_upper" });
    expect(result.pacDonors).toBeUndefined(); expect(result.diagnostics.join(" ")).toMatch(/report bound/);
  });

  it("discovers IEFs by explicit annual filingYear, retains annual GUIDs and blank electionYear", async () => {
    const rows = [registry(CAN), registry(IEF, "IEF"), registry(IEF, "IEF", { guid: guid(IEF + 1), filingYear: "2025", filerEntityID: IEF + 1 }),
      registry(222, "IEF", { filingYear: "2024" })];
    const source = server({ registryRows: rows });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } }).loadIndependentSpending({ electionYear: 2026 });
    expect(result.attemptedRegistrationGuids).toEqual([guid(IEF), guid(IEF + 1)]);
    expect(result.ieProofs).toHaveLength(2); expect(result).not.toHaveProperty("complete");
    expect(result.registryBefore?.rows.filter(r => r.filerTypeCode === "IEF").every(r => r.electionYear === null)).toBe(true);
    expect(source.log.filter(r => r.endpoint === "GetTransactionDetailsByGuid")).toHaveLength(2);
    expect(mocks.ie.mock.calls.map(c => c[0].identity.electionYear)).toEqual([2026, 2026]);
  });
  it("acquires actual NRA nullable registry metadata only through explicitly electronic current reports", async () => {
    const registrationGuid = "64ed7b66-6f6d-49a9-8923-0de464f3c711";
    const source = server({
      registryRows: [registry(IEF, "IEF", { guid: registrationGuid,
        committeeName: "NRA Political Victory Fund - IE Committee ", filingYear: "2026", isPaperFiler: null })],
      reports: () => [report(IEF)],
      nativeRows: () => [native(IEF, { filerRegistrationGuid: registrationGuid })],
    });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } })
      .loadIndependentSpending({ electionYear: 2026 });
    expect(result.ieProofs).toHaveLength(1);
    expect(result.ieProofs?.[0]?.payer.registrationGuid).toBe(registrationGuid);
    expect(result.registryBefore?.rows[0]?.isPaperFiler).toBeNull();
    expect(result.registryAfter?.rows[0]?.rawFields.isPaperFiler).toBeNull();
    expect(source.log.filter(r => r.endpoint === "GetPublicFilerProfileFiling").map(r => r.body.filerRegistrationGuid))
      .toEqual([registrationGuid, registrationGuid]);
    const input = mocks.ie.mock.calls[0]![0] as ArkansasCurrentOriginalFinancialInput;
    expect(input.reportsBefore.rows[0]?.isPaperFile).toBe(false);
    expect(input.reportsAfter.rows[0]?.isPaperFile).toBe(false);
    expect(input.pdfs).toHaveLength(1);
    expect(input.details).toHaveLength(1);
  });
  it.each([
    ["paper current report", { isPaperFile: true }],
    ["unknown current paper flag", { isPaperFile: null }],
    ["unknown current status", { reportStatus: null }],
  ] as const)("preserves nullable IEF registration with %s", async (_label, overrides) => {
    const source = server({ registryRows: [registry(IEF, "IEF", { isPaperFiler: null })],
      reports: id => [report(id, overrides)] });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } })
      .loadIndependentSpending({ electionYear: 2026 });
    expect(result.ieProofs).toBeUndefined();
    expect(result.unverifiedRegistrationGuids).toEqual([guid(IEF)]);
    expect(source.log.some(r => r.endpoint === "DownloadDocument")).toBe(false);
    expect(mocks.ie).not.toHaveBeenCalled();
  });
  it("preserves one unsupported payer while retaining separately verified positive reports", async () => {
    const rows = [registry(CAN), registry(IEF, "IEF"), registry(555, "IEF")];
    const source = server({ registryRows: rows, reports: id => [report(id, id === 555 ? { filerReportVersionID: 2, reportStatus: "Amended" } : {})] });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } }).loadIndependentSpending({ electionYear: 2026 });
    expect(result.ieProofs).toHaveLength(1); expect(result.unverifiedRegistrationGuids).toEqual([guid(555)]);
    expect(result.diagnostics.join(" ")).toMatch(/unsupported amended/);
  });
  it.each(["cap", "closing failure", "changed registry"] as const)("omits usable outside proof when closing/source bound fails: %s", async kind => {
    const rows = [registry(CAN), registry(IEF, "IEF")];
    const source = server({ registryRows: rows, failClosingRegistry: kind === "closing failure",
      registryAfter: kind === "changed registry" ? [registry(CAN), registry(IEF, "IEF", { totalSpent: 1000 })] : undefined });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl }, maxTotalRequests: kind === "cap" ? 7 : 2000 })
      .loadIndependentSpending({ electionYear: 2026 });
    expect(result.ieProofs).toBeUndefined(); expect(result.diagnostics.join(" ")).toMatch(/preserved/);
  });
  it("does not fabricate an outside zero for no scoped payers or no authoritative payer proofs", async () => {
    for (const rows of [[registry(CAN)], [registry(CAN), registry(IEF, "IEF", { isPaperFiler: true })]]) {
      const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: server({ registryRows: rows }).fetchImpl } })
        .loadIndependentSpending({ electionYear: 2026 });
      expect(result.ieProofs).toBeUndefined(); expect(result).not.toHaveProperty("outsideGroups");
    }
  });
  it("rejects a full payer cap instead of silently scanning only a subset", async () => {
    const rows = [registry(CAN), registry(IEF, "IEF"), registry(555, "IEF")];
    const source = server({ registryRows: rows });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl }, maxPayers: 1 }).loadIndependentSpending({ electionYear: 2026 });
    expect(result.ieProofs).toBeUndefined(); expect(result.attemptedRegistrationGuids).toEqual([]);
    expect(result.diagnostics.join(" ")).toMatch(/payer bound/); expect(source.log).toHaveLength(1);
  });

  it("allows a hash-bound current Amended identity cover only as identity evidence", async () => {
    mocks.parse.mockImplementation(extraction => ({ ...extraction, kind: "candidate", ownerName: "Edna Charlene Fite",
      filerId: "8277", officeName: "State Representative", district: "24", electionYear: 2026,
      periodStart: "2026-03-04", periodEnd: "2026-04-30", filedAt: "2026-05-19T10:50:12" }));
    const rows = [registry(8277, "CAN", { filerName: "Fite, Edna C.", office: "State Representative", officeDistrictName: "24" })];
    const source = server({ registryRows: rows, reports: id => [report(id, { filerReportVersionID: 2, reportStatus: "Amended", reportVersion: "Amended", hasChild: true })] });
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } })
      .loadCandidateIdentity({ entityId: 8277, electionYear: 2026, officeName: "State Representative", district: "24", reportGuid: guid(82770) });
    expect(result.pdf?.parsed.ownerName).toBe("Edna Charlene Fite");
    expect(result.pdf?.request.requestBody.fileName).toBe("2026 April Monthly Report V2");
    expect(result).not.toHaveProperty("pacDonors"); expect(mocks.cash).not.toHaveBeenCalled();
    expect(source.log.map(r => r.endpoint)).toEqual(["GetCandidateCommitteDetails", "GetPublicFilerProfileFiling", "DownloadDocument", "GetPublicFilerProfileFiling", "GetCandidateCommitteDetails"]);
  });
  it.each(["missing", "changed", "wrong seat", "wrong cover"] as const)("preserves identity proof on %s context", async kind => {
    const source = server({ reports: (id, call) => [report(id, kind === "changed" && call === 2 ? { filerReportVersionID: 2 } : {})] });
    if (kind === "wrong cover") mocks.parse.mockImplementation(extraction => ({ ...extraction, kind: "candidate", ownerName: "Unknown", filerId: String(CAN), officeName: "State Senate", district: "8", electionYear: 2026 }));
    const result = await createArkansasVerifiedFinanceLoader({ clientOptions: { fetchImpl: source.fetchImpl } })
      .loadCandidateIdentity({ entityId: CAN, electionYear: 2026, officeName: "State Senate", district: kind === "wrong seat" ? "8" : "7", reportGuid: guid(kind === "missing" ? 123 : CAN * 10) });
    expect(result.identity).toBeUndefined(); expect(result.pdf).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/preserved/);
  });
});

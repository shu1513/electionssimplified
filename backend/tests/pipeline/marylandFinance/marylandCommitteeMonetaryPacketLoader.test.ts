import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ census: vi.fn(), inventory: vi.fn(), document: vi.fn(), summary: vi.fn(), context: vi.fn(), legacyReturns: vi.fn(), families: vi.fn(), receiptDetails: vi.fn() }));
vi.mock("../../../src/pipeline/marylandFinance/marylandPartitionedContributionCensus.js", () => ({ readMarylandPartitionedContributionCensus: mocks.census }));
vi.mock("../../../src/pipeline/marylandFinance/marylandPublicReportClient.js", async importOriginal => ({ ...await importOriginal<object>(), readMarylandCurrentReportInventory: mocks.inventory }));
vi.mock("../../../src/pipeline/marylandFinance/marylandSavedReportDocumentReader.js", () => ({ readMarylandSavedReportDocument: mocks.document }));
vi.mock("../../../src/pipeline/marylandFinance/marylandReportSummaryReader.js", () => ({ readMarylandReportSummary: mocks.summary }));
vi.mock("../../../src/pipeline/marylandFinance/marylandCompleteReceiptReportReader.js", () => ({ readMarylandCompleteReceiptReport: mocks.receiptDetails }));
vi.mock("../../../src/pipeline/marylandFinance/marylandOutsideReceivingContext.js", () => ({ bindMarylandOutsideReceivingContext: mocks.context }));
vi.mock("../../../src/pipeline/marylandFinance/marylandLegacyReturnedContributionFacts.js", () => ({ readMarylandLegacyReturnedContributionObservations: mocks.legacyReturns, proveMarylandLegacyReturnCashFamilies: mocks.families }));
import { loadMarylandCommitteeMonetaryPacket, type MarylandCommitteeMonetaryPacketInput } from "../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryPacketLoader.js";
import { buildMarylandPublicReportInventoryRequest, decodeMarylandPublicReportInventory } from "../../../src/pipeline/marylandFinance/marylandPublicReportClient.js";

const OWNER = "11111111-1111-4111-8111-111111111111", REPORT = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`;
const labels = { TCC: "Candidate Committee", TFED: "Federal Committee", TPAC: "Political Action Committee", TPCC: "Party Central Committee", TPCLB: "Political Club", TPOC: "Participating Organization Committee", TRNFC: "Registered Out-of-State (Non-Federal) Committee", TSLATE: "Slate Committee", TUNFC: "Unregistered Out-of-State (Non-Federal) Committee" };
function published() {
  const parent = { reportGuid: REPORT, reportVersionId: 2, reportName: "Published report", reportVersion: "Amended", reportVersionCode: "RPTAMD", reportType: "Campaign Finance Report", reportTypeCode: "FPCFR", filingEntityId: 1, filerRegistrationGuid: OWNER,
    committeeType: "Candidate Committee", committeeTypeCode: "CC", officeSought: "Governor", officeSoughtId: 40, jurisdiction: "State", jurisdictionId: 1, reportingCycle: "2023-2026", reportingCycleId: 12023, reportingYear: 2026,
    startDate: "2025-01-09T00:00:00", endDate: "2026-01-14T00:00:00", dueDate: "2026-01-28T00:00:00", filedDate: "2026-01-26T12:00:00", zeroActivity: false, hasChild: true };
  const childResults = [1, 2].map(v => ({ filerReportGuid: REPORT, filerReportVersionID: v, totalRows: 2, reportName: parent.reportName, reportType: "Disclosure Report", startDate: parent.startDate, endDate: parent.endDate, dueDate: parent.dueDate,
    filedDate: v === 2 ? parent.filedDate : "2026-01-25T12:00:00", isCompleted: true, isPaperFile: false, generateStatus: "Completed", generateStatusCode: "GRCOMP", reportStatus: `Version ${v}` }));
  return decodeMarylandPublicReportInventory({ succeeded: true, error: null, data: { items: [{ ...parent, childResults }], totalItems: 1 } }, buildMarylandPublicReportInventoryRequest({ filerRegistrationGuid: OWNER, electionCycleId: "12023", pageNumber: 1 })).reports[0]!;
}
type Row = Record<string, unknown>;
function row(n = 1, overrides: Row = {}): Row {
  return { transactionId: n, transactionGuid: uuid(n), transactionVersionID: 1, reportGuid: REPORT, reportVersionId: 1, filerRegistrationGuid: OWNER, electionCycleId: 12023,
    isActive: true, isReturn: false, transactionTypeCode: "TCON", transactionAmount: 10, transactionDate: "2025-06-01T00:00:00", contributionTypeCode: "CMONT", contributionType: "Monetary - Check", contributorTypeCode: "TCC", contributorType: labels.TCC,
    contributorName: "Reported TCC", contributorFullAddress: "12 Example St City, MD 12345", contributorZipCode: "12345", parentTransactionId: null, parentTransactionGuid: null, ...overrides };
}
const cap = (letter: string, completedAt = "2026-10-13T06:00:00.123456+00:00") => ({ sha256: letter.repeat(64), byteCount: 100, startedAt: "2026-10-12T06:00:00.123456+00:00", completedAt });
const basis = "active_native_api_with_published_summary_controls";
let rows: Row[], prior: Row[], report: ReturnType<typeof published>, input: MarylandCommitteeMonetaryPacketInput;
const sum = (predicate: (r: Row) => boolean) => rows.filter(predicate).reduce((n, r) => n + Math.round(Number(r.transactionAmount) * 100), 0);
function modern() {
  const amounts: Record<number, number> = { 1: sum(r => !r.isReturn && r.contributionTypeCode !== "CINKIND" && r.contributionTypeCode !== "ANYMS"), 2: sum(r => r.contributionTypeCode === "ANYMS"),
    3: sum(r => Boolean(r.isReturn) && r.contributionTypeCode !== "CINKIND"), 19: sum(r => !r.isReturn && r.contributionTypeCode === "CINKIND"), 21: sum(r => Boolean(r.isReturn) && r.contributionTypeCode === "CINKIND") };
  return { format: "modern", sourceFacts: { sha256: "c".repeat(64), byteCount: 100, pageCount: 6 },
    controls: { schema: "modern_numbered_26", controls: Array.from({ length: 26 }, (_, n) => ({ number: n + 1, amountCents: amounts[n + 1] ?? 0, printedLabel: "", printedOperator: "+" })), anonymousTransactionCount: 7, equations: {} } };
}
function legacy() {
  const groups: Record<string, number> = { A: sum(r => !r.isReturn && r.contributionTypeCode === "CMONT"), E: sum(r => !r.isReturn && r.contributionTypeCode === "TRFR"), I: sum(r => !r.isReturn && r.contributionTypeCode === "OTHRINCM") };
  return { format: "legacy", sourceFacts: { sha256: "c".repeat(64), byteCount: 100, pageCount: 6 },
    controls: { schema: "legacy_parts_3_4_5_6", receiptControls: "ABCDEFGHI".split("").map(column => ({ column, schedule: "1", amountCents: groups[column] ?? 0 })),
      expenseControls: [{ column: "Z", schedule: "2", amountCents: sum(r => Boolean(r.isReturn) && r.contributionTypeCode !== "CINKIND") }], inKind: { contributionsCents: sum(r => !r.isReturn && r.contributionTypeCode === "CINKIND") }, anonymousContributionsCents: null, returnedInKindCents: null } };
}
function refund(n: number, parent: number, overrides: Row = {}): Row {
  return row(n, { isReturn: true, transactionTypeCode: "TRCON", contributionType: "Monetary", parentTransactionId: parent, parentTransactionGuid: uuid(parent), transactionDate: "2025-06-02T00:00:00", ...overrides });
}
beforeEach(() => {
  vi.resetAllMocks(); report = published(); rows = [row()]; prior = [];
  input = { source: { currentCensusDirectory: "/private/current", priorCensusDirectory: "/private/prior", priorCycle: "12019", inventoryDirectory: "/private/inventory", documents: [{ reportGuid: REPORT, reportVersionId: 2, originalPath: "/private/document.original.pdf", captureJournalPath: "/private/captures.json" }] },
    receivingContext: { canonical: { candidateId: uuid(201) } } as MarylandCommitteeMonetaryPacketInput["receivingContext"], now: new Date("2026-10-15T00:00:00Z") };
  mocks.context.mockResolvedValue({ diagnostics: [], binding: { canonical: { linkId: uuid(200), candidateId: uuid(201), electionId: uuid(202), electionYear: 2026, committeeId: "source account", committeeName: "Receiving Committee" }, filerRegistrationGuid: OWNER, sourceCycle: { value: "12023" }, sourceCommitteeName: "Receiving Committee", sourceCommitteeLabels: ["Receiving Committee", "Receiving Official Label"], sourceMetadata: Array.from({ length: 5 }, () => cap("d")) } });
  mocks.census.mockImplementation(async ({ outputDirectory }) => { const selected = outputDirectory === "/private/current" ? rows : prior; return { rows: selected, declaredRows: selected.length, captures: [cap(outputDirectory === "/private/current" ? "a" : "b")] }; });
  mocks.inventory.mockImplementation(async () => ({ privateReports: [report], captures: [cap("e", "2026-10-14T00:00:00.123456+00:00")], sourceFacts: { completedAt: "2026-10-14T00:00:00.123456+00:00" } }));
  mocks.document.mockImplementation(async () => ({ privateBytes: new Uint8Array([37, 80]), sourceFacts: { ...cap("c", "2026-10-10T00:00:00.987654+00:00"), startedAt: "2026-10-09T00:00:00.987654+00:00" } }));
  mocks.summary.mockImplementation(async () => modern());
  mocks.receiptDetails.mockRejectedValue(new Error("Printed receipt details remain unqualified"));
  mocks.legacyReturns.mockImplementation(async () => ({ sourceFacts: { sha256: "c".repeat(64), byteCount: 100, pageCount: 6, returnCount: rows.filter(r => r.isReturn).length, returnCents: sum(r => Boolean(r.isReturn)) } }));
  mocks.families.mockImplementation(({ pdfReports }) => ({ sourceFacts: { documentFamily: "cash_outflow", reportsCompared: pdfReports.length, nativeReturns: rows.filter(r => r.isReturn).length, pdfReturns: rows.filter(r => r.isReturn).length, returnCents: sum(r => Boolean(r.isReturn)) }, reports: pdfReports.map(({ report: r }: { report: typeof report }) => ({ report: r, pdfSha256: "c".repeat(64), pdfByteCount: 100, pdfPageCount: 6, returnCount: rows.filter(r => r.isReturn).length, returnCents: sum(r => Boolean(r.isReturn)), documentFamily: "cash_outflow" })) }));
});

describe("Maryland API ledger and published summary packet", () => {
  it("uses the explicit independent basis, genuine captures and no receipt-detail attempt", async () => {
    const result = await loadMarylandCommitteeMonetaryPacket(input);
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw Error(JSON.stringify(result.diagnostics));
    expect(result.privateSnapshot).toMatchObject({ sourceObservedAt: new Date("2026-10-10T00:00:00.987Z"), inventoryObservedAt: new Date("2026-10-14T00:00:00.123Z"), aggregation: { giftCount: 1, grossCents: 1000, netCents: 1000 }, provenance: { financialBasis: basis, reportCount: 1, captureCount: 9 } });
    expect(result.sourceFacts).toMatchObject({ financialBasis: basis, detailVerification: "not_performed", nativeSchema: { rowsChecked: 1, absentReturnDisplays: 0, originalFamilyReturnDisplays: 0 }, sourceObservedAt: "2026-10-10T00:00:00.987654+00:00" });
    expect(result.sourceFacts.originalCaptures.map(c => c.role)).toEqual(["receiving_context", "receiving_context", "receiving_context", "receiving_context", "receiving_context", "current_census", "prior_census", "inventory", "pdf"]);
    expect(mocks.census.mock.calls.map(([v]) => v.electionCycle)).toEqual(["12023", "12019"]);
    expect(mocks.document).toHaveBeenCalledWith({ report, originalPath: "/private/document.original.pdf", captureJournalPath: "/private/captures.json" });
    expect(mocks.summary).toHaveBeenCalledWith(new Uint8Array([37, 80])); expect(mocks.receiptDetails).not.toHaveBeenCalled();
    expect(result.reports[0]).toMatchObject({ detailVerification: "not_performed", anonymousItemizationComparison: "not_evaluable", publishedAnonymousTransactionCount: 7 });
    expect(JSON.stringify({ sourceFacts: result.sourceFacts, reports: result.reports, diagnostics: result.diagnostics })).not.toMatch(/Reported TCC|Example St|11111111-1111|22222222-2222|source account|\/private/);
    expect(result.reports[0]).not.toHaveProperty("matchedIdentityOccurrences");
  });
  it("retains all nine classes, all source rows, and negative signed positions", async () => {
    rows = Object.entries(labels).map(([code, label], n) => row(n + 1, { contributorName: `Reported ${code}`, contributorTypeCode: code, contributorType: label }));
    prior = [row(100, { electionCycleId: 12019, transactionDate: "2022-06-01T00:00:00", transactionAmount: 20 })]; rows.push(refund(101, 100, { transactionAmount: 20 }));
    const result = await loadMarylandCommitteeMonetaryPacket(input);
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw Error(JSON.stringify(result.diagnostics));
    expect(result.privateSnapshot.aggregation).toMatchObject({ giftCount: 9, refundCount: 1, grossCents: 9000, refundCents: 2000, netCents: 7000 });
    expect(result.privateSnapshot.aggregation.positions).toHaveLength(9); expect(result.privateSnapshot.aggregation.positions.find(p => p.reportedClassCode === "TCC")?.netCents).toBe(-1000);
  });
  it.each(["missing", "duplicate", "historical", "extra"])("holds %s PDF descriptors before summary parsing", async kind => {
    const documents = [...input.source.documents]; if (kind === "missing") documents.length = 0; if (kind === "duplicate") documents.push(documents[0]!);
    if (kind === "historical") documents[0] = { ...documents[0]!, reportVersionId: 1 }; if (kind === "extra") documents.push({ ...documents[0]!, reportGuid: uuid(900), originalPath: "/private/other.pdf" });
    const result = await loadMarylandCommitteeMonetaryPacket({ ...input, source: { ...input.source, documents } });
    expect(result.status).toBe("preserve"); expect(result).not.toHaveProperty("privateSnapshot"); expect(mocks.summary).not.toHaveBeenCalled();
  });
  it("requires whole current inventory/lineage binding for noneligible rows too", async () => {
    rows.push(row(2, { reportGuid: uuid(900), contributorTypeCode: "TIND", contributorType: "Individual" }));
    expect((await loadMarylandCommitteeMonetaryPacket(input)).status).toBe("preserve"); expect(mocks.document).not.toHaveBeenCalled();
  });
  it.each([
    { contributionTypeCode: "UNKNOWN" }, { contributionType: "Monetary - Invented" }, { contributionType: "In-Kind" }, { contributionType: null }, { contributorType: "Political Action Committee" }, { contributorTypeCode: "UNKNOWN" }, { isActive: false },
  ])("holds any native schema/code/display/class contradiction before positive selection: %j", async override => {
    rows.push(row(2, { contributorTypeCode: "TIND", contributorType: "Individual", ...override }));
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("preserve"); expect(result.diagnostics).toContain("native_schema_unavailable"); expect(mocks.summary).not.toHaveBeenCalled();
  });
  it("checks all prior rows for class/display contradictions as well", async () => {
    prior = [row(100, { electionCycleId: 12019, transactionDate: "2022-06-01T00:00:00", contributionType: "Unknown old display" })];
    expect((await loadMarylandCommitteeMonetaryPacket(input)).status).toBe("preserve");
  });
  it("accepts only the exact observed EFT payment variants without changing their financial families", async () => {
    rows = [row(1, { contributionType: "Monetary - Electronic Fund Transfer (EFT)" }), row(2, { contributionTypeCode: "OTHRINCM", contributionType: "Other Income - Electronic Fund Transfer (EFT)" })];
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("ready");
    expect(result.reports[0]!.nativeFamilies).toMatchObject({ monetaryGifts: { count: 1, cents: 1000 }, otherReceipts: { count: 1, cents: 1000 } });
  });
  it("keeps modern anonymous amount control separate from unevaluable aggregate-row itemization", async () => {
    rows = [row(1, { contributionTypeCode: "ANYMS", contributionType: "Anonymous", contributorTypeCode: null, contributorType: null, contributorName: "Anonymous", contributorFullAddress: null, contributorZipCode: null })];
    const result = await loadMarylandCommitteeMonetaryPacket(input);
    expect(result.status).toBe("ready"); expect(result.reports[0]).toMatchObject({ nativeFamilies: { anonymousAggregates: { count: 1, cents: 1000 } }, publishedAnonymousTransactionCount: 7, anonymousItemizationComparison: "not_evaluable" });
    expect(result.reports[0]!.familyControls).toContainEqual({ family: "anonymousAggregates", nativeCents: 1000, controlCents: 1000, differenceCents: 0 });
  });
  it("requires no native anonymous aggregates when a legacy control is absent", async () => {
    rows = [row(1, { contributionTypeCode: "ANYMS", contributionType: "Anonymous", contributorTypeCode: null, contributorType: null, contributorName: "Anonymous" })]; mocks.summary.mockImplementation(async () => legacy());
    const result = await loadMarylandCommitteeMonetaryPacket(input);
    expect(result.status).toBe("preserve"); expect(result.reports[0]!.familyControls).toContainEqual({ family: "anonymousAggregates", nativeCents: 1000, controlCents: null, differenceCents: null });
  });
  it("separately reconciles legacy CMONT A-D, transfers E-H, other I and in-kind J", async () => {
    rows = [row(), row(2, { contributionTypeCode: "TRFR", contributionType: "Transfer" }), row(3, { contributionTypeCode: "OTHRINCM", contributionType: "Other Income" }), row(4, { contributionTypeCode: "CINKIND", contributionType: "In-Kind" })];
    mocks.summary.mockImplementation(async () => legacy()); const result = await loadMarylandCommitteeMonetaryPacket(input);
    expect(result.status).toBe("ready"); expect(result.reports[0]!.familyControls?.filter(c => c.controlCents !== null).map(c => [c.family, c.differenceCents])).toEqual([["monetaryGifts", 0], ["transfers", 0], ["otherReceipts", 0], ["inKindGifts", 0], ["cashReturns", 0]]);
    expect(result.reports[0]!.familyControls).toContainEqual({ family: "inKindReturns", nativeCents: 0, controlCents: null, differenceCents: null });
  });
  it("holds same-total legacy mechanism swaps instead of comparing only combined cash", async () => {
    mocks.summary.mockImplementation(async () => { const value = legacy(); value.controls.receiptControls.find(c => c.column === "A")!.amountCents = 0; value.controls.receiptControls.find(c => c.column === "E")!.amountCents = 1000; return value; });
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("preserve"); expect(result.diagnostics).toContain("report_0_financial_family_controls");
  });
  it.each([1, 2, 19])("holds modern published family control %i differences", async number => {
    mocks.summary.mockImplementation(async () => { const value = modern(); value.controls.controls[number - 1]!.amountCents++; return value; });
    expect((await loadMarylandCommitteeMonetaryPacket(input)).status).toBe("preserve");
  });
  it("separately reconciles modern cash/in-kind returns even when their sum agrees", async () => {
    prior = [row(100, { electionCycleId: 12019, transactionDate: "2022-06-01T00:00:00", transactionAmount: 20 })]; rows = [refund(101, 100, { transactionAmount: 20 })];
    mocks.summary.mockImplementation(async () => { const value = modern(); value.controls.controls[2]!.amountCents = 0; value.controls.controls[20]!.amountCents = 2000; return value; });
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("preserve"); expect(result.reports[0]!.familyControls).toContainEqual({ family: "cashReturns", nativeCents: 2000, controlCents: 0, differenceCents: 2000 });
    expect(result.reports[0]!.familyControls).toContainEqual({ family: "inKindReturns", nativeCents: 0, controlCents: 2000, differenceCents: -2000 });
  });
  it("validates original-kind return display and freshly proves the same legacy original's cash family", async () => {
    prior = [row(100, { electionCycleId: 12019, transactionDate: "2022-06-01T00:00:00", contributionTypeCode: "CINKIND", contributionType: "In-Kind" })]; rows = [refund(101, 100, { contributionType: "In-Kind" })]; mocks.summary.mockImplementation(async () => legacy());
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("ready"); if (result.status !== "ready") throw Error(JSON.stringify(result.diagnostics));
    expect(result.sourceFacts.nativeSchema).toMatchObject({ originalFamilyReturnDisplays: 1 });
    expect(result.privateSnapshot.aggregation).toMatchObject({ grossCents: 0, refundCents: 1000, netCents: -1000 });
    expect(result.privateSnapshot.aggregation.positions[0]).toMatchObject({ originalGiftKinds: ["CINKIND"], documentBoundCashOutflowRefundCount: 1 });
    expect(mocks.legacyReturns).toHaveBeenCalledWith(new Uint8Array([37, 80])); expect(mocks.families.mock.calls[0]![0]).toMatchObject({ reports: [report], currentRows: rows, priorRows: prior, pdfReports: [{ report, facts: { sourceFacts: { sha256: "c".repeat(64), returnCount: 1, returnCents: 1000 } } }] });
  });
  it("allows source-null cash-return display only with its resolved parent and family controls", async () => {
    prior = [row(100, { electionCycleId: 12019, transactionDate: "2022-06-01T00:00:00" })]; rows = [refund(101, 100, { contributionType: null })];
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("ready"); expect(result.sourceFacts.nativeSchema).toMatchObject({ absentReturnDisplays: 1 });
  });
  it("allows original transfer display on a CMONT cash return only with an actual transfer parent", async () => {
    prior = [row(100, { electionCycleId: 12019, transactionDate: "2022-06-01T00:00:00", contributionTypeCode: "TRFR", contributionType: "Transfer" })]; rows = [refund(101, 100, { contributionType: "Transfer" })];
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("ready"); expect(result.sourceFacts.nativeSchema).toMatchObject({ originalFamilyReturnDisplays: 1 });
  });
  it.each([
    { contributionType: "In-Kind" }, { contributionType: "Transfer" }, { contributionType: null, parentTransactionGuid: uuid(999) }, { contributionType: "Unknown" },
  ])("holds conflicting or unproved return display %j", async override => {
    prior = [row(100, { electionCycleId: 12019, transactionDate: "2022-06-01T00:00:00" })]; rows = [refund(101, 100, override)];
    expect((await loadMarylandCommitteeMonetaryPacket(input)).status).toBe("preserve");
  });
  it("does not reinterpret an actual CINKIND-coded return as cash", async () => {
    prior = [row(100, { electionCycleId: 12019, transactionDate: "2022-06-01T00:00:00", contributionTypeCode: "CINKIND", contributionType: "In-Kind" })]; rows = [refund(101, 100, { contributionTypeCode: "CINKIND", contributionType: "In-Kind" })];
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("ready"); expect(result.sourceFacts.refundCents).toBe(0); expect(result.reports[0]!.nativeFamilies).toMatchObject({ cashReturns: { count: 0, cents: 0 }, inKindReturns: { count: 1, cents: 1000 } });
  });
  it("holds unavailable/changed original return evidence without substituting prior diagnostics", async () => {
    mocks.summary.mockImplementation(async () => legacy()); mocks.legacyReturns.mockResolvedValue({ sourceFacts: { sha256: "a".repeat(64), byteCount: 100 } });
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("preserve"); expect(mocks.families).not.toHaveBeenCalled();
  });
  it("holds a fresh whole-family proof failure", async () => {
    mocks.summary.mockImplementation(async () => legacy()); mocks.families.mockImplementation(() => { throw Error("unknown returned source family"); });
    const result = await loadMarylandCommitteeMonetaryPacket(input); expect(result.status).toBe("preserve"); expect(result.diagnostics).toContain("legacy_return_family_unavailable");
  });
  it("keeps report ordinal failure and scans every remaining original", async () => {
    const second = { ...report, reportGuid: uuid(500), childResults: report.childResults!.map(c => ({ ...c, filerReportGuid: uuid(500) })) };
    mocks.inventory.mockResolvedValue({ privateReports: [report, second], captures: [cap("e", "2026-10-14T00:00:00.123456+00:00")], sourceFacts: { completedAt: "2026-10-14T00:00:00.123456+00:00" } });
    const documents = [...input.source.documents, { ...input.source.documents[0]!, reportGuid: uuid(500), originalPath: "/private/second.pdf" }];
    mocks.summary.mockRejectedValueOnce(new Error("private source fragment must never appear")).mockImplementationOnce(async () => { const value = modern(); value.controls.controls.forEach(c => c.amountCents = 0); return value; });
    const result = await loadMarylandCommitteeMonetaryPacket({ ...input, source: { ...input.source, documents } });
    expect(result.status).toBe("preserve"); expect(result.reports).toHaveLength(2); expect(mocks.document).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain("private source fragment");
  });
  it("clones descriptors, canonical source metadata and now before first await", async () => {
    let release!: (value: unknown) => void; const bound = await mocks.context(); mocks.context.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = loadMarylandCommitteeMonetaryPacket(input); (input.source as { currentCensusDirectory: string }).currentCensusDirectory = "/changed"; (input.source.documents[0] as { originalPath: string }).originalPath = "/changed.pdf"; input.now!.setUTCFullYear(2000); release(bound);
    const result = await pending; expect(result.status).toBe("ready"); expect(mocks.census.mock.calls[0]![0].outputDirectory).toBe("/private/current"); expect(mocks.document.mock.calls[0]![0].originalPath).toBe("/private/document.original.pdf");
  });
  it("holds future microseconds and source time newer than inventory without retiming either", async () => {
    mocks.document.mockResolvedValue({ privateBytes: new Uint8Array([37]), sourceFacts: { ...cap("c", "2026-10-15T00:00:00.000001+00:00"), startedAt: "2026-10-15T00:00:00.000000+00:00" } });
    expect((await loadMarylandCommitteeMonetaryPacket(input)).status).toBe("preserve"); mocks.document.mockResolvedValue({ privateBytes: new Uint8Array([37]), sourceFacts: cap("c") });
    mocks.inventory.mockResolvedValue({ privateReports: [report], captures: [cap("e", "2026-10-12T06:00:00.123456+00:00")], sourceFacts: { completedAt: "2026-10-12T06:00:00.123456+00:00" } }); expect((await loadMarylandCommitteeMonetaryPacket(input)).status).toBe("preserve");
  });
});

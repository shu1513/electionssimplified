import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ local: vi.fn(), catalog: vi.fn(), resolve: vi.fn(), finance: vi.fn() }));
vi.mock("../../../src/pipeline/floridaFinance/floridaLocalFinanceContext.js", () => ({ loadFloridaLocalFinanceContext: mocks.local }));
vi.mock("../../../src/pipeline/floridaFinance/floridaCandidateAccountSource.js", () => ({
  createFloridaCandidateAccountSource: () => ({ fetchCatalog: mocks.catalog }), resolveFloridaCandidateAccount: mocks.resolve,
}));
vi.mock("../../../src/pipeline/floridaFinance/floridaProcessedFinanceSourceLoader.js", () => ({
  createFloridaProcessedFinanceSourceLoader: () => ({ load: mocks.finance }),
}));
import { createFloridaCandidateProcessedFinanceSource } from "../../../src/pipeline/floridaFinance/floridaCandidateProcessedFinanceSource.js";
const context = { candidateId: "candidate", candidateElectionId: "ce", electionId: "election",
  candidateName: "Adam Botana", electionYear: 2026, electionDate: "2026-11-03", officeScope: "state_lower",
  officeCanonicalName: "State Lower Chamber Legislator", district: "80", committeeId: "synthetic-linked-id",
  genericRecipientName: "Botana, Adam (REP)(STR)" };
function source(refresh = false) {
  return createFloridaCandidateProcessedFinanceSource({ db: { query: vi.fn() }, request: vi.fn(), refresh });
}
const input = { candidateId: context.candidateId, electionId: context.electionId, committeeId: context.committeeId };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.local.mockResolvedValue({ status: "resolved", context });
  mocks.catalog.mockResolvedValue({ rows: [], sources: [{ sha256: "catalog-hash" }] });
  mocks.resolve.mockReturnValue({ status: "matched", account: "88807", officeName: "State Representative", district: "80",
    row: { candidateName: "Adam Botana" } });
  mocks.finance.mockResolvedValue({ proof: { context: { sourceAccount: "88807" } }, diagnostics: [] });
});
describe("Florida automatic source composition", () => {
  it("uses numeric catalog account and real local race rather than synthetic link identity", async () => {
    expect(await source().load(input)).toMatchObject({ status: "verified", proof: { context: { sourceAccount: "88807" } } });
    expect(mocks.resolve.mock.calls[0]![0].target).toMatchObject({ officeName: context.officeCanonicalName, district: "80", electionType: "general" });
    expect(mocks.finance.mock.calls[0]![0]).toMatchObject({ context: { sourceAccount: "88807",
      officeName: "State Representative", genericRecipientName: context.genericRecipientName }, windowStart: "2025-01-01" });
  });
  it("does not acquire sources for unsupported local races", async () => {
    mocks.local.mockResolvedValue({ status: "preserve", reason: "primary election" });
    expect(await source().load(input)).toEqual({ status: "preserve", diagnostics: ["primary election"] });
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it.each(["unmatched", "ambiguous"])("preserves %s accounts without loading finance", async status => {
    mocks.resolve.mockReturnValue({ status, reason: "source ownership unknown" });
    expect((await source().load(input)).status).toBe("preserve");
    expect(mocks.finance).not.toHaveBeenCalled();
  });
  it("preserves incomplete processed publication", async () => {
    mocks.finance.mockResolvedValue({ diagnostics: ["Updated–Needs Review"] });
    expect(await source().load(input)).toEqual({ status: "preserve", diagnostics: ["Updated–Needs Review"] });
  });
  it("shares catalog per batch but reacquires finance for each candidate", async () => {
    const batch = source(); await batch.load(input); await batch.load(input);
    expect(mocks.catalog).toHaveBeenCalledTimes(1); expect(mocks.finance).toHaveBeenCalledTimes(2);
    expect(mocks.catalog).toHaveBeenCalledWith({ electionId: "20261103-GEN", savedFirst: true });
  });
  it("refresh bypasses saved catalog openings", async () => {
    await source(true).load(input);
    expect(mocks.catalog).toHaveBeenCalledWith({ electionId: "20261103-GEN", savedFirst: false });
  });
  it("retries a failed catalog and caches the successful retry", async () => {
    mocks.catalog.mockRejectedValueOnce(new Error("public source HTTP503"));
    const batch = source();
    expect(await batch.load(input)).toEqual({ status: "preserve", diagnostics: ["public source HTTP503"] });
    expect((await batch.load(input)).status).toBe("verified");
    expect((await batch.load(input)).status).toBe("verified");
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
    expect(mocks.finance).toHaveBeenCalledTimes(2);
  });
  it("preserves source failure", async () => {
    mocks.catalog.mockRejectedValue(new Error("public source HTTP503"));
    expect(await source().load(input)).toEqual({ status: "preserve", diagnostics: ["public source HTTP503"] });
  });
});

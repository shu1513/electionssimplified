import { describe, expect, it, vi } from "vitest";
import { createAlabamaVerifiedPacLoader, type AlabamaVerifiedPacLoaderInput, type AlabamaVerifiedPacLoaderOptions } from "../../../src/pipeline/alabamaFinance/alabamaVerifiedPacLoader.js";
import type { AlabamaCashRowsLoader } from "../../../src/pipeline/alabamaFinance/alabamaCandidateFinanceSync.js";
import type { AlabamaFcpaArtifactCacheMetadata } from "../../../src/pipeline/alabamaFinance/alabamaFcpaArtifactCache.js";
import type { AlabamaExtractCatalogRow, AlabamaNativeContributionRow, AlabamaCommitteeFilingRow, AlabamaCommitteeRegistryRow } from "../../../src/pipeline/alabamaFinance/alabamaFcpaClient.js";
const input: AlabamaVerifiedPacLoaderInput = { internalCommitteeId: 206, fcpaCommitteeNumber: "25079", windowStart: "2023-01-01", windowEnd: "2026-12-31", extractYears: [2023, 2024, 2025, 2026], coversCashCents: 150000, authoritativeCoverCount: 1 };
const cash = { committeeId: "25079", amountCents: 150000, contributionDate: "09/17/2026", lastName: "Electric Cooperatives of Alabama PAC", firstName: "", contributionId: "1871301", filedDate: "10/02/2026", contributionType: "Cash (Itemized)", contributorType: "PAC", committeeType: "Principal Campaign Committee", committeeName: "", candidateName: "THOMAS JACKSON", amended: "N" };
const native: AlabamaNativeContributionRow = { TRANSACTIONID: 1871301, COMMITTEEID: 206, FILINGDATE: "10/02/2026", CONTRIBUTOR: cash.lastName, CITYSTATE: "Montgomery, AL", ZIP: "36124", CONTRIBUTIONTYPE: "Cash (Itemized)", DESCRIPTION: "", AMOUNT: 1500, TRANSACTIONDATE: cash.contributionDate, RECIPIENTNAME: "THOMAS E ACTION JACKSON" };
const filing: AlabamaCommitteeFilingRow = { ID: 175978, DESCRIPTION: "2026 ELECTION CYCLE Monthly Report", PERIODBEGIN: "09/01/2026", PERIODEND: "09/30/2026", FILEDDATE: "10/02/2026 09:49 AM", AMENDED: "No" };
const registry: AlabamaCommitteeRegistryRow[] = [{ id: 206, committeeId: "25079", committeeType: "1", candidateFirstName: "THOMAS", candidateMiddleName: "E ACTION", candidateLastName: "JACKSON" }, { id: 33, committeeId: "24906", committeeType: "2", committeeName: cash.lastName }];
function catalog(year: number): AlabamaExtractCatalogRow { return { YEAR: year, DATATYPE: "Cash Contribution", LASTUPDATED: "10/11/2026", LASTUPDATEDRAW: year === 2023 ? "Oct 11, 2026, 2:33:00 AM" : "Oct 11, 2026, 2:34:00 AM", DOWNLOAD: year }; }
function metadata(year: number): AlabamaFcpaArtifactCacheMetadata {
  return { version: 1, artifact: { kind: "cash", year }, filePath: "/verified/cash.zip", metadataPath: "/verified/cash.json", downloadedAt: "2026-10-11T10:00:00Z", source: { dataType: "Cash Contribution", downloadId: year, lastUpdatedRaw: catalog(year).LASTUPDATEDRAW }, fileName: "cash.csv", zipBytes: 100, zipSha256: "a".repeat(64), csvSha256: "b".repeat(64), recordCount: year === 2026 ? 1 : 0, quarantinedCount: 0 };
}
function setup() {
  const loadCashRows = vi.fn<AlabamaCashRowsLoader>(async (year) => ({ rows: year === 2026 ? [{ ...cash }] : [], quarantinedCount: 0, metadata: metadata(year) }));
  const fetchCatalog = vi.fn(async () => input.extractYears.map(catalog));
  const fetchRegistry = vi.fn(async () => structuredClone(registry));
  const fetchNativeContributions = vi.fn(async () => [{ ...native }]);
  const fetchFilings = vi.fn(async () => [{ ...filing }]);
  const coverLoader = vi.fn(async () => ({ windowStart: input.windowStart, filingCount: 1, windowFilingCount: 1, cashCents: 150000, inKindCents: 0, otherCents: 0, expenditureCents: 0, openingBalanceCents: 0, latestEndingBalanceCents: 150000 }));
  const createCoversLoader = vi.fn<NonNullable<AlabamaVerifiedPacLoaderOptions["createCoversLoader"]>>(() => coverLoader);
  const fetchCoverHtml = vi.fn(async () => "");
  const clientOptions = { timeoutMs: 25 };
  const options = { loadCashRows, fetchCatalog, fetchRegistry, fetchNativeContributions, fetchFilings, createCoversLoader, fetchCoverHtml, clientOptions };
  return { ...options, coverLoader, options, run: (request = input) => createAlabamaVerifiedPacLoader(options)(request) };
}
async function preserves(run: () => ReturnType<ReturnType<typeof createAlabamaVerifiedPacLoader>>, reason: string) {
  const result = await run();
  expect(result.pacDonors).toBeUndefined(); expect(result.diagnostics.join(" ")).toContain(reason);
}
describe("createAlabamaVerifiedPacLoader", () => {
  it("accepts complete current cash proof with different legitimate per-year generation minutes", async () => {
    const s = setup(); const result = await s.run();
    expect(result.pacDonors?.[0]).toMatchObject({ committeeId: "24906", amount: 1500, contributionCount: 1 });
    expect(result.diagnostics).toEqual([]);
    expect(s.loadCashRows.mock.calls.map(([year]) => year)).toEqual(input.extractYears);
    expect(s.fetchNativeContributions.mock.calls).toEqual([
      [{ fcpaCommitteeNumber: "25079", internalCommitteeId: 206 }, s.clientOptions],
      [{ fcpaCommitteeNumber: "25079", internalCommitteeId: 206, pacOnly: true }, s.clientOptions],
      [{ fcpaCommitteeNumber: "25079", internalCommitteeId: 206 }, s.clientOptions],
      [{ fcpaCommitteeNumber: "25079", internalCommitteeId: 206, pacOnly: true }, s.clientOptions],
    ]);
    expect(s.fetchCatalog).toHaveBeenCalledTimes(2); expect(s.fetchRegistry).toHaveBeenCalledTimes(2);
    expect(s.fetchFilings).toHaveBeenCalledTimes(2);
    const coverOptions = s.createCoversLoader.mock.calls[0]![0]!;
    expect(await coverOptions.fetchFilings!(206)).toEqual([filing]);
    expect(s.fetchFilings).toHaveBeenCalledTimes(2);
    expect(coverOptions.clientOptions).toBe(s.clientOptions); expect(coverOptions.fetchCoverHtml).toBe(s.fetchCoverHtml);
  });
  it("preserves legacy metadata-free cache without government requests", async () => {
    const s = setup(); s.loadCashRows.mockImplementation(async () => ({ rows: [], quarantinedCount: 0 }));
    await preserves(() => s.run(), "metadata");
    expect(s.fetchCatalog).not.toHaveBeenCalled(); expect(s.fetchRegistry).not.toHaveBeenCalled(); expect(s.fetchNativeContributions).not.toHaveBeenCalled();
  });
  it("preserves unavailable cache without government requests", async () => {
    const s = setup(); s.loadCashRows.mockRejectedValue(new Error("cache unavailable"));
    await preserves(() => s.run(), "cache unavailable"); expect(s.fetchCatalog).not.toHaveBeenCalled();
  });
  it.each([
    { recordCount: 2 }, { quarantinedCount: 1 }, { zipBytes: 0 }, { csvSha256: "bad" }, { zipSha256: "bad" },
    { version: 2 }, { filePath: "" }, { downloadedAt: "invalid" }, { artifact: { kind: "expenditure", year: 2023 } },
    { source: { dataType: "Expenditure", downloadId: 2023, lastUpdatedRaw: catalog(2023).LASTUPDATEDRAW } },
  ])("rejects runtime artifact integrity mismatch %j before requests", async (change) => {
    const s = setup(); s.loadCashRows.mockImplementation(async (year) => ({ rows: year === 2026 ? [cash] : [], quarantinedCount: 0, metadata: { ...metadata(year), ...(year === 2023 ? change : {}) } as AlabamaFcpaArtifactCacheMetadata }));
    await preserves(() => s.run(), "metadata"); expect(s.fetchCatalog).not.toHaveBeenCalled();
  });
  it("allows unrelated quarantines only with matching counters and exact independent current cash proof", async () => {
    const s = setup(); s.loadCashRows.mockImplementation(async (year) => ({ rows: year === 2026 ? [cash] : [], quarantinedCount: year === 2024 ? 2 : 0, metadata: { ...metadata(year), recordCount: year === 2024 ? 2 : metadata(year).recordCount, quarantinedCount: year === 2024 ? 2 : 0 } }));
    expect((await s.run()).pacDonors?.[0]?.amount).toBe(1500);
    s.loadCashRows.mockImplementation(async (year) => ({ rows: [], quarantinedCount: year === 2026 ? 1 : 0, metadata: { ...metadata(year), quarantinedCount: year === 2026 ? 1 : 0 } }));
    await preserves(() => s.run(), "cash ID sets disagree");
  });
  it.each([[2023, 2024, 2026], [2023, 2024, 2025, 2025], [2022, 2023, 2024, 2025, 2026]])("rejects incomplete/duplicate/extraneous term years %j", async (...years) => {
    const s = setup(); await preserves(() => s.run({ ...input, extractYears: years }), "complete term"); expect(s.loadCashRows).not.toHaveBeenCalled();
  });
  it("rejects ambiguous or missing catalog rows", async () => {
    const s = setup(); s.fetchCatalog.mockResolvedValue([catalog(2023), catalog(2024), catalog(2025)]);
    await preserves(() => s.run(), "catalog for 2026");
    s.fetchCatalog.mockResolvedValue([...input.extractYears.map(catalog), catalog(2026)]);
    await preserves(() => s.run(), "catalog for 2026");
  });
  it("rejects wrong current download identity even if the timestamp is unchanged", async () => {
    const s = setup(); s.fetchCatalog.mockResolvedValue(input.extractYears.map((year) => ({ ...catalog(year), DOWNLOAD: 99 })));
    await preserves(() => s.run(), "does not match"); expect(s.fetchRegistry).not.toHaveBeenCalled();
  });
  it("rejects changed closing catalog full source metadata", async () => {
    const s = setup(); s.fetchCatalog.mockResolvedValueOnce(input.extractYears.map(catalog)).mockResolvedValueOnce(input.extractYears.map((year) => ({ ...catalog(year), LASTUPDATED: "changed" })));
    await preserves(() => s.run(), "catalog changed");
  });
  it("rejects cache older than a current term filing using earliest per-year extraction minute", async () => {
    const s = setup(); s.fetchFilings.mockResolvedValue([{ ...filing, FILEDDATE: "10/11/2026 02:34 AM" }]);
    await preserves(() => s.run(), "newer than"); expect(s.fetchNativeContributions).not.toHaveBeenCalled();
  });
  it.each(["02/30/2026 09:49 AM", "10/02/2026 13:00 PM", "10/02/2026 09:60 AM", "10/02/2026", ""])("rejects impossible/unproved current filing stamp %s", async (FILEDDATE) => {
    const s = setup(); s.fetchFilings.mockResolvedValue([{ ...filing, FILEDDATE }]);
    await preserves(() => s.run(), "filings unavailable");
  });
  it("does not let irrelevant old filed dates block a known historical period", async () => {
    const s = setup(); const rows = [{ ...filing }, { ...filing, ID: 2, PERIODBEGIN: "01/01/2022", FILEDDATE: null }];
    s.fetchFilings.mockResolvedValue(rows); s.coverLoader.mockResolvedValue({ ...await s.coverLoader(), filingCount: 2 });
    expect((await s.run()).pacDonors?.[0]?.amount).toBe(1500);
  });
  it("rejects empty or changed full registry, including excluded PCC and unknown metadata changes", async () => {
    const s = setup(); s.fetchRegistry.mockResolvedValueOnce([]); await preserves(() => s.run(), "registry unavailable");
    s.fetchRegistry.mockResolvedValueOnce(structuredClone(registry)).mockResolvedValueOnce([{ ...registry[0]!, committeeStatus: "changed" }, registry[1]!]);
    await preserves(() => s.run(), "registry changed");
  });
  it.each([{ cashCents: 150001 }, { windowFilingCount: 2 }, { filingCount: 0 }, { windowStart: "2025-01-01" }])("rejects fresh cover disagreement %j", async (change) => {
    const s = setup(); s.coverLoader.mockResolvedValue({ ...await s.coverLoader(), ...change });
    await preserves(() => s.run(), "covers disagree");
  });
  it("preserves changed native address metadata and current filing metadata", async () => {
    const s = setup(); s.fetchNativeContributions.mockResolvedValueOnce([{ ...native }]).mockResolvedValueOnce([{ ...native }]).mockResolvedValue([{ ...native, ZIP: "changed" }]);
    await preserves(() => s.run(), "metadata changed");
    const f = setup(); f.fetchFilings.mockResolvedValueOnce([{ ...filing }]).mockResolvedValueOnce([{ ...filing, AMENDED: "Yes" }]);
    await preserves(() => f.run(), "metadata changed");
  });
  it("rejects repeated native identities even if source metadata stays stable", async () => {
    const s = setup(); s.fetchNativeContributions.mockResolvedValue([{ ...native }, { ...native }]);
    await preserves(() => s.run(), "source IDs");
  });
  it("preserves getter failures instead of emitting an empty donor snapshot", async () => {
    const s = setup(); s.fetchNativeContributions.mockRejectedValue(new Error("strict pagination incomplete"));
    await preserves(() => s.run(), "strict pagination incomplete");
  });
  it("acquires fresh registry/catalog brackets per call and accepts order-only differences", async () => {
    const s = setup(); s.fetchRegistry.mockResolvedValueOnce(structuredClone(registry)).mockResolvedValueOnce(structuredClone(registry).reverse());
    expect((await s.run()).pacDonors?.[0]?.amount).toBe(1500);
    expect((await s.run()).pacDonors?.[0]?.amount).toBe(1500);
    expect(s.fetchCatalog).toHaveBeenCalledTimes(4); expect(s.fetchRegistry).toHaveBeenCalledTimes(4);
  });
  it("returns a proven empty PAC snapshot only after complete zero-cash native/current cover proof", async () => {
    const s = setup(); s.loadCashRows.mockImplementation(async (year) => ({ rows: [], quarantinedCount: 0, metadata: { ...metadata(year), recordCount: 0 } }));
    s.fetchNativeContributions.mockResolvedValue([]);
    s.coverLoader.mockResolvedValue({ ...await s.coverLoader(), cashCents: 0 });
    expect(await s.run({ ...input, coversCashCents: 0 })).toEqual({ pacDonors: [], diagnostics: [] });
  });
});

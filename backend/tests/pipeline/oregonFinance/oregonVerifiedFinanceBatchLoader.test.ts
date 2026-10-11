import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OregonCandidateFinanceDueRow } from "../../../src/pipeline/oregonFinance/oregonCandidateFinanceBatchSync.js";
import type { OregonVerifiedLocalCandidateRow } from "../../../src/pipeline/oregonFinance/oregonVerifiedLocalCandidateContext.js";
import type { OregonVerifiedFinanceSourceLoaderResult } from "../../../src/pipeline/oregonFinance/oregonVerifiedFinanceSourceLoader.js";
import { loadOregonVerifiedFinanceForCandidate as load } from "../../../src/pipeline/oregonFinance/oregonVerifiedFinanceBatchLoader.js";

const boundary = vi.hoisted(() => ({
  createClient: vi.fn(), createCache: vi.fn(), source: vi.fn(),
  writeCapture: vi.fn(), readSaved: vi.fn(),
  client: { syntheticTransportBoundary: true },
}));
vi.mock("../../../src/pipeline/oregonFinance/oregonVerifiedSourceClient.js", () => ({
  createOregonVerifiedSourceClient: boundary.createClient,
}));
vi.mock("../../../src/pipeline/oregonFinance/oregonVerifiedSourceArtifactCache.js", () => ({
  createOregonVerifiedSourceArtifactCache: boundary.createCache,
  DEFAULT_OREGON_VERIFIED_SOURCE_CACHE_DIR: "scratch/oregon-campaign-finance/verified",
}));
vi.mock("../../../src/pipeline/oregonFinance/oregonVerifiedFinanceSourceLoader.js", () => ({
  loadOregonVerifiedFinanceSource: boundary.source,
}));

const candidateId = "11111111-1111-4111-8111-111111111111";
const electionId = "22222222-2222-4222-8222-222222222222";
const linkId = "33333333-3333-4333-8333-333333333333";
const generationDir = "/synthetic/external/immutable-generation";
function due(overrides: Partial<OregonCandidateFinanceDueRow> = {}): OregonCandidateFinanceDueRow {
  return { candidateId, electionId, candidateName: "Adam Baker", electionYear: 2026,
    officeScope: "state_lower", officeName: "State Lower Chamber Legislator",
    district: "State House District 40 (2024); Oregon", committeeId: "21892",
    committeeName: "Adam 4 Oregon", sourceUrl: null, lastSyncedAt: null, ...overrides };
}
function local(overrides: Partial<OregonVerifiedLocalCandidateRow> = {}): OregonVerifiedLocalCandidateRow {
  return { candidateId, electionId, committeeId: "21892", candidateName: "Adam Baker",
    electionDate: "2026-11-03", electionStage: "general", officeName: "State Lower Chamber Legislator",
    districtName: "State House District 40 (2024); Oregon", districtState: "OR",
    districtType: "state_lower", geoidCompact: "41040", ...overrides };
}
function database(options: {
  localRows?: OregonVerifiedLocalCandidateRow[];
  priorRows?: { id: string; pac_source_provenance: unknown }[];
  outsideRows?: { payer_committee_id: string; source_provenance: unknown }[];
} = {}) {
  return { query: vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM public.candidates candidate")) return { rows: options.localRows ?? [local()] };
    if (sql.includes("LEFT JOIN public.or_candidate_finance_summaries")) return {
      rows: options.priorRows ?? [{ id: linkId, pac_source_provenance: null }],
    };
    if (sql.includes("or_candidate_finance_outside_source_proofs")) return { rows: options.outsideRows ?? [] };
    throw new Error("Unexpected SQL in read-only batch factory test");
  }) };
}
async function run(options: { db?: ReturnType<typeof database>; row?: OregonCandidateFinanceDueRow; refresh?: boolean } = {}) {
  return load({ db: options.db ?? database(), row: options.row ?? due(),
    refresh: options.refresh, clientOptions: { requestDelayMs: 0 } });
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.createClient.mockReturnValue(boundary.client);
  boundary.createCache.mockResolvedValue({ generationDir, writeCapture: boundary.writeCapture,
    readSavedPublicGet: boundary.readSaved });
  boundary.source.mockResolvedValue({ diagnostics: [] });
  boundary.writeCapture.mockResolvedValue(undefined);
  boundary.readSaved.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Oregon normal verified batch acquisition orchestration", () => {
  it("projects actual local GEOID into the numeric source seat without changing the link display district", async () => {
    const db = database();
    await run({ db });
    const input = boundary.source.mock.calls[0][0];
    expect(input.candidateContext).toEqual({ candidateId, electionId, committeeId: "21892",
      candidateName: "Adam Baker", electionYear: 2026, electionType: "General",
      officeName: "State Lower Chamber Legislator", district: "40" });
    expect(input.client).toBe(boundary.client);
    expect(db.query.mock.calls[0][1]).toEqual([candidateId, electionId, "21892"]);
    expect(db.query.mock.calls[0][0]).toContain("district.geoid_compact");
    expect(db.query.mock.calls[0][0]).toContain("ce.status NOT IN ('withdrawn', 'lost')");
    expect(db.query.mock.calls[1][1]).toEqual([candidateId, electionId, "21892", 2026]);
    expect(db.query.mock.calls[1][0]).toContain("link.link_status='active'");
    expect(db.query.mock.calls[2][1]).toEqual([linkId, 2026]);
    expect(db.query.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE|BEGIN|COMMIT)\b/.test(sql))).toBe(true);
  });
  it.each([
    { candidateName: "Different Person" }, { electionDate: "2025-11-03" },
    { electionStage: "primary" }, { districtState: "WA" }, { geoidCompact: "53040" },
    { geoidCompact: "4140" }, { officeName: "State Senator" }, { districtType: "state_upper" },
    { districtName: "Different district display" },
  ])("omits mismatched actual context before opening cache or source %j", overrides => {
    return run({ db: database({ localRows: [local(overrides)] }) }).then(result => {
      expect(result.components).toBeUndefined(); expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(boundary.createCache).not.toHaveBeenCalled(); expect(boundary.createClient).not.toHaveBeenCalled();
      expect(boundary.source).not.toHaveBeenCalled();
    });
  });
  it.each([
    { candidateName: "Changed Due Name" }, { electionYear: 2025 },
    { officeName: "Governor" }, { district: "40" },
  ])("omits mismatched due-link fields before source calls %j", overrides => {
    return run({ row: due(overrides) }).then(result => {
      expect(result.components).toBeUndefined(); expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(boundary.createCache).not.toHaveBeenCalled(); expect(boundary.createClient).not.toHaveBeenCalled();
    });
  });
  it("preserves when the actual candidate/election join is absent or nonunique", async () => {
    for (const localRows of [[], [local(), local()]]) {
      const db = database({ localRows });
      const result = await run({ db });
      expect(result.components).toBeUndefined(); expect(db.query).toHaveBeenCalledTimes(1);
    }
    expect(boundary.createCache).not.toHaveBeenCalled();
  });
  it("requires exactly one existing active receiving link before any artifact or government boundary", async () => {
    for (const priorRows of [[], [{ id: linkId, pac_source_provenance: null }, { id: electionId, pac_source_provenance: null }]]) {
      const db = database({ priorRows });
      const result = await run({ db });
      expect(result.components).toBeUndefined(); expect(result.diagnostics.join(" ")).toContain("no unique active receiving link");
      expect(db.query).toHaveBeenCalledTimes(2);
    }
    expect(boundary.createCache).not.toHaveBeenCalled(); expect(boundary.source).not.toHaveBeenCalled();
  });
  it("passes even unknown prior PAC/payer JSON as constraints and never promotes them into accepted results", async () => {
    const pac = { oldUnknownAuthority: true }, outside = { oldPayerAuthority: true };
    const result = await run({ db: database({ priorRows: [{ id: linkId, pac_source_provenance: pac }],
      outsideRows: [{ payer_committee_id: "23238", source_provenance: outside }] }) });
    const input = boundary.source.mock.calls[0][0];
    expect(input.priorPacProvenance).toBe(pac);
    expect(input.priorOutsideProvenanceByPayer).toEqual({ "23238": outside });
    expect(result.components).toBeUndefined();
  });
  it.each([false, true])("forwards refresh=%s and delegates original saved evidence and raw captures without retagging", async refresh => {
    const saved = { bytes: new Uint8Array([1, 2]), request: { startedAt: "2025-01-01T00:00:00.000Z" } };
    const capture = { syntheticObservedCapture: true };
    boundary.readSaved.mockResolvedValue(saved);
    const result = await load({ db: database(), row: due(), refresh, rawCacheDir: "/external/oregon-source-cache",
      clientOptions: { requestDelayMs: 0, userAgent: "Explicit source research UA", timeoutMs: 54321 } });
    expect(boundary.createCache).toHaveBeenCalledWith("/external/oregon-source-cache");
    const options = boundary.createClient.mock.calls[0][0], input = boundary.source.mock.calls[0][0];
    expect(options.userAgent).toBe("Explicit source research UA"); expect(options.timeoutMs).toBe(54321);
    expect(input.refresh).toBe(refresh);
    expect(await input.readSavedPublicGet("exact-source-url")).toBe(saved);
    expect(boundary.readSaved).toHaveBeenCalledWith("exact-source-url");
    await options.onRawResponse(capture);
    expect(boundary.writeCapture).toHaveBeenCalledWith(capture);
    expect(saved.request.startedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(result.generationDir).toBe(generationDir);
  });
  it("forwards configured fetch after the exact requested pacing delay", async () => {
    vi.useFakeTimers();
    const response = { syntheticTransportResponse: true }, fetchFn = vi.fn().mockResolvedValue(response);
    await load({ db: database(), row: due(), clientOptions: { fetchFn, requestDelayMs: 25 } });
    const options = boundary.createClient.mock.calls[0][0], init = { method: "GET", headers: { accept: "text/html" } };
    const pending = options.fetchFn("https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=21892", init);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24); expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toBe(response);
    expect(fetchFn).toHaveBeenCalledWith("https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=21892", init);
  });
  it("uses default cache and fetch with default250ms delay, and allows explicit zero pacing", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn().mockResolvedValue({ syntheticResponse: true }); vi.stubGlobal("fetch", fetchFn);
    await load({ db: database(), row: due() });
    expect(boundary.createCache).toHaveBeenCalledWith("scratch/oregon-campaign-finance/verified");
    const defaultFetch = boundary.createClient.mock.calls[0][0].fetchFn;
    const first = defaultFetch("source-url", {});
    await vi.advanceTimersByTimeAsync(249); expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await first; expect(fetchFn).toHaveBeenCalledTimes(1);
    await run();
    const zeroFetch = boundary.createClient.mock.calls[1][0].fetchFn;
    await zeroFetch("other-source-url", {}); expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it.each([-1, 0.5, NaN])("rejects invalid pacing %s before cache or source creation", async requestDelayMs => {
    await expect(load({ db: database(), row: due(), clientOptions: { requestDelayMs } })).rejects.toThrow("Invalid Oregon verified source request delay");
    expect(boundary.createCache).not.toHaveBeenCalled(); expect(boundary.createClient).not.toHaveBeenCalled();
  });
  // Source boundaries below are intentionally opaque mocks: these are routing tests, not financial proof.
  it.each(["pac", "outside", "both", "none", "empty-outside"] as const)("returns only source-loader components independently: %s", async kind => {
    const pac = { donors: [{ syntheticNamedDonor: true }], provenance: { syntheticSourceAuthority: true } };
    const outside = [{ syntheticScopedPositive: true }];
    const source = { diagnostics: ["Observed source boundary diagnostic"],
      ...(kind === "pac" || kind === "both" ? { pac } : {}),
      ...(kind === "outside" || kind === "both" ? { positiveOutsideEvidence: outside } : {}),
      ...(kind === "empty-outside" ? { positiveOutsideEvidence: [] } : {}),
    } as unknown as OregonVerifiedFinanceSourceLoaderResult;
    boundary.source.mockResolvedValue(source);
    const result = await run();
    expect(result.diagnostics).toBe(source.diagnostics); expect(result.generationDir).toBe(generationDir);
    if (kind === "none" || kind === "empty-outside") expect(result.components).toBeUndefined();
    else {
      expect(result.components?.candidateContext.district).toBe("40");
      expect(result.components?.pac).toBe(source.pac);
      expect(result.components?.positiveOutsideEvidence).toBe(source.positiveOutsideEvidence);
    }
  });
});

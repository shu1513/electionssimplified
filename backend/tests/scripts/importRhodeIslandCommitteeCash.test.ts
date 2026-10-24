import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImportRhodeIslandCashArgs as parse, runImportRhodeIslandCash as run } from "../../src/scripts/importRhodeIslandCommitteeCash.js";
import { loadRhodeIslandCanonicalCashContext } from "../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashContext.js";
import { loadRhodeIslandCashPacket } from "../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashSource.js";
import { writeRhodeIslandCashPacket } from "../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashWriter.js";
vi.mock("../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashContext.js", () => ({ loadRhodeIslandCanonicalCashContext: vi.fn() }));
vi.mock("../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashSource.js", () => ({ loadRhodeIslandCashPacket: vi.fn() }));
vi.mock("../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashWriter.js", () => ({ writeRhodeIslandCashPacket: vi.fn() }));
const args = ["--candidate-id", "11111111-1111-4111-8111-111111111111", "--election-id=22222222-2222-4222-8222-222222222222",
  "--org-id", "123", "--organization-name", "JORDAN EXAMPLE", "--reviewed-mapping", "--cache-dir", "/tmp/ri-example-cache"];
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_SYNC_ENABLED", "true");
  vi.mocked(loadRhodeIslandCanonicalCashContext).mockResolvedValue({ candidate_name: "Jordan Example", last_name: "Example", election_year: 2026,
    office_scope: "statewide", office_name: "Governor", district: null, district_type: "statewide", geoid_compact: "44" });
  vi.mocked(loadRhodeIslandCashPacket).mockResolvedValue({ reportCount: 7, receivingRows: 20, donors: [{}], selectedOccurrences: 2,
    totalCents: 200_000, coverageThrough: "2026-10-05", observedAt: "2026-10-24T09:00:00.000Z" } as any);
  vi.mocked(writeRhodeIslandCashPacket).mockResolvedValue({ status: "written", linkId: "example", donorsWritten: 1, reportedCashCents: 200_000 });
});
afterEach(() => vi.unstubAllEnvs());
describe("scoped Rhode Island verified-cache import", () => {
  it("parses exact scope and both value forms", () => {
    expect(parse(args)).toMatchObject({ committeeId: "123", committeeName: "JORDAN EXAMPLE", reviewedMapping: true, dryRun: false });
  });
  it.each([
    [...args, "--dry_run"], [...args, "unexpected"], [...args, "--dry-run=true"], [...args, "--org-id", "456"],
    args.filter(a => a !== "--reviewed-mapping"), args.map(a => a === "123" ? "not-numeric" : a),
    [...args, "--cache-dir"],
  ])("rejects typos, missing values, duplicate scopes or missing manual review", bad => {
    expect(() => parse(bad)).toThrow();
  });
  it.each(["RHODE_ISLAND_CAMPAIGN_FINANCE_ENABLED", "RHODE_ISLAND_CAMPAIGN_FINANCE_SYNC_ENABLED"])("requires both finance flags before any DB call", async flag => {
    vi.stubEnv(flag, "false"); await expect(run({ options: parse(args), db: {} as any })).rejects.toThrow(/finance_sync_disabled/);
    expect(loadRhodeIslandCanonicalCashContext).not.toHaveBeenCalled();
  });
  it("dry-runs real source qualification without calling the writer", async () => {
    expect(await run({ options: parse([...args, "--dry-run"]), db: {} as any })).toMatchObject({ accepted: 1, written: 0, receiving_rows: 20 });
    expect(loadRhodeIslandCashPacket).toHaveBeenCalled(); expect(writeRhodeIslandCashPacket).not.toHaveBeenCalled();
  });
  it("passes only the cache-minted packet and explicit reviewed mapping to the writer", async () => {
    const output = await run({ options: parse(args), db: {} as any });
    expect(output).toMatchObject({ accepted: 1, written: 1, committee_cash_cents: 200_000 });
    expect(writeRhodeIslandCashPacket).toHaveBeenCalledWith(expect.objectContaining({ packet: await vi.mocked(loadRhodeIslandCashPacket).mock.results[0]!.value, reviewedMapping: true }));
    expect(JSON.stringify(output)).not.toMatch(/JORDAN|EXAMPLE|OrgID|candidate_id|committee_id/);
  });
  it("reports an identical source as unchanged", async () => {
    vi.mocked(writeRhodeIslandCashPacket).mockResolvedValue({ status: "unchanged", linkId: "example", donorsWritten: 0, reportedCashCents: 200_000 });
    expect(await run({ options: parse(args), db: {} as any })).toMatchObject({ accepted: 1, written: 0, unchanged: 1 });
  });
  it("does not call the writer or return a financial zero on a missing source", async () => {
    vi.mocked(loadRhodeIslandCashPacket).mockRejectedValue(Error("source_missing"));
    await expect(run({ options: parse(args), db: {} as any })).rejects.toThrow(/source_missing/);
    expect(writeRhodeIslandCashPacket).not.toHaveBeenCalled();
  });
  it("refuses a missing canonical context before reading source data", async () => {
    vi.mocked(loadRhodeIslandCanonicalCashContext).mockResolvedValue(null);
    await expect(run({ options: parse(args), db: {} as any })).rejects.toThrow(/canonical_context_unavailable/);
    expect(loadRhodeIslandCashPacket).not.toHaveBeenCalled(); expect(writeRhodeIslandCashPacket).not.toHaveBeenCalled();
  });
});

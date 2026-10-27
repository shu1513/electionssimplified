import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRhodeIslandCf8Filer, readRhodeIslandCf8FilerCache } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCf8FilerCache.js";
import { assertRhodeIslandReviewedIePacket, loadRhodeIslandReviewedIePacket,
  rhodeIslandReviewedIeContextMatches } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandReviewedCf8Source.js";
import { GUID, NAME, portal, url } from "../../helpers/rhodeIslandCf8Fixtures.js";

const candidateId = "00000000-0000-0000-0000-000000000010", electionId = "00000000-0000-0000-0000-000000000011";
const canonical = { candidate_name: "Example Person", last_name: "Person", election_year: 2026,
  office_scope: "statewide", office_name: "Governor", district: null, district_type: "statewide", geoid_compact: "44" };
let cacheDir: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  cacheDir = await mkdtemp(join(tmpdir(), "ri-reviewed-cf8-source-"));
});
afterEach(() => vi.useRealTimers());
async function fixture() {
  await acquireRhodeIslandCf8Filer({ cacheDir, electionYear: 2026, spenderName: NAME, transport: portal().transport });
  const cache = await readRhodeIslandCf8FilerCache({ cacheDir, electionYear: 2026, spenderName: NAME });
  return { db: { query: vi.fn().mockResolvedValue({ rows: [{ ...canonical }] }) }, cacheDir, candidateId, electionId,
    electionYear: 2026, spenderName: NAME, reviewedSpenderNames: [NAME], reviewedMapping: true as const,
    reports: [{ filingGuid: GUID, sourceUrl: url(), sourceSha256: cache.scans[0]!.sha256, filedDate: "2026-10-10",
      reportedSpenderName: NAME, reportedCandidateName: "Example Person", supportOppose: "support" as const,
      review: { purpose: "independent_expenditure" as const, candidateCount: 1 as const, referendumCount: 0 as const,
        wholeReportRead: true as const, completeDisbursements: true as const, payerIdentityVerified: true as const, candidateElectionVerified: true as const },
      lines: [{ lineNumber: 1, disbursementDate: "2026-10-10", amountCents: 200 }], reportedYearToDateCents: 200 }] };
}
describe("cache-backed manually reviewed IE packets", () => {
  it("mints a frozen positive packet without a receiving link and retains original clocks", async () => {
    const input = await fixture(), packet = await loadRhodeIslandReviewedIePacket(input);
    const cache = await readRhodeIslandCf8FilerCache(input);
    expect(packet).toMatchObject({ context: { candidateId, electionId, candidateName: "Example Person" },
      supportCents: 200, occurrenceCount: 1, excludedNonIeReportCount: 1, sourceReportCount: 2 });
    expect(packet.observedAt).toBe(cache.observedAt);
    expect(packet.completedAt).toBe(cache.completedAt);
    expect(input.db.query.mock.calls[0]![0]).not.toContain("ri_candidate_finance_links");
    expect(() => assertRhodeIslandReviewedIePacket(packet)).not.toThrow();
    expect(() => assertRhodeIslandReviewedIePacket(structuredClone(packet))).toThrow("cache_backed_packet_required");
    expect(() => { packet.reports[0]!.lines[0]!.amountCents = 900; }).toThrow();
    input.reports[0]!.lines[0]!.amountCents = 900;
    expect(packet.reports[0]!.lines[0]!.amountCents).toBe(200);
  });
  it("rejects a transcription tied to different original bytes", async () => {
    const input = await fixture(); input.reports[0]!.sourceSha256 = "b".repeat(64);
    await expect(loadRhodeIslandReviewedIePacket(input)).rejects.toThrow("reviewed_original_changed");
  });
  it("requires explicit payer-body alias review instead of fuzzy label merging", async () => {
    const input = await fixture(); input.reports[0]!.reportedSpenderName = "Explicitly Reviewed Alternate Name";
    await expect(loadRhodeIslandReviewedIePacket(input)).rejects.toThrow("unreviewed_payer_body_name");
    input.reviewedSpenderNames.push("Explicitly Reviewed Alternate Name");
    await expect(loadRhodeIslandReviewedIePacket(input)).resolves.toMatchObject({ occurrenceCount: 1 });
  });
  it("rejects a conflicting candidate or stale canonical office/district", async () => {
    const input = await fixture(); input.reports[0]!.reportedCandidateName = "Different Person";
    await expect(loadRhodeIslandReviewedIePacket(input)).rejects.toThrow("reviewed_target_conflict");
    input.reports[0]!.reportedCandidateName = "Example Person";
    input.db.query.mockResolvedValue({ rows: [{ ...canonical, geoid_compact: "45" }] });
    await expect(loadRhodeIslandReviewedIePacket(input)).rejects.toThrow("canonical_context_or_district");
  });
  it("requires both reviewed mapping and a current canonical row", async () => {
    const input = await fixture();
    await expect(loadRhodeIslandReviewedIePacket({ ...input, reviewedMapping: false as never })).rejects.toThrow("manual_mapping_review_required");
    input.db.query.mockResolvedValue({ rows: [] });
    await expect(loadRhodeIslandReviewedIePacket(input)).rejects.toThrow("current_canonical_context");
  });
  it("does not permit stale mutable source evidence to advance a clock", async () => {
    const input = await fixture();
    vi.setSystemTime(Date.now() + 49 * 60 * 60 * 1000);
    await expect(loadRhodeIslandReviewedIePacket(input)).rejects.toThrow("mutable_source_refresh_required");
  });
  it("checks the same actual canonical district at selection and under a write lock", () => {
    const expected = { candidateId, electionId, candidateName: "Example Person", electionYear: 2026,
      officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "75" };
    const actual = { ...canonical, office_scope: expected.officeScope, office_name: expected.officeName,
      district: "75", district_type: "state_lower", geoid_compact: "44075" };
    expect(rhodeIslandReviewedIeContextMatches(actual, expected)).toBe(true);
    expect(rhodeIslandReviewedIeContextMatches({ ...actual, geoid_compact: "44076", district: "76" }, { ...expected, district: "76" })).toBe(false);
    expect(rhodeIslandReviewedIeContextMatches(null, expected)).toBe(false);
  });
});

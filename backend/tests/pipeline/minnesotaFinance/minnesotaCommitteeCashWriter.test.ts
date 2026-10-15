import { describe, expect, it, vi } from "vitest";
import {
  MINNESOTA_COMMITTEE_CASH_BASIS,
  validateMinnesotaCommitteeCashSnapshot,
  writeMinnesotaCommitteeCash,
  type MinnesotaCommitteeCashSnapshot,
} from "../../../src/pipeline/minnesotaFinance/minnesotaCommitteeCashWriter.js";

const SYNCED_AT = new Date("2026-10-15T21:00:00.000Z");
const SOURCE_URL = "https://register.cfb.mn.gov/reports-and-data/self-help/data-downloads/campaign-finance/";

function snapshot(): MinnesotaCommitteeCashSnapshot {
  return {
    aggregate: {
      donors: [
        { reportedCommitteeId: "100", reportedCommitteeName: "Example Fund", amountCents: 25000, contributionCount: 2 },
        { reportedCommitteeId: "100", reportedCommitteeName: "EXAMPLE FUND", amountCents: 12500, contributionCount: 1 },
      ],
      totalAmountCents: 37500, matchedContributionRowCount: 6, includedContributionRowCount: 3,
      excludedContributionRowCount: 2, zeroContributionRowCount: 1, excludedUnknownClassRowCount: 1,
    },
    source: { observedAt: "2026-10-15T20:00:00.000Z", sha256: "a".repeat(64), byteCount: 1200, rowCount: 8, url: SOURCE_URL },
  };
}

describe("Minnesota committee cash writer", () => {
  it("pairs a complete replacement to its source while preserving distinct literal names", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(writeMinnesotaCommitteeCash({
      db, linkId: "link-1", electionYear: 2026, snapshot: snapshot(), syncedAt: SYNCED_AT,
    })).resolves.toEqual({ donorsWritten: 2 });
    expect(db.query).toHaveBeenCalledTimes(4);
    expect(db.query.mock.calls[0]).toEqual([
      expect.stringContaining("DELETE FROM public.mn_candidate_finance_pac_donors"), ["link-1", 2026],
    ]);
    expect(db.query.mock.calls[1]?.[1]).toEqual([
      "link-1", 2026, MINNESOTA_COMMITTEE_CASH_BASIS, SOURCE_URL, "a".repeat(64), 1200, 8,
      "2026-10-15T20:00:00.000Z", "375.00", 6, 3, 2, 1, 1, SYNCED_AT.toISOString(),
    ]);
    expect(db.query.mock.calls.slice(2).map((call) => call[1])).toEqual([
      ["link-1", 2026, "100", "Example Fund", "250.00", 2, "a".repeat(64), SYNCED_AT.toISOString()],
      ["link-1", 2026, "100", "EXAMPLE FUND", "125.00", 1, "a".repeat(64), SYNCED_AT.toISOString()],
    ]);
    expect(db.query.mock.calls.every((call) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(String(call[0])))).toBe(true);
  });

  it("replaces a qualified empty component without manufacturing donor rows", async () => {
    const data = snapshot();
    data.aggregate = { donors: [], totalAmountCents: 0, matchedContributionRowCount: 2,
      includedContributionRowCount: 0, excludedContributionRowCount: 2, zeroContributionRowCount: 0,
      excludedUnknownClassRowCount: 1 };
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(writeMinnesotaCommitteeCash({
      db, linkId: "link-1", electionYear: 2026, snapshot: data, syncedAt: SYNCED_AT,
    })).resolves.toEqual({ donorsWritten: 0 });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1]?.[1]?.[8]).toBe("0.00");
  });

  it("serializes the largest safe cent integer without floating-point money conversion", async () => {
    const data = snapshot();
    data.aggregate.donors = [{ reportedCommitteeId: "100", reportedCommitteeName: "Example Fund",
      amountCents: Number.MAX_SAFE_INTEGER, contributionCount: 3 }];
    data.aggregate.totalAmountCents = Number.MAX_SAFE_INTEGER;
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await writeMinnesotaCommitteeCash({ db, linkId: "link-1", electionYear: 2026, snapshot: data, syncedAt: SYNCED_AT });
    expect(db.query.mock.calls[1]?.[1]?.[8]).toBe("90071992547409.91");
    expect(db.query.mock.calls[2]?.[1]?.[4]).toBe("90071992547409.91");
  });

  const invalidCases: [string, (data: MinnesotaCommitteeCashSnapshot) => void][] = [
    ["fractional cents", (data) => { data.aggregate.donors[0]!.amountCents = 0.5; }],
    ["unsafe cents", (data) => { data.aggregate.totalAmountCents = Number.MAX_SAFE_INTEGER + 1; }],
    ["fractional count", (data) => { data.aggregate.includedContributionRowCount = 1.5; }],
    ["count overflow", (data) => { data.source.rowCount = 2_147_483_648; }],
    ["total disagreement", (data) => { data.aggregate.totalAmountCents += 1; }],
    ["donor count disagreement", (data) => { data.aggregate.donors[0]!.contributionCount += 1; }],
    ["scope count disagreement", (data) => { data.aggregate.matchedContributionRowCount += 1; }],
    ["unknown count outside exclusions", (data) => { data.aggregate.excludedUnknownClassRowCount = 3; }],
    ["empty whole source", (data) => { data.source.rowCount = 0; }],
    ["source smaller than matched", (data) => { data.source.rowCount = 5; }],
    ["duplicate group", (data) => { data.aggregate.donors[1]!.reportedCommitteeName = "Example Fund"; }],
    ["nonnumeric reported account", (data) => { data.aggregate.donors[0]!.reportedCommitteeId = "unknown"; }],
    ["nonliteral normalized name", (data) => { data.aggregate.donors[0]!.reportedCommitteeName = " Example Fund "; }],
    ["name control character", (data) => { data.aggregate.donors[0]!.reportedCommitteeName = "Example\u0000Fund"; }],
    ["digest", (data) => { data.source.sha256 = "not-a-digest"; }],
    ["byte count", (data) => { data.source.byteCount = 0; }],
    ["observation time", (data) => { data.source.observedAt = "2026-10-15"; }],
    ["invalid calendar observation", (data) => { data.source.observedAt = "2026-02-30T20:00:00.000Z"; }],
    ["foreign source", (data) => { data.source.url = "https://example.com/source.csv"; }],
    ["non-HTTPS source", (data) => { data.source.url = "http://cfb.mn.gov/source.csv"; }],
    ["source credentials", (data) => { data.source.url = "https://user@cfb.mn.gov/source.csv"; }],
  ];
  it.each(invalidCases)("rejects %s before any SQL", async (_label, change) => {
    const data = snapshot();
    change(data);
    const db = { query: vi.fn() };
    expect(() => validateMinnesotaCommitteeCashSnapshot(data)).toThrow("Invalid Minnesota committee cash");
    await expect(writeMinnesotaCommitteeCash({
      db, linkId: "link-1", electionYear: 2026, snapshot: data, syncedAt: SYNCED_AT,
    })).rejects.toThrow("Invalid Minnesota committee cash");
    expect(db.query).not.toHaveBeenCalled();
  });
});

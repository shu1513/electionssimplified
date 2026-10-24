import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncDueColoradoNativeReceipts } from "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptBatchSync.js";
import { listColoradoIeReceivers } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeReceiver.js";
import { getColoradoNativeReceiptRegistry } from "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptSource.js";
import { ColoradoReportError } from "../../../src/pipeline/coloradoFinance/coloradoTracerReports.js";
vi.mock(
  "../../../src/pipeline/coloradoFinance/coloradoReportedIeReceiver.js",
  async (original) => ({
    ...(await original<object>()),
    listColoradoIeReceivers: vi.fn(),
    lockColoradoIeReceiver: vi.fn(),
  }),
);
vi.mock(
  "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptSource.js",
  async (original) => ({
    ...(await original<object>()),
    getColoradoNativeReceiptRegistry: vi.fn(),
  }),
);
const receiver = (end: string) => ({
  linkId: `00000000-0000-4000-8000-${end.padStart(12, "0")}`,
  candidateId: "00000000-0000-4000-8000-000000000002",
  electionId: "00000000-0000-4000-8000-000000000003",
  candidateName: "Ada Example",
  fullName: "Ada Example",
  linkCandidateName: "ADA EXAMPLE",
  party: "Democratic",
  officeName: "Governor",
  linkOffice: "Governor",
  linkSource: "manual",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingId: "202600001",
  receivingName: "Example Campaign",
  tracerCandidateId: "202600002",
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "false");
  for (const key of [
    "CANDIDATE_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_SYNC_ENABLED",
    "COLORADO_NATIVE_RECEIPTS_ENABLED",
  ])
    vi.stubEnv(key, "true");
});
afterEach(() => vi.unstubAllEnvs());
describe("Colorado independent native receipt due policy", () => {
  it("retries the oldest actual timestamp, regardless of weekday string order", async () => {
    const old = receiver("9"),
      recent = receiver("1");
    vi.mocked(listColoradoIeReceivers).mockResolvedValue([recent, old]);
    const attempts = [
      {
        link_id: old.linkId,
        election_year: 2026,
        receiver_context: old,
        source_revision: "co-native-cash-v1",
        last_attempted_at: new Date("2026-10-15T12:00:00Z"),
      },
      {
        link_id: recent.linkId,
        election_year: 2026,
        receiver_context: recent,
        source_revision: "co-native-cash-v1",
        last_attempted_at: new Date("2026-10-19T12:00:00Z"),
      },
    ];
    const query = vi.fn().mockImplementation(async (sql: string) => ({
        rows: sql.includes("co_native_receipt_attempts") ? attempts : [],
      })),
      transaction = vi.fn().mockResolvedValue({ rows: [] }),
      release = vi.fn(),
      connect = vi.fn().mockResolvedValue({ query: transaction, release });
    vi.mocked(getColoradoNativeReceiptRegistry).mockRejectedValue(
      new ColoradoReportError("native_receipt_source_unavailable"),
    );
    const result = await syncDueColoradoNativeReceipts({
      db: { query, connect } as never,
      now: new Date("2026-10-22T12:00:00Z"),
      maxCandidates: 1,
    });
    expect(
      transaction.mock.calls.find((c) =>
        String(c[0]).startsWith("INSERT INTO"),
      )![1][0],
    ).toBe(old.linkId);
    expect(result).toMatchObject({
      heldComponents: 1,
      writtenComponents: 0,
      holds: { native_receipt_source_unavailable: 1 },
    });
    expect(
      transaction.mock.calls.some((c) =>
        String(c[0]).includes("co_native_receipt_sources"),
      ),
    ).toBe(false);
  });
  it("uses source observation freshness independently of recent local sync clocks", async () => {
    const r = receiver("1");
    vi.mocked(listColoradoIeReceivers).mockResolvedValue([r]);
    const source = {
      link_id: r.linkId,
      election_year: 2026,
      receiver_context: r,
      source_facts: { revision: "co-native-cash-v1" },
      source_observed_at: new Date("2026-09-01T12:00:00Z"),
      last_synced_at: new Date("2026-10-22T12:00:00Z"),
    };
    const query = vi.fn().mockImplementation(async (sql: string) => ({
      rows: sql.includes("co_native_receipt_sources") ? [source] : [],
    }));
    const result = await syncDueColoradoNativeReceipts({
      db: { query, connect: vi.fn() } as never,
      now: new Date("2026-10-22T12:00:00Z"),
      dryRun: true,
    });
    expect(result).toMatchObject({
      totalDueRows: 1,
      selectedCandidates: 1,
      attemptedComponents: 0,
    });
    expect(
      query.mock.calls.every(
        (c) => !String(c[0]).includes("co_candidate_finance_summaries"),
      ),
    ).toBe(true);
  });
  it("cannot use refresh to bypass disabled sync", async () => {
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_SYNC_ENABLED", "false");
    const query = vi.fn();
    expect(
      await syncDueColoradoNativeReceipts({
        db: { query, connect: vi.fn() } as never,
        refresh: true,
      }),
    ).toMatchObject({ enabled: false, attemptedComponents: 0 });
    expect(query).not.toHaveBeenCalled();
    expect(listColoradoIeReceivers).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  overlayColoradoNativeReceiptPacket,
  overlayColoradoNativeReceipts,
} from "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptReader.js";
import { listColoradoIeReceivers } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeReceiver.js";
import { receiptPacket } from "./coloradoNativeReceiptFixtures.js";
vi.mock(
  "../../../src/pipeline/coloradoFinance/coloradoReportedIeReceiver.js",
  async (original) => ({
    ...(await original<object>()),
    listColoradoIeReceivers: vi.fn(),
  }),
);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  for (const f of [
    "CANDIDATE_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_ENABLED",
    "COLORADO_NATIVE_RECEIPTS_ENABLED",
  ])
    vi.stubEnv(f, "true");
  vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "false");
  vi.mocked(listColoradoIeReceivers).mockResolvedValue([
    receiptPacket().receiver,
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("Colorado native cash donor overlay", () => {
  it("preserves direct totals, IE and headline clocks while adding unsorted groups", () => {
    const p = receiptPacket(),
      base = overlayColoradoNativeReceiptPacket(undefined, p);
    base.last_synced_at = "2026-10-01T00:00:00Z";
    base.direct_campaign.total_raised = 3000;
    base.outside_spending.support_total = 1000;
    const result = overlayColoradoNativeReceiptPacket(base, p);
    expect(result.last_synced_at).toBe(base.last_synced_at);
    expect(result.direct_campaign.total_raised).toBe(3000);
    expect(result.outside_spending).toEqual(base.outside_spending);
    expect(result.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({
      interest_name: "Not yet sorted",
      amount: 100,
      pac_count: 1,
    });
    expect(result.direct_campaign.pac_money_coverage_note).toContain(
      "2022-12-09–2026-10-14",
    );
    expect(result.direct_campaign.pac_money_coverage_note).toContain(
      "Covered major-contributor notices count once",
    );
  });
  it("caps displayed names after computing all signed groups and counts", () => {
    const p = receiptPacket();
    p.groups = Array.from({ length: 7 }, (_, i) => ({
      key: `GROUP ${i}`,
      name: `Group ${i}`,
      cashCents: i === 0 ? -500 : 1000,
      occurrences: 1,
    }));
    p.controls = {
      ...p.controls,
      cashCents: 5500,
      allRows: 7,
      committeeRows: 7,
    };
    const result = overlayColoradoNativeReceiptPacket(undefined, p),
      interest = result.direct_campaign.pac_money_by_interest?.[0];
    expect(interest?.amount).toBe(55);
    expect(interest?.pac_count).toBe(7);
    expect(interest?.pacs).toHaveLength(5);
  });
  it("does no donor reads with its default-off flag disabled", async () => {
    vi.stubEnv("COLORADO_NATIVE_RECEIPTS_ENABLED", "false");
    const query = vi.fn(),
      base = new Map();
    expect(
      await overlayColoradoNativeReceipts({ query } as never, base, [], []),
    ).toBe(base);
    expect(query).not.toHaveBeenCalled();
  });
});

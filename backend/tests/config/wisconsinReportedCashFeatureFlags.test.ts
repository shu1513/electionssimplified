import { afterEach, describe, expect, it, vi } from "vitest";
import { isWisconsinCampaignFinanceRawDataRefreshEnabled, isWisconsinCampaignFinanceSyncEnabled, isWisconsinReportedCommitteeCashEnabled } from "../../src/config/featureFlags.js";
afterEach(() => vi.unstubAllEnvs());
describe("Wisconsin reported cash permission gates", () => {
  it("keeps new publication and source network off even when legacy sync is forced", () => {
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_SYNC_ENABLED", "false");
    vi.stubEnv("WISCONSIN_REPORTED_COMMITTEE_CASH_ENABLED", "false");
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "false");
    expect(isWisconsinCampaignFinanceSyncEnabled(true)).toBe(true);
    expect(isWisconsinReportedCommitteeCashEnabled()).toBe(false);
    expect(isWisconsinCampaignFinanceRawDataRefreshEnabled()).toBe(false);
  });
  it("permits private acquisition without granting publication", () => {
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("WISCONSIN_REPORTED_COMMITTEE_CASH_ENABLED", "false");
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    expect(isWisconsinCampaignFinanceRawDataRefreshEnabled()).toBe(true);
    expect(isWisconsinReportedCommitteeCashEnabled()).toBe(false);
  });
  it("requires the base state flag for either opt-in", () => {
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("WISCONSIN_REPORTED_COMMITTEE_CASH_ENABLED", "true");
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    expect(isWisconsinReportedCommitteeCashEnabled()).toBe(false);
    expect(isWisconsinCampaignFinanceRawDataRefreshEnabled()).toBe(false);
  });
});

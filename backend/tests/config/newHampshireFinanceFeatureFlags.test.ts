import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isNewHampshireCampaignFinanceEnabled,
  isNewHampshireCfsRawDataRefreshEnabled,
  isNewHampshireReportedIeEnabled,
  isNewHampshireReportedCommitteeReceiptsEnabled,
} from "../../src/config/featureFlags.js";

afterEach(() => vi.unstubAllEnvs());

describe("New Hampshire campaign-finance feature flags", () => {
  it("defaults both gates off", () => {
    vi.stubEnv("NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED", "");
    vi.stubEnv("NEW_HAMPSHIRE_CFS_RAW_DATA_REFRESH_ENABLED", "");
    expect(isNewHampshireCampaignFinanceEnabled()).toBe(false);
    expect(isNewHampshireCfsRawDataRefreshEnabled()).toBe(false);
  });

  it("requires the master gate and lets force bypass only the raw-refresh gate", () => {
    vi.stubEnv("NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("NEW_HAMPSHIRE_CFS_RAW_DATA_REFRESH_ENABLED", "true");
    expect(isNewHampshireCfsRawDataRefreshEnabled(true)).toBe(false);

    vi.stubEnv("NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("NEW_HAMPSHIRE_CFS_RAW_DATA_REFRESH_ENABLED", "false");
    expect(isNewHampshireCfsRawDataRefreshEnabled()).toBe(false);
    expect(isNewHampshireCfsRawDataRefreshEnabled(true)).toBe(true);
  });

  it("requires explicit independent publication gates and the master", () => {
    vi.stubEnv("NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("NEW_HAMPSHIRE_REPORTED_IE_ENABLED", "");
    vi.stubEnv("NEW_HAMPSHIRE_REPORTED_COMMITTEE_RECEIPTS_ENABLED", "");
    expect(isNewHampshireReportedIeEnabled()).toBe(false);
    expect(isNewHampshireReportedCommitteeReceiptsEnabled()).toBe(false);
    vi.stubEnv("NEW_HAMPSHIRE_REPORTED_IE_ENABLED", "true");
    expect(isNewHampshireReportedIeEnabled()).toBe(true);
    expect(isNewHampshireReportedCommitteeReceiptsEnabled()).toBe(false);
    vi.stubEnv("NEW_HAMPSHIRE_REPORTED_COMMITTEE_RECEIPTS_ENABLED", "true");
    expect(isNewHampshireReportedCommitteeReceiptsEnabled()).toBe(true);
    vi.stubEnv("NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED", "false");
    expect(isNewHampshireReportedIeEnabled()).toBe(false);
    expect(isNewHampshireReportedCommitteeReceiptsEnabled()).toBe(false);
  });
});

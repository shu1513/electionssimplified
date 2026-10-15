import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isMissouriCampaignFinanceRawDataRefreshEnabled,
  isMissouriCommitteeReceiptsEnabled,
} from "../../src/config/featureFlags.js";

afterEach(() => vi.unstubAllEnvs());

describe("Missouri committee receipt publication gate", () => {
  it("stays off by default even when raw acquisition is forced", () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", undefined);
    expect(isMissouriCampaignFinanceRawDataRefreshEnabled(true)).toBe(true);
    expect(isMissouriCommitteeReceiptsEnabled()).toBe(false);
  });

  it("requires both the existing source master flag and explicit receipt enablement", () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    expect(isMissouriCommitteeReceiptsEnabled()).toBe(false);
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    expect(isMissouriCommitteeReceiptsEnabled()).toBe(true);
  });
});

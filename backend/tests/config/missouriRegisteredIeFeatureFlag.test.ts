import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMissouriCampaignFinanceRawDataRefreshEnabled,
  isMissouriRegisteredIeEnabled,
} from "../../src/config/featureFlags.js";

afterEach(() => vi.unstubAllEnvs());

describe("Missouri registered IE publication gate", () => {
  it("stays off by default even when acquisition is forced", () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED", undefined);
    expect(isMissouriCampaignFinanceRawDataRefreshEnabled(true)).toBe(true);
    expect(isMissouriRegisteredIeEnabled()).toBe(false);
  });

  it("requires both the parent flag and explicit independent enablement", () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED", "true");
    expect(isMissouriRegisteredIeEnabled()).toBe(false);
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    expect(isMissouriRegisteredIeEnabled()).toBe(true);
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED", "false");
    expect(isMissouriRegisteredIeEnabled()).toBe(false);
  });
});

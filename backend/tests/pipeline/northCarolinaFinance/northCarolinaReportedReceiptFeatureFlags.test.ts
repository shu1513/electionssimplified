import { afterEach, describe, expect, it, vi } from "vitest";
import { isNorthCarolinaReportedCommitteeReceiptsEnabled } from "../../../src/config/featureFlags.js";

afterEach(() => vi.unstubAllEnvs());
function masters() {
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "true");
}
describe("North Carolina independent reported receipt gate", () => {
  it("defaults off even with both masters and force", () => {
    masters();
    vi.stubEnv("NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED", undefined);
    expect(isNorthCarolinaReportedCommitteeReceiptsEnabled()).toBe(false);
    expect(isNorthCarolinaReportedCommitteeReceiptsEnabled(true)).toBe(false);
  });
  it.each(["CANDIDATE_FINANCE_ENABLED", "NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED"])("requires %s even with child and force", (parent) => {
    masters();
    vi.stubEnv("NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED", "true");
    vi.stubEnv(parent, "false");
    expect(isNorthCarolinaReportedCommitteeReceiptsEnabled(true)).toBe(false);
  });
  it("can run independently while legacy direct sync is off", () => {
    masters();
    vi.stubEnv("NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED", "false");
    vi.stubEnv("NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED", "true");
    expect(isNorthCarolinaReportedCommitteeReceiptsEnabled()).toBe(true);
  });
});

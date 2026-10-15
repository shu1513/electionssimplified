import { afterEach, describe, expect, it, vi } from "vitest";
import { isGeorgiaReportedIeEnabled, isGeorgiaReportedCommitteeContributionsEnabled }
  from "../../../src/config/featureFlags.js";
afterEach(() => vi.unstubAllEnvs());
const children = ["GEORGIA_REPORTED_IE_ENABLED", "GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED"] as const;
describe("Georgia reported finance publication gates", () => {
  it("defaults off and cannot be enabled by force", () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true"); vi.stubEnv("GEORGIA_CAMPAIGN_FINANCE_ENABLED", "true");
    for (const child of children) vi.stubEnv(child, "");
    expect(isGeorgiaReportedIeEnabled()).toBe(false);
    expect(isGeorgiaReportedCommitteeContributionsEnabled()).toBe(false);
    expect(isGeorgiaReportedIeEnabled(true)).toBe(false);
    expect(isGeorgiaReportedCommitteeContributionsEnabled(true)).toBe(false);
  });
  it.each(["CANDIDATE_FINANCE_ENABLED", "GEORGIA_CAMPAIGN_FINANCE_ENABLED"])("requires parent %s", parent => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true"); vi.stubEnv("GEORGIA_CAMPAIGN_FINANCE_ENABLED", "true");
    for (const child of children) vi.stubEnv(child, "true");
    vi.stubEnv(parent, "false");
    expect(isGeorgiaReportedIeEnabled(true)).toBe(false);
    expect(isGeorgiaReportedCommitteeContributionsEnabled(true)).toBe(false);
  });
  it("keeps the two components independent", () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true"); vi.stubEnv("GEORGIA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv(children[0], "true"); vi.stubEnv(children[1], "false");
    expect(isGeorgiaReportedIeEnabled()).toBe(true);
    expect(isGeorgiaReportedCommitteeContributionsEnabled()).toBe(false);
    vi.stubEnv(children[0], "false"); vi.stubEnv(children[1], "true");
    expect(isGeorgiaReportedIeEnabled()).toBe(false);
    expect(isGeorgiaReportedCommitteeContributionsEnabled()).toBe(true);
  });
});

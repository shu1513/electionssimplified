import { afterEach, expect, it, vi } from "vitest";
import {
  isVirginiaReportedCommitteeEnabled as committee,
  isVirginiaReportedIeEnabled as ie,
  isVirginiaReportedRawRefreshEnabled as raw,
} from "../../../src/config/featureFlags.js";
afterEach(() => vi.unstubAllEnvs());
it("Virginia reported gates default off and require both masters", () => {
  for (const key of [
    "VIRGINIA_REPORTED_COMMITTEE_ENABLED",
    "VIRGINIA_REPORTED_IE_ENABLED",
    "VIRGINIA_REPORTED_RAW_REFRESH_ENABLED",
  ])
    vi.stubEnv(key, undefined);
  expect([committee(), ie(), raw()]).toEqual([false, false, false]);
  for (const key of [
    "CANDIDATE_FINANCE_ENABLED",
    "VIRGINIA_CAMPAIGN_FINANCE_ENABLED",
    "VIRGINIA_REPORTED_COMMITTEE_ENABLED",
    "VIRGINIA_REPORTED_IE_ENABLED",
    "VIRGINIA_REPORTED_RAW_REFRESH_ENABLED",
  ])
    vi.stubEnv(key, "true");
  expect([committee(), ie(), raw()]).toEqual([true, true, true]);
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
  expect([committee(), ie(), raw()]).toEqual([false, false, false]);
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "false");
  expect([committee(), ie(), raw()]).toEqual([false, false, false]);
});

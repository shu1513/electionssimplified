import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isColoradoReportedIeEnabled,
  isColoradoReportedIeRawRefreshEnabled,
} from "../../../src/config/featureFlags.js";
beforeEach(() => {
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "false");
  vi.stubEnv("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());
describe("Colorado independent source gates", () => {
  it("defaults to held without the explicit IE feature", () => {
    expect(isColoradoReportedIeEnabled()).toBe(false);
    expect(isColoradoReportedIeRawRefreshEnabled()).toBe(false);
  });
  it("requires both the feature and existing native download gate for network", () => {
    vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "true");
    expect(isColoradoReportedIeEnabled()).toBe(true);
    expect(isColoradoReportedIeRawRefreshEnabled()).toBe(false);
    vi.stubEnv("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED", "true");
    expect(isColoradoReportedIeRawRefreshEnabled()).toBe(true);
  });
  it.each(["CANDIDATE_FINANCE_ENABLED", "COLORADO_CAMPAIGN_FINANCE_ENABLED"])(
    "keeps master %s authoritative",
    (key) => {
      vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "true");
      vi.stubEnv("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED", "true");
      vi.stubEnv(key, "false");
      expect(isColoradoReportedIeEnabled()).toBe(false);
      expect(isColoradoReportedIeRawRefreshEnabled()).toBe(false);
    },
  );
  it("does not allow a force argument to release a disabled feature", () =>
    expect(
      (isColoradoReportedIeEnabled as (force?: boolean) => boolean)(true),
    ).toBe(false));
  it("does not read an invalid subflag while the source master is off", () => {
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "invalid");
    expect(isColoradoReportedIeEnabled()).toBe(false);
  });
});

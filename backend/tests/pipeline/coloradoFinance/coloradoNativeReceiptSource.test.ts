import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getColoradoNativeReceiptRegistry,
  getColoradoNativeReceiptsPacket,
} from "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptSource.js";
import {
  isColoradoNativeReceiptsEnabled,
  isColoradoNativeReceiptsRawRefreshEnabled,
} from "../../../src/config/featureFlags.js";
import { coloradoSourceUrl } from "../../../src/pipeline/coloradoFinance/coloradoTracerObservations.js";
import { receiptPacket } from "./coloradoNativeReceiptFixtures.js";
beforeEach(() => {
  for (const f of [
    "CANDIDATE_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_ENABLED",
    "COLORADO_NATIVE_RECEIPTS_ENABLED",
  ])
    vi.stubEnv(f, "true");
  vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "false");
  vi.stubEnv("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());
describe("separate native Colorado receipt source gates", () => {
  it("works with IE disabled and requires each global/source/raw gate", () => {
    expect(isColoradoNativeReceiptsEnabled()).toBe(true);
    expect(isColoradoNativeReceiptsRawRefreshEnabled()).toBe(false);
    vi.stubEnv("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED", "true");
    expect(isColoradoNativeReceiptsRawRefreshEnabled()).toBe(true);
    for (const f of [
      "COLORADO_NATIVE_RECEIPTS_ENABLED",
      "COLORADO_CAMPAIGN_FINANCE_ENABLED",
      "CANDIDATE_FINANCE_ENABLED",
    ]) {
      vi.stubEnv(f, "false");
      expect(isColoradoNativeReceiptsEnabled()).toBe(false);
      expect(isColoradoNativeReceiptsRawRefreshEnabled()).toBe(false);
      vi.stubEnv(f, "true");
    }
  });
  it("holds a missing saved packet without secretly downloading or inventing an empty registry", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "co-receipt-test-")),
      fetchFn = vi.fn();
    try {
      await expect(
        getColoradoNativeReceiptRegistry({
          cacheDir,
          electionYear: 2026,
          fetchFn,
        }),
      ).rejects.toThrow("native_receipt_source_unavailable");
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
  it("cannot inject a shape-only registry into the protected packet factory", async () => {
    await expect(
      getColoradoNativeReceiptsPacket({
        receiver: receiptPacket().receiver,
        registry: { rows: [], asOf: "2026-10-23" } as never,
      }),
    ).rejects.toThrow("receipt_unverified_registry");
  });
  it("allows both published report viewers and excludes unrelated source paths", () => {
    for (const path of [
      "/PublicSite/Reports/ReportViewer.aspx",
      "/PublicSite/Reserved.ReportViewerWebControl.axd",
      "/PublicSite/SearchPages/FilingDetail.aspx",
      "/PublicSite/SearchPages/FilingAmendmentSelect.aspx",
    ]) {
      expect(coloradoSourceUrl(path).pathname).toBe(path);
    }
    expect(() =>
      coloradoSourceUrl("https://example.com/ReportViewer.aspx"),
    ).toThrow("native_source_url");
    expect(() => coloradoSourceUrl("/PublicSite/private.aspx")).toThrow(
      "native_source_url",
    );
  });
});

import { IndianaNativePacCollector } from "../../../src/pipeline/indianaFinance/indianaNativePacCollector.js";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  aggregateIndianaNativePacGifts,
  validateIndianaNativePacClosure,
  inPacManifestHash,
  validateIndianaNativePacFacts,
  IN_NATIVE_PAC_REVISION,
  IndianaNativePacSource,
  type IndianaNativePacControls,
  type IndianaNativePacFacts,
} from "../../../src/pipeline/indianaFinance/indianaNativePacSource.js";
import { inHash } from "../../../src/pipeline/indianaFinance/indianaNativeOriginals.js";
import {
  isIndianaNativePacEnabled,
  isIndianaNativePacRawRefreshEnabled,
} from "../../../src/config/featureFlags.js";
import { writeIndianaNativePac } from "../../../src/pipeline/indianaFinance/indianaNativePacStore.js";
const gift = (kind: "Direct" | "In-Kind", cents: number) => ({
  url: "https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionDetail.aspx?Synthetic=one",
  cells: [],
  name: "Synthetic PAC",
  committee: "Synthetic Receiver",
  kind,
  day: "2026-10-01",
  cents,
  donorClass: "Political Action Committee" as const,
});
afterEach(() => vi.unstubAllEnvs());
describe("Indiana native raw acquisition gates", () => {
  it("does not fetch after incomplete saved evidence when raw refresh is disabled", async () => {
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
    vi.stubEnv("INDIANA_NATIVE_PAC_RAW_REFRESH_ENABLED", "false");
    const archive = { read: vi.fn().mockResolvedValue([]), observe: vi.fn() };
    await expect(
      new IndianaNativePacSource(archive as never).get(
        { receivingId: "123", electionYear: 2026 } as never,
        "2026-10-21",
      ),
    ).rejects.toThrow("independent_filing_inventory_missing");
    expect(archive.observe).not.toHaveBeenCalled();
  });
  it("checks the raw gate before creating any source original", async () => {
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "false");
    vi.stubEnv("INDIANA_NATIVE_PAC_RAW_REFRESH_ENABLED", "true");
    const archive = { observe: vi.fn() };
    await expect(
      new IndianaNativePacCollector(archive as never).collect(
        {} as never,
        "2026-10-21",
      ),
    ).rejects.toThrow("native_pac_raw_refresh_disabled");
    expect(archive.observe).not.toHaveBeenCalled();
  });
});
describe("Indiana native PAC admission and controls", () => {
  it("closes uncapped cash/in-kind groups with signed credits", () => {
    const groups = aggregateIndianaNativePacGifts([
      gift("Direct", 10000),
      gift("Direct", -3000),
      gift("In-Kind", 2500),
    ]);
    const controls: IndianaNativePacControls = {
      cashCents: 7000,
      inKindCents: 2500,
      totalCents: 9500,
      occurrences: 3,
      allRows: 8,
      pacRows: 3,
      excludedNonGiftRows: 0,
      regularReports: 3,
      coveredSupplements: 1,
    };
    expect(groups).toHaveLength(1);
    expect(() =>
      validateIndianaNativePacClosure(controls, groups),
    ).not.toThrow();
    expect(() =>
      validateIndianaNativePacClosure(
        { ...controls, totalCents: 10000 },
        groups,
      ),
    ).toThrow("native_pac_full_group_closure");
  });
  it("keeps the actual provenance digest stable across JSONB property reordering", () => {
    const time = new Date(Date.now() - 1000).toISOString();
    const observations = [
      {
        directory: "source-originals-00000000-0000-0000-0000-000000000000",
        meta: {
          url: "https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionSearch.aspx",
          file: "00001.original",
          requestFile: null,
          requestSha256: null,
          method: "GET" as const,
          status: 200,
          contentType: "text/html",
          startedAt: time,
          completedAt: time,
          bytes: 1,
          sha256: inHash("synthetic"),
          eof: true,
        },
      },
    ];
    const facts: IndianaNativePacFacts = {
      revision: IN_NATIVE_PAC_REVISION,
      from: "2025-01-01",
      through: "2026-10-21",
      regularThrough: "2026-10-09",
      observedAt: time,
      completedAt: time,
      manifestSha256: inPacManifestHash(observations),
      observations,
    };
    expect(() => validateIndianaNativePacFacts(facts)).not.toThrow();
    const reordered = structuredClone(facts);
    reordered.observations[0]!.meta = Object.fromEntries(
      Object.entries(reordered.observations[0]!.meta).reverse(),
    ) as (typeof observations)[0]["meta"];
    expect(() => validateIndianaNativePacFacts(reordered)).not.toThrow();
    expect(() =>
      validateIndianaNativePacFacts({
        ...facts,
        manifestSha256: "0".repeat(64),
      }),
    ).toThrow("native_pac_manifest_conflict");
  });
  it("rejects edited packets before connecting even when native publication is enabled", async () => {
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
    const connect = vi.fn();
    await expect(
      writeIndianaNativePac({ db: { connect } as never, packet: {} as never }),
    ).rejects.toThrow("unverified_native_pac_packet");
    expect(connect).not.toHaveBeenCalled();
  });
  it("defaults new gates off and never lets raw refresh enable the parent feature", () => {
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "false");
    vi.stubEnv("INDIANA_NATIVE_PAC_RAW_REFRESH_ENABLED", "true");
    expect(isIndianaNativePacEnabled()).toBe(false);
    expect(isIndianaNativePacRawRefreshEnabled()).toBe(false);
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
    expect(isIndianaNativePacRawRefreshEnabled()).toBe(true);
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "false");
    expect(isIndianaNativePacEnabled()).toBe(false);
    expect(isIndianaNativePacRawRefreshEnabled()).toBe(false);
  });
});

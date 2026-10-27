import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRhodeIslandReviewedIeArgs as parse, runRhodeIslandReviewedIeImport as run } from "../../src/scripts/importRhodeIslandReviewedIe.js";
afterEach(() => vi.unstubAllEnvs());
describe("RI reviewed IE stdin import boundary", () => {
  it("requires one cache directory and explicit manual mapping review", () => {
    expect(parse(["--cache-dir","/tmp/synthetic","--reviewed-mapping"])).toMatchObject({reviewedMapping:true,dryRun:false});
    expect(() => parse(["--cache-dir","/tmp/synthetic"])).toThrow("manual_mapping_review_required");
    expect(() => parse(["--cache-dir=x","--cache-dir=y","--reviewed-mapping"])).toThrow("one_cache_directory_required");
    expect(() => parse(["--cache-dir=x","--reviewed-mapping","--force"])).toThrow("unknown_cli_argument");
  });
  it("requires both finance flags before DB/source access", async () => {
    const db={query:vi.fn(),connect:vi.fn()} as any,options=parse(["--cache-dir=x","--reviewed-mapping"]);
    vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_ENABLED","false");vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_SYNC_ENABLED","true");
    await expect(run({db,options,payload:{} as any})).rejects.toThrow("finance_sync_disabled");expect(db.query).not.toHaveBeenCalled();
    vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_SYNC_ENABLED","false");
    await expect(run({db,options,payload:{} as any})).rejects.toThrow("finance_sync_disabled");expect(db.connect).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadIndianaCandidateFinanceSummariesByCandidateElection as load } from "../../../src/pipeline/indianaFinance/indianaBallotLookupFinanceLoader.js";
import * as native from "../../../src/pipeline/indianaFinance/indianaNativePacReader.js";

const candidates = [{ candidate_id: "candidate", election_id: "election" }];
const elections = [{ election_id: "election", state: "IN" }];
beforeEach(() => {
  vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "false");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Indiana finance loader failure isolation", () => {
  it("propagates legacy failures to the dispatcher's reporting path when native is disabled", async () => {
    const failure = new Error("synthetic legacy query failure");
    const db = { query: vi.fn().mockRejectedValue(failure) };
    const overlay = vi.spyOn(native, "overlayIndianaNativePacFinance");
    await expect(load(db, candidates, elections)).rejects.toBe(failure);
    expect(overlay).not.toHaveBeenCalled();
  });
  it("still tries independent native evidence when enabled and legacy fails", async () => {
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      query: vi.fn().mockRejectedValue(new Error("synthetic failure")),
    };
    const result = new Map();
    const overlay = vi
      .spyOn(native, "overlayIndianaNativePacFinance")
      .mockResolvedValue(result);
    await expect(load(db, candidates, elections)).resolves.toBe(result);
    expect(overlay).toHaveBeenCalledWith(db, new Map(), candidates, elections);
  });
  it("preserves legacy money when the enabled native overlay fails", async () => {
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              ...candidates[0],
              committee_id: "123",
              election_year: 2026,
              total_receipts: "150",
              direct_contribution_total: "100",
              source_url: null,
              last_synced_at: "2026-10-21T00:00:00.000Z",
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };
    vi.spyOn(native, "overlayIndianaNativePacFinance").mockRejectedValue(
      new Error("synthetic native failure"),
    );
    const result = await load(db, candidates, elections);
    expect([...result.values()][0]?.direct_campaign.total_raised).toBe(150);
  });
  it("does no work when the parent feature is disabled", async () => {
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
    const db = { query: vi.fn() };
    const overlay = vi.spyOn(native, "overlayIndianaNativePacFinance");
    await expect(load(db, candidates, elections)).resolves.toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
  });
});

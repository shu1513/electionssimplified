import { describe, expect, it, vi } from "vitest";

import {
  extractFamilySourceUrls,
  historicalDefaultIngestKey,
  resolveHistoricalImportDebugJson,
  resolveReinstateRetiredDebugJson,
  resolveReviewApproveFailureDebugJson,
  stageManualElectionPayload,
} from "../../src/scripts/injectManualElections.js";

describe("extractFamilySourceUrls", () => {
  it("normalizes and dedupes array values", () => {
    expect(
      extractFamilySourceUrls({
        family_source_urls: {
          judicial_office: ["https://example.gov/courts", "https://example.gov/courts"],
        },
      })
    ).toEqual({ judicial_office: ["https://example.gov/courts"] });
  });

  it("throws on a bare string instead of dropping the family silently", () => {
    expect(() =>
      extractFamilySourceUrls({ family_source_urls: { judicial_office: "https://example.gov/courts" } })
    ).toThrow(/family_source_urls\.judicial_office must be an array of URL strings/);
  });

  it("throws on an unknown contest family", () => {
    expect(() =>
      extractFamilySourceUrls({ family_source_urls: { school_board: ["https://example.gov/board"] } })
    ).toThrow(/family_source_urls\.school_board is not a known contest family/);
  });

  it("returns null when the payload carries no family_source_urls", () => {
    expect(extractFamilySourceUrls({ entries: [] })).toBeNull();
  });
});

describe("resolveReviewApproveFailureDebugJson", () => {
  it("returns null when review approval is not requested", () => {
    expect(resolveReviewApproveFailureDebugJson({}, false)).toBeNull();
    expect(
      resolveReviewApproveFailureDebugJson({ review_decision: "approve", review_reason: "ok" }, false)
    ).toBeNull();
  });

  it("stages soft_retry_count=1 so the validator's review-approve branch applies", () => {
    const json = resolveReviewApproveFailureDebugJson(
      {
        review_decision: "approve",
        review_reason: "official Alaska ballot title verified against the Division of Elections list",
      },
      true
    );
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as Record<string, unknown>;
    expect(parsed.soft_retry_count).toBe(1);
    expect(parsed.manual_review_approved).toBe(true);
    expect(typeof parsed.manual_approve_at).toBe("string");
    expect(parsed.soft_retry_at).toBeUndefined();
  });

  it("rejects review approval without an approve decision or reason", () => {
    expect(() =>
      resolveReviewApproveFailureDebugJson({ review_reason: "reason without decision" }, true)
    ).toThrow('--review-approve requires the payload to carry review_decision: "approve"');

    expect(() =>
      resolveReviewApproveFailureDebugJson({ review_decision: "approve", review_reason: "   " }, true)
    ).toThrow("--review-approve requires a non-empty payload review_reason");

    expect(() =>
      resolveReviewApproveFailureDebugJson({ review_decision: "reject", review_reason: "no" }, true)
    ).toThrow('--review-approve requires the payload to carry review_decision: "approve"');
  });
});

describe("resolveHistoricalImportDebugJson", () => {
  it("requires explicit review approval", () => {
    expect(() => resolveHistoricalImportDebugJson({}, true)).toThrow(
      '--historical requires the payload to carry review_decision: "approve"'
    );
    expect(() =>
      resolveHistoricalImportDebugJson({ review_decision: "approve", review_reason: " " }, true)
    ).toThrow("--historical requires a non-empty payload review_reason");
  });

  it("stamps an approved historical import", () => {
    const json = resolveHistoricalImportDebugJson(
      { review_decision: "approve", review_reason: "official dated result verified" },
      true
    );
    const parsed = JSON.parse(json!) as Record<string, unknown>;
    expect(parsed.historical_import_approved).toBe(true);
    expect(typeof parsed.historical_import_approved_at).toBe("string");
  });
});

describe("historicalDefaultIngestKey", () => {
  it("namespaces by the earliest entry election year, never the run year", () => {
    expect(
      historicalDefaultIngestKey("d-1", {
        entries: [{ election_date: "2026-06-02" }, { election_date: "2021-11-02" }],
      })
    ).toBe("manual:elections:d-1:historical:2021");
  });

  it("falls back to the run year when no entry carries a parseable date", () => {
    const runYear = new Date().getUTCFullYear();
    expect(historicalDefaultIngestKey("d-1", { entries: [] })).toBe(
      `manual:elections:d-1:historical:${runYear}`
    );
  });
});

describe("stageManualElectionPayload", () => {
  const options = {
    ingestKey: "manual:elections:11111111-1111-4111-8111-111111111111:2026",
    runId: "manual-test-run",
    payloadJson: JSON.stringify({ entries: [] }),
    failureDebugJson: null,
    aiRawDebugJson: JSON.stringify({ manual_research: true }),
  };

  it("does not publish when protected existing staging prevents the upsert", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const xAdd = vi.fn();

    const result = await stageManualElectionPayload(
      { query } as unknown as Parameters<typeof stageManualElectionPayload>[0],
      { xAdd } as unknown as Parameters<typeof stageManualElectionPayload>[1],
      { ...options, overwriteExisting: false }
    );

    expect(result).toEqual({ staged: false });
    expect(xAdd).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain(
      "staging_items.status IN ('failed', 'rejected', 'no_results')"
    );
    expect(query.mock.calls[0]?.[1]?.[9]).toBe(false);
  });

  it("publishes after a successful upsert", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ ingest_key: options.ingestKey }] });
    const xAdd = vi.fn().mockResolvedValue("123-0");

    const result = await stageManualElectionPayload(
      { query } as unknown as Parameters<typeof stageManualElectionPayload>[0],
      { xAdd } as unknown as Parameters<typeof stageManualElectionPayload>[1],
      options
    );

    expect(result).toEqual({ staged: true, redisMessageId: "123-0" });
    expect(xAdd).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]?.[9]).toBe(true);
  });
});

describe("resolveReinstateRetiredDebugJson", () => {
  it("returns null when neither the flag nor the payload field is set", () => {
    expect(resolveReinstateRetiredDebugJson({}, false)).toBeNull();
    expect(resolveReinstateRetiredDebugJson({ review_reason: "ok" }, false)).toBeNull();
  });

  it("refuses a payload that carries reinstate_retired without the CLI flag", () => {
    expect(() => resolveReinstateRetiredDebugJson({ reinstate_retired: true, review_reason: "ok" }, false)).toThrow(
      /re-run with --reinstate-retired/
    );
  });

  it("requires the payload field and a review_reason when the flag is passed", () => {
    expect(() => resolveReinstateRetiredDebugJson({}, true)).toThrow(/reinstate_retired: true/);
    expect(() => resolveReinstateRetiredDebugJson({ reinstate_retired: true }, true)).toThrow(/review_reason/);
  });

  it("stamps the approval marker the writer looks for", () => {
    const json = resolveReinstateRetiredDebugJson(
      { reinstate_retired: true, review_reason: "County clerk's certified ballot lists the race." },
      true
    );
    const parsed = JSON.parse(json!) as Record<string, unknown>;
    expect(parsed.reinstate_retired_approved).toBe(true);
    expect(typeof parsed.reinstate_retired_approved_at).toBe("string");
  });
});

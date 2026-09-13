import { describe, expect, it, vi } from "vitest";

import { parseRewritesFile, rewriteRollCallRecords } from "../../src/scripts/rewriteRollCallDescriptions.js";
import { buildCandidateRecordIdentityKey } from "../../src/pipeline/candidates/candidateRecordStore.js";

const ENTRY = {
  _current: { sentences: 6, chars: 600, problem: "has 6 sentences (max 3)" },
  jurisdiction: "DE",
  chamber: "house",
  session: "2163",
  roll: 1529458,
  measure_id: "HB 67",
  vote_date: "2025-03-27",
  yea_description: "Voted for House Bill 67, which caps tow fees. The Delaware House passed it 23-14.",
  nay_description: "Voted against House Bill 67, which caps tow fees. The Delaware House passed it 23-14.",
};

describe("parseRewritesFile", () => {
  it("reads entries and ignores operator notes", () => {
    const [entry] = parseRewritesFile({ rewrites: [ENTRY] });
    expect(entry).toMatchObject({ jurisdiction: "DE", chamber: "house", session: "2163", rollNumber: 1529458, measureId: "HB 67" });
  });

  it("rejects a duplicate roll, a bad chamber, and a missing sentence", () => {
    expect(() => parseRewritesFile({ rewrites: [ENTRY, ENTRY] })).toThrow(/appears more than once/);
    expect(() => parseRewritesFile({ rewrites: [{ ...ENTRY, chamber: "floor" }] })).toThrow(/chamber must be one of/);
    expect(() => parseRewritesFile({ rewrites: [{ ...ENTRY, nay_description: " " }] })).toThrow(/nay_description must be a non-empty string/);
    expect(() => parseRewritesFile({ rewrites: [] })).toThrow(/non-empty array/);
  });
});

describe("rewriteRollCallRecords", () => {
  const rewrite = parseRewritesFile({ rewrites: [ENTRY] })[0]!;
  const oldYea = "Voted for House Bill 67, which sets rules for towing. Long digest. The Delaware House passed it 23-14, and it became law.";
  const oldNay = "Voted against House Bill 67, which sets rules for towing. Long digest. The Delaware House passed it 23-14, and it became law.";
  const sourceUrl = "https://legiscan.com/DE/rollcall/HB67/id/1529458";
  const record = (id: string, candidate: string, description: string) => ({
    id,
    candidate_id: candidate,
    description,
    source_url: sourceUrl,
    event_date: "2025-03-27",
    record_identity_key: buildCandidateRecordIdentityKey({ description, sourceUrl, eventDate: "2025-03-27" }),
  });

  it("rewrites yea and nay rows, re-keys them, and leaves edited rows alone", async () => {
    const rows = [record("r1", "c1", oldYea), record("r2", "c2", oldNay), record("r3", "c3", "Hand-edited text. 23-14.")];
    const query = vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValue({ rows: [], rowCount: 1 });
    const result = await rewriteRollCallRecords({ query }, { rewrite, oldYeaDescription: oldYea, oldNayDescription: oldNay });
    expect(result).toEqual({ rewritten: 2, leftAlone: 1, leftAloneIds: ["r3"] });
    // select, then per rewritten row: update + transition + audit.
    expect(query).toHaveBeenCalledTimes(1 + 2 * 3);
    const [, updateSql, updateParams] = [query.mock.calls[1]![0], query.mock.calls[1]![0], query.mock.calls[1]![1]] as [string, string, unknown[]];
    expect(updateSql).toMatch(/UPDATE public.candidate_records/);
    expect(updateParams[2]).toBe(ENTRY.yea_description);
    expect(updateParams[3]).toBe(buildCandidateRecordIdentityKey({ description: ENTRY.yea_description, sourceUrl, eventDate: "2025-03-27" }));
    expect(query.mock.calls[2]![1]).toEqual(["c1", rows[0]!.record_identity_key, updateParams[3], "plain_language_rewrite"]);
    expect(query.mock.calls[3]![0]).toMatch(/plain_language_rewrites/);
    expect(query.mock.calls[3]![1]).toEqual(["r1", oldYea, ENTRY.yea_description, "manual", "rollcall-rewrite"]);
  });

  it("with staleToo, rewrites an older revision of the digest but not a hand-shortened row", async () => {
    const stale = "Voted against House Bill 67, which sets rules for towing. Older digest wording. More. Still more. The Delaware House passed it 23-14, and it became law.";
    const short = "Voted for House Bill 67, which caps towing fees. The Delaware House passed it 23-14, and it became law.";
    const rows = [record("r1", "c1", stale), record("r2", "c2", short), record("r3", "c3", "Hand-edited text. 23-14.")];
    const query = vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValue({ rows: [], rowCount: 1 });
    const result = await rewriteRollCallRecords({ query }, { rewrite, oldYeaDescription: oldYea, oldNayDescription: oldNay, staleToo: true });
    expect(result).toEqual({ rewritten: 1, leftAlone: 2, leftAloneIds: ["r2", "r3"] });
    expect((query.mock.calls[1]![1] as unknown[])[2]).toBe(ENTRY.nay_description);
  });

  it("fails loud when a row changed under the rewrite", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [record("r1", "c1", oldYea)] }).mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(rewriteRollCallRecords({ query }, { rewrite, oldYeaDescription: oldYea, oldNayDescription: oldNay })).rejects.toThrow(
      /record r1 changed under the rewrite/
    );
  });
});

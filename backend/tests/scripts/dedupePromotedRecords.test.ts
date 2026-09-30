import { describe, expect, it } from "vitest";

import {
  DELETE_DUPLICATES_SQL,
  planPromotedRecordDedupe,
  REHOME_CONTENT_REPORTS_SQL,
  REHOME_NOTIFICATION_EVENTS_SQL,
} from "../../src/scripts/dedupePromotedRecords.js";
import { recordKey, type RecordRow } from "../../src/scripts/promoteResearchData.js";

// Transition-map keys are recordKey-joined (NUL separator), never hand-built.
const candKey = (candidateId: string, key: string) =>
  recordKey({ candidate_id: candidateId, record_identity_key: key });

const recordRow = (overrides: Partial<RecordRow>): RecordRow => ({
  candidate_id: "c1",
  record_identity_key: "key",
  description: "Voted to adopt the budget for fiscal year 2025.",
  source_url: "https://example.gov/doc/1",
  event_date: "2024-03-06",
  created_at_utc: "2026-07-28 06:14:50.777574", retired_at_utc: null, retired_reason: null,
  origin: null,
  origin_run_id: null,
  ...overrides,
});

// Deterministic similarity: exact-match only. The production scorer is
// candidateRecordStore's own test surface.
const similarityOf = (a: string, b: string) => (a === b ? 1 : 0);
const normalizeUrl = (url: string) => url.trim().toLowerCase().replace(/\/+$/g, "");

describe("planPromotedRecordDedupe", () => {
  it("deletes the old-phrasing orphan whose keeper sibling the source still stands behind", () => {
    // The live incident's shape: the plain-language rewrite re-keyed the local
    // row, promotion inserted it as new, and the old-phrasing row stayed.
    const keeper = recordRow({ record_identity_key: "new-key", description: "Voted to adopt the 2025 budget." });
    const stale = recordRow({ record_identity_key: "old-key", description: "Voted to adopt the 2025 budget." });
    const plan = planPromotedRecordDedupe({
      sourceRows: [keeper],
      targetRows: [keeper, stale],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });

    expect(plan.deletions).toEqual([
      { staleRow: stale, keeperRow: keeper, similarity: 1, via: "similarity" },
    ]);
    expect(plan.unmatchedOrphans).toHaveLength(0);
  });

  it("deletes via the transition ledger even when the rewrite is beyond the similarity threshold", () => {
    // The 278-of-817 case: rewrites that rephrased too much for the 0.86
    // heuristic. The ledger names the successor exactly.
    const keeper = recordRow({
      record_identity_key: "new-key",
      description: "A completely rephrased plain-language description.",
    });
    const stale = recordRow({ record_identity_key: "old-key" });
    const plan = planPromotedRecordDedupe({
      sourceRows: [keeper],
      targetRows: [keeper, stale],
      normalizeUrl,
      similarityOf: () => 0,
      threshold: 0.86,
      transitions: new Map([[candKey("c1", "old-key"), "new-key"]]),
    });
    expect(plan.deletions).toEqual([
      { staleRow: stale, keeperRow: keeper, similarity: 1, via: "transition" },
    ]);
    expect(plan.unmatchedOrphans).toHaveLength(0);
  });

  it("does not delete a ledgered orphan whose successor is missing from the target", () => {
    // Old key on target, new key only local: that state is promotion's rekey
    // to fix in place — deleting here would drop the fact from the target.
    const localOnly = recordRow({ record_identity_key: "new-key" });
    const stale = recordRow({ record_identity_key: "old-key", description: "Different wording." });
    const plan = planPromotedRecordDedupe({
      sourceRows: [localOnly],
      targetRows: [stale],
      normalizeUrl,
      similarityOf: () => 0,
      threshold: 0.86,
      transitions: new Map([[candKey("c1", "old-key"), "new-key"]]),
    });
    expect(plan.deletions).toHaveLength(0);
    expect(plan.unmatchedOrphans).toEqual([stale]);
  });

  it("never deletes a row the source still holds, even amid duplicates", () => {
    const keeper = recordRow({ record_identity_key: "new-key" });
    const plan = planPromotedRecordDedupe({
      sourceRows: [keeper],
      targetRows: [keeper],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    expect(plan.deletions).toHaveLength(0);
    expect(plan.unmatchedOrphans).toHaveLength(0);
  });

  it("leaves an orphan alone when no keeper shares its candidate, date and URL", () => {
    // A locally deleted record is target-only too — that is promotion's
    // documented never-delete posture, not a duplicate.
    const keeper = recordRow({ record_identity_key: "new-key", source_url: "https://example.gov/doc/2" });
    const stale = recordRow({ record_identity_key: "old-key" });
    const plan = planPromotedRecordDedupe({
      sourceRows: [keeper],
      targetRows: [keeper, stale],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    expect(plan.deletions).toHaveLength(0);
    expect(plan.unmatchedOrphans).toEqual([stale]);
  });

  it("leaves an orphan alone when the sibling's description is not similar enough", () => {
    const keeper = recordRow({ record_identity_key: "new-key", description: "A different vote entirely." });
    const stale = recordRow({ record_identity_key: "old-key" });
    const plan = planPromotedRecordDedupe({
      sourceRows: [keeper],
      targetRows: [keeper, stale],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    expect(plan.deletions).toHaveLength(0);
    expect(plan.unmatchedOrphans).toEqual([stale]);
  });

  it("matches keepers on the normalized URL", () => {
    const keeper = recordRow({ record_identity_key: "new-key", source_url: "https://EXAMPLE.gov/doc/1/" });
    const stale = recordRow({ record_identity_key: "old-key" });
    const plan = planPromotedRecordDedupe({
      sourceRows: [keeper],
      targetRows: [keeper, stale],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    expect(plan.deletions).toHaveLength(1);
  });

  it("scopes matching to one candidate", () => {
    const keeper = recordRow({ record_identity_key: "new-key" });
    const stale = recordRow({ record_identity_key: "old-key", candidate_id: "c2" });
    const plan = planPromotedRecordDedupe({
      sourceRows: [keeper],
      targetRows: [keeper, stale],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    expect(plan.deletions).toHaveLength(0);
    expect(plan.unmatchedOrphans).toEqual([stale]);
  });

  it("handles several duplicates for one candidate independently", () => {
    const keeperA = recordRow({ record_identity_key: "new-a", description: "Fact A." });
    const staleA = recordRow({ record_identity_key: "old-a", description: "Fact A." });
    const keeperB = recordRow({
      record_identity_key: "new-b",
      description: "Fact B.",
      event_date: "2024-06-12",
      source_url: "https://example.gov/doc/9",
    });
    const staleB = recordRow({
      record_identity_key: "old-b",
      description: "Fact B.",
      event_date: "2024-06-12",
      source_url: "https://example.gov/doc/9",
    });
    const plan = planPromotedRecordDedupe({
      sourceRows: [keeperA, keeperB],
      targetRows: [keeperA, staleA, keeperB, staleB],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    expect(plan.deletions.map((deletion) => deletion.staleRow.record_identity_key).sort()).toEqual([
      "old-a",
      "old-b",
    ]);
  });
});

describe("rehome statements", () => {
  it("moves notification events to the keeper, skipping users the keeper already covers", () => {
    // Cascade-deleting events would erase the "already told this follower"
    // ledger and let a later worker re-notify the same fact under the
    // keeper's id.
    expect(REHOME_NOTIFICATION_EVENTS_SQL).toMatch(
      /UPDATE public\.user_candidate_follow_notification_events/
    );
    expect(REHOME_NOTIFICATION_EVENTS_SQL).toMatch(/SET candidate_record_id = m\.keeper_id/);
    expect(REHOME_NOTIFICATION_EVENTS_SQL).toMatch(/NOT EXISTS/);
    // One event per (user, event_type, keeper) WITHIN the statement: the
    // plan may map several stale rows onto one keeper, and NOT EXISTS only
    // sees the statement-start snapshot — without the DISTINCT ON, two
    // same-user events would collide on the partial unique index and abort
    // the whole cleanup transaction.
    expect(REHOME_NOTIFICATION_EVENTS_SQL).toMatch(/DISTINCT ON \(e\.user_id, e\.event_type, p\.keeper_id\)/);
    expect(REHOME_NOTIFICATION_EVENTS_SQL).not.toMatch(/\bDELETE\b/i);
  });

  it("re-points content reports at the keeper — no FK means they would silently dangle", () => {
    expect(REHOME_CONTENT_REPORTS_SQL).toMatch(/UPDATE public\.content_reports/);
    expect(REHOME_CONTENT_REPORTS_SQL).toMatch(/entity_type = 'candidate_record'/);
    expect(REHOME_CONTENT_REPORTS_SQL).toMatch(/SET entity_id = p\.keeper_id/);
    expect(REHOME_CONTENT_REPORTS_SQL).not.toMatch(/\bDELETE\b/i);
  });

  it("resolves stale and keeper ids from natural keys at execution time", () => {
    for (const sql of [REHOME_NOTIFICATION_EVENTS_SQL, REHOME_CONTENT_REPORTS_SQL]) {
      expect(sql).toMatch(/keeper_record_identity_key/);
      expect(sql).toMatch(/JOIN public\.candidate_records AS keeper/);
    }
  });
});

describe("DELETE_DUPLICATES_SQL", () => {
  it("deletes only candidate_records rows addressed by their full natural key", () => {
    expect(DELETE_DUPLICATES_SQL).toMatch(/DELETE FROM public\.candidate_records/);
    expect(DELETE_DUPLICATES_SQL).toMatch(/t\.candidate_id = s\.candidate_id/);
    expect(DELETE_DUPLICATES_SQL).toMatch(/t\.record_identity_key = s\.record_identity_key/);
    expect(DELETE_DUPLICATES_SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(DELETE_DUPLICATES_SQL).not.toMatch(/\bDROP\b/i);
  });
});

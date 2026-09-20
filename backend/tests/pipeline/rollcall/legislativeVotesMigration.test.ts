import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CANDIDATE_RECORD_ORIGINS } from "../../../src/pipeline/candidates/candidateRecordStore.js";
import {
  LEGISLATIVE_VOTE_CHAMBERS,
  LEGISLATIVE_VOTE_REVIEW_STATUSES,
} from "../../../src/pipeline/rollcall/legislativeVotes.js";
import { migrationTableColumns } from "../../helpers/migrationTableColumns.js";

const MIGRATION_251_SQL = readFileSync(
  new URL("../../../../db/migrations/251_add_legislative_votes.sql", import.meta.url),
  "utf8"
);
const MIGRATION_252_SQL = readFileSync(
  new URL("../../../../db/migrations/252_add_rollcall_import_record_origin.sql", import.meta.url),
  "utf8"
);
const MIGRATION_289_SQL = readFileSync(
  new URL("../../../../db/migrations/289_add_travel_import_record_origin.sql", import.meta.url),
  "utf8"
);

/**
 * The exact string literals inside a named CHECK (... IN ('a', 'b')) — so the
 * comparison is two-way: an extra SQL value fails as surely as a missing one,
 * and a value mentioned only in a comment does not count.
 */
function checkConstraintValues(sql: string, constraintName: string): string[] {
  const start = sql.search(new RegExp(`CONSTRAINT ${constraintName}\\s+CHECK`));
  expect(start, constraintName).toBeGreaterThanOrEqual(0);
  const body = sql.slice(start + "CONSTRAINT ".length);
  const end = Math.min(
    ...[body.indexOf("CONSTRAINT "), body.indexOf(";")].filter((index) => index >= 0)
  );
  return [...body.slice(0, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe("legislative votes migration", () => {
  it("keeps chamber and review_status CHECKs exactly aligned with the code enums", () => {
    expect(checkConstraintValues(MIGRATION_251_SQL, "legislative_votes_chamber_check")).toEqual(
      [...LEGISLATIVE_VOTE_CHAMBERS].sort()
    );
    expect(
      checkConstraintValues(MIGRATION_251_SQL, "legislative_votes_review_status_check")
    ).toEqual([...LEGISLATIVE_VOTE_REVIEW_STATUSES].sort());
  });

  it("builds every column the plan's data model names", () => {
    const columns = migrationTableColumns("legislative_votes");
    for (const column of [
      "jurisdiction",
      "chamber",
      "session",
      "roll_number",
      "vote_date",
      "measure_id",
      "exact_question",
      "voted_text_version",
      "is_floor_vote",
      "result",
      "yeas",
      "nays",
      "display_url",
      "machine_url",
      "bill_url",
      "source_sha256",
      "fetched_at",
      "yea_description",
      "nay_description",
      "labels_json",
      // The reviewed sine-die date override (migration 257).
      "official_vote_date",
      "review_status",
      "reviewed_at",
      "importer_version",
    ]) {
      expect(columns.has(column), column).toBe(true);
    }
  });

  it("only lets a judged floor vote be approved, and freezes it once approved", () => {
    expect(MIGRATION_251_SQL).toContain("legislative_votes_approved_fields_check");
    expect(MIGRATION_251_SQL).toContain("review_status <> 'approved'");
    expect(MIGRATION_251_SQL).toContain("is_floor_vote = true");
    expect(MIGRATION_251_SQL).toContain("jsonb_array_length(coalesce(labels_json, '[]'::jsonb)) > 0");
    expect(MIGRATION_251_SQL).toContain("trg_reject_approved_legislative_vote_edit");
  });
});

describe("candidate_records origin migration", () => {
  it("keeps the origin CHECK exactly aligned with CandidateRecordOrigin", () => {
    expect(checkConstraintValues(MIGRATION_289_SQL, "candidate_records_origin_check")).toEqual(
      [...CANDIDATE_RECORD_ORIGINS].sort()
    );
    // 252 is the earlier list: everything it allowed is still allowed.
    for (const origin of checkConstraintValues(MIGRATION_252_SQL, "candidate_records_origin_check")) {
      expect(CANDIDATE_RECORD_ORIGINS).toContain(origin);
    }
  });
});

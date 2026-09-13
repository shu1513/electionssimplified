import type { Pool } from "pg";

import { parseFederalMeasure } from "./federalMeasures.js";
import type { LegislativeVoteChamber, LegislativeVoteReviewStatus } from "./legislativeVotes.js";
import { describeRollCallDescriptionLengthProblem } from "./rollCallDescriptionLength.js";

type Queryable = Pick<Pool, "query">;

// The columns the fetcher owns on public.legislative_votes (migration 251).
// Judgment columns (yea_description, nay_description, labels_json,
// official_vote_date, review_status, reviewed_at) are written only by
// applyLegislativeVoteJudgment (rollcall:judge) and read by the importer
// (loadLegislativeVote).
export type LegislativeVoteSourceRow = {
  jurisdiction: string;
  chamber: LegislativeVoteChamber;
  session: string;
  rollNumber: number;
  // ISO date, YYYY-MM-DD.
  voteDate: string;
  measureId: string | null;
  exactQuestion: string;
  isFloorVote: boolean | null;
  result: string;
  yeas: number;
  nays: number;
  displayUrl: string;
  machineUrl: string;
  billUrl: string | null;
  sourceSha256: string;
  fetchedAt: Date;
  importerVersion: string;
};

export type LegislativeVoteUpsertOutcome =
  // No row for this roll key yet.
  | "inserted"
  // Row existed and at least one source field differs (the feed republished,
  // or the parser/classifier changed).
  | "updated"
  // Row existed with identical source fields; only fetched_at and
  // importer_version advanced.
  | "unchanged"
  // Row is approved and the source differs. Approval covers the row as the
  // reviewer saw it, so nothing is written (the DB trigger would reject it
  // anyway); the run report surfaces it for a human to re-review.
  | "approved_conflict";

export type LegislativeVoteUpsertResult = {
  outcome: LegislativeVoteUpsertOutcome;
  id: string;
  reviewStatus: LegislativeVoteReviewStatus;
  // True when an update changed what the judgment is ABOUT (the question or
  // the measure), so the stored sentences/labels were cleared and the row
  // went back to pending for a fresh AI pass and review.
  judgmentCleared: boolean;
};

type ExistingRow = {
  id: string;
  review_status: LegislativeVoteReviewStatus;
  vote_date: string;
  measure_id: string | null;
  exact_question: string;
  is_floor_vote: boolean | null;
  result: string;
  yeas: number;
  nays: number;
  display_url: string;
  machine_url: string;
  bill_url: string | null;
  source_sha256: string;
};

// The AI sentences and labels are written against the question and the
// measure. Tallies, result, date, URLs, and the file hash can all change
// (the Senate republishes with a modify_date; the House corrects totals)
// without changing what the vote was about, so they never discard a paid
// judgment or a reviewer's decision.
function judgmentInputsMatch(existing: ExistingRow, row: LegislativeVoteSourceRow): boolean {
  return existing.exact_question === row.exactQuestion && existing.measure_id === row.measureId;
}

function sourceFieldsMatch(existing: ExistingRow, row: LegislativeVoteSourceRow): boolean {
  return (
    existing.vote_date === row.voteDate &&
    existing.measure_id === row.measureId &&
    existing.exact_question === row.exactQuestion &&
    existing.is_floor_vote === row.isFloorVote &&
    existing.result === row.result &&
    existing.yeas === row.yeas &&
    existing.nays === row.nays &&
    existing.display_url === row.displayUrl &&
    existing.machine_url === row.machineUrl &&
    existing.bill_url === row.billUrl &&
    existing.source_sha256 === row.sourceSha256
  );
}

/**
 * Writes one fetched roll call under its (jurisdiction, chamber, session,
 * roll_number) key. Each call is its own statement pair — no transaction —
 * so one bad roll call never holds up the rest of a run.
 */
export async function upsertLegislativeVoteSource(
  db: Queryable,
  row: LegislativeVoteSourceRow
): Promise<LegislativeVoteUpsertResult> {
  const existing = await db.query<ExistingRow>(
    `SELECT id,
            review_status,
            vote_date::text AS vote_date,
            measure_id,
            exact_question,
            is_floor_vote,
            result,
            yeas,
            nays,
            display_url,
            machine_url,
            bill_url,
            source_sha256
       FROM legislative_votes
      WHERE jurisdiction = $1
        AND chamber = $2
        AND session = $3
        AND roll_number = $4`,
    [row.jurisdiction, row.chamber, row.session, row.rollNumber]
  );
  const current = existing.rows[0];

  if (!current) {
    const inserted = await db.query<{ id: string; review_status: LegislativeVoteReviewStatus }>(
      `INSERT INTO legislative_votes (
         jurisdiction, chamber, session, roll_number, vote_date, measure_id,
         exact_question, is_floor_vote, result, yeas, nays, display_url,
         machine_url, bill_url, source_sha256, fetched_at, importer_version
       ) VALUES (
         $1, $2, $3, $4, $5::date, $6,
         $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16::timestamptz, $17
       )
       RETURNING id, review_status`,
      [
        row.jurisdiction,
        row.chamber,
        row.session,
        row.rollNumber,
        row.voteDate,
        row.measureId,
        row.exactQuestion,
        row.isFloorVote,
        row.result,
        row.yeas,
        row.nays,
        row.displayUrl,
        row.machineUrl,
        row.billUrl,
        row.sourceSha256,
        row.fetchedAt.toISOString(),
        row.importerVersion,
      ]
    );
    const created = inserted.rows[0]!;
    return { outcome: "inserted", id: created.id, reviewStatus: created.review_status, judgmentCleared: false };
  }

  if (sourceFieldsMatch(current, row)) {
    await db.query(
      `UPDATE legislative_votes
          SET fetched_at = $2::timestamptz,
              importer_version = $3
        WHERE id = $1`,
      [current.id, row.fetchedAt.toISOString(), row.importerVersion]
    );
    return { outcome: "unchanged", id: current.id, reviewStatus: current.review_status, judgmentCleared: false };
  }

  if (current.review_status === "approved") {
    return {
      outcome: "approved_conflict",
      id: current.id,
      reviewStatus: current.review_status,
      judgmentCleared: false,
    };
  }

  // A different question or measure makes any stored judgment a judgment
  // of something else; a reviewer must not be able to approve it. Clearing
  // the sentences/labels and returning to pending keeps the
  // approved_fields and reviewed_at CHECKs satisfied.
  const judgmentCleared = !judgmentInputsMatch(current, row);
  const judgmentReset = judgmentCleared
    ? `,
            yea_description = NULL,
            nay_description = NULL,
            labels_json = NULL,
            official_vote_date = NULL,
            review_status = 'pending',
            reviewed_at = NULL`
    : "";

  await db.query(
    `UPDATE legislative_votes
        SET vote_date = $2::date,
            measure_id = $3,
            exact_question = $4,
            is_floor_vote = $5,
            result = $6,
            yeas = $7,
            nays = $8,
            display_url = $9,
            machine_url = $10,
            bill_url = $11,
            source_sha256 = $12,
            fetched_at = $13::timestamptz,
            importer_version = $14${judgmentReset}
      WHERE id = $1`,
    [
      current.id,
      row.voteDate,
      row.measureId,
      row.exactQuestion,
      row.isFloorVote,
      row.result,
      row.yeas,
      row.nays,
      row.displayUrl,
      row.machineUrl,
      row.billUrl,
      row.sourceSha256,
      row.fetchedAt.toISOString(),
      row.importerVersion,
    ]
  );
  return {
    outcome: "updated",
    id: current.id,
    reviewStatus: judgmentCleared ? "pending" : current.review_status,
    judgmentCleared,
  };
}

// What the fan-out needs from one reviewed row.
export type LegislativeVoteForImport = {
  id: string;
  voteDate: string;
  // The reviewed override for a source that stamped the legislative day
  // (migration 257). The fan-out's event_date is officialVoteDate ??
  // voteDate; every evidence-vs-row check stays on voteDate.
  officialVoteDate: string | null;
  measureId: string | null;
  exactQuestion: string;
  isFloorVote: boolean | null;
  yeas: number;
  nays: number;
  machineUrl: string;
  sourceSha256: string;
  yeaDescription: string | null;
  nayDescription: string | null;
  labelsJson: unknown;
  reviewStatus: LegislativeVoteReviewStatus;
};

export async function loadLegislativeVote(
  db: Queryable,
  key: { jurisdiction: string; chamber: LegislativeVoteChamber; session: string; rollNumber: number }
): Promise<LegislativeVoteForImport | null> {
  const result = await db.query<{
    id: string;
    vote_date: string;
    official_vote_date: string | null;
    measure_id: string | null;
    exact_question: string;
    is_floor_vote: boolean | null;
    yeas: number;
    nays: number;
    machine_url: string;
    source_sha256: string;
    yea_description: string | null;
    nay_description: string | null;
    labels_json: unknown;
    review_status: LegislativeVoteReviewStatus;
  }>(
    `SELECT id,
            vote_date::text AS vote_date,
            official_vote_date::text AS official_vote_date,
            measure_id,
            exact_question,
            is_floor_vote,
            yeas,
            nays,
            machine_url,
            source_sha256,
            yea_description,
            nay_description,
            labels_json,
            review_status
       FROM legislative_votes
      WHERE jurisdiction = $1
        AND chamber = $2
        AND session = $3
        AND roll_number = $4`,
    [key.jurisdiction, key.chamber, key.session, key.rollNumber]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    voteDate: row.vote_date,
    officialVoteDate: row.official_vote_date,
    measureId: row.measure_id,
    exactQuestion: row.exact_question,
    isFloorVote: row.is_floor_vote,
    yeas: row.yeas,
    nays: row.nays,
    machineUrl: row.machine_url,
    sourceSha256: row.source_sha256,
    yeaDescription: row.yea_description,
    nayDescription: row.nay_description,
    labelsJson: row.labels_json,
    reviewStatus: row.review_status,
  };
}

/**
 * Re-reads the row inside the fan-out's transaction, holding a share lock so
 * a reviewer's "back to pending" cannot commit underneath the write, and
 * checks that what is about to fan out is still the approved judgment: the
 * row was loaded seconds earlier, before the sentence validation's network
 * round trip, and a revoked or re-approved judgment must not replicate.
 */
export async function assertLegislativeVoteStillApproved(db: Queryable, vote: LegislativeVoteForImport): Promise<void> {
  const result = await db.query<{
    review_status: LegislativeVoteReviewStatus;
    source_sha256: string;
    official_vote_date: string | null;
    yea_description: string | null;
    nay_description: string | null;
    labels_json: unknown;
  }>(
    `SELECT review_status, source_sha256, official_vote_date::text AS official_vote_date, yea_description, nay_description, labels_json
       FROM legislative_votes
      WHERE id = $1
      FOR SHARE`,
    [vote.id]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`legislative_votes row ${vote.id} no longer exists`);
  }
  if (row.review_status !== "approved") {
    throw new Error(`legislative_votes row ${vote.id} is ${row.review_status} now; approval was withdrawn during the run`);
  }
  if (
    row.source_sha256 !== vote.sourceSha256 ||
    row.official_vote_date !== vote.officialVoteDate ||
    row.yea_description !== vote.yeaDescription ||
    row.nay_description !== vote.nayDescription ||
    JSON.stringify(row.labels_json) !== JSON.stringify(vote.labelsJson)
  ) {
    throw new Error(`legislative_votes row ${vote.id} was re-approved with different content during the run`);
  }
}

export type LegislativeVoteJudgment = {
  jurisdiction: string;
  chamber: LegislativeVoteChamber;
  session: string;
  rollNumber: number;
  // What the judgment was written about, so a roll number that is mistyped
  // onto another existing roll call cannot carry these sentences with it.
  // measureId compares as a parsed measure (`H R 1` and `H.R. 1` agree).
  measureId: string | null;
  voteDate: string;
  // The official record's date, when the source stamped the legislative day
  // instead (an overnight sine-die vote). null = no override; the whole
  // judgment is written as given, so re-applying with null clears one.
  officialVoteDate: string | null;
  yeaDescription: string;
  nayDescription: string;
  // Already shape-checked (see parseRollCallLabels); stored as given. `nay`
  // is the authored nay-side stance (null = nay voters get no tag on that
  // slug), never an inversion of `yea`.
  labels: readonly { slug: string; yea: "for" | "against" | null; nay: "for" | "against" | null }[];
  // Later kept floor votes on the same measure+chamber the operator has
  // seen and still wants to approve past (see the superseded-stage gate).
  acknowledgeLaterRolls: readonly number[];
  reviewStatus: "pending" | "approved";
};

export type LegislativeVoteJudgmentOutcome =
  // Same sentences, labels, and status already on the row.
  | "unchanged"
  // Sentences/labels and/or status written.
  | "updated";

// jsonb stores object keys in its own order (shorter first), so stored
// labels and the file's labels are compared element by element, not as
// serialized strings.
function canonicalLabels(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return JSON.stringify(
    value.map((element) => {
      const { slug, yea, nay } = (element ?? {}) as { slug?: unknown; yea?: unknown; nay?: unknown };
      return [slug ?? null, yea ?? null, nay ?? null];
    })
  );
}

function sameMeasure(stored: string | null, expected: string | null): boolean {
  const a = parseFederalMeasure(stored);
  const b = parseFederalMeasure(expected);
  if (a === null || b === null) {
    return a === b && (stored ?? "").trim().toUpperCase() === (expected ?? "").trim().toUpperCase();
  }
  return a.type === b.type && a.number === b.number;
}

/**
 * Writes one roll call's judgment (the two sentences, the labels, and the
 * review decision) onto its legislative_votes row. Call inside a
 * transaction: the row is locked, and a row that is already approved with a
 * different judgment is moved back to pending first, since the freeze
 * trigger (migration 251) lets an approved row change only through pending.
 * The importer then rewrites any records it already fanned out.
 *
 * Approved → pending is refused once records have been fanned out: the
 * importer only skips a pending row, it never withdraws records, so the
 * operator must either supply a corrected approved judgment (rewritten in
 * place on the next import) or retire the records first.
 */
export async function applyLegislativeVoteJudgment(
  db: Queryable,
  judgment: LegislativeVoteJudgment
): Promise<LegislativeVoteJudgmentOutcome> {
  const current = await db.query<{
    id: string;
    is_floor_vote: boolean | null;
    measure_id: string | null;
    vote_date: string;
    official_vote_date: string | null;
    review_status: LegislativeVoteReviewStatus;
    yeas: number;
    nays: number;
    yea_description: string | null;
    nay_description: string | null;
    labels_json: unknown;
  }>(
    `SELECT id, is_floor_vote, measure_id, vote_date::text AS vote_date, official_vote_date::text AS official_vote_date, review_status, yeas, nays, yea_description, nay_description, labels_json
       FROM legislative_votes
      WHERE jurisdiction = $1
        AND chamber = $2
        AND session = $3
        AND roll_number = $4
      FOR UPDATE`,
    [judgment.jurisdiction, judgment.chamber, judgment.session, judgment.rollNumber]
  );
  const row = current.rows[0];
  const name = `${judgment.chamber} ${judgment.session} roll ${judgment.rollNumber}`;
  if (!row) {
    throw new Error(`${name} is not in legislative_votes; run rollcall:fetch first`);
  }
  if (!sameMeasure(row.measure_id, judgment.measureId) || row.vote_date !== judgment.voteDate) {
    throw new Error(
      `${name} is ${row.measure_id ?? "no measure"} on ${row.vote_date}, but the judgment says ${judgment.measureId ?? "no measure"} on ${judgment.voteDate}`
    );
  }
  if (judgment.reviewStatus === "approved" && row.is_floor_vote !== true) {
    throw new Error(`${name} is not a kept floor vote (is_floor_vote = ${String(row.is_floor_vote)}); it cannot be approved`);
  }
  if (row.review_status === "approved" && judgment.reviewStatus === "pending") {
    const fannedOut = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM candidate_records
        WHERE origin = 'rollcall_import'
          AND starts_with(origin_run_id, $1)
          AND retired_at IS NULL`,
      [`rollcall:${judgment.jurisdiction}:${judgment.chamber}:${judgment.session}:${judgment.rollNumber}:`]
    );
    const n = Number(fannedOut.rows[0]?.n ?? "0");
    if (n > 0) {
      throw new Error(
        `${name} already fanned out ${n} live candidate records; setting it back to pending would not withdraw them. ` +
          "Supply a corrected approved judgment (the next rollcall:import rewrites them in place) or retire the records first."
      );
    }
  }
  const labelsJson = JSON.stringify(judgment.labels);
  const sameJudgment =
    row.yea_description === judgment.yeaDescription &&
    row.nay_description === judgment.nayDescription &&
    row.official_vote_date === judgment.officialVoteDate &&
    canonicalLabels(row.labels_json) === canonicalLabels(judgment.labels);
  if (sameJudgment && row.review_status === judgment.reviewStatus) {
    return "unchanged";
  }
  // Approval gates for the two authoring failures the data actually showed
  // (2026-08-29). Both run only when this apply would change something, so
  // re-applying a committed pre-gate judgments file verbatim stays a no-op.
  if (judgment.reviewStatus === "approved") {
    // 1. Each sentence must cite THIS roll call's tally. The closing tally
    //    sentence is already the template (plan §3); making it a gate stops
    //    a sentence written about a different stage of the same bill (PA
    //    HB 103: first-passage prose approved while the members' final
    //    position was the 201-2 concurrence) and plain mistyped tallies.
    //    Boundary-anchored: a bare substring test would let 215-14 satisfy
    //    a required 15-1.
    const tally = `${row.yeas}-${row.nays}`;
    const tallyPattern = new RegExp(`(?<![\\d-])${row.yeas}-${row.nays}(?!\\d)`);
    for (const [field, text] of [
      ["yea_description", judgment.yeaDescription],
      ["nay_description", judgment.nayDescription],
    ] as const) {
      if (!tallyPattern.test(text)) {
        throw new Error(`${name}: ${field} does not cite this roll call's tally ${tally}; describe the vote being approved`);
      }
    }
    assertDescriptionLengths(name, judgment.yeaDescription, judgment.nayDescription);
    // 2. Superseded-stage gate: another kept floor vote on the same measure
    //    in the same chamber, on or after this one's date, means this vote
    //    may not be the chamber's final action, and a record citing only
    //    the earlier stage reads as the member's final position on the
    //    bill. Same-day peers count — re-votes after a motion to
    //    reconsider land on the same date, and within a day the sources
    //    give no reliable order. Judge the decisive vote instead, or list
    //    the other roll numbers in acknowledge_later_rolls to approve this
    //    one on purpose. Scoped to this bill's session: measure numbers
    //    repeat across sessions (H.R. 1 exists in every Congress). A
    //    federal bill lives across both calendar sessions of its Congress,
    //    so US scans both; a state session key already spans the term.
    if (row.measure_id !== null) {
      // A malformed US session key would derive scan keys that match
      // nothing and silently skip the gate, so it fails loud instead
      // (rollcall:judge always builds `<congress>-<1|2>`; this guards
      // direct callers and malformed rows).
      if (judgment.jurisdiction === "US" && !/^\d+-[12]$/.test(judgment.session)) {
        throw new Error(`${name}: US session '${judgment.session}' is not <congress>-<1|2>`);
      }
      const sessions =
        judgment.jurisdiction === "US"
          ? [1, 2].map((half) => `${judgment.session.split("-")[0]}-${half}`)
          : [judgment.session];
      const later = await db.query<{
        session: string;
        roll_number: number;
        vote_date: string;
        measure_id: string;
        exact_question: string;
      }>(
        `SELECT session, roll_number, vote_date::text AS vote_date, measure_id, exact_question
           FROM legislative_votes
          WHERE jurisdiction = $1
            AND chamber = $2
            AND session = ANY($3::text[])
            AND is_floor_vote = true
            -- The OR admits a peer whose source stamped the legislative
            -- day: an overnight vote raw-dated 6/30 with official date
            -- 7/1 must still block a 7/1 roll call. It only ever widens
            -- the scan; the boundary stays this row's raw vote_date.
            AND (vote_date >= $4::date OR COALESCE(official_vote_date, vote_date) >= $4::date)
            AND measure_id IS NOT NULL
            AND id <> $5`,
        [judgment.jurisdiction, judgment.chamber, sessions, row.vote_date, row.id]
      );
      // An acknowledged number covers any session in the scan on purpose:
      // the cross-session peer (a next-calendar-session concurrence) is
      // half the reason US scans both, and the error below names every
      // unacknowledged vote with its session, so the operator sees exactly
      // what a number will cover before writing it.
      const superseding = later.rows.filter(
        (candidate) =>
          sameMeasure(candidate.measure_id, row.measure_id) &&
          !judgment.acknowledgeLaterRolls.includes(candidate.roll_number)
      );
      if (superseding.length > 0) {
        const listed = superseding
          .map((vote) => `${vote.session} roll ${vote.roll_number} on ${vote.vote_date} (${vote.exact_question})`)
          .join("; ");
        throw new Error(
          `${name} may not be this chamber's final kept floor vote on ${row.measure_id}: ${listed}. ` +
            "Judge the decisive vote instead, or list the other roll numbers in acknowledge_later_rolls to approve this one anyway."
        );
      }
    }
  }
  if (row.review_status === "approved" && !sameJudgment) {
    await db.query(
      `UPDATE legislative_votes
          SET review_status = 'pending',
              reviewed_at = NULL
        WHERE id = $1`,
      [row.id]
    );
  }
  await db.query(
    `UPDATE legislative_votes
        SET yea_description = $2,
            nay_description = $3,
            labels_json = $4::jsonb,
            official_vote_date = $5::date,
            review_status = $6,
            reviewed_at = CASE WHEN $6 = 'approved' THEN now() ELSE NULL END
      WHERE id = $1`,
    [row.id, judgment.yeaDescription, judgment.nayDescription, labelsJson, judgment.officialVoteDate, judgment.reviewStatus]
  );
  return "updated";
}

// 3. Length gate (2026-09-13): a description is the vote, the bill's plain
//    effect, and the tally — not a bill digest. See rollCallDescriptionLength.ts.
function assertDescriptionLengths(name: string, yeaDescription: string, nayDescription: string): void {
  for (const [field, text] of [
    ["yea_description", yeaDescription],
    ["nay_description", nayDescription],
  ] as const) {
    const problem = describeRollCallDescriptionLengthProblem(text);
    if (problem !== null) {
      throw new Error(`${name}: ${field} ${problem}`);
    }
  }
}

export type LegislativeVoteDescriptionRewrite = {
  jurisdiction: string;
  chamber: LegislativeVoteChamber;
  session: string;
  rollNumber: number;
  measureId: string | null;
  voteDate: string;
  yeaDescription: string;
  nayDescription: string;
};

export type LegislativeVoteDescriptionRewriteResult = {
  outcome: "unchanged" | "updated";
  id: string;
  oldYeaDescription: string;
  oldNayDescription: string;
};

/**
 * Wording-only change to an APPROVED roll call: the two sentences move,
 * labels, dates, and review status stay exactly as judged. Used by the
 * description-length campaign (rollcall:rewrite), where re-running the
 * full judgment would re-litigate stage acknowledgements and overwrite
 * labels added by later backfills. Gated on the tally and on length like
 * an approval; refuses a pending row (judge it instead).
 */
export async function applyLegislativeVoteDescriptionRewrite(
  db: Queryable,
  rewrite: LegislativeVoteDescriptionRewrite
): Promise<LegislativeVoteDescriptionRewriteResult> {
  const current = await db.query<{
    id: string;
    measure_id: string | null;
    vote_date: string;
    review_status: LegislativeVoteReviewStatus;
    yeas: number;
    nays: number;
    yea_description: string | null;
    nay_description: string | null;
  }>(
    `SELECT id, measure_id, vote_date::text AS vote_date, review_status, yeas, nays, yea_description, nay_description
       FROM legislative_votes
      WHERE jurisdiction = $1
        AND chamber = $2
        AND session = $3
        AND roll_number = $4
      FOR UPDATE`,
    [rewrite.jurisdiction, rewrite.chamber, rewrite.session, rewrite.rollNumber]
  );
  const row = current.rows[0];
  const name = `${rewrite.jurisdiction} ${rewrite.chamber} ${rewrite.session} roll ${rewrite.rollNumber}`;
  if (!row) {
    throw new Error(`${name} is not in legislative_votes`);
  }
  if (!sameMeasure(row.measure_id, rewrite.measureId) || row.vote_date !== rewrite.voteDate) {
    throw new Error(
      `${name} is ${row.measure_id ?? "no measure"} on ${row.vote_date}, but the rewrite says ${rewrite.measureId ?? "no measure"} on ${rewrite.voteDate}`
    );
  }
  if (row.review_status !== "approved" || row.yea_description === null || row.nay_description === null) {
    throw new Error(`${name} is ${row.review_status}; rollcall:rewrite only rewords approved roll calls (use rollcall:judge)`);
  }
  if (rewrite.yeaDescription.toLowerCase() === rewrite.nayDescription.toLowerCase()) {
    throw new Error(`${name}: yea_description and nay_description are the same sentence`);
  }
  const base = {
    outcome: "unchanged" as const,
    id: row.id,
    oldYeaDescription: row.yea_description,
    oldNayDescription: row.nay_description,
  };
  if (row.yea_description === rewrite.yeaDescription && row.nay_description === rewrite.nayDescription) {
    return base;
  }
  const tally = `${row.yeas}-${row.nays}`;
  const tallyPattern = new RegExp(`(?<![\\d-])${row.yeas}-${row.nays}(?!\\d)`);
  for (const [field, text] of [
    ["yea_description", rewrite.yeaDescription],
    ["nay_description", rewrite.nayDescription],
  ] as const) {
    if (!tallyPattern.test(text)) {
      throw new Error(`${name}: ${field} does not cite this roll call's tally ${tally}`);
    }
  }
  assertDescriptionLengths(name, rewrite.yeaDescription, rewrite.nayDescription);
  // The freeze trigger refuses edits to an approved row, so the row passes
  // through pending and is re-approved in the same transaction — the same
  // two steps rollcall:judge takes for a corrected approved judgment.
  await db.query(
    `UPDATE legislative_votes
        SET review_status = 'pending',
            reviewed_at = NULL
      WHERE id = $1`,
    [row.id]
  );
  await db.query(
    `UPDATE legislative_votes
        SET yea_description = $2,
            nay_description = $3,
            review_status = 'approved',
            reviewed_at = now()
      WHERE id = $1`,
    [row.id, rewrite.yeaDescription, rewrite.nayDescription]
  );
  return { ...base, outcome: "updated" };
}

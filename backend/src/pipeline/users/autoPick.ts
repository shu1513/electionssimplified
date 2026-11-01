import type { Pool, PoolClient } from "pg";

import { isUuid } from "../../utils/uuid.js";
import { US_LATEST_LOCAL_DATE_SQL } from "../../utils/usLocalDate.js";
import { isJudicialRetentionTitle } from "../../ai/electionPartisanshipPolicy.js";
import { researchAreaWeightForRank } from "./userResearchAreaScoring.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionalDb = Pick<Pool, "connect">;
type TransactionClient = Pick<PoolClient, "query" | "release">;

// ---------------------------------------------------------------------------
// Auto-pick engine ("Pick for me"): scores a race's candidates (or a ballot
// measure) against the user's ranked issues and either picks or explains why
// it can't. Spec: docs/plans/auto-pick-by-issues.md. The engine must be
// honest — a race with no usable evidence gets no pick and a reason, never a
// guess.
//
// The decision logic is pure (decideOfficeRace / decideMeasure below, unit
// tested over fixtures); the SQL loaders and the write path wrap it.
// ---------------------------------------------------------------------------

/** UX floor: below this many saved issues, ranking has no meaning. */
export const MIN_AUTO_PICK_ISSUES = 3;

/** Batch bound for POST /api/me/auto-picks — bounds the work per call. */
export const MAX_AUTO_PICK_ELECTION_IDS = 200;

export type AutoPickMode = "fill_empty" | "replace";

export type AutoPickReason =
  | "by_elimination"
  | "insufficient_evidence"
  | "only_negative_evidence"
  | "tie"
  | "all_vetoed"
  | "veto"
  | "too_few_issues"
  | "election_closed";

export type AutoPickIssue = {
  researchAreaId: string;
  /** research_areas.slug — 'integrity_and_ethics' gets special stance rules. */
  slug: string;
  rank: number | null;
  direction: "support" | "oppose";
  hardVeto: boolean;
};

export type AutoPickCandidate = {
  candidateId: string;
  displayName: string;
  /** candidates.last_records_searched_at IS NULL — never researched at all. */
  neverResearched: boolean;
};

/** One live record's tag on one of the user's issues. */
export type AutoPickRecordTag = {
  candidateId: string;
  recordId: string;
  researchAreaId: string;
  stance: "for" | "against" | null;
  /** candidate_records.description — shown when this record triggers a veto. */
  description: string;
};

export type AutoPickMeasureTag = {
  researchAreaId: string;
  stance: "for" | "against";
};

export type AutoPickVetoedBy = {
  research_area_id: string;
  record_id: string;
  description: string;
};

export type AutoPickPerIssue = {
  research_area_id: string;
  /** clamp(Σ effective stances, −3, +3) / 3 — −1..1, ± thirds. */
  net: number;
  /** Records whose effective stance AGREES with the user's direction. */
  for_count: number;
  /** Records whose effective stance CONFLICTS with the user's direction. */
  against_count: number;
};

export type AutoPickCandidateReport = {
  candidate_id: string;
  display_name: string;
  score: number;
  has_evidence: boolean;
  vetoed_by: AutoPickVetoedBy[];
  per_issue: AutoPickPerIssue[];
};

export type AutoPickUnresearched = {
  candidate_id: string;
  display_name: string;
  /** true = never researched at all; false = researched, no stance found on
   * the user's issues. */
  never_researched: boolean;
};

/**
 * An issue the user has NOT ranked that the race's candidates (or the
 * measure) carry usable records on — what the "add these issues" prompt
 * offers after a no-pick the user's list could not decide.
 */
export type AutoPickSuggestedIssue = {
  research_area_id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Live candidates in the (narrowed) field with at least one usable
   * record on this issue. 1 for a measure or a retention judge. */
  candidate_count: number;
  record_count: number;
};

export type AutoPickElectionResult = {
  election_id: string;
  race_type: "office" | "ballot_measure";
  outcome: "picked" | "skipped_existing" | "no_pick";
  reason: AutoPickReason | null;
  picked_candidate_ids: string[];
  measure_position: "yes" | "no" | null;
  /** On a "tie" or "only_negative_evidence" no-pick: the narrowed field the
   * user should decide among (tied leaders, or the eligible unknowns). */
  shortlist_candidate_ids: string[];
  candidates: AutoPickCandidateReport[];
  /** Measure races: per-issue alignment (net = ±1 after the user's
   * direction), for the "Why this pick" panel. Empty for office races. */
  measure_per_issue: { research_area_id: string; net: number }[];
  unresearched: AutoPickUnresearched[];
  /** Non-empty only on a no-pick that more ranked issues could decide
   * (too_few_issues, insufficient_evidence, only_negative_evidence, tie):
   * the unranked, user-selectable issues the undecided field has records
   * on, most candidates first. Empty when nothing is known about them at
   * all. */
  suggested_issues: AutoPickSuggestedIssue[];
};

export type AutoPicksResult = { results: AutoPickElectionResult[] };

export type AutoPickErrorCode =
  | "invalid_user_id"
  | "invalid_election_id"
  | "invalid_input"
  | "user_not_found"
  | "election_not_found";

export class AutoPickError extends Error {
  constructor(
    readonly code: AutoPickErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AutoPickError";
  }
}

const INTEGRITY_SLUG = "integrity_and_ethics";

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * Weight per issue: 0.75^(rank − 1) via the shared formula. Unranked legacy
 * rows weigh one rank below the user's highest explicit rank — the same rule
 * as loadUserResearchAreaWeights.
 */
function issueWeights(issues: readonly AutoPickIssue[]): Map<string, number> {
  const highestRank = issues.reduce<number>(
    (last, issue) => (issue.rank !== null && issue.rank > last ? issue.rank : last),
    0
  );
  const weights = new Map<string, number>();
  for (const issue of issues) {
    weights.set(issue.researchAreaId, researchAreaWeightForRank(issue.rank ?? highestRank + 1));
  }
  return weights;
}

/**
 * Effective stance of one record tag under the user's direction on that
 * issue: +1 agrees with the user's position, −1 conflicts. An
 * integrity_and_ethics tag means "a NEGATIVE ethics record exists" — an
 * adverse action against the candidate personally by an official body
 * (conviction, charge, censure, fine, suspension, substantiated finding) —
 * so it always counts −1 (stance is forbidden there). The tagging rule
 * (candidateRecordAreaLabelPrompt.ts, manual-research records-import.md)
 * keeps cleared complaints, unofficial allegations, and the candidate's own
 * reform work OUT of this tag; the 2026-09-06 retag pass removed the ones
 * that had slipped in. Returns null for tags that carry
 * no signal (stance NULL on a stanced area — the tagging policy forbids it,
 * but stored data is not trusted to be clean).
 */
function effectiveStance(issue: AutoPickIssue, stance: "for" | "against" | null): 1 | -1 | null {
  if (issue.slug === INTEGRITY_SLUG) {
    return -1;
  }
  if (stance === null) {
    return null;
  }
  const recordSide = stance === "for" ? 1 : -1;
  const userSide = issue.direction === "oppose" ? -1 : 1;
  return recordSide === userSide ? 1 : -1;
}

/** Sorted by the user's priority: explicit ranks first, then legacy unranked. */
function issuesInRankOrder(issues: readonly AutoPickIssue[]): AutoPickIssue[] {
  return [...issues].sort((a, b) => {
    if (a.rank === null && b.rank === null) {
      return 0;
    }
    if (a.rank === null) {
      return 1;
    }
    if (b.rank === null) {
      return -1;
    }
    return a.rank - b.rank;
  });
}

function buildCandidateReport(
  candidate: AutoPickCandidate,
  issues: readonly AutoPickIssue[],
  weights: Map<string, number>,
  tags: readonly AutoPickRecordTag[]
): AutoPickCandidateReport {
  const vetoedBy: AutoPickVetoedBy[] = [];
  const perIssue: AutoPickPerIssue[] = [];
  let score = 0;
  let hasEvidence = false;

  for (const issue of issuesInRankOrder(issues)) {
    let forCount = 0;
    let againstCount = 0;
    for (const tag of tags) {
      if (tag.candidateId !== candidate.candidateId || tag.researchAreaId !== issue.researchAreaId) {
        continue;
      }
      const effective = effectiveStance(issue, tag.stance);
      if (effective === null) {
        continue;
      }
      hasEvidence = true;
      if (effective === 1) {
        forCount += 1;
      } else {
        againstCount += 1;
        if (issue.hardVeto) {
          vetoedBy.push({
            research_area_id: issue.researchAreaId,
            record_id: tag.recordId,
            description: tag.description,
          });
        }
      }
    }
    if (forCount === 0 && againstCount === 0) {
      continue;
    }
    // ±3 cap: three consistent records already express full conviction — a
    // 40-record incumbent gets no volume bonus over a 3-record challenger.
    const net = Math.max(-3, Math.min(3, forCount - againstCount)) / 3;
    perIssue.push({
      research_area_id: issue.researchAreaId,
      net,
      for_count: forCount,
      against_count: againstCount,
    });
    score += (weights.get(issue.researchAreaId) ?? 0) * net;
  }

  return {
    candidate_id: candidate.candidateId,
    display_name: candidate.displayName,
    score,
    has_evidence: hasEvidence,
    vetoed_by: vetoedBy,
    per_issue: perIssue,
  };
}

export type OfficeDecision = {
  outcome: "picked" | "no_pick";
  reason: AutoPickReason | null;
  pickedCandidateIds: string[];
  shortlistCandidateIds: string[];
  candidates: AutoPickCandidateReport[];
  unresearched: AutoPickUnresearched[];
};

/**
 * Office-race decision over live candidacies. Spec order:
 * 1. remove vetoed and negative-score candidates (both work against the
 *    user's issues);
 * 2. no evidence anywhere → insufficient_evidence;
 * 3. positives fill seats in score order, a tie for the last open seat stops
 *    the fill (reason "tie", tied group = shortlist);
 * 4. remaining zero/no-evidence candidates fill leftover seats only when
 *    their count equals the open seats (by_elimination); more of them than
 *    seats → only_negative_evidence with the unknowns as shortlist.
 */
export function decideOfficeRace(
  issues: readonly AutoPickIssue[],
  candidates: readonly AutoPickCandidate[],
  tags: readonly AutoPickRecordTag[],
  seatsToFill: number | null
): OfficeDecision {
  const weights = issueWeights(issues);
  const reports = candidates.map((candidate) => buildCandidateReport(candidate, issues, weights, tags));
  // Score-desc for display; ties keep the input (alphabetical) order.
  const orderedReports = [...reports].sort((a, b) => b.score - a.score);
  const unresearched: AutoPickUnresearched[] = candidates
    .filter((candidate, index) => !reports[index]!.has_evidence)
    .map((candidate) => ({
      candidate_id: candidate.candidateId,
      display_name: candidate.displayName,
      never_researched: candidate.neverResearched,
    }));

  const base = { candidates: orderedReports, unresearched };

  if (!reports.some((report) => report.has_evidence)) {
    return {
      ...base,
      outcome: "no_pick",
      reason: "insufficient_evidence",
      pickedCandidateIds: [],
      shortlistCandidateIds: [],
    };
  }

  const eligible = orderedReports.filter((report) => report.vetoed_by.length === 0);
  if (eligible.length === 0) {
    return {
      ...base,
      outcome: "no_pick",
      reason: "all_vetoed",
      pickedCandidateIds: [],
      shortlistCandidateIds: [],
    };
  }

  // NULL seats_to_fill renders as a single seat product-wide; same here.
  const seats = seatsToFill ?? 1;
  const positives = eligible.filter((report) => report.score > 0);
  const zeros = eligible.filter((report) => report.score === 0);

  // Fill seats by equal-score GROUPS, not one candidate at a time: members
  // of a tied group are indistinguishable on the user's issues, so the group
  // is takeable only when it fits whole into the remaining seats. (A
  // per-candidate walk would seat the alphabetically-first member of a fully
  // tied group and report only the rest as tied.)
  const scoreGroups: AutoPickCandidateReport[][] = [];
  for (const report of positives) {
    const lastGroup = scoreGroups[scoreGroups.length - 1];
    if (lastGroup && lastGroup[0]!.score === report.score) {
      lastGroup.push(report);
    } else {
      scoreGroups.push([report]);
    }
  }
  const picked: AutoPickCandidateReport[] = [];
  let tieBlocked = false;
  let shortlist: AutoPickCandidateReport[] = [];
  for (const group of scoreGroups) {
    if (picked.length >= seats) {
      break;
    }
    if (group.length > seats - picked.length) {
      tieBlocked = true;
      shortlist = group;
      break;
    }
    picked.push(...group);
  }

  let byElimination = false;
  if (!tieBlocked && picked.length < seats) {
    const openSeats = seats - picked.length;
    if (zeros.length === openSeats && zeros.length > 0) {
      // e.g. a 2-candidate race where A opposes the user's issue and B has
      // only general records: B is the only one left standing.
      picked.push(...zeros);
      byElimination = true;
    } else if (picked.length === 0 && zeros.length > 0) {
      // Wrong count for the open seats (either way), so nobody is seated —
      // but when NOTHING was seated these unknowns are still the narrowed
      // field the no-pick result must hand the user. When positives already
      // filled some seats the outcome is "picked" and the shortlist stays
      // empty, matching the response contract.
      shortlist = zeros;
    }
  }

  if (picked.length > 0) {
    return {
      ...base,
      outcome: "picked",
      reason: tieBlocked ? "tie" : byElimination ? "by_elimination" : null,
      pickedCandidateIds: picked.map((report) => report.candidate_id),
      shortlistCandidateIds: shortlist.map((report) => report.candidate_id),
    };
  }
  return {
    ...base,
    outcome: "no_pick",
    reason: tieBlocked ? "tie" : "only_negative_evidence",
    pickedCandidateIds: [],
    shortlistCandidateIds: shortlist.map((report) => report.candidate_id),
  };
}

export type MeasureDecision = {
  outcome: "picked" | "no_pick";
  reason: AutoPickReason | null;
  measurePosition: "yes" | "no" | null;
  perIssue: { research_area_id: string; net: number }[];
};

/**
 * Measure decision: score = Σ w(rank) · direction · stance over the measure's
 * tags on ranked issues. A crossed veto answers No outright; otherwise Yes
 * for score > 0, No for score < 0, and no answer for 0 or no tagged overlap.
 */
export type RetentionDecision = {
  outcome: "picked" | "no_pick";
  reason: AutoPickReason | null;
  measurePosition: "yes" | "no" | null;
  candidate: AutoPickCandidateReport;
};

/**
 * Judicial retention: an office race with one candidate that the ballot
 * asks as Yes/No on keeping them. The judge is scored exactly like an
 * office candidate (same per-issue nets, caps, and vetoes), and the score
 * maps to a side the way decideMeasure's does: a crossed line is No, a
 * positive score Yes, a negative score No, and zero (no records on the
 * user's issues, or sides that cancel) is no answer.
 */
export function decideRetentionRace(
  issues: readonly AutoPickIssue[],
  candidate: AutoPickCandidate,
  tags: readonly AutoPickRecordTag[]
): RetentionDecision {
  const report = buildCandidateReport(candidate, issues, issueWeights(issues), tags);
  if (report.vetoed_by.length > 0) {
    return { outcome: "picked", reason: "veto", measurePosition: "no", candidate: report };
  }
  if (report.score === 0) {
    return { outcome: "no_pick", reason: "insufficient_evidence", measurePosition: null, candidate: report };
  }
  return { outcome: "picked", reason: null, measurePosition: report.score > 0 ? "yes" : "no", candidate: report };
}

export function decideMeasure(
  issues: readonly AutoPickIssue[],
  tags: readonly AutoPickMeasureTag[]
): MeasureDecision {
  const weights = issueWeights(issues);
  const perIssue: { research_area_id: string; net: number }[] = [];
  let score = 0;
  let vetoCrossed = false;
  for (const issue of issuesInRankOrder(issues)) {
    // One tag per (measure, area) — unique index — so find() is exhaustive.
    const tag = tags.find((measureTag) => measureTag.researchAreaId === issue.researchAreaId);
    if (!tag) {
      continue;
    }
    // Plain direction · stance (measure stance is NOT NULL; the
    // integrity_and_ethics record rule is about candidate conduct records
    // and has no measure counterpart).
    const stanceSide = tag.stance === "for" ? 1 : -1;
    const userSide = issue.direction === "oppose" ? -1 : 1;
    const effective = stanceSide * userSide;
    perIssue.push({ research_area_id: issue.researchAreaId, net: effective });
    score += (weights.get(issue.researchAreaId) ?? 0) * effective;
    if (issue.hardVeto && effective === -1) {
      vetoCrossed = true;
    }
  }

  if (vetoCrossed) {
    return { outcome: "picked", reason: "veto", measurePosition: "no", perIssue };
  }
  if (perIssue.length === 0 || score === 0) {
    return { outcome: "no_pick", reason: "insufficient_evidence", measurePosition: null, perIssue };
  }
  return { outcome: "picked", reason: null, measurePosition: score > 0 ? "yes" : "no", perIssue };
}

// ---------------------------------------------------------------------------
// SQL loaders
// ---------------------------------------------------------------------------

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!isUuid(normalized)) {
    throw new AutoPickError("invalid_user_id", "User ID must be a valid UUID");
  }
  return normalized;
}

function normalizeElectionId(electionId: string): string {
  const normalized = electionId.trim();
  if (!isUuid(normalized)) {
    throw new AutoPickError("invalid_election_id", "Election ID must be a valid UUID");
  }
  return normalized;
}

async function assertActiveUser(db: Queryable, normalizedUserId: string, lock: boolean): Promise<void> {
  const user = await db.query<{ id: string }>(
    `
      SELECT id
      FROM public.users
      WHERE id = $1::uuid
        AND deleted_at IS NULL
      ${lock ? "FOR UPDATE" : ""}
    `,
    [normalizedUserId]
  );
  if (user.rows.length === 0) {
    throw new AutoPickError("user_not_found", "User not found");
  }
}

type IssueRow = {
  research_area_id: string;
  slug: string;
  rank: number | string | null;
  direction: string;
  hard_veto: boolean;
};

async function loadIssues(db: Queryable, normalizedUserId: string): Promise<AutoPickIssue[]> {
  const result = await db.query<IssueRow>(
    `
      SELECT
        preference.research_area_id::text AS research_area_id,
        area.slug,
        preference.rank,
        preference.direction,
        preference.hard_veto
      FROM public.user_research_area_preferences AS preference
      JOIN public.research_areas AS area
        ON area.id = preference.research_area_id
      WHERE preference.user_id = $1::uuid
    `,
    [normalizedUserId]
  );
  return result.rows.map((row) => ({
    researchAreaId: row.research_area_id,
    slug: row.slug,
    rank: row.rank === null ? null : typeof row.rank === "number" ? row.rank : Number.parseInt(row.rank, 10),
    direction: row.direction === "oppose" ? "oppose" : "support",
    hardVeto: row.hard_veto === true,
  }));
}

type ElectionRow = {
  id: string;
  race_type: "office" | "ballot_measure";
  official_ballot_title: string;
  seats_to_fill: number | null;
  office_id: string | null;
  is_upcoming: boolean;
};

// Retention races are catalogued as office races with the judge as the only
// candidate, but the ballot asks Yes/No on keeping them; the answer is stored
// as measure_position on the office race (see userElectionChoices).
function isRetentionElection(election: ElectionRow): boolean {
  return (
    election.race_type === "office" &&
    typeof election.official_ballot_title === "string" &&
    isJudicialRetentionTitle(election.official_ballot_title)
  );
}

async function loadElection(db: Queryable, normalizedElectionId: string): Promise<ElectionRow> {
  const result = await db.query<ElectionRow>(
    `
      SELECT
        id::text AS id,
        race_type,
        official_ballot_title,
        seats_to_fill,
        office_id::text AS office_id,
        election_date >= ${US_LATEST_LOCAL_DATE_SQL} AS is_upcoming
      FROM public.elections
      WHERE id = $1::uuid
    `,
    [normalizedElectionId]
  );
  const election = result.rows[0];
  if (!election) {
    throw new AutoPickError("election_not_found", "Election not found");
  }
  return election;
}

type CandidateRow = {
  candidate_id: string;
  display_name: string;
  never_researched: boolean;
};

// Same liveness rules as the pick writer: live candidacy (not withdrawn or
// lost), live candidate (not deleted or merged).
async function loadCandidates(db: Queryable, normalizedElectionId: string): Promise<AutoPickCandidate[]> {
  const result = await db.query<CandidateRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          trim(concat_ws(' ', candidate.first_name, candidate.last_name))
        ) AS display_name,
        candidate.last_records_searched_at IS NULL AS never_researched
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
       AND candidate.deleted_at IS NULL
       AND candidate.merged_into_candidate_id IS NULL
      WHERE candidate_election.election_id = $1::uuid
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
      ORDER BY display_name ASC, candidate.id ASC
    `,
    [normalizedElectionId]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    displayName: row.display_name,
    neverResearched: row.never_researched,
  }));
}

type RecordTagRow = {
  candidate_id: string;
  record_id: string;
  research_area_id: string;
  stance: "for" | "against" | null;
  description: string;
};

// Live records only; tags restricted to the user's saved issues (the
// 'general' area is not user-selectable, so it can never appear here) AND to
// the election office's allowed areas. Record tags are candidate-wide, so a
// candidate can carry records from a previous office the current one cannot
// affect — the election views scope those out (ballotLookup's
// scopeRecordTagsToOffice), and a pick engine that counted them would decide
// races on issues the office has no say over. integrity_and_ethics is
// universal (conduct is office-agnostic), matching the election views. An
// election with no linked office has no allowed set and keeps every tag; an
// office with an EMPTY allowed set keeps only the universal area, same as
// the views.
async function loadRecordTags(
  db: Queryable,
  candidateIds: readonly string[],
  areaIds: readonly string[],
  officeId: string | null
): Promise<AutoPickRecordTag[]> {
  if (candidateIds.length === 0 || areaIds.length === 0) {
    return [];
  }
  const result = await db.query<RecordTagRow>(
    `
      SELECT
        record.candidate_id::text AS candidate_id,
        record.id::text AS record_id,
        tag.research_area_id::text AS research_area_id,
        tag.stance,
        record.description
      FROM public.candidate_records AS record
      JOIN public.candidate_record_area_tags AS tag
        ON tag.candidate_record_id = record.id
      WHERE record.candidate_id = ANY($1::uuid[])
        AND record.retired_at IS NULL
        AND tag.research_area_id = ANY($2::uuid[])
        AND (
          $3::uuid IS NULL
          OR tag.research_area_id IN (
            SELECT allowed.research_area_id
            FROM public.office_research_areas AS allowed
            WHERE allowed.office_id = $3::uuid
          )
          OR tag.research_area_id IN (
            SELECT area.id
            FROM public.research_areas AS area
            WHERE area.slug = '${INTEGRITY_SLUG}'
          )
        )
    `,
    [candidateIds, areaIds, officeId]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    recordId: row.record_id,
    researchAreaId: row.research_area_id,
    stance: row.stance,
    description: row.description,
  }));
}

async function loadMeasureTags(
  db: Queryable,
  normalizedElectionId: string,
  areaIds: readonly string[]
): Promise<AutoPickMeasureTag[]> {
  if (areaIds.length === 0) {
    return [];
  }
  const result = await db.query<{ research_area_id: string; stance: "for" | "against" }>(
    `
      SELECT
        tag.research_area_id::text AS research_area_id,
        tag.stance
      FROM public.ballot_measures AS measure
      JOIN public.ballot_measure_research_area_tags AS tag
        ON tag.ballot_measure_id = measure.id
      WHERE measure.election_id = $1::uuid
        AND tag.research_area_id = ANY($2::uuid[])
    `,
    [normalizedElectionId, areaIds]
  );
  return result.rows.map((row) => ({ researchAreaId: row.research_area_id, stance: row.stance }));
}

type SuggestedIssueRow = {
  research_area_id: string;
  slug: string;
  name: string;
  description: string | null;
  candidate_count: number | string;
  record_count: number | string;
};

function toSuggestedIssues(rows: readonly SuggestedIssueRow[]): AutoPickSuggestedIssue[] {
  return rows.map((row) => ({
    research_area_id: row.research_area_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    candidate_count: Number(row.candidate_count),
    record_count: Number(row.record_count),
  }));
}

// The no-pick reasons that a longer issue list can turn into a pick. Vetoes
// and the too-few / closed cases are not evidence gaps, so no suggestions.
const SUGGESTION_REASONS: ReadonlySet<AutoPickReason> = new Set<AutoPickReason>([
  "insufficient_evidence",
  "only_negative_evidence",
  "tie",
]);

// The mirror image of loadRecordTags: live records on these candidates
// tagged with areas the user has NOT ranked, filtered to what the engine
// could actually use — a stance (or any integrity_and_ethics tag, which is
// evidence by itself), a user-selectable area (the 'general' area cannot
// be ranked, so offering it would be a dead end), and the office's allowed
// areas under the same scoping rule as loadRecordTags.
async function loadUncoveredRecordAreas(
  db: Queryable,
  candidateIds: readonly string[],
  rankedAreaIds: readonly string[],
  officeId: string | null
): Promise<AutoPickSuggestedIssue[]> {
  if (candidateIds.length === 0) {
    return [];
  }
  const result = await db.query<SuggestedIssueRow>(
    `
      SELECT
        area.id::text AS research_area_id,
        area.slug,
        area.name,
        area.description,
        count(DISTINCT record.candidate_id)::int AS candidate_count,
        count(*)::int AS record_count
      FROM public.candidate_records AS record
      JOIN public.candidate_record_area_tags AS tag
        ON tag.candidate_record_id = record.id
      JOIN public.research_areas AS area
        ON area.id = tag.research_area_id
      WHERE record.candidate_id = ANY($1::uuid[])
        AND record.retired_at IS NULL
        AND NOT (tag.research_area_id = ANY($2::uuid[]))
        AND area.is_user_selectable = true
        AND (tag.stance IS NOT NULL OR area.slug = '${INTEGRITY_SLUG}')
        AND (
          $3::uuid IS NULL
          OR area.slug = '${INTEGRITY_SLUG}'
          OR tag.research_area_id IN (
            SELECT allowed.research_area_id
            FROM public.office_research_areas AS allowed
            WHERE allowed.office_id = $3::uuid
          )
        )
      GROUP BY area.id, area.slug, area.name, area.description
      ORDER BY candidate_count DESC, record_count DESC, area.name ASC
    `,
    [candidateIds, rankedAreaIds, officeId]
  );
  return toSuggestedIssues(result.rows);
}

// Measure counterpart: the measure's tags on unranked, selectable areas.
// One tag per (measure, area), so each row is one record on one "candidate".
async function loadUncoveredMeasureAreas(
  db: Queryable,
  normalizedElectionId: string,
  rankedAreaIds: readonly string[]
): Promise<AutoPickSuggestedIssue[]> {
  const result = await db.query<SuggestedIssueRow>(
    `
      SELECT
        area.id::text AS research_area_id,
        area.slug,
        area.name,
        area.description,
        1 AS candidate_count,
        1 AS record_count
      FROM public.ballot_measures AS measure
      JOIN public.ballot_measure_research_area_tags AS tag
        ON tag.ballot_measure_id = measure.id
      JOIN public.research_areas AS area
        ON area.id = tag.research_area_id
      WHERE measure.election_id = $1::uuid
        AND NOT (tag.research_area_id = ANY($2::uuid[]))
        AND area.is_user_selectable = true
      ORDER BY area.name ASC
    `,
    [normalizedElectionId, rankedAreaIds]
  );
  return toSuggestedIssues(result.rows);
}

async function countExistingPicks(
  db: Queryable,
  normalizedUserId: string,
  normalizedElectionId: string
): Promise<number> {
  // Same liveness rule as the choices reader (userElectionChoices
  // rowsToChoices): a candidate row whose candidate was deleted or merged
  // renders nowhere, so it must not make fill_empty report skipped_existing
  // on a race the user sees as empty. Measure rows always count.
  const result = await db.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM public.user_election_choices AS choice
      LEFT JOIN public.candidates AS candidate
        ON candidate.id = choice.candidate_id
       AND candidate.deleted_at IS NULL
       AND candidate.merged_into_candidate_id IS NULL
      WHERE choice.user_id = $1::uuid
        AND choice.election_id = $2::uuid
        AND (choice.measure_position IS NOT NULL OR candidate.id IS NOT NULL)
    `,
    [normalizedUserId, normalizedElectionId]
  );
  return Number(result.rows[0]?.count ?? "0");
}

export type ClearAutoPicksResult = { cleared_count: number };

/**
 * Deletes every auto-pick row (origin = 'auto') on the user's UPCOMING
 * elections in one statement. One request instead of a PUT per row: the API
 * has a global per-IP rate limit, and a client-side loop over stale cache
 * could unpick a row another tab had already re-picked manually — here the
 * origin check and the delete are the same atomic operation, so a row whose
 * origin flipped back to 'manual' is never touched. Past elections keep
 * their auto picks as history, matching the manual write path's refusal to
 * change closed elections.
 */
export async function clearAutoPicks(
  db: Queryable,
  userId: string,
  electionDate?: string
): Promise<ClearAutoPicksResult> {
  const normalizedUserId = normalizeUserId(userId);
  await assertActiveUser(db, normalizedUserId, false);
  // Optional election-date scope: the My Picks page clears one date card at
  // a time. Still bounded to upcoming — a past date filter deletes nothing.
  const result = await db.query(
    `
      DELETE FROM public.user_election_choices AS choice
      USING public.elections AS election
      WHERE election.id = choice.election_id
        AND choice.user_id = $1::uuid
        AND choice.origin = 'auto'
        AND election.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
        AND ($2::date IS NULL OR election.election_date = $2::date)
    `,
    [normalizedUserId, electionDate ?? null]
  );
  return { cleared_count: result.rowCount ?? 0 };
}

function emptyResult(
  electionId: string,
  raceType: "office" | "ballot_measure",
  outcome: AutoPickElectionResult["outcome"],
  reason: AutoPickReason | null
): AutoPickElectionResult {
  return {
    election_id: electionId,
    race_type: raceType,
    outcome,
    reason,
    picked_candidate_ids: [],
    measure_position: null,
    shortlist_candidate_ids: [],
    candidates: [],
    measure_per_issue: [],
    unresearched: [],
    suggested_issues: [],
  };
}

/** Whether a no-pick is the kind a longer issue list could decide. */
function wantsSuggestions(result: Pick<AutoPickElectionResult, "outcome" | "reason">): boolean {
  return result.outcome === "no_pick" && result.reason !== null && SUGGESTION_REASONS.has(result.reason);
}

/**
 * Computes one election's decision from a consistent read source (the write
 * path passes its own transaction client so the decision and the writes share
 * one snapshot). Assumes the caller already checked MIN_AUTO_PICK_ISSUES and
 * the election window.
 */
async function computeDecision(
  db: Queryable,
  issues: readonly AutoPickIssue[],
  election: ElectionRow
): Promise<AutoPickElectionResult> {
  const areaIds = issues.map((issue) => issue.researchAreaId);
  if (election.race_type === "ballot_measure") {
    const tags = await loadMeasureTags(db, election.id, areaIds);
    const decision = decideMeasure(issues, tags);
    const result = {
      ...emptyResult(election.id, election.race_type, decision.outcome, decision.reason),
      measure_position: decision.measurePosition,
      measure_per_issue: decision.perIssue,
    };
    if (wantsSuggestions(result)) {
      result.suggested_issues = await loadUncoveredMeasureAreas(db, election.id, areaIds);
    }
    return result;
  }
  const candidates = await loadCandidates(db, election.id);
  const tags = await loadRecordTags(
    db,
    candidates.map((candidate) => candidate.candidateId),
    areaIds,
    election.office_id
  );
  if (isRetentionElection(election)) {
    // Exactly one live judge is the retention shape; anything else is a
    // roster problem the engine must not paper over with a Yes/No.
    if (candidates.length !== 1) {
      return emptyResult(election.id, election.race_type, "no_pick", "insufficient_evidence");
    }
    const decision = decideRetentionRace(issues, candidates[0]!, tags);
    const result = {
      ...emptyResult(election.id, election.race_type, decision.outcome, decision.reason),
      measure_position: decision.measurePosition,
      candidates: [decision.candidate],
      // The judge's per-issue nets double as the measure-style alignment
      // list, so the "Why this pick" panel reads the same for a Yes/No.
      measure_per_issue: decision.candidate.per_issue.map(({ research_area_id, net }) => ({ research_area_id, net })),
    };
    if (wantsSuggestions(result)) {
      result.suggested_issues = await loadUncoveredRecordAreas(
        db,
        [candidates[0]!.candidateId],
        areaIds,
        election.office_id
      );
    }
    return result;
  }
  const decision = decideOfficeRace(issues, candidates, tags, election.seats_to_fill);
  const result: AutoPickElectionResult = {
    election_id: election.id,
    race_type: election.race_type,
    outcome: decision.outcome,
    reason: decision.reason,
    picked_candidate_ids: decision.pickedCandidateIds,
    measure_position: null,
    shortlist_candidate_ids: decision.shortlistCandidateIds,
    candidates: decision.candidates,
    measure_per_issue: [],
    unresearched: decision.unresearched,
    suggested_issues: [],
  };
  if (wantsSuggestions(result)) {
    // A tie or an unknowns-only field is already narrowed: suggest what
    // separates THOSE candidates, not what the eliminated ones did. With no
    // shortlist (nobody has evidence) the whole live roster is the field.
    const field =
      decision.shortlistCandidateIds.length > 0
        ? decision.shortlistCandidateIds
        : candidates.map((candidate) => candidate.candidateId);
    result.suggested_issues = await loadUncoveredRecordAreas(db, field, areaIds, election.office_id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

async function rollbackQuietly(client: TransactionClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

/**
 * Writes one election's winners inside the caller's transaction. Same
 * eligibility gates as setUserElectionChoice's same-statement inserts, with
 * origin = 'auto'. Returns false when a gate refused (the election window
 * closed between compute and write — the only reachable path, since compute
 * and write share the transaction's snapshot for catalog reads).
 */
async function writeMeasurePosition(
  client: Queryable,
  normalizedUserId: string,
  electionId: string,
  position: "yes" | "no",
  raceType: "ballot_measure" | "office"
): Promise<boolean> {
  const inserted = await client.query(
    `
      INSERT INTO public.user_election_choices (user_id, election_id, measure_position, origin)
      SELECT $1::uuid, election.id, $3, 'auto'
      FROM public.elections AS election
      WHERE election.id = $2::uuid
        AND election.race_type = $4
        AND election.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
      ON CONFLICT (user_id, election_id) WHERE measure_position IS NOT NULL
      DO UPDATE SET measure_position = EXCLUDED.measure_position, origin = 'auto', updated_at = now()
    `,
    [normalizedUserId, electionId, position, raceType]
  );
  return (inserted.rowCount ?? 0) > 0;
}

async function writeDecision(
  client: Queryable,
  normalizedUserId: string,
  result: AutoPickElectionResult
): Promise<boolean> {
  if (result.race_type === "ballot_measure") {
    if (result.measure_position === null) {
      return true;
    }
    return writeMeasurePosition(client, normalizedUserId, result.election_id, result.measure_position, "ballot_measure");
  }
  if (result.measure_position !== null) {
    // Retention: the Yes/No lands on the office race itself, the same row
    // shape the manual writer uses (userElectionChoices.writeMeasurePosition).
    return writeMeasurePosition(client, normalizedUserId, result.election_id, result.measure_position, "office");
  }

  for (const candidateId of result.picked_candidate_ids) {
    const inserted = await client.query(
      `
        INSERT INTO public.user_election_choices (user_id, election_id, candidate_id, origin)
        SELECT $1::uuid, candidate_election.election_id, candidate_election.candidate_id, 'auto'
        FROM public.candidate_elections AS candidate_election
        JOIN public.candidates AS candidate
          ON candidate.id = candidate_election.candidate_id
         AND candidate.deleted_at IS NULL
         AND candidate.merged_into_candidate_id IS NULL
        JOIN public.elections AS election
          ON election.id = candidate_election.election_id
         AND election.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
        WHERE candidate_election.candidate_id = $3::uuid
          AND candidate_election.election_id = $2::uuid
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
        ON CONFLICT (user_id, election_id, candidate_id) WHERE candidate_id IS NOT NULL
        DO UPDATE SET origin = 'auto', updated_at = now()
      `,
      [normalizedUserId, result.election_id, candidateId]
    );
    if ((inserted.rowCount ?? 0) === 0) {
      return false;
    }
  }
  return true;
}

export type ApplyAutoPicksInput = {
  electionIds: readonly string[];
  mode: AutoPickMode;
  dryRun?: boolean;
};

/**
 * Runs the engine over the given elections for one user.
 *
 * - fill_empty skips elections that already have any pick;
 * - replace overwrites — but only when the engine actually produced a pick
 *   (a "no pick" outcome must not wipe a manual pick the user already made);
 * - dry_run computes everything without writing;
 * - each election runs in its own transaction, so a failed write never
 *   leaves a half-filled multi-seat race, and one bad election does not
 *   roll back the batch.
 */
export async function applyAutoPicks(
  db: TransactionalDb & Queryable,
  userId: string,
  input: ApplyAutoPicksInput
): Promise<AutoPicksResult> {
  const normalizedUserId = normalizeUserId(userId);
  if (input.mode !== "fill_empty" && input.mode !== "replace") {
    throw new AutoPickError("invalid_input", "mode must be 'fill_empty' or 'replace'");
  }
  if (input.electionIds.length === 0) {
    throw new AutoPickError("invalid_input", "election_ids must not be empty");
  }
  if (input.electionIds.length > MAX_AUTO_PICK_ELECTION_IDS) {
    throw new AutoPickError(
      "invalid_input",
      `election_ids must contain at most ${MAX_AUTO_PICK_ELECTION_IDS} ids`
    );
  }
  const normalizedElectionIds = input.electionIds.map(normalizeElectionId);
  const seenElectionIds = new Set<string>();
  for (const electionId of normalizedElectionIds) {
    const dedupeKey = electionId.toLowerCase();
    if (seenElectionIds.has(dedupeKey)) {
      throw new AutoPickError("invalid_input", `election_ids contains a duplicate: ${electionId}`);
    }
    seenElectionIds.add(dedupeKey);
  }
  const dryRun = input.dryRun === true;

  await assertActiveUser(db, normalizedUserId, false);

  // Prevalidate every id BEFORE any write: elections commit one at a time,
  // so an unknown id discovered mid-batch would turn "some choices already
  // written" into an error response the caller reads as "nothing happened".
  const foundElections = await db.query<{ id: string }>(
    `
      SELECT id::text AS id
      FROM public.elections
      WHERE id = ANY($1::uuid[])
    `,
    [normalizedElectionIds]
  );
  const foundElectionIds = new Set(foundElections.rows.map((row) => row.id.toLowerCase()));
  const missingElectionIds = normalizedElectionIds.filter(
    (electionId) => !foundElectionIds.has(electionId.toLowerCase())
  );
  if (missingElectionIds.length > 0) {
    throw new AutoPickError("election_not_found", `Election not found: ${missingElectionIds.join(", ")}`);
  }

  // Dry runs write nothing, so one preferences read up front is fine. The
  // write path loads them per election INSIDE its transaction instead — see
  // applyOne.
  const dryRunIssues = dryRun ? await loadIssues(db, normalizedUserId) : null;

  const results: AutoPickElectionResult[] = [];
  for (const electionId of normalizedElectionIds) {
    if (dryRun) {
      results.push(await computeOne(db, normalizedUserId, dryRunIssues!, electionId, input.mode));
    } else {
      results.push(await applyOne(db, normalizedUserId, electionId, input.mode));
    }
  }
  return { results };
}

/** Read-only pass for dry_run — same decisions, nothing written. */
async function computeOne(
  db: Queryable,
  normalizedUserId: string,
  issues: readonly AutoPickIssue[],
  normalizedElectionId: string,
  mode: AutoPickMode
): Promise<AutoPickElectionResult> {
  const election = await loadElection(db, normalizedElectionId);
  if (!election.is_upcoming) {
    return emptyResult(election.id, election.race_type, "no_pick", "election_closed");
  }
  if (mode === "fill_empty" && (await countExistingPicks(db, normalizedUserId, normalizedElectionId)) > 0) {
    return emptyResult(election.id, election.race_type, "skipped_existing", null);
  }
  if (issues.length < MIN_AUTO_PICK_ISSUES) {
    // Below the floor the engine does not score, but the "add these
    // issues" prompt is MORE useful here, not less: it is how a user with
    // zero or two ranked issues gets to three without guessing in Settings.
    // Same loaders as the scored path, over the whole live roster (nothing
    // is narrowed yet).
    const result = emptyResult(election.id, election.race_type, "no_pick", "too_few_issues");
    result.suggested_issues = await loadUncoveredAreasForElection(db, issues, election);
    return result;
  }
  return computeDecision(db, issues, election);
}

async function loadUncoveredAreasForElection(
  db: Queryable,
  issues: readonly AutoPickIssue[],
  election: ElectionRow
): Promise<AutoPickSuggestedIssue[]> {
  const areaIds = issues.map((issue) => issue.researchAreaId);
  if (election.race_type === "ballot_measure") {
    return loadUncoveredMeasureAreas(db, election.id, areaIds);
  }
  const candidates = await loadCandidates(db, election.id);
  return loadUncoveredRecordAreas(
    db,
    candidates.map((candidate) => candidate.candidateId),
    areaIds,
    election.office_id
  );
}

async function applyOne(
  db: TransactionalDb,
  normalizedUserId: string,
  normalizedElectionId: string,
  mode: AutoPickMode
): Promise<AutoPickElectionResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE on the user row serializes this user's choice writes against
    // the manual write path (setUserElectionChoice takes the same lock), so
    // the fill_empty check and the seat-capped inserts are race-safe.
    await assertActiveUser(client, normalizedUserId, true);
    // Preferences load AFTER the lock: the preferences writer takes the same
    // user FOR UPDATE lock, so this read sees the latest committed settings —
    // a save from another tab moments earlier can't produce picks computed
    // from the old settings.
    const issues = await loadIssues(client, normalizedUserId);
    const result = await computeOne(client, normalizedUserId, issues, normalizedElectionId, mode);
    const wrote =
      result.outcome === "picked" &&
      (result.picked_candidate_ids.length > 0 || result.measure_position !== null);
    if (wrote) {
      if (mode === "replace") {
        // Only when there is something to write: "replace" must never turn a
        // failed engine run into a wiped manual pick.
        await client.query(
          `
            DELETE FROM public.user_election_choices
            WHERE user_id = $1::uuid
              AND election_id = $2::uuid
          `,
          [normalizedUserId, normalizedElectionId]
        );
      }
      const written = await writeDecision(client, normalizedUserId, result);
      if (!written) {
        // The same-statement gate refused: the election window closed between
        // compute and write (the only reachable path — catalog reads share
        // this transaction's snapshot). Roll back so a multi-seat race is
        // never left half-filled.
        await client.query("ROLLBACK");
        return emptyResult(normalizedElectionId, result.race_type, "no_pick", "election_closed");
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

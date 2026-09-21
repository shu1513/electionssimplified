/**
 * Sweep-evidence guard for manual candidate-record writes.
 *
 * A zero-record or neutral-only manual records pass asserts that the
 * per-question discovery sweep was actually finished. That assertion used to
 * be honor-system (a bare CLI flag), which let an unfinished sweep write a
 * false `no_records_found` gap and stamp `last_records_searched_at` — after
 * which the candidate is never re-searched. This module makes the assertion
 * carry its evidence: the operator must supply the per-question evidence
 * table they were already required to keep, and the writer refuses the
 * completeness claim without it.
 *
 * The guard deliberately validates only shape, not truth: the smallest
 * complete question list (judicial candidates) has three questions, so three
 * entries is the floor. Truth of the findings stays unverifiable, but the
 * ROUTING of the sweep no longer relies on skill discipline: the 2026-07-15
 * bulk runs collapsed every candidate onto a generic officeholder-framed
 * template (first-time candidates were never asked the career question) and
 * their 4-entry ledgers passed this guard. Full-history completeness claims
 * now require each entry to be tagged with a question_id and the tagged set
 * to cover the candidate's route (officeholder / never-held / judicial) —
 * see resolveSweepRoute and listMissingSweepRouteQuestionIds. Era coverage
 * remains research-derived and unchecked.
 *
 * Validated confirmations are also persisted (candidate_record_sweep_confirmations,
 * one row per candidate and context) so manual:records:audit can tell
 * an evidence-backed confirmed-null candidate apart from a skipped sweep.
 * A later write MERGES into the row (see writeMergedSweepConfirmation): prior
 * evidence entries stay, and the completeness claims are re-checked against
 * the candidate's whole active record set, not just the new batch.
 * A stance-bearing FULL-history sweep that supplies its ledger persists too,
 * with an empty claim set (confirmed_gap_ids = '{}'): "sweep ran with
 * evidence; stance-labeled records found; no completeness claims". Delta
 * (windowed) writes never persist their window ledger — window evidence
 * cannot back a full-history claim.
 */

import type { PoolClient } from "pg";

import { NON_STANCE_RESEARCH_AREA_SLUGS } from "../pipeline/candidates/candidateRecordResearchAreaPolicy.js";

export const SWEEP_EVIDENCE_MIN_ENTRIES = 3;

export const SWEEP_COMPLETENESS_GAP_IDS: ReadonlySet<string> = new Set([
  "candidate_records.no_records_found",
  "candidate_records.only_general_labels",
]);

/**
 * Discovery routes and their canonical question ids, mirroring the three
 * question lists in the manual-research skill (references/records.md) and the
 * AI discovery prompt. A route's every id must appear on at least one tagged
 * evidence entry before a full-history completeness claim is accepted; a
 * question that cannot apply (e.g. `executive` for a legislator who never
 * held an executive role) still gets its one-line entry — that IS the answer.
 * Era-split sweeps tag multiple entries with the same id.
 */
export const SWEEP_ROUTE_QUESTION_IDS = {
  officeholder: [
    "rollcalls",
    "sponsorship",
    "executive",
    "proceedings",
    "leadership",
    "outside_chamber",
    "endorsements",
  ],
  never_held_office: ["career", "orgs_advocacy", "court_legal", "endorsements"],
  judicial: ["cases", "discipline", "endorsements"],
} as const satisfies Record<string, readonly string[]>;

export type SweepRoute = keyof typeof SWEEP_ROUTE_QUESTION_IDS;

const ALL_SWEEP_QUESTION_IDS: ReadonlySet<string> = new Set(
  Object.values(SWEEP_ROUTE_QUESTION_IDS).flat()
);

export type SweepEvidenceEntry = {
  question: string;
  finding: string;
  /**
   * Canonical discovery-question id this entry answers (null for extra
   * entries outside the route's list: archive scans, office-area follow-ups).
   */
  questionId: string | null;
};

export type SweepEvidenceParseResult =
  | {
      ok: true;
      entries: SweepEvidenceEntry[];
      /**
       * Top-level `has_held_public_office` from the evidence file: the
       * operator's research-derived routing answer, used (and persisted)
       * only when candidates.has_held_public_office is still NULL.
       */
      hasHeldPublicOffice: boolean | null;
    }
  | { ok: false; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A completeness assertion is being made when the verified record set is
 * empty (which stamps search completion even without any flag) or when the
 * operator passes a sweep-completeness confirmed-gap id.
 */
export function sweepEvidenceRequired(input: {
  recordCount: number;
  confirmedGapIds: ReadonlySet<string>;
}): boolean {
  if (input.recordCount === 0) {
    return true;
  }
  for (const id of input.confirmedGapIds) {
    if (SWEEP_COMPLETENESS_GAP_IDS.has(id)) {
      return true;
    }
  }
  return false;
}

export function parseSweepEvidencePayload(payload: unknown): SweepEvidenceParseResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "evidence payload must be an object with an entries array" };
  }
  const input = payload as Record<string, unknown>;
  if (!Array.isArray(input.entries)) {
    return { ok: false, reason: "evidence payload.entries must be an array" };
  }
  if (
    input.has_held_public_office !== undefined &&
    typeof input.has_held_public_office !== "boolean"
  ) {
    return {
      ok: false,
      reason: "evidence payload.has_held_public_office must be a boolean when present",
    };
  }
  const entries: SweepEvidenceEntry[] = [];
  const seenQuestions = new Map<string, number>();
  for (const [index, row] of input.entries.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return { ok: false, reason: `evidence entries[${index}] must be an object` };
    }
    const entry = row as Record<string, unknown>;
    if (!isNonEmptyString(entry.question)) {
      return { ok: false, reason: `evidence entries[${index}].question must be a non-empty string` };
    }
    if (!isNonEmptyString(entry.finding)) {
      return {
        ok: false,
        reason: `evidence entries[${index}].finding must be a non-empty string (use "nothing found" for empty answers)`,
      };
    }
    let questionId: string | null = null;
    if (entry.question_id !== undefined && entry.question_id !== null) {
      if (typeof entry.question_id !== "string" || !ALL_SWEEP_QUESTION_IDS.has(entry.question_id)) {
        return {
          ok: false,
          reason: `evidence entries[${index}].question_id must be one of: ${[...ALL_SWEEP_QUESTION_IDS].sort().join(", ")}; got ${JSON.stringify(entry.question_id)}. Omit question_id on extra entries (archive scans, office-area follow-ups).`,
        };
      }
      questionId = entry.question_id;
    }
    const question = entry.question.trim();
    const normalizedQuestion = question.toLowerCase().replace(/\s+/g, " ");
    const duplicateOf = seenQuestions.get(normalizedQuestion);
    if (duplicateOf !== undefined) {
      return {
        ok: false,
        reason: `evidence entries[${index}].question duplicates entries[${duplicateOf}] — each row must be a distinct discovery question (asking the same question for a different era/session? name the era in the question text)`,
      };
    }
    seenQuestions.set(normalizedQuestion, index);
    entries.push({ question, finding: entry.finding.trim(), questionId });
  }
  if (entries.length < SWEEP_EVIDENCE_MIN_ENTRIES) {
    return {
      ok: false,
      reason: `evidence payload.entries needs at least ${SWEEP_EVIDENCE_MIN_ENTRIES} question/finding rows (one per discovery question actually asked); got ${entries.length}`,
    };
  }
  return {
    ok: true,
    entries,
    hasHeldPublicOffice: (input.has_held_public_office as boolean | undefined) ?? null,
  };
}

export type SweepRouteResolution =
  | {
      ok: true;
      route: SweepRoute;
      /**
       * Non-null when candidates.has_held_public_office is NULL and the
       * evidence file supplied the answer: the writer persists it inside the
       * write transaction so the next sweep routes from the database.
       */
      persistHasHeldPublicOffice: boolean | null;
    }
  | { ok: false; reason: string };

/**
 * Derive which question list a full-history completeness claim must cover.
 * Judicial contests route on the election's discovery_contest_family alone;
 * everything else routes on has-EVER-held-public-office — the database
 * column when set, else the evidence file's has_held_public_office answer.
 * A contradiction between the two is refused rather than silently resolved:
 * one of them is wrong, and the operator has the research in front of them.
 */
export function hasHeldPublicOfficeContradiction(input: {
  candidateHasHeldPublicOffice: boolean | null;
  evidenceHasHeldPublicOffice: boolean | null;
}): string | null {
  if (
    input.candidateHasHeldPublicOffice === null ||
    input.evidenceHasHeldPublicOffice === null ||
    input.candidateHasHeldPublicOffice === input.evidenceHasHeldPublicOffice
  ) {
    return null;
  }
  return `evidence file says has_held_public_office=${input.evidenceHasHeldPublicOffice} but candidates.has_held_public_office=${input.candidateHasHeldPublicOffice}. One of them is wrong: if the evidence file is wrong, fix it; if the stored value is stale, correct it with a profile re-write carrying the researched answer and --replace-profile-fields has_held_public_office (manual:candidate-profile:write or manual:presidential-profile:write), then rerun this records write.`;
}

/**
 * Holding an office NOW implies having held one — the same rule the profile
 * contract and merge guard enforce. Without this check here, a records
 * write on a column-NULL candidate could claim has_held_public_office=false,
 * take the shorter never_held question list, and persist the false answer,
 * even when candidates.current_office plainly says otherwise.
 */
export function currentOfficeRoutingContradiction(input: {
  candidateCurrentOffice: string | null;
  hasHeldPublicOffice: boolean | null;
}): string | null {
  const office = input.candidateCurrentOffice?.trim() ?? "";
  if (office === "" || input.hasHeldPublicOffice !== false) {
    return null;
  }
  return `candidates.current_office ("${office}") contradicts has_held_public_office=false — a candidate holding a public office now HAS held public office. If the office is real, the routing answer must be true; if current_office is stale or holds an occupation, clear or replace it with a profile write (--clear-profile-fields current_office / --replace-profile-fields current_office), then rerun this records write.`;
}

/**
 * The routing checks a DELTA (windowed) write runs: it asserts only its
 * window and never persists a routing answer, but it must not proceed on a
 * contradictory routing state — a stored-vs-evidence disagreement, or a
 * never-held answer (stored OR claimed) against a set current_office. The
 * office check uses the same EFFECTIVE answer as resolveSweepRoute; passing
 * only the evidence answer would let a legacy stored-false row with a set
 * office slip through whenever the delta ledger omits the optional field.
 */
export function deltaSweepRoutingContradiction(input: {
  candidateCurrentOffice: string | null;
  candidateHasHeldPublicOffice: boolean | null;
  evidenceHasHeldPublicOffice: boolean | null;
}): string | null {
  return (
    hasHeldPublicOfficeContradiction({
      candidateHasHeldPublicOffice: input.candidateHasHeldPublicOffice,
      evidenceHasHeldPublicOffice: input.evidenceHasHeldPublicOffice,
    }) ??
    currentOfficeRoutingContradiction({
      candidateCurrentOffice: input.candidateCurrentOffice,
      hasHeldPublicOffice:
        input.candidateHasHeldPublicOffice ?? input.evidenceHasHeldPublicOffice,
    })
  );
}

export function resolveSweepRoute(input: {
  discoveryContestFamily: string | null;
  candidateCurrentOffice: string | null;
  candidateHasHeldPublicOffice: boolean | null;
  evidenceHasHeldPublicOffice: boolean | null;
}): SweepRouteResolution {
  const { candidateHasHeldPublicOffice, evidenceHasHeldPublicOffice } = input;
  const contradiction = hasHeldPublicOfficeContradiction({
    candidateHasHeldPublicOffice,
    evidenceHasHeldPublicOffice,
  });
  if (contradiction !== null) {
    return { ok: false, reason: contradiction };
  }
  // Checked on the EFFECTIVE answer and before the judicial branch: the
  // judicial route also persists a column-NULL candidate's evidence answer,
  // so a false claim against a set current_office must not slip through it.
  const officeContradiction = currentOfficeRoutingContradiction({
    candidateCurrentOffice: input.candidateCurrentOffice,
    hasHeldPublicOffice: candidateHasHeldPublicOffice ?? evidenceHasHeldPublicOffice,
  });
  if (officeContradiction !== null) {
    return { ok: false, reason: officeContradiction };
  }
  const persistHasHeldPublicOffice =
    candidateHasHeldPublicOffice === null ? evidenceHasHeldPublicOffice : null;
  if (input.discoveryContestFamily === "judicial_office") {
    return { ok: true, route: "judicial", persistHasHeldPublicOffice };
  }
  const hasHeld = candidateHasHeldPublicOffice ?? evidenceHasHeldPublicOffice;
  if (hasHeld === null) {
    return {
      ok: false,
      reason:
        'Cannot route the sweep-completeness check: candidates.has_held_public_office is NULL and the evidence file has no top-level "has_held_public_office". Answer it from the profile research (has this candidate EVER held public office, current or former?) and add "has_held_public_office": true|false to the evidence file.',
    };
  }
  return {
    ok: true,
    route: hasHeld ? "officeholder" : "never_held_office",
    persistHasHeldPublicOffice,
  };
}

/**
 * The route question ids not yet covered by any tagged entry. Empty means
 * the claim's question list was fully worked; anything else blocks the
 * completeness claim.
 */
export function listMissingSweepRouteQuestionIds(
  entries: readonly Pick<SweepEvidenceEntry, "questionId">[],
  route: SweepRoute
): string[] {
  const tagged = new Set(entries.map((entry) => entry.questionId).filter((id) => id !== null));
  return SWEEP_ROUTE_QUESTION_IDS[route].filter((id) => !tagged.has(id));
}

/**
 * The full route-coverage gate both records writers run before persisting a
 * full-history ledger: resolve the route (or refuse), then require every
 * route question id on at least one tagged entry. Throws with the
 * operator-facing message; returns the route and the routing answer to
 * persist (non-null only when candidates.has_held_public_office is NULL and
 * the evidence file supplied it).
 */
export function enforceSweepRouteCoverage(input: {
  discoveryContestFamily: string | null;
  candidateCurrentOffice: string | null;
  candidateHasHeldPublicOffice: boolean | null;
  evidenceHasHeldPublicOffice: boolean | null;
  entries: readonly SweepEvidenceEntry[];
}): { route: SweepRoute; persistHasHeldPublicOffice: boolean | null } {
  const resolution = resolveSweepRoute({
    discoveryContestFamily: input.discoveryContestFamily,
    candidateCurrentOffice: input.candidateCurrentOffice,
    candidateHasHeldPublicOffice: input.candidateHasHeldPublicOffice,
    evidenceHasHeldPublicOffice: input.evidenceHasHeldPublicOffice,
  });
  if (!resolution.ok) {
    throw new Error(`Sweep evidence routing failed: ${resolution.reason}`);
  }
  const missingQuestionIds = listMissingSweepRouteQuestionIds(input.entries, resolution.route);
  if (missingQuestionIds.length > 0) {
    throw new Error(
      `Sweep evidence does not cover the ${resolution.route} question list: missing question_id ${missingQuestionIds.join(", ")}. Tag each entry with its question_id (era-split sweeps tag several entries with the same id; extra entries like archive scans omit it). A question that cannot apply still gets its one-line entry — the finding says why it does not apply.`
    );
  }
  return {
    route: resolution.route,
    persistHasHeldPublicOffice: resolution.persistHasHeldPublicOffice,
  };
}

/**
 * Persist the first evidence-backed routing answer inside the write
 * transaction. Guarded on IS NULL so a set value is never overwritten — but
 * the guard alone is not enough under concurrency: two writers can both read
 * NULL before either commits, resolve OPPOSITE routes, and the loser's
 * conditional update would silently match zero rows while its
 * opposite-routed confirmation still committed. So a zero-row update
 * re-reads the column: same value → another writer persisted the same
 * answer, fine; different value → throw, rolling back this writer's
 * confirmation with it.
 */
export async function persistHasHeldPublicOfficeAnswer(
  client: Pick<PoolClient, "query">,
  candidateId: string,
  value: boolean
): Promise<void> {
  const updated = await client.query(
    `
      UPDATE public.candidates
      SET has_held_public_office = $2,
          updated_at = now()
      WHERE id = $1
        AND has_held_public_office IS NULL
    `,
    [candidateId, value]
  );
  if ((updated.rowCount ?? 0) > 0) {
    return;
  }
  const current = await client.query<{ has_held_public_office: boolean | null }>(
    `SELECT has_held_public_office FROM public.candidates WHERE id = $1`,
    [candidateId]
  );
  const stored = current.rows[0]?.has_held_public_office ?? null;
  if (stored !== value) {
    throw new Error(
      `candidates.has_held_public_office is now ${stored} but this write resolved has_held_public_office=${value} from its evidence file — a concurrent write landed first with the opposite answer. Nothing was written; re-check the research and rerun against the stored value.`
    );
  }
}

/**
 * The completeness claims a passing write actually asserts: zero verified
 * records implies no_records_found even without any flag, and the
 * only_general_labels claim can arrive as either an operator flag or a
 * detected quality gap. Non-completeness gap ids are ignored.
 */
export function assertedSweepCompletenessGapIds(input: {
  recordCount: number;
  confirmedGapIds: ReadonlySet<string>;
  qualityGapIds: readonly string[];
}): string[] {
  const asserted = new Set<string>();
  if (input.recordCount === 0) {
    asserted.add("candidate_records.no_records_found");
  }
  for (const id of [...input.confirmedGapIds, ...input.qualityGapIds]) {
    if (SWEEP_COMPLETENESS_GAP_IDS.has(id)) {
      asserted.add(id);
    }
  }
  return [...asserted].sort();
}

/**
 * Whether a supplied, validated --evidence-file's entries should flow into
 * the writer's confirmation-handling branch. Full-history writes always
 * keep them: the ledger is persisted (with an empty claim set when the
 * sweep found stance-labeled records). Delta writes keep them only when the
 * zero-record path REQUIRED them — there they gate a timestamp refresh of
 * the prior full-history confirmation, never an upsert; a non-required
 * window ledger stays external (validated and counted only).
 */
export function retainSuppliedSweepEvidence(input: {
  evidenceRequired: boolean;
  deltaMode: boolean;
}): boolean {
  return input.evidenceRequired || !input.deltaMode;
}

/**
 * Persist the validated confirmation inside the writer's transaction. One
 * row per candidate and research context: a newer sweep supersedes only the
 * same context. An empty confirmedGapIds list is valid and means the
 * evidenced full sweep found stance-labeled records and asserts no
 * completeness claim.
 */
export async function upsertSweepConfirmation(
  client: Pick<PoolClient, "query">,
  input: {
    candidateId: string;
    confirmedGapIds: readonly string[];
    entries: readonly SweepEvidenceEntry[];
    contextType: "election" | "presidential_cycle";
    contextId: string;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO public.candidate_record_sweep_confirmations
        (candidate_id, confirmed_gap_ids, evidence, context_type, context_id)
      VALUES ($1, $2::text[], $3::jsonb, $4, $5)
      ON CONFLICT (candidate_id, context_type, context_id)
      DO UPDATE SET
        confirmed_gap_ids = EXCLUDED.confirmed_gap_ids,
        evidence = EXCLUDED.evidence,
        confirmed_at = now(),
        updated_at = now()
    `,
    [
      input.candidateId,
      [...input.confirmedGapIds],
      // Stored shape mirrors the evidence-file contract (snake_case
      // question_id, omitted when untagged) so audits read one format.
      JSON.stringify({
        entries: input.entries.map((entry) => ({
          question: entry.question,
          finding: entry.finding,
          ...(entry.questionId != null ? { question_id: entry.questionId } : {}),
        })),
      }),
      input.contextType,
      input.contextId,
    ]
  );
}

export type CandidateRecordSetShape = {
  /** Active (non-retired) candidate_records rows. */
  activeRecordCount: number;
  /** Active records with at least one stance-area (non-general) label. */
  stanceLabeledRecordCount: number;
};

/**
 * Completeness claims describe the candidate's WHOLE record set, but a
 * writer only sees its own batch. A small additive write whose new rows are
 * all general-labeled used to store only_general_labels for a candidate with
 * many stance-labeled records. Keep a claim only when the full active record
 * set still supports it; other ids pass through untouched.
 */
export function claimsSupportedByRecordSet(
  claims: readonly string[],
  shape: CandidateRecordSetShape
): string[] {
  return claims.filter((id) => {
    if (id === "candidate_records.no_records_found") {
      return shape.activeRecordCount === 0;
    }
    if (id === "candidate_records.only_general_labels") {
      return shape.activeRecordCount > 0 && shape.stanceLabeledRecordCount === 0;
    }
    return true;
  });
}

function normalizeSweepQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Read a stored ledger back into entries. Tolerant on purpose: a malformed
 * stored entry is skipped rather than failing the write that merges into it.
 */
export function parseStoredSweepEvidenceEntries(evidence: unknown): SweepEvidenceEntry[] {
  const rawEntries =
    typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>).entries
      : null;
  if (!Array.isArray(rawEntries)) {
    return [];
  }
  const entries: SweepEvidenceEntry[] = [];
  for (const row of rawEntries) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      continue;
    }
    const entry = row as Record<string, unknown>;
    if (!isNonEmptyString(entry.question) || !isNonEmptyString(entry.finding)) {
      continue;
    }
    entries.push({
      question: entry.question.trim(),
      finding: entry.finding.trim(),
      questionId: typeof entry.question_id === "string" ? entry.question_id : null,
    });
  }
  return entries;
}

/**
 * Prior entries keep their place; a new entry for the same question
 * (case/space-insensitive) replaces the prior answer, and new questions are
 * appended. Earlier evidence is never dropped by a later, smaller write.
 */
export function mergeSweepEvidenceEntries(
  prior: readonly SweepEvidenceEntry[],
  next: readonly SweepEvidenceEntry[]
): SweepEvidenceEntry[] {
  const merged = [...prior];
  const indexByQuestion = new Map(merged.map((entry, index) => [normalizeSweepQuestion(entry.question), index]));
  for (const entry of next) {
    const key = normalizeSweepQuestion(entry.question);
    const existing = indexByQuestion.get(key);
    if (existing === undefined) {
      indexByQuestion.set(key, merged.length);
      merged.push(entry);
    } else {
      merged[existing] = entry;
    }
  }
  return merged;
}

export async function loadCandidateRecordSetShape(
  client: Pick<PoolClient, "query">,
  candidateId: string
): Promise<CandidateRecordSetShape> {
  const result = await client.query<{ active_record_count: string; stance_labeled_record_count: string }>(
    `
      SELECT
        count(*)::text AS active_record_count,
        count(*) FILTER (
          WHERE EXISTS (
            SELECT 1
            FROM public.candidate_record_area_tags t
            JOIN public.research_areas ra ON ra.id = t.research_area_id
            WHERE t.candidate_record_id = r.id
              AND NOT (ra.slug = ANY($2::text[]))
          )
        )::text AS stance_labeled_record_count
      FROM public.candidate_records r
      WHERE r.candidate_id = $1
        AND r.retired_at IS NULL
    `,
    [candidateId, [...NON_STANCE_RESEARCH_AREA_SLUGS]]
  );
  return {
    activeRecordCount: Number(result.rows[0]?.active_record_count ?? "0"),
    stanceLabeledRecordCount: Number(result.rows[0]?.stance_labeled_record_count ?? "0"),
  };
}

/**
 * Remove every completeness claim the candidate's active record set no
 * longer supports, in ALL of the candidate's contexts. Claims are
 * candidate-wide, so stanced records written for one election falsify an
 * only_general_labels claim stored for another. Rows and their evidence
 * stay; confirmed_at is not bumped (nothing was re-swept). Returns the
 * number of rows changed.
 */
export async function pruneUnsupportedSweepClaims(
  client: Pick<PoolClient, "query">,
  candidateId: string,
  shape: CandidateRecordSetShape,
  /** Limit the check to these claim ids (default: every completeness id). */
  gapIds: readonly string[] = [...SWEEP_COMPLETENESS_GAP_IDS]
): Promise<number> {
  const completenessIds = gapIds.filter((id) => SWEEP_COMPLETENESS_GAP_IDS.has(id));
  const supported = new Set(claimsSupportedByRecordSet(completenessIds, shape));
  const unsupported = completenessIds.filter((id) => !supported.has(id));
  if (unsupported.length === 0) {
    return 0;
  }
  const result = await client.query(
    `
      UPDATE public.candidate_record_sweep_confirmations
      SET confirmed_gap_ids = ARRAY(
            SELECT gap_id
            FROM unnest(confirmed_gap_ids) AS gap_id
            WHERE NOT (gap_id = ANY($2::text[]))
          ),
          updated_at = now()
      WHERE candidate_id = $1
        AND confirmed_gap_ids && $2::text[]
    `,
    [candidateId, unsupported]
  );
  return result.rowCount ?? 0;
}

/**
 * The writers' persist step. Run inside the write transaction, AFTER this
 * write's records and labels are stored, so the record-set check sees them.
 * Locks the existing row, merges its evidence with this write's entries,
 * keeps only the asserted claims the whole active record set supports, and
 * prunes claims the record set falsifies in the candidate's other contexts.
 */
export async function writeMergedSweepConfirmation(
  client: Pick<PoolClient, "query">,
  input: {
    candidateId: string;
    assertedGapIds: readonly string[];
    entries: readonly SweepEvidenceEntry[];
    contextType: "election" | "presidential_cycle";
    contextId: string;
  }
): Promise<{
  confirmedGapIds: string[];
  droppedGapIds: string[];
  entryCount: number;
  otherContextRowsPruned: number;
}> {
  const prior = await client.query<{ evidence: unknown }>(
    `
      SELECT evidence
      FROM public.candidate_record_sweep_confirmations
      WHERE candidate_id = $1
        AND context_type = $2
        AND context_id = $3
      FOR UPDATE
    `,
    [input.candidateId, input.contextType, input.contextId]
  );
  const entries = mergeSweepEvidenceEntries(
    parseStoredSweepEvidenceEntries(prior.rows[0]?.evidence ?? null),
    input.entries
  );
  const shape = await loadCandidateRecordSetShape(client, input.candidateId);
  const confirmedGapIds = claimsSupportedByRecordSet(input.assertedGapIds, shape);
  const droppedGapIds = input.assertedGapIds.filter((id) => !confirmedGapIds.includes(id));
  await upsertSweepConfirmation(client, {
    candidateId: input.candidateId,
    confirmedGapIds,
    entries,
    contextType: input.contextType,
    contextId: input.contextId,
  });
  // This context's row is already consistent, so any row changed here
  // belongs to another context.
  const otherContextRowsPruned = await pruneUnsupportedSweepClaims(client, input.candidateId, shape);
  return { confirmedGapIds, droppedGapIds, entryCount: entries.length, otherContextRowsPruned };
}

/**
 * Re-assert an existing confirmation without touching its content: a
 * zero-record DELTA write re-verified the claim for its window, and the
 * audit treats a confirmation older than the latest search stamp as
 * historical — so confirmed_at must advance with the stamp. The original
 * full-sweep evidence, gap ids, and context are the support for the
 * full-history claim and must NOT be replaced by window-only evidence
 * (the window evidence lives in the writer's --evidence-file and the run
 * report). Caller guarantees the row exists.
 */
export async function refreshSweepConfirmationTimestamp(
  client: Pick<PoolClient, "query">,
  input: {
    candidateId: string;
    contextType: "election" | "presidential_cycle";
    contextId: string;
  }
): Promise<void> {
  await client.query(
    `
      UPDATE public.candidate_record_sweep_confirmations
      SET confirmed_at = now(),
          updated_at = now()
      WHERE candidate_id = $1
        AND context_type = $2
        AND context_id = $3
    `,
    [input.candidateId, input.contextType, input.contextId]
  );
}

/**
 * A live write that found real, stance-labeled records without carrying a
 * ledger falsifies any earlier COMPLETENESS confirmation — the table would
 * otherwise keep asserting no_records_found / only_general_labels for a
 * candidate who now has records — so remove such rows inside the same
 * transaction. Empty-claim-set rows ("sweep ran, stances found") are NOT
 * falsified by finding more records; they stay and age out against the
 * search stamp like any confirmation (the audit already treats a
 * confirmation older than the latest stamp as historical).
 *
 * Candidate-wide on purpose: completeness claims describe the candidate's
 * record set, so a claim made in any context is falsified by records found
 * in any other. Empty-claim-set rows only age out where the write ALSO
 * advances last_records_searched_at (the district writer does); a writer
 * that advances no stamp must additionally drop its own context's
 * empty-claim row with deleteSweepConfirmation.
 */
export async function deleteSweepCompletenessConfirmation(
  client: Pick<PoolClient, "query">,
  candidateId: string,
  options: {
    /** Keep this context's row: the caller merges into it right after. */
    exceptContext?: { contextType: "election" | "presidential_cycle"; contextId: string };
  } = {}
): Promise<void> {
  if (options.exceptContext) {
    await client.query(
      `
        DELETE FROM public.candidate_record_sweep_confirmations
        WHERE candidate_id = $1
          AND confirmed_gap_ids && $2::text[]
          AND NOT (context_type = $3 AND context_id = $4)
      `,
      [
        candidateId,
        [...SWEEP_COMPLETENESS_GAP_IDS],
        options.exceptContext.contextType,
        options.exceptContext.contextId,
      ]
    );
    return;
  }
  await client.query(
    `
      DELETE FROM public.candidate_record_sweep_confirmations
      WHERE candidate_id = $1
        AND confirmed_gap_ids && $2::text[]
    `,
    [candidateId, [...SWEEP_COMPLETENESS_GAP_IDS]]
  );
}

/**
 * Unconditional variant for writers that advance no per-candidate search
 * stamp (manual:presidential-records:write — markCandidateRecordsSearchCompleted
 * is district-path only). Without an advancing stamp, a surviving
 * empty-claim-set row could never be dated as historical, so "newest sweep
 * wins" demands removal when a newer sweep arrives without a ledger.
 */
export async function deleteSweepConfirmation(
  client: Pick<PoolClient, "query">,
  input: {
    candidateId: string;
    contextType: "election" | "presidential_cycle";
    contextId: string;
  }
): Promise<void> {
  await client.query(
    `
      DELETE FROM public.candidate_record_sweep_confirmations
      WHERE candidate_id = $1
        AND context_type = $2
        AND context_id = $3
    `,
    [input.candidateId, input.contextType, input.contextId]
  );
}

export function sweepEvidenceMissingError(context: string): Error {
  return new Error(
    [
      `A zero-record or neutral-only ${context} pass asserts a FINISHED discovery sweep, so it requires --evidence-file evidence.json.`,
      `The file must contain {"entries": [{"question": "...", "finding": "...", "question_id": "..."}, ...]} — one row per discovery question actually asked (minimum ${SWEEP_EVIDENCE_MIN_ENTRIES}), with question_id tags covering the candidate's route question list.`,
      "If the question list has not been finished, finish it (or run the remaining questions) instead of asserting completeness.",
    ].join("\n")
  );
}

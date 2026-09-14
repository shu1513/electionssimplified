import { useSyncExternalStore } from "react";
import { ApiError, apiRequest, isDecidedChoice, splitRetentionRaces } from "@voteapp/api-client";
import type { ElectionChoice, ElectionSummary, PickProgress } from "@voteapp/api-client";

// Moved to @voteapp/api-client so mobile shares the one "decided" rule;
// re-exported here so this module stays the web's import site for it.
export { isDecidedChoice };

// Guest ballot draft: planned votes for visitors with no account, kept in
// localStorage so the draft survives restarts and flushes into
// /api/me/election-choices when they sign up (useFlushBallotDraft in App).
// Rows are stored in ElectionChoice shape — the pick chips, cards, and
// controls all consume that type, so a guest draft plugs into the same
// components as the server truth. localStorage (not sessionStorage, unlike
// pendingDistricts): the draft is the product here — losing 13 picks to a
// closed tab would defeat the point — while pending district ids are a
// one-shot handoff. Server-side caches were rejected outright: an anonymous
// visitor has no durable server identity to key one on.

const STORAGE_KEY = "voteapp_ballot_draft";

// Mirror of the backend's UUID_PATTERN (backend/src/utils/uuid.ts),
// version and variant nibbles included: the guard exists so a corrupt
// draft can never 400 /api/ballot, and the server rejects shapes like the
// nil UUID that a looser hex-only check would wave through.
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Mirror of the backend's MAX_BALLOT_DISTRICT_IDS (apiValidation.ts): a
// 51st id — corrupt drafts only; a real ballot stores far fewer — would
// 400 the whole request just like a malformed one.
const MAX_DRAFT_DISTRICT_IDS = 50;

export type BallotDraft = {
  v: 1;
  /** District ids of the ballot the draft was built on — the nav badge's
   * link target (/ballot?d=…). */
  district_ids: string[];
  /** Progress denominator: the nearest upcoming election day's race ids,
   * snapshotted on the last /ballot visit. Null until the guest sees a
   * ballot with an upcoming date. */
  target: {
    election_date: string;
    election_ids: string[];
    /** Optional metadata for the completion notice, never part of progress. */
    retention_ids?: string[];
  } | null;
  choices: Record<string, ElectionChoice>;
};

const EMPTY_DRAFT: BallotDraft = { v: 1, district_ids: [], target: null, choices: {} };

const listeners = new Set<() => void>();
let cache: BallotDraft | null = null;

// A pick row survives sanitization only with every field the readers touch.
// Invalid picks are dropped individually; a row left with no picks and no
// measure position is dropped whole (the same "decided" rule putRow keeps).
function sanitizeChoiceRow(value: unknown): ElectionChoice | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.election_id !== "string" ||
    typeof row.official_ballot_title !== "string" ||
    typeof row.election_date !== "string" ||
    typeof row.updated_at !== "string" ||
    (row.race_type !== "office" && row.race_type !== "ballot_measure") ||
    !Array.isArray(row.picks)
  ) {
    return null;
  }
  const picks = row.picks.filter(
    (pick): pick is ElectionChoice["picks"][number] =>
      typeof pick === "object" &&
      pick !== null &&
      typeof (pick as { candidate_id?: unknown }).candidate_id === "string" &&
      typeof (pick as { display_name?: unknown }).display_name === "string" &&
      typeof (pick as { candidacy_status?: unknown }).candidacy_status === "string"
  );
  const measurePosition =
    row.measure_position === "yes" || row.measure_position === "no" ? row.measure_position : null;
  if (picks.length === 0 && measurePosition === null) {
    return null;
  }
  return {
    election_id: row.election_id,
    race_type: row.race_type,
    official_ballot_title: row.official_ballot_title,
    election_date: row.election_date,
    seats_to_fill: typeof row.seats_to_fill === "number" ? row.seats_to_fill : null,
    picks,
    measure_position: measurePosition,
    updated_at: row.updated_at,
  };
}

// Field-by-field sanitization, never a cast: this value renders in the
// header on EVERY route (useGuestDraftNav), so a malformed draft — another
// script on the origin, a devtools edit, a bug in an older build — that
// merely parses as JSON would otherwise throw on .length/.picks in every
// render and brick the app persistently, since the bad bytes survive
// reloads. Anything salvageable is kept (a mangled row must not take twelve
// good picks with it); anything malformed degrades to its empty value.
function parseDraft(raw: string | null): BallotDraft {
  if (!raw) {
    return EMPTY_DRAFT;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_DRAFT;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return EMPTY_DRAFT;
  }
  const draft = parsed as Record<string, unknown>;
  if (draft.v !== 1) {
    return EMPTY_DRAFT;
  }
  // UUID-shape check, not just string: district_ids go verbatim into
  // /api/ballot?district_ids=..., where one malformed id 400s the whole
  // request — /draft then shows a hard error box instead of its
  // address-search fallback. Real drafts only ever copy server-issued
  // UUIDs, so dropping a non-UUID only ever discards corrupt bytes.
  const districtIds = Array.isArray(draft.district_ids)
    ? draft.district_ids
        .filter((id): id is string => typeof id === "string" && UUID_SHAPE_RE.test(id))
        .slice(0, MAX_DRAFT_DISTRICT_IDS)
    : [];
  let target: BallotDraft["target"] = null;
  if (typeof draft.target === "object" && draft.target !== null) {
    const rawTarget = draft.target as Record<string, unknown>;
    if (typeof rawTarget.election_date === "string" && Array.isArray(rawTarget.election_ids)) {
      target = {
        election_date: rawTarget.election_date,
        election_ids: rawTarget.election_ids.filter((id): id is string => typeof id === "string"),
        ...(Array.isArray(rawTarget.retention_ids) ? {
          retention_ids: rawTarget.retention_ids.filter((id): id is string => typeof id === "string"),
        } : {}),
      };
    }
  }
  const choices: Record<string, ElectionChoice> = {};
  if (typeof draft.choices === "object" && draft.choices !== null && !Array.isArray(draft.choices)) {
    for (const value of Object.values(draft.choices)) {
      const row = sanitizeChoiceRow(value);
      if (row) {
        choices[row.election_id] = row;
      }
    }
  }
  return { v: 1, district_ids: districtIds, target, choices };
}

function readStorage(): BallotDraft {
  if (typeof window === "undefined") {
    return EMPTY_DRAFT;
  }
  try {
    return parseDraft(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage unavailable (private mode): fall back to the in-memory cache
    // so picks at least last the tab's lifetime.
    return cache ?? EMPTY_DRAFT;
  }
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function writeDraft(next: BallotDraft): void {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory copy; persistence just won't happen.
  }
  emit();
}

function currentDraft(): BallotDraft {
  cache ??= readStorage();
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Cross-tab sync: another tab's write lands here as a storage event; drop
// the cache so the next snapshot re-reads. Module-level and guarded — SSR
// has no window.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      cache = null;
      emit();
    }
  });
}

export function readBallotDraft(): BallotDraft {
  return currentDraft();
}

export function useBallotDraft(): BallotDraft {
  return useSyncExternalStore(subscribe, currentDraft, () => EMPTY_DRAFT);
}

export function clearBallotDraft(): void {
  cache = EMPTY_DRAFT;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
  emit();
}

export function draftChoicesByElectionId(draft: BallotDraft): Map<string, ElectionChoice> {
  return new Map(Object.entries(draft.choices));
}

/** Progress against the stored target. Null without a target — and once the
 * target day has passed (`today` is the usLatestLocalDate() calendar
 * string): the snapshot only refreshes on a guest ballot-page load, so with
 * no date check the header would keep counting toward an election that is
 * over until the guest happens to reload a ballot. */
export function draftProgress(draft: BallotDraft, today: string): PickProgress | null {
  if (!draft.target || draft.target.election_ids.length === 0 || draft.target.election_date < today) {
    return null;
  }
  const picked = draft.target.election_ids.filter((id) => isDecidedChoice(draft.choices[id])).length;
  const total = draft.target.election_ids.length;
  return {
    election_date: draft.target.election_date,
    election_ids: draft.target.election_ids,
    picked,
    total,
    complete: picked === total,
  };
}

/** The draft's progress denominator from a ballot payload: the nearest
 * upcoming election day's contested races, computed from the FULL payload
 * so race-type tabs cannot shrink the goal. Grouped retention is metadata.
 * Null when nothing is upcoming. Shared by every guest page that loads a
 * full election list (/ballot and /draft) so each refreshes the target. */
export function nearestUpcomingTarget(
  elections: Pick<ElectionSummary, "id" | "election_date" | "race_type" | "official_ballot_title">[],
  today: string
): BallotDraft["target"] {
  const upcoming = elections.filter((election) => election.election_date >= today);
  if (upcoming.length === 0) {
    return null;
  }
  const date = upcoming.reduce(
    (min, election) => (election.election_date < min ? election.election_date : min),
    upcoming[0].election_date
  );
  const { contested, retention } = splitRetentionRaces(upcoming.filter((election) => election.election_date === date));
  return {
    election_date: date,
    election_ids: contested.map((election) => election.id),
    ...(retention.length > 0 ? { retention_ids: retention.map((election) => election.id) } : {}),
  };
}

/** True when every listed race has a decided choice (and there is at least
 * one race). The draft pages' "finished" test, shared by the milestone and
 * by the page deciding whether its own sign-up CTA is redundant. */
export function allRacesDecided(
  elections: { id: string }[],
  choiceByElectionId: Map<string, ElectionChoice> | undefined
): boolean {
  return (
    elections.length > 0 && elections.every((election) => isDecidedChoice(choiceByElectionId?.get(election.id)))
  );
}

/** Decided races in the draft, counted with or without a target — the
 * generic nav badge's number when no ballot context exists yet. */
export function draftPickCount(draft: BallotDraft): number {
  return Object.values(draft.choices).filter((choice) => isDecidedChoice(choice)).length;
}

/** True when the draft holds anything worth flushing into an account. */
export function hasDraftPicks(draft: BallotDraft): boolean {
  return draftPickCount(draft) > 0;
}

/** Called by the guest ballot page on every successful load, so the badge's
 * link and denominator track the ballot the guest actually looked at last. */
export function setDraftBallotContext(
  districtIds: string[],
  target: BallotDraft["target"]
): void {
  const draft = currentDraft();
  writeDraft({ ...draft, district_ids: districtIds, target });
}

type DraftRaceContext = {
  electionId: string;
  raceTitle: string;
  /** ISO YYYY-MM-DD. */
  electionDate: string;
};

function baseRow(
  draft: BallotDraft,
  context: DraftRaceContext,
  raceType: "office" | "ballot_measure",
  seatsToFill: number | null
): ElectionChoice {
  return (
    draft.choices[context.electionId] ?? {
      election_id: context.electionId,
      race_type: raceType,
      official_ballot_title: context.raceTitle,
      election_date: context.electionDate,
      seats_to_fill: seatsToFill,
      picks: [],
      measure_position: null,
      updated_at: new Date().toISOString(),
    }
  );
}

function putRow(draft: BallotDraft, row: ElectionChoice): void {
  const choices = { ...draft.choices };
  if (row.picks.length === 0 && row.measure_position === null) {
    delete choices[row.election_id];
  } else {
    choices[row.election_id] = { ...row, updated_at: new Date().toISOString() };
  }
  writeDraft({ ...draft, choices });
}

/** Same semantics as the server writer: single-seat races replace (radio),
 * multi-seat races append up to the seat cap and no-op past it (the button
 * disables at the cap anyway). */
export function setDraftCandidateChoice(
  input: DraftRaceContext & {
    seatsToFill: number | null;
    candidateId: string;
    candidateName: string;
    chosen: boolean;
  }
): void {
  const draft = currentDraft();
  const row = baseRow(draft, input, "office", input.seatsToFill);
  const seatCap = input.seatsToFill ?? 1;
  const others = row.picks.filter((pick) => pick.candidate_id !== input.candidateId);
  let picks = others;
  if (input.chosen) {
    const pick = { candidate_id: input.candidateId, display_name: input.candidateName, candidacy_status: "active" };
    if (seatCap <= 1) {
      picks = [pick];
    } else if (others.length < seatCap) {
      picks = [...others, pick];
    } else {
      return;
    }
  }
  putRow(draft, { ...row, picks });
}

/** raceType defaults to a ballot measure; judicial retention races are
 * office races answered Yes/No, so their rows must keep race_type "office". */
export function setDraftMeasureChoice(
  input: DraftRaceContext & { position: "yes" | "no" | null; raceType?: "office" | "ballot_measure" }
): void {
  const draft = currentDraft();
  const row = baseRow(draft, input, input.raceType ?? "ballot_measure", null);
  // A retention row saved by an older build may still hold the judge as a
  // candidate pick; the Yes/No answer replaces it (the server does the same),
  // otherwise clearing "No" would leave that pick to flush as a "Yes".
  putRow(draft, { ...row, picks: [], measure_position: input.position });
}

// The server's verdict on ONE row, as opposed to a failure of the pass:
// choice writes map business rejections (election closed since, candidate
// withdrew, cap already reached on the account) to 400/404 — see
// backend/src/api/apiErrors.ts. Retrying those can never succeed, so the
// row is skipped and the pass continues. Everything else is not about the
// row: 401/403 mean the session is the problem, 429 means the burst of
// sequential PUTs got throttled, 5xx means the server failed — all retry-
// able, so they abort the pass and the draft survives.
function isPermanentRowRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 403 &&
    error.status !== 429
  );
}

/**
 * Replays the guest draft into the signed-in account via the normal
 * PUT /api/me/election-choices writer, oldest row first so the newest intent
 * wins any single-seat replace. Business rejections (400/404) skip that
 * write and keep going — the server is the authority. Any other failure
 * (transport, auth, throttling, 5xx) aborts and KEEPS the draft so a later
 * session can retry; the draft clears only after a complete pass. A retry
 * re-PUTs rows that already landed, which is safe: re-choosing a chosen
 * candidate and re-setting a measure position are no-ops server-side.
 */
export async function flushBallotDraftToAccount(): Promise<void> {
  const draft = currentDraft();
  const rows = Object.values(draft.choices)
    .filter(isDecidedChoice)
    .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
  for (const row of rows) {
    const updates =
      row.measure_position !== null
        ? [{ election_id: row.election_id, measure_position: row.measure_position }]
        : row.picks.map((pick) => ({
            election_id: row.election_id,
            candidate_id: pick.candidate_id,
            chosen: true,
          }));
    for (const update of updates) {
      try {
        await apiRequest("/api/me/election-choices", { method: "PUT", body: update });
      } catch (error) {
        if (!isPermanentRowRejection(error)) {
          throw error;
        }
      }
    }
  }
  clearBallotDraft();
}

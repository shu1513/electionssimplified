// Navigation context the list pages hand to the detail pages via router
// state: where "back" goes, and (later, for the pagers) the sibling order
// the reader just saw. Router state is ephemeral and non-shareable — it can
// survive same-browser reloads and back/forward (React Router copies it
// into window.history.state, see SavedBallotPage's capture-then-clear), but
// an external visit never has it, and an old history entry can hold a shape
// from any past deploy. So every field is validated on read, and the
// optional fields degrade independently: a broken sibling list must not
// take the back link down with it.

import type { BallotRaceType, CandidateRailSortKey, RailSortKey } from "@voteapp/api-client";
import { CANDIDATE_RAIL_SORTS, RAIL_SORTS } from "@voteapp/api-client";
import { safeInternalPath } from "./safeInternalPath";

/** A back-link destination. Purely where and what to call it — any state to
 * deliver there travels beside it (CandidateNavState.backState), keeping
 * this type non-recursive. */
export type BackTo = { path: string; label: string };

/** List disclosure state travels only with this navigation round trip. */
export type ElectionListState = {
  expandedRetentionDates: string[];
  /** Date + rating; collapsing High on one date must not affect another. */
  collapsedVotePowerGroups?: string[];
};

export function readElectionListState(state: unknown): ElectionListState | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const { expandedRetentionDates: dates, collapsedVotePowerGroups: groups } = state as Record<string, unknown>;
  let result: ElectionListState | undefined;
  if (Array.isArray(dates) && dates.every((date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date))) {
    result = { expandedRetentionDates: dates };
  }
  if (Array.isArray(groups) && groups.every((key) => typeof key === "string" &&
    /^\d{4}-\d{2}-\d{2}:(very_high|high|above_average|medium|low|unknown)$/.test(key))) {
    result = { ...result, expandedRetentionDates: result?.expandedRetentionDates ?? [], collapsedVotePowerGroups: groups };
  }
  return result;
}

/** race_type powers the rail's race-type tabs; the sort keys power its
 * sort control (vote_power_score and election_date mirror the backend's
 * sort inputs; research_area_ids feed the client-mirrored My-issues
 * scoring; awaiting_candidates keeps the no-candidates tail sunk under
 * every sort, as the backend does). All optional because an old history
 * entry predates them — each control is simply not offered when its keys
 * are missing. */
export type NavContest = {
  id: string;
  title: string;
  race_type?: BallotRaceType;
  vote_power_score?: number | null;
  election_date?: string;
  research_area_ids?: string[];
  awaiting_candidates?: boolean;
  retention?: boolean;
};
/** research_area_records powers the candidate rail's My-issues sort: each
 * candidate's stance-bearing records condensed to per-area counts at
 * snapshot time. Optional — an old history entry predates it, and the sort
 * control is simply not offered without it. */
export type NavCandidate = {
  id: string;
  name: string;
  research_area_records?: { research_area_id: string; record_count: number }[];
};

/** Handed to /elections/:id links. contests = the ballot in displayed
 * order (races + measures + the awaiting-candidates tail) — the full
 * pool, NOT sliced by the list's race-type tab, so the rail can re-slice;
 * raceType records which tab was engaged at click time. backState
 * restores a candidate page's own context on the back hop (set when the
 * election was reached from a candidate page) — the mirror of
 * CandidateNavState.backState, so a My Picks → candidate → election →
 * back round trip keeps the candidate's original back link. */
export type ElectionNavState = {
  backTo: BackTo;
  listState?: ElectionListState;
  backState?: CandidateNavState;
  contests?: NavContest[];
  raceType?: BallotRaceType;
  /** The rail's engaged sort, carried so sibling walks and candidate round
   * trips keep it; absent (an old history entry) = the election page seeds
   * from the back URL's own ?sort= instead. */
  railSort?: RailSortKey;
  /** The election page's ROSTER sort (its candidates section), carried so a
   * candidate round trip restores it — set by the election page on
   * departure and overridden by the candidate page's rail sort on the way
   * back. Same value space as the candidate rail's sort, deliberately. */
  rosterSort?: CandidateRailSortKey;
};

/** Handed to /candidates/:id links. backState restores the election page's
 * own ballot context on the back hop; electionId scopes the candidate
 * sequence (a candidate can be in several races at once). */
export type CandidateNavState = {
  backTo: BackTo;
  backState?: ElectionNavState;
  electionId?: string;
  candidates?: NavCandidate[];
  /** The candidate rail's engaged sort, carried so sibling walks and
   * election round trips keep it; absent (an old history entry) = the
   * rail's own default order. */
  railSort?: CandidateRailSortKey;
};

function readBackTo(value: unknown): BackTo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { path, label } = value as Record<string, unknown>;
  // safeInternalPath: a corrupt or ancient history entry must not yield an
  // external or protocol-relative href.
  if (typeof path !== "string" || safeInternalPath(path) === null) {
    return null;
  }
  if (typeof label !== "string" || label.trim() === "") {
    return null;
  }
  return { path, label };
}

// One malformed entry discards the whole list (undefined), not just the
// entry: a partially-valid sequence would page through a list the user
// never saw. Absent stays absent.
function readIdLabelList<Key extends string>(
  value: unknown,
  labelKey: Key
): ({ id: string } & Record<Key, string>)[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: ({ id: string } & Record<Key, string>)[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const id = (entry as Record<string, unknown>).id;
    const label = (entry as Record<string, unknown>)[labelKey];
    // trim() both: a whitespace-only id would build a broken href, and a
    // whitespace-only label would render an invisible pager link. Values are
    // validated, never normalized — real ids and titles carry no edge spaces.
    if (typeof id !== "string" || id.trim() === "" || typeof label !== "string" || label.trim() === "") {
      return undefined;
    }
    entries.push({ id, [labelKey]: label } as { id: string } & Record<Key, string>);
  }
  return entries;
}

/** null only when there is no usable backTo; a valid backTo with a broken
 * optional field keeps the back link and drops only that field. Mutually
 * recursive with readCandidateNavState via backState — terminates because
 * the stored structure is finite (each hop nests one more layer). */
export function readElectionNavState(state: unknown): ElectionNavState | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const record = state as Record<string, unknown>;
  const backTo = readBackTo(record.backTo);
  if (backTo === null) {
    return null;
  }
  const result: ElectionNavState = { backTo };
  const listState = readElectionListState(record.listState);
  if (listState) result.listState = listState;
  const backState = readCandidateNavState(record.backState);
  if (backState !== null) {
    result.backState = backState;
  }
  const contests = readIdLabelList(record.contests, "title");
  if (contests !== undefined) {
    // The optional per-entry fields degrade per entry, not per list: an
    // invalid value only withholds the control that needs it (the rail
    // requires every entry keyed), never the pager or the rail itself.
    const rawContests = record.contests as unknown[];
    result.contests = contests.map((contest, index) => {
      const raw = rawContests[index] as Record<string, unknown>;
      const entry: NavContest = { ...contest };
      if (raw.race_type === "office" || raw.race_type === "ballot_measure") {
        entry.race_type = raw.race_type;
      }
      if (raw.vote_power_score === null || typeof raw.vote_power_score === "number") {
        entry.vote_power_score = raw.vote_power_score;
      }
      if (typeof raw.election_date === "string" && raw.election_date.trim() !== "") {
        entry.election_date = raw.election_date;
      }
      if (
        Array.isArray(raw.research_area_ids) &&
        raw.research_area_ids.every((areaId) => typeof areaId === "string" && areaId.trim() !== "")
      ) {
        entry.research_area_ids = raw.research_area_ids;
      }
      if (raw.retention === true) {
        entry.retention = true;
      }
      if (raw.awaiting_candidates === true) {
        entry.awaiting_candidates = true;
      }
      return entry;
    });
  }
  if (record.raceType === "office" || record.raceType === "ballot_measure") {
    result.raceType = record.raceType;
  }
  if (RAIL_SORTS.some((option) => option.value === record.railSort)) {
    result.railSort = record.railSort as RailSortKey;
  }
  if (CANDIDATE_RAIL_SORTS.some((option) => option.value === record.rosterSort)) {
    result.rosterSort = record.rosterSort as CandidateRailSortKey;
  }
  return result;
}

/** The pager's neighbors in a validated sibling list, or null when there is
 * nothing to page: no list, fewer than two entries, or the current page
 * missing from it (a stale filtered snapshot must not render a pager the
 * reader never saw). Ends of the sequence yield a null prev/next slot. */
export function pagerNeighbors<Entry extends { id: string }>(
  list: Entry[] | undefined,
  currentId: string
): { prev: Entry | null; next: Entry | null } | null {
  if (list === undefined || list.length < 2) {
    return null;
  }
  const index = list.findIndex((entry) => entry.id === currentId);
  if (index === -1) {
    return null;
  }
  return {
    prev: index > 0 ? list[index - 1] : null,
    next: index < list.length - 1 ? list[index + 1] : null,
  };
}

/** Same layering: backTo is the gate; backState, electionId, and candidates
 * each validate (and degrade) on their own. */
export function readCandidateNavState(state: unknown): CandidateNavState | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const record = state as Record<string, unknown>;
  const backTo = readBackTo(record.backTo);
  if (backTo === null) {
    return null;
  }
  const result: CandidateNavState = { backTo };
  const backState = readElectionNavState(record.backState);
  if (backState !== null) {
    result.backState = backState;
  }
  if (typeof record.electionId === "string" && record.electionId !== "") {
    result.electionId = record.electionId;
  }
  const candidates = readIdLabelList(record.candidates, "name");
  if (candidates !== undefined) {
    // research_area_records degrades per entry, not per list: an invalid
    // value only withholds the rail's sort control (which requires every
    // entry keyed), never the pager or the rail itself.
    const rawCandidates = record.candidates as unknown[];
    result.candidates = candidates.map((candidate, index) => {
      const raw = (rawCandidates[index] as Record<string, unknown>).research_area_records;
      return Array.isArray(raw) &&
        raw.every(
          (area) =>
            typeof area === "object" &&
            area !== null &&
            typeof (area as Record<string, unknown>).research_area_id === "string" &&
            ((area as Record<string, unknown>).research_area_id as string).trim() !== "" &&
            // A count: non-negative integer only. NaN in particular must not
            // pass — it would poison the sort's record-volume tiebreak.
            Number.isSafeInteger((area as Record<string, unknown>).record_count) &&
            ((area as Record<string, unknown>).record_count as number) >= 0
        )
        ? {
            ...candidate,
            research_area_records: raw as NavCandidate["research_area_records"],
          }
        : candidate;
    });
  }
  if (CANDIDATE_RAIL_SORTS.some((option) => option.value === record.railSort)) {
    result.railSort = record.railSort as CandidateRailSortKey;
  }
  return result;
}

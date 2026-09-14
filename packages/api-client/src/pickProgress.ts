import type { ElectionChoice, ElectionSummary } from "./types";
import { splitRetentionRaces } from "./retention";
import { isDecidedChoice } from "./useElectionChoices";

/** Progress over one election day. `election_date` and `election_ids`
 * name the ballot the counts describe (the day, and the races counted on
 * it) so a consumer can tell "this ballot went from 12/13 to 13/13" apart
 * from "a different day is nearest" or "the race list changed under me"
 * (an address change or a retired race can shrink 1/2 into 1/1 with no
 * new pick). */
export type PickProgress = {
  election_date: string;
  election_ids: string[];
  picked: number;
  total: number;
  complete: boolean;
};

/**
 * The draft link's label, shared by the web header nav, the web candidate
 * page's post-pick actions, and the mobile saved-ballot header so they never
 * drift: plain until the first pick (no homework-flavored "0/8", and no
 * counter while the queries haven't settled — a counter that flashes in
 * later is fine, a wrong one is not), then counting up, then the earned name
 * "My Draft ✓" when every race on the nearest election day is decided.
 */
export function myDraftLabel(progress: PickProgress | null): string {
  return progress && progress.picked > 0
    ? progress.complete
      ? "My Draft ✓"
      : `My Draft ${progress.picked}/${progress.total}`
    : "My Draft";
}

/**
 * Pick progress over the nearest upcoming election day ("My Draft 4/13" →
 * "My Draft ✓"): the same denominator as that day's draft card. Null means
 * no counter (ballot or choices not loaded, or no upcoming races). Pure —
 * each platform's hook supplies its own ballot fetch and today string; only
 * id + election_date are read so any election payload shape qualifies.
 * Optional exclusions leave the nearest day's counts and ids together.
 */
export function nearestDayPickProgress(
  elections: { id: string; election_date: string }[] | undefined,
  choiceByElectionId: Map<string, ElectionChoice> | undefined,
  today: string,
  { exclude }: { exclude?: Set<string> } = {}
): PickProgress | null {
  if (elections === undefined || choiceByElectionId === undefined) {
    return null;
  }
  const upcoming = elections.filter((election) => election.election_date >= today);
  if (upcoming.length === 0) {
    return null;
  }
  const date = upcoming.reduce(
    (min, election) => (election.election_date < min ? election.election_date : min),
    upcoming[0].election_date
  );
  const group = upcoming.filter((election) => election.election_date === date && !exclude?.has(election.id));
  // Keep the nearest date even if all its races are excluded; do not jump
  // ahead to a different ballot or announce an empty ballot as complete.
  if (group.length === 0) {
    return null;
  }
  const picked = group.filter((election) => isDecidedChoice(choiceByElectionId.get(election.id))).length;
  return {
    election_date: date,
    election_ids: group.map((election) => election.id),
    picked,
    total: group.length,
    complete: picked === group.length,
  };
}

/** The shared web/mobile completion rule: grouped retention has its own
 * progress and never moves the nearest-day draft completion target. */
export type DraftProgress = PickProgress & { hasOpenRetention: boolean };

export function nearestDayDraftProgress(
  elections: Pick<ElectionSummary, "id" | "election_date" | "race_type" | "official_ballot_title">[] | undefined,
  choiceByElectionId: Map<string, ElectionChoice> | undefined,
  today: string
): DraftProgress | null {
  const { retention } = splitRetentionRaces(elections ?? []);
  const progress = nearestDayPickProgress(elections, choiceByElectionId, today, {
    exclude: new Set(retention.map((election) => election.id)),
  });
  return progress ? {
    ...progress,
    hasOpenRetention: retention.some((election) =>
      election.election_date === progress.election_date && !isDecidedChoice(choiceByElectionId?.get(election.id))
    ),
  } : null;
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./client";
import type {
  AutoPickElectionResult,
  AutoPickReason,
  AutoPickSuggestedIssue,
  AutoPicksClearResult,
  AutoPicksResult,
  ElectionChoice,
} from "./types";

// Auto-pick ("Pick by my issues") logic shared by the web controls and the
// mobile ports: the issue floor, the per-reason copy, the fill/clear
// mutations, and the headline sentence the "Why this pick" panel leads with.
// The single-race replace mutation (useAutoPick) lives in useElectionChoices.

/** Mirrors the server's UX floor (MIN_AUTO_PICK_ISSUES): below this many
 * ranked issues the controls explain what to do instead of calling the API. */
export const MIN_AUTO_PICK_ISSUES = 3;

// Server-side cap on election_ids per request (MAX_AUTO_PICK_ELECTION_IDS);
// larger ballots run in sequential chunks.
const MAX_IDS_PER_REQUEST = 200;

const REASON_LABELS: Record<AutoPickReason, string> = {
  insufficient_evidence: "not enough evidence",
  only_negative_evidence: "only unknowns left",
  tie: "a tie",
  all_vetoed: "all crossed your line",
  veto: "crossed your line",
  by_elimination: "picked by elimination",
  too_few_issues: `fewer than ${MIN_AUTO_PICK_ISSUES} ranked issues`,
  election_closed: "no longer open",
};

/** One-phrase reason for the inline race-row annotations ("auto pick: not
 * enough evidence"). null (a no-pick with no recorded reason) reads as the
 * evidence gap. */
export function reasonLabel(reason: AutoPickReason | null): string {
  // The fallback also covers a reason this build no longer knows (an older
  // backend during a deploy-skew window can still send "retention"): the
  // evidence-gap phrase is never wrong for a no-pick, "undefined" is.
  return reason === null ? "not enough evidence" : (REASON_LABELS[reason] ?? "not enough evidence");
}

/**
 * Whether the engine has rows left to clear ON THIS DATE — display gating
 * only. The clear itself is one server-side DELETE scoped to origin =
 * 'auto' and this election date, so stale cache here can never unpick a
 * row the user has since re-picked manually in another tab.
 */
export function hasClearableAutoPicks(choices: ElectionChoice[], date: string): boolean {
  return choices.some(
    (choice) =>
      choice.election_date === date &&
      (choice.picks.some((pick) => pick.origin === "auto") ||
        (choice.measure_position !== null && choice.measure_origin === "auto"))
  );
}

/** "Jane", "Jane and John", "Jane, Ann and John" — the list style every
 * auto-pick sentence uses (shortlists, picked names, veto areas). */
export function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function candidateName(result: AutoPickElectionResult, candidateId: string): string {
  return (
    result.candidates.find((report) => report.candidate_id === candidateId)?.display_name ?? "a candidate"
  );
}

/**
 * Headline sentence per outcome/reason — the honest summary the spec
 * requires ("no pick" is a normal outcome, and saying why is the feature).
 * seatsToFill: elections.seats_to_fill — null reads as a single seat; pass
 * null for measures.
 */
export function summarizeAutoPick(result: AutoPickElectionResult, seatsToFill: number | null): string {
  // Race-type-independent "couldn't run" reasons come before the fork: a
  // measure result carries them too (with an empty per-issue list), and
  // letting the measure branch see one would mislabel a rank-your-issues
  // problem as a tagging gap.
  if (result.reason === "too_few_issues") {
    return `Rank at least ${MIN_AUTO_PICK_ISSUES} issues first, so the pick reflects what matters to you.`;
  }
  if (result.reason === "election_closed") {
    return "This election is no longer open for picks.";
  }
  if (result.race_type === "office" && result.measure_position !== null) {
    // Judicial retention: the office race is answered Yes/No on keeping the
    // one judge, scored on their records like any candidate.
    if (result.reason === "veto") {
      return "Vote No — this judge's record goes against an issue you drew a line on.";
    }
    return result.measure_position === "yes"
      ? "Vote Yes — this judge's record supports your issues overall."
      : "Vote No — this judge's record goes against your issues overall.";
  }
  const shortlist = joinNames(result.shortlist_candidate_ids.map((id) => candidateName(result, id)));
  if (result.race_type === "ballot_measure") {
    if (result.reason === "veto") {
      return "Vote No — this measure goes against an issue you drew a line on.";
    }
    if (result.measure_position === "yes") {
      return "Vote Yes — this measure supports your issues overall.";
    }
    if (result.measure_position === "no") {
      return "Vote No — this measure goes against your issues overall.";
    }
    // Two distinct "no answer" cases, and the user deserves to know which:
    // an empty per-issue list means the measure shares no tags with their
    // ranked issues; a non-empty list with no position means the weighted
    // sides cancelled out (the chips below show the split).
    if (result.measure_per_issue.length === 0) {
      return "No answer — this measure isn't tagged with any of your issues yet.";
    }
    return "No answer — this measure helps some of your issues and hurts others about equally, so it's your call.";
  }
  if (result.outcome === "picked") {
    const picked = joinNames(result.picked_candidate_ids.map((id) => candidateName(result, id)));
    // Multi-seat races can fill fewer seats than they have (a tie or a lack
    // of evidence for the rest): a "picked" summary that hides the open
    // seats would read as a finished race.
    const openSeats = (seatsToFill ?? 1) - result.picked_candidate_ids.length;
    if (result.reason === "by_elimination") {
      return `Picked ${picked} by elimination — the rest have records against your issues, and nothing known counts against ${picked}.`;
    }
    if (result.reason === "tie") {
      return `Picked ${picked}; the ${openSeats === 1 ? "last seat is" : `remaining ${openSeats} seats are`} a tie between ${shortlist} — that part is your call.`;
    }
    if (openSeats > 0) {
      return `Picked ${picked} — the best match for your issues. ${openSeats === 1 ? "One seat is" : `${openSeats} seats are`} still open: nothing known separates the other candidates, so those picks are yours to make.`;
    }
    return `Picked ${picked} — the best match for your issues.`;
  }
  switch (result.reason) {
    case "tie":
      return `It's a tie between ${shortlist} on your issues — your call between them.`;
    case "only_negative_evidence":
      return result.shortlist_candidate_ids.length > 0
        ? `Couldn't pick one — narrowed to ${shortlist}: nothing known against them, but nothing for them either.`
        : "No pick: every candidate with a record here works against your issues.";
    case "all_vetoed":
      return "No pick: every candidate goes against one of your musts.";
    default: {
      // One candidate (a retention judge, or an unopposed race): name the
      // gap for them, not for "these candidates". Records that cancel out
      // (a retention judge scoring exactly zero with evidence) get the
      // measure page's even-split wording.
      const only = result.candidates.length === 1 ? result.candidates[0] : undefined;
      if (only && only.per_issue.length > 0) {
        return "No pick: this candidate's record helps some of your issues and hurts others about equally, so it's your call.";
      }
      if (only) {
        return "No pick: this candidate has no record on your issues yet.";
      }
      return "No pick: none of these candidates has a record on your issues yet.";
    }
  }
}

/** One issue the "add these issues" prompt offers, merged across the races
 * of one run. */
export type SuggestedIssueGroup = AutoPickSuggestedIssue & {
  /** Races in the run whose undecided candidates have records on it. */
  race_count: number;
};

/**
 * Merges the per-race suggested_issues of a run into one list for the
 * "add these issues" prompt: a single-race run is a list of one. Each issue
 * appears once, with the candidate and record counts summed and the number
 * of races it would help; the issues that would move the most races (then
 * the most candidates) come first. A result from a backend without the
 * field contributes nothing.
 */
export function collectSuggestedIssues(results: Iterable<AutoPickElectionResult>): SuggestedIssueGroup[] {
  const byId = new Map<string, SuggestedIssueGroup>();
  for (const result of results) {
    for (const issue of result.suggested_issues ?? []) {
      const existing = byId.get(issue.research_area_id);
      if (existing) {
        existing.candidate_count += issue.candidate_count;
        existing.record_count += issue.record_count;
        existing.race_count += 1;
      } else {
        byId.set(issue.research_area_id, { ...issue, race_count: 1 });
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      b.race_count - a.race_count ||
      b.candidate_count - a.candidate_count ||
      b.record_count - a.record_count ||
      a.name.localeCompare(b.name)
  );
}

/**
 * Per-date "Auto-fill empty picks by my issues": POST /api/me/auto-picks in
 * fill_empty mode over the given election ids, chunked to the server cap.
 * Shares the choice-write key so every pick control disables together.
 * onResults feeds the caller's per-row annotations: null at run start (an
 * old "not enough evidence" must not read as the latest result — a failed
 * run's partial writes surface via the onSettled refetch), the keyed map on
 * success.
 */
export function useAutoPickFill(
  onResults?: (byElectionId: Map<string, AutoPickElectionResult> | null) => void
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["set-election-choice"],
    onMutate: () => onResults?.(null),
    mutationFn: async (electionIds: string[]) => {
      const all: AutoPickElectionResult[] = [];
      for (let start = 0; start < electionIds.length; start += MAX_IDS_PER_REQUEST) {
        const response = await apiRequest<AutoPicksResult>("/api/me/auto-picks", {
          method: "POST",
          body: { election_ids: electionIds.slice(start, start + MAX_IDS_PER_REQUEST), mode: "fill_empty" },
        });
        all.push(...response.results);
      }
      return all;
    },
    // onSettled, not onSuccess: the batch commits election by election, so a
    // failure partway through can leave real writes behind.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["me", "election-choices"] }),
    onSuccess: (all) => onResults?.(new Map(all.map((result) => [result.election_id, result]))),
  });
}

/**
 * Date-scoped clear of the engine's rows: DELETE /api/me/auto-picks
 * ?election_date=<the mutate argument>, so one card's clear can't touch
 * another date's auto picks. One atomic server-side statement — it either
 * cleared everything on the date or nothing.
 */
export function useClearAutoPicks(
  onResults?: (byElectionId: Map<string, AutoPickElectionResult> | null) => void
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["set-election-choice"],
    mutationFn: (electionDate: string) =>
      apiRequest<AutoPicksClearResult>(
        `/api/me/auto-picks?election_date=${encodeURIComponent(electionDate)}`,
        { method: "DELETE" }
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["me", "election-choices"] }),
    onSuccess: () => onResults?.(null),
  });
}

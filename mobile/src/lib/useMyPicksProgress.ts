import { useQuery } from "@tanstack/react-query";
import type { BallotSummary, DraftProgress } from "@voteapp/api-client";
import { apiRequest, nearestDayDraftProgress, useElectionChoices, useMe } from "@voteapp/api-client";
import { usLatestLocalDate } from "./usLatestLocalDate";

/**
 * The saved-ballot header's pick counter ("My Draft 4/13" → "My Draft ✓"):
 * progress over the nearest upcoming election day, the same denominator as
 * that day's card on the My Draft screen. Null hides the counter (logged
 * out, unverified, ballot not loaded, no upcoming races, or choices still
 * loading). Mobile counterpart of the web's useMyPicksProgress.
 *
 * Same key AND url as the My Draft screen's ballot query, so opening that
 * screen from the header is ONE shared request — in paper-ballot contest
 * order (explicit sort + followed_first so the user's saved list
 * preferences never apply there). Deliberately NOT the ["me", "ballot"]
 * key: the saved-ballot tab owns that one with the user's saved sort — but
 * the shared ["me", "ballot"] prefix means address-change invalidations
 * refresh both. No include=preview: that include exists for the web's
 * ballot-sheet view; mobile has no such view yet.
 */
export function useMyPicksProgress(): DraftProgress | null {
  const { me } = useMe();
  const verified = me?.email_verified === true;
  const ballot = useQuery({
    queryKey: ["me", "ballot", "picks"],
    queryFn: () => apiRequest<BallotSummary>("/api/me/ballot?sort=state_baseline&followed_first=false"),
    enabled: verified,
    retry: false,
    staleTime: 60_000,
  });
  const { choiceByElectionId } = useElectionChoices();
  if (!verified) {
    return null;
  }
  return nearestDayDraftProgress(ballot.data?.elections, choiceByElectionId, usLatestLocalDate());
}

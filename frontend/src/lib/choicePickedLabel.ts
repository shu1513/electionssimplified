import type { ElectionChoice } from "@voteapp/api-client";

/** A rail row's answer for a decided choice: the picked name(s), or Yes /
 * No for a measure. null = undecided; the row shows none because an
 * "undecided" badge on every open race read as noise (same rule as the
 * ballot cards). A withdrawn pick keeps its name with a flag, as the cards
 * do — a silent disappearance would read as data loss. On a retention race
 * a legacy judge pick (a candidate row, from before the Yes / No answer)
 * reads as "Yes", as the My Draft ballot renders it (BallotPreview). */
export function choicePickedLabel(choice: ElectionChoice | undefined, retention = false): string | null {
  if (choice === undefined) return null;
  if (choice.measure_position !== null) return choice.measure_position === "yes" ? "Yes" : "No";
  if (choice.picks.length === 0) return null;
  if (retention) return "Yes";
  return choice.picks
    .map((pick) => (pick.candidacy_status === "withdrawn" ? `${pick.display_name} (withdrew)` : pick.display_name))
    .join(", ");
}

import { Link } from "react-router";
import type { ElectionVotingMethod } from "@voteapp/api-client";

// One line under a race title when the contest is counted by ranked-choice
// voting. Nothing renders for any other method or when the method was never
// recorded, so the ballot never claims a counting rule it does not know.
//
// linkToExplainer: false inside the election card, whose whole body is
// already a <Link>; an <a> nested in an <a> is invalid HTML and breaks
// hydration. The race page the card leads to carries the link.
export function RankedChoiceNotice({
  votingMethod,
  className,
  linkToExplainer = true,
}: {
  votingMethod: ElectionVotingMethod | null | undefined;
  className?: string;
  linkToExplainer?: boolean;
}) {
  if (votingMethod !== "ranked_choice") return null;
  return (
    <p className={className ?? "mt-1 text-sm text-ink"} data-testid="ranked-choice-notice">
      This race uses ranked-choice voting: rank the candidates in order of preference.
      {linkToExplainer ? (
        <>
          {" "}
          <Link to="/ranked-choice-voting" className="font-semibold underline hover:text-ink">
            How it works
          </Link>
        </>
      ) : null}
    </p>
  );
}

import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { APP_NAME } from "@voteapp/api-client";
import { pageMeta } from "../lib/pageMeta";

export const meta: MetaFunction = () =>
  pageMeta({
    title: `Ranked-choice voting · ${APP_NAME}`,
    description:
      "How a ranked-choice ballot works: how to mark it, how the rounds are counted, and which November 2026 races use it.",
    path: "/ranked-choice-voting",
  });

// Linked from every race card and race page whose voting_method is
// 'ranked_choice', and from the Methodology page. Explains the mechanics
// only: the site takes no position on whether the method is good or bad.
const h2 = "pt-2 text-heading font-semibold";

export default function RankedChoiceVotingPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <section className="space-y-3 text-body text-ink">
        <h1 className="text-title font-bold">Ranked-choice voting</h1>
        <p>
          In a ranked-choice race you rank the candidates in order of preference instead of picking
          one. Your ballot is counted in rounds, and if your first choice is eliminated it counts for
          your next choice. Some places call it instant-runoff voting.
        </p>

        <h2 className={h2}>How do I fill out the ballot?</h2>
        <p>
          Mark one candidate as your first choice, another as your second choice, and so on. You may
          rank as many or as few candidates as you like. Ranking a second choice never hurts your
          first choice: your ballot counts for your second choice only if your first choice has been
          eliminated. Do not give two candidates the same rank, and do not rank the same candidate
          twice; most ballots treat either one as a mistake for that rank. Some jurisdictions cap the
          number of rankings; the cap is printed on the ballot.
        </p>

        <h2 className={h2}>How are the votes counted?</h2>
        <ol className="list-decimal space-y-1 pl-6">
          <li>Every ballot counts for its first choice. A candidate with more than half of those votes wins.</li>
          <li>
            If no one has a majority, the candidate with the fewest votes is eliminated. Each ballot
            that ranked that candidate first now counts for its next choice.
          </li>
          <li>Repeat until one candidate has more than half of the ballots still counting.</li>
        </ol>
        <p>
          A ballot that ranked only eliminated candidates stops counting; election officials call it
          an exhausted ballot. Results are usually posted in rounds, and in a close race the final
          round can take days to tabulate after election day.
        </p>

        <h2 className={h2}>What if the race elects more than one person?</h2>
        <p>
          Some ranked-choice races fill several seats at once, such as the three council seats in
          each Portland, Oregon district. A candidate wins by reaching a share of the vote, not a
          majority: with three seats the threshold is just over 25 percent. Votes a winner receives
          beyond the threshold transfer to those ballots&rsquo; next choices, the last-place candidate
          is eliminated when no one reaches it, and the rounds continue until every seat is filled.
          The race page shows how many seats a contest fills.
        </p>

        <h2 className={h2}>Which November 2026 races use it?</h2>
        <p>
          Maine uses ranked-choice voting for its U.S. Senate and U.S. House general elections but
          not for governor or the state legislature. Alaska uses it for every state and federal office
          after its top-four primary. The District of Columbia uses it in any contest with three or more
          candidates, so some of its races rank and others say vote for one. Cities and counties using it include San Francisco, Oakland, Berkeley, San
          Leandro, and Albany in California; Boulder, Colorado (mayor); Portland, Maine; Portland,
          Corvallis, and Multnomah County in Oregon; and Arlington County, Virginia (county board).
          On {APP_NAME}, each of these races carries a ranked-choice note on its card and its page.
          A race with no note is counted the usual way or its method has not been recorded.
        </p>

        <h2 className={h2}>Where does this come from?</h2>
        <p>
          The list of jurisdictions follows each state and city&rsquo;s own election office and the
          2026 tracking table published by FairVote. Read more about how the site is built on the{" "}
          <Link to="/methodology" className="font-semibold underline hover:text-ink">
            How it works
          </Link>{" "}
          page.
        </p>
      </section>
    </div>
  );
}

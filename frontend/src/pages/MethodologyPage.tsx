import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { APP_NAME, VERIFY_WITH_OFFICIALS_NOTE } from "@voteapp/api-client";
import { ORGANIZATION_LEGAL_NAME, SOURCE_REPOSITORY_URL } from "../components/SiteJsonLd";
import { CONTACT_EMAIL } from "../lib/embedPublisher";
import { pageMeta } from "../lib/pageMeta";

export const meta: MetaFunction = () =>
  pageMeta({
    title: `How ${APP_NAME} works · ${APP_NAME}`,
    description: `Who runs ${APP_NAME}, where its election data comes from, how candidate records are researched and checked, how the vote-power and competitiveness ratings are calculated, and how to report an error.`,
    path: "/methodology",
  });

// Every number and threshold on this page mirrors the backend it describes
// (votePower.ts, competitivenessLabels.ts, districtsLoader.ts). Change the
// code, change the sentence — the page is the public contract for the
// ratings, and an engine that cites it must not be citing stale math.
//
// Question headings, answer-first paragraphs: this page exists so that a
// search or AI engine deciding whether to trust and cite the site finds a
// plain statement of who we are, where the data comes from, how it is
// checked, and how to get it corrected — in that order.
const h2 = "pt-2 text-heading font-semibold";
const h3 = "pt-1 text-subheading font-semibold";

export default function MethodologyPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <section className="space-y-3 text-body text-ink">
        <h1 className="text-title font-bold">How {APP_NAME} works</h1>
        <p>
          {APP_NAME} is an independent, nonpartisan guide to what is on your ballot: every race for
          your address, who is running, what they have actually done, and what each ballot measure
          means. This page explains who runs the site, where the data comes from, how it is checked,
          how the ratings are calculated, and how to get a mistake fixed.
        </p>

        <h2 className={h2}>Who runs {APP_NAME}?</h2>
        <p>
          {APP_NAME} is published by {ORGANIZATION_LEGAL_NAME}, a Delaware corporation. It is funded by
          reader contributions and by its founders, and it takes no money from any candidate,
          campaign, committee, or party. It endorses no one. The source code is public at{" "}
          <a href={SOURCE_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline hover:text-ink">
            GitHub
          </a>
          , and you can reach the team at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline hover:text-ink">
            {CONTACT_EMAIL}
          </a>
          . Read more about why the site exists on the <Link to="/mission" className="underline hover:text-ink">Mission</Link> page.
        </p>

        <h2 className={h2}>Where does the data come from?</h2>
        <p>
          Races and candidate lists come from state and county election offices: certified
          candidate lists, sample ballots, and filing records. Candidate records come from official
          sources: recorded votes, bills sponsored, court and agency records, and a candidate&rsquo;s own
          official statements. Campaign finance comes from the Federal Election Commission and
          state and city disclosure agencies. Ballot measure explanations come from the official
          measure text and the state&rsquo;s own voter guide. Every record on the site shows its source link
          and the date it was researched, so you can check it yourself.
        </p>

        <h2 className={h2}>How is the research done?</h2>
        <p>
          AI models search for verifiable public records and write plain-language summaries of them.
          Nothing goes live on that alone: every payload passes automated validators that reject
          missing sources, dead links, and claims without a source; the sources themselves are
          checked to be official or primary; and researchers review the results and rerun any
          search that fails. AI calls are never automatic: each research run is started by a person.
          Summaries are limited to two sentences, use plain words, and describe what a candidate did,
          not how the race is going.
        </p>

        <h2 className={h2}>What do we leave out?</h2>
        <p>
          No endorsements, no predictions, and no opinion about who should win. We do not publish
          unresolved accusations: a lawsuit filed against a candidate appears only once a court has
          ruled or an official body has acted. Trivia, biography filler, and campaign talking points
          are not records. If a candidate has no verifiable public record, the page says so instead of
          filling the space.
        </p>

        <h2 className={h2}>How is &ldquo;vote power&rdquo; calculated?</h2>
        <p>
          Vote power answers one question: how much can your single vote change the outcome here,
          compared with other races on your ballot? It combines two measures, representation and
          decisiveness, into one of six ratings: very low, low, average, above average, high, very
          high.
        </p>
        <h3 className={h3}>Representation</h3>
        <p>
          Representation compares the size of the electorate to a statewide vote in the same state.
          The score is 50 + 50 × ln(state population ÷ district population) ÷ ln(50,000), clamped
          between 50 and 100. A statewide race scores exactly 50 (the &ldquo;average&rdquo; baseline); a
          district 50,000 times smaller than its state scores 100. Grades: 66 and up is high, 55 and
          up is above average, 33 and up is average, below that is low. Populations come from the
          U.S. Census.
        </p>
        <h3 className={h3}>Decisiveness</h3>
        <p>
          Decisiveness estimates how likely the race is to be close. If every candidate on the ballot
          wins a seat (one candidate for one seat, or three for three), the race is uncontested and
          decisiveness is none. Otherwise the grade follows the competitiveness label below: a
          toss-up or very competitive race is high, competitive or somewhat competitive is medium,
          and safe is low.
        </p>
        <h3 className={h3}>Combining the two</h3>
        <p>
          The rating is read off a fixed table of the two grades. High representation with high
          decisiveness is very high; high representation with an uncontested race is low; average
          representation needs a high-decisiveness race to reach high; and an uncontested race in a
          low-representation district is very low. When one measure is unknown, the rating rests on
          the other and the page says which. Ballot measures are rated on representation alone,
          because you vote directly on the policy. Judicial retention questions get no rating.
        </p>
        <p>
          Every election page shows this calculation with the real numbers under &ldquo;How do we
          calculate my vote power?&rdquo;.
        </p>

        <h2 className={h2}>How is competitiveness decided?</h2>
        <p>
          When a current analyst rating exists for the race, it drives the label. We use the published
          ratings of Inside Elections and Sabato&rsquo;s Crystal Ball, averaged when both rate the race, and
          show the date the ratings were read. Otherwise the label comes from past results for the same
          office: the winner&rsquo;s margin over the runner-up as a share of all votes, blended over recent
          contests when several exist. A margin of 2 points or less is a toss-up, up to 5 is very
          competitive, up to 10 is competitive, up to 15 is somewhat competitive, and wider than 15 is
          safe. Past margins are flagged as stale after redistricting.
        </p>

        <h2 className={h2}>How are candidate summaries written?</h2>
        <p>
          A candidate summary is at most two sentences and 300 characters. It says what the person has
          done in and around public office, in plain words, with no campaign language and no
          horse-race framing. Positions on issues come from the candidate&rsquo;s records: each record is
          tagged with the issue it touches and whether the action was for or against it, and the
          page&rsquo;s stance summary counts those records. A ballot measure gets a two-sentence summary
          plus a plain statement of what a yes vote and a no vote each mean.
        </p>

        <h2 id="corrections" className={h2}>How do I report an error?</h2>
        <p>
          Every election page, candidate page, and individual record has a &ldquo;Report an issue&rdquo;
          button. Tell us what is wrong and, if you can, where the correct information is. Reports go
          to a person, who checks the source, fixes the entry, and reruns the research when a source
          has changed. You can also email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline hover:text-ink">
            {CONTACT_EMAIL}
          </a>
          . Candidates and campaigns are welcome to send corrections the same way; we correct facts,
          not framing.
        </p>

        <h2 className={h2}>What are the limits?</h2>
        <p>
          {VERIFY_WITH_OFFICIALS_NOTE} {APP_NAME} is not an official election source: confirm
          registration, deadlines, and polling places with your state or county election office.
          Coverage grows race by race, so an empty ballot means &ldquo;not researched yet&rdquo;, not
          &ldquo;no elections&rdquo;. Research is dated on every page; a record can be out of date until its
          next research pass. The full scope and limits are in the{" "}
          <Link to="/disclaimer" className="underline hover:text-ink">
            Disclaimer
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

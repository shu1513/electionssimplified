import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router";
import type { MetaFunction } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { APP_NAME, apiRequest, formatElectionDate, isDecidedChoice, splitRetentionRaces, useMe } from "@voteapp/api-client";
import type { BallotSummary, ElectionChoice, ElectionSummary } from "@voteapp/api-client";
import { BallotPreviewSheets, BallotViewToggle } from "../components/BallotPreview";
import { DetailPager } from "../components/DetailPager";
import { DraftMilestone } from "../components/DraftMilestone";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../components/Status";
import type { CandidateNavState, ElectionNavState } from "../lib/detailNavContext";
import {
  allRacesDecided,
  draftChoicesByElectionId,
  draftPickCount,
  nearestUpcomingTarget,
  setDraftBallotContext,
  useBallotDraft,
} from "../lib/ballotDraft";
import { PickDateCard } from "./PicksPage";
import { useElectionListState } from "../lib/useElectionListState";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { pageMeta } from "../lib/pageMeta";

// Same title as useDocumentTitle below, in the server-rendered HTML. No path:
// the draft is per-browser, so no canonical or og:url.
export const meta: MetaFunction = () => pageMeta({ title: `My Ballot Draft · ${APP_NAME}` });
import { usLatestLocalDate } from "../lib/usLatestLocalDate";
import { isEmbedListedRace } from "../lib/embedPilot";
import { getEmbedHome, useEmbedSession } from "../lib/embedSession";
import { countBucket, track } from "../lib/usage";
import { useShowDraftMilestone } from "../lib/useShowDraftMilestone";

// The page-bottom sign-up CTA, its own component so the "shown" usage event
// rides a mount effect instead of the page's early-return-laden body.
function DraftSignupCta() {
  useEffect(() => {
    track("signup_prompt", { source: "draft", action: "shown" });
  }, []);
  return (
    <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <Link
        to={`/register?next=${encodeURIComponent("/draft")}`}
        onClick={() => track("signup_prompt", { source: "draft", action: "click" })}
        className="rounded-lg bg-rausch px-3 py-1.5 font-semibold text-white transition hover:bg-rausch-dark"
      >
        Sign up free to save your picks
      </Link>
      <span className="text-xs text-ink-soft">
        Your draft lives only on this device until you sign up.
      </span>
    </p>
  );
}

// The guest's My Picks: the header's "My Draft" link lands here, and
// the page renders the SAME date cards the signed-in /me/picks page shows —
// races from the guest's last-viewed ballot, picks from the localStorage
// draft — minus sharing (the share API is account-only). The one addition is
// the register CTA: the draft on display is itself the pitch for saving it.

const DRAFT_NAV_STATE: ElectionNavState = {
  backTo: { path: "/draft", label: "My Draft" },
};

// Bare pick lines rendered straight from draft rows (date · race — choice),
// for the picks no ballot card can carry: the no-ballot-context fallback,
// and picks made off the stored ballot via a shared or searched link.
function DraftChoiceRows({ rows, navState = DRAFT_NAV_STATE }: { rows: ElectionChoice[]; navState?: ElectionNavState }) {
  const sorted = [...rows].sort((a, b) =>
    a.election_date < b.election_date ? -1 : a.election_date > b.election_date ? 1 : 0
  );
  return (
    <ul className="mt-3 space-y-2">
      {sorted.map((choice) => (
        <li key={choice.election_id} className="text-sm">
          <span className="text-ink-soft">{formatElectionDate(choice.election_date)} · </span>
          <Link
            to={`/elections/${choice.election_id}`}
            state={navState}
            className="text-ink hover:text-rausch"
          >
            {choice.official_ballot_title}
          </Link>
          <span className="text-ink-soft"> — </span>
          <span
            className={
              choice.measure_position === "no" ? "font-semibold text-red-900" : "font-semibold text-green-900"
            }
          >
            {choice.measure_position !== null
              ? choice.measure_position === "yes"
                ? "Yes"
                : "No"
              : choice.picks.map((pick, index) => (
                  <span key={pick.candidate_id}>
                    {index > 0 ? ", " : null}
                    {/* Same as the date cards' picked lines: the name links to
                        the candidate's profile, back link returns here. */}
                    <Link
                      to={`/candidates/${pick.candidate_id}`}
                      state={
                        {
                          backTo: navState.backTo,
                          electionId: choice.election_id,
                        } satisfies CandidateNavState
                      }
                      className="hover:text-rausch"
                    >
                      {pick.display_name}
                    </Link>
                  </span>
                ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DraftPage() {
  useDocumentTitle("My Ballot Draft");
  const { me } = useMe();
  const draft = useBallotDraft();
  // Inside the newsroom embed: list view only, the way back is the city list
  // the box started on, and no sign-up button (the box's draft lives in the
  // frame's own storage, so an account made in a new tab would not get it).
  const embedSession = useEmbedSession();
  const embedHome = embedSession ? getEmbedHome() : null;
  const { listState, expandedRetentionDates, setRetentionOpen } = useElectionListState();
  const navState: ElectionNavState = { ...DRAFT_NAV_STATE, ...(listState ? { listState } : {}) };
  const districtIds = draft.district_ids;
  const [view, setView] = useState<"list" | "ballot">("list");
  // ONE payload for both views, in paper-ballot contest order (same contract
  // as the signed-in picks page): the date cards take within-date order from
  // it and the ballot sheets render it as-is, so List and Ballot view can
  // never disagree. This deliberately gives up the cache reuse with
  // BallotPage's default-sort query — a guest arriving from /ballot refetches
  // once — in exchange for one order everywhere.
  // Inside the box the list keeps the box's scope: the city list's pinned
  // election day and no retention questions, so this page and the counter
  // show exactly the races the reader was offered.
  const embedDate = embedSession ? (draft.target?.election_date ?? null) : null;
  const ballot = useQuery({
    queryKey: ["ballot", districtIds.join(","), "preview", embedDate],
    queryFn: async () => {
      const summary = await apiRequest<BallotSummary>(
        `/api/ballot?district_ids=${encodeURIComponent(districtIds.join(","))}&include=preview&sort=state_baseline&followed_first=false` +
          (embedDate ? `&election_date=${embedDate}` : "")
      );
      return embedDate
        ? { ...summary, elections: summary.elections.filter((election) => isEmbedListedRace(election, embedDate)) }
        : summary;
    },
    enabled: me === null && districtIds.length > 0,
  });

  // Same refresh BallotPage does on every successful load: the draft's
  // progress denominator (the header counter's target day) is a snapshot,
  // and this page is the other place a guest loads a full election list —
  // without it a guest who never revisits /ballot keeps a stale target.
  // District ids are the draft's own, so only the target changes; the
  // effect keys on the joined ids, not the array identity.
  const ballotElections = ballot.data?.elections;
  useEffect(() => {
    if (me !== null || !ballotElections) {
      return;
    }
    setDraftBallotContext(districtIds, nearestUpcomingTarget(ballotElections, usLatestLocalDate()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, ballotElections, districtIds.join(",")]);

  // draft_review once per settled load with something to review. The
  // deep-link case (picks, no stored ballot) settles with no query at all.
  const reviewablePicks = draftPickCount(draft);
  const reviewSettled = ballot.isSuccess || districtIds.length === 0;
  useEffect(() => {
    if (me !== null || !reviewSettled || reviewablePicks === 0) {
      return;
    }
    track("draft_review", { pick_count_bucket: countBucket(reviewablePicks), view, store: "draft" });
    // Fires per settled payload, not per pick or view change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, reviewSettled, ballot.data]);

  const pickCount = draftPickCount(draft);
  const choices = draftChoicesByElectionId(draft);
  const today = usLatestLocalDate();
  // Same strict date grouping as /me/picks, upcoming only: a draft is a plan,
  // and past races can no longer be picked. Computed before the early
  // returns below because the milestone hook needs the nearest day.
  const byDate = new Map<string, ElectionSummary[]>();
  for (const election of ballot.data?.elections ?? []) {
    if (election.election_date < today) {
      continue;
    }
    const group = byDate.get(election.election_date) ?? [];
    group.push(election);
    byDate.set(election.election_date, group);
  }
  const dates = [...byDate.keys()].sort();
  // Draft rows the date cards won't display, keyed off the ids actually
  // rendered (not the raw payload): a pick on a just-finished race still in
  // the ballot response would otherwise vanish from both the cards and this
  // list.
  const cardedIds = new Set([...byDate.values()].flat().map((election) => election.id));
  const extraRows = [...choices.values()].filter((choice) => !cardedIds.has(choice.election_id));
  // The finish-line box shows once per day per browser (owner's rule), and
  // while it does the bottom sign-up CTA steps aside — one button per page.
  const nearestRaces = splitRetentionRaces(byDate.get(dates[0]) ?? []);
  const nearestComplete =
    ballot.isSuccess && dates.length > 0 && allRacesDecided(nearestRaces.contested, choices);
  const milestoneShown = useShowDraftMilestone(dates[0], nearestComplete);
  // The guest's ballot, by the draft's own district ids — the same URL
  // /ballot hands the header counter.
  const ballotPath = `/ballot?d=${encodeURIComponent(districtIds.join(","))}`;

  // No-flash rule: nothing until the session state is known.
  if (me === undefined) {
    return <LoadingNotice text="Loading…" />;
  }
  // Signed-in visitors have the real thing — and this is where a guest lands
  // right after registering from the CTA below (?next=/draft), by which time
  // the flush hook has replayed the draft into the account.
  if (me !== null) {
    return <Navigate to="/me/picks" replace />;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Same top bar as the election and candidate pages, back slot only:
          this page is one step below the guest's ballot, and the guest
          header has no ballot link (only "My Draft"), so without it the
          browser's back button was the sole way out. Rendered as soon as
          the draft carries district ids — the /ballot URL needs nothing
          else — and skipped for the no-ballot cases below, which already
          point at the address search. The label is BallotPage's own title. */}
      {embedHome ? (
        <DetailPager ariaLabel="Draft navigation" prev={null} next={null} backTo={embedHome} />
      ) : districtIds.length > 0 ? (
        <DetailPager
          ariaLabel="Draft navigation"
          prev={null}
          next={null}
          backTo={{ path: ballotPath, label: "My elections" }}
        />
      ) : null}
      <h1 className="text-title font-bold">My Ballot Draft</h1>

      {districtIds.length === 0 ? (
        pickCount === 0 ? (
          <>
            <EmptyNotice text="Your ballot draft is empty." />
            <p className="text-center">
              <Link to="/" className="text-ink underline hover:text-rausch">
                Start with your address
              </Link>{" "}
              to see your elections and build your ballot.
            </p>
          </>
        ) : (
          // Deep-link entry: picks exist but no ballot was ever loaded, so
          // there is no race list to card — list the picks themselves and
          // point at the address search, the only page that can build the
          // real ballot around them.
          <>
            <DraftChoiceRows rows={[...choices.values()]} navState={navState} />
            <p className="mt-3 text-sm text-ink-soft">
              <Link to="/" className="underline hover:text-ink">
                Search your address
              </Link>{" "}
              to see every race on your ballot.
            </p>
          </>
        )
      ) : (
        <>
          {ballot.isPending ? <LoadingNotice text="Loading your elections…" /> : null}
          {ballot.isError ? (
            <div className="mt-4">
              <ErrorNotice error={ballot.error} />
            </div>
          ) : null}
          {ballot.isSuccess ? (
            dates.length === 0 ? (
              <EmptyNotice text="No upcoming elections found for your districts yet. Check back — new elections are added as they are announced." />
            ) : (
              <>
                {/* Above the toggle so both views carry it; dates holds
                    upcoming days only, so the first is the nearest. */}
                <DraftMilestone
                  show={milestoneShown}
                  date={dates[0]}
                  signup={!embedSession}
                  hasOpenRetention={nearestRaces.retention.some((election) => !isDecidedChoice(choices.get(election.id)))}
                />
                {embedSession ? null : (
                  <div className="mt-4">
                    <BallotViewToggle
                      view={view}
                      onChange={(next) => {
                        track("list_control", { control: "view_toggle", value: next });
                        setView(next);
                      }}
                    />
                  </div>
                )}
                {view === "ballot" && !embedSession ? (
                  // Same settled payload as the cards — no second fetch, no
                  // loading state of its own.
                  <BallotPreviewSheets
                    elections={ballot.data?.elections ?? []}
                    choiceByElectionId={choices}
                    today={today}
                  />
                ) : (
                  <div className="mt-4 space-y-4">
                    {dates.map((date) => (
                      <PickDateCard
                        key={date}
                        date={date}
                        elections={byDate.get(date) ?? []}
                        choiceByElectionId={choices}
                        share={false}
                        navState={navState}
                        retentionOpen={expandedRetentionDates.includes(date)}
                        onRetentionOpenChange={(open) => setRetentionOpen(date, open)}
                      />
                    ))}
                  </div>
                )}
              </>
            )
          ) : null}
          {/* Picks the cards above can't carry — made on races outside the
              stored ballot (a shared or searched link) or on races the
              upcoming cards no longer show. A saved pick must never be
              invisible on this page: the header badge and the signup CTA
              both count it, so hiding it here reads as lost. Only rendered
              once the ballot settles — before that, "outside the cards" is
              unknowable. */}
          {ballot.isSuccess && extraRows.length > 0 ? (
            <section className="mt-6">
              <h2 className="text-heading font-semibold text-ink">Other saved picks</h2>
              <p className="mt-0.5 text-xs text-ink-soft">
                Races you picked from a direct link — not part of the ballot above.
              </p>
              <DraftChoiceRows rows={extraRows} navState={navState} />
            </section>
          ) : null}
        </>
      )}

      {/* Hidden while the milestone above the toggle renders: it carries
          this same link and hint, and two identical buttons on one short
          page read as a mistake. */}
      {pickCount > 0 && !milestoneShown && !embedSession ? <DraftSignupCta /> : null}
    </div>
  );
}

export default DraftPage;

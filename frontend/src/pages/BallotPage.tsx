import { useEffect } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { MetaFunction } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { APP_NAME, apiRequest, useMe } from "@voteapp/api-client";
import {
  BALLOT_SORTS,
  PUBLIC_BALLOT_SORTS,
  type BallotSort,
  type BallotSummary,
} from "@voteapp/api-client";
import { ElectionList } from "../components/ElectionCard";
import { RaceTypeTabs } from "../components/RaceTypeTabs";
import { HowToVoteControl } from "../components/HowToVoteControl";
import {
  deriveBallotFilters,
  railSortForBallotSort,
  sortRailEntries,
  useElectionChoices,
  useMyResearchAreas,
} from "@voteapp/api-client";
import {
  draftChoicesByElectionId,
  nearestUpcomingTarget,
  setDraftBallotContext,
  useBallotDraft,
} from "../lib/ballotDraft";
import { useRaceTypeParam } from "../lib/useRaceTypeParam";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../components/Status";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { pageMeta } from "../lib/pageMeta";

// Same title as useDocumentTitle below, but in the server-rendered HTML. No
// path: a ballot URL is district-specific, so no canonical or og:url here.
export const meta: MetaFunction = () => pageMeta({ title: `Elections · ${APP_NAME}` });
import { useHydrated } from "../lib/useHydrated";
import { getEmbedHome, useEmbedSession } from "../lib/embedSession";
import { DetailPager } from "../components/DetailPager";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";
import { useTrackBallotResult, track } from "../lib/usage";

// The anonymous endpoint can honor these server-side. my_areas is offered on
// top of them to signed-in visitors with saved research areas, honored by a
// CLIENT-side re-sort (sortRailEntries — the same mirror of the backend
// comparator the detail rail uses), because /api/ballot has no user to score
// against. For anonymous visitors a my_areas URL value falls back to
// vote_power so the UI never claims an ordering nobody computed.
const SORT_VALUES: readonly string[] = PUBLIC_BALLOT_SORTS.map((option) => option.value);

export function BallotPage() {
  useDocumentTitle("Elections");
  // Signed-in verified visitors get their saved areas listed first (in their
  // own rank order) even on the public ballot; anonymous visitors get an
  // empty map (no personalization).
  const {
    weights: savedAreaWeights,
    savedAreaIds,
    hasSaved,
    isLoading: savedAreasLoading,
  } = useMyResearchAreas();
  const { choiceByElectionId } = useElectionChoices();
  // Guests read their picks from the local ballot draft instead of the
  // account endpoint — the same chips render from either source.
  const { me } = useMe();
  const isGuest = me === null;
  const draft = useBallotDraft();
  // Set by the home page's post-search navigation so the visitor can confirm
  // the geocoder matched the right address. Router state only — the address is
  // personal data and must stay out of the URL; a shared link omits the
  // confirmation line. A refresh does NOT: the browser restores router state
  // from history.state, which is exactly why it must read as null until
  // hydration — SSR rendered this document without it.
  const location = useLocation();
  const hydrated = useHydrated();
  const routerState = hydrated
    ? (location.state as { matchedAddress?: unknown; addressMatchCount?: unknown; scope?: unknown } | null)
    : null;
  const matchedAddress = typeof routerState?.matchedAddress === "string" ? routerState.matchedAddress : null;
  // Which partial search produced this ballot ("zip" names the ZIP, "region"
  // names the area); null on bare links, where the banner stays generic.
  const partialScope =
    routerState?.scope === "zip" || routerState?.scope === "region" ? routerState.scope : null;
  // The geocoder returned more than one candidate address and the ballot is
  // for the first one — the confirmation line alone is too easy to skim past.
  const ambiguousMatchCount =
    typeof routerState?.addressMatchCount === "number" && routerState.addressMatchCount > 1
      ? routerState.addressMatchCount
      : null;
  const [searchParams, setSearchParams] = useSearchParams();
  // Set by ZIP searches; deliberately a URL param, not router state — it
  // holds no location, and the partial label must survive refresh and
  // shared links.
  const isPartialBallot = searchParams.get("partial") === "1";
  const districtIds = (searchParams.get("d") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const rawSort = searchParams.get("sort") ?? "";
  // my_areas is only real once the viewer's saved areas confirm (hasSaved);
  // until then — and for anonymous visitors forever — it degrades to the
  // vote_power default. The list is withheld while that's still unsettled
  // (awaitingSavedAreas below) so the degraded order never flashes.
  const myAreasRequested = rawSort === "my_areas";
  const sort: BallotSort = myAreasRequested
    ? hasSaved
      ? "my_areas"
      : "vote_power"
    : SORT_VALUES.includes(rawSort)
      ? (rawSort as BallotSort)
      : "vote_power";
  // What the anonymous endpoint is asked for: my_areas is client-side here,
  // so its fetch requests (and caches under) the plain vote_power payload.
  const fetchSort: BallotSort = sort === "my_areas" ? "vote_power" : sort;
  const { raceTypeRequested, onRaceTypeChange } = useRaceTypeParam();

  const ballot = useQuery({
    queryKey: ["ballot", districtIds.join(","), fetchSort],
    queryFn: () =>
      apiRequest<BallotSummary>(
        `/api/ballot?district_ids=${encodeURIComponent(districtIds.join(","))}&sort=${fetchSort}`
      ),
    enabled: districtIds.length > 0,
  });

  useTrackBallotResult(ballot, {
    scope: isPartialBallot ? (partialScope ?? "unknown") : "exact",
    partialBanner: isPartialBallot,
    ambiguousBanner: Boolean(matchedAddress && ambiguousMatchCount),
  });

  // Keep the guest draft's badge link and progress denominator tracking the
  // ballot the guest actually looked at last. Signed-in visitors never touch
  // the draft here — theirs lives in the account.
  // Inside the newsroom box: "search again" goes to the box's own search
  // page instead of the site's landing page, and a top bar leads back there.
  const embedSession = useEmbedSession();
  const embedHome = embedSession ? getEmbedHome() : null;
  const searchAgainPath = embedHome?.path ?? "/?new=1";

  const ballotElections = ballot.data?.elections;
  useEffect(() => {
    if (!isGuest || !ballotElections) {
      return;
    }
    setDraftBallotContext(districtIds, nearestUpcomingTarget(ballotElections, usLatestLocalDate()));
    // districtIds is rebuilt each render; its joined string is the stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGuest, ballotElections, districtIds.join(",")]);

  function onSortChange(nextSort: string) {
    track("list_control", { control: "sort", value: nextSort });
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("sort", nextSort);
        return next;
      },
      { replace: true }
    );
  }

  // The web pages offer no hide-by-choice filters (the vote_power sort
  // already surfaces the high-impact races on top); only the race-type tab
  // slices the list. The shared derivation still serves mobile's filters.
  const filtersView = deriveBallotFilters({
    elections: ballot.data?.elections ?? [],
    savedAreaIds,
    hasSaved,
    issuesRequested: false,
    impactRequested: null,
    raceTypeRequested,
  });
  // A ?sort=my_areas load must not flash the unsorted ballot while the saved
  // areas are still unknown (the ballot is one request; the saved areas are
  // two chained ones, so the ballot usually lands first). Withhold the list
  // until the flag settles — it settles on failure too, falling open to the
  // vote_power order: a ballot app errs toward showing races, and the select
  // admits the fallback rather than claiming an issue ordering.
  const awaitingSavedAreas = myAreasRequested && savedAreasLoading;

  // The my_areas re-sort. Runs over the tab-visible list only; the
  // awaiting-candidates tail needs no special handling because ElectionList
  // splits it into its own closing section regardless of input order (the
  // backend's sink + compare produces the same outcome). The wrapper objects
  // adapt ElectionSummary's field names to the shared comparator's keys.
  const visibleElections =
    sort === "my_areas"
      ? sortRailEntries(
          filtersView.visibleElections.map((election) => ({
            id: election.id,
            title: election.official_ballot_title,
            race_type: election.race_type,
            vote_power_score: election.vote_power.score,
            election_date: election.election_date,
            research_area_ids: election.research_areas.map((area) => area.id),
            election,
          })),
          "my_areas",
          savedAreaWeights
        ).map((entry) => entry.election)
      : filtersView.visibleElections;

  // my_areas rides on top of the public sorts, only for viewers who can be
  // scored against (saved research areas confirmed).
  const sortOptions = hasSaved ? BALLOT_SORTS : PUBLIC_BALLOT_SORTS;

  if (districtIds.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="sr-only">Elections</h1>
        <EmptyNotice text="No districts selected." />
        <p className="text-center">
          <Link to={embedHome?.path ?? "/"} className="text-ink underline hover:text-rausch">
            Start with your address
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Visible page heading, one step larger than the date group headings
          ("Elections on …") below it, so a first-time visitor landing here
          straight from the address form knows what the list is: THEIR
          elections. "My elections", not "Upcoming elections": the list keeps
          just-finished elections for BALLOT_PAST_ELECTION_VISIBILITY_DAYS so
          their results stay discoverable, and those are not upcoming. */}
      {embedHome ? <DetailPager ariaLabel="Ballot navigation" prev={null} next={null} backTo={embedHome} /> : null}
      <h1 className="mb-4 text-title font-bold text-ink">My elections:</h1>
      {/* Race-type tabs and sorting on the left, the "How to vote" resources
          on the right — its disclosure panel opens inline under its own
          column. The how-to-vote control waits for the ballot response
          because that's where its state abbreviation(s) come from. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Offered only when the ballot mixes candidate races and ballot
              measures — a single-type ballot has nothing to switch between. */}
          {filtersView.showRaceTypeTabs ? (
            <RaceTypeTabs raceType={filtersView.raceType} onChange={onRaceTypeChange} />
          ) : null}
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            Sort by
            <select
              value={sort}
              onChange={(event) => onSortChange(event.target.value)}
              className="rounded-md border border-line bg-white px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {ballot.isSuccess ? (
          <HowToVoteControl states={ballot.data.districts.map((district) => district.state)} />
        ) : null}
      </div>

      {/* The always-on "Matched address" confirmation line was dropped as
          clutter; the warning below is self-contained (it names the matched
          address) and only appears when the geocoder was ambiguous — the one
          case where the ballot has a real chance of being for the wrong
          address. */}
      {/* ZIP and city searches land here with partial=1 in the URL (the flag
          carries no location, so unlike the matched address it survives
          refreshes and shared links). The ZIP or area name rides router
          state as the matched address; a bare link renders the generic
          wording. */}
      {isPartialBallot ? (
        <p role="alert" className="mt-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink">
          {/* Deliberately no claim about WHAT is excluded: ward/seat races
              ride the area's district row on exact ballots too (see
              ElectionCard's sub_district_seat note) and render here with
              their own "may not cover your address" label, so any exclusion
              rule stated up here would be false for them. The CTA sentence
              already names what a street address adds. */}
          {matchedAddress && partialScope ? (
            <>
              This is a partial ballot for {partialScope === "zip" ? "ZIP code " : ""}
              <span className="font-medium">{matchedAddress}</span>.
            </>
          ) : (
            "This is a partial ballot."
          )}{" "}
          <Link
            to={searchAgainPath}
            onClick={() => track("partial_upgrade_click", { banner: "partial" })}
            className="underline hover:text-rausch"
          >
            Enter your street address
          </Link>{" "}
          to check for additional congressional, legislative, local, and school races.
        </p>
      ) : null}

      {matchedAddress && ambiguousMatchCount ? (
        <p role="alert" className="mt-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink">
          Your search matched {ambiguousMatchCount} possible addresses, and this ballot is for{" "}
          <span className="font-medium">{matchedAddress}</span>. If that is not your address,{" "}
          <Link
            to={searchAgainPath}
            onClick={() => track("partial_upgrade_click", { banner: "ambiguous" })}
            className="underline hover:text-rausch"
          >
            search again
          </Link>{" "}
          with your full street address, city, and ZIP code.
        </p>
      ) : null}

      {/* A ballot error wins over the saved-areas withhold: with no list to
          withhold, gating on the filter would pair the loading notice with
          the error (or hide the error outright). */}
      {ballot.isPending || (awaitingSavedAreas && !ballot.isError) ? (
        <LoadingNotice text="Loading your elections…" />
      ) : null}
      {ballot.isError ? (
        <div className="mt-4">
          <ErrorNotice error={ballot.error} />
        </div>
      ) : null}

      {ballot.isSuccess && !awaitingSavedAreas ? (
        <>
          {ballot.data.elections.length === 0 ? (
            <EmptyNotice text="No upcoming elections found for these districts yet. Check back — new elections are added as they are announced." />
          ) : (
            // An active filter can empty this list; the "N elections hidden ·
            // Show all" line in the controls row explains the empty view.
            <ElectionList
              elections={visibleElections}
              savedAreaWeights={savedAreaWeights}
              choicesByElectionId={isGuest ? draftChoicesByElectionId(draft) : choiceByElectionId}
              // Full query string: the back link must return to this exact
              // list — same districts, sort, and filters.
              backTo={{ path: location.pathname + location.search, label: "All elections" }}
              // Tab-unsliced pool + the engaged tab: the detail rail's own
              // race-type tabs start here and can reach the other tab's races.
              contestsPool={filtersView.filteredElections}
              raceType={filtersView.raceType}
              // Seed the rail's always-engaged sort from this list's sort.
              railSort={railSortForBallotSort(sort)}
              sort={sort}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

export default BallotPage;

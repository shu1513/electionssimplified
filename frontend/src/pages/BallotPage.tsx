import { useEffect } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { MetaFunction } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { APP_NAME, apiRequest, useMe } from "@voteapp/api-client";
import {
  BALLOT_SORTS,
  DEFAULT_BALLOT_SORT,
  PUBLIC_BALLOT_SORTS,
  type BallotSort,
  type BallotSummary,
} from "@voteapp/api-client";
import { ElectionList, splitViewEntry } from "../components/ElectionCard";
import { useSplitViewForward, useSplitViewShortcut } from "../lib/useSplitViewShortcut";
import { CandidateSearchBox } from "../components/CandidateSearchBox";
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
// against. For anonymous visitors a my_areas URL value falls back to the
// default sort so the UI never claims an ordering nobody computed.
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
    ? (location.state as
        | { matchedAddress?: unknown; addressMatchCount?: unknown; scope?: unknown }
        | null)
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
  // Inside the newsroom box the list starts with the biggest districts first
  // (president, governor, U.S. Senate), the order a reader expects from a
  // ballot; a sort the reader picks still wins, as on the site.
  const embedSession = useEmbedSession();
  // Wide screens skip this list for the split view (useSplitViewShortcut).
  // Held when the page has something to say first — a partial ballot or an
  // ambiguous address match, whose banners the split view has no place
  // for — and inside the newsroom box, which is too small for the rail.
  const shortcut = useSplitViewShortcut({
    hold: Boolean(embedSession) || isPartialBallot || Boolean(matchedAddress && ambiguousMatchCount),
  });
  // Split-view-sized screens default to ballot order (owner, 2026-10-31)
  // when the URL names no sort — whether this list forwards to the split
  // view or is shown (held, or asked for), since a card click from it
  // seeds the rail with this list's sort. Narrow screens keep vote power.
  const defaultSort: BallotSort = embedSession
    ? "district_size"
    : shortcut.wide
      ? "state_baseline"
      : DEFAULT_BALLOT_SORT;
  const rawSort = searchParams.get("sort") ?? "";
  // my_areas is only real once the viewer's saved areas confirm (hasSaved);
  // until then — and for anonymous visitors forever — it degrades to the
  // default sort. The list is withheld while that's still unsettled
  // (awaitingSavedAreas below) so the degraded order never flashes.
  const myAreasRequested = rawSort === "my_areas";
  const sort: BallotSort = myAreasRequested
    ? hasSaved
      ? "my_areas"
      : defaultSort
    : SORT_VALUES.includes(rawSort)
      ? (rawSort as BallotSort)
      : defaultSort;
  // What the anonymous endpoint is asked for: my_areas is client-side here,
  // so its fetch requests (and caches under) the plain vote_power payload.
  const fetchSort: BallotSort = sort === "my_areas" ? "vote_power" : sort;

  const ballot = useQuery({
    queryKey: ["ballot", districtIds.join(","), fetchSort],
    queryFn: () =>
      apiRequest<BallotSummary>(
        `/api/ballot?district_ids=${encodeURIComponent(districtIds.join(","))}&sort=${fetchSort}`
      ),
    // hydrated: the shortcut's sort is undecided during the hydration render
    // (the viewport reads as narrow there), and a fetch in the wrong sort
    // would only be thrown away one paint later.
    enabled: districtIds.length > 0 && hydrated,
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
    raceTypeRequested: null,
  });
  // A ?sort=my_areas load must not flash the unsorted ballot while the saved
  // areas are still unknown (the ballot is one request; the saved areas are
  // two chained ones, so the ballot usually lands first). Withhold the list
  // until the flag settles — it settles on failure too, falling open to the
  // default order: a ballot app errs toward showing races, and the select
  // admits the fallback rather than claiming an issue ordering.
  const awaitingSavedAreas = myAreasRequested && savedAreasLoading;

  // The my_areas re-sort. Runs over the full list; the
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

  // Where a detail page's back link returns: this exact list — same
  // districts, sort, and filters (full query string). On a split-view-sized
  // screen the ballot-order default is named explicitly, so "← All
  // elections" shows the list in the order the rail had whatever screen it
  // is opened on.
  const listBackTo = {
    path:
      shortcut.wide && !searchParams.has("sort")
        ? `${location.pathname}${location.search}${location.search ? "&" : "?"}sort=${sort}`
        : location.pathname + location.search,
    label: "All elections",
  };
  // The forward itself: the first displayed race, carrying the snapshot its
  // card would have delivered. Not before identity settles: the guest draft
  // effect above records the ballot's districts only once me reads null,
  // and the election page's pick controls are gated on those districts —
  // forwarding first would unmount this page with them unsaved.
  const skippingList = useSplitViewForward(
    shortcut,
    ballot.isSuccess && !awaitingSavedAreas && me !== undefined
      ? splitViewEntry({
          elections: visibleElections,
          contestsPool: filtersView.filteredElections,
          sort,
          backTo: listBackTo,
          raceType: filtersView.raceType,
          railSort: railSortForBallotSort(sort),
        })
      : null
  );

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

  if (skippingList) {
    // The forward to the split view is in flight: the loading notice stays
    // up rather than the list flashing for a frame.
    return (
      <div className="mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px]">
        <h1 className="sr-only">Elections</h1>
        <LoadingNotice text="Loading your elections…" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px] box:px-[11px] box:pt-[11px] box:pb-[29px]">
      {/* Visible page heading, one step larger than the date group headings
          ("Elections on …") below it, so a first-time visitor landing here
          straight from the address form knows what the list is: THEIR
          elections. "My elections", not "Upcoming elections": the list keeps
          just-finished elections for BALLOT_PAST_ELECTION_VISIBILITY_DAYS so
          their results stay discoverable, and those are not upcoming. */}
      {embedHome ? <DetailPager ariaLabel="Ballot navigation" prev={null} next={null} backTo={embedHome} /> : null}
      <h1 className="mb-[18px] text-title font-bold text-ink box:mb-[11px]">My elections:</h1>
      {/* Sorting and candidate search on the left, the "How to vote" resources
          on the right — its disclosure panel opens inline under its own
          column. The how-to-vote control waits for the ballot response
          because that's where its state abbreviation(s) come from. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            Sort by
            <select
              value={sort}
              onChange={(event) => onSortChange(event.target.value)}
              className="select-chevron w-[9.5rem] rounded-md border border-line bg-white py-1.5 pl-2 pr-6 text-sm text-ink focus:border-ink focus:outline-none"
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <CandidateSearchBox
            backTo={{ path: location.pathname + location.search, label: "All elections" }}
            label="Candidate:"
            ballotDistrictIds={districtIds}
            labelClassName="text-ink-soft"
            narrow
          />
        </div>
        {/* Not inside the newsroom box: its links all leave the box, and the
            row is too narrow there to spare the room. */}
        {ballot.isSuccess && !embedSession ? (
          <HowToVoteControl states={ballot.data.districts.map((district) => district.state)} />
        ) : null}
      </div>

      {/* One line for the visitor who just typed an address on the landing
          page: which address these elections are for, plus the privacy
          promise the address field made, scoped to accounts on purpose. The
          address does not land on any account (the districts ride the URL and
          the local draft), but the backend keeps a short-lived geocoder cache
          the privacy policy discloses, so "never stored" or "only the
          districts were kept" would be untrue. Guests only, and only when
          neither banner below already names the address (partial or
          ambiguous match).
          Router state, so a refresh keeps it and a shared link never has it.
          Signed-in visitors saving an address get AddressSavedNotice on
          their saved ballot instead; a member's one-off search stays quiet.
          isGuest is false while /api/me is still loading, so the line
          appears once identity settles rather than flashing for a member. */}
      {matchedAddress && isGuest && !isPartialBallot && !ambiguousMatchCount ? (
        <p role="status" className="mt-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink">
          Elections for <span className="font-medium">{matchedAddress}</span>. Your address was only used to
          find these election districts. We do NOT save it to your account.
        </p>
      ) : null}
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
              backTo={listBackTo}
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

import type { BallotRaceType, RailSortKey, ResearchAreaWeight } from "@voteapp/api-client";
import {
  VOTE_POWER_BAND_ORDER,
  isRailDistrictSort,
  railSortForBallotSort,
  railSortsOffered,
  sortRailEntries,
} from "@voteapp/api-client";
import type { ElectionNavState, NavContest } from "./detailNavContext";

export type RailOrder = {
  /** The full snapshot, untouched (the rail's mount gate reads it). */
  contests: NavContest[] | undefined;
  /** The sorts this snapshot can honor; empty on an unkeyed snapshot or
   * while the saved areas load. */
  offeredRailSorts: RailSortKey[];
  /** The engaged sort, or null with nothing offerable. */
  railSort: RailSortKey | null;
  /** The engaged sort is one the reader did not choose (rewriteBackPath). */
  railSortFallback: boolean;
  railDistrictOffered: boolean;
  /** Vote-power band headings are on (the list's ten-race rule). */
  railVotePowerBands: boolean;
  /** What the rail shows, in order: the engaged tab's slice, in the
   * engaged sort, bands first where they are on. Prev/next walk it. */
  displayedContests: NavContest[] | undefined;
};

/**
 * The election rail's order from a nav snapshot — tab slice, engaged sort,
 * vote-power bands — as the election page renders it. Pure, so the
 * candidate page's post-pick advance can find the same "next race" from
 * the election context it carries (its backState) without a round trip.
 *
 * The rail mirrors the list tab the reader arrived from (navState.raceType):
 * it slices to that race type when the snapshot types every contest (an
 * old history entry may not) and holds both types. No switch of its own —
 * the list page's tabs are the one place the type is chosen, so the back
 * link's ?type= is never rewritten.
 *
 * The sort control is offered only for the sorts the snapshot can honor
 * faithfully (railSortsOffered — an old unkeyed snapshot offers none), and
 * withheld while the saved areas load so the default cannot engage
 * prematurely and visibly re-shuffle. The sort is always engaged, seeded
 * by the LIST's sort (the pages stamp railSort via railSortForBallotSort —
 * the rail's sorts are the list's own, the two district-size sorts
 * included). A snapshot that PREDATES the railSort stamp seeds from the
 * back URL's own ?sort= instead — defaulting it to vote_power would make
 * rewriteBackPath silently rewrite a sort=my_areas back link the reader
 * never touched. Only after both fall through does vote_power, the
 * ballot's default, apply. `railSortOverride` is the reader's explicit
 * pick on the rail's control (component state on the election page).
 */
export function railOrder({
  navState,
  railSortOverride,
  weights,
  hasSaved,
  savedAreasLoading,
}: {
  navState: ElectionNavState | null;
  railSortOverride: RailSortKey | null;
  weights: Map<string, ResearchAreaWeight>;
  hasSaved: boolean;
  savedAreasLoading: boolean;
}): RailOrder {
  const contests = navState?.contests;
  const railTabsAvailable =
    contests !== undefined &&
    contests.every((contest) => contest.race_type !== undefined) &&
    contests.some((contest) => contest.race_type === "office") &&
    contests.some((contest) => contest.race_type === "ballot_measure");
  const railTab: BallotRaceType | null = railTabsAvailable ? (navState?.raceType ?? null) : null;
  // The direction the snapshot's district headings run in — the list's
  // sort at click time (stamped; else read off the back URL for a snapshot
  // that predates the stamp). Flipping to the other district sort runs the
  // groups the other way.
  const snapshotDistrictSort = (() => {
    if (navState === null) return null;
    // listSort, never railSort: railSort is the rail's engaged sort and is
    // forwarded on sibling walks, so after a switch to a district sort it
    // would misread a vote-power snapshot as size-ordered.
    const stamped = navState.listSort;
    if (isRailDistrictSort(stamped)) return stamped;
    if (stamped !== undefined) return null;
    // A snapshot that predates the listSort stamp: the back URL's sort.
    const fromUrl = railSortForBallotSort(
      new URL(navState.backTo.path, "http://internal").searchParams.get("sort") ?? "vote_power"
    );
    return isRailDistrictSort(fromUrl) ? fromUrl : null;
  })();
  // Ballot order is offered only from a snapshot that arrived in it (the
  // rail cannot compute the paper-ballot order itself); listSort, never
  // railSort, for the same reason as above.
  const snapshotBallotOrdered = navState?.listSort === "ballot_order";
  const offeredRailSorts = savedAreasLoading
    ? []
    : railSortsOffered(contests ?? [], hasSaved, {
        snapshotOrdered: snapshotDistrictSort !== null,
        ballotOrdered: snapshotBallotOrdered,
      });
  const railSortState =
    railSortOverride ??
    (navState === null
      ? null
      : navState.railSort !== undefined
        ? navState.railSort
        : railSortForBallotSort(
            new URL(navState.backTo.path, "http://internal").searchParams.get("sort") ?? "vote_power"
          ));
  const railSort =
    railSortState !== null && offeredRailSorts.includes(railSortState)
      ? railSortState
      : offeredRailSorts.includes("vote_power")
        ? "vote_power"
        : (offeredRailSorts[0] ?? null);
  const railSortFallback = railSort !== railSortState;
  const railDistrictOffered = offeredRailSorts.some((sort) => isRailDistrictSort(sort));
  // Prev/next walk exactly what the rail shows: the engaged tab's slice, in
  // the engaged sort's order.
  const slicedContests =
    railTab !== null && contests !== undefined
      ? contests.filter((contest) => contest.race_type === railTab)
      : contests;
  const sortedContests =
    railSort !== null && slicedContests !== undefined
      ? sortRailEntries(slicedContests, railSort, weights, {
          // A district-size arrival's own order is the list's true size
          // order: keep it (flipped for the other direction). Any other
          // arrival orders the levels itself.
          groupOrder: snapshotDistrictSort !== null ? "snapshot" : "level",
          reverseGroups:
            isRailDistrictSort(railSort) && snapshotDistrictSort !== null && railSort !== snapshotDistrictSort,
        })
      : slicedContests;
  // Vote-power band headings by the list's own rule: bands only once ten
  // or more banded races are on show, so a short ballot is not chopped
  // into tiny sections — and only on a single-date slice, since the list
  // counts per date and the rail has no date headings to keep a second
  // date's bands from reading as repeats.
  const bandedContests = (sortedContests ?? []).filter((contest) => contest.vote_power_band !== undefined);
  const railVotePowerBands =
    railSort === "vote_power" &&
    bandedContests.length >= 10 &&
    new Set(bandedContests.map((contest) => contest.election_date)).size === 1;
  // With bands on, the order is the list's: band first, score within — the
  // scorer's ratings are not monotone in the score (a measure bump can
  // lift a rating), so a pure score order would repeat a heading. A stable
  // sort keeps the score order inside each band; the tails (no band) stay
  // where sortRailEntries put them. Rail and pager both read this array.
  const bandRank = (contest: NavContest): number =>
    contest.vote_power_band === undefined
      ? Number.POSITIVE_INFINITY
      : VOTE_POWER_BAND_ORDER.indexOf(contest.vote_power_band as (typeof VOTE_POWER_BAND_ORDER)[number]);
  const displayedContests =
    railVotePowerBands && sortedContests !== undefined
      ? [...sortedContests].sort((a, b) => bandRank(a) - bandRank(b))
      : sortedContests;
  return {
    contests,
    offeredRailSorts,
    railSort,
    railSortFallback,
    railDistrictOffered,
    railVotePowerBands,
    displayedContests,
  };
}

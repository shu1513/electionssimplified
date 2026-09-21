import { Fragment, useEffect, useRef, useState } from "react";
import { isRouteErrorResponse, Link, useLoaderData, useLocation, useRouteError } from "react-router";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import type { BallotRaceType, ElectionDetail, PartyBucket, RailSortKey } from "@voteapp/api-client";
import {
  RAIL_SORTS,
  competitivenessChip,
  railSortForBallotSort,
  railSortsOffered,
  sortRailEntries,
} from "@voteapp/api-client";
import { partyColorClass } from "@voteapp/api-client";
import { DetailPager } from "../components/DetailPager";
import { DetailRail } from "../components/DetailRail";
import { RaceTypeTabs } from "../components/RaceTypeTabs";
import {
  pagerNeighbors,
  readElectionNavState,
  type CandidateNavState,
  type ElectionNavState,
} from "../lib/detailNavContext";
import { JsonLdScript } from "../components/JsonLdScript";
import { MeasureFundingSection } from "../components/MeasureFundingSection";
import { NotFoundNotice } from "../components/NotFoundNotice";
import { RouteError } from "../components/RouteError";
import { SourceFootnote } from "../components/SourceFootnote";
import { SourceLine } from "../components/SourceLine";
import { ReportContentButton } from "../components/ReportContentButton";
import { ShareButton } from "../components/ShareButton";
import {
  deriveCandidateResultBadges,
  formatDistrictName,
  formatElectionDate,
  formatOutcome,
  formatRosterStatus,
  formatVotePowerLabel,
} from "@voteapp/api-client";
import { loadFromApi } from "../lib/loadFromApi";
import { useHydrated } from "../lib/useHydrated";
import { pageMeta } from "../lib/pageMeta";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";
import { AREA_TEXT_CLASS, SAVED_AREA_TEXT_CLASS } from "../components/ElectionCard";
import { CappedInlineList } from "../components/CappedInlineList";
import { AutoPickControl } from "../components/AutoPickControl";
import { RetentionJudgeSection } from "../components/RetentionJudgeSection";
import { CandidatePickButton, MeasureChoiceButtons, StrandedPicksNotice } from "../components/ElectionChoiceControls";
import { PostPickActions } from "../components/PostPickActions";
import { draftChoicesByElectionId, isDecidedChoice, useBallotDraft } from "../lib/ballotDraft";
import { useMyDistricts } from "../lib/useMyDistricts";
import { AddressNudge } from "../components/AddressNudge";
import { isRetentionRace, splitResearchAreasBySaved, useElectionChoices } from "@voteapp/api-client";
import { votePowerBadgeClass } from "../lib/votePowerBadge";
import { APP_NAME } from "@voteapp/api-client";
import { useMe } from "@voteapp/api-client";
import { useMyResearchAreas } from "@voteapp/api-client";
import { aggregateRecordAreaStances, scoreStanceRelevance } from "@voteapp/api-client";
import { partyBucket } from "@voteapp/api-client";
import { positionBucket, sourceLinkProps, track, useSectionExposure } from "../lib/usage";

// "alphabetical" is the payload's own order: the API sorts candidates by
// display name (there is no true ballot-position data). "my_issues" is the
// default for viewers with saved research areas.
type CandidateSort = "alphabetical" | "my_issues";

// Rewrites the back link's ?type= (and, where the list can honor it, ?sort=)
// to the rail's current tab and sort, so leaving the split view lands on the
// view the rail is showing rather than the one the reader arrived with.
// Sort carry-over rules: vote_power is a list sort on both pages; my_areas
// reaches both ballot lists (/me/ballot server-side, /ballot via its
// client-side mirror — which degrades to vote_power rather than lying if
// the URL ever lands on a viewer without saved areas); alphabetical is
// rail-only and leaves the path's sort untouched. The rewrite happens only when the engaged sort would
// CHANGE the order the back URL already yields — the rail's seeded default
// is mapped FROM that URL's sort (railSortForBallotSort), so this rule
// keeps a richer list sort the rail merely approximates (district_size →
// vote_power) from being silently overwritten, while a genuinely different
// choice still carries over. The base is a throwaway for relative parsing
// only.
function rewriteBackPath(
  path: string,
  tabs: { available: boolean; raceType: BallotRaceType | null },
  railSort: RailSortKey | null
): string {
  const url = new URL(path, "http://internal");
  if (tabs.available) {
    if (tabs.raceType) {
      url.searchParams.set("type", tabs.raceType);
    } else {
      url.searchParams.delete("type");
    }
  }
  const honorable =
    railSort === "vote_power" ||
    (railSort === "my_areas" && (url.pathname === "/me/ballot" || url.pathname === "/ballot"));
  if (honorable && railSort !== railSortForBallotSort(url.searchParams.get("sort") ?? "vote_power")) {
    url.searchParams.set("sort", railSort);
  }
  return url.pathname + url.search + url.hash;
}

// The party filter over the candidates list. Order fixes the chip row;
// labels are plural because the chips answer "show me the …".
const PARTY_FILTER_OPTIONS: { bucket: PartyBucket; label: string }[] = [
  { bucket: "democratic", label: "Democrats" },
  { bucket: "republican", label: "Republicans" },
  { bucket: "other", label: "Other" },
];

// The office summary is seeded (seedOffices.ts) as newline-separated
// bullets, rendered as-is under the "About this office" heading. Blank lines
// are dropped; nothing else is parsed — no hook, no label.
function officeSummaryLines(summary: string): string[] {
  return summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// Server loader: the election subject arrives in the document HTML so
// non-JS crawlers can read it. Anonymous by design — see loadFromApi.
export async function loader({ params, request }: LoaderFunctionArgs) {
  return loadFromApi<ElectionDetail>(`/api/elections/${params.electionId}`, request);
}

// Replaces useDocumentTitle here: a leaf meta export fully overrides the
// root's, so it must carry the full pageMeta set — title alone would drop
// the og:*/twitter:* share-card tags on exactly the page people share.
export const meta: MetaFunction<typeof loader> = ({ data, error, location }) => {
  if (!data) {
    // "Not found" only for real 404s; a 429/502/504 render must not tell
    // crawlers the page doesn't exist.
    const isNotFound = isRouteErrorResponse(error) && error.status === 404;
    return [{ title: isNotFound ? `Not found · ${APP_NAME}` : `Something went wrong · ${APP_NAME}` }];
  }
  return pageMeta({
    title: `${data.official_ballot_title} · ${APP_NAME}`,
    // No "campaign finance" here: this page stopped rendering finance
    // (it lives on candidate profiles now), and a search preview must not
    // promise content the page doesn't have.
    description: `${data.official_ballot_title} — ${formatDistrictName(data.district.name)} election on ${data.election_date}: candidates and issue research.`,
    path: location.pathname,
  });
};

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundNotice subject="Election" />;
  }
  return <RouteError />;
}

export function ElectionPage() {
  const { me } = useMe();
  const { savedAreaIds, weights, hasSaved, isLoading: savedAreasLoading } = useMyResearchAreas();
  const location = useLocation();
  const hydrated = useHydrated();
  // location.state survives reloads (the browser keeps it in history.state),
  // but the SSR pass always rendered this document with null state — so it
  // must read as null until hydration or the first client render diverges
  // from the server HTML. The nav bar and rail appear one paint later on a
  // reload; the sort/tab seeds below stay derived (not useState initializers)
  // so they engage when the state materializes.
  const navState = hydrated ? readElectionNavState(location.state) : null;
  // null = no explicit pick; viewers with saved areas default to "my
  // issues first" (their picks are the point of saving areas), everyone
  // else to the alphabetical payload order. A picked "my_issues" is
  // ignored while saved areas are empty — same resilience as the record
  // view on CandidatePage — and honored again once areas are re-saved.
  // Seeded from the nav state's rosterSort so a candidate round trip
  // restores the roster order the reader left (or switched to, via the
  // candidate rail) — the remount would otherwise reset it to the default.
  const [chosenSortOverride, setChosenSort] = useState<CandidateSort | null>(null);
  const chosenSort = chosenSortOverride ?? navState?.rosterSort ?? null;
  const effectiveChosenSort = chosenSort === "my_issues" && !hasSaved ? null : chosenSort;
  const candidateSort = effectiveChosenSort ?? (hasSaved ? "my_issues" : "alphabetical");
  // The pick carries the election it was made on: this component stays
  // mounted across param changes, and unlike the sort (a preference that
  // travels), a party filter is a per-race choice — carrying it into the
  // next election would silently hide candidates there. A pick from another
  // election reads as "all"; no effect needed, stale state is simply never
  // read.
  const [partyPick, setPartyPick] = useState<{ electionId: string; bucket: PartyBucket | "all" }>({
    electionId: "",
    bucket: "all",
  });

  const data = useLoaderData<typeof loader>();
  const competitiveness = competitivenessChip(data);
  // The ⓘ next to "Retention race": the one-line explanation is a tap
  // target, not a title tooltip (touch never sees tooltips). Component
  // state, so it closes again on a sibling walk to the next race.
  const [retentionInfoOpen, setRetentionInfoOpen] = useState(false);
  const retentionInfoRef = useRef<HTMLDivElement>(null);
  // Popover, not in-flow text: opening it must not push the page down. It
  // closes on Escape or a click anywhere outside the ⓘ and its bubble.
  useEffect(() => {
    if (!retentionInfoOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!retentionInfoRef.current?.contains(event.target as Node)) {
        setRetentionInfoOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRetentionInfoOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [retentionInfoOpen]);
  // Usage: which parts of the page reached the viewport, once per election
  // (this element stays mounted across rail walks, hence the key).
  const votePowerRef = useSectionExposure("vote_power", data.id);
  const officeRef = useSectionExposure("office", data.id);
  const measureSummaryRef = useSectionExposure("measure_summary", data.id);
  const measureYesNoRef = useSectionExposure("measure_yes_no", data.id);
  const candidatesRef = useSectionExposure("candidates", data.id);
  const resultsRef = useSectionExposure("results", data.id);
  const chosenPartyFilter = partyPick.electionId === data.id ? partyPick.bucket : "all";
  // Data-driven visibility: the filter renders only when the roster spans
  // >= 2 buckets — a nonpartisan or one-party roster gets no filter because
  // it could not change anything. is_partisan is deliberately not consulted
  // (it can be null, and a partisan race whose roster is all one bucket
  // still has nothing to filter). The count guard mirrors the sort's
  // resilience: a picked bucket is ignored — not cleared — while the filter
  // is hidden.
  const partyCounts: Record<PartyBucket, number> = { democratic: 0, republican: 0, other: 0 };
  for (const candidate of data.candidates) {
    partyCounts[partyBucket(candidate.party)] += 1;
  }
  const presentPartyOptions = PARTY_FILTER_OPTIONS.filter((option) => partyCounts[option.bucket] > 0);
  const showPartyFilter = presentPartyOptions.length >= 2;
  const partyFilter =
    showPartyFilter && chosenPartyFilter !== "all" && partyCounts[chosenPartyFilter] > 0
      ? chosenPartyFilter
      : "all";
  const partyFilteredCandidates =
    partyFilter === "all"
      ? data.candidates
      : data.candidates.filter((candidate) => partyBucket(candidate.party) === partyFilter);
  const measure = data.ballot_measure;
  // Election-level sources the measure section did NOT already show. A
  // measure election's sources are usually the same page the measure was
  // researched from (the SoS voter guide), so listing them again under
  // "Election sources" doubled the same "Source: sos.ca.gov" line — the
  // measure section shows source_urls (minus the official PDF, which has
  // its own link) and the official_measure_url link, so both are covered.
  const measureShownSources = new Set<string>(
    measure ? [...measure.source_urls, ...(measure.official_measure_url ? [measure.official_measure_url] : [])] : []
  );
  const electionOnlySources = [...new Set(data.sources)].filter((url) => !measureShownSources.has(url));
  // "My choice" controls on upcoming elections only (the backend rejects
  // choice writes to past ones). Signed-in viewers need a loaded choices
  // list first (no-flash rule, like FollowButton); guests pick straight
  // into the local ballot draft, so the same buttons render with the draft
  // as their choice source. me is undefined while the session loads —
  // render nothing then to avoid a flash of the wrong state.
  const { choiceByElectionId, canChoose } = useElectionChoices();
  const draft = useBallotDraft();
  const isGuest = me === null;
  const myChoice = isGuest
    ? draftChoicesByElectionId(draft).get(data.id)
    : choiceByElectionId?.get(data.id);
  // The rail's pick checks: same choice source as the ballot pages' cards
  // (account choices signed-in, local draft as guest), same decided rule as
  // the pick-progress counters — a choice row emptied of picks keeps no
  // check.
  const railChoices = isGuest ? draftChoicesByElectionId(draft) : choiceByElectionId;
  const isPickedContest = (electionId: string): boolean => isDecidedChoice(railChoices?.get(electionId));
  const choicesSettled = isGuest || (canChoose && choiceByElectionId !== undefined);
  const isUpcoming = data.election_date >= usLatestLocalDate();
  // District gate (docs/plans/pick-district-gate.md): controls only for a
  // race in the viewer's own districts. The decided-choice clause is the
  // safety valve — an existing pick always keeps its controls, so an
  // imperfect geocode can never lock someone out of changing it.
  const { districtIds, isLoading: districtsLoading } = useMyDistricts();
  const showChoiceControls =
    choicesSettled &&
    !districtsLoading &&
    isUpcoming &&
    (districtIds?.has(data.district.id) === true || isDecidedChoice(myChoice));
  // State 3 of the gate: districts unknown (settled) on an upcoming race —
  // a conversion nudge sits where the controls would. Districts known but
  // foreign renders neither (state 2: clean read-only page).
  const showAddressNudge =
    choicesSettled && !districtsLoading && isUpcoming && districtIds === undefined && !isDecidedChoice(myChoice);
  // Per-candidate result badges (Won / Advanced / Lost / …); the matching and
  // completeness guards — roster-matched winners only, losers only where the
  // outcome's own signal proves the race decided — live in
  // deriveCandidateResultBadges.
  const resultBadges = deriveCandidateResultBadges(data.results, data.candidates, data.seats_to_fill ?? null);
  // Same fork as StrandedPicksNotice: signed-in picks carry candidacy_status,
  // guest draft rows are always "active" so absence from the roster is the
  // only signal.
  const rosterCandidateIds = new Set(data.candidates.map((candidate) => candidate.candidate_id));
  const hasStrandedPicks = (myChoice?.picks ?? []).some((pick) =>
    isGuest ? !rosterCandidateIds.has(pick.candidate_id) : pick.candidacy_status === "withdrawn"
  );
  // Full set, uncapped — the list card previews these; the detail page is
  // where they all fit. Measure elections skip this row: the measure section
  // already shows the same areas with their for/against stance. The ??
  // fallbacks cover deploy skew — a not-yet-redeployed backend omits both
  // fields, which must degrade to "no section", not a crash.
  const office = data.office ?? null;
  const officeBullets = office ? officeSummaryLines(office.summary) : [];
  const researchAreas = data.research_areas ?? [];
  const orderedAreas = splitResearchAreasBySaved(researchAreas, weights);
  const showOfficeInfo = data.race_type !== "ballot_measure" && (office !== null || researchAreas.length > 0);
  // Judicial retention: an office race the ballot asks as Yes/No. The judge
  // card gets no pick button; the answer lives in the sticky Yes/No pair
  // below, and auto pick leaves it open (reason "retention").
  const retention = isRetentionRace(data);
  // The retention layout needs the one judge; any other roster shape (none
  // loaded yet, a stray second row) falls back to the plain candidate list.
  const retentionJudge = retention && data.candidates.length === 1 ? data.candidates[0]! : null;
  // The nav bar exists only for in-app arrivals: router state carries where
  // "back" goes and the ballot sequence. Deep links (shares, search
  // engines) have neither — they get no bar at all, by product choice.
  // The rail's race-type tabs: offered only when the snapshot types every
  // contest (an old history entry may not) and holds both types. The tab
  // starts where the list's tab was (navState.raceType) and lives in
  // component state — the route element stays mounted across sibling walks,
  // which is exactly the persistence the choice needs; remounts (back out
  // and in, candidate round trips) restore it from the nav state instead.
  const contests = navState?.contests;
  const railTabsAvailable =
    contests !== undefined &&
    contests.every((contest) => contest.race_type !== undefined) &&
    contests.some((contest) => contest.race_type === "office") &&
    contests.some((contest) => contest.race_type === "ballot_measure");
  // undefined = untouched (follow the nav state's tab), null = an explicit
  // "All" — the one control here whose cleared value is a real choice, so a
  // plain ?? fallback would undo it.
  const [railTabOverride, setRailTabState] = useState<BallotRaceType | null | undefined>(undefined);
  const railTabState = railTabOverride !== undefined ? railTabOverride : (navState?.raceType ?? null);
  const railTab = railTabsAvailable ? railTabState : null;
  // The rail's sort control: offered only for the sorts this snapshot can
  // honor faithfully (railSortsOffered — an old unkeyed snapshot offers
  // none), and withheld while the saved areas load so the default cannot
  // engage prematurely and visibly re-shuffle. Same persistence story as
  // the tab: component state across sibling walks, nav state across
  // remounts. No "As listed": the sort is always engaged, seeded by the
  // LIST's sort (the pages stamp railSort via railSortForBallotSort, which
  // sends the un-honorable district-size sorts to vote_power). A snapshot
  // that PREDATES the railSort stamp seeds from the back URL's own ?sort=
  // instead — defaulting it to vote_power would make rewriteBackPath
  // silently rewrite a sort=my_areas back link the reader never touched.
  // Only after both fall through does vote_power, the ballot's default,
  // apply (below).
  const offeredRailSorts = savedAreasLoading ? [] : railSortsOffered(contests ?? [], hasSaved);
  const [railSortOverride, setRailSortState] = useState<RailSortKey | null>(null);
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
  // Prev/next walk exactly what the rail shows: the engaged tab's slice, in
  // the engaged sort's order.
  const slicedContests =
    railTab !== null && contests !== undefined
      ? contests.filter((contest) => contest.race_type === railTab)
      : contests;
  const displayedContests =
    railSort !== null && slicedContests !== undefined
      ? sortRailEntries(slicedContests, railSort, weights)
      : slicedContests;
  const contestNeighbors = pagerNeighbors(displayedContests, data.id);
  // Desktop rail: gated on the FULL snapshot (>= 2 entries containing this
  // election), not the slice — switching the rail to the other tab hides
  // the current row from the slice but must not tear the rail down.
  const railContests = pagerNeighbors(contests, data.id) !== null ? (displayedContests ?? null) : null;
  // Two derived contexts, deliberately split:
  // - `forwarded` (sibling walks, the candidate chain's back hop) carries
  //   the rail's CURRENT tab and sort but the ORIGINAL back destination —
  //   the ?type=/?sort= rewrite is recomputed from it at render time on
  //   every page, so "All" (and an un-rewritten sort) can always restore
  //   the arrival URL. Baking a rewritten path into forwarded state would
  //   make a previously-engaged sort unremovable after a sibling walk.
  // - `backTo` (this page's rendered back links only) IS the rewrite:
  //   leaving the split view lands on the view the rail is showing. Only
  //   an EXPLICIT sort rewrites ?sort= — see explicitRailSort above.
  const railNav =
    navState === null
      ? null
      : (() => {
          if (!railTabsAvailable && offeredRailSorts.length === 0) {
            return { forwarded: navState, backTo: navState.backTo };
          }
          // Field removal only on this copy — the shared original must
          // never be mutated.
          const forwarded: ElectionNavState = { ...navState };
          if (railTab) {
            forwarded.raceType = railTab;
          } else {
            delete forwarded.raceType;
          }
          if (railSort) {
            forwarded.railSort = railSort;
          } else {
            delete forwarded.railSort;
          }
          return {
            forwarded,
            backTo: {
              ...navState.backTo,
              path: rewriteBackPath(
                navState.backTo.path,
                { available: railTabsAvailable, raceType: railTab },
                railSort
              ),
            },
          };
        })();
  // Computed once, before render: the roster links hand the candidate page
  // this exact displayed order (sort + party + records filters applied), so
  // the JSX and the state payload must come from the same array.
  const orderedCandidates = sortCandidatesByStance(partyFilteredCandidates, candidateSort, weights);
  const candidateNavState: CandidateNavState = {
    backTo: { path: `/elections/${data.id}`, label: data.official_ballot_title },
    // The election page's own incoming context rides along so the back hop
    // restores it (election → candidate → back keeps the ballot sequence,
    // including the rail tab and sort as switched). rosterSort rides on top:
    // the back hop remounts this page, and without it the roster's sort
    // resets to the default instead of the order the reader left. The
    // candidate page overrides it with its rail's current sort, so the two
    // stay one continuous control across the round trip.
    ...(railNav ? { backState: { ...railNav.forwarded, rosterSort: candidateSort } } : {}),
    electionId: data.id,
    candidates: orderedCandidates.map(({ candidate, stances }) => ({
      id: candidate.candidate_id,
      name: candidate.display_name,
      // The candidate rail's My-issues sort key: the already-aggregated
      // stance areas condensed to per-area record counts — all the
      // mirrored scoring reads.
      research_area_records: stances.map((stance) => ({
        research_area_id: stance.research_area_id,
        record_count: stance.for_count + stance.against_count,
      })),
    })),
    // The roster sort in force RIGHT NOW — the candidate rail starts on it,
    // so an explicit A–Z choice here survives opening a candidate instead
    // of being stomped by the rail's My-issues default. Same values by
    // construction: CandidateSort and CandidateRailSortKey are both
    // "alphabetical" | "my_issues".
    railSort: candidateSort,
  };

  // The nav bar at the top: prev | back | next, each slot captioned.
  // backToState: when the back destination is a candidate page, restore
  // its own context (the mirror of the roster links' backState). With the
  // rail on screen (lg+) the bar is redundant, so it drops to narrow
  // screens only; rail-less arrivals keep it at every width.
  const pagerBar = railNav ? (
    <DetailPager
      ariaLabel="Ballot navigation"
      prev={
        contestNeighbors?.prev
          ? { path: `/elections/${contestNeighbors.prev.id}`, label: contestNeighbors.prev.title }
          : null
      }
      next={
        contestNeighbors?.next
          ? { path: `/elections/${contestNeighbors.next.id}`, label: contestNeighbors.next.title }
          : null
      }
      backTo={railNav.backTo}
      backToState={railNav.forwarded.backState ?? railNav.forwarded.listState}
      siblingState={railNav.forwarded}
    />
  ) : null;

  return (
    // With rail context the page widens to a two-column grid on lg+ (rail |
    // detail); without it — deep links, stale snapshots — the markup is the
    // classic centered column at every width.
    <div
      className={
        railContests !== null
          ? "mx-auto max-w-3xl px-4 py-8 box:px-[11px] box:pt-[11px] box:pb-[29px] lg:grid lg:max-w-6xl lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-8"
          : "mx-auto max-w-3xl px-4 py-8 box:px-[11px] box:pt-[11px] box:pb-[29px]"
      }
    >
      {railContests !== null && railNav !== null ? (
        <DetailRail
          ariaLabel="Ballot"
          entries={railContests.map((contest) => ({
            id: contest.id,
            label: contest.title,
            path: `/elections/${contest.id}`,
            picked: isPickedContest(contest.id),
          }))}
          currentId={data.id}
          backTo={railNav.backTo}
          backToState={railNav.forwarded.backState ?? railNav.forwarded.listState}
          siblingState={railNav.forwarded}
          headerSlot={
            // The list label renders even when no control is offerable (an
            // old snapshot): naming WHAT the rows are never depends on the
            // sort/tab keys. Mirrors the candidate rail's "Candidates:".
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink">Elections:</p>
              <div className="flex flex-col gap-2">
                {railTabsAvailable ? (
                  <RaceTypeTabs
                    raceType={railTab}
                    onChange={(next) => {
                      track("detail_control", { control: "rail_tab", value: next ?? "all" });
                      setRailTabState(next);
                    }}
                    compact
                  />
                ) : null}
                {offeredRailSorts.length > 0 ? (
                  <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                    Sort
                    <select
                      value={railSort ?? ""}
                      onChange={(event) => {
                        track("detail_control", { control: "rail_sort", value: event.target.value });
                        setRailSortState(event.target.value as RailSortKey);
                      }}
                      className="min-w-0 flex-1 rounded-md border border-line bg-white px-1.5 py-1 text-xs text-ink focus:border-ink focus:outline-none"
                    >
                      {RAIL_SORTS.filter((option) => offeredRailSorts.includes(option.value)).map(
                        (option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        )
                      )}
                    </select>
                  </label>
                ) : null}
              </div>
            </div>
          }
        />
      ) : null}
      {/* min-w-0: the grid column must be allowed to shrink or long titles
          blow the layout; lg:max-w-3xl keeps the reading measure of the
          classic column even though the grid column is wider. In rail mode a
          before pseudo-element draws the rail/detail divider a rem into the
          gutter (centered in gap-8) — a pseudo, not border-l + pl, because
          box-sizing is border-box and padding on this max-w-3xl div would
          eat 17px of reading measure. On the detail side (not the rail) so
          the rule spans the full content height; conditional so deep links
          never grow a stray rule. */}
      <div
        className={
          railContests !== null
            ? "min-w-0 lg:relative lg:max-w-3xl lg:before:absolute lg:before:inset-y-0 lg:before:-left-4 lg:before:w-px lg:before:bg-line lg:before:content-['']"
            : "min-w-0 lg:max-w-3xl"
        }
      >
        {railContests !== null ? <div className="lg:hidden">{pagerBar}</div> : pagerBar}
        <JsonLdScript
          data={{
            "@type": "Event",
            name: data.official_ballot_title,
            startDate: data.election_date,
            location: { "@type": "AdministrativeArea", name: formatDistrictName(data.district.name) },
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-title font-bold">{data.official_ballot_title}</h1>
          <ShareButton
            path={`/elections/${data.id}`}
            shareText={`${data.official_ballot_title} — ${formatElectionDate(data.election_date)}`}
          />
        </div>
        {/* District as a quiet subtitle, name only (no district type): ballot
            titles are often generic ("Governor", "Mayor"), and a direct-link
            visitor needs to see WHERE the race is — the list card shows the
            same line for the same reason. The sub-district caveat below also
            refers to "the district above". */}
        <p className="mt-1 text-sm text-ink-soft">{formatDistrictName(data.district.name)}</p>
        {/* Header strip: label-over-value columns split by a hairline — the
            vote-power verdict first, then one date column whose value carries
            the stage ("General election") so "General" can't read as a
            mystery word. Fixed grid tracks, not content-hugging flex, so the
            divider sits at the same fraction of the width however short the
            verdict is. Only the verdict is bold. */}
        <div
          ref={votePowerRef}
          className={
            data.vote_power.label !== "unknown"
              ? "mt-3 grid grid-cols-[minmax(9rem,1fr)_2fr] gap-x-6"
              : "mt-3"
          }
        >
          {data.vote_power.label !== "unknown" ? (
            // relative: the retention popover anchors to this column's left
            // edge (under the label), not to the ⓘ, which can sit after a
            // wrapped word and leave the bubble hanging mid-line.
            <div ref={retentionInfoRef} className="relative">
              <p className="text-sm text-ink">My vote power</p>
              <p className={`mt-1 flex items-center gap-1.5 text-lg font-semibold ${votePowerBadgeClass(data.vote_power.label)}`}>
                {formatVotePowerLabel(data.vote_power.label)}
                {/* "Retention race" alone means nothing to a first-time
                    reader; the ⓘ reveals the backend's one-line explanation
                    below the grid (the value column is too narrow for it). */}
                {data.vote_power.label === "retention" && data.vote_power.explanation ? (
                  <button
                    type="button"
                    aria-expanded={retentionInfoOpen}
                    aria-label="What is a retention race?"
                    onClick={() => setRetentionInfoOpen((open) => !open)}
                    className="text-ink-soft hover:text-ink"
                  >
                    <span
                      aria-hidden
                      className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-serif italic"
                    >
                      i
                    </span>
                  </button>
                ) : null}
              </p>
              {retentionInfoOpen && data.vote_power.label === "retention" && data.vote_power.explanation ? (
                // Absolutely positioned bubble under the column: floats over
                // the page instead of reflowing it, flush with the label's
                // left edge. Capped to the viewport so a phone never clips it.
                <div
                  role="note"
                  className="absolute left-0 top-full z-20 mt-1 flex w-72 max-w-[calc(100vw-2rem)] items-start gap-2 rounded-lg border border-line bg-surface p-3 text-sm font-normal text-ink shadow-lg"
                >
                  <span className="min-w-0 flex-1">{data.vote_power.explanation.how}</span>
                  {/* A visible way out, not only Escape / click-away — touch
                      users have no Escape key and may not guess that tapping
                      elsewhere closes it. */}
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setRetentionInfoOpen(false)}
                    className="-mr-1 -mt-1 rounded p-1 leading-none text-ink-soft hover:text-ink"
                  >
                    <span aria-hidden>×</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className={data.vote_power.label !== "unknown" ? "border-l border-line pl-6" : undefined}>
            <p className="text-sm text-ink">Election date</p>
            <p className="mt-1 text-lg text-ink">
              {formatElectionDate(data.election_date)}
              {/* formatOutcome doubles as a stage prettifier: general → General */}
              {data.election_stage ? <> · {formatOutcome(data.election_stage)} election</> : null}
              {data.seats_to_fill != null && data.seats_to_fill > 1 ? <> · {data.seats_to_fill} seats</> : null}
            </p>
          </div>
        </div>
        {/* The detail page has room for the whole caveat, where the ballot card
            only has room to flag it. Same rule as ElectionCard: name the seat's
            area, say plainly that we cannot match an address to it, and never
            imply the race was filtered in or out. */}
        {data.sub_district_seat ? (
          <p className="mt-2 rounded-lg border border-line bg-surface/50 px-3 py-2 text-sm text-ink-soft">
            This seat represents <span className="font-medium text-ink">{data.sub_district_seat}</span>, not the whole
            district above. We can&rsquo;t match an address to an area this small, so this race may not be on your ballot.
          </p>
        ) : null}
        {competitiveness ? (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-surface px-2 py-0.5 text-ink-soft" title={competitiveness.description}>
              {competitiveness.label}
            </span>
          </div>
        ) : null}
        {/* No "how" panel on a retention race: nothing was graded, and the
            header value already names the race kind. */}
        {data.vote_power.label !== "unknown" && data.vote_power.label !== "retention" && data.vote_power.explanation ? (
          <details
            className="mt-2 text-sm"
            onToggle={(event) =>
              track("detail_control", { control: "vote_power_how", value: event.currentTarget.open ? "open" : "close" })
            }
          >
            <summary className="cursor-pointer text-xs font-medium text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink">
              How do we calculate my vote power?
            </summary>
            <div className="mt-2 rounded-xl border border-line bg-surface p-4 box:p-[11px]">
              {/* The how copy arrives with blank lines between its points;
                  preserve them so each axis reads as its own paragraph. */}
              <p className="whitespace-pre-line text-ink">{data.vote_power.explanation.how}</p>
              {/* One row per graded measure, formula-style: title, grade, this
                  election's actual numbers, then a one-line why. */}
              <div className="mt-3 space-y-2">
                {data.vote_power.explanation.parts.map((part) => (
                  <div key={part.title} className="rounded-lg bg-surface p-3">
                    <p className="text-ink">
                      <span className="font-semibold">{part.title}:</span>{" "}
                      <span className="font-medium">{part.grade}</span>
                      {part.stat ? <span className="text-ink-soft"> · {part.stat}</span> : null}
                    </p>
                    <p className="mt-1 text-xs text-ink-soft">{part.detail}</p>
                    {part.formula ? (
                      // Second disclosure layer: the plain-language detail is
                      // for everyone; the exact scoring formula only unfolds
                      // for readers who ask for it.
                      <details className="mt-1">
                        {/* Part name in the label: two of these can render
                            side by side, and identical accessible names are
                            indistinguishable to screen-reader and
                            voice-control users. */}
                        <summary className="cursor-pointer text-[11px] text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink">
                          Show the {part.title.toLowerCase()} math
                        </summary>
                        <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-ink-soft">
                          {part.formula}
                        </p>
                      </details>
                    ) : null}
                  </div>
                ))}
              </div>
              <p className="mt-3 font-medium text-ink">{data.vote_power.explanation.result}</p>
              {data.vote_power.explanation.caveat ? (
                <p className="mt-2 text-xs text-ink-soft">{data.vote_power.explanation.caveat}</p>
              ) : null}
            </div>
          </details>
        ) : null}

        {showOfficeInfo ? (
          // Duties first, then which issues the election touches.
          <section className="mt-6 box:mt-[18px] rounded-xl border border-line bg-surface p-4 box:p-[11px]">
            <h2 ref={officeRef} className="text-heading font-semibold">About this office</h2>
            {officeBullets.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-ink">
                {officeBullets.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : null}
            {researchAreas.length > 0 ? (
              // Same one-list, comma-separated presentation as the ballot
              // cards: saved matches lead in semibold, with a screen-reader-
              // only "(saved)" cue keeping the distinction audible. Capped
              // like the cards, but here the overflow expands in place — this
              // page is where the full set lives.
              <CappedInlineList
                // Keyed by election: the route element stays mounted across
                // sibling walks, and the list's expanded state must not
                // carry from one race to the next.
                key={data.id}
                label="Affects:"
                noun="issues"
                className="mt-3 text-sm"
                items={[...orderedAreas.saved, ...orderedAreas.others].map((area) => ({
                  key: area.id,
                  node: (
                    <span className={orderedAreas.saved.includes(area) ? SAVED_AREA_TEXT_CLASS : AREA_TEXT_CLASS}>
                      {area.name}
                      {orderedAreas.saved.includes(area) ? <span className="sr-only"> (saved)</span> : null}
                    </span>
                  ),
                }))}
              />
            ) : null}
          </section>
        ) : null}

        {measure ? (
          <section className="mt-6 box:mt-[18px] rounded-xl border border-line bg-surface p-4 box:p-[11px]">
            {/* nudge-deep green (user decision 2026-09-11) — not party blue
                on a nonpartisan measure. */}
            <h2 ref={measureSummaryRef} className="text-heading font-semibold text-nudge-deep">Ballot Measure</h2>
            {measure.research_area_tags.length > 0 ? (
              // Comma-separated colored text, not boxed chips (boxes read as
              // buttons). Tags group by stance under a leading verb
              // ("Supports: X, Y" / "Opposes: Z") so the direction reads once
              // per group instead of as a "(for)" suffix on every name. Color
              // matches the YES/NO boxes below (green = supports, red =
              // opposes), but the verb carries the meaning — color alone would
              // be invisible to color-blind readers. Stanceless tags keep the
              // ballot cards' "Affects:" label and saved/muted styling, and
              // saved areas keep the sr-only cue used elsewhere. text-sm, not
              // the cards' text-xs: under the green heading the tags need
              // size to read as their own line, not a caption on it.
              <div className="mt-2 space-y-1 text-sm">
                {(
                  [
                    ["Supports:", "for", "font-medium text-green-900"],
                    ["Opposes:", "against", "font-medium text-red-900"],
                  ] as const
                ).map(([label, stance, tagClass]) => {
                  const tags = measure.research_area_tags.filter((tag) => tag.stance === stance);
                  if (tags.length === 0) {
                    return null;
                  }
                  return (
                    <p key={stance}>
                      <span className="font-medium text-ink-soft">{label}</span>{" "}
                      {tags.map((tag, index, all) => (
                        <Fragment key={tag.research_area_id}>
                          <span className={savedAreaIds.has(tag.research_area_id) ? SAVED_AREA_TEXT_CLASS : tagClass}>
                            {tag.name}
                            {savedAreaIds.has(tag.research_area_id) ? <span className="sr-only"> (saved)</span> : null}
                          </span>
                          {index < all.length - 1 ? ", " : null}
                        </Fragment>
                      ))}
                    </p>
                  );
                })}
                {measure.research_area_tags.some((tag) => tag.stance !== "for" && tag.stance !== "against") ? (
                  <p>
                    <span className="font-medium text-ink-soft">Affects:</span>{" "}
                    {measure.research_area_tags
                      .filter((tag) => tag.stance !== "for" && tag.stance !== "against")
                      .map((tag, index, all) => (
                        <Fragment key={tag.research_area_id}>
                          <span
                            className={savedAreaIds.has(tag.research_area_id) ? SAVED_AREA_TEXT_CLASS : "text-ink-soft"}
                          >
                            {tag.name}
                            {savedAreaIds.has(tag.research_area_id) ? <span className="sr-only"> (saved)</span> : null}
                          </span>
                          {index < all.length - 1 ? ", " : null}
                        </Fragment>
                      ))}
                  </p>
                ) : null}
              </div>
            ) : null}
            {measure.summary ? <p className="mt-2 text-body text-ink">{measure.summary}</p> : null}
            {measure.official_measure_url ? (
              <p className="mt-2 text-sm">
                <a
                  href={measure.official_measure_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() =>
                    track("official_source_click", {
                      kind: "measure_official",
                      ...sourceLinkProps(measure.official_measure_url ?? ""),
                    })
                  }
                  className="font-medium text-ink underline underline-offset-2 hover:text-ink-soft"
                >
                  {isGovernmentUrl(measure.official_measure_url)
                    ? `Read the official ballot measure${isPdfUrl(measure.official_measure_url) ? " (PDF)" : ""}`
                    : "More about this measure"}
                </a>
              </p>
            ) : null}
            <div ref={measureYesNoRef} className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded border border-green-200 bg-green-50 p-3">
                <h3 className="text-subheading font-semibold text-green-900">A YES vote means</h3>
                <p className="mt-1 text-sm text-green-900">{measure.what_yes_means}</p>
              </div>
              <div className="rounded border border-red-200 bg-red-50 p-3">
                <h3 className="text-subheading font-semibold text-red-900">A NO vote means</h3>
                <p className="mt-1 text-sm text-red-900">{measure.what_no_means}</p>
              </div>
            </div>
            {/* Auto-pick sits here, not on the sticky card's row: right after
                reading what Yes and No mean is where "answer from my issues"
                helps, and three buttons on the card's one row were cramped.
                Compact so the Yes/No pair stays the loud control; same gate
                as the card, and same key rationale (the route element
                survives rail walks). */}
            {data.race_type === "ballot_measure" && showChoiceControls ? (
              <div className="mt-3">
                <AutoPickControl key={data.id} electionId={data.id} seatsToFill={null} compact measure />
              </div>
            ) : null}
            {/* No inline Yes/No here: the sticky card at the page's end is
                the ONE pick control (same single-control rule as the
                candidate page) — and being pinned, it stays on screen while
                these explainer boxes are read. */}
            {/* Right after what Yes and No mean: who is paying to push each
                answer. A measure's title can flatter it; its donors cannot. */}
            {measure.funding ? <MeasureFundingSection funding={measure.funding} homeState={data.district.state} /> : null}
            {measure.results.length > 0 ? (
              <div className="mt-3">
                <h3 className="text-subheading font-semibold">Results</h3>
                {hasCertifiedRow(measure.results) ? null : (
                  <p className="mt-1 text-xs text-ink-soft">
                    Unofficial until certified by the relevant election authority.
                  </p>
                )}
                <ul className="mt-2 space-y-3">
                  {measure.results.map((result) => (
                    <li key={result.id} className="text-sm">
                      <p className="text-ink">
                        <span className="font-medium">{formatOutcome(result.outcome)}</span>
                        {result.result_status ? (
                          <span className="text-ink-soft"> · {formatOutcome(result.result_status)}</span>
                        ) : null}
                      </p>
                      <SourceLine
                        url={result.source_url}
                        researchedDate={result.retrieved_at.slice(0, 10)}
                        kind="result_source"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : measure.result ? (
              // Legacy canonical outcome kept as a fallback for measures whose
              // result predates the per-pass results rows.
              <p className="mt-3 text-sm font-medium">
                Result: <span className={measure.result === "passed" ? "text-green-700" : "text-red-700"}>{measure.result}</span>
              </p>
            ) : null}
            <SourceFootnote
              urls={measure.source_urls.filter((url) => url !== measure.official_measure_url)}
              className="mt-1"
            />
            <div className="mt-3">
              <ReportContentButton
                entityType="ballot_measure"
                entityId={measure.id}
                contextLabel="ballot measure"
                reporterEmail={me?.email}
              />
            </div>
          </section>
        ) : null}

        {/* hasStrandedPicks keeps this section alive when EVERY candidacy
            withdrew: the payload then lists no candidates, but the stranded
            notice below is the page's only removal control. */}
        {retentionJudge ? (
          // One question about one person: the judge inline, no roster.
          <>
            <RetentionJudgeSection
              key={data.id}
              electionId={data.id}
              candidate={retentionJudge}
              showAutoPick={showChoiceControls}
              reporterEmail={me?.email}
              headingRef={candidatesRef}
            />
            {showAddressNudge ? (
              <div className="mt-3">
                <AddressNudge />
              </div>
            ) : null}
          </>
        ) : data.candidates.length > 0 || (showChoiceControls && hasStrandedPicks) ? (
          <section className="mt-6 box:mt-[18px]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 ref={candidatesRef} className="text-heading font-semibold">Candidates</h2>
              {showChoiceControls && data.seats_to_fill != null && data.seats_to_fill > 1 ? (
                <span className="text-xs text-ink-soft">
                  This election fills {data.seats_to_fill} seats — pick up to {data.seats_to_fill} candidates.
                </span>
              ) : null}
              {hasSaved && data.candidates.length > 1 ? (
                <label className="flex items-center gap-2 text-sm text-ink-soft">
                  Sort by
                  <select
                    value={candidateSort}
                    onChange={(event) => {
                      track("detail_control", { control: "roster_sort", value: event.target.value });
                      setChosenSort(event.target.value as CandidateSort);
                    }}
                    className="rounded-md border border-line bg-white px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
                  >
                    <option value="my_issues">My issues first</option>
                    <option value="alphabetical">Alphabetical</option>
                  </select>
                </label>
              ) : null}
            </div>
            {/* Stranded picks have no candidate card below (ballotLookup
                filters withdrawn candidacies out), yet still count toward
                the seat cap — surface them here, with their removal
                control. */}
            {showChoiceControls ? (
              <StrandedPicksNotice
                electionId={data.id}
                choice={myChoice}
                raceTitle={data.official_ballot_title}
                electionDate={data.election_date}
                seatsToFill={data.seats_to_fill ?? null}
                rosterCandidateIds={rosterCandidateIds}
              />
            ) : null}
            {/* Districts unknown: the nudge takes the controls' slot at the
                top of the candidate list. */}
            {showAddressNudge && data.race_type !== "ballot_measure" ? (
              <div className="mt-3">
                <AddressNudge />
              </div>
            ) : null}
            {showPartyFilter ? (
              <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter candidates by party">
                {[{ bucket: "all" as const, label: "All" }, ...presentPartyOptions].map((option) => (
                  <button
                    key={option.bucket}
                    type="button"
                    onClick={() => {
                      track("detail_control", { control: "party_filter", value: option.bucket });
                      setPartyPick({ electionId: data.id, bucket: option.bucket });
                    }}
                    aria-pressed={partyFilter === option.bucket}
                    className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
                      partyFilter === option.bucket
                        ? "border-ink bg-ink text-white"
                        : "border-line bg-white text-ink hover:bg-surface"
                    }`}
                  >
                    {option.bucket === "all"
                      ? `All (${data.candidates.length})`
                      : `${option.label} (${partyCounts[option.bucket]})`}
                  </button>
                ))}
              </div>
            ) : null}
            {/* Race-level "Pick by my issues": one engine run for this election
                (mode replace — a re-run refreshes the pick), with its "Why
                this pick" panel below the button. Guests get a sign-in
                prompt inside the control, matching the per-candidate
                buttons' visibility gate. key: this route element stays
                mounted across sibling rail walks, so without a remount the
                previous election's panel (or an in-flight run's result)
                would surface under the next election. length: in the
                stranded-only state (section open, every candidacy
                withdrawn) the engine has nobody to pick — the button could
                only answer "No pick". Placed under the party chips so the
                narrowing controls read first and the one action last; the
                former "Has a record on my issues" chip was dropped — this
                button already answers "who matches my issues". The engine
                ignores the party filter (whole roster), so a pick clears
                it: otherwise "Democrats" + auto-pick could choose a
                Republican whose card stays hidden. */}
            {data.candidates.length > 0 && showChoiceControls && data.race_type !== "ballot_measure" && !retention ? (
              <div className="mt-3">
                <AutoPickControl
                  key={data.id}
                  electionId={data.id}
                  seatsToFill={data.seats_to_fill ?? null}
                  onPicked={() => setPartyPick({ electionId: data.id, bucket: "all" })}
                />
              </div>
            ) : null}
            <div className="mt-3 space-y-3">
              {orderedCandidates.map(({ candidate, stances }, index) => (
                // Whole-card click target via a stretched link: the name
                // Link's ::after overlays the wrapper. Campaign finance is
                // deliberately NOT rendered here — it lives on the candidate
                // profile page only. Following also happens there.
                <div
                  key={candidate.candidate_id}
                  // Faint tint at rest; hover matches the ballot cards — brand
                  // border plus the name taking the link color (group-hover).
                  className="group relative rounded-xl border border-line bg-surface/50 shadow-sm transition hover:border-rausch hover:shadow-md"
                >
                  <div className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {/* The badge sits beside the heading, not inside it (an
                          in-heading badge fuses into the accessible name —
                          "Jordan VoterAdvanced"), and the wrapper is a div
                          because a heading is flow content, invalid in a span. */}
                      <div className="flex items-center gap-2">
                        <h3 className="text-subheading font-semibold">
                          <Link
                            to={`/candidates/${candidate.candidate_id}`}
                            state={candidateNavState}
                            onClick={() =>
                              track("candidate_open", {
                                position_bucket: positionBucket(index + 1),
                                has_summary: Boolean(candidate.summary),
                                has_stances: stances.length > 0,
                                incumbent: Boolean(candidate.is_incumbent),
                              })
                            }
                            // Brand red at rest, not only on hover — black
                            // names read as plain headings, not links.
                            // rausch-deep, not -dark: AA contrast on the
                            // tinted card bg — see ElectionCard's title.
                            className="text-rausch-deep transition after:absolute after:inset-0 group-hover:text-rausch-deep"
                          >
                            {candidate.display_name}
                          </Link>
                        </h3>
                        {(() => {
                          const badge = resultBadges.get(candidate.candidate_id);
                          if (!badge) {
                            return null;
                          }
                          return (
                            <span
                              className={
                                badge.kind === "winner"
                                  ? "rounded border border-green-700 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-900"
                                  : "rounded border border-red-700 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-900"
                              }
                            >
                              {badge.label}
                            </span>
                          );
                        })()}
                      </div>
                      {/* Withdrawn candidacies never reach this payload
                          (ballotLookup filters them), but the writer also
                          rejects withdrawn/lost — don't render a button whose
                          only outcome is an error. */}
                      {showChoiceControls &&
                      !retention &&
                      candidate.status !== "withdrawn" &&
                      candidate.status !== "lost" ? (
                        // z-10 lifts the button above the card's stretched
                        // link so clicking it doesn't navigate.
                        <span className="relative z-10">
                          <CandidatePickButton
                            electionId={data.id}
                            candidateId={candidate.candidate_id}
                            candidateName={candidate.display_name}
                            raceTitle={data.official_ballot_title}
                            electionDate={data.election_date}
                            choice={myChoice}
                            seatsToFill={data.seats_to_fill ?? null}
                            size="sm"
                            surface="election_inline"
                          />
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm text-ink-soft">
                      <span className={partyColorClass(candidate.party) || undefined}>
                        {candidate.party}
                      </span>
                      {candidate.is_incumbent ? " · Incumbent" : ""}
                      {candidate.status !== "active" && candidate.status !== "declared"
                        ? ` · ${candidate.status}`
                        : ""}
                    </p>
                    {candidate.summary ? (
                      <p className="mt-2 line-clamp-3 text-sm text-ink">{candidate.summary}</p>
                    ) : null}
                    {stances.length > 0 ? (
                      // Comma-separated colored text, not boxed chips (boxes
                      // read as buttons). Stance direction colors the name:
                      // all-for green, all-against red, mixed amber —
                      // replacing the saved-area green, which said nothing
                      // about the candidate (saved areas keep their sr-only
                      // cue). Counts compress to +N/-N; screen readers get the
                      // spelled-out counts instead, since "-2" can be read as
                      // just "2". Every stance has for_count + against_count
                      // >= 1 — aggregateRecordAreaStances drops
                      // neutral/untagged records — so "against == 0" can only
                      // mean all-for.
                      // Without a label the row was a bare "Housing
                      // Affordability +1" — an issue name and a number with
                      // nothing saying what was counted. "Records:" names the
                      // source, matching the "Affects:" row. Capped at three:
                      // the viewer's saved issues first (their own rank, any
                      // direction — an against-record on a top issue is the
                      // point), then the candidate's busiest areas; the rest
                      // expand in place.
                      <CappedInlineList
                        // Election in the key too: the card is keyed by
                        // candidate alone, so one person running in two
                        // sibling races would otherwise keep the list open.
                        key={`${data.id}:${candidate.candidate_id}`}
                        label="Records:"
                        noun="issues"
                        className="mt-2 text-sm"
                        items={orderStancesForRow(stances, weights).map((stance) => ({
                          key: stance.research_area_id,
                          node: (
                            <span
                              // Saved issues take the shared purple; the +N/-N
                              // counts (and the sr-only "for/against") still
                              // carry the direction the color otherwise would.
                              className={
                                savedAreaIds.has(stance.research_area_id)
                                  ? SAVED_AREA_TEXT_CLASS
                                  : stance.against_count === 0
                                    ? "font-medium text-green-900"
                                    : stance.for_count === 0
                                      ? "font-medium text-red-900"
                                      : "font-medium text-amber-900"
                              }
                            >
                              {stance.name}{" "}
                              <span aria-hidden="true">
                                {[
                                  stance.for_count > 0 ? `+${stance.for_count}` : null,
                                  stance.against_count > 0 ? `-${stance.against_count}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                              </span>
                              <span className="sr-only">
                                {[
                                  stance.for_count > 0 ? `${stance.for_count} for` : null,
                                  stance.against_count > 0 ? `${stance.against_count} against` : null,
                                ]
                                  .filter(Boolean)
                                  .join(", ")}
                              </span>
                              {savedAreaIds.has(stance.research_area_id) ? (
                                <span className="sr-only"> (saved)</span>
                              ) : null}
                            </span>
                          ),
                        }))}
                      />
                    ) : null}
                    {/* Visible affordance: at rest nothing said the card was
                        a link (hover styling only). Underlined navy, not
                        brand red — the red name is the title, a second red
                        line was too much red next to the GOP party label;
                        not ink-mid either, which vanished into the summary
                        text. Navy is the palette's inert dark blue (dusky,
                        unlike the saturated dem-blue label). aria-hidden —
                        the name Link already carries the target, a second
                        link would double it for screen readers. */}
                    <span
                      aria-hidden="true"
                      className="mt-2 block text-sm font-medium text-navy underline underline-offset-2 transition group-hover:text-rausch-deep"
                    >
                      See full profile →
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : data.candidate_roster_status ? (
          // Empty office roster: say WHY instead of hiding the section (roster
          // awaiting certification, profiles being prepared, or unavailable).
          <section className="mt-6 box:mt-[18px]">
            <h2 className="text-heading font-semibold">Candidates</h2>
            <p className="mt-3 rounded-xl border border-line bg-surface p-4 box:p-[11px] text-sm text-ink-soft">
              {formatRosterStatus(data.candidate_roster_status).long}
            </p>
          </section>
        ) : null}

        {data.results.length > 0 ? (
          <section className="mt-6 box:mt-[18px] rounded-xl border border-line bg-surface p-4 box:p-[11px]">
            <h2 ref={resultsRef} className="text-heading font-semibold">Results</h2>
            {hasCertifiedRow(data.results) ? null : (
              <p className="mt-1 text-xs text-ink-soft">
                Unofficial until certified by the relevant election authority.
              </p>
            )}
            <ul className="mt-2 space-y-3">
              {data.results.map((result) => (
                <li key={result.id} className="text-sm">
                  <p className="text-ink">
                    <span className="font-medium">{formatOutcome(result.outcome)}</span>
                    {result.result_status ? (
                      <span className="text-ink-soft"> · {formatOutcome(result.result_status)}</span>
                    ) : null}
                  </p>
                  {result.winners.length > 0 ? (
                    <p className="text-ink-soft">
                      Winner{result.winners.length === 1 ? "" : "s"}:{" "}
                      {result.winners
                        .map((winner) =>
                          winner.party ? `${winner.candidate_name ?? "Unknown"} (${winner.party})` : winner.candidate_name ?? "Unknown"
                        )
                        .join(", ")}
                    </p>
                  ) : null}
                  <SourceLine
                    url={result.source_url}
                    researchedDate={result.retrieved_at.slice(0, 10)}
                    kind="result_source"
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* One footnote line, no heading: the research trail is usually two
            pages of one site (index + detail), and a heading plus a line per
            URL read as the same source printed twice. */}
        <SourceFootnote urls={electionOnlySources} className="mt-6 box:mt-[18px]" />

        {/* Last on purpose: reporting is a reaction to reading the page, not a
            headline action worth space above the candidates. Skipped when the
            measure section already rendered its own report button: on a
            measure page the measure IS the page, and a second identical
            "Report an issue" (with the same source line above it) read as a
            duplicate. */}
        {measure === null ? (
          <div className="mt-6 box:mt-[18px]">
            <ReportContentButton
              entityType="election"
              entityId={data.id}
              contextLabel="election"
              reporterEmail={me?.email}
            />
          </div>
        ) : null}

        {/* measure !== null too, not just the race type: upcoming measure
            elections can exist before their ballot-measure row (details
            still TBD) — the old inline buttons lived inside the measure
            section and so never rendered there, and a Yes/No pair with no
            explanation of what either vote means would be worse. */}
        {((measure !== null && data.race_type === "ballot_measure") || retention) && showChoiceControls ? (
          // The measure page's ONE pick control, mirroring the candidate
          // page's sticky card: a measure has no deeper detail page — the
          // decision happens here — so the Yes/No pair pins to the viewport
          // bottom (sticky, inside the detail column; data-sticky-pick-cta
          // lifts the chatbot launcher clear of it). No caption naming the
          // measure: this page's h1 IS the measure — one subject, zero
          // ambiguity — and the "My pick:" prefix already says the buttons
          // record a plan. A retention race shares the card; its one caption
          // says what the sides mean, because the h1 names a judge, not a
          // question a voter can answer without knowing the stakes.
          <div
            data-sticky-pick-cta=""
            className="sticky bottom-3 z-30 mt-6 box:mt-[18px] rounded-xl border border-line bg-surface p-3 shadow-lg"
          >
            {retention ? (
              <p className="mb-2 text-sm text-ink-soft">Yes keeps this judge in office. No removes them.</p>
            ) : null}
            <MeasureChoiceButtons
              electionId={data.id}
              raceTitle={data.official_ballot_title}
              electionDate={data.election_date}
              choice={myChoice}
              raceType={retention ? "office" : "ballot_measure"}
              fullWidth
            />
            {/* Back link only for election-list arrivals — a My-Picks
                arrival would get a back link and a draft link to the same
                place (see PostPickActions). */}
            {myChoice?.measure_position != null ? (
              <PostPickActions
                back={
                  railNav !== null &&
                  (railNav.backTo.path.startsWith("/ballot") || railNav.backTo.path.startsWith("/me/ballot"))
                    ? { path: railNav.backTo.path, state: railNav.forwarded.backState ?? railNav.forwarded.listState, label: "elections" }
                    : null
                }
              />
            ) : null}
          </div>
        ) : null}

        {/* Districts unknown on a measure: the nudge takes the sticky card's
            slot (plain, not pinned — a passive sentence doesn't earn
            viewport pinning). Same measure !== null guard as the card: a
            TBD measure renders no pick UI of any kind. */}
        {measure !== null && data.race_type === "ballot_measure" && showAddressNudge ? (
          <div className="mt-6 box:mt-[18px]">
            <AddressNudge />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default ElectionPage;

// The blanket pre-certification notice contradicts a row already labeled
// "Certified"; show it only while everything listed is pre-certification.
function hasCertifiedRow(results: readonly { result_status: string }[]): boolean {
  return results.some((result) => result.result_status === "certified");
}

function isPdfUrl(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}

// "Official" is a claim, not a style: the pipeline intends
// official_measure_url to be an official full-text page, but real rows point
// at Wikipedia/Ballotpedia. Only .gov links get the official label; anything
// else keeps neutral wording. .us is deliberately excluded — it is an open
// registry (individuals and businesses register ordinary .us domains), so it
// is not evidence of government hosting.
function isGovernmentUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".gov");
  } catch {
    return false;
  }
}

// Client-side "my issues first" candidate ordering: weighted unique matched
// areas dominate, matching record volume breaks ties, and candidates that
// tie completely (including all zero-scores) keep the payload's alphabetical
// order — the sort is stable over the original sequence. Relevance, not
// agreement: against-only records on a saved issue still count as a track
// record on it (scoreStanceRelevance), matching the direction-neutral label.
/**
 * Row order for a candidate's record stances: the viewer's saved issues
 * first by their own rank, then everything else by record volume, slug as
 * the tiebreak. Direction never affects placement — a top saved issue shows
 * whether the candidate is for or against it.
 */
function orderStancesForRow(
  stances: ReturnType<typeof aggregateRecordAreaStances>,
  weights: ReturnType<typeof useMyResearchAreas>["weights"]
): ReturnType<typeof aggregateRecordAreaStances> {
  return [...stances].sort(
    (a, b) =>
      (weights.get(a.research_area_id)?.rank ?? Number.POSITIVE_INFINITY) -
        (weights.get(b.research_area_id)?.rank ?? Number.POSITIVE_INFINITY) ||
      b.for_count + b.against_count - (a.for_count + a.against_count) ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  );
}

function sortCandidatesByStance(
  candidates: ElectionDetail["candidates"],
  sort: CandidateSort,
  weights: ReturnType<typeof useMyResearchAreas>["weights"]
): Array<{ candidate: ElectionDetail["candidates"][number]; stances: ReturnType<typeof aggregateRecordAreaStances> }> {
  const entries = candidates.map((candidate) => ({
    candidate,
    stances: aggregateRecordAreaStances(candidate.records),
  }));
  if (sort === "alphabetical") {
    return entries;
  }
  return entries
    .map((entry, index) => ({ entry, index, score: scoreStanceRelevance(entry.stances, weights) }))
    .sort(
      (a, b) =>
        b.score.score - a.score.score || b.score.recordCount - a.score.recordCount || a.index - b.index
    )
    .map(({ entry }) => entry);
}

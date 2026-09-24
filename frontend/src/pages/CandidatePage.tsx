import { Fragment, useState } from "react";
import { isRouteErrorResponse, Link, useLoaderData, useLocation, useRouteError } from "react-router";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import type { CandidateDetail, CandidateElection, FinanceSummary } from "@voteapp/api-client";
import {
  CANDIDATE_RAIL_SORTS,
  candidateRailSortsOffered,
  sortCandidateRailEntries,
  type CandidateRailSortKey,
} from "@voteapp/api-client";
import { DetailPager } from "../components/DetailPager";
import { DetailRail } from "../components/DetailRail";
import {
  pagerNeighbors,
  readCandidateNavState,
  type CandidateNavState,
  type ElectionNavState,
} from "../lib/detailNavContext";
import { JsonLdScript } from "../components/JsonLdScript";
import { NotFoundNotice } from "../components/NotFoundNotice";
import { RouteError } from "../components/RouteError";
import { FollowButton } from "../components/FollowButton";
import { RegisterToFollowButton } from "../components/RegisterToFollowButton";
import { ShareButton } from "../components/ShareButton";
import { CandidatePickButton, CandidatePickRow, MeasureChoiceButtons } from "../components/ElectionChoiceControls";
import { draftChoicesByElectionId, isDecidedChoice, useBallotDraft } from "../lib/ballotDraft";
import { useMyDistricts } from "../lib/useMyDistricts";
import { AddressNudge } from "../components/AddressNudge";
import { PostPickActions } from "../components/PostPickActions";
import { useElectionChoices } from "@voteapp/api-client";
import { FinanceSummaryCard, hasFinanceContent } from "../components/FinanceSummaryCard";
import { StanceSummary } from "../components/StanceSummary";
import { TrackRecordSection, type RecordView } from "../components/TrackRecordSection";
import { ReportContentButton } from "../components/ReportContentButton";
import { formatDistrictName, formatElectionDate, isJudicialRetentionTitle } from "@voteapp/api-client";
import { loadFromApi } from "../lib/loadFromApi";
import { pageMeta } from "../lib/pageMeta";
import { useHydrated } from "../lib/useHydrated";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";
import { partyColorClass, profilePartyLabel } from "@voteapp/api-client";
import { candidateProfileLinks } from "@voteapp/api-client";
import { useFollows } from "@voteapp/api-client";
import { APP_NAME } from "@voteapp/api-client";
import { useMe } from "@voteapp/api-client";
import { useMyResearchAreas } from "@voteapp/api-client";
import { sourceLinkProps, track, useSectionExposure } from "../lib/usage";

// Loader payload: the candidate detail plus this candidate's finance for
// each election they are currently in, keyed by candidate_election_id.
export type CandidateLoaderData = CandidateDetail & {
  ongoing_finance: Record<string, FinanceSummary | null>;
};

// Server loader: the candidate subject arrives in the document HTML so
// non-JS crawlers can read it. Anonymous by design — see loadFromApi.
//
// Ongoing-election finance rides along in the loader (not a client query):
// SSR never dehydrates query state, so a client-side fetch would leave the
// profile's only finance surface invisible to crawlers and no-JS readers.
// Election-specific finance still stays off the candidate detail payload
// (see backend candidateDetailReader.ts) — the loader hits the narrow
// per-candidate finance endpoint, instead of the full election detail with
// every opponent's records.
export async function loader({ params, request }: LoaderFunctionArgs): Promise<CandidateLoaderData> {
  const detail = await loadFromApi<CandidateDetail>(`/api/candidates/${params.candidateId}`, request);
  const today = usLatestLocalDate();
  const ongoingElections = detail.candidate.elections.filter(
    (election) => election.election_date >= today
  );
  const entries = await Promise.all(
    ongoingElections.map(async (election): Promise<[string, FinanceSummary | null]> => {
      try {
        const { finance_summary } = await loadFromApi<{ finance_summary: FinanceSummary | null }>(
          `/api/elections/${election.election_id}/candidates/${detail.candidate.candidate_id}/finance`,
          request
        );
        return [election.candidate_election_id, finance_summary];
      } catch {
        // A finance failure (404/429/5xx/timeout) must not take down the
        // whole profile; the section simply doesn't render — same degradation
        // the old client-side fetch had.
        return [election.candidate_election_id, null];
      }
    })
  );
  return { ...detail, ongoing_finance: Object.fromEntries(entries) };
}

// Finance for an election the candidate is currently in, server-fetched by
// the loader so crawlers see it. Renders its own section so there is no
// orphan heading when the election has no finance coverage.
function OngoingElectionFinance({
  election,
  summary,
  showElection,
  exposureRef,
}: {
  election: CandidateElection;
  summary: FinanceSummary | null;
  // True when the candidate is in more than one ongoing race: the
  // placeholder then names its race, or two of them are indistinguishable.
  showElection: boolean;
  /** section_exposed marker for the first finance disclosure on the page. */
  exposureRef?: (node: Element | null) => void;
}) {
  if (!hasFinanceContent(summary)) {
    // Quiet placeholder where the disclosure row would sit, so a reader who
    // saw finance on another candidate knows this one is not hiding it.
    // "Not available", not "not found": the gap is usually a source we do
    // not cover (or a failed fetch), not proof the candidate filed nothing.
    return (
      <p className="mt-[29px] box:mt-[18px] text-sm text-ink-soft">
        Campaign finance information not available
        {showElection ? ` · ${election.official_ballot_title}` : ""}
      </p>
    );
  }
  return (
    <section className="mt-[29px] box:mt-[18px]">
      {/* Collapsed by default: finance is reference material, and open it
          pushed the record — the page's main content — below the fold. The
          collapsed content still ships in the SSR HTML (details just hides
          it), so crawler readability is unaffected.

          The heading lives OUTSIDE the summary, sr-only: browsers map
          <summary> to a button, and a heading inside it can drop out of
          screen-reader heading navigation (the HTML content model also
          forbids mixing a heading with phrasing content there). The heading
          always names the election; the visible line names it only when the
          candidate is in two concurrent races, which would otherwise render
          two indistinguishable "Campaign finance" rows. With one race the
          page header already says it. */}
      <h2 className="sr-only">{`Campaign Finance Information — ${election.official_ballot_title}`}</h2>
      <details
        ref={exposureRef as ((node: HTMLDetailsElement | null) => void) | undefined}
        onToggle={(event) =>
          track("detail_control", { control: "finance_toggle", value: event.currentTarget.open ? "open" : "close" })
        }
      >
        <summary className="cursor-pointer select-none">
          <span className="text-lg font-semibold text-green-600" aria-hidden="true">$ </span>
          <span className="text-lg font-semibold">Campaign Finance Information</span>
          {showElection ? (
            <>
              {" "}
              <span className="text-sm text-ink-soft">
                · {election.official_ballot_title} · {formatElectionDate(election.election_date)}
              </span>
            </>
          ) : null}
        </summary>
        <div className="mt-2 rounded-xl border border-line bg-surface p-4 box:p-[11px]">
          <FinanceSummaryCard summary={summary} />
        </div>
      </details>
    </section>
  );
}

// "Name (Party, State)" built from the non-empty parts: party is typed
// string but the detail reader coalesces a missing value to ""
// (candidateDetailReader.ts), and "Jane Doe (, CA)" must not reach a share
// card or a share sheet. Placeholder parties ("Nonpartisan"/"Unknown") are
// hidden the same way as in the header. Mirrored on the mobile candidate
// screen.
function candidateShareText(candidate: { display_name: string; party: string; state: string }): string {
  const context = [profilePartyLabel(candidate.party), candidate.state].filter(Boolean).join(", ");
  return context ? `${candidate.display_name} (${context})` : candidate.display_name;
}

// The <title>: name plus the office held (or, failing that, the race most
// recently entered) and state. Names repeat across the site (hundreds of
// candidates share theirs with someone else), and a search engine treats
// identical titles as one page competing with itself. Exported for tests.
export function candidateTitleText(candidate: {
  display_name: string;
  state: string;
  current_office: string | null;
  elections: readonly { official_ballot_title: string; election_date: string }[];
}): string {
  const latest = [...candidate.elections].sort((a, b) => b.election_date.localeCompare(a.election_date))[0];
  const role = candidate.current_office?.trim() || (latest ? `Candidate for ${latest.official_ballot_title}` : "");
  const context = [role, candidate.state].filter(Boolean).join(", ");
  return context ? `${candidate.display_name} — ${context}` : candidate.display_name;
}

// One election list, rendered once for the races still ahead and once for
// the finished ones. Only the heading differs.
function ElectionHistorySection({
  heading,
  elections,
  navState,
}: {
  heading: string;
  elections: CandidateElection[];
  navState: ElectionNavState;
}) {
  return (
    <section className="mt-[29px] box:mt-[18px]">
      <h2 className="text-heading font-semibold">{heading}</h2>
      <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
        {elections.map((election) => (
          <li key={election.candidate_election_id} className="px-3 py-2 text-sm">
            <Link
              to={`/elections/${election.election_id}`}
              state={navState}
              className="text-ink underline hover:text-rausch"
            >
              {election.official_ballot_title}
            </Link>{" "}
            <span className="text-ink-soft">
              · {formatElectionDate(election.election_date)} · {formatDistrictName(election.district.name)}
              {election.is_incumbent ? " · incumbent" : ""}
            </span>
            {/* No finance on any row here: campaign finance shows only for the
                election(s) the candidate is currently in (the eager section
                above). */}
          </li>
        ))}
      </ul>
    </section>
  );
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
  const candidate = data.candidate;
  return pageMeta({
    title: `${candidateTitleText(candidate)} · ${APP_NAME}`,
    description: `${candidateShareText(candidate)} — issue-tagged records with sources, election history, and campaign finance.`,
    path: location.pathname,
  });
};

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundNotice subject="Candidate" />;
  }
  return <RouteError />;
}

export function CandidatePage() {
  // The anonymous loader payload always carries is_following=false; derive
  // the real state from the follows list (only fetched for verified users),
  // same as ElectionPage. useSetFollow invalidates that list on toggle.
  // The button renders only once the list has loaded — before then a
  // followed candidate would briefly (or, on fetch failure, permanently)
  // show as unfollowed.
  const { follows, canFollow } = useFollows();
  const { me } = useMe();
  const { hasSaved, preferences, weights, isLoading: savedAreasLoading } = useMyResearchAreas();
  // "My issues first" is the only grouped view: with no saved areas the
  // preference reorder is a no-op, so it degrades to the public-salience
  // order a plain "by issue" view would show.
  const [recordView, setRecordView] = useState<RecordView>("my_issues");

  const detail = useLoaderData<typeof loader>();
  const candidate = detail.candidate;
  // Usage: which parts of the profile reached the viewport, once per
  // candidate (the route element stays mounted across rail walks).
  const summaryRef = useSectionExposure("summary", candidate.candidate_id);
  const stanceRef = useSectionExposure("stance", candidate.candidate_id);
  const financeRef = useSectionExposure("finance", candidate.candidate_id);
  const trackRecordRef = useSectionExposure("track_record", candidate.candidate_id);
  // ?? {}: tolerates loader data from before this field existed (deploy skew
  // between a cached document and fresh code) by rendering no finance.
  const ongoingFinance = detail.ongoing_finance ?? {};
  const isFollowing = (follows ?? []).some((follow) => follow.candidate_id === candidate.candidate_id);
  const profileLinks = candidateProfileLinks(candidate);
  const today = usLatestLocalDate();
  const ongoingElections = candidate.elections.filter((election) => election.election_date >= today);
  // The history list splits on the same date boundary: "is in" would misread
  // on a race that finished years ago. Within the ongoing bucket it also
  // splits on candidacy status — a withdrawn (or eliminated) candidate is
  // not "in" a race whose date is still ahead, but the candidacy stays
  // visible as history (the API keeps withdrawn links on purpose). Same
  // status rule as officeCandidacies below.
  const isExitedCandidacy = (election: CandidateElection): boolean =>
    election.status === "withdrawn" || election.status === "lost";
  const activeOngoingElections = ongoingElections.filter((election) => !isExitedCandidacy(election));
  const exitedOngoingElections = ongoingElections.filter(isExitedCandidacy);
  const pastElections = candidate.elections.filter((election) => election.election_date < today);
  // "My choice" rows: one per ongoing OFFICE candidacy the candidate hasn't
  // withdrawn or lost — a candidate can be in several races at once (and
  // have past ones), so each row names its election and only pickable
  // candidacies get a button. Rendered only once the choices list is loaded
  // (no-flash rule, like the follow button).
  const { choiceByElectionId, canChoose } = useElectionChoices();
  const draft = useBallotDraft();
  const officeCandidacies = ongoingElections.filter(
    (election) => election.race_type === "office" && election.status !== "withdrawn" && election.status !== "lost"
  );
  // Guests get the same rows writing to the local ballot draft
  // (lib/ballotDraft.ts) instead of the account endpoint. me is undefined
  // while the session loads — render nothing then to avoid a flash of the
  // wrong row (same no-flash rule as the follow button).
  const isGuest = me === null;
  const choiceForElection = (electionId: string) =>
    isGuest ? draftChoicesByElectionId(draft).get(electionId) : choiceByElectionId?.get(electionId);
  const choicesSettled = isGuest || (canChoose && choiceByElectionId !== undefined);
  // District gate (docs/plans/pick-district-gate.md): picking is a ballot
  // action, so only races in the viewer's own districts get controls. The
  // decided-choice clause is the safety valve — an imperfect geocode must
  // never lock someone out of seeing or changing an existing pick.
  const { districtIds, isLoading: districtsLoading } = useMyDistricts();
  const pickableElections =
    choicesSettled && !districtsLoading
      ? officeCandidacies.filter(
          (election) =>
            districtIds?.has(election.district.id) === true ||
            isDecidedChoice(choiceForElection(election.election_id))
        )
      : [];
  // State 3 of the gate: districts unknown (settled) with an UNDECIDED race
  // on the page — a conversion nudge replaces the controls. Decided races
  // keep their controls via the safety valve above and get no nudge (it
  // would contradict the ✓ beside it — same decided-race exclusion as the
  // election page); only a race still worth deciding earns the ask.
  const showAddressNudge =
    choicesSettled &&
    !districtsLoading &&
    districtIds === undefined &&
    officeCandidacies.some((election) => !isDecidedChoice(choiceForElection(election.election_id)));
  // The page's primary action ("Add to cart"): the sticky bottom pick card.
  // Only when the candidate is in exactly one pickable race — the card's
  // button carries no race name, so with several races it can't say which
  // one it would pick; those pages rely on the self-describing rows below.
  const primaryPickElection = pickableElections.length === 1 ? pickableElections[0] : null;
  // Whether THIS candidate holds (one of) the pick(s) for the card's race, or
  // the race's Yes/No answer is recorded (judicial retention) — gates the
  // card's post-pick actions. True on arrival too, not only right after
  // clicking: the "where to next" links are just as useful when a reader
  // returns to a candidate they already picked.
  const primaryChoice = primaryPickElection ? choiceForElection(primaryPickElection.election_id) : undefined;
  const isPrimaryPicked =
    primaryChoice !== undefined &&
    (primaryChoice.measure_position !== null ||
      primaryChoice.picks.some((pick) => pick.candidate_id === candidate.candidate_id));
  const location = useLocation();
  const hydrated = useHydrated();
  // Same hydration gate as the election page: location.state survives
  // reloads via history.state, but SSR rendered with null — reading it
  // before hydration mismatches the server HTML.
  const navState = hydrated ? readCandidateNavState(location.state) : null;
  // The rail's roster sort: offered only for the sorts this snapshot can
  // honor (candidateRailSortsOffered — an old snapshot without the stance
  // keys offers none; My issues additionally needs saved areas). Same
  // persistence story as the election rail's sort: component state across
  // sibling walks (the route element stays mounted), nav state across
  // remounts (election round trips). No "As listed" option here, unlike the
  // election rail: the roster's arrival order is always one of the two
  // offered sorts (the election page's own options), so an always-engaged
  // sort loses nothing — the default is the first offered ("My issues
  // first" with saved areas, A–Z without, matching the roster's own
  // defaults).
  const railRoster = navState?.candidates;
  // Withheld while the saved areas are still loading: the default sort is
  // the first offered option, and engaging A–Z in the window before
  // hasSaved settles would visibly re-shuffle the rail on every arrival
  // for viewers whose default is My issues first.
  const offeredRailSorts = savedAreasLoading
    ? []
    : candidateRailSortsOffered(railRoster ?? [], hasSaved);
  const [railSortOverride, setRailSortState] = useState<CandidateRailSortKey | null>(null);
  const railSortState = railSortOverride ?? navState?.railSort ?? null;
  const railSort =
    railSortState !== null && offeredRailSorts.includes(railSortState)
      ? railSortState
      : (offeredRailSorts[0] ?? null);
  // Sorting re-orders but never removes, so the displayed roster keeps the
  // same membership gate as the arrival list.
  const displayedRoster =
    railSort !== null && railRoster !== undefined
      ? sortCandidateRailEntries(railRoster, railSort, weights)
      : railRoster;
  // The context handed onward — sibling walks and the election round trip —
  // carries the rail's CURRENT sort; the back destination needs no rewrite
  // here (the election page's roster sort is component state, not URL).
  const forwardedNavState: CandidateNavState | null =
    navState === null
      ? null
      : offeredRailSorts.length === 0
        ? navState
        : (() => {
            // Field removal only on the copy — never mutate the shared
            // original.
            const forwarded: CandidateNavState = { ...navState };
            if (railSort) {
              forwarded.railSort = railSort;
            } else {
              delete forwarded.railSort;
            }
            return forwarded;
          })();
  // The back hop's election state: the arrival context with rosterSort
  // overridden by this rail's CURRENT sort, so a sort switched here walks
  // back into the election page's roster (rail and roster are one
  // continuous control — same value space by construction). Recomputed at
  // render on every sibling page, so the override always reflects the sort
  // on screen, not the one at departure. With no engaged rail sort (an old
  // unkeyed snapshot) the arrival state passes through untouched.
  const backToElectionState =
    navState?.backState !== undefined && railSort !== null
      ? { ...navState.backState, rosterSort: railSort }
      : navState?.backState;
  // Every election link on this page (the back-link fallback and the
  // Elections history list) tells the election page to come back here. This
  // page's own arrival context rides along (backState) so the round trip
  // hands it back — without it, My Picks → candidate → election → back
  // would land on a candidate page that forgot it came from My Picks.
  const electionNavState: ElectionNavState = {
    backTo: { path: `/candidates/${candidate.candidate_id}`, label: candidate.display_name },
    ...(forwardedNavState ? { backState: forwardedNavState } : {}),
  };
  // Prev/next over the arrival election's roster as the rail displays it (a
  // candidate can be in several races — the sequence is scoped to the one
  // the reader came from). Null (back slot only) when this candidate fell
  // out of the snapshot. The nav bar exists only for in-app arrivals: no
  // router state (deep link) = no bar, by product choice.
  const rosterNeighbors = pagerNeighbors(displayedRoster, candidate.candidate_id);
  // Desktop rail: the arrival race's roster under the same guard as
  // prev/next (pagerNeighbors is null unless the list has >= 2 entries and
  // contains this candidate). navState is re-read only for the type system —
  // non-null neighbors implies it.
  const railCandidates = rosterNeighbors !== null ? (displayedRoster ?? null) : null;
  // The rail's pick checks, mirroring the election rail: the green mark on
  // the candidate(s) the viewer picked IN THIS RACE — same choice source as
  // the "My choice" rows (account choices signed-in, local draft as guest).
  // Scoped through the snapshot's electionId (the race the roster belongs
  // to); an old snapshot without it degrades to no checks. Multi-seat races
  // can legitimately check several rows.
  const railChoice = navState?.electionId !== undefined ? choiceForElection(navState.electionId) : undefined;
  const railPickedIds = new Set((railChoice?.picks ?? []).map((pick) => pick.candidate_id));

  // Display label for the back slot: when the destination is an election,
  // its official ballot title runs to legal-name length ("For United States
  // Representative, 1st Congressional District") and the reader just left
  // it — the Elections section below names it anyway. A generic "Election"
  // reads cleaner. List destinations ("My Picks", "Shared picks") keep
  // their short names.
  const pagerBackTo = navState
    ? navState.backTo.path.startsWith("/elections/")
      ? { path: navState.backTo.path, label: "Election" }
      : navState.backTo
    : null;

  // The nav bar at the top: prev | back | next, each slot captioned. The
  // back slot restores the election page's own ballot sequence (backState).
  // With the rail on screen (lg+) the bar is redundant, so it drops to
  // narrow screens only; rail-less arrivals keep it at every width.
  const pagerBar =
    navState && pagerBackTo ? (
      <DetailPager
        ariaLabel="Candidate navigation"
        prev={
          rosterNeighbors?.prev
            ? { path: `/candidates/${rosterNeighbors.prev.id}`, label: rosterNeighbors.prev.name }
            : null
        }
        next={
          rosterNeighbors?.next
            ? { path: `/candidates/${rosterNeighbors.next.id}`, label: rosterNeighbors.next.name }
            : null
        }
        backTo={pagerBackTo}
        backToState={backToElectionState}
        siblingState={forwardedNavState}
      />
    ) : null;

  return (
    // With rail context the page widens to a two-column grid on lg+ (rail |
    // detail); without it — deep links, stale snapshots — the markup is the
    // classic centered column at every width. Mirrors ElectionPage.
    <div
      className={
        railCandidates !== null
          ? "mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px] box:px-[11px] box:pt-[11px] box:pb-[29px] lg:grid lg:max-w-6xl lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-8"
          : "mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px] box:px-[11px] box:pt-[11px] box:pb-[29px]"
      }
    >
      {railCandidates !== null && navState !== null ? (
        // The rail's exit link keeps the full backTo label (the election's
        // ballot title): rail rows truncate, so length is fine there, and
        // the fuller name is clearer than the pager's generic "Election".
        <DetailRail
          ariaLabel="Candidates in this race"
          entries={railCandidates.map((entry) => ({
            id: entry.id,
            label: entry.name,
            path: `/candidates/${entry.id}`,
            picked: railPickedIds.has(entry.id),
          }))}
          pickedSrLabel="my pick"
          currentId={candidate.candidate_id}
          backTo={navState.backTo}
          backToState={backToElectionState}
          siblingState={forwardedNavState}
          headerSlot={
            // The list label renders even when no sort is offerable (an old
            // snapshot): naming WHAT the rows are never depends on the keys.
            <div className="flex flex-col gap-1.5">
              {/* text-ink, not -soft: the label is the rail's identity, not
                  a caption — it must register at a glance. */}
              <p className="text-xs font-semibold uppercase tracking-wide text-ink">Candidates:</p>
              {offeredRailSorts.length > 0 ? (
                <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                  Sort
                  <select
                    value={railSort ?? ""}
                    onChange={(event) =>
                      setRailSortState(event.target.value as CandidateRailSortKey)
                    }
                    className="min-w-0 flex-1 rounded-md border border-line bg-white px-1.5 py-1 text-xs text-ink focus:border-ink focus:outline-none"
                  >
                    {CANDIDATE_RAIL_SORTS.filter((option) =>
                      offeredRailSorts.includes(option.value)
                    ).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          }
        />
      ) : null}
      {/* min-w-0: the grid column must be allowed to shrink or long names
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
          railCandidates !== null
            ? "min-w-0 lg:relative lg:max-w-3xl lg:before:absolute lg:before:inset-y-0 lg:before:-left-4 lg:before:w-px lg:before:bg-line lg:before:content-['']"
            : "min-w-0 lg:max-w-3xl"
        }
      >
        {railCandidates !== null ? <div className="lg:hidden">{pagerBar}</div> : pagerBar}
        <JsonLdScript
          data={{
            "@type": "Person",
            name: candidate.display_name,
            ...(candidate.current_office ? { jobTitle: candidate.current_office } : {}),
            ...(candidate.official_website_url ? { url: candidate.official_website_url } : {}),
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-title font-bold">{candidate.display_name}</h1>
          <div className="flex items-center gap-2">
            <ShareButton
              path={`/candidates/${candidate.candidate_id}`}
              shareText={candidateShareText(candidate)}
            />
            {canFollow && follows ? (
              <FollowButton
                // Remount on candidate change: the route element stays mounted
                // across candidate-to-candidate navigation, and without the key
                // a follow error from the previous candidate would linger under
                // this one's button.
                key={candidate.candidate_id}
                candidateId={candidate.candidate_id}
                candidateName={candidate.display_name}
                isFollowing={isFollowing}
              />
            ) : me === null ? (
              // Logged-out visitors get a Follow button that prompts them to
              // register (me is undefined while the session is still loading —
              // render nothing then to avoid a flash of the wrong button).
              <RegisterToFollowButton candidateName={candidate.display_name} />
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          {profilePartyLabel(candidate.party) ? (
            <>
              <span className={partyColorClass(candidate.party) || undefined}>
                {profilePartyLabel(candidate.party)}
              </span>{" "}
              ·{" "}
            </>
          ) : null}
          {candidate.state}
          {candidate.current_office ? <> · {candidate.current_office}</> : null}
        </p>
        {profileLinks.length > 0 ? (
          <p className="mt-1 text-sm">
            {profileLinks.map((link, index) => (
              <Fragment key={link.label}>
                {index > 0 ? <span className="text-ink-soft"> · </span> : null}
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => track("official_source_click", { kind: "profile_link", ...sourceLinkProps(link.href) })}
                  className="text-ink underline hover:text-rausch"
                >
                  {link.label}
                </a>
              </Fragment>
            ))}
          </p>
        ) : null}
        {candidate.summary ? (
          <p ref={summaryRef} className="mt-3 text-body text-ink">
            {candidate.summary}
          </p>
        ) : null}

        {/* Directly after the summary, before the pick rows — the same order
            as the measure page (explainer boxes, then choice buttons). */}
        <StanceSummary
          // Keyed by candidate: the route element stays mounted across
          // sibling walks, and the boxes' expanded state must start fresh
          // for each person.
          key={candidate.candidate_id}
          candidateName={candidate.display_name}
          records={candidate.records}
          // Personalized order/emphasis only in the "my issues first" view,
          // so the summary always matches the record groups below it.
          preferences={recordView === "my_issues" ? preferences : []}
          exposureRef={stanceRef}
        />

        {/* Districts unknown: the address nudge takes the pick controls'
            in-body slot (single-race pages get it here too — a passive
            sentence doesn't earn the sticky card's viewport pinning). */}
        {showAddressNudge ? (
          <div className="mt-[18px]">
            <AddressNudge />
          </div>
        ) : null}

        {/* In-body rows only when the sticky bar can't act: with several
            concurrent races the bar's bare "Make my pick" can't say which
            race it would pick, so each race keeps its self-describing row.
            Single-race pages leave picking to the sticky bar alone. */}
        {primaryPickElection === null && pickableElections.length > 0 ? (
          <div className="mt-[18px] space-y-2">
            {pickableElections.map((election) =>
              isJudicialRetentionTitle(election.official_ballot_title) ? (
                // Retention race: answered Yes/No, never by picking the judge.
                <div key={election.candidate_election_id} className="rounded-lg border border-line p-3">
                  <p className="mb-2 text-sm text-ink">
                    {election.official_ballot_title} · {formatElectionDate(election.election_date)}
                  </p>
                  <MeasureChoiceButtons
                    electionId={election.election_id}
                    raceTitle={election.official_ballot_title}
                    electionDate={election.election_date}
                    choice={choiceForElection(election.election_id)}
                    raceType="office"
                  />
                </div>
              ) : (
                /* Always names the election: several concurrent races (and past
                   ones) exist, and the pick must land on the right one. */
                <CandidatePickRow
                  key={election.candidate_election_id}
                  electionId={election.election_id}
                  candidateId={candidate.candidate_id}
                  candidateName={candidate.display_name}
                  raceName={election.official_ballot_title}
                  dateLabel={formatElectionDate(election.election_date)}
                  electionDate={election.election_date}
                  choice={choiceForElection(election.election_id)}
                  seatsToFill={election.seats_to_fill ?? null}
                />
              )
            )}
          </div>
        ) : null}

        {ongoingElections.map((election, index) => (
          <OngoingElectionFinance
            key={election.candidate_election_id}
            election={election}
            summary={ongoingFinance[election.candidate_election_id] ?? null}
            showElection={ongoingElections.length > 1}
            exposureRef={index === 0 ? financeRef : undefined}
          />
        ))}

        <TrackRecordSection
          // Keyed by candidate: the roster pager keeps this page mounted
          // across candidates, and the "show all" expansion must not leak
          // from one candidate's 50-record list into the next. The view
          // pick (recordView) is a preference that travels, so it lives here.
          // Prefixed: StanceSummary above is a sibling keyed by the same id,
          // and React treats equal sibling keys as one child.
          key={`track-record-${candidate.candidate_id}`}
          records={candidate.records}
          preferences={preferences}
          view={recordView}
          onViewChange={setRecordView}
          reporterEmail={me?.email}
          headingRef={trackRecordRef}
          emptyState={
            // An empty record list is ambiguous on its own: researched-and-
            // none-found and not-researched-yet must read differently or
            // absence looks like a completed (empty) record. "Verified", not
            // "found": a search can finish with every discovered record
            // dropped for permanently failing source checks, and the
            // checkpoint still advances — the array only proves nothing
            // verifiable was kept.
            <p className="mt-[29px] box:mt-[18px] text-sm text-ink-soft">
              {candidate.records_researched_through
                ? `No verified public records for this candidate — record history researched through ${formatElectionDate(candidate.records_researched_through)}.`
                : "This candidate's record history has not been researched yet."}
            </p>
          }
        />

        {/* Not a bare "Elections": on a candidate page that reads as a generic
            section of election news. Name the person and the relationship, and
            split on the election date — "is in" would misread on a race that
            finished years ago, and on a race the candidate withdrew from. */}
        {activeOngoingElections.length === 1 &&
        isJudicialRetentionTitle(activeOngoingElections[0]!.official_ballot_title) ? (
          // A retention judge is not "in a race" against anyone: one line
          // pointing at the Yes/No question, not a race list with the full
          // ballot title, state, and incumbent tag repeated.
          <p className="mt-[29px] box:mt-[18px] text-sm text-ink-soft">
            <Link
              to={`/elections/${activeOngoingElections[0]!.election_id}`}
              state={electionNavState}
              className="text-ink underline hover:text-rausch"
            >
              Retention question
            </Link>{" "}
            · {formatElectionDate(activeOngoingElections[0]!.election_date)}
          </p>
        ) : activeOngoingElections.length > 1 || (activeOngoingElections.length === 1 && navState === null) ? (
          // A one-race list only repeats what the reader already knows when
          // they arrived from a list or a race (the top bar leads back there).
          // On a deep link it stays: it is the page's only link to the race.
          <ElectionHistorySection
            heading={`${activeOngoingElections.length === 1 ? "Race" : "Races"} ${candidate.display_name} is in:`}
            elections={activeOngoingElections}
            navState={electionNavState}
          />
        ) : null}

        {exitedOngoingElections.length > 0 ? (
          <ElectionHistorySection
            heading={`${exitedOngoingElections.length === 1 ? "Race" : "Races"} ${candidate.display_name} is no longer in:`}
            elections={exitedOngoingElections}
            navState={electionNavState}
          />
        ) : null}

        {pastElections.length > 0 ? (
          <ElectionHistorySection
            heading={`Past ${pastElections.length === 1 ? "race" : "races"} ${candidate.display_name} ran in:`}
            elections={pastElections}
            navState={electionNavState}
          />
        ) : null}

        {candidate.last_researched ? (
          <p className="mt-[29px] box:mt-[18px] text-xs text-ink-soft">
            Profile last researched {formatElectionDate(candidate.last_researched.slice(0, 10))}.
          </p>
        ) : null}

        {/* Last on purpose: reporting is a reaction to reading the profile, not
            a headline action worth space above the record. Per-record report
            buttons stay on their cards. */}
        <div className="mt-[29px] box:mt-[18px]">
          <ReportContentButton
            entityType="candidate"
            entityId={candidate.candidate_id}
            contextLabel="candidate profile"
            reporterEmail={me?.email}
          />
        </div>

        {primaryPickElection ? (
          // The page's ONE pick control: a sticky card pinned to the bottom
          // of the viewport while the profile scrolls, at every width —
          // sticky (not fixed) so in the split layout it stays inside the
          // detail column instead of overlaying the rail. No caption naming
          // the race: the card renders only when the candidate is in exactly
          // one pickable race (see primaryPickElection), so the page itself
          // is the context — a title line here just repeats the "Race X is
          // in" section.
          // data-sticky-pick-cta: index.css lifts the chatbot's floating
          // launcher above this card (both pin to the viewport bottom and
          // the launcher would cover the button's right end on phones).
          <div
            data-sticky-pick-cta=""
            className="sticky bottom-3 z-30 mt-[29px] box:mt-[18px] rounded-xl border border-line bg-surface p-3 shadow-lg"
          >
            {isJudicialRetentionTitle(primaryPickElection.official_ballot_title) ? (
              // Retention race: the sticky card asks Yes/No on keeping the
              // judge instead of offering a candidate pick. No caption and no
              // auto-pick here — the profile is reference material; the
              // election page owns the explanation and the alignment control.
              <>
                <MeasureChoiceButtons
                  key={candidate.candidate_id}
                  electionId={primaryPickElection.election_id}
                  raceTitle={primaryPickElection.official_ballot_title}
                  electionDate={primaryPickElection.election_date}
                  choice={choiceForElection(primaryPickElection.election_id)}
                  raceType="office"
                  fullWidth
                />
              </>
            ) : (
              <CandidatePickButton
                // Remount on candidate change, like the Follow button above:
                // the route element stays mounted across roster navigation,
                // and without the key a failed save's error from the previous
                // candidate would linger under this one's button.
                key={candidate.candidate_id}
                electionId={primaryPickElection.election_id}
                candidateId={candidate.candidate_id}
                candidateName={candidate.display_name}
                raceTitle={primaryPickElection.official_ballot_title}
                electionDate={primaryPickElection.election_date}
                choice={choiceForElection(primaryPickElection.election_id)}
                seatsToFill={primaryPickElection.seats_to_fill ?? null}
                fullWidth
                surface="candidate_card"
              />
            )}
            {/* "Back to election" only for election arrivals: a My-Picks
                arrival would get a back link and a draft link to the same
                place (see PostPickActions). */}
            {isPrimaryPicked ? (
              <PostPickActions
                back={
                  navState?.backTo.path.startsWith("/elections/")
                    ? { path: navState.backTo.path, state: backToElectionState, label: "election" }
                    : null
                }
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default CandidatePage;

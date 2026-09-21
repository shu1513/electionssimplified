import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  BallotLevel,
  BallotRaceType,
  BallotSort,
  ElectionChoice,
  ElectionSummary,
  RailSortKey,
  ResearchAreaWeight,
  ResultChipTone,
} from "@voteapp/api-client";
import type { BackTo, ElectionNavState } from "../lib/detailNavContext";
import { useElectionListState } from "../lib/useElectionListState";
import {
  ballotLevel,
  ballotLevelLabel,
  buildResultChipParts,
  competitivenessChip,
  formatChoiceLabel,
  formatDistrictName,
  formatElectionDate,
  formatRosterStatus,
  formatVotePowerLabel,
  resultChipTone,
  isDecidedChoice,
  isRetentionRace,
  splitRetentionRaces,
  splitResearchAreasBySaved,
} from "@voteapp/api-client";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";
import { votePowerBadgeClass } from "../lib/votePowerBadge";
import { positionBucket, track } from "../lib/usage";

// Same green/red as the election page's candidate result badges (and the
// measure No chip's red) — one color language for "called" across surfaces.
const RESULT_CHIP_CLASSES: Record<ResultChipTone, string> = {
  positive: "rounded border border-green-700 bg-green-50 px-2 py-0.5 font-medium text-green-900",
  negative: "rounded border border-red-700 bg-red-50 px-2 py-0.5 font-medium text-red-900",
  neutral: "rounded bg-surface px-2 py-0.5 text-ink",
};

// Statewide races carry a dozen-plus research areas; rendering every one
// buried the card's actual signal (title, candidates, vote power) under a
// wall of identical chips. The card is a preview — saved-area matches lead
// (they are the personal signal), the cap applies to the whole row, and the
// election page carries the full set.
const MAX_AREA_CHIPS = 3;

// Research areas render as plain colored text, comma-separated — NOT boxed
// chips. Boxed/pill styling is reserved for interactive elements; a bordered
// area "chip" read as a button and invited dead clicks. Saved matches lead
// AND render in purple: purple means "an issue on my list" on every surface
// (ballot cards, election rows, the candidate page's stance boxes) and is
// the one hue the stance colors (green/red/amber) and party colors don't
// use. Both exported so the other surfaces match the card's.
export const AREA_TEXT_CLASS = "font-medium text-green-900";
export const SAVED_AREA_TEXT_CLASS = "font-semibold text-purple-800";

// An ordinary office race without candidates or results has nothing to read.
// Measures and judicial retentions remain readable Yes/No races without a
// candidate profile, including a lone retention outside a collapsed group.
// Keep this rule shared by date grouping, detail navigation, and usage events.
function isAwaitingCandidates(election: ElectionSummary): boolean {
  return election.race_type !== "ballot_measure" && !isRetentionRace(election) &&
    election.candidate_count === 0 && !election.has_results;
}

/**
 * A ballot is built from district rows, and the county row carries every
 * seat attached to it — so a ward- or precinct-level seat reaches every
 * county resident, including those who cannot vote in it. The address lookup
 * has no ward/precinct membership, so the list names the seats' area and
 * admits it cannot match them, once per run of such seats rather than on
 * every card. Runs are consecutive (presentational, never reordering) and
 * break when the parent district changes. Understated ("may not"): in
 * several states the seat is a residency district voted countywide.
 */
function splitSeatRuns(elections: ElectionSummary[]): { district: string | null; elections: ElectionSummary[] }[] {
  const runs: { district: string | null; elections: ElectionSummary[] }[] = [];
  for (const election of elections) {
    const district = election.sub_district_seat ? formatDistrictName(election.district.name) : null;
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.district === district) {
      lastRun.elections.push(election);
    } else {
      runs.push({ district, elections: [election] });
    }
  }
  return runs;
}

function SeatRun({ district, count, children }: { district: string | null; count: number; children: ReactNode }) {
  if (district === null) {
    return <>{children}</>;
  }
  // Note hugs its cards (tighter gap inside than the list's own spacing) so
  // it reads as belonging to the run below, not to the card above. A run of
  // one seat gets the singular.
  return (
    <div>
      <p className="mb-1.5 text-sm text-ink-soft">
        {count === 1
          ? `This seat covers part of ${district} — it may not cover your address.`
          : `These seats each cover part of ${district} — one may not cover your address.`}
      </p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

/**
 * Under the district-size sorts the backend orders each date's races by
 * government level before population, so the level sections are consecutive
 * runs of the payload — presentational, like the date groups, never a
 * reorder. Other sorts do not use government-level sections.
 */
function splitLevelRuns(elections: ElectionSummary[]): { level: BallotLevel; elections: ElectionSummary[] }[] {
  const runs: { level: BallotLevel; elections: ElectionSummary[] }[] = [];
  for (const election of elections) {
    const level = ballotLevel(
      election.office?.scope,
      election.district.district_type,
      election.discovery_contest_family
    );
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.level === level) {
      lastRun.elections.push(election);
    } else {
      runs.push({ level, elections: [election] });
    }
  }
  return runs;
}

// Visible bands, highest first. The two lowest ratings share one label.
const VOTE_POWER_GROUPS = ["very_high", "high", "above_average", "medium", "low", "unknown"] as const;

function splitVotePowerGroups(elections: ElectionSummary[]) {
  return VOTE_POWER_GROUPS.map((rating) => ({
    rating,
    label: formatVotePowerLabel(rating),
    elections: elections.filter((election) => {
      if (isRetentionRace(election)) return false;
      const label = election.vote_power.label === "very_low" ? "low" : election.vote_power.label;
      return (label === "retention" ? "unknown" : label) === rating;
    }),
  })).filter((group) => group.elections.length > 0);
}

/**
 * One collapsible district or vote-power section, open by default.
 * District groups use local state. Vote-power groups opt into navigation
 * state so returning from a detail page restores their disclosures.
 */
function ElectionSection({ label, count, children, colorClass = "text-ink hover:text-rausch-deep",
  open: controlledOpen, onOpenChange, heading = false,
}: {
  label: string;
  count: number;
  children: ReactNode;
  colorClass?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Render the toggle as an h2 at the date headings' size: for a section
   * that sits beside "Elections on {date}", not inside one. */
  heading?: boolean;
}) {
  const [localOpen, setOpen] = useState(true);
  const open = controlledOpen ?? localOpen;
  const toggle = (
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          onOpenChange?.(!open);
        }}
        // 17.5px: a hair above the card titles (subheading, 16-17px) and
        // under the date heading (19-22px) — user tuned this by eye on
        // 2026-09-12 (text-lg read a touch too big).
        className={`flex min-h-10 w-full items-center gap-1.5 text-left box:min-h-8 ${heading ? "text-heading font-bold" : "text-[1.09375rem] font-semibold"} ${colorClass}`}
      >
        {label}
        <span className="text-sm font-normal text-ink-soft">({count})</span>
        {/* Chevron trails the label (user choice 2026-09-12: right, not
            left); points right when collapsed, down when open. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={`h-[22px] w-[22px] shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
        >
          <path d="M7 5l6 5-6 5V5z" />
        </svg>
      </button>
  );
  return (
    <section>
      {heading ? <h2>{toggle}</h2> : toggle}
      {open ? <div className="mt-2 space-y-3 box:mt-1 box:space-y-2">{children}</div> : null}
    </section>
  );
}

/** Lists show the group size; draft cards opt into answered progress. */
export function RetentionGroup({
  elections,
  choicesByElectionId,
  children,
  showProgress = false,
  open: controlledOpen,
  onOpenChange,
}: {
  elections: ElectionSummary[];
  choicesByElectionId?: Map<string, ElectionChoice>;
  children: ReactNode;
  showProgress?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const answered = elections.filter((election) => isDecidedChoice(choicesByElectionId?.get(election.id))).length;
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          track("list_control", { control: "retention_group", value: open ? "close" : "open" });
          setOpen(!open);
          onOpenChange?.(!open);
        }}
        className={`flex min-h-10 w-full items-center gap-1.5 text-left font-semibold text-ink box:min-h-8 ${showProgress ? "text-heading" : "text-[1.09375rem]"}`}
      >
        Retention Races{" "}
        {!showProgress ? (
          <span className="text-sm font-normal text-ink-soft">({elections.length})</span>
        ) : null}
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={`h-[22px] w-[22px] shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
        >
          <path d="M7 5l6 5-6 5V5z" />
        </svg>
      </button>
      {showProgress ? (
        <div className="mt-2 flex items-center gap-3">
          <div
            role="progressbar"
            aria-label={`${answered} of ${elections.length} retention races decided`}
            aria-valuemin={0}
            aria-valuemax={elections.length}
            aria-valuenow={answered}
            className="h-2 flex-1 overflow-hidden rounded-full bg-line/70"
          >
            <div
              className="h-full rounded-full bg-green-700"
              style={{ width: `${elections.length > 0 ? (answered / elections.length) * 100 : 0}%` }}
            />
          </div>
          <span className="text-sm font-semibold tabular-nums text-ink">
            {answered} / {elections.length}
          </span>
        </div>
      ) : null}
      {open ? <div className="mt-2 space-y-3 box:mt-1 box:space-y-2">{children}</div> : null}
    </section>
  );
}

// Partition before the awaiting tail: even a retention with no candidate
// profile belongs to its date's group, matching the progress exclusion.
function groupListElections(elections: ElectionSummary[], votePowerDates?: ReadonlySet<string>) {
  const { contested, retention } = splitRetentionRaces(elections);
  const retentionIds = new Set(retention.map((election) => election.id));
  const byDate = new Map<string, { date: string; contested: ElectionSummary[]; retention: ElectionSummary[] }>();
  for (const election of elections) {
    const grouped = retentionIds.has(election.id);
    if (!grouped && isAwaitingCandidates(election)) continue;
    let group = byDate.get(election.election_date);
    if (!group) {
      group = { date: election.election_date, contested: [], retention: [] };
      byDate.set(election.election_date, group);
    }
    (grouped ? group.retention : group.contested).push(election);
  }
  // A retention-only date may have arrived in the backend's awaiting tail.
  const groups = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const group of groups) {
    if (!votePowerDates?.has(group.date)) continue;
    // Keep detail navigation and usage positions in the same order as
    // the displayed bands; a singleton retention stays a plain card.
    group.contested = [
      ...splitVotePowerGroups(group.contested).flatMap((band) => band.elections),
      ...group.contested.filter(isRetentionRace),
    ];
  }
  return { groups, awaiting: contested.filter(isAwaitingCandidates), retentionIds };
}

/**
 * Date-grouped card list shared by both ballot pages. Elections cluster on
 * election days (a typical ballot is one or two dates), so the date renders
 * once as a group heading instead of being stamped on every card. Dates
 * stay chronological; within a date, payload order is preserved in each
 * partition (contested first, grouped retention last).
 *
 * Races still waiting on a candidate list render apart, under one closing
 * section instead of inside the date groups: the backend sinks them to the
 * end of the payload, and date-grouping that tail would repeat date headings
 * at the bottom of the list. Their cards carry their own date (their section
 * heading names no date), and they keep the payload's relative order.
 */
export function ElectionList({
  elections,
  savedAreaWeights,
  choicesByElectionId,
  backTo,
  contestsPool,
  raceType,
  railSort,
  sort,
}: {
  elections: ElectionSummary[];
  /** District-size sorts group by level. Vote-power groups appear only
   * when that date has at least ten displayed non-retention races. */
  sort?: BallotSort;
  /**
   * The session holder's saved research areas (useMyResearchAreas().weights):
   * membership decides which chips lead, rank decides their order.
   */
  savedAreaWeights?: Map<string, ResearchAreaWeight>;
  /**
   * The session holder's planned votes (useElectionChoices().choiceByElectionId).
   * Undefined while anonymous or still loading. Only elections present in the
   * map get a pick chip; a race without one shows nothing, deliberately — an
   * empty-state badge on every undecided race was more noise than signal.
   */
  choicesByElectionId?: Map<string, ElectionChoice>;
  /**
   * Where a detail page's back link should return (the calling page's own
   * URL including its query string, so sort and filters survive the round
   * trip). When set, every card hands the election page this destination
   * plus the ballot's displayed contest order via router state.
   */
  backTo?: BackTo;
  /**
   * The nav snapshot's contest pool when it should be WIDER than the
   * displayed list — the ballot pages pass their filter-visible but
   * tab-UNsliced list so the detail rail's race-type tabs can reach races
   * the list's engaged tab put aside. Defaults to `elections`.
   */
  contestsPool?: ElectionSummary[];
  /** The list's engaged race-type tab, recorded in the nav snapshot so the
   * detail rail's tabs start where the reader left the list. */
  raceType?: BallotRaceType | null;
  /** The rail sort seeded by the list's engaged sort (railSortForBallotSort
   * — district-size sorts fall back to vote_power), recorded so the rail's
   * always-engaged sort control starts where the list was. */
  railSort?: RailSortKey;
}) {
  const {
    listState,
    expandedRetentionDates,
    setRetentionOpen,
    setVotePowerOpen,
    awaitingCandidatesOpen,
    setAwaitingCandidatesOpen,
    isSectionOpen,
    setSectionOpen,
  } = useElectionListState();
  const nonRetentionCounts = new Map<string, number>();
  if (sort === "vote_power") {
    for (const election of elections) {
      if (isRetentionRace(election) || isAwaitingCandidates(election)) continue;
      const date = election.election_date;
      nonRetentionCounts.set(date, (nonRetentionCounts.get(date) ?? 0) + 1);
    }
  }
  const votePowerDates = new Set([...nonRetentionCounts].filter(([, count]) => count >= 10).map(([date]) => date));
  const { groups, awaiting: awaitingCandidates } = groupListElections(elections, votePowerDates);
  // Navigation uses the same qualifying dates as the displayed list,
  // even when its pool includes races hidden by the active tab.
  const pool = groupListElections(contestsPool ?? elections, votePowerDates);
  const navState: ElectionNavState | undefined = backTo
    ? {
        backTo,
        ...(listState ? { listState } : {}),
        contests: [
          ...pool.groups.flatMap((group) => [...group.contested, ...group.retention]),
          ...pool.awaiting,
        ].map((election) => ({
          id: election.id,
          title: election.official_ballot_title,
          race_type: election.race_type === "ballot_measure" ? "ballot_measure" : "office",
          // The rail's sort keys: score/date mirror the backend's sort
          // inputs, the area ids feed the client My-issues scoring, and the
          // awaiting flag keeps that tail sunk under every rail sort.
          vote_power_score: election.vote_power.score,
          election_date: election.election_date,
          research_area_ids: election.research_areas.map((area) => area.id),
          ...(pool.retentionIds.has(election.id)
            ? { retention: true }
            : isAwaitingCandidates(election) ? { awaiting_candidates: true } : {}),
        })),
        ...(raceType ? { raceType } : {}),
        ...(railSort ? { railSort } : {}),
      }
    : undefined;
  // Displayed position (1-based, readable cards then the awaiting tail) for
  // the election_open usage event — "which slot in THIS rendered list".
  const positionById = new Map<string, number>();
  for (const election of [...groups.flatMap((group) => [...group.contested, ...group.retention]), ...awaitingCandidates]) {
    positionById.set(election.id, positionById.size + 1);
  }
  const levelSections = sort === "district_size" || sort === "district_size_smallest";
  const renderCards = (cards: ElectionSummary[], showVotePower = true) =>
    splitSeatRuns(cards).map((run) => (
      <SeatRun key={run.elections[0].id} district={run.district} count={run.elections.length}>
        {run.elections.map((election) => (
          <ElectionCard
            key={election.id}
            election={election}
            savedAreaWeights={savedAreaWeights}
            myChoice={choicesByElectionId?.get(election.id)}
            showVotePower={showVotePower}
            navState={navState}
            position={positionById.get(election.id) ?? 1}
          />
        ))}
      </SeatRun>
    ));
  return (
    <div className="mt-4 space-y-6 box:mt-3 box:space-y-4">
      {groups.map((group) => (
        // One date section, with grouped retention after its contested races.
        <section key={group.date}>
          {/* The ballot pages carry no h1 banner; these date headings are the
              page's identity, so they read as full sentences and lead the
              visual hierarchy. */}
          <h2 className="text-heading font-bold text-ink">Elections on {formatElectionDate(group.date)}</h2>
          {levelSections ? (
            // Keyed on the sort too, so flipping biggest ↔ smallest remounts
            // every section open even where a level's first race is unchanged.
            <div className="mt-3 space-y-5 box:mt-2 box:space-y-3">
              {splitLevelRuns(group.contested).map((run) => (
                <ElectionSection
                  key={`${sort}-${run.level}-${run.elections[0].id}`}
                  label={ballotLevelLabel(run.level)}
                  count={run.elections.length}
                  open={isSectionOpen(`${group.date}:level:${run.level}`)}
                  onOpenChange={(open) => setSectionOpen(`${group.date}:level:${run.level}`, open)}
                >
                  {renderCards(run.elections)}
                </ElectionSection>
              ))}
            </div>
          ) : votePowerDates.has(group.date) ? (
            <div className="mt-3 space-y-5 box:mt-2 box:space-y-3">
              {splitVotePowerGroups(group.contested).map((band) => (
                <ElectionSection
                  key={`vote_power-${band.rating}`}
                  label={`My vote power: ${band.label}`}
                  count={band.elections.length}
                  colorClass={votePowerBadgeClass(band.rating)}
                  open={isSectionOpen(`${group.date}:${band.rating}`)}
                  onOpenChange={(open) => setVotePowerOpen(`${group.date}:${band.rating}`, open)}
                >
                  {renderCards(band.elections, false)}
                </ElectionSection>
              ))}
              {renderCards(group.contested.filter(isRetentionRace))}
            </div>
          ) : (
            <div className="mt-2 space-y-3">{renderCards(group.contested)}</div>
          )}
          {group.retention.length > 0 ? (
            <div className="mt-3">
              <RetentionGroup
                elections={group.retention}
                choicesByElectionId={choicesByElectionId}
                open={expandedRetentionDates.includes(group.date)}
                onOpenChange={(open) => setRetentionOpen(group.date, open)}
              >
                {renderCards(group.retention)}
              </RetentionGroup>
            </div>
          ) : null}
        </section>
      ))}
      {awaitingCandidates.length > 0 ? (
        // Neutral about WHO the wait is on: this section spans every
        // zero-candidate reason, and roster_processing means the list is
        // published and this app is still preparing profiles — "waiting on
        // officials" would misplace that blame. Leads with "Elections" to
        // parallel the "Elections on {date}" headings above it. Collapsed by
        // default: these races have nothing to read or pick yet, and on a
        // long ballot they pushed the real list's end out of sight.
        <ElectionSection
          heading
          label="Elections awaiting candidate information"
          count={awaitingCandidates.length}
          open={awaitingCandidatesOpen}
          onOpenChange={setAwaitingCandidatesOpen}
        >
          {/* No level sections here: this tail spans dates and levels
              under one heading, and a card carries its own date already. */}
          {splitSeatRuns(awaitingCandidates).map((run) => (
            <SeatRun key={run.elections[0].id} district={run.district} count={run.elections.length}>
              {run.elections.map((election) => (
                <ElectionCard
                  key={election.id}
                  election={election}
                  savedAreaWeights={savedAreaWeights}
                  myChoice={choicesByElectionId?.get(election.id)}
                  navState={navState}
                  position={positionById.get(election.id) ?? 1}
                  showDate
                />
              ))}
            </SeatRun>
          ))}
        </ElectionSection>
      ) : null}
    </div>
  );
}

/**
 * A single election card. Deliberately NOT exported: it omits its own date
 * (ElectionList's group heading carries it), so a standalone render would be
 * dateless. Render elections through ElectionList, which is the public API
 * and is shared between the anonymous and saved ballots. savedAreaWeights
 * (verified users with saved research areas) puts the matching area chips
 * first so "affects what I care about" reads at a glance.
 */
function ElectionCard({
  election,
  savedAreaWeights,
  myChoice,
  navState,
  position,
  showDate = false,
  showVotePower = true,
}: {
  election: ElectionSummary;
  savedAreaWeights?: Map<string, ResearchAreaWeight>;
  /** The viewer's planned vote for this election, when they have one. */
  myChoice?: ElectionChoice;
  /** ElectionList's nav context (back destination + contest order),
   * delivered to the election page via the card link's router state. */
  navState?: ElectionNavState;
  /** 1-based slot in the rendered list, for the election_open usage event. */
  position: number;
  /**
   * The "Elections awaiting candidate information" section spans dates under
   * one heading, so its cards must say their own date; everywhere else the
   * group heading carries it.
   */
  showDate?: boolean;
  /** The vote-power section heading supplies this label for grouped cards. */
  showVotePower?: boolean;
}) {
  // Saved matches lead (in the user's rank order), unsaved follow in public-
  // salience order — see splitResearchAreasBySaved. The chips that survive
  // the cap are the areas voters care about most.
  const { saved: savedAreas, others: otherAreas } = splitResearchAreasBySaved(
    election.research_areas,
    savedAreaWeights
  );
  // One cap for the whole row: saved matches lead in the user's rank order and
  // take the slots first, so the top three saved issues show and everything
  // else — further saves included — folds into the overflow count.
  const visibleAreas = [...savedAreas, ...otherAreas].slice(0, MAX_AREA_CHIPS);
  const hiddenAreaCount = election.research_areas.length - visibleAreas.length;
  // The viewer's planned vote, shown only on upcoming races: a past
  // election's choice is history. Withdrawn picks stay visible with a flag —
  // a silent disappearance would read as data loss. Races WITHOUT a pick show
  // nothing: an empty-state badge on every undecided race read as noise, and
  // the absence of a green chip already marks them.
  const isUpcoming = election.election_date >= usLatestLocalDate();
  const choiceLabel = myChoice && isUpcoming ? formatChoiceLabel(myChoice) : null;
  const competitiveness = competitivenessChip(election);
  // The viewer's picked candidate ids, feeding the result chip's
  // "My pick won ✓" marker. Built even on past races — the pick CHIP hides
  // once the election passes (a choice is history), but the marker is the
  // payoff of that history, so it renders regardless of date.
  const myPickCandidateIds =
    myChoice && myChoice.picks.length > 0
      ? new Set(myChoice.picks.map((pick) => pick.candidate_id))
      : undefined;
  // Skip an empty chip row so the card doesn't carry stray spacing when a
  // race has no signals to show.
  const hasSignalChips =
    (election.followed_candidates?.length ?? 0) > 0 ||
    election.current_competitiveness != null ||
    election.historical_competitiveness !== null ||
    election.has_results ||
    choiceLabel !== null;
  return (
    <Link
      to={`/elections/${election.id}`}
      state={navState}
      onClick={() =>
        track("election_open", {
          race_type: election.race_type === "ballot_measure" ? "ballot_measure" : "office",
          vote_power: election.vote_power.label,
          position_bucket: positionBucket(position),
          awaiting: isAwaitingCandidates(election),
        })
      }
      // Faint tint at rest; on hover the border goes brand and the title
      // takes the link color (via group-hover below). The old cue — gray bg
      // one step grayer — was under 2% lightness and read as nothing.
      className="group block rounded-xl border border-line bg-surface p-4 box:p-3 shadow-sm transition hover:border-rausch hover:shadow-md"
    >
      {/* No per-card date: ElectionList's group heading carries it. Vote
          power and roster status sit to the right of the title. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {/* rausch-deep, not -dark: 16-17px semibold needs 4.5:1 on the card's
            tinted bg, and rausch-dark is 4.41:1 there. */}
        <h3 className="text-subheading font-semibold text-ink transition group-hover:text-rausch-deep">
          {election.official_ballot_title}
        </h3>
        {/* Labels wrap separately on narrow screens, never mid-phrase. */}
        <span className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-1">
          {showVotePower && election.vote_power.label !== "unknown" && election.vote_power.label !== "retention" ? (
            // Colored text, not a pill: the tinted badge read as a button.
            <span
              className={`whitespace-nowrap text-sm font-medium ${votePowerBadgeClass(election.vote_power.label)}`}
            >
              My vote power: {formatVotePowerLabel(election.vote_power.label === "very_low" ? "low" : election.vote_power.label)}
            </span>
          ) : null}
          {election.race_type !== "ballot_measure" && election.candidate_count === 0 && election.candidate_roster_status ? (
            <span className="whitespace-nowrap text-sm text-ink-soft">
              {formatRosterStatus(election.candidate_roster_status).short}
            </span>
          ) : null}
        </span>
      </div>
      {/* Always show the district: ballot titles are often generic ("Mayor",
          "Governor", "State Representative"), and the district name is what
          tells the voter WHERE the race is. */}
      <p className="mt-0.5 text-sm text-ink-soft">
        {formatDistrictName(election.district.name)}
        {showDate ? <> · {formatElectionDate(election.election_date)}</> : null}
      </p>
      {hasSignalChips ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {choiceLabel ? (
            // Leads the chip row: the voter's own decision outranks the
            // other signals. Bordered, distinct from the solid
            // followed-candidates chip. A "No" measure pick renders red to
            // match the election page's "A NO vote means" box — a green
            // "My pick: No" read as a contradiction.
            <span
              className={`rounded border px-2 py-0.5 font-medium ${
                myChoice?.measure_position === "no"
                  ? "border-red-700 bg-red-50 text-red-900"
                  : "border-green-700 bg-green-50 text-green-900"
              }`}
            >
              {choiceLabel}
            </span>
          ) : null}
          {election.followed_candidates && election.followed_candidates.length > 0 ? (
            <span className="rounded bg-green-600 px-2 py-0.5 font-medium text-white">
              {election.followed_candidates.map((candidate) => candidate.display_name).join(", ")}{" "}
              {election.followed_candidates.length === 1 ? "is" : "are"} running
            </span>
          ) : null}
          {competitiveness ? (
            <span className="rounded bg-surface px-2 py-0.5 text-ink-soft">{competitiveness.label}</span>
          ) : null}
          {election.has_results ? (
            // Called results get the badge colors from the election page
            // (green = decided forward, red = failed) so the answer stands
            // out from the neutral info chips around it; undecided rows stay
            // neutral so color always means "called".
            <span className={RESULT_CHIP_CLASSES[resultChipTone(election.current_result_outcome)]}>
              {election.current_result_outcome
                ? (() => {
                    const parts = buildResultChipParts(
                      election.current_result_outcome,
                      election.current_result_winners ?? [],
                      myPickCandidateIds
                    );
                    if (parts.winners.length === 0) {
                      return parts.heading;
                    }
                    return (
                      <>
                        {parts.heading} —{" "}
                        {parts.winners.map((winner, index) => (
                          <Fragment key={`${winner.label}-${index}`}>
                            {winner.label}
                            {winner.isMyPick && parts.myPickMarker ? (
                              // Solid pill inside the tinted chip so the
                              // personal payoff outshines the surrounding
                              // roll call. Winner-name matching is id-only,
                              // and a losing pick renders nothing (see
                              // buildResultChipParts). Leading space:
                              // margin is only visual, and without it the
                              // copy/accessible text runs the name into the
                              // marker ("(Democratic)My pick advanced ✓").
                              <>
                                {" "}
                                <span className="whitespace-nowrap rounded bg-green-700 px-1.5 font-semibold text-white">
                                  {parts.myPickMarker}
                                </span>
                              </>
                            ) : null}
                            {index < parts.winners.length - 1 ? ", " : null}
                          </Fragment>
                        ))}
                      </>
                    );
                  })()
                : "Results available"}
            </span>
          ) : null}
        </div>
      ) : null}
      {election.research_areas.length > 0 ? (
        // Visually one comma-separated list: saved matches lead (all of
        // them, in the user's rank order) in semibold, unsaved follow under
        // the cap. Weight is a sighted-only cue, so saved areas carry a
        // screen-reader-only "(saved)" to keep the distinction audible.
        <p className="mt-1.5 text-sm">
          {/* A verb, not a noun phrase: the election is the subject, so the
              row reads "this election affects these things". A noun label
              ("Key issues") left it ambiguous whether the topics were the
              race's subject matter or what it changes. */}
          <span className="font-medium text-ink-soft">Affects:</span>{" "}
          {/* Comma separators live OUTSIDE the area spans as plain text
              nodes, so each span's text stays exactly the area name. */}
          {visibleAreas.map((area, index, all) => (
            <Fragment key={area.id}>
              <span className={savedAreas.includes(area) ? SAVED_AREA_TEXT_CLASS : AREA_TEXT_CLASS}>
                {area.name}
                {savedAreas.includes(area) ? <span className="sr-only"> (saved)</span> : null}
              </span>
              {index < all.length - 1 || hiddenAreaCount > 0 ? ", " : null}
            </Fragment>
          ))}
          {hiddenAreaCount > 0 ? (
            // "issues", matching the row's own label. Same green as the
            // issue names: the overflow count is part of the same list.
            <span className={AREA_TEXT_CLASS}>
              +{hiddenAreaCount} more issue{hiddenAreaCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </p>
      ) : null}
    </Link>
  );
}

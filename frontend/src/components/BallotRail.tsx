import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { BackTo } from "../lib/detailNavContext";
import { track } from "../lib/usage";

/** One contest box on the rail. pickedLabel is the decided answer shown on
 * the collapsed line (the picked name(s), or Yes / No); null or absent =
 * undecided, and the line stays bare. */
export type BallotRailContest = {
  id: string;
  label: string;
  path: string;
  pickedLabel?: string | null;
  /** The heading this contest sits under ("City: Berkeley"); a heading row
   * renders wherever it changes from the previous contest's. Present only
   * under the rail's By-district sort. */
  group?: string;
  /** A judicial retention race: rendered in the rail's own tail under the
   * "Retention races" disclosure heading, after every other contest. */
  retention?: boolean;
};

/** One row inside the open (current) contest box. path absent = a
 * display-only row (a measure's Yes / No). picked absent = a plain row
 * without an oval: the retention judge's name, where the ballot marks Yes
 * or No below rather than the name itself. */
export type BallotRailRow = {
  id: string;
  label: string;
  path?: string;
  state?: unknown;
  picked?: boolean;
  withdrawn?: boolean;
};

// The fill-in oval, same shape and colors as the My Draft ballot's
// (BallotPreview): filled green for a pick, empty otherwise. Decorative —
// the row's sr-only text carries the pick for screen readers.
function Oval({ filled }: { filled: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-3 w-5 shrink-0 rounded-full border-2 ${filled ? "border-green-700 bg-green-700" : "border-ink bg-white"}`}
    />
  );
}

// The "you are here" mark's chevron: trails the one row whose page is on
// the right (the race title on an election page, the candidate's row on a
// candidate page), beside that row's rail-toned tint. Decorative — the row
// carries aria-current.
function HereChevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="ml-auto h-4 w-4 shrink-0 text-ink-soft"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 5l5 5-5 5" />
    </svg>
  );
}

const RAIL_ITEM_CLICK = () =>
  track("detail_control", { control: "rail_item", value: "none" });

/**
 * The desktop split-screen rail drawn as the reader's ballot: one box per
 * contest in the order the list showed, the contest on screen open with
 * its ovals and names, every other contest collapsed to one line that
 * shows the decided answer in green. Picks are made on the detail side;
 * the rail only mirrors them, so filling in happens as the reader decides.
 *
 * Same data contract as DetailPager (which stays for narrow screens, where
 * this rail is display: none): the page builds `contests` from its
 * validated nav state and the rail renders it verbatim, no fetching. The
 * back link doubles as the "leave split screen" control and delivers
 * `backToState` exactly as the pager's back slot does; contest links pass
 * `siblingState` verbatim so a walk down the ballot keeps the whole
 * context chain; row links carry their own state (the candidate page's
 * arrival context).
 *
 * On an election page the current contest is the open box: text, not a
 * link, aria-current on the box. On a candidate page (`currentRowId`) the
 * open box is the candidate's race, its title a link back to that race,
 * and the current candidate is the highlighted row. Whichever is current
 * is scrolled into view on arrival: ballots run to 40+ contests, longer
 * than the rail's own scroll viewport.
 */
export function BallotRail({
  ariaLabel,
  contests,
  currentId,
  currentRowId,
  rows,
  backTo,
  backToState,
  siblingState,
  openContestState,
  openSlot,
  headerSlot,
}: {
  ariaLabel: string;
  contests: BallotRailContest[];
  /** The open contest. */
  currentId: string;
  /** The row that IS the page (a candidate page): that row is highlighted
   * and the open contest's title becomes a link carrying openContestState. */
  currentRowId?: string;
  /** The open contest's rows: candidates, or a measure's Yes / No. */
  rows: BallotRailRow[];
  backTo: BackTo;
  backToState?: unknown;
  siblingState?: unknown;
  openContestState?: unknown;
  /** Rendered inside the open box between its title and rows — the
   * candidate page's roster sort lives here. */
  openSlot?: ReactNode;
  /** Rendered between the back link and the boxes — the rail's race-type
   * tabs and sort live here. The rail stays presentation-only: whatever
   * the slot controls re-slices `contests` in the caller. */
  headerSlot?: ReactNode;
}) {
  const currentRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    // block: "nearest" scrolls only what's needed — the rail's own scroll
    // container when the box is off-screen, nothing when it's visible.
    // Guarded because jsdom elements have no scrollIntoView. Keyed on the
    // current ids ONLY: a slot control reordering `contests` or `rows` must
    // not snap the scroll back to the current box or row.
    if (
      currentRef.current &&
      typeof currentRef.current.scrollIntoView === "function"
    ) {
      currentRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [currentId, currentRowId]);
  const boxIsCurrent = currentRowId === undefined;
  // Retention races: one tail after everything else (sortRailEntries sinks
  // them), under a heading that folds them away — closed by default like
  // the list's retention section, held open while the reader is on one of
  // them (the open box must be visible). Component state, so the choice
  // survives sibling walks (the route element stays mounted).
  const main = contests.filter((contest) => !contest.retention);
  const tail = contests.filter((contest) => contest.retention);
  const [tailOpenChoice, setTailOpenChoice] = useState(false);
  const tailOpen =
    tailOpenChoice || tail.some((contest) => contest.id === currentId);

  const renderBox = (contest: BallotRailContest) =>
    contest.id === currentId ? (
      // The open box: page tone, no right edge, overhanging the column's
      // hairline (see the wrapper comment).
      <li
        key={contest.id}
        ref={boxIsCurrent ? currentRef : undefined}
        aria-current={boxIsCurrent ? "page" : undefined}
        title={contest.label}
        className="-mr-4 rounded-l-lg border-y border-l border-line bg-page"
      >
        {boxIsCurrent ? (
          // rounded-tl-lg: the tint must not poke past the box's own corner.
          <p className="flex items-center gap-2 rounded-tl-lg bg-rail px-3 py-1.5 text-sm font-semibold leading-snug text-ink">
            <span className="min-w-0">{contest.label}</span>
            <HereChevron />
          </p>
        ) : (
          <Link
            to={contest.path}
            state={openContestState}
            onClick={RAIL_ITEM_CLICK}
            className="block px-3 py-1.5 text-sm font-semibold leading-snug text-ink transition hover:text-rausch"
          >
            {contest.label}
          </Link>
        )}
        {openSlot ? (
          <div className="border-t border-line px-3 py-1.5">{openSlot}</div>
        ) : null}
        {rows.length > 0 ? (
          <ul>
            {rows.map((row) => (
              <li
                key={row.id}
                ref={row.id === currentRowId ? currentRef : undefined}
                aria-current={row.id === currentRowId ? "page" : undefined}
                title={row.label}
                // The current candidate: the column's own tone inside the
                // page-toned box, plus weight — the box itself is the
                // connected element, so the row needs only a quiet mark.
                className={`flex items-center gap-2 border-t border-line px-3 py-1.5 text-sm ${
                  row.id === currentRowId ? "bg-rail font-semibold" : ""
                }`}
              >
                {row.picked !== undefined ? <Oval filled={row.picked} /> : null}
                {row.path && row.id !== currentRowId ? (
                  <Link
                    to={row.path}
                    state={row.state}
                    onClick={RAIL_ITEM_CLICK}
                    className={`min-w-0 truncate transition hover:text-rausch ${
                      row.withdrawn
                        ? "text-ink-soft line-through"
                        : row.picked
                          ? "font-bold text-ink"
                          : "text-ink"
                    }`}
                  >
                    {row.label}
                  </Link>
                ) : (
                  <span
                    className={`min-w-0 truncate ${row.picked ? "font-bold text-ink" : "text-ink"}`}
                  >
                    {row.label}
                  </span>
                )}
                {row.picked ? (
                  <span className="sr-only"> (my pick)</span>
                ) : null}
                {row.id === currentRowId ? <HereChevron /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t border-line px-3 py-1.5 text-xs text-ink-soft">
            Candidate list not final.
          </p>
        )}
      </li>
    ) : (
      <li key={contest.id}>
        <Link
          to={contest.path}
          state={siblingState}
          title={contest.label}
          onClick={RAIL_ITEM_CLICK}
          className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft transition hover:border-rausch hover:text-ink"
        >
          <span className="min-w-0 flex-1 truncate">{contest.label}</span>
          {contest.pickedLabel ? (
            <>
              {/* Suffix, not prefix: the title must stay the leading text
                  of the accessible name so lines read (and match queries)
                  by their race title first. */}
              <span className="sr-only">, my pick:</span>
              <span className="max-w-[55%] shrink-0 truncate font-semibold text-green-900">
                {contest.pickedLabel}
              </span>
            </>
          ) : null}
        </Link>
      </li>
    );

  return (
    // The connected-tab layout: the rail column sits on the deeper rail
    // tone with a hairline at its right edge (the ::after), and the open
    // box takes the page tone and runs 1rem past the column — over that
    // hairline (the nav's z-10 lifts it above the pseudo-element) — so the
    // box and the detail read as one continuous surface. That join is the
    // whole "you are here" cue; no accent color needed, which sidesteps
    // the partisan read of blue/red on election content. The column is the
    // grid cell (full page height), the nav inside it sticks and scrolls
    // on its own; hidden below the rail breakpoint, where the pager bar
    // takes over. The 1rem overhang lives inside the nav's padding box
    // (pr-4) so its overflow clipping never cuts the box.
    <div className="relative -mr-4 hidden rounded-l-2xl bg-rail after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-line rail:block">
      <nav
        aria-label={ariaLabel}
        className="sticky top-0 z-10 max-h-screen min-w-0 scrollbar-none overflow-y-auto pb-4 pl-3 pr-4 pt-4"
      >
        <Link
          to={backTo.path}
          state={backToState}
          aria-label={`Back to ${backTo.label}`}
          title={backTo.label}
          onClick={() =>
            track("detail_control", { control: "pager_back", value: "none" })
          }
          className="block truncate text-sm font-medium text-ink transition hover:text-rausch"
        >
          <span aria-hidden="true">← </span>
          {backTo.label}
        </Link>
        {headerSlot ? (
          <div className="mt-3 border-t border-line pt-3">{headerSlot}</div>
        ) : null}
        <ol
          className={`mt-3 space-y-1.5 ${headerSlot ? "" : "border-t border-line pt-3"}`}
        >
          {main.map((contest, index) => [
            contest.group !== undefined &&
            contest.group !== main[index - 1]?.group ? (
              <li
                key={`heading:${contest.id}`}
                className={index > 0 ? "pt-2" : ""}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                  {contest.group}
                </p>
              </li>
            ) : null,
            renderBox(contest),
          ])}
        </ol>
        {tail.length > 0 ? (
          <>
            {/* The tail's heading is the fold control: same size and case as
                the district headings, chevron trailing (points right closed,
                down open — the list's convention). The lines under it stay
                ordinary rail lines; only the heading toggles. */}
            <button
              type="button"
              aria-expanded={tailOpen}
              aria-controls="ballot-rail-retention"
              onClick={() => {
                track("detail_control", {
                  control: "rail_retention",
                  value: tailOpen ? "close" : "open",
                });
                setTailOpenChoice(!tailOpen);
              }}
              className="mt-3 flex w-full items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide text-ink-soft transition hover:text-ink"
            >
              Retention races{" "}
              <span className="font-normal normal-case">({tail.length})</span>
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className={`h-4 w-4 shrink-0 transition-transform ${tailOpen ? "rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 5l5 5-5 5" />
              </svg>
            </button>
            {tailOpen ? (
              <ol id="ballot-rail-retention" className="mt-1.5 space-y-1.5">
                {tail.map((contest) => renderBox(contest))}
              </ol>
            ) : null}
          </>
        ) : null}
        <p className="mt-3 text-xs text-ink-soft">Not an official ballot.</p>
      </nav>
    </div>
  );
}

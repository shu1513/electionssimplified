import type { BallotRaceType } from "@voteapp/api-client";

// UI words, not wire words: "Offices" matches official sample-ballot
// vocabulary (ballots segment "Offices" and "Measures") and, unlike
// "Candidates", cannot be misread as a list of people. "Ballot Measures"
// is the nationally neutral term — "Propositions" is regional (CA/AZ;
// other states say Questions, Amendments, Issues) and the election page
// heading already says "Ballot Measure".
const TABS: { value: BallotRaceType | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "office", label: "Offices" },
  { value: "ballot_measure", label: "Ballot Measures" },
];

/**
 * The ballot pages' race-type view switch. The pages render it only when
 * deriveBallotFilters offers it (both race types present — a single-type
 * ballot has nothing to switch between). A view switch, not a filter: the
 * races the tab puts aside are on the other, visibly-labeled tab rather
 * than "hidden".
 *
 * Toggle buttons (aria-pressed), not ARIA tabs: the switch re-slices one
 * list in place — there are no separate tab panels to move focus between.
 */
export function RaceTypeTabs({
  raceType,
  onChange,
  compact = false,
}: {
  raceType: BallotRaceType | null;
  onChange: (raceType: BallotRaceType | null) => void;
  /** Tighter type and padding for narrow homes (the 18rem detail rail). */
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Race type"
      // Compact (the rail): shrink to the tabs — a full-width box left a
      // blank run after "Ballot Measures" — and sit a hair shorter.
      className={`flex-wrap items-center rounded-md border border-line bg-white ${
        compact ? "inline-flex gap-0.5 self-start p-0.5" : "flex gap-1 p-1"
      }`}
    >
      {TABS.map((tab) => {
        const selected = raceType === tab.value;
        return (
          <button
            key={tab.label}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(tab.value)}
            className={`rounded transition ${compact ? "min-h-[22px] px-2 py-0 text-xs" : "px-2.5 py-1 text-sm"} ${
              selected ? "bg-ink font-medium text-white" : "text-ink-soft hover:bg-surface hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

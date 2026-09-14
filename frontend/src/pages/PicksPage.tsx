import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  apiRequest,
  formatElectionDate,
  splitRetentionRaces,
  useElectionChoices,
  useMe,
  useMintPickCardShare,
  useMyPickCardShares,
} from "@voteapp/api-client";
import type { AutoPickElectionResult, BallotSummary, ElectionChoice, ElectionSummary } from "@voteapp/api-client";
import { AutoPickFillControl, reasonLabel } from "../components/AutoPickFillControl";
import { RemoveStrandedPickButton } from "../components/ElectionChoiceControls";
import { BallotPreviewSheets, BallotViewToggle } from "../components/BallotPreview";
import { RetentionGroup } from "../components/ElectionCard";
import { DraftMembershipCta } from "../components/DraftMembershipCta";
import { DraftMilestone } from "../components/DraftMilestone";
import { allRacesDecided } from "../lib/ballotDraft";
import { useShowDraftMilestone } from "../lib/useShowDraftMilestone";
import { ErrorNotice, LoadingNotice } from "../components/Status";
import type { CandidateNavState, ElectionNavState } from "../lib/detailNavContext";
import { ShareButton } from "../components/ShareButton";
import { VerifyPrompt } from "../components/VerifyPrompt";
import { SITE_ORIGIN } from "../lib/pageMeta";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";
import { countBucket, track } from "../lib/usage";

// My Picks (the header calls it "My Draft" until the nearest election day is
// fully decided): the pick cards — fight-card view of each upcoming election
// day: what's on the ballot, who I picked, what's still undecided. Followed
// candidates live on /me/follows and the ranked issue editor on Settings,
// each restored to its own home after a stint on this page.

// Election links on this page hand the election page its back destination.
// No contest list: these cards are pick summaries, not a ballot sequence.
const PICKS_NAV_STATE: ElectionNavState = {
  backTo: { path: "/me/picks", label: "My Election Draft" },
};

// One race row on a date card. "Pick chips" per candidate so a multi-seat
// race reads name-by-name, with the outcome carried per candidacy. The
// certified writer projects advanced/runoff onto winners (everyone else
// becomes lost), so all five terminal statuses need a chip — a certified
// "advanced" with no chip would read as no outcome at all once the race
// leaves the carded window and the result fallback with it. Labels match
// the election page's badges (Won / Advanced / In runoff / Lost). Each chip
// leads with a real space: margin is only visual, and without the space the
// copy/accessible text runs the name into the label ("Jane SmithWon").
function pickStatusChip(status: string) {
  if (status === "won" || status === "advanced" || status === "runoff") {
    return (
      <>
        {" "}
        <span className="rounded bg-green-700 px-1.5 py-0.5 text-xs font-semibold text-white">
          {status === "won" ? "Won" : status === "advanced" ? "Advanced" : "In runoff"}
        </span>
      </>
    );
  }
  if (status === "lost") {
    return (
      <>
        {" "}
        <span className="rounded bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-soft">Lost</span>
      </>
    );
  }
  if (status === "withdrawn") {
    return (
      <>
        {" "}
        <span className="text-xs text-ink-soft">(withdrew)</span>
      </>
    );
  }
  return null;
}

// Outcome chip for a measure pick — the measure counterpart of the won/lost
// candidacy chips. The word states the FACT ("Passed"/"Failed"); the color
// says how it landed for the owner, mirroring Won-green/Lost-muted: green
// when the outcome matches their vote, muted when it went the other way.
// Anything but the writer's two canonical values (including a pre-field
// backend during deploy skew) renders nothing. Mirrored on the public card
// page.
function measureOutcomeChip(position: "yes" | "no", result: string | null | undefined) {
  if (result !== "passed" && result !== "failed") {
    return null;
  }
  const matchedPick = (result === "passed") === (position === "yes");
  const label = result === "passed" ? "Passed" : "Failed";
  return (
    <>
      {" "}
      {matchedPick ? (
        <span className="rounded bg-green-700 px-1.5 py-0.5 text-xs font-semibold text-white">{label}</span>
      ) : (
        <span className="rounded bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-soft">{label}</span>
      )}
    </>
  );
}

// Result-derived chip for a pick the candidacy pipeline hasn't labeled yet:
// election-night calls arrive as result rows (outcome + winner ids) long
// before candidate_elections.status flips to won/lost. Id-only matching and
// decisive outcomes only, the same conservatism as the ballot card's
// "My pick won ✓" marker — and the same silence when the pick isn't among
// the winners: the card announces the payoff, it doesn't rub in the loss.
function pickResultChip(
  outcome: string | null | undefined,
  winners: readonly { candidate_id?: string }[] | undefined,
  candidateId: string
) {
  if (outcome !== "won" && outcome !== "advanced" && outcome !== "runoff") {
    return null;
  }
  if (!(winners ?? []).some((winner) => winner.candidate_id === candidateId)) {
    return null;
  }
  // Same vocabulary as the election page's badges and pickStatusChip: a
  // runoff berth is its own state, not a generic "Advanced".
  return (
    <>
      {" "}
      <span className="rounded bg-green-700 px-1.5 py-0.5 text-xs font-semibold text-white">
        {outcome === "won" ? "Won" : outcome === "advanced" ? "Advanced" : "In runoff"}
      </span>
    </>
  );
}

// Marks a row the auto-pick engine wrote (origin = 'auto'); a manual re-pick
// clears it. Leading space for the same copy/a11y reason as the other chips.
function autoChip() {
  return (
    <>
      {" "}
      <span
        title="Picked for you from your ranked issues"
        className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-soft"
      >
        Auto
      </span>
    </>
  );
}

function PickedLine({
  choice,
  election,
  navState = PICKS_NAV_STATE,
}: {
  choice: ElectionChoice;
  election?: ElectionSummary;
  navState?: ElectionNavState;
}) {
  // The canonical result reaches this line two ways: via the ballot summary
  // while the race is still carded, and via the choice itself afterwards
  // (attached on the choices list read) — so PastPicks keeps showing an
  // election-night call during the weeks before certification.
  const resultOutcome = election?.current_result_outcome ?? choice.current_result_outcome;
  const resultWinners = election?.current_result_winners ?? choice.current_result_winners;
  if (choice.measure_position !== null) {
    return (
      <span className={choice.measure_position === "yes" ? "font-semibold text-green-900" : "font-semibold text-red-900"}>
        {choice.measure_position === "yes" ? "Yes" : "No"}
        {/* Certified measure result first; before it lands, the canonical
            result row's election-night passed/failed fills in. Anything
            else (too_close, unknown) renders nothing, as the chip demands. */}
        {measureOutcomeChip(choice.measure_position, choice.measure_result ?? resultOutcome)}
        {choice.measure_origin === "auto" ? autoChip() : null}
      </span>
    );
  }
  return (
    <span className="font-semibold text-green-900">
      {choice.picks.map((pick, index) => (
        <span key={pick.candidate_id}>
          {index > 0 ? ", " : null}
          {/* Same destination as the election page's roster: the pick IS the
              candidate, so the name goes to their profile. Back link comes
              from this page's own nav state; electionId scopes the profile's
              candidacy context to this race. */}
          <Link
            to={`/candidates/${pick.candidate_id}`}
            state={{ backTo: navState.backTo, electionId: choice.election_id } satisfies CandidateNavState}
            className="hover:text-rausch"
          >
            {pick.display_name}
          </Link>
          {/* candidacy_status (certified won/lost, withdrawn) outranks the
              result-derived chip — never both. */}
          {pickStatusChip(pick.candidacy_status) ??
            pickResultChip(resultOutcome, resultWinners, pick.candidate_id)}
          {pick.origin === "auto" ? autoChip() : null}
          {/* A withdrawn pick on an upcoming race is otherwise unremovable:
              the election page's roster no longer lists the candidacy, yet
              the pick still counts toward the seat cap. Date-gated because
              the backend rejects writes to past elections, and guest-safe
              by construction — draft rows never carry "withdrawn". */}
          {pick.candidacy_status === "withdrawn" && choice.election_date >= usLatestLocalDate() ? (
            <>
              {" "}
              <RemoveStrandedPickButton
                electionId={choice.election_id}
                candidateId={pick.candidate_id}
                candidateName={pick.display_name}
                raceTitle={choice.official_ballot_title}
                electionDate={choice.election_date}
                seatsToFill={choice.seats_to_fill}
              />
            </>
          ) : null}
        </span>
      ))}
    </span>
  );
}

// The label-worthiness rule ElectionCard uses: a choice whose only pick lost
// its candidate (deleted/merged) renders nothing and counts as undecided.
function hasRenderablePick(choice: ElectionChoice | undefined): choice is ElectionChoice {
  return choice !== undefined && (choice.picks.length > 0 || choice.measure_position !== null);
}

// canMint controls creation; an existing link remains visible even without picks.
function ShareCardControl({ electionDate, canMint }: { electionDate: string; canMint: boolean }) {
  // Every date card renders its own "Share"; sighted users read the card
  // heading for context, but a screen reader's button list needs the date
  // in the name itself. Same label on both control shapes (mint button,
  // then ShareButton) so the control keeps one identity across the swap.
  const shareLabel = `Share my ${formatElectionDate(electionDate)} picks`;
  const { shares } = useMyPickCardShares();
  const mint = useMintPickCardShare();
  // The server's list is the only truth: a link minted on another device or
  // before a reload shows here, and a revoke from
  // another tab takes effect on the next refetch. The mint hook writes its
  // result into that same list, so no mutation state is consulted here — a
  // stale mint result would otherwise resurrect a dead link.
  const token = shares?.find((share) => share.election_date === electionDate)?.token ?? null;

  if (token) {
    const path = `/picks/${token}`;
    return (
      <span className="flex flex-wrap items-center gap-2">
        {/* The minted URL is the deliverable — it renders here, visibly,
            the moment it exists. The anchor opens the public card so the sharer can see exactly
            what recipients will.

            href is deliberately the RELATIVE path while the text shows the
            canonical host: the token only exists in the environment that
            minted it, so an absolute SITE_ORIGIN href would 404 from dev or
            staging, while in production the two are the same page anyway.
            The protocol is trimmed from the display only. */}
        <a
          href={path}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-xs text-ink underline hover:text-rausch"
        >
          {`${SITE_ORIGIN.replace(/^https?:\/\//, "")}${path}`}
        </a>
        {/* pageMeta on the public page supplies the og card; ShareButton
            handles native share / copy / X / Facebook / WhatsApp / email. */}
        <ShareButton
          path={path}
          shareText={`My ${formatElectionDate(electionDate)} election picks`}
          affirmative
          ariaLabel={shareLabel}
        />
      </span>
    );
  }
  if (!canMint) {
    return null;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={mint.isPending}
        onClick={() => mint.mutate(electionDate)}
        aria-label={shareLabel}
        className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink transition hover:border-ink disabled:opacity-50"
      >
        {mint.isPending ? "…" : "Share"}
      </button>
      {mint.isError ? (
        <span role="alert" className="text-xs font-medium text-red-800">
          Couldn't create the share link — try again.
        </span>
      ) : null}
    </span>
  );
}

// One line for the whole fill run, instead of "auto pick: …" on every row the
// engine left open (34 races → 30 identical notes was clutter). Counts what
// landed and groups the open rows by reason; skipped_existing rows (already
// decided by hand) are not the run's story. Per-race detail stays on each
// election page's panel.
function autoFillSummary(results: Map<string, AutoPickElectionResult>): string | null {
  const all = [...results.values()];
  const picked = all.filter((result) => result.outcome === "picked").length;
  const open = all.filter((result) => result.outcome === "no_pick");
  if (picked === 0 && open.length === 0) {
    return null;
  }
  const byReason = new Map<string, number>();
  for (const result of open) {
    const label = reasonLabel(result.reason);
    byReason.set(label, (byReason.get(label) ?? 0) + 1);
  }
  const reasons = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => (byReason.size > 1 ? `${label} (${count})` : label))
    .join(", ");
  const parts = [`Auto-fill picked ${picked} race${picked === 1 ? "" : "s"}`];
  if (open.length > 0) {
    parts.push(`${open.length} left open: ${reasons}`);
  }
  return parts.join(" · ");
}

// Exported for the guest /draft page, which renders the same card from the
// localStorage ballot draft: share off (the share API is account-only and
// the card would leak a mintable URL promise it can't keep), and its own
// back-link state so races return to /draft, not /me/picks.
export function PickDateCard({
  date,
  elections,
  choiceByElectionId,
  share = true,
  navState = PICKS_NAV_STATE,
  retentionOpen,
  onRetentionOpenChange,
  autoPickChoices,
  autoResults,
  onAutoResults,
}: {
  date: string;
  elections: ElectionSummary[];
  choiceByElectionId: Map<string, ElectionChoice> | undefined;
  share?: boolean;
  navState?: ElectionNavState;
  retentionOpen?: boolean;
  onRetentionOpenChange?: (open: boolean) => void;
  /** All stored choices; presence turns on this card's auto-pick controls
   * (My Picks only — the guest draft page reuses the card without them). */
  autoPickChoices?: ElectionChoice[];
  /** This date's last fill run, keyed by election id — feeds the one-line
   * run summary and the partial-tie note below. Lives in PicksPage (not
   * here) so the ballot view shares it and a view toggle doesn't discard
   * it. */
  autoResults?: Map<string, AutoPickElectionResult> | null;
  onAutoResults?: (byElectionId: Map<string, AutoPickElectionResult> | null) => void;
}) {
  const { contested, retention } = splitRetentionRaces(elections);
  const pickedCount = contested.filter((election) =>
    hasRenderablePick(choiceByElectionId?.get(election.id))
  ).length;
  // Cards outlive their election day (the ballot keeps finished races for a
  // few days so results can land on them); once the date passes, "no pick
  // yet" would invite an action that's no longer possible.
  const isPast = date < usLatestLocalDate();
  const raceNoun = `race${contested.length === 1 ? "" : "s"}`;
  const progressLabel = `${pickedCount} of ${contested.length} ${raceNoun} decided`;
  const progressPercent = contested.length === 0 ? 0 : Math.round((pickedCount / contested.length) * 100);
  const summary = autoResults ? autoFillSummary(autoResults) : null;
  const renderRows = (races: ElectionSummary[]) => races.map((election) => {
    const choice = choiceByElectionId?.get(election.id);
    const autoResult = autoResults?.get(election.id);
    const decided = hasRenderablePick(choice);
    return (
      <li key={election.id} className="grid gap-x-6 border-b border-line/60 py-2 text-sm sm:grid-cols-2">
        <div className="min-w-0 font-[430]">
          {/* Undecided rows carry "no pick yet" for screen readers
              only: sighted users read the empty pick column. */}
          <Link
            to={`/elections/${election.id}`}
            state={navState}
            aria-label={
              decided ? undefined : `${election.official_ballot_title} — ${isPast ? "no pick" : "no pick yet"}`
            }
            className="text-ink hover:text-rausch"
          >
            {election.official_ballot_title}
          </Link>
        </div>
        <div className="min-w-0">
          {decided ? (
            <>
              <PickedLine choice={choice} election={election} navState={navState} />
              {autoResult?.outcome === "picked" &&
              autoResult.reason === "tie" &&
              (choice?.picks.length ?? 0) < (choice?.seats_to_fill ?? 1) ? (
                // Partial fill: some seats landed, the rest tied. Gated
                // on a live vacancy so the note retires the moment the
                // user fills the remaining seats by hand.
                <span className="text-xs text-ink-soft"> · remaining seats tied — your call</span>
              ) : null}
            </>
          ) : null}
        </div>
      </li>
    );
  });
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Date only: the page h1 already says "My Election Draft". */}
        <h3 className="text-heading font-semibold text-ink">{formatElectionDate(date)}</h3>
        {/* Mint-on-demand: no share row (and no live public URL) exists until
            the user asks for one. The mint button hides while the card has
            zero picks (the backend refuses to mint for an empty card), but a
            link minted earlier still shows. */}
        {share ? (
          <ShareCardControl
            electionDate={date}
            canMint={elections.some((election) => hasRenderablePick(choiceByElectionId?.get(election.id)))}
          />
        ) : null}
      </div>
      {/* Progress bar + "N / M" instead of a grey sentence: the count is a
          status, and a bar is the shape people already read as one. The
          full sentence stays as the bar's accessible name. Green = the
          "decided" color the pick names and Won chips already use. */}
      {contested.length > 0 ? (
        <div className="mt-2 flex items-center gap-3">
          <div
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={0}
            aria-valuemax={contested.length}
            aria-valuenow={pickedCount}
            className="h-2 flex-1 overflow-hidden rounded-full bg-line/70"
          >
            <div className="h-full rounded-full bg-green-700" style={{ width: `${progressPercent}%` }} />
          </div>
          <span className="text-sm font-semibold tabular-nums text-ink">
            {pickedCount} / {contested.length}
          </span>
        </div>
      ) : null}
      {autoPickChoices !== undefined && !isPast ? (
        <AutoPickFillControl
          date={date}
          elections={elections}
          choices={autoPickChoices}
          choiceByElectionId={choiceByElectionId}
          onResults={onAutoResults}
        />
      ) : null}
      {summary !== null ? (
        <p role="status" className="mt-2 text-xs text-ink-soft">
          {summary}
        </p>
      ) : null}
      {/* Two aligned columns, race | my pick (a grid, not a table: no cell
          borders, just hairline row dividers). Long titles wrap inside
          their column; the pick stays aligned on the right. Below sm the
          columns stack so a phone reads title-over-pick. */}
      <div
        aria-hidden="true"
        className="mt-3 hidden gap-x-6 border-b border-line pb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft sm:grid sm:grid-cols-2"
      >
        <span>Race</span>
        <span>My pick</span>
      </div>
      <ul className="mt-3 border-t border-line sm:mt-0 sm:border-t-0">
        {renderRows(contested)}
      </ul>
      {retention.length > 0 ? (
        <div className="mt-3">
          <RetentionGroup
            elections={retention}
            choicesByElectionId={choiceByElectionId}
            showProgress
            open={retentionOpen}
            onOpenChange={onRetentionOpenChange}
          >
            <ul>{renderRows(retention)}</ul>
          </RetentionGroup>
        </div>
      ) : null}
    </section>
  );
}

// Upcoming picks the date cards do NOT show, from the choices payload alone
// (it carries title + date, like PastPicks below). The choice API accepts a
// pick on ANY upcoming race with a valid candidacy — via candidate search, a
// shared link, or before an address change — while the cards render only the
// saved ballot, so without this section such a pick would silently vanish
// from the page that claims to list "My Election Draft". Also the whole list
// for the unverified render, where no ballot loads and nothing is carded.
function UpcomingUncardedPicks({
  title,
  choices,
  today,
  cardedElectionIds,
}: {
  title: string;
  choices: ElectionChoice[];
  today: string;
  cardedElectionIds: Set<string>;
}) {
  const upcoming = choices
    .filter((choice) => choice.election_date >= today && !cardedElectionIds.has(choice.election_id))
    .filter((choice) => choice.picks.length > 0 || choice.measure_position !== null)
    // Soonest first — the reverse of PastPicks: what's next matters most.
    .sort((a, b) => (a.election_date < b.election_date ? -1 : a.election_date > b.election_date ? 1 : 0));
  if (upcoming.length === 0) {
    return null;
  }
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">{title}</h2>
      <ul className="mt-3 space-y-2">
        {upcoming.map((choice) => (
          <li key={choice.election_id} className="text-sm">
            <span className="text-ink-soft">{formatElectionDate(choice.election_date)} · </span>
            <Link to={`/elections/${choice.election_id}`} state={PICKS_NAV_STATE} className="text-ink hover:text-rausch">
              {choice.official_ballot_title}
            </Link>
            <span className="text-ink-soft"> — </span>
            <PickedLine choice={choice} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Past picks come from the choices payload alone (it carries title + date),
// not the ballot: the saved ballot only keeps recently finished elections,
// while picks history should survive indefinitely. Races still carded above
// (the ballot's just-finished window) are excluded — their picks are already
// on display, with results; they fall in here when the ballot drops them.
function PastPicks({
  choices,
  today,
  cardedElectionIds,
}: {
  choices: ElectionChoice[];
  today: string;
  cardedElectionIds: Set<string>;
}) {
  const past = choices
    .filter((choice) => choice.election_date < today && !cardedElectionIds.has(choice.election_id))
    .filter((choice) => choice.picks.length > 0 || choice.measure_position !== null)
    .sort((a, b) => (a.election_date < b.election_date ? 1 : a.election_date > b.election_date ? -1 : 0));
  if (past.length === 0) {
    return null;
  }
  return (
    <details className="mt-4">
      <summary className="cursor-pointer select-none text-sm font-medium text-ink-soft hover:text-ink">
        Past elections ({past.length})
      </summary>
      <ul className="mt-3 space-y-2">
        {past.map((choice) => (
          <li key={choice.election_id} className="text-sm">
            <span className="text-ink-soft">{formatElectionDate(choice.election_date)} · </span>
            <Link to={`/elections/${choice.election_id}`} state={PICKS_NAV_STATE} className="text-ink hover:text-rausch">
              {choice.official_ballot_title}
            </Link>
            <span className="text-ink-soft"> — </span>
            <PickedLine choice={choice} />
          </li>
        ))}
      </ul>
    </details>
  );
}

// Live share links whose date has no card on this page: the election dropped
// off the ballot, the address changed, or (unverified) no ballot loads at
// all. The public URL keeps serving — results, and the owner's first name —
// so the owner needs a way back to it. Dates WITH a card carry their own
// control inside the card; listing those here too would show one link twice.
function SharedLinks({ cardedDates }: { cardedDates: Set<string> }) {
  const { shares } = useMyPickCardShares();
  const uncarded = (shares ?? []).filter((share) => !cardedDates.has(share.election_date));
  if (uncarded.length === 0) {
    return null;
  }
  return (
    <details className="mt-4">
      <summary className="cursor-pointer select-none text-sm font-medium text-ink-soft hover:text-ink">
        Shared links ({uncarded.length})
      </summary>
      <ul className="mt-3 space-y-3">
        {uncarded.map((share) => (
          <li key={share.election_date} className="text-sm">
            <span className="text-ink-soft">{formatElectionDate(share.election_date)} · </span>
            <ShareCardControl electionDate={share.election_date} canMint={false} />
          </li>
        ))}
      </ul>
    </details>
  );
}

// The logged-out wall, its own component so the signup_prompt "shown" usage
// event rides a mount effect (no hooks after PicksPage's early returns).
function PicksLoginWall() {
  useEffect(() => {
    track("signup_prompt", { source: "picks_wall", action: "shown" });
  }, []);
  return (
    <div className="mx-auto max-w-md px-4 py-10 text-center">
      <p className="text-ink-soft">Log in to plan your votes and manage the candidates you follow.</p>
      <p className="mt-4">
        <Link
          to="/login"
          onClick={() => track("signup_prompt", { source: "picks_wall", action: "click" })}
          className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
        >
          Log in
        </Link>
      </p>
    </div>
  );
}

export function PicksPage() {
  useDocumentTitle("My Election Draft");
  const { me, isLoading } = useMe();
  const verified = me?.email_verified === true;
  const [view, setView] = useState<"list" | "ballot">("list");
  const {
    choices,
    choiceByElectionId,
    isLoading: choicesLoading,
    isError: choicesError,
  } = useElectionChoices();
  // ONE payload for both of THIS PAGE's views, in paper-ballot contest order
  // (explicit sort + followed_first so the user's saved list preferences
  // never apply here): the date cards take within-date order from it and the
  // ballot sheets render it as-is, so List and Ballot view can never
  // disagree — and when curated county placements land (ballot-facsimile
  // Phase 3) both views inherit them at once. Deliberately NOT the
  // ["me", "ballot"] key: the saved ballot page owns that key with the
  // user's saved sort. The nav's pick counter (usePickProgress) rides this
  // same key and url, so a cold load of /me/picks is one shared request.
  const ballot = useQuery({
    queryKey: ["me", "ballot", "preview"],
    queryFn: () =>
      apiRequest<BallotSummary>("/api/me/ballot?include=preview&sort=state_baseline&followed_first=false"),
    enabled: verified,
    retry: false,
  });

  // Fill-run results per election date, shared by both views: the list
  // cards annotate their race rows from it and the ballot sheets annotate
  // their contest boxes, so running a fill in one view and toggling to the
  // other keeps the "why was this left open" feedback (see PR #796 review).
  // Above the early returns — hooks must run on every render.
  const [autoResultsByDate, setAutoResultsByDate] = useState<
    Map<string, Map<string, AutoPickElectionResult>>
  >(() => new Map());
  const handleAutoResults = (date: string) => (byElectionId: Map<string, AutoPickElectionResult> | null) => {
    setAutoResultsByDate((previous) => {
      const next = new Map(previous);
      if (byElectionId === null) {
        next.delete(date);
      } else {
        next.set(date, byElectionId);
      }
      return next;
    });
  };

  // draft_review once per settled load with something to review — above the
  // early returns, like the state above.
  const reviewablePicks = (choices ?? []).filter(hasRenderablePick).length;
  const choicesReadyForUsage = choiceByElectionId !== undefined;
  useEffect(() => {
    if (!ballot.isSuccess || !choicesReadyForUsage || reviewablePicks === 0) {
      return;
    }
    track("draft_review", { pick_count_bucket: countBucket(reviewablePicks), view, store: "account" });
    // Fires per settled payload, not per pick or view change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ballot.data, choicesReadyForUsage]);

  const today = usLatestLocalDate();
  // Strict date grouping: cards are "everything you face on this day", and
  // within a day the payload's ballot order stands as-is. No date filter of our own: the ballot
  // payload already keeps just-finished elections for a few days
  // (BALLOT_PAST_ELECTION_VISIBILITY_DAYS), and the card should live exactly
  // as long — results land right on it before it retires to Past elections.
  // Computed above the early returns because the milestone hook below needs
  // the nearest upcoming day on every render.
  const byDate = new Map<string, ElectionSummary[]>();
  for (const election of ballot.data?.elections ?? []) {
    const group = byDate.get(election.election_date) ?? [];
    group.push(election);
    byDate.set(election.election_date, group);
  }
  const dates = [...byDate.keys()].sort();
  // Nearest UPCOMING day, not dates[0]: cards keep just-finished days for a
  // few days, and a finished day has nothing left to celebrate.
  const nearestUpcomingDate = dates.find((date) => date >= today);
  const cardedElectionIds = new Set((ballot.data?.elections ?? []).map((election) => election.id));
  // The finish-line box and the honorary-member ask share ONE moment: the
  // first visit after every race on the nearest day is decided, once per
  // day per browser (owner's rule: persistent = nag).
  const nearestRaces = splitRetentionRaces(byDate.get(nearestUpcomingDate ?? "") ?? []);
  const nearestComplete =
    nearestUpcomingDate !== undefined && allRacesDecided(nearestRaces.contested, choiceByElectionId);
  const milestoneShown = useShowDraftMilestone(nearestUpcomingDate, nearestComplete);

  if (isLoading || me === undefined) {
    return <LoadingNotice text="Loading…" />;
  }
  if (me === null) {
    return <PicksLoginWall />;
  }
  if (!me.email_verified) {
    // The verify wall must not hide the picks themselves: the choice API
    // deliberately accepts any registered session (see apiServer's
    // election-choices route), so a just-saved pick has to be visible here
    // — only the address-derived ballot views stay verified-gated. Nothing
    // is carded (the ballot query never ran), so the upcoming section
    // lists every decided choice.
    const unverifiedToday = usLatestLocalDate();
    const nothingCarded = new Set<string>();
    return (
      <>
        <VerifyPrompt email={me.email} />
        <div className="mx-auto max-w-md px-4 pb-10">
          <UpcomingUncardedPicks
            title="Your upcoming picks"
            choices={choices ?? []}
            today={unverifiedToday}
            cardedElectionIds={nothingCarded}
          />
          <PastPicks choices={choices ?? []} today={unverifiedToday} cardedElectionIds={nothingCarded} />
          {/* No cards here, so every live link lists — the share API is not
              verification-gated. */}
          <SharedLinks cardedDates={new Set()} />
        </div>
      </>
    );
  }

  // Cards are meaningless without the choices: rendering them from an
  // unloaded map claims "no pick yet" on races the user already decided
  // (same no-flash rule ElectionCard documents for its chip). One reveal:
  // nothing below the heading until BOTH queries settle, and no cards at
  // all when the choices fetch failed — a visible error beats confidently
  // wrong "0 of N decided" cards.
  const choicesReady = choiceByElectionId !== undefined;
  const picksSettled = ballot.isSuccess && choicesReady;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <section>
        <h1 className="text-title font-bold">My Election Draft{dates.length > 1 ? "s" : ""}</h1>
        {ballot.isPending || (choicesLoading && !choicesError) ? (
          <LoadingNotice text="Loading your elections…" />
        ) : null}
        {ballot.isError ? (
          <div className="mt-4">
            <ErrorNotice error={ballot.error} />
          </div>
        ) : null}
        {choicesError ? (
          // Not ErrorNotice: it renders generic copy for non-ApiError values,
          // and this page has two failure slots (ballot, picks) that must
          // stay tellable apart. Same visual shell, specific words.
          <p className="mt-4 rounded-lg border border-rausch/40 bg-rausch/5 px-3 py-2 text-sm text-rausch-dark">
            Could not load your picks — refresh to try again.
          </p>
        ) : null}
        {picksSettled && dates.length === 0 ? (
          ballot.data.district_ids.length === 0 ? (
            // No saved address (empty district set): the ask is the whole
            // message. Same green as AddressNudge — one color for the
            // "give address → see your ballot" action, wherever it appears.
            <p className="mt-3 rounded-md border border-nudge-line bg-nudge px-3 py-2 text-sm text-ink">
              <Link to="/me/ballot" className="font-medium text-nudge-deep underline hover:text-ink">
                Set your address
              </Link>{" "}
              to see your races.
            </p>
          ) : (
            // Address is saved and the lookup ran — there genuinely are no
            // upcoming elections. No CTA: there is nothing for them to do.
            <p className="mt-3 text-sm text-ink-soft">No upcoming elections on your ballot yet.</p>
          )
        ) : null}
        {picksSettled ? (
          <>
            {/* Above the toggle so both views carry it. */}
            {nearestUpcomingDate !== undefined ? (
              <DraftMilestone
                show={milestoneShown}
                date={nearestUpcomingDate}
                signup={false}
                hasOpenRetention={nearestRaces.retention.some((election) => !hasRenderablePick(choiceByElectionId?.get(election.id)))}
              />
            ) : null}
            {dates.length > 0 ? (
              <div className="mt-4">
                <BallotViewToggle
                  view={view}
                  onChange={(next) => {
                    track("list_control", { control: "view_toggle", value: next });
                    setView(next);
                  }}
                />
              </div>
            ) : null}
            {view === "ballot" ? (
              // Same settled payload as the cards — no second fetch, no
              // loading state of its own. No auto-pick controls here: the
              // sheet imitates a paper ballot, so app machinery stays in
              // list view. Fill-run annotations still carry over so a run
              // made in list view keeps its "why" notes after a toggle.
              <BallotPreviewSheets
                elections={ballot.data?.elections ?? []}
                choiceByElectionId={choiceByElectionId}
                today={today}
                autoResultFor={(date, electionId) => autoResultsByDate.get(date)?.get(electionId)}
              />
            ) : (
              <div className="mt-4 space-y-4">
                {dates.map((date) => (
                  <PickDateCard
                    key={date}
                    date={date}
                    elections={byDate.get(date) ?? []}
                    choiceByElectionId={choiceByElectionId}
                    autoPickChoices={choices ?? []}
                    autoResults={autoResultsByDate.get(date) ?? null}
                    onAutoResults={handleAutoResults(date)}
                  />
                ))}
              </div>
            )}
            {/* One slot below whichever view is on: the honorary-member ask,
                riding the milestone's single moment. */}
            <DraftMembershipCta show={milestoneShown} />
            <UpcomingUncardedPicks
              title="Other upcoming picks"
              choices={choices ?? []}
              today={today}
              cardedElectionIds={cardedElectionIds}
            />
            <PastPicks choices={choices ?? []} today={today} cardedElectionIds={cardedElectionIds} />
            <SharedLinks cardedDates={new Set(dates)} />
          </>
        ) : null}
      </section>
    </div>
  );
}

export default PicksPage;

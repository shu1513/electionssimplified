import { useId } from "react";
import { ApiError, useElectionChoiceSaving, useMe, useSetElectionChoice } from "@voteapp/api-client";
import type { ElectionChoice } from "@voteapp/api-client";
import { setDraftCandidateChoice, setDraftMeasureChoice } from "../lib/ballotDraft";
import { msSincePageView, track, trackSettled } from "../lib/usage";

type PickSurface = "election_inline" | "candidate_card" | "candidate_row" | "measure_card" | "stranded";
type PickBase = {
  kind: "candidate" | "measure";
  surface: PickSurface;
  store: "account" | "draft";
  change: "added" | "changed" | "removed";
};

// pick_attempt now, pick_result when the write settles. A guest draft write
// is synchronous and in memory only (writeDraft swallows storage failures),
// so it reports "draft_memory", never "saved"; an account write reports on
// the page it started from even if that page has since unmounted.
function recordPick(base: PickBase, request: Promise<unknown> | null): void {
  track("pick_attempt", { ...base, ms_since_view: msSincePageView() });
  if (request === null) {
    track("pick_result", { ...base, outcome: "draft_memory" });
    return;
  }
  trackSettled(request, "pick_result", base, "saved");
  request.catch(() => undefined);
}

// "My choice" controls: the viewer's planned vote per election. Signed-in
// viewers write to /api/me/election-choices; guests write to the local
// ballot draft (lib/ballotDraft.ts) — same buttons, different store, so
// building a ballot needs no account. Callers gate rendering on a loaded
// choices list for signed-in viewers (same no-flash rule as FollowButton),
// and only render for upcoming elections — the backend rejects writes to
// past ones. raceTitle/electionDate ride along on every control because the
// draft rows must be self-describing (the draft has no server read to fill
// in titles).

// Backend rejections carry human-readable messages ("This election fills 2
// seats; remove a pick before adding another"); transport failures don't
// ("Failed to fetch"), so those get generic copy instead.
function saveErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Couldn't save — check your connection and try again.";
}

function SaveError({ error }: { error: unknown }) {
  if (!error) {
    return null;
  }
  return (
    <span role="alert" className="text-xs font-medium text-red-800">
      {saveErrorMessage(error)}
    </span>
  );
}

type CandidatePickButtonProps = {
  electionId: string;
  candidateId: string;
  /** Carried in the accessible name so the page's N pick buttons stay
   * distinguishable in screen-reader button lists and voice control. */
  candidateName: string;
  /** The election's official ballot title — stored on guest draft rows. */
  raceTitle: string;
  /** ISO election date (YYYY-MM-DD) — stored on guest draft rows. */
  electionDate: string;
  /** The viewer's current choice state for this election, if any. */
  choice: ElectionChoice | undefined;
  /** elections.seats_to_fill — null renders as a single seat. */
  seatsToFill: number | null;
  size?: "sm" | "md";
  /** Stretch the control to its container's width (the mobile sticky bar). */
  fullWidth?: boolean;
  /** Where the control sits, for the pick usage events. */
  surface?: "election_inline" | "candidate_card";
  /** Fires once a pick LANDS (guest: on the draft write; account: when the
   * PUT resolves) — never on a removal or a failed save. The election
   * page's post-pick toast hangs off it. */
  onPicked?: () => void;
};

/**
 * Toggle for "this candidate is my pick". Single-seat races behave like a
 * radio (the backend replaces the previous pick); multi-seat races act as
 * checkboxes capped at seats_to_fill, so the button disables once the cap
 * is reached and this candidate is not among the picks.
 */
export function CandidatePickButton({
  electionId,
  candidateId,
  candidateName,
  raceTitle,
  electionDate,
  choice,
  seatsToFill,
  size = "md",
  fullWidth = false,
  surface = "election_inline",
  onPicked,
}: CandidatePickButtonProps) {
  const { me } = useMe();
  const isGuest = me === null;
  const setChoice = useSetElectionChoice();
  const saving = useElectionChoiceSaving();
  const capMessageId = useId();
  const picks = choice?.picks ?? [];
  const isPicked = picks.some((pick) => pick.candidate_id === candidateId);
  const seatCap = seatsToFill ?? 1;
  function toggle() {
    const chosen = !isPicked;
    const base: PickBase = {
      kind: "candidate",
      surface,
      store: isGuest ? "draft" : "account",
      // Single-seat races replace the previous pick (a change); multi-seat
      // ones add a seat.
      change: !chosen ? "removed" : picks.length > 0 && seatCap <= 1 ? "changed" : "added",
    };
    if (isGuest) {
      setDraftCandidateChoice({ electionId, raceTitle, electionDate, seatsToFill, candidateId, candidateName, chosen });
      recordPick(base, null);
      if (chosen) {
        onPicked?.();
      }
      return;
    }
    const request = setChoice.mutateAsync({ election_id: electionId, candidate_id: candidateId, chosen });
    recordPick(base, request);
    if (chosen && onPicked) {
      // Rejections already surface under the button (SaveError); nothing to
      // confirm then.
      request.then(onPicked, () => undefined);
    }
  }
  const atMultiSeatCap = seatCap > 1 && !isPicked && picks.length >= seatCap;
  // Yellow only ever marks an UNDONE decision (same grammar as
  // MeasureChoiceButtons): once the race's seats are all picked, the other
  // candidates' buttons demote to a quiet outline — still clickable
  // (single-seat is a radio replace), no longer shouting. A 3-seat race
  // with 1 pick is still undone, so its remaining buttons stay yellow.
  const raceDecided = picks.length >= seatCap;
  // Same visible-vs-tooltip split as CandidatePickRow: standalone (fullWidth)
  // the button is the page's only pick control, so the cap reason must be
  // visible — a title on a disabled button reaches neither touch nor
  // keyboard users. Inline on the election page the title stays: the page
  // shows the viewer's other picks and a per-seat hint, and a message under
  // every capped candidate card would repeat itself down the roster.
  const showCapMessage = atMultiSeatCap && fullWidth;
  // disabled:opacity-50 lives in the shared base: `saving` disables EVERY
  // choice control while any one of them writes, so a picked button must dim
  // too, not only the unpicked ones.
  const sizeClass =
    size === "sm"
      ? "rounded-full px-3 py-1 text-xs font-semibold transition disabled:opacity-50"
      : "rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-50";
  const base = fullWidth ? `${sizeClass} w-full text-center` : sizeClass;
  const visibleLabel = setChoice.isPending ? "…" : isPicked ? "✓ My pick" : "Make my pick";

  return (
    <span className={fullWidth ? "flex w-full flex-col gap-1" : "inline-flex flex-col items-end gap-1"}>
      {/* aria-label derives from visibleLabel so name and text can't drift:
          the candidate suffix keeps the page's N pick buttons apart in
          screen-reader button lists and voice control, and leading with the
          visible text keeps the spoken label a prefix of the name (WCAG
          2.5.3). Matches the ballot cards' "My pick: {name}" chip wording. */}
      <button
        type="button"
        disabled={saving || atMultiSeatCap}
        aria-pressed={isPicked}
        aria-label={`${visibleLabel}: ${candidateName}`}
        aria-describedby={showCapMessage ? capMessageId : undefined}
        title={
          atMultiSeatCap && !showCapMessage
            ? `This election fills ${seatCap} seats — remove a pick first`
            : undefined
        }
        onClick={toggle}
        className={
          isPicked
            ? `${base} bg-green-700 text-white hover:bg-green-800`
            : raceDecided
              ? `${base} border border-line bg-white text-ink hover:border-green-700`
              : // pick yellow: the app's reserved primary-action color — the
                // unpicked state is the call to act, the picked state stays
                // green ("done"), so the two never compete.
                `${base} bg-pick text-ink hover:bg-pick-hover`
        }
      >
        {visibleLabel}
      </button>
      {showCapMessage ? (
        <span id={capMessageId} className="text-xs font-medium text-ink-soft">
          This election fills {seatCap} seats — remove a pick first
        </span>
      ) : null}
      {/* Only this control's own failure: a shared banner would blame every
          button on the page for one candidate's rejection. */}
      {setChoice.isError && !setChoice.isPending ? <SaveError error={setChoice.error} /> : null}
    </span>
  );
}

type CandidatePickRowProps = {
  electionId: string;
  candidateId: string;
  /** Shown in the row text so the action reads as a sentence. */
  candidateName: string;
  /** The election's official ballot title, e.g. "Commissioner of Agriculture". */
  raceName: string;
  /** Pre-formatted election date, e.g. "August 18, 2026". */
  dateLabel: string;
  /** ISO election date (YYYY-MM-DD) — stored on guest draft rows. */
  electionDate: string;
  /** The viewer's current choice state for this election, if any. */
  choice: ElectionChoice | undefined;
  /** elections.seats_to_fill — null renders as a single seat. */
  seatsToFill: number | null;
};

/**
 * Ballot-style pick toggle for the candidate page: the whole row is the
 * button and its text reads as a sentence ("Make Jane Doe my pick for
 * Governor"), because a bare "Make my pick" button next to a race name read
 * as two unrelated things. "my pick" stays in the label so the row reads
 * as recording a personal choice, not as casting a vote online. Same toggle
 * semantics as CandidatePickButton (radio for single-seat, capped checkboxes
 * for multi-seat).
 */
export function CandidatePickRow({
  electionId,
  candidateId,
  candidateName,
  raceName,
  dateLabel,
  electionDate,
  choice,
  seatsToFill,
}: CandidatePickRowProps) {
  const { me } = useMe();
  const isGuest = me === null;
  const setChoice = useSetElectionChoice();
  const saving = useElectionChoiceSaving();
  const capMessageId = useId();
  const picks = choice?.picks ?? [];
  const isPicked = picks.some((pick) => pick.candidate_id === candidateId);
  const seatCap = seatsToFill ?? 1;
  const atMultiSeatCap = seatCap > 1 && !isPicked && picks.length >= seatCap;
  // Same yellow-only-while-undone rule as CandidatePickButton.
  const raceDecided = picks.length >= seatCap;
  const base =
    "w-full rounded-xl border p-3 text-left text-sm transition disabled:opacity-50";
  function toggle() {
    const chosen = !isPicked;
    const pickBase: PickBase = {
      kind: "candidate",
      surface: "candidate_row",
      store: isGuest ? "draft" : "account",
      change: !chosen ? "removed" : picks.length > 0 && seatCap <= 1 ? "changed" : "added",
    };
    if (isGuest) {
      setDraftCandidateChoice({
        electionId,
        raceTitle: raceName,
        electionDate,
        seatsToFill,
        candidateId,
        candidateName,
        chosen,
      });
      recordPick(pickBase, null);
      return;
    }
    recordPick(pickBase, setChoice.mutateAsync({ election_id: electionId, candidate_id: candidateId, chosen }));
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={saving || atMultiSeatCap}
        aria-pressed={isPicked}
        aria-describedby={atMultiSeatCap ? capMessageId : undefined}
        onClick={toggle}
        className={
          isPicked
            ? `${base} border-green-700 bg-green-50 text-green-900 hover:bg-green-100`
            : raceDecided
              ? `${base} border-line bg-white text-ink hover:border-green-700`
              : // Same reserved pick yellow as CandidatePickButton's unpicked
                // state — one color grammar for "choose" across the app.
                `${base} border-pick bg-pick text-ink hover:bg-pick-hover`
        }
      >
        {isPicked ? (
          <>
            ✓ <span className="font-semibold">{candidateName}</span> is my pick for {raceName} ·{" "}
            {dateLabel}
          </>
        ) : (
          <>
            Make <span className="font-semibold">{candidateName}</span> my pick for {raceName} ·{" "}
            {dateLabel}
          </>
        )}
      </button>
      {/* Visible, not a title tooltip: unlike the election page, this page
          doesn't show the viewer's other picks, so a dimmed row is otherwise
          unexplained — and title tooltips never reach touch or keyboard
          users (a native-disabled button isn't focusable at all). */}
      {atMultiSeatCap ? (
        <span id={capMessageId} className="text-xs font-medium text-ink-soft">
          This election fills {seatCap} seats — remove a pick first
        </span>
      ) : null}
      {setChoice.isError && !setChoice.isPending ? <SaveError error={setChoice.error} /> : null}
    </div>
  );
}

type RemoveStrandedPickButtonProps = {
  electionId: string;
  candidateId: string;
  /** Carried in the accessible name — the visible label is a bare "Remove
   * pick", which a screen-reader button list can't tell apart. */
  candidateName: string;
  /** The election's official ballot title — stored on guest draft rows. */
  raceTitle: string;
  /** ISO election date (YYYY-MM-DD) — stored on guest draft rows. */
  electionDate: string;
  /** elections.seats_to_fill — the guest draft write re-derives its cap. */
  seatsToFill: number | null;
};

/**
 * Removes a STRANDED pick — one whose candidacy left the race after the pick
 * was made (withdrawn for accounts, gone from the roster for guest drafts).
 * Such candidacies are filtered out of election payloads and never get a
 * CandidatePickButton, so without this control the pick holds one of a
 * multi-seat race's slots forever — both the backend's seat cap and the
 * guest draft's count every stored pick, but the toggle that could clear it
 * has no candidate row to live on. Same session fork as CandidatePickButton:
 * signed-in → PUT, guest → local draft. Upcoming elections only, same as
 * every choice control — the backend rejects writes to past ones.
 */
export function RemoveStrandedPickButton({
  electionId,
  candidateId,
  candidateName,
  raceTitle,
  electionDate,
  seatsToFill,
}: RemoveStrandedPickButtonProps) {
  const { me } = useMe();
  const isGuest = me === null;
  const setChoice = useSetElectionChoice();
  const saving = useElectionChoiceSaving();
  function remove() {
    const pickBase: PickBase = {
      kind: "candidate",
      surface: "stranded",
      store: isGuest ? "draft" : "account",
      change: "removed",
    };
    if (isGuest) {
      setDraftCandidateChoice({
        electionId,
        raceTitle,
        electionDate,
        seatsToFill,
        candidateId,
        candidateName,
        chosen: false,
      });
      recordPick(pickBase, null);
      return;
    }
    recordPick(pickBase, setChoice.mutateAsync({ election_id: electionId, candidate_id: candidateId, chosen: false }));
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={saving}
        aria-label={`Remove pick: ${candidateName}`}
        onClick={remove}
        className="rounded-full border border-line bg-white px-2 py-0.5 text-xs font-medium text-ink transition hover:border-ink disabled:opacity-50"
      >
        {setChoice.isPending ? "…" : "Remove pick"}
      </button>
      {setChoice.isError && !setChoice.isPending ? <SaveError error={setChoice.error} /> : null}
    </span>
  );
}

/**
 * Election-page banner for stranded picks. The race's candidate list no
 * longer shows these candidacies at all, so on a multi-seat race the only
 * visible symptom is every other button disabled with "remove a pick first"
 * — this names the invisible pick and offers the removal the roster can't.
 * Renders nothing when no pick is stranded.
 *
 * Detection forks on the session: signed-in picks carry the authoritative
 * candidacy_status, but guest draft rows are always stored "active"
 * (lib/ballotDraft.ts), so for guests the only signal is the pick's absence
 * from the payload roster. Both surfaces read the same candidate_elections
 * rows, so a stored pick missing from the roster really did lose its
 * candidacy — but the draft can't say HOW (withdrawal, or dropped in a
 * roster re-research), hence the vaguer guest copy.
 */
export function StrandedPicksNotice({
  electionId,
  choice,
  raceTitle,
  electionDate,
  seatsToFill,
  rosterCandidateIds,
}: {
  electionId: string;
  choice: ElectionChoice | undefined;
  raceTitle: string;
  electionDate: string;
  seatsToFill: number | null;
  /** candidate_ids the election payload still lists (the FULL roster, not a
   * client-side filtered view — a party filter must not strand picks). */
  rosterCandidateIds: ReadonlySet<string>;
}) {
  const { me } = useMe();
  const isGuest = me === null;
  const stranded = (choice?.picks ?? []).filter((pick) =>
    isGuest ? !rosterCandidateIds.has(pick.candidate_id) : pick.candidacy_status === "withdrawn"
  );
  if (stranded.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 rounded-md border border-line bg-surface px-3 py-2">
      <ul className="space-y-1">
        {stranded.map((pick) => (
          <li key={pick.candidate_id} className="flex flex-wrap items-center gap-2 text-sm text-ink">
            <span>
              Your pick <span className="font-semibold">{pick.display_name}</span>{" "}
              {isGuest ? "is no longer listed in this race" : "withdrew from this race"} — it
              still counts toward your picks until you remove it.
            </span>
            <RemoveStrandedPickButton
              electionId={electionId}
              candidateId={pick.candidate_id}
              candidateName={pick.display_name}
              raceTitle={raceTitle}
              electionDate={electionDate}
              seatsToFill={seatsToFill}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

type MeasureChoiceButtonsProps = {
  electionId: string;
  /** The measure's official ballot title — stored on guest draft rows. */
  raceTitle: string;
  /** ISO election date (YYYY-MM-DD) — stored on guest draft rows. */
  electionDate: string;
  choice: ElectionChoice | undefined;
  /** Stretch the pair across the container (the sticky measure card). */
  fullWidth?: boolean;
  /** "office" for a judicial retention race (a Yes/No answered office race);
   * stored on guest draft rows so the row keeps the catalog's race type. */
  raceType?: "office" | "ballot_measure";
};

/**
 * Yes/No planned-vote pair for a ballot measure. Clicking the active side
 * clears the position (sends null). Color grammar: while undecided BOTH
 * sides wear the reserved pick yellow (the page is asking); once decided
 * the picked side keeps its semantic color (green Yes / red No) and the
 * other side demotes to a quiet outline — yellow only ever marks an undone
 * decision, same rule as CandidatePickButton.
 */
export function MeasureChoiceButtons({
  electionId,
  raceTitle,
  electionDate,
  choice,
  fullWidth = false,
  raceType = "ballot_measure",
}: MeasureChoiceButtonsProps) {
  const { me } = useMe();
  const isGuest = me === null;
  const setChoice = useSetElectionChoice();
  const saving = useElectionChoiceSaving();
  const position = choice?.measure_position ?? null;
  const sizeClass = "rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-50";
  const base = fullWidth ? `${sizeClass} flex-1 text-center` : sizeClass;
  const undecided = position === null;

  function setPosition(next: "yes" | "no" | null) {
    const pickBase: PickBase = {
      kind: "measure",
      surface: "measure_card",
      store: isGuest ? "draft" : "account",
      change: next === null ? "removed" : position === null ? "added" : "changed",
    };
    if (isGuest) {
      setDraftMeasureChoice({ electionId, raceTitle, electionDate, position: next, raceType });
      recordPick(pickBase, null);
      return;
    }
    recordPick(pickBase, setChoice.mutateAsync({ election_id: electionId, measure_position: next }));
  }

  return (
    <div className={fullWidth ? "flex w-full flex-wrap items-center gap-2" : "flex flex-wrap items-center gap-2"}>
      {/* text-ink, not -soft: the label anchors the card's purpose and has
          to register at a glance next to two loud buttons. */}
      <span className="text-sm font-medium text-ink">My pick:</span>
      <button
        type="button"
        disabled={saving}
        aria-pressed={position === "yes"}
        onClick={() => setPosition(position === "yes" ? null : "yes")}
        className={
          position === "yes"
            ? `${base} bg-green-700 text-white hover:bg-green-800`
            : undecided
              ? `${base} bg-pick text-ink hover:bg-pick-hover`
              : `${base} border border-line bg-white text-ink hover:border-green-700`
        }
      >
        {position === "yes" ? "✓ Yes" : "Yes"}
      </button>
      <button
        type="button"
        disabled={saving}
        aria-pressed={position === "no"}
        onClick={() => setPosition(position === "no" ? null : "no")}
        className={
          position === "no"
            ? `${base} bg-red-700 text-white hover:bg-red-800`
            : undecided
              ? `${base} bg-pick text-ink hover:bg-pick-hover`
              : `${base} border border-line bg-white text-ink hover:border-red-700`
        }
      >
        {position === "no" ? "✓ No" : "No"}
      </button>
      {setChoice.isError && !setChoice.isPending ? <SaveError error={setChoice.error} /> : null}
    </div>
  );
}

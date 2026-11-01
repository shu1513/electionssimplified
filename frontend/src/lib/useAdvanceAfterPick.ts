import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useElectionChoiceSaving } from "@voteapp/api-client";

/** How long a landed pick stays on screen before the page moves on: long
 * enough to see the control flip to "✓ My pick", short enough to read as
 * one motion. */
export const ADVANCE_AFTER_PICK_MS = 1200;
/** The leaving race's fade-out (index.css race-out); the move follows it. */
export const ADVANCE_LEAVE_MS = 180;
/** The arriving race's fade-in (index.css race-in). */
export const ADVANCE_ENTER_MS = 240;

export type AdvanceTarget = { electionId: string; path: string; state: unknown };

// The race the advance is moving to, set just before the navigation and
// read by the election page's useAdvanceEnter so only THAT arrival plays
// the fade-in — a rail click or a back hop arrives plain. Module state,
// not router state: it must not survive a reload or a shared link.
let enteringElectionId: string | null = null;

/**
 * Post-pick auto-advance (owner, 2026-10-31): once a pick the reader just
 * made DECIDES the race, the page moves down the ballot to the next race
 * after a short pause. Decided means a single-seat race picked, a measure
 * answered, or the last seat of a multi-seat race filled — never earlier,
 * so "pick up to 3" keeps its remaining picks, and a re-click within the
 * pause still undoes (it clears `decided`, which cancels the move).
 *
 * Only a pick made on this page arms it (the controls' onPicked calls the
 * returned `arm`): arriving at a race already decided moves no one, and
 * the rail's auto-fill never does either. `key` names the race the arming
 * belongs to: a walk to another race DISARMS (not just pauses — coming
 * back to a race left mid-pause must not move the reader without a new
 * pick), and a pick that lands after the reader has already left its race
 * never arms. No next race — a deep link without ballot context, the last
 * race of the ballot — means no move; the post-pick links stay the exits.
 *
 * A choice write in flight holds the pause: account picks are not
 * optimistic (the choice list refetches after the PUT), so during an undo
 * the race still reads as decided until the server answers — the move
 * must wait for that answer, and the pause restarts once it lands.
 *
 * Not a cut: after the pause `leaving` turns true for ADVANCE_LEAVE_MS
 * (the page fades its detail column out, index.css race-out), then the
 * navigation happens and the arriving race fades in (useAdvanceEnter).
 */
export function useAdvanceAfterPick({
  key,
  decided,
  next,
}: {
  key: string;
  decided: boolean;
  next: AdvanceTarget | null;
}): { arm: () => void; leaving: boolean } {
  const navigate = useNavigate();
  const saving = useElectionChoiceSaving();
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [leavingKey, setLeavingKey] = useState<string | null>(null);
  // The race on screen right now, for a pick that lands late (below).
  const keyRef = useRef(key);
  keyRef.current = key;
  // The target is read when the timer fires, not when it is set: its state
  // object is rebuilt every render and must not restart the pause.
  const nextRef = useRef(next);
  nextRef.current = next;
  const nextPath = next?.path ?? null;
  // Set once the move has fired: the column must then STAY out while the
  // next race loads (the route element keeps rendering this race until the
  // loader resolves), so the disarm below must not read as a cancel.
  const movedRef = useRef(false);
  useEffect(() => {
    if (armedKey !== key || !decided || saving || nextPath === null) return;
    movedRef.current = false;
    const pause = setTimeout(() => setLeavingKey(key), ADVANCE_AFTER_PICK_MS);
    const move = setTimeout(() => {
      movedRef.current = true;
      setArmedKey(null);
      const target = nextRef.current;
      if (target) {
        enteringElectionId = target.electionId;
        void navigate(target.path, { state: target.state });
      }
    }, ADVANCE_AFTER_PICK_MS + ADVANCE_LEAVE_MS);
    return () => {
      clearTimeout(pause);
      clearTimeout(move);
      // An undo inside the window brings the column back; the disarm after
      // a move does not.
      if (!movedRef.current) setLeavingKey(null);
    };
  }, [armedKey, key, decided, saving, nextPath, navigate]);
  // Arming and leaving belong to the race they were set on: once the page
  // is on another race both are cleared, so walking back to the first race
  // later neither moves the reader again nor finds its column faded out.
  useEffect(() => {
    setArmedKey((current) => (current !== null && current !== key ? null : current));
    setLeavingKey((current) => (current !== null && current !== key ? null : current));
  }, [key]);
  return {
    // A pick that lands after the reader walked on (a slow account PUT)
    // belongs to a race no longer on screen: ignore it.
    arm: () => {
      if (keyRef.current === key) setArmedKey(key);
    },
    leaving: leavingKey === key,
  };
}

/**
 * True while `electionId` is the race the auto-advance just moved to, so
 * the election page plays the fade-in on that arrival only. Clears itself
 * once the animation has run; a later visit to the same race arrives plain.
 */
export function useAdvanceEnter(electionId: string): boolean {
  const entering = enteringElectionId === electionId;
  useEffect(() => {
    if (!entering) return;
    const timer = setTimeout(() => {
      if (enteringElectionId === electionId) enteringElectionId = null;
    }, ADVANCE_ENTER_MS);
    return () => clearTimeout(timer);
  }, [entering, electionId]);
  return entering;
}

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

/** How long a landed pick stays on screen before the page moves on: long
 * enough to see the control flip to "✓ My pick", short enough to read as
 * one motion. */
export const ADVANCE_AFTER_PICK_MS = 1200;

export type AdvanceTarget = { path: string; state: unknown };

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
 * belongs to, so a rail walk to another race disarms. No next race — a
 * deep link without ballot context, the last race of the ballot — means
 * no move; the post-pick links stay the exits there.
 */
export function useAdvanceAfterPick({
  key,
  decided,
  next,
}: {
  key: string;
  decided: boolean;
  next: AdvanceTarget | null;
}): () => void {
  const navigate = useNavigate();
  const [armedKey, setArmedKey] = useState<string | null>(null);
  // The target is read when the timer fires, not when it is set: its state
  // object is rebuilt every render and must not restart the pause.
  const nextRef = useRef(next);
  nextRef.current = next;
  const nextPath = next?.path ?? null;
  useEffect(() => {
    if (armedKey !== key || !decided || nextPath === null) return;
    const timer = setTimeout(() => {
      setArmedKey(null);
      const target = nextRef.current;
      if (target) void navigate(target.path, { state: target.state });
    }, ADVANCE_AFTER_PICK_MS);
    return () => clearTimeout(timer);
  }, [armedKey, key, decided, nextPath, navigate]);
  return () => setArmedKey(key);
}

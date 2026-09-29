import { useEffect, useRef, useState } from "react";
import { DraftLink } from "./PostPickActions";
import { markDraftToastSeen } from "../lib/draftToastSeen";

// The election page's post-pick confirmation for roster picks — the same
// "added to cart" moment the candidate page's sticky card gives, cut to the
// one link that matters here: the reader is already on the election, so no
// "Back to election". A brief toast, never a pinned bar (owner's rule:
// persistent = nag): it slides down, holds a few seconds, fades, and
// unmounts.
//
// It lives in the header's My Draft counter's column, so the motion points
// at where the running total lives. While the header link is on screen the
// pill hangs directly beneath it with a caret pointing up at the counter,
// and follows it as the page scrolls. The header is not sticky, so once a
// scroll down the roster takes the link away the pill parks at the top of
// that same column, caret still pointing up: "it's above you". Scrolling
// back up dismisses the pill the moment the header returns: the real
// counter is the thing to see, and a pill over it would cover it.
//
// The caller keys it per pick, so another pick remounts it and the label
// re-reads with the new count. Hidden in split view by the caller — the
// rail's own progress bar already says it.
//
// Once per browser (draftToastSeen): the caller skips it after the first
// showing, and the toast marks that showing itself, only when it is
// actually on screen — a split-view mount sits under the caller's
// rail:hidden and must not spend the one lesson a phone would later get.

const HOLD_MS = 6000;
const FADE_MS = 300;
/** Gap between the header link's bottom edge and the pill. */
const ANCHOR_GAP_PX = 6;
/** The caret is a 12px square rotated 45°; half its width centers it. */
const CARET_HALF_PX = 6;
/** Corner fallback (no header link to align with): the page's 16px gutter. */
const GUTTER_PX = 16;

type Placement = {
  /** Viewport offset of the pill's top edge; null parks it at the top. */
  top: number | null;
  /** The pill's right edge, as an offset from the viewport's right. */
  right: number;
  /** The caret's offset from the pill's right edge, centering it under the link. */
  caretRight: number;
};

/** Where the header's My Draft link is right now, on screen or not. */
function measure(): Placement {
  if (typeof document === "undefined") {
    return { top: null, right: GUTTER_PX, caretRight: CARET_HALF_PX };
  }
  const link = document.querySelector<HTMLElement>("[data-draft-link]");
  const rect = link?.getBoundingClientRect();
  if (!rect || rect.width === 0) {
    return { top: null, right: GUTTER_PX, caretRight: CARET_HALF_PX };
  }
  const onScreen = rect.bottom > 0 && rect.top < window.innerHeight;
  return {
    top: onScreen ? rect.bottom + ANCHOR_GAP_PX : null,
    right: window.innerWidth - rect.right,
    caretRight: Math.max(CARET_HALF_PX, rect.width / 2 - CARET_HALF_PX),
  };
}

export function DraftToast() {
  const [phase, setPhase] = useState<"in" | "out" | "gone">("in");
  const [placement, setPlacement] = useState<Placement>(measure);
  const placementRef = useRef(placement);
  const pillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // checkVisibility sees through an ancestor's display:none; where the
    // browser lacks it (older Safari, jsdom) assume the pill is showing.
    const pill = pillRef.current;
    if (pill && (typeof pill.checkVisibility !== "function" || pill.checkVisibility())) {
      markDraftToastSeen();
    }
    const fade = setTimeout(() => setPhase("out"), HOLD_MS - FADE_MS);
    const gone = setTimeout(() => setPhase("gone"), HOLD_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, []);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = measure();
      // Parked, and the header just scrolled back in: get out of its way.
      if (placementRef.current.top === null && next.top !== null) {
        setPhase("gone");
        return;
      }
      placementRef.current = next;
      setPlacement(next);
    };
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(update);
      }
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  if (phase === "gone") {
    return null;
  }
  const anchored = placement.top !== null;
  return (
    // pointer-events: the full-width strip must not swallow taps on the
    // page beneath it; only the pill itself is clickable.
    <div
      className={
        anchored
          ? "pointer-events-none fixed inset-x-0 z-30 flex justify-end"
          : "pointer-events-none fixed inset-x-0 top-3 z-30 flex justify-end"
      }
      style={{ top: anchored ? placement.top! : undefined, paddingRight: placement.right }}
    >
      <div
        ref={pillRef}
        role="status"
        className={`pointer-events-auto relative rounded-full border border-line bg-white px-4 py-2 text-sm shadow-lg transition-opacity duration-300 motion-safe:animate-toast-in ${
          phase === "out" ? "opacity-0" : "opacity-100"
        }`}
      >
        <span
          aria-hidden="true"
          data-draft-toast-caret=""
          className="absolute -top-1.5 h-3 w-3 rotate-45 border-t border-l border-line bg-white"
          style={{ right: placement.caretRight }}
        />
        <DraftLink />
      </div>
    </div>
  );
}

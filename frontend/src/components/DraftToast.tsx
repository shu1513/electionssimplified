import { useEffect, useState } from "react";
import { DraftLink } from "./PostPickActions";

// The election page's post-pick confirmation for roster picks — the same
// "added to cart" moment the candidate page's sticky card gives, cut to the
// one link that matters here: the reader is already on the election, so no
// "Back to election". A brief toast, never a pinned bar (owner's rule:
// persistent = nag): it slides down at the top right — the header's My
// Draft counter's corner, so the motion points at where the running total
// lives — holds a few seconds, fades, and unmounts.
//
// When the header link is on screen (reader still near the top), the pill
// anchors directly beneath it with a caret pointing up at the counter.
// The header is not sticky, so after a scroll down the roster the link is
// gone; the pill then takes the top-right corner without the caret,
// gesturing at the header's place rather than pointing at nothing.
// Measured once on mount — the caller keys the toast per pick, so another
// pick remounts and re-measures — and not on scroll: a six-second pill
// need not track the page.
//
// The caller keys it per pick, so another pick remounts it and the label
// re-reads with the new count. Hidden in split view by the caller — the
// rail's own progress bar already says it.

const HOLD_MS = 6000;
const FADE_MS = 300;
/** Gap between the header link's bottom edge and the pill. */
const ANCHOR_GAP_PX = 6;
/** The caret is a 12px square rotated 45°; half its width centers it. */
const CARET_HALF_PX = 6;

type Anchor = {
  /** Viewport offset of the pill's top edge. */
  top: number;
  /** Viewport offset of the pill's right edge (from the viewport's right). */
  right: number;
  /** The caret's offset from the pill's right edge, centering it under the link. */
  caretRight: number;
};

/** The header's My Draft link, if it is on screen right now. */
function measureAnchor(): Anchor | null {
  if (typeof document === "undefined") {
    return null;
  }
  const link = document.querySelector<HTMLElement>("[data-draft-link]");
  if (!link) {
    return null;
  }
  const rect = link.getBoundingClientRect();
  if (rect.width === 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) {
    return null;
  }
  return {
    top: rect.bottom + ANCHOR_GAP_PX,
    right: window.innerWidth - rect.right,
    caretRight: Math.max(CARET_HALF_PX, rect.width / 2 - CARET_HALF_PX),
  };
}

export function DraftToast() {
  const [phase, setPhase] = useState<"in" | "out" | "gone">("in");
  const [anchor] = useState<Anchor | null>(measureAnchor);
  useEffect(() => {
    const fade = setTimeout(() => setPhase("out"), HOLD_MS - FADE_MS);
    const gone = setTimeout(() => setPhase("gone"), HOLD_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, []);
  if (phase === "gone") {
    return null;
  }
  return (
    // pointer-events: the full-width strip must not swallow taps on the
    // page beneath it; only the pill itself is clickable.
    <div
      className={
        anchor
          ? "pointer-events-none fixed inset-x-0 z-30 flex justify-end"
          : "pointer-events-none fixed inset-x-0 top-3 z-30 flex justify-end px-4"
      }
      style={anchor ? { top: anchor.top, paddingRight: anchor.right } : undefined}
    >
      <div
        role="status"
        className={`pointer-events-auto relative rounded-full border border-line bg-white px-4 py-2 text-sm shadow-lg transition-opacity duration-300 motion-safe:animate-toast-in ${
          phase === "out" ? "opacity-0" : "opacity-100"
        }`}
      >
        {anchor ? (
          <span
            aria-hidden="true"
            data-draft-toast-caret=""
            className="absolute -top-1.5 h-3 w-3 rotate-45 border-t border-l border-line bg-white"
            style={{ right: anchor.caretRight }}
          />
        ) : null}
        <DraftLink />
      </div>
    </div>
  );
}

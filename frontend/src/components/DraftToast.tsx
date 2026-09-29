import { useEffect, useState } from "react";
import { DraftLink } from "./PostPickActions";

// The election page's post-pick confirmation for roster picks — the same
// "added to cart" moment the candidate page's sticky card gives, cut to the
// one link that matters here: the reader is already on the election, so no
// "Back to election". A brief toast, never a pinned bar (owner's rule:
// persistent = nag): it slides up, holds a few seconds, fades, and unmounts.
// The caller keys it per pick, so another pick remounts it and the label
// re-reads with the new count. Hidden in split view by the caller — the
// rail's own progress bar already says it.

const HOLD_MS = 6000;
const FADE_MS = 300;

export function DraftToast() {
  const [phase, setPhase] = useState<"in" | "out" | "gone">("in");
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
    // pointer-events: the full-width centering strip must not swallow taps
    // on the roster beneath it; only the pill itself is clickable.
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div
        role="status"
        className={`pointer-events-auto rounded-full border border-line bg-white px-4 py-2 text-sm shadow-lg transition-opacity duration-300 motion-safe:animate-toast-in ${
          phase === "out" ? "opacity-0" : "opacity-100"
        }`}
      >
        <DraftLink />
      </div>
    </div>
  );
}

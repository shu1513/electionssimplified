import { useCallback, useSyncExternalStore } from "react";

/** The split-screen (master-detail rail) breakpoint as a media query —
 * mirrors --breakpoint-rail in index.css. From here up the two detail
 * pages render the rail beside the detail column. */
export const RAIL_MEDIA_QUERY = "(min-width: 54rem)";

const noopUnsubscribe = () => {};

function canMatch(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/**
 * Whether `query` matches the viewport right now, live across resizes.
 * False on the server and during hydration (the server snapshot), so the
 * first client render matches the SSR HTML and the real answer lands one
 * paint later — and false where matchMedia is missing (jsdom, old
 * browsers): "no signal" must never read as a wide screen.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!canMatch()) return noopUnsubscribe;
      const list = window.matchMedia(query);
      // Optional calls: a test stub may hand back a bare { matches } object.
      list.addEventListener?.("change", onChange);
      return () => list.removeEventListener?.("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => (canMatch() ? window.matchMedia(query).matches : false),
    () => false
  );
}

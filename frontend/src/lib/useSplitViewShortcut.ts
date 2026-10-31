import { useEffect, useRef, type RefObject } from "react";
import { useLocation, useNavigate } from "react-router";
import { isListRequested, type ElectionNavState } from "./detailNavContext";
import { useHydrated } from "./useHydrated";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "./useMediaQuery";

/** Where the shortcut lands: the first displayed race, with the nav
 * snapshot its card would have delivered (ElectionCard's splitViewEntry). */
export type SplitViewEntry = { electionId: string; state: ElectionNavState };

/** The shortcut's decision for one list page mount (useSplitViewShortcut):
 * `intended` says the page is heading for the split view, so it fetches
 * the split view's own default sort; `navigated` is useSplitViewForward's
 * once-only guard. */
export type SplitViewShortcut = { intended: boolean; navigated: RefObject<boolean> };

/**
 * The wide-screen shortcut past the list pages (owner, 2026-10-31). From
 * the rail breakpoint up the election page is a split view whose rail IS
 * the ballot list, so a visitor arriving at a list page — the address
 * search's result, the signed-in home redirect, the header's ballot link —
 * is forwarded straight into it: the first displayed race, with the same
 * snapshot its card would have delivered. The list's history entry is
 * replaced, so browser Back still leaves the way the reader came. The
 * split view opens in ballot order, not the list's vote-power default,
 * so the page fetches that sort when it knows it is forwarding.
 *
 * Never when the reader asked for the list: a detail page's back link
 * ("← All elections") stamps listRequested on the state it delivers, and
 * without that exception the link would bounce straight back. `hold`
 * keeps the list for a load that has something to say first (a partial
 * ballot, an ambiguous address match, an address-saved notice).
 *
 * The viewport and arrival parts are decided once per mount, at the first
 * hydrated render — wide reads false during hydration (useMediaQuery), so
 * never before it — and held from then on: a window widened or narrowed
 * later keeps whatever the reader is already on, and a one-race ballot (no
 * rail, so no forward) stays in the sort it was fetched in instead of
 * re-sorting under them. A lazy ref init during render, the once-only
 * pattern React allows. `hold` is read live, because a page can gain
 * something to say after mount: the saved ballot's own address form saves
 * into this same route, and its confirmation must still show.
 */
export function useSplitViewShortcut({ hold = false }: { hold?: boolean } = {}): SplitViewShortcut {
  const location = useLocation();
  const hydrated = useHydrated();
  const wide = useMediaQuery(RAIL_MEDIA_QUERY);
  const decision = useRef<boolean | null>(null);
  if (hydrated && decision.current === null) {
    decision.current = wide && !isListRequested(location.state);
  }
  const navigated = useRef(false);
  return { intended: decision.current === true && !hold, navigated };
}

/**
 * The forward itself, once the list page has its entry (null while the
 * ballot loads, or when the split view would not render — see
 * splitViewEntry). Returns true while the forward is pending, so the page
 * shows its loading notice instead of flashing the list for a frame.
 */
export function useSplitViewForward(shortcut: SplitViewShortcut, entry: SplitViewEntry | null): boolean {
  const navigate = useNavigate();
  const skipping = shortcut.intended && entry !== null;
  useEffect(() => {
    if (!skipping || entry === null || shortcut.navigated.current) return;
    shortcut.navigated.current = true;
    void navigate(`/elections/${entry.electionId}`, { replace: true, state: entry.state });
  }, [skipping, entry, shortcut, navigate]);
  return skipping;
}

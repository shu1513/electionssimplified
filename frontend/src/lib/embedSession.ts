// The newsroom embed frames /embed/city/<slug> on a publisher's page. From
// there the reader walks candidate, race, and draft pages with ordinary
// in-app navigation, so those pages render inside the same frame. "Embed
// session" = this document is framed; the app then swaps the site chrome for
// the compact box chrome, keeps only the box's own pages in the frame, and
// hides the actions that cannot work there (a third-party frame gets no
// session cookie and its own partitioned storage).
//
// Only /embed/city/* may be LOADED in a frame (the router worker sends
// X-Frame-Options: DENY for everything else); the other pages are reached by
// client-side navigation only.

import { useEffect, useSyncExternalStore } from "react";

function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin top that throws on access is still a frame.
    return true;
  }
}

const subscribe = () => () => {};

/** True when the app is running inside the newsroom embed's frame. False on
 * the server, so the server HTML is the same for every visitor. */
export function useEmbedSession(): boolean {
  return useSyncExternalStore(subscribe, isFramed, () => false);
}

/** Tells the framing page ONCE how tall the first view is (the city list
 * with every group closed), so embed.js can fit the box to it instead of
 * leaving empty space under the list. The box never resizes after that. It
 * measures the content wrapper, not the document: inside an iframe the
 * document is never shorter than the iframe itself. The host (embed.js)
 * checks the message origin and source window, and ignores later messages. */
export function useReportEmbedHeight(enabled: boolean, content: { current: HTMLElement | null }): void {
  useEffect(() => {
    const element = content.current;
    if (!enabled || !element || window.parent === window) {
      return;
    }
    let cancelled = false;
    const post = () => {
      if (!cancelled) {
        window.parent.postMessage({ type: "es-embed-height", height: Math.ceil(element.getBoundingClientRect().height) }, "*");
      }
    };
    // Wait for web fonts so the measured height is the settled one.
    const fonts = document.fonts?.ready;
    if (fonts) {
      void fonts.then(post, post);
    } else {
      post();
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, content]);
}

const IN_BOX_PATHS = [/^\/embed\/city\/[^/]+\/?$/, /^\/ballot\/?$/, /^\/candidates\/[^/]+\/?$/, /^\/elections\/[^/]+\/?$/, /^\/draft\/?$/];

/** Pages that stay inside the box. Every other link opens a new tab. */
export function isInBoxPath(pathname: string): boolean {
  return IN_BOX_PATHS.some((pattern) => pattern.test(pathname));
}

export type EmbedHome = { path: string; label: string };

// Module state on purpose: it lives exactly as long as the framed document,
// which is the embed session.
let home: EmbedHome | null = null;
let source: string | null = null;

/** The city list the box started on; the draft page's way back. */
export function setEmbedHome(next: EmbedHome): void {
  home = next;
}

export function getEmbedHome(): EmbedHome | null {
  return home;
}

/** The allowlisted publisher code, kept so returning to the city list (whose
 * URL no longer carries the #pub= fragment) still tags outbound links. */
export function rememberEmbedSource(code: string | null): string | null {
  if (code !== null) {
    source = code;
  }
  return source;
}

// The reader's own ballot, once they have searched an address inside the box
// (path + query of the ballot page). From then on the box is about THEIR
// races: the city list stops standing in for their districts, and the draft
// page goes back to this ballot instead of the city list.
let ballotPath: string | null = null;

export function rememberEmbedBallotPath(path: string): void {
  ballotPath = path;
}

export function getEmbedBallotPath(): string | null {
  return ballotPath;
}

// Which groups the reader has open on a city list, kept for this document
// only: a fresh load always starts from the same view (the box is sized from
// it), while coming back from a race finds the list as the reader left it.
let openGroups: { slug: string; keys: Set<string> } | null = null;

export function rememberOpenGroups(slug: string, keys: Set<string>): void {
  openGroups = { slug, keys };
}

export function recallOpenGroups(slug: string): Set<string> | null {
  return openGroups?.slug === slug ? openGroups.keys : null;
}

/** Click guard for the box: a same-origin link to a page outside the box, or
 * any external link, opens in a new tab so the reader never loses the
 * article. Links to in-box pages are left to the router. */
export function guardEmbedClick(event: {
  target: EventTarget | null;
  defaultPrevented: boolean;
  preventDefault: () => void;
}): void {
  if (event.defaultPrevented || !(event.target instanceof Element)) {
    return;
  }
  const anchor = event.target.closest("a");
  const href = anchor?.getAttribute("href");
  if (!anchor || !href || href.startsWith("#") || anchor.target === "_blank") {
    return;
  }
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }
  if (url.origin === window.location.origin && isInBoxPath(url.pathname)) {
    return;
  }
  event.preventDefault();
  window.open(url.href, "_blank", "noopener");
}

export function resetEmbedSessionForTests(): void {
  home = null;
  source = null;
  openGroups = null;
  ballotPath = null;
}

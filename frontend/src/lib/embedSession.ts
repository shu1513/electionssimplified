// The newsroom embed frames /embed (the landing page) on a publisher's page.
// From there the reader walks ballot, race, candidate, and draft pages with ordinary
// in-app navigation, so those pages render inside the same frame. "Embed
// session" = this document is framed; the app then swaps the site chrome for
// the compact box chrome, keeps only the box's own pages in the frame, and
// hides the actions that cannot work there (a third-party frame gets no
// session cookie and its own partitioned storage).
//
// Only /embed may be LOADED in a frame (the router worker sends
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

/** Tells the framing page how tall the current page's content is, whenever
 * that changes. embed.js decides when to listen: while the box first loads,
 * and again when the box's own width changes (a rotated phone, a resized
 * window), so content fitted to an old width never leaves the box half empty.
 * It ignores every other report, so nothing the reader does resizes the box.
 * Measures the content wrapper, not the document: inside an iframe the
 * document is never shorter than the iframe itself. The host checks the
 * message origin and source window. */
export function useReportEmbedHeight(enabled: boolean, content: { current: HTMLElement | null }): void {
  useEffect(() => {
    const element = content.current;
    if (!enabled || !element || window.parent === window) {
      return;
    }
    const post = () => {
      window.parent.postMessage({ type: "es-embed-height", height: Math.ceil(element.getBoundingClientRect().height) }, "*");
    };
    post();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(post);
    observer?.observe(element);
    void document.fonts?.ready.then(post, post);
    return () => observer?.disconnect();
  }, [enabled, content]);
}

const IN_BOX_PATHS = [/^\/embed\/?$/, /^\/ballot\/?$/, /^\/candidates\/[^/]+\/?$/, /^\/elections\/[^/]+\/?$/, /^\/draft\/?$/];

/** Pages that stay inside the box. Every other link opens a new tab. */
export function isInBoxPath(pathname: string): boolean {
  return IN_BOX_PATHS.some((pattern) => pattern.test(pathname));
}

export type EmbedHome = { path: string; label: string };

// Module state on purpose: it lives exactly as long as the framed document,
// which is the embed session.
let home: EmbedHome | null = null;
let source: string | null = null;

/** The box's front page; where "search again" and the ballot's top bar lead. */
export function setEmbedHome(next: EmbedHome): void {
  home = next;
}

export function getEmbedHome(): EmbedHome | null {
  return home;
}

/** The allowlisted publisher code, kept so returning to the front page (whose
 * URL no longer carries the #pub= fragment) still tags outbound links. */
export function rememberEmbedSource(code: string | null): string | null {
  if (code !== null) {
    source = code;
  }
  return source;
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
}

// Demo mode: the whole site again under /demo, shown as it was the day before
// the November 3, 2026 general election — races still open, no results — so a
// visitor can see the election-season experience at any time of year.
//
// How it fits together:
// - server.js (and the dev plugin in vite.config.ts) serve /demo/* from the
//   same build with the router basename set to /demo. Every in-app link and
//   navigation then stays under /demo with no change to the pages.
// - usLatestLocalDate() returns DEMO_TODAY, so every upcoming/past check
//   treats that election as still ahead.
// - API requests carry DEMO_API_HEADERS; the backend then answers on the same
//   date and leaves out results, for signed-in visitors too
//   (backend/src/utils/usLocalDate.ts, backend/src/api/demoView.ts).

/** Keep in step with DEMO_BASENAME in server.js and vite.config.ts. */
export const DEMO_BASENAME = "/demo";

/** Keep in step with DEMO_TODAY_ISO in backend/src/utils/usLocalDate.ts. */
export const DEMO_TODAY = "2026-11-02";

export const DEMO_API_HEADERS = { "x-voteapp-demo": "1" };

/** True for /demo and everything under it. Case-insensitive, like the
 * router's own basename match. */
export function isDemoPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === DEMO_BASENAME || path.startsWith(`${DEMO_BASENAME}/`);
}

type DemoRequestGlobal = { __voteappDemoRequest?: { getStore: () => unknown } };

/**
 * Whether this render or request belongs to the demo.
 *
 * In the browser the address bar decides. On the server there is no address
 * bar and one process renders demo and normal requests at the same time, so
 * server.js runs each /demo request inside an AsyncLocalStorage context and
 * publishes that storage on globalThis for this check. With no storage
 * published (unit tests, the build-time prerender) the answer is always no.
 */
export function isDemoMode(): boolean {
  if (typeof window !== "undefined") {
    return isDemoPath(window.location.pathname);
  }
  return (globalThis as DemoRequestGlobal).__voteappDemoRequest?.getStore() === true;
}

// The one page the demo does not cover: a shared pick card is a public page
// about an account's real picks, results included. Signing in and the
// account pages DO work in the demo — the account is the visitor's real one,
// seen on the demo date. Paths are the router's (basename already removed).
const OUTSIDE_DEMO_PATHS = [/^\/picks\//];

/** True for a page the demo does not cover; the app then loads the real page. */
export function isOutsideDemo(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return OUTSIDE_DEMO_PATHS.some((pattern) => pattern.test(path));
}

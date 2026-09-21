import { useCallback, useEffect, useRef } from "react";
import { useLocation, useMatches } from "react-router";
import { ApiError, hasFinanceContent, useMe } from "@voteapp/api-client";
import { readCandidateNavState, readElectionNavState } from "./detailNavContext";
import { isEmbedPublisherCode } from "./embedPublisher";
import { rememberEmbedSource } from "./embedSession";
import { usLatestLocalDate } from "./usLatestLocalDate";

// First-party usage analytics (docs/plans/usage-analytics.md). What leaves
// the browser: a per-tab session id, a per-page-view id, a route id (never a
// path — /picks/<token> must not reach analytics), a catalog name, a small
// props object, and foreground time. What never leaves: addresses, district
// ids, candidate/election ids, emails, chat text, user ids. The backend
// (backend/src/usage/events.ts) re-validates every prop against the same
// catalog, so this module cannot widen what is stored even by mistake.
//
// Inert unless VITE_USAGE_ANALYTICS_ENABLED is "true" at build time, and
// always inert under SSR, browser automation, the /privacy opt-out, or when
// sessionStorage is unavailable. track() never throws and never awaits.

export const USAGE_ROUTES = [
  "home",
  "ballot",
  "draft",
  "election",
  "candidate",
  "mission",
  "support",
  "support_member",
  "support_once",
  "disclaimer",
  "terms",
  "privacy",
  "register",
  "login",
  "forgot_password",
  "reset_password",
  "verify_email",
  "verify_email_change",
  "welcome",
  "saved_ballot",
  "picks",
  "follows",
  "settings",
  "pick_card",
  "city",
  "not_found",
  "other",
] as const;
export type UsageRoute = (typeof USAGE_ROUTES)[number];

// React Router framework-mode route ids are the file paths from routes.ts
// without their extension. Anything unmapped (tests, future routes) is
// "other" — never the pathname.
const ROUTE_BY_MATCH_ID: Record<string, UsageRoute> = {
  "pages/HomePage": "home",
  "pages/BallotPage": "ballot",
  "pages/DraftPage": "draft",
  "pages/ElectionPage": "election",
  "pages/CandidatePage": "candidate",
  "pages/MissionPage": "mission",
  "pages/SupportPage": "support",
  "pages/SupportMemberPage": "support_member",
  "pages/SupportOncePage": "support_once",
  "routes/disclaimer": "disclaimer",
  "routes/terms": "terms",
  "routes/privacy": "privacy",
  "pages/RegisterPage": "register",
  "pages/LoginPage": "login",
  "pages/ForgotPasswordPage": "forgot_password",
  "pages/ResetPasswordPage": "reset_password",
  "routes/verify-email": "verify_email",
  "routes/verify-email-change": "verify_email_change",
  "pages/WelcomePage": "welcome",
  "pages/SavedBallotPage": "saved_ballot",
  "pages/PicksPage": "picks",
  "pages/FollowsPage": "follows",
  "pages/SettingsPage": "settings",
  "pages/PublicPickCardPage": "pick_card",
  "pages/NotFoundPage": "not_found",
};

export function routeForMatchId(matchId: string | undefined): UsageRoute {
  return (matchId && ROUTE_BY_MATCH_ID[matchId]) || "other";
}

export type ErrorCategory = "not_found" | "rate_limited" | "server" | "network" | "address" | "render" | "other";

/** Coarse category for an error the visitor saw; never the message. */
export function errorCategoryOf(error: unknown): ErrorCategory {
  if (error instanceof ApiError) {
    if (error.status === 404) return "not_found";
    if (error.status === 422) return "address";
    if (error.status === 429) return "rate_limited";
    if (error.status >= 500) return "server";
    return "other";
  }
  return "network";
}

export type CountBucket = "0" | "1-3" | "4-10" | "11-25" | "26+";

export function countBucket(count: number): CountBucket {
  if (count <= 0) return "0";
  if (count <= 3) return "1-3";
  if (count <= 10) return "4-10";
  if (count <= 25) return "11-25";
  return "26+";
}

export function positionBucket(position: number): "1-3" | "4-10" | "11+" {
  if (position <= 3) return "1-3";
  if (position <= 10) return "4-10";
  return "11+";
}

type Props = Record<string, unknown>;

/** Office scope / district type → a coarse level. The two vocabularies
 * share their words (statewide, county, place, us_house, state_lower, …). */
export function officeLevel(scope: string | null | undefined): "federal" | "state" | "county" | "city" | "school" | "other" {
  switch (scope) {
    case "us_house":
    case "us_senate":
    case "presidential":
      return "federal";
    case "statewide":
    case "state_lower":
    case "state_upper":
      return "state";
    case "county":
      return "county";
    case "place":
      return "city";
    default:
      return typeof scope === "string" && scope.startsWith("school") ? "school" : "other";
  }
}

/** official_source_click props for an outbound source: is it a .gov host,
 * is it a PDF. Never the URL itself. */
export function sourceLinkProps(url: string): { gov: boolean; pdf: boolean } {
  let gov = false;
  try {
    gov = new URL(url).hostname.toLowerCase().endsWith(".gov");
  } catch {
    gov = false;
  }
  return { gov, pdf: /\.pdf($|[?#])/i.test(url) };
}

export type ChatSource = "candidate" | "record" | "finance" | "election" | "measure" | "official" | "source" | "page" | "other";

/** chat_result_click's source: the server's card source_type folded to a
 * short list; anything new the server invents lands in "other" rather
 * than dropping the event. */
export function chatSourceBucket(sourceType: string): ChatSource {
  switch (sourceType) {
    case "candidate_profile":
      return "candidate";
    case "candidate_record":
      return "record";
    case "finance_summary":
      return "finance";
    case "election":
      return "election";
    case "ballot_measure":
      return "measure";
    case "official_state_resource":
      return "official";
    case "source_link":
      return "source";
    case "page":
      return "page";
    default:
      return "other";
  }
}

type Arrival = "list" | "roster" | "candidate" | "draft" | "picks" | "share" | "deep";

/** How a detail page was reached, from the validated nav state's back
 * destination — a route family, never the destination's ids. */
export function arrivalFor(route: UsageRoute, state: unknown): Arrival {
  const nav = route === "election" ? readElectionNavState(state) : readCandidateNavState(state);
  if (!nav) return "deep";
  const path = nav.backTo.path;
  if (path.startsWith("/ballot") || path.startsWith("/me/ballot")) return "list";
  if (path.startsWith("/elections/")) return "roster";
  if (path.startsWith("/candidates/")) return "candidate";
  if (path.startsWith("/draft")) return "draft";
  if (path.startsWith("/me/picks")) return "picks";
  if (path.startsWith("/picks/")) return "share";
  return "deep";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The content shape of a detail page from its loader data: enough to read
 * decision rates against what the page offered, nothing that names it. */
export function pageViewProps(route: UsageRoute, data: unknown, state: unknown): Props {
  if (route !== "election" && route !== "candidate") return {};
  const props: Props = { arrival: arrivalFor(route, state) };
  if (!isRecord(data)) return props;
  const today = usLatestLocalDate();
  if (route === "election") {
    const raceType = data.race_type === "ballot_measure" ? "ballot_measure" : "office";
    const office = isRecord(data.office) ? data.office : null;
    const district = isRecord(data.district) ? data.district : null;
    const measure = isRecord(data.ballot_measure) ? data.ballot_measure : null;
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    props.race_type = raceType;
    props.office_level = officeLevel(
      (typeof office?.scope === "string" ? office.scope : null) ??
        (typeof district?.district_type === "string" ? district.district_type : null)
    );
    props.upcoming = typeof data.election_date === "string" && data.election_date >= today;
    if (raceType === "ballot_measure") {
      props.measure_tbd = measure === null;
      props.has_summary = typeof measure?.summary === "string" && measure.summary.length > 0;
      props.has_official_url = typeof measure?.official_measure_url === "string";
      const tags = Array.isArray(measure?.research_area_tags) ? measure.research_area_tags : [];
      props.has_stance_tags = tags.some(
        (tag) => isRecord(tag) && (tag.stance === "for" || tag.stance === "against")
      );
    } else {
      props.has_summary = typeof office?.summary === "string" && office.summary.length > 0;
      props.candidate_count_bucket = countBucket(candidates.length);
    }
    return props;
  }
  const candidate = isRecord(data.candidate) ? data.candidate : null;
  if (!candidate) return props;
  const records = Array.isArray(candidate.records) ? candidate.records : [];
  const elections = Array.isArray(candidate.elections) ? candidate.elections : [];
  const finance = isRecord(data.ongoing_finance) ? Object.values(data.ongoing_finance) : [];
  props.has_summary = typeof candidate.summary === "string" && candidate.summary.length > 0;
  props.record_count_bucket = countBucket(records.length);
  props.upcoming = elections.some(
    (election) => isRecord(election) && typeof election.election_date === "string" && election.election_date >= today
  );
  props.has_finance = finance.some((summary) => hasFinanceContent(summary as Parameters<typeof hasFinanceContent>[0]));
  return props;
}

type UsageEvent = {
  event_id: string;
  session_id: string;
  page_view_id: string | null;
  name: string;
  route: UsageRoute;
  client_offset_ms: number;
  props: Props;
};

type StoredSession = { id: string; started_at: number; last_active_at: number };

const SESSION_KEY = "voteapp_usage_session";
const OPTOUT_KEY = "voteapp_usage_optout";
const DRAFT_KEY = "voteapp_ballot_draft";
const ENDPOINT = "/api/usage/events";
const PAYLOAD_VERSION = 1;
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_CLIENT_OFFSET_MS = 7 * 24 * 60 * 60_000;
const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_AT_EVENTS = 20;
const PAGE_TIME_CHECKPOINT_MS = 30_000;
const MAX_QUEUE = 200;
const MAX_BATCH_EVENTS = 40;
// Under the API's 16 KB JSON limit with room for the envelope.
const MAX_BODY_BYTES = 12_000;

let session: StoredSession | null = null;
let queue: UsageEvent[] = [];
const retried = new WeakSet<UsageEvent>();
let inFlight = false;
// A 404 means the server has the feature off: stop sending for this tab.
let serverDisabled = false;
let currentRoute: UsageRoute = "other";
// The page the app is rendering right now, stamped by useUsageTracking
// DURING render (parents render before children, but child effects run
// before parent effects — so a child's track() on mount would otherwise
// see the previous page). track() syncs the page view from it lazily.
let desired: { route: UsageRoute; key: string; props: Props } | null = null;
let view: { id: string; key: string; startedAt: number; visibleMs: number; visibleSince: number | null } | null = null;

function isEnabled(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (import.meta.env.VITE_USAGE_ANALYTICS_ENABLED !== "true") return false;
  if (navigator.webdriver) return false;
  if (serverDisabled) return false;
  return !isUsageOptedOut();
}

// The choice made in THIS tab wins over storage: if localStorage refuses the
// write (private mode, quota), an opt-out must still hold for the tab's life.
let optOutThisTab: boolean | null = null;

export function isUsageOptedOut(): boolean {
  if (optOutThisTab !== null) return optOutThisTab;
  try {
    return window.localStorage.getItem(OPTOUT_KEY) === "1";
  } catch {
    return false;
  }
}

/** The /privacy control. Opting out also drops anything not yet sent. */
export function setUsageOptOut(optedOut: boolean): void {
  optOutThisTab = optedOut;
  if (optedOut) {
    queue = [];
  }
  try {
    if (optedOut) {
      window.localStorage.setItem(OPTOUT_KEY, "1");
    } else {
      window.localStorage.removeItem(OPTOUT_KEY);
    }
  } catch {
    // Storage blocked: the in-memory choice above still governs this tab.
  }
}

function readStoredSession(): StoredSession | null {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { id, started_at, last_active_at } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || typeof started_at !== "number" || typeof last_active_at !== "number") return null;
    return { id, started_at, last_active_at };
  } catch {
    return null;
  }
}

/** Ensures a live session, rotating after 30 idle minutes. Returns null (and
 * leaves the module inert) when sessionStorage is unavailable. */
function ensureSession(now: number): StoredSession | null {
  try {
    if (session && now - session.last_active_at <= SESSION_IDLE_MS) {
      session.last_active_at = now;
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return session;
    }
    const stored = session ?? readStoredSession();
    if (stored && now - stored.last_active_at <= SESSION_IDLE_MS) {
      session = { ...stored, last_active_at: now };
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return session;
    }
    session = { id: crypto.randomUUID(), started_at: now, last_active_at: now };
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    queue.push(
      buildEvent(session, "session_start", sessionStartProps(), now, { route: currentRoute, pageViewId: view?.id ?? null })
    );
    return session;
  } catch {
    return null;
  }
}

function referrerBucket(): "search" | "social" | "direct" | "internal" | "other" {
  const referrer = document.referrer;
  if (!referrer) return "direct";
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === window.location.hostname.toLowerCase()) return "internal";
  if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave)\.[a-z.]+$|search/.test(host)) return "search";
  if (
    /(^|\.)(facebook|fb|instagram|threads|twitter|x|t|reddit|linkedin|tiktok|youtube|bsky|nextdoor|snapchat)\.(com|net|co|app|social)$/.test(
      host
    )
  ) {
    return "social";
  }
  return "other";
}

function deviceBucket(): "phone" | "tablet" | "desktop" {
  const width = window.innerWidth;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  if (width < 640) return "phone";
  if (coarse && width < 1024) return "tablet";
  return "desktop";
}

function hadSavedDraft(): boolean {
  try {
    return window.localStorage.getItem(DRAFT_KEY) !== null;
  } catch {
    return false;
  }
}

/** The newsroom-embed publisher code, only when it is on the allowlist we
 * ship: from the arrival URL (`?src=`) for a reader who opened the site from
 * a box, or, for a session that runs INSIDE a box, the code that box was
 * loaded with (its `#pub=` fragment, kept by lib/embedSession.ts). Nothing
 * else from the URL is ever read (privacy rule 3). */
function arrivalSource(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get("src");
    return isEmbedPublisherCode(value) ? value : rememberEmbedSource(null);
  } catch {
    return null;
  }
}

function sessionStartProps(): Props {
  const source = arrivalSource();
  return {
    referrer_bucket: referrerBucket(),
    device: deviceBucket(),
    landing_route: currentRoute,
    had_saved_draft: hadSavedDraft(),
    auth: "unknown",
    ...(source ? { source } : {}),
  };
}

function buildEvent(
  live: StoredSession,
  name: string,
  props: Props,
  now: number,
  attribution: { route: UsageRoute; pageViewId: string | null }
): UsageEvent {
  return {
    event_id: crypto.randomUUID(),
    session_id: live.id,
    page_view_id: attribution.pageViewId,
    name,
    route: attribution.route,
    client_offset_ms: Math.min(Math.max(0, Math.round(now - live.started_at)), MAX_CLIENT_OFFSET_MS),
    props,
  };
}

/** Queues one event; callers have already checked isEnabled(). */
function enqueue(name: string, props: Props, attribution = { route: currentRoute, pageViewId: view?.id ?? null }): void {
  const now = Date.now();
  const live = ensureSession(now);
  if (!live) return;
  queue.push(buildEvent(live, name, props, now, attribution));
  if (queue.length > MAX_QUEUE) {
    queue.splice(0, queue.length - MAX_QUEUE);
  }
  if (queue.length >= FLUSH_AT_EVENTS) {
    flush("fetch");
  }
}

/** Starts a page view for the rendered page when it changed: closes the old
 * view (final page_time, attributed to it) and emits page_view for the new
 * one. Idempotent, so both track() and the route effect may call it. */
function syncPageView(): void {
  if (!desired || (view && view.key === desired.key)) return;
  const previous = view;
  const previousRoute = currentRoute;
  if (previous) {
    accumulateVisible(performance.now());
  }
  const visible = typeof document !== "undefined" && document.visibilityState === "visible";
  const now = performance.now();
  currentRoute = desired.route;
  view = { id: crypto.randomUUID(), key: desired.key, startedAt: now, visibleMs: 0, visibleSince: visible ? now : null };
  if (previous) {
    // The closing view's final time, attributed to the page it measured.
    enqueue("page_time", { visible_ms: Math.round(previous.visibleMs) }, { route: previousRoute, pageViewId: previous.id });
  }
  enqueue("page_view", desired.props);
}

export type UsageAttribution = { route: UsageRoute; pageViewId: string | null };

/** The page an operation started on — capture it before awaiting anything,
 * so a late result is not attributed to whatever page comes next. */
export function currentAttribution(): UsageAttribution {
  try {
    if (isEnabled()) syncPageView();
  } catch {
    // fall through to whatever is current
  }
  return { route: currentRoute, pageViewId: view?.id ?? null };
}

/** Milliseconds since the current page view started (0 before any view). */
export function msSincePageView(): number {
  return view ? Math.max(0, Math.round(performance.now() - view.startedAt)) : 0;
}

/** Records one catalog event. Safe to call from anywhere; never throws. */
export function track(name: string, props: Props = {}, attribution?: UsageAttribution): void {
  try {
    if (!isEnabled()) return;
    syncPageView();
    enqueue(name, props, attribution);
  } catch {
    // Analytics must never surface as an app error.
  }
}

/**
 * Records `name` once `promise` settles — outcome `okOutcome` or "error"
 * with a category — on the page the operation started from. The promise's
 * own rejection is left to the caller; this only observes.
 */
export function trackSettled(promise: Promise<unknown>, name: string, props: Props, okOutcome = "ok"): void {
  const attribution = currentAttribution();
  promise.then(
    () => track(name, { ...props, outcome: okOutcome }, attribution),
    (error: unknown) => track(name, { ...props, outcome: "error", error_category: errorCategoryOf(error) }, attribution)
  );
}

/**
 * Fires `section_exposed` once per page view when the returned ref's element
 * first enters the viewport. Attach to a heading or a short marker, not a
 * tall section. `key` re-arms it (detail route elements stay mounted across
 * sibling walks, so a new election on the same page needs a new exposure).
 */
export function useSectionExposure(section: string, key: string): (node: Element | null) => void {
  const nodeRef = useRef<Element | null>(null);
  const setNode = useCallback((node: Element | null) => {
    nodeRef.current = node;
  }, []);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node || !isEnabled() || typeof IntersectionObserver === "undefined") return;
    const attribution = currentAttribution();
    let fired = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!fired && entries.some((entry) => entry.isIntersecting)) {
          fired = true;
          track("section_exposed", { section }, attribution);
          observer.disconnect();
        }
      },
      { threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [section, key]);
  return setNode;
}

function takeBatch(): UsageEvent[] {
  const batch: UsageEvent[] = [];
  let bytes = 32;
  while (queue.length > 0 && batch.length < MAX_BATCH_EVENTS) {
    const next = queue[0]!;
    const size = JSON.stringify(next).length + 1;
    if (batch.length > 0 && bytes + size > MAX_BODY_BYTES) break;
    batch.push(queue.shift()!);
    bytes += size;
  }
  return batch;
}

/** Puts a failed batch back at the front, once per event. */
function requeueOnce(batch: UsageEvent[]): void {
  const again = batch.filter((event) => !retried.has(event));
  for (const event of again) retried.add(event);
  queue = [...again, ...queue].slice(-MAX_QUEUE);
}

function flush(mode: "fetch" | "beacon"): void {
  // Consent is re-checked at send time: a batch re-queued by a failed
  // request after an opt-out must never leave the browser.
  if (!isEnabled()) {
    queue = [];
    return;
  }
  if (queue.length === 0) return;
  if (mode === "beacon") {
    // Queued-not-confirmed by design: this is the page-hide path where a
    // fetch would be cancelled. Drain everything; no retry is possible.
    if (typeof navigator.sendBeacon !== "function") {
      mode = "fetch";
    } else {
      while (queue.length > 0) {
        const batch = takeBatch();
        const body = JSON.stringify({ v: PAYLOAD_VERSION, events: batch });
        if (!navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) {
          requeueOnce(batch);
          break;
        }
      }
      return;
    }
  }
  if (inFlight) return;
  const batch = takeBatch();
  const body = JSON.stringify({ v: PAYLOAD_VERSION, events: batch });
  inFlight = true;
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  })
    .then((response) => {
      if (response.status === 404) {
        serverDisabled = true;
        queue = [];
      } else if (response.status === 429 || response.status >= 500) {
        requeueOnce(batch);
      }
    })
    .catch(() => requeueOnce(batch))
    .finally(() => {
      inFlight = false;
      if (queue.length >= FLUSH_AT_EVENTS) flush("fetch");
    });
}

function accumulateVisible(now: number): void {
  if (view && view.visibleSince !== null) {
    view.visibleMs += now - view.visibleSince;
    view.visibleSince = now;
  }
}

/** Cumulative foreground time for the current view. Reports keep the max per
 * page_view_id, so repeated checkpoints are harmless. */
function checkpointPageTime(): void {
  if (!view || !isEnabled()) return;
  accumulateVisible(performance.now());
  enqueue("page_time", { visible_ms: Math.round(view.visibleMs) }, { route: currentRoute, pageViewId: view.id });
}

function onVisibilityChange(): void {
  if (!view) return;
  if (document.visibilityState === "hidden") {
    checkpointPageTime();
    view.visibleSince = null;
    flush("beacon");
  } else {
    view.visibleSince = performance.now();
  }
}

function onPageHide(): void {
  if (!view) return;
  checkpointPageTime();
  view.visibleSince = null;
  flush("beacon");
}

/**
 * Mounted once in App: page views and foreground time per pathname change,
 * the session's auth_resolved transitions, periodic flushes, and the
 * hide-time beacon. Query-string changes (sort, filters) stay inside one
 * page view on purpose — they are controls on a page, not a new page.
 */
export function useUsageTracking(): void {
  const location = useLocation();
  const matches = useMatches();
  const { me } = useMe();
  // Render-phase stamp (idempotent module write, no React state): children
  // rendering under this layout, and their mount effects, already see the
  // page they belong to.
  if (typeof window !== "undefined") {
    const leaf = matches[matches.length - 1];
    const route = routeForMatchId(leaf?.id);
    desired = { route, key: location.pathname, props: pageViewProps(route, leaf?.data, location.state) };
  }
  const lastAuth = useRef<"guest" | "signed_in" | null>(null);

  useEffect(() => {
    if (!isEnabled()) return;
    syncPageView();
  }, [location.pathname]);

  useEffect(() => {
    if (me === undefined) return;
    const auth = me === null ? "guest" : "signed_in";
    if (lastAuth.current === auth) return;
    lastAuth.current = auth;
    track("auth_resolved", { auth });
  }, [me]);

  useEffect(() => {
    // Build flag only: the runtime checks (opt-out, storage, server 404)
    // live in track()/flush(), so opting back in on /privacy takes effect
    // without a reload while an opted-out tab pays only for idle timers.
    if (import.meta.env.VITE_USAGE_ANALYTICS_ENABLED !== "true") return;
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    const flushTimer = window.setInterval(() => flush("fetch"), FLUSH_INTERVAL_MS);
    const timeTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") checkpointPageTime();
    }, PAGE_TIME_CHECKPOINT_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.clearInterval(flushTimer);
      window.clearInterval(timeTimer);
    };
  }, []);
}

type BallotQueryState = {
  isPending: boolean;
  isError: boolean;
  data: { districts: { state: string }[]; elections: unknown[] } | undefined;
  error: unknown;
};

/**
 * One ballot_result per settled list load (ready / empty / error), shared by
 * the anonymous and saved ballot pages. Coarse by construction: US state
 * codes, count buckets, and which banners showed — never district ids.
 */
export function useTrackBallotResult(
  ballot: BallotQueryState,
  context: { scope: "exact" | "zip" | "region" | "unknown"; partialBanner: boolean; ambiguousBanner: boolean }
): void {
  const tracked = useRef<unknown>(undefined);
  const { scope, partialBanner, ambiguousBanner } = context;
  useEffect(() => {
    if (ballot.isPending) return;
    const settled = ballot.isError ? ballot.error : ballot.data;
    if (settled === undefined || tracked.current === settled) return;
    tracked.current = settled;
    const data = ballot.isError ? undefined : ballot.data;
    const states = [...new Set((data?.districts ?? []).map((district) => district.state))]
      .filter((state) => /^[A-Z]{2}$/.test(state))
      .slice(0, 3);
    track("ballot_result", {
      outcome: ballot.isError ? "error" : data && data.elections.length > 0 ? "ready" : "empty",
      scope,
      states,
      election_count_bucket: countBucket(data?.elections.length ?? 0),
      district_count_bucket: countBucket(data?.districts.length ?? 0),
      partial_banner: partialBanner,
      ambiguous_banner: ambiguousBanner,
    });
  }, [ballot.isPending, ballot.isError, ballot.data, ballot.error, scope, partialBanner, ambiguousBanner]);
}

/** Test seam: flushes the queue now (fetch path). */
export function flushUsageEventsForTests(): void {
  flush("fetch");
}

/** Test seam: wipes module state between tests. */
export function resetUsageForTests(): void {
  session = null;
  queue = [];
  inFlight = false;
  serverDisabled = false;
  optOutThisTab = null;
  currentRoute = "other";
  desired = null;
  view = null;
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

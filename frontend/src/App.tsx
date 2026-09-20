import { useEffect, useRef, useState } from "react";
import { Link, Outlet, ScrollRestoration, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChatWidget } from "./components/chatbot/ChatWidget";
import { DraftCompleteNotice } from "./components/DraftCompleteNotice";
import { EmbedHeader } from "./components/EmbedHeader";
import { RouteError } from "./components/RouteError";
import { TermsRenewalGate } from "./components/TermsRenewalGate";
import { APP_NAME, VERIFY_WITH_OFFICIALS_NOTE, apiRequest, COPYRIGHT_LINE, purgeAccountScopedQueries, useMe } from "@voteapp/api-client";
import { guardEmbedClick, useEmbedSession } from "./lib/embedSession";
import { importDraftHandoff, isDraftHandoffHash } from "./lib/ballotDraft";
import { savePendingDistrictIds } from "./lib/pendingDistricts";
import { useFlushBallotDraft } from "./lib/useFlushBallotDraft";
import { useDistrictHandoffRunner } from "./lib/districtHandoff";
import { myDraftLabel, useGuestDraftNav, useMyPicksProgress } from "./lib/usePickProgress";
import { trackSettled, useUsageTracking } from "./lib/usage";

/**
 * The signed-in account menu: a "Hi {first name} ▾" button that discloses
 * the low-frequency destinations (Mission, My Elections, My Candidates,
 * Settings, Sign Out). Collapsing them is what keeps the signed-in header to ONE line
 * on a 375px phone — the previous all-links-visible nav wrapped onto two
 * extra lines there. The greeting doubles as the trigger; dark navy +
 * semibold keeps it visually distinct from the plain links beside it.
 */
function AccountMenu({ firstName }: { firstName: string }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Signs out everywhere (all devices), not just this session: one button is
  // simpler for non-technical users than a this-device/everywhere pair.
  const logoutAll = useMutation({
    mutationFn: () => {
      const request = apiRequest<{ status: string }>("/api/auth/logout-all", { method: "POST", body: {} });
      trackSettled(request, "auth_result", { action: "logout", has_next: false });
      return request;
    },
    onSuccess: () => {
      queryClient.setQueryData(["me"], null);
      purgeAccountScopedQueries(queryClient);
      navigate("/");
      // Signing out while already on "/" keeps the pathname unchanged, so
      // the route-focus effect never fires — and this whole menu (with the
      // focused button) unmounts, dropping focus to <body>. Hand focus to
      // <main> ourselves; on other pages the effect targets it anyway.
      document.getElementById("main")?.focus({ preventScroll: true });
    },
  });

  // Light-dismiss: outside click/tap or Escape closes the menu.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // A keyboard user may have tabbed onto a link that is about to
        // unmount; hand focus back to the trigger so it doesn't drop to
        // <body>. (Activating a link is covered separately: navigation
        // moves focus to <main>.)
        if (menuRef.current?.contains(document.activeElement)) {
          triggerRef.current?.focus();
        }
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Any navigation closes the menu — covers the menu links themselves and
  // browser back/forward while it happens to be open.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <span ref={menuRef} className="relative flex min-w-0">
      {/* Disclosure, not a role="menu" menu: plain links behind an
          aria-expanded button (the APG disclosure-navigation pattern).
          role="menu" would announce application-menu semantics and demand
          arrow-key behavior these links don't have — so no aria-haspopup
          either, which implies exactly that. */}
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex min-w-0 items-center gap-1 text-sm font-semibold text-navy"
      >
        {/* min-w-0 + truncate: first names run to 80 chars; the name
            ellipsizes into the leftover row width instead of rewrapping the
            header. */}
        <span className="min-w-0 truncate">Hi {firstName}</span>
        <span aria-hidden="true" className="shrink-0 text-xs">
          ▾
        </span>
      </button>
      {open ? (
        // The panel's own click handler (not the pathname effect alone)
        // closes it on link activation: selecting the link for the page
        // already on screen leaves location.pathname unchanged, so the
        // effect never fires and the menu would stay open.
        <span
          onClick={() => setOpen(false)}
          className="absolute right-0 top-full z-10 mt-2 flex w-44 flex-col rounded-lg border border-line bg-white py-1 shadow-md"
        >
          <Link to="/me/ballot" className="px-4 py-2 text-ink-soft hover:bg-surface hover:text-ink">
            My Elections
          </Link>
          <Link to="/me/follows" className="px-4 py-2 text-ink-soft hover:bg-surface hover:text-ink">
            My Candidates
          </Link>
          <Link to="/mission" className="px-4 py-2 text-ink-soft hover:bg-surface hover:text-ink">
            Mission
          </Link>
          <Link to="/me/settings" className="px-4 py-2 text-ink-soft hover:bg-surface hover:text-ink">
            Settings
          </Link>
          {/* stopPropagation: the panel's onClick would close the menu, which
              would hide the pending/error states this button reports inline.
              Success navigates to "/", which closes the menu via the pathname
              effect (and unmounts this component once /api/me returns null). */}
          <button
            type="button"
            disabled={logoutAll.isPending}
            onClick={(event) => {
              event.stopPropagation();
              logoutAll.mutate();
            }}
            className="px-4 py-2 text-left text-ink-soft hover:bg-surface hover:text-ink disabled:cursor-not-allowed"
          >
            {logoutAll.isPending ? "Signing out…" : "Sign Out"}
          </button>
          {logoutAll.isError ? (
            <span role="alert" className="px-4 pb-2 text-xs text-red-700">
              Sign out failed. Try again.
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function AccountNav() {
  const { me } = useMe();
  const { pathname } = useLocation();
  // Header collection mechanic, both sides of the session: guests get a
  // "My Draft" link to /draft once they've seen a ballot or made a pick
  // (null — no link — before that), signed-in users get the same counter on
  // the My Picks link. Both flip to a ✓ when every race on the nearest
  // election day is decided. On the SSR pass the guest link is absent
  // (server snapshot is an empty draft), so the cached anonymous document
  // stays draft-free.
  const guestDraftNav = useGuestDraftNav();
  const picksProgress = useMyPicksProgress();

  // While /api/me is unresolved (SSR, or a cold-started API taking tens of
  // seconds), default to the logged-out links rather than an empty header —
  // an invisible Log in/Sign up costs signups, while a signed-in visitor
  // briefly seeing them is harmless and self-corrects when /api/me lands.
  if (!me) {
    // The address-search landing keeps the leanest header of all — just
    // Log in + Sign up. A returning guest's draft link would be noise on
    // the page whose whole job is starting a fresh search, and the Mission
    // pitch no longer rides in any guest header (the footer link keeps the
    // page reachable).
    const onSearchLanding = pathname === "/";
    const showDraftLink = !onSearchLanding && guestDraftNav !== null;
    return (
      <span className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 sm:gap-x-4">
        {showDraftLink ? (
          <Link
            to={guestDraftNav.to}
            className={
              guestDraftNav.complete
                ? "whitespace-nowrap font-semibold text-green-800 hover:text-green-900"
                : "whitespace-nowrap font-medium text-ink-soft hover:text-ink"
            }
          >
            {guestDraftNav.label}
          </Link>
        ) : null}
        {/* Measured at 375px: logo + draft link + Log in + Sign up cannot
            share one row, so with a draft link present the Log in link
            yields on phones — Sign up stays, and the register page's own
            "Log in" link keeps the path one tap away. */}
        <Link
          to="/login"
          className={
            showDraftLink ? "hidden text-ink-soft hover:text-ink sm:inline" : "text-ink-soft hover:text-ink"
          }
        >
          Log in
        </Link>
        <Link
          to="/register"
          className="whitespace-nowrap rounded-lg bg-rausch px-2.5 py-1.5 font-semibold text-white transition hover:bg-rausch-dark sm:px-3"
        >
          Sign up
        </Link>
      </span>
    );
  }

  // Label rules live in myDraftLabel (shared with the candidate page's
  // post-pick actions), mirroring the guest label rules.
  const draftLabel = myDraftLabel(picksProgress);

  // Two items, one line: the greeting/menu leads, the working document
  // (My Draft) stays a visible link beside it. Sign Out lives at the bottom
  // of the account menu — a rarely-used action doesn't earn header space.
  // min-w-0 down the chain (span → AccountMenu → name span): the row never
  // wraps; the NAME is what gives way, ellipsizing to whatever width is
  // left beside the draft link.
  return (
    <span className="flex min-w-0 items-center gap-x-2.5 sm:gap-x-4">
      <AccountMenu firstName={me.first_name} />
      <Link to="/me/picks" className="shrink-0 whitespace-nowrap text-ink-soft hover:text-ink">
        {draftLabel}
      </Link>
    </span>
  );
}

export function App() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const lastPathname = useRef(location.pathname);
  const embedSession = useEmbedSession();
  const navigate = useNavigate();
  const { me } = useMe();
  // Draft handoff from the newsroom box's "Save" link (lib/ballotDraft.ts).
  // Guests only: a link must never write picks into a signed-in account, so
  // for anyone else the fragment is just dropped. Waits for the session to
  // resolve, then clears the fragment either way.
  useEffect(() => {
    if (embedSession || me === undefined || !isDraftHandoffHash(location.hash)) {
      return;
    }
    if (me === null) {
      // The reader's exact ballot from the box arms the same district handoff
      // an address search on this site would: the districts become the new
      // account's saved ballot once it is verified.
      const { districtIds } = importDraftHandoff(location.hash);
      if (districtIds.length > 0) {
        savePendingDistrictIds(districtIds);
      }
    }
    navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true, state: location.state });
  }, [embedSession, me, location.hash, location.pathname, location.search, location.state, navigate]);
  // Replays a guest ballot draft into the account on login/registration.
  useFlushBallotDraft();
  // Initializes account districts from a guest address search once /api/me
  // reports a verified session, on whatever page the user landed.
  useDistrictHandoffRunner();
  // First-party usage analytics (docs/plans/usage-analytics.md): page views,
  // foreground time, auth transitions. Inert unless the build flag is set.
  useUsageTracking();

  // In-app navigation keeps focus wherever it was in the old page; move it
  // to the new page's content so keyboard and screen-reader users land where
  // sighted users look. Compared against the previous pathname (not a
  // first-render flag) so the initial load keeps the browser's default focus
  // even under StrictMode's double effect run.
  useEffect(() => {
    if (lastPathname.current === location.pathname) {
      return;
    }
    lastPathname.current = location.pathname;
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  // Inside the newsroom embed's frame (lib/embedSession.ts) the pages keep
  // their content but trade the site header and footer for the box's compact
  // chrome: no account links (a third-party frame has no session), no chat
  // bubble, and a click guard that sends every page outside the box to a new
  // tab.
  if (embedSession) {
    return (
      <div className="bg-page text-ink" onClickCapture={guardEmbedClick}>
        <div className="px-3 pt-3">
          <EmbedHeader />
        </div>
        <main id="main" ref={mainRef} tabIndex={-1} className="outline-none">
          <Outlet />
        </main>
        <ScrollRestoration />
      </div>
    );
  }

  // Mirrors AccountNav's landing test: "/" is the address-search landing.
  const onSearchLanding = location.pathname === "/";

  return (
    <div className="min-h-screen bg-page text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-20 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:shadow-md"
      >
        Skip to content
      </a>
      {/* On "/" the landing masthead carries a big centred wordmark
          (HomePage.tsx), so the header drops its own copy — one brand mark
          per page — and its border, so the white canvas runs unbroken from
          the top edge to the address field. */}
      <header className={onSearchLanding ? "bg-page" : "border-b border-line bg-page"}>
        {/* flex-wrap: when logo + nav outgrow the row (guest nav with the
            draft link at phone widths) the nav drops to its own line instead
            of the shrink-0 logo painting over it. ml-auto keeps the wrapped
            nav right-aligned. */}
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-4">
          {/* text-base below sm: the smaller logo is what buys the header
              its single line at 375px (measured: the text-xl wordmark alone
              is 185px of a 343px row). */}
          {onSearchLanding ? null : (
            <Link to="/" className="shrink-0 text-base font-extrabold tracking-tight text-rausch sm:text-xl">
              {APP_NAME}
            </Link>
          )}
          {/* min-w-0 (not shrink-0): the nav must be squeezable so the guest
              span's flex-wrap can still break links onto an extra line as a
              last resort on very narrow screens. */}
          <nav className="ml-auto flex min-w-0 items-center text-sm">
            <AccountNav />
          </nav>
        </div>
        {/* Second header row, empty until the draft's last race gets a pick
            (docs/plans/draft-completion-moment.md). In flow on purpose: it
            pushes the page down rather than covering the pick card. */}
        <DraftCompleteNotice />
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="outline-none">
        <Outlet />
      </main>
      <TermsRenewalGate />
      {/* Flag-guarded chatbot widget (docs/plans/chatbot-rag.md): floating
          lower-right bubble on most pages; the component owns its own
          per-route visibility and auth-wall rules. */}
      {import.meta.env.VITE_CHATBOT_ENABLED === "true" && <ChatWidget />}
      <ScrollRestoration />
      {/* The old footer repeated the home page's pitch line and buried the
          Disclaimer inside it. The pitch now sits in the hero where it is
          read, and the footer does the job a footer is for: reaching every
          document from every page, which is also what keeps the clickwrap's
          named documents permanently available rather than only at the gate. */}
      <footer className="mt-16 border-t border-line py-8 text-center text-xs text-ink-soft">
        {/* Reaches everyone who sees results, including the people the
            clickwrap never reached — a shared computer, someone else's phone,
            a link from a text message. For a reliance claim this line carries
            more weight than the agreement does, because it does not depend on
            the reader having accepted anything. It used to sit above the
            election list, where it read as an interruption; the footer keeps
            it on every page instead of only the ballot, and beside the
            Disclaimer link it already points at. Non-blocking by design. */}
        <p className="mb-3 px-4">{VERIFY_WITH_OFFICIALS_NOTE}</p>
        <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-5 gap-y-2">
          {/* Mission left the header (guests: gone entirely; signed-in: in
              the account menu) — the footer keeps it reachable from every
              page for the guests it pitches to. */}
          <Link to="/mission" className="underline hover:text-ink">
            Mission
          </Link>
          <Link to="/terms" className="underline hover:text-ink">
            Terms of Use
          </Link>
          <Link to="/privacy" className="underline hover:text-ink">
            Privacy Policy
          </Link>
          <Link to="/disclaimer" className="underline hover:text-ink">
            Disclaimer
          </Link>
        </nav>
        <p className="mt-4">{COPYRIGHT_LINE}</p>
      </footer>
    </div>
  );
}

export function ErrorBoundary() {
  return <RouteError />;
}

export default App;

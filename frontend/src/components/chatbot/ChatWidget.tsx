import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { useMutation } from "@tanstack/react-query";
import {
  askChatbot,
  ApiError,
  CHATBOT_MAX_QUESTION_LENGTH,
  CHATBOT_PRIVACY_NOTE,
  submitChatbotFeedback,
  useMe,
} from "@voteapp/api-client";
import type { ChatbotAskContext, ChatbotAskResponse, ChatbotResultCard, ContentReportEntityType } from "@voteapp/api-client";

import { ReportContentButton } from "../ReportContentButton";
import { chatSourceBucket, countBucket, currentAttribution, errorCategoryOf, positionBucket, track, trackSettled } from "../../lib/usage";

// Floating "Ask" widget (docs/plans/chatbot-rag.md Phase 1): a minimized
// bubble in the lower-right on most pages, expanding to a small chat box.
// Answers come only from VoteApp's database — deterministic templates and
// search-result cards, no generated prose. The widget exists to answer
// questions about whatever the user encounters while browsing: it remembers
// the current (or most recent) candidate/election page and sends it as
// context, so "tell me more about this candidate" resolves deterministically
// server-side. Verified accounts only: logged-out visitors see a register
// prompt, unverified accounts a verify prompt (server enforces with 401/403).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Current page → widget context, or null on non-detail pages. */
export function contextFromPathname(pathname: string): ChatbotAskContext | null {
  const match = /^\/(candidates|elections)\/([^/]+)$/.exec(pathname);
  if (!match || !UUID_RE.test(match[2] as string)) {
    return null;
  }
  return { kind: match[1] === "candidates" ? "candidate" : "election", id: match[2] as string };
}

const ELECTION_ROSTER_CHIP = "Who is running in this election?";

/** Tappable starter questions for an empty chat — the SAME on every page.
 * Page-specific chips were removed twice for the same reason: candidate
 * chips in #767, election chips by request 2026-08-21 (the election page
 * already shows the roster and details a "tell me more" chip would repeat).
 * No register chip either: the site header already links voter registration
 * — the second slot instead showcases the personalized saved-issues match,
 * which no page shows outside the ballot page's my-areas sort. */
export const STARTER_QUESTIONS = ["What can you do?", "Which races affect issues I care about?"] as const;

/**
 * Where the widget stays hidden: the logged-out home page (first-visit
 * pitch), the public pick-card share page (a friend's shared link, not a
 * member browsing), and the auth flows themselves.
 */
export function isChatWidgetHidden(pathname: string, isLoggedIn: boolean): boolean {
  if (pathname === "/" && !isLoggedIn) {
    return true;
  }
  if (pathname.startsWith("/picks/")) {
    return true;
  }
  return ["/login", "/register", "/forgot-password", "/reset-password", "/verify-email", "/verify-email-change"].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
}

function ResultCardLink({ card, position }: { card: ChatbotResultCard; position: number }) {
  const body = (
    <>
      <p className="text-sm font-semibold text-ink">{card.title}</p>
      <p className="mt-0.5 text-xs text-ink-soft">{card.snippet}</p>
    </>
  );
  const className = "block rounded-lg border border-line px-3 py-2 transition hover:border-ink-soft hover:bg-surface";
  // Usage: which kind of card gets clicked and how far down — never its URL.
  const onClick = () =>
    track("chat_result_click", { source: chatSourceBucket(card.source_type), position_bucket: positionBucket(position) });
  // Official state resources are absolute external URLs; everything else is
  // a site-relative page. Both are server-constructed.
  if (card.url.startsWith("http://") || card.url.startsWith("https://")) {
    return (
      <a href={card.url} target="_blank" rel="noopener noreferrer" onClick={onClick} className={className}>
        {body}
        <p className="mt-0.5 text-xs text-ink-soft">Official resource ↗</p>
      </a>
    );
  }
  return (
    <Link to={card.url} onClick={onClick} className={className}>
      {body}
    </Link>
  );
}

function formatDataCurrentAsOf(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export type Turn = { question: string; response: ChatbotAskResponse };

/** The previous turn's question to send for scope carry-over, or null. The
 * server appends the previous question to a scopeless follow-up so its
 * district/candidate words join the match — append-only, so a refused turn's
 * words only ADD terms the next question must then match. Observed
 * 2026-10-25: "which candidate is in state assembly district 48" refused
 * because the preceding refused "highest vote power" question rode along.
 * Refusals therefore carry nothing; answered and clarified turns still do
 * (a clarification's "which state?" needs the question being scoped). */
export function carriedPreviousQuestion(turns: ReadonlyArray<Turn>): string | null {
  const last = turns[turns.length - 1];
  if (!last) {
    return null;
  }
  if (last.response.outcome === "refuse_no_data" || last.response.outcome === "refuse_policy") {
    return null;
  }
  return last.question;
}
type ChatEntry = "typed" | "starter" | "followup";
// Server answer kinds the usage catalog knows; anything newer is "other".
const CHAT_ANSWER_KINDS: ReadonlySet<string> = new Set(["template", "retrieval", "clarify", "refuse_no_data", "refuse_policy"]);

/** The one election an answer cited, as ask context — null when it cited
 * zero or several distinct elections. Off detail pages the deictic roster
 * chip has nothing else to resolve against (the saved-issues answer is
 * personalized, so its previous-question text carries no scope either), so
 * the chip click sends this as context. URLs are server-constructed
 * (/elections/<id>), so parsing them is safe here. */
export function citedElectionContext(response: ChatbotAskResponse): ChatbotAskContext | null {
  const ids = new Set<string>();
  for (const card of response.results) {
    if (card.source_type === "election") {
      const match = /^\/elections\/([0-9a-f-]{36})$/i.exec(card.url);
      if (match) {
        ids.add((match[1] as string).toLowerCase());
      }
    }
  }
  const [id] = ids;
  return ids.size === 1 && id ? { kind: "election", id } : null;
}

/** Deterministic follow-up chips under the latest answer, derived from what
 * it cited (docs/plans/chatbot-improvements-2026-08.md PR 3). Deictic
 * phrasings on purpose: the server resolves "their"/"this" against the
 * remembered page context or the carried previous question, so the chips
 * drive free next hops (profile → finance, election → roster). Two guards
 * keep them honest: a facet the answer ALREADY cited is not re-suggested
 * (finance cards → no funding chip), and neither is the question just
 * asked (a starter chip must not reappear as its own follow-up). Several
 * cited candidates is fine on purpose: "their" reads as plural, and the
 * previous-question carry scopes retrieval to those candidates — the
 * roster-answer → race-wide-funding hop is the chip's best case, so no
 * exactly-one-candidate restriction. The roster chip is the opposite case:
 * "this election" is singular, so it needs exactly ONE cited election — an
 * answer citing several races (the saved-issues match lists up to five)
 * gets no roster chip. A third guard: a chip whose answer the
 * CURRENT page already shows is redundant (funding on a candidate profile,
 * the roster on an election page) — suppress it there. */
export function followUpQuestions(
  response: ChatbotAskResponse,
  askedQuestion: string,
  context: ChatbotAskContext | null = null
): string[] {
  const cited = new Set(response.results.map((card) => card.source_type));
  const suggestions: string[] = [];
  if (cited.has("candidate_profile") && !cited.has("finance_summary") && context?.kind !== "candidate") {
    suggestions.push("Who is funding their campaign?");
  }
  if (citedElectionContext(response) !== null && context?.kind !== "election") {
    suggestions.push(ELECTION_ROSTER_CHIP);
  }
  const asked = askedQuestion.trim().toLowerCase();
  return suggestions.filter((suggestion) => suggestion.toLowerCase() !== asked);
}

/** The entity behind an AI answer's first cited source — what a content
 * report about the answer should attach to. URLs are server-constructed
 * (/candidates/<id> or /elections/<id>), so parsing them is safe here. */
export function reportTargetFromResults(
  results: readonly ChatbotResultCard[]
): { entityType: ContentReportEntityType; entityId: string } | null {
  for (const card of results) {
    const match = /^\/(candidates|elections)\/([0-9a-f-]{36})$/i.exec(card.url);
    if (match) {
      return {
        entityType: match[1] === "candidates" ? "candidate" : "election",
        entityId: match[2] as string,
      };
    }
  }
  return null;
}

/** One-shot 👍/👎 under an answer (docs/plans/chatbot-improvements-2026-08.md
 * PR 2). The thanks copy appears only after the server confirmed the vote —
 * an optimistic "Thanks" would silently lose feedback on network failures.
 * A transient failure reverts to the buttons (they ARE the retry control);
 * a 400 means the token itself was rejected (it died with a server restart),
 * so retrying can never succeed — give up honestly instead. */
function FeedbackButtons({ token }: { token: string }) {
  const feedback = useMutation({
    mutationFn: (verdict: "up" | "down") => {
      const request = submitChatbotFeedback(token, verdict);
      trackSettled(request, "chat_feedback", { verdict });
      return request;
    },
  });
  if (feedback.isSuccess) {
    return <p className="text-xs text-ink-soft">Thanks for the feedback.</p>;
  }
  if (feedback.error instanceof ApiError && feedback.error.status === 400) {
    return <p className="text-xs text-ink-soft">Couldn't record feedback for this answer.</p>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-xs text-ink-soft">Helpful?</span>
      <button
        type="button"
        aria-label="Good answer"
        disabled={feedback.isPending}
        onClick={() => feedback.mutate("up")}
        className="rounded px-1 text-xs transition hover:bg-surface disabled:opacity-50"
      >
        👍
      </button>
      <button
        type="button"
        aria-label="Bad answer"
        disabled={feedback.isPending}
        onClick={() => feedback.mutate("down")}
        className="rounded px-1 text-xs transition hover:bg-surface disabled:opacity-50"
      >
        👎
      </button>
      {feedback.isError && <span className="text-xs text-rausch-dark">Couldn't save — try again.</span>}
    </span>
  );
}

function TurnView({ turn, reporterEmail }: { turn: Turn; reporterEmail: string | null }) {
  const isAi = turn.response.ai_generated === true;
  const reportTarget = isAi ? reportTargetFromResults(turn.response.results) : null;
  return (
    <div>
      {/* aria-live="off" excludes the echoed question from the transcript's
          polite region — the user just typed it; re-announcing it before the
          answer is noise. Still reachable by normal SR navigation. */}
      <p aria-live="off" className="ml-8 rounded-xl bg-surface px-3 py-2 text-sm text-ink">{turn.question}</p>
      <p className="mt-2 whitespace-pre-line text-sm text-ink">{turn.response.answer}</p>
      {/* Honest-degradation line (PR 3): deterministic server copy, e.g. the
          daily AI-answer limit fell back to cards. Muted, above the cards it
          explains. */}
      {turn.response.notice && <p className="mt-1 text-xs italic text-ink-soft">{turn.response.notice}</p>}
      {turn.response.results.length > 0 && (
        <ul className="mt-2 space-y-2">
          {/* URL alone is NOT unique: a candidate's profile/finance/record
              cards deliberately share one page URL. Static list, so the
              index disambiguates safely. */}
          {turn.response.results.map((card, index) => (
            <li key={`${index}:${card.source_type}:${card.url}`}>
              <ResultCardLink card={card} position={index + 1} />
            </li>
          ))}
        </ul>
      )}
      {/* BEHAVIOR.md rule 9 (amended by request 2026-08-19): the AI label
          and data-current date moved to ONE static line in the panel footer
          — repeating them under every answer read as noise. The per-answer
          report control stays: it attaches to the first cited entity, whose
          page holds the data behind the answer. */}
      {isAi && reportTarget && (
        <div className="mt-1.5">
          <ReportContentButton
            entityType={reportTarget.entityType}
            entityId={reportTarget.entityId}
            contextLabel="this AI answer"
            reporterEmail={reporterEmail}
          />
        </div>
      )}
      {turn.response.feedback_token && (
        <div className="mt-1.5">
          <FeedbackButtons token={turn.response.feedback_token} />
        </div>
      )}
    </div>
  );
}

/** The register/verify walls. The widget stays visible to logged-out
 * visitors on purpose: opening it is the acquisition prompt. */
function AccessPrompt({ kind }: { kind: "register" | "verify" }) {
  // The register wall is a sign-up prompt like the follow/pick dialogs;
  // usage counts it shown once per mount and its links when clicked.
  useEffect(() => {
    if (kind === "register") {
      track("signup_prompt", { source: "chat", action: "shown" });
    }
  }, [kind]);
  if (kind === "register") {
    const onLinkClick = () => track("signup_prompt", { source: "chat", action: "click" });
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-sm text-ink">
          Ask questions about the candidates and elections you're looking at — free with an account.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link
            to="/register"
            onClick={onLinkClick}
            className="rounded-lg bg-rausch px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-rausch-dark"
          >
            Sign up
          </Link>
          <Link to="/login" onClick={onLinkClick} className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink">
            Log in
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-sm text-ink">Verify your email to use Ask — check your inbox for the verification link.</p>
      <Link to="/me/settings" className="mt-3 inline-block text-sm text-rausch underline">
        Account settings
      </Link>
    </div>
  );
}

/** Fresh auth identity → fresh widget. Remounting on login/logout/account
 * switch resets EVERYTHING at once — open state (a panel opened before the
 * login flow must not greet the new session already expanded), the
 * transcript and remembered page context (on a shared browser the previous
 * account's questions and viewed pages must not carry over — same reason
 * purgeAccountScopedQueries exists), and any in-flight ask (a slow answer
 * settling after the switch lands on the unmounted instance, a no-op,
 * instead of the next account's chat). */
export function ChatWidget() {
  const { me } = useMe();
  // The epoch bumps only when a RESOLVED identity CHANGES — never when the
  // initial /api/me load settles (undefined → user), which must not snap
  // shut a widget opened while that request was still in flight.
  const resolved = me === undefined ? null : (me?.email ?? "anon");
  const lastResolved = useRef<string | null>(null);
  const epoch = useRef(0);
  if (resolved !== null) {
    if (lastResolved.current !== null && resolved !== lastResolved.current) {
      epoch.current += 1;
    }
    lastResolved.current = resolved;
  }
  return <ChatWidgetSession key={epoch.current} />;
}

function ChatWidgetSession() {
  const location = useLocation();
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  // Latest dated answer feeds the single footer disclosure line.
  const latestDataCurrentAsOf =
    [...turns].reverse().find((turn) => turn.response.data_current_as_of)?.response.data_current_as_of ?? null;
  // The current or most recent candidate/election page this session — the
  // "what the user is looking at" the server resolves deictic questions
  // against. Kept after navigating away so "their record?" asked from the
  // ballot page still means the candidate just viewed.
  const [context, setContext] = useState<ChatbotAskContext | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const pageContext = contextFromPathname(location.pathname);
    if (pageContext) {
      setContext(pageContext);
    }
  }, [location.pathname]);

  const ask = useMutation({
    mutationFn: (input: {
      question: string;
      previousQuestion: string | null;
      context: ChatbotAskContext | null;
      entry: ChatEntry;
    }) => {
      const request = askChatbot(input.question, { previousQuestion: input.previousQuestion, context: input.context });
      // Usage (docs/plans/usage-analytics.md): how the question was entered
      // and what kind of answer came back — never the text. Recorded from
      // inside mutationFn, on the page the question was asked from, so an
      // answer that lands after the widget remounts still counts.
      const attribution = currentAttribution();
      const base = { entry: input.entry, context_kind: input.context?.kind ?? "none", first_turn: input.previousQuestion === null };
      request.then(
        (response) =>
          track(
            "chat_ask",
            {
              ...base,
              outcome: "ok",
              answer: CHAT_ANSWER_KINDS.has(response.outcome) ? response.outcome : "other",
              result_count_bucket: countBucket(response.results.length),
              ai_generated: response.ai_generated === true,
            },
            attribution
          ),
        (error: unknown) => track("chat_ask", { ...base, outcome: "error", error_category: errorCategoryOf(error) }, attribution)
      );
      return request;
    },
    onSuccess: (response, input) => {
      setTurns((previous) => [...previous, { question: input.question, response }]);
    },
  });

  useEffect(() => {
    // Optional-call: jsdom (tests) has no Element.scrollTo.
    transcriptRef.current?.scrollTo?.({ top: transcriptRef.current.scrollHeight });
  }, [turns, ask.isPending]);

  // Keyboard flow (PR 3 a11y): opening moves focus into the question input —
  // or onto the panel itself on the register/verify walls, which render no
  // input (the launcher just unmounted, so without this fallback focus drops
  // to body and a keyboard user is stranded outside the dialog; panel focus
  // also makes Escape work there). Closing hands focus back to the launcher
  // bubble. wasOpen keeps the initial mount (open=false, nothing to restore)
  // from yanking focus to a launcher the user never touched.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      (inputRef.current ?? panelRef.current)?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      launcherRef.current?.focus();
    }
  }, [open]);

  if (isChatWidgetHidden(location.pathname, Boolean(me))) {
    return null;
  }

  function sendQuestion(text: string, entry: ChatEntry, contextOverride: ChatbotAskContext | null = null) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || ask.isPending) {
      return;
    }
    ask.mutate({
      question: trimmed,
      previousQuestion: carriedPreviousQuestion(turns),
      context: contextOverride ?? context,
      entry,
    });
    setQuestion("");
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    sendQuestion(question, "typed");
  }

  const accessKind = !me ? "register" : !me.email_verified ? "verify" : null;
  // A mid-session 401/403 (expired session, un-verified elsewhere) gets the
  // same walls as the client-side check.
  const errorAccessKind =
    ask.error instanceof ApiError && ask.error.status === 401
      ? "register"
      : ask.error instanceof ApiError && ask.error.status === 403
        ? "verify"
        : null;
  // The one wall the panel will show — rendering and the chat_open event
  // read the same value, so a reopen after a mid-session 401 is counted
  // as the register wall it displays.
  const wall = accessKind ?? errorAccessKind;
  const notAvailable = ask.error instanceof ApiError && ask.error.status === 404;

  if (!open) {
    return (
      <button
        type="button"
        ref={launcherRef}
        onClick={() => {
          track("chat_open", { context_kind: context?.kind ?? "none", wall: wall ?? "none" });
          setOpen(true);
        }}
        aria-label="Open Ask"
        className="chat-launcher fixed bottom-4 right-4 z-30 rounded-full border border-line bg-white px-4 py-3 text-sm font-semibold text-ink shadow-lg transition hover:bg-surface"
      >
        Ask
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Ask about elections and candidates"
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        // Escape minimizes from anywhere in the panel (PR 3 a11y); the
        // focus-restore effect then returns focus to the launcher. Portal
        // guard: React bubbles synthetic events through the COMPONENT tree,
        // so Escape inside the portaled report dialog (Headless UI portals
        // to body) would land here too — minimizing the widget unmounts
        // ReportContentButton and destroys its preserved draft. A portaled
        // target is not a DOM descendant of this panel, so contains() skips
        // exactly those events; Headless UI still closes its own dialog.
        if (event.key === "Escape" && event.currentTarget.contains(event.target as Node)) {
          setOpen(false);
        }
      }}
      className="fixed bottom-4 right-4 z-30 flex max-h-[75vh] w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-2xl border border-line bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between rounded-t-2xl border-b border-line bg-surface px-3 py-2">
        <p className="text-sm font-bold text-ink">Ask</p>
        <div className="flex items-center gap-1">
          {/* Back to the empty-chat start screen (starter chips included) —
              without this, the only way out of a conversation was a page
              reload. A NEW chat must not inherit the old one's remembered
              context either: after navigating away, "their record?" would
              silently answer about a candidate no longer on screen. Reset to
              the CURRENT page's context (null off detail pages). */}
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (ask.isPending) {
                  return;
                }
                setTurns([]);
                setQuestion("");
                setContext(contextFromPathname(location.pathname));
                ask.reset();
              }}
              className="rounded px-2 py-0.5 text-xs text-ink-soft hover:text-ink"
            >
              New chat
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Minimize Ask"
            className="rounded px-2 py-0.5 text-ink-soft hover:text-ink"
          >
            —
          </button>
        </div>
      </div>

      {wall ? (
        <AccessPrompt kind={wall} />
      ) : (
        <>
          <div ref={transcriptRef} className="min-h-[8rem] flex-1 overflow-y-auto px-3 py-3">
            {turns.length === 0 && !ask.isPending && (
              <div>
                <p className="text-sm text-ink-soft">
                  Ask about the November 2026 elections we cover: candidates, records, campaign finance, elections, and
                  ballot measures. Answers come only from our data — never opinions or endorsements.
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {STARTER_QUESTIONS.map((starter) => (
                    <button
                      key={starter}
                      type="button"
                      onClick={() => sendQuestion(starter, "starter")}
                      className="rounded-full border border-line px-2.5 py-1 text-xs text-ink transition hover:border-ink-soft hover:bg-surface"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Answers, pending copy, and errors announce politely to screen
                readers (PR 3 a11y). The follow-up chips live OUTSIDE the
                region: announcing suggestion buttons as if they were answer
                text is noise. */}
            <div aria-live="polite">
              <div className="space-y-4">
                {turns.map((turn, index) => (
                  <TurnView key={index} turn={turn} reporterEmail={me?.email ?? null} />
                ))}
              </div>
              {ask.isPending && <p className="mt-3 text-sm text-ink-soft">Looking that up…</p>}
              {ask.isError &&
                !errorAccessKind &&
                (notAvailable ? (
                  <p className="mt-3 text-sm text-ink-soft">Ask isn't available right now. Please try again later.</p>
                ) : (
                  <p className="mt-3 rounded-lg border border-rausch/40 bg-rausch/5 px-2 py-1.5 text-xs text-rausch-dark">
                    Something went wrong. Please try again.
                  </p>
                ))}
            </div>
            {turns.length > 0 && !ask.isPending && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {followUpQuestions(
                  (turns[turns.length - 1] as Turn).response,
                  (turns[turns.length - 1] as Turn).question,
                  contextFromPathname(location.pathname)
                ).map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => {
                      // The roster chip may be clicked off any detail page
                      // (e.g. after the saved-issues answer on Settings),
                      // where neither page context nor the previous
                      // question's text can scope "this election" — so the
                      // click carries the cited election as context, and
                      // remembers it for typed deictic follow-ups.
                      const electionContext =
                        suggestion === ELECTION_ROSTER_CHIP
                          ? citedElectionContext((turns[turns.length - 1] as Turn).response)
                          : null;
                      if (electionContext) {
                        setContext(electionContext);
                      }
                      sendQuestion(suggestion, "followup", electionContext);
                    }}
                    className="rounded-full border border-line px-2.5 py-1 text-xs text-ink transition hover:border-ink-soft hover:bg-surface"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
          <form onSubmit={submit} className="border-t border-line p-2">
            <div className="flex gap-1.5">
              <label htmlFor="chat-widget-question" className="sr-only">
                Your question
              </label>
              <input
                id="chat-widget-question"
                ref={inputRef}
                type="text"
                value={question}
                maxLength={CHATBOT_MAX_QUESTION_LENGTH}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Ask about what you're looking at…"
                className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-soft focus:border-ink-soft focus:outline-none"
              />
              <button
                type="submit"
                disabled={ask.isPending || question.trim().length === 0}
                className="shrink-0 rounded-lg bg-rausch px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-rausch-dark disabled:opacity-50"
              >
                Ask
              </button>
            </div>
            {/* BEHAVIOR.md rule 9: the AI-generated label and data-current
                date live HERE, once per panel, instead of under every answer
                (moved by request 2026-08-19 — per-answer repeats were noise).
                The date is the latest answer's data_current_as_of. */}
            <p className="mt-1 px-0.5 text-[10px] leading-tight text-ink-soft">
              AI answers from our election data — may contain mistakes.
              {latestDataCurrentAsOf && ` Data current as of ${formatDataCurrentAsOf(latestDataCurrentAsOf)}.`}{" "}
              {CHATBOT_PRIVACY_NOTE}
            </p>
          </form>
        </>
      )}
    </div>
  );
}

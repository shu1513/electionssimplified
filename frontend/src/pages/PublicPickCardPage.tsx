import { isRouteErrorResponse, Link, useLoaderData, useLocation, useRouteError } from "react-router";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { APP_NAME, formatElectionDate } from "@voteapp/api-client";
import type { PickCard, PickCardEntry } from "@voteapp/api-client";
import type { BackTo } from "../lib/detailNavContext";
import { NotFoundNotice } from "../components/NotFoundNotice";
import { RouteError } from "../components/RouteError";
import { loadFromApi } from "../lib/loadFromApi";
import { pageMeta, SITE_ORIGIN } from "../lib/pageMeta";

// The public face of a shared pick card: /picks/<token>. The token in the
// path is the whole authorization, and loadFromApi never forwards cookies.
// Shows a LIVE view of one voter's picks for one election day, headed by
// the owner's first name — the point of sharing is "these are MY picks",
// and a nameless card reads as anonymous data, not a friend's choices.
// First name is the payload's only identity field (userPickCardShares.ts).

// "Shu's choices for November 3, 2026 elections" — the page h1 and the
// share-card title both. Falls back to the unnamed form when a
// not-yet-redeployed backend omits first_name (deploy skew).
function cardTitle(card: PickCard): string {
  const date = formatElectionDate(card.election_date);
  return card.first_name
    ? `${card.first_name}'s choices for ${date} elections`
    : `Election Picks for ${date}`;
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // React Router decodes path params; re-encode so a token containing ?, #,
  // or % travels as an opaque path segment instead of re-shaping the URL.
  return loadFromApi<PickCard>(`/api/pick-cards/${encodeURIComponent(params.token ?? "")}`, request);
}

export const meta: MetaFunction<typeof loader> = ({ data, error, location, params }) => {
  if (!data) {
    const isNotFound = isRouteErrorResponse(error) && error.status === 404;
    return [{ title: isNotFound ? `Not found · ${APP_NAME}` : `Something went wrong · ${APP_NAME}` }];
  }
  const raceCount = data.entries.length;
  return [
    ...pageMeta({
      title: `${cardTitle(data)} · ${APP_NAME}`,
      description: `${raceCount} race${raceCount === 1 ? "" : "s"} picked for the ${formatElectionDate(data.election_date)} election on ${APP_NAME}.`,
      path: location.pathname,
      // Per-share generated image ("See Shu's picks for Nov 3, 2026
      // Elections") — the picture dominates the preview card in messaging
      // apps, so it, not just the title, must carry the owner's name.
      image: {
        url: `${SITE_ORIGIN}/api/pick-cards/${encodeURIComponent(params.token ?? "")}/og-image.png`,
        alt: cardTitle(data),
      },
    }),
    // Unguessable capability URLs must stay out of search indexes: the link
    // is shared person-to-person, not published.
    { name: "robots", content: "noindex" },
  ];
};

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundNotice subject="Pick card" />;
  }
  return <RouteError />;
}

// Outcome chip for a measure pick — same rules and styling as the owner's
// card (see PicksPage): the word states the fact, the color says how it
// landed for the card's owner; anything but "passed"/"failed" renders
// nothing.
function measureOutcomeChip(position: "yes" | "no", result: string | null | undefined) {
  if (result !== "passed" && result !== "failed") {
    return null;
  }
  const matchedPick = (result === "passed") === (position === "yes");
  const label = result === "passed" ? "Passed" : "Failed";
  // Leading space: margin is only visual, and without it the copy/accessible
  // text runs the pick into the label ("YesPassed").
  return (
    <>
      {" "}
      {matchedPick ? (
        <span className="rounded bg-green-700 px-1.5 py-0.5 text-xs font-semibold text-white">{label}</span>
      ) : (
        <span className="rounded bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-soft">{label}</span>
      )}
    </>
  );
}

// Candidacy-status chip — same rules, styling, and vocabulary as the owner's
// card (PicksPage.pickStatusChip). All five terminal statuses render: the
// certified writer projects advanced/runoff onto winners, and a recipient
// must not read a certified "advanced" as no outcome. The withdrawn flag
// keeps a dropped-out candidate from reading as still running.
function pickStatusChip(status: string) {
  if (status === "won" || status === "advanced" || status === "runoff") {
    return (
      <>
        {" "}
        <span className="rounded bg-green-700 px-1.5 py-0.5 text-xs font-semibold text-white">
          {status === "won" ? "Won" : status === "advanced" ? "Advanced" : "In runoff"}
        </span>
      </>
    );
  }
  if (status === "lost") {
    return (
      <>
        {" "}
        <span className="rounded bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-soft">Lost</span>
      </>
    );
  }
  if (status === "withdrawn") {
    return (
      <>
        {" "}
        <span className="text-xs text-ink-soft">(withdrew)</span>
      </>
    );
  }
  return null;
}

// Result-derived chip for a pick the candidacy pipeline hasn't labeled yet —
// same rules as the owner's card (PicksPage): election-night calls arrive as
// result rows (outcome + winner ids) long before candidate_elections.status
// flips to won/lost. Id-only matching, decisive outcomes only, and silence
// when the pick isn't among the winners.
function pickResultChip(entry: PickCardEntry, candidateId: string) {
  const outcome = entry.current_result_outcome;
  if (outcome !== "won" && outcome !== "advanced" && outcome !== "runoff") {
    return null;
  }
  if (!(entry.current_result_winners ?? []).some((winner) => winner.candidate_id === candidateId)) {
    return null;
  }
  // Same vocabulary as the election page's badges: a runoff berth is its
  // own state, not a generic "Advanced". Leading space keeps the copy/
  // accessible text from running the name into the label.
  return (
    <>
      {" "}
      <span className="rounded bg-green-700 px-1.5 py-0.5 text-xs font-semibold text-white">
        {outcome === "won" ? "Won" : outcome === "advanced" ? "Advanced" : "In runoff"}
      </span>
    </>
  );
}

export function PublicPickCardPage() {
  const card = useLoaderData<typeof loader>();
  // The anonymous card is still a real origin: detail pages reached from it
  // link back to this tokenized URL. Shape satisfies both nav-state types.
  const location = useLocation();
  const shareNavState: { backTo: BackTo } = {
    backTo: { path: location.pathname, label: "Shared picks" },
  };

  return (
    <div className="mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px]">
      <section className="rounded-xl border border-line bg-surface p-5">
        <h1 className="text-title font-bold text-ink">{cardTitle(card)}</h1>
        <p className="mt-1 text-sm text-ink-soft">Shared from {APP_NAME}.</p>
        {card.entries.length === 0 ? (
          <p className="mt-4 text-sm text-ink-soft">This card has no picks right now.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {card.entries.map((entry) => (
              <li key={entry.election_id} className="text-sm">
                <Link
                  to={`/elections/${entry.election_id}`}
                  state={shareNavState}
                  className="font-medium text-ink hover:text-rausch"
                >
                  {entry.official_ballot_title}
                </Link>
                <span className="text-ink-soft"> · {entry.district_name}</span>
                <p className="mt-0.5">
                  {entry.measure_position !== null ? (
                    <span
                      className={
                        entry.measure_position === "yes"
                          ? "font-semibold text-green-900"
                          : "font-semibold text-red-900"
                      }
                    >
                      {entry.measure_position === "yes" ? "Yes" : "No"} on{" "}
                      {entry.race_type === "office" ? "keeping this judge" : "this measure"}
                      {/* Certified measure result first; before it lands, the
                          canonical result row's election-night passed/failed
                          fills in — same fallback as the owner's card. */}
                      {measureOutcomeChip(
                        entry.measure_position,
                        entry.measure_result ?? entry.current_result_outcome
                      )}
                    </span>
                  ) : (
                    <span className="font-semibold text-green-900">
                      {entry.picks.map((pick, index) => (
                        <span key={pick.candidate_id}>
                          {index > 0 ? ", " : null}
                          <Link
                            to={`/candidates/${pick.candidate_id}`}
                            state={shareNavState}
                            className="hover:text-rausch"
                          >
                            {pick.display_name}
                          </Link>
                          {pickStatusChip(pick.candidacy_status) ??
                            // candidacy_status has nothing to say yet —
                            // fall back to the canonical result row.
                            pickResultChip(entry, pick.candidate_id)}
                        </span>
                      ))}
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* The share loop's landing pitch: the reader arrived from a friend's
          card, so the next step is making their own. */}
      <p className="mt-6 text-center text-sm">
        <Link
          to="/"
          className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
        >
          Research your own ballot on {APP_NAME}
        </Link>
      </p>
    </div>
  );
}

export default PublicPickCardPage;

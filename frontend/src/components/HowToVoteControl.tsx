import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@voteapp/api-client";
import type { StateVotingResources, StateVotingResourcesResult } from "@voteapp/api-client";
import { track } from "../lib/usage";

/** Display form of a link's destination so voters see where they're headed. */
function linkHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function OfficialLink({
  url,
  label,
  kind,
}: {
  url: string;
  label: string;
  kind: "mail" | "polling" | "registration";
}) {
  const host = linkHost(url);
  return (
    <p className="text-sm">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => track("list_control", { control: "how_to_vote_link", value: kind })}
        className="font-medium text-ink underline underline-offset-2 hover:text-rausch"
      >
        {label}
      </a>
      {host ? <span className="ml-2 text-xs text-ink-soft">{host}</span> : null}
    </p>
  );
}

/**
 * The mail block leads (it's the option a voter can act on from home) and its
 * wording follows the researched request type, because "sign up for mail
 * voting" is wrong in automatic vote-by-mail states — there is nothing to
 * sign up for.
 */
function MailSection({ resources }: { resources: StateVotingResources }) {
  const { mail_ballot_request_url, mail_ballot_request_type, mail_ballot_request_deadline_rule } = resources;
  if (!resources.mail_voting_available || !mail_ballot_request_url) {
    return null;
  }

  const label =
    mail_ballot_request_type === "not_required"
      ? "How vote-by-mail works"
      : mail_ballot_request_type === "online_portal"
        ? "Request your ballot online"
        : mail_ballot_request_type === "form"
          ? "Get the mail-ballot application"
          : "Request a mail ballot";

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">Vote by mail</p>
      {mail_ballot_request_type === "not_required" ? (
        <p className="mt-1 text-sm text-ink-soft">
          Every registered {resources.state_name} voter is mailed a ballot automatically — no request needed.
        </p>
      ) : null}
      <div className="mt-1">
        <OfficialLink url={mail_ballot_request_url} label={label} kind="mail" />
      </div>
      {mail_ballot_request_deadline_rule ? (
        <p className="mt-1 text-xs text-ink-soft">{mail_ballot_request_deadline_rule}</p>
      ) : null}
    </div>
  );
}

function StateResourcesSection({ state, showStateName }: { state: string; showStateName: boolean }) {
  const query = useQuery({
    queryKey: ["state-resources", state],
    queryFn: () =>
      apiRequest<StateVotingResourcesResult>(`/api/state-resources?state=${encodeURIComponent(state)}`),
    // Official links change on a research cadence, not per visit.
    staleTime: 60 * 60 * 1000,
  });

  if (query.isPending) {
    return <p className="text-sm text-ink-soft">Loading voting resources…</p>;
  }
  if (query.isError) {
    return <p className="text-sm text-ink-soft">Voting resources for {state} aren't available right now.</p>;
  }

  const resources = query.data.state_resources;
  const hasMail = resources.mail_voting_available && resources.mail_ballot_request_url !== null;
  // Registration leads: it is the prerequisite for both ways of voting. The
  // field is optional on the client type (older API builds omit it), so the
  // block renders only when a URL actually arrived.
  const registrationUrl = resources.voter_registration_url?.trim() || null;

  return (
    <div className="flex flex-col gap-2">
      {showStateName ? (
        <p className="text-sm font-medium text-ink">{resources.state_name}</p>
      ) : null}
      {registrationUrl ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">Register to vote</p>
          <div className="mt-1">
            <OfficialLink url={registrationUrl} label="Register or check your registration" kind="registration" />
          </div>
        </div>
      ) : null}
      <MailSection resources={resources} />
      {hasMail ? <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">or</p> : null}
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">Vote in person</p>
        <div className="mt-1">
          <OfficialLink url={resources.polling_place_url} label="Find your polling place" kind="polling" />
        </div>
      </div>
    </div>
  );
}

/**
 * "How to vote in WA" disclosure for the elections list: official state links
 * for registering first, then voting by mail, then in person. The panel is a
 * popover layered over the list (absolute, anchored under the trigger) so
 * opening it never shoves the elections down the page; Escape and a click
 * outside close it. This is informational content, not a list control, so
 * the trigger is a quiet text link with an info glyph rather than a bordered
 * button (py-1.5 keeps it level with the toolbar row it sits beside).
 * Resources load lazily on first open; states normally holds one entry (a
 * ballot's districts share a state), but every distinct state gets its own
 * section if not.
 */
export function HowToVoteControl({ states }: { states: string[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const uniqueStates = [...new Set(states)];

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (uniqueStates.length === 0) {
    return null;
  }

  // ml-auto keeps the control on the right edge even when the toolbar row
  // wraps and this becomes the only item on its line — justify-between on
  // the parent would otherwise drop it to the left. relative anchors the
  // popover to this column.
  return (
    <div ref={wrapperRef} className="relative ml-auto">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          track("list_control", { control: "how_to_vote", value: open ? "close" : "open" });
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className={`flex items-center gap-1.5 py-1.5 text-sm underline-offset-2 transition hover:text-ink hover:underline ${
          open ? "text-ink underline" : "text-ink-soft"
        }`}
      >
        <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3.5 w-3.5">
          <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 5.4v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="6" cy="3.4" r="0.9" fill="currentColor" />
        </svg>
        How to vote{uniqueStates.length === 1 ? ` in ${uniqueStates[0]}` : ""}
      </button>
      {open ? (
        <div
          id={panelId}
          className="absolute right-0 top-full z-20 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-lg border border-line bg-white p-3 pr-9 shadow-lg"
        >
          {/* Explicit close affordance — the trigger also toggles, but a
              panel with no visible way out reads as stuck. Focus returns to
              the trigger so a keyboard user isn't dropped at the top. */}
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
            className="absolute right-2 top-2 rounded p-1 text-ink-soft transition hover:bg-surface hover:text-ink"
          >
            <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3.5 w-3.5">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {uniqueStates.map((state) => (
            <StateResourcesSection key={state} state={state} showStateName={uniqueStates.length > 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

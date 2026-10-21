import { useState } from "react";
import { Link } from "react-router";
import { useFollows, useFollowSaving, useSetFollow } from "@voteapp/api-client";
import type { CandidateFollow } from "@voteapp/api-client";
import { CandidateSearchBox } from "./CandidateSearchBox";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "./Status";
import { formatElectionDate } from "@voteapp/api-client";
import type { BackTo } from "../lib/detailNavContext";
import { partyColorClass, profilePartyLabel } from "@voteapp/api-client";

// This section lives on the My Candidates page; detail pages reached from it
// (candidate links, election links, the search combobox) link back there.
// The shape satisfies both ElectionNavState and CandidateNavState — backTo
// is their only required field.
const FOLLOWS_NAV_STATE: { backTo: BackTo } = {
  backTo: { path: "/me/follows", label: "My Candidates" },
};

type FollowSort = "election" | "name";

// Client-side sort: the list is capped at 25 follows and every row already
// carries its next election date, so re-sorting needs no server round trip.
// "election" puts the soonest ballot first; follows with no upcoming election
// sink to the bottom. Election dates are YYYY-MM-DD strings, so plain string
// comparison orders them correctly.
function compareFollows(a: CandidateFollow, b: CandidateFollow, sort: FollowSort): number {
  if (sort === "election") {
    const aDate = a.active_election?.election_date ?? null;
    const bDate = b.active_election?.election_date ?? null;
    if (aDate !== bDate) {
      if (aDate === null) return 1;
      if (bDate === null) return -1;
      return aDate < bDate ? -1 : 1;
    }
  }
  return a.display_name.localeCompare(b.display_name);
}

// The followed-candidates manager, back on /me/follows after a stint inside
// My Picks. One deliberate difference from the original page: no
// "Latest: <record>" preview line — it was noise, and the full record lives
// one click away on the candidate page. Callers gate on a verified session
// (the follows endpoint is verification-gated).

function NotifyToggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-soft">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 accent-rausch"
      />
      {label}
    </label>
  );
}

function FollowRow({ follow }: { follow: CandidateFollow }) {
  const setFollow = useSetFollow();
  const saving = useFollowSaving();
  // Optimistic overlay: two quick toggles must not build the second payload
  // from the pre-refetch prop (the PUT saves BOTH booleans, so a stale spread
  // silently reverts the first change). null = no pending edits.
  const [pendingNotify, setPendingNotify] = useState<{
    notify_elections: boolean;
    notify_updates: boolean;
  } | null>(null);

  const notify = pendingNotify ?? {
    notify_elections: follow.notify_elections,
    notify_updates: follow.notify_updates,
  };

  function update(fields: Partial<{ notify_elections: boolean; notify_updates: boolean }>) {
    const next = { ...notify, ...fields };
    setPendingNotify(next);
    setFollow.mutate(
      { candidate_id: follow.candidate_id, following: true, ...next },
      {
        onSettled: () => {
          // Server truth (refetched by the mutation's invalidate) takes over.
          setPendingNotify(null);
        },
      }
    );
  }

  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to={`/candidates/${follow.candidate_id}`}
            state={FOLLOWS_NAV_STATE}
            className="font-semibold text-ink hover:text-rausch"
          >
            {follow.display_name}
          </Link>
          <p className="text-sm text-ink-soft">
            {profilePartyLabel(follow.party) ? (
              <>
                <span className={partyColorClass(follow.party) || undefined}>
                  {profilePartyLabel(follow.party)}
                </span>{" "}
                ·{" "}
              </>
            ) : null}
            {follow.state}
            {follow.current_office ? <> · {follow.current_office}</> : null}
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => setFollow.mutate({ candidate_id: follow.candidate_id, following: false })}
          className="rounded-lg border border-line bg-white px-3 py-1 text-xs font-semibold text-ink transition hover:border-rausch"
        >
          Unfollow
        </button>
      </div>
      {follow.active_election ? (
        <p className="mt-2 text-sm text-ink-soft">
          On the ballot:{" "}
          <Link
            to={`/elections/${follow.active_election.election_id}`}
            state={FOLLOWS_NAV_STATE}
            className="underline hover:text-ink"
          >
            {follow.active_election.official_ballot_title}
          </Link>{" "}
          · {formatElectionDate(follow.active_election.election_date)}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-4">
        <NotifyToggle
          label="Email me about their future elections"
          checked={notify.notify_elections}
          disabled={saving}
          onChange={(next) => update({ notify_elections: next })}
        />
        <NotifyToggle
          label="Email me about their new actions"
          checked={notify.notify_updates}
          disabled={saving}
          onChange={(next) => update({ notify_updates: next })}
        />
      </div>
      {setFollow.isError ? (
        <div className="mt-2">
          <ErrorNotice error={setFollow.error} />
        </div>
      ) : null}
    </li>
  );
}

export function FollowedCandidatesSection() {
  const { follows, isLoading: followsLoading, isError } = useFollows();
  const [sort, setSort] = useState<FollowSort>("election");
  const sortedFollows = follows ? [...follows].sort((a, b) => compareFollows(a, b, sort)) : undefined;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-heading font-bold text-ink">My Candidates</h2>
        {/* Rendered outside the follows-list branch: discovery must work
            with zero follows and when the follows fetch fails. Deliberately
            does NOT filter the follows list below. */}
        <CandidateSearchBox backTo={FOLLOWS_NAV_STATE.backTo} />
      </div>
      {followsLoading ? <LoadingNotice text="Loading follows…" /> : null}
      {isError ? (
        <div className="mt-4">
          <ErrorNotice error={new Error("Could not load follows")} />
        </div>
      ) : null}
      {follows && follows.length === 0 ? (
        <EmptyNotice text="You aren't following anyone yet. Use the Follow button on any candidate page." />
      ) : null}
      {sortedFollows && sortedFollows.length > 0 ? (
        <>
          <div className="mt-4 flex items-center justify-end gap-2">
            <label htmlFor="follow-sort-select" className="text-sm font-medium text-ink">
              Sort by:
            </label>
            <select
              id="follow-sort-select"
              value={sort}
              onChange={(event) => setSort(event.target.value as FollowSort)}
              className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-ink focus:border-rausch focus:outline-none"
            >
              <option value="election">Next election</option>
              <option value="name">Name (A–Z)</option>
            </select>
          </div>
          <ul className="mt-2 space-y-3">
            {sortedFollows.map((follow) => (
              <FollowRow key={follow.candidate_id} follow={follow} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

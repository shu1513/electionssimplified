import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@voteapp/api-client";
import { BALLOT_SORTS, type BallotPreferences, type BallotSort, type BallotSummary } from "@voteapp/api-client";
import {
  AddressSavedNotice,
  SavedAddressForm,
  type AddressSavedLocationState,
  type AddressSavedNoticeData,
} from "../components/SavedAddressForm";
import { ElectionList } from "../components/ElectionCard";
import { FullAddressExplanation } from "../components/FullAddressExplanation";
import { RaceTypeTabs } from "../components/RaceTypeTabs";
import { HowToVoteControl } from "../components/HowToVoteControl";
import { deriveBallotFilters, railSortForBallotSort, useElectionChoices, useMyResearchAreas } from "@voteapp/api-client";
import { useRaceTypeParam } from "../lib/useRaceTypeParam";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../components/Status";
import { useMe } from "@voteapp/api-client";
import { retryDistrictHandoff, useDistrictHandoffStatus } from "../lib/districtHandoff";
import { VerifyPrompt } from "../components/VerifyPrompt";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { track, useTrackBallotResult } from "../lib/usage";

type SavedBallot = BallotSummary & { matched_address?: string };

// Persisted ordering preferences: unlike the race-type tab's URL param,
// these save to the account and apply to every future visit. Only the sort
// select is exposed here — `followed_first` stays in the saved object (the
// PUT replaces the FULL object, so it must round-trip untouched) but has no
// control of its own: the toolbar was too busy with it.
function useBallotPreferences() {
  const queryClient = useQueryClient();
  // Optimistic overlay: consecutive changes must merge from the latest view,
  // not from a stale cache snapshot — the PUT saves the FULL object, so a
  // stale spread would revert the previous change.
  const [pending, setPending] = useState<BallotPreferences | null>(null);
  const prefs = useQuery({
    queryKey: ["me", "ballot-preferences"],
    queryFn: () => apiRequest<BallotPreferences>("/api/me/ballot-preferences"),
    staleTime: 60_000,
  });

  const update = useMutation({
    mutationKey: ["put-ballot-preferences"],
    mutationFn: (next: BallotPreferences) =>
      apiRequest<BallotPreferences>("/api/me/ballot-preferences", { method: "PUT", body: next }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["me", "ballot-preferences"], saved);
      void queryClient.invalidateQueries({ queryKey: ["me", "ballot"] });
    },
    onSettled: () => {
      setPending(null);
    },
  });
  // Cross-mount in-flight guard: component-local isPending resets on remount
  // (navigate away and back mid-save), but the mutation cache does not — a
  // remounted control must stay locked until the older full-object PUT
  // settles, or two writes could commit out of order.
  const saving = useIsMutating({ mutationKey: ["put-ballot-preferences"] }) > 0;

  const current = pending ?? prefs.data ?? null;

  function change(fields: Partial<BallotPreferences>, onSaved?: () => void) {
    if (!current) {
      return;
    }
    const next = { ...current, ...fields };
    setPending(next);
    update.mutate(next, onSaved ? { onSuccess: onSaved } : undefined);
  }

  return { prefs, update, saving, current, change };
}

function BallotSortPreference({
  sortOverride,
  onClearOverride,
}: {
  /** A ?sort= URL override (the rail's sort carry-over): session-scoped,
   * wins over the saved preference server-side, never persisted. */
  sortOverride: BallotSort | null;
  onClearOverride: () => void;
}) {
  const { prefs, update, saving, current, change } = useBallotPreferences();
  if (prefs.isError) {
    return <ErrorNotice error={prefs.error} />;
  }
  if (!current) {
    return null;
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        Sort by
        <select
          // The select must show the order the list is actually in — the
          // override when one is engaged, the preference otherwise. While a
          // save is in flight the just-chosen value (the pending overlay in
          // `current`) wins: the override is cleared only on success, and
          // showing it mid-save would snap the select back to the old
          // value.
          value={saving ? current.sort : (sortOverride ?? current.sort)}
          // Disabled while a save is in flight: the PUT replaces the FULL
          // object, so concurrent requests could commit out of order and
          // the earlier write would win.
          disabled={saving}
          onChange={(event) => {
            track("list_control", { control: "sort", value: event.target.value });
            // Choosing here clears the override (the explicit URL param
            // wins server-side, so left in place it would pin the list to
            // the old order and make this select a no-op) — but only AFTER
            // the PUT succeeds: clearing first would launch a ballot GET
            // still under the OLD preference and race the save, and a
            // failed save keeps the override describing the list on screen
            // alongside the error notice.
            change(
              { sort: event.target.value as BallotPreferences["sort"] },
              sortOverride ? onClearOverride : undefined
            );
          }}
          className="rounded-md border border-line bg-white px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-60"
        >
          {BALLOT_SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {update.isError ? <ErrorNotice error={update.error} /> : null}
    </div>
  );
}

export function SavedBallotPage() {
  useDocumentTitle("Your saved ballot");
  const { me, isLoading, isError: meError, refetch: refetchMe } = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  // Set when SavedAddressForm just navigated here after a successful save;
  // the notice carries the matched address and the ambiguous-match warning.
  const [addressSaved, setAddressSaved] = useState<AddressSavedNoticeData | null>(null);
  // Capture-then-clear: React Router copies navigation state into
  // window.history.state, which survives refresh and back/forward — left in
  // place, the "Address saved" banner (home address included) would replay
  // from the history entry indefinitely, even beside a newer address's
  // ballot. An effect, not a mount-time read: the empty-state form on this
  // page saves without remounting it, so the state can arrive mid-life.
  useEffect(() => {
    const saved = (location.state as Partial<AddressSavedLocationState> | null)?.addressSaved;
    if (saved) {
      setAddressSaved(saved);
      void navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);
  const { weights: savedAreaWeights, savedAreaIds, hasSaved } = useMyResearchAreas();
  const { raceTypeRequested, onRaceTypeChange } = useRaceTypeParam();
  // ?sort= — the rail's sort carry-over. Session-scoped like the tab:
  // the explicit param wins over the saved preference server-side
  // ([ballot-personalized-ordering] in apiServer.ts) without touching it.
  // Unknown values read as "no override", like the other params.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSortParam = searchParams.get("sort");
  const sortOverride: BallotSort | null = BALLOT_SORTS.some((option) => option.value === rawSortParam)
    ? (rawSortParam as BallotSort)
    : null;
  function clearSortOverride() {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("sort");
        return next;
      },
      { replace: true }
    );
  }
  const { choiceByElectionId } = useElectionChoices();
  // The sort this list is ACTUALLY in (override wins server-side, else the
  // saved preference) — seeds the detail rail's always-engaged sort. Shares
  // the preference controls' query via the cache. The list is withheld
  // until this settles (guard below): the server has already ordered the
  // ballot by the saved preference, so cards navigable before the client
  // knows that sort would seed the rail with the wrong order. On a
  // preferences failure it falls open — list shown, seed simply omitted.
  const { prefs: ballotPreferencesQuery, current: ballotPreferences } = useBallotPreferences();
  const effectiveListSort = sortOverride ?? ballotPreferences?.sort ?? null;
  // Anonymous-to-account handoff (lib/districtHandoff.ts) runs app-wide from
  // App; this page only reads its status: the ballot query is withheld while
  // ids are still queued, and a recoverable failure gets an explicit retry.
  const handoffState = useDistrictHandoffStatus();

  const verified = me?.email_verified === true;

  const ballot = useQuery<SavedBallot>({
    // The override is part of the key so switching (or clearing) it
    // refetches; invalidations on the ["me", "ballot"] prefix still match.
    queryKey: ["me", "ballot", sortOverride ?? ""],
    queryFn: () =>
      apiRequest<SavedBallot>(
        sortOverride ? `/api/me/ballot?sort=${encodeURIComponent(sortOverride)}` : "/api/me/ballot"
      ),
    enabled: verified && handoffState === "done",
    retry: false,
  });
  useTrackBallotResult(ballot, { scope: "exact", partialBanner: false, ambiguousBanner: false });

  if (meError) {
    // /api/me failed for a non-auth reason (network, 5xx): without this the
    // me === undefined guard below would spin forever.
    return (
      <div className="mx-auto max-w-md px-4 py-10 space-y-4 text-center">
        <p className="text-ink-soft">We couldn't check your session. Please try again.</p>
        <button
          type="button"
          onClick={() => void refetchMe()}
          className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
        >
          Retry
        </button>
      </div>
    );
  }
  if (isLoading || me === undefined) {
    return <LoadingNotice text="Loading…" />;
  }
  if (me === null) {
    return (
      <div className="mx-auto max-w-md px-4 py-10 text-center">
        <p className="text-ink-soft">Log in to see your saved ballot.</p>
        <p className="mt-4">
          <Link
            to="/login"
            className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
          >
            Log in
          </Link>
        </p>
      </div>
    );
  }
  if (!verified) {
    return <VerifyPrompt email={me.email} />;
  }

  if (handoffState === "failed") {
    return (
      <div className="mx-auto max-w-md px-4 py-10 space-y-4 text-center">
        <p className="text-ink-soft">
          We couldn't save the districts from your recent address search to your account. Your search is
          still remembered.
        </p>
        <button
          type="button"
          onClick={retryDistrictHandoff}
          className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
        >
          Try again
        </button>
      </div>
    );
  }

  if (handoffState !== "done" || ballot.isPending) {
    return <LoadingNotice text="Loading your ballot…" />;
  }

  if (ballot.isError) {
    // A 403 here means verification state changed server-side; anything else
    // is a real error.
    if (ballot.error instanceof ApiError && ballot.error.status === 403) {
      return <VerifyPrompt email={me.email} />;
    }
    return (
      <div className="mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px]">
        <ErrorNotice error={ballot.error} />
      </div>
    );
  }

  // The ballot arrives already ordered by the saved sort preference; until
  // the preferences query tells the client WHICH sort that was, the cards
  // would stamp no railSort and the detail rail would open in its default
  // order instead of the list's. Withhold until the FIRST attempt settles,
  // then never again: a failure falls open to the list with the seed
  // omitted, and the errorUpdateCount guard is what keeps it open — this
  // gate unmounts the preference controls, and their remount resets an
  // errored query to pending (retryOnMount), so gating on pending alone
  // flip-flops forever between this notice and the list. An engaged ?sort=
  // override needs no wait: it IS the effective sort.
  if (!sortOverride && ballotPreferencesQuery.isLoading && ballotPreferencesQuery.errorUpdateCount === 0) {
    return <LoadingNotice text="Loading your ballot…" />;
  }

  const data = ballot.data;
  // No hide-by-choice filters on the web pages — only the race-type tab
  // slices the list. The shared derivation still serves mobile's filters.
  const filtersView = deriveBallotFilters({
    elections: data.elections,
    savedAreaIds,
    hasSaved,
    issuesRequested: false,
    impactRequested: null,
    raceTypeRequested,
  });

  if (data.districts.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        {/* A save can succeed and still map to zero districts; without the
            notice the user lands back on the form with no feedback. */}
        {addressSaved ? (
          <div className="mb-4">
            <AddressSavedNotice saved={addressSaved} />
          </div>
        ) : null}
        <h1 className="text-title font-bold">Set your address</h1>
        {/* Same explainer as the home page so a new member who lands here
            right after sign-up can see why a street address matters before
            typing one. */}
        <p className="mt-2 text-sm text-ink-soft">
          Enter your address once to get the correct ballot.{" "}
          <FullAddressExplanation onOpen={() => track("why_address_open", { after_input: false })} />
        </p>
        <div className="mt-3">
          <SavedAddressForm inputId="saved-address" label="Your address" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pt-[25px] pb-8 sm:pt-[27px]">
      {addressSaved ? (
        <div className="mb-4">
          <AddressSavedNotice saved={addressSaved} />
        </div>
      ) : null}
      {/* Visible page heading, one step larger than the date group headings
          ("Elections on …") below it — same wording as the public ballot page
          so the list reads the same before and after sign-in. No count
          subtitle. */}
      <h1 className="mb-4 text-title font-bold text-ink">My elections:</h1>
      {/* Race-type tabs and ordering on the left, official how-to-vote links
          on the right — the same split as the public ballot page, so the
          resources reach signed-in voters too (their home page redirects
          here). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Offered only when the ballot mixes candidate races and ballot
              measures — a single-type ballot has nothing to switch between. */}
          {filtersView.showRaceTypeTabs ? (
            <RaceTypeTabs raceType={filtersView.raceType} onChange={onRaceTypeChange} />
          ) : null}
          <BallotSortPreference sortOverride={sortOverride} onClearOverride={clearSortOverride} />
        </div>
        <HowToVoteControl states={data.districts.map((district) => district.state)} />
      </div>

      {data.elections.length === 0 ? (
        <EmptyNotice text="No upcoming elections found for your districts yet. Check back — new elections are added as they are announced." />
      ) : (
        <ElectionList
          elections={filtersView.visibleElections}
          savedAreaWeights={savedAreaWeights}
          choicesByElectionId={choiceByElectionId}
          // Full query string: the back link must return to this exact
          // list — the ?type= tab and ?sort= override survive the round trip.
          backTo={{ path: location.pathname + location.search, label: "My Elections" }}
          // Tab-unsliced pool + the engaged tab: the detail rail's own
          // race-type tabs start here and can reach the other tab's races.
          contestsPool={filtersView.filteredElections}
          raceType={filtersView.raceType}
          // Seed the rail's always-engaged sort from this list's sort.
          railSort={effectiveListSort ? railSortForBallotSort(effectiveListSort) : undefined}
          sort={effectiveListSort ?? undefined}
        />
      )}

      <p className="mt-8 text-sm text-ink-soft">
        Moved?{" "}
        <Link to="/me/settings" className="underline hover:text-ink">
          Change your address in Settings
        </Link>
        .
      </p>
      <p className="mt-2 text-sm text-ink-soft">
        Looking somewhere else?{" "}
        <Link to="/?new=1" className="underline hover:text-ink">
          Run a one-off address search
        </Link>{" "}
        without changing your saved address.
      </p>
    </div>
  );
}

export default SavedBallotPage;

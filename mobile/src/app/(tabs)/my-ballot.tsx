import type { BallotPreferences, BallotSummary, VoteImpactThreshold } from "@voteapp/api-client";
import {
  ApiError,
  apiRequest,
  BALLOT_SORT_DESCRIPTIONS,
  BALLOT_SORTS,
  deriveBallotFilters,
  myDraftLabel,
  useElectionChoices,
  useMe,
  useMyResearchAreas,
} from "@voteapp/api-client";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AccountGate } from "../../components/AccountGate";
import { BallotFiltersControl } from "../../components/BallotFiltersControl";
import { ElectionCard } from "../../components/ElectionCard";
import { FullAddressExplanation } from "../../components/FullAddressExplanation";
import { SavedAddressForm } from "../../components/SavedAddressForm";
import { SortChips } from "../../components/SortChips";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../../components/Status";
import { VerifyPrompt } from "../../components/VerifyPrompt";
import { clearPendingDistrictIds, readPendingDistrictIds } from "../../lib/pendingDistricts";
import { registerForPushRequestingPermission } from "../../lib/pushNotifications";
import { useMyPicksProgress } from "../../lib/useMyPicksProgress";

type SavedBallot = BallotSummary & { matched_address?: string };

// Persisted ordering preferences, ported from the web SavedBallotPage:
// unlike the filters' local state, these save to the account and apply to
// every future visit. Only the sort chips render a control now — the
// "Followed candidates first" checkbox is gone, as on the web, but the
// saved followed_first value is untouched: the sort control still
// round-trips it in the full-object PUT, and the API keeps applying it.
// The plumbing stays in a hook with a mutationKey lock (one save in flight)
// and a pending overlay so consecutive changes merge from the latest view.
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
  // Cross-mount in-flight guard: component-local isPending resets on
  // remount, but the mutation cache does not — a remounted control must stay
  // locked until the older full-object PUT settles, or two writes could
  // commit out of order. Shared across both preference controls, so a save
  // from one also locks the other.
  const saving = useIsMutating({ mutationKey: ["put-ballot-preferences"] }) > 0;

  const current = pending ?? prefs.data ?? null;

  function change(fields: Partial<BallotPreferences>) {
    if (!current) {
      return;
    }
    const next = { ...current, ...fields };
    setPending(next);
    update.mutate(next);
  }

  return { prefs, update, saving, current, change };
}

function BallotSortPreference() {
  const { prefs, update, saving, current, change } = useBallotPreferences();
  if (prefs.isError) {
    return <ErrorNotice error={prefs.error} />;
  }
  if (!current) {
    return null;
  }
  return (
    <View className="mt-3 gap-2">
      {/* Disabled while a save is in flight: the PUT replaces the FULL
          object, so concurrent requests could commit out of order. SortChips
          has no disabled state; gate in the handler instead. */}
      <SortChips
        options={BALLOT_SORTS}
        value={current.sort}
        onChange={(sort) => {
          if (!saving) {
            change({ sort });
          }
        }}
      />
      {update.isError ? <ErrorNotice error={update.error} /> : null}
    </View>
  );
}

// Anonymous-to-account handoff, ported from the web with one extra state:
// AsyncStorage reads are async, so "checking" covers the initial read that
// sessionStorage answered synchronously on the web.
type HandoffState = "checking" | "pending" | "done" | "failed";

function SavedBallotBody({ email }: { email: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const savedPrefs = useQuery({
    queryKey: ["me", "ballot-preferences"],
    queryFn: () => apiRequest<BallotPreferences>("/api/me/ballot-preferences"),
    staleTime: 60_000,
  });
  const { savedAreaIds, weights, hasSaved } = useMyResearchAreas();
  // The viewer's picks, for the cards' "My pick" chips — progress at a
  // glance down the saved-ballot list. Cards render without waiting for
  // this: a late chip appearing beats blocking the ballot on it.
  const { choiceByElectionId } = useElectionChoices();
  // Filters: local state like the anonymous ballot's sort — the tab stays
  // mounted under a stack push, so the choices survive navigating into an
  // election and back. Deliberately NOT account preferences — hiding races
  // should never silently persist across visits.
  const [onlyMyIssues, setOnlyMyIssues] = useState(false);
  const [impactLevel, setImpactLevel] = useState<VoteImpactThreshold | null>(null);
  const [handoffState, setHandoffState] = useState<HandoffState>("checking");
  const [addressExplanationVisible, setAddressExplanationVisible] = useState(false);
  const handoffFiredRef = useRef(false);

  useEffect(() => {
    if (handoffState !== "checking") {
      return;
    }
    void readPendingDistrictIds().then((ids) => {
      setHandoffState(ids.length === 0 ? "done" : "pending");
    });
  }, [handoffState]);

  // Initialize saved districts from the last anonymous search (this body
  // only renders verified — the endpoint is verified-email-gated).
  // Only a definitive rejection of the payload itself (400: malformed or
  // unknown district ids) resolves to "the account's ballot is the source
  // of truth". Everything else — 401/403 (session or verification state
  // changed server-side), 429, network and server failures — is recoverable,
  // so keep the queued ids and surface an explicit retry instead of dropping
  // the user onto the empty set-address form with their search lost.
  useEffect(() => {
    if (handoffState !== "pending" || handoffFiredRef.current) {
      return;
    }
    handoffFiredRef.current = true;
    void (async () => {
      const districtIds = await readPendingDistrictIds();
      try {
        await apiRequest("/api/me/districts/initialize", {
          method: "POST",
          body: { district_ids: districtIds },
        });
        await clearPendingDistrictIds();
        setHandoffState("done");
        void queryClient.invalidateQueries({ queryKey: ["me", "ballot"] });
        // The pick gate's district set (useMyAccountDistricts) was just
        // initialized — refetch it or stale ids keep gating pick buttons.
        // Not needed in the 400 branch: a rejected payload changes nothing.
        void queryClient.invalidateQueries({ queryKey: ["me", "districts"] });
        // The anonymous search just became a saved ballot — same prompt
        // moment as the explicit address save below.
        void registerForPushRequestingPermission();
      } catch (error) {
        if (error instanceof ApiError && error.status === 400) {
          await clearPendingDistrictIds();
          setHandoffState("done");
          void queryClient.invalidateQueries({ queryKey: ["me", "ballot"] });
        } else {
          setHandoffState("failed");
        }
      }
    })();
  }, [handoffState, queryClient]);

  const ballot = useQuery<SavedBallot>({
    queryKey: ["me", "ballot"],
    queryFn: () => apiRequest<SavedBallot>("/api/me/ballot"),
    enabled: handoffState === "done",
    retry: false,
  });

  if (handoffState === "failed") {
    return (
      <View className="items-center px-4 py-10">
        <Text className="text-center text-ink-soft">
          We couldn&apos;t save the districts from your recent address search to your account. Your search is
          still remembered.
        </Text>
        <Pressable
          onPress={() => {
            handoffFiredRef.current = false;
            setHandoffState("pending");
          }}
          accessibilityRole="button"
          className="mt-4 rounded-lg bg-rausch px-4 py-2 active:bg-rausch-dark"
        >
          <Text className="font-semibold text-white">Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (handoffState !== "done" || ballot.isPending) {
    return <LoadingNotice text="Loading your ballot…" />;
  }

  if (ballot.isError) {
    // A 403 here means verification state changed server-side; anything else
    // is a real error.
    if (ballot.error instanceof ApiError && ballot.error.status === 403) {
      return <VerifyPrompt email={email} />;
    }
    return (
      <View className="px-4 py-8">
        <ErrorNotice error={ballot.error} />
      </View>
    );
  }

  const data = ballot.data;
  const filtersView = deriveBallotFilters({
    elections: data.elections,
    savedAreaIds,
    hasSaved,
    issuesRequested: onlyMyIssues,
    impactRequested: impactLevel,
  });

  if (data.districts.length === 0) {
    return (
      <ScrollView className="flex-1 bg-white" contentContainerClassName="px-4 py-10" keyboardShouldPersistTaps="handled">
        <Text className="text-2xl font-bold text-ink">Set your address</Text>
        <Text className="mt-2 text-sm text-ink-soft">Enter your address once to get the correct ballot.</Text>
        {/* Same explainer as the home tab so a new member who lands here
            right after sign-up can see why a street address matters. */}
        <Pressable
          accessibilityRole="button"
          onPress={() => setAddressExplanationVisible(true)}
          className="mt-1 self-start"
        >
          <Text className="text-sm text-ink-soft underline">Why full address?</Text>
        </Pressable>
        <View className="mt-4">
          <SavedAddressForm label="Your address" />
        </View>
        <FullAddressExplanation
          visible={addressExplanationVisible}
          onClose={() => setAddressExplanationVisible(false)}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1 bg-white" contentContainerClassName="px-4 py-8" keyboardShouldPersistTaps="handled">
      <Text className="text-2xl font-bold text-ink">Your saved ballot</Text>
      <Text className="mt-1 text-sm text-ink-soft">
        {data.elections.length} election{data.elections.length === 1 ? "" : "s"} across{" "}
        {data.districts.length} district{data.districts.length === 1 ? "" : "s"},{" "}
        {BALLOT_SORT_DESCRIPTIONS[savedPrefs.data?.sort ?? "vote_power"]}
      </Text>
      <BallotSortPreference />
      {/* The Order section makes the disclosure always available here —
          signed-in viewers always have the followed-first preference even
          when no filter is offerable. */}
      <BallotFiltersControl
        showIssues={filtersView.showIssuesFilter}
        issuesOn={filtersView.issuesOn}
        onIssuesChange={setOnlyMyIssues}
        showImpactHigh={filtersView.showImpactHigh}
        showImpactMedium={filtersView.showImpactMedium}
        impactLevel={filtersView.impactLevel}
        onImpactChange={setImpactLevel}
        activeFilterCount={filtersView.activeFilterCount}
        hiddenCount={filtersView.hiddenCount}
        onShowAll={() => {
          setOnlyMyIssues(false);
          setImpactLevel(null);
        }}
      />

      {data.elections.length === 0 ? (
        <EmptyNotice text="No upcoming elections found for your districts yet. Check back — new elections are added as they are announced." />
      ) : (
        // An active filter can empty this list; the "N elections hidden ·
        // Show all" line above explains the empty view.
        <View className="mt-4 gap-3">
          {filtersView.visibleElections.map((election) => (
            <ElectionCard
              key={election.id}
              election={election}
              savedAreaWeights={weights}
              myChoice={choiceByElectionId?.get(election.id)}
            />
          ))}
        </View>
      )}

      <Text className="mt-8 text-sm text-ink-soft">
        Moved?{" "}
        <Text className="underline" accessibilityRole="link" onPress={() => router.push("/settings/address")}>
          Change your address in Settings
        </Text>
        .
      </Text>
      <Text className="mt-2 text-sm text-ink-soft">
        Looking somewhere else?{" "}
        <Text className="underline" accessibilityRole="link" onPress={() => router.push("/")}>
          Run a one-off address search
        </Text>{" "}
        without changing your saved address.
      </Text>
    </ScrollView>
  );
}

// Header entry to the My Draft screen (no fifth tab; tab real estate is
// scarce). The label carries live progress over the nearest election day —
// "My Draft 0/13" → "My Draft 4/13" → "My Draft ✓" — from the shared hook, the
// same vocabulary as the web header nav. Hidden while logged out or the
// session is still loading: a draft link for a viewer with no draft is
// noise (mobile has no guest draft).
function DraftHeaderLink() {
  const router = useRouter();
  const progress = useMyPicksProgress();
  return (
    <Pressable
      onPress={() => router.push("/my-draft")}
      accessibilityRole="link"
      className="mr-4 rounded-full border border-line bg-white px-3 py-1.5 active:border-ink"
    >
      <Text className="text-sm font-medium text-ink">{myDraftLabel(progress)}</Text>
    </Pressable>
  );
}

export default function MyBallotScreen() {
  // navigation.setOptions, not a <Tabs.Screen options> element: the
  // dynamic-options composition API is only documented for Stack routes;
  // setOptions is the navigator-agnostic contract. DraftHeaderLink carries
  // its own hooks, so once mounted it live-updates without re-setting.
  const navigation = useNavigation();
  const { me } = useMe();
  const signedIn = me != null;
  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: signedIn ? () => <DraftHeaderLink /> : undefined });
  }, [navigation, signedIn]);
  return (
    <AccountGate signedOutText="Log in to see your saved ballot.">
      {(me) => <SavedBallotBody email={me.email} />}
    </AccountGate>
  );
}

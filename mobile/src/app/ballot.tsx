import type { BallotSort, BallotSummary, VoteImpactThreshold } from "@voteapp/api-client";
import {
  apiRequest,
  BALLOT_SORT_DESCRIPTIONS,
  ballotListOrder,
  DEFAULT_BALLOT_SORT,
  deriveBallotFilters,
  formatDistrictName,
  formatDistrictType,
  PUBLIC_BALLOT_SORTS,
  useMyResearchAreas,
  VERIFY_WITH_OFFICIALS_NOTE,
} from "@voteapp/api-client";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Collapsible } from "../components/Collapsible";
import { BallotFiltersControl } from "../components/BallotFiltersControl";
import { ElectionCard } from "../components/ElectionCard";
import { SortChips } from "../components/SortChips";
import { EmptyNotice, ErrorNotice, LoadingNotice } from "../components/Status";
import { consumeMatchedAddress, type MatchedAddressHandoff } from "../lib/matchedAddress";

/**
 * Port of the web BallotPage. Params mirror the web URL (`d` = comma-joined
 * district ids). The matched address arrives through the in-memory holder,
 * never navigation params (Expo Router would serialize it into URL-shaped
 * state — see lib/matchedAddress.ts); the web keeps it in router state for
 * the same reason. Sort is local state instead of a URL param — there is no
 * address bar to reflect it into.
 */
export default function BallotScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ d?: string; partial?: string }>();
  // Set by ZIP searches. A param, not the in-memory holder: it carries no
  // location, and the partial label must survive remounts — same reasoning
  // as the web's partial=1 URL param.
  const isPartialBallot = params.partial === "1";
  const { savedAreaIds, weights, hasSaved } = useMyResearchAreas();
  const [sort, setSort] = useState<BallotSort>(DEFAULT_BALLOT_SORT);
  // Filters: local state like sort — the screen stays mounted under a stack
  // push, so the choices survive navigating into an election and back (the
  // web reflects them into the URL for the same reason).
  const [onlyMyIssues, setOnlyMyIssues] = useState(false);
  const [impactLevel, setImpactLevel] = useState<VoteImpactThreshold | null>(null);
  // Consume once on mount; state keeps it across re-renders and sort changes.
  const [matched] = useState<MatchedAddressHandoff | null>(consumeMatchedAddress);
  const matchedAddress = matched?.address ?? null;
  // The geocoder returned more than one candidate address and the ballot is
  // for the first one — the confirmation line alone is too easy to skim past.
  const ambiguousMatchCount = matched && matched.matchCount > 1 ? matched.matchCount : null;

  const districtIds = (params.d ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  const ballot = useQuery({
    queryKey: ["ballot", districtIds.join(","), sort],
    queryFn: () =>
      apiRequest<BallotSummary>(
        `/api/ballot?district_ids=${encodeURIComponent(districtIds.join(","))}&sort=${sort}`
      ),
    enabled: districtIds.length > 0,
  });

  const filtersView = deriveBallotFilters({
    elections: ballot.data?.elections ?? [],
    savedAreaIds,
    hasSaved,
    issuesRequested: onlyMyIssues,
    impactRequested: impactLevel,
  });

  if (districtIds.length === 0) {
    return (
      <View className="flex-1 bg-white px-4 py-10">
        <Stack.Screen options={{ title: "Your ballot" }} />
        <EmptyNotice text="No districts selected." />
        <Pressable accessibilityRole="link" onPress={() => router.dismissTo("/")}>
          <Text className="text-center text-ink underline">Start with your address</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-white" contentContainerClassName="px-4 py-8">
      <Stack.Screen options={{ title: "Your ballot" }} />
      <Text className="text-2xl font-bold text-ink">Your ballot</Text>

      {/* Suppressed on partial ballots: the ZIP is not an address, and the
          partial banner below already names it. */}
      {matchedAddress && !isPartialBallot ? (
        <Text className="mt-1 text-sm text-ink-soft">
          Matched address: <Text className="font-medium text-ink">{matchedAddress}</Text>{" "}
          <Text className="underline" accessibilityRole="link" onPress={() => router.dismissTo("/")}>
            Not your address?
          </Text>
        </Text>
      ) : null}
      {/* Same partial-ballot label as the web ballot page. The ZIP or area
          name is the matched address from the in-memory holder; without it
          (screen remount) the generic wording renders. */}
      {isPartialBallot ? (
        <View accessibilityRole="alert" className="mt-2 rounded-md border border-line bg-surface px-3 py-2">
          <Text className="text-sm text-ink">
            {/* Deliberately no claim about WHAT is excluded: ward/seat races
                render here too, with their own "may not cover your address"
                label, so any exclusion rule stated up here would be false
                for them — same reasoning as the web ballot page. The CTA
                sentence already names what a street address adds. */}
            {matchedAddress && matched?.scope && matched.scope !== "exact" ? (
              <>
                This is a partial ballot for {matched.scope === "zip" ? "ZIP code " : ""}
                <Text className="font-medium">{matchedAddress}</Text>.
              </>
            ) : (
              "This is a partial ballot."
            )}{" "}
            <Text className="underline" accessibilityRole="link" onPress={() => router.dismissTo("/")}>
              Enter your street address
            </Text>{" "}
            to check for additional congressional, legislative, local, and school races.
          </Text>
        </View>
      ) : null}
      {matchedAddress && ambiguousMatchCount ? (
        // Same warning as the web ballot page (role="alert" there).
        <View accessibilityRole="alert" className="mt-2 rounded-md border border-line bg-surface px-3 py-2">
          <Text className="text-sm text-ink">
            Your search matched {ambiguousMatchCount} possible addresses, and this ballot is for the first one.
            Please check the matched address above — if it is not yours,{" "}
            <Text className="underline" accessibilityRole="link" onPress={() => router.dismissTo("/")}>
              search again
            </Text>{" "}
            with your full street address, city, and ZIP code.
          </Text>
        </View>
      ) : null}

      <View className="mt-3">
        <SortChips options={PUBLIC_BALLOT_SORTS} value={sort} onChange={setSort} />
      </View>
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

      {/* Reaches everyone who sees results, including people the clickwrap
          never reached — a shared device, a link from a text message. For a
          reliance claim this carries more weight than the agreement, because
          it does not depend on the reader having accepted anything. */}
      <Text className="mt-4 text-xs text-ink-soft">
        {VERIFY_WITH_OFFICIALS_NOTE}{" "}
        <Text className="underline" accessibilityRole="link" onPress={() => router.push("/legal/disclaimer")}>
          Disclaimer
        </Text>
      </Text>

      {ballot.isPending ? <LoadingNotice text="Loading your elections…" /> : null}
      {ballot.isError ? (
        <View className="mt-4">
          <ErrorNotice error={ballot.error} />
        </View>
      ) : null}

      {ballot.isSuccess ? (
        <>
          <Text className="mt-2 text-sm text-ink-soft">
            {ballot.data.elections.length} election{ballot.data.elections.length === 1 ? "" : "s"} across{" "}
            {ballot.data.districts.length} district{ballot.data.districts.length === 1 ? "" : "s"},{" "}
            {BALLOT_SORT_DESCRIPTIONS[sort]}
          </Text>

          <Collapsible summary="Which districts?">
            <View className="mt-2 rounded-lg border border-line">
              {ballot.data.districts.map((district, index) => (
                <View
                  key={district.id}
                  className={
                    index > 0
                      ? "flex-row items-center justify-between border-t border-line px-3 py-2"
                      : "flex-row items-center justify-between px-3 py-2"
                  }
                >
                  <Text className="flex-1 text-xs text-ink">{formatDistrictName(district.name)}</Text>
                  <Text className="text-xs text-ink-soft">{formatDistrictType(district.district_type)}</Text>
                </View>
              ))}
            </View>
          </Collapsible>

          <Collapsible summary="What do these labels mean?">
            <View className="mt-2 gap-2 rounded-lg border border-line bg-surface p-3">
              <Text className="text-xs text-ink-soft">
                <Text className="font-bold text-ink">My vote power</Text> estimates how much weight one vote
                carries in an election, based on district population and how decisive the contest is expected
                to be. It is an estimate for comparing elections — it does not measure the value, importance,
                or likely effect of your individual vote.
              </Text>
              <Text className="text-xs text-ink-soft">
                <Text className="font-bold text-ink">Competitiveness</Text> labels reflect the margin of past
                results for the same contest and may be outdated after redistricting.
              </Text>
              <Text className="text-xs text-ink-soft">Details and limitations: Disclaimer, section 8.</Text>
            </View>
          </Collapsible>

          {ballot.data.elections.length === 0 ? (
            <EmptyNotice text="No upcoming elections found for these districts yet. Check back — new elections are added as they are announced." />
          ) : (
            // An active filter can empty this list; the "N elections hidden ·
            // Show all" line above explains the empty view.
            <View className="mt-4 gap-3">
              {/* Flat list: ballotListOrder restores date order and the
                  empty-race sink that the positional ballot-order payload
                  leaves out (the identity for every other sort's payload). */}
              {ballotListOrder(filtersView.visibleElections).map((election) => (
                <ElectionCard key={election.id} election={election} savedAreaWeights={weights} />
              ))}
            </View>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

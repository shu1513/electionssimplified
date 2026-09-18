import type { ElectionDetail, PartyBucket } from "@voteapp/api-client";
import { isRetentionRace, partyColorClass } from "@voteapp/api-client";
import {
  aggregateRecordAreaStances,
  ApiError,
  apiRequest,
  competitivenessChip,
  deriveCandidateResultBadges,
  formatDistrictName,
  formatDistrictType,
  formatElectionDate,
  formatMoney,
  formatOutcome,
  formatRosterStatus,
  formatVotePowerLabel,
  hasFinanceContent,
  isDecidedChoice,
  partyBucket,
  scoreStanceRelevance,
  splitResearchAreasBySaved,
  useElectionChoices,
  useFollows,
  useMe,
  useMyAccountDistricts,
  useMyResearchAreas,
} from "@voteapp/api-client";
import type { CandidateResultBadge } from "@voteapp/api-client";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Fragment, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { votePowerTextClass } from "../../lib/votePowerText";
import { AddressNudge } from "../../components/AddressNudge";
import { AutoPickControl } from "../../components/AutoPickControls";
import { DraftCompleteNotice } from "../../components/DraftCompleteNotice";
import { AREA_TEXT_CLASS, SAVED_AREA_TEXT_CLASS } from "../../components/ElectionCard";
import {
  CandidatePickButton,
  LogInToPlanLine,
  MeasureChoiceButtons,
  StrandedPicksNotice,
} from "../../components/ElectionChoiceControls";
import { FinanceSummaryCard } from "../../components/FinanceSummaryCard";
import { FollowButton } from "../../components/FollowButton";
import { NotFoundNotice } from "../../components/NotFoundNotice";
import { ShareButton } from "../../components/ShareButton";
import { SortChips } from "../../components/SortChips";
import { SourceFootnote } from "../../components/SourceFootnote";
import { MeasureFundingSection } from "../../components/MeasureFundingSection";
import { SourceLine } from "../../components/SourceLine";
import { ErrorNotice, LoadingNotice } from "../../components/Status";
import { openExternalUrl } from "../../lib/openExternalUrl";
import { usLatestLocalDate } from "../../lib/usLatestLocalDate";

// "alphabetical" is the payload's own order: the API sorts candidates by
// display name (there is no true ballot-position data). "my_issues" is the
// default for viewers with saved research areas. Same as the web.
type CandidateSort = "alphabetical" | "my_issues";

const CANDIDATE_SORT_OPTIONS = [
  { value: "my_issues", label: "My issues first" },
  { value: "alphabetical", label: "Alphabetical" },
] as const;

// The party filter over the candidates list. Same buckets and labels as the
// web ElectionPage.
const PARTY_FILTER_OPTIONS: { bucket: PartyBucket; label: string }[] = [
  { bucket: "democratic", label: "Democrats" },
  { bucket: "republican", label: "Republicans" },
  { bucket: "other", label: "Other" },
];

/**
 * Port of the web ElectionPage. The web's SSR loader becomes a plain
 * useQuery (no SEO concern on mobile); follow/report controls arrive with
 * the auth chunk.
 */
export default function ElectionScreen() {
  const { electionId } = useLocalSearchParams<{ electionId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { savedAreaIds, weights, hasSaved } = useMyResearchAreas();
  // "My choice" state, all loaded before any control renders (no-flash rule,
  // like FollowButton). me is undefined while the session loads — the guest
  // login line must not flash for a viewer who turns out to be signed in.
  const { me } = useMe();
  const { choiceByElectionId, canChoose } = useElectionChoices();
  const { districtIds, isLoading: districtsLoading } = useMyAccountDistricts();
  // Election payload candidates carry no follow state; derive it from the
  // follows list (only fetched for verified users). Controls render only
  // once that list has loaded. Same as the web.
  const { follows, canFollow } = useFollows();
  const followedIds = new Set((follows ?? []).map((follow) => follow.candidate_id));
  // null = no explicit pick; viewers with saved areas default to "my
  // issues first", everyone else to the alphabetical payload order. A
  // picked "my_issues" is ignored while saved areas are empty and honored
  // again once areas are re-saved. Same as the web.
  const [chosenSort, setChosenSort] = useState<CandidateSort | null>(null);
  const effectiveChosenSort = chosenSort === "my_issues" && !hasSaved ? null : chosenSort;
  const candidateSort = effectiveChosenSort ?? (hasSaved ? "my_issues" : "alphabetical");
  // Keyed to the election it was made on: unlike the sort (a preference
  // that travels), a party filter is a per-race choice — carrying it into
  // another election rendered by this same mounted screen would silently
  // hide candidates there. A pick from another election reads as "all".
  const [partyPick, setPartyPick] = useState<{ electionId: string; bucket: PartyBucket | "all" }>({
    electionId: "",
    bucket: "all",
  });
  // "Has a record on my issues" — same per-race keying as the party pick,
  // for the same reason: it hides candidates, so it must not travel to the
  // next election this mounted screen renders. Same as the web.
  const [recordsPick, setRecordsPick] = useState<{ electionId: string; on: boolean }>({
    electionId: "",
    on: false,
  });

  const election = useQuery({
    queryKey: ["election", electionId],
    queryFn: () => apiRequest<ElectionDetail>(`/api/elections/${electionId}`),
    enabled: typeof electionId === "string" && electionId.length > 0,
    retry: false,
  });

  // A missing/empty id disables the query but leaves isPending true forever;
  // without this guard a malformed deep link traps the user on the spinner.
  if (typeof electionId !== "string" || electionId.length === 0) {
    return (
      <View className="flex-1 bg-white px-4 py-8">
        <Stack.Screen options={{ title: "Election" }} />
        <NotFoundNotice subject="Election" />
      </View>
    );
  }

  if (election.isPending) {
    return (
      <View className="flex-1 bg-white">
        <Stack.Screen options={{ title: "Election" }} />
        <LoadingNotice text="Loading election…" />
      </View>
    );
  }

  if (election.isError) {
    const notFound = election.error instanceof ApiError && election.error.status === 404;
    return (
      <View className="flex-1 bg-white px-4 py-8">
        <Stack.Screen options={{ title: "Election" }} />
        {notFound ? <NotFoundNotice subject="Election" /> : <ErrorNotice error={election.error} />}
      </View>
    );
  }

  const data = election.data;
  const competitiveness = competitivenessChip(data);
  const measure = data.ballot_measure;
  // Election-level sources the measure section did not already show (its
  // source_urls plus the official-measure link), mirroring the web page.
  const measureShownSources = new Set<string>(
    measure ? [...measure.source_urls, ...(measure.official_measure_url ? [measure.official_measure_url] : [])] : []
  );
  const electionOnlySources = data.sources.filter((url) => !measureShownSources.has(url));
  // Pick gates, copied from the web ElectionPage. Controls render on
  // upcoming elections only (the backend rejects writes to past ones), and
  // only once the signed-in viewer's choices list is loaded. District gate
  // (docs/plans/pick-district-gate.md): controls only for a race in the
  // viewer's own districts; the decided-choice clause is the safety valve —
  // an existing pick always keeps its controls, so an imperfect geocode can
  // never lock someone out of changing it.
  const isGuest = me === null;
  const myChoice = choiceByElectionId?.get(data.id);
  // Judicial retention: an office race answered Yes/No (same as the web
  // page). No pick button on the judge card; the footer pair answers it.
  const retention = isRetentionRace(data);
  const choicesSettled = canChoose && choiceByElectionId !== undefined;
  const isUpcoming = data.election_date >= usLatestLocalDate();
  const showChoiceControls =
    choicesSettled &&
    !districtsLoading &&
    isUpcoming &&
    (districtIds?.has(data.district.id) === true || isDecidedChoice(myChoice));
  // State 3 of the gate: districts unknown (settled) on an upcoming race — a
  // conversion nudge sits where the controls would. Districts known but
  // foreign renders neither (state 2: clean read-only screen).
  const showAddressNudge =
    choicesSettled && !districtsLoading && isUpcoming && districtIds === undefined && !isDecidedChoice(myChoice);
  // Logged out on an upcoming race: one quiet login line where a control
  // would sit — mobile has no guest ballot draft. Logged-out past races
  // render nothing.
  const showGuestLoginLine = isGuest && isUpcoming;
  const chosenPartyFilter = partyPick.electionId === data.id ? partyPick.bucket : "all";
  // Data-driven visibility, same rules and resilience as the web
  // ElectionPage: render the filter only when the roster spans >= 2
  // buckets, and ignore — never clear — a picked bucket while the filter
  // is hidden.
  const partyCounts: Record<PartyBucket, number> = { democratic: 0, republican: 0, other: 0 };
  for (const candidate of data.candidates) {
    partyCounts[partyBucket(candidate.party)] += 1;
  }
  const presentPartyOptions = PARTY_FILTER_OPTIONS.filter((option) => partyCounts[option.bucket] > 0);
  const showPartyFilter = presentPartyOptions.length >= 2;
  const partyFilter =
    showPartyFilter && chosenPartyFilter !== "all" && partyCounts[chosenPartyFilter] > 0
      ? chosenPartyFilter
      : "all";
  const partyFilteredCandidates =
    partyFilter === "all"
      ? data.candidates
      : data.candidates.filter((candidate) => partyBucket(candidate.party) === partyFilter);
  // "Has a record on my issues": the exact relevance scoring the "my issues
  // first" sort uses — score > 0 means at least one stance-bearing record on
  // a saved area (relevance, not agreement). Applied after the party filter.
  // While the toggle is OFF it appears only when it could change the current
  // view (saved areas + the party-filtered set splits into matched +
  // unmatched); while ON it stays visible and keeps applying — even when
  // that empties the current party view — because an active filter that
  // silently stops applying would show a full roster the viewer believes is
  // filtered. Same as the web ElectionPage.
  const chosenRecordsFilter = recordsPick.electionId === data.id ? recordsPick.on : false;
  const matchedOnMyIssues = partyFilteredCandidates.filter(
    (candidate) => scoreStanceRelevance(aggregateRecordAreaStances(candidate.records), weights).score > 0
  );
  const recordsFilterOn = hasSaved && chosenRecordsFilter;
  const showRecordsFilter =
    recordsFilterOn ||
    (hasSaved && matchedOnMyIssues.length > 0 && matchedOnMyIssues.length < partyFilteredCandidates.length);
  const visibleCandidates = recordsFilterOn ? matchedOnMyIssues : partyFilteredCandidates;
  const hiddenByRecordsFilter = partyFilteredCandidates.length - matchedOnMyIssues.length;
  // Per-candidate result badges (Won / Advanced / Lost / …); the matching and
  // completeness guards — roster-matched winners only, losers only where the
  // outcome's own signal proves the race decided — live in
  // deriveCandidateResultBadges. Mirrors the web election page.
  const resultBadges = deriveCandidateResultBadges(data.results, data.candidates, data.seats_to_fill ?? null);
  // Same predicate as StrandedPicksNotice: a pick whose candidacy withdrew.
  const hasStrandedPicks = (myChoice?.picks ?? []).some((pick) => pick.candidacy_status === "withdrawn");

  return (
    // Root View + footer sibling (not an absolute overlay): RN has no
    // position:sticky, and a plain flex sibling below the ScrollView can
    // never cover content.
    <View className="flex-1 bg-white">
      {/* In flow above the scroller, like the web's header row: the draft's
          finish line when the last pick lands here (or on a candidate
          screen), never covering the footer. */}
      <DraftCompleteNotice />
      <ScrollView className="flex-1" contentContainerClassName="px-4 py-8">
      <Stack.Screen options={{ title: data.official_ballot_title }} />
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <Text className="flex-1 text-2xl font-bold text-ink">{data.official_ballot_title}</Text>
        <ShareButton
          path={`/elections/${data.id}`}
          shareText={`${data.official_ballot_title} — ${formatElectionDate(data.election_date)}`}
        />
      </View>
      <Text className="mt-1 text-sm text-ink-soft">
        {formatElectionDate(data.election_date)} · {formatDistrictName(data.district.name)} ·{" "}
        {formatDistrictType(data.district.district_type)}
        {data.election_stage ? <> · {data.election_stage}</> : null}
        {data.seats_to_fill != null && data.seats_to_fill > 1 ? <> · {data.seats_to_fill} seats</> : null}
      </Text>
      <View className="mt-2 flex-row flex-wrap gap-2">
        {data.vote_power.label !== "unknown" ? (
          // Colored text, not a tinted pill — same scale as the ballot cards.
          <Text className={`text-xs font-medium ${votePowerTextClass(data.vote_power.label)}`}>
            My vote power: {formatVotePowerLabel(data.vote_power.label)}
          </Text>
        ) : null}
        {competitiveness ? (
          <Text className="rounded bg-surface px-2 py-0.5 text-xs text-ink-soft">{competitiveness.label}</Text>
        ) : null}
      </View>
      {/* Mobile has no vote-power explanation panel, so without this line the
          rating chip would be an unsourced claim — name the analyst outlet
          and the as-of date (web carries the same attribution in its
          explanation panel). */}
      {competitiveness && data.current_competitiveness ? (
        <Text className="mt-1 text-xs text-ink-soft">{competitiveness.description}</Text>
      ) : null}

      {/* Measure elections skip this: the measure section shows the same
          areas with their stance. key: this mounted screen can render
          another race after a push, and the "+N more" expansion must not
          carry from one race to the next (same as the web page). */}
      {data.race_type !== "ballot_measure" ? (
        <OfficeInfo key={data.id} office={data.office ?? null} researchAreas={data.research_areas ?? []} weights={weights} />
      ) : null}

      {measure ? (
        <View className="mt-6 rounded-xl border border-line bg-white p-4">
          <Text className="text-lg font-semibold text-ink">Ballot measure</Text>
          {measure.research_area_tags.length > 0 ? (
            <View className="mt-2 flex-row flex-wrap gap-2">
              {measure.research_area_tags.map((tag) => (
                <Text
                  key={tag.research_area_id}
                  className={
                    savedAreaIds.has(tag.research_area_id)
                      ? "rounded border border-purple-300 bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-800"
                      : "rounded bg-surface px-2 py-0.5 text-xs text-ink-soft"
                  }
                >
                  {tag.name}
                </Text>
              ))}
            </View>
          ) : null}
          {measure.summary ? <Text className="mt-2 text-sm text-ink">{measure.summary}</Text> : null}
          <View className="mt-3 gap-3">
            <View className="rounded border border-green-200 bg-green-50 p-3">
              <Text className="text-sm font-semibold text-green-900">A YES vote means</Text>
              <Text className="mt-1 text-sm text-green-900">{measure.what_yes_means}</Text>
            </View>
            <View className="rounded border border-red-200 bg-red-50 p-3">
              <Text className="text-sm font-semibold text-red-900">A NO vote means</Text>
              <Text className="mt-1 text-sm text-red-900">{measure.what_no_means}</Text>
            </View>
          </View>
          {/* Auto-pick sits here, not on the footer card: right after
              reading what Yes and No mean is where "answer from my issues"
              helps. Compact so the Yes/No pair stays the loud control; same
              gate as the card, and keyed to the election because this
              mounted screen can render another race after a push. */}
          {data.race_type === "ballot_measure" && showChoiceControls ? (
            <View className="mt-3">
              <AutoPickControl key={data.id} electionId={data.id} seatsToFill={null} compact />
            </View>
          ) : null}
          {/* Right after what Yes and No mean: who is paying to push each answer. */}
          {measure.funding ? <MeasureFundingSection funding={measure.funding} homeState={data.district.state} /> : null}
          {measure.result ? (
            <Text className="mt-3 text-sm font-medium text-ink">
              Result:{" "}
              <Text className={measure.result === "passed" ? "text-green-700" : "text-red-700"}>
                {measure.result}
              </Text>
            </Text>
          ) : null}
          {measure.official_measure_url ? (
            <Text
              className="mt-3 text-sm font-medium text-rausch-dark underline" accessibilityRole="link"
              onPress={() => openExternalUrl(measure.official_measure_url as string)}
            >
              {isGovernmentUrl(measure.official_measure_url)
                ? `Read the official measure text${isPdfUrl(measure.official_measure_url) ? " (PDF)" : ""}`
                : "More about this measure"}
            </Text>
          ) : null}
          <SourceFootnote
            urls={measure.source_urls.filter((url) => url !== measure.official_measure_url)}
            className="mt-1"
          />
        </View>
      ) : null}

      {/* Districts unknown on a measure: the nudge takes the footer card's
          slot (plain, not pinned — a passive sentence doesn't earn viewport
          pinning). measure !== null like the footer card: a TBD measure
          renders no pick UI of any kind. Same slot for the guest login
          line. */}
      {measure !== null && data.race_type === "ballot_measure" && showAddressNudge ? (
        <View className="mt-4">
          <AddressNudge />
        </View>
      ) : null}
      {measure !== null && data.race_type === "ballot_measure" && showGuestLoginLine ? (
        <View className="mt-4">
          <LogInToPlanLine />
        </View>
      ) : null}

      {/* hasStrandedPicks keeps this section alive when EVERY candidacy
          withdrew: the payload then lists no candidates, but the stranded
          notice below is the screen's only removal control. */}
      {data.candidates.length > 0 || (showChoiceControls && hasStrandedPicks) ? (
        <View className="mt-6">
          <Text className="text-lg font-semibold text-ink">Candidates</Text>
          {/* Multi-seat hint, same copy as the web page header. */}
          {showChoiceControls && data.seats_to_fill != null && data.seats_to_fill > 1 ? (
            <Text className="mt-1 text-xs text-ink-soft">
              This election fills {data.seats_to_fill} seats — pick up to {data.seats_to_fill} candidates.
            </Text>
          ) : null}
          {/* Race-level "Pick by my issues": one engine run for this
              election (mode replace — a re-run refreshes the pick), with
              its "Why this pick" panel below the button. key: this mounted
              screen can render another race after a push, and without a
              remount the previous election's panel (or an in-flight run's
              result) would surface under the next one. length: in the
              stranded-only state (section open, every candidacy withdrawn)
              the engine has nobody to pick. */}
          {data.candidates.length > 0 && showChoiceControls && data.race_type !== "ballot_measure" && !retention ? (
            <View className="mt-2">
              <AutoPickControl key={data.id} electionId={data.id} seatsToFill={data.seats_to_fill ?? null} />
            </View>
          ) : null}
          {/* Stranded picks have no candidate card below (withdrawn
              candidacies are filtered out of the payload), yet still count
              toward the seat cap and disable the remaining buttons —
              surface them here with their removal control, like the web. */}
          {showChoiceControls ? <StrandedPicksNotice electionId={data.id} choice={myChoice} /> : null}
          {/* Districts unknown: the nudge takes the controls' slot at the
              top of the candidate list; guests get the login line there. */}
          {showAddressNudge && data.race_type !== "ballot_measure" ? (
            <View className="mt-2">
              <AddressNudge />
            </View>
          ) : null}
          {showGuestLoginLine && data.race_type !== "ballot_measure" ? (
            <View className="mt-2">
              <LogInToPlanLine />
            </View>
          ) : null}
          {hasSaved && data.candidates.length > 1 ? (
            <View className="mt-2">
              <SortChips
                options={CANDIDATE_SORT_OPTIONS}
                value={candidateSort}
                onChange={setChosenSort}
                accessibilityLabel="Sort candidates"
              />
            </View>
          ) : null}
          {showPartyFilter ? (
            <View className="mt-2">
              <SortChips
                options={[
                  { value: "all" as const, label: `All (${data.candidates.length})` },
                  ...presentPartyOptions.map((option) => ({
                    value: option.bucket,
                    label: `${option.label} (${partyCounts[option.bucket]})`,
                  })),
                ]}
                value={partyFilter}
                onChange={(bucket) => setPartyPick({ electionId: data.id, bucket })}
                accessibilityLabel="Filter candidates by party"
              />
            </View>
          ) : null}
          {showRecordsFilter ? (
            <View className="mt-2 flex-row flex-wrap items-center gap-2">
              {/* Same chip styling as SortChips; a lone toggle rather than a
                  chips row because there is no option set to pick from. */}
              <Pressable
                onPress={() => setRecordsPick({ electionId: data.id, on: !recordsFilterOn })}
                accessibilityRole="button"
                accessibilityState={{ selected: recordsFilterOn }}
                className={
                  recordsFilterOn
                    ? "rounded-full border border-ink bg-ink px-3 py-1.5"
                    : "rounded-full border border-line bg-white px-3 py-1.5"
                }
              >
                <Text className={recordsFilterOn ? "text-xs font-medium text-white" : "text-xs text-ink"}>
                  Has a record on my issues
                </Text>
              </Pressable>
              {recordsFilterOn && hiddenByRecordsFilter > 0 ? (
                // The hidden count is always visible while the filter hides
                // anyone: no records ≠ no stances (rosters are unevenly
                // researched), so the filtered list must never look like the
                // full roster. At 0 hidden there is nothing concealed and
                // the pressed chip alone carries the state.
                <Text className="text-xs text-ink-soft">
                  {hiddenByRecordsFilter} candidate{hiddenByRecordsFilter === 1 ? "" : "s"} hidden ·{" "}
                  <Text
                    accessibilityRole="button"
                    className="font-medium underline"
                    onPress={() => setRecordsPick({ electionId: data.id, on: false })}
                  >
                    Show all
                  </Text>
                </Text>
              ) : null}
            </View>
          ) : null}
          <View className="mt-3 gap-3">
            {sortCandidatesByStance(visibleCandidates, candidateSort, weights).map(({ candidate, stances }) => (
              <CandidateCard
                key={candidate.candidate_id}
                candidate={candidate}
                stances={stances}
                savedAreaIds={savedAreaIds}
                resultBadge={resultBadges.get(candidate.candidate_id)}
                followButton={
                  canFollow && follows ? (
                    <FollowButton
                      candidateId={candidate.candidate_id}
                      candidateName={candidate.display_name}
                      isFollowing={followedIds.has(candidate.candidate_id)}
                      size="sm"
                    />
                  ) : null
                }
                pickControl={
                  // Withdrawn candidacies never reach this payload for
                  // upcoming races, but the writer also rejects
                  // withdrawn/lost — don't render a button whose only
                  // outcome is an error. Same guard as the web page.
                  showChoiceControls && !retention && candidate.status !== "withdrawn" && candidate.status !== "lost" ? (
                    <CandidatePickButton
                      electionId={data.id}
                      candidateId={candidate.candidate_id}
                      candidateName={candidate.display_name}
                      choice={myChoice}
                      seatsToFill={data.seats_to_fill ?? null}
                      size="sm"
                    />
                  ) : null
                }
              />
            ))}
          </View>
        </View>
      ) : data.candidate_roster_status ? (
        // Empty office roster: say WHY instead of hiding the section (roster
        // awaiting certification, profiles being prepared, or unavailable).
        <View className="mt-6">
          <Text className="text-lg font-semibold text-ink">Candidates</Text>
          <View className="mt-3 rounded-xl border border-line bg-white p-4">
            <Text className="text-sm text-ink-soft">{formatRosterStatus(data.candidate_roster_status).long}</Text>
          </View>
        </View>
      ) : null}

      {data.results.length > 0 ? (
        <View className="mt-6 rounded-xl border border-line bg-white p-4">
          <Text className="text-lg font-semibold text-ink">Results</Text>
          <Text className="mt-1 text-xs text-ink-soft">
            Unofficial until certified by the relevant election authority.
          </Text>
          <View className="mt-2 gap-3">
            {data.results.map((result) => (
              <View key={result.id}>
                <Text className="text-sm text-ink">
                  <Text className="font-medium">{formatOutcome(result.outcome)}</Text>
                  {result.result_status ? (
                    <Text className="text-ink-soft"> · {formatOutcome(result.result_status)}</Text>
                  ) : null}
                </Text>
                {result.winners.length > 0 ? (
                  <Text className="text-sm text-ink-soft">
                    Winner{result.winners.length === 1 ? "" : "s"}:{" "}
                    {result.winners
                      .map((winner) =>
                        winner.party
                          ? `${winner.candidate_name ?? "Unknown"} (${winner.party})`
                          : (winner.candidate_name ?? "Unknown")
                      )
                      .join(", ")}
                  </Text>
                ) : null}
                <SourceLine url={result.source_url} researchedDate={result.retrieved_at.slice(0, 10)} />
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* One footnote line, no heading, minus anything the measure section
          already cited (same rule as the web page). */}
      <SourceFootnote urls={electionOnlySources} className="mt-6" />
      </ScrollView>
      {/* The measure screen's ONE pick control, in a safe-area-aware footer
          below the scroll area (the web pins the same card with sticky).
          measure !== null too, not just the race type: an upcoming measure
          election can exist before its ballot-measure row (details TBD), and
          a Yes/No pair with no explanation of what either vote means would
          be worse than none. */}
      {((measure !== null && data.race_type === "ballot_measure") || retention) && showChoiceControls ? (
        <View
          className="border-t border-line bg-white px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          {retention ? (
            <Text className="mb-2 text-sm text-ink-soft">Yes keeps this judge in office. No removes them.</Text>
          ) : null}
          <MeasureChoiceButtons electionId={data.id} choice={myChoice} />
          {/* Post-pick continuation: back to the list this race came from.
              Only after a recorded position (the "added to cart" moment) and
              only when there is somewhere to go back to (deep links have no
              stack). */}
          {myChoice?.measure_position != null && router.canGoBack() ? (
            <Text
              className="mt-2 text-center text-sm text-ink-soft underline"
              accessibilityRole="link"
              onPress={() => router.back()}
            >
              Back
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// Same cap as the ballot cards; here the overflow expands in place — this
// screen is where the full set lives.
const MAX_AFFECTS_AREAS = 3;

// The office summary is seeded as newline-separated bullets, rendered as-is
// under the "About this office" heading. Blank lines are dropped; nothing
// else is parsed — no hook, no label. Port of the web ElectionPage.
function officeSummaryLines(summary: string): string[] {
  return summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Duties first, then which issues the election touches. Renders nothing
 * when the payload carries neither (the ?? fallbacks at the call site cover
 * deploy skew — a not-yet-redeployed backend omits both fields, which must
 * degrade to "no section", not a crash).
 */
function OfficeInfo({
  office,
  researchAreas,
  weights,
}: {
  office: ElectionDetail["office"];
  researchAreas: ElectionDetail["research_areas"];
  weights: ReturnType<typeof useMyResearchAreas>["weights"];
}) {
  const [expanded, setExpanded] = useState(false);
  const bullets = office ? officeSummaryLines(office.summary) : [];
  if (office === null && researchAreas.length === 0) {
    return null;
  }
  // Saved matches lead in the user's rank order, in purple; the rest follow
  // in green. Same split and colors as the ballot cards.
  const { saved, others } = splitResearchAreasBySaved(researchAreas, weights);
  const ordered = [...saved, ...others];
  const visible = expanded ? ordered : ordered.slice(0, MAX_AFFECTS_AREAS);
  const hiddenCount = ordered.length - visible.length;
  const showToggle = ordered.length > MAX_AFFECTS_AREAS;
  return (
    <View className="mt-6 rounded-xl border border-line bg-white p-4">
      <Text className="text-lg font-semibold text-ink">About this office</Text>
      {bullets.length > 0 ? (
        <View className="mt-2 gap-1">
          {bullets.map((line, index) => (
            <View key={index} className="flex-row gap-2">
              <Text className="text-sm text-ink">{"\u2022"}</Text>
              <Text className="flex-1 text-sm text-ink">{line}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {researchAreas.length > 0 ? (
        <Text className="mt-3 text-sm">
          <Text className="font-medium text-ink-soft">Affects:</Text>{" "}
          {visible.map((area, index) => (
            <Fragment key={area.id}>
              <Text className={saved.includes(area) ? SAVED_AREA_TEXT_CLASS : AREA_TEXT_CLASS}>{area.name}</Text>
              {index < visible.length - 1 || showToggle ? ", " : null}
            </Fragment>
          ))}
          {showToggle ? (
            <Text
              className="font-medium text-ink underline"
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : `+${hiddenCount} more issue${hiddenCount === 1 ? "" : "s"}`}
            </Text>
          ) : null}
        </Text>
      ) : null}
    </View>
  );
}

function CandidateCard({
  candidate,
  stances,
  savedAreaIds,
  resultBadge,
  followButton,
  pickControl,
}: {
  candidate: ElectionDetail["candidates"][number];
  stances: ReturnType<typeof aggregateRecordAreaStances>;
  savedAreaIds: Set<string>;
  /** Won / Advanced / Lost / … once a decisive result is recorded. */
  resultBadge?: CandidateResultBadge;
  followButton?: React.ReactNode;
  /** The "Make my pick" button when the viewer can pick in this race. */
  pickControl?: React.ReactNode;
}) {
  const router = useRouter();
  const [financeOpen, setFinanceOpen] = useState(false);
  return (
    <View className="rounded-xl border border-line bg-white">
      <Pressable
        onPress={() => router.push(`/candidates/${candidate.candidate_id}`)}
        className="p-4 active:bg-surface"
        accessibilityRole="link"
      >
        <View className="flex-row items-start justify-between gap-3">
          <View className="flex-1">
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="font-semibold text-ink">{candidate.display_name}</Text>
              {resultBadge ? (
                <Text
                  className={
                    resultBadge.kind === "winner"
                      ? "rounded border border-green-700 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-900"
                      : "rounded border border-red-700 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-900"
                  }
                >
                  {resultBadge.label}
                </Text>
              ) : null}
            </View>
            <Text className="text-sm text-ink-soft">
              <Text className={partyColorClass(candidate.party) || undefined}>
                {candidate.party}
              </Text>
              {candidate.is_incumbent ? " · Incumbent" : ""}
              {candidate.status !== "active" && candidate.status !== "declared"
                ? ` · ${candidate.status}`
                : ""}
            </Text>
          </View>
          <View className="shrink-0 items-end gap-2">
            {candidate.finance_summary?.direct_campaign.total_raised != null ? (
              <Text className="text-sm text-ink-soft">
                Raised {formatMoney(candidate.finance_summary.direct_campaign.total_raised)}
              </Text>
            ) : null}
            {candidate.finance_summary?.direct_campaign.loans_received != null &&
            candidate.finance_summary.direct_campaign.loans_received > 0 ? (
              <Text className="text-sm text-ink-soft">
                Loans {formatMoney(candidate.finance_summary.direct_campaign.loans_received)}
              </Text>
            ) : null}
            {/* Nested pressable: the follow tap wins over the card's
                navigation, mirroring the web's stopPropagation wrapper. */}
            {followButton}
          </View>
        </View>
        {candidate.summary ? (
          <Text className="mt-2 text-sm text-ink" numberOfLines={3}>
            {candidate.summary}
          </Text>
        ) : null}
        {stances.length > 0 ? (
          <View className="mt-2 flex-row flex-wrap gap-2">
            {stances.map((stance) => (
              <Text
                key={stance.research_area_id}
                className={
                  savedAreaIds.has(stance.research_area_id)
                    ? "rounded border border-purple-300 bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-800"
                    : "rounded bg-surface px-2 py-0.5 text-xs text-ink-soft"
                }
              >
                {stance.name} ·{" "}
                {[
                  stance.for_count > 0 ? `${stance.for_count} for` : null,
                  stance.against_count > 0 ? `${stance.against_count} against` : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </Text>
            ))}
          </View>
        ) : null}
        {/* Nested pressable like the follow button: the pick tap wins over
            the card's navigation. Own row at the card's foot — a small
            inline button next to the name is too cramped a touch target on
            a phone. */}
        {pickControl ? <View className="mt-3 flex-row">{pickControl}</View> : null}
      </Pressable>
      {hasFinanceContent(candidate.finance_summary) ? (
        // Same per-card disclosure as the web page's <details>; a separate
        // pressable so opening finance never triggers the card's navigation.
        <View className="border-t border-line px-4 py-3">
          <Pressable
            onPress={() => setFinanceOpen((current) => !current)}
            accessibilityRole="button"
            accessibilityState={{ expanded: financeOpen }}
            accessibilityLabel={`Campaign finance for ${candidate.display_name}`}
          >
            {/* The web gets a free disclosure triangle from <details>;
                mirror that affordance for sighted users. */}
            <Text className="text-sm font-medium text-ink">
              {financeOpen ? "▾" : "▸"} Campaign finance
            </Text>
          </Pressable>
          {financeOpen ? (
            <View className="mt-2">
              <FinanceSummaryCard summary={candidate.finance_summary} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function isPdfUrl(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}

// "Official" is a claim, not a style: only .gov links get the official
// label; anything else keeps neutral wording. .us is deliberately excluded —
// it is an open registry (individuals and businesses register ordinary .us
// domains), so it is not evidence of government hosting.
function isGovernmentUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".gov");
  } catch {
    return false;
  }
}

// Client-side "my issues first" candidate ordering: weighted unique matched
// areas dominate, matching record volume breaks ties, and candidates that
// tie completely keep the payload's alphabetical order (stable sort over
// the original sequence). Relevance, not agreement: against-only records on
// a saved issue still count as a track record on it. Same logic as the web
// ElectionPage.
function sortCandidatesByStance(
  candidates: ElectionDetail["candidates"],
  sort: CandidateSort,
  weights: ReturnType<typeof useMyResearchAreas>["weights"]
): {
  candidate: ElectionDetail["candidates"][number];
  stances: ReturnType<typeof aggregateRecordAreaStances>;
}[] {
  const entries = candidates.map((candidate) => ({
    candidate,
    stances: aggregateRecordAreaStances(candidate.records),
  }));
  if (sort === "alphabetical") {
    return entries;
  }
  return entries
    .map((entry, index) => ({ entry, index, score: scoreStanceRelevance(entry.stances, weights) }))
    .sort(
      (a, b) =>
        b.score.score - a.score.score || b.score.recordCount - a.score.recordCount || a.index - b.index
    )
    .map(({ entry }) => entry);
}

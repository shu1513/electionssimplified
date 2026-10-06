import type { ElectionChoice, ElectionSummary, ResearchAreaWeight } from "@voteapp/api-client";
import {
  competitivenessChip,
  formatChoiceLabel,
  formatDistrictName,
  formatDistrictType,
  formatElectionDate,
  formatResultChipLabel,
  formatRosterStatus,
  formatVotePowerLabel,
  resultChipTone,
  splitResearchAreasBySaved,
} from "@voteapp/api-client";
import type { ResultChipTone } from "@voteapp/api-client";
import { useRouter } from "expo-router";
import { Fragment } from "react";
import { Pressable, Text, View } from "react-native";
import { usLatestLocalDate } from "../lib/usLatestLocalDate";
import { votePowerTextClass } from "../lib/votePowerText";

// Same green/red as the election page's candidate result badges — one color
// language for "called" across surfaces. Mirrors the web ElectionCard.
const RESULT_CHIP_CLASSES: Record<ResultChipTone, string> = {
  positive: "rounded border border-green-700 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-900",
  negative: "rounded border border-red-700 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-900",
  neutral: "rounded bg-surface px-2 py-0.5 text-xs text-ink",
};

// Statewide races carry a dozen-plus research areas; rendering every one
// buried the card's actual signal under a wall of identical chips. Saved
// matches lead, the cap applies to the whole row, and the election screen
// carries the full set. Same cap as the web card.
const MAX_AREA_CHIPS = 3;

// Research areas render as plain colored text, comma-separated — NOT boxed
// chips (boxes read as buttons). Saved matches lead AND render in purple:
// purple means "an issue on my list" on every surface, and is the one hue
// the stance colors (green/red/amber) and party colors don't use. Mirrors
// the web card's AREA_TEXT_CLASS / SAVED_AREA_TEXT_CLASS.
export const AREA_TEXT_CLASS = "font-medium text-green-900";
export const SAVED_AREA_TEXT_CLASS = "font-semibold text-purple-800";

/**
 * Shared between the anonymous ballot and the saved ballot. savedAreaWeights
 * (verified users with saved research areas — useMyResearchAreas().weights)
 * puts the matching areas first, in purple, so "affects what I care about"
 * reads at a glance.
 */
export function ElectionCard({
  election,
  savedAreaWeights,
  myChoice,
}: {
  election: ElectionSummary;
  savedAreaWeights?: Map<string, ResearchAreaWeight>;
  /** The viewer's planned vote for this election, when they have one. */
  myChoice?: ElectionChoice;
}) {
  const router = useRouter();
  // The viewer's planned vote, shown only on upcoming races: a past
  // election's choice is history. Races WITHOUT a pick show nothing — the
  // absence of a green chip already marks them. Same rule as the web card.
  const isUpcoming = election.election_date >= usLatestLocalDate();
  const choiceLabel = myChoice && isUpcoming ? formatChoiceLabel(myChoice) : null;
  const competitiveness = competitivenessChip(election);
  // Saved matches lead in the user's rank order and take the slots first;
  // everything else folds into the overflow count. Same split as the web.
  const { saved: savedAreas, others: otherAreas } = splitResearchAreasBySaved(
    election.research_areas,
    savedAreaWeights
  );
  const visibleAreas = [...savedAreas, ...otherAreas].slice(0, MAX_AREA_CHIPS);
  const hiddenAreaCount = election.research_areas.length - visibleAreas.length;
  return (
    <Pressable
      onPress={() => router.push(`/elections/${election.id}`)}
      className="rounded-xl border border-line bg-white p-4 active:bg-surface"
      accessibilityRole="link"
    >
      <View className="flex-row items-start justify-between gap-3">
        <Text className="flex-1 font-semibold text-ink">{election.official_ballot_title}</Text>
        <Text className="shrink-0 text-sm text-ink-soft">{formatElectionDate(election.election_date)}</Text>
      </View>
      {election.voting_method === "ranked_choice" ? (
        <Text className="mt-1 text-sm text-ink">
          This race uses ranked-choice voting: rank the candidates in order of preference.
        </Text>
      ) : null}
      <Text className="mt-1 text-sm text-ink-soft">
        {formatDistrictName(election.district.name)} · {formatDistrictType(election.district.district_type)}
        {election.office ? <> · {election.office.canonical_name}</> : null}
      </Text>
      <View className="mt-2 flex-row flex-wrap items-center gap-2">
        {choiceLabel ? (
          // Leads the chip row: the voter's own decision outranks the other
          // signals. A "No" measure pick renders red to match the measure
          // screen's "A NO vote means" box — a green "My pick: No" read as
          // a contradiction. Same styling as the web card's chip.
          <Text
            className={
              myChoice?.measure_position === "no"
                ? "rounded border border-red-700 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-900"
                : "rounded border border-green-700 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-900"
            }
          >
            {choiceLabel}
          </Text>
        ) : null}
        {election.followed_candidates && election.followed_candidates.length > 0 ? (
          <Text className="rounded bg-rausch px-2 py-0.5 text-xs font-medium text-white">
            You follow {election.followed_candidates.map((candidate) => candidate.display_name).join(", ")}
          </Text>
        ) : null}
        {election.race_type === "ballot_measure" ? (
          // Green letters, no pill — same as the web card (user decision
          // 2026-09-11). The gray chip read as a status badge.
          <Text className="px-2 py-0.5 text-xs text-nudge-deep">Ballot measure</Text>
        ) : election.candidate_count === 0 && election.candidate_roster_status ? (
          <Text className="rounded bg-surface px-2 py-0.5 text-xs text-ink-soft">
            {formatRosterStatus(election.candidate_roster_status).short}
          </Text>
        ) : election.candidate_count === 1 ? (
          // The one count worth showing: a lone name usually means the race
          // is decided. Stated as a count, not "Uncontested" — the roster
          // status only exists for empty rosters, so nothing here proves the
          // list is complete. Any other count changed nothing about whether
          // to open the race, so it no longer renders. Same as the web card.
          <Text className="rounded bg-surface px-2 py-0.5 text-xs text-ink-soft">1 candidate</Text>
        ) : null}
        {election.vote_power.label !== "unknown" && election.vote_power.label !== "retention" ? (
          // Colored text, not a tinted pill: the label glows warm for
          // high-leverage races and fades to gray for low ones — never
          // rausch, which is the brand/CTA color, and never purple, which
          // marks the viewer's saved issues on the same card.
          <Text className={`text-xs font-medium ${votePowerTextClass(election.vote_power.label)}`}>
            My vote power: {formatVotePowerLabel(election.vote_power.label)}
          </Text>
        ) : null}
        {competitiveness ? (
          <Text className="rounded bg-surface px-2 py-0.5 text-xs text-ink-soft">{competitiveness.label}</Text>
        ) : null}
        {election.has_results ? (
          // Called results get the badge colors from the election page
          // (green = decided forward, red = failed) so the answer stands out
          // from the neutral info chips; undecided rows stay neutral so
          // color always means "called".
          <Text className={RESULT_CHIP_CLASSES[resultChipTone(election.current_result_outcome)]}>
            {election.current_result_outcome
              ? formatResultChipLabel(election.current_result_outcome, election.current_result_winners ?? [])
              : "Results available"}
          </Text>
        ) : null}
      </View>
      {election.research_areas.length > 0 ? (
        // One comma-separated list: saved matches lead in purple semibold,
        // the rest in green under the cap. Nested Text so the row wraps as
        // prose, not as chips.
        <Text className="mt-3 text-sm">
          <Text className="font-medium text-ink-soft">Affects:</Text>{" "}
          {visibleAreas.map((area, index, all) => (
            <Fragment key={area.id}>
              <Text className={savedAreas.includes(area) ? SAVED_AREA_TEXT_CLASS : AREA_TEXT_CLASS}>{area.name}</Text>
              {index < all.length - 1 || hiddenAreaCount > 0 ? ", " : null}
            </Fragment>
          ))}
          {hiddenAreaCount > 0 ? (
            <Text className={AREA_TEXT_CLASS}>
              +{hiddenAreaCount} more issue{hiddenAreaCount === 1 ? "" : "s"}
            </Text>
          ) : null}
        </Text>
      ) : null}
    </Pressable>
  );
}

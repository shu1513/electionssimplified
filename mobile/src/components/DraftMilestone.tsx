import { formatElectionDate, nearestDayDraftProgress, type ElectionChoice, type ElectionSummary } from "@voteapp/api-client";
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { hasDraftCompleteBeenSeen, markDraftCompleteSeen } from "../lib/draftCompleteSeen";

// Mobile port of the web's DraftMilestone (docs/plans/
// draft-completion-moment.md, section 2): the My Draft screen's finish
// line, above the date cards, once every counted race on the nearest
// upcoming election day has a pick (grouped retentions have separate progress) — and shown ONCE per day per device (owner's
// rule: persistent = nag). Same counting rule as the card's "N / M"
// progress bar (isDecidedChoice) and the same one-line wording as the
// notice. The seen state is read on each focus (AsyncStorage, async) and
// held, so the box stays for this visit even though it marks the day right
// away; the next focus finds the marker and shows nothing. Marking also
// covers the notice's scope, so the pick screens' one-time notice never
// fires for a day read about here. No sign-up link: mobile has no guest
// draft.

export function DraftMilestone({
  date,
  elections,
  choiceByElectionId,
}: {
  /** The nearest upcoming election day — the first carded date on or after
   * today, not the first card (just-finished days stay carded for a while). */
  date: string;
  elections: ElectionSummary[];
  choiceByElectionId: Map<string, ElectionChoice> | undefined;
}) {
  const progress = nearestDayDraftProgress(elections, choiceByElectionId, date);
  const complete = progress?.complete ?? false;

  // My Draft stays mounted under the screens it pushes (a native stack), so
  // "once per visit" is per FOCUS, not per mount: the marker is re-read
  // every time the screen regains focus, and the box only shows — and only
  // marks the day — while focused. Otherwise the last pick made on the
  // election screen above would flip `complete` while this screen is
  // hidden, mark the day unseen, and the user would come back to nothing.
  // null = not read yet for this focus; the box waits for a known answer.
  const focused = useIsFocused();
  const [seenState, setSeenState] = useState<{ date: string; seen: boolean } | null>(null);
  useEffect(() => {
    if (!focused) {
      return;
    }
    let cancelled = false;
    void hasDraftCompleteBeenSeen(date, "milestone").then((seen) => {
      if (!cancelled) {
        setSeenState({ date, seen });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [date, focused]);

  const show = focused && complete && seenState !== null && seenState.date === date && !seenState.seen;
  useEffect(() => {
    if (show) {
      void markDraftCompleteSeen(date, "milestone");
      void markDraftCompleteSeen(date, "notice");
    }
  }, [show, date]);

  if (!show) {
    return null;
  }
  return (
    <View
      accessibilityLabel={`${formatElectionDate(date)} election draft milestone`}
      className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3"
    >
      <Text className="text-sm font-semibold text-green-900">
        ✓ You have completed your {formatElectionDate(date)} election draft.
        {progress?.hasOpenRetention ? " Retention races are still open on your draft." : null}
      </Text>
    </View>
  );
}

import { formatElectionDate, useMe } from "@voteapp/api-client";
import { useIsFocused, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";
import { hasDraftCompleteBeenSeen, markDraftCompleteSeen } from "../lib/draftCompleteSeen";
import { useMyPicksProgress } from "../lib/useMyPicksProgress";

// Mobile port of the web's DraftCompleteNotice (docs/plans/
// draft-completion-moment.md): one notice, once per election day per
// device, when every counted race on the nearest upcoming day has a pick. Driven by
// the same progress value the saved-ballot header counter reads — a known
// incomplete → known complete for the SAME tracked ballot (identity + day +
// race list); null is "unknown", never "incomplete", so a returning user
// whose first resolved value is already complete gets nothing.
//
// Mounted in flow at the top of the two screens where picks are made (the
// election and candidate screens), above their ScrollView and never over
// their pick footer — the same "root View + siblings, no absolute overlay"
// rule those screens follow. Per-screen instances, not a root-layout
// overlay: RN has no shared header row to ride, and the notice belongs on
// the screen where the last pick landed. Screens beneath the focused one
// stay mounted in a native stack (election → candidate), so only the
// FOCUSED instance may fire and announce; the others just keep their
// baseline current. Losing focus retires the notice; the My Draft screen's
// milestone (DraftMilestone) is the persistent one.
//
// Wording (owner's call, same as the web): "You have completed your {day}
// election draft." plus the link and any open-retention reminder. Status message: polite live
// region on Android, an explicit VoiceOver announcement on iOS, focus and
// scroll position untouched.

export function DraftCompleteNotice() {
  const { me } = useMe();
  const router = useRouter();
  const focused = useIsFocused();
  const progress = useMyPicksProgress();

  const identity = me?.email ?? null;
  const trackedDate = identity !== null && progress !== null ? progress.election_date : null;
  const trackedKey =
    progress !== null && trackedDate !== null
      ? `${identity}|${trackedDate}|${[...progress.election_ids].sort().join(",")}`
      : null;
  const complete = progress?.complete ?? null;

  const baseline = useRef<{ key: string; complete: boolean } | null>(null);
  const [shown, setShown] = useState<{ key: string; date: string } | null>(null);
  // Render-time reset (the pattern TermsRenewalGate uses for its identity
  // key): the notice is CLEARED — not merely hidden — the moment progress
  // stops confirming it (unpick, ballot change, unknown) or the screen loses
  // focus. Clearing is what keeps an unpick → repick from resurrecting a
  // notice the seen marker already ruled out, announcement included.
  if (shown !== null && (shown.key !== trackedKey || complete !== true || !focused)) {
    setShown(null);
  }

  useEffect(() => {
    if (trackedKey === null || trackedDate === null || complete === null) {
      // Nothing confirms progress any more: break the chain.
      baseline.current = null;
      return;
    }
    const previous = baseline.current;
    baseline.current = { key: trackedKey, complete };
    if (previous === null || previous.key !== trackedKey || previous.complete || !complete) {
      return;
    }
    if (!focused) {
      // A screen beneath the focused one saw the same transition; the
      // focused screen owns the notice. Baseline is already current, so
      // regaining focus later cannot re-fire for this completion.
      return;
    }
    // Known incomplete → known complete for the same ballot, on the focused
    // screen. The seen check is async (AsyncStorage); `cancelled` guards
    // against an unpick or an unmount landing before it resolves.
    let cancelled = false;
    void hasDraftCompleteBeenSeen(trackedDate).then((seen) => {
      if (cancelled || seen) {
        return;
      }
      void markDraftCompleteSeen(trackedDate);
      setShown({ key: trackedKey, date: trackedDate });
    });
    return () => {
      cancelled = true;
    };
  }, [trackedKey, trackedDate, complete, focused]);

  // accessibilityLiveRegion below is Android-only; VoiceOver needs an
  // explicit announcement (same pattern as TermsRenewalGate's error line).
  const message = shown ? `You have completed your ${formatElectionDate(shown.date)} election draft.${progress?.hasOpenRetention ? " Retention races are still open on your draft." : ""}` : null;
  useEffect(() => {
    if (message !== null) {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);

  if (shown === null || message === null) {
    return null;
  }
  return (
    <View accessibilityLiveRegion="polite" className="border-b border-green-200 bg-green-50 px-4 py-2">
      <Text className="text-sm font-semibold text-green-900">{message}</Text>
      <View className="mt-1 flex-row items-center justify-between gap-3">
        <Text
          accessibilityRole="link"
          onPress={() => {
            setShown(null);
            router.push("/my-draft");
          }}
          className="text-sm font-semibold text-green-800 underline"
        >
          Review my picks
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={8}
          onPress={() => setShown(null)}
          className="rounded px-2 active:bg-green-100"
        >
          <Text className="text-lg leading-none text-green-900">×</Text>
        </Pressable>
      </View>
    </View>
  );
}

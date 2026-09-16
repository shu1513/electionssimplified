import {
  ApiError,
  RENEWAL_CHECKBOX_LABEL,
  TERMS_VERSION,
  useAcceptTerms,
  useMe,
} from "@voteapp/api-client";
import { Link, usePathname } from "expo-router";
import { useEffect, useState } from "react";
import { AccessibilityInfo, AppState, Modal, Pressable, Text, View } from "react-native";
import { useLogout } from "../lib/auth";
import { LegalGate } from "./LegalGate";

/**
 * Gate only when the recorded acceptance is OLDER than the version this
 * build can display. A plain !== would re-gate a user who already accepted
 * a newer version elsewhere (e.g. on the web after a terms bump this build
 * predates), and submitting this build's version for them would 422
 * forever. Accepting on the web is also the escape hatch for an outdated
 * build: once /api/me reports the newer version, the gate clears.
 */
function acceptedVersionIsBefore(accepted: string | null, current: string): boolean {
  if (accepted === null) {
    return true;
  }
  const acceptedParts = accepted.split(".").map(Number);
  const currentParts = current.split(".").map(Number);
  if ([...acceptedParts, ...currentParts].some(Number.isNaN)) {
    return accepted !== current;
  }
  for (let i = 0; i < Math.max(acceptedParts.length, currentParts.length); i++) {
    const acceptedPart = acceptedParts[i] ?? 0;
    const currentPart = currentParts[i] ?? 0;
    if (acceptedPart !== currentPart) {
      return acceptedPart < currentPart;
    }
  }
  return false;
}

/**
 * Blocking modal for signed-in users whose recorded terms acceptance
 * predates the current version — the mobile counterpart of the web's
 * TermsRenewalGate, with the same clickwrap rules (unchecked box, action
 * disabled until checked, adjacent document links via LegalGate).
 *
 * Mounted in the root layout, always rendered, so checkbox state survives
 * reading the linked documents: the component returns null on /legal/*
 * (the user has to be able to read what they are agreeing to) without
 * unmounting. A native Modal, not a positioned View, so the underlying
 * screens are unreachable by TalkBack/VoiceOver on both platforms.
 */
export function TermsRenewalGate() {
  const { me, refetch } = useMe();
  const pathname = usePathname();
  const acceptTerms = useAcceptTerms();
  const logout = useLogout();
  const [checked, setChecked] = useState(false);

  const gateActive = me != null && acceptedVersionIsBefore(me.accepted_terms_version, TERMS_VERSION);

  // Acceptance can also happen on the web (the escape hatch for outdated
  // builds), but this app has no AppState bridge into React Query's focus
  // manager, so nothing ever refetches ["me"] while the modal blocks every
  // screen — the gate would hold a fresh web acceptance hostage until an
  // app restart. Re-check on every return to the foreground instead.
  useEffect(() => {
    if (!gateActive) {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refetch();
      }
    });
    return () => subscription.remove();
  }, [gateActive, refetch]);

  // The component outlives sessions, so consent state must not: a box
  // checked by one user (or before a later terms bump) must never carry
  // over to the next time the gate appears. Render-time adjustment, so the
  // stale check is never visible for even a frame.
  const identityKey = me ? `${me.email}:${me.accepted_terms_version ?? ""}` : null;
  const [prevIdentityKey, setPrevIdentityKey] = useState(identityKey);
  if (identityKey !== prevIdentityKey) {
    setPrevIdentityKey(identityKey);
    setChecked(false);
  }
  const resetAcceptTerms = acceptTerms.reset;
  useEffect(() => {
    resetAcceptTerms();
  }, [identityKey, resetAcceptTerms]);

  // The backend 422s only when the submitted version is not its current
  // one, i.e. this build is older than the server's terms. Retrying from
  // the same build can never succeed, so say what actually helps.
  const staleBuild = acceptTerms.error instanceof ApiError && acceptTerms.error.status === 422;
  const errorText = staleBuild
    ? "This version of the app can't accept the newest terms. Please update Elections Simplified, or accept the updated terms on the Elections Simplified website."
    : "Something went wrong recording your acceptance. Please try again.";

  // accessibilityLiveRegion below is Android-only; VoiceOver needs an
  // explicit announcement.
  const showError = acceptTerms.isError;
  useEffect(() => {
    if (showError) {
      AccessibilityInfo.announceForAccessibility(errorText);
    }
  }, [showError, errorText]);

  if (!gateActive) {
    return null;
  }
  // The legal documents must be readable before agreeing, and the two
  // settings screens that hold the exits — Security (sign out, delete
  // account) and Email preferences — must stay reachable without agreeing:
  // a user who rejects the new terms has to be able to leave, and BPC
  // §17602(d) forbids extra steps in front of cancellation. Membership
  // management lives on the website (/me/membership), which the web gate
  // leaves open for the same reason.
  if (
    pathname.startsWith("/legal/") ||
    pathname === "/settings/security" ||
    pathname === "/settings/email-preferences"
  ) {
    return null;
  }

  const canAccept = checked && !acceptTerms.isPending;
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      // The gate is blocking: the Android back button must not dismiss it.
      onRequestClose={() => {}}
    >
      <View className="flex-1 items-center justify-center bg-ink/40 p-4">
        <View className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
          <Text accessibilityRole="header" className="text-lg font-bold text-ink">
            Our terms have been updated
          </Text>
          <Text className="mt-2 text-sm text-ink-soft">
            To keep using Elections Simplified, please review and accept the updated Terms of Use, Privacy
            Policy, and Disclaimer.
          </Text>
          <View className="mt-4">
            <LegalGate label={RENEWAL_CHECKBOX_LABEL} checked={checked} onChange={setChecked} />
          </View>
          {acceptTerms.isError ? (
            <Text accessibilityLiveRegion="assertive" className="mt-3 text-sm text-red-900">
              {errorText}
            </Text>
          ) : null}
          {staleBuild ? (
            // Foreground refetch covers accepting on this device's browser;
            // this covers accepting on another device while the app never
            // leaves the foreground.
            <Text
              accessibilityRole="button"
              onPress={() => void refetch()}
              className="mt-2 text-sm font-medium text-ink underline"
            >
              I&apos;ve accepted on the website — check again
            </Text>
          ) : null}
          <Pressable
            disabled={!canAccept}
            onPress={() => acceptTerms.mutate(TERMS_VERSION)}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canAccept }}
            className={
              canAccept
                ? "mt-4 w-full rounded-lg bg-rausch px-4 py-3 active:bg-rausch-dark"
                : "mt-4 w-full rounded-lg bg-line px-4 py-3"
            }
          >
            <Text className="text-center font-semibold text-white">
              {acceptTerms.isPending ? "Saving…" : "Agree and continue"}
            </Text>
          </Pressable>
          {/* The exit for someone who declines: sign out here, or reach the
              ungated Security screen (delete account) and the website's
              membership page. Without this the only way out of a
              stale-terms account is accepting, which a clickwrap must not
              force. */}
          <Text className="mt-3 text-center text-sm text-ink-soft">
            Don&apos;t agree? You can still{" "}
            <Link href="/settings/security" className="font-medium text-ink underline">
              delete your account
            </Link>
            , cancel a membership at electionssimplified.com/me/membership, or{" "}
            <Text
              accessibilityRole="button"
              accessibilityState={{ disabled: logout.isPending }}
              onPress={() => {
                if (!logout.isPending) {
                  logout.mutate();
                }
              }}
              className="font-medium text-ink underline"
            >
              {logout.isPending ? "signing out…" : "sign out"}
            </Text>
            .
          </Text>
        </View>
      </View>
    </Modal>
  );
}

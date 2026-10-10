import type { AddressLocation, AddressResolution } from "@voteapp/api-client";
import { apiRequest, TERMS_VERSION, useMe } from "@voteapp/api-client";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { AddressAutocomplete } from "../../components/AddressAutocomplete";
import { FullAddressExplanation } from "../../components/FullAddressExplanation";
import { ErrorNotice } from "../../components/Status";
import { useLogout } from "../../lib/auth";
import { setMatchedAddress } from "../../lib/matchedAddress";
import { clearPendingDistrictIds, savePendingDistrictIds } from "../../lib/pendingDistricts";

/**
 * Signed-in state / auth entry links. The account screens (saved ballot,
 * follows, settings) land in the next chunk; until then this strip is the
 * whole account surface.
 */
function AuthStrip() {
  const router = useRouter();
  const { me, isLoading, isError } = useMe();
  const logout = useLogout();
  // A failed identity fetch (backend down, network) must not masquerade as
  // "signed out" — render nothing rather than the log-in links.
  if (isLoading || isError) {
    return null;
  }
  if (!me) {
    return (
      <View className="flex-row justify-end gap-4 pb-2">
        <Text
          className="text-sm text-ink underline"
          accessibilityRole="link"
          onPress={() => router.push("/auth/login")}
        >
          Log in
        </Text>
        <Text
          className="text-sm text-ink underline"
          accessibilityRole="link"
          onPress={() => router.push("/auth/register")}
        >
          Sign up
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-row items-center justify-end gap-4 pb-2">
      <Text className="shrink text-sm text-ink-soft" numberOfLines={1}>
        {me.email}
        {me.email_verified ? "" : " (unverified)"}
      </Text>
      <Text
        className="text-sm text-ink underline"
        accessibilityRole="button"
        onPress={() => {
          if (!logout.isPending) {
            logout.mutate();
          }
        }}
      >
        {logout.isPending ? "Logging out…" : "Log out"}
      </Text>
    </View>
  );
}

/**
 * Port of the web HomePage's anonymous flow. Web-only concerns dropped:
 * the verified-user redirect to the saved ballot (no account screens yet)
 * and pre-hydration input adoption (no SSR). The matched address goes
 * through an in-memory holder — Expo Router serializes params into its
 * URL-based navigation state, and the address must never reach a URL.
 */
export default function HomeScreen() {
  const router = useRouter();
  const { me } = useMe();
  const [address, setAddress] = useState("");
  // Coordinates for the CURRENT address value, present only right after a
  // completed autocomplete selection; any manual edit clears them — same
  // rule as the web home.
  const [addressLocation, setAddressLocation] = useState<AddressLocation | null>(null);
  // Set right after the autocomplete selection was an area with a known
  // state (city, neighborhood, county): the search runs the region
  // partial-ballot path. Any edit clears it — same rule as the web home.
  const [regionSelection, setRegionSelection] = useState<{ state: string; locality: string | null } | null>(null);
  // True right after an area selection the server could not place in a
  // state — nothing to search, so the form shows guidance. Any edit clears
  // it — same rule as the web home.
  const [regionUnsupported, setRegionUnsupported] = useState(false);
  // True while a picked suggestion's retrieve is in flight: the input
  // already shows the description, but its classification has not landed,
  // so a quick tap on Search would send a bare area string to the geocoder
  // and 422 — same rule as the web home.
  const [retrievePending, setRetrievePending] = useState(false);
  const [addressExplanationVisible, setAddressExplanationVisible] = useState(false);
  const resolve = useMutation({
    mutationFn: (input: {
      address: string;
      coordinates: AddressLocation | null;
      region: { state: string; locality: string | null } | null;
    }) =>
      // Pressing Search under the agreement notice is the assent, so the
      // accepted version rides along with every search. Nothing is stored
      // server-side — same rule as the web. Coordinates (from the
      // autocomplete selection, when present) let the backend resolve venue
      // addresses the Census street data lacks.
      apiRequest<AddressResolution>("/api/address/resolve", {
        method: "POST",
        body: {
          address: input.address,
          accepted_terms_version: TERMS_VERSION,
          // Opt in to the ZIP/region partial-ballot paths: this build
          // renders the partial banner and scope-aware errors — same as the
          // web home.
          allow_partial: true,
          ...(input.coordinates ? { coordinates: input.coordinates } : {}),
          ...(input.region
            ? {
                region_state: input.region.state,
                ...(input.region.locality ? { region_locality: input.region.locality } : {}),
              }
            : {}),
        },
      }),
    onSuccess: (resolution) => {
      // Stash for the anonymous-to-account handoff: if this visitor signs
      // up, these districts become their saved ballot once they verify.
      // Save only when identity is KNOWN to be logged out or unverified —
      // while /api/me is still loading (me === undefined) a verified user's
      // one-off search must not re-arm the handoff. Same rule as the web.
      if (resolution.scope === "exact") {
        if (me === null || me?.email_verified === false) {
          void savePendingDistrictIds(resolution.districts.map((district) => district.id));
        }
      } else {
        // A partial (ZIP) result must not become a signed-up account's
        // saved ballot; clearing keeps "last search wins". Unconditional,
        // unlike the save: the identity guard exists so a verified user's
        // one-off search cannot ARM the handoff — clearing is harmless in
        // every identity state, including still-loading. Same rule as the
        // web home.
        void clearPendingDistrictIds();
      }
      // Straight to the elections — the districts list is a detour nobody
      // asked for. The matched address goes through the in-memory holder,
      // never navigation params — see lib/matchedAddress.ts.
      setMatchedAddress(resolution.matched_address, resolution.address_match_count, resolution.scope);
      router.push({
        pathname: "/ballot",
        params: {
          d: resolution.districts.map((district) => district.id).join(","),
          // Unlike the address, the partial flag holds no location, so it
          // may ride navigation params — same reasoning as the web URL.
          ...(resolution.scope !== "exact" ? { partial: "1" } : {}),
        },
      });
    },
  });

  // regionUnsupported: a stateless region selection can only fail (no
  // coordinates, no state, and the string is an area the geocoder can't
  // match) — Search disables while the guidance under the field explains;
  // any edit re-enables. Same rule as the web home.
  const canSearch =
    address.trim().length > 0 &&
    !resolve.isPending &&
    !regionUnsupported &&
    !retrievePending;

  function onSearchPress() {
    if (!canSearch) {
      return;
    }
    resolve.mutate({ address: address.trim(), coordinates: addressLocation, region: regionSelection });
  }

  return (
    <KeyboardAvoidingView className="flex-1 bg-white" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="px-4 py-10">
        <AuthStrip />
        {/* One sentence, no sub-line — same headline as the web home. Two
            steps below the old 3xl: at phone width a full sentence set that
            large ran six lines and pushed the address field off the fold. */}
        <Text className="text-xl font-bold text-ink">
          Uncover who your candidates really are by their track records
        </Text>
        {/* What the service is, where a first-time visitor looks — same line
            the web hero carries. */}
        <Text className="mt-3 text-center text-sm font-medium text-ink-soft">
          Independent, nonpartisan, AI-assisted election research with linked sources.
        </Text>

        <View className="mt-6 gap-4">
          <View>
            {/* Instructional label for first-time visitors, naming ZIP as the
                escape hatch and carrying the "why full address" explainer in
                its parenthesis — same shape as the web home. Signed-in
                surfaces keep "Your address". */}
            <Text className="text-sm font-medium text-ink">
              Enter address or ZIP to see which elections you can vote in (
              <Text
                className="font-normal underline"
                accessibilityRole="button"
                onPress={() => setAddressExplanationVisible(true)}
              >
                why full address
              </Text>
              ):
            </Text>
            <AddressAutocomplete
              value={address}
              onChange={(value, location, granularity, region) => {
                setAddress(value);
                setAddressLocation(location ?? null);
                setRegionSelection(granularity === "region" && region ? region : null);
                setRegionUnsupported(granularity === "region" && !region);
              }}
              onRetrievePendingChange={setRetrievePending}
              placeholder="1600 Pennsylvania Avenue NW, Washington, DC 20500"
              accessibilityLabel="Enter address or ZIP to see which elections you can vote in"
            />
            {regionUnsupported ? (
              <Text accessibilityRole="alert" className="mt-1 text-xs text-rausch-dark">
                We can’t place that selection in a state. Pick a street address, city, or ZIP
                code from the suggestions.
              </Text>
            ) : null}
          </View>

          <Pressable
            disabled={!canSearch}
            onPress={onSearchPress}
            accessibilityRole="button"
            className={
              canSearch ? "w-full rounded-md bg-rausch px-4 py-3 active:bg-rausch-dark" : "w-full rounded-md bg-line px-4 py-3"
            }
          >
            <Text className="text-center font-semibold text-white">
              {resolve.isPending ? "Searching…" : "Search"}
            </Text>
          </Pressable>
          {/* The agreement, in the same block as the button it names (sign-in
              wrap, Meyer v. Uber): pressing Search is the assent. Wording is
              PRE_SEARCH_NOTICE from legalCopy.ts word for word, with each
              document name opening its legal screen — same as the web form.
              The typed address is still here on the way back. */}
          <Text className="text-center text-xs text-ink-soft">
            By clicking Search you agree to the{" "}
            <Text className="text-ink underline" accessibilityRole="link" onPress={() => router.push("/legal/terms")}>
              Terms of Use
            </Text>
            ,{" "}
            <Text className="text-ink underline" accessibilityRole="link" onPress={() => router.push("/legal/privacy")}>
              Privacy Policy
            </Text>
            , and{" "}
            <Text
              className="text-ink underline"
              accessibilityRole="link"
              onPress={() => router.push("/legal/disclaimer")}
            >
              AI Research and Election Information Disclaimer
            </Text>
            .
          </Text>
        </View>

        {resolve.isError ? (
          <View className="mt-4">
            <ErrorNotice error={resolve.error} />
          </View>
        ) : null}
      </ScrollView>

      <FullAddressExplanation
        visible={addressExplanationVisible}
        onClose={() => setAddressExplanationVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

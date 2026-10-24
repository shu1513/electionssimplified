import { useRef } from "react";
import type { AddressLocation, AddressSuggestion } from "@voteapp/api-client";
import { useAddressSuggestions } from "@voteapp/api-client";
import { Pressable, Text, TextInput, View } from "react-native";

// Port of the web AddressAutocomplete. The suggestion machinery
// (useAddressSuggestions: debounce, AbortController, session token) is the
// shared hook unchanged; only the dropdown rendering is native. Autocomplete
// failing must never block the form: the input stays a plain controlled text
// field and the suggestion list simply disappears.

type AddressAutocompleteProps = {
  value: string;
  /** location is set only when the value came from a completed dropdown
   * selection; every keystroke or fallback call passes it as undefined, so
   * callers that track coordinates must clear them when it is absent.
   * granularity (and region, for area selections with a known state) arrive
   * only on a completed selection too — same contract as the web
   * AddressAutocomplete. */
  onChange: (
    value: string,
    location?: AddressLocation | null,
    granularity?: "address" | "zip" | "region",
    region?: { state: string; locality: string | null }
  ) => void;
  /** True while a selected suggestion's retrieve is in flight — the caller
   * must hold Search; same contract as the web AddressAutocomplete. */
  onRetrievePendingChange?: (pending: boolean) => void;
  placeholder?: string;
  /** Screen-reader label. React Native does not associate a sibling <Text>
   * with the input, so callers whose visible label differs from the default
   * must pass it here or screen readers announce the wrong thing. */
  accessibilityLabel?: string;
};

export function AddressAutocomplete({
  value,
  onChange,
  onRetrievePendingChange,
  placeholder,
  accessibilityLabel = "Your address",
}: AddressAutocompleteProps) {
  const { suggestions, enabled, onInputChanged, selectSuggestion, clearSuggestions, warmup } =
    useAddressSuggestions();

  // Overlapping selections each hold and release the pending flag; a count
  // keeps an earlier release from unfreezing Search while a later retrieve
  // is still in flight.
  const retrievesInFlight = useRef(0);

  async function onSelect(suggestion: AddressSuggestion) {
    // Optimistically show the picked description, then upgrade to the full
    // retrieved address (falls back to the description if retrieve fails).
    onChange(suggestion.description);
    clearSuggestions();
    retrievesInFlight.current += 1;
    onRetrievePendingChange?.(true);
    let retrieved: Awaited<ReturnType<typeof selectSuggestion>>;
    try {
      retrieved = await selectSuggestion(suggestion);
    } finally {
      retrievesInFlight.current -= 1;
      if (retrievesInFlight.current === 0) {
        onRetrievePendingChange?.(false);
      }
    }
    if (!retrieved) {
      return;
    }
    if (retrieved.granularity === "zip" && retrieved.postal_code) {
      // A picked ZIP becomes the bare five digits — exactly what the resolve
      // endpoint's partial-ballot path takes.
      onChange(retrieved.postal_code, null, "zip");
      return;
    }
    onChange(
      retrieved.address,
      retrieved.location,
      retrieved.granularity,
      retrieved.granularity === "region" && retrieved.state
        ? { state: retrieved.state, locality: retrieved.locality }
        : undefined
    );
  }

  return (
    <View>
      <TextInput
        className="mt-1 w-full rounded-md border border-line bg-white px-3 py-3 text-ink"
        placeholder={placeholder}
        placeholderTextColor="#717171"
        autoComplete="street-address"
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={(text) => {
          onChange(text);
          onInputChanged(text);
        }}
        onFocus={() => warmup()}
      />
      {enabled && suggestions.length > 0 ? (
        <View className="mt-1 overflow-hidden rounded-xl border border-line bg-white">
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.place_id}
              className="px-3 py-2 active:bg-surface"
              onPress={() => {
                void onSelect(suggestion);
              }}
            >
              <Text className="text-sm">
                <Text className="font-semibold text-ink">{suggestion.main_text}</Text>{" "}
                <Text className="text-ink-soft">{suggestion.secondary_text}</Text>
              </Text>
            </Pressable>
          ))}
          {/* Required attribution when predictions are shown without a map. */}
          <View className="border-t border-line px-3 py-1.5">
            <Text className="text-right text-[10px] text-ink-soft">powered by Google</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

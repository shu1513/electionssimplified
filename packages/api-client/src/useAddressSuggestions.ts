import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "./client";
import type { AddressAutocompleteResponse, AddressLocation, AddressRetrieveResponse, AddressSuggestion } from "./types";

// Autocomplete state machine per docs/address-autocomplete-frontend.md:
// - fresh crypto.randomUUID() session token at the first keystroke that
//   triggers a suggest call; the SAME token on every suggest and the final
//   retrieve; token dies after a retrieve or when the entry is abandoned.
// - leading-edge fire: the first suggest of an entry (no live session token)
//   goes out immediately; subsequent keystrokes debounce. 3-char minimum,
//   in-flight requests aborted when a new one fires, out-of-order responses
//   ignored.
// - warmup(): call on input focus; fires one throwaway invalid request so the
//   TLS handshake, CORS preflight cache, and backend are warm before the
//   first real keystroke. The server 400s it before touching Google.
// - Any failure hides the dropdown and never blocks manual entry; the
//   "not configured" 500 disables autocomplete for the session.

export const SUGGEST_DEBOUNCE_MS = 125;
export const SUGGEST_MIN_CHARS = 3;

export type SelectedSuggestion = {
  address: string;
  location: AddressLocation | null;
  /** Server-side classification (see AddressRetrieveResponse); a stale API
   * omitting it reads as "address", matching its old behavior. */
  granularity: "address" | "zip" | "region";
  /** Five-digit ZIP when granularity is "zip", or for a "region" street
   * pick that names one (feeds resolve's region_postal_code); null
   * otherwise. */
  postal_code: string | null;
  /** Two-letter state for "region" selections when the server named one;
   * null otherwise. Feeds resolve's region_state. */
  state: string | null;
  /** Locality name for "region" selections when the server named one; null
   * otherwise. Feeds resolve's region_locality. */
  locality: string | null;
};

export type UseAddressSuggestionsResult = {
  suggestions: AddressSuggestion[];
  /** False once the backend reports autocomplete is not configured. */
  enabled: boolean;
  onInputChanged: (text: string) => void;
  /** Resolves to the full address (plus the place's coordinates when Google
   * provides them) and the server's granularity classification, or null when
   * retrieve failed or was superseded by newer typing or another selection. */
  selectSuggestion: (suggestion: AddressSuggestion) => Promise<SelectedSuggestion | null>;
  clearSuggestions: () => void;
  /** Call on input focus: warms connections before the first keystroke. */
  warmup: () => void;
};

export function useAddressSuggestions(): UseAddressSuggestionsResult {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [enabled, setEnabled] = useState(true);
  const sessionTokenRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);
  const enabledRef = useRef(true);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      abortRef.current?.abort();
    };
  }, []);

  const fireSuggest = useCallback(async (input: string) => {
    // Google Places autocomplete session token: groups suggest+retrieve
    // calls for billing. Uniqueness matters, cryptographic strength does not.
    // React Native's Hermes has no crypto.randomUUID — the mobile app must
    // polyfill it at startup (expo-crypto's Crypto.randomUUID), the standard
    // Expo approach. Web and Node 19+ provide it natively.
    sessionTokenRef.current ??= crypto.randomUUID();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++requestSeqRef.current;
    try {
      const response = await apiRequest<AddressAutocompleteResponse>("/api/address/autocomplete", {
        method: "POST",
        body: { input, session_token: sessionTokenRef.current },
        signal: controller.signal,
      });
      if (seq === requestSeqRef.current) {
        // Defensive: the contract above says autocomplete failing must never
        // block the form — that includes a malformed 200 whose body lacks a
        // suggestions array, which would otherwise crash the page at
        // suggestions.length.
        setSuggestions(Array.isArray(response.suggestions) ? response.suggestions : []);
      }
    } catch (error) {
      if (seq !== requestSeqRef.current) {
        return; // Superseded; newer request owns the state.
      }
      setSuggestions([]);
      if (error instanceof ApiError && error.status === 500) {
        // "Address autocomplete is not configured" — hide the feature
        // entirely and fall back to plain input for the session.
        enabledRef.current = false;
        setEnabled(false);
      }
      // Every other failure (429, 5xx, network, abort-timeout): no dropdown,
      // user keeps typing.
    }
  }, []);

  const onInputChanged = useCallback(
    (text: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        // Entry abandoned: the session is dead; the next entry gets a fresh
        // token.
        sessionTokenRef.current = null;
      }
      if (!enabledRef.current || trimmed.length < SUGGEST_MIN_CHARS) {
        abortRef.current?.abort();
        requestSeqRef.current += 1;
        setSuggestions([]);
        return;
      }
      if (sessionTokenRef.current === null) {
        // Leading edge: the first suggest of an entry fires immediately (also
        // covers pasting a full address). fireSuggest sets the session token
        // synchronously, so the next keystroke takes the debounced path.
        void fireSuggest(trimmed);
        return;
      }
      debounceRef.current = setTimeout(() => {
        void fireSuggest(trimmed);
      }, SUGGEST_DEBOUNCE_MS);
    },
    [fireSuggest]
  );

  const warmupFiredRef = useRef(false);
  const warmup = useCallback(() => {
    if (warmupFiredRef.current || !enabledRef.current) {
      return;
    }
    warmupFiredRef.current = true;
    // Fire-and-forget throwaway request: the empty input fails validation, so
    // the server 400s before touching Google — no billable call, no session
    // token. What it buys: the TLS handshake, the CORS preflight cache entry
    // for this URL, and a warm backend, all before the first real suggest.
    // The not-configured 500 arrives before body validation, so this also
    // disables the dropdown for the session one focus earlier.
    void apiRequest("/api/address/autocomplete", {
      method: "POST",
      body: { input: "", session_token: "" },
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 500) {
        enabledRef.current = false;
        setEnabled(false);
      }
    });
  }, []);

  const selectSuggestion = useCallback(async (
    suggestion: AddressSuggestion
  ): Promise<SelectedSuggestion | null> => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    abortRef.current?.abort();
    const seq = ++requestSeqRef.current;
    const sessionToken = sessionTokenRef.current;
    setSuggestions([]);
    if (!sessionToken) {
      return null;
    }
    // Billing-relevant: the session ends the moment the final retrieve is
    // issued. Clear BEFORE awaiting so typing during the in-flight retrieve
    // starts a fresh session instead of reusing the spent token (the local
    // sessionToken copy still rides on the retrieve request).
    sessionTokenRef.current = null;
    // Abortable like the suggests: a keystroke supersedes the result anyway
    // (the seq check below), and without an abort the caller's
    // retrieve-pending state would hold Search hostage for the full network
    // round trip on a slow link. Aborting the HTTP request changes nothing
    // server-side.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await apiRequest<AddressRetrieveResponse>("/api/address/autocomplete/retrieve", {
        method: "POST",
        body: { place_id: suggestion.place_id, session_token: sessionToken },
        signal: controller.signal,
      });
      if (seq !== requestSeqRef.current) {
        // Superseded while in flight — the user typed or selected again
        // (both bump the sequence synchronously), so applying this result
        // would revert their newer input and carry its coordinates into
        // district resolution. Drop it.
        return null;
      }
      const granularity =
        response.granularity === "zip" || response.granularity === "region" ? response.granularity : "address";
      return {
        address: response.address,
        // Belt and braces on top of the server's fail-closed rule: a coarse
        // place's point must never ride into district resolution.
        location: granularity === "address" ? (response.location ?? null) : null,
        granularity,
        postal_code:
          granularity !== "address" && typeof response.postal_code === "string" ? response.postal_code : null,
        state: granularity === "region" && typeof response.state === "string" ? response.state : null,
        locality: granularity === "region" && typeof response.locality === "string" ? response.locality : null,
      };
    } catch {
      // Retrieve failed; the user still has their typed text and can submit
      // it manually. The token stays dead either way — the session state is
      // indeterminate and a fresh session costs nothing.
      return null;
    }
  }, []);

  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
  }, []);

  return { suggestions, enabled, onInputChanged, selectSuggestion, clearSuggestions, warmup };
}

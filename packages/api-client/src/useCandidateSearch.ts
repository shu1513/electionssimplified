import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "./client";
import type { CandidateSearchMatch, CandidateSearchResponse } from "./types";

// Candidate-name typeahead against GET /api/candidates/search. Same debounce
// machinery as useAddressSuggestions minus the Places session token (nothing
// billing-related here): in-flight requests aborted when a new one fires,
// out-of-order responses ignored, any failure just hides the dropdown.

export const CANDIDATE_SEARCH_DEBOUNCE_MS = 275;
export const CANDIDATE_SEARCH_MIN_CHARS = 2;

export type UseCandidateSearchResult = {
  matches: CandidateSearchMatch[];
  onInputChanged: (text: string) => void;
  clearMatches: () => void;
};

/** `districtIds`: the caller's ballot — candidates running there rank first. */
export function useCandidateSearch(districtIds: readonly string[] = []): UseCandidateSearchResult {
  const [matches, setMatches] = useState<CandidateSearchMatch[]>([]);
  // A ref, not a dependency: the ids only steer ranking, so a changed list
  // applies from the next keystroke without rebuilding the callbacks.
  const districtParamRef = useRef("");
  districtParamRef.current =
    districtIds.length > 0 ? `&district_ids=${encodeURIComponent(districtIds.join(","))}` : "";
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      abortRef.current?.abort();
    };
  }, []);

  const fireSearch = useCallback(async (input: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++requestSeqRef.current;
    try {
      const response = await apiRequest<CandidateSearchResponse>(
        `/api/candidates/search?q=${encodeURIComponent(input)}${districtParamRef.current}`,
        { signal: controller.signal }
      );
      if (seq === requestSeqRef.current) {
        setMatches(response.candidates);
      }
    } catch {
      if (seq !== requestSeqRef.current) {
        return; // Superseded; newer request owns the state.
      }
      // Any failure (429, 5xx, network, abort-timeout): no dropdown, the
      // user keeps typing and the follows filter still works.
      setMatches([]);
    }
  }, []);

  const onInputChanged = useCallback(
    (text: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      // Every keystroke invalidates whatever is in flight AND whatever is on
      // screen: a request for the previous text must not resolve into the
      // dropdown, and already-loaded suggestions for the previous text must
      // not stay selectable under an input they no longer match. The dropdown
      // simply stays closed until results for the current text land.
      abortRef.current?.abort();
      requestSeqRef.current += 1;
      setMatches([]);
      const trimmed = text.trim();
      if (trimmed.length < CANDIDATE_SEARCH_MIN_CHARS) {
        return;
      }
      debounceRef.current = setTimeout(() => {
        void fireSearch(trimmed);
      }, CANDIDATE_SEARCH_DEBOUNCE_MS);
    },
    [fireSearch]
  );

  const clearMatches = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    abortRef.current?.abort();
    requestSeqRef.current += 1;
    setMatches([]);
  }, []);

  return { matches, onInputChanged, clearMatches };
}

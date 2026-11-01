import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { toPreferenceInputs, type RankedResearchArea } from "./rankedResearchAreas";
import type { ResearchAreaPreferencesResult } from "./types";

/** Every full-list replace of the ranked issues shares this key, so the
 * in-flight guards of the settings editor, the welcome step, and the
 * "add these issues" prompt all see each other. */
export const RESEARCH_AREA_PREFERENCES_MUTATION_KEY = ["put-research-area-preferences"] as const;

/**
 * PUT /api/me/research-area-preferences with a complete ranked list (list
 * position = rank). Writes the saved list straight into the preferences
 * cache and refetches what is sorted or defaulted by it: the saved ballot
 * (server-sorted by my_areas) and the ballot-preferences default, which can
 * flip to my_areas on the first saved area.
 */
export function useReplaceResearchAreaPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...RESEARCH_AREA_PREFERENCES_MUTATION_KEY],
    mutationFn: (ranked: RankedResearchArea[]) =>
      apiRequest<ResearchAreaPreferencesResult>("/api/me/research-area-preferences", {
        method: "PUT",
        body: { preferences: toPreferenceInputs(ranked) },
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["me", "research-area-preferences"], saved);
      void queryClient.invalidateQueries({ queryKey: ["me", "ballot"] });
      void queryClient.invalidateQueries({ queryKey: ["me", "ballot-preferences"] });
    },
  });
}

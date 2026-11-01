import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import type { ResearchAreaPreference, ResearchAreaPreferencesResult } from "./types";
import { useMe } from "./useMe";
import { buildResearchAreaWeights, type ResearchAreaWeight } from "./researchAreaScoring";

/**
 * The session holder's saved research areas, shaped for personalization:
 * membership checks (highlighting) and weights (client-side sorts). Shares
 * the query key with the settings editor so both views stay in sync, and is
 * only fetched for verified users — the endpoint is verified-email-gated,
 * and anonymous visitors get the un-personalized experience.
 */
export function useMyResearchAreas(): {
  preferences: ResearchAreaPreference[];
  savedAreaIds: Set<string>;
  weights: Map<string, ResearchAreaWeight>;
  hasSaved: boolean;
  isLoading: boolean;
  /** The preferences fetch itself failed (never true for anonymous or
   * unverified viewers — their query is disabled). Consumers that gate a
   * flow on "how many issues are saved" must not read an errored empty
   * list as "the user saved nothing". */
  isError: boolean;
  /** Re-runs the preferences fetch (a retry affordance after isError). */
  refetch: () => void;
} {
  const { me, isLoading: meLoading } = useMe();
  const enabled = me?.email_verified === true;
  const query = useQuery({
    queryKey: ["me", "research-area-preferences"],
    queryFn: () => apiRequest<ResearchAreaPreferencesResult>("/api/me/research-area-preferences"),
    enabled,
    staleTime: 60_000,
  });

  const preferences = query.data?.preferences ?? [];
  return {
    preferences,
    savedAreaIds: new Set(preferences.map((preference) => preference.research_area_id)),
    weights: buildResearchAreaWeights(preferences),
    hasSaved: preferences.length > 0,
    // True only while "does the viewer have saved areas?" is not yet
    // knowable: the identity lookup, then (for verified users) the
    // preferences fetch. Settles false on every terminal state INCLUDING
    // failures — a failed fetch falls back to the un-personalized
    // experience rather than pending forever, so consumers that withhold
    // personalized views on this flag (the ballot "Only my issues" filter)
    // fail open instead of spinning.
    isLoading: enabled ? query.isPending : meLoading,
    isError: enabled ? query.isError : false,
    refetch: () => {
      void query.refetch();
    },
  };
}

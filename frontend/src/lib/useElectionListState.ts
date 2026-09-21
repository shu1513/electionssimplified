import { useLocation, useNavigate } from "react-router";
import { readElectionListState, type ElectionListState } from "./detailNavContext";
import { useHydrated } from "./useHydrated";

/** Remember disclosures for list → election → list navigation only. */
export function useElectionListState() {
  const location = useLocation();
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const listState = hydrated ? readElectionListState(location.state) : undefined;
  const expandedRetentionDates = listState?.expandedRetentionDates ?? [];
  const collapsedVotePowerGroups = listState?.collapsedVotePowerGroups ?? [];
  const updateState = (changes: Partial<ElectionListState>) => {
    // Replace this list entry so browser Back restores it too; no new
    // history step or scroll reset just for opening or closing a group.
    void navigate(location.pathname + location.search + location.hash, {
      replace: true,
      preventScrollReset: true,
      state: { ...location.state, expandedRetentionDates, ...changes },
    });
  };
  const setRetentionOpen = (date: string, open: boolean) => {
    const dates = expandedRetentionDates.filter((entry) => entry !== date);
    if (open) dates.push(date);
    updateState({ expandedRetentionDates: dates });
  };
  const setVotePowerOpen = (key: string, open: boolean) => {
    const groups = collapsedVotePowerGroups.filter((entry) => entry !== key);
    if (!open) groups.push(key);
    updateState({ collapsedVotePowerGroups: groups });
  };
  const awaitingCandidatesOpen = listState?.awaitingCandidatesOpen ?? false;
  const setAwaitingCandidatesOpen = (open: boolean) => updateState({ awaitingCandidatesOpen: open });
  return {
    listState,
    expandedRetentionDates,
    setRetentionOpen,
    collapsedVotePowerGroups,
    setVotePowerOpen,
    awaitingCandidatesOpen,
    setAwaitingCandidatesOpen,
  };
}

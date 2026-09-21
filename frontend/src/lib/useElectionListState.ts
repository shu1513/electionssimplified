import { useLocation, useNavigate } from "react-router";
import { readElectionListState, type ElectionListState } from "./detailNavContext";
import { useEmbedSession } from "./embedSession";
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
  // Sections the reader never touched take the page's default: open on the
  // site, closed inside the newsroom box (it is small, and a long ballot
  // would bury everything below the first section). Whatever the reader
  // opens or closes is kept either way, so a round trip to a race or a
  // candidate comes back to the list as they left it.
  const sectionsStartOpen = !useEmbedSession();
  const sectionOpen = listState?.sectionOpen ?? {};
  const isSectionOpen = (key: string) =>
    sectionOpen[key] ?? (collapsedVotePowerGroups.includes(key) ? false : sectionsStartOpen);
  const setSectionOpen = (key: string, open: boolean) => {
    updateState({ sectionOpen: { ...sectionOpen, [key]: open } });
  };
  const setVotePowerOpen = (key: string, open: boolean) => {
    const groups = collapsedVotePowerGroups.filter((entry) => entry !== key);
    if (!open) groups.push(key);
    updateState({ collapsedVotePowerGroups: groups, sectionOpen: { ...sectionOpen, [key]: open } });
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
    isSectionOpen,
    setSectionOpen,
  };
}

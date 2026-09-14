import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { clearBallotDraft } from "./ballotDraft";
import { useGuestDraftNav } from "./usePickProgress";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  clearBallotDraft();
});
afterEach(() => { clearBallotDraft(); vi.useRealTimers(); });

it.each([{ election_ids: ["mayor"] }, { election_ids: [] }])("does not count retention-only answers in the guest fallback badge (counted=$election_ids)", ({ election_ids }) => {
  window.localStorage.setItem("voteapp_ballot_draft", JSON.stringify({
    v: 1, district_ids: ["dddddddd-1111-4111-8111-111111111111"],
    target: { election_date: "2026-11-03", election_ids, retention_ids: ["r-1", "r-2"] },
    choices: { "r-1": { election_id: "r-1", race_type: "office", official_ballot_title: "Shall Judge A be retained?",
      election_date: "2026-11-03", seats_to_fill: null, picks: [], measure_position: "yes", updated_at: "2026-08-01" } },
  }));
  window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
  const { result } = renderHook(() => useGuestDraftNav());
  expect(result.current).toEqual({ to: "/draft", label: "My Draft", complete: false });
});

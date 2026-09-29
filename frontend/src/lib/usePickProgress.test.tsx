import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { clearBallotDraft } from "./ballotDraft";
import { useDraftPulse, useGuestDraftNav } from "./usePickProgress";

it("pulses the draft counter only when the picked count rises", () => {
  const { result, rerender } = renderHook(({ picked }: { picked: number | null }) => useDraftPulse(picked), {
    initialProps: { picked: null as number | null },
  });
  // First number is the baseline, not a rise.
  rerender({ picked: 3 });
  expect(result.current).toBe(0);
  rerender({ picked: 4 });
  expect(result.current).toBe(1);
  // A refetch gap keeps the baseline; a removal never pulses.
  rerender({ picked: null });
  rerender({ picked: 4 });
  expect(result.current).toBe(1);
  rerender({ picked: 3 });
  expect(result.current).toBe(1);
  rerender({ picked: 5 });
  expect(result.current).toBe(2);
});

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
  // A contested race gives a 0/1 goal; a retention-only day has no
  // denominator, so the label stays plain rather than counting the answer.
  const label = election_ids.length > 0 ? "My Draft 0/1" : "My Draft";
  expect(result.current).toEqual({ to: "/draft", label, complete: false });
});

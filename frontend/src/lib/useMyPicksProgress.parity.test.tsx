import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { myDraftLabel, type ElectionChoice } from "@voteapp/api-client";
import { useMyPicksProgress as useWebProgress } from "./usePickProgress";
import { useMyPicksProgress as useMobileProgress } from "../../../mobile/src/lib/useMyPicksProgress";
import { renderRoutes } from "../test/render";
import { stubApiRoutes } from "../test/mockApi";
import { ballotSummary, electionSummary, retentionElection, ME_VERIFIED } from "../test/fixtures";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function ProgressLabels() {
  const web = useWebProgress();
  const mobile = useMobileProgress();
  return <>
    <output aria-label="Web draft">{myDraftLabel(web)}</output>
    <output aria-label="Mobile draft">{myDraftLabel(mobile)}</output>
    <output aria-label="Same progress">{JSON.stringify(web) === JSON.stringify(mobile) ? "yes" : "no"}</output>
  </>;
}

it("keeps actual web and mobile header hooks aligned as picks and the ballot change", async () => {
  const elections = [electionSummary({ id: "mayor" }), electionSummary({ id: "governor" }),
    retentionElection("r1"), retentionElection("r2")];
  const makeChoice = (id: string): ElectionChoice => ({
    election_id: id, election_date: "2026-11-03", race_type: "office", official_ballot_title: id,
    seats_to_fill: null,
    picks: id.startsWith("r") ? [] : [{ candidate_id: `c-${id}`, display_name: "Jane Smith", candidacy_status: "declared" }],
    measure_position: id.startsWith("r") ? "yes" : null, updated_at: "2026-08-01",
  });
  const picks = [makeChoice("mayor")];
  stubApiRoutes({
    "/api/me": { body: ME_VERIFIED },
    "/api/me/ballot": { body: ballotSummary(elections) },
    "/api/me/election-choices": { body: { choices: picks } },
  });
  const { queryClient } = renderRoutes([{ path: "/", element: <ProgressLabels /> }]);
  const expectLabels = async (label: string) => {
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Web draft" })).toHaveTextContent(label);
      expect(screen.getByRole("status", { name: "Mobile draft" })).toHaveTextContent(label);
      expect(screen.getByRole("status", { name: "Same progress" })).toHaveTextContent("yes");
    });
  };
  await expectLabels("My Draft 1/2");
  await act(async () => { queryClient.setQueryData(["me", "election-choices"], { choices: [...picks, makeChoice("r1")] }); });
  await expectLabels("My Draft 1/2");
  await act(async () => {
    queryClient.setQueryData(["me", "election-choices"], { choices: [...picks, makeChoice("governor")] });
  });
  await expectLabels("My Draft ✓");
  await act(async () => {
    const retentionOnly = ballotSummary(elections.slice(2));
    queryClient.setQueryData(["me", "ballot", "preview"], retentionOnly);
    queryClient.setQueryData(["me", "ballot", "picks"], retentionOnly);
  });
  await expectLabels("My Draft");
  expect(screen.getByRole("status", { name: "Web draft" }).textContent).toBe("My Draft");
  expect(screen.getByRole("status", { name: "Mobile draft" }).textContent).toBe("My Draft");
});

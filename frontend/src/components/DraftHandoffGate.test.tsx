import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import type { ElectionChoice } from "@voteapp/api-client";
import { ME_UNVERIFIED, ME_VERIFIED } from "../test/fixtures";
import {
  clearBallotDraft,
  draftHandoffFragment,
  draftPickCount,
  readBallotDraft,
  setDraftBallotContext,
  setDraftCandidateChoice,
} from "../lib/ballotDraft";
import { readPendingDistrictIds, clearPendingDistrictIds } from "../lib/pendingDistricts";
import { DraftHandoffGate } from "./DraftHandoffGate";

function electionChoice(overrides: Partial<ElectionChoice> = {}): ElectionChoice {
  return {
    election_id: "e-1",
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2099-11-03",
    seats_to_fill: null,
    picks: [{ candidate_id: "c-9", display_name: "Jane Smith", candidacy_status: "declared" }],
    measure_position: null,
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const E1 = "eeeeeeee-1111-4111-8111-111111111111";
const E2 = "eeeeeeee-2222-4222-8222-222222222222";
const DISTRICT = "dddddddd-1111-4111-8111-111111111111";

/** A fragment as the box's Save link builds it: two picks and an exact ballot. */
function boxFragment(): string {
  for (const [electionId, candidateId] of [[E1, "c1"], [E2, "c2"]] as const) {
    setDraftCandidateChoice({
      electionId,
      raceTitle: "Race",
      electionDate: "2099-11-03",
      seatsToFill: null,
      candidateId,
      candidateName: "Jordan Voter",
      chosen: true,
    });
  }
  const fragment = draftHandoffFragment(readBallotDraft(), [DISTRICT]);
  clearBallotDraft();
  return fragment;
}

function arrive(fragment: string) {
  return renderRoutes(
    [{ path: "/register", element: <DraftHandoffGate /> }],
    { pathname: "/register", search: "?next=%2Fdraft", ...({ hash: fragment } as object) }
  );
}

beforeEach(() => {
  clearBallotDraft();
  clearPendingDistrictIds();
  sessionStorage.removeItem("voteapp_pending_handoff");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DraftHandoffGate", () => {
  it("adds a guest's picks to this browser's draft, arms the district handoff, and clears the fragment", async () => {
    const fragment = boxFragment();
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    const { router } = arrive(fragment);

    await waitFor(() => expect(draftPickCount(readBallotDraft())).toBe(2));
    expect(readPendingDistrictIds()).toEqual([DISTRICT]);
    expect(router.state.location.hash).toBe("");
    expect(router.state.location.search).toBe("?next=%2Fdraft");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a guest's own ballot, and then does not arm the account handoff with the incoming one", async () => {
    const fragment = boxFragment();
    const own = "cccccccc-3333-4333-8333-333333333333";
    setDraftBallotContext([own], null);
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    arrive(fragment);

    await waitFor(() => expect(draftPickCount(readBallotDraft())).toBe(2));
    expect(readBallotDraft().district_ids).toEqual([own]);
    expect(readPendingDistrictIds()).toEqual([]);
  });

  it("asks an unverified signed-in reader too: any signed-in account can save picks", async () => {
    const fragment = boxFragment();
    stubApiRoutes({
      "/api/me": { body: ME_UNVERIFIED },
      "/api/me/election-choices": { body: { choices: [] } },
    });
    arrive(fragment);

    expect(await screen.findByRole("dialog")).toHaveTextContent("You made 2 picks on another website.");
    expect(draftPickCount(readBallotDraft())).toBe(0);
  });

  it("says so and offers a retry when the account's picks cannot be loaded, and survives a reload", async () => {
    const fragment = boxFragment();
    let fail = true;
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/election-choices": () => (fail ? apiError(500, "server_error", "boom") : { body: { choices: [] } }),
    });
    const first = arrive(fragment);

    expect(await screen.findByRole("dialog", {}, { timeout: 4000 })).toHaveTextContent("we could not check your account");
    // The fragment is gone from the URL, but the picks are not lost with it.
    expect(first.router.state.location.hash).toBe("");
    first.unmount();

    // A reload: no fragment this time.
    fail = false;
    renderRoutes([{ path: "/register", element: <DraftHandoffGate /> }], "/register");
    expect(await screen.findByRole("dialog", {}, { timeout: 4000 })).toHaveTextContent("You made 2 picks on another website.");

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sessionStorage.getItem("voteapp_pending_handoff")).toBeNull();
  });

  it("asks a signed-in reader first, then adds only the races their account has not decided", async () => {
    const fragment = boxFragment();
    const puts: unknown[] = [];
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      // The account already has a pick for E1.
      "/api/me/election-choices": (_url: URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          puts.push(JSON.parse(String(init.body)));
          return { body: {} };
        }
        return { body: { choices: [electionChoice({ election_id: E1 })] } };
      },
    });
    const { router } = arrive(fragment);

    expect(await screen.findByRole("dialog")).toHaveTextContent("You made 1 pick on another website. Add it to your account?");
    expect(router.state.location.hash).toBe("");
    // Nothing is written before the reader answers.
    expect(puts).toEqual([]);
    expect(draftPickCount(readBallotDraft())).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "Add picks" }));
    await waitFor(() => expect(puts).toEqual([{ election_id: E2, candidate_id: "c2", chosen: true }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("drops the picks when a signed-in reader says not now", async () => {
    const fragment = boxFragment();
    const puts: unknown[] = [];
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/election-choices": (_url: URL, init?: RequestInit) => {
        if (init?.method === "PUT") puts.push(init.body);
        return { body: { choices: [] } };
      },
    });
    arrive(fragment);

    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(puts).toEqual([]);
    expect(draftPickCount(readBallotDraft())).toBe(0);
  });
});

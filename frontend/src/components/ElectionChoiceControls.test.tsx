import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectionChoice, Me } from "@voteapp/api-client";
import {
  CandidatePickButton,
  CandidatePickRow,
  MeasureChoiceButtons,
  RemoveStrandedPickButton,
  StrandedPicksNotice,
} from "./ElectionChoiceControls";
import { clearBallotDraft, readBallotDraft, setDraftCandidateChoice } from "../lib/ballotDraft";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { renderRoutes } from "../test/render";

// The controls fork on the session (signed-in → PUT, guest → local draft),
// and renderRoutes builds its own QueryClient with nothing seeded — a real
// useMe would leave `me` undefined (loading) for the whole test. Mocking it
// pins the fork deterministically per test.
const SIGNED_IN: Me = {
  id: "user-1",
  email: "voter@example.com",
  first_name: "Vo",
  email_verified: true,
  accepted_terms_version: null,
  has_password: true,
};
let mockMe: Me | null | undefined = SIGNED_IN;
vi.mock("@voteapp/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@voteapp/api-client")>();
  return {
    ...actual,
    useMe: () => ({ me: mockMe, isLoading: false, isError: false, refetch: vi.fn() }),
  };
});

beforeEach(() => {
  mockMe = SIGNED_IN;
  window.localStorage.clear();
  clearBallotDraft();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ELECTION_ID = "33333333-3333-4333-8333-333333333333";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CANDIDATE_ID = "44444444-4444-4444-8444-444444444444";

function choice(overrides: Partial<ElectionChoice> = {}): ElectionChoice {
  return {
    election_id: ELECTION_ID,
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    seats_to_fill: null,
    picks: [],
    measure_position: null,
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function pick(candidateId: string) {
  return { candidate_id: candidateId, display_name: "Someone", candidacy_status: "declared" };
}

// The controls mutate through react-query, so they render via renderRoutes
// (which supplies the QueryClient); choice state itself arrives as a prop.
function renderControl(element: React.ReactElement) {
  return renderRoutes([{ path: "/", element }], "/");
}

describe("CandidatePickButton", () => {
  it("PUTs a pick and toggles off with chosen: false", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me/election-choices": (_url, init) => {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({
          election_id: ELECTION_ID,
          candidate_id: CANDIDATE_ID,
          chosen: true,
        });
        return { status: 200, body: { choice: choice({ picks: [pick(CANDIDATE_ID)] }) } };
      },
    });

    renderControl(
      <CandidatePickButton electionId={ELECTION_ID} candidateId={CANDIDATE_ID} candidateName="Jane Doe" raceTitle="Governor" electionDate="2026-11-03" choice={undefined} seatsToFill={null} />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Make my pick: Jane Doe" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("fires onPicked once the PUT resolves", async () => {
    let resolvePut: (() => void) | null = null;
    stubApiRoutes({
      "/api/me/election-choices": () =>
        new Promise<{ status: number; body: unknown }>((resolve) => {
          resolvePut = () => resolve({ status: 200, body: { choice: choice({ picks: [pick(CANDIDATE_ID)] }) } });
        }),
    });
    const onPicked = vi.fn();
    renderControl(
      <CandidatePickButton electionId={ELECTION_ID} candidateId={CANDIDATE_ID} candidateName="Jane Doe" raceTitle="Governor" electionDate="2026-11-03" choice={undefined} seatsToFill={null} onPicked={onPicked} />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Make my pick: Jane Doe" }));
    // In flight: nothing to confirm yet.
    await waitFor(() => expect(resolvePut).not.toBeNull());
    expect(onPicked).not.toHaveBeenCalled();
    resolvePut!();
    await waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1));
  });

  it("does not fire onPicked on a removal", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me/election-choices": () => ({ status: 200, body: { choice: choice() } }),
    });
    const onPicked = vi.fn();
    renderControl(
      <CandidatePickButton electionId={ELECTION_ID} candidateId={CANDIDATE_ID} candidateName="Jane Doe" raceTitle="Governor" electionDate="2026-11-03" choice={choice({ picks: [pick(CANDIDATE_ID)] })} seatsToFill={null} onPicked={onPicked} />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "✓ My pick: Jane Doe" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "✓ My pick: Jane Doe" })).toBeEnabled());
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("does not fire onPicked on a rejected save", async () => {
    stubApiRoutes({
      "/api/me/election-choices": apiError(400, "election_closed", "Choices can only be changed for upcoming elections"),
    });
    const onPicked = vi.fn();
    renderControl(
      <CandidatePickButton electionId={ELECTION_ID} candidateId={CANDIDATE_ID} candidateName="Jane Doe" raceTitle="Governor" electionDate="2026-11-03" choice={undefined} seatsToFill={null} onPicked={onPicked} />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Make my pick: Jane Doe" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("fires onPicked on a guest draft pick, synchronously", async () => {
    mockMe = null;
    const onPicked = vi.fn();
    renderControl(
      <CandidatePickButton electionId={ELECTION_ID} candidateId={CANDIDATE_ID} candidateName="Jane Doe" raceTitle="Governor" electionDate="2026-11-03" choice={undefined} seatsToFill={null} onPicked={onPicked} />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Make my pick: Jane Doe" }));
    expect(onPicked).toHaveBeenCalledTimes(1);
    expect(readBallotDraft().choices[ELECTION_ID].picks.map((p) => p.candidate_id)).toEqual([CANDIDATE_ID]);
  });

  it("renders as picked and unpicks with chosen: false", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me/election-choices": (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          election_id: ELECTION_ID,
          candidate_id: CANDIDATE_ID,
          chosen: false,
        });
        return { status: 200, body: { choice: choice() } };
      },
    });

    renderControl(
      <CandidatePickButton
        electionId={ELECTION_ID}
        candidateId={CANDIDATE_ID}
        candidateName="Jane Doe"
        raceTitle="Governor"
        electionDate="2026-11-03"
        choice={choice({ picks: [pick(CANDIDATE_ID)] })}
        seatsToFill={null}
      />
    );

    const button = screen.getByRole("button", { name: "✓ My pick: Jane Doe" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    await userEvent.setup().click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("disables an unpicked button at the multi-seat cap, with the reason in the tooltip", () => {
    stubApiRoutes({});
    renderControl(
      <CandidatePickButton
        electionId={ELECTION_ID}
        candidateId={CANDIDATE_ID}
        candidateName="Jane Doe"
        raceTitle="Governor"
        electionDate="2026-11-03"
        choice={choice({ seats_to_fill: 2, picks: [pick(OTHER_CANDIDATE_ID), pick("55555555-5555-4555-8555-555555555555")] })}
        seatsToFill={2}
      />
    );

    const button = screen.getByRole("button", { name: "Make my pick: Jane Doe" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "This election fills 2 seats — remove a pick first");
  });

  it("shows the cap reason as visible text in fullWidth mode (the page's only pick control)", () => {
    stubApiRoutes({});
    renderControl(
      <CandidatePickButton
        electionId={ELECTION_ID}
        candidateId={CANDIDATE_ID}
        candidateName="Jane Doe"
        raceTitle="Governor"
        electionDate="2026-11-03"
        choice={choice({ seats_to_fill: 2, picks: [pick(OTHER_CANDIDATE_ID), pick("55555555-5555-4555-8555-555555555555")] })}
        seatsToFill={2}
        fullWidth
      />
    );

    // Standalone the tooltip is not enough: a disabled button never gets
    // focus and touch has no hover, so the reason renders as visible text
    // and doubles as the accessible description.
    const button = screen.getByRole("button", { name: "Make my pick: Jane Doe" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("title");
    const message = screen.getByText("This election fills 2 seats — remove a pick first");
    expect(button).toHaveAttribute("aria-describedby", message.id);
  });

  it("keeps a single-seat button enabled when another candidate holds the pick (radio replace)", () => {
    stubApiRoutes({});
    renderControl(
      <CandidatePickButton
        electionId={ELECTION_ID}
        candidateId={CANDIDATE_ID}
        candidateName="Jane Doe"
        raceTitle="Governor"
        electionDate="2026-11-03"
        choice={choice({ picks: [pick(OTHER_CANDIDATE_ID)] })}
        seatsToFill={null}
      />
    );

    expect(screen.getByRole("button", { name: "Make my pick: Jane Doe" })).toBeEnabled();
  });

  it("shows the backend's rejection message inline", async () => {
    stubApiRoutes({
      "/api/me/election-choices": apiError(
        400,
        "invalid_request",
        "Choices can only be changed for upcoming elections"
      ),
    });

    renderControl(
      <CandidatePickButton electionId={ELECTION_ID} candidateId={CANDIDATE_ID} candidateName="Jane Doe" raceTitle="Governor" electionDate="2026-11-03" choice={undefined} seatsToFill={null} />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Make my pick: Jane Doe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choices can only be changed for upcoming elections"
    );
  });
});

describe("CandidatePickRow", () => {
  function renderRow(rowChoice: ElectionChoice | undefined, seatsToFill: number | null = null) {
    return renderControl(
      <CandidatePickRow
        electionId={ELECTION_ID}
        candidateId={CANDIDATE_ID}
        candidateName="Jane Doe"
        raceName="Governor"
        dateLabel="November 3, 2026"
        electionDate="2026-11-03"
        choice={rowChoice}
        seatsToFill={seatsToFill}
      />
    );
  }

  it("reads as a sentence and PUTs a pick", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me/election-choices": (_url, init) => {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({
          election_id: ELECTION_ID,
          candidate_id: CANDIDATE_ID,
          chosen: true,
        });
        return { status: 200, body: { choice: choice({ picks: [pick(CANDIDATE_ID)] }) } };
      },
    });

    renderRow(undefined);

    const button = screen.getByRole("button", { name: "Make Jane Doe my pick for Governor · November 3, 2026" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await userEvent.setup().click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("renders the picked sentence and unpicks with chosen: false", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me/election-choices": (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          election_id: ELECTION_ID,
          candidate_id: CANDIDATE_ID,
          chosen: false,
        });
        return { status: 200, body: { choice: choice() } };
      },
    });

    renderRow(choice({ picks: [pick(CANDIDATE_ID)] }));

    const button = screen.getByRole("button", {
      name: "✓ Jane Doe is my pick for Governor · November 3, 2026",
    });
    expect(button).toHaveAttribute("aria-pressed", "true");
    await userEvent.setup().click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("disables an unpicked row at the multi-seat cap, with the reason visible below it", () => {
    stubApiRoutes({});
    renderRow(
      choice({
        seats_to_fill: 2,
        picks: [pick(OTHER_CANDIDATE_ID), pick("55555555-5555-4555-8555-555555555555")],
      }),
      2
    );

    const button = screen.getByRole("button", { name: "Make Jane Doe my pick for Governor · November 3, 2026" });
    expect(button).toBeDisabled();
    // The reason is visible text (title tooltips never reach touch/keyboard
    // users) and doubles as the button's accessible description.
    const message = screen.getByText("This election fills 2 seats — remove a pick first");
    expect(button).toHaveAttribute("aria-describedby", message.id);
  });

  it("shows no cap message when the row is picked or the cap isn't reached", () => {
    stubApiRoutes({});
    renderRow(choice({ seats_to_fill: 2, picks: [pick(CANDIDATE_ID), pick(OTHER_CANDIDATE_ID)] }), 2);

    expect(screen.queryByText(/fills 2 seats/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "✓ Jane Doe is my pick for Governor · November 3, 2026" })
    ).toBeEnabled();
  });

  it("shows the backend's rejection message inline", async () => {
    stubApiRoutes({
      "/api/me/election-choices": apiError(
        400,
        "invalid_request",
        "Choices can only be changed for upcoming elections"
      ),
    });

    renderRow(undefined);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Make Jane Doe my pick for Governor · November 3, 2026" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choices can only be changed for upcoming elections"
    );
  });
});

describe("MeasureChoiceButtons", () => {
  it("PUTs a yes position and clears it by re-clicking the active side", async () => {
    let call = 0;
    const fetchMock = stubApiRoutes({
      "/api/me/election-choices": (_url, init) => {
        call += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          election_id: ELECTION_ID,
          measure_position: call === 1 ? "yes" : null,
        });
        return {
          status: 200,
          body: { choice: choice({ race_type: "ballot_measure", measure_position: call === 1 ? "yes" : null }) },
        };
      },
    });

    // First render: no position. Click "Yes" → PUT yes.
    const { unmount } = renderControl(<MeasureChoiceButtons electionId={ELECTION_ID} raceTitle="Prop A" electionDate="2026-11-03" choice={undefined} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();

    // Re-render as yes-selected (state arrives via props). Click the active
    // side → PUT null (clear).
    renderControl(
      <MeasureChoiceButtons
        electionId={ELECTION_ID}
        raceTitle="Prop A"
        electionDate="2026-11-03"
        choice={choice({ race_type: "ballot_measure", measure_position: "yes" })}
      />
    );
    const yesButton = screen.getByRole("button", { name: "✓ Yes" });
    expect(yesButton).toHaveAttribute("aria-pressed", "true");
    await userEvent.setup().click(yesButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows transport failures with generic copy", async () => {
    // Network-level failure: fetch itself rejects, so no ApiError message
    // exists to pass through.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    renderControl(<MeasureChoiceButtons electionId={ELECTION_ID} raceTitle="Prop A" electionDate="2026-11-03" choice={undefined} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "No" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save — check your connection and try again."
    );
  });
});

function renderRemoveButton() {
  return renderControl(
    <RemoveStrandedPickButton
      electionId={ELECTION_ID}
      candidateId={CANDIDATE_ID}
      candidateName="Jane Doe"
      raceTitle="Governor"
      electionDate="2026-11-03"
      seatsToFill={2}
    />
  );
}

function renderNotice(picks: ElectionChoice["picks"], rosterIds: string[] = []) {
  return renderControl(
    <StrandedPicksNotice
      electionId={ELECTION_ID}
      choice={choice({ picks })}
      raceTitle="Governor"
      electionDate="2026-11-03"
      seatsToFill={2}
      rosterCandidateIds={new Set(rosterIds)}
    />
  );
}

describe("RemoveStrandedPickButton", () => {
  it("PUTs chosen: false for the stranded candidate", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me/election-choices": (_url, init) => {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({
          election_id: ELECTION_ID,
          candidate_id: CANDIDATE_ID,
          chosen: false,
        });
        return { status: 200, body: { choice: choice() } };
      },
    });

    renderRemoveButton();

    await userEvent.setup().click(screen.getByRole("button", { name: "Remove pick: Jane Doe" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("shows the API rejection under the button", async () => {
    stubApiRoutes({
      "/api/me/election-choices": () =>
        apiError(400, "election_closed", "Choices can only be changed for upcoming elections"),
    });

    renderRemoveButton();

    await userEvent.setup().click(screen.getByRole("button", { name: "Remove pick: Jane Doe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choices can only be changed for upcoming elections"
    );
  });

  it("removes a guest's pick from the local draft with no API call", async () => {
    mockMe = null;
    const fetchMock = stubApiRoutes({});
    setDraftCandidateChoice({
      electionId: ELECTION_ID,
      raceTitle: "Governor",
      electionDate: "2026-11-03",
      seatsToFill: 2,
      candidateId: CANDIDATE_ID,
      candidateName: "Jane Doe",
      chosen: true,
    });

    renderRemoveButton();

    await userEvent.setup().click(screen.getByRole("button", { name: "Remove pick: Jane Doe" }));
    expect(readBallotDraft().choices[ELECTION_ID]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("StrandedPicksNotice", () => {
  it("names each withdrawn pick with its own remove button, skipping active picks", () => {
    renderNotice([
      { candidate_id: CANDIDATE_ID, display_name: "Jane Doe", candidacy_status: "withdrawn" },
      { candidate_id: OTHER_CANDIDATE_ID, display_name: "John Roe", candidacy_status: "active" },
    ]);

    expect(screen.getByText(/Jane Doe/)).toBeInTheDocument();
    expect(screen.getByText(/withdrew from this race/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove pick: Jane Doe" })).toBeInTheDocument();
    expect(screen.queryByText(/John Roe/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove pick: John Roe" })).not.toBeInTheDocument();
  });

  it("renders nothing when no pick is withdrawn", () => {
    const { container } = renderNotice([pick(CANDIDATE_ID)]);
    expect(container).toBeEmptyDOMElement();
  });

  it("flags a guest pick missing from the roster, ignoring status", () => {
    // Guest draft rows are always stored "active", so status can't signal a
    // candidacy that left the race — roster absence is the guest's signal.
    mockMe = null;
    renderNotice(
      [
        { candidate_id: CANDIDATE_ID, display_name: "Jane Doe", candidacy_status: "active" },
        { candidate_id: OTHER_CANDIDATE_ID, display_name: "John Roe", candidacy_status: "active" },
      ],
      [OTHER_CANDIDATE_ID]
    );

    expect(screen.getByText(/is no longer listed in this race/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove pick: Jane Doe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove pick: John Roe" })).not.toBeInTheDocument();
  });

  it("renders nothing for a guest whose picks are all still rostered", () => {
    mockMe = null;
    const { container } = renderNotice(
      [{ candidate_id: CANDIDATE_ID, display_name: "Jane Doe", candidacy_status: "active" }],
      [CANDIDATE_ID]
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("guest mode (no session)", () => {
  it("writes a candidate pick to the local draft with no API call", async () => {
    mockMe = null;
    const fetchMock = stubApiRoutes({});

    renderControl(
      <CandidatePickButton electionId={ELECTION_ID} candidateId={CANDIDATE_ID} candidateName="Jane Doe" raceTitle="Governor" electionDate="2026-11-03" choice={undefined} seatsToFill={null} />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Make my pick: Jane Doe" }));
    const row = readBallotDraft().choices[ELECTION_ID];
    expect(row.picks).toEqual([
      { candidate_id: CANDIDATE_ID, display_name: "Jane Doe", candidacy_status: "active" },
    ]);
    expect(row.official_ballot_title).toBe("Governor");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes a measure position to the local draft with no API call", async () => {
    mockMe = null;
    const fetchMock = stubApiRoutes({});

    renderControl(<MeasureChoiceButtons electionId={ELECTION_ID} raceTitle="Prop A" electionDate="2026-11-03" choice={undefined} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "No" }));
    expect(readBallotDraft().choices[ELECTION_ID].measure_position).toBe("no");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

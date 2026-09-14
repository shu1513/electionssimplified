import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ElectionChoice } from "@voteapp/api-client";
import { App } from "../App";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ballotSummary, electionSummary, retentionElection, ME_VERIFIED } from "../test/fixtures";
import { clearBallotDraft, setDraftBallotContext, setDraftCandidateChoice } from "../lib/ballotDraft";

// The notice rides the app shell's header, so every test renders <App />
// with stand-in pages: the transition happens while the user is on some
// page, and the assertions are about the header row.
function renderShell(initialEntry = "/elections/e-1") {
  return renderRoutes(
    [
      {
        path: "/",
        element: <App />,
        children: [
          { index: true, element: <p>home content</p> },
          { path: "elections/e-1", element: <p>election content</p> },
          { path: "draft", element: <p>draft content</p> },
          { path: "me/picks", element: <p>picks content</p> },
          { path: "*", element: <p>other content</p> },
        ],
      },
    ],
    initialEntry
  );
}

const GUEST = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

const NOTICE_TEXT = /You have completed your November 3, 2026 election draft/;

function seedDraft(draft: {
  target: { election_date: string; election_ids: string[]; retention_ids?: string[] } | null;
  choices: Record<string, ElectionChoice>;
}) {
  window.localStorage.setItem(
    "voteapp_ballot_draft",
    JSON.stringify({ v: 1, district_ids: ["dddddddd-1111-4111-8111-111111111111"], ...draft })
  );
  window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
}

function choice(electionId: string, title: string): ElectionChoice {
  return {
    election_id: electionId,
    race_type: "office",
    official_ballot_title: title,
    election_date: "2026-11-03",
    seats_to_fill: null,
    picks: [{ candidate_id: `${electionId}-c`, display_name: "Jane Smith", candidacy_status: "active" }],
    measure_position: null,
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

// The pick that finishes (or, with chosen: false, reopens) the e-2 race.
function pickMayor(chosen: boolean) {
  act(() => {
    setDraftCandidateChoice({
      electionId: "e-2",
      raceTitle: "Mayor",
      electionDate: "2026-11-03",
      seatsToFill: null,
      candidateId: "c-2",
      candidateName: "Pat Mayor",
      chosen,
    });
  });
}

const TWO_RACE_TARGET = { election_date: "2026-11-03", election_ids: ["e-1", "e-2"] };

beforeEach(() => {
  // Frozen clock so the 2026-11-03 fixtures stay upcoming.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  window.localStorage.clear();
  clearBallotDraft();
});

afterEach(() => {
  clearBallotDraft();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


it.each([false, true])("guest completion describes open retention only when needed (answered=%s)", async (answered) => {
  const retentionChoice = (id: string): ElectionChoice => ({ ...choice(id, `Shall Judge ${id} be retained?`), picks: [], measure_position: "no" });
  seedDraft({
    target: { ...TWO_RACE_TARGET, retention_ids: ["r-1", "r-2"] },
    choices: { "e-1": choice("e-1", "Governor"), ...(answered ? { "r-1": retentionChoice("r-1"), "r-2": retentionChoice("r-2") } : {}) },
  });
  stubApiRoutes(GUEST);
  renderShell();
  expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();
  pickMayor(true);
  await screen.findByText(NOTICE_TEXT);
  expect(screen.getByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
  expect(screen.getByRole("status").textContent?.includes("Retention races are still open on your draft.")).toBe(!answered);
  pickMayor(false);
  pickMayor(true);
  await waitFor(() => expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument());
});

it.each([false, true])("account completion excludes grouped retention (answered=%s)", async (answered) => {
  let choices: ElectionChoice[] = answered ? ["r-1", "r-2"].map((id) => ({
    ...choice(id, `Shall Judge ${id} be retained?`), picks: [], measure_position: "yes",
  })) : [];
  stubApiRoutes({
    "/api/me": { body: ME_VERIFIED },
    "/api/me/ballot": { body: ballotSummary([electionSummary(), retentionElection("r-1"), retentionElection("r-2")]) },
    "/api/me/election-choices": () => ({ body: { choices } }),
  });
  const { queryClient } = renderShell();
  await waitFor(() => expect(queryClient.getQueryState(["me", "election-choices"])?.status).toBe("success"));
  await waitFor(() => expect(queryClient.getQueryState(["me", "ballot", "preview"])?.status).toBe("success"));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  choices = [...choices, choice("e-1", "Governor")];
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["me", "election-choices"] }); });
  await screen.findByText(NOTICE_TEXT);
  expect(screen.getByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
  expect(screen.getByRole("status").textContent?.includes("Retention races are still open on your draft.")).toBe(!answered);
});

describe("DraftCompleteNotice", () => {
  it("fires once when the guest draft's last race gets a pick, closes on unpick, and does not repeat", async () => {
    seedDraft({ target: TWO_RACE_TARGET, choices: { "e-1": choice("e-1", "Governor") } });
    stubApiRoutes(GUEST);
    renderShell();
    // Incomplete on arrival: the live region is present but empty.
    expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    pickMayor(true);
    const status = screen.getByRole("status");
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();
    // One sentence plus the link — no count line, no "review and change" copy.
    expect(status).toHaveTextContent(/^You have completed your November 3, 2026 election draft\.\s*Review my picks\s*×$/);
    expect(screen.getByRole("link", { name: "Review my picks" })).toHaveAttribute("href", "/draft");
    // Status message, not a dialog: focus stays where it was.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    expect(JSON.parse(window.localStorage.getItem("voteapp_draft_complete_seen") ?? "[]")).toEqual(["2026-11-03"]);

    // Unpick: the message no longer holds.
    pickMayor(false);
    await waitFor(() => expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument());

    // Re-pick: the day was already celebrated on this browser.
    pickMayor(true);
    expect(await screen.findByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument();
  });

  it("stays quiet when the first known progress is already complete (a returning guest)", async () => {
    seedDraft({
      target: TWO_RACE_TARGET,
      choices: { "e-1": choice("e-1", "Governor"), "e-2": choice("e-2", "Mayor") },
    });
    stubApiRoutes(GUEST);
    renderShell();
    expect(await screen.findByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(window.localStorage.getItem("voteapp_draft_complete_seen")).toBeNull();
  });

  it("stays quiet when the signed-in progress resolves asynchronously as complete", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/ballot": { body: ballotSummary([electionSummary()]) },
      "/api/me/election-choices": { body: { choices: [choice("e-1", "Governor")] } },
    });
    renderShell();
    expect(await screen.findByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("fires for a signed-in user whose choices go from incomplete to complete", async () => {
    let choices: ElectionChoice[] = [];
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/ballot": { body: ballotSummary([electionSummary()]) },
      "/api/me/election-choices": () => ({ body: { choices } }),
    });
    const { queryClient } = renderShell();
    expect(await screen.findByRole("link", { name: "My Draft" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    // A pick lands (the choice mutation invalidates this key the same way).
    choices = [choice("e-1", "Governor")];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["me", "election-choices"] });
    });
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review my picks" })).toHaveAttribute("href", "/me/picks");

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument();
  });

  it("counts a completion on the draft page as seen without showing or queuing the notice", async () => {
    seedDraft({ target: TWO_RACE_TARGET, choices: { "e-1": choice("e-1", "Governor") } });
    stubApiRoutes(GUEST);
    const { router } = renderShell("/draft");
    expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();

    pickMayor(true);
    expect(await screen.findByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(JSON.parse(window.localStorage.getItem("voteapp_draft_complete_seen") ?? "[]")).toEqual(["2026-11-03"]);

    await act(async () => {
      await router.navigate("/elections/e-1");
    });
    expect(await screen.findByText("election content")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("retires an open notice when the user reaches the draft page", async () => {
    seedDraft({ target: TWO_RACE_TARGET, choices: { "e-1": choice("e-1", "Governor") } });
    stubApiRoutes(GUEST);
    renderShell();
    expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();
    pickMayor(true);
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Review my picks" }));
    expect(await screen.findByText("draft content")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("does not treat a shrinking race list as a completion", async () => {
    // 1 of 2 picked; the ballot is reloaded (address change, retired race)
    // and now holds only the already-picked race: 1/1, no new pick.
    seedDraft({ target: TWO_RACE_TARGET, choices: { "e-1": choice("e-1", "Governor") } });
    stubApiRoutes(GUEST);
    renderShell();
    expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();

    act(() => {
      setDraftBallotContext(["dddddddd-1111-4111-8111-111111111111"], {
        election_date: "2026-11-03",
        election_ids: ["e-1"],
      });
    });
    expect(await screen.findByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    // And the day's once-only notice was not consumed by it.
    expect(window.localStorage.getItem("voteapp_draft_complete_seen")).toBeNull();
  });

  it("drops an open notice when progress can no longer confirm it", async () => {
    seedDraft({ target: TWO_RACE_TARGET, choices: { "e-1": choice("e-1", "Governor") } });
    stubApiRoutes(GUEST);
    renderShell();
    expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();
    pickMayor(true);
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();

    // The draft is cleared (what registering does once the flush succeeds).
    act(() => {
      clearBallotDraft();
    });
    await waitFor(() => expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument());
  });

  it("remembers a date whose marker write failed even though reads work", async () => {
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "voteapp_draft_complete_seen") {
        throw new Error("QuotaExceededError");
      }
      return realSetItem.call(this, key, value);
    });
    // A date no other test uses, so the module-level memory fallback cannot
    // leak between tests.
    const target = { election_date: "2026-11-05", election_ids: ["e-1", "e-2"] };
    const nov5 = (id: string, title: string) => ({ ...choice(id, title), election_date: "2026-11-05" });
    seedDraft({ target, choices: { "e-1": nov5("e-1", "Governor") } });
    stubApiRoutes(GUEST);
    renderShell();
    expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();

    const notice = /You have completed your November 5, 2026 election draft/;
    pickMayor(true);
    expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(window.localStorage.getItem("voteapp_draft_complete_seen")).toBeNull();
    pickMayor(false);
    await waitFor(() => expect(screen.queryByText(notice)).not.toBeInTheDocument());
    pickMayor(true);
    expect(await screen.findByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it("still fires once per tab when the seen marker cannot be stored", async () => {
    const realSetItem = Storage.prototype.setItem;
    const realGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "voteapp_draft_complete_seen") {
        throw new Error("QuotaExceededError");
      }
      return realSetItem.call(this, key, value);
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (key === "voteapp_draft_complete_seen") {
        throw new Error("SecurityError");
      }
      return realGetItem.call(this, key);
    });
    seedDraft({ target: TWO_RACE_TARGET, choices: { "e-1": choice("e-1", "Governor") } });
    stubApiRoutes(GUEST);
    renderShell();
    expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();

    pickMayor(true);
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();
    pickMayor(false);
    await waitFor(() => expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument());
    pickMayor(true);
    expect(await screen.findByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument();
  });
});

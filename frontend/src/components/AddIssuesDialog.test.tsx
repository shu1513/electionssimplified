import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, SuggestedIssueGroup } from "@voteapp/api-client";
import { AddIssuesDialog } from "./AddIssuesDialog";
import { stubApiRoutes } from "../test/mockApi";
import { renderRoutes } from "../test/render";

// Same mocking rationale as AutoPickControl.test: useMyResearchAreas forks
// on the session, and renderRoutes seeds nothing.
const SIGNED_IN: Me = {
  id: "user-1",
  email: "voter@example.com",
  first_name: "Vo",
  email_verified: true,
  accepted_terms_version: null,
  has_password: true,
};
vi.mock("@voteapp/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@voteapp/api-client")>();
  return {
    ...actual,
    useMe: () => ({ me: SIGNED_IN, isLoading: false, isError: false, refetch: vi.fn() }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const AREA_HOUSING = "aaaaaaaa-0000-4000-8000-000000000001";
const AREA_CLIMATE = "aaaaaaaa-0000-4000-8000-000000000002";
const AREA_TAXES = "aaaaaaaa-0000-4000-8000-000000000003";
const AREA_SAFETY = "aaaaaaaa-0000-4000-8000-000000000004";
const AREA_WATER = "aaaaaaaa-0000-4000-8000-000000000005";
const AREA_ETHICS = "aaaaaaaa-0000-4000-8000-00000000000e";

function preference(researchAreaId: string, name: string, rank: number, direction = "support") {
  return { research_area_id: researchAreaId, slug: name.toLowerCase(), name, description: null, rank, direction, hard_veto: false };
}

const THREE_PREFERENCES = {
  preferences: [
    preference(AREA_HOUSING, "Housing", 1),
    preference(AREA_CLIMATE, "Climate", 2, "oppose"),
    preference(AREA_TAXES, "Taxes", 3),
  ],
};

function suggestion(overrides: Partial<SuggestedIssueGroup> & Pick<SuggestedIssueGroup, "research_area_id" | "name">): SuggestedIssueGroup {
  return {
    slug: overrides.name.toLowerCase().replace(/ /g, "_"),
    description: null,
    candidate_count: 2,
    record_count: 3,
    race_count: 1,
    ...overrides,
  };
}

const SUGGESTIONS = [
  suggestion({ research_area_id: AREA_SAFETY, name: "Public safety", description: "Policing and crime." }),
  suggestion({ research_area_id: AREA_WATER, name: "Water", candidate_count: 1, record_count: 1 }),
  suggestion({ research_area_id: AREA_ETHICS, name: "Integrity and ethics", slug: "integrity_and_ethics" }),
];

function putBodies(fetchMock: ReturnType<typeof stubApiRoutes>) {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input).includes("research-area-preferences") && init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)));
}

function renderDialog({
  onClose = vi.fn(),
  onAdded = vi.fn(),
  preferences = THREE_PREFERENCES,
  putStatus = 200,
} = {}) {
  const fetchMock = stubApiRoutes({
    "/api/me": { body: { user: SIGNED_IN } },
    "/api/me/research-area-preferences": (_url, init) =>
      init?.method === "PUT"
        ? putStatus === 200
          ? { body: { preferences: JSON.parse(String(init.body)).preferences } }
          : { status: putStatus, body: { error: { code: "invalid", message: "Too many issues." } } }
        : { body: preferences },
  });
  renderRoutes([
    {
      path: "/",
      element: (
        <AddIssuesDialog suggestions={SUGGESTIONS} scope="election" onClose={onClose} onAdded={onAdded} />
      ),
    },
  ]);
  return { fetchMock, onClose, onAdded };
}

/** The ranked panel's rows, top to bottom, by issue name. */
function rankedNames() {
  return screen
    .queryAllByRole("button", { name: /rank \d+\. Click to remove\./ })
    .map((card) => card.getAttribute("aria-label")!.split(",")[0]);
}

describe("AddIssuesDialog", () => {
  it("opens as the user's current list, with the race's issues offered above it, none chosen", async () => {
    renderDialog();
    expect(await screen.findByRole("dialog", { name: "Filter candidates by choosing your stances on these issues" })).toBeInTheDocument();
    expect(screen.getByText(/Choose the issues that matter most to you and drag to arrange them/)).toBeInTheDocument();
    // The ranked panel: the existing three, untouched.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Drag to reorder/ }).map((handle) => handle.getAttribute("aria-label"))).toEqual([
        "Housing, rank 1. Drag to reorder.",
        "Climate, rank 2. Drag to reorder.",
        "Taxes, rank 3. Drag to reorder.",
      ])
    );
    // The pool holds only the offered issues, none selected yet — and it
    // comes BEFORE the ranked list, so the choice is the first thing seen.
    for (const name of ["Public safety", "Water", "Integrity and ethics"]) {
      expect(screen.getByRole("button", { name, pressed: false })).toBeInTheDocument();
    }
    expect(rankedNames()).toEqual([]);
    const pool = screen.getByText("Choose and rank issues related to this race");
    const priorities = screen.getByText("My priorities");
    expect(pool.compareDocumentPosition(priorities) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add 0 issues and pick again" })).toBeDisabled();
  });

  it("shows the Settings row controls — a side for all but ethics, and Must — once an issue is tapped in", async () => {
    renderDialog();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Public safety", pressed: false }));
    await user.click(screen.getByRole("button", { name: "Integrity and ethics", pressed: false }));
    expect(rankedNames()).toEqual(["Public safety", "Integrity and ethics"]);
    expect(screen.getByRole("group", { name: "Your position on Public safety" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Your position on Integrity and ethics" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Must: .* \(Public safety\)$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Skip candidates with a negative ethics record .* \(Integrity and ethics\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add 2 issues and pick again" })).toBeEnabled();
  });

  it("saves the arranged list — sides, Must, and drops — as one full-list PUT and hands back control", async () => {
    const { fetchMock, onAdded, onClose } = renderDialog();
    const user = userEvent.setup();
    // Tap Public safety and Integrity in; leave Water out.
    await user.click(await screen.findByRole("button", { name: "Public safety", pressed: false }));
    await user.click(screen.getByRole("button", { name: "Integrity and ethics", pressed: false }));
    // Oppose + Must on Public safety, from its ranked row.
    const safety = screen.getByRole("group", { name: "Your position on Public safety" });
    await user.click(within(safety).getByRole("button", { name: "Oppose" }));
    await user.click(screen.getByRole("button", { name: /^Must: .* \(Public safety\)$/ }));
    await user.click(screen.getByRole("button", { name: "Add 2 issues and pick again" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    // The existing three keep their ranks and sides (Climate stays
    // "oppose"); the additions follow at ranks 4 and 5.
    expect(putBodies(fetchMock)).toEqual([
      {
        preferences: [
          { research_area_id: AREA_HOUSING, rank: 1, direction: "support", hard_veto: false },
          { research_area_id: AREA_CLIMATE, rank: 2, direction: "oppose", hard_veto: false },
          { research_area_id: AREA_TAXES, rank: 3, direction: "support", hard_veto: false },
          { research_area_id: AREA_SAFETY, rank: 4, direction: "oppose", hard_veto: true },
          { research_area_id: AREA_ETHICS, rank: 5, direction: "support", hard_veto: false },
        ],
      },
    ]);
  });

  // Reordering (drag, or keyboard on the ⠿ handle) is the shared editor's
  // own behavior, covered by ResearchAreaPicker.test; this dialog only has
  // to render it with the user's whole list.
  it("disables the add button again once a tapped-in issue is tapped back off", async () => {
    renderDialog();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Water", pressed: false }));
    expect(screen.getByRole("button", { name: "Add 1 issue and pick again" })).toBeEnabled();
    // The row it landed in is tinted, so a tap above a long list is seen.
    expect(screen.getByRole("button", { name: "Water, rank 4. Drag to reorder." }).closest("li")).toHaveClass("bg-green-50");
    expect(screen.getByRole("button", { name: "Housing, rank 1. Drag to reorder." }).closest("li")).not.toHaveClass("bg-green-50");
    await user.click(screen.getByRole("button", { name: "Water, rank 4. Click to remove." }));
    expect(screen.getByRole("button", { name: "Add 0 issues and pick again" })).toBeDisabled();
  });

  it("closes without saving on Not now", async () => {
    const { fetchMock, onClose, onAdded } = renderDialog();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAdded).not.toHaveBeenCalled();
    expect(putBodies(fetchMock)).toEqual([]);
  });

  it("promises the rerun only once the list reaches the floor", async () => {
    renderDialog({ preferences: { preferences: THREE_PREFERENCES.preferences.slice(0, 1) } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Water", pressed: false }));
    // 1 ranked + 1 chosen = 2: still short, so no rerun is promised.
    expect(screen.getByRole("button", { name: "Add 1 issue" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Public safety", pressed: false }));
    // 1 ranked + 2 chosen = 3: at the floor.
    expect(screen.getByRole("button", { name: "Add 2 issues and pick again" })).toBeEnabled();
  });

  it("shows the server's message when the save fails, keeping the dialog open", async () => {
    const { onAdded } = renderDialog({ putStatus: 400 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Water", pressed: false }));
    await user.click(screen.getByRole("button", { name: "Add 1 issue and pick again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many issues.");
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

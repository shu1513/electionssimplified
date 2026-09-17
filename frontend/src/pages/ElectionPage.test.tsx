import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ElectionPage, ErrorBoundary } from "./ElectionPage";
import { ElectionList } from "../components/ElectionCard";
import { clearBallotDraft, readBallotDraft, setDraftBallotContext, setDraftCandidateChoice } from "../lib/ballotDraft";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import {
  DISTRICT,
  electionDetail,
  electionSummary,
  retentionElection,
  financeSummary,
  ME_VERIFIED,
  MY_DISTRICTS,
  VOTE_POWER_WITH_EXPLANATION,
} from "../test/fixtures";
import type { ElectionDetail } from "@voteapp/api-client";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

// The subject arrives via the route loader (server-fetched in production);
// tests supply it directly instead of stubbing the loader's fetch.
// `state` simulates arriving with nav context (see detailNavContext.ts).
function renderElection(
  loader: (args: { params: { electionId?: string } }) => unknown,
  id = "e-1",
  state?: unknown
) {
  return renderRoutes(
    [
      {
        path: "/elections/:electionId",
        element: <ElectionPage />,
        errorElement: <ErrorBoundary />,
        hydrateFallbackElement: <p />,
        loader,
      },
      { path: "/candidates/:candidateId", element: <p /> },
      { path: "/ballot", element: <p /> },
      { path: "/disclaimer", element: <p /> },
    ],
    state === undefined ? `/elections/${id}` : { pathname: `/elections/${id}`, state }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ElectionPage", () => {
  it("renders not-found UI when the loader throws a 404", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => {
      throw new Response("Not Found", { status: 404 });
    }, "e-missing");
    expect(await screen.findByText("Election not found")).toBeInTheDocument();
  });

  it("shows the current-cycle rating chip instead of the historic one when both arrive", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        historical_competitiveness: {
          display_label: "Historically competitive",
          display_description: "Based on the 2024 Governor result.",
          source: "MIT_2024",
          source_url: null,
          election_year: 2024,
          margin_percent: 8.4,
          competitiveness_label: "competitive",
          stale_after_redistricting: false,
        },
        current_competitiveness: {
          display_label: "Currently a toss-up",
          display_description: "Based on current race ratings from Inside Elections as of August 6, 2026.",
          competitiveness_label: "toss_up",
          method: "outlet_consensus",
          confidence: "medium",
          as_of: "2026-08-06",
        },
      })
    );

    // Both chips at once would contradict on a race that flipped.
    expect(await screen.findByText("Currently a toss-up")).toBeInTheDocument();
    expect(screen.queryByText("Historically competitive")).not.toBeInTheDocument();
  });

  it("shows no competitiveness chip for the safe tier", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        historical_competitiveness: {
          display_label: "Historically not competitive",
          display_description: "Based on the 2024 Governor result.",
          source: "MIT_2024",
          source_url: null,
          election_year: 2024,
          margin_percent: 22.4,
          competitiveness_label: "safe",
          stale_after_redistricting: false,
        },
      })
    );
    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.queryByText("Historically not competitive")).not.toBeInTheDocument();
  });

  it("renders the election header and every candidate", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail());

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.getByText("Jordan Voter")).toBeInTheDocument();
    expect(screen.getByText("Riley Runner")).toBeInTheDocument();
    // The candidate list carries no follow controls; following lives on the
    // candidate profile page.
    expect(screen.queryByRole("button", { name: /follow/i })).not.toBeInTheDocument();
    // The report button sits at the end of the page, after the candidates.
    const reportButton = screen.getByRole("button", { name: "Report an issue with election" });
    const candidatesHeading = screen.getByRole("heading", { name: "Candidates" });
    expect(candidatesHeading.compareDocumentPosition(reportButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders a collapsed vote power explanation when the detail payload carries one", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ vote_power: VOTE_POWER_WITH_EXPLANATION }));

    await screen.findByRole("heading", { name: "Governor" });
    expect(screen.getByText("How do we calculate my vote power?")).toBeInTheDocument();
    // Native <details> keeps content in the DOM while collapsed; the backend
    // copy must arrive verbatim.
    expect(screen.getByText("What determines the vote power rating:")).toBeInTheDocument();
    // Each part renders formula-style: title, grade, stat, then the detail.
    expect(screen.getByText("Representation:")).toBeInTheDocument();
    expect(screen.getByText("· 50 out of 100")).toBeInTheDocument();
    expect(screen.getByText("· 3.3-point margin in 2022")).toBeInTheDocument();
    expect(
      screen.getByText("Past results here were very close — a small number of votes could decide the winner.")
    ).toBeInTheDocument();
    expect(screen.getByText("Average representation + high decisiveness → My vote power: High.")).toBeInTheDocument();
    expect(screen.getByText("Some data is missing.")).toBeInTheDocument();
    // The exact formula sits behind its own per-part disclosure when the
    // backend provides one; the null formula on the other part must not
    // render a toggle at all. The label must be the real <summary> control,
    // and the formula's own <details> starts collapsed — asserted on that
    // inner element directly, since the closed outer panel would hide the
    // formula either way.
    expect(screen.getByText("Show the representation math").tagName).toBe("SUMMARY");
    const formula = screen.getByText("score = 100 × ln(9,808,667 ÷ 104,650) ÷ ln(9,808,667 ÷ 1,204) = 50");
    expect(formula.closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("Show the decisiveness math")).not.toBeInTheDocument();
  });

  it("names each math disclosure after its part when both formulas arrive", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const explanation = VOTE_POWER_WITH_EXPLANATION.explanation!;
    renderElection(() =>
      electionDetail({
        vote_power: {
          ...VOTE_POWER_WITH_EXPLANATION,
          explanation: {
            ...explanation,
            parts: [
              explanation.parts[0],
              { ...explanation.parts[1], formula: 'margin = 3.3 points → "very competitive" → grade high' },
            ],
          },
        },
      })
    );

    await screen.findByRole("heading", { name: "Governor" });
    // Distinct labels on real <summary> controls — two bare "Show the math"
    // toggles would be indistinguishable to screen-reader and voice-control
    // users. (No getByRole here: <summary> has no reliable ARIA role.)
    expect(screen.getByText("Show the representation math").tagName).toBe("SUMMARY");
    expect(screen.getByText("Show the decisiveness math").tagName).toBe("SUMMARY");
  });

  it("omits the vote power explanation when the payload has none or the label is unknown", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail());

    await screen.findByRole("heading", { name: "Governor" });
    expect(screen.queryByText("How do we calculate my vote power?")).not.toBeInTheDocument();
  });

  it("names a retention race in the vote power slot, with no explanation panel", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        official_ballot_title: "Shall Judge Jordan Voter be retained in office?",
        vote_power: {
          ...VOTE_POWER_WITH_EXPLANATION,
          label: "retention",
          score: null,
          explanation: {
            how: "A retention race asks Yes or No on keeping one judge in office. With no competing candidates, the normal vote power rating methods don't apply.",
            parts: [],
            result: "Retention race",
            caveat: null,
          },
        },
      })
    );

    await screen.findByRole("heading", { name: "Shall Judge Jordan Voter be retained in office?" });
    expect(screen.getByText("My vote power").nextElementSibling).toHaveTextContent("Retention race");
    // The label alone is opaque, but the header stays clean: the backend's
    // one-line explanation sits behind an ⓘ toggle, not inline.
    expect(screen.queryByText("A retention race asks Yes or No on keeping one judge in office. With no competing candidates, the normal vote power rating methods don't apply.")).not.toBeInTheDocument();
    const info = screen.getByRole("button", { name: "What is a retention race?" });
    expect(info).toHaveAttribute("aria-expanded", "false");
    const user = userEvent.setup();
    await user.click(info);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("A retention race asks Yes or No on keeping one judge in office. With no competing candidates, the normal vote power rating methods don't apply.");
    // A floating bubble, not in-flow text: it must not push the page down.
    expect(note.className).toContain("absolute");
    expect(info).toHaveAttribute("aria-expanded", "true");
    // Its own close button, Escape, and a click anywhere else all close it.
    await user.click(within(note).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await user.click(info);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await user.click(info);
    await user.click(screen.getByRole("heading", { name: "Shall Judge Jordan Voter be retained in office?" }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.queryByText("How do we calculate my vote power?")).not.toBeInTheDocument();
  });

  it("hides the vote power explanation entirely for an unknown label", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        vote_power: { ...VOTE_POWER_WITH_EXPLANATION, label: "unknown", score: null },
      })
    );

    await screen.findByRole("heading", { name: "Governor" });
    expect(screen.queryByText(/My vote power:/)).not.toBeInTheDocument();
    expect(screen.queryByText("How do we calculate my vote power?")).not.toBeInTheDocument();
  });

  it("shows the seat count for multi-seat contests and hides it otherwise", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ seats_to_fill: 3 }));

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.getByText(/3 seats/)).toBeInTheDocument();
  });

  it("shows no seat count when seats_to_fill is absent or 1", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ seats_to_fill: 1 }));

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.queryByText(/seats/)).not.toBeInTheDocument();
  });

  it("explains a seat whose electorate is smaller than the district, without claiming to filter", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ sub_district_seat: "Ward 3" }));

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.getByText(/This seat represents/)).toBeInTheDocument();
    expect(screen.getByText("Ward 3")).toBeInTheDocument();
    expect(screen.getByText(/may not be on your ballot/)).toBeInTheDocument();
  });

  it("shows no seat-area note for an ordinary race", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail());

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.queryByText(/This seat represents/)).not.toBeInTheDocument();
  });

  it("hides the party filter when the roster spans a single bucket", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    // Default fixture: two Independent candidates — one "other" bucket.
    renderElection(() => electionDetail());

    await screen.findByRole("heading", { name: "Candidates" });
    expect(screen.queryByRole("group", { name: "Filter candidates by party" })).not.toBeInTheDocument();
  });

  it("filters candidates by party bucket and restores with All", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    renderElection(() =>
      electionDetail({
        candidates: [
          {
            candidate_id: "c-1",
            display_name: "Dana Democrat",
            party: "Democratic",
            is_incumbent: false,
            status: "active",
            summary: null,
            finance_summary: null,
            records: [],
          },
          {
            candidate_id: "c-2",
            display_name: "Riley Republican",
            party: "Republican",
            is_incumbent: false,
            status: "active",
            summary: null,
            finance_summary: null,
            records: [],
          },
          {
            candidate_id: "c-3",
            // The registration label buckets with its party for filtering,
            // even though storage keeps it distinct.
            display_name: "Alex Alaskan",
            party: "Registered Democrat",
            is_incumbent: false,
            status: "active",
            summary: null,
            finance_summary: null,
            records: [],
          },
          {
            candidate_id: "c-4",
            display_name: "Indy Other",
            party: "Independent",
            is_incumbent: false,
            status: "active",
            summary: null,
            finance_summary: null,
            records: [],
          },
        ],
      })
    );

    await screen.findByRole("group", { name: "Filter candidates by party" });
    // Chips carry counts; All is pressed by default.
    expect(screen.getByRole("button", { name: "All (4)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Democrats (2)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Republicans (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Other (1)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Democrats (2)" }));
    expect(screen.getByText("Dana Democrat")).toBeInTheDocument();
    expect(screen.getByText("Alex Alaskan")).toBeInTheDocument();
    expect(screen.queryByText("Riley Republican")).not.toBeInTheDocument();
    expect(screen.queryByText("Indy Other")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All (4)" }));
    expect(screen.getByText("Riley Republican")).toBeInTheDocument();
    expect(screen.getByText("Indy Other")).toBeInTheDocument();
  });

  it("clears the party filter when auto-pick chooses a candidate the filter hid", async () => {
    // The engine scores the whole roster, not the filtered view the button
    // sits under. Filtered to Democrats, a Republican pick must not land on
    // a hidden card.
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/research-area-preferences": {
        body: {
          preferences: [
            { research_area_id: "a-1", slug: "housing", name: "Housing", description: null, rank: 1 },
            { research_area_id: "a-2", slug: "health", name: "Health", description: null, rank: 2 },
            { research_area_id: "a-3", slug: "safety", name: "Safety", description: null, rank: 3 },
          ],
        },
      },
      "/api/me/auto-picks": {
        body: {
          results: [
            {
              election_id: "e-1",
              race_type: "office",
              outcome: "picked",
              reason: null,
              picked_candidate_ids: ["c-2"],
              measure_position: null,
              shortlist_candidate_ids: [],
              candidates: [],
              measure_per_issue: [],
              unresearched: [],
            },
          ],
        },
      },
    });
    const user = userEvent.setup();
    renderElection(() =>
      electionDetail({
        candidates: [
          {
            candidate_id: "c-1",
            display_name: "Dana Democrat",
            party: "Democratic",
            is_incumbent: false,
            status: "active",
            summary: null,
            finance_summary: null,
            records: [],
          },
          {
            candidate_id: "c-2",
            display_name: "Riley Republican",
            party: "Republican",
            is_incumbent: false,
            status: "active",
            summary: null,
            finance_summary: null,
            records: [],
          },
        ],
      })
    );

    await user.click(await screen.findByRole("button", { name: "Democrats (1)" }));
    expect(screen.queryByText("Riley Republican")).not.toBeInTheDocument();

    const autoPick = await screen.findByRole("button", { name: "Auto-pick by my issues" });
    await waitFor(() => expect(autoPick).toBeEnabled());
    await user.click(autoPick);

    expect(await screen.findByText("Riley Republican")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All (2)" })).toHaveAttribute("aria-pressed", "true");
  });

  it("resets the party filter when navigating to a different election", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const candidate = (id: string, name: string, party: string) => ({
      candidate_id: id,
      display_name: name,
      party,
      is_incumbent: false,
      status: "active",
      summary: null,
      finance_summary: null,
      records: [],
    });
    // Same route stays mounted across param changes; both rosters offer the
    // "Democrats" bucket, so a leaked pick WOULD apply — and must not.
    const { router } = renderElection(({ params }) =>
      params.electionId === "e-2"
        ? electionDetail({
            id: "e-2",
            candidates: [candidate("c-5", "Casey Second", "Democratic"), candidate("c-6", "Robin Second", "Republican")],
          })
        : electionDetail({
            id: "e-1",
            candidates: [candidate("c-1", "Dana First", "Democratic"), candidate("c-2", "Riley First", "Republican")],
          })
    );

    await user.click(await screen.findByRole("button", { name: "Democrats (1)" }));
    expect(screen.queryByText("Riley First")).not.toBeInTheDocument();

    await router.navigate("/elections/e-2");
    // Fresh election, fresh filter: both candidates visible, All pressed.
    expect(await screen.findByText("Robin Second")).toBeInTheDocument();
    expect(screen.getByText("Casey Second")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All (2)" })).toHaveAttribute("aria-pressed", "true");
  });

  it("explains an empty candidate list instead of hiding the section", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        candidates: [],
        candidate_roster_status: { reason: "awaiting_official_roster", check_after: "2026-08-27" },
      })
    );

    expect(await screen.findByRole("heading", { name: "Candidates" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "We haven't found a final candidate list from election officials for this race yet. We'll check again after August 27, 2026."
      )
    ).toBeInTheDocument();
  });

  it("hides the candidates section entirely when empty with no roster status", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ candidates: [], candidate_roster_status: null }));

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Candidates" })).not.toBeInTheDocument();
  });

  it("falls back to generic copy for an unknown roster status reason", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        candidates: [],
        candidate_roster_status: { reason: "some_future_reason", check_after: null },
      })
    );

    expect(await screen.findByText("Candidate information for this race isn't available yet.")).toBeInTheDocument();
  });

  it("renders no campaign finance on candidate cards, even when the payload carries it", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const detail = electionDetail();
    detail.candidates[0].finance_summary = financeSummary();
    renderElection(() => detail);

    // Finance lives on the candidate profile page only — no disclosure, no
    // "Raised $X" chip here.
    expect(await screen.findByText("Jordan Voter")).toBeInTheDocument();
    expect(screen.queryByText("Campaign finance")).not.toBeInTheDocument();
    expect(screen.queryByText(/Raised \$/)).not.toBeInTheDocument();
    expect(screen.queryByText("Top disclosed occupations of direct donors")).not.toBeInTheDocument();
    expect(screen.queryByText("Growth PAC")).not.toBeInTheDocument();
    // The card link to the profile survives.
    const cardLink = screen.getByRole("link", { name: /Jordan Voter/ });
    expect(cardLink).toHaveAttribute("href", "/candidates/c-1");
  });

  it("shows no follow buttons in the candidate list even for verified users", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
    });
    renderElection(() => electionDetail());

    // Following moved to the candidate profile page; the list stays a pure
    // navigation surface.
    expect(await screen.findByText("Jordan Voter")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow" })).not.toBeInTheDocument();
    const cardLink = screen.getByRole("link", { name: "Jordan Voter" });
    expect(cardLink).toHaveAttribute("href", "/candidates/c-1");
  });

  it("renders ballot measure yes/no explanations when present", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          source_urls: [],
          official_measure_url: null,
          research_area_tags: [],
          results: [],
        },
      })
    );

    expect(await screen.findByText("Yes approves the bond.")).toBeInTheDocument();
    expect(screen.getByText("No rejects the bond.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Report an issue with ballot measure" })).toBeInTheDocument();
    // One report button per measure page: the measure IS the page, so the
    // election-level button would be a visually identical duplicate.
    expect(screen.queryByRole("button", { name: "Report an issue with election" })).not.toBeInTheDocument();
  });

  it("does not repeat a measure's source under Election sources", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        sources: ["https://sos.example.gov/guide", "https://sos.example.gov/measure-1.pdf"],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          source_urls: ["https://sos.example.gov/guide"],
          official_measure_url: "https://sos.example.gov/measure-1.pdf",
          research_area_tags: [],
          results: [],
        },
      })
    );

    await screen.findByText("Yes approves the bond.");
    // The measure section already shows the guide as its source line and the
    // PDF as the official-measure link; both election sources are covered, so
    // the "Election sources" section (and its duplicate source line) is gone.
    expect(screen.getAllByRole("link", { name: "sos.example.gov" })).toHaveLength(1);
    expect(screen.getAllByText(/^Sources?:/)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Report an issue/ })).toHaveLength(1);
  });

  it("keeps Election sources for URLs the measure section did not show", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        sources: ["https://sos.example.gov/guide", "https://county.example.gov/notice"],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          source_urls: ["https://sos.example.gov/guide"],
          official_measure_url: null,
          research_area_tags: [],
          results: [],
        },
      })
    );

    await screen.findByText("Yes approves the bond.");
    // The measure's own footnote plus one election-level footnote for the
    // county notice the measure did not cite.
    expect(screen.getAllByText(/^Sources?:/)).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "sos.example.gov" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "county.example.gov" })).toBeInTheDocument();
  });

  it("names a source site once and links its further pages as numbered footnotes", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        sources: [
          "https://elections.ny.gov/certification-2026",
          "https://elections.ny.gov/ballot-certifications",
          "https://ballotpedia.org/New_York",
        ],
      })
    );

    const first = await screen.findByRole("link", { name: "elections.ny.gov" });
    expect(first).toHaveAttribute("href", "https://elections.ny.gov/certification-2026");
    expect(screen.getByRole("link", { name: "elections.ny.gov, page 2" })).toHaveAttribute(
      "href",
      "https://elections.ny.gov/ballot-certifications"
    );
    expect(screen.getByRole("link", { name: "ballotpedia.org" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /elections\.ny\.gov/ })).toHaveLength(2);
    expect(screen.getByText(/^Sources:/)).toBeInTheDocument();
    expect(screen.queryByText("Election sources")).not.toBeInTheDocument();
  });

  it("renders candidate stance chips as +N/-N colored by direction", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const record = (id: string, tag: { research_area_id: string; slug: string; name: string; stance: "for" | "against" | null }) => ({
      id,
      description: "A record.",
      source_url: "https://example.gov/record",
      event_date: "2025-01-15",
      created_at: "2025-02-01T00:00:00.000Z",
      research_area_tags: [tag],
    });
    const detail = electionDetail();
    detail.candidates[0].records = [
      record("r-1", { research_area_id: "a-1", slug: "civil_rights", name: "Civil Rights", stance: "for" }),
      record("r-2", { research_area_id: "a-2", slug: "housing_affordability", name: "Housing Affordability", stance: "against" }),
      record("r-3", { research_area_id: "a-2", slug: "housing_affordability", name: "Housing Affordability", stance: "against" }),
      record("r-4", { research_area_id: "a-3", slug: "gun_control", name: "Gun Control", stance: "for" }),
      record("r-5", { research_area_id: "a-3", slug: "gun_control", name: "Gun Control", stance: "against" }),
      record("r-6", { research_area_id: "a-3", slug: "gun_control", name: "Gun Control", stance: "against" }),
    ];
    renderElection(() => detail);

    // All-for compresses to +N in green, all-against to -N in red, and a
    // mixed area shows both counts in amber.
    const forChip = (await screen.findByText("Civil Rights")).closest("span")!;
    expect(forChip.textContent).toContain("+1");
    expect(forChip.className).toContain("text-green-900");
    const againstChip = screen.getByText("Housing Affordability").closest("span")!;
    expect(againstChip.textContent).toContain("-2");
    expect(againstChip.className).toContain("text-red-900");
    const mixedChip = screen.getByText("Gun Control").closest("span")!;
    expect(mixedChip.textContent).toContain("+1 -2");
    expect(mixedChip.className).toContain("text-amber-900");
    // Screen readers hear spelled-out counts — "-2" alone can be read as "2".
    expect(mixedChip.textContent).toContain("1 for, 2 against");
    // The row is labelled: an issue name and a bare number say nothing about
    // what was counted.
    expect(forChip.closest("p")).toHaveTextContent("Records:");
  });

  it("caps the records row at three, saved issues first in any direction, then busiest areas, and expands in place", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/research-area-preferences": {
        body: {
          preferences: [
            { research_area_id: "a-gun", slug: "gun_control", name: "Gun Control", description: null, rank: 1 },
            { research_area_id: "a-none", slug: "data_privacy", name: "Data Privacy", description: null, rank: 2 },
          ],
        },
      },
    });
    const tagged = (id: string, research_area_id: string, slug: string, name: string, stance: "for" | "against") => ({
      id,
      description: "A record.",
      source_url: "https://example.gov/record",
      event_date: "2025-01-15",
      created_at: "2025-02-01T00:00:00.000Z",
      research_area_tags: [{ research_area_id, slug, name, stance }],
    });
    const detail = electionDetail();
    detail.candidates[0].records = [
      // Saved #1, all against: leads anyway. Saved #2 has no records, so it
      // cannot fill a slot. Then Environment (3) beats Civil Rights (2)
      // beats Housing (1) on volume.
      tagged("r-1", "a-gun", "gun_control", "Gun Control", "against"),
      tagged("r-2", "a-env", "environment_and_public_health", "Environment and Public Health", "for"),
      tagged("r-3", "a-env", "environment_and_public_health", "Environment and Public Health", "for"),
      tagged("r-4", "a-env", "environment_and_public_health", "Environment and Public Health", "for"),
      tagged("r-5", "a-civ", "civil_rights", "Civil Rights", "for"),
      tagged("r-6", "a-civ", "civil_rights", "Civil Rights", "for"),
      tagged("r-7", "a-hou", "housing_affordability", "Housing Affordability", "for"),
    ];
    renderElection(() => detail);

    const gun = await screen.findByText("Gun Control");
    // Wait for the preferences fetch: the saved cue marks the row re-ordered.
    await within(gun.closest("span")!).findByText("(saved)");
    const row = gun.closest("p")!;
    const names = () =>
      Array.from(row.querySelectorAll(":scope > span:not(:first-child)")).map((chip) => chip.firstChild?.textContent);
    expect(names()).toEqual(["Gun Control", "Environment and Public Health", "Civil Rights"]);
    expect(screen.queryByText("Housing Affordability")).not.toBeInTheDocument();
    const toggle = within(row).getByRole("button", { name: "+1 more issues" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(names()).toEqual(["Gun Control", "Environment and Public Health", "Civil Rights", "Housing Affordability"]);
    await userEvent.click(within(row).getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("Housing Affordability")).not.toBeInTheDocument();
  });

  it("colors measure research-area chips by stance", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          source_urls: [],
          official_measure_url: null,
          research_area_tags: [
            { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", stance: "for" },
            { research_area_id: "a-2", slug: "civil_rights", name: "Civil Rights", stance: "against" },
            { research_area_id: "a-3", slug: "gun_control", name: "Gun Control", stance: null },
          ],
          results: [],
        },
      })
    );

    // The measure works FOR housing (green, under "Supports:"), AGAINST
    // civil rights (red, under "Opposes:"); a stanceless tag stays muted
    // under "Affects:". The direction is the visible group label, not just
    // color, so color-blind readers can tell the groups apart too.
    const forChip = await screen.findByText("Housing Affordability");
    expect(forChip.className).toContain("text-green-900");
    expect(screen.getByText("Supports:")).toBeInTheDocument();
    const againstChip = screen.getByText("Civil Rights");
    expect(againstChip.className).toContain("text-red-900");
    expect(screen.getByText("Opposes:")).toBeInTheDocument();
    const neutralChip = screen.getByText("Gun Control");
    expect(neutralChip.className).toContain("text-ink-soft");
    expect(screen.getByText("Affects:")).toBeInTheDocument();
  });

  it("marks saved areas with an sr-only cue on measure and candidate chips", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/research-area-preferences": {
        body: {
          preferences: [
            { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", description: null, rank: 1 },
          ],
        },
      },
    });
    const detail = electionDetail({
      race_type: "ballot_measure",
      ballot_measure: {
        id: "m-1",
        official_ballot_title: "Measure 1",
        summary: "A measure.",
        what_yes_means: "Yes approves the bond.",
        what_no_means: "No rejects the bond.",
        result: null,
        source_urls: [],
        official_measure_url: null,
        research_area_tags: [
          { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", stance: "for" },
        ],
        results: [],
      },
    });
    detail.candidates[0].records = [
      {
        id: "r-1",
        description: "A record.",
        source_url: "https://example.gov/record",
        event_date: "2025-01-15",
        created_at: "2025-02-01T00:00:00.000Z",
        research_area_tags: [
          { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", stance: "for" },
        ],
      },
    ];
    renderElection(() => detail);

    // Both chip surfaces voice saved-ness for assistive tech, matching the
    // ElectionCard precedent. The cue arrives with the async preferences
    // fetch, after the loader-fed chips render — so wait on the cue itself.
    const savedCues = await screen.findAllByText("(saved)");
    expect(savedCues).toHaveLength(2);
    // Both surfaces now render the bare area name; the measure chip lives
    // under the "Supports:" group label, the candidate chip carries counts.
    const chips = screen.getAllByText("Housing Affordability");
    expect(chips).toHaveLength(2);
    const measureChip = chips.find((chip) => chip.closest("p")?.textContent?.includes("Supports:"))!;
    expect(measureChip).toHaveTextContent("(saved)");
    const candidateChip = chips
      .find((chip) => !chip.closest("p")?.textContent?.includes("Supports:"))!
      .closest("span")!;
    expect(candidateChip).toHaveTextContent("1 for");
    expect(candidateChip).toHaveTextContent("(saved)");
  });

  it("renders the office description before the affects row, in public-salience order", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        office: {
          id: "o-1",
          scope: "statewide",
          canonical_name: "Governor",
          summary: "Signing or vetoing bills that become state law\nDeciding how much money goes to schools",
        },
        // Alphabetical (API order) on purpose: the page must re-order by
        // public salience, which puts Environment ahead of Civil Rights.
        research_areas: [
          { id: "a-civ", slug: "civil_rights", name: "Civil Rights", description: null },
          { id: "a-env", slug: "environment_and_public_health", name: "Environment & Public Health", description: null },
        ],
      })
    );

    expect(await screen.findByRole("heading", { name: "About this office" })).toBeInTheDocument();
    // Every summary line is a bullet; no hook paragraph, no label.
    const bullets = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(bullets).toEqual(["Signing or vetoing bills that become state law", "Deciding how much money goes to schools"]);
    const description = screen.getByText("Deciding how much money goes to schools");
    const label = screen.getByText("Affects:");
    expect(description.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const environment = screen.getByText("Environment & Public Health");
    const civilRights = screen.getByText("Civil Rights");
    expect(environment.compareDocumentPosition(civilRights) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("caps the affects row at three issues and expands the rest in place", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        research_areas: [
          { id: "a-1", slug: "civil_rights", name: "Civil Rights", description: null },
          { id: "a-2", slug: "environment_and_public_health", name: "Environment and Public Health", description: null },
          { id: "a-3", slug: "gun_control", name: "Gun Control", description: null },
          { id: "a-4", slug: "housing_affordability", name: "Housing Affordability", description: null },
          { id: "a-5", slug: "data_privacy", name: "Data Privacy", description: null },
        ],
      })
    );

    const row = (await screen.findByText("Affects:")).closest("p")!;
    expect(row.querySelectorAll(":scope > span").length).toBe(4);
    const toggle = within(row).getByRole("button", { name: "+2 more issues" });
    await userEvent.click(toggle);
    expect(row.querySelectorAll(":scope > span").length).toBe(6);
    expect(within(row).getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("starts the affects row collapsed again after a sibling walk", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const areas = [
      { id: "a-1", slug: "civil_rights", name: "Civil Rights", description: null },
      { id: "a-2", slug: "environment_and_public_health", name: "Environment and Public Health", description: null },
      { id: "a-3", slug: "gun_control", name: "Gun Control", description: null },
      { id: "a-4", slug: "housing_affordability", name: "Housing Affordability", description: null },
    ];
    // Same route stays mounted across param changes, so the list's expanded
    // state would otherwise carry over to the next race.
    const { router } = renderElection(({ params }) =>
      electionDetail({ id: params.electionId === "e-2" ? "e-2" : "e-1", research_areas: areas })
    );

    await user.click(await screen.findByRole("button", { name: "+1 more issues" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();

    await router.navigate("/elections/e-2");
    expect(await screen.findByRole("button", { name: "+1 more issues" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show less" })).not.toBeInTheDocument();
  });

  it("renders an older hook-plus-bullets summary as plain bullets too", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        office: {
          id: "o-2",
          scope: "state_lower",
          canonical_name: "State Lower Chamber Legislator",
          // Earlier seed shape (sentence hook first), still in a database
          // until the seed re-runs: it must not grow a paragraph or a label.
          summary: "Your state representative writes state laws.\nVoting on how much you pay in state taxes",
        },
      })
    );

    expect(await screen.findByRole("heading", { name: "About this office" })).toBeInTheDocument();
    const bullets = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(bullets).toEqual([
      "Your state representative writes state laws.",
      "Voting on how much you pay in state taxes",
    ]);
    expect(screen.queryByText("This office affects:")).not.toBeInTheDocument();
    expect(screen.queryByText(/State Lower Chamber Legislator/)).not.toBeInTheDocument();
  });

  it("lets logged-out visitors pick straight into the local ballot draft", async () => {
    clearBallotDraft();
    // Pick controls only render for races in the viewer's districts; a
    // guest's districts come from the draft's ballot context.
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail());

    // One per active candidate, same placement as the signed-in control — and
    // each accessible name carries its candidate, so screen-reader button
    // lists and voice control can tell the page's pick buttons apart. The
    // buttons only render once the 401 settles (no-flash rule), so their
    // presence proves the guest fork.
    const jordanPick = await screen.findByRole("button", { name: "Make my pick: Jordan Voter" });
    expect(screen.getByRole("button", { name: "Make my pick: Riley Runner" })).toBeInTheDocument();
    await userEvent.setup().click(jordanPick);

    // The pick lands in the localStorage draft (no API write) and the button
    // flips to picked, same as the signed-in flow.
    expect(await screen.findByRole("button", { name: "✓ My pick: Jordan Voter" })).toBeInTheDocument();
    expect(readBallotDraft().choices["e-1"].picks.map((pick) => pick.candidate_id)).toEqual(["c-1"]);
  });

  it("lets guests pick a measure position from the sticky card, then shows the draft link", async () => {
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          results: [],
          source_urls: [],
          official_measure_url: null,
          research_area_tags: [],
        },
      })
    );

    // ONE pick control on the page — the sticky card's pair (the inline
    // mid-page buttons are gone).
    const yes = await screen.findByRole("button", { name: "Yes" });
    expect(screen.getAllByRole("button", { name: "Yes" })).toHaveLength(1);
    // Auto-pick is account-only: guests get the sign-up teaser in its
    // place (measure wording), never the button itself.
    expect(screen.queryByRole("button", { name: "Auto-pick by my issues" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Does this measure match my values?" })).toBeInTheDocument();
    // Nothing to confirm before the pick.
    expect(screen.queryByRole("link", { name: /My Draft/ })).not.toBeInTheDocument();
    await userEvent.setup().click(yes);

    // The position lands in the localStorage draft and the confirmation
    // actions appear (deep link count form — no ballot seen).
    expect(await screen.findByRole("button", { name: "✓ Yes" })).toBeInTheDocument();
    expect(readBallotDraft().choices["e-1"].measure_position).toBe("yes");
    expect(await screen.findByRole("link", { name: "My Draft (1)" })).toHaveAttribute(
      "href",
      "/draft"
    );
  });

  it("asks Yes/No on a judicial retention race instead of offering a judge pick (guest draft keeps race_type office)", async () => {
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    const judge = electionDetail().candidates[0]!;
    renderElection(() =>
      electionDetail({
        official_ballot_title: "Shall Judge Jordan Voter be retained in office?",
        candidates: [
          {
            ...judge,
            party: "Nonpartisan",
            is_incumbent: true,
            official_website_url: "https://judge.example.gov",
            records: [
              {
                id: "r-1",
                description: "Upheld the clean water rule.",
                source_url: "https://example.gov/record",
                event_date: "2026-05-01",
                created_at: "2026-05-02T00:00:00.000Z",
                research_area_tags: [
                  { research_area_id: "a-env", slug: "environment", name: "Environment", stance: "for" },
                ],
              },
            ],
          },
        ],
      })
    );

    // The sticky pair is the one pick control (it appears once the district
    // gate settles): no candidate pick button, no roster.
    const no = await screen.findByRole("button", { name: "No" });
    expect(screen.getAllByRole("button", { name: "No" })).toHaveLength(1);
    expect(screen.getByText("Yes keeps this judge in office. No removes them.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Make my pick/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /match my values/ })).not.toBeInTheDocument();
    // One question about one person: the judge inline (name as the section
    // heading, site, summary, records) instead of a "Candidates" list that
    // only linked to the profile.
    expect(screen.queryByRole("heading", { name: "Candidates" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Jordan Voter" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Official site" })).toHaveAttribute("href", "https://judge.example.gov");
    expect(screen.getByText("A candidate summary.")).toBeInTheDocument();
    // The profile's blocks, verbatim: stance boxes, then the track record
    // grouped by issue with every group collapsed (the record card sits
    // inside a closed <details>) and the same view picker.
    expect(screen.getByRole("heading", { name: "Supports" })).toBeInTheDocument();
    expect(screen.getByText("Environment (1 record)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Track record" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Track record — Environment" })).toBeInTheDocument();
    expect(screen.getByText("Upheld the clean water rule.").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Supports Environment")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("my_issues");
    expect(screen.queryByText("See full profile →")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Jordan Voter" })).not.toBeInTheDocument();
    // The guest teaser asks about alignment, not "which candidate".
    expect(screen.getByRole("button", { name: "Does this candidate align with my values?" })).toBeInTheDocument();
    await userEvent.setup().click(no);

    expect(await screen.findByRole("button", { name: "✓ No" })).toBeInTheDocument();
    const row = readBallotDraft().choices["e-1"];
    expect(row.measure_position).toBe("no");
    expect(row.race_type).toBe("office");
    expect(row.picks).toEqual([]);
  });

  it("shows no Yes/No card on a measure election whose measure details are still TBD", async () => {
    // Upcoming measure elections can exist before their ballot-measure row;
    // a Yes/No pair with no explanation of what either vote means must not
    // render.
    clearBallotDraft();
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({ race_type: "ballot_measure", candidates: [], ballot_measure: null })
    );

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "No" })).not.toBeInTheDocument();
  });

  it("shows logged-out visitors no pick buttons on past elections", async () => {
    // The backend rejects choice writes to past elections, so the register
    // prompt would advertise an action the visitor could never complete.
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ election_date: "2020-11-03" }));

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Make my pick/ })).not.toBeInTheDocument();
  });

  it("gives logged-in viewers the real pick button, not the register prompt", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/election-choices": (_url, init) => {
        if (init?.method === "PUT") {
          expect(JSON.parse(String(init.body))).toEqual({
            election_id: "e-1",
            candidate_id: "c-1",
            chosen: true,
          });
          return { status: 200, body: { choice: null } };
        }
        return { status: 200, body: { choices: [] } };
      },
    });
    renderElection(() => electionDetail());

    const pickButton = await screen.findByRole("button", { name: "Make my pick: Jordan Voter" });
    await userEvent.setup().click(pickButton);

    // The click writes a choice instead of opening the register dialog.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(true)
    );
    expect(screen.queryByRole("link", { name: "Sign up" })).not.toBeInTheDocument();
  });

  it("surfaces a withdrawn pick with a remove control and PUTs chosen: false", async () => {
    // ballotLookup filters withdrawn candidacies out of the payload, so a
    // withdrawn pick has no candidate card (and no pick button) here while
    // still counting toward the seat cap — the notice is this page's only
    // removal path.
    const puts: unknown[] = [];
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/election-choices": (_url, init) => {
        if (init?.method === "PUT") {
          puts.push(JSON.parse(String(init.body)));
          return { status: 200, body: { choice: null } };
        }
        return {
          status: 200,
          body: {
            choices: [
              {
                election_id: "e-1",
                race_type: "office",
                official_ballot_title: "Governor",
                election_date: "2026-11-03",
                seats_to_fill: 2,
                picks: [
                  {
                    candidate_id: "c-withdrawn",
                    display_name: "Quinn Quitter",
                    candidacy_status: "withdrawn",
                  },
                ],
                measure_position: null,
                updated_at: "2026-08-01T00:00:00.000Z",
              },
            ],
          },
        };
      },
    });
    renderElection(() => electionDetail({ seats_to_fill: 2 }));

    expect(
      await screen.findByText(/withdrew from this race/)
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Remove pick: Quinn Quitter" }));
    await waitFor(() =>
      expect(puts).toEqual([{ election_id: "e-1", candidate_id: "c-withdrawn", chosen: false }])
    );
  });

  it("keeps the stranded-pick notice when every candidacy withdrew, without the auto-pick button", async () => {
    // An all-withdrawn roster arrives as an empty candidates list; the
    // section must still open (the notice is the only removal control for a
    // pick that keeps counting toward the seat cap), but auto-pick has
    // nobody left to pick and must not render its dead-end button.
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/election-choices": {
        body: {
          choices: [
            {
              election_id: "e-1",
              race_type: "office",
              official_ballot_title: "Governor",
              election_date: "2026-11-03",
              seats_to_fill: 2,
              picks: [
                {
                  candidate_id: "c-withdrawn",
                  display_name: "Quinn Quitter",
                  candidacy_status: "withdrawn",
                },
              ],
              measure_position: null,
              updated_at: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    renderElection(() => electionDetail({ candidates: [], seats_to_fill: 2 }));

    expect(await screen.findByText(/withdrew from this race/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove pick: Quinn Quitter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto-pick by my issues" })).not.toBeInTheDocument();
  });

  it("frees a guest's seat slot held by a draft pick that left the roster", async () => {
    // Guest draft rows are always stored candidacy_status "active", so the
    // withdrawn-status path can't fire — roster absence is the guest signal.
    // With the cap full (ghost + Jordan on a 2-seat race), Riley's button is
    // the trap's visible symptom: disabled until the ghost pick is removed.
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    setDraftCandidateChoice({
      electionId: "e-1",
      raceTitle: "Governor",
      electionDate: "2026-11-03",
      seatsToFill: 2,
      candidateId: "c-gone",
      candidateName: "Quinn Quitter",
      chosen: true,
    });
    setDraftCandidateChoice({
      electionId: "e-1",
      raceTitle: "Governor",
      electionDate: "2026-11-03",
      seatsToFill: 2,
      candidateId: "c-1",
      candidateName: "Jordan Voter",
      chosen: true,
    });
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ seats_to_fill: 2 }));

    expect(await screen.findByText(/is no longer listed in this race/)).toBeInTheDocument();
    // The still-rostered pick is not flagged, and the cap holds Riley shut.
    expect(screen.getByRole("button", { name: "✓ My pick: Jordan Voter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make my pick: Riley Runner" })).toBeDisabled();

    await userEvent.setup().click(screen.getByRole("button", { name: "Remove pick: Quinn Quitter" }));

    // The removal is a local draft write: notice gone, seat freed.
    await waitFor(() =>
      expect(screen.queryByText(/is no longer listed in this race/)).not.toBeInTheDocument()
    );
    expect(readBallotDraft().choices["e-1"].picks.map((pick) => pick.candidate_id)).toEqual(["c-1"]);
    expect(screen.getByRole("button", { name: "Make my pick: Riley Runner" })).toBeEnabled();
  });

  it("pulls pick buttons once the guest's ballot context says the race is foreign", async () => {
    // State 2 of the gate: districts known, race foreign — no controls, no
    // nudge. The flip (mine → foreign) makes the absence assertions sound:
    // the buttons demonstrably rendered first, so their disappearance is the
    // gate's verdict, not a page that hadn't settled yet.
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail());

    await screen.findByRole("button", { name: "Make my pick: Jordan Voter" });
    // A ballot lookup for a different address rewrites the draft's district
    // context; the store change propagates without a remount.
    act(() => setDraftBallotContext(["dddddddd-2222-4222-8222-222222222222"], null));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /my pick/i })).not.toBeInTheDocument()
    );
    expect(screen.queryByRole("link", { name: "Enter your address" })).not.toBeInTheDocument();
    // The read-only page keeps its content — only the controls go.
    expect(screen.getByRole("heading", { name: "Governor" })).toBeInTheDocument();
  });

  it("nudges a signed-in viewer with no saved address instead of pick controls", async () => {
    // State 3, server-side fork: verified account, no saved address — the
    // endpoint returns an empty list, which means unknown (a real ballot
    // always has at least one district), never "no districts".
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: { district_ids: [] } },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/election-choices": { body: { choices: [] } },
    });
    renderElection(() => electionDetail());

    const nudge = await screen.findByRole("link", { name: "Enter your address" });
    expect(nudge).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button", { name: /my pick/i })).not.toBeInTheDocument();
    // The whole control set is gated, the auto-pick button included.
    expect(screen.queryByRole("button", { name: "Pick for me" })).not.toBeInTheDocument();
  });

  it("keeps controls for a decided draft pick in a foreign race (safety valve)", async () => {
    // Districts known, race foreign, but the draft already holds a decided
    // pick here — an imperfect geocode must never lock a guest out of
    // seeing or changing it.
    clearBallotDraft();
    setDraftBallotContext(["dddddddd-2222-4222-8222-222222222222"], null);
    setDraftCandidateChoice({
      electionId: "e-1",
      raceTitle: "Governor",
      electionDate: "2026-11-03",
      seatsToFill: null,
      candidateId: "c-1",
      candidateName: "Jordan Voter",
      chosen: true,
    });
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail());

    expect(await screen.findByRole("button", { name: "✓ My pick: Jordan Voter" })).toBeInTheDocument();
    // The full control set returns, so the pick stays changeable.
    expect(screen.getByRole("button", { name: "Make my pick: Riley Runner" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Enter your address" })).not.toBeInTheDocument();
  });

  it("nudges instead of the Yes/No card when a measure viewer's districts are unknown", async () => {
    // The measure sticky card has its own nudge render point — cover it so
    // the office-race tests can't green-light a regression here.
    clearBallotDraft();
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          results: [],
          source_urls: [],
          official_measure_url: null,
          research_area_tags: [],
        },
      })
    );

    expect(await screen.findByRole("link", { name: "Enter your address" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "No" })).not.toBeInTheDocument();
  });

  it("puts the viewer's saved areas first with an sr-only cue", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/research-area-preferences": {
        body: {
          preferences: [
            { research_area_id: "a-civ", slug: "civil_rights", name: "Civil Rights", description: null, rank: 1 },
          ],
        },
      },
    });
    renderElection(() =>
      electionDetail({
        research_areas: [
          { id: "a-civ", slug: "civil_rights", name: "Civil Rights", description: null },
          { id: "a-env", slug: "environment_and_public_health", name: "Environment & Public Health", description: null },
        ],
      })
    );

    // Saved-ness arrives with the async preferences fetch; wait on the cue.
    const savedCue = await screen.findByText("(saved)");
    expect(savedCue.parentElement?.textContent).toContain("Civil Rights");
    // Saved Civil Rights outranks the globally higher-salience Environment.
    const civilRights = screen.getByText("Civil Rights");
    const environment = screen.getByText("Environment & Public Health");
    expect(civilRights.compareDocumentPosition(environment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no office section on ballot measure elections", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        // The measure's areas arrive on research_areas too; the measure
        // section owns rendering them (with stance), so the office row
        // must not duplicate the chips.
        research_areas: [
          { id: "a-1", slug: "housing_affordability", name: "Housing Affordability", description: null },
        ],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          source_urls: [],
          official_measure_url: null,
          research_area_tags: [
            { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", stance: "for" },
          ],
          results: [],
        },
      })
    );

    await screen.findByRole("heading", { name: "Ballot Measure" });
    expect(screen.queryByText("About this office")).not.toBeInTheDocument();
    expect(screen.queryByText("Affects:")).not.toBeInTheDocument();
  });

  it("defaults to my-issues order for viewers with saved areas and can switch to alphabetical", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/research-area-preferences": {
        body: {
          preferences: [
            { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", description: null, rank: 1 },
          ],
        },
      },
    });
    const detail = electionDetail();
    // Riley (second in the alphabetical payload) is the only match on the
    // viewer's saved area, so the my-issues default must lift them first.
    detail.candidates[1].records = [
      {
        id: "r-1",
        description: "A record.",
        source_url: "https://example.gov/record",
        event_date: "2025-01-15",
        created_at: "2025-02-01T00:00:00.000Z",
        research_area_tags: [
          { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", stance: "for" },
        ],
      },
    ];
    renderElection(() => detail);

    // The dropdown only renders once the async preferences arrive.
    const select = await screen.findByRole("combobox");
    expect(select).toHaveValue("my_issues");
    expect(screen.getByRole("option", { name: "My issues first" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Alphabetical" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /against my issues/i })).not.toBeInTheDocument();
    const riley = screen.getByText("Riley Runner");
    const jordan = screen.getByText("Jordan Voter");
    expect(riley.compareDocumentPosition(jordan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const user = userEvent.setup();
    await user.selectOptions(select, "alphabetical");
    expect(
      screen.getByText("Jordan Voter").compareDocumentPosition(screen.getByText("Riley Runner")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("ranks an against-only candidate above one with no relevant records under my-issues sort", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/research-area-preferences": {
        body: {
          preferences: [
            { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", description: null, rank: 1 },
          ],
        },
      },
    });
    const detail = electionDetail();
    // "My issues first" sorts by relevance, not agreement: Riley's record is
    // AGAINST the saved issue, but it is still a track record on it, so Riley
    // must outrank record-less Jordan rather than tying at zero.
    detail.candidates[1].records = [
      {
        id: "r-1",
        description: "A record.",
        source_url: "https://example.gov/record",
        event_date: "2025-01-15",
        created_at: "2025-02-01T00:00:00.000Z",
        research_area_tags: [
          { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", stance: "against" },
        ],
      },
    ];
    renderElection(() => detail);

    await screen.findByRole("combobox");
    const riley = screen.getByText("Riley Runner");
    const jordan = screen.getByText("Jordan Voter");
    expect(riley.compareDocumentPosition(jordan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders measure result rows, including election-night outcomes", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          // Canonical result unset: election-night outcomes never project it,
          // yet the rows below must still be visible.
          result: null,
          source_urls: [],
          official_measure_url: null,
          research_area_tags: [],
          results: [
            {
              id: "mr-1",
              pass_type: "election_night",
              result_status: "unofficial",
              outcome: "passed",
              source_url: "https://results.example.gov/measure-1",
              source_type: "official",
              retrieved_at: "2026-11-04T06:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(await screen.findByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("· Unofficial")).toBeInTheDocument();
    // Nothing certified yet, so the pre-certification notice applies.
    expect(screen.getByText("Unofficial until certified by the relevant election authority.")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: /results\.example\.gov/ });
    expect(source).toHaveAttribute("href", "https://results.example.gov/measure-1");
  });

  it("drops the pre-certification notice once a certified result row exists", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: "passed",
          source_urls: [],
          official_measure_url: null,
          research_area_tags: [],
          results: [
            {
              id: "mr-2",
              pass_type: "certified",
              result_status: "certified",
              outcome: "passed",
              source_url: "https://sos.example.gov/certified-results",
              source_type: "official",
              retrieved_at: "2026-12-01T06:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(await screen.findByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("· Certified")).toBeInTheDocument();
    // "Unofficial until certified" above a row labeled Certified is
    // contradictory for official election information.
    expect(
      screen.queryByText("Unofficial until certified by the relevant election authority.")
    ).not.toBeInTheDocument();
  });

  it("links the official measure text and lists the remaining measure sources", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          source_urls: [
            "https://sos.example.gov/qualified-measures",
            "https://sos.example.gov/measures/measure-1.pdf",
          ],
          official_measure_url: "https://sos.example.gov/measures/measure-1.pdf",
          research_area_tags: [],
          results: [],
        },
      })
    );

    const measureLink = await screen.findByRole("link", { name: "Read the official ballot measure (PDF)" });
    expect(measureLink).toHaveAttribute("href", "https://sos.example.gov/measures/measure-1.pdf");
    // The official URL renders only as the prominent link, not a second source line.
    expect(screen.getByRole("link", { name: "sos.example.gov" })).toHaveAttribute(
      "href",
      "https://sos.example.gov/qualified-measures"
    );
  });

  it("uses neutral wording when the measure URL is not government-hosted", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          source_urls: ["https://ballotpedia.org/Example_Measure_(2026)"],
          official_measure_url: "https://ballotpedia.org/Example_Measure_(2026)",
          research_area_tags: [],
          results: [],
        },
      })
    );

    // A third-party page must not be presented as the official measure text.
    const link = await screen.findByRole("link", { name: "More about this measure" });
    expect(link).toHaveAttribute("href", "https://ballotpedia.org/Example_Measure_(2026)");
    expect(screen.queryByRole("link", { name: /official ballot measure/ })).not.toBeInTheDocument();
  });

  it("lists every measure source when there is no official measure URL", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        race_type: "ballot_measure",
        candidates: [],
        ballot_measure: {
          id: "m-1",
          official_ballot_title: "Measure 1",
          summary: "A measure.",
          what_yes_means: "Yes approves the bond.",
          what_no_means: "No rejects the bond.",
          result: null,
          source_urls: ["https://sos.example.gov/qualified-measures", "https://news.example.org/measure-1"],
          official_measure_url: null,
          research_area_tags: [],
          results: [],
        },
      })
    );

    // Without an official URL there is no prominent link, and every source
    // gets its own provenance line (the old UI capped this at one).
    expect(await screen.findByRole("link", { name: "sos.example.gov" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "news.example.org" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /official ballot measure/ })).not.toBeInTheDocument();
  });
});

describe("ElectionPage candidate result badges", () => {
  function officeResult(overrides: Partial<ElectionDetail["results"][number]> = {}) {
    return {
      id: "r-1",
      pass_type: "election_night",
      result_status: "unofficial",
      outcome: "advanced",
      winners: [{ candidate_id: "c-1", candidate_name: "Jordan Voter", party: "Independent" }],
      source_url: "https://results.example.gov/governor",
      retrieved_at: "2026-11-04T06:00:00.000Z",
      ...overrides,
    };
  }

  /** The badge element sitting next to one candidate's name, if any. */
  function badgeElementFor(name: string): HTMLElement | null {
    const row = screen.getByRole("heading", { name }).parentElement;
    return row?.querySelector<HTMLElement>("span:not(:has(h3))") ?? null;
  }

  /** The badge text sitting next to one candidate's name, if any. */
  function badgeFor(name: string): string | null {
    return badgeElementFor(name)?.textContent ?? null;
  }

  it("marks who advanced and who did not", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ results: [officeResult()] }));

    await screen.findByRole("heading", { name: "Governor" });
    // The roster itself says who moved on — no trip to the results section.
    expect(badgeFor("Jordan Voter")).toBe("Advanced");
    expect(badgeFor("Riley Runner")).toBe("Did not advance");
  });

  it("colors the outcome green for winners and red for losers", async () => {
    // Same red as the measure "No" chip and the "A NO vote means" box: the
    // badge pair has to read at a glance, and gray registered as "no data"
    // rather than "this candidate lost".
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ results: [officeResult()] }));

    await screen.findByRole("heading", { name: "Governor" });
    expect(badgeElementFor("Jordan Voter")?.className).toContain("text-green-900");
    const loser = badgeElementFor("Riley Runner");
    expect(loser?.className).toContain("text-red-900");
    expect(loser?.className).not.toContain("text-ink-soft");
  });

  it("says Won and Lost on a general-election result", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ results: [officeResult({ outcome: "won" })] }));

    await screen.findByRole("heading", { name: "Governor" });
    expect(badgeFor("Jordan Voter")).toBe("Won");
    expect(badgeFor("Riley Runner")).toBe("Lost");
  });

  it("marks only who continues in a runoff", async () => {
    // A runoff row names who advances to the next round; it says nothing
    // about who is out, so no loser badge goes out.
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ results: [officeResult({ outcome: "runoff" })] }));

    await screen.findByRole("heading", { name: "Governor" });
    expect(badgeFor("Jordan Voter")).toBe("In runoff");
    expect(badgeFor("Riley Runner")).toBeNull();
  });

  it("badges nobody when no winner matched the roster", async () => {
    // A name-only (write-in) winner set is not exhaustive over the roster —
    // marking every listed candidate as a loser would be a false statement.
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        results: [
          officeResult({ outcome: "won", winners: [{ candidate_name: "Sam Writein" }] }),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Governor" });
    expect(badgeFor("Jordan Voter")).toBeNull();
    expect(badgeFor("Riley Runner")).toBeNull();
  });

  it("badges nobody when the winner id points outside the displayed roster", async () => {
    // A stale or filtered-out id (e.g. a withdrawn candidate dropped from the
    // payload) must not flip everyone else to losers.
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        results: [
          officeResult({
            outcome: "won",
            winners: [{ candidate_id: "c-elsewhere", candidate_name: "Sam Elsewhere" }],
          }),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Governor" });
    expect(badgeFor("Jordan Voter")).toBeNull();
    expect(badgeFor("Riley Runner")).toBeNull();
  });

  it("withholds loser badges on a partial match", async () => {
    // One winner matched, the other name-only: that second winner might be a
    // roster candidate the matcher missed, so only the confirmed winner is
    // marked and nobody is called a loser.
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({
        results: [
          officeResult({
            outcome: "advanced",
            winners: [
              { candidate_id: "c-1", candidate_name: "Jordan Voter" },
              { candidate_name: "Sam Writein" },
            ],
          }),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Governor" });
    expect(badgeFor("Jordan Voter")).toBe("Advanced");
    expect(badgeFor("Riley Runner")).toBeNull();
  });

  it("badges nobody on an undecided result", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() =>
      electionDetail({ results: [officeResult({ outcome: "too_close", winners: [] })] })
    );

    await screen.findByRole("heading", { name: "Governor" });
    expect(badgeFor("Jordan Voter")).toBeNull();
    expect(badgeFor("Riley Runner")).toBeNull();
  });

  it("keeps the candidate name out of the badge's accessible name", async () => {
    // Regression guard: an in-heading badge fused into the accessible name
    // ("Jordan VoterAdvanced").
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail({ results: [officeResult()] }));

    expect(await screen.findByRole("heading", { name: "Jordan Voter" })).toBeInTheDocument();
  });
});

describe("ElectionPage back link and nav context", () => {
  const BALLOT_BACK = { path: "/ballot?d=d-1&sort=district_size", label: "All elections" };

  it("uses the arrival context for the back link when router state validates", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail(), "e-1", { backTo: BALLOT_BACK });

    const back = await screen.findByRole("link", { name: "Back to All elections" });
    // The full query string survives the round trip.
    expect(back).toHaveAttribute("href", "/ballot?d=d-1&sort=district_size");
  });

  it.each(["back link", "browser Back"])("restores expanded retention via %s without changing fresh visits", async (returnVia) => {
    stubApiRoutes({ ...ANONYMOUS });
    const elections = [retentionElection("r-1"), retentionElection("r-2"),
      retentionElection("r-3", { election_date: "2027-11-02" }),
      retentionElection("r-4", { election_date: "2027-11-02" })];
    const { router } = renderRoutes([
      { path: "/ballot", element: <ElectionList elections={elections} backTo={{ path: "/ballot", label: "All elections" }} /> },
      { path: "/elections/:electionId", element: <ElectionPage />, hydrateFallbackElement: <p />,
        loader: () => electionDetail({ id: "r-1", official_ballot_title: elections[0].official_ballot_title }) },
    ], "/ballot");
    const groups = () => screen.getAllByRole("button", { name: "Retention Races (2)" });
    expect(groups()[0]).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(groups()[0]);
    await userEvent.click(screen.getByRole("link", { name: new RegExp(elections[0].official_ballot_title) }));
    const back = (await screen.findAllByRole("link", { name: "Back to All elections" }))[0];
    if (returnVia === "back link") await userEvent.click(back);
    else await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(groups()[0]).toHaveAttribute("aria-expanded", "true"));
    expect(groups()[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: new RegExp(elections[0].official_ballot_title) })).toBeInTheDocument();
    // Collapsing again replaces the remembered value, and a fresh list
    // navigation without state still starts with everything collapsed.
    await userEvent.click(groups()[0]);
    expect(router.state.location.state.expandedRetentionDates).toEqual([]);
    await userEvent.click(groups()[0]);
    await act(async () => { await router.navigate("/ballot", { state: null }); });
    expect(groups()[0]).toHaveAttribute("aria-expanded", "false");
  });

  it.each(["back link", "browser Back"])("remembers collapsed vote-power groups via %s", async (returnVia) => {
    stubApiRoutes({ ...ANONYMOUS });
    const elections = ["2026-11-03", "2027-11-02"].flatMap((date) =>
      Array.from({ length: 10 }, (_, i) => electionSummary({
        id: `${date}-${i}`, official_ballot_title: `Race ${date}-${i}`, election_date: date,
        vote_power: { ...VOTE_POWER_WITH_EXPLANATION, label: i === 0 ? "high" : "medium" },
      })));
    elections.push(retentionElection("r-1"), retentionElection("r-2"));
    const { router } = renderRoutes([
      { path: "/ballot", element: <ElectionList elections={elections} sort="vote_power" backTo={{ path: "/ballot", label: "All elections" }} /> },
      { path: "/elections/:electionId", element: <ElectionPage />, hydrateFallbackElement: <p />,
        loader: () => electionDetail({ id: "2026-11-03-1" }) },
    ], "/ballot");
    const highGroups = () => screen.getAllByRole("button", { name: "My vote power: High(1)" });
    const retention = () => screen.getByRole("button", { name: "Retention Races (2)" });
    expect(highGroups()[0]).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(highGroups()[0]);
    await userEvent.click(retention());
    expect(screen.queryByText("Race 2026-11-03-0")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /Race 2026-11-03-1/ }));
    const back = (await screen.findAllByRole("link", { name: "Back to All elections" }))[0];
    if (returnVia === "back link") await userEvent.click(back);
    else await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(highGroups()[0]).toHaveAttribute("aria-expanded", "false"));
    expect(highGroups()[1]).toHaveAttribute("aria-expanded", "true");
    expect(retention()).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("Race 2026-11-03-0")).not.toBeInTheDocument();
    expect(screen.getByText("Race 2027-11-02-0")).toBeInTheDocument();
    await userEvent.click(highGroups()[0]);
    expect(router.state.location.state.collapsedVotePowerGroups).toEqual([]);
    expect(retention()).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(highGroups()[0]);
    await act(async () => { await router.navigate("/ballot", { state: null }); });
    expect(highGroups()[0]).toHaveAttribute("aria-expanded", "true");
    expect(retention()).toHaveAttribute("aria-expanded", "false");
  });

  it("preserves both disclosures through the post-pick Back to elections link", async () => {
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    const elections = Array.from({ length: 10 }, (_, i) => electionSummary({
      id: `ordinary-${i}`, official_ballot_title: `Ordinary race ${i}`,
      vote_power: { ...VOTE_POWER_WITH_EXPLANATION, label: i === 0 ? "high" : "medium" },
    }));
    const retention = retentionElection("r-1");
    elections.push(retention, retentionElection("r-2"));
    const { router } = renderRoutes([
      { path: "/ballot", element: <ElectionList elections={elections} sort="vote_power"
        backTo={{ path: "/ballot?sort=vote_power", label: "All elections" }} /> },
      { path: "/elections/:electionId", element: <ElectionPage />, hydrateFallbackElement: <p />,
        loader: () => electionDetail({ id: retention.id, official_ballot_title: retention.official_ballot_title }) },
    ], "/ballot?sort=vote_power");
    const high = () => screen.getByRole("button", { name: "My vote power: High(1)" });
    const group = () => screen.getByRole("button", { name: "Retention Races (2)" });
    await userEvent.click(high());
    await userEvent.click(group());
    const listState = router.state.location.state;
    await userEvent.click(screen.getByRole("link", { name: new RegExp(retention.official_ballot_title) }));
    expect(screen.queryByRole("link", { name: "Back to elections" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Yes" }));
    await userEvent.click(await screen.findByRole("link", { name: "Back to elections" }));
    await waitFor(() => expect(group()).toHaveAttribute("aria-expanded", "true"));
    expect(high()).toHaveAttribute("aria-expanded", "false");
    expect(router.state.location.search).toBe("?sort=vote_power");
    expect(router.state.location.state).toEqual(listState);
    clearBallotDraft();
  });

  it("keeps explicit backState precedence on the post-pick link", async () => {
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    const backState = { backTo: { path: "/me/picks", label: "My Draft" } };
    const { router } = renderElection(() => electionDetail({ official_ballot_title: "Shall Judge A be retained?" }), "e-1", {
      backTo: BALLOT_BACK,
      backState,
      listState: { expandedRetentionDates: ["2026-11-03"], collapsedVotePowerGroups: ["2026-11-03:high"] },
    });
    await userEvent.click(await screen.findByRole("button", { name: "No" }));
    await userEvent.click(await screen.findByRole("link", { name: "Back to elections" }));
    expect(router.state.location.state).toEqual(backState);
    clearBallotDraft();
  });

  it("shows no nav bar on a deep link with no state", async () => {
    // Deep links (shares, search engines) have no arrival context — no bar
    // at all, by product choice.
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail());

    await screen.findByRole("heading", { name: "Governor" });
    expect(screen.queryByRole("navigation", { name: "Ballot navigation" })).not.toBeInTheDocument();
  });

  it("shows no nav bar when the stored state is malformed", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(() => electionDetail(), "e-1", {
      backTo: { path: "https://evil.example/phish", label: "All elections" },
    });

    await screen.findByRole("heading", { name: "Governor" });
    expect(screen.queryByRole("navigation", { name: "Ballot navigation" })).not.toBeInTheDocument();
  });

  it("restores a candidate page's own context when backing out to it", async () => {
    // The return half of My Picks → candidate → election → back: the back
    // link must deliver the candidate's original nav state, or a
    // multi-election candidate lands stateless and loses its back link.
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const candidateContext = { backTo: { path: "/me/picks", label: "My Picks" } };
    const { router } = renderElection(() => electionDetail(), "e-1", {
      backTo: { path: "/candidates/c-1", label: "Jordan Voter" },
      backState: candidateContext,
    });

    await user.click(await screen.findByRole("link", { name: "Back to Jordan Voter" }));

    expect(router.state.location.pathname).toBe("/candidates/c-1");
    expect(router.state.location.state).toEqual(candidateContext);
  });

  it("hands candidate links this election as back context plus the displayed roster order", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const incoming = { backTo: BALLOT_BACK, contests: [{ id: "e-1", title: "Governor" }] };
    const { router } = renderElection(() => electionDetail(), "e-1", incoming);

    await user.click(await screen.findByRole("link", { name: "Jordan Voter" }));

    expect(router.state.location.pathname).toBe("/candidates/c-1");
    expect(router.state.location.state).toEqual({
      backTo: { path: "/elections/e-1", label: "Governor" },
      // The election page's own arrival context rides along so the back
      // hop can restore it — with the roster sort in force stamped on, so
      // the return remount reopens the roster in this same order.
      backState: { ...incoming, rosterSort: "alphabetical" },
      electionId: "e-1",
      // research_area_records: the candidate rail's My-issues sort key —
      // empty here because the fixture candidates carry no records.
      candidates: [
        { id: "c-1", name: "Jordan Voter", research_area_records: [] },
        { id: "c-2", name: "Riley Runner", research_area_records: [] },
      ],
      // The roster sort in force (anonymous → alphabetical): the candidate
      // rail starts on it instead of stomping it with its own default.
      railSort: "alphabetical",
    });
  });

  it("restores a handed-back roster sort instead of the default", async () => {
    // The return half of the roster round trip: a saved-areas viewer
    // defaults to my_issues, so an explicit alphabetical choice must come
    // back from the nav state, not reset on the remount.
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/research-area-preferences": {
        body: {
          preferences: [
            { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", description: null, rank: 1 },
          ],
        },
      },
    });
    renderElection(() => electionDetail(), "e-1", {
      backTo: BALLOT_BACK,
      rosterSort: "alphabetical",
    });

    expect(await screen.findByRole("combobox")).toHaveValue("alphabetical");
  });

  it("scopes the handed-off roster order to the active party filter", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderElection(() =>
      electionDetail({
        candidates: [
          {
            candidate_id: "c-dem",
            display_name: "Dana Democrat",
            party: "Democratic",
            is_incumbent: false,
            status: "active",
            summary: null,
            finance_summary: null,
            records: [],
          },
          {
            candidate_id: "c-rep",
            display_name: "Rory Republican",
            party: "Republican",
            is_incumbent: false,
            status: "active",
            summary: null,
            finance_summary: null,
            records: [],
          },
        ],
      })
    );

    await user.click(await screen.findByRole("button", { name: "Democrats (1)" }));
    await user.click(screen.getByRole("link", { name: "Dana Democrat" }));

    const state = router.state.location.state as { candidates: unknown };
    expect(state.candidates).toEqual([
      { id: "c-dem", name: "Dana Democrat", research_area_records: [] },
    ]);
  });
});

describe("ElectionPage ballot pager", () => {
  const CONTESTS = [
    { id: "e-1", title: "Governor" },
    { id: "e-2", title: "Mayor" },
    { id: "e-3", title: "Sheriff" },
  ];
  const ARRIVAL = { backTo: { path: "/ballot?d=d-1", label: "All elections" }, contests: CONTESTS };
  // The loader answers for whatever id the pager navigates to, so a walk
  // across contests keeps rendering real pages.
  const perIdLoader = ({ params }: { params: { electionId?: string } }) =>
    electionDetail({ id: params.electionId });

  it("renders prev/next around the current contest, forwarding the walk state", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(perIdLoader, "e-2", ARRIVAL);

    const pager = await screen.findByRole("navigation", { name: "Ballot navigation" });
    expect(within(pager).getByRole("link", { name: "Previous: Governor" })).toHaveAttribute(
      "href",
      "/elections/e-1"
    );
    expect(within(pager).getByRole("link", { name: "Next: Sheriff" })).toHaveAttribute("href", "/elections/e-3");
    expect(within(pager).getByRole("link", { name: "Back to All elections" })).toHaveAttribute(
      "href",
      "/ballot?d=d-1"
    );
  });

  it("leaves the prev slot empty at the start of the sequence", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(perIdLoader, "e-1", ARRIVAL);

    const pager = await screen.findByRole("navigation", { name: "Ballot navigation" });
    expect(within(pager).queryByRole("link", { name: /^Previous:/ })).not.toBeInTheDocument();
    expect(within(pager).getByRole("link", { name: "Next: Mayor" })).toBeInTheDocument();
  });

  it("keeps paging across two consecutive next clicks", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderElection(perIdLoader, "e-1", ARRIVAL);

    await user.click(await screen.findByRole("link", { name: "Next: Mayor" }));
    // The forwarded state re-renders the pager on the next page.
    await user.click(await screen.findByRole("link", { name: "Next: Sheriff" }));

    expect(router.state.location.pathname).toBe("/elections/e-3");
    expect(router.state.location.state).toEqual(ARRIVAL);
    const pager = await screen.findByRole("navigation", { name: "Ballot navigation" });
    expect(within(pager).getByRole("link", { name: "Previous: Mayor" })).toBeInTheDocument();
    expect(within(pager).queryByRole("link", { name: /^Next:/ })).not.toBeInTheDocument();
  });

  it("shows no prev/next on a stale snapshot or a single-contest list", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    // Current election missing from the snapshot (stale filtered list).
    renderElection(perIdLoader, "e-9", { ...ARRIVAL });
    await screen.findByRole("heading", { name: "Governor" });
    let pager = screen.getByRole("navigation", { name: "Ballot navigation" });
    expect(within(pager).getByRole("link", { name: "Back to All elections" })).toBeInTheDocument();
    expect(within(pager).queryByRole("link", { name: /^(Previous|Next):/ })).not.toBeInTheDocument();

    renderElection(perIdLoader, "e-2", {
      backTo: ARRIVAL.backTo,
      contests: [{ id: "e-2", title: "Mayor" }],
    });
    await waitFor(() =>
      expect(screen.getAllByRole("navigation", { name: "Ballot navigation" })).toHaveLength(2)
    );
    pager = screen.getAllByRole("navigation", { name: "Ballot navigation" })[1];
    expect(within(pager).queryByRole("link", { name: /^(Previous|Next):/ })).not.toBeInTheDocument();
  });
});

// The desktop split-screen rail (aria-label "Ballot", vs the pager's "Ballot
// navigation" — distinct names because both are in the DOM and CSS decides
// which is visible per viewport). Same gate as prev/next: a validated
// sequence containing the current election.
describe("ElectionPage ballot rail", () => {
  const CONTESTS = [
    { id: "e-1", title: "Governor" },
    { id: "e-2", title: "Mayor" },
    { id: "e-3", title: "Sheriff" },
  ];
  const ARRIVAL = { backTo: { path: "/ballot?d=d-1", label: "All elections" }, contests: CONTESTS };
  const perIdLoader = ({ params }: { params: { electionId?: string } }) =>
    electionDetail({ id: params.electionId });

  it("renders the ballot sequence with the current contest highlighted, not linked", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(perIdLoader, "e-2", ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    expect(within(rail).getByRole("link", { name: "Governor" })).toHaveAttribute("href", "/elections/e-1");
    expect(within(rail).getByRole("link", { name: "Sheriff" })).toHaveAttribute("href", "/elections/e-3");
    // The current contest is text with aria-current, not a link.
    expect(within(rail).queryByRole("link", { name: "Mayor" })).not.toBeInTheDocument();
    expect(within(rail).getByText("Mayor").closest("li")).toHaveAttribute("aria-current", "page");
    // The exit control: same destination and state contract as the pager's
    // back slot.
    expect(within(rail).getByRole("link", { name: "Back to All elections" })).toHaveAttribute(
      "href",
      "/ballot?d=d-1"
    );
  });

  it("keeps the rail through a sibling walk, forwarding the arrival state verbatim", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderElection(perIdLoader, "e-2", ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    await user.click(within(rail).getByRole("link", { name: "Sheriff" }));

    expect(router.state.location.pathname).toBe("/elections/e-3");
    expect(router.state.location.state).toEqual(ARRIVAL);
    // The next page re-renders the rail with the new current entry. The rail
    // element survives the navigation, so retry until the re-render lands.
    await waitFor(() => {
      const nextRail = screen.getByRole("navigation", { name: "Ballot" });
      expect(within(nextRail).getByText("Sheriff").closest("li")).toHaveAttribute("aria-current", "page");
      expect(within(nextRail).getByRole("link", { name: "Mayor" })).toHaveAttribute("href", "/elections/e-2");
    });
  });

  it("renders no rail on deep links or stale snapshots (pager rules apply)", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    // Deep link: no router state at all.
    renderElection(perIdLoader, "e-1");
    await screen.findByRole("heading", { name: "Governor" });
    expect(screen.queryByRole("navigation", { name: "Ballot" })).not.toBeInTheDocument();

    // Stale snapshot: current election missing from the sequence — the back
    // bar survives (its own gate), the rail does not.
    renderElection(perIdLoader, "e-9", { ...ARRIVAL });
    await waitFor(() =>
      expect(screen.getAllByRole("navigation", { name: "Ballot navigation" })).toHaveLength(1)
    );
    expect(screen.queryByRole("navigation", { name: "Ballot" })).not.toBeInTheDocument();
  });

  it("offers no race-type tabs on an untyped (pre-deploy) snapshot", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(perIdLoader, "e-2", ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    expect(within(rail).queryByRole("button", { name: "Ballot Measures" })).not.toBeInTheDocument();
  });
});

// The rail's own race-type tabs: available only when the snapshot types
// every contest and holds both types. The tab starts on the list's engaged
// tab (raceType), re-slices the rail in place, and travels with sibling
// walks and the back link.
describe("ElectionPage ballot rail race-type tabs", () => {
  // A guest draft left by earlier tests' pick clicks would mark rail rows
  // decided and suffix their accessible names. Reset through the module so
  // its in-memory snapshot clears too, not just localStorage.
  beforeEach(() => {
    clearBallotDraft();
  });

  const TYPED_CONTESTS = [
    { id: "e-1", title: "Governor", race_type: "office" },
    { id: "q-1", title: "Measure A", race_type: "ballot_measure" },
    { id: "e-2", title: "Mayor", race_type: "office" },
    { id: "q-2", title: "Measure B", race_type: "ballot_measure" },
  ];
  const ARRIVAL_ON_MEASURES = {
    backTo: { path: "/ballot?d=d-1&type=ballot_measure", label: "All elections" },
    contests: TYPED_CONTESTS,
    raceType: "ballot_measure",
  };
  const perIdLoader = ({ params }: { params: { electionId?: string } }) =>
    electionDetail({ id: params.electionId });

  it("starts on the arrival tab: rail sliced, tab pressed, back link untouched", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(perIdLoader, "q-1", ARRIVAL_ON_MEASURES);

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    expect(within(rail).getByRole("button", { name: "Ballot Measures" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(within(rail).getByText("Measure A").closest("li")).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("link", { name: "Measure B" })).toBeInTheDocument();
    expect(within(rail).queryByText("Governor")).not.toBeInTheDocument();
    expect(within(rail).queryByText("Mayor")).not.toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Back to All elections" })).toHaveAttribute(
      "href",
      "/ballot?d=d-1&type=ballot_measure"
    );
  });

  it("slices the pager's prev/next to the engaged tab", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(perIdLoader, "q-1", ARRIVAL_ON_MEASURES);

    // Measure B is next IN THE SLICE — the office races between them in the
    // full sequence must be stepped over, not visited.
    const pager = await screen.findByRole("navigation", { name: "Ballot navigation" });
    expect(within(pager).getByRole("link", { name: "Next: Measure B" })).toHaveAttribute(
      "href",
      "/elections/q-2"
    );
    expect(within(pager).queryByRole("link", { name: /^Previous:/ })).not.toBeInTheDocument();
  });

  it("switching to All restores every contest and rewrites the back link", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    renderElection(perIdLoader, "q-1", ARRIVAL_ON_MEASURES);

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    await user.click(within(rail).getByRole("button", { name: "All" }));

    expect(within(rail).getByRole("link", { name: "Governor" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Mayor" })).toBeInTheDocument();
    expect(within(rail).getByText("Measure A").closest("li")).toHaveAttribute("aria-current", "page");
    // Leaving the split view must land on the tab the rail is showing.
    expect(within(rail).getByRole("link", { name: "Back to All elections" })).toHaveAttribute(
      "href",
      "/ballot?d=d-1"
    );
  });

  it("forwards the switched tab to sibling walks", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderElection(perIdLoader, "q-1", ARRIVAL_ON_MEASURES);

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    await user.click(within(rail).getByRole("button", { name: "Offices" }));
    await user.click(within(rail).getByRole("link", { name: "Governor" }));

    expect(router.state.location.pathname).toBe("/elections/e-1");
    // Forwarded state: the switched tab, but the ORIGINAL back destination —
    // the rewrite happens at render time so "All" can always restore it.
    expect(router.state.location.state).toEqual({
      ...ARRIVAL_ON_MEASURES,
      raceType: "office",
    });
    // Wait for the DESTINATION page's render, not just any rail: the
    // pre-navigation DOM also has a Ballot rail with Candidates pressed
    // (the click set it), so asserting immediately races the loader — the
    // aria-current flip below is the first signal unique to the new page.
    await waitFor(() => {
      expect(
        within(screen.getByRole("navigation", { name: "Ballot" })).getByText("Governor").closest("li")
      ).toHaveAttribute("aria-current", "page");
    });
    const nextRail = screen.getByRole("navigation", { name: "Ballot" });
    expect(within(nextRail).getByRole("button", { name: "Offices" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(within(nextRail).queryByText("Measure B")).not.toBeInTheDocument();
    // The rendered back link still lands on the switched tab — recomputed
    // from the forwarded original, not baked into it.
    expect(within(nextRail).getByRole("link", { name: "Back to All elections" })).toHaveAttribute(
      "href",
      "/ballot?d=d-1&type=office"
    );
  });

  it("keeps the rail up when the current race is on the other tab", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    renderElection(perIdLoader, "q-1", ARRIVAL_ON_MEASURES);

    // Viewing Measure A, switch to Candidates: the current row leaves the
    // slice (the detail page itself marks the reader's place) but the rail
    // must not tear down.
    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    await user.click(within(rail).getByRole("button", { name: "Offices" }));

    expect(within(rail).queryByText("Measure A")).not.toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Governor" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Mayor" })).toBeInTheDocument();
  });
});

// The rail's sort control (under the tabs) and its pick checks. Sort keys
// ride the snapshot; the sort is offered only when every entry carries them.
describe("ElectionPage ballot rail sort and pick checks", () => {
  beforeEach(() => {
    clearBallotDraft();
  });

  const KEYED_CONTESTS = [
    {
      id: "e-1",
      title: "Governor",
      race_type: "office",
      vote_power_score: 10,
      election_date: "2026-11-03",
      research_area_ids: [],
    },
    {
      id: "e-2",
      title: "Proposition 33",
      race_type: "ballot_measure",
      vote_power_score: 50,
      election_date: "2026-11-03",
      research_area_ids: [],
    },
    {
      id: "e-3",
      title: "Proposition 4",
      race_type: "ballot_measure",
      vote_power_score: 30,
      election_date: "2026-11-03",
      research_area_ids: [],
    },
  ];
  const ARRIVAL = { backTo: { path: "/me/ballot", label: "My Elections" }, contests: KEYED_CONTESTS };
  // A verified viewer with saved research areas — the only viewer the rail
  // offers my_areas to, the one list sort besides vote_power it can carry
  // back to the list.
  const SAVED_AREAS = {
    "/api/me": { body: ME_VERIFIED },
    "/api/me/districts": { body: MY_DISTRICTS },
    "/api/me/candidate-follows": { body: { follows: [] } },
    "/api/me/election-choices": { body: { choices: [] } },
    "/api/me/auto-picks": { body: { results: [] } },
    "/api/me/research-area-preferences": {
      body: {
        preferences: [{ research_area_id: "a-1", slug: "housing", name: "Housing", description: null, rank: 1 }],
      },
    },
  };
  const perIdLoader = ({ params }: { params: { electionId?: string } }) =>
    electionDetail({ id: params.electionId });

  it("engages the default sort on arrival and rewrites the back link only for a real change", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    renderElection(perIdLoader, "e-1", ARRIVAL);

    // No "As listed": with no seed in the snapshot the rail defaults to
    // vote_power and arrives already sorted — and since that's also what
    // the back URL yields, the URL is NOT rewritten.
    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    const rows = () => within(rail).getAllByRole("listitem").map((row) => row.textContent);
    const select = await within(rail).findByRole("combobox");
    expect(select).toHaveValue("vote_power");
    expect(within(select).queryByRole("option", { name: "As listed" })).not.toBeInTheDocument();
    expect(rows()).toEqual(["Proposition 33", "Proposition 4", "Governor"]);
    expect(within(rail).getByRole("link", { name: "Back to My Elections" })).toHaveAttribute(
      "href",
      "/me/ballot"
    );

    // A–Z is numeric-aware and rail-only: no ?sort= carry-over.
    await user.selectOptions(select, "alphabetical");
    expect(rows()).toEqual(["Governor", "Proposition 4", "Proposition 33"]);
    expect(within(rail).getByRole("link", { name: "Back to My Elections" })).toHaveAttribute(
      "href",
      "/me/ballot"
    );
  });

  it("starts on the seeded list sort and preserves a district-size back URL", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(perIdLoader, "e-1", {
      // A district-size list: the rail cannot honor that order, so the
      // seed falls back to vote_power (stamped by the list page) — but the
      // back URL must keep the richer sort the rail merely approximates.
      backTo: { path: "/me/ballot?sort=district_size", label: "My Elections" },
      contests: KEYED_CONTESTS,
      railSort: "vote_power",
    });

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    expect(await within(rail).findByRole("combobox")).toHaveValue("vote_power");
    expect(within(rail).getByRole("link", { name: "Back to My Elections" })).toHaveAttribute(
      "href",
      "/me/ballot?sort=district_size"
    );
  });

  it("seeds a pre-railSort snapshot from the back URL's sort without rewriting it", async () => {
    stubApiRoutes({ ...SAVED_AREAS });
    renderElection(perIdLoader, "e-1", {
      // Keyed contests but NO railSort stamp — a history entry from the
      // deploy before the stamp existed. Defaulting to vote_power here
      // would silently rewrite the sort=my_areas back link; the seed must
      // come from the URL instead.
      backTo: { path: "/me/ballot?sort=my_areas", label: "My Elections" },
      contests: KEYED_CONTESTS,
    });

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    expect(await within(rail).findByRole("combobox")).toHaveValue("my_areas");
    expect(within(rail).getByRole("link", { name: "Back to My Elections" })).toHaveAttribute(
      "href",
      "/me/ballot?sort=my_areas"
    );
  });

  it("keeps the engaged sort and its rewrite through a sibling walk", async () => {
    stubApiRoutes({ ...SAVED_AREAS });
    const user = userEvent.setup();
    renderElection(perIdLoader, "e-1", ARRIVAL);

    // A genuinely different list sort carries over to the back link.
    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    await user.selectOptions(await within(rail).findByRole("combobox"), "my_areas");
    expect(within(rail).getByRole("link", { name: "Back to My Elections" })).toHaveAttribute(
      "href",
      "/me/ballot?sort=my_areas"
    );
    await user.click(within(rail).getByRole("link", { name: "Proposition 33" }));

    const nextRail = await screen.findByRole("navigation", { name: "Ballot" });
    expect(await within(nextRail).findByRole("combobox")).toHaveValue("my_areas");
    expect(within(nextRail).getByRole("link", { name: "Back to My Elections" })).toHaveAttribute(
      "href",
      "/me/ballot?sort=my_areas"
    );
  });

  it("offers no sort control on an unkeyed (pre-deploy) snapshot", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderElection(perIdLoader, "e-1", {
      backTo: ARRIVAL.backTo,
      contests: KEYED_CONTESTS.map(({ id, title, race_type }) => ({ id, title, race_type })),
    });

    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    expect(within(rail).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("marks decided races with the check and an accessible suffix", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    // Guest pick in the local draft — the same source the ballot cards use.
    setDraftCandidateChoice({
      electionId: "e-3",
      raceTitle: "Proposition 4",
      electionDate: "2026-11-03",
      seatsToFill: null,
      candidateId: "c-1",
      candidateName: "Jordan Voter",
      chosen: true,
    });
    renderElection(perIdLoader, "e-1", ARRIVAL);

    // waitFor: the guest draft becomes the choice source only once /api/me
    // resolves to "no session".
    const rail = await screen.findByRole("navigation", { name: "Ballot" });
    await waitFor(() =>
      expect(within(rail).getByTitle("Proposition 4")).toHaveTextContent("(decided)")
    );
    expect(within(rail).getByTitle("Proposition 4").querySelector("svg")).not.toBeNull();
    // Undecided rows keep their plain label and no check.
    const plainRow = within(rail).getByTitle("Proposition 33");
    expect(plainRow).not.toHaveTextContent("(decided)");
    expect(plainRow.querySelector("svg")).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CandidatePage, ErrorBoundary, loader } from "./CandidatePage";
import { clearBallotDraft, readBallotDraft, setDraftBallotContext, setDraftCandidateChoice } from "../lib/ballotDraft";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import {
  candidateDetail,
  candidateElection,
  candidateFollow,
  DISTRICT,
  financeSummary,
  ME_UNVERIFIED,
  ME_VERIFIED,
  MY_DISTRICTS,
} from "../test/fixtures";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

// The subject arrives via the route loader (server-fetched in production);
// tests supply it directly instead of stubbing the loader's fetch.
// `state` simulates arriving with nav context (see detailNavContext.ts).
function renderCandidate(
  loader: (args: { params: { candidateId?: string } }) => unknown,
  id = "c-1",
  state?: unknown
) {
  return renderRoutes(
    [
      {
        path: "/candidates/:candidateId",
        element: <CandidatePage />,
        errorElement: <ErrorBoundary />,
        hydrateFallbackElement: <p />,
        loader,
      },
      { path: "/elections/:electionId", element: <p /> },
    ],
    state === undefined ? `/candidates/${id}` : { pathname: `/candidates/${id}`, state }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CandidatePage", () => {
  it("renders not-found UI when the loader throws a 404", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => {
      throw new Response("Not Found", { status: 404 });
    }, "c-missing");
    expect(await screen.findByText("Candidate not found")).toBeInTheDocument();
  });

  it("renders the profile with records grouped under their research area", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail());

    expect(await screen.findByRole("heading", { name: "Jordan Voter" })).toBeInTheDocument();
    expect(screen.getByText("Voted for the clean water act.")).toBeInTheDocument();
    // The record's area tag names the group heading.
    expect(screen.getByText("Environment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Report an issue with candidate profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Report an issue with candidate record" })).toBeInTheDocument();
  });

  it("links the official website, X, and LinkedIn when the profile has them", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        official_website_url: "https://jordan.example",
        twitter_handle: "jordan_voter",
        linkedin_url: "https://www.linkedin.com/in/jordan-voter",
      })
    );

    expect(await screen.findByRole("link", { name: "Official website" })).toHaveAttribute(
      "href",
      "https://jordan.example"
    );
    expect(screen.getByRole("link", { name: "X (Twitter)" })).toHaveAttribute("href", "https://x.com/jordan_voter");
    expect(screen.getByRole("link", { name: "LinkedIn" })).toHaveAttribute(
      "href",
      "https://www.linkedin.com/in/jordan-voter"
    );
  });

  it("shows only the profile links that exist", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ twitter_handle: "jordan_voter" }));

    expect(await screen.findByRole("link", { name: "X (Twitter)" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Official website" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "LinkedIn" })).not.toBeInTheDocument();
  });

  it("starts every issue group collapsed, each stating its record count", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const record = (id: string, areaId: string, areaName: string) => ({
      id,
      description: `Did a thing (${id}).`,
      source_url: "https://example.gov/record",
      event_date: "2026-05-01",
      created_at: "2026-05-02T00:00:00.000Z",
      research_area_tags: [{ research_area_id: areaId, slug: areaId, name: areaName, stance: "for" as const }],
    });
    renderCandidate(() =>
      candidateDetail({
        records: [
          record("r-1", "a-1", "Civil Rights"),
          record("r-2", "a-2", "Gun Control"),
          record("r-3", "a-3", "Housing"),
          record("r-4", "a-4", "Privacy"),
        ],
      })
    );

    const groupState = (name: string) =>
      (screen.getByText(name).closest("details") as HTMLDetailsElement).open;
    expect(await screen.findByText("Civil Rights")).toBeInTheDocument();
    // Test slugs (a-1…a-4) sit outside the salience ranking, so the groups
    // fall back to alphabetical: Civil Rights, Gun Control, Housing, Privacy.
    expect(groupState("Civil Rights")).toBe(false);
    expect(groupState("Gun Control")).toBe(false);
    expect(groupState("Housing")).toBe(false);
    expect(groupState("Privacy")).toBe(false);
    // Collapsed groups still state their size, so the closed profile reads
    // as an index of which issues carry a record. Every record here has a
    // stance, so the tally IS the size — no separate "1 record" count.
    expect(screen.getAllByText("· 1 support")).toHaveLength(4);
    expect(screen.queryByText("· 1 record")).not.toBeInTheDocument();
    // The group heading sits OUTSIDE the disclosure (a heading inside
    // <summary> can drop out of screen-reader heading navigation), same
    // pattern as the campaign-finance section.
    const heading = screen.getByRole("heading", { level: 3, name: "Track record — Civil Rights" });
    expect(heading.closest("details")).toBeNull();
  });

  it("tallies each collapsed group's support/oppose split for that group's own area", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const record = (
      id: string,
      tags: { areaId: string; slug: string; name: string; stance: "for" | "against" | null }[]
    ) => ({
      id,
      description: `Did a thing (${id}).`,
      source_url: "https://example.gov/record",
      event_date: "2026-05-01",
      created_at: "2026-05-02T00:00:00.000Z",
      research_area_tags: tags.map((tag) => ({
        research_area_id: tag.areaId,
        slug: tag.slug,
        name: tag.name,
        stance: tag.stance,
      })),
    });
    const gun = (stance: "for" | "against" | null) => ({
      areaId: "a-gun",
      slug: "gun_control",
      name: "Gun Control",
      stance,
    });
    const gunRecord = (id: string, stance: "for" | "against" | null) => record(id, [gun(stance)]);
    renderCandidate(() =>
      candidateDetail({
        records: [
          gunRecord("r-1", "for"),
          gunRecord("r-2", "for"),
          gunRecord("r-3", "against"),
          // Neutral counts toward neither side, so the split need not sum to
          // the record count.
          gunRecord("r-4", null),
          // A record can lean the other way in a second area — that stance
          // belongs to the housing group, not the gun-control tally.
          record("r-5", [
            gun("for"),
            { areaId: "a-hou", slug: "housing_affordability", name: "Housing Affordability", stance: "against" },
          ]),
          // Judicial evaluative areas grade the evidence, so they read
          // favorable/unfavorable, matching the cards inside.
          record("r-6", [
            { areaId: "a-imp", slug: "impartiality", name: "Impartiality", stance: "against" },
          ]),
        ],
      })
    );

    const summaryText = (name: string) =>
      (screen.getByText(name).closest("details") as HTMLDetailsElement).querySelector("summary")
        ?.textContent;
    expect(await screen.findByText("Gun Control")).toBeInTheDocument();
    // r-4 is neutral, so the split (3/1) sums to less than the 5 records.
    expect(summaryText("Gun Control")).toContain("· 5 records");
    expect(summaryText("Gun Control")).toContain("· 3 support");
    expect(summaryText("Gun Control")).toContain("· 1 oppose");
    // Housing has no supporting record; a "0 support" would be pure noise.
    // Its one record is the one oppose, so the total is dropped too.
    expect(summaryText("Housing Affordability")).toContain("· 1 oppose");
    expect(summaryText("Housing Affordability")).not.toContain("support");
    expect(summaryText("Housing Affordability")).not.toContain("record");
    expect(summaryText("Impartiality")).toContain("· 1 unfavorable");
  });

  describe("stance summary boxes", () => {
    const record = (
      id: string,
      tags: { areaId: string; slug: string; name: string; stance: "for" | "against" | null }[]
    ) => ({
      id,
      description: `Did a thing (${id}).`,
      source_url: "https://example.gov/record",
      event_date: "2026-05-01",
      created_at: "2026-05-02T00:00:00.000Z",
      research_area_tags: tags.map((tag) => ({
        research_area_id: tag.areaId,
        slug: tag.slug,
        name: tag.name,
        stance: tag.stance,
      })),
    });
    // A box is its heading's enclosing div; textContent covers the area list.
    const boxText = (heading: string) =>
      screen.getByRole("heading", { name: heading }).closest("div")?.textContent;

    it("classifies areas into supports, opposes, and mixed with their counts", async () => {
      stubApiRoutes({ ...ANONYMOUS });
      renderCandidate(() =>
        candidateDetail({
          records: [
            record("r-1", [{ areaId: "a-hc", slug: "healthcare_affordability", name: "Healthcare Affordability", stance: "for" }]),
            record("r-2", [{ areaId: "a-hc", slug: "healthcare_affordability", name: "Healthcare Affordability", stance: "for" }]),
            record("r-3", [{ areaId: "a-env", slug: "environment_and_public_health", name: "Environment and Public Health", stance: "against" }]),
            record("r-4", [{ areaId: "a-gun", slug: "gun_control", name: "Gun Control", stance: "for" }]),
            record("r-5", [{ areaId: "a-gun", slug: "gun_control", name: "Gun Control", stance: "against" }]),
          ],
        })
      );

      await screen.findByRole("heading", { name: "Jordan Voter" });
      // The section is reachable by heading navigation under the candidate's
      // name; the visible lead-in stays aria-hidden (it repeats the heading).
      expect(
        screen.getByRole("heading", { level: 2, name: "Where Jordan Voter stands, based on their records" })
      ).toBeInTheDocument();
      expect(boxText("Supports")).toContain("Healthcare Affordability (2 records)");
      expect(boxText("Opposes")).toContain("Environment and Public Health (1 record)");
      // A split never majority-collapses — it lands in Mixed with both
      // counts, in the record-group headers' phrasing.
      expect(boxText("Mixed record")).toContain("Gun Control (1 support · 1 oppose)");
      expect(boxText("Supports")).not.toContain("Gun Control");
      expect(boxText("Opposes")).not.toContain("Gun Control");
    });

    it("orders areas within a box by public salience, not payload order", async () => {
      stubApiRoutes({ ...ANONYMOUS });
      renderCandidate(() =>
        candidateDetail({
          records: [
            // Payload leads with the lower-salience area; the box must not.
            record("r-1", [{ areaId: "a-gun", slug: "gun_control", name: "Gun Control", stance: "for" }]),
            record("r-2", [{ areaId: "a-hc", slug: "healthcare_affordability", name: "Healthcare Affordability", stance: "for" }]),
          ],
        })
      );

      await screen.findByRole("heading", { name: "Jordan Voter" });
      const text = boxText("Supports") ?? "";
      expect(text.indexOf("Healthcare Affordability")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Healthcare Affordability")).toBeLessThan(text.indexOf("Gun Control"));
    });

    it("excludes evaluative areas even when they carry stances", async () => {
      stubApiRoutes({ ...ANONYMOUS });
      renderCandidate(() =>
        candidateDetail({
          records: [
            record("r-1", [
              { areaId: "a-comp", slug: "legal_competence", name: "Legal Competence", stance: "for" },
              { areaId: "a-hou", slug: "housing_affordability", name: "Housing Affordability", stance: "for" },
            ]),
            record("r-2", [{ areaId: "a-imp", slug: "impartiality", name: "Impartiality", stance: "against" }]),
          ],
        })
      );

      await screen.findByRole("heading", { name: "Jordan Voter" });
      // "Supports Legal Competence" would state advocacy the evidence-grading
      // stance never claimed; only the advocacy area surfaces.
      expect(boxText("Supports")).toContain("Housing Affordability (1 record)");
      expect(boxText("Supports")).not.toContain("Legal Competence");
      expect(screen.queryByRole("heading", { name: "Opposes" })).not.toBeInTheDocument();
    });

    it("renders no summary at all without stance-bearing records", async () => {
      stubApiRoutes({ ...ANONYMOUS });
      renderCandidate(() =>
        candidateDetail({
          records: [
            // Relevance-only tag (null stance) and an untagged record: no
            // position is claimed anywhere, so no boxes and no lead-in.
            record("r-1", [{ areaId: "a-ie", slug: "integrity_and_ethics", name: "Candidate Ethics", stance: null }]),
            record("r-2", []),
          ],
        })
      );

      await screen.findByRole("heading", { name: "Jordan Voter" });
      expect(screen.queryByRole("heading", { name: "Supports" })).not.toBeInTheDocument();
      expect(screen.queryByText("Where they stand, based on their records:")).not.toBeInTheDocument();
    });

    it("renders only the populated side, never an empty counterpart box", async () => {
      stubApiRoutes({ ...ANONYMOUS });
      renderCandidate(() =>
        candidateDetail({
          records: [record("r-1", [{ areaId: "a-gun", slug: "gun_control", name: "Gun Control", stance: "against" }])],
        })
      );

      await screen.findByRole("heading", { name: "Jordan Voter" });
      expect(boxText("Opposes")).toContain("Gun Control (1 record)");
      expect(screen.queryByRole("heading", { name: "Supports" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Mixed record" })).not.toBeInTheDocument();
    });

    it("counts a record once per tagged area, each side from its own tag", async () => {
      stubApiRoutes({ ...ANONYMOUS });
      renderCandidate(() =>
        candidateDetail({
          records: [
            // One record, for one area and against another — it lands in
            // both boxes, once each (per-area tallies, like the group
            // headers).
            record("r-1", [
              { areaId: "a-hou", slug: "housing_affordability", name: "Housing Affordability", stance: "for" },
              { areaId: "a-env", slug: "environment_and_public_health", name: "Environment and Public Health", stance: "against" },
            ]),
          ],
        })
      );

      await screen.findByRole("heading", { name: "Jordan Voter" });
      expect(boxText("Supports")).toContain("Housing Affordability (1 record)");
      expect(boxText("Opposes")).toContain("Environment and Public Health (1 record)");
    });

    it("leads with the viewer's saved areas, bolded, in the my-issues view", async () => {
      stubApiRoutes({
        "/api/me": { body: ME_VERIFIED },
        "/api/me/districts": { body: MY_DISTRICTS },
        "/api/me/candidate-follows": { body: { follows: [] } },
        "/api/me/research-area-preferences": {
          body: {
            preferences: [
              { research_area_id: "a-gun", slug: "gun_control", name: "Gun Control", description: null, rank: 1 },
            ],
          },
        },
      });
      renderCandidate(() =>
        candidateDetail({
          records: [
            record("r-1", [{ areaId: "a-hc", slug: "healthcare_affordability", name: "Healthcare Affordability", stance: "for" }]),
            record("r-2", [{ areaId: "a-gun", slug: "gun_control", name: "Gun Control", stance: "for" }]),
            record("r-3", [{ areaId: "a-mix", slug: "housing_affordability", name: "Housing Affordability", stance: "for" }]),
          ],
        })
      );

      // Saved areas load async; the personalized order applies once they
      // arrive. Saved Gun Control then leads despite Healthcare outranking
      // it publicly; the unsaved rest keep salience order.
      await waitFor(() => {
        const text = boxText("Supports") ?? "";
        expect(text.indexOf("Gun Control")).toBeLessThan(text.indexOf("Healthcare Affordability"));
      });
      const text = boxText("Supports") ?? "";
      expect(text.indexOf("Healthcare Affordability")).toBeLessThan(text.indexOf("Housing Affordability"));
      // Only the saved area's name-and-count node is emphasized (the box
      // heading has its own font-semibold, hence the `p` scope).
      const supportsBox = screen.getByRole("heading", { name: "Supports" }).closest("div") as HTMLElement;
      const bolded = [...supportsBox.querySelectorAll("p .font-semibold")].map((el) => el.textContent);
      expect(bolded).toEqual(["Gun Control (1 record)"]);
      // Purple is the saved-issue color on every surface.
      expect(supportsBox.querySelector("p .font-semibold")?.className).toContain("text-purple-800");
    });

    it("caps each box at three issues and expands the rest in place", async () => {
      stubApiRoutes({ ...ANONYMOUS });
      renderCandidate(() =>
        candidateDetail({
          records: [
            record("r-1", [{ areaId: "a-1", slug: "healthcare_affordability", name: "Healthcare Affordability", stance: "for" }]),
            record("r-2", [{ areaId: "a-2", slug: "gun_control", name: "Gun Control", stance: "for" }]),
            record("r-3", [{ areaId: "a-3", slug: "housing_affordability", name: "Housing Affordability", stance: "for" }]),
            record("r-4", [{ areaId: "a-4", slug: "data_privacy", name: "Data Privacy", stance: "for" }]),
          ],
        })
      );

      await screen.findByRole("heading", { name: "Jordan Voter" });
      const supportsBox = screen.getByRole("heading", { name: "Supports" }).closest("div") as HTMLElement;
      expect(boxText("Supports")).not.toContain("Data Privacy");
      await userEvent.click(within(supportsBox).getByRole("button", { name: "+1 more issues" }));
      expect(boxText("Supports")).toContain("Data Privacy (1 record)");
      expect(within(supportsBox).getByRole("button", { name: "Show less" })).toBeInTheDocument();
    });
  });

  it("orders issue groups by public salience with untagged records last", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const record = (id: string, tags: { areaId: string; slug: string; name: string }[]) => ({
      id,
      description: `Did a thing (${id}).`,
      source_url: "https://example.gov/record",
      event_date: "2026-05-01",
      created_at: "2026-05-02T00:00:00.000Z",
      research_area_tags: tags.map((tag) => ({
        research_area_id: tag.areaId,
        slug: tag.slug,
        name: tag.name,
        stance: "for" as const,
      })),
    });
    renderCandidate(() =>
      candidateDetail({
        records: [
          // Payload arrives alphabetical-ish; salience rank must win, with
          // the untagged record's synthetic General group sinking to the end.
          record("r-1", [{ areaId: "a-civ", slug: "civil_rights", name: "Civil Rights" }]),
          record("r-2", []),
          record("r-3", [{ areaId: "a-env", slug: "environment_and_public_health", name: "Environment and Public Health" }]),
          record("r-4", [{ areaId: "a-gun", slug: "gun_control", name: "Gun Control" }]),
        ],
      })
    );

    await screen.findByText("Civil Rights");
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      // The stance summary's box heading renders above the record groups
      // (all four stance-bearing records here are "for").
      "Supports",
      "Track record — Environment and Public Health",
      "Track record — Gun Control",
      "Track record — Civil Rights",
      "Track record — General",
    ]);
  });

  it("folds untagged records into the real General group instead of a separate bucket", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const record = (id: string, tags: { areaId: string; slug: string; name: string }[]) => ({
      id,
      description: `Did a thing (${id}).`,
      source_url: "https://example.gov/record",
      event_date: "2026-05-01",
      created_at: "2026-05-02T00:00:00.000Z",
      research_area_tags: tags.map((tag) => ({ research_area_id: tag.areaId, slug: tag.slug, name: tag.name, stance: null })),
    });
    renderCandidate(() =>
      candidateDetail({
        records: [
          // Payload order is newest-first; the untagged record sits between
          // two General-tagged ones and must stay there after the merge.
          record("r-1", [{ areaId: "a-gen", slug: "general", name: "General" }]),
          record("r-2", []),
          record("r-3", [{ areaId: "a-gen", slug: "general", name: "General" }]),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Track record" });
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Track record — General"]);
    expect(screen.queryByText(/Other records/)).not.toBeInTheDocument();
    // All three sit inside the one General group, in payload order.
    const group = screen.getByText("General").closest("details") as HTMLElement;
    const shown = [...group.querySelectorAll("li")].map((li) => li.textContent?.match(/\(r-\d\)/)?.[0]);
    expect(shown).toEqual(["(r-1)", "(r-2)", "(r-3)"]);
  });

  it("defaults the record view to \"My issues first\" and personalizes once saved areas load", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/research-area-preferences": {
        body: {
          preferences: [
            { research_area_id: "a-gun", slug: "gun_control", name: "Gun Control", description: null, rank: 1 },
          ],
        },
      },
    });
    const record = (id: string, areaId: string, slug: string, name: string) => ({
      id,
      description: `Did a thing (${id}).`,
      source_url: "https://example.gov/record",
      event_date: "2026-05-01",
      created_at: "2026-05-02T00:00:00.000Z",
      research_area_tags: [{ research_area_id: areaId, slug, name, stance: "for" as const }],
    });
    renderCandidate(() =>
      candidateDetail({
        records: [
          record("r-1", "a-env", "environment_and_public_health", "Environment and Public Health"),
          record("r-2", "a-gun", "gun_control", "Gun Control"),
        ],
      })
    );

    // "My issues first" is the default view; saved areas load async, and
    // once they arrive the saved Gun Control group leads even though
    // Environment outranks it publicly.
    const select = await screen.findByRole("combobox");
    expect(select).toHaveValue("my_issues");
    await waitFor(() => {
      const headings = screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent);
      expect(headings).toEqual([
        // "Supports" is the stance summary's box heading; the group reorder
        // under test only concerns the Track record headings below it.
        "Supports",
        "Track record — Gun Control",
        "Track record — Environment and Public Health",
      ]);
    });
  });

  it("collapses campaign finance by default while keeping it in the DOM", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => ({
      ...candidateDetail({ elections: [candidateElection()] }),
      ongoing_finance: { "ce-1": financeSummary() },
    }));

    const heading = await screen.findByRole("heading", { name: "Campaign Finance Information — Governor" });
    // The heading sits OUTSIDE the disclosure (a heading inside <summary>
    // can drop out of screen-reader heading navigation); the details is its
    // sibling within the section.
    expect(heading.closest("details")).toBeNull();
    const details = heading.closest("section")?.querySelector("details");
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
    // Collapsed, not absent: SSR HTML must keep finance crawler-readable.
    expect(screen.getByText("$120,000")).toBeInTheDocument();
  });

  it("scopes each record's For/Against chip to the group it renders under", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    // One record, for one area and against another: each group's copy must
    // show only its own area's direction.
    renderCandidate(() =>
      candidateDetail({
        records: [
          {
            id: "r-mixed",
            description: "Backed a housing bill that cut transit funding.",
            source_url: "https://example.gov/record",
            event_date: "2026-05-01",
            created_at: "2026-05-02T00:00:00.000Z",
            research_area_tags: [
              { research_area_id: "a-housing", slug: "housing", name: "Housing", stance: "for" },
              { research_area_id: "a-transit", slug: "transit", name: "Transit", stance: "against" },
            ],
          },
        ],
      })
    );

    await screen.findByRole("heading", { name: "Jordan Voter" });
    // The chip names its topic so a card read without its group heading
    // still says what the stance is about.
    expect(screen.getByText("Supports Housing")).toBeInTheDocument();
    expect(screen.getByText("Opposes Transit")).toBeInTheDocument();
  });

  it("uses evidence wording, not advocacy verbs, for judicial evaluative areas", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    // On legal_competence/impartiality a for/against tag grades the
    // EVIDENCE (favorable/unfavorable) — "Opposes Legal Competence" would
    // claim an intent the data never asserted.
    renderCandidate(() =>
      candidateDetail({
        records: [
          {
            id: "r-judicial",
            description: "Had two rulings reversed on appeal during 2024.",
            source_url: "https://example.gov/opinions",
            event_date: "2024-08-01",
            created_at: "2026-05-02T00:00:00.000Z",
            research_area_tags: [
              {
                research_area_id: "a-competence",
                slug: "legal_competence",
                name: "Legal Competence",
                stance: "against",
              },
              {
                research_area_id: "a-impartiality",
                slug: "impartiality",
                name: "Impartiality",
                stance: "for",
              },
            ],
          },
        ],
      })
    );

    await screen.findByRole("heading", { name: "Jordan Voter" });
    expect(screen.getByText("Unfavorable on Legal Competence")).toBeInTheDocument();
    expect(screen.getByText("Favorable on Impartiality")).toBeInTheDocument();
    expect(screen.queryByText("Opposes Legal Competence")).not.toBeInTheDocument();
    expect(screen.queryByText("Supports Impartiality")).not.toBeInTheDocument();
  });

  it("keeps mixed records chipless in the newest view and spells out per-tag stances", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        records: [
          {
            id: "r-mixed",
            description: "Backed a housing bill that cut transit funding.",
            source_url: "https://example.gov/record",
            event_date: "2026-05-01",
            created_at: "2026-05-02T00:00:00.000Z",
            research_area_tags: [
              { research_area_id: "a-housing", slug: "housing", name: "Housing", stance: "for" },
              { research_area_id: "a-transit", slug: "transit", name: "Transit", stance: "against" },
            ],
          },
        ],
      })
    );

    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox"), "newest");

    // The flat view has no single chip — the tag list carries each area's
    // stance in the same verb phrasing as the grouped chip.
    expect(screen.getByText("Supports Housing")).toBeInTheDocument();
    expect(screen.getByText("Opposes Transit")).toBeInTheDocument();
  });

  it("renders the profile report button after the record and election sections", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }));

    await screen.findByRole("heading", { name: "Jordan Voter" });
    const button = screen.getByRole("button", { name: "Report an issue with candidate profile" });
    const electionsHeading = screen.getByRole("heading", { name: "Race Jordan Voter is in:" });
    expect(electionsHeading.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("links a retention judge to the Yes/No question in one line instead of a race list", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection({
            official_ballot_title: "Shall Judge Jordan Voter be retained in office?",
            election_date: "2026-11-03",
          }),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Jordan Voter" });
    expect(screen.queryByRole("heading", { name: /is in:/ })).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Retention question" });
    expect(link).toHaveAttribute("href", "/elections/e-1");
    expect(link.parentElement).toHaveTextContent("Retention question · November 3, 2026");
  });

  it("splits the election list into upcoming and past races, pluralized per section", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection(),
          candidateElection({ candidate_election_id: "ce-2", election_id: "e-2", election_date: "2099-12-01" }),
          candidateElection({ candidate_election_id: "ce-3", election_id: "e-3", election_date: "2000-11-07" }),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Races Jordan Voter is in:" });
    const upcoming = screen.getByRole("heading", { name: "Races Jordan Voter is in:" });
    const past = screen.getByRole("heading", { name: "Past race Jordan Voter ran in:" });
    // Races still ahead lead; the finished one follows.
    expect(upcoming.compareDocumentPosition(past) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("files a withdrawn future candidacy under \"no longer in\", never \"is in\"", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection({ status: "withdrawn" }),
          candidateElection({ candidate_election_id: "ce-2", election_id: "e-2", election_date: "2099-12-01" }),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Jordan Voter" });
    // A candidate who withdrew from a future-dated race is not "in" it, but
    // the candidacy stays visible as history.
    expect(screen.getByRole("heading", { name: "Race Jordan Voter is in:" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Race Jordan Voter is no longer in:" })).toBeInTheDocument();
    const active = screen.getByRole("heading", { name: "Race Jordan Voter is in:" });
    const exited = screen.getByRole("heading", { name: "Race Jordan Voter is no longer in:" });
    expect(active.compareDocumentPosition(exited) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cuts the newest-first view off at 20 with a show-all button", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const records = Array.from({ length: 25 }, (_, index) => ({
      id: `r-${index + 1}`,
      description: `Record number ${index + 1}.`,
      source_url: "https://example.gov/record",
      event_date: "2026-05-01",
      created_at: "2026-05-02T00:00:00.000Z",
      research_area_tags: [],
    }));
    renderCandidate(() => candidateDetail({ records }));

    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox"), "newest");

    expect(screen.getByText("Record number 20.")).toBeInTheDocument();
    expect(screen.queryByText("Record number 21.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all 25 records" }));
    expect(screen.getByText("Record number 25.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("says no verified records when the empty list was actually researched", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ records: [], records_researched_through: "2026-07-10" }));

    expect(
      await screen.findByText(
        "No verified public records for this candidate — record history researched through July 10, 2026."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Track record" })).not.toBeInTheDocument();
  });

  it("says records are not researched yet when there is no research checkpoint", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ records: [], records_researched_through: null }));

    expect(
      await screen.findByText("This candidate's record history has not been researched yet.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/No verified public records/)).not.toBeInTheDocument();
  });

  it("shows logged-out visitors a Follow button that prompts them to register", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail());

    const followButton = await screen.findByRole("button", { name: "Follow" });
    await userEvent.click(followButton);

    expect(await screen.findByText("Get updates on Jordan Voter whenever there's news. Signing up is free.")).toBeInTheDocument();
    // Both links carry the candidate page as the post-auth return path.
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      "/register?next=%2Fcandidates%2Fc-1"
    );
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      "/login?next=%2Fcandidates%2Fc-1"
    );
  });

  it("shows no follow controls to logged-in but unverified users", async () => {
    // The follows endpoint is verified-email-gated, and the register prompt
    // would be wrong for someone who already registered.
    stubApiRoutes({ "/api/me": { body: ME_UNVERIFIED } });
    renderCandidate(() => candidateDetail());

    expect(await screen.findByRole("heading", { name: "Jordan Voter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow" })).not.toBeInTheDocument();
  });

  it("shows the follow button as Following once the follows list confirms it", async () => {
    // The anonymous loader payload always carries is_following=false; the
    // button must reflect the client-fetched follows list, not the payload.
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": { body: { follows: [candidateFollow()] } },
    });
    renderCandidate(() => candidateDetail());

    expect(await screen.findByRole("button", { name: "Following" })).toBeInTheDocument();
  });

  it("asks before unfollowing: Cancel sends nothing, Unfollow sends following:false", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: MY_DISTRICTS },
      "/api/me/candidate-follows": (_url, init) =>
        init?.method === "PUT" ? { body: { follow: null } } : { body: { follows: [candidateFollow()] } },
    });
    const user = userEvent.setup();
    renderCandidate(() => candidateDetail());

    const following = await screen.findByRole("button", { name: "Following" });
    // Hover previews the action the click will ask about.
    await user.hover(following);
    expect(following).toHaveTextContent("Unfollow");
    await user.click(following);
    const dialog = await screen.findByRole("dialog", { name: "Unfollow Jordan Voter?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")).toBeUndefined();

    await user.click(screen.getByRole("button", { name: /Following|Unfollow/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unfollow" }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(put).toBeDefined();
      expect(JSON.parse(String(put![1]!.body))).toEqual({ candidate_id: "c-1", following: false });
    });
  });

  it("lets logged-out visitors pick from the sticky bar straight into the local ballot draft", async () => {
    clearBallotDraft();
    // Pick controls only render for races in the viewer's districts; a
    // guest's districts come from the draft's ballot context.
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }));

    // The control only renders once the 401 settles (no-flash rule), so its
    // presence proves the guest fork.
    const cta = await screen.findByRole("button", { name: "Make my pick: Jordan Voter" });
    await userEvent.click(cta);

    // The pick lands in the localStorage draft (no API write) and the CTA
    // flips to its picked state, same as the signed-in flow.
    expect(
      await screen.findByRole("button", { name: "✓ My pick: Jordan Voter" })
    ).toBeInTheDocument();
    expect(readBallotDraft().choices["e-1"].picks.map((pick) => pick.candidate_id)).toEqual(["c-1"]);
  });

  it("shows post-pick actions on the sticky card once the guest picks", async () => {
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }));

    const cta = await screen.findByRole("button", { name: "Make my pick: Jordan Voter" });
    // Nothing to confirm before the pick.
    expect(screen.queryByRole("link", { name: /My Draft/ })).not.toBeInTheDocument();
    await userEvent.click(cta);

    // The draft link wears the header nav's exact label (deep-link count
    // form — no ballot seen, so no denominator) and points at the guest
    // draft page.
    const draftLink = await screen.findByRole("link", { name: "My Draft (1)" });
    expect(draftLink).toHaveAttribute("href", "/draft");
    // Deep link, no router state: there is no election to go back to.
    expect(screen.queryByRole("link", { name: "Back to election" })).not.toBeInTheDocument();
  });

  it("offers a back-to-election link in the post-pick actions for election arrivals", async () => {
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }), "c-1", {
      backTo: { path: "/elections/e-1", label: "Governor" },
    });

    await userEvent.click(await screen.findByRole("button", { name: "Make my pick: Jordan Voter" }));
    expect(await screen.findByRole("link", { name: "Back to election" })).toHaveAttribute(
      "href",
      "/elections/e-1"
    );
  });

  it("shows the signed-in draft link when this candidate is already the account's pick", async () => {
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
              election_date: "2099-11-03",
              seats_to_fill: null,
              picks: [{ candidate_id: "c-1", display_name: "Jordan Voter", candidacy_status: "declared" }],
              measure_position: null,
              updated_at: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      },
      // The header-shared ballot preview useMyPicksProgress reads: one
      // upcoming race, already decided above — the earned label.
      "/api/me/ballot": { body: { elections: [{ id: "e-1", election_date: "2099-11-03" }] } },
    });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }));

    // Picked on arrival (account choices), so the actions render without a
    // click — the "where to next" links matter on a return visit too.
    const link = await screen.findByRole("link", { name: "My Draft ✓" });
    expect(link).toHaveAttribute("href", "/me/picks");
  });

  it("shows logged-out visitors no pick row for withdrawn or past candidacies", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection({ status: "withdrawn" }),
          candidateElection({ candidate_election_id: "ce-2", election_id: "e-2", election_date: "2020-11-03" }),
        ],
      })
    );

    expect(await screen.findByRole("heading", { name: "Jordan Voter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /my pick for/ })).not.toBeInTheDocument();
  });

  it("renders the sticky bar as the page's only pick control for a single pickable race", async () => {
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }));

    // One control, not several: the sticky bottom card is always in reach,
    // so the in-body row would only duplicate it.
    const ctas = await screen.findAllByRole("button", { name: "Make my pick: Jordan Voter" });
    expect(ctas).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /my pick for/ })).not.toBeInTheDocument();
  });

  it("asks a bare Yes/No on the sticky card for a retention judge — no caption, no auto-pick", async () => {
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        elections: [candidateElection({ official_ballot_title: "Shall Judge Jordan Voter be retained in office?" })],
      })
    );

    // Yes/No on keeping the judge, never a candidate pick. The profile is
    // reference material: the explanation caption and the alignment control
    // live on the election page's judge section, not here.
    expect(await screen.findByRole("button", { name: "No" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(screen.queryByText("Yes keeps this judge in office. No removes them.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /align with my values/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Make my pick/ })).not.toBeInTheDocument();
  });

  it("renders no primary pick CTA when the candidate is in several pickable races", async () => {
    // The CTA carries no race name, so with two concurrent races it cannot
    // say which one it would pick — those pages rely on the self-describing
    // rows, one per race.
    clearBallotDraft();
    setDraftBallotContext([DISTRICT.id], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection(),
          candidateElection({
            candidate_election_id: "ce-2",
            election_id: "e-2",
            official_ballot_title: "Lieutenant Governor",
          }),
        ],
      })
    );

    expect(
      await screen.findByRole("button", {
        name: "Make Jordan Voter my pick for Governor · November 3, 2099",
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make my pick: Jordan Voter" })).not.toBeInTheDocument();
  });

  it("keeps controls without the nudge on a decided race when districts are unknown", async () => {
    // Safety valve + state 3 together: the existing pick keeps its controls
    // even with no district context, and with no undecided race left the
    // address nudge must not render beside the ✓ it would contradict.
    clearBallotDraft();
    setDraftCandidateChoice({
      electionId: "e-1",
      raceTitle: "Governor",
      electionDate: "2099-11-03",
      seatsToFill: null,
      candidateId: "c-1",
      candidateName: "Jordan Voter",
      chosen: true,
    });
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }));

    expect(await screen.findByRole("button", { name: "✓ My pick: Jordan Voter" })).toBeInTheDocument();
    expect(screen.queryByText(/Enter your address/)).not.toBeInTheDocument();
  });

  it("shows a guest neither pick controls nor the nudge for a race outside their districts", async () => {
    // State 2 of the gate: districts known, race foreign — a clean read-only
    // page, no controls and no nudge (the viewer already has a ballot; this
    // race just isn't on it).
    clearBallotDraft();
    setDraftBallotContext(["dddddddd-2222-4222-8222-222222222222"], null);
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }));

    // Follow renders once the session settles (same no-flash rule as the
    // pick gate), so its presence proves the absences below are the gate's
    // verdict, not a not-yet-rendered page.
    await screen.findByRole("button", { name: "Follow" });
    expect(screen.queryByRole("button", { name: /my pick/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Enter your address" })).not.toBeInTheDocument();
  });

  it("nudges a guest with no ballot context in place of the pick controls", async () => {
    // State 3: districts unknown — no controls, but the conversion nudge
    // takes their slot.
    clearBallotDraft();
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => candidateDetail({ elections: [candidateElection()] }));

    const nudge = await screen.findByRole("link", { name: "Enter your address" });
    expect(nudge).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button", { name: /my pick/i })).not.toBeInTheDocument();
  });

  it("gates a signed-in viewer per race: a decided foreign race keeps controls, an undecided one gets none", async () => {
    // State 2 + the safety valve in one page: the saved-address districts
    // say both races are foreign, but the account already holds a pick for
    // one (a moved voter, or an imperfect geocode) — that race keeps its
    // controls; the undecided one renders neither controls nor a nudge
    // (districts are known). Each half is the other's timing proof: the ✓
    // card only renders once the districts response is in (pickableElections
    // stays empty while the query pends), so when it appears, the missing
    // controls on the undecided race are the gate's verdict, not a page
    // still waiting on /api/me/districts. And were the gate open, both
    // races would be pickable, the sticky card would yield to per-race
    // rows, and the ✓ lookup itself would fail.
    clearBallotDraft();
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/districts": { body: { district_ids: ["dddddddd-2222-4222-8222-222222222222"] } },
      "/api/me/candidate-follows": { body: { follows: [] } },
      "/api/me/election-choices": {
        body: {
          choices: [
            {
              election_id: "e-1",
              race_type: "office",
              official_ballot_title: "Governor",
              election_date: "2099-11-03",
              seats_to_fill: null,
              picks: [{ candidate_id: "c-1", display_name: "Jordan Voter", candidacy_status: "declared" }],
              measure_position: null,
              updated_at: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      },
      "/api/me/ballot": { body: { elections: [{ id: "e-1", election_date: "2099-11-03" }] } },
    });
    renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection(),
          candidateElection({
            candidate_election_id: "ce-2",
            election_id: "e-2",
            official_ballot_title: "Lieutenant Governor",
          }),
        ],
      })
    );

    expect(await screen.findByRole("button", { name: "✓ My pick: Jordan Voter" })).toBeInTheDocument();
    // The undecided foreign race: no pick row, and no nudge (districts are
    // known — a nudge would ask for an address the viewer already saved).
    expect(screen.queryByRole("button", { name: /my pick for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Enter your address" })).not.toBeInTheDocument();
  });

  it("shows loader-fetched finance for an ongoing election", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    // Finance rides in the loader payload (SSR-rendered for crawlers), not
    // in a client-side query.
    renderCandidate(() => ({
      ...candidateDetail({ elections: [candidateElection()] }),
      ongoing_finance: { "ce-1": financeSummary() },
    }));

    // The accessible name carries the election for screen-reader heading
    // navigation (a candidate can be in two concurrent races).
    expect(await screen.findByRole("heading", { name: "Campaign Finance Information — Governor" })).toBeInTheDocument();
    expect(screen.getByText("$120,000")).toBeInTheDocument();
    expect(screen.getByText("Top disclosed occupations of direct donors")).toBeInTheDocument();
    // One race: the page header already names it, so the visible row does not.
    expect(screen.getByText("Campaign Finance Information").closest("summary")).not.toHaveTextContent("Governor");
  });

  it("names the race on each finance row when the candidate is in two ongoing races", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => ({
      ...candidateDetail({
        elections: [
          candidateElection(),
          candidateElection({
            candidate_election_id: "ce-2",
            election_id: "e-2",
            official_ballot_title: "State Senator",
          }),
        ],
      }),
      ongoing_finance: { "ce-1": financeSummary(), "ce-2": financeSummary() },
    }));

    await screen.findByRole("heading", { name: "Campaign Finance Information — State Senator" });
    const rows = screen.getAllByText("Campaign Finance Information").map((node) => node.closest("summary"));
    expect(rows[0]).toHaveTextContent("· Governor ·");
    expect(rows[1]).toHaveTextContent("· State Senator ·");
  });

  it("renders no finance section when the ongoing election has no finance for the candidate", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() => ({
      ...candidateDetail({ elections: [candidateElection()] }),
      ongoing_finance: { "ce-1": null },
    }));

    expect(await screen.findByRole("heading", { name: "Jordan Voter" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Campaign Finance/i })).not.toBeInTheDocument();
  });

  it("loader fetches ongoing-election finance, skips past elections, and survives a finance failure", async () => {
    // Two ongoing races (one finance fetch fails) and one past race. Only
    // the ongoing races may be fetched — the past election's endpoint is
    // deliberately unmocked, so a stray fetch would throw loudly.
    stubApiRoutes({
      "/api/candidates/c-1": {
        body: candidateDetail({
          elections: [
            candidateElection(),
            candidateElection({ candidate_election_id: "ce-2", election_id: "e-2" }),
            candidateElection({
              candidate_election_id: "ce-past",
              election_id: "e-past",
              election_date: "2000-11-03",
            }),
          ],
        }),
      },
      "/api/elections/e-1/candidates/c-1/finance": { body: { finance_summary: financeSummary() } },
      "/api/elections/e-2/candidates/c-1/finance": apiError(500, "internal_error", "boom"),
    });

    const data = await loader({
      params: { candidateId: "c-1" },
      request: new Request("http://localhost/candidates/c-1"),
      context: {},
      url: new URL("http://localhost/candidates/c-1"),
      pattern: "/candidates/:candidateId",
    });

    expect(data.ongoing_finance["ce-1"]).toEqual(financeSummary());
    // The failed fetch degrades to "no finance" instead of failing the page.
    expect(data.ongoing_finance["ce-2"]).toBeNull();
    expect("ce-past" in data.ongoing_finance).toBe(false);
  });

  it("shows no finance on past-election rows and never fetches it", async () => {
    const fetchMock = stubApiRoutes({
      ...ANONYMOUS,
      "/api/elections/e-1/candidates/c-1/finance": { body: { finance_summary: financeSummary() } },
    });
    renderCandidate(() =>
      candidateDetail({ elections: [candidateElection({ election_date: "2000-11-03" })] })
    );

    expect(
      await screen.findByRole("heading", { name: "Past race Jordan Voter ran in:" })
    ).toBeInTheDocument();
    // Campaign finance shows only for elections the candidate is currently
    // in; past rows carry no disclosure and trigger no fetch.
    expect(screen.queryByText("Campaign Finance Information")).not.toBeInTheDocument();
    const financeCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/api/elections/")
    ).length;
    expect(financeCalls).toBe(0);
  });

  it("submits record reports with the candidate record target", async () => {
    let submittedBody: unknown = null;
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/content-reports": (_url, init) => {
        submittedBody = JSON.parse(String(init?.body));
        return { status: 201, body: { report: { id: "report-1" } } };
      },
    });
    renderCandidate(() => candidateDetail());

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Report an issue with candidate record" }));
    await user.type(screen.getByLabelText("Details"), "This record needs another source.");
    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByText("Report sent. Thank you.")).toBeInTheDocument();
    expect(submittedBody).toEqual({
      entity_type: "candidate_record",
      entity_id: "r-1",
      message: "This record needs another source.",
    });
  });
});

describe("CandidatePage back link and nav context", () => {
  const ARRIVAL = {
    backTo: { path: "/elections/e-1", label: "Governor" },
    backState: { backTo: { path: "/ballot?d=d-1", label: "All elections" } },
    electionId: "e-1",
    candidates: [{ id: "c-1", name: "Jordan Voter" }],
  };

  it("links back to the arrival election and restores its nav state on the hop", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderCandidate(() => candidateDetail(), "c-1", ARRIVAL);

    const back = await screen.findByRole("link", { name: "Back to Election" });
    expect(back).toHaveAttribute("href", "/elections/e-1");

    await user.click(back);
    expect(router.state.location.pathname).toBe("/elections/e-1");
    // The election page gets its own ballot context back.
    expect(router.state.location.state).toEqual(ARRIVAL.backState);
  });

  it("names the arrival race above the candidate, and nothing on a deep link", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const detail = () => candidateDetail({ elections: [candidateElection({ election_id: "e-1", official_ballot_title: "Governor" })] });
    const arrived = renderCandidate(detail, "c-1", ARRIVAL);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.parentElement?.previousElementSibling).toHaveTextContent(/^Governor · /);
    arrived.unmount();

    renderCandidate(detail);
    const deepLinkHeading = await screen.findByRole("heading", { level: 1 });
    expect(deepLinkHeading.parentElement?.previousElementSibling?.tagName).not.toBe("P");
  });

  it("shows no nav bar on a deep link, even with a sole candidacy", async () => {
    // Deep links have no arrival context — no bar at all, by product
    // choice; the Elections section below still links every race.
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection({ election_id: "e-9", official_ballot_title: "Mayor", election_date: "2020-11-03" }),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Jordan Voter" });
    expect(screen.queryByRole("navigation", { name: "Candidate navigation" })).not.toBeInTheDocument();
  });

  it("shows no back link with several candidacies and no arrival context", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection(),
          candidateElection({ candidate_election_id: "ce-2", election_id: "e-2", official_ballot_title: "Mayor" }),
        ],
      })
    );

    await screen.findByRole("heading", { name: "Jordan Voter" });
    expect(screen.queryByRole("link", { name: /^Back to / })).not.toBeInTheDocument();
  });

  it("hands election-history links this candidate as their back destination", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderCandidate(() =>
      candidateDetail({
        elections: [
          candidateElection(),
          candidateElection({ candidate_election_id: "ce-2", election_id: "e-2", official_ballot_title: "Mayor" }),
        ],
      })
    );

    await user.click(await screen.findByRole("link", { name: "Mayor" }));

    expect(router.state.location.pathname).toBe("/elections/e-2");
    expect(router.state.location.state).toEqual({
      backTo: { path: "/candidates/c-1", label: "Jordan Voter" },
    });
  });

  it("ships its own arrival context inside election-history links", async () => {
    // My Picks → candidate → election-history row must let the election
    // page hand the My Picks context back on the return hop.
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const picksArrival = { backTo: { path: "/me/picks", label: "My Picks" } };
    const { router } = renderCandidate(
      () =>
        candidateDetail({
          elections: [
            candidateElection(),
            candidateElection({ candidate_election_id: "ce-2", election_id: "e-2", official_ballot_title: "Mayor" }),
          ],
        }),
      "c-1",
      picksArrival
    );

    await user.click(await screen.findByRole("link", { name: "Mayor" }));

    expect(router.state.location.state).toEqual({
      backTo: { path: "/candidates/c-1", label: "Jordan Voter" },
      backState: picksArrival,
    });
  });
});

describe("CandidatePage roster pager", () => {
  const ROSTER_ARRIVAL = {
    backTo: { path: "/elections/e-1", label: "Governor" },
    backState: { backTo: { path: "/ballot?d=d-1", label: "All elections" } },
    electionId: "e-1",
    candidates: [
      { id: "c-1", name: "Jordan Voter" },
      { id: "c-2", name: "Riley Runner" },
    ],
  };
  // The loader answers for whatever id the pager navigates to.
  const perIdLoader = ({ params }: { params: { candidateId?: string } }) =>
    candidateDetail({ candidate_id: params.candidateId });

  it("pages the arrival roster by candidate name and forwards the walk state", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderCandidate(perIdLoader, "c-1", ROSTER_ARRIVAL);

    const pager = await screen.findByRole("navigation", { name: "Candidate navigation" });
    expect(within(pager).queryByRole("link", { name: /^Previous:/ })).not.toBeInTheDocument();
    expect(within(pager).getByRole("link", { name: "Back to Election" })).toHaveAttribute(
      "href",
      "/elections/e-1"
    );

    await user.click(within(pager).getByRole("link", { name: "Next: Riley Runner" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/candidates/c-2"));
    expect(router.state.location.state).toEqual(ROSTER_ARRIVAL);
    // On the neighbor, the walk points back. The pager stays mounted across
    // the walk, so wait for a link that only the neighbor renders — finding
    // the nav itself would resolve against the still-current page.
    const previousLink = await screen.findByRole("link", { name: "Previous: Jordan Voter" });
    const nextPager = screen.getByRole("navigation", { name: "Candidate navigation" });
    expect(nextPager).toContainElement(previousLink);
    expect(within(nextPager).queryByRole("link", { name: /^Next:/ })).not.toBeInTheDocument();
  });

  it("delivers the ballot context through the pager's up-level link", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderCandidate(perIdLoader, "c-1", ROSTER_ARRIVAL);

    const pager = await screen.findByRole("navigation", { name: "Candidate navigation" });
    await user.click(within(pager).getByRole("link", { name: "Back to Election" }));

    expect(router.state.location.pathname).toBe("/elections/e-1");
    expect(router.state.location.state).toEqual(ROSTER_ARRIVAL.backState);
  });

  it("shows no nav bar at all on a deep link with no back destination", async () => {
    // Default fixture: elections is empty, so the fallback chain yields no
    // backTo either — nothing to render.
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(perIdLoader);
    await screen.findByRole("heading", { name: "Jordan Voter" });
    expect(screen.queryByRole("navigation", { name: "Candidate navigation" })).not.toBeInTheDocument();
  });

  it("collapses to a back-only bar when the candidate left the snapshot", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(perIdLoader, "c-9", ROSTER_ARRIVAL);
    await screen.findByRole("heading", { name: "Jordan Voter" });

    const pager = screen.getByRole("navigation", { name: "Candidate navigation" });
    expect(within(pager).getByRole("link", { name: "Back to Election" })).toBeInTheDocument();
    expect(within(pager).queryByRole("link", { name: /^(Previous|Next):/ })).not.toBeInTheDocument();
  });
});

// The desktop split-screen rail (aria-label "Candidates in this race", vs
// the pager's "Candidate navigation" — distinct names because both are in
// the DOM and CSS decides which is visible per viewport). Same gate as
// prev/next: a validated roster containing the current candidate.
describe("CandidatePage roster rail", () => {
  const ROSTER_ARRIVAL = {
    backTo: { path: "/elections/e-1", label: "Governor" },
    backState: { backTo: { path: "/ballot?d=d-1", label: "All elections" } },
    electionId: "e-1",
    candidates: [
      { id: "c-1", name: "Jordan Voter" },
      { id: "c-2", name: "Riley Runner" },
      { id: "c-3", name: "Casey Contender" },
    ],
  };
  const perIdLoader = ({ params }: { params: { candidateId?: string } }) =>
    candidateDetail({ candidate_id: params.candidateId });

  it("renders the roster with the current candidate highlighted and the full back label", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(perIdLoader, "c-2", ROSTER_ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    expect(within(rail).getByRole("link", { name: "Jordan Voter" })).toHaveAttribute("href", "/candidates/c-1");
    expect(within(rail).getByRole("link", { name: "Casey Contender" })).toHaveAttribute(
      "href",
      "/candidates/c-3"
    );
    // The current candidate is text with aria-current, not a link.
    expect(within(rail).queryByRole("link", { name: "Riley Runner" })).not.toBeInTheDocument();
    expect(within(rail).getByText("Riley Runner").closest("li")).toHaveAttribute("aria-current", "page");
    // The exit link keeps the election's full title — unlike the pager's
    // generic "Election" relabel.
    expect(within(rail).getByRole("link", { name: "Back to Governor" })).toHaveAttribute(
      "href",
      "/elections/e-1"
    );
  });

  it("marks the picked candidate with the check and an accessible suffix", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    clearBallotDraft();
    // Guest pick in the local draft — the same source the "My choice" rows
    // use — in the rail's own race (the snapshot's electionId).
    setDraftCandidateChoice({
      electionId: "e-1",
      raceTitle: "Governor",
      electionDate: "2026-11-03",
      seatsToFill: null,
      candidateId: "c-3",
      candidateName: "Casey Contender",
      chosen: true,
    });
    renderCandidate(perIdLoader, "c-2", ROSTER_ARRIVAL);

    // waitFor: the guest draft becomes the choice source only once /api/me
    // resolves to "no session".
    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    await waitFor(() =>
      expect(within(rail).getByTitle("Casey Contender")).toHaveTextContent("(my pick)")
    );
    expect(within(rail).getByTitle("Casey Contender").querySelector("svg")).not.toBeNull();
    // Unpicked rows — the current candidate included — stay plain.
    const plainRow = within(rail).getByTitle("Jordan Voter");
    expect(plainRow).not.toHaveTextContent("(my pick)");
    expect(plainRow.querySelector("svg")).toBeNull();
    expect(within(rail).getByTitle("Riley Runner").querySelector("svg")).toBeNull();
    clearBallotDraft();
  });

  it("keeps the rail through a roster walk, forwarding the arrival state verbatim", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderCandidate(perIdLoader, "c-1", ROSTER_ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    await user.click(within(rail).getByRole("link", { name: "Casey Contender" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/candidates/c-3"));
    expect(router.state.location.state).toEqual(ROSTER_ARRIVAL);
    // The rail stays mounted across the walk, so finding the nav resolves
    // against the still-current page; wait for the neighbor's own marker.
    await waitFor(() => {
      const railNow = screen.getByRole("navigation", { name: "Candidates in this race" });
      expect(within(railNow).getByText("Casey Contender").closest("li")).toHaveAttribute("aria-current", "page");
    });
    const nextRail = screen.getByRole("navigation", { name: "Candidates in this race" });
    expect(within(nextRail).getByRole("link", { name: "Jordan Voter" })).toHaveAttribute(
      "href",
      "/candidates/c-1"
    );
  });

  it("delivers the ballot context through the rail's exit link", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    const { router } = renderCandidate(perIdLoader, "c-1", ROSTER_ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    await user.click(within(rail).getByRole("link", { name: "Back to Governor" }));

    expect(router.state.location.pathname).toBe("/elections/e-1");
    expect(router.state.location.state).toEqual(ROSTER_ARRIVAL.backState);
  });

  it("renders no rail on deep links or stale snapshots (pager rules apply)", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    // Deep link: no router state at all.
    renderCandidate(perIdLoader, "c-1");
    await screen.findByRole("heading", { name: "Jordan Voter" });
    expect(screen.queryByRole("navigation", { name: "Candidates in this race" })).not.toBeInTheDocument();

    // Stale snapshot: current candidate missing from the roster — the back
    // bar survives (its own gate), the rail does not.
    renderCandidate(perIdLoader, "c-9", { ...ROSTER_ARRIVAL });
    await waitFor(() =>
      expect(screen.getAllByRole("navigation", { name: "Candidate navigation" })).toHaveLength(1)
    );
    expect(screen.queryByRole("navigation", { name: "Candidates in this race" })).not.toBeInTheDocument();
  });

  it("offers no sort control on an unkeyed (pre-deploy) snapshot", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(perIdLoader, "c-2", ROSTER_ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    expect(within(rail).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

// The roster rail's sort control: stance keys ride the snapshot; My issues
// mirrors the election page's roster sort, A–Z is rail-only.
describe("CandidatePage roster rail sort", () => {
  // Arrival order c-1, c-2, c-3. Riley and Casey both match the saved area;
  // Casey's larger record volume outranks Riley; recordless Jordan sinks.
  // A–Z gives a third, distinct order (Casey, Jordan, Riley).
  const KEYED_ARRIVAL = {
    backTo: { path: "/elections/e-1", label: "Governor" },
    electionId: "e-1",
    candidates: [
      { id: "c-1", name: "Jordan Voter", research_area_records: [] },
      {
        id: "c-2",
        name: "Riley Runner",
        research_area_records: [{ research_area_id: "a-gun", record_count: 1 }],
      },
      {
        id: "c-3",
        name: "Casey Contender",
        research_area_records: [{ research_area_id: "a-gun", record_count: 3 }],
      },
    ],
  };
  const SAVED_GUN = {
    "/api/me": { body: ME_VERIFIED },
    "/api/me/districts": { body: MY_DISTRICTS },
    "/api/me/candidate-follows": { body: { follows: [] } },
    "/api/me/research-area-preferences": {
      body: {
        preferences: [
          { research_area_id: "a-gun", slug: "gun_control", name: "Gun Control", description: null, rank: 1 },
        ],
      },
    },
  };
  const perIdLoader = ({ params }: { params: { candidateId?: string } }) =>
    candidateDetail({ candidate_id: params.candidateId });
  const railRows = (rail: HTMLElement) =>
    within(rail)
      .getAllByRole("listitem")
      .map((row) => row.textContent);

  it("defaults to My issues first and forwards the engaged sort to sibling walks", async () => {
    stubApiRoutes({ ...SAVED_GUN });
    const user = userEvent.setup();
    const { router } = renderCandidate(perIdLoader, "c-1", KEYED_ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    // The list is labeled for what it is.
    expect(within(rail).getByText("Candidates:")).toBeInTheDocument();
    // findBy: the control appears once the saved-areas fetch settles. No
    // "As listed" option — the sort is always engaged, defaulting to My
    // issues first, so the rail arrives already sorted.
    const select = await within(rail).findByRole("combobox");
    expect(select).toHaveValue("my_issues");
    expect(within(select).queryByRole("option", { name: "As listed" })).not.toBeInTheDocument();
    expect(railRows(rail)).toEqual(["Casey Contender", "Riley Runner", "Jordan Voter"]);

    await user.click(within(rail).getByRole("link", { name: "Riley Runner" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/candidates/c-2"));
    // Forwarded state: the engaged sort rides along; everything else is the
    // arrival snapshot untouched.
    expect(router.state.location.state).toEqual({ ...KEYED_ARRIVAL, railSort: "my_issues" });
    // The rail stays mounted across the walk and its sort value and row order
    // are identical on both pages, so wait for Riley's own marker before
    // asserting — otherwise these checks pass against the departed page.
    await waitFor(() => {
      const railNow = screen.getByRole("navigation", { name: "Candidates in this race" });
      expect(within(railNow).getByText("Riley Runner").closest("li")).toHaveAttribute("aria-current", "page");
    });
    const nextRail = screen.getByRole("navigation", { name: "Candidates in this race" });
    expect(await within(nextRail).findByRole("combobox")).toHaveValue("my_issues");
    expect(railRows(nextRail)).toEqual(["Casey Contender", "Riley Runner", "Jordan Voter"]);
  });

  it("honors an A–Z handoff from the election roster over the My-issues default", async () => {
    stubApiRoutes({ ...SAVED_GUN });
    renderCandidate(perIdLoader, "c-1", { ...KEYED_ARRIVAL, railSort: "alphabetical" });

    // The reader explicitly chose A–Z on the election page; the rail must
    // start there even though this viewer's default would be My issues.
    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    const select = await within(rail).findByRole("combobox");
    await within(select).findByRole("option", { name: "My issues first" });
    expect(select).toHaveValue("alphabetical");
    expect(railRows(rail)).toEqual(["Casey Contender", "Jordan Voter", "Riley Runner"]);
  });

  it("switches between A–Z and My issues first", async () => {
    stubApiRoutes({ ...SAVED_GUN });
    const user = userEvent.setup();
    renderCandidate(perIdLoader, "c-1", KEYED_ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    const select = await within(rail).findByRole("combobox");
    await user.selectOptions(select, "alphabetical");
    expect(railRows(rail)).toEqual(["Casey Contender", "Jordan Voter", "Riley Runner"]);

    await user.selectOptions(select, "my_issues");
    expect(railRows(rail)).toEqual(["Casey Contender", "Riley Runner", "Jordan Voter"]);
  });

  it("hands the rail's current sort back to the election as its roster sort", async () => {
    stubApiRoutes({ ...SAVED_GUN });
    const user = userEvent.setup();
    const electionContext = { backTo: { path: "/me/ballot", label: "My Elections" } };
    const { router } = renderCandidate(perIdLoader, "c-1", {
      ...KEYED_ARRIVAL,
      backState: electionContext,
    });

    // Switch the rail to A–Z, then take the back hop: the election page
    // must reopen its roster in A–Z, not its My-issues default — rail and
    // roster read as one continuous control across the round trip.
    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    await user.selectOptions(await within(rail).findByRole("combobox"), "alphabetical");
    await user.click(within(rail).getByRole("link", { name: "Back to Governor" }));

    expect(router.state.location.pathname).toBe("/elections/e-1");
    expect(router.state.location.state).toEqual({
      ...electionContext,
      rosterSort: "alphabetical",
    });
  });

  it("offers and engages only A–Z for viewers without saved areas", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderCandidate(perIdLoader, "c-1", KEYED_ARRIVAL);

    const rail = await screen.findByRole("navigation", { name: "Candidates in this race" });
    const select = await within(rail).findByRole("combobox");
    const options = within(select).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["A–Z"]);
    expect(select).toHaveValue("alphabetical");
    // A–Z engaged by default: names order alphabetically (which is also the
    // anonymous roster's own order — no visible reshuffle).
    expect(railRows(rail)).toEqual(["Casey Contender", "Jordan Voter", "Riley Runner"]);
  });
});

describe("CandidatePage newest-view expansion across the pager", () => {
  it("re-collapses the newest list when paging to the next candidate", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const user = userEvent.setup();
    // 21 records — one past the 20-record cap, so "Show all" renders.
    const manyRecords = Array.from({ length: 21 }, (_, i) => ({
      id: `r-${i}`,
      description: `Did a thing (${i}).`,
      source_url: "https://example.gov/record",
      event_date: "2026-05-01",
      created_at: "2026-05-02T00:00:00.000Z",
      research_area_tags: [],
    }));
    const { router } = renderCandidate(
      ({ params }) => candidateDetail({ candidate_id: params.candidateId, records: manyRecords }),
      "c-1",
      {
        backTo: { path: "/elections/e-1", label: "Governor" },
        electionId: "e-1",
        candidates: [
          { id: "c-1", name: "Jordan Voter" },
          { id: "c-2", name: "Riley Runner" },
        ],
      }
    );

    // Switch to the flat newest view and expand past the cap.
    await user.selectOptions(await screen.findByRole("combobox"), "newest");
    await user.click(screen.getByRole("button", { name: "Show all 21 records" }));
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();

    // Page to the neighbor: the component stays mounted (same route), so a
    // bare boolean would leak the expansion. The next candidate must open
    // capped again.
    await user.click(screen.getByRole("link", { name: "Next: Riley Runner" }));
    expect(router.state.location.pathname).toBe("/candidates/c-2");
    expect(await screen.findByRole("button", { name: "Show all 21 records" })).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ElectionList } from "./ElectionCard";
import { renderRoutes } from "../test/render";
import { DISTRICT, electionSummary, retentionElection, VOTE_POWER } from "../test/fixtures";
import { buildResearchAreaWeights } from "@voteapp/api-client";
import type { ElectionChoice, ElectionSummary } from "@voteapp/api-client";

// Test ids double as slugs by default; slugs like "a-1" are unranked in the
// priority list, so those chips fall back to alphabetical order. Pass a real
// slug to exercise the priority ranking.
function area(id: string, name: string, slug = id) {
  return { id, slug, name, description: null };
}

// Saved-preference map shaped like useMyResearchAreas().weights; null means
// the area is saved but the user never ranked it.
function savedWeights(ranks: Record<string, number | null>) {
  return buildResearchAreaWeights(
    Object.entries(ranks).map(([research_area_id, rank]) => ({
      research_area_id,
      rank,
      // The card only reads membership and rank; the display fields come
      // from the election payload, so placeholders suffice here.
      slug: research_area_id,
      name: research_area_id,
      direction: "support" as const,
      hard_veto: false,
      description: null,
    }))
  );
}

// ElectionCard is private to ElectionList (it omits its own date), so the
// card's chip behavior is exercised through a single-election list.
function renderCard(
  election: ElectionSummary,
  savedAreaRanks?: Record<string, number | null>,
  choicesByElectionId?: Map<string, ElectionChoice>
) {
  return renderRoutes(
    [
      {
        path: "/",
        element: (
          <ElectionList
            elections={[election]}
            savedAreaWeights={savedAreaRanks ? savedWeights(savedAreaRanks) : undefined}
            choicesByElectionId={choicesByElectionId}
          />
        ),
      },
    ],
    "/"
  );
}

function electionChoice(overrides: Partial<ElectionChoice> = {}): ElectionChoice {
  return {
    election_id: "e-1",
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    seats_to_fill: null,
    picks: [{ candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "declared" }],
    measure_position: null,
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

// Frozen clock: the choice chip renders only on upcoming races
// (usLatestLocalDate), so the 2026-11-03 fixtures would stop being
// "upcoming" — and the chip assertions would rot — once that day passes.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ElectionCard", () => {
  it("puts vote power on the title row, with the district below, and no candidate count", () => {
    renderCard(electionSummary());

    const row = screen.getByRole("heading", { name: "Governor" }).parentElement;
    expect(row).toHaveTextContent("My vote power: High");
    // A contested race's headcount changed nothing about opening it.
    expect(row).not.toHaveTextContent(/candidate/);
    // Every card names its district — generic titles ("Mayor", "Governor")
    // don't say where the race is.
    expect(screen.getByText("Alaska")).toBeInTheDocument();
  });

  it("omits candidate counts even for a lone candidate", () => {
    renderCard(electionSummary({ candidate_count: 1 }));
    expect(screen.queryByText("1 candidate")).not.toBeInTheDocument();
    expect(screen.queryByText(/Uncontested/)).not.toBeInTheDocument();
  });

  it("shows no vote-power badge on a judicial retention race", () => {
    // The backend labels a retention race "retention" with no score: there
    // is no rating to show, so the row carries no badge (like "unknown").
    renderCard(electionSummary({ candidate_count: 1, vote_power: { ...VOTE_POWER, label: "retention", score: null } }));
    expect(screen.queryByText(/My vote power:/)).not.toBeInTheDocument();
  });

  it("color-codes the vote-power badge by level", () => {
    // Fixture default is "high" → orange; hotter and cooler levels shift hue.
    renderCard(electionSummary());
    expect(screen.getByText("My vote power: High").className).toContain("text-red-700");

    renderCard(electionSummary({ vote_power: { ...VOTE_POWER, label: "very_high" } }));
    expect(screen.getByText("My vote power: Very high").className).toContain("text-red-900");

    renderCard(electionSummary({ vote_power: { ...VOTE_POWER, label: "medium" } }));
    expect(screen.getByText("My vote power: Average").className).toContain("text-sky-700");

    renderCard(electionSummary({ vote_power: { ...VOTE_POWER, label: "above_average" } }));
    expect(screen.getByText("My vote power: Above average").className).toContain("text-orange-700");

    // "low" displays as "Below average" — the label map and color map key on
    // the same wire value, so both must hold at once.
    renderCard(electionSummary({ vote_power: { ...VOTE_POWER, label: "low" } }));
    expect(screen.getByText("My vote power: Below average").className).toContain("text-gray-600");

    renderCard(electionSummary({ vote_power: { ...VOTE_POWER, label: "very_low" } }));
    expect(screen.getAllByText("My vote power: Below average")[1].className).toContain("text-gray-500");
  });

  it("omits the vote-power text when the score is unknown", () => {
    renderCard(electionSummary({ vote_power: { ...VOTE_POWER, label: "unknown" } }));

    expect(screen.queryByText(/My vote power:/)).not.toBeInTheDocument();
    expect(screen.getByText("Alaska")).toBeInTheDocument();
  });

  it("shows the district name on every card", () => {
    renderRoutes(
      [
        {
          path: "/",
          element: (
            <ElectionList
              elections={[
                // Overlapping school districts: same generic title, one ballot.
                electionSummary({
                  id: "e-1",
                  official_ballot_title: "Board of Education Member",
                  district: {
                    id: "d-el",
                    district_type: "school_elementary",
                    name: "Yuma Elementary District, Arizona",
                    state: "AZ",
                  },
                }),
                electionSummary({
                  id: "e-2",
                  official_ballot_title: "Board of Education Member",
                  district: {
                    id: "d-hi",
                    district_type: "school_secondary",
                    name: "Yuma Union High School District, Arizona",
                    state: "AZ",
                  },
                }),
                electionSummary({ id: "e-3", official_ballot_title: "Governor" }),
              ]}
            />
          ),
        },
      ],
      "/"
    );

    // Identically-titled races stay tellable-apart…
    expect(screen.getByText("Yuma Elementary District, Arizona")).toBeInTheDocument();
    expect(screen.getByText("Yuma Union High School District, Arizona")).toBeInTheDocument();
    // …and unique titles carry their district too ("Alaska" is the fixture's).
    expect(screen.getByText("Alaska")).toBeInTheDocument();
  });

  it("shows neither a type label nor a candidate count for ballot measures", () => {
    renderCard(electionSummary({ race_type: "ballot_measure", candidate_count: 0 }));

    // The old "Ballot Measure" label ran together with the vote-power text
    // beside it; the tabs and the title already say what the row is.
    expect(screen.queryByText("Ballot Measure")).not.toBeInTheDocument();
    expect(screen.queryByText(/candidates?/)).not.toBeInTheDocument();
  });

  it("caps unsaved research-area chips and counts the rest", () => {
    renderCard(
      electionSummary({
        research_areas: [
          area("a-1", "Civil Rights"),
          area("a-2", "Gun Control"),
          area("a-3", "Housing Affordability"),
          area("a-4", "Data Privacy"),
          area("a-5", "Public Infrastructure"),
        ],
      })
    );

    // These slugs are unranked, so they fall back to alphabetical order and
    // the cap keeps the first three names.
    expect(screen.getByText("Affects:")).toBeInTheDocument();
    expect(screen.getByText("Civil Rights")).toBeInTheDocument();
    expect(screen.getByText("Data Privacy")).toBeInTheDocument();
    expect(screen.getByText("Gun Control")).toBeInTheDocument();
    expect(screen.queryByText("Housing Affordability")).not.toBeInTheDocument();
    expect(screen.queryByText("Public Infrastructure")).not.toBeInTheDocument();
    // The overflow count wears the same green as the area chips — it is part
    // of the same list, not a muted footnote.
    expect(screen.getByText("+2 more issues").className).toBe(screen.getByText("Civil Rights").className);
  });

  it("orders chips by public-salience priority, not the payload order", () => {
    renderCard(
      electionSummary({
        research_areas: [
          // Payload arrives alphabetical; priority rank must win.
          area("a-1", "Civil Rights", "civil_rights"),
          area("a-2", "Environment and Public Health", "environment_and_public_health"),
          area("a-3", "Gun Control", "gun_control"),
        ],
      })
    );

    const label = screen.getByText("Affects:");
    const chipTexts = Array.from(label.parentElement?.children ?? [])
      .map((chip) => chip.textContent)
      .filter((text) => text !== "Affects:");
    expect(chipTexts).toEqual(["Environment and Public Health", "Gun Control", "Civil Rights"]);
  });

  it("renders saved chips semibold with a screen-reader saved marker, unsaved chips medium", () => {
    renderCard(
      electionSummary({
        research_areas: [area("a-1", "Civil Rights"), area("a-2", "Gun Control")],
      }),
      { "a-2": 1 }
    );

    // Same green accent on both, but the saved match reads heavier — the
    // same weight cue as the candidate page's stance boxes…
    expect(screen.getByText("Gun Control").className).toContain("font-semibold");
    expect(screen.getByText("Civil Rights").className).toContain("font-medium");
    // …while assistive tech still hears which chip is the user's.
    expect(screen.getByText("Gun Control")).toHaveTextContent("Gun Control (saved)");
    expect(screen.getByText("Civil Rights")).not.toHaveTextContent("(saved)");
  });

  it("orders saved chips by the user's own ranking, not public salience", () => {
    renderCard(
      electionSummary({
        research_areas: [
          // Environment far outranks Civil Rights in public salience; the
          // user's explicit 1–7 ranking must win anyway.
          area("a-env", "Environment and Public Health", "environment_and_public_health"),
          area("a-civ", "Civil Rights", "civil_rights"),
          // Saved but never ranked: sinks below ranked saves, still ahead of
          // unsaved chips.
          area("a-gun", "Gun Control", "gun_control"),
          area("a-imm", "Immigration", "immigration"),
        ],
      }),
      { "a-env": 2, "a-civ": 1, "a-gun": null }
    );

    const label = screen.getByText("Affects:");
    const chipTexts = Array.from(label.parentElement?.children ?? [])
      .map((chip) => chip.textContent)
      .filter((text) => text !== "Affects:");
    // Three saved matches fill the cap, so the unsaved area only counts.
    expect(chipTexts).toEqual([
      "Civil Rights (saved)",
      "Environment and Public Health (saved)",
      "Gun Control (saved)",
      "+1 more issue",
    ]);
  });

  it("caps saved matches at three by the user's ranking and counts the rest", () => {
    renderCard(
      electionSummary({
        research_areas: [
          area("a-1", "Civil Rights", "civil_rights"),
          area("a-2", "Gun Control", "gun_control"),
          area("a-3", "Immigration", "immigration"),
          area("a-4", "Housing Affordability", "housing_affordability"),
          area("a-5", "Data Privacy", "data_privacy"),
          area("a-6", "Foreign Trade", "foreign_trade"),
        ],
      }),
      // Ranked out of payload order: the user's rank picks which three show.
      { "a-1": 3, "a-2": 1, "a-3": 4, "a-4": 2 }
    );
    const label = screen.getByText("Affects:");
    const chipTexts = Array.from(label.parentElement?.children ?? [])
      .map((chip) => chip.textContent)
      .filter((text) => text !== "Affects:");
    expect(chipTexts).toEqual([
      "Gun Control (saved)",
      "Housing Affordability (saved)",
      "Civil Rights (saved)",
      "+3 more issues",
    ]);
  });

  it("omits the affects row when a race has no research areas", () => {
    renderCard(electionSummary({ research_areas: [] }));
    expect(screen.queryByText("Affects:")).not.toBeInTheDocument();
  });

  it("keeps one label whether a race touches one area or many", () => {
    renderCard(electionSummary({ research_areas: [area("a-1", "Gun Control")] }));
    // A verb label needs no singular/plural fork — that is half the point
    // of it over a noun phrase.
    expect(screen.getByText("Affects:")).toBeInTheDocument();
  });

  it("orders saved-area chips ahead of unsaved ones", () => {
    renderCard(
      electionSummary({
        research_areas: [
          area("a-1", "Civil Rights"),
          area("a-2", "Gun Control"),
          area("a-3", "Housing Affordability"),
        ],
      }),
      { "a-3": 1 }
    );

    // Filter the label out by text (not position) so this assertion covers
    // chip order only and survives DOM reshuffles around the label.
    const label = screen.getByText("Affects:");
    const chipTexts = Array.from(label.parentElement?.children ?? [])
      .map((chip) => chip.textContent)
      .filter((text) => text !== "Affects:");
    // Saved match leads even though it is last in the payload.
    expect(chipTexts).toEqual(["Housing Affordability (saved)", "Civil Rights", "Gun Control"]);
  });

  it("always shows saved-area matches, ahead of the cap", () => {
    renderCard(
      electionSummary({
        research_areas: [
          area("a-1", "Civil Rights"),
          area("a-2", "Gun Control"),
          area("a-3", "Housing Affordability"),
          area("a-4", "Data Privacy"),
          area("a-5", "Public Infrastructure"),
        ],
      }),
      { "a-4": null, "a-5": null }
    );

    // Saved matches render regardless of position in the payload…
    expect(screen.getByText("Data Privacy")).toBeInTheDocument();
    expect(screen.getByText("Public Infrastructure")).toBeInTheDocument();
    // …and the unsaved chips still fit under the cap, so no overflow chip.
    expect(screen.getByText("Civil Rights")).toBeInTheDocument();
    expect(screen.queryByText(/more area/)).not.toBeInTheDocument();
  });

  it("groups consecutive same-date elections under one date heading", () => {
    renderRoutes(
      [
        {
          path: "/",
          element: (
            <ElectionList
              elections={[
                electionSummary({ id: "e-1", official_ballot_title: "Governor" }),
                electionSummary({ id: "e-2", official_ballot_title: "State Senate" }),
                electionSummary({
                  id: "e-3",
                  official_ballot_title: "Special Runoff",
                  election_date: "2027-03-02",
                }),
              ]}
            />
          ),
        },
      ],
      "/"
    );

    // One heading for the shared date, one for the outlier — not one per card.
    expect(screen.getAllByRole("heading", { name: "Elections on November 3, 2026" })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Elections on March 2, 2027" })).toBeInTheDocument();
    expect(screen.getByText("Governor")).toBeInTheDocument();
    expect(screen.getByText("State Senate")).toBeInTheDocument();
    expect(screen.getByText("Special Runoff")).toBeInTheDocument();
  });

  it("shows every chip when the list is short", () => {
    renderCard(electionSummary({ research_areas: [area("a-1", "Civil Rights")] }));

    expect(screen.getByText("Civil Rights")).toBeInTheDocument();
    expect(screen.queryByText(/more area/)).not.toBeInTheDocument();
  });

  it("moves races without a candidate list into a closing section, dates on the cards", () => {
    renderRoutes(
      [
        {
          path: "/",
          element: (
            <ElectionList
              elections={[
                electionSummary({ id: "e-1", official_ballot_title: "Governor" }),
                electionSummary({
                  id: "e-2",
                  official_ballot_title: "School Board",
                  candidate_count: 0,
                  candidate_roster_status: { reason: "awaiting_official_roster", check_after: null },
                }),
              ]}
            />
          ),
        },
      ],
      "/"
    );

    // One date heading for the readable race; the pending race sits under the
    // waiting section instead of repeating that date at the bottom.
    expect(screen.getAllByRole("heading", { name: "Elections on November 3, 2026" })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /^Elections awaiting candidate information/ })).toBeInTheDocument();
    // Collapsed by default: nothing to read or pick there yet.
    expect(screen.queryByText("Candidate list not final")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Elections awaiting candidate information/ }));
    // Its section heading names no date, so the card carries its own.
    expect(screen.getByText("Alaska · November 3, 2026")).toBeInTheDocument();
    expect(screen.getByText("Candidate list not final")).toBeInTheDocument();
  });

  it("keeps candidate-less ballot measures inside their date group", () => {
    renderRoutes(
      [
        {
          path: "/",
          element: (
            <ElectionList
              elections={[
                electionSummary({
                  id: "e-1",
                  official_ballot_title: "Proposition 4",
                  race_type: "ballot_measure",
                  candidate_count: 0,
                }),
              ]}
            />
          ),
        },
      ],
      "/"
    );

    // Zero candidates is a measure's normal state — no waiting section.
    expect(screen.getByRole("heading", { name: "Elections on November 3, 2026" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Elections awaiting candidate information/ })).not.toBeInTheDocument();
  });

  it("keeps candidate-less races with a recorded result inside their date group", () => {
    renderRoutes(
      [
        {
          path: "/",
          element: (
            <ElectionList
              elections={[
                // Winners can be recorded without candidate links, and the
                // ballot keeps races three days past election day — a decided
                // race is readable, so it must not sink.
                electionSummary({
                  id: "e-1",
                  official_ballot_title: "County Clerk",
                  candidate_count: 0,
                  has_results: true,
                  current_result_outcome: "won",
                }),
              ]}
            />
          ),
        },
      ],
      "/"
    );

    expect(screen.getByRole("heading", { name: "Elections on November 3, 2026" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Elections awaiting candidate information/ })).not.toBeInTheDocument();
  });

  it("renders only the waiting section when every race lacks a candidate list", () => {
    renderRoutes(
      [
        {
          path: "/",
          element: (
            <ElectionList
              elections={[
                electionSummary({
                  id: "e-1",
                  candidate_count: 0,
                  candidate_roster_status: { reason: "awaiting_official_roster", check_after: null },
                }),
              ]}
            />
          ),
        },
      ],
      "/"
    );

    expect(screen.getByRole("heading", { name: /^Elections awaiting candidate information/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Elections on/ })).not.toBeInTheDocument();
  });

  it("shows the viewer's pick on an upcoming race, flagging withdrawn candidates", () => {
    renderCard(electionSummary(), undefined, new Map([["e-1", electionChoice()]]));
    expect(screen.getByText("My pick: Jane Smith")).toBeInTheDocument();

    renderCard(
      electionSummary(),
      undefined,
      new Map([
        [
          "e-1",
          electionChoice({
            picks: [{ candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "withdrawn" }],
          }),
        ],
      ])
    );
    expect(screen.getByText("My pick: Jane Smith (withdrew)")).toBeInTheDocument();
  });

  it("pluralizes the label when a multi-seat race carries several picks", () => {
    renderCard(
      electionSummary(),
      undefined,
      new Map([
        [
          "e-1",
          electionChoice({
            seats_to_fill: 2,
            picks: [
              { candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "declared" },
              { candidate_id: "c-2", display_name: "John Roe", candidacy_status: "declared" },
            ],
          }),
        ],
      ])
    );
    expect(screen.getByText("My picks: Jane Smith, John Roe")).toBeInTheDocument();
  });

  it("shows a measure position as the choice chip", () => {
    renderCard(
      electionSummary({ race_type: "ballot_measure", candidate_count: 0 }),
      undefined,
      new Map([["e-1", electionChoice({ race_type: "ballot_measure", picks: [], measure_position: "yes" })]])
    );
    const yesChip = screen.getByText("My pick: Yes");
    expect(yesChip.className).toContain("text-green-900");
  });

  it("renders a No measure pick in red, matching the election page's NO box", () => {
    renderCard(
      electionSummary({ race_type: "ballot_measure", candidate_count: 0 }),
      undefined,
      new Map([["e-1", electionChoice({ race_type: "ballot_measure", picks: [], measure_position: "no" })]])
    );
    const noChip = screen.getByText("My pick: No");
    expect(noChip.className).toContain("text-red-900");
    expect(noChip.className).not.toContain("text-green-900");
  });

  it("stays silent on an undecided race", () => {
    // Deliberately no empty-state badge: one on every undecided race read as
    // noise, and the absence of a pick chip already marks them. Regression
    // guard for the removed "No pick yet" nudge.
    renderCard(electionSummary(), undefined, new Map());
    expect(screen.queryByText("No pick yet")).not.toBeInTheDocument();
    expect(screen.queryByText(/My picks?:/)).not.toBeInTheDocument();

    // Same when a choice row exists but formats to nothing — its only pick's
    // candidate was deleted or merged.
    renderCard(electionSummary(), undefined, new Map([["e-1", electionChoice({ picks: [] })]]));
    expect(screen.queryByText("No pick yet")).not.toBeInTheDocument();
    expect(screen.queryByText(/My picks?:/)).not.toBeInTheDocument();
  });

  it("shows no choice chip for anonymous viewers or past races", () => {
    // No choices map (anonymous / still loading).
    renderCard(electionSummary());
    expect(screen.queryByText(/My picks?:/)).not.toBeInTheDocument();

    // Past race: the pick is history.
    renderCard(
      electionSummary({ election_date: "2024-11-05", has_results: true }),
      undefined,
      new Map([["e-1", electionChoice({ election_date: "2024-11-05" })]])
    );
    expect(screen.queryByText(/My picks?:/)).not.toBeInTheDocument();
  });
});

describe("ElectionCard result chip", () => {
  it("names the winners next to the outcome", () => {
    // "Advanced" alone left the voter asking who — the names are the answer
    // they came for, so the chip carries them.
    renderCard(
      electionSummary({
        election_date: "2026-08-04",
        has_results: true,
        current_result_outcome: "advanced",
        current_result_winners: [
          { candidate_id: "c-1", candidate_name: "Jocelyn Benson", party: "Democratic" },
          { candidate_id: "c-2", candidate_name: "John James", party: "Republican" },
        ],
      })
    );
    expect(
      screen.getByText("Result: Advanced — Jocelyn Benson (Democratic), John James (Republican)")
    ).toBeInTheDocument();
  });

  it("omits the party when the winner has none", () => {
    renderCard(
      electionSummary({
        election_date: "2026-08-04",
        has_results: true,
        current_result_outcome: "won",
        current_result_winners: [{ candidate_id: "c-1", candidate_name: "Dana Reyes" }],
      })
    );
    expect(screen.getByText("Result: Won — Dana Reyes")).toBeInTheDocument();
  });

  it("colors called results green (or red for a failed measure) and keeps undecided neutral", () => {
    // The chip carries the answer the voter came for — badge colors from the
    // election page make it stand out from the neutral info chips around it.
    renderCard(
      electionSummary({
        election_date: "2026-08-04",
        has_results: true,
        current_result_outcome: "advanced",
        current_result_winners: [{ candidate_id: "c-1", candidate_name: "Jocelyn Benson", party: "Democratic" }],
      })
    );
    const advanced = screen.getByText("Result: Advanced — Jocelyn Benson (Democratic)");
    expect(advanced.className).toContain("text-green-900");
    expect(advanced.className).toContain("font-medium");

    renderCard(
      electionSummary({
        id: "e-2",
        race_type: "ballot_measure",
        candidate_count: 0,
        election_date: "2026-08-04",
        has_results: true,
        current_result_outcome: "failed",
      })
    );
    expect(screen.getByText("Result: Failed").className).toContain("text-red-900");

    renderCard(
      electionSummary({
        id: "e-3",
        election_date: "2026-08-04",
        has_results: true,
        current_result_outcome: "too_close",
      })
    );
    // Undecided stays neutral: color always means "called".
    const tooClose = screen.getByText("Result: Too close");
    expect(tooClose.className).not.toContain("text-green-900");
    expect(tooClose.className).not.toContain("text-red-900");
  });

  it("suppresses winner names on a non-decisive outcome", () => {
    // The contract permits winners on a too_close row (a recorded leader);
    // "Result: Too close — Jane Smith" would read as calling the race.
    renderCard(
      electionSummary({
        election_date: "2026-08-04",
        has_results: true,
        current_result_outcome: "too_close",
        current_result_winners: [{ candidate_id: "c-1", candidate_name: "Jane Smith" }],
      })
    );
    expect(screen.getByText("Result: Too close")).toBeInTheDocument();
  });

  it("marks the viewer's pick inline after their winner's name — even on a past race", () => {
    // 2026-07-04 is past under the frozen clock, so the "My pick: …" chip is
    // hidden (a choice is history) — but the marker is that choice's payoff,
    // so it renders anyway, right after the pick's name in the winner list.
    renderCard(
      electionSummary({
        election_date: "2026-07-04",
        has_results: true,
        current_result_outcome: "advanced",
        current_result_winners: [
          { candidate_id: "c-1", candidate_name: "Jocelyn Benson", party: "Democratic" },
          { candidate_id: "c-2", candidate_name: "John James", party: "Republican" },
        ],
      }),
      undefined,
      new Map([
        [
          "e-1",
          electionChoice({
            election_date: "2026-07-04",
            picks: [{ candidate_id: "c-1", display_name: "Jocelyn Benson", candidacy_status: "declared" }],
          }),
        ],
      ])
    );
    expect(screen.queryByText(/My picks?:/)).not.toBeInTheDocument();
    const marker = screen.getByText("My pick advanced ✓");
    expect(marker.className).toContain("bg-green-700");
    // The marker sits inside the chip, between the pick's name and the rest
    // of the roll call — separated by a real space, so copied/accessible
    // text doesn't run the name into the marker.
    expect(marker.parentElement).toHaveTextContent(
      "Result: Advanced — Jocelyn Benson (Democratic) My pick advanced ✓, John James (Republican)"
    );
  });

  it('says "My pick won ✓" when the outcome claims the seat', () => {
    renderCard(
      electionSummary({
        election_date: "2026-07-04",
        has_results: true,
        current_result_outcome: "won",
        current_result_winners: [
          { candidate_id: "c-1", candidate_name: "Jane Smith", party: "Nonpartisan" },
        ],
      }),
      undefined,
      new Map([["e-1", electionChoice({ election_date: "2026-07-04" })]])
    );
    expect(screen.getByText("My pick won ✓")).toBeInTheDocument();
  });

  it("shows no marker when the viewer's pick lost", () => {
    renderCard(
      electionSummary({
        election_date: "2026-07-04",
        has_results: true,
        current_result_outcome: "advanced",
        current_result_winners: [
          { candidate_id: "c-2", candidate_name: "John James", party: "Republican" },
        ],
      }),
      undefined,
      // The fixture pick is c-1, who is not among the winners.
      new Map([["e-1", electionChoice({ election_date: "2026-07-04" })]])
    );
    expect(screen.queryByText(/My pick/)).not.toBeInTheDocument();
    expect(screen.getByText("Result: Advanced — John James (Republican)")).toBeInTheDocument();
  });

  it("falls back to the outcome alone when no winner is named", () => {
    // Ballot measures (Passed/Failed already says everything) and office rows
    // whose winners are all nameless both take this path.
    renderCard(
      electionSummary({
        race_type: "ballot_measure",
        candidate_count: 0,
        election_date: "2026-08-04",
        has_results: true,
        current_result_outcome: "passed",
        current_result_winners: [],
      })
    );
    expect(screen.getByText("Result: Passed")).toBeInTheDocument();

    // Deploy skew: a backend that predates the field omits it entirely.
    renderCard(
      electionSummary({
        id: "e-2",
        election_date: "2026-08-04",
        has_results: true,
        current_result_outcome: "won",
      })
    );
    expect(screen.getByText("Result: Won")).toBeInTheDocument();
  });

  it("flags a run of seats smaller than the district row with one note, not one per card", () => {
    const seat = (id: string, title: string, seat: string, district = DISTRICT) =>
      electionSummary({ id, official_ballot_title: title, sub_district_seat: seat, district });
    const county = { ...DISTRICT, id: "d-county", district_type: "county", name: "Travis County, Texas" };
    renderRoutes(
      [
        {
          path: "/",
          element: (
            <ElectionList
              elections={[
                electionSummary({ id: "e-plain" }),
                seat("e-1", "Justice of the Peace Ward 3", "Ward 3"),
                seat("e-2", "Justice of the Peace Ward 5", "Ward 5"),
                seat("e-3", "County Commissioner, Precinct 2", "Precinct 2", county),
              ]}
            />
          ),
        },
      ],
      "/"
    );
    // The wording must not promise a filter the address lookup cannot do.
    const notes = screen.getAllByText(/may not cover your address/);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent("These seats each cover part of Alaska — one may not cover your address.");
    // A run of one seat reads in the singular.
    expect(notes[1]).toHaveTextContent("This seat covers part of Travis County, Texas — it may not cover your address.");
    // The seat name still reads from the title; the card carries no line of its own.
    expect(screen.getByText("Justice of the Peace Ward 3")).toBeInTheDocument();
    expect(screen.queryByText("Ward 3")).not.toBeInTheDocument();
  });

  it("sections each date by government level under the district-size sorts, open by default", async () => {
    // Payload order is the backend's: level walk, then population. The list
    // only splits consecutive runs, so the section order is the payload's.
    const level = (id: string, title: string, scope: string | null, district_type: string, family?: string) =>
      electionSummary({
        id,
        official_ballot_title: title,
        district: { ...DISTRICT, id: `d-${id}`, district_type },
        office: scope ? { id: `o-${id}`, scope, canonical_name: title, summary: "" } : null,
        discovery_contest_family: family ?? "non_judicial_office",
      });
    const elections = [
      // Senate offices are scope "statewide"; the contest family makes them federal.
      level("e-1", "U.S. Senator", "statewide", "statewide", "us_senate"),
      level("e-2", "Governor", "statewide", "statewide"),
      level("e-3", "Proposition 4", null, "statewide"),
      level("e-4", "County Sheriff", "county", "county"),
      level("e-5", "School Board", "school_unified", "school_unified"),
    ];
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="district_size" /> }], "/");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const sections = screen.getAllByRole("button", { expanded: true });
    expect(sections.map((button) => button.textContent)).toEqual(["Federal: Alaska(1)", "State(2)", "County: Alaska(1)", "City(1)"]);
    // No Presidential section: none on this ballot. School boards read as City.
    expect(screen.queryByText(/Presidential/)).not.toBeInTheDocument();
    expect(screen.getByText("School Board")).toBeInTheDocument();

    // Collapsing hides that level's cards and nothing else.
    await user.click(sections[1]);
    expect(sections[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Governor")).not.toBeInTheDocument();
    expect(screen.queryByText("Proposition 4")).not.toBeInTheDocument();
    expect(screen.getByText("County Sheriff")).toBeInTheDocument();
  });

  it.each(["district_size", "district_size_smallest"] as const)(
    "shows shared city/county/state names once under %s", (sort) => {
      const districts = [
        { id: "city", name: "San Francisco city, California", district_type: "place", state: "CA" },
        { id: "county", name: "San Francisco County, California", district_type: "county", state: "CA" },
        { id: "state", name: "California", district_type: "statewide", state: "CA" },
      ];
      const elections = districts.flatMap((district) => [1, 2].map((n) => electionSummary({
        id: `${district.id}-${n}`, district, office: null, race_type: "ballot_measure",
        official_ballot_title: `${district.id} measure ${n}`,
      })));
      renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort={sort} /> }], "/");
      for (const label of ["City: San Francisco", "County: San Francisco", "State: California"]) {
        expect(screen.getByRole("button", { name: `${label}(2)` })).toHaveAttribute("aria-expanded", "true");
      }
      for (const district of districts) expect(screen.queryByText(district.name)).not.toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(6);
    }
  );

  it("preserves numbered districts under shared state and federal headings", () => {
    const statewide = { id: "ca", name: "California", state: "CA", district_type: "statewide" };
    const race = (id: string, district: ElectionSummary["district"], scope: string, family?: string) =>
      electionSummary({ id, district, official_ballot_title: id,
        office: { id: `o-${id}`, scope, canonical_name: id, summary: "" },
        discovery_contest_family: family ?? "non_judicial_office" });
    const elections = [
      race("Senator", statewide, "statewide", "us_senate"),
      race("Representative", { ...statewide, id: "house", district_type: "us_house", name: "Congressional District 11 (2024); California" }, "us_house"),
      race("Governor", statewide, "statewide"),
      race("Assembly", { ...statewide, id: "assembly", district_type: "state_lower", name: "Assembly District 17 (2024); California" }, "state_lower"),
    ];
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="district_size" /> }], "/");
    expect(screen.getByRole("button", { name: "Federal: California(2)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "State: California(2)" })).toBeInTheDocument();
    expect(screen.queryByText("California")).not.toBeInTheDocument();
    expect(screen.getByText("Congressional District 11; California")).toBeInTheDocument();
    expect(screen.getByText("Assembly District 17; California")).toBeInTheDocument();
  });

  it("preserves different city and school district locations within one level", () => {
    const districts = [
      { id: "sf", name: "San Francisco city, California", state: "CA", district_type: "place" },
      { id: "oak", name: "Oakland city, California", state: "CA", district_type: "place" },
      { id: "school", name: "San Francisco Unified School District, California", state: "CA", district_type: "school_unified" },
    ];
    const elections = districts.map((district) => electionSummary({ id: district.id, district, office: null, race_type: "ballot_measure" }));
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="district_size" /> }], "/");
    expect(screen.getByRole("button", { name: "City(3)" })).toBeInTheDocument();
    for (const district of districts) expect(screen.getByText(district.name)).toBeInTheDocument();
  });

  it("renders the date groups flat under every other sort", () => {
    renderRoutes(
      [
        {
          path: "/",
          element: (
            <ElectionList
              elections={[electionSummary({ id: "e-1" }), electionSummary({ id: "e-2", official_ballot_title: "Mayor" })]}
              sort="vote_power"
            />
          ),
        },
      ],
      "/"
    );
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
    expect(screen.getByText("Mayor")).toBeInTheDocument();
    expect(screen.getAllByText(DISTRICT.name)).toHaveLength(2);
  });

  it("leaves ordinary races unflagged, including on a backend that predates the field", () => {
    renderCard(electionSummary({ sub_district_seat: null }));
    expect(screen.queryByText(/may not cover your address/)).not.toBeInTheDocument();

    // Deploy skew: a backend that predates the field omits it entirely.
    renderCard(electionSummary({ id: "e-2" }));
    expect(screen.queryByText(/may not cover your address/)).not.toBeInTheDocument();
  });

  it("shows the current-cycle rating chip instead of the historic one when both arrive", () => {
    const historical = {
      display_label: "Historically competitive",
      display_description: "Based on the 2024 Governor result.",
      source: "MIT_2024",
      source_url: null,
      election_year: 2024,
      margin_percent: 8.4,
      competitiveness_label: "competitive",
      stale_after_redistricting: false,
    };
    renderCard(
      electionSummary({
        historical_competitiveness: historical,
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
    expect(screen.getByText("Currently a toss-up")).toBeInTheDocument();
    expect(screen.queryByText("Historically competitive")).not.toBeInTheDocument();

    // Fallback race (and any backend that predates the field): historic chip.
    renderCard(electionSummary({ id: "e-2", historical_competitiveness: historical }));
    expect(screen.getByText("Historically competitive")).toBeInTheDocument();
  });

  it("shows no competitiveness chip for the safe tier", () => {
    renderCard(
      electionSummary({
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
        current_competitiveness: {
          display_label: "Currently not competitive",
          display_description: "Based on current race ratings from Inside Elections as of August 6, 2026.",
          competitiveness_label: "safe",
          method: "outlet_consensus",
          confidence: "medium",
          as_of: "2026-08-06",
        },
      })
    );
    expect(screen.queryByText(/not competitive/)).not.toBeInTheDocument();
  });
});

describe("retention grouping", () => {
  it.each(["vote_power", "my_areas", "district_size", "district_size_smallest"] as const)(
    "collapses retention between contested races and awaiting under %s, including nav order", async (sort) => {
      const elections = [retentionElection("r-1"), electionSummary(), retentionElection("r-2", { candidate_count: 0 }),
        electionSummary({ id: "awaiting", official_ballot_title: "Awaiting mayor", candidate_count: 0 })];
      const { router } = renderRoutes([
        { path: "/", element: <ElectionList elections={elections} sort={sort} backTo={{ path: "/", label: "Ballot" }} /> },
        { path: "/elections/:id", element: <p>Detail</p> },
      ], "/");
      const group = screen.getByRole("button", { name: "Retention Races (2)" });
      expect(group).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(elections[0].official_ballot_title)).not.toBeInTheDocument();
      expect(screen.getByText("Governor").compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(group.compareDocumentPosition(screen.getByRole("heading", { name: /^Elections awaiting candidate information/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.click(group);
      expect(group).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(elections[0].official_ballot_title)).toBeInTheDocument();
      expect(screen.getByText(elections[2].official_ballot_title)).toBeInTheDocument();
      expect(screen.queryByText(/^[0-9]+ candidates?$/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("link", { name: /Governor/ }));
      expect(router.state.location.state.contests.map((entry: { id: string }) => entry.id)).toEqual(["e-1", "r-1", "r-2", "awaiting"]);
      expect(router.state.location.state.contests[2]).toMatchObject({ retention: true });
      expect(router.state.location.state.contests[2].awaiting_candidates).toBeUndefined();
    }
  );

  it.each([0, 1, 2])("keeps the list group size for %i answers", (count) => {
    const elections = [retentionElection("r-1"), retentionElection("r-2")];
    const choices = new Map(elections.slice(0, count).map((election, index) => [election.id,
      electionChoice({ election_id: election.id, picks: [], measure_position: index === 0 ? "yes" : "no" })]));
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} choicesByElectionId={choices} /> }], "/");
    const group = screen.getByRole("button", { name: "Retention Races (2)" });
    expect(group.querySelector("span")).toHaveClass("text-sm", "font-normal", "text-ink-soft");
  });

  it.each(["vote_power", "my_areas", "district_size", "district_size_smallest"] as const)(
    "keeps candidate-free singleton retentions in their dates under %s", async (sort) => {
      const earlier = retentionElection("early", { candidate_count: 0, has_results: false, election_date: "2026-09-15" });
      const singleton = retentionElection("lone", { candidate_count: 0, has_results: false });
      const races = Array.from({ length: 10 }, (_, i) => electionSummary({ id: `race-${i}` }));
      const elections = [...races, singleton, earlier,
        electionSummary({ id: "waiting", official_ballot_title: "Awaiting mayor", candidate_count: 0 })];
      const { router } = renderRoutes([
        { path: "/", element: <ElectionList elections={elections} sort={sort} backTo={{ path: "/", label: "Ballot" }} /> },
        { path: "/elections/:id", element: <p>Detail</p> },
      ], "/");
      expect(screen.queryByRole("button", { name: /Retention Races/ })).not.toBeInTheDocument();
      for (const [date, election] of [["September 15, 2026", earlier], ["November 3, 2026", singleton]] as const) {
        const section = screen.getByRole("heading", { name: `Elections on ${date}` }).parentElement!;
        expect(within(section).getByText(election.official_ballot_title)).toBeInTheDocument();
      }
      const waiting = screen.getByRole("heading", { name: /^Elections awaiting candidate information/ }).parentElement!;
      fireEvent.click(screen.getByRole("button", { name: /^Elections awaiting candidate information/ }));
      expect(within(waiting).getByText("Awaiting mayor")).toBeInTheDocument();
      expect(within(waiting).queryByText(/Shall Judge/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("link", { name: new RegExp(singleton.official_ballot_title) }));
      const contests = router.state.location.state.contests as { id: string; retention?: boolean; awaiting_candidates?: boolean }[];
      expect(contests.map((race) => race.id)).toEqual(["early", ...races.map((race) => race.id), "lone", "waiting"]);
      expect(contests.find((race) => race.id === "lone")).not.toHaveProperty("awaiting_candidates");
      expect(contests.find((race) => race.id === "lone")).not.toHaveProperty("retention");
      expect(contests.at(-1)).toMatchObject({ id: "waiting", awaiting_candidates: true });
    }
  );

  it("leaves one retention on each date as ordinary cards", () => {
    const elections = [retentionElection("r-1"), retentionElection("r-2", { election_date: "2026-09-15" })];
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} /> }], "/");
    expect(screen.queryByRole("button", { name: /Retention Races/ })).not.toBeInTheDocument();
    for (const election of elections) expect(screen.getByText(election.official_ballot_title)).toBeInTheDocument();
  });
});

it("restores an earlier retention-only date from the awaiting tail to chronological order", () => {
  renderRoutes([{ path: "/", element: <ElectionList elections={[
    electionSummary(),
    retentionElection("r-1", { election_date: "2026-09-15", candidate_count: 0 }),
    retentionElection("r-2", { election_date: "2026-09-15", candidate_count: 0 }),
  ]} /> }], "/");
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Elections on September 15, 2026", "Elections on November 3, 2026",
  ]);
  expect(screen.getByRole("button", { name: "Retention Races (2)" })).toBeInTheDocument();
});


describe("vote-power sections", () => {
  const race = (id: string, label: ElectionSummary["vote_power"]["label"] = "medium", overrides: Partial<ElectionSummary> = {}) =>
    electionSummary({ id, official_ballot_title: `Race ${id}`, vote_power: { ...VOTE_POWER, label }, ...overrides });

  it.each([9, 10])("uses the 10 non-retention threshold with %i ordinary races", (count) => {
    const elections = [...Array.from({ length: count }, (_, i) => race(`e-${i}`)),
      retentionElection("r-1"), retentionElection("r-2"),
      retentionElection("r-lone", { election_date: "2027-11-02" })];
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="vote_power" /> }], "/");
    if (count === 10) expect(screen.getByRole("button", { name: "My vote power: Average(10)" })).toHaveAttribute("aria-expanded", "true");
    else expect(screen.queryByRole("button", { name: /Average/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retention Races (2)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/Shall Judge r-lone/)).toBeInTheDocument();
  });

  it.each([6, 9, 10])("counts only the %i cards remaining in the date section, excluding waiting races", (count) => {
    const elections = [
      ...Array.from({ length: count }, (_, i) => race(`e-${i}`, "high")),
      ...Array.from({ length: 4 }, (_, i) => race(`waiting-${i}`, "high", { candidate_count: 0 })),
    ];
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="vote_power" /> }], "/");
    if (count === 10) expect(screen.getByRole("button", { name: "My vote power: High(10)" })).toBeInTheDocument();
    else expect(screen.queryByRole("button", { name: /My vote power:/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Elections awaiting candidate information\s*\(4\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Elections awaiting candidate information/ }));
    for (let i = 0; i < 4; i++) expect(screen.getByText(`Race waiting-${i}`)).toBeInTheDocument();
  });

  it("counts candidate-free measures and offices with results as displayed cards", () => {
    const elections = [
      ...Array.from({ length: 8 }, (_, i) => race(`e-${i}`, "high")),
      race("measure", "high", { race_type: "ballot_measure", candidate_count: 0 }),
      race("results", "high", { candidate_count: 0, has_results: true }),
    ];
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="vote_power" /> }], "/");
    expect(screen.getByRole("button", { name: "My vote power: High(10)" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Elections awaiting candidate information/ })).not.toBeInTheDocument();
  });

  it("orders populated bands highest first, combines the bottom two, and preserves card navigation order", async () => {
    const labels = ["low", "high", "very_low", "medium", "above_average", "very_high", "unknown", "high", "medium", "low"] as const;
    const elections = labels.map((label, i) => race(`e-${i}`, label));
    const { router } = renderRoutes([
      { path: "/", element: <ElectionList elections={elections} sort="vote_power" backTo={{ path: "/", label: "All elections" }} /> },
      { path: "/elections/:id", element: <p>Detail</p> },
    ], "/");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "My vote power: Very high(1)", "My vote power: High(2)", "My vote power: Above average(1)", "My vote power: Average(2)", "My vote power: Below average(3)", "My vote power: Unknown(1)",
    ]);
    const colors = ["text-red-900", "text-red-700", "text-orange-700", "text-sky-700", "text-gray-600", "text-ink-soft"];
    screen.getAllByRole("button").forEach((button, index) => {
      expect(button).toHaveClass(colors[index]);
      expect(button).not.toHaveClass("hover:text-rausch-deep");
    });
    for (const card of screen.getAllByRole("link")) {
      expect(within(card).queryByText(/My vote power:/)).not.toBeInTheDocument();
    }
    const low = screen.getByRole("button", { name: "My vote power: Below average(3)" });
    expect(within(low.parentElement!).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/elections/e-0", "/elections/e-2", "/elections/e-9",
    ]);
    expect(screen.queryByText("My vote power: Very low")).not.toBeInTheDocument();
    await userEvent.click(low);
    expect(screen.queryByText("Race e-2")).not.toBeInTheDocument();
    expect(screen.getByText("Race e-5")).toBeInTheDocument();
    await userEvent.click(low);
    const visibleOrder = screen.getAllByRole("link").map((link) => link.getAttribute("href")!.split("/").pop());
    await userEvent.click(screen.getByRole("link", { name: /Race e-5/ }));
    expect(router.state.location.state.contests.map((entry: { id: string }) => entry.id)).toEqual(visibleOrder);
  });

  it("omits absent bands", () => {
    const elections = Array.from({ length: 10 }, (_, i) => race(`e-${i}`, "high"));
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="vote_power" /> }], "/");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "My vote power: High(10)" })).toBeInTheDocument();
  });

  it("does not count hidden races in the navigation pool toward the threshold", () => {
    const pool = Array.from({ length: 12 }, (_, i) => race(`e-${i}`));
    renderRoutes([{ path: "/", element: <ElectionList elections={pool.slice(0, 9)} contestsPool={pool} sort="vote_power" /> }], "/");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([[7, 7], [7, 10], [10, 7], [10, 10]])(
    "checks the threshold per date with %i August and %i November races", (augustCount, novemberCount) => {
      const dates = ["2026-08-04", "2026-11-03"];
      const counts = [augustCount, novemberCount];
      const elections = dates.flatMap((date, index) => [
        ...Array.from({ length: counts[index] }, (_, i) => race(`${date}-${i}`, "high", { election_date: date })),
        retentionElection(`${date}-r-1`, { election_date: date }),
        retentionElection(`${date}-r-2`, { election_date: date }),
        retentionElection(`${date}-r-3`, { election_date: date }),
      ]);
      renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="vote_power" /> }], "/");
      const headings = screen.getAllByRole("heading", { level: 2 });
      for (let index = 0; index < dates.length; index++) {
        const dateSection = within(headings[index].parentElement!);
        if (counts[index] >= 10) expect(dateSection.getByRole("button", { name: "My vote power: High(10)" })).toBeInTheDocument();
        else expect(dateSection.queryByRole("button", { name: /^My vote power: High/ })).not.toBeInTheDocument();
        for (const card of dateSection.getAllByRole("link")) {
          if (counts[index] >= 10) expect(within(card).queryByText("My vote power: High")).not.toBeInTheDocument();
          else expect(within(card).getByText("My vote power: High")).toBeInTheDocument();
        }
        expect(dateSection.getByRole("button", { name: "Retention Races (3)" })).toHaveAttribute("aria-expanded", "false");
      }
    }
  );

  it("keeps date boundaries and the awaiting-candidates section", () => {
    const elections = Array.from({ length: 10 }, (_, i) => race(`e-${i}`, "high", {
      election_date: i < 5 ? "2026-11-03" : "2027-11-02", candidate_count: i === 9 ? 0 : 2,
    }));
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort="vote_power" /> }], "/");
    // No vote-power sections; the waiting section's own toggle is the only button.
    expect(screen.queryByRole("button", { name: /My vote power/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Elections awaiting candidate information/ })).toBeInTheDocument();
    expect(screen.queryByText("Race e-9")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Elections awaiting candidate information/ }));
    expect(screen.getByText("Race e-9")).toBeInTheDocument();
  });

  it.each(["district_size", "district_size_smallest", "my_areas"] as const)("keeps %s behavior and omits empty district levels", (sort) => {
    const elections = Array.from({ length: 10 }, (_, i) => race(`e-${i}`, "medium", {
      district: { ...DISTRICT, district_type: "statewide" },
    }));
    renderRoutes([{ path: "/", element: <ElectionList elections={elections} sort={sort} /> }], "/");
    expect(screen.queryByRole("button", { name: /Average/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /County/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("My vote power: Average")).toHaveLength(10);
    if (sort !== "my_areas") expect(screen.getByRole("button", { name: "State: Alaska(10)" })).toBeInTheDocument();
  });
});

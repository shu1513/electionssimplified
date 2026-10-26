import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  createAskService,
  electionCountdownAnswer,
  fallbackNotice,
  isCarryablePreviousQuestion,
  myCloseRacesAnswer,
  myIssuesBallotAnswer,
  myMeasuresBallotAnswer,
  nameTokens,
  questionNamesAnyOf,
  type MyBallotElection,
  type MyIssuesBallotElection,
} from "../../src/chatbot/askService.js";

// Pure pieces of the ask service; the full pipeline is exercised by
// `npm run chatbot:eval` against the live index.
//
// All instants are explicit UTC (Date.UTC) and the function itself only uses
// UTC accessors, so these tests pass identically on any machine timezone.

describe("isCarryablePreviousQuestion", () => {
  it("carries a retrieval-type previous question (no deterministic intent)", () => {
    expect(isCarryablePreviousQuestion("Who is running for governor in Georgia?")).toBe(true);
    expect(isCarryablePreviousQuestion("Tell me about the State Senate District 2 race")).toBe(true);
  });

  it("never carries smalltalk, logistics, results, or policy asks (template turns)", () => {
    expect(isCarryablePreviousQuestion("hi")).toBe(false);
    expect(isCarryablePreviousQuestion("thanks")).toBe(false);
    expect(isCarryablePreviousQuestion("where do I vote?")).toBe(false);
    expect(isCarryablePreviousQuestion("when is the election?")).toBe(false);
    expect(isCarryablePreviousQuestion("who won the Georgia Senate race?")).toBe(false);
    expect(isCarryablePreviousQuestion("who should I vote for?")).toBe(false);
  });

  it("treats a missing or blank previous question as nothing to carry", () => {
    expect(isCarryablePreviousQuestion(null)).toBe(false);
    expect(isCarryablePreviousQuestion(undefined)).toBe(false);
    expect(isCarryablePreviousQuestion("   ")).toBe(false);
  });
});

describe("nameTokens", () => {
  it("lowercases, strips diacritics, and splits on punctuation", () => {
    expect(nameTokens("María O'Brien-Smith")).toEqual(["maria", "o", "brien", "smith"]);
  });
});

describe("questionNamesAnyOf", () => {
  const roster = ["Maria Ghobadi", "Rhonda A. Haymon"];

  it("matches a page candidate named by first name only", () => {
    expect(questionNamesAnyOf(roster, "what's the difference between Maria and Rhonda?")).toBe(true);
  });

  it("matches across diacritics (roster 'María' vs typed 'Maria')", () => {
    expect(questionNamesAnyOf(["María López"], "who is Maria?")).toBe(true);
  });

  it("requires an exact whole word, not a fuzzy hit", () => {
    expect(questionNamesAnyOf(roster, "how do I register in Georgia?")).toBe(false);
    expect(questionNamesAnyOf(roster, "tell me about Marianne")).toBe(false);
  });

  it("ignores initials and other short tokens", () => {
    // "A." must not match the article "a" in a question.
    expect(questionNamesAnyOf(["Rhonda A. Haymon"], "a question about nothing")).toBe(false);
  });

  it("ignores name tokens that are question grammar (gate-bypass guard)", () => {
    expect(questionNamesAnyOf(["Will Smith"], "Will there be a runoff?")).toBe(false);
    expect(questionNamesAnyOf(["June Carter"], "when is the June primary?")).toBe(false);
    // The same candidates still match on their other tokens.
    expect(questionNamesAnyOf(["Will Smith"], "what about Smith?")).toBe(true);
  });
});

describe("personalized ballot templates", () => {
  const votePower = (score: number | null): MyBallotElection["vote_power"] => ({
    score,
    label: "medium",
    confidence: "low",
    representation_level: "medium",
    decisiveness_level: "medium",
    factors: [],
  });
  const race = (
    id: string,
    title: string,
    overrides: Partial<MyBallotElection> = {}
  ): MyBallotElection => ({
    id,
    official_ballot_title: title,
    election_date: "2026-11-03",
    race_type: "office",
    vote_power: votePower(null),
    current_competitiveness: null,
    historical_competitiveness: null,
    ...overrides,
  });
  const historical = (
    label: NonNullable<MyBallotElection["historical_competitiveness"]>["competitiveness_label"],
    display: string
  ): NonNullable<MyBallotElection["historical_competitiveness"]> => ({
    display_label: display,
    display_description: `${display} based on 2024 margins.`,
    source: "test",
    source_url: null,
    election_year: 2024,
    winner_party: null,
    runner_up_party: null,
    margin_percent: 3,
    competitiveness_label: label,
    stale_after_redistricting: false,
  });
  const current = (
    label: NonNullable<MyBallotElection["current_competitiveness"]>["competitiveness_label"],
    display: string
  ): NonNullable<MyBallotElection["current_competitiveness"]> => ({
    display_label: display,
    display_description: `${display} per current analyst ratings.`,
    competitiveness_label: label,
    method: "outlet_consensus",
    confidence: "high",
    as_of: "2026-08-01",
  });

  describe("myMeasuresBallotAnswer", () => {
    it("lists only measure races, reader order kept", () => {
      const response = myMeasuresBallotAnswer([
        race("e1", "Governor"),
        race("m1", "Proposition 4", { race_type: "ballot_measure" }),
        race("m2", "Proposition 33", { race_type: "ballot_measure" }),
      ]);
      expect(response.outcome).toBe("template");
      expect(response.answer).toBe("2 ballot measures are on your ballot: Proposition 4; Proposition 33.");
      expect(response.results.map((card) => card.url)).toEqual(["/elections/m1", "/elections/m2"]);
    });

    it("degrades to the ballot card when no measures exist", () => {
      const response = myMeasuresBallotAnswer([race("e1", "Governor")]);
      expect(response.answer).toContain("don't see any ballot measures");
      expect(response.results.map((card) => card.url)).toEqual(["/me/ballot"]);
    });
  });

  describe("myCloseRacesAnswer", () => {
    it("ranks by label order, then vote power, and skips safe races", () => {
      const response = myCloseRacesAnswer([
        race("e1", "Governor", {
          historical_competitiveness: historical("competitive", "Competitive"),
          vote_power: votePower(0.9),
        }),
        race("e2", "US Senate", { current_competitiveness: current("toss_up", "Toss-up") }),
        race("e3", "Sheriff", { historical_competitiveness: historical("safe", "Safe") }),
        race("e4", "Mayor", {
          historical_competitiveness: historical("competitive", "Competitive"),
          vote_power: votePower(0.2),
        }),
      ]);
      expect(response.outcome).toBe("template");
      // Toss-up first; the two competitive races order by vote power.
      expect(response.answer).toContain(
        "3 races on your ballot look close: US Senate (Toss-up); Governor (Competitive); Mayor (Competitive)."
      );
      expect(response.results.map((card) => card.url)).toEqual(["/elections/e2", "/elections/e1", "/elections/e4"]);
      expect(response.results[0]?.snippet).toBe("Toss-up — Toss-up per current analyst ratings.");
    });

    it("prefers the current rating over the historical one for the same race", () => {
      const response = myCloseRacesAnswer([
        race("e1", "Governor", {
          current_competitiveness: current("toss_up", "Toss-up"),
          historical_competitiveness: historical("safe", "Safe"),
        }),
      ]);
      expect(response.answer).toContain("1 race on your ballot looks close: Governor (Toss-up).");
    });

    it("says so when rated races exist but none is close", () => {
      const response = myCloseRacesAnswer([
        race("e1", "Governor", { historical_competitiveness: historical("safe", "Safe") }),
        race("e2", "Sheriff", { historical_competitiveness: historical("somewhat_competitive", "Somewhat competitive") }),
      ]);
      expect(response.answer).toBe(
        "None of the 2 rated races on your ballot look especially close right now. You can browse your full ballot for the details."
      );
      expect(response.results.map((card) => card.url)).toEqual(["/me/ballot"]);
    });

    it("uses singular wording for a single rated race", () => {
      const response = myCloseRacesAnswer([
        race("e1", "Governor", { historical_competitiveness: historical("safe", "Safe") }),
      ]);
      expect(response.answer).toBe(
        "The 1 rated race on your ballot doesn't look especially close right now. You can browse your full ballot for the details."
      );
    });

    it("degrades honestly when nothing on the ballot is rated", () => {
      const response = myCloseRacesAnswer([race("e1", "Governor")]);
      expect(response.answer).toContain("don't have competitiveness ratings");
      expect(response.results.map((card) => card.url)).toEqual(["/me/ballot"]);
    });
  });
});

describe("myIssuesBallotAnswer", () => {
  const area = (id: string, name: string) => ({ id, slug: id, name, description: null });
  const HOUSING = area("a-housing", "Housing");
  const CLIMATE = area("a-climate", "Climate");
  const COURTS = area("a-courts", "Courts");
  /** Housing rank 1 (weight 7), Climate unranked (weight 1). */
  const weights = new Map([
    ["a-housing", { weight: 7, rank: 1 }],
    ["a-climate", { weight: 1, rank: 8 }],
  ]);
  const election = (id: string, title: string, areas: (typeof HOUSING)[]): MyIssuesBallotElection => ({
    id,
    official_ballot_title: title,
    election_date: "2026-11-03",
    research_areas: areas,
  });

  it("names matched races ordered by the asker's area weights", () => {
    const response = myIssuesBallotAnswer(weights, [
      election("e1", "City Council District 2", [CLIMATE]),
      election("e2", "Mayor", [HOUSING, CLIMATE]),
      election("e3", "Judge, Seat 4", [COURTS]),
    ]);
    expect(response.outcome).toBe("template");
    // Mayor (7+1) outranks the council race (1); the courts race matches
    // nothing the user saved and is left out.
    expect(response.answer).toBe(
      "2 races on your ballot touch the issues you saved: Mayor (Housing, Climate); City Council District 2 (Climate)."
    );
    expect(response.results.map((card) => card.url)).toEqual(["/elections/e2", "/elections/e1"]);
    expect(response.results[0]?.snippet).toBe("Touches your saved issues: Housing, Climate.");
  });

  it("breaks score ties toward the user's best-ranked issue, like the ballot page", () => {
    // Parks rank 2 (weight 6) + Climate unranked (weight 1) ties Housing
    // rank 1 (weight 7) on score — the race touching the #1 issue must win,
    // even though the other race's date is earlier.
    const PARKS = area("a-parks", "Parks");
    const tied = new Map([
      ["a-housing", { weight: 7, rank: 1 }],
      ["a-parks", { weight: 6, rank: 2 }],
      ["a-climate", { weight: 1, rank: 8 }],
    ]);
    const response = myIssuesBallotAnswer(tied, [
      { ...election("e1", "Two Weak Matches", [PARKS, CLIMATE]), election_date: "2026-11-02" },
      election("e2", "Top Issue Match", [HOUSING]),
    ]);
    expect(response.results.map((card) => card.title)).toEqual(["Top Issue Match", "Two Weak Matches"]);
  });

  it("caps the list and says how many matched in total", () => {
    const many = Array.from({ length: 7 }, (_, i) => election(`e${i}`, `Race ${i}`, [HOUSING]));
    const response = myIssuesBallotAnswer(weights, many);
    expect(response.answer).toContain("7 races on your ballot touch the issues you saved — the closest 5 matches");
    expect(response.results).toHaveLength(5);
  });

  it("is honest when nothing on the ballot matches", () => {
    const response = myIssuesBallotAnswer(weights, [election("e3", "Judge, Seat 4", [COURTS])]);
    expect(response.answer).toContain("None of the races on your ballot are tagged with the issues you saved");
    expect(response.results.map((card) => card.url)).toEqual(["/me/ballot", "/me/settings"]);
  });
});

describe("the my-issues intent resolves the asker's saved areas", () => {
  /** Scripted pool: `areas` answers the preference-weights query, `districts`
   * the saved-district-ids query. The ballot query itself is not scripted —
   * these tests cover the guard paths that return before it. */
  function myIssuesPool(areas: { research_area_id: string; rank: number | null }[], districts: string[]): Pool {
    return {
      query: async (text: string) => {
        if (text.includes("FROM public.user_research_area_preferences")) {
          return { rows: areas, rowCount: areas.length };
        }
        if (text.includes("public.user_districts")) {
          // The reader LEFT JOINs from users: a district-less user is one row
          // with a null district_id, never zero rows.
          const rows =
            districts.length > 0
              ? districts.map((district_id) => ({ user_id: USER_ID, district_id }))
              : [{ user_id: USER_ID, district_id: null }];
          return { rows, rowCount: rows.length };
        }
        if (text.includes("INSERT INTO chatbot.questions")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected query in my-issues path: ${text.slice(0, 80)}`);
      },
    } as unknown as Pool;
  }

  it("points at Settings when the account has no saved issues", async () => {
    const service = createAskService({ db: myIssuesPool([], []), embeddings: null });
    const response = await service.ask("which of these elections affect issues I care about?", null, null, USER_ID);
    expect(response.outcome).toBe("template");
    expect(response.answer).toContain("Pick your issues in Settings");
    expect(response.results[0]?.url).toBe("/me/settings");
  });

  it("points at the ballot page when issues are saved but no districts are", async () => {
    const service = createAskService({
      db: myIssuesPool([{ research_area_id: "a-housing", rank: 1 }], []),
      embeddings: null,
    });
    const response = await service.ask("which races matter to me?", null, null, USER_ID);
    expect(response.answer).toContain("not where you vote");
    expect(response.results[0]?.url).toBe("/me/ballot");
  });
});

describe("electionCountdownAnswer", () => {
  it("counts calendar days to November 3, 2026", () => {
    expect(electionCountdownAnswer(new Date(Date.UTC(2026, 7, 12, 12, 0)))).toBe(
      "The November 2026 general election is on Tuesday, November 3, 2026 — 83 days from today."
    );
  });

  it("stays on 'tomorrow' just after midnight UTC (US clocks are still on November 2)", () => {
    // 2026-11-03 00:30 UTC = Nov 2, 7:30pm Eastern — saying "today" here
    // would be wrong for every US timezone.
    expect(electionCountdownAnswer(new Date(Date.UTC(2026, 10, 3, 0, 30)))).toBe(
      "The November 2026 general election is tomorrow: Tuesday, November 3, 2026."
    );
    // 2026-11-02 05:00 UTC = Nov 2, midnight Eastern — the day before.
    expect(electionCountdownAnswer(new Date(Date.UTC(2026, 10, 2, 5, 0)))).toBe(
      "The November 2026 general election is tomorrow: Tuesday, November 3, 2026."
    );
  });

  it("flips to 'today' once the US Eastern date is November 3", () => {
    // 2026-11-03 06:00 UTC = 1:00am Eastern on election day.
    expect(electionCountdownAnswer(new Date(Date.UTC(2026, 10, 3, 6, 0)))).toBe(
      "The November 2026 general election is today, Tuesday, November 3, 2026!"
    );
    // Late election night: 11:00pm Eastern is still November 3.
    expect(electionCountdownAnswer(new Date(Date.UTC(2026, 10, 4, 4, 0)))).toBe(
      "The November 2026 general election is today, Tuesday, November 3, 2026!"
    );
  });

  it("uses the past tense after election day", () => {
    expect(electionCountdownAnswer(new Date(Date.UTC(2026, 10, 4, 12, 0)))).toBe(
      "The November 2026 general election was on Tuesday, November 3, 2026."
    );
  });
});

// Template-path pipeline tests with a scripted pool: the intent branch only
// touches state_resources, user_districts, and the question log — no
// generation, retrieval, or LLM.

const CA_RESOURCES = {
  state_abbreviation: "CA",
  state_name: "California",
  polling_place_url: "https://example.gov/ca/polling",
  voter_registration_url: "https://registertovote.ca.gov",
  id_requirements: "No document required for most voters.",
  online_registration_available: true,
  online_registration_deadline_rule: "Register online by October 19, 2026.",
  in_person_registration_deadline_rule: "Available through election day.",
  same_day_registration_available: true,
  mail_voting_available: true,
  mail_ballot_request_url: "https://example.gov/ca/mail",
  mail_ballot_request_deadline_rule: null,
  id_requirements_source_url: null,
  mail_voting_source_url: null,
};

/** Pool fake for the intent/template path. userStates scripts the asker's
 * saved-district states; state_resources answers only for CA. */
function templatePool(userStates: string[]): { pool: Pool; logged: unknown[][] } {
  const logged: unknown[][] = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      if (text.includes("FROM public.user_districts")) {
        return { rows: userStates.slice(0, 2).map((state) => ({ state })), rowCount: Math.min(userStates.length, 2) };
      }
      if (text.includes("FROM public.state_resources")) {
        return values?.[0] === "CA" ? { rows: [CA_RESOURCES], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO chatbot.questions")) {
        logged.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query in template path: ${text.slice(0, 80)}`);
    },
  } as unknown as Pool;
  return { pool, logged };
}

const USER_ID = "6b1f8d3e-2a5c-4f7b-9d0e-1c2b3a4d5e6f";

describe("logistics templates resolve the asker's saved state", () => {
  it("answers registration for the account's single saved state without asking", async () => {
    const { pool } = templatePool(["CA"]);
    const service = createAskService({ db: pool, embeddings: null });
    const response = await service.ask("How do I register to vote?", null, null, USER_ID);
    expect(response.outcome).toBe("template");
    expect(response.answer).toContain("California");
    expect(response.results[0]?.url).toBe("https://registertovote.ca.gov");
  });

  it("still asks which state when the account spans several states", async () => {
    const { pool } = templatePool(["CA", "GA"]);
    const service = createAskService({ db: pool, embeddings: null });
    const response = await service.ask("How do I register to vote?", null, null, USER_ID);
    expect(response.answer).toContain("Tell me which state you vote in");
    expect(response.results).toEqual([]);
  });

  it("still asks which state with no saved districts and no userId", async () => {
    const { pool } = templatePool([]);
    const service = createAskService({ db: pool, embeddings: null });
    const saved = await service.ask("How do I register to vote?", null, null, USER_ID);
    expect(saved.answer).toContain("Tell me which state you vote in");
    const anonymous = await service.ask("How do I register to vote?");
    expect(anonymous.answer).toContain("Tell me which state you vote in");
  });

  it("a question-named state wins over the saved state", async () => {
    const { pool } = templatePool(["GA"]);
    const service = createAskService({ db: pool, embeddings: null });
    const response = await service.ask("How do I register to vote in California?", null, null, USER_ID);
    expect(response.answer).toContain("California");
  });
});

describe("bare-state replies complete the previous turn's logistics intent", () => {
  it("answers the previous registration ask for the named state", async () => {
    const { pool } = templatePool([]);
    const service = createAskService({ db: pool, embeddings: null });
    const response = await service.ask("California", "How do I register to vote?", null, USER_ID);
    expect(response.outcome).toBe("template");
    expect(response.answer).toContain("California");
    expect(response.results[0]?.url).toBe("https://registertovote.ca.gov");
  });

  it("completes a scopeless runoff-date ask as that state's date template", async () => {
    const { pool } = templatePool([]);
    const service = createAskService({ db: pool, embeddings: null });
    const response = await service.ask("in California", "When is the runoff?", null, USER_ID);
    expect(response.answer).toContain("California's official election website");
  });
});

describe("ballot deep links point at the saved-ballot page", () => {
  it("links /me/ballot for ballot and my-area questions", async () => {
    const { pool } = templatePool([]);
    const service = createAskService({ db: pool, embeddings: null });
    const ballot = await service.ask("What's on my ballot?", null, null, USER_ID);
    expect(ballot.results[0]?.url).toBe("/me/ballot");
    const area = await service.ask("Who is running in my area?", null, null, USER_ID);
    expect(area.outcome).toBe("template");
    expect(area.results[0]?.url).toBe("/me/ballot");
  });
});

describe("question logging", () => {
  it("logs one row per ask by default", async () => {
    const { pool, logged } = templatePool([]);
    const service = createAskService({ db: pool, embeddings: null });
    await service.ask("What's on my ballot?", null, null, USER_ID);
    expect(logged).toHaveLength(1);
  });

  it("logQuestions:false answers identically but writes nothing (eval runs)", async () => {
    const { pool, logged } = templatePool([]);
    const service = createAskService({ db: pool, embeddings: null, logQuestions: false });
    const response = await service.ask("What's on my ballot?", null, null, USER_ID);
    expect(response.outcome).toBe("template");
    expect(logged).toHaveLength(0);
  });
});

describe("fallbackNotice", () => {
  it("announces the daily limits, stays silent on transient LLM faults", () => {
    const limitCopy = "Daily AI-answer limit reached — showing matching data instead.";
    expect(fallbackNotice("rate_limited")).toBe(limitCopy);
    expect(fallbackNotice("budget_exhausted")).toBe(limitCopy);
    expect(fallbackNotice("llm_failed")).toBeNull();
    expect(fallbackNotice("invalid_output")).toBeNull();
    // The non-fallback answered_by values must never grow a notice either.
    expect(fallbackNotice("retrieval")).toBeNull();
    expect(fallbackNotice("llm")).toBeNull();
  });
});

describe("feedback tokens on responses", () => {
  it("attaches a token minted for the answer path when a minter is configured", async () => {
    const { pool } = templatePool([]);
    const minted: string[] = [];
    const service = createAskService({
      db: pool,
      embeddings: null,
      feedbackTokens: {
        mint: (answeredBy) => {
          minted.push(answeredBy);
          return `token-for-${answeredBy}`;
        },
      },
    });
    const response = await service.ask("What's on my ballot?", null, null, USER_ID);
    expect(response.feedback_token).toBe("token-for-intent:ballot_lookup");
    expect(minted).toEqual(["intent:ballot_lookup"]);
  });

  it("leaves responses token-free without a minter (operator scripts)", async () => {
    const { pool } = templatePool([]);
    const service = createAskService({ db: pool, embeddings: null, logQuestions: false });
    const response = await service.ask("What's on my ballot?", null, null, USER_ID);
    expect(response.feedback_token).toBeUndefined();
  });
});

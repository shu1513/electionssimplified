import { describe, expect, it } from "vitest";

import {
  classifyRaceQuestion,
  districtNumberPattern,
  expandOfficeAliases,
  RACE_COLLECTIVE_RE,
  RACE_OTHERS_RE,
} from "../../src/chatbot/retrieval.js";

describe("expandOfficeAliases", () => {
  it("appends the corpus office phrase for common federal Senate phrasings", () => {
    expect(expandOfficeAliases("Who has raised more money in the Georgia Senate race?")).toBe(
      "Who has raised more money in the Georgia Senate race? United States Senator"
    );
    expect(expandOfficeAliases("Who is running for US Senate in Georgia?")).toBe(
      "Who is running for US Senate in Georgia? United States Senator"
    );
    expect(expandOfficeAliases("Tell me about the U.S. Senate election")).toBe(
      "Tell me about the U.S. Senate election United States Senator"
    );
    expect(expandOfficeAliases("the United States Senate seat in Ohio")).toBe(
      "the United States Senate seat in Ohio United States Senator"
    );
  });

  it("appends each alias at most once", () => {
    expect(expandOfficeAliases("US Senate race or United States Senate seat?")).toBe(
      "US Senate race or United States Senate seat? United States Senator"
    );
  });

  it("leaves state-senate questions on the state races", () => {
    expect(expandOfficeAliases("Who won the state Senate race in Georgia?")).toBe(
      "Who won the state Senate race in Georgia?"
    );
    expect(expandOfficeAliases("Who's running for State Senate District 2?")).toBe(
      "Who's running for State Senate District 2?"
    );
  });

  it("leaves questions without a federal phrasing untouched", () => {
    expect(expandOfficeAliases("Who is Jon Ossoff?")).toBe("Who is Jon Ossoff?");
    expect(expandOfficeAliases("Who are the candidates for Los Angeles mayor?")).toBe(
      "Who are the candidates for Los Angeles mayor?"
    );
    // "Senate" alone (no race/seat/election frame, no US prefix) stays as-is:
    // "my senator" / "the Senate" questions are not reliably federal races.
    expect(expandOfficeAliases("What does the Senate do?")).toBe("What does the Senate do?");
  });
});

describe("classifyRaceQuestion", () => {
  it("classifies money questions", () => {
    expect(classifyRaceQuestion("Who has raised more money in the Georgia Senate race?")).toBe("money");
    expect(classifyRaceQuestion("How much has the Republican candidate raised?")).toBe("money");
    expect(classifyRaceQuestion("Compare their fundraising")).toBe("money");
    expect(classifyRaceQuestion("Who spent the most cash on hand?")).toBe("money");
  });

  it("classifies records questions, winning over money words", () => {
    expect(classifyRaceQuestion("What are the candidates' records in the Georgia Senate race?")).toBe("records");
    expect(classifyRaceQuestion("How did they vote on the budget?")).toBe("records");
    expect(classifyRaceQuestion("What bills has she sponsored?")).toBe("records");
    // Both kinds of words → records: the asked-for artifact is the record.
    expect(classifyRaceQuestion("What is their voting record on campaign finance bills?")).toBe("records");
  });

  it("classifies everything else neutral", () => {
    expect(classifyRaceQuestion("Who is running for US Senate in Georgia?")).toBe("neutral");
    expect(classifyRaceQuestion("Tell me about the Los Angeles mayor race")).toBe("neutral");
  });
});

describe("RACE_COLLECTIVE_RE", () => {
  it("matches questions about a race's field as a whole", () => {
    expect(RACE_COLLECTIVE_RE.test("Compare the candidates for me.")).toBe(true);
    expect(RACE_COLLECTIVE_RE.test("What are the differences between them?")).toBe(true);
    expect(RACE_COLLECTIVE_RE.test("Who else is running?")).toBe(true);
    expect(RACE_COLLECTIVE_RE.test("who's running")).toBe(true);
    expect(RACE_COLLECTIVE_RE.test("Who has raised the most money in this race?")).toBe(true);
    expect(RACE_COLLECTIVE_RE.test("How do they stack up against each other?")).toBe(true);
  });

  it("does not leak the answerability-gate bypass to off-topic questions", () => {
    // These get page context applied if they match — so a match here means
    // an off-topic question would pass the gate on the page's chunks.
    expect(RACE_COLLECTIVE_RE.test("What will the weather be on election day?")).toBe(false);
    expect(RACE_COLLECTIVE_RE.test("Who is Jon Ossoff?")).toBe(false);
    expect(RACE_COLLECTIVE_RE.test("How do I contest a parking ticket in Atlanta?")).toBe(false);
    expect(RACE_COLLECTIVE_RE.test("Is the racetrack referendum on the ballot?")).toBe(false);
  });
});

describe("RACE_OTHERS_RE", () => {
  it("keeps race-member precedence when a named candidate is compared to the field", () => {
    expect(RACE_OTHERS_RE.test("Compare Jon Ossoff with the other candidates.")).toBe(true);
    expect(RACE_OTHERS_RE.test("Compare Jon Ossoff to the candidates in this race.")).toBe(true);
    expect(RACE_OTHERS_RE.test("How does she stack up against her opponents?")).toBe(true);
    expect(RACE_OTHERS_RE.test("Has Ossoff raised more than everyone else?")).toBe(true);
    expect(RACE_OTHERS_RE.test("How does Ossoff compare to the rest?")).toBe(true);
  });

  it("stays off single-candidate questions that merely contain 'other'", () => {
    // Bare "other" is a modifier, not a field noun — this question is about
    // Ossoff's own records and must keep entity-first ranking.
    expect(RACE_OTHERS_RE.test("In this race, what other bills has Jon Ossoff sponsored?")).toBe(false);
  });

  it("leaves fully-named comparisons on entity-first ranking", () => {
    // "each other" names ALL its subjects — the named candidates' own
    // chunks must not be crowded out by a whole-field round-robin.
    expect(RACE_OTHERS_RE.test("How do Ossoff and Collins compare against each other?")).toBe(false);
    expect(RACE_OTHERS_RE.test("Compare Jon Ossoff and Mike Collins.")).toBe(false);
    expect(RACE_OTHERS_RE.test("Who has raised the most money in this race?")).toBe(false);
  });
});

describe("districtNumberPattern", () => {
  it("builds a whole-word alternation of the numbers attached to office words", () => {
    expect(districtNumberPattern("which candidate is in state assembly district 48")).toBe("\\m(48)\\M");
    expect(districtNumberPattern("Council Member Ward 3, Position 2")).toBe("\\m(3|2)\\M");
    expect(districtNumberPattern("what does Prop 33 do?")).toBe("\\m(33)\\M");
    expect(districtNumberPattern("Position No. 5 candidates")).toBe("\\m(5)\\M");
  });

  it("accepts the number before the office word, ordinals, and glued abbreviations", () => {
    expect(districtNumberPattern("who represents the 48th district?")).toBe("\\m(48)\\M");
    expect(districtNumberPattern("HD41 candidates")).toBe("\\m(41)\\M");
  });

  it("dedupes repeats", () => {
    expect(districtNumberPattern("district 5 or district 5?")).toBe("\\m(5)\\M");
  });

  it("ignores dates, counts, years, and numbers with no office word", () => {
    expect(districtNumberPattern("Who is running for the State Assembly on November 3, 2026?")).toBeNull();
    expect(districtNumberPattern("Who are the 2 candidates for District 48?")).toBe("\\m(48)\\M");
    expect(districtNumberPattern("who is running for the 3 seats on the school board?")).toBeNull();
    expect(districtNumberPattern("top 5 donors to Jon Ossoff")).toBeNull();
    expect(districtNumberPattern("who is running in 2026?")).toBeNull();
  });

  it("is null when the question names no number", () => {
    expect(districtNumberPattern("who is running for governor in Georgia?")).toBeNull();
  });
});

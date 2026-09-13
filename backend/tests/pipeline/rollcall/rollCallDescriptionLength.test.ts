import { describe, expect, it } from "vitest";

import {
  describeRollCallDescriptionLengthProblem,
  splitRollCallSentences,
} from "../../../src/pipeline/rollcall/rollCallDescriptionLength.js";

describe("splitRollCallSentences", () => {
  it("does not split on bill-type prefixes, initials, or time abbreviations", () => {
    expect(splitRollCallSentences("Voted to pass H.R. 1, the budget bill. It passed the House 215-214.")).toHaveLength(2);
    expect(splitRollCallSentences("Voted to pass S. 5. The Senate passed it 64-35.")).toHaveLength(2);
    expect(splitRollCallSentences("Voted for S.J.Res. 3 with A.J. Smith at 8 a.m. on Monday. It passed 30-20.")).toHaveLength(2);
    expect(splitRollCallSentences("Voted for the U.S. Senate version of the bill. It passed 51-49.")).toHaveLength(2);
    expect(splitRollCallSentences("Voted to pass the Freedom to Vote: John R. Lewis Act, a bill to expand voting. It passed 220-203.")).toHaveLength(2);
  });

  it("does not split on decimals or dollar figures", () => {
    expect(splitRollCallSentences("Voted for a $30.2 million bond. It passed 40-10.")).toHaveLength(2);
  });

  it("splits on . ! ? followed by a capital, digit, or quote", () => {
    expect(splitRollCallSentences('Voted no. "Why?" he asked. It failed 10-90. 2 members were absent.')).toHaveLength(4);
  });
});

describe("describeRollCallDescriptionLengthProblem", () => {
  const ok = "Voted to pass House Bill 67, which caps tow and storage fees when a car is towed from a private lot. The Delaware House passed it 23-14, and it became law.";

  it("accepts the vote + effect + tally shape", () => {
    expect(describeRollCallDescriptionLengthProblem(ok)).toBeNull();
  });

  it("names too many sentences first", () => {
    const digest = `${ok} Before towing, the company must post a sign. Storage is capped at $50 a day.`;
    expect(describeRollCallDescriptionLengthProblem(digest)).toMatch(/has 4 sentences \(max 3\)/);
  });

  it("names the character cap", () => {
    const long = `Voted to pass House Bill 67, ${"which caps fees ".repeat(20)}and more. It passed 23-14.`;
    expect(describeRollCallDescriptionLengthProblem(long)).toMatch(/characters \(max 320\)/);
  });

  it("names a run-on sentence", () => {
    const runOn = `Voted to pass House Bill 67, which ${"caps fees and ".repeat(9)}more. It passed 23-14.`;
    expect(describeRollCallDescriptionLengthProblem(runOn)).toMatch(/-word sentence \(max 30 words per sentence\)/);
  });
});

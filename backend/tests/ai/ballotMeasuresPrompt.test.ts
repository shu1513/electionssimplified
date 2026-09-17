import { describe, expect, it } from "vitest";

import {
  BALLOT_MEASURE_SUMMARY_MAX_LENGTH,
  BALLOT_MEASURE_YES_NO_MAX_LENGTH,
  buildBallotMeasuresPrompt,
} from "../../src/ai/providers/ballotMeasuresPrompt.js";
import { PLAIN_LANGUAGE_STYLE_RULES } from "../../src/ai/providers/promptWritingStyle.js";

describe("buildBallotMeasuresPrompt", () => {
  it("includes the plain-language style rules", () => {
    const prompt = buildBallotMeasuresPrompt({
      districtName: "Los Angeles County, California",
      districtType: "county",
      state: "CA",
      electionDate: "2026-06-02",
      officialBallotTitle: "Measure H",
      seedUrls: [],
      allowedResearchAreaSlugs: ["healthcare_affordability"],
    });

    for (const rule of PLAIN_LANGUAGE_STYLE_RULES) {
      expect(prompt).toContain(rule);
    }
    expect(prompt).toContain("6th-grade reader");
  });

  it("demands concrete, non-circular summary and yes/no meanings", () => {
    const prompt = buildBallotMeasuresPrompt({
      districtName: "Los Angeles County, California",
      districtType: "county",
      state: "CA",
      electionDate: "2026-06-02",
      officialBallotTitle: "Measure H",
      seedUrls: [],
      allowedResearchAreaSlugs: ["healthcare_affordability"],
    });
    expect(prompt).toContain("Sentence one says what the measure does in everyday words. Sentence two says how it affects the reader");
    expect(prompt).toContain("Round dollar amounts");
    expect(prompt).toContain(
      "never a restatement like 'adopts the measure' or 'the changes described'"
    );
  });

  it("states the length caps enforced by the validator", () => {
    const prompt = buildBallotMeasuresPrompt({
      districtName: "Los Angeles County, California",
      districtType: "county",
      state: "CA",
      electionDate: "2026-06-02",
      officialBallotTitle: "Measure H",
      seedUrls: [],
      allowedResearchAreaSlugs: ["healthcare_affordability"],
    });

    expect(prompt).toContain("summary is exactly two short sentences at the reading level the style rules above set");
    expect(prompt).toContain(`summary must be at most ${BALLOT_MEASURE_SUMMARY_MAX_LENGTH} characters`);
    expect(prompt).toContain(
      `what_yes_means and what_no_means must each be at most 1-2 short sentences and at most ${BALLOT_MEASURE_YES_NO_MAX_LENGTH} characters`
    );
  });

  it("requests binary YES-outcome research-area tags from allowed slugs", () => {
    const prompt = buildBallotMeasuresPrompt({
      districtName: "Los Angeles County, California",
      districtType: "county",
      state: "CA",
      electionDate: "2026-06-02",
      officialBallotTitle: "Measure H",
      seedUrls: [],
      allowedResearchAreaSlugs: ["healthcare_affordability", "cost_of_living_reduction"],
    });

    expect(prompt).toContain('"research_area_tags"');
    expect(prompt).toContain("research_area_tags describes the likely policy effect if YES wins / the measure passes.");
    expect(prompt).toContain('"for" means the YES outcome advances');
    expect(prompt).toContain('"against" means the YES outcome cuts against');
    expect(prompt).toContain("Do not tag an area if the effect is mixed, indirect, unclear, or not meaningfully directional.");
    expect(prompt).toContain("best supporting URLs used for this research, up to 20 unique URLs");
    expect(prompt).toContain('- "healthcare_affordability"');
    expect(prompt).toContain('- "cost_of_living_reduction"');
  });

  it("asks for the real effect in plain words and never forces a tag", () => {
    const prompt = buildBallotMeasuresPrompt({
      districtName: "Maryland",
      districtType: "statewide",
      state: "MD",
      electionDate: "2026-11-03",
      officialBallotTitle: "Question 1 - Arbitration Reform for State Employees Act of 2026",
      seedUrls: [],
      allowedResearchAreaSlugs: ["labor_rights"],
    });

    expect(prompt).toContain("an average voter can tell what the measure does and whether it costs them anything");
    expect(prompt).toContain("binding arbitration -> a neutral third party decides");
    expect(prompt).toContain("Say who pays.");
    expect(prompt).toContain("Describe the real effect, not the title.");
    expect(prompt).toContain("Do not tag from the measure title or the sponsor's framing.");
    expect(prompt).toContain("Never force a tag. An empty research_area_tags array is a valid answer");
    // The old wording pushed toward always tagging something.
    expect(prompt).not.toContain("Return an empty research_area_tags array only if");
  });
});

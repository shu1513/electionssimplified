import { describe, expect, it } from "vitest";

import {
  calculateVotePower,
  decisivenessLevelFromContest,
  explainVotePower,
  representationLevelFromScore,
} from "../../../src/pipeline/address/votePower.js";

describe("representationLevelFromScore", () => {
  it("buckets representation scores into graded tiers", () => {
    expect(representationLevelFromScore(90)).toBe("high");
    expect(representationLevelFromScore(66)).toBe("high");
    expect(representationLevelFromScore(65.99)).toBe("above_average");
    expect(representationLevelFromScore(55)).toBe("above_average");
    // 54.99 is still the statewide-baseline tier: a county covering most of
    // its state must not flip on a fraction of a point.
    expect(representationLevelFromScore(54.99)).toBe("medium");
    expect(representationLevelFromScore(50)).toBe("medium");
    expect(representationLevelFromScore(33)).toBe("medium");
    expect(representationLevelFromScore(20)).toBe("low");
  });

  it("treats missing or invalid scores as unknown", () => {
    expect(representationLevelFromScore(null)).toBe("unknown");
    expect(representationLevelFromScore(undefined)).toBe("unknown");
    expect(representationLevelFromScore(Number.NaN)).toBe("unknown");
  });
});

describe("decisivenessLevelFromContest", () => {
  it("buckets historical competitiveness labels", () => {
    expect(decisivenessLevelFromContest({ raceType: "office", candidateCount: 2, competitivenessLabel: "toss_up" })).toBe(
      "high"
    );
    expect(
      decisivenessLevelFromContest({
        raceType: "office",
        candidateCount: 2,
        competitivenessLabel: "very_competitive",
      })
    ).toBe("high");
    expect(
      decisivenessLevelFromContest({ raceType: "office", candidateCount: 2, competitivenessLabel: "competitive" })
    ).toBe("medium");
    expect(
      decisivenessLevelFromContest({
        raceType: "office",
        candidateCount: 2,
        competitivenessLabel: "somewhat_competitive",
      })
    ).toBe("medium");
    expect(decisivenessLevelFromContest({ raceType: "office", candidateCount: 2, competitivenessLabel: "safe" })).toBe(
      "low"
    );
  });

  it("treats one-candidate office races as no decisiveness", () => {
    expect(decisivenessLevelFromContest({ raceType: "office", candidateCount: 1, competitivenessLabel: "toss_up" })).toBe(
      "none"
    );
  });

  it("treats a multi-seat office race as uncontested when the roster fits the seats", () => {
    // Three candidates for three seats: every one of them wins.
    expect(
      decisivenessLevelFromContest({ raceType: "office", candidateCount: 3, seatsToFill: 3, competitivenessLabel: "toss_up" })
    ).toBe("none");
    expect(
      decisivenessLevelFromContest({ raceType: "office", candidateCount: 2, seatsToFill: 3, competitivenessLabel: "safe" })
    ).toBe("none");
    // One more candidate than seats: somebody loses, so the label grades.
    expect(
      decisivenessLevelFromContest({ raceType: "office", candidateCount: 4, seatsToFill: 3, competitivenessLabel: "safe" })
    ).toBe("low");
  });

  it("reads a missing or nonsense seats_to_fill as one seat", () => {
    expect(
      decisivenessLevelFromContest({ raceType: "office", candidateCount: 1, seatsToFill: null, competitivenessLabel: "toss_up" })
    ).toBe("none");
    expect(
      decisivenessLevelFromContest({ raceType: "office", candidateCount: 2, seatsToFill: 0, competitivenessLabel: "toss_up" })
    ).toBe("high");
    expect(
      decisivenessLevelFromContest({ raceType: "office", candidateCount: 2, seatsToFill: 1, competitivenessLabel: "toss_up" })
    ).toBe("high");
  });

  it("does not treat zero-candidate office races as uncontested because rosters may be unloaded", () => {
    expect(
      decisivenessLevelFromContest({
        raceType: "office",
        candidateCount: 0,
        competitivenessLabel: null,
      })
    ).toBe("unknown");
  });

  it("does not treat zero-candidate ballot measures as uncontested", () => {
    expect(
      decisivenessLevelFromContest({
        raceType: "ballot_measure",
        candidateCount: 0,
        competitivenessLabel: null,
      })
    ).toBe("unknown");
  });

  it("treats unexpected competitiveness labels as unknown", () => {
    expect(
      decisivenessLevelFromContest({
        raceType: "office",
        candidateCount: 2,
        competitivenessLabel: "not_a_real_label" as never,
      })
    ).toBe("unknown");
  });
});

describe("calculateVotePower", () => {
  it.each([
    { representationPowerScore: 90, competitivenessLabel: "safe", label: "medium" },
    { representationPowerScore: 90, competitivenessLabel: "competitive", label: "high" },
    { representationPowerScore: 90, competitivenessLabel: "toss_up", label: "very_high" },
    { representationPowerScore: 60, competitivenessLabel: "safe", label: "medium" },
    { representationPowerScore: 60, competitivenessLabel: "competitive", label: "above_average" },
    { representationPowerScore: 60, competitivenessLabel: "toss_up", label: "high" },
    { representationPowerScore: 50, competitivenessLabel: "safe", label: "low" },
    { representationPowerScore: 50, competitivenessLabel: "competitive", label: "medium" },
    { representationPowerScore: 50, competitivenessLabel: "toss_up", label: "high" },
    { representationPowerScore: 20, competitivenessLabel: "safe", label: "low" },
    { representationPowerScore: 20, competitivenessLabel: "competitive", label: "low" },
    { representationPowerScore: 20, competitivenessLabel: "toss_up", label: "medium" },
  ] as const)(
    "maps representation=$representationPowerScore and competitiveness=$competitivenessLabel to $label",
    ({ representationPowerScore, competitivenessLabel, label }) => {
      expect(
        calculateVotePower({
          raceType: "office",
          candidateCount: 2,
          representationPowerScore,
          competitivenessLabel,
        }).label
      ).toBe(label);
    }
  );

  it.each([
    { representationPowerScore: 90, label: "low" },
    { representationPowerScore: 60, label: "low" },
    { representationPowerScore: 50, label: "low" },
    { representationPowerScore: 20, label: "very_low" },
  ] as const)("maps uncontested representation=$representationPowerScore to $label", ({ representationPowerScore, label }) => {
    expect(
      calculateVotePower({
        raceType: "office",
        candidateCount: 1,
        representationPowerScore,
        competitivenessLabel: null,
      }).label
    ).toBe(label);
  });

  it("gives a judicial retention race no rating at all, whatever the inputs", () => {
    // One candidate, but not uncontested: the Yes/No vote decides. Checked
    // before the uncontested rule, so neither the score cap nor the
    // uncontested factor applies.
    expect(
      calculateVotePower({
        raceType: "office",
        officialBallotTitle: "Shall Presiding Justice THERESE M. STEWART be elected to the office for the term provided by law?",
        candidateCount: 1,
        representationPowerScore: 90,
        competitivenessLabel: "toss_up",
      })
    ).toEqual({
      score: null,
      label: "retention",
      confidence: "high",
      representation_level: "unknown",
      decisiveness_level: "unknown",
      factors: [],
    });
    // The title alone is not enough: a ballot measure that mentions a court
    // stays a measure.
    expect(
      calculateVotePower({
        raceType: "ballot_measure",
        officialBallotTitle: "Shall the county retain its Superior Court facilities levy?",
        candidateCount: 0,
        representationPowerScore: 50,
        competitivenessLabel: null,
      }).label
    ).not.toBe("retention");
  });

  it("rates high representation plus high decisiveness as very high", () => {
    expect(
      calculateVotePower({
        raceType: "office",
        candidateCount: 2,
        representationPowerScore: 90,
        competitivenessLabel: "toss_up",
      })
    ).toMatchObject({
      score: 96,
      label: "very_high",
      confidence: "high",
      representation_level: "high",
      decisiveness_level: "high",
      factors: ["high_representation", "high_decisiveness"],
    });
  });

  it("rates high representation plus medium decisiveness as high", () => {
    expect(
      calculateVotePower({
        raceType: "office",
        candidateCount: 2,
        representationPowerScore: 90,
        competitivenessLabel: "competitive",
      })
    ).toMatchObject({
      score: 76,
      label: "high",
      confidence: "high",
      representation_level: "high",
      decisiveness_level: "medium",
    });
  });

  it("rates medium representation plus high decisiveness as high", () => {
    expect(
      calculateVotePower({
        raceType: "office",
        candidateCount: 2,
        representationPowerScore: 50,
        competitivenessLabel: "very_competitive",
      })
    ).toMatchObject({
      score: 69,
      label: "high",
      confidence: "high",
      representation_level: "medium",
      decisiveness_level: "high",
    });
  });

  it("caps one-candidate office races as low power", () => {
    expect(
      calculateVotePower({
        raceType: "office",
        candidateCount: 1,
        representationPowerScore: 90,
        competitivenessLabel: "toss_up",
      })
    ).toMatchObject({
      score: 25,
      label: "low",
      confidence: "high",
      decisiveness_level: "none",
      factors: ["high_representation", "uncontested_race"],
    });
  });

  it("rates ballot measures one tier above the office matrix, with no score bonus", () => {
    // Office: 58 / medium. Measure: same 58, medium → above_average.
    expect(
      calculateVotePower({
        raceType: "ballot_measure",
        candidateCount: 0,
        representationPowerScore: 50,
        competitivenessLabel: "competitive",
      })
    ).toMatchObject({
      score: 58,
      label: "above_average",
      confidence: "high",
      factors: ["medium_representation", "medium_decisiveness", "direct_vote_on_policy"],
    });
  });

  it("lets a measure with close-race evidence reach very high", () => {
    expect(
      calculateVotePower({
        raceType: "ballot_measure",
        candidateCount: 0,
        representationPowerScore: 90,
        competitivenessLabel: "toss_up",
      })
    ).toMatchObject({
      score: 96,
      label: "very_high",
      factors: ["high_representation", "high_decisiveness", "direct_vote_on_policy"],
    });
  });

  it("rates a statewide measure above average: the baseline plus the direct-vote step", () => {
    expect(
      calculateVotePower({
        raceType: "ballot_measure",
        candidateCount: 0,
        representationPowerScore: 50,
        competitivenessLabel: null,
      })
    ).toMatchObject({
      score: 50,
      label: "above_average",
      confidence: "high",
      representation_level: "medium",
      decisiveness_level: "unknown",
      factors: ["medium_representation", "direct_vote_on_policy"],
    });
  });

  it("keeps a partial-data measure under the partial-data ceiling", () => {
    // Unknown representation: the bumped label stays under the "high" cap.
    expect(
      calculateVotePower({
        raceType: "ballot_measure",
        candidateCount: 0,
        representationPowerScore: null,
        competitivenessLabel: "toss_up",
      })
    ).toMatchObject({
      score: 79,
      label: "high",
      confidence: "medium",
      factors: ["missing_representation_data", "high_decisiveness", "direct_vote_on_policy"],
    });
  });

  it("keeps continuous scores more precise than display buckets", () => {
    const tossUp = calculateVotePower({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 50,
      competitivenessLabel: "toss_up",
    });
    const veryCompetitive = calculateVotePower({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 50,
      competitivenessLabel: "very_competitive",
    });

    expect(tossUp).toMatchObject({
      score: 78,
      label: "high",
      decisiveness_level: "high",
    });
    expect(veryCompetitive).toMatchObject({
      score: 69,
      label: "high",
      decisiveness_level: "high",
    });
  });

  it("rates a measure on representation alone when decisiveness is structurally unavailable", () => {
    // high → very_high by the direct-vote bump, then capped back to high:
    // "very high" needs close-race evidence, which a measure without history
    // cannot have.
    expect(
      calculateVotePower({
        raceType: "ballot_measure",
        candidateCount: 0,
        representationPowerScore: 90,
        competitivenessLabel: null,
      })
    ).toMatchObject({
      score: 90,
      label: "high",
      confidence: "high",
      representation_level: "high",
      decisiveness_level: "unknown",
      factors: ["high_representation", "direct_vote_on_policy"],
    });
  });

  it("keeps ballot measure power unknown when representation is unknown", () => {
    expect(
      calculateVotePower({
        raceType: "ballot_measure",
        candidateCount: 0,
        representationPowerScore: null,
        competitivenessLabel: null,
      })
    ).toMatchObject({
      score: null,
      label: "unknown",
      confidence: "low",
      factors: ["missing_representation_data", "missing_decisiveness_data", "direct_vote_on_policy"],
    });
  });

  it("uses representation only when decisiveness is unknown", () => {
    expect(
      calculateVotePower({
        raceType: "office",
        candidateCount: 2,
        representationPowerScore: 90,
        competitivenessLabel: null,
      })
    ).toMatchObject({
      score: 79,
      label: "high",
      confidence: "medium",
      representation_level: "high",
      decisiveness_level: "unknown",
      factors: ["high_representation", "missing_decisiveness_data"],
    });
  });

  it("uses decisiveness only when representation is unknown", () => {
    expect(
      calculateVotePower({
        raceType: "office",
        candidateCount: 2,
        representationPowerScore: null,
        competitivenessLabel: "toss_up",
      })
    ).toMatchObject({
      score: 79,
      label: "high",
      confidence: "medium",
      representation_level: "unknown",
      decisiveness_level: "high",
      factors: ["missing_representation_data", "high_decisiveness"],
    });
  });

  it("returns unknown when both core inputs are unknown", () => {
    expect(
      calculateVotePower({
        raceType: "office",
        candidateCount: 2,
        representationPowerScore: null,
        competitivenessLabel: null,
      })
    ).toMatchObject({
      score: null,
      label: "unknown",
      confidence: "low",
      factors: ["missing_representation_data", "missing_decisiveness_data"],
    });
  });
});

describe("explainVotePower", () => {
  function explain(input: Parameters<typeof explainVotePower>[0]) {
    return explainVotePower(input, calculateVotePower(input));
  }

  it("explains a fully-known contested office race with graded parts, stats, and no caveat", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 68.38,
      competitivenessLabel: "toss_up",
      districtPopulation: 736081,
      representationScope: { statePopulation: 39287377, description: "a statewide vote in CA" },
      marginPercent: 1.8,
      marginElectionYears: [2022],
    });

    // The how copy explains the displayed label (grade combination), never
    // the internal 45/55 sorting-score formula.
    expect(explanation.how).toBe(
      "What determines the vote power rating:\n\nRepresentation: how much weight one vote carries here compared with a statewide vote — the smaller the district, the more each vote counts.\n\nDecisiveness: how likely this race is to be close, based on past results or current analyst ratings, plus whether more candidates are running than there are seats."
    );
    expect(explanation.parts).toEqual([
      {
        title: "Representation",
        grade: "High",
        stat: "68 out of 100",
        detail:
          "This district is a small slice of its state, so each vote here carries much more weight than a vote in a statewide race. About 736,081 people live here.",
        formula:
          "score = 50 + 50 × ln(state population ÷ this district's) ÷ ln(50,000) = 50 + 50 × ln(39,287,377 ÷ 736,081) ÷ ln(50,000) = 68.38, measured against a statewide vote in CA (grades: 66+ high, 55+ above average, 33+ average, otherwise low; a statewide race is the 50 baseline)",
      },
      {
        title: "Decisiveness",
        grade: "High",
        stat: "1.8-point margin in 2022",
        detail: "Past results here were very close — a small number of votes could decide the winner.",
        formula:
          'margin = 1.8 points → "toss-up" → grade high (margins, first match: ≤2 toss-up, ≤5 very competitive, ≤10 competitive, ≤15 somewhat competitive, otherwise not competitive; toss-up and very competitive grade high, competitive and somewhat competitive grade average, not competitive grades low)',
      },
    ]);
    expect(explanation.result).toBe("High representation + high decisiveness → My vote power: Very high.");
    expect(explanation.caveat).toBeNull();
  });

  it("falls back to a symbolic representation formula when scope extremes are unavailable", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 90,
      competitivenessLabel: null,
      districtPopulation: 736081,
    });

    expect(explanation.parts[0]?.formula).toBe(
      "score = 50 + 50 × ln(state population ÷ this district's population) ÷ ln(50,000), kept between 50 and 100 and rounded to 2 decimals = 90 (grades: 66+ high, 55+ above average, 33+ average, otherwise low; a statewide race is the 50 baseline)"
    );
  });

  it("shows the weighted blend arithmetic in the decisiveness formula", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 50,
      competitivenessLabel: "somewhat_competitive",
      marginPercent: 11.3,
      marginElectionYears: [2024, 2022],
      marginContests: [
        { marginPercent: 9.2, electionYear: 2024, weight: 0.625 },
        { marginPercent: 14.8, electionYear: 2022, weight: 0.375 },
      ],
    });

    expect(explanation.parts[1]?.formula).toBe(
      'margin = 0.625 × 9.2 (2024) + 0.375 × 14.8 (2022) = 11.3 points → "somewhat competitive" → grade average (margins, first match: ≤2 toss-up, ≤5 very competitive, ≤10 competitive, ≤15 somewhat competitive, otherwise not competitive; toss-up and very competitive grade high, competitive and somewhat competitive grade average, not competitive grades low)'
    );
  });

  it("floors the representation stat so the displayed number stays in the grade's bucket", () => {
    // 65.6 is above average (< 66); rounding would display the
    // high-threshold 66 and contradict the stated grade.
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 65.6,
      competitivenessLabel: "safe",
    });

    expect(explanation.parts[0]).toMatchObject({ grade: "Above average", stat: "65 out of 100" });
    // Without a population the detail stays a single sentence.
    expect(explanation.parts[0]?.detail).toBe(
      "This district is a good deal smaller than its state, so each vote here carries more weight than a vote in a statewide race."
    );
    expect(explanation.result).toBe("Above average representation + low decisiveness → My vote power: Average.");
  });

  it("keeps the statewide-baseline copy for a score under the above-average threshold", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 54.6,
      competitivenessLabel: null,
    });

    expect(explanation.parts[0]).toMatchObject({ grade: "Average", stat: "54 out of 100" });
    expect(explanation.parts[0]?.detail).toBe(
      "This district covers a large share of its state, so each vote carries about average weight — like a vote in a statewide race."
    );
    expect(explanation.result).toBe("Average representation → My vote power: Average.");
  });

  it("drops the margin year from the stat when it is not provided", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 50,
      competitivenessLabel: "safe",
      marginPercent: 40,
    });

    expect(explanation.parts[1]).toMatchObject({ grade: "Low", stat: "40-point margin" });
    expect(explanation.result).toBe("Average representation + low decisiveness → My vote power: Below average.");
  });

  it('displays a medium rating as "Average" in the result line', () => {
    // medium representation + medium decisiveness → medium label; every
    // user-visible "medium" — both axes and the rating — reads "average".
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 50,
      competitivenessLabel: "competitive",
      marginPercent: 8,
    });

    expect(explanation.result).toBe("Average representation + average decisiveness → My vote power: Average.");
  });

  it("labels a multi-year margin as a weighted blend instead of pinning it on one year", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 50,
      competitivenessLabel: "somewhat_competitive",
      marginPercent: 11.45,
      marginElectionYears: [2024, 2022],
    });

    expect(explanation.parts[1]?.stat).toBe("11.45-point weighted margin across 2024 and 2022");
  });

  it("explains a retention race with no graded parts", () => {
    const input = {
      raceType: "office" as const,
      officialBallotTitle: "Retention of District Court Judge Pat Example",
      candidateCount: 1,
      representationPowerScore: 90,
      competitivenessLabel: null,
    };
    expect(explainVotePower(input, calculateVotePower(input))).toEqual({
      how: "A retention race asks Yes or No on keeping one judge in office. With no competing candidates, the normal vote power rating methods don't apply.",
      parts: [],
      result: "Retention race",
      caveat: null,
    });
  });

  it("explains an uncontested race without a margin stat", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 1,
      representationPowerScore: 90,
      competitivenessLabel: "toss_up",
      marginPercent: 3.25,
      marginElectionYears: [2022],
    });

    expect(explanation.parts[1]).toEqual({
      title: "Decisiveness",
      grade: "None",
      stat: "only 1 candidate",
      detail: "One candidate is running unopposed, so votes can't change the outcome.",
      formula: null,
    });
    expect(explanation.result).toBe("High representation + an uncontested race → My vote power: Below average.");
  });

  it("explains a multi-seat uncontested race with both counts", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 3,
      seatsToFill: 3,
      representationPowerScore: 90,
      competitivenessLabel: "toss_up",
      marginPercent: 3.25,
      marginElectionYears: [2022],
    });

    expect(explanation.parts[1]).toEqual({
      title: "Decisiveness",
      grade: "None",
      stat: "3 candidates for 3 seats",
      detail: "Every candidate on the ballot wins a seat, so votes can't change the outcome.",
      formula: null,
    });
    expect(explanation.result).toBe("High representation + an uncontested race → My vote power: Below average.");
  });

  it("qualifies decisiveness when the historical results predate redistricting", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 90,
      competitivenessLabel: "toss_up",
      staleAfterRedistricting: true,
    });

    expect(explanation.parts[1]?.detail).toBe(
      "Past results here were very close — a small number of votes could decide the winner. District lines have changed since then, so older results are a weaker guide."
    );
    // Staleness qualifies historical evidence only; representation is a
    // present-day population measure.
    expect(explanation.parts[0]?.detail).not.toContain("District lines");
  });

  it("skips the decisiveness row for a measure when history is structurally absent, with no measure row", () => {
    const explanation = explain({
      raceType: "ballot_measure",
      candidateCount: 0,
      representationPowerScore: 90,
      competitivenessLabel: null,
    });

    expect(explanation.parts.map((part) => part.title)).toEqual(["Representation"]);
    // Measures get their own "how" copy: no decisiveness paragraph (the
    // panel shows no such row), the direct-vote step in its place.
    expect(explanation.how).toBe(
      "What determines the vote power rating for ballot measures:\n\nRepresentation: how much weight one vote carries here compared with a statewide vote — the smaller the district, the more each vote counts.\n\nYou have more power in ballot measures because you vote directly on the policy."
    );
    // The direct-vote step is named in the sum even when the bump was capped
    // (high → very high → back to high): it is still part of the rating.
    expect(explanation.result).toBe("High representation + a direct vote on the policy → My vote power: High.");
    expect(explanation.caveat).toBeNull();
  });

  it("explains a statewide measure as the baseline plus the direct vote", () => {
    const explanation = explain({
      raceType: "ballot_measure",
      candidateCount: 0,
      representationPowerScore: 50,
      competitivenessLabel: null,
    });

    expect(explanation.parts[0]).toMatchObject({ grade: "Average", stat: "50 out of 100" });
    expect(explanation.result).toBe(
      "Average representation + a direct vote on the policy → My vote power: Above average."
    );
    expect(explanation.caveat).toBeNull();
  });

  it("keeps the decisiveness row for ballot measures that have history", () => {
    const explanation = explain({
      raceType: "ballot_measure",
      candidateCount: 0,
      representationPowerScore: 50,
      competitivenessLabel: "competitive",
    });

    expect(explanation.parts.map((part) => part.title)).toEqual(["Representation", "Decisiveness"]);
    expect(explanation.result).toBe(
      "Average representation + average decisiveness + a direct vote on the policy → My vote power: Above average."
    );
  });

  it("rates a measure with unknown representation on decisiveness alone", () => {
    const explanation = explain({
      raceType: "ballot_measure",
      candidateCount: 0,
      representationPowerScore: null,
      competitivenessLabel: "toss_up",
    });

    expect(explanation.parts.map((part) => part.title)).toEqual(["Representation", "Decisiveness"]);
    expect(explanation.result).toBe("High decisiveness + a direct vote on the policy → My vote power: High.");
  });

  it("carries a partial-data caveat when one core axis is missing", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 90,
      competitivenessLabel: null,
    });

    expect(explanation.parts[1]).toEqual({
      title: "Decisiveness",
      grade: "Unknown",
      stat: null,
      detail: "No analyst ratings or past results for this contest yet.",
      formula: null,
    });
    expect(explanation.result).toBe("High representation → My vote power: High.");
    expect(explanation.caveat).toBe(
      'Some data is missing, so this rating is based on partial information and capped at "High".'
    );
  });

  it("reports no rating when both core axes are missing", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: null,
      competitivenessLabel: null,
    });

    expect(explanation.parts).toEqual([
      {
        title: "Representation",
        grade: "Unknown",
        stat: null,
        detail: "We don't have a representation score for this district yet.",
        formula: null,
      },
      {
        title: "Decisiveness",
        grade: "Unknown",
        stat: null,
        detail: "No analyst ratings or past results for this contest yet.",
        formula: null,
      },
    ]);
    expect(explanation.result).toBe("Not enough data → no rating yet.");
    expect(explanation.caveat).toBe("Not enough data to rate this election yet.");
  });

  it("shows boundary margins at the classifier's two-decimal precision", () => {
    // A 2.04 margin grades "very competitive" (not ≤2); displaying it as
    // "2 points" would contradict the ≤2 toss-up rule shown beside it.
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 50,
      competitivenessLabel: "very_competitive",
      marginPercent: 2.04,
      marginElectionYears: [2024],
    });

    expect(explanation.parts[1]?.stat).toBe("2.04-point margin in 2024");
    expect(explanation.parts[1]?.formula).toContain('margin = 2.04 points → "very competitive" → grade high');
  });

  it("renders the statewide baseline as a plain ln(1) equation equal to 50", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 50,
      competitivenessLabel: null,
      districtPopulation: 39287377,
      representationScope: { statePopulation: 39287377, description: "a statewide vote in CA" },
    });

    expect(explanation.parts[0]?.formula).toBe(
      "score = 50 + 50 × ln(state population ÷ this district's) ÷ ln(50,000) = 50 + 50 × ln(39,287,377 ÷ 39,287,377) ÷ ln(50,000) = 50, measured against a statewide vote in CA (grades: 66+ high, 55+ above average, 33+ average, otherwise low; a statewide race is the 50 baseline)"
    );
  });

  it("names the 100 cap when a tiny district's raw score exceeds it", () => {
    // 39,287,377 ÷ 500 is a ratio above the 50,000 ruler: raw 102.09 stores
    // as 100, so the equation must not claim the arithmetic equals 100.
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 100,
      competitivenessLabel: null,
      districtPopulation: 500,
      representationScope: { statePopulation: 39287377, description: "a statewide vote in CA" },
    });

    expect(explanation.parts[0]?.formula).toBe(
      "score = 50 + 50 × ln(state population ÷ this district's) ÷ ln(50,000) = 50 + 50 × ln(39,287,377 ÷ 500) ÷ ln(50,000) = 102.09, capped at 100, measured against a statewide vote in CA (grades: 66+ high, 55+ above average, 33+ average, otherwise low; a statewide race is the 50 baseline)"
    );
  });

  it("degrades to the symbolic formula when the stored score no longer matches the live populations", () => {
    // Stored 90 but the live scope recomputes to 68.38: emitting the numeric
    // equation would show arithmetic that does not produce the printed score.
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 90,
      competitivenessLabel: null,
      districtPopulation: 736081,
      representationScope: { statePopulation: 39287377, description: "a statewide vote in CA" },
    });

    expect(explanation.parts[0]?.formula).toBe(
      "score = 50 + 50 × ln(state population ÷ this district's population) ÷ ln(50,000), kept between 50 and 100 and rounded to 2 decimals = 90 (grades: 66+ high, 55+ above average, 33+ average, otherwise low; a statewide race is the 50 baseline)"
    );
  });
});

describe("explainVotePower with a current race rating", () => {
  function explain(input: Parameters<typeof explainVotePower>[0]) {
    return explainVotePower(input, calculateVotePower(input));
  }

  const RATING_SCALE =
    "(d: toss-up 0, tilt 2, lean(s) 3, likely 4, solid/safe 5; mean, first match: <1 toss-up, <2.5 very competitive, <3.5 competitive, <4.5 somewhat competitive, otherwise not competitive; toss-up and very competitive grade high, competitive and somewhat competitive grade average, not competitive grades low)";

  it("swaps the decisiveness part to analyst-rating copy with the real derivation", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 94.44,
      competitivenessLabel: "competitive",
      currentRating: {
        asOf: "2026-08-06",
        method: "outlet_consensus",
        confidence: "high",
        outlets: [
          { outlet: "inside_elections", rawRating: "Tilt Democrat", intensity: 2 },
          { outlet: "sabato", rawRating: "Leans Democratic", intensity: 3 },
        ],
      },
    });

    expect(explanation.how).toBe(
      "What determines the vote power rating:\n\nRepresentation: how much weight one vote carries here compared with a statewide vote — the smaller the district, the more each vote counts.\n\nDecisiveness: how likely this race is to be close, based on past results or current analyst ratings, plus whether more candidates are running than there are seats."
    );
    expect(explanation.parts[1]).toEqual({
      title: "Decisiveness",
      grade: "Average",
      stat: "rated competitive as of August 6, 2026",
      detail:
        "Election analysts currently rate this race somewhat close. Rating from Inside Elections and University of Virginia's Sabato's Crystal Ball.",
      formula: `IE "Tilt Democrat" (d=2) + Sabato "Leans Democratic" (d=3) → mean 2.5 → "competitive" → grade average ${RATING_SCALE}`,
    });
    // Two agreeing outlets = high rating confidence: no rating caveat.
    expect(explanation.caveat).toBeNull();
  });

  it("marks the formula when a consensus guardrail moved the label off the plain mean bin", () => {
    // Solid D + Solid R: mean 5 bins to safe, but the opposite-favored
    // guardrail stores very_competitive with medium confidence.
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 94.44,
      competitivenessLabel: "very_competitive",
      currentRating: {
        asOf: "2026-08-06",
        method: "outlet_consensus",
        confidence: "medium",
        outlets: [
          { outlet: "inside_elections", rawRating: "Solid Democrat", intensity: 5 },
          { outlet: "sabato", rawRating: "Safe Republican", intensity: 5 },
        ],
      },
    });

    expect(explanation.parts[1]?.formula).toBe(
      `IE "Solid Democrat" (d=5) + Sabato "Safe Republican" (d=5) → mean 5 → "very competitive" after consensus guardrails → grade high ${RATING_SCALE}`
    );
    expect(explanation.caveat).toBe(
      "Election analysts disagree on which side is favored here, so the current rating is less certain."
    );
  });

  it("caveats a single-outlet rating and keeps the one-term formula", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: 94.44,
      competitivenessLabel: "safe",
      currentRating: {
        asOf: "2026-07-30",
        method: "outlet_consensus",
        confidence: "medium",
        outlets: [{ outlet: "inside_elections", rawRating: "Solid Republican", intensity: 5 }],
      },
    });

    expect(explanation.parts[1]).toMatchObject({
      grade: "Low",
      stat: "rated not competitive as of July 30, 2026",
      detail: "Election analysts currently rate this race not competitive. Rating from Inside Elections.",
      formula: `IE "Solid Republican" (d=5) → mean 5 → "not competitive" → grade low ${RATING_SCALE}`,
    });
    expect(explanation.caveat).toBe(
      "The current race rating comes from a single analyst source, so it is less certain."
    );
  });

  it("joins the missing-data caveat and the rating caveat when both apply", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 2,
      representationPowerScore: null,
      competitivenessLabel: "toss_up",
      currentRating: {
        asOf: "2026-08-06",
        method: "outlet_consensus",
        confidence: "medium",
        outlets: [{ outlet: "inside_elections", rawRating: "Toss-up", intensity: 0 }],
      },
    });

    expect(explanation.caveat).toBe(
      'Some data is missing, so this rating is based on partial information and capped at "High". The current race rating comes from a single analyst source, so it is less certain.'
    );
  });

  it("keeps uncontested precedence: one candidate ignores the current rating everywhere", () => {
    const explanation = explain({
      raceType: "office",
      candidateCount: 1,
      representationPowerScore: 94.44,
      competitivenessLabel: "toss_up",
      currentRating: {
        asOf: "2026-08-06",
        method: "outlet_consensus",
        confidence: "medium",
        outlets: [{ outlet: "inside_elections", rawRating: "Toss-up", intensity: 0 }],
      },
    });

    expect(explanation.parts[1]).toMatchObject({
      grade: "None",
      stat: "only 1 candidate",
      detail: "One candidate is running unopposed, so votes can't change the outcome.",
      formula: null,
    });
    // The rating did not drive the grade, so neither the how copy nor the
    // caveat may claim it.
    expect(explanation.how).toContain("based on past results");
    expect(explanation.caveat).toBeNull();
  });
});

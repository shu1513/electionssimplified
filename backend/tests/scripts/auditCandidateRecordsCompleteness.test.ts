import { describe, expect, it } from "vitest";

import {
  buildAuditTargetConditions,
  extractAuditEvidenceEntries,
  isConfirmedNull,
  listRouteCoverageGaps,
  listSharedFindingTexts,
  listUnsearchedFindingGaps,
  SHARED_FINDING_MIN_CANDIDATES,
  SHARED_FINDING_MIN_LENGTH,
  type SweepConfirmationDetectorRow,
} from "../../src/scripts/auditCandidateRecordsCompleteness.js";

describe("buildAuditTargetConditions", () => {
  it("returns no conditions when no filters are set", () => {
    const result = buildAuditTargetConditions({
      candidateId: null,
      electionId: null,
      districtId: null,
    });
    expect(result.conditions).toEqual([]);
    expect(result.values).toEqual([]);
  });

  it("builds a direct candidate condition", () => {
    const result = buildAuditTargetConditions({
      candidateId: "11111111-1111-1111-1111-111111111111",
      electionId: null,
      districtId: null,
    });
    expect(result.conditions).toEqual(["c.id = $1::uuid"]);
    expect(result.values).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  it("builds EXISTS conditions for election and district so aggregation rows stay unfiltered", () => {
    const result = buildAuditTargetConditions({
      candidateId: null,
      electionId: "22222222-2222-2222-2222-222222222222",
      districtId: "33333333-3333-3333-3333-333333333333",
    });
    expect(result.conditions).toHaveLength(2);
    expect(result.conditions[0]).toContain("EXISTS");
    expect(result.conditions[0]).toContain("cef.election_id = $1::uuid");
    expect(result.conditions[1]).toContain("EXISTS");
    expect(result.conditions[1]).toContain("ef.district_id = $2::uuid");
    expect(result.values).toEqual([
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    ]);
  });

  it("accepts joint-ticket running mates through either side of the election link", () => {
    const result = buildAuditTargetConditions({
      candidateId: null,
      electionId: "22222222-2222-2222-2222-222222222222",
      districtId: "33333333-3333-3333-3333-333333333333",
    });
    for (const condition of result.conditions) {
      expect(condition).toContain("cef.candidate_id = c.id OR cef.running_mate_candidate_id = c.id");
    }
  });

  it("combines all three filters with sequential placeholders", () => {
    const result = buildAuditTargetConditions({
      candidateId: "11111111-1111-1111-1111-111111111111",
      electionId: "22222222-2222-2222-2222-222222222222",
      districtId: "33333333-3333-3333-3333-333333333333",
    });
    expect(result.conditions[0]).toContain("$1");
    expect(result.conditions[1]).toContain("$2");
    expect(result.conditions[2]).toContain("$3");
    expect(result.values).toHaveLength(3);
  });
});

function detectorRow(
  overrides: Partial<SweepConfirmationDetectorRow> & { candidate_id: string }
): SweepConfirmationDetectorRow {
  return {
    display_name: `Candidate ${overrides.candidate_id}`,
    has_held_public_office: null,
    confirmed_at: "2026-07-15T12:00:00Z",
    evidence: { entries: [] },
    context_type: "election",
    context_id: "11111111-1111-1111-1111-111111111111",
    discovery_contest_family: null,
    context_election_found: true,
    ...overrides,
  };
}

function entriesWithIds(ids: readonly (string | null)[], finding = "nothing found") {
  return {
    entries: ids.map((id, index) => ({
      question: `Question ${index + 1}?`,
      finding,
      ...(id ? { question_id: id } : {}),
    })),
  };
}

describe("extractAuditEvidenceEntries", () => {
  it("reads entries defensively and skips malformed rows", () => {
    expect(extractAuditEvidenceEntries(null)).toEqual([]);
    expect(extractAuditEvidenceEntries({ entries: "nope" })).toEqual([]);
    expect(
      extractAuditEvidenceEntries({
        entries: [
          { question: "Q?", finding: "  found something  ", question_id: "career" },
          { question: "Q2?", finding: "   " },
          "not-an-object",
          { question: "Q3?", finding: "untagged answer" },
        ],
      })
    ).toEqual([
      { finding: "found something", questionId: "career" },
      { finding: "untagged answer", questionId: null },
    ]);
  });
});

describe("listSharedFindingTexts", () => {
  const template =
    "No roll-call votes found; this candidate has not served in a state or federal legislature.";

  it("flags long finding text repeated verbatim across enough distinct candidates", () => {
    const rows = ["a", "b", "c"].map((id) =>
      detectorRow({
        candidate_id: id,
        evidence: { entries: [{ question: "Votes?", finding: template }] },
      })
    );

    const groups = listSharedFindingTexts(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ findingText: template, candidateCount: 3 });
    expect(groups[0]?.sampleCandidates.map((c) => c.candidateId)).toEqual(["a", "b", "c"]);
  });

  it("matches case- and whitespace-insensitively but does not double-count a candidate", () => {
    const rows = [
      detectorRow({
        candidate_id: "a",
        evidence: {
          entries: [
            { question: "Votes?", finding: template },
            { question: "Votes again?", finding: template.toUpperCase() },
          ],
        },
      }),
      detectorRow({
        candidate_id: "b",
        evidence: { entries: [{ question: "Votes?", finding: template.replace(/ /g, "  ") }] },
      }),
      detectorRow({
        candidate_id: "c",
        evidence: { entries: [{ question: "Votes?", finding: template }] },
      }),
    ];

    const groups = listSharedFindingTexts(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.candidateCount).toBe(3);
  });

  it("exempts short negative findings and under-threshold groups", () => {
    expect("nothing found".length).toBeLessThan(SHARED_FINDING_MIN_LENGTH);
    const shortRows = ["a", "b", "c", "d"].map((id) =>
      detectorRow({
        candidate_id: id,
        evidence: { entries: [{ question: "Votes?", finding: "nothing found" }] },
      })
    );
    expect(listSharedFindingTexts(shortRows)).toEqual([]);

    const underThreshold = ["a", "b"].map((id) =>
      detectorRow({
        candidate_id: id,
        evidence: { entries: [{ question: "Votes?", finding: template }] },
      })
    );
    expect(SHARED_FINDING_MIN_CANDIDATES).toBe(3);
    expect(listSharedFindingTexts(underThreshold)).toEqual([]);
  });
});

describe("listUnsearchedFindingGaps", () => {
  it("flags confirmations whose entries admit a question was not searched, most gaps first", () => {
    const rows = [
      detectorRow({
        candidate_id: "a",
        evidence: {
          entries: [
            { question: "Votes?", finding: "Clerk XML import covers 2019-2021.", question_id: "rollcalls" },
            { question: "Proceedings?", finding: "Not searched this pass; open coverage gap.", question_id: "proceedings" },
          ],
        },
      }),
      detectorRow({
        candidate_id: "b",
        evidence: {
          entries: [
            { question: "Leadership?", finding: "Not searched this pass; open coverage gap.", question_id: "leadership" },
            { question: "Endorsements?", finding: "not yet searched", question_id: "endorsements" },
            { question: "Career?", finding: "nothing found", question_id: "career" },
          ],
        },
      }),
      detectorRow({
        candidate_id: "c",
        evidence: { entries: [{ question: "Court?", finding: "Nothing found in accessible sources; MyCase not searched by name.", question_id: "court_legal" }] },
      }),
    ];
    const gaps = listUnsearchedFindingGaps(rows);
    expect(gaps.map((gap) => gap.candidateId)).toEqual(["b", "a"]);
    expect(gaps[0]).toMatchObject({ unsearchedQuestionIds: ["leadership", "endorsements"] });
    expect(gaps[1]?.sampleFinding).toBe("Not searched this pass; open coverage gap.");
  });
});

describe("listRouteCoverageGaps", () => {
  it("accepts a confirmation covering the route matching the stored routing fact", () => {
    const officeholder = detectorRow({
      candidate_id: "a",
      has_held_public_office: true,
      evidence: entriesWithIds([
        "rollcalls",
        "sponsorship",
        "executive",
        "proceedings",
        "leadership",
        "outside_chamber",
        "endorsements",
      ]),
    });
    const neverHeld = detectorRow({
      candidate_id: "b",
      has_held_public_office: false,
      evidence: entriesWithIds(["career", "orgs_advocacy", "court_legal", "endorsements"]),
    });
    expect(listRouteCoverageGaps([officeholder, neverHeld])).toEqual([]);
  });

  it("requires the judicial route on judicial election contexts, for both routing answers", () => {
    const judicialLedgers = [true, false].map((hasHeld, index) =>
      detectorRow({
        candidate_id: `judge-${index}`,
        has_held_public_office: hasHeld,
        discovery_contest_family: "judicial_office",
        evidence: entriesWithIds(["cases", "discipline", "endorsements"]),
      })
    );
    expect(listRouteCoverageGaps(judicialLedgers)).toEqual([]);

    // An officeholder-covered ledger on a judicial contest is the wrong
    // route even though the tags form a complete list.
    const wrongRouteOnJudicial = detectorRow({
      candidate_id: "judge-wrong",
      has_held_public_office: true,
      discovery_contest_family: "judicial_office",
      evidence: entriesWithIds([
        "rollcalls",
        "sponsorship",
        "executive",
        "proceedings",
        "leadership",
        "outside_chamber",
        "endorsements",
      ]),
    });
    const gaps = listRouteCoverageGaps([wrongRouteOnJudicial]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain("allowed: judicial");
  });

  it("rejects judicial-only tags on non-judicial contexts", () => {
    const mayoral = detectorRow({
      candidate_id: "mayor",
      has_held_public_office: true,
      evidence: entriesWithIds(["cases", "discipline", "endorsements"]),
    });
    const presidential = detectorRow({
      candidate_id: "pres",
      context_type: "presidential_cycle",
      has_held_public_office: true,
      evidence: entriesWithIds(["cases", "discipline", "endorsements"]),
    });
    const gaps = listRouteCoverageGaps([mayoral, presidential]);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.reason).toContain("allowed: officeholder");
  });

  it("permits the judicial route only when the election context row is missing", () => {
    const orphaned = detectorRow({
      candidate_id: "orphan",
      context_election_found: false,
      evidence: entriesWithIds(["cases", "discipline", "endorsements"]),
    });
    expect(listRouteCoverageGaps([orphaned])).toEqual([]);
  });

  it("flags untagged pre-#350 ledgers (the 2026-07-15 cohort) with the no-tags reason", () => {
    const row = detectorRow({
      candidate_id: "a",
      evidence: entriesWithIds([null, null, null, null]),
    });
    const gaps = listRouteCoverageGaps([row]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      candidateId: "a",
      taggedQuestionIds: [],
      reason: "no question_id tags (pre-#350 ledger or untagged template)",
    });
  });

  it("flags a wrong-route ledger against the stored routing fact", () => {
    // Never-held candidate whose ledger covers the officeholder list: the
    // exact 07-15 failure shape, now visible retroactively.
    const row = detectorRow({
      candidate_id: "a",
      has_held_public_office: false,
      evidence: entriesWithIds([
        "rollcalls",
        "sponsorship",
        "executive",
        "proceedings",
        "leadership",
        "outside_chamber",
        "endorsements",
      ]),
    });
    const gaps = listRouteCoverageGaps([row]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain("allowed: never_held_office");
  });

  it("accepts any complete route when the routing fact is unknown", () => {
    const row = detectorRow({
      candidate_id: "a",
      has_held_public_office: null,
      evidence: entriesWithIds(["career", "orgs_advocacy", "court_legal", "endorsements"]),
    });
    expect(listRouteCoverageGaps([row])).toEqual([]);
  });

  it("flags an incomplete route even with some valid tags", () => {
    const row = detectorRow({
      candidate_id: "a",
      has_held_public_office: false,
      evidence: entriesWithIds(["career", "endorsements"]),
    });
    const gaps = listRouteCoverageGaps([row]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.taggedQuestionIds).toEqual(["career", "endorsements"]);
  });
});

describe("isConfirmedNull", () => {
  it("requires a covering confirmation with the no_records_found gap id", () => {
    expect(
      isConfirmedNull({
        confirmed_gap_ids: ["candidate_records.no_records_found"],
        confirmation_covers_latest_search: true,
      })
    ).toBe(true);
    expect(
      isConfirmedNull({
        confirmed_gap_ids: ["candidate_records.no_records_found"],
        confirmation_covers_latest_search: false,
      })
    ).toBe(false);
    expect(
      isConfirmedNull({
        confirmed_gap_ids: [],
        confirmation_covers_latest_search: true,
      })
    ).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  applyAutoPicks,
  AutoPickError,
  clearAutoPicks,
  decideMeasure,
  decideOfficeRace,
  decideRetentionRace,
  type AutoPickCandidate,
  type AutoPickIssue,
  type AutoPickMeasureTag,
  type AutoPickRecordTag,
} from "../../../src/pipeline/users/autoPick.js";

const AREA_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const AREA_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const AREA_3 = "aaaaaaaa-0000-4000-8000-000000000003";
const AREA_ETHICS = "aaaaaaaa-0000-4000-8000-00000000000e";
const CAND_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const CAND_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CAND_C = "bbbbbbbb-0000-4000-8000-00000000000c";
const CAND_D = "bbbbbbbb-0000-4000-8000-00000000000d";

function issue(
  researchAreaId: string,
  rank: number | null,
  overrides: Partial<Pick<AutoPickIssue, "slug" | "direction" | "hardVeto">> = {}
): AutoPickIssue {
  return {
    researchAreaId,
    rank,
    slug: overrides.slug ?? `area-${researchAreaId.slice(-1)}`,
    direction: overrides.direction ?? "support",
    hardVeto: overrides.hardVeto ?? false,
  };
}

function candidate(candidateId: string, displayName: string, neverResearched = false): AutoPickCandidate {
  return { candidateId, displayName, neverResearched };
}

let recordCounter = 0;
function tag(
  candidateId: string,
  researchAreaId: string,
  stance: "for" | "against" | null,
  description = "a record"
): AutoPickRecordTag {
  recordCounter += 1;
  return {
    candidateId,
    recordId: `cccccccc-0000-4000-8000-${String(recordCounter).padStart(12, "0")}`,
    researchAreaId,
    stance,
    description,
  };
}

function measureTag(researchAreaId: string, stance: "for" | "against"): AutoPickMeasureTag {
  return { researchAreaId, stance };
}

const THREE_ISSUES = [issue(AREA_1, 1), issue(AREA_2, 2), issue(AREA_3, 3)];

describe("decideOfficeRace", () => {
  it("picks the highest-scoring positive candidate for a single seat", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice"), candidate(CAND_B, "Bob")],
      [tag(CAND_A, AREA_1, "for"), tag(CAND_B, AREA_2, "for")],
      1
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBeNull();
    expect(decision.pickedCandidateIds).toEqual([CAND_A]);
    expect(decision.shortlistCandidateIds).toEqual([]);
    expect(decision.unresearched).toEqual([]);
  });

  it("caps per-issue volume at ±3: 30 aligned records tie 3 aligned records", () => {
    const incumbentTags = Array.from({ length: 30 }, () => tag(CAND_A, AREA_1, "for"));
    const challengerTags = Array.from({ length: 3 }, () => tag(CAND_B, AREA_1, "for"));
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Incumbent"), candidate(CAND_B, "Challenger")],
      [...incumbentTags, ...challengerTags],
      1
    );
    expect(decision.outcome).toBe("no_pick");
    expect(decision.reason).toBe("tie");
    expect(decision.pickedCandidateIds).toEqual([]);
    expect(new Set(decision.shortlistCandidateIds)).toEqual(new Set([CAND_A, CAND_B]));
  });

  it("lets one positively evidenced candidate win over unresearched opponents, reporting them", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [
        candidate(CAND_A, "Evidenced"),
        candidate(CAND_B, "Never researched", true),
        candidate(CAND_C, "Researched, no stances", false),
      ],
      [tag(CAND_A, AREA_1, "for")],
      1
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.pickedCandidateIds).toEqual([CAND_A]);
    expect(decision.unresearched).toEqual([
      { candidate_id: CAND_B, display_name: "Never researched", never_researched: true },
      { candidate_id: CAND_C, display_name: "Researched, no stances", never_researched: false },
    ]);
  });

  it("picks the lone unknown by elimination when the only evidenced candidate scores negative", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Opposes my issue"), candidate(CAND_B, "Unknown")],
      [tag(CAND_A, AREA_1, "against")],
      1
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBe("by_elimination");
    expect(decision.pickedCandidateIds).toEqual([CAND_B]);
  });

  it("returns only_negative_evidence with the unknowns as shortlist when they outnumber the seats", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [
        candidate(CAND_A, "Opposes my issue"),
        candidate(CAND_B, "Unknown 1"),
        candidate(CAND_C, "Unknown 2"),
        candidate(CAND_D, "Unknown 3"),
      ],
      [tag(CAND_A, AREA_1, "against")],
      1
    );
    expect(decision.outcome).toBe("no_pick");
    expect(decision.reason).toBe("only_negative_evidence");
    expect(decision.pickedCandidateIds).toEqual([]);
    expect(new Set(decision.shortlistCandidateIds)).toEqual(new Set([CAND_B, CAND_C, CAND_D]));
  });

  it("shortlists the unknowns even when they under-fill the open seats", () => {
    // 2 seats, one negative candidate, one unknown: the unknown can't fill
    // both seats (no elimination), but the no-pick must still hand the user
    // the narrowed field instead of an empty shortlist.
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Opposes my issue"), candidate(CAND_B, "Unknown")],
      [tag(CAND_A, AREA_1, "against")],
      2
    );
    expect(decision.outcome).toBe("no_pick");
    expect(decision.reason).toBe("only_negative_evidence");
    expect(decision.shortlistCandidateIds).toEqual([CAND_B]);
  });

  it("keeps the shortlist empty when positives filled some seats and unknowns can't fill the rest", () => {
    // Outcome is "picked" (partial), so the elimination-stage shortlist must
    // not leak into a result the response contract documents as empty.
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Positive"), candidate(CAND_B, "Unknown 1"), candidate(CAND_C, "Unknown 2")],
      [tag(CAND_A, AREA_1, "for")],
      2
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBeNull();
    expect(decision.pickedCandidateIds).toEqual([CAND_A]);
    expect(decision.shortlistCandidateIds).toEqual([]);
  });

  it("excludes a vetoed candidate even as the highest scorer, reporting the offending record", () => {
    const issues = [issue(AREA_1, 1, { hardVeto: true }), issue(AREA_2, 2), issue(AREA_3, 3)];
    const offending = tag(CAND_A, AREA_1, "against", "voted to expand access");
    const decision = decideOfficeRace(
      issues,
      [candidate(CAND_A, "High scorer"), candidate(CAND_B, "Modest")],
      [
        tag(CAND_A, AREA_1, "for"),
        tag(CAND_A, AREA_1, "for"),
        tag(CAND_A, AREA_2, "for"),
        offending,
        tag(CAND_B, AREA_2, "for"),
      ],
      1
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.pickedCandidateIds).toEqual([CAND_B]);
    const vetoed = decision.candidates.find((report) => report.candidate_id === CAND_A);
    expect(vetoed?.vetoed_by).toEqual([
      { research_area_id: AREA_1, record_id: offending.recordId, description: "voted to expand access" },
    ]);
  });

  it("returns all_vetoed when every candidate crossed a line", () => {
    const issues = [issue(AREA_1, 1, { hardVeto: true }), issue(AREA_2, 2), issue(AREA_3, 3)];
    const decision = decideOfficeRace(
      issues,
      [candidate(CAND_A, "Alice")],
      [tag(CAND_A, AREA_1, "against")],
      1
    );
    expect(decision.outcome).toBe("no_pick");
    expect(decision.reason).toBe("all_vetoed");
    expect(decision.pickedCandidateIds).toEqual([]);
  });

  it("flips a 'for' record into a strike under an oppose direction", () => {
    const issues = [issue(AREA_1, 1, { direction: "oppose" }), issue(AREA_2, 2), issue(AREA_3, 3)];
    const decision = decideOfficeRace(
      issues,
      [candidate(CAND_A, "Supports the goal I oppose"), candidate(CAND_B, "Unknown")],
      [tag(CAND_A, AREA_1, "for")],
      1
    );
    // A scores negative and is removed; B wins by elimination.
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBe("by_elimination");
    expect(decision.pickedCandidateIds).toEqual([CAND_B]);
    const flipped = decision.candidates.find((report) => report.candidate_id === CAND_A);
    expect(flipped?.score).toBeLessThan(0);
    expect(flipped?.per_issue).toEqual([
      { research_area_id: AREA_1, net: -1 / 3, for_count: 0, against_count: 1 },
    ]);
  });

  it("returns insufficient_evidence when no candidate has any record on the user's issues", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice", true), candidate(CAND_B, "Bob")],
      [],
      1
    );
    expect(decision.outcome).toBe("no_pick");
    expect(decision.reason).toBe("insufficient_evidence");
    expect(decision.unresearched).toHaveLength(2);
  });

  it("fills every seat of a multi-seat race in score order", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice"), candidate(CAND_B, "Bob"), candidate(CAND_C, "Cara")],
      [tag(CAND_A, AREA_1, "for"), tag(CAND_B, AREA_2, "for"), tag(CAND_C, AREA_3, "for")],
      2
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBeNull();
    expect(decision.pickedCandidateIds).toEqual([CAND_A, CAND_B]);
  });

  it("allows a tie that fits within the open seats", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice"), candidate(CAND_B, "Bob"), candidate(CAND_C, "Cara")],
      [tag(CAND_A, AREA_1, "for"), tag(CAND_B, AREA_1, "for"), tag(CAND_C, AREA_3, "for")],
      2
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBeNull();
    expect(new Set(decision.pickedCandidateIds)).toEqual(new Set([CAND_A, CAND_B]));
  });

  it("refuses to split a tied group that outsizes the open seats", () => {
    // Three candidates tied on the same issue, two seats: seating any two of
    // them would be an arbitrary (alphabetical) choice, so nobody is seated
    // and the whole group is the shortlist.
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice"), candidate(CAND_B, "Bob"), candidate(CAND_C, "Cara")],
      [tag(CAND_A, AREA_1, "for"), tag(CAND_B, AREA_1, "for"), tag(CAND_C, AREA_1, "for")],
      2
    );
    expect(decision.outcome).toBe("no_pick");
    expect(decision.reason).toBe("tie");
    expect(decision.pickedCandidateIds).toEqual([]);
    expect(new Set(decision.shortlistCandidateIds)).toEqual(new Set([CAND_A, CAND_B, CAND_C]));
  });

  it("stops at a tie for the last open seat, keeping the seats it could fill", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice"), candidate(CAND_B, "Bob"), candidate(CAND_C, "Cara")],
      [tag(CAND_A, AREA_1, "for"), tag(CAND_B, AREA_2, "for"), tag(CAND_C, AREA_2, "for")],
      2
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBe("tie");
    expect(decision.pickedCandidateIds).toEqual([CAND_A]);
    expect(new Set(decision.shortlistCandidateIds)).toEqual(new Set([CAND_B, CAND_C]));
  });

  it("fills what it can when nothing remains for the other seats", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice"), candidate(CAND_B, "Bob")],
      [tag(CAND_A, AREA_1, "for"), tag(CAND_B, AREA_1, "against")],
      3
    );
    // B is negative (removed); no zeros exist, so only A's seat fills.
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBeNull();
    expect(decision.pickedCandidateIds).toEqual([CAND_A]);
  });

  it("counts an integrity_and_ethics record as a strike regardless of stance", () => {
    const issues = [
      issue(AREA_ETHICS, 1, { slug: "integrity_and_ethics" }),
      issue(AREA_2, 2),
      issue(AREA_3, 3),
    ];
    const decision = decideOfficeRace(
      issues,
      [candidate(CAND_A, "Has an ethics record"), candidate(CAND_B, "Unknown")],
      [tag(CAND_A, AREA_ETHICS, null)],
      1
    );
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBe("by_elimination");
    expect(decision.pickedCandidateIds).toEqual([CAND_B]);
  });

  it("treats the ethics veto as 'skip candidates with any ethics record'", () => {
    const issues = [
      issue(AREA_ETHICS, 1, { slug: "integrity_and_ethics", hardVeto: true }),
      issue(AREA_2, 2),
      issue(AREA_3, 3),
    ];
    const decision = decideOfficeRace(
      issues,
      [candidate(CAND_A, "Admonished"), candidate(CAND_B, "Clean")],
      [tag(CAND_A, AREA_ETHICS, null), tag(CAND_A, AREA_2, "for"), tag(CAND_B, AREA_3, "for")],
      1
    );
    expect(decision.pickedCandidateIds).toEqual([CAND_B]);
    const vetoed = decision.candidates.find((report) => report.candidate_id === CAND_A);
    expect(vetoed?.vetoed_by).toHaveLength(1);
  });

  it("ignores records tagged on areas the user did not rank", () => {
    const unrankedArea = "aaaaaaaa-0000-4000-8000-0000000000ff";
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice")],
      [tag(CAND_A, unrankedArea, "for")],
      1
    );
    expect(decision.reason).toBe("insufficient_evidence");
    expect(decision.candidates[0]?.has_evidence).toBe(false);
  });

  it("ignores a stance-less tag on a non-ethics area", () => {
    const decision = decideOfficeRace(THREE_ISSUES, [candidate(CAND_A, "Alice")], [tag(CAND_A, AREA_1, null)], 1);
    expect(decision.reason).toBe("insufficient_evidence");
  });

  it("treats null seats_to_fill as a single seat", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Alice"), candidate(CAND_B, "Bob")],
      [tag(CAND_A, AREA_1, "for"), tag(CAND_B, AREA_2, "for")],
      null
    );
    expect(decision.pickedCandidateIds).toEqual([CAND_A]);
  });

  it("weights rank 1 above rank 2: one top-issue record beats one second-issue record", () => {
    const decision = decideOfficeRace(
      THREE_ISSUES,
      [candidate(CAND_A, "Second issue"), candidate(CAND_B, "Top issue")],
      [tag(CAND_A, AREA_2, "for"), tag(CAND_B, AREA_1, "for")],
      1
    );
    expect(decision.pickedCandidateIds).toEqual([CAND_B]);
  });
});

describe("decideRetentionRace", () => {
  const judge = candidate(CAND_A, "Judge Pat Example");

  it("answers Yes on a positive score and No on a negative one", () => {
    expect(decideRetentionRace(THREE_ISSUES, judge, [tag(CAND_A, AREA_1, "for")])).toMatchObject({
      outcome: "picked",
      reason: null,
      measurePosition: "yes",
    });
    expect(decideRetentionRace(THREE_ISSUES, judge, [tag(CAND_A, AREA_1, "against")])).toMatchObject({
      outcome: "picked",
      reason: null,
      measurePosition: "no",
    });
  });

  it("answers No outright when a record crosses a line in the sand", () => {
    const issues = [issue(AREA_1, 1), issue(AREA_2, 2, { hardVeto: true }), issue(AREA_3, 3)];
    const decision = decideRetentionRace(issues, judge, [tag(CAND_A, AREA_1, "for"), tag(CAND_A, AREA_2, "against")]);
    expect(decision).toMatchObject({ outcome: "picked", reason: "veto", measurePosition: "no" });
    expect(decision.candidate.vetoed_by).toHaveLength(1);
  });

  it("gives no answer with no records on the user's issues, or when the sides cancel", () => {
    expect(decideRetentionRace(THREE_ISSUES, judge, [])).toMatchObject({
      outcome: "no_pick",
      reason: "insufficient_evidence",
      measurePosition: null,
    });
    // Equal weight on one issue: one for, one against → net 0.
    expect(
      decideRetentionRace(THREE_ISSUES, judge, [tag(CAND_A, AREA_1, "for"), tag(CAND_A, AREA_1, "against")])
    ).toMatchObject({ outcome: "no_pick", reason: "insufficient_evidence", measurePosition: null });
  });
});

describe("decideMeasure", () => {
  it("answers Yes when the weighted tags align with the user's directions", () => {
    const decision = decideMeasure(THREE_ISSUES, [measureTag(AREA_1, "for"), measureTag(AREA_2, "against")]);
    // +1·1.0 (rank 1) − 1·0.75 (rank 2) > 0.
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBeNull();
    expect(decision.measurePosition).toBe("yes");
    expect(decision.perIssue).toEqual([
      { research_area_id: AREA_1, net: 1 },
      { research_area_id: AREA_2, net: -1 },
    ]);
  });

  it("answers No when the score is negative", () => {
    const decision = decideMeasure(THREE_ISSUES, [measureTag(AREA_1, "against")]);
    expect(decision.measurePosition).toBe("no");
    expect(decision.reason).toBeNull();
  });

  it("answers No outright when the measure crosses a line in the sand, even if the score is positive", () => {
    const issues = [issue(AREA_1, 1), issue(AREA_2, 2, { hardVeto: true }), issue(AREA_3, 3)];
    const decision = decideMeasure(issues, [measureTag(AREA_1, "for"), measureTag(AREA_2, "against")]);
    expect(decision.outcome).toBe("picked");
    expect(decision.reason).toBe("veto");
    expect(decision.measurePosition).toBe("no");
  });

  it("gives no answer for a measure with no tags on the user's issues", () => {
    const decision = decideMeasure(THREE_ISSUES, []);
    expect(decision.outcome).toBe("no_pick");
    expect(decision.reason).toBe("insufficient_evidence");
    expect(decision.measurePosition).toBeNull();
  });

  it("gives no answer when the weighted stances balance to exactly zero", () => {
    // Two legacy unranked issues carry the same weight, one aligned and one
    // conflicting: a genuine 0.
    const issues = [issue(AREA_1, null), issue(AREA_2, null, { direction: "oppose" })];
    const decision = decideMeasure(issues, [measureTag(AREA_1, "for"), measureTag(AREA_2, "for")]);
    expect(decision.outcome).toBe("no_pick");
    expect(decision.reason).toBe("insufficient_evidence");
    expect(decision.measurePosition).toBeNull();
  });

  it("flips a 'for' tag under an oppose direction", () => {
    const issues = [issue(AREA_1, 1, { direction: "oppose" }), issue(AREA_2, 2), issue(AREA_3, 3)];
    const decision = decideMeasure(issues, [measureTag(AREA_1, "for")]);
    expect(decision.measurePosition).toBe("no");
  });
});

// ---------------------------------------------------------------------------
// applyAutoPicks orchestration (mocked db, mirroring userElectionChoices.test)
// ---------------------------------------------------------------------------

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

function createMockDb() {
  const client = { query: vi.fn(), release: vi.fn() };
  const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
  return { db, client };
}

const userRow = { rows: [{ id: USER_ID }] };
const threeIssueRows = {
  rows: [AREA_1, AREA_2, AREA_3].map((areaId, index) => ({
    research_area_id: areaId,
    slug: `area-${index + 1}`,
    rank: index + 1,
    direction: "support",
    hard_veto: false,
  })),
};

describe("applyAutoPicks", () => {
  it("rejects a bad mode", async () => {
    const { db } = createMockDb();
    await expect(
      applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "everything" as never })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an empty election list, oversize batches, duplicates, and bad ids", async () => {
    const { db } = createMockDb();
    await expect(applyAutoPicks(db, USER_ID, { electionIds: [], mode: "replace" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      applyAutoPicks(db, USER_ID, { electionIds: Array.from({ length: 201 }, () => ELECTION_ID), mode: "replace" })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID, ELECTION_ID], mode: "replace" })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      applyAutoPicks(db, USER_ID, { electionIds: ["not-a-uuid"], mode: "replace" })
    ).rejects.toBeInstanceOf(AutoPickError);
  });

  it("rejects the whole batch before any write when an election id does not exist", async () => {
    const { db, client } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow) // assertActiveUser
      .mockResolvedValueOnce({ rows: [] }); // prevalidate: nothing found
    await expect(
      applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace" })
    ).rejects.toMatchObject({ code: "election_not_found" });
    expect(db.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("reports too_few_issues per election instead of erroring", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow) // assertActiveUser
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }) // prevalidate election ids
      .mockResolvedValueOnce({ rows: threeIssueRows.rows.slice(0, 2) }) // loadIssues: only 2
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "office", seats_to_fill: 1, office_id: null, is_upcoming: true }],
      }) // loadElection
      .mockResolvedValueOnce({
        rows: [{ candidate_id: CAND_A, display_name: "Alice", never_researched: false }],
      }) // loadCandidates (for the suggestions)
      .mockResolvedValueOnce({
        rows: [
          {
            research_area_id: AREA_3,
            slug: "area-3",
            name: "Area 3",
            description: null,
            candidate_count: 1,
            record_count: 2,
          },
        ],
      }); // loadUncoveredRecordAreas
    const result = await applyAutoPicks(db, USER_ID, {
      electionIds: [ELECTION_ID],
      mode: "replace",
      dryRun: true,
    });
    expect(result.results).toEqual([
      expect.objectContaining({ election_id: ELECTION_ID, outcome: "no_pick", reason: "too_few_issues" }),
    ]);
    // Below the floor the prompt still gets the race's uncovered issues —
    // that is how a two-issue user reaches three. The two ranked areas are
    // excluded from the offer.
    expect(result.results[0]!.suggested_issues).toEqual([
      expect.objectContaining({ research_area_id: AREA_3, candidate_count: 1, record_count: 2 }),
    ]);
    expect(db.query.mock.calls[5]![1]).toEqual([[CAND_A], [AREA_1, AREA_2], null]);
  });

  it("answers Yes on a judicial retention race from the judge's records, as a measure position", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }) // prevalidate election ids
      .mockResolvedValueOnce(threeIssueRows)
      .mockResolvedValueOnce({
        rows: [
          {
            id: ELECTION_ID,
            race_type: "office",
            official_ballot_title: "Retention of District Court Judge Pat Example",
            seats_to_fill: 1,
            office_id: null,
            is_upcoming: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ candidate_id: CAND_A, display_name: "Pat Example", never_researched: false }],
      }) // loadCandidates
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: CAND_A,
            record_id: "cccccccc-0000-4000-8000-000000009999",
            research_area_id: AREA_1,
            stance: "for",
            description: "a record",
          },
        ],
      }); // loadRecordTags
    const result = await applyAutoPicks(db, USER_ID, {
      electionIds: [ELECTION_ID],
      mode: "replace",
      dryRun: true,
    });
    expect(result.results[0]).toMatchObject({
      race_type: "office",
      outcome: "picked",
      reason: null,
      picked_candidate_ids: [],
      measure_position: "yes",
      measure_per_issue: [{ research_area_id: AREA_1, net: 1 / 3 }],
    });
    expect(result.results[0]!.candidates[0]).toMatchObject({ candidate_id: CAND_A, display_name: "Pat Example" });
    expect(db.query).toHaveBeenCalledTimes(6);
  });

  it("gives a retention race no answer when the roster is not exactly one judge", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] })
      .mockResolvedValueOnce(threeIssueRows)
      .mockResolvedValueOnce({
        rows: [
          {
            id: ELECTION_ID,
            race_type: "office",
            official_ballot_title: "Retention of District Court Judge Pat Example",
            seats_to_fill: 1,
            office_id: null,
            is_upcoming: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { candidate_id: CAND_A, display_name: "Pat Example", never_researched: false },
          { candidate_id: CAND_B, display_name: "Stray Row", never_researched: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const result = await applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace", dryRun: true });
    expect(result.results[0]).toMatchObject({ outcome: "no_pick", reason: "insufficient_evidence", measure_position: null });
  });

  it("writes a retention No as an office-race measure position with origin auto", async () => {
    const { db, client } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow) // pool assertActiveUser
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }); // prevalidate election ids
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce(userRow) // assertActiveUser FOR UPDATE
      .mockResolvedValueOnce(threeIssueRows) // loadIssues
      .mockResolvedValueOnce({
        rows: [
          {
            id: ELECTION_ID,
            race_type: "office",
            official_ballot_title: "Shall Judge Pat Example be retained in office?",
            seats_to_fill: 1,
            office_id: null,
            is_upcoming: true,
          },
        ],
      }) // loadElection
      .mockResolvedValueOnce({
        rows: [{ candidate_id: CAND_A, display_name: "Pat Example", never_researched: false }],
      }) // loadCandidates
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: CAND_A,
            record_id: "cccccccc-0000-4000-8000-000000009998",
            research_area_id: AREA_1,
            stance: "against",
            description: "a record",
          },
        ],
      }) // loadRecordTags
      .mockResolvedValueOnce({ rows: [] }) // DELETE existing picks
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT measure position
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const result = await applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace" });
    expect(result.results[0]).toMatchObject({ outcome: "picked", measure_position: "no", picked_candidate_ids: [] });
    const insertCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.user_election_choices")
    );
    expect(String(insertCall![0])).toContain("measure_position");
    expect(insertCall![1]).toEqual([USER_ID, ELECTION_ID, "no", "office"]);
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql[sql.length - 1]).toBe("COMMIT");
  });

  it("reports an answered retention race as skipped_existing in fill_empty mode", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }) // prevalidate election ids
      .mockResolvedValueOnce(threeIssueRows)
      .mockResolvedValueOnce({
        rows: [
          {
            id: ELECTION_ID,
            race_type: "office",
            official_ballot_title: "Retention of District Court Judge Pat Example",
            seats_to_fill: 1,
            is_upcoming: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] }); // countExistingPicks: the Yes/No row
    const result = await applyAutoPicks(db, USER_ID, {
      electionIds: [ELECTION_ID],
      mode: "fill_empty",
      dryRun: true,
    });
    expect(result.results[0]).toMatchObject({ outcome: "skipped_existing", reason: null });
  });

  it("reports election_closed for a past election", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }) // prevalidate election ids
      .mockResolvedValueOnce(threeIssueRows)
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "office", seats_to_fill: 1, is_upcoming: false }],
      });
    const result = await applyAutoPicks(db, USER_ID, {
      electionIds: [ELECTION_ID],
      mode: "replace",
      dryRun: true,
    });
    expect(result.results[0]).toMatchObject({ outcome: "no_pick", reason: "election_closed" });
  });

  it("skips an election that already has a pick in fill_empty mode", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }) // prevalidate election ids
      .mockResolvedValueOnce(threeIssueRows)
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "office", seats_to_fill: 1, is_upcoming: true }],
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] }); // countExistingPicks
    const result = await applyAutoPicks(db, USER_ID, {
      electionIds: [ELECTION_ID],
      mode: "fill_empty",
      dryRun: true,
    });
    expect(result.results[0]).toMatchObject({ outcome: "skipped_existing", reason: null });
    // The count must use the choices reader's liveness rule: a row whose
    // candidate was deleted or merged renders nowhere, and treating it as
    // "already picked" would block filling a race the user sees as empty.
    const countSql = String(db.query.mock.calls[4]?.[0]);
    expect(countSql).toContain("merged_into_candidate_id IS NULL");
    expect(countSql).toContain("measure_position IS NOT NULL OR candidate.id IS NOT NULL");
  });

  it("never deletes existing picks when a replace run produced no pick", async () => {
    const { db, client } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow) // pool assertActiveUser
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }); // prevalidate election ids
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce(userRow) // assertActiveUser FOR UPDATE
      .mockResolvedValueOnce(threeIssueRows) // loadIssues (after the lock)
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "office", seats_to_fill: 1, is_upcoming: true }],
      }) // loadElection
      .mockResolvedValueOnce({ rows: [] }) // loadCandidates: none
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const result = await applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace" });
    expect(result.results[0]).toMatchObject({ outcome: "no_pick", reason: "insufficient_evidence" });
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("DELETE"))).toBe(false);
    expect(sql.some((statement) => statement.includes("INSERT"))).toBe(false);
    expect(sql[sql.length - 1]).toBe("COMMIT");
  });

  it("suggests the unranked issues the undecided field has records on after an evidence-gap no-pick", async () => {
    const { db } = createMockDb();
    const suggestionRows = [
      {
        research_area_id: AREA_ETHICS,
        slug: "public_safety",
        name: "Public safety",
        description: "Policing and crime.",
        candidate_count: "2",
        record_count: "5",
      },
    ];
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }) // prevalidate election ids
      .mockResolvedValueOnce(threeIssueRows)
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "office", seats_to_fill: 1, office_id: null, is_upcoming: true }],
      }) // loadElection
      .mockResolvedValueOnce({
        rows: [
          { candidate_id: CAND_A, display_name: "Alice", never_researched: false },
          { candidate_id: CAND_B, display_name: "Bob", never_researched: false },
        ],
      }) // loadCandidates
      .mockResolvedValueOnce({ rows: [] }) // loadRecordTags: nothing on the user's issues
      .mockResolvedValueOnce({ rows: suggestionRows }); // loadUncoveredRecordAreas
    const result = await applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace", dryRun: true });
    expect(result.results[0]).toMatchObject({ outcome: "no_pick", reason: "insufficient_evidence" });
    expect(result.results[0]!.suggested_issues).toEqual([
      {
        research_area_id: AREA_ETHICS,
        slug: "public_safety",
        name: "Public safety",
        description: "Policing and crime.",
        candidate_count: 2,
        record_count: 5,
      },
    ]);
    // The suggestion query runs over the whole roster (nobody had evidence,
    // so there is no shortlist), excludes the ranked areas, and only offers
    // what the user could actually rank and the engine could actually use.
    const [sql, params] = db.query.mock.calls[6]!;
    expect(String(sql)).toContain("is_user_selectable = true");
    expect(String(sql)).toContain("NOT (tag.research_area_id = ANY($2::uuid[]))");
    expect(String(sql)).toContain("tag.stance IS NOT NULL OR area.slug = 'integrity_and_ethics'");
    expect(params).toEqual([[CAND_A, CAND_B], [AREA_1, AREA_2, AREA_3], null]);
  });

  it("narrows the suggestion query to the shortlist on a tie", async () => {
    const { db } = createMockDb();
    const tiedTag = (candidateId: string, recordId: string) => ({
      candidate_id: candidateId,
      record_id: recordId,
      research_area_id: AREA_1,
      stance: "for",
      description: "a record",
    });
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] })
      .mockResolvedValueOnce(threeIssueRows)
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "office", seats_to_fill: 1, office_id: null, is_upcoming: true }],
      })
      .mockResolvedValueOnce({
        rows: [
          { candidate_id: CAND_A, display_name: "Alice", never_researched: false },
          { candidate_id: CAND_B, display_name: "Bob", never_researched: false },
          { candidate_id: CAND_C, display_name: "Cara", never_researched: true },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          tiedTag(CAND_A, "cccccccc-0000-4000-8000-000000000001"),
          tiedTag(CAND_B, "cccccccc-0000-4000-8000-000000000002"),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // loadUncoveredRecordAreas: nothing more known
    const result = await applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace", dryRun: true });
    expect(result.results[0]).toMatchObject({ outcome: "no_pick", reason: "tie", suggested_issues: [] });
    expect(db.query.mock.calls[6]![1]).toEqual([[CAND_A, CAND_B], [AREA_1, AREA_2, AREA_3], null]);
  });

  it("does not look for suggestions when every candidate crossed a line", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] })
      .mockResolvedValueOnce({
        rows: threeIssueRows.rows.map((row) => ({ ...row, hard_veto: true })),
      })
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "office", seats_to_fill: 1, office_id: null, is_upcoming: true }],
      })
      .mockResolvedValueOnce({
        rows: [{ candidate_id: CAND_A, display_name: "Alice", never_researched: false }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: CAND_A,
            record_id: "cccccccc-0000-4000-8000-000000000001",
            research_area_id: AREA_1,
            stance: "against",
            description: "a record",
          },
        ],
      });
    const result = await applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace", dryRun: true });
    expect(result.results[0]).toMatchObject({ outcome: "no_pick", reason: "all_vetoed", suggested_issues: [] });
    expect(db.query).toHaveBeenCalledTimes(6);
  });

  it("suggests a measure's tags on unranked issues when it shares none with the user's", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow)
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] })
      .mockResolvedValueOnce(threeIssueRows)
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "ballot_measure", seats_to_fill: null, office_id: null, is_upcoming: true }],
      })
      .mockResolvedValueOnce({ rows: [] }) // loadMeasureTags: no overlap
      .mockResolvedValueOnce({
        rows: [
          {
            research_area_id: AREA_ETHICS,
            slug: "housing",
            name: "Housing",
            description: null,
            candidate_count: 1,
            record_count: 1,
          },
        ],
      }); // loadUncoveredMeasureAreas
    const result = await applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace", dryRun: true });
    expect(result.results[0]).toMatchObject({
      race_type: "ballot_measure",
      outcome: "no_pick",
      reason: "insufficient_evidence",
      suggested_issues: [expect.objectContaining({ research_area_id: AREA_ETHICS, name: "Housing", candidate_count: 1 })],
    });
    expect(String(db.query.mock.calls[5]![0])).toContain("ballot_measure_research_area_tags");
  });

  it("replaces existing picks and writes the winner with origin auto", async () => {
    const { db, client } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow) // pool assertActiveUser
      .mockResolvedValueOnce({ rows: [{ id: ELECTION_ID }] }); // prevalidate election ids
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce(userRow) // assertActiveUser FOR UPDATE
      .mockResolvedValueOnce(threeIssueRows) // loadIssues (after the lock)
      .mockResolvedValueOnce({
        rows: [{ id: ELECTION_ID, race_type: "office", seats_to_fill: 1, is_upcoming: true }],
      }) // loadElection
      .mockResolvedValueOnce({
        rows: [
          { candidate_id: CAND_A, display_name: "Alice", never_researched: false },
          { candidate_id: CAND_B, display_name: "Bob", never_researched: true },
        ],
      }) // loadCandidates
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: CAND_A,
            record_id: "cccccccc-0000-4000-8000-000000009999",
            research_area_id: AREA_1,
            stance: "for",
            description: "a record",
          },
        ],
      }) // loadRecordTags
      .mockResolvedValueOnce({ rows: [] }) // DELETE existing picks
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT winner
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const result = await applyAutoPicks(db, USER_ID, { electionIds: [ELECTION_ID], mode: "replace" });
    expect(result.results[0]).toMatchObject({
      outcome: "picked",
      reason: null,
      picked_candidate_ids: [CAND_A],
    });
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("DELETE FROM public.user_election_choices"))).toBe(true);
    const insert = sql.find((statement) => statement.includes("INSERT INTO public.user_election_choices"));
    expect(insert).toContain("'auto'");
    expect(sql[sql.length - 1]).toBe("COMMIT");
  });
});

describe("clearAutoPicks", () => {
  it("deletes only origin='auto' rows on upcoming elections, in one statement", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow) // assertActiveUser
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }); // the DELETE
    await expect(clearAutoPicks(db, USER_ID)).resolves.toEqual({ cleared_count: 2 });

    // One SQL statement carries the whole contract: the origin check and
    // the delete are atomic (a row re-picked manually in another tab keeps
    // its 'manual' origin and survives), and past elections stay history.
    expect(db.query).toHaveBeenCalledTimes(2);
    const deleteSql = String(db.query.mock.calls[1]?.[0]);
    expect(deleteSql).toContain("DELETE FROM public.user_election_choices");
    expect(deleteSql).toContain("origin = 'auto'");
    expect(deleteSql).toContain("election.election_date >=");
  });

  it("scopes the delete to one election date when given", async () => {
    const { db } = createMockDb();
    db.query
      .mockResolvedValueOnce(userRow) // assertActiveUser
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // the DELETE
    await expect(clearAutoPicks(db, USER_ID, "2026-11-03")).resolves.toEqual({ cleared_count: 1 });
    const deleteCall = db.query.mock.calls[1];
    expect(String(deleteCall?.[0])).toContain("$2::date");
    expect(deleteCall?.[1]).toEqual([USER_ID, "2026-11-03"]);
  });

  it("rejects an unknown user before deleting anything", async () => {
    const { db } = createMockDb();
    db.query.mockResolvedValueOnce({ rows: [] }); // assertActiveUser: no user
    await expect(clearAutoPicks(db, USER_ID)).rejects.toMatchObject({ code: "user_not_found" });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

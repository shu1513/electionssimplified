import { describe, expect, it, vi } from "vitest";

import {
  electionStagesConflict,
  runMoveCandidateElectionLink,
} from "../../src/scripts/moveManualCandidateElectionLink.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const FROM_ELECTION = "22222222-2222-2222-2222-222222222222";
const TO_ELECTION = "33333333-3333-3333-3333-333333333333";
const LINK_ID = "44444444-4444-4444-4444-444444444444";
const MATE_ID = "55555555-5555-5555-5555-555555555555";

function linkRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LINK_ID,
    is_incumbent: false,
    status: "declared",
    running_mate_candidate_id: null,
    ...overrides,
  };
}

function linkFkRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    constraint_name: "fl_candidate_finance_outside_group_l_candidate_election_id_fkey",
    table_name: "public.fl_candidate_finance_outside_group_links",
    column_name: "candidate_election_id",
    referenced_column: "id",
    column_count: 1,
    ...overrides,
  };
}

function manualFinanceTargetFkRows() {
  return [
    linkFkRow({
      constraint_name: "manual_candidate_finance_filing_targets_candidate_election_fk",
      table_name: "manual_candidate_finance_filing_targets",
      column_name: "candidate_id",
      referenced_column: "candidate_id",
      column_count: 2,
    }),
    linkFkRow({
      constraint_name: "manual_candidate_finance_filing_targets_candidate_election_fk",
      table_name: "manual_candidate_finance_filing_targets",
      column_name: "election_id",
      referenced_column: "election_id",
      column_count: 2,
    }),
  ];
}

function electionRows(
  overrides: {
    fromDate?: string;
    toDate?: string;
    toDistrict?: string;
    toRaceType?: string;
    toStage?: string | null;
    toTitle?: string;
  } = {}
) {
  return [
    {
      id: FROM_ELECTION,
      district_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      election_date: overrides.fromDate ?? "2026-11-03",
      official_ballot_title: "Governing Board",
      race_type: "office",
      election_stage: "general",
    },
    {
      id: TO_ELECTION,
      district_id: overrides.toDistrict ?? "dddddddd-dddd-dddd-dddd-dddddddddddd",
      election_date: overrides.toDate ?? "2026-11-03",
      official_ballot_title: overrides.toTitle ?? "Governing Board Member, Seat 3",
      race_type: overrides.toRaceType ?? "office",
      election_stage: overrides.toStage === undefined ? "general" : overrides.toStage,
    },
  ];
}

// Query order: BEGIN, lock from-link, load elections, FK-table catalog scan,
// (per-table finance counts), target-link lock, then either
// [link-FK catalog scan, per-table link counts, DELETE] on the merge path or
// [mate collision, UPDATE] on the move path, COMMIT/ROLLBACK.
function buildClient(responses: Record<string, unknown[][]>) {
  const calls: { text: string; values: unknown[] }[] = [];
  const queue = { ...responses };
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values: values ?? [] });
    for (const key of Object.keys(queue)) {
      if (text.includes(key)) {
        const rows = queue[key]!.shift();
        if (rows !== undefined) return { rows };
      }
    }
    return { rows: [] };
  });
  return { query, calls };
}

function happyResponses(overrides: Partial<Record<string, unknown[][]>> = {}) {
  return {
    "FROM public.candidate_elections\n        WHERE candidate_id": [[linkRow()], []],
    "FROM public.elections": [electionRows()],
    "pg_constraint": [
      [{ table_name: "public.az_candidate_finance_links", election_column: "election_id" }],
    ],
    "count(*)::text AS n FROM public.az_candidate_finance_links": [[{ n: "0" }]],
    // Moving candidate's name for the target-roster identity guard; the
    // roster query itself defaults to an empty result (no name collisions).
    "FROM public.candidates WHERE id": [[{ display_name: "Alante’ J. Gaines" }]],
    ...overrides,
  };
}

describe("electionStagesConflict", () => {
  it("conflicts only when both stages are stated and differ", () => {
    expect(electionStagesConflict("general", "primary")).toBe(true);
    expect(electionStagesConflict("general", "general")).toBe(false);
    expect(electionStagesConflict(null, "general")).toBe(false);
    expect(electionStagesConflict("general", null)).toBe(false);
    expect(electionStagesConflict(null, null)).toBe(false);
  });
});

describe("runMoveCandidateElectionLink", () => {
  it("moves the link to the sibling shell and preserves the row id", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runMoveCandidateElectionLink(
      { query },
      { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
    );

    expect(result.action).toBe("moved");
    expect(result.toElectionTitle).toBe("Governing Board Member, Seat 3");
    // The sibling guard must validate against locked rows (deterministic
    // order so two concurrent movers cannot deadlock).
    const electionsLoad = calls.find((call) => call.text.includes("FROM public.elections"));
    expect(electionsLoad?.text).toContain("ORDER BY id");
    expect(electionsLoad?.text).toContain("FOR UPDATE");
    const update = calls.find((call) => call.text.includes("UPDATE public.candidate_elections"));
    expect(update?.text).toContain("SET election_id = $2::uuid");
    expect(update?.values).toEqual([LINK_ID, TO_ELECTION]);
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it("accepts uppercase UUID input by normalizing before row matching", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runMoveCandidateElectionLink(
      { query },
      {
        candidateId: CANDIDATE_ID.toUpperCase(),
        fromElectionId: FROM_ELECTION.toUpperCase(),
        toElectionId: TO_ELECTION.toUpperCase(),
        dryRun: false,
      }
    );

    expect(result.action).toBe("moved");
    const linkLock = calls.find((call) => call.text.includes("WHERE candidate_id"));
    expect(linkLock?.values).toEqual([CANDIDATE_ID, FROM_ELECTION]);
  });

  it("refuses when the from-election has persisted election results", async () => {
    const { query } = buildClient(happyResponses({
      "FROM public.election_results": [[{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }]],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/persisted election_results rows whose winners reference/);
  });

  it("dry-run rolls back and writes nothing", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runMoveCandidateElectionLink(
      { query },
      { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: true }
    );

    expect(result.dryRun).toBe(true);
    // Leading-whitespace-tolerant: the production UPDATE is a multiline
    // template literal starting with a newline.
    expect(calls.some((call) => /^\s*(UPDATE|DELETE)\b/i.test(call.text))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses when the link does not exist", async () => {
    const { query } = buildClient(happyResponses({
      "FROM public.candidate_elections\n        WHERE candidate_id": [[]],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/No candidate_elections link found/);
  });

  it("refuses cross-district and cross-date moves", async () => {
    const crossDistrict = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDistrict: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" })],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: crossDistrict.query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/different districts/);

    const crossDate = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDate: "2027-05-01" })],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: crossDate.query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/different dates/);
  });

  it("crosses districts only under the explicit flag, and only between verified siblings", async () => {
    const districtRows = [
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "Jefferson County School District in Anchorage ISD, Kentucky", state: "KY", district_type: "school_secondary" },
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "Jefferson County School District, Kentucky", state: "KY", district_type: "school_unified" },
    ];
    const allowed = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDistrict: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" })],
      "FROM public.districts": [districtRows],
    }));
    const result = await runMoveCandidateElectionLink(
      { query: allowed.query },
      {
        candidateId: CANDIDATE_ID,
        fromElectionId: FROM_ELECTION,
        toElectionId: TO_ELECTION,
        dryRun: false,
        allowCrossDistrict: true,
      }
    );
    expect(result.action).toBe("moved");
    expect(result.crossDistrict).toEqual({
      fromDistrict: "Jefferson County School District in Anchorage ISD, Kentucky",
      toDistrict: "Jefferson County School District, Kentucky",
    });

    // Same-district move under the flag reports no crossing.
    const sameDistrict = buildClient(happyResponses());
    const sameResult = await runMoveCandidateElectionLink(
      { query: sameDistrict.query },
      {
        candidateId: CANDIDATE_ID,
        fromElectionId: FROM_ELECTION,
        toElectionId: TO_ELECTION,
        dryRun: false,
        allowCrossDistrict: true,
      }
    );
    expect(sameResult.crossDistrict).toBeUndefined();

    // Different states are never siblings, flag or no flag.
    const crossState = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDistrict: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" })],
      "FROM public.districts": [[
        { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "Henry County School District, Tennessee", state: "TN", district_type: "school_unified" },
        { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "Henry County School District, Georgia", state: "GA", district_type: "school_unified" },
      ]],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: crossState.query },
        {
          candidateId: CANDIDATE_ID,
          fromElectionId: FROM_ELECTION,
          toElectionId: TO_ELECTION,
          dryRun: false,
          allowCrossDistrict: true,
        }
      )
    ).rejects.toThrow(/different states/);

    // The flag never relaxes the date guard.
    const crossDate = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDistrict: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", toDate: "2027-05-01" })],
      "FROM public.districts": [districtRows],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: crossDate.query },
        {
          candidateId: CANDIDATE_ID,
          fromElectionId: FROM_ELECTION,
          toElectionId: TO_ELECTION,
          dryRun: false,
          allowCrossDistrict: true,
        }
      )
    ).rejects.toThrow(/different dates/);
  });

  it("crosses from a whole-district row onto its local_special area row when the printed title matches", async () => {
    // Santa Clara County 2026: a trustee-area seat written on the whole
    // school row moves onto the reviewed area polygon that replaces it.
    const districtRows = [
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "Mountain View-Los Altos Union School District, California", state: "CA", district_type: "school_secondary" },
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "Mountain View-Los Altos Union High School District Trustee Area 3", state: "CA", district_type: "local_special" },
    ];
    const allowed = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDistrict: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", toTitle: "Governing Board" })],
      "FROM public.districts": [districtRows],
    }));
    const result = await runMoveCandidateElectionLink(
      { query: allowed.query },
      { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false, allowCrossDistrict: true }
    );
    expect(result.action).toBe("moved");
    expect(result.crossDistrict?.toDistrict).toBe("Mountain View-Los Altos Union High School District Trustee Area 3");

    // The other direction (area row -> whole row) and a different title stay refused.
    const reversed = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDistrict: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", toTitle: "Governing Board" })],
      "FROM public.districts": [[{ ...districtRows[0], district_type: "local_special" }, { ...districtRows[1], district_type: "school_secondary" }]],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: reversed.query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false, allowCrossDistrict: true }
      )
    ).rejects.toThrow(/not siblings|same body/);
  });

  it("refuses cross-district moves whose districts are not verifiable siblings", async () => {
    // Same state, unrelated bodies: the review case — on a general-election
    // date thousands of contests share state and date, so a mistyped UUID
    // must die here.
    const unrelated = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDistrict: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" })],
      "FROM public.districts": [[
        { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "Jefferson County School District, Kentucky", state: "KY", district_type: "school_unified" },
        { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "Fayette County School District, Kentucky", state: "KY", district_type: "school_unified" },
      ]],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: unrelated.query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false, allowCrossDistrict: true }
      )
    ).rejects.toThrow(/do not describe the same body/);

    // Related names but incompatible district kinds (school vs place).
    const wrongKind = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toDistrict: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" })],
      "FROM public.districts": [[
        { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "Anchorage in Jefferson County, Kentucky", state: "KY", district_type: "place" },
        { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "Anchorage, Kentucky", state: "KY", district_type: "school_unified" },
      ]],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: wrongKind.query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false, allowCrossDistrict: true }
      )
    ).rejects.toThrow(/incompatible district types/);
  });

  it("refuses moves between different contest kinds, cross-district or not", async () => {
    const wrongRaceType = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toRaceType: "ballot_measure" })],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: wrongRaceType.query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/different race types/);

    const wrongStage = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toStage: "primary" })],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: wrongStage.query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/different stages/);
  });

  it("treats a NULL election_stage as not stated, not as a different contest", async () => {
    // The writer stores NULL when a payload omits the stage; the live KY
    // school-board duplicates paired a NULL row with a 'general' row.
    const { query } = buildClient(happyResponses({
      "FROM public.elections": [electionRows({ toStage: null })],
    }));

    const result = await runMoveCandidateElectionLink(
      { query },
      { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
    );

    expect(result.action).toBe("moved");
  });

  it("refuses the move when the target roster lists the same person under another id", async () => {
    // The live shape: the duplicate shell also minted a duplicate CANDIDATE
    // row, names differing only by apostrophe character. Moving the un-merged
    // twin would show the person twice on the surviving election.
    const { query } = buildClient(happyResponses({
      "JOIN public.candidates c ON": [[
        { id: "66666666-6666-6666-6666-666666666666", display_name: "Alante' J. Gaines" },
      ]],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/merge the candidates first/);
  });

  it("fails closed on a first+last name match unless the operator overrides", async () => {
    // Review round 2: the live "Matthew McPeak" / "Matthew James McPeak"
    // pair IS one person — warn-and-proceed still committed the duplicate,
    // so the variant match now refuses like the exact match.
    const nearMiss = () => buildClient(happyResponses({
      "FROM public.candidates WHERE id": [[{ display_name: "Matthew McPeak" }]],
      "JOIN public.candidates c ON": [[
        { id: "66666666-6666-6666-6666-666666666666", display_name: "Matthew James McPeak" },
      ]],
    }));
    await expect(
      runMoveCandidateElectionLink(
        { query: nearMiss().query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/--allow-same-name-target/);

    // The override asserts the operator verified two distinct people; the
    // move proceeds and the overridden match is recorded.
    const overridden = await runMoveCandidateElectionLink(
      { query: nearMiss().query },
      {
        candidateId: CANDIDATE_ID,
        fromElectionId: FROM_ELECTION,
        toElectionId: TO_ELECTION,
        dryRun: false,
        allowSameNameTarget: true,
      }
    );
    expect(overridden.action).toBe("moved");
    expect(overridden.targetRosterNameWarnings).toHaveLength(1);
    expect(overridden.targetRosterNameWarnings![0]).toMatch(/OVERRIDDEN/);

    // The override also covers verified name-twins with the EXACT same name.
    const exact = await runMoveCandidateElectionLink(
      { query: buildClient(happyResponses({
        "JOIN public.candidates c ON": [[
          { id: "66666666-6666-6666-6666-666666666666", display_name: "Alante' J. Gaines" },
        ]],
      })).query },
      {
        candidateId: CANDIDATE_ID,
        fromElectionId: FROM_ELECTION,
        toElectionId: TO_ELECTION,
        dryRun: false,
        allowSameNameTarget: true,
      }
    );
    expect(exact.action).toBe("moved");
    expect(exact.targetRosterNameWarnings![0]).toMatch(/OVERRIDDEN/);
  });

  it("treats conflicting generational suffixes as two people and proceeds without the flag", async () => {
    const { query } = buildClient(happyResponses({
      "FROM public.candidates WHERE id": [[{ display_name: "Harold V. Kane, Jr." }]],
      "JOIN public.candidates c ON": [[
        { id: "66666666-6666-6666-6666-666666666666", display_name: "Harold V. Kane, Sr." },
      ]],
    }));
    const result = await runMoveCandidateElectionLink(
      { query },
      { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
    );
    expect(result.action).toBe("moved");
    expect(result.targetRosterNameWarnings).toHaveLength(1);
    expect(result.targetRosterNameWarnings![0]).toMatch(/conflicting generational suffix/);

    // A bare name next to a suffixed one stays presumed-same: a source
    // omitting "Jr." is far likelier than father and son in one contest.
    await expect(
      runMoveCandidateElectionLink(
        { query: buildClient(happyResponses({
          "FROM public.candidates WHERE id": [[{ display_name: "Harold V. Kane" }]],
          "JOIN public.candidates c ON": [[
            { id: "66666666-6666-6666-6666-666666666666", display_name: "Harold V. Kane, Jr." },
          ]],
        })).query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/merge the candidates first/);
  });

  it("refuses when finance rows on the from-election would be stranded", async () => {
    const { query } = buildClient(happyResponses({
      "count(*)::text AS n FROM public.az_candidate_finance_links": [[{ n: "2" }]],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/az_candidate_finance_links \(2\)/);
  });

  it("refuses only when immutable manual-finance targets reference the moved candidacy", async () => {
    const { query, calls } = buildClient(happyResponses({
      "FROM public.manual_candidate_finance_filing_targets": [[{ n: "2" }]],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/2 manual candidate-finance filing target row\(s\).*immutable payload identity/s);
    expect(calls.some((call) => call.text.includes("UPDATE public.candidate_elections"))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("converges an identical duplicate link by deleting the from-link", async () => {
    const { query, calls } = buildClient(happyResponses({
      "FROM public.candidate_elections\n        WHERE candidate_id": [[linkRow()], [linkRow({ id: "99999999-9999-9999-9999-999999999999" })]],
      "confrelid = 'public.candidate_elections'": [[]],
    }));

    const result = await runMoveCandidateElectionLink(
      { query },
      { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
    );

    expect(result.action).toBe("merged_duplicate");
    const del = calls.find((call) => call.text.includes("DELETE FROM public.candidate_elections"));
    expect(del?.values).toEqual([LINK_ID]);
  });

  it("refuses the duplicate merge when rows reference the from-link id", async () => {
    const { query, calls } = buildClient(happyResponses({
      "FROM public.candidate_elections\n        WHERE candidate_id": [[linkRow()], [linkRow({ id: "99999999-9999-9999-9999-999999999999" })]],
      "confrelid = 'public.candidate_elections'": [
        [linkFkRow()],
      ],
      "count(*)::text AS n FROM public.fl_candidate_finance_outside_group_links": [[{ n: "3" }]],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(
      /fl_candidate_finance_outside_group_links\.candidate_election_id \(3\)/
    );
    // The count must key on the from-link id, and the delete must not run.
    const count = calls.find((call) =>
      call.text.includes("FROM public.fl_candidate_finance_outside_group_links")
    );
    expect(count?.values).toEqual([LINK_ID]);
    expect(calls.some((call) => call.text.includes("DELETE FROM public.candidate_elections"))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses any move while user election choices name the from-candidacy", async () => {
    const { query, calls } = buildClient(happyResponses({
      "FROM public.user_election_choices": [[{ n: "2" }]],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/2 user_election_choices row\(s\).*planned votes/s);
    // Refused before any write on either path.
    expect(calls.some((call) => call.text.includes("UPDATE public.candidate_elections"))).toBe(false);
    expect(calls.some((call) => call.text.includes("DELETE FROM public.candidate_elections"))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("exempts known guarded composite FKs from the shape refusal once their counts are zero", async () => {
    // fk_user_election_choices_candidacy is composite, but its rows are
    // counted (and refused when present) by the dedicated choice guard —
    // with zero choices the duplicate merge must proceed, not refuse on
    // shape.
    const { query, calls } = buildClient(happyResponses({
      "FROM public.candidate_elections\n        WHERE candidate_id": [[linkRow()], [linkRow({ id: "99999999-9999-9999-9999-999999999999" })]],
      "confrelid = 'public.candidate_elections'": [
        [
          linkFkRow({
            constraint_name: "fk_user_election_choices_candidacy",
            table_name: "public.user_election_choices",
            column_name: "candidate_id",
            referenced_column: "candidate_id",
            column_count: 2,
          }),
          linkFkRow({
            constraint_name: "fk_user_election_choices_candidacy",
            table_name: "public.user_election_choices",
            column_name: "election_id",
            referenced_column: "election_id",
            column_count: 2,
          }),
          ...manualFinanceTargetFkRows(),
        ],
      ],
    }));

    const result = await runMoveCandidateElectionLink(
      { query },
      { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
    );

    expect(result.action).toBe("merged_duplicate");
    const del = calls.find((call) => call.text.includes("DELETE FROM public.candidate_elections"));
    expect(del?.values).toEqual([LINK_ID]);
  });

  it("refuses the duplicate merge under an FK shape the guard cannot count", async () => {
    // A composite FK (or one referencing a non-id unique column) cannot be
    // checked by comparing a single child column to the from-link id; the
    // guard must fail closed instead of counting zero and cascading.
    const { query, calls } = buildClient(happyResponses({
      "FROM public.candidate_elections\n        WHERE candidate_id": [[linkRow()], [linkRow({ id: "99999999-9999-9999-9999-999999999999" })]],
      "confrelid = 'public.candidate_elections'": [
        [
          linkFkRow({
            constraint_name: "future_composite_fkey",
            table_name: "public.future_link_scoped_table",
            column_name: "candidate_id",
            referenced_column: "candidate_id",
            column_count: 2,
          }),
          linkFkRow({
            constraint_name: "future_composite_fkey",
            table_name: "public.future_link_scoped_table",
            column_name: "election_id",
            referenced_column: "election_id",
            column_count: 2,
          }),
        ],
      ],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/cannot check.*future_link_scoped_table\.future_composite_fkey/s);
    expect(calls.some((call) => call.text.includes("FROM public.future_link_scoped_table"))).toBe(false);
    expect(calls.some((call) => call.text.includes("DELETE FROM public.candidate_elections"))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("runs the cascade guard on a dry-run duplicate merge without deleting", async () => {
    const { query, calls } = buildClient(happyResponses({
      "FROM public.candidate_elections\n        WHERE candidate_id": [[linkRow()], [linkRow({ id: "99999999-9999-9999-9999-999999999999" })]],
      "confrelid = 'public.candidate_elections'": [[linkFkRow()]],
      "count(*)::text AS n FROM public.fl_candidate_finance_outside_group_links": [[{ n: "0" }]],
    }));

    const result = await runMoveCandidateElectionLink(
      { query },
      { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: true }
    );

    expect(result.action).toBe("merged_duplicate");
    expect(result.dryRun).toBe(true);
    // The guard must not be gated behind !dryRun: a dry run has to report
    // the same refusal a live run would.
    expect(calls.some((call) => call.text.includes("confrelid = 'public.candidate_elections'"))).toBe(true);
    const count = calls.find((call) =>
      call.text.includes("FROM public.fl_candidate_finance_outside_group_links")
    );
    expect(count?.values).toEqual([LINK_ID]);
    expect(calls.some((call) => /^\s*(UPDATE|DELETE)\b/i.test(call.text))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses to merge disagreeing duplicate links", async () => {
    const { query } = buildClient(happyResponses({
      "FROM public.candidate_elections\n        WHERE candidate_id": [
        [linkRow()],
        [linkRow({ id: "99999999-9999-9999-9999-999999999999", status: "withdrawn" })],
      ],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/links disagree/);
  });

  it("refuses when the moved running mate collides on the target shell", async () => {
    const { query } = buildClient(happyResponses({
      "FROM public.candidate_elections\n        WHERE candidate_id": [
        [linkRow({ running_mate_candidate_id: MATE_ID })],
        [],
      ],
      "running_mate_candidate_id = $2::uuid": [[{ id: "88888888-8888-8888-8888-888888888888" }]],
    }));

    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: TO_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/already has a link carrying running mate/);
  });

  it("rejects identical from and to elections before touching the database", async () => {
    const { query } = buildClient({});
    await expect(
      runMoveCandidateElectionLink(
        { query },
        { candidateId: CANDIDATE_ID, fromElectionId: FROM_ELECTION, toElectionId: FROM_ELECTION, dryRun: false }
      )
    ).rejects.toThrow(/must differ/);
    expect(query).not.toHaveBeenCalled();
  });
});

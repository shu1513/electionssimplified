import { describe, expect, it, vi } from "vitest";

import {
  normalizeElectionSources,
  runSupersedeElection,
} from "../../src/scripts/supersedeManualElection.js";

const RETIRED = "22222222-2222-2222-2222-222222222222";
const SURVIVOR_A = "33333333-3333-3333-3333-333333333333";
const SURVIVOR_B = "44444444-4444-4444-4444-444444444444";
const DISTRICT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const REASON = "Generic board shell superseded by the per-district contests.";

function retiredRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RETIRED,
    district_id: DISTRICT,
    election_date: "2026-11-03",
    official_ballot_title: "Chicago Board of Education Member",
    official_ballot_title_key: "chicago board of education member",
    race_type: "office",
    election_stage: "general",
    sources: ["https://chicagoelections.gov/contests"],
    ...overrides,
  };
}

function survivorRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    district_id: DISTRICT,
    election_date: "2026-11-03",
    official_ballot_title: `Chicago Board of Education Member, District ${id.slice(0, 1)}A`,
    race_type: "office",
    election_stage: "general",
    sources: ["https://chicagoelections.gov/district"],
    ...overrides,
  };
}

// Query order: BEGIN, lock retired, lock survivors, FK catalog scan,
// (per-table zero-reference counts), (survivor source updates), DELETE, COMMIT/ROLLBACK.
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
    "WHERE id = $1::uuid\n        FOR UPDATE": [[retiredRow()]],
    "WHERE id = ANY($1::uuid[])": [[survivorRow(SURVIVOR_A), survivorRow(SURVIVOR_B)]],
    "pg_constraint": [
      [
        { table_name: "public.candidate_elections", column_name: "election_id" },
        { table_name: "public.user_election_follows", column_name: "election_id" },
      ],
    ],
    "count(*)::text AS n FROM public.candidate_elections": [[{ n: "0" }]],
    "count(*)::text AS n FROM public.user_election_follows": [[{ n: "0" }]],
    "INSERT INTO public.retired_election_identities": [[{ id: "ledger-1" }]],
    ...overrides,
  };
}

describe("runSupersedeElection", () => {
  it("deletes the retired shell and appends its sources to each survivor", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runSupersedeElection(
      { query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
    );

    expect(result.deletedElectionId).toBe(RETIRED);
    expect(result.referencingTablesChecked).toBe(2);
    expect(result.supersededBy).toHaveLength(2);
    expect(result.supersededBy[0]).toMatchObject({ electionId: SURVIVOR_A, sourcesAppended: 1 });

    const sourceUpdates = calls.filter((call) => call.text.includes("SET sources"));
    expect(sourceUpdates).toHaveLength(2);
    expect(JSON.parse(sourceUpdates[0]!.values[1] as string)).toEqual([
      "https://chicagoelections.gov/district",
      "https://chicagoelections.gov/contests",
    ]);
    const del = calls.find((call) => call.text.includes("DELETE FROM public.elections"));
    expect(del?.values).toEqual([RETIRED]);
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it("writes a superseded tombstone naming the survivors, before the delete", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runSupersedeElection(
      { query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
    );

    const ledgerIndex = calls.findIndex((call) => call.text.includes("INSERT INTO public.retired_election_identities"));
    const deleteIndex = calls.findIndex((call) => call.text.includes("DELETE FROM public.elections"));
    expect(ledgerIndex).toBeGreaterThan(0);
    expect(ledgerIndex).toBeLessThan(deleteIndex);
    expect(calls[ledgerIndex]?.values).toEqual([
      DISTRICT,
      "2026-11-03",
      "chicago board of education member",
      "Chicago Board of Education Member",
      "office",
      RETIRED,
      "superseded",
      REASON,
      "https://chicagoelections.gov/contests",
      [SURVIVOR_A, SURVIVOR_B],
      null,
      null,
    ]);
    expect(result.retiredIdentity.ledgerId).toBe("ledger-1");
    expect(result.retiredIdentity.officialBallotTitleKey).toBe("chicago board of education member");
  });

  it("dry-run reports the plan and rolls back without deleting", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runSupersedeElection(
      { query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: true }
    );

    expect(result.dryRun).toBe(true);
    expect(result.supersededBy[1]).toMatchObject({ electionId: SURVIVOR_B, sourcesAppended: 1 });
    expect(calls.some((call) => call.text.startsWith("DELETE") || call.text.includes("SET sources"))).toBe(false);
    expect(calls.some((call) => call.text.includes("INSERT INTO public.retired_election_identities"))).toBe(false);
    expect(result.retiredIdentity.ledgerId).toBeNull();
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses while any table still references the shell, naming the blockers", async () => {
    const { query } = buildClient(happyResponses({
      "count(*)::text AS n FROM public.candidate_elections": [[{ n: "5" }]],
    }));

    await expect(
      runSupersedeElection(
        { query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
      )
    ).rejects.toThrow(/candidate_elections\.election_id \(5\).*manual:candidate-elections:move/);
  });

  it("refuses a superseding election from another district or date", async () => {
    const wrongDistrict = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [survivorRow(SURVIVOR_A, { district_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" }), survivorRow(SURVIVOR_B)],
      ],
    }));
    await expect(
      runSupersedeElection(
        { query: wrongDistrict.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
      )
    ).rejects.toThrow(/different district/);

    const wrongDate = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [survivorRow(SURVIVOR_A, { election_date: "2027-02-24" }), survivorRow(SURVIVOR_B)],
      ],
    }));
    await expect(
      runSupersedeElection(
        { query: wrongDate.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
      )
    ).rejects.toThrow(/different date/);
  });

  it("crosses districts only under the explicit flag, and only between verified siblings", async () => {
    const OVERLAY_DISTRICT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const siblingDistricts = [
      { id: DISTRICT, name: "Jefferson County School District in Anchorage ISD, Kentucky", state: "KY", district_type: "school_secondary" },
      { id: OVERLAY_DISTRICT, name: "Jefferson County School District, Kentucky", state: "KY", district_type: "school_unified" },
    ];

    const allowed = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [survivorRow(SURVIVOR_A, { district_id: OVERLAY_DISTRICT }), survivorRow(SURVIVOR_B)],
      ],
      "FROM public.districts": [siblingDistricts],
    }));
    const result = await runSupersedeElection(
      { query: allowed.query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false, allowCrossDistrict: true }
    );
    expect(result.crossDistrict).toEqual([
      {
        electionId: SURVIVOR_A,
        fromDistrict: "Jefferson County School District in Anchorage ISD, Kentucky",
        toDistrict: "Jefferson County School District, Kentucky",
      },
    ]);
    expect(allowed.calls.at(-1)?.text).toBe("COMMIT");

    // Same-district supersession under the flag reports no crossing.
    const sameDistrict = buildClient(happyResponses());
    const sameResult = await runSupersedeElection(
      { query: sameDistrict.query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false, allowCrossDistrict: true }
    );
    expect(sameResult.crossDistrict).toBeUndefined();

    // Different states are never siblings, flag or no flag.
    const crossState = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [survivorRow(SURVIVOR_A, { district_id: OVERLAY_DISTRICT }), survivorRow(SURVIVOR_B)],
      ],
      "FROM public.districts": [[
        { id: DISTRICT, name: "Henry County School District, Tennessee", state: "TN", district_type: "school_unified" },
        { id: OVERLAY_DISTRICT, name: "Henry County School District, Georgia", state: "GA", district_type: "school_unified" },
      ]],
    }));
    await expect(
      runSupersedeElection(
        { query: crossState.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false, allowCrossDistrict: true }
      )
    ).rejects.toThrow(/different states/);

    // The flag never relaxes the date guard.
    const crossDate = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [survivorRow(SURVIVOR_A, { district_id: OVERLAY_DISTRICT, election_date: "2027-02-24" }), survivorRow(SURVIVOR_B)],
      ],
      "FROM public.districts": [siblingDistricts],
    }));
    await expect(
      runSupersedeElection(
        { query: crossDate.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false, allowCrossDistrict: true }
      )
    ).rejects.toThrow(/different date/);
  });

  it("refuses cross-district supersession without sibling evidence, and contest-kind mismatches always", async () => {
    const OVERLAY_DISTRICT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

    // Same state, unrelated bodies — a supersede DELETE has no undo, so a
    // mistyped UUID must die on the body-name evidence.
    const unrelated = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [survivorRow(SURVIVOR_A, { district_id: OVERLAY_DISTRICT }), survivorRow(SURVIVOR_B)],
      ],
      "FROM public.districts": [[
        { id: DISTRICT, name: "Jefferson County School District, Kentucky", state: "KY", district_type: "school_unified" },
        { id: OVERLAY_DISTRICT, name: "Fayette County School District, Kentucky", state: "KY", district_type: "school_unified" },
      ]],
    }));
    await expect(
      runSupersedeElection(
        { query: unrelated.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false, allowCrossDistrict: true }
      )
    ).rejects.toThrow(/do not describe the same body/);

    // race_type and stage must match with or without the flag.
    const wrongRaceType = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [survivorRow(SURVIVOR_A, { race_type: "ballot_measure" }), survivorRow(SURVIVOR_B)],
      ],
    }));
    await expect(
      runSupersedeElection(
        { query: wrongRaceType.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
      )
    ).rejects.toThrow(/different race type/);

    const wrongStage = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [survivorRow(SURVIVOR_A, { election_stage: "primary" }), survivorRow(SURVIVOR_B)],
      ],
    }));
    await expect(
      runSupersedeElection(
        { query: wrongStage.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
      )
    ).rejects.toThrow(/different stage/);
  });

  it("treats a NULL election_stage on the retired shell as not stated", async () => {
    const { query, calls } = buildClient(happyResponses({
      "WHERE id = $1::uuid\n        FOR UPDATE": [[retiredRow({ election_stage: null })]],
    }));

    const result = await runSupersedeElection(
      { query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
    );

    expect(result.deletedElectionId).toBe(RETIRED);
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it("lets the shell's own research deferrals cascade, reported, while everything else still blocks", async () => {
    const references = [
      { table_name: "public.candidate_elections", column_name: "election_id" },
      { table_name: "public.manual_research_deferrals", column_name: "election_id" },
    ];
    const { query, calls } = buildClient(happyResponses({
      pg_constraint: [references],
      "count(*)::text AS n FROM public.manual_research_deferrals": [[{ n: "2" }]],
    }));

    const result = await runSupersedeElection(
      { query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
    );

    expect(result.cascadeDeletes).toEqual([{ table: "manual_research_deferrals", rows: 2 }]);
    expect(calls.find((call) => call.text.includes("DELETE FROM public.elections"))?.values).toEqual([RETIRED]);

    const stillBlocked = buildClient(happyResponses({
      pg_constraint: [references],
      "count(*)::text AS n FROM public.manual_research_deferrals": [[{ n: "2" }]],
      "count(*)::text AS n FROM public.candidate_elections": [[{ n: "1" }]],
    }));
    await expect(
      runSupersedeElection(
        { query: stillBlocked.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
      )
    ).rejects.toThrow(/candidate_elections\.election_id \(1\)/);
  });

  it("refuses missing retired or superseding elections", async () => {
    const missingRetired = buildClient(happyResponses({
      "WHERE id = $1::uuid\n        FOR UPDATE": [[]],
    }));
    await expect(
      runSupersedeElection(
        { query: missingRetired.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A], dryRun: false }
      )
    ).rejects.toThrow(/Election not found/);

    const missingSurvivor = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [[survivorRow(SURVIVOR_A)]],
    }));
    await expect(
      runSupersedeElection(
        { query: missingSurvivor.query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
      )
    ).rejects.toThrow(/Superseding election not found: 44444444/);
  });

  it("rejects empty, duplicate, and self-referencing superseded-by lists before touching the database", async () => {
    const { query } = buildClient({});
    await expect(
      runSupersedeElection({ query }, { electionId: RETIRED, reason: REASON, supersededByIds: [], dryRun: false })
    ).rejects.toThrow(/at least one replacement/);
    await expect(
      runSupersedeElection(
        { query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_A], dryRun: false }
      )
    ).rejects.toThrow(/duplicate election ids/);
    await expect(
      runSupersedeElection(
        { query },
        { electionId: RETIRED, reason: REASON, supersededByIds: [RETIRED], dryRun: false }
      )
    ).rejects.toThrow(/must not include the election being retired/);
    expect(query).not.toHaveBeenCalled();
  });

  it("still appends a new retired source when the survivor carries duplicate existing sources", async () => {
    // Regression: [a, a] existing + [b] retired must count b as appended —
    // an un-deduped existing length made the diff zero and dropped b.
    const { query, calls } = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [
          survivorRow(SURVIVOR_A, {
            sources: ["https://chicagoelections.gov/district", "https://chicagoelections.gov/district"],
          }),
          survivorRow(SURVIVOR_B),
        ],
      ],
    }));

    const result = await runSupersedeElection(
      { query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
    );

    expect(result.supersededBy[0]).toMatchObject({ electionId: SURVIVOR_A, sourcesAppended: 1 });
    const update = calls.find(
      (call) => call.text.includes("SET sources") && call.values[0] === SURVIVOR_A
    );
    expect(JSON.parse(update?.values[1] as string)).toEqual([
      "https://chicagoelections.gov/district",
      "https://chicagoelections.gov/contests",
    ]);
  });

  it("accepts uppercase UUID input by normalizing before survivor matching", async () => {
    const { query } = buildClient(happyResponses());

    const result = await runSupersedeElection(
      { query },
      {
        electionId: RETIRED.toUpperCase(),
        supersededByIds: [SURVIVOR_A.toUpperCase(), SURVIVOR_B.toUpperCase()],
        dryRun: true,
      }
    );

    expect(result.deletedElectionId).toBe(RETIRED);
    expect(result.supersededBy.map((entry) => entry.electionId)).toEqual([SURVIVOR_A, SURVIVOR_B]);
  });

  it("skips the source update when the survivor already carries every retired source", async () => {
    const { query, calls } = buildClient(happyResponses({
      "WHERE id = ANY($1::uuid[])": [
        [
          survivorRow(SURVIVOR_A, {
            sources: ["https://chicagoelections.gov/district", "https://chicagoelections.gov/contests"],
          }),
          survivorRow(SURVIVOR_B),
        ],
      ],
    }));

    const result = await runSupersedeElection(
      { query },
      { electionId: RETIRED, reason: REASON, supersededByIds: [SURVIVOR_A, SURVIVOR_B], dryRun: false }
    );

    expect(result.supersededBy[0]).toMatchObject({ electionId: SURVIVOR_A, sourcesAppended: 0 });
    expect(result.supersededBy[1]).toMatchObject({ electionId: SURVIVOR_B, sourcesAppended: 1 });
    expect(calls.filter((call) => call.text.includes("SET sources"))).toHaveLength(1);
  });
});

describe("normalizeElectionSources", () => {
  it("keeps trimmed string entries and drops everything else", () => {
    expect(normalizeElectionSources([" https://a.gov ", "", 42, null, "https://b.gov"])).toEqual([
      "https://a.gov",
      "https://b.gov",
    ]);
    expect(normalizeElectionSources("not-an-array")).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { runRetireSpuriousElection } from "../../src/scripts/retireSpuriousManualElection.js";

const SPURIOUS = "d556e3cb-0b17-4ecf-9d97-f03257f9ae1f";

const BASE_OPTIONS = {
  electionId: SPURIOUS,
  reason: "California has no 2026 US Senate contest; both classes next up 2028/2030.",
  noContestSource: "https://en.wikipedia.org/wiki/2026_United_States_Senate_elections",
};

const DISTRICT = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function electionRow() {
  return {
    id: SPURIOUS,
    district_id: DISTRICT,
    election_date: "2026-11-03",
    official_ballot_title: "United States Senator",
    official_ballot_title_key: "united states senator",
    race_type: "office",
    district_name: "California",
    district_state: "CA",
  };
}

// Query order: BEGIN, lock election, FK catalog scan, per-table counts (a
// generic count per referencing table, plus one conditional follow-up each
// for current_race_ratings and user_district_notification_events), DELETE,
// COMMIT/ROLLBACK. Each key's queue holds responses in that call order; a
// text matching several keys consumes the first key with a response left.
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
    "FOR UPDATE OF e": [[electionRow()]],
    pg_constraint: [
      [
        { table_name: "public.candidate_elections", column_name: "election_id" },
        { table_name: "public.current_race_ratings", column_name: "election_id" },
        { table_name: "public.election_senate_metadata", column_name: "election_id" },
        { table_name: "public.manual_research_deferrals", column_name: "election_id" },
        { table_name: "public.user_district_notification_events", column_name: "election_id" },
        { table_name: "public.user_election_follows", column_name: "election_id" },
      ],
    ],
    "count(*)::text AS n FROM public.candidate_elections": [[{ n: "0" }]],
    // generic count, then the evidence_status <> 'none_found' follow-up
    "count(*)::text AS n FROM public.current_race_ratings": [[{ n: "1" }], [{ n: "0" }]],
    "count(*)::text AS n FROM public.election_senate_metadata": [[{ n: "1" }]],
    "count(*)::text AS n FROM public.manual_research_deferrals": [[{ n: "1" }]],
    // generic count, then the notified_at IS NOT NULL follow-up
    "count(*)::text AS n FROM public.user_district_notification_events": [[{ n: "1" }], [{ n: "0" }]],
    "count(*)::text AS n FROM public.user_election_follows": [[{ n: "0" }]],
    "FROM public.staging_items": [
      [
        {
          ingest_key: "manual:elections:ca:2026",
          entries: [{ official_ballot_title: "United States Senator", election_date: "2026-11-03" }],
        },
      ],
    ],
    "INSERT INTO public.retired_election_identities": [[{ id: "ledger-1" }]],
    ...overrides,
  };
}

describe("runRetireSpuriousElection", () => {
  it("deletes the spurious row and reports the allowlisted cascades", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runRetireSpuriousElection({ query }, { ...BASE_OPTIONS, dryRun: false });

    expect(result.deletedElectionId).toBe(SPURIOUS);
    expect(result.deletedElectionTitle).toBe("United States Senator");
    expect(result.districtState).toBe("CA");
    expect(result.referencingTablesChecked).toBe(6);
    expect(result.cascadeDeletes).toEqual([
      { table: "current_race_ratings", rows: 1, note: "evidence_status = 'none_found'" },
      { table: "election_senate_metadata", rows: 1 },
      { table: "manual_research_deferrals", rows: 1 },
      { table: "user_district_notification_events", rows: 1, note: "1 unsent" },
    ]);

    const del = calls.find((call) => call.text.includes("DELETE FROM public.elections"));
    expect(del?.values).toEqual([SPURIOUS]);
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it("writes the tombstone in the same transaction, before the delete", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runRetireSpuriousElection({ query }, { ...BASE_OPTIONS, dryRun: false });

    const ledgerIndex = calls.findIndex((call) => call.text.includes("INSERT INTO public.retired_election_identities"));
    const deleteIndex = calls.findIndex((call) => call.text.includes("DELETE FROM public.elections"));
    const beginIndex = calls.findIndex((call) => call.text === "BEGIN");
    expect(ledgerIndex).toBeGreaterThan(beginIndex);
    expect(ledgerIndex).toBeLessThan(deleteIndex);
    expect(calls[ledgerIndex]?.values).toEqual([
      DISTRICT,
      "2026-11-03",
      "united states senator",
      "United States Senator",
      "office",
      SPURIOUS,
      "retired_spurious",
      BASE_OPTIONS.reason,
      BASE_OPTIONS.noContestSource,
      [],
      "manual:elections:ca:2026",
      null,
    ]);
    expect(result.retiredIdentity).toEqual({
      ledgerId: "ledger-1",
      officialBallotTitleKey: "united states senator",
      stagingIngestKeys: ["manual:elections:ca:2026"],
    });
  });

  it("dry-run reports the plan and rolls back without deleting", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runRetireSpuriousElection({ query }, { ...BASE_OPTIONS, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.cascadeDeletes).toHaveLength(4);
    expect(calls.some((call) => call.text.startsWith("DELETE"))).toBe(false);
    expect(calls.some((call) => call.text.includes("INSERT INTO public.retired_election_identities"))).toBe(false);
    expect(result.retiredIdentity.ledgerId).toBeNull();
    expect(result.retiredIdentity.stagingIngestKeys).toEqual(["manual:elections:ca:2026"]);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("blocks while a non-allowlisted table still references the row", async () => {
    const { query, calls } = buildClient(
      happyResponses({
        "count(*)::text AS n FROM public.candidate_elections": [[{ n: "2" }]],
      })
    );

    await expect(
      runRetireSpuriousElection({ query }, { ...BASE_OPTIONS, dryRun: false })
    ).rejects.toThrow(/public\.candidate_elections\.election_id \(2\)/);
    expect(calls.some((call) => call.text.startsWith("DELETE"))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("blocks when a real rating exists — evidence the race is not spurious", async () => {
    const { query, calls } = buildClient(
      happyResponses({
        "count(*)::text AS n FROM public.current_race_ratings": [[{ n: "1" }], [{ n: "1" }]],
      })
    );

    await expect(
      runRetireSpuriousElection({ query }, { ...BASE_OPTIONS, dryRun: false })
    ).rejects.toThrow(/evidence_status = 'rated'/);
    expect(calls.some((call) => call.text.startsWith("DELETE"))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("blocks when users were already notified about the race", async () => {
    const { query, calls } = buildClient(
      happyResponses({
        // generic count 2, then the notified_at IS NOT NULL follow-up finds 1 sent
        "count(*)::text AS n FROM public.user_district_notification_events": [[{ n: "2" }], [{ n: "1" }]],
      })
    );

    await expect(
      runRetireSpuriousElection({ query }, { ...BASE_OPTIONS, dryRun: false })
    ).rejects.toThrow(/1 already notified/);
    expect(calls.some((call) => call.text.startsWith("DELETE"))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("fails when the election does not exist", async () => {
    const { query } = buildClient({ "FOR UPDATE OF e": [[]] });

    await expect(
      runRetireSpuriousElection({ query }, { ...BASE_OPTIONS, dryRun: true })
    ).rejects.toThrow(`Election not found: ${SPURIOUS}`);
  });
});

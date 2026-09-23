import { describe, expect, it, vi } from "vitest";

import {
  readElectionIds,
  runElectionOfficeIdRepair,
  type OfficeRepairClient,
} from "../../src/scripts/repairElectionOfficeIds.js";

const COMMISSIONER_OFFICE_ID = "00000000-0000-4000-8000-00000000000a";
const SUPERVISOR_OFFICE_ID = "00000000-0000-4000-8000-00000000000b";

type StrandedRow = {
  id: string;
  official_ballot_title: string;
  discovery_contest_family: string | null;
  district_name: string;
  state: string;
  district_type: string;
};

function strandedRow(overrides: Partial<StrandedRow> = {}): StrandedRow {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    official_ballot_title: "ANSON COUNTY BOARD OF COMMISSIONERS DISTRICT 02",
    discovery_contest_family: "non_judicial_office",
    district_name: "Anson County, North Carolina",
    state: "NC",
    district_type: "county",
    ...overrides,
  };
}

// Answers the stranded-shell SELECT, the office-name SELECT, and the
// OfficeMatcher's own alias/office loads; records every statement so the
// transaction shape and writes can be pinned.
function fakeClient(input: {
  stranded: StrandedRow[];
  aliases?: Array<{ office_id: string; normalized_alias: string }>;
  // Rows the alias INSERT reports as written; defaults to every queued row
  // (no ON CONFLICT skips).
  aliasInsertRowCount?: number;
}) {
  const statements: { text: string; values?: unknown[] }[] = [];
  const offices = [
    { id: COMMISSIONER_OFFICE_ID, canonical_name: "County Commissioner" },
    { id: SUPERVISOR_OFFICE_ID, canonical_name: "County Supervisor" },
  ];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    statements.push({ text, values });
    if (text.includes("FOR UPDATE OF e")) {
      return { rows: input.stranded };
    }
    if (text.includes("INSERT INTO public.office_title_aliases")) {
      const queued = Array.isArray(values?.[0]) ? (values[0] as unknown[]).length : 0;
      return { rows: [], rowCount: input.aliasInsertRowCount ?? queued };
    }
    if (text.includes("FROM public.office_title_aliases")) {
      return { rows: input.aliases ?? [] };
    }
    if (text.includes("FROM public.offices")) {
      return { rows: offices };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as OfficeRepairClient, statements };
}

function updates(statements: { text: string; values?: unknown[] }[]) {
  return statements.filter((statement) => statement.text.includes("SET office_id"));
}

function aliasInserts(statements: { text: string; values?: unknown[] }[]) {
  return statements.filter((statement) =>
    statement.text.includes("INSERT INTO public.office_title_aliases")
  );
}

function lastTransactionStatement(statements: { text: string }[]) {
  const transactionStatements = statements.filter(
    (statement) => statement.text === "COMMIT" || statement.text === "ROLLBACK"
  );
  return transactionStatements[transactionStatements.length - 1]?.text;
}

describe("runElectionOfficeIdRepair", () => {
  it("backfills a resolvable shell, persists the learned alias, and commits", async () => {
    const { client, statements } = fakeClient({ stranded: [strandedRow()] });

    const summary = await runElectionOfficeIdRepair(client, { dryRun: false });

    expect(summary.examined).toBe(1);
    expect(summary.unmatched).toEqual([]);
    expect(summary.repaired).toEqual([
      expect.objectContaining({
        officeId: COMMISSIONER_OFFICE_ID,
        officeCanonicalName: "County Commissioner",
        method: "deterministic_fallback",
      }),
    ]);

    const update = updates(statements)[0];
    expect(update?.values).toEqual([strandedRow().id, COMMISSIONER_OFFICE_ID]);
    // The guard keeps a concurrently-repaired row untouched.
    expect(update?.text).toContain("office_id IS NULL");

    expect(summary.aliasRowsInserted).toBe(1);
    // The learned alias is the fully reduced matcher key (body rewrite +
    // seat strip), not the raw title.
    const aliasInsert = aliasInserts(statements)[0];
    expect(aliasInsert?.values?.[3]).toEqual(["county commissioner"]);

    expect(lastTransactionStatement(statements)).toBe("COMMIT");
  });

  it("rolls back everything on --dry-run while still reporting the repairs", async () => {
    const { client, statements } = fakeClient({ stranded: [strandedRow()] });

    const summary = await runElectionOfficeIdRepair(client, { dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.repaired).toHaveLength(1);
    expect(updates(statements)).toHaveLength(1);
    expect(lastTransactionStatement(statements)).toBe("ROLLBACK");
  });

  it("reports unresolvable shells without writing and dedupes learned aliases per key", async () => {
    const { client, statements } = fakeClient({
      stranded: [
        strandedRow({ id: "10000000-0000-4000-8000-000000000001" }),
        // Same matcher key as the first row (different county) — the learned
        // alias is persisted once.
        strandedRow({
          id: "10000000-0000-4000-8000-000000000002",
          district_name: "Bladen County, North Carolina",
          official_ballot_title: "BLADEN COUNTY BOARD OF COMMISSIONERS DISTRICT 02",
        }),
        strandedRow({
          id: "10000000-0000-4000-8000-000000000003",
          official_ballot_title: "Some Unknown Office Title",
        }),
      ],
    });

    const summary = await runElectionOfficeIdRepair(client, { dryRun: false });

    expect(summary.examined).toBe(3);
    expect(summary.repaired).toHaveLength(2);
    expect(summary.unmatched).toEqual([
      expect.objectContaining({
        electionId: "10000000-0000-4000-8000-000000000003",
        method: "none",
      }),
    ]);
    expect(updates(statements)).toHaveLength(2);
    expect(summary.aliasRowsInserted).toBe(1);
  });

  it("resolves via a seeded alias without re-learning it", async () => {
    const { client, statements } = fakeClient({
      stranded: [
        strandedRow({
          official_ballot_title: "County Council At Large",
          district_name: "Anne Arundel County, Maryland",
          state: "MD",
        }),
      ],
      aliases: [{ office_id: SUPERVISOR_OFFICE_ID, normalized_alias: "county council" }],
    });

    const summary = await runElectionOfficeIdRepair(client, { dryRun: false });

    expect(summary.repaired).toEqual([
      expect.objectContaining({
        officeId: SUPERVISOR_OFFICE_ID,
        method: "alias_exact",
      }),
    ]);
    expect(summary.aliasRowsInserted).toBe(0);
    expect(aliasInserts(statements)).toHaveLength(0);
  });

  it("reports the alias rows the INSERT wrote, not the rows it queued", async () => {
    // A concurrent writer (or an earlier partial run) may already hold the
    // (scope, normalized_alias) key; ON CONFLICT DO NOTHING skips it and the
    // summary must reflect the real insert count.
    const { client } = fakeClient({
      stranded: [strandedRow()],
      aliasInsertRowCount: 0,
    });

    const summary = await runElectionOfficeIdRepair(client, { dryRun: false });

    expect(summary.repaired).toHaveLength(1);
    expect(summary.aliasRowsInserted).toBe(0);
  });
});

describe("repair-office-ids --election-id filter", () => {
  it("passes the named ids to the stranded-shell SELECT, and an empty list when none are named", async () => {
    const targeted = fakeClient({ stranded: [] });
    await runElectionOfficeIdRepair(targeted.client, {
      dryRun: true,
      electionIds: ["10000000-0000-4000-8000-000000000001"],
    });
    const targetedSelect = targeted.statements.find((statement) => statement.text.includes("FOR UPDATE OF e"));
    expect(targetedSelect?.text).toContain("e.id = ANY ($1::uuid[])");
    expect(targetedSelect?.values).toEqual([["10000000-0000-4000-8000-000000000001"]]);

    const all = fakeClient({ stranded: [] });
    await runElectionOfficeIdRepair(all.client, { dryRun: true });
    const allSelect = all.statements.find((statement) => statement.text.includes("FOR UPDATE OF e"));
    expect(allSelect?.values).toEqual([[]]);
  });

  it("reads repeated --election-id values, dedupes them, and rejects a non-UUID", () => {
    expect(
      readElectionIds([
        "--dry-run",
        "--election-id",
        "10000000-0000-4000-8000-00000000000A",
        "--election-id",
        "10000000-0000-4000-8000-00000000000a",
      ])
    ).toEqual(["10000000-0000-4000-8000-00000000000a"]);
    expect(readElectionIds(["--dry-run"])).toEqual([]);
    expect(() => readElectionIds(["--election-id", "not-a-uuid"])).toThrow(/needs an election UUID/);
    expect(() => readElectionIds(["--election-id"])).toThrow(/needs an election UUID/);
  });
});

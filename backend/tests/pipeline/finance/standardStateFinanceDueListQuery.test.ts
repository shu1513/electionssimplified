import { describe, expect, it, vi } from "vitest";

import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueQueryRow,
} from "../../../src/pipeline/finance/standardStateFinanceDueListQuery.js";
import { listDueTexasCandidateFinanceSyncRows } from "../../../src/pipeline/texasFinance/texasCandidateFinanceBatchSync.js";
import { TEXAS_FINANCE_ELIGIBLE_OFFICE_KEYS } from "../../../src/pipeline/texasFinance/texasFinanceEligibleOffices.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

const DUE_LIST_INPUT = {
  now: new Date("2026-06-01T00:00:00.000Z"),
  staleAfterDays: 7,
  maxCandidates: 25,
  electionLookbackDays: 30,
  electionLookaheadDays: 730,
};

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Jane Doe",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    committee_id: "C-100",
    committee_name: "Friends of Jane Doe",
    source_url: "https://example.gov/committee/C-100",
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// Byte-for-byte pin of the canonical template under Texas config. The
// remaining migration waves verify each state by byte-comparing builder output
// against that state's bespoke SQL, so template drift (even whitespace) must
// fail the suite. Update this literal only on a deliberate template change.
const EXPECTED_CANONICAL_TEXAS_SQL = `
      WITH due AS (
        SELECT
          link.candidate_id::text AS candidate_id,
          link.election_id::text AS election_id,
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), ''),
            link.candidate_name_normalized
          ) AS candidate_name,
          link.election_year,
          office.scope AS office_scope,
          link.office_name,
          link.district,
          link.committee_id,
          link.committee_name,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM public.tx_candidate_finance_links AS link
        JOIN public.candidates AS candidate
          ON candidate.id = link.candidate_id
        JOIN public.candidate_elections AS candidate_election
          ON candidate_election.candidate_id = link.candidate_id
         AND candidate_election.election_id = link.election_id
        JOIN public.elections AS election
          ON election.id = link.election_id
        JOIN public.districts AS district
          ON district.id = election.district_id
        LEFT JOIN public.offices AS office
          ON office.id = election.office_id
        LEFT JOIN public.tx_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'TX'
          AND election.race_type = 'office'
          AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
          AND (office.scope || '::' || office.canonical_name) = ANY($6::text[])
          AND (
            summary.last_synced_at IS NULL
            OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))
          )
        ORDER BY summary.last_synced_at ASC NULLS FIRST,
                 election.election_date ASC,
                 link.candidate_name_normalized ASC,
                 link.id ASC
        LIMIT $3::int
      )
      SELECT
        candidate_id,
        election_id,
        candidate_name,
        election_year,
        office_scope,
        office_name,
        district,
        committee_id,
        committee_name,
        source_url,
        last_synced_at,
        total_due_rows
      FROM due
    `;

function createCanonicalQuery() {
  return createStandardStateFinanceDueListQuery({
    state: "TX",
    tables: {
      links: "tx_candidate_finance_links",
      summaries: "tx_candidate_finance_summaries",
    },
    eligibleOfficeKeys: TEXAS_FINANCE_ELIGIBLE_OFFICE_KEYS,
  });
}

describe("createStandardStateFinanceDueListQuery", () => {
  it("issues the canonical due-list query and maps rows to camelCase", async () => {
    const db = createMockDb([dueRow()]);
    const listDueRows = createCanonicalQuery();

    const result = await listDueRows(db, DUE_LIST_INPUT);

    expect(result).toEqual({
      totalDueRows: 1,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          committeeId: "C-100",
          committeeName: "Friends of Jane Doe",
          sourceUrl: "https://example.gov/committee/C-100",
          lastSyncedAt: null,
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.tx_candidate_finance_links AS link");
    expect(sql).toContain("LEFT JOIN public.tx_candidate_finance_summaries AS summary");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("candidate.deleted_at IS NULL");
    expect(sql).toContain("district.state = 'TX'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain(
      "election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))"
    );
    expect(sql).toContain(
      "election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))"
    );
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($6::text[])");
    expect(sql).toContain("OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))");
    expect(sql).toContain("LIMIT $3::int");
    expect(normalizeSql(sql)).toContain(
      "ORDER BY summary.last_synced_at ASC NULLS FIRST, election.election_date ASC, link.candidate_name_normalized ASC, link.id ASC"
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      30,
      730,
      [...TEXAS_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]);
  });

  it("emits the canonical SQL template byte-for-byte", async () => {
    const db = createMockDb();
    const listDueRows = createCanonicalQuery();

    await listDueRows(db, DUE_LIST_INPUT);

    expect(String(db.query.mock.calls[0]?.[0])).toBe(EXPECTED_CANONICAL_TEXAS_SQL);
  });

  // Texas migrated onto the builder in the canonical-cohort PR, so this now
  // pins that the exported Texas function stays on the canonical config.
  it("matches the Texas due-list query, parameters, and mapping", async () => {
    const rows = [
      dueRow(),
      dueRow({
        candidate_id: "33333333-3333-4333-8333-333333333333",
        candidate_name: "John Roe",
        district: "District 7",
        last_synced_at: "2026-05-01T00:00:00.000Z",
        total_due_rows: "2",
      }),
    ];
    const bespokeDb = createMockDb(rows.map((row) => ({ ...row })));
    const builderDb = createMockDb(rows.map((row) => ({ ...row })));
    const listDueRows = createCanonicalQuery();

    const bespokeResult = await listDueTexasCandidateFinanceSyncRows(bespokeDb, DUE_LIST_INPUT);
    const builderResult = await listDueRows(builderDb, DUE_LIST_INPUT);

    expect(normalizeSql(String(builderDb.query.mock.calls[0]?.[0]))).toBe(
      normalizeSql(String(bespokeDb.query.mock.calls[0]?.[0]))
    );
    expect(builderDb.query.mock.calls[0]?.[1]).toEqual(bespokeDb.query.mock.calls[0]?.[1]);
    expect(builderResult).toEqual(bespokeResult);
  });

  it("selects overridden link columns and maps rows through the provided mapRow", async () => {
    const db = createMockDb([
      dueRow({
        committee_id: undefined,
        committee_name: undefined,
        committee_key: "PCC 123",
        link_source: "ocf_export",
      }),
    ]);
    const listDueRows = createStandardStateFinanceDueListQuery({
      state: "DC",
      tables: {
        links: "dc_candidate_finance_links",
        summaries: "dc_candidate_finance_summaries",
      },
      eligibleOfficeKeys: ["citywide::Mayor"],
      linkColumns: ["committee_key", "committee_name", "link_source"],
      mapRow: (row: StandardStateFinanceDueQueryRow) => ({
        candidateId: row.candidate_id,
        committeeKey: row.committee_key as string,
        committeeName: row.committee_name as string,
        linkSource: row.link_source as string,
      }),
    });

    const result = await listDueRows(db, DUE_LIST_INPUT);

    expect(result).toEqual({
      totalDueRows: 1,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          committeeKey: "PCC 123",
          committeeName: undefined,
          linkSource: "ocf_export",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("link.committee_key,");
    expect(sql).toContain("link.link_source,");
    expect(sql).not.toContain("link.committee_id");
    expect(sql).toContain("district.state = 'DC'");
    expect(sql).toContain("FROM public.dc_candidate_finance_links AS link");
    // Canonical columns stay in place around the overridden identity columns.
    expect(normalizeSql(sql)).toContain(
      "link.district, link.committee_key, link.committee_name, link.link_source, link.source_url,"
    );
  });

  it("adds the general-stage filter and election_date only when configured", async () => {
    const db = createMockDb([
      dueRow({ election_date: "2026-11-03T00:00:00.000Z", link_source: "cers_portal" }),
    ]);
    const mapRow = vi.fn((row: StandardStateFinanceDueQueryRow) => ({
      electionDate: row.election_date,
      linkSource: row.link_source,
    }));
    const listDueRows = createStandardStateFinanceDueListQuery({
      state: "MT",
      tables: {
        links: "mt_candidate_finance_links",
        summaries: "mt_candidate_finance_summaries",
      },
      eligibleOfficeKeys: ["state_upper::State Senator"],
      electionStage: "general",
      selectElectionDate: true,
      linkColumns: ["committee_id", "committee_name", "link_source"],
      mapRow,
    });

    const result = await listDueRows(db, DUE_LIST_INPUT);

    const sql = String(db.query.mock.calls[0]?.[0]);
    // Stage filter sits directly after the race_type predicate.
    expect(sql).toContain(
      "          AND election.race_type = 'office'\n          AND election.election_stage = 'general'\n          AND election.election_date >="
    );
    // election_date is selected between election_year and office_scope, inside and outside the CTE.
    expect(sql).toContain(
      "          link.election_year,\n          election.election_date::text AS election_date,\n          office.scope AS office_scope,"
    );
    expect(sql).toContain("        election_year,\n        election_date,\n        office_scope,");
    expect(sql).toContain(
      "          link.committee_id,\n          link.committee_name,\n          link.link_source,\n          link.source_url,"
    );
    // Parameters are unchanged: the stage is a validated literal, not a bind.
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      30,
      730,
      ["state_upper::State Senator"],
    ]);
    expect(result.rows).toEqual([{ electionDate: "2026-11-03T00:00:00.000Z", linkSource: "cers_portal" }]);

    // The default template carries neither line (the byte-for-byte pin above
    // guards the exact default text; this guards the option gating).
    const defaultDb = createMockDb();
    await createCanonicalQuery()(defaultDb, DUE_LIST_INPUT);
    const defaultSql = String(defaultDb.query.mock.calls[0]?.[0]);
    expect(defaultSql).not.toContain("election_stage");
    expect(defaultSql).not.toContain("election_date::text");
  });

  it("adds ballot_title only when configured", async () => {
    const db = createMockDb([
      dueRow({ ballot_title: "Circuit Judge, 10th Circuit, Place 1", fcpa_committee_number: null }),
    ]);
    const mapRow = vi.fn((row: StandardStateFinanceDueQueryRow) => ({
      ballotTitle: row.ballot_title,
      fcpaCommitteeNumber: row.fcpa_committee_number,
    }));
    const listDueRows = createStandardStateFinanceDueListQuery({
      state: "AL",
      tables: {
        links: "al_candidate_finance_links",
        summaries: "al_candidate_finance_summaries",
      },
      eligibleOfficeKeys: ["statewide::Governor"],
      electionStage: "general",
      linkColumns: ["committee_id", "committee_name", "fcpa_committee_number", "link_source"],
      mapRow,
    });

    const result = await listDueRows(db, DUE_LIST_INPUT);

    const sql = String(db.query.mock.calls[0]?.[0]);
    // Nothing selected without the flag; the stage filter is independent of it.
    expect(sql).not.toContain("ballot_title");
    expect(sql).toContain("          AND election.election_stage = 'general'\n");
    expect(result.rows).toEqual([
      { ballotTitle: "Circuit Judge, 10th Circuit, Place 1", fcpaCommitteeNumber: null },
    ]);

    const titledDb = createMockDb([dueRow({ ballot_title: "Governor" })]);
    const listTitledRows = createStandardStateFinanceDueListQuery({
      state: "AL",
      tables: {
        links: "al_candidate_finance_links",
        summaries: "al_candidate_finance_summaries",
      },
      eligibleOfficeKeys: ["statewide::Governor"],
      selectBallotTitle: true,
      mapRow: (row) => row.ballot_title,
    });
    const titledResult = await listTitledRows(titledDb, DUE_LIST_INPUT);
    const titledSql = String(titledDb.query.mock.calls[0]?.[0]);
    // ballot_title is selected between office_name and district, inside and outside the CTE.
    expect(titledSql).toContain(
      "          link.office_name,\n          election.official_ballot_title AS ballot_title,\n          link.district,"
    );
    expect(titledSql).toContain("        office_name,\n        ballot_title,\n        district,");
    expect(titledSql).not.toContain("election_date::text");
    expect(titledSql).not.toContain("election_stage");
    expect(titledResult.rows).toEqual(["Governor"]);
  });

  it("returns zero totals for an empty result and tolerates malformed counts", async () => {
    const listDueRows = createCanonicalQuery();

    const emptyResult = await listDueRows(createMockDb(), DUE_LIST_INPUT);
    expect(emptyResult).toEqual({ rows: [], totalDueRows: 0 });

    const malformedResult = await listDueRows(
      createMockDb([dueRow({ total_due_rows: "not-a-number" })]),
      DUE_LIST_INPUT
    );
    expect(malformedResult.totalDueRows).toBe(0);

    const numericResult = await listDueRows(createMockDb([dueRow({ total_due_rows: 41 })]), DUE_LIST_INPUT);
    expect(numericResult.totalDueRows).toBe(41);
  });

  it("passes a fresh eligible-office array on every call", async () => {
    const db = createMockDb();
    const listDueRows = createCanonicalQuery();

    await listDueRows(db, DUE_LIST_INPUT);
    await listDueRows(db, DUE_LIST_INPUT);

    const firstKeys = db.query.mock.calls[0]?.[1]?.[5];
    const secondKeys = db.query.mock.calls[1]?.[1]?.[5];
    expect(firstKeys).toEqual([...TEXAS_FINANCE_ELIGIBLE_OFFICE_KEYS]);
    expect(secondKeys).toEqual(firstKeys);
    expect(secondKeys).not.toBe(firstKeys);
  });

  it("applies optional candidate/year scope and refresh inside the CTE before LIMIT", async () => {
    const db = createMockDb([dueRow({ last_synced_at: DUE_LIST_INPUT.now.toISOString() })]);
    const result = await createCanonicalQuery()(db, {
      ...DUE_LIST_INPUT,
      candidateId: CANDIDATE_ID,
      electionYear: 2026,
      refresh: true,
    });
    const [sqlValue, params] = db.query.mock.calls[0]!;
    const sql = String(sqlValue);
    expect(sql).toContain("AND link.candidate_id = $7::uuid");
    expect(sql).toContain("AND link.election_year = $8::int");
    expect(sql).toContain("AND EXTRACT(YEAR FROM election.election_date)::int = $8::int");
    expect(sql).toContain("$9::boolean");
    expect(normalizeSql(sql)).toContain(
      "AND ( $9::boolean OR summary.last_synced_at IS NULL OR summary.last_synced_at <"
    );
    expect(sql.indexOf("link.candidate_id = $7")).toBeLessThan(sql.indexOf("LIMIT $3"));
    expect(sql.indexOf("link.election_year = $8")).toBeLessThan(sql.indexOf("LIMIT $3"));
    expect(sql.indexOf("$9::boolean")).toBeLessThan(sql.indexOf("LIMIT $3"));
    expect(params?.slice(6)).toEqual([CANDIDATE_ID, 2026, true]);
    expect(result.rows[0]?.lastSyncedAt).toBe(DUE_LIST_INPUT.now.toISOString());
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("district.state = 'TX'");
  });

  it("keeps bind numbering and the original SQL correct for independent optional scopes", async () => {
    const query = createCanonicalQuery();
    const db = createMockDb();
    await query(db, { ...DUE_LIST_INPUT, electionYear: 2026 });
    expect(String(db.query.mock.calls[0]?.[0])).toContain("link.election_year = $7::int");
    expect(db.query.mock.calls[0]?.[1]?.slice(6)).toEqual([2026]);
    await query(db, { ...DUE_LIST_INPUT, refresh: true });
    expect(String(db.query.mock.calls[1]?.[0])).toContain("$7::boolean");
    expect(db.query.mock.calls[1]?.[1]?.slice(6)).toEqual([true]);
    await query(db, { ...DUE_LIST_INPUT, refresh: false });
    expect(String(db.query.mock.calls[2]?.[0])).toBe(EXPECTED_CANONICAL_TEXAS_SQL);
    expect(db.query.mock.calls[2]?.[1]).toHaveLength(6);
  });

  it.each([
    { candidateId: "not-a-uuid" },
    { electionYear: 2026.5 },
    { electionYear: 2101 },
    { refresh: "true" },
  ])("rejects invalid optional scope before querying: %j", async (scope) => {
    const db = createMockDb();
    await expect(createCanonicalQuery()(db, { ...DUE_LIST_INPUT, ...scope } as never)).rejects.toThrow(
      "Invalid standard finance due-list"
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects invalid configuration at construction", () => {
    const base = {
      state: "TX",
      tables: {
        links: "tx_candidate_finance_links",
        summaries: "tx_candidate_finance_summaries",
      },
      eligibleOfficeKeys: ["statewide::Governor"],
    };
    const mapRow = (row: StandardStateFinanceDueQueryRow) => row;

    expect(() => createStandardStateFinanceDueListQuery({ ...base, state: "Texas" })).toThrow(
      "Invalid standard finance due-list state: Texas"
    );
    expect(() => createStandardStateFinanceDueListQuery({ ...base, state: "tx" })).toThrow(
      "Invalid standard finance due-list state: tx"
    );
    expect(() =>
      createStandardStateFinanceDueListQuery({
        ...base,
        tables: { ...base.tables, links: "tx_links; DROP TABLE" },
      })
    ).toThrow("Invalid standard finance table identifier: tx_links; DROP TABLE");
    expect(() =>
      createStandardStateFinanceDueListQuery({
        ...base,
        tables: { ...base.tables, summaries: "Bad-Name" },
      })
    ).toThrow("Invalid standard finance table identifier: Bad-Name");
    expect(() =>
      createStandardStateFinanceDueListQuery({
        ...base,
        linkColumns: ["committee_id, committee_name"],
        mapRow,
      })
    ).toThrow("Invalid standard finance due-list link column: committee_id, committee_name");
    expect(() => createStandardStateFinanceDueListQuery({ ...base, linkColumns: [], mapRow })).toThrow(
      "Standard finance due-list link columns must not be empty"
    );
    expect(() =>
      createStandardStateFinanceDueListQuery({
        ...base,
        linkColumns: ["committee_key"],
      } as Parameters<typeof createStandardStateFinanceDueListQuery>[0])
    ).toThrow("Standard finance due-list linkColumns require a mapRow");
    expect(() => createStandardStateFinanceDueListQuery({ ...base, eligibleOfficeKeys: [] })).toThrow(
      "Standard finance due-list eligible office keys must not be empty"
    );
    expect(() =>
      createStandardStateFinanceDueListQuery({
        ...base,
        electionStage: "primary' OR 1=1 --",
      } as unknown as Parameters<typeof createStandardStateFinanceDueListQuery>[0])
    ).toThrow("Invalid standard finance due-list election stage: primary' OR 1=1 --");
  });
});

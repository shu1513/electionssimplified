import { expect, it, vi } from "vitest";

import { buildOutsideIndustrySupportExplanation } from "../../src/pipeline/address/ballotLookupFinanceShared.js";
import type {
  BallotLookupFinanceOutsideIndustrySupportEvidence,
  BallotLookupFinanceSummary,
} from "../../src/pipeline/address/ballotLookupFinanceShared.js";
import { migrationTableColumns } from "./migrationTableColumns.js";

type MockDb = { query: ReturnType<typeof vi.fn> };

type LoaderRow = Record<string, unknown>;

/**
 * Characterization spec for a state whose ballot-lookup finance loader has
 * the standard Texas-derived shape (5 queries: summary, direct breakdowns,
 * outside groups, outside industries, donor evidence). The fixtures and
 * expected output below pin the loader's CURRENT observable behavior so the
 * Phase 3 swap onto loadStandardStateFinanceSummariesByCandidateElection
 * must reproduce it exactly. Nothing here asserts SQL text — only which
 * tables each query touches, which columns it references, the request
 * parameters, and the mapped output.
 */
export type StateFinanceLoaderCharacterizationSpec = {
  load: (
    db: MockDb,
    candidateRows: readonly LoaderRow[],
    electionRows: readonly LoaderRow[]
  ) => Promise<Map<string, BallotLookupFinanceSummary>>;
  flagEnvVar: string;
  stateCode: string;
  /** e.g. "me_candidate_finance" — the 5 state tables share this prefix. */
  tablePrefix: string;
  source: BallotLookupFinanceSummary["source"];
  genericSourceUrl: string;
  /** An election row (minus election_id/state) the state's office filter accepts. */
  eligibleOffice: { office_scope: string; office_canonical_name: string };
  /** Set when the loader has an office filter: a row it must reject. */
  ineligibleOffice?: { office_scope: string; office_canonical_name: string };
  /**
   * Category types the state's direct-breakdown query returns; default both.
   * The mock bypasses SQL, so the fixtures must mimic the state's filter — a
   * contribution_size-only state (Louisiana/Vermont shape) never sees the
   * occupation rows, and the expected output drops them accordingly.
   */
  directCategoryTypes?: readonly ("occupation" | "contribution_size")[];
  /**
   * The state's outside-industry explanation action wording; default is the
   * shared "independent spending supporting this candidate". Louisiana/Vermont
   * describe their outside groups as PACs.
   */
  outsideSupportActionLabel?: string;
  /**
   * The state's outside-coverage note, when its source has a known gap the
   * summary must disclose. Omitted for every state whose totals carry no
   * such caveat — those payloads must not gain the field at all.
   */
  outsideCoverageNote?: string;
  directCoverageNote?: string;
  /**
   * Set when the loader opts into the public_funds_received funding column.
   * Every other state's payload must not gain the field at all.
   */
  publicFundsReceived?: boolean;
  /** State-only donor queries following the standard five-query family. */
  additionalQueryAliases?: readonly Record<string, string>[];
};

const CANDIDATE_A = "11111111-1111-4111-8111-111111111111";
const ELECTION_A = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_B = "33333333-3333-4333-8333-333333333333";
const ELECTION_B = "44444444-4444-4444-8444-444444444444";

const SUMMARY_A_SOURCE_URL = "https://portal.example/summary-a";
const DIRECT_BUCKET_SOURCE_URL = "https://portal.example/direct-bucket";
const OPPOSE_GROUP_SOURCE_URL = "https://portal.example/oppose-group";
const EVIDENCE_SOURCE_URL = "https://portal.example/evidence";

function key(candidateId: string, electionId: string): string {
  return `${candidateId}\u0000${electionId}`;
}

/** alias → table-suffix map per query position (1-indexed call order). */
const QUERY_TABLE_ALIASES: ReadonlyArray<Record<string, string>> = [
  { link: "links", summary: "summaries" },
  { link: "links", breakdown: "direct_breakdowns" },
  { link: "links", outside_group: "outside_groups" },
  { link: "links", breakdown: "outside_group_breakdowns" },
  {
    link: "links",
    industry: "outside_group_breakdowns",
    breakdown: "outside_group_breakdowns",
    outside_group: "outside_groups",
  },
];

function buildFixtureRows(directCategoryTypes: readonly ("occupation" | "contribution_size")[]): LoaderRow[][] {
  const rows: LoaderRow[][] = [
    // 1: summary — A exercises string parsing + direct-null fallback; B the
    // direct-wins precedence with everything else null.
    [
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        committee_id: "COM-A",
        election_year: 2026,
        total_receipts: "12345.67",
        direct_contribution_total: null,
        total_disbursements: "111.5",
        cash_on_hand: 42,
        public_funds_received: "3120785.29",
        outside_support_total: "900",
        outside_oppose_total: null,
        source_url: SUMMARY_A_SOURCE_URL,
        last_synced_at: "2026-08-01T00:00:00.000Z",
      },
      {
        candidate_id: CANDIDATE_B,
        election_id: ELECTION_B,
        committee_id: null,
        election_year: 2024,
        total_receipts: "50",
        direct_contribution_total: "75.25",
        total_disbursements: null,
        cash_on_hand: null,
        outside_support_total: null,
        outside_oppose_total: null,
        source_url: null,
        last_synced_at: "2026-07-01T00:00:00.000Z",
      },
    ],
    // 2: direct breakdowns — occupation vs contribution_size routing plus the
    // three source_url fallbacks (own url, summary url, generic url).
    [
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        category_type: "occupation",
        category_name: "Attorney",
        amount: "500",
        contributor_count: "3",
        source_url: null,
      },
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        category_type: "contribution_size",
        category_name: "$0-$100",
        amount: 200,
        contributor_count: null,
        source_url: DIRECT_BUCKET_SOURCE_URL,
      },
      {
        candidate_id: CANDIDATE_B,
        election_id: ELECTION_B,
        category_type: "occupation",
        category_name: "Teacher",
        amount: "80",
        contributor_count: null,
        source_url: null,
      },
    ],
    // 3: outside groups — support/oppose routing + generic-url fallback.
    [
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        committee_id: "PAC-1",
        committee_name: "Good PAC",
        support_oppose: "support",
        amount: "1000",
        source_url: null,
      },
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        committee_id: "PAC-2",
        committee_name: "Bad PAC",
        support_oppose: "oppose",
        amount: 250.5,
        source_url: OPPOSE_GROUP_SOURCE_URL,
      },
    ],
    // 4: outside industries.
    [
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        support_oppose: "support",
        category_name: "energy",
        amount: "800",
        contributor_count: "5",
        source_url: null,
      },
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        support_oppose: "oppose",
        category_name: "law",
        amount: "100",
        contributor_count: null,
        source_url: null,
      },
    ],
    // 5: donor evidence — sort-desc + committee-name override via the outside
    // group map (PAC-1 present, PAC-9 absent) + contributor_count rounding.
    [
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        industry_name: "energy",
        committee_id: "PAC-9",
        committee_name: "Solo PAC",
        support_oppose: "support",
        organization_name: "Beta LLC",
        amount: "300",
        contributor_count: null,
        source_url: EVIDENCE_SOURCE_URL,
      },
      {
        candidate_id: CANDIDATE_A,
        election_id: ELECTION_A,
        industry_name: "energy",
        committee_id: "PAC-1",
        committee_name: "Raw Name Ignored",
        support_oppose: "support",
        organization_name: "Acme Corp",
        amount: "600",
        contributor_count: "7.4",
        source_url: null,
      },
    ],
  ];
  rows[1] = rows[1]!.filter((row) =>
    directCategoryTypes.includes(row.category_type as "occupation" | "contribution_size")
  );
  return rows;
}

function buildExpected(spec: StateFinanceLoaderCharacterizationSpec): Map<string, BallotLookupFinanceSummary> {
  const directCategoryTypes = spec.directCategoryTypes ?? ["occupation", "contribution_size"];
  const occupationsA = directCategoryTypes.includes("occupation")
    ? [{ category_name: "Attorney", amount: 500, contributor_count: 3, source_url: SUMMARY_A_SOURCE_URL }]
    : [];
  const bucketsA = directCategoryTypes.includes("contribution_size")
    ? [{ category_name: "$0-$100", amount: 200, contributor_count: null, source_url: DIRECT_BUCKET_SOURCE_URL }]
    : [];
  const supportingIndustriesA = [
    { category_name: "energy", amount: 800, contributor_count: 5, source_url: spec.genericSourceUrl },
  ];
  const opposingIndustriesA = [
    { category_name: "law", amount: 100, contributor_count: null, source_url: spec.genericSourceUrl },
  ];
  const energyOrganizations: BallotLookupFinanceOutsideIndustrySupportEvidence[] = [
    {
      organization_name: "Acme Corp",
      organization_type: "donor",
      amount: 600,
      contributor_count: 7,
      committee_id: "PAC-1",
      committee_name: "Good PAC",
      source_url: spec.genericSourceUrl,
    },
    {
      organization_name: "Beta LLC",
      organization_type: "donor",
      amount: 300,
      contributor_count: null,
      committee_id: "PAC-9",
      committee_name: "Solo PAC",
      source_url: EVIDENCE_SOURCE_URL,
    },
  ];
  const occupationsB = directCategoryTypes.includes("occupation")
    ? [{ category_name: "Teacher", amount: 80, contributor_count: null, source_url: spec.genericSourceUrl }]
    : [];

  return new Map<string, BallotLookupFinanceSummary>([
    [
      key(CANDIDATE_A, ELECTION_A),
      {
        source: spec.source,
        cycle: 2026,
        fec_candidate_id: null,
        controlled_committee_id: "COM-A",
        last_synced_at: "2026-08-01T00:00:00.000Z",
        direct_campaign: {
          total_raised: 12345.67,
          total_spent: 111.5,
          cash_on_hand: 42,
          debts_owed: null,
          ...(spec.publicFundsReceived ? { public_funds_received: 3120785.29 } : {}),
          top_occupations: occupationsA,
          top_employers: [],
          top_industries: [],
          contribution_size_buckets: bucketsA,
          // Absent (not null) for states with no disclosed gap, so this pins
          // both that the state sends it and that nobody else gained it.
          ...(spec.directCoverageNote === undefined
            ? {}
            : { direct_coverage_note: spec.directCoverageNote }),
        },
        outside_spending: {
          support_total: 900,
          oppose_total: null,
          // Absent (not null) for states with no disclosed gap, so this pins
          // both that Ohio sends it and that nobody else gained the field.
          ...(spec.outsideCoverageNote === undefined
            ? {}
            : { outside_coverage_note: spec.outsideCoverageNote }),
          top_supporting_groups: [
            {
              committee_id: "PAC-1",
              committee_name: "Good PAC",
              support_oppose: "support",
              amount: 1000,
              source_url: spec.genericSourceUrl,
            },
          ],
          top_opposing_groups: [
            {
              committee_id: "PAC-2",
              committee_name: "Bad PAC",
              support_oppose: "oppose",
              amount: 250.5,
              source_url: OPPOSE_GROUP_SOURCE_URL,
            },
          ],
          top_supporting_industries: supportingIndustriesA,
          top_opposing_industries: opposingIndustriesA,
        },
        backing_summary: {
          top_direct_donor_occupations: occupationsA,
          top_outside_supporting_industries: [
            {
              ...supportingIndustriesA[0],
              explanation: spec.outsideSupportActionLabel
                ? buildOutsideIndustrySupportExplanation("energy", energyOrganizations, spec.outsideSupportActionLabel)
                : buildOutsideIndustrySupportExplanation("energy", energyOrganizations),
              supporting_organizations: energyOrganizations,
            },
          ],
        },
      } satisfies BallotLookupFinanceSummary,
    ],
    [
      key(CANDIDATE_B, ELECTION_B),
      {
        source: spec.source,
        cycle: 2024,
        fec_candidate_id: null,
        controlled_committee_id: null,
        last_synced_at: "2026-07-01T00:00:00.000Z",
        direct_campaign: {
          total_raised: 75.25,
          total_spent: null,
          cash_on_hand: null,
          debts_owed: null,
          ...(spec.publicFundsReceived ? { public_funds_received: null } : {}),
          top_occupations: occupationsB,
          top_employers: [],
          top_industries: [],
          contribution_size_buckets: [],
          ...(spec.directCoverageNote === undefined
            ? {}
            : { direct_coverage_note: spec.directCoverageNote }),
        },
        outside_spending: {
          support_total: null,
          oppose_total: null,
          // The note describes the SOURCE, so it rides along even on a
          // candidate with no outside rows — the gap is why the totals may
          // be empty.
          ...(spec.outsideCoverageNote === undefined
            ? {}
            : { outside_coverage_note: spec.outsideCoverageNote }),
          top_supporting_groups: [],
          top_opposing_groups: [],
          top_supporting_industries: [],
          top_opposing_industries: [],
        },
        backing_summary: {
          top_direct_donor_occupations: occupationsB,
          top_outside_supporting_industries: [],
        },
      } satisfies BallotLookupFinanceSummary,
    ],
  ]);
}

function electionRow(
  electionId: string,
  state: string,
  office: { office_scope: string; office_canonical_name: string }
): LoaderRow {
  return { election_id: electionId, state, ...office };
}

export function runStateFinanceLoaderCharacterization(spec: StateFinanceLoaderCharacterizationSpec): void {
  const candidateRows = [
    { candidate_id: CANDIDATE_A, election_id: ELECTION_A },
    { candidate_id: CANDIDATE_B, election_id: ELECTION_B },
  ];
  const eligibleElectionRows = [
    electionRow(ELECTION_A, spec.stateCode, spec.eligibleOffice),
    electionRow(ELECTION_B, spec.stateCode, spec.eligibleOffice),
  ];

  it("returns an empty map without querying when the feature flag is off", async () => {
    vi.stubEnv(spec.flagEnvVar, "false");
    const db: MockDb = { query: vi.fn() };

    const result = await spec.load(db, candidateRows, eligibleElectionRows);

    expect(result.size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns an empty map without querying when no election belongs to the state", async () => {
    vi.stubEnv(spec.flagEnvVar, "true");
    const db: MockDb = { query: vi.fn() };

    const result = await spec.load(db, candidateRows, [
      electionRow(ELECTION_A, "ZZ", spec.eligibleOffice),
      electionRow(ELECTION_B, "ZZ", spec.eligibleOffice),
    ]);

    expect(result.size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  if (spec.ineligibleOffice) {
    const ineligibleOffice = spec.ineligibleOffice;
    it("returns an empty map without querying when every office is ineligible", async () => {
      vi.stubEnv(spec.flagEnvVar, "true");
      const db: MockDb = { query: vi.fn() };

      const result = await spec.load(db, candidateRows, [
        electionRow(ELECTION_A, spec.stateCode, ineligibleOffice),
        electionRow(ELECTION_B, spec.stateCode, ineligibleOffice),
      ]);

      expect(result.size).toBe(0);
      expect(db.query).not.toHaveBeenCalled();
    });
  }

  it("maps the fixture rows to the pinned summaries", async () => {
    vi.stubEnv(spec.flagEnvVar, "true");
    const fixtures = buildFixtureRows(spec.directCategoryTypes ?? ["occupation", "contribution_size"]);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: MockDb = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: fixtures[calls.length - 1] ?? [] };
      }),
    };

    const result = await spec.load(db, candidateRows, eligibleElectionRows);

    const aliases = [...QUERY_TABLE_ALIASES, ...(spec.additionalQueryAliases ?? [])];
    expect(calls).toHaveLength(aliases.length);
    // Every query stays on the state's own tables and each expected relation
    // appears in its slot of the fixed query order.
    for (const [index, aliasTables] of aliases.entries()) {
      for (const suffix of Object.values(aliasTables)) {
        expect(calls[index]!.sql, `query ${index + 1} should join ${spec.tablePrefix}_${suffix}`).toContain(
          `${spec.tablePrefix}_${suffix}`
        );
      }
    }
    // Both candidate elections survive the request filter, deduplicated.
    expect(JSON.parse(String(calls[0]!.params[0]))).toEqual([
      { candidate_id: CANDIDATE_A, election_id: ELECTION_A },
      { candidate_id: CANDIDATE_B, election_id: ELECTION_B },
    ]);
    // Follow-up queries page over exactly the summary-selected pairs.
    for (const call of calls.slice(1)) {
      expect(JSON.parse(String(call.params[0]))).toEqual([
        { candidate_id: CANDIDATE_A, election_id: ELECTION_A },
        { candidate_id: CANDIDATE_B, election_id: ELECTION_B },
      ]);
    }

    expect(result).toEqual(buildExpected(spec));
  });

  it("only references columns the migrations create for the state tables", async () => {
    vi.stubEnv(spec.flagEnvVar, "true");
    const queries: string[] = [];
    const db: MockDb = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: queries.length === 1 ? [{ candidate_id: CANDIDATE_A, election_id: ELECTION_A }] : [] };
      }),
    };

    await spec.load(db, candidateRows, eligibleElectionRows);
    const aliases = [...QUERY_TABLE_ALIASES, ...(spec.additionalQueryAliases ?? [])];
    expect(queries).toHaveLength(aliases.length);

    for (const [index, aliasTables] of aliases.entries()) {
      for (const [alias, suffix] of Object.entries(aliasTables)) {
        const tableName = `${spec.tablePrefix}_${suffix}`;
        const referenced = new Set(
          [...queries[index]!.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, "g"))].map((match) => match[1]!)
        );
        expect(referenced.size).toBeGreaterThan(0);
        const schemaColumns = migrationTableColumns(tableName);
        expect(schemaColumns.size).toBeGreaterThan(0);
        for (const column of referenced) {
          expect(schemaColumns.has(column), `query ${index + 1}: ${alias}.${column} is not a column of ${tableName}`).toBe(
            true
          );
        }
      }
    }
  });
}

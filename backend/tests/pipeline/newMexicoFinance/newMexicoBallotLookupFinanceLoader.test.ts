import { afterEach, describe, expect, it, vi } from "vitest";

import { migrationTableColumns } from "../../helpers/migrationTableColumns.js";
import { loadNewMexicoCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/newMexicoFinance/newMexicoBallotLookupFinanceLoader.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

describe("newMexicoBallotLookupFinanceLoader", () => {
  // Regression guard for the schema drift where the outside-groups query
  // selected outside_group.expenditure_count, a column no migration ever
  // created for New Mexico (only the Tennessee table has it). Unit tests
  // mock db.query, so this cross-checks every column the query references
  // against the columns the migrations actually build.
  it("only references outside-group columns that the migrations create", async () => {
    vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "true");
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (queries.length === 1) {
        return { rows: [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }] };
      }
      return { rows: [] };
    });

    await loadNewMexicoCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [{ election_id: ELECTION_ID, state: "NM", office_scope: "statewide", office_canonical_name: "Governor" }]
    );

    const outsideGroupSql = queries.find((sql) => sql.includes("nm_candidate_finance_outside_groups"));
    expect(outsideGroupSql).toBeDefined();

    const referencedColumns = new Set(
      [...outsideGroupSql!.matchAll(/outside_group\.([a-z_]+)/g)].map((match) => match[1])
    );
    expect(referencedColumns.size).toBeGreaterThan(0);

    const schemaColumns = migrationTableColumns("nm_candidate_finance_outside_groups");
    expect(schemaColumns.size).toBeGreaterThan(0);
    for (const column of referencedColumns) {
      expect(
        schemaColumns.has(column),
        `outside_group.${column} is not a column of nm_candidate_finance_outside_groups`
      ).toBe(true);
    }
  });

  it("keeps annual summaries when the native component overlay fails", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
    vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("nm_reported_finance_components")) throw new Error("relation does not exist");
      if (queries.length === 1) {
        return {
          rows: [{
            candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "C1", election_year: 2026,
            total_receipts: "100", direct_contribution_total: "80", total_disbursements: "50",
            outside_support_total: null, outside_oppose_total: null, source_url: null, last_synced_at: "2026-10-01T00:00:00Z",
          }],
        };
      }
      return { rows: [] };
    });

    const summaries = await loadNewMexicoCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [{ election_id: ELECTION_ID, state: "NM", office_scope: "statewide", office_canonical_name: "Governor" }]
    );
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();

    expect(queries.some((sql) => sql.includes("nm_reported_finance_components"))).toBe(true);
    expect(summaries.size).toBe(1);
    expect(summaries.values().next().value?.direct_campaign.total_raised).toBe(80);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { DelawareCandidateFinanceDueRow } from "../../../src/pipeline/delawareFinance/delawareCandidateFinanceDueList.js";
import { loadDelawareVerifiedFinanceLocalContext } from "../../../src/pipeline/delawareFinance/delawareVerifiedFinanceLocalContext.js";

const row: DelawareCandidateFinanceDueRow = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  electionId: "22222222-2222-4222-8222-222222222222", candidateName: "Example Candidate",
  electionYear: 2026, electionDate: "2026-11-03", officeScope: "statewide", officeName: "Attorney General",
  district: "Delaware", cfId: "01004199", committeeName: "Example Committee", linkSource: "cfrs_portal",
  sourceUrl: "https://cfrs.elections.delaware.gov/", lastSyncedAt: null,
};
const context = {
  party: "Democratic", office_scope: "statewide", office_name: "Attorney General",
  district_type: "statewide", geoid_compact: "10", linked_office_name: "Attorney General",
  linked_district: "Delaware", committee_name: "Example Committee", election_date: "2026-11-03",
};
const db = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows }) });

describe("Delaware verified finance local context", () => {
  it("binds the active roster and statewide canonical office without treating its label as a seat", async () => {
    const database = db([context]);
    expect(await loadDelawareVerifiedFinanceLocalContext({ db: database, row })).toMatchObject({
      officeName: "Attorney General", district: null, party: "Democratic", receivingCfId: row.cfId,
    });
    const [sql, params] = database.query.mock.calls[0]!;
    expect(sql).toContain("roster.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("election.election_stage = 'general'");
    expect(params).toEqual([row.candidateId, row.electionId, row.cfId, 2026]);
  });
  it("uses the canonical legislative GEOID and verifies the stored link seat", async () => {
    const linked = { ...row, officeScope: "state_lower", officeName: "State Representative", district: "38" };
    const local = { ...context, office_scope: "state_lower", office_name: "State Lower Chamber Legislator",
      district_type: "state_lower", geoid_compact: "10038", linked_office_name: "State Representative", linked_district: "38" };
    expect(await loadDelawareVerifiedFinanceLocalContext({ db: db([local]), row: linked })).toMatchObject({
      officeName: "State Representative", district: "38",
    });
    await expect(loadDelawareVerifiedFinanceLocalContext({ db: db([{ ...local, geoid_compact: "10037" }]), row: linked })).rejects.toThrow("conflicting seat");
  });
  it.each([
    { party: null }, { geoid_compact: "11" }, { district_type: "county" },
    { election_date: "2024-11-05" }, { committee_name: "Different Committee" },
  ])("preserves on conflicting or missing local authority %j", async (change) => {
    await expect(loadDelawareVerifiedFinanceLocalContext({ db: db([{ ...context, ...change }]), row })).rejects.toThrow();
  });
  it.each([{ rows: [] }, { rows: [context, context] }])("rejects absent or ambiguous active local links", async ({ rows }) => {
    await expect(loadDelawareVerifiedFinanceLocalContext({ db: db(rows), row })).rejects.toThrow("one active local");
  });
  it("rejects an internally consistent stored link that points to the wrong canonical office", async () => {
    await expect(loadDelawareVerifiedFinanceLocalContext({
      db: db([{ ...context, linked_office_name: "Governor" }]), row: { ...row, officeName: "Governor" },
    })).rejects.toThrow("linked office conflicts");
  });
});

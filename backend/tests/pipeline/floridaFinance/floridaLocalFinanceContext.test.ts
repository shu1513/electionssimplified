import { describe, expect, it, vi } from "vitest";
import { loadFloridaLocalFinanceContext } from "../../../src/pipeline/floridaFinance/floridaLocalFinanceContext.js";

const row = {
  candidate_id: "candidate", candidate_election_id: "candidate-election", election_id: "election",
  candidate_name: "Adam Botana", candidate_status: "qualified", election_date: "2026-11-03",
  election_stage: "general", race_type: "office", state: "FL",
  office_scope: "state_lower", office_canonical_name: "State Lower Chamber Legislator",
  district_type: "state_lower", geoid_compact: "12080",
  committee_id: "BOTANA_ADAM_REP_STR", committee_name: "Botana, Adam (REP)(STR)", election_year: 2026,
};
function run(rows = [row], lock = false) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, result: loadFloridaLocalFinanceContext({ db: { query },
    candidateId: row.candidate_id, electionId: row.election_id, committeeId: row.committee_id, lock }) };
}
describe("Florida local source ownership", () => {
  it("derives House80 from actual office and compact district, not link labels", async () => {
    const { result, query } = run();
    expect(await result).toMatchObject({ status: "resolved", context: { district: "80", electionYear: 2026 } });
    expect(query.mock.calls[0]![0]).not.toContain("link.office_name");
    expect(query.mock.calls[0]![0]).not.toContain("link.district");
  });
  it("can recheck ownership with local rows locked", async () => {
    const { result, query } = run([row], true);
    expect((await result).status).toBe("resolved");
    expect(query.mock.calls[0]![0]).toContain("FOR SHARE OF candidate, candidate_election, election, district, office, link");
  });
  it.each([{ rows: [] }, { rows: [row, row] }])("preserves absent or nonunique ownership", async ({ rows }) => {
    expect((await run(rows).result).status).toBe("preserve");
  });
  it.each([
    { election_stage: "primary" }, { election_date: "2026-03-24" }, { election_year: 2024 },
    { state: "PA" }, { race_type: "ballot_measure" }, { candidate_status: "withdrawn" },
    { candidate_status: "lost" }, { office_canonical_name: "School Board Member" },
    { district_type: "state_upper" }, { geoid_compact: "12000" }, { geoid_compact: "12121" },
    { geoid_compact: "48080" }, { candidate_name: "" }, { committee_name: "" },
    { committee_id: "other" }, { candidate_id: "other" }, { election_id: "other" },
  ])("preserves wrong race/context %j", async (change) => {
    expect((await run([{ ...row, ...change }]).result).status).toBe("preserve");
  });
  it("binds Senate numeric seats independently", async () => {
    expect(await run([{ ...row, office_scope: "state_upper", office_canonical_name: "State Senator",
      district_type: "state_upper", geoid_compact: "12009" }]).result)
      .toMatchObject({ status: "resolved", context: { district: "9" } });
    expect((await run([{ ...row, office_scope: "state_upper", office_canonical_name: "State Senator",
      district_type: "state_upper", geoid_compact: "12041" }]).result).status).toBe("preserve");
  });
  it("binds statewide offices only to Florida state district", async () => {
    const statewide = { ...row, office_scope: "statewide", office_canonical_name: "Governor", district_type: "statewide", geoid_compact: "12" };
    expect(await run([statewide]).result).toMatchObject({ status: "resolved", context: { district: null } });
    expect((await run([{ ...statewide, geoid_compact: "12080" }]).result).status).toBe("preserve");
  });
});

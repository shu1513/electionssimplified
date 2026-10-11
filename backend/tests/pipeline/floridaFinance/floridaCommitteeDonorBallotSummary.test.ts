import { describe, expect, it } from "vitest";
import { groupFloridaCommitteeDonorCards } from "../../../src/pipeline/floridaFinance/floridaCommitteeDonorBallotSummary.js";
const row = { candidate_id: "candidate", election_id: "general", committee_id: "1",
  committee_name: "Exact Registered Committee", committee_type: "PAC", amount: "1000.00",
  source_url: "https://dos.elections.myflorida.com/committees/ComDetail.asp?account=1", verified_at: "2026-10-11T21:00:00Z" };
describe("Florida named committee card", () => {
  it("keeps unsorted named committees and source links", () => {
    const result = groupFloridaCommitteeDonorCards([row]).get("candidate\u0000general")!;
    expect(result.groups).toMatchObject([{ interest: "unclassified", interest_name: "Not yet sorted", amount: 1000, pac_count: 1,
      pacs: [{ committee_id: "1", committee_name: row.committee_name, source_url: row.source_url }] }]);
    expect(result.coverageNote).toContain("net of cash refunds");
  });
  it("computes full group amount/count before display cap", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ ...row, committee_id: String(i+1), amount: 100+i }));
    const group = groupFloridaCommitteeDonorCards(rows).get("candidate\u0000general")!.groups[0]!;
    expect(group.amount).toBe(828); expect(group.pac_count).toBe(8); expect(group.pacs).toHaveLength(5);
    expect(group.pacs[0]!.amount).toBe(107);
  });
  it.each(["PAC", "CCE", "PTY", "PAP"])("retains verified legal class %s", committee_type => {
    expect(groupFloridaCommitteeDonorCards([{ ...row, committee_type }]).get("candidate\u0000general")!.groups).toHaveLength(1);
  });
  it.each(["ECO", "ECI", "IXO", "unknown"])("excludes distinct class %s", committee_type => {
    expect(groupFloridaCommitteeDonorCards([{ ...row, committee_type }]).get("candidate\u0000general")!.groups).toEqual([]);
  });
  it("accepted zero has explicit empty PAC list; absence remains absent", () => {
    expect(groupFloridaCommitteeDonorCards([{ ...row, committee_id: null, committee_name: null, amount: null }])
      .get("candidate\u0000general")!.groups).toEqual([]);
    expect(groupFloridaCommitteeDonorCards([]).size).toBe(0);
  });
  it("keeps candidate election scopes separate", () => {
    const result = groupFloridaCommitteeDonorCards([row, { ...row, election_id: "other", amount: 500 }]);
    expect(result.get("candidate\u0000general")!.groups[0]!.amount).toBe(1000);
    expect(result.get("candidate\u0000other")!.groups[0]!.amount).toBe(500);
  });
});

import { describe, expect, it, vi } from "vitest";
import { syncDueFloridaCandidateFinance } from "../../../src/pipeline/floridaFinance/floridaCandidateFinanceBatchSync.js";
import type { FloridaCandidateOutsideFinanceComponent } from "../../../src/pipeline/floridaFinance/floridaCandidateOutsideFinanceSource.js";
const due = { candidate_id: "11111111-1111-4111-8111-111111111111", candidate_election_id: "ce", election_id: "22222222-2222-4222-8222-222222222222",
  candidate_name: "Adam Botana", election_year: 2026, office_name: "State Lower Chamber Legislator", district: "80",
  committee_id: "BOTANA_ADAM_REP_STR", committee_name: "Botana, Adam (REP)(STR)", source_url: null, last_synced_at: null, total_due_rows: 1 };
function setup() {
  const direct = vi.fn().mockResolvedValue({}), load = vi.fn().mockResolvedValue({ status: "preserve", diagnostics: ["Unknown outside source"] });
  const write = vi.fn().mockResolvedValue({ status: "written", supportCents: 1000, diagnostics: [] });
  return { direct, load, write, input: {
    db: { query: vi.fn().mockResolvedValue({ rows: [due] }) }, outsideDb: { connect: vi.fn() },
    candidateId: due.candidate_id, now: new Date("2026-10-11T22:00:00Z"), autoLinkMissingLinks: false,
    fetchMissingContributionData: false, includeRegisteredCommitteeDonors: false,
    contributionDataByCommitteeId: new Map([[due.committee_id, { contributionRows: [{ recipientName: due.committee_name, contributionDate: "05/14/2026", amount: "1000", transactionType: "CHE", contributorName: "Example", address: "", city: "", state: "", zip: "", occupation: "", inKindDescription: "" }] }]]),
    syncFloridaCandidateFinanceFn: direct, outsideFinanceSource: { load }, writeOutsideAllocationsFn: write,
  } };
}
describe("Florida normal independent expenditure sync hook", () => {
  it("writes checked payer packets separately after ordinary finance succeeds", async () => {
    const test = setup();
    // Forwarding fixture only; source and writer suites verify actual raw proof.
    const component = { payerIdentity: { payerLabel: "Example (PAC)", rawSource: [] }, source: {} } as unknown as FloridaCandidateOutsideFinanceComponent;
    const localContext = { candidateId: due.candidate_id };
    test.load.mockResolvedValue({ status: "loaded", localContext, components: [component], diagnostics: [] });
    const result = await syncDueFloridaCandidateFinance(test.input);
    expect(test.load).toHaveBeenCalledWith({ candidateId: due.candidate_id, electionId: due.election_id, committeeId: due.committee_id });
    expect(test.write).toHaveBeenCalledWith({ db: test.input.outsideDb, localContext, ...component });
    expect(test.direct.mock.invocationCallOrder[0]).toBeLessThan(test.load.mock.invocationCallOrder[0]);
    expect(test.direct.mock.calls[0][0]).not.toHaveProperty("trustedOutsideGroups");
    expect(result.results[0].outsideComponents).toMatchObject([{ status: "written", supportCents: 1000 }]);
  });
  it("unknown outside source does not affect independently written direct finance", async () => {
    const test = setup(), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await syncDueFloridaCandidateFinance(test.input);
      expect(result.syncedCandidateCount).toBe(1); expect(test.direct).toHaveBeenCalledOnce();
      expect(test.write).not.toHaveBeenCalled(); expect(result.results[0].outsideComponents).toBeUndefined();
    } finally { warn.mockRestore(); }
  });
  it("acquires candidate-wide outside component once across receiving sibling links", async () => {
    const test = setup(), secondCommittee = "SECOND_RECEIVING_LINK";
    test.input.db.query.mockResolvedValue({ rows: [due, { ...due, committee_id: secondCommittee, total_due_rows: 2 }] });
    test.input.contributionDataByCommitteeId.set(secondCommittee, test.input.contributionDataByCommitteeId.get(due.committee_id)!);
    test.load.mockResolvedValue({ status: "loaded", localContext: {}, components: [], diagnostics: [] });
    const result = await syncDueFloridaCandidateFinance(test.input);
    expect(result.syncedCandidateCount).toBe(2);
    expect(test.direct).toHaveBeenCalledTimes(2); expect(test.load).toHaveBeenCalledOnce();
    expect(test.write).not.toHaveBeenCalled();
  });
  it.each(["dry", "disabled", "connection"])("skips outside source when %s", async mode => {
    const test = setup();
    await syncDueFloridaCandidateFinance({ ...test.input, ...(mode === "dry" ? { dryRun: true } : mode === "disabled" ? { includeIndependentExpenditures: false } : { outsideDb: undefined }) });
    expect(test.load).not.toHaveBeenCalled(); expect(test.write).not.toHaveBeenCalled();
  });
  it("ordinary finance failure does not acquire outside source", async () => {
    const test = setup(); test.direct.mockRejectedValue(new Error("direct failed"));
    const result = await syncDueFloridaCandidateFinance(test.input);
    expect(result.failedCandidateCount).toBe(1); expect(test.load).not.toHaveBeenCalled();
  });
  it("outside acquisition exception preserves ordinary sync result", async () => {
    const test = setup(), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      test.load.mockRejectedValue(new Error("public source unavailable"));
      expect((await syncDueFloridaCandidateFinance(test.input)).syncedCandidateCount).toBe(1);
      expect(test.write).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});

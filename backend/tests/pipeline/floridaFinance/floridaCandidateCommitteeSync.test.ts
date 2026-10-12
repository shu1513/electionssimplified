import { describe, expect, it, vi } from "vitest";
import { syncDueFloridaCandidateFinance } from "../../../src/pipeline/floridaFinance/floridaCandidateFinanceBatchSync.js";
import type { FloridaCommitteeDonorFinanceInput } from "../../../src/pipeline/floridaFinance/floridaCommitteeDonorWriter.js";
const due = { candidate_id: "11111111-1111-4111-8111-111111111111", candidate_election_id: "ce",
  election_id: "22222222-2222-4222-8222-222222222222", candidate_name: "Adam Botana",
  election_year: 2026, office_name: "State Lower Chamber Legislator", district: "80",
  committee_id: "BOTANA_ADAM_REP_STR", committee_name: "Botana, Adam (REP)(STR)",
  source_url: null, last_synced_at: null, total_due_rows: 1 };
const contribution = { recipientName: due.committee_name, contributionDate: "2026-05-14", amount: "1000",
  transactionType: "CHE", contributorName: "Verified Committee", address: "", city: "", state: "", zip: "",
  occupation: "", inKindDescription: "" };
function input() {
  return { db: { query: vi.fn().mockResolvedValue({ rows: [due] }) }, candidateId: due.candidate_id,
    now: new Date("2026-10-11T21:00:00Z"), autoLinkMissingLinks: false, fetchMissingContributionData: false,
    contributionDataByCommitteeId: new Map([[due.committee_id, { contributionRows: [contribution] }]]),
    syncFloridaCandidateFinanceFn: vi.fn().mockResolvedValue({}) };
}
describe("Florida normal committee sync hook", () => {
  it("forwards accepted component through existing atomic snapshot path", async () => {
    const base = input();
    // This test checks forwarding only; source and writer tests verify complete proof contents.
    const pacFinance = { source: { status: "verified" }, finance: { status: "accepted", donors: [] } } as unknown as FloridaCommitteeDonorFinanceInput;
    const load = vi.fn().mockResolvedValue({ status: "accepted", pacFinance });
    await syncDueFloridaCandidateFinance({ ...base, committeeFinanceSource: { load } });
    expect(load).toHaveBeenCalledWith({ candidateId: due.candidate_id, electionId: due.election_id, committeeId: due.committee_id });
    expect(base.syncFloridaCandidateFinanceFn).toHaveBeenCalledWith(expect.objectContaining({ pacFinance }));
    expect(String(base.db.query.mock.calls[0]![0])).toContain("link.candidate_id = $7::uuid");
    expect(base.db.query.mock.calls[0]![1].at(-1)).toBe(due.candidate_id);
  });
  it("preserves unknown PAC component while continuing independent direct sync", async () => {
    const base = input(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await syncDueFloridaCandidateFinance({ ...base, committeeFinanceSource: {
        load: vi.fn().mockResolvedValue({ status: "preserve", diagnostics: ["unknown historical donor"] }) } });
      expect(base.syncFloridaCandidateFinanceFn).toHaveBeenCalledTimes(1);
      expect(base.syncFloridaCandidateFinanceFn.mock.calls[0]![0].pacFinance).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it("dry run never initiates public-source or registry fetching", async () => {
    const base = input(), load = vi.fn();
    await syncDueFloridaCandidateFinance({ ...base, dryRun: true, committeeFinanceSource: { load } });
    expect(load).not.toHaveBeenCalled();
  });
  it("explicit component disable leaves legacy data path available", async () => {
    const base = input(), load = vi.fn();
    await syncDueFloridaCandidateFinance({ ...base, includeRegisteredCommitteeDonors: false, committeeFinanceSource: { load } });
    expect(load).not.toHaveBeenCalled();
    expect(base.syncFloridaCandidateFinanceFn).toHaveBeenCalledTimes(1);
  });
});

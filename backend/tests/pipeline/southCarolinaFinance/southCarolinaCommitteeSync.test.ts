import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncSouthCarolinaCandidateFinance } from "../../../src/pipeline/southCarolinaFinance/southCarolinaCandidateFinanceSync.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function api() {
  let donor = "Example PAC";
  let failDetail = false;
  const line = (type: string, amount: number) => ({ type, filingPeriod: amount, electionCycleTotal: amount });
  const fetchImpl: typeof fetch = async request => {
    const url = String(request);
    let body: unknown;
    if (url.endsWith("Candidate/Reports")) {
      body = { results: [{ reportId: 1, report: "Q2", reportType: "Quarterly", electionDate: "11/3/2026", contributions: 100, expenses: 25, balance: 75, dateSubmitted: "2026-07-10", reportWithDates: { candidateFilerId: 44315, campaignId: 77205, filingStartDate: "2026-01-01", filingEndDate: "2026-06-30", isPrimary: false, isGeneral: true, isPreElection: false, isFinal: false } }] };
    } else if (url.includes("Report/Details")) {
      if (failDetail) return new Response("unavailable", { status: 503 });
      body = { filerName: "Test, Casey", electionDate: "11/3/2026", electionType: "General", reportType: "Quarterly", filingPeriod: "1/1/2026 - 6/30/2026", isAmendment: false, overview: {
        reportSequenceNumber: 1, income: [line("Cash Contributions", 100), line("In-kind Contributions", 0), line("Personal Contributions", 0), line("Loans", 0), line("Account Credits", 0), line("Debt Setoff Funds", 0), line("Total", 100)],
        expenditures: [line("Expenditures", 25), line("Returned Contributions", 0), line("In-Kind Expenditures", 0), line("Total", 25)], totals: [{ totalType: "Campaign Funds", startingBalance: 0, endingBalance: 75 }],
      }, contributions: { contributionsTotal: 100, details: [{ contributorId: 2, contributor: donor, date: "Apr 2, 2026", amount: 100, occupation: "", description: "" }] },
      expenditures: { expendituresTotal: 25, details: [{ paidToId: 3, paidTo: "Printing Vendor", date: "Apr 3, 2026", amount: 25, description: "printing" }] }, versions: [{ id: 1, name: "Original Report" }] };
    } else {
      body = [{ contributionId: 4, candidateId: 44315, officeRunId: 77205, candidateName: "Casey Test", officeName: "SC House of Representatives District 48", electionDate: "11/3/2026", date: "2026-04-02", amount: 100, contributorName: donor, contributorOccupation: "", group: "Yes", description: "" }];
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, changeDonor: () => { donor = "Other Committee"; }, failDetail: () => { failDetail = true; } };
}
async function setup() {
  const sourceCacheDir = await mkdtemp(join(tmpdir(), "sc-sync-test-"));
  directories.push(sourceCacheDir);
  const query = vi.fn(async (sql: unknown) => ({ rows: String(sql).includes("INSERT INTO public.sc_candidate_finance_links") ? [{ id: "33333333-3333-4333-8333-333333333333" }] : [], rowCount: 1 }));
  const client = { query, release: vi.fn() };
  const input = { db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as never, candidateId: "candidate-1", electionId: "election-1", candidateName: "Casey Test", electionYear: 2026, electionDate: "2026-11-03", officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "48", filer: { candidateFilerId: 44315, filerName: "Test, Casey", linkSource: "ethics_filer_search" as const }, sourceCacheDir };
  return { input, query };
}
describe("ordinary SC source acquisition and donor component", () => {
  it("requires a real saved opening, preserves changed source, then writes the new stable donor", async () => {
    const { input, query } = await setup(); const source = api();
    const sync = () => syncSouthCarolinaCandidateFinance({ ...input, clientOptions: { fetchImpl: source.fetchImpl } });
    expect((await sync()).pacDonorTotal).toBeNull();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.sc_candidate_finance_pac_donors"))).toBe(false);
    expect((await sync()).pacDonorsWritten).toBe(1);
    source.changeDonor(); query.mockClear();
    expect((await sync()).pacDonorTotal).toBeNull();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.sc_candidate_finance_pac_donors"))).toBe(false);
    expect((await sync()).pacDonorTotal).toBe(100);
    source.failDetail(); query.mockClear();
    await expect(sync()).rejects.toThrow("HTTP 503");
    expect(query).not.toHaveBeenCalled();
  });
  it("cache initialization failure preserves donors but still writes valid direct totals", async () => {
    const { input, query } = await setup(); const blocked = join(input.sourceCacheDir, "file");
    await writeFile(blocked, "not a directory");
    const result = await syncSouthCarolinaCandidateFinance({ ...input, sourceCacheDir: blocked, clientOptions: { fetchImpl: api().fetchImpl } });
    expect(result).toMatchObject({ summaryWritten: true, directContributionTotal: 100, pacDonorTotal: null });
    expect(result.pacDonorDiagnostics?.join(" ")).toMatch(/capture unavailable/);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.sc_candidate_finance_pac_donors"))).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceDelawareCandidateFinanceSnapshot } from "../../../src/pipeline/delawareFinance/delawareFinanceWriter.js";
import { writeDelawareOutsideEvidence } from "../../../src/pipeline/delawareFinance/delawareOutsideEvidenceWriter.js";
import type { DelawareVerifiedThirdPartyOutsideProof } from "../../../src/pipeline/delawareFinance/delawareThirdPartyOutsideSource.js";
import { writeDelawarePacEvidence, type DelawarePacEvidence } from "../../../src/pipeline/delawareFinance/delawarePacEvidenceWriter.js";

vi.mock("../../../src/pipeline/delawareFinance/delawareOutsideEvidenceWriter.js", () => ({ writeDelawareOutsideEvidence: vi.fn() }));
vi.mock("../../../src/pipeline/delawareFinance/delawarePacEvidenceWriter.js", () => ({ writeDelawarePacEvidence: vi.fn() }));
const outsideWriter = vi.mocked(writeDelawareOutsideEvidence);
const pacWriter = vi.mocked(writeDelawarePacEvidence);
const link = {
  candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
  electionYear: 2026, candidateNameNormalized: "EXAMPLE CANDIDATE", officeName: "Attorney General",
  district: "Delaware", committeeId: "01004199", committeeName: "Example Committee",
  linkSource: "cfrs_portal" as const, sourceUrl: "https://cfrs.elections.delaware.gov/",
};
const linkId = "33333333-3333-4333-8333-333333333333";
// These tests exercise the enclosing transaction. The actual scoped proof
// validator and financial source replay have separate non-mocked suites.
const evidence = { version: 1 } as DelawareVerifiedThirdPartyOutsideProof;
function database(foreignOwner = false) {
  const client = { release: vi.fn(), query: vi.fn(async (sql: string) => {
    if (sql.includes("INSERT INTO public.de_candidate_finance_links")) return { rows: [{ id: linkId }], rowCount: 1 };
    if (sql.includes("SELECT pac_source_provenance")) return { rows: [{ pac_source_provenance: null, outside_report_provenance: null }], rowCount: 1 };
    if (foreignOwner && sql.includes("candidate_id <> $3")) return { rows: [{ id: "other-owner" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  return { client, db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } };
}
afterEach(() => { outsideWriter.mockReset(); pacWriter.mockReset(); });

describe("Delaware outside snapshot transaction", () => {
  it("writes scoped evidence inside the shared transaction and preserves outside-only direct amounts", async () => {
    outsideWriter.mockResolvedValue({ groupsWritten: 1, diagnostics: [] });
    const { db, client } = database();
    const result = await replaceDelawareCandidateFinanceSnapshot({ db, link, outsideEvidence: [evidence] });
    expect(result).toMatchObject({ summaryWritten: false, outsideGroupsWritten: 1 });
    expect(outsideWriter.mock.calls[0]![0]).toMatchObject({ db: client, linkId, link, prior: null, incoming: [evidence] });
    const sql = client.query.mock.calls.map(([sql]) => sql);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.some(sql => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(sql.find(sql => sql.includes("INSERT INTO public.de_candidate_finance_summaries"))).toContain("DO NOTHING");
    expect(sql.some(sql => /DELETE.*outside|outside_support_total|outside_oppose_total/.test(sql))).toBe(false);
    expect(sql.some(sql => sql.includes("UPDATE public.de_candidate_finance_links") && sql.includes("id <>"))).toBe(false);
  });
  it("keeps direct refresh success when a scoped outside component is preserved", async () => {
    outsideWriter.mockResolvedValue({ groupsWritten: 0, diagnostics: ["Outside snapshot preserved"] });
    const { db } = database();
    const result = await replaceDelawareCandidateFinanceSnapshot({ db, link,
      summary: { totalReceipts: 100, directContributionTotal: 100, totalDisbursements: 10, cashOnHand: 90 },
      outsideEvidence: [evidence] });
    expect(result).toMatchObject({ summaryWritten: true, outsideGroupsWritten: 0, outsideDiagnostics: ["Outside snapshot preserved"] });
  });
  it("rolls back the entire snapshot on a scoped storage database failure", async () => {
    outsideWriter.mockRejectedValue(new Error("synthetic database failure"));
    const { db, client } = database();
    await expect(replaceDelawareCandidateFinanceSnapshot({ db, link, outsideEvidence: [evidence] })).rejects.toThrow("database failure");
    expect(client.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it("rejects another active candidate owner before writing evidence", async () => {
    const { db, client } = database(true);
    await expect(replaceDelawareCandidateFinanceSnapshot({ db, link, outsideEvidence: [evidence] })).rejects.toThrow("another active candidate owner");
    expect(outsideWriter).not.toHaveBeenCalled();
    expect(client.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  });
  it("attaches PAC and outside components to one transaction while preserving an unavailable direct gift total", async () => {
    pacWriter.mockResolvedValue({ donorsWritten: 2, diagnostics: [] });
    outsideWriter.mockResolvedValue({ groupsWritten: 1, diagnostics: [] });
    const pacEvidence = { donors: [] } as unknown as DelawarePacEvidence;
    const { db, client } = database();
    const result = await replaceDelawareCandidateFinanceSnapshot({ db, link,
      summary: { totalReceipts: 100, totalDisbursements: 10, cashOnHand: 90 },
      pacEvidence, outsideEvidence: [evidence] });
    expect(result).toMatchObject({ pacDonorsWritten: 2, outsideGroupsWritten: 1 });
    expect(pacWriter.mock.calls[0]![0]).toMatchObject({ db: client, linkId, link, incoming: pacEvidence });
    const summarySql = client.query.mock.calls.find(([sql]) => sql.includes("total_receipts"))![0];
    expect(summarySql).toContain("direct_contribution_total = COALESCE(EXCLUDED.direct_contribution_total, de_candidate_finance_summaries.direct_contribution_total)");
    expect(client.query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(client.query.mock.calls.some(([sql]) => sql.includes("UPDATE public.de_candidate_finance_links") && sql.includes("id <>"))).toBe(false);
  });
  it("keeps cash and outside independent when PAC authority is preserved", async () => {
    pacWriter.mockResolvedValue({ donorsWritten: 0, diagnostics: ["PAC snapshot preserved"] });
    outsideWriter.mockResolvedValue({ groupsWritten: 1, diagnostics: [] });
    const { db } = database();
    const result = await replaceDelawareCandidateFinanceSnapshot({ db, link,
      summary: { totalReceipts: 100, directContributionTotal: 100 },
      pacEvidence: { donors: [] } as unknown as DelawarePacEvidence, outsideEvidence: [evidence] });
    expect(result).toMatchObject({ summaryWritten: true, pacDonorsWritten: 0, outsideGroupsWritten: 1,
      pacDiagnostics: ["PAC snapshot preserved"] });
  });
  it("rolls back cash and skips outside writes on a PAC database failure", async () => {
    pacWriter.mockRejectedValue(new Error("synthetic PAC database failure"));
    const { db, client } = database();
    await expect(replaceDelawareCandidateFinanceSnapshot({ db, link, summary: { totalReceipts: 100 },
      pacEvidence: { donors: [] } as unknown as DelawarePacEvidence, outsideEvidence: [evidence] })).rejects.toThrow("PAC database failure");
    expect(outsideWriter).not.toHaveBeenCalled();
    expect(client.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  });
  it("retains other receiving accounts on a scoped cash-only refresh", async () => {
    const { db, client } = database();
    await replaceDelawareCandidateFinanceSnapshot({ db, link, linkReplacementPolicy: "retain",
      summary: { totalReceipts: 100, directContributionTotal: 100 } });
    expect(client.query.mock.calls.some(([sql]) => sql.includes("UPDATE public.de_candidate_finance_links") && sql.includes("id <>"))).toBe(false);
    expect(pacWriter).not.toHaveBeenCalled();
    expect(outsideWriter).not.toHaveBeenCalled();
    expect(client.query.mock.calls.at(-1)![0]).toBe("COMMIT");
  });
});

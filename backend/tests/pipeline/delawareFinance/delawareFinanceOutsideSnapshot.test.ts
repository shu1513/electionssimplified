import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceDelawareCandidateFinanceSnapshot } from "../../../src/pipeline/delawareFinance/delawareFinanceWriter.js";
import { writeDelawareOutsideEvidence } from "../../../src/pipeline/delawareFinance/delawareOutsideEvidenceWriter.js";
import type { DelawareVerifiedThirdPartyOutsideProof } from "../../../src/pipeline/delawareFinance/delawareThirdPartyOutsideSource.js";

vi.mock("../../../src/pipeline/delawareFinance/delawareOutsideEvidenceWriter.js", () => ({ writeDelawareOutsideEvidence: vi.fn() }));
const outsideWriter = vi.mocked(writeDelawareOutsideEvidence);
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
    if (sql.includes("SELECT outside_report_provenance")) return { rows: [{ outside_report_provenance: null }], rowCount: 1 };
    if (foreignOwner && sql.includes("candidate_id <> $3")) return { rows: [{ id: "other-owner" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  return { client, db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } };
}
afterEach(() => outsideWriter.mockReset());

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
});

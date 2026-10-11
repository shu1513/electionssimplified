import { describe, expect, it, vi } from "vitest";
import { replaceArkansasCandidateFinanceSnapshot } from "../../../src/pipeline/arkansasFinance/arkansasFinanceWriter.js";
import { arkansasPacReceivingSourceUrl, type ArkansasPacSourceProvenance } from "../../../src/pipeline/arkansasFinance/arkansasPacSourceEvidence.js";

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const hash = "a".repeat(64);
const link = { candidateId: id(1), electionId: id(2), electionYear: 2026,
  candidateNameNormalized: "JANE DOE", officeName: "Governor", filingEntityId: 7243, filerName: "Jane Doe" };
const sourceUrl = arkansasPacReceivingSourceUrl(id(3));
function evidence(empty = false): ArkansasPacSourceProvenance {
  return {
    version: 1, scope: "current_original_reported_pac_cash", link: { ...link, filingEntityId: "7243" },
    receiver: { entityId: "7243", registrationGuid: id(3), sourceName: "Jane Doe", electionYear: 2026,
      officeName: "Governor", district: null },
    windowStart: "2025-01-01", windowEnd: "2026-10-11", publishedThrough: "2026-01-31", sourceUrl,
    monetaryCashCents: empty ? 0 : 50000, pacCashCents: empty ? 0 : 50000,
    reports: [{ reportGuid: id(4), reportVersion: 1, reportName: "January Original",
      periodStart: "2025-01-01", periodEnd: "2026-01-31", filedAtRaw: "2026-02-01T12:00:00",
      filePath: `Reports/${id(4)}.pdf`, pdfSha256: hash, reportFingerprint: hash,
      returnedCashCents: 0, returnProof: "explicit_section19_zero" }],
    cashRows: empty ? [] : [{ guid: id(5), reportGuid: id(4), reportedName: "Zeta Committee",
      transactionDate: "2025-12-01", amountCents: 50000, transactionSource: "Political Action Committee",
      transactionSubTypeDescription: "Itemized Monetary", nativeFingerprint: hash, transactionId: 100,
      transactionVersionId: 1, transactionTypeCode: "TCON", transactionSubTypeCode: "ITMY",
      transactionSourceTypeCode: "TPAC", detailFingerprint: hash }],
    groups: empty ? [] : [{ committeeId: "reported:ZETA COMMITTEE", committeeName: "Zeta Committee",
      committeeType: "Political Action Committee", amountCents: 50000, contributionCount: 1, receiptGuids: [id(5)] }],
    sourceFingerprints: { reportsBefore: hash, reportsAfter: hash, nativeBefore: hash, nativeAfter: hash,
      registryBefore: hash, registryAfter: hash }, rawResponseHashes: [hash],
  };
}
const donors = [{ committeeId: "reported:ZETA COMMITTEE", committeeName: "Zeta Committee",
  committeeType: "Political Action Committee" as const, amount: 500, contributionCount: 1, sourceUrl }];
function database(options: { prior?: unknown; otherOwner?: boolean; failInsert?: boolean } = {}) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("INSERT INTO public.ar_candidate_finance_links")) return { rows: [{ id: id(6) }] };
    if (sql.includes("candidate_id <> $3::uuid")) return { rows: options.otherOwner ? [{ id: id(7) }] : [] };
    if (sql.includes("SELECT pac_source_provenance")) return { rows: [{ pac_source_provenance: options.prior ?? null }] };
    if (sql.includes("INSERT INTO public.ar_candidate_finance_pac_donors") && options.failInsert) throw new Error("PAC insert failure");
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  return { db: { query: vi.fn(), connect: vi.fn(async () => client) } as never, client };
}
describe("Arkansas verified PAC persistence", () => {
  it("stores rows and proof in one transaction while leaving direct and outside amounts unknown", async () => {
    const { db, client } = database();
    expect(await replaceArkansasCandidateFinanceSnapshot({ db, link, pacDonors: donors,
      pacSourceProvenance: evidence() })).toMatchObject({ summaryWritten: true, pacDonorsWritten: 1 });
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toBe("BEGIN"); expect(sqls.at(-1)).toBe("COMMIT");
    expect(sqls.some(sql => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(sqls.some(sql => sql.includes("FOR UPDATE"))).toBe(true);
    expect(sqls.some(sql => sql.includes("DELETE FROM public.ar_candidate_finance_outside_groups"))).toBe(false);
    expect(sqls.some(sql => sql.includes("UPDATE public.ar_candidate_finance_summaries SET pac_source_provenance"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it("preserves omitted PACs and requires provenance even for an empty snapshot", async () => {
    const { db, client } = database();
    await replaceArkansasCandidateFinanceSnapshot({ db, link });
    expect(client.query.mock.calls.some(([sql]) => sql.includes("pac_donors") || sql.includes("pac_source_provenance"))).toBe(false);
    const missing = database();
    await expect(replaceArkansasCandidateFinanceSnapshot({ db: missing.db, link, pacDonors: [] })).rejects.toThrow("paired source provenance");
    expect(missing.client.query).not.toHaveBeenCalled();
    const empty = database();
    await expect(replaceArkansasCandidateFinanceSnapshot({ db: empty.db, link, pacDonors: [],
      pacSourceProvenance: evidence(true) })).resolves.toMatchObject({ pacDonorsWritten: 0, summaryWritten: true });
    expect(empty.client.query.mock.calls.some(([sql]) => sql.includes("DELETE FROM public.ar_candidate_finance_pac_donors"))).toBe(true);
  });
  it.each(["owner", "prior", "insert"])("rolls back %s failures without committing evidence", async kind => {
    const state = database({ otherOwner: kind === "owner", prior: kind === "prior" ? evidence() : null,
      failInsert: kind === "insert" });
    const p = kind === "prior" ? evidence(true) : evidence();
    await expect(replaceArkansasCandidateFinanceSnapshot({ db: state.db, link,
      pacDonors: kind === "prior" ? [] : donors, pacSourceProvenance: p })).rejects.toThrow();
    expect(state.client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(state.client.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(state.client.query.mock.calls.some(([sql]) => sql.includes("SET pac_source_provenance"))).toBe(false);
  });
  it("retains the validated generation if caller data changes during a database wait", async () => {
    const state = database();
    const p = evidence(), suppliedDonors = structuredClone(donors), suppliedLink = { ...link };
    const db = { query: vi.fn(), connect: vi.fn(async () => {
      suppliedDonors[0]!.amount = 9000;
      (p.groups[0] as { amountCents: number }).amountCents = 900000;
      suppliedLink.filingEntityId = 9999;
      return state.client;
    }) } as never;
    await replaceArkansasCandidateFinanceSnapshot({ db, link: suppliedLink, pacDonors: suppliedDonors, pacSourceProvenance: p });
    const insert = state.client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.ar_candidate_finance_pac_donors"))!;
    expect(JSON.parse(String(insert[1]![2]))[0].amount).toBe(500);
    const stored = state.client.query.mock.calls.find(([sql]) => sql.includes("SET pac_source_provenance"))!;
    expect(JSON.parse(String(stored[1]![2])).groups[0].amountCents).toBe(50000);
    const ownership = state.client.query.mock.calls.find(([sql]) => sql.includes("candidate_id <> $3::uuid"))!;
    expect(ownership[1]![0]).toBe("7243");
  });
});

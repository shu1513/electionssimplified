import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PHOENIX_EFD_BALLOT_URL, PHOENIX_EFD_INDEX_URL, PHOENIX_EFD_REVIEW,
  parsePhoenixCouncilBallot, parsePhoenixEfdIndex, selectPhoenixEfdFamily, phoenixEfdObservationDay,
  validatePhoenixReviewedEfd, type PhoenixReviewedEfdReport } from "../../../src/pipeline/phoenixFinance/phoenixReviewedEfd.js";
import { loadPhoenixReviewedEfdPacket } from "../../../src/pipeline/phoenixFinance/phoenixReviewedEfdSource.js";
import { syncPhoenixReviewedEfd } from "../../../src/pipeline/phoenixFinance/phoenixReviewedEfdSync.js";
import { phoenixEfdReportProjection, writePhoenixReviewedEfdPacket } from "../../../src/pipeline/phoenixFinance/phoenixReviewedEfdWriter.js";
import { appendPhoenixReviewedEfdSummaries } from "../../../src/pipeline/phoenixFinance/phoenixReviewedEfdBallotSummary.js";
import { loadPhoenixCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/phoenixFinance/phoenixBallotLookupFinanceLoader.js";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";

// Entirely invented fixtures. No source filing, identity or amount is copied.
const candidateId = "11111111-1111-4111-8111-111111111111", electionId = "22222222-2222-4222-8222-222222222222";
const familyId = "33333333-3333-4333-8333-333333333333", payer = "Example Neighborhood Association", person = "Taylor Sample";
const url = (id: string) => `https://www.phoenix.gov/content/dam/phoenix/cityclerksite/documents/synthetic-${id}.pdf`;
const key = candidateElectionKey(candidateId, electionId);
const contextRow = { candidate_name: person, election_date: "2026-11-03", office_name: "City Council Member",
  office_scope: "place", state: "AZ", district_type: "place", geoid_compact: "0455000",
  official_ballot_title: "Phoenix City Council, District 2" };
const electionRow = { election_id: electionId, state: "AZ", district_type: "place", geoid_compact: "0455000",
  office_scope: "place", office_canonical_name: "City Council Member", official_ballot_title: contextRow.official_ballot_title };

function pdf(marker: string): Buffer {
  const stream = `BT /F1 12 Tf 20 700 Td (${marker}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let text = "%PDF-1.4\n"; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  return Buffer.from(text + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const pdfs = [pdf("Synthetic review A"), pdf("Synthetic review B")];
const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
function reviews(): PhoenixReviewedEfdReport[] {
  return ["900001", "900002"].map((id, i) => ({ documentId: id, sourceUrl: url(id), sourceSha256: sha(pdfs[i]!),
    filedDate: "2026-10-20", reportedSpenderName: payer, reportedCandidateName: person,
    reportedOffice: "Council", reportedDistrictNumber: null, vendorName: `Invented Vendor ${i}`,
    expenditureDate: i ? "2026-10-04" : "2026-10-02", amountCents: i ? 6789 : 12345,
    supportOppose: i ? "oppose" : "support", reviewedPageCount: 1, review: PHOENIX_EFD_REVIEW }));
}
function index(extra = ""): string {
  return `<table><tr><th>DATE</th><th>NAME</th><th>DOC ID</th></tr>
    <tr><td>10/28/0222</td><td>Unrelated Historic Organization</td><td><a href="https://apps-secure.phoenix.gov/PublicRecordsSearch/Home/RenderPDF?doc=999999">999999</a></td></tr>
    ${reviews().map(r => `<tr><td>10/20/2026</td><td>${payer}</td><td><a href="${r.sourceUrl}">${r.documentId}</a></td></tr>`).join("")}
    ${extra}<tr><td></td><td></td><td></td></tr></table>`;
}
function ballot(targetCertified = true): string {
  return `<h1>November 3, 2026 Election</h1><h2>Candidates for District 2</h2><table>
    <tr><th>Name</th><th>Certified to Ballot</th></tr><tr><td>${person}</td><td>${targetCertified ? "07/09/2026" : ""}</td></tr>
    <tr><td>Jordan Example</td><td>${targetCertified ? "" : "07/10/2026"}</td></tr></table>`;
}
function transport(options: { targetCertified?: boolean; changedClosingIndex?: boolean; newFilingPdfUnavailable?: boolean } = {}) {
  let indexes = 0;
  const newFiling = `<tr><td>10/20/2026</td><td>${payer}</td><td><a href="${url("900003")}">900003</a></td></tr>`;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    const href = String(input);
    if (href === PHOENIX_EFD_INDEX_URL) {
      indexes++;
      const extra = (options.changedClosingIndex && indexes === 2) || options.newFilingPdfUnavailable ? newFiling : "";
      return new Response(index(extra), { headers: { "Content-Type": "text/html" } });
    }
    if (href === PHOENIX_EFD_BALLOT_URL) return new Response(ballot(options.targetCertified), { headers: { "Content-Type": "text/html" } });
    if (href === url("900003")) return new Response("unavailable", { status: 503 });
    const i = reviews().findIndex(r => r.sourceUrl === href);
    expect(i).toBeGreaterThanOrEqual(0);
    return new Response(new Uint8Array(pdfs[i]!), { headers: { "Content-Type": "application/pdf" } });
  }) as unknown as typeof fetch;
}
const canonicalDb = () => ({ query: vi.fn(async () => ({ rows: [{ ...contextRow }] })) });
const temporary: string[] = [];
async function cache(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "phoenix-efd-synthetic-")); temporary.push(dir); return dir;
}
async function packet(cacheDir?: string, fetchImpl = transport()) {
  return loadPhoenixReviewedEfdPacket({ db: canonicalDb() as never, cacheDir: cacheDir ?? await cache(),
    candidateId, electionId, spenderName: payer, reports: reviews(), reviewedMapping: true, fetchImpl, requestIntervalMs: 0 });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  for (const flag of ["PHOENIX_CAMPAIGN_FINANCE_ENABLED", "PHOENIX_REVIEWED_EFD_ENABLED", "PHOENIX_REVIEWED_EFD_SYNC_ENABLED", "PHOENIX_REVIEWED_EFD_RAW_REFRESH_ENABLED"]) vi.stubEnv(flag, "true");
  vi.stubEnv("AI_API_CALLS_ALLOWED", "false");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("unit_network_denied"); }));
});
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Phoenix reviewed EFD qualification", () => {
  it("accounts for every physical publication row and retains uncertified ballot rows", () => {
    const rows = parsePhoenixEfdIndex(index());
    expect(rows).toHaveLength(3); expect(rows[0]!.filedDate).toBe("0222-10-28");
    expect(selectPhoenixEfdFamily(rows, payer, "2026-11-03", "2026-10-26")).toHaveLength(2);
    expect(parsePhoenixCouncilBallot(ballot())).toEqual([
      { name: person, district: 2, certifiedDate: "2026-07-09" }, { name: "Jordan Example", district: 2, certifiedDate: null },
    ]);
    expect(phoenixEfdObservationDay("2026-10-27T03:00:00Z")).toBe("2026-10-26");
  });
  it("rejects incomplete, duplicate, amended and indistinguishable reviewed families", () => {
    const family = parsePhoenixEfdIndex(index()), validate = (reports: PhoenixReviewedEfdReport[]) =>
      validatePhoenixReviewedEfd({ spenderName: payer, electionDate: "2026-11-03", asOfDate: "2026-10-26", family, reports });
    expect(() => validate(reviews().slice(0, 1))).toThrow("incomplete_reviewed_report_set");
    expect(() => validate([reviews()[0]!, reviews()[0]!])).toThrow("duplicate_reviewed_report");
    expect(() => validate([{ ...reviews()[0]!, review: { ...PHOENIX_EFD_REVIEW, newReport: false } as never }, reviews()[1]!])).toThrow("new_report_review");
    const duplicate = { ...reviews()[1]!, vendorName: reviews()[0]!.vendorName, expenditureDate: reviews()[0]!.expenditureDate,
      amountCents: reviews()[0]!.amountCents, supportOppose: reviews()[0]!.supportOppose };
    expect(() => validate([reviews()[0]!, duplicate])).toThrow("indistinguishable_expenses");
    const annotated = index(`<tr><td>10/21/2026</td><td>${payer} (Amendment)</td><td><a href="${url("900003")}">900003</a></td></tr>`);
    expect(() => selectPhoenixEfdFamily(parsePhoenixEfdIndex(annotated), payer, "2026-11-03", "2026-10-26")).toThrow("lineage_requires_review");
  });
  it("requires exact cents, real dates and literal office/district controls", () => {
    const family = parsePhoenixEfdIndex(index());
    for (const change of [{ amountCents: 12.5 }, { expenditureDate: "2026-02-30" }, { reportedOffice: "Mayor" }, { reportedDistrictNumber: 3 }]) {
      expect(() => validatePhoenixReviewedEfd({ spenderName: payer, electionDate: "2026-11-03", asOfDate: "2026-10-26", family,
        reports: [{ ...reviews()[0]!, ...change }, reviews()[1]!] })).toThrow();
    }
  });
  it("accepts late filings for pre-election expenses without assigning runoff expenses to the earlier contest", () => {
    const reports = reviews().map(r => ({ ...r, filedDate: "2027-01-16" }));
    const family = reports.map(r => ({ documentId: r.documentId, spenderName: payer, sourceUrl: r.sourceUrl, filedDate: r.filedDate }));
    const input = { spenderName: payer, electionDate: "2026-11-03", asOfDate: "2027-01-19", family, reports };
    expect(validatePhoenixReviewedEfd(input).occurrenceCount).toBe(2);
    expect(() => validatePhoenixReviewedEfd({ ...input, reports: [{ ...reports[0]!, expenditureDate: "2026-12-10" }, reports[1]!] })).toThrow("expenditure_controls");
  });
  it("mints only whole-cache-backed frozen packets with a certified target", async () => {
    const p = await packet(); expect(p.occurrenceCount).toBe(2); expect(p.supportCents).toBe(12345); expect(p.opposeCents).toBe(6789);
    expect(Object.isFrozen(p.reports[0]!.review)).toBe(true);
    await expect(packet(undefined, transport({ targetCertified: false }))).rejects.toThrow("official_ballot_context_conflict");
  });
  it("replays unavailable-source originals without advancing their clocks", async () => {
    const dir = await cache(), first = await packet(dir);
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const unavailable = vi.fn(async () => new Response("unavailable", { status: 403 })) as unknown as typeof fetch;
    const replay = await packet(dir, unavailable);
    expect(replay.observedAt).toBe(first.observedAt); expect(replay.sourceDigest).toBe(first.sourceDigest);
  });
  it("never hides a changed complete publication census behind saved originals", async () => {
    const dir = await cache(); await packet(dir);
    await expect(packet(dir, transport({ changedClosingIndex: true }))).rejects.toThrow("publication_census_changed");
  });
  it("refuses to replay saved originals once an incomplete refresh has seen a new filing", async () => {
    const dir = await cache(); await packet(dir);
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    await expect(packet(dir, transport({ newFilingPdfUnavailable: true }))).rejects.toThrow("publication_census_changed");
    await expect(packet(undefined, transport({ newFilingPdfUnavailable: true }))).rejects.toThrow("source_unavailable");
  });
  it("lets a newer capture that proved a source change block older saved originals until a complete refresh", async () => {
    const dir = await cache(); await packet(dir);
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    await expect(packet(dir, transport({ changedClosingIndex: true }))).rejects.toThrow("publication_census_changed");
    const unavailable = vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    await expect(packet(dir, unavailable)).rejects.toThrow("source_unavailable");
    vi.stubEnv("PHOENIX_REVIEWED_EFD_RAW_REFRESH_ENABLED", "false");
    await expect(packet(dir)).rejects.toThrow("recent_whole_original_cache_required");
    vi.stubEnv("PHOENIX_REVIEWED_EFD_RAW_REFRESH_ENABLED", "true");
    vi.setSystemTime(new Date("2026-10-27T13:00:00Z"));
    const fresh = await packet(dir);
    vi.stubEnv("PHOENIX_REVIEWED_EFD_RAW_REFRESH_ENABLED", "false");
    expect((await packet(dir)).sourceDigest).toBe(fresh.sourceDigest);
  });
  it("rejects changed scan review hashes and missing review gates", async () => {
    await expect(loadPhoenixReviewedEfdPacket({ db: canonicalDb() as never, cacheDir: await cache(), candidateId, electionId,
      spenderName: payer, reports: [{ ...reviews()[0]!, sourceSha256: "a".repeat(64) }, reviews()[1]!],
      reviewedMapping: true, fetchImpl: transport(), requestIntervalMs: 0 })).rejects.toThrow("reviewed_whole_original_changed");
    vi.stubEnv("PHOENIX_REVIEWED_EFD_SYNC_ENABLED", "false");
    await expect(packet()).rejects.toThrow("reviewed_sync_disabled");
  });
  it("an unavailable uncached source never reaches the production financial writer", async () => {
    const db = { ...canonicalDb(), connect: vi.fn() };
    await expect(syncPhoenixReviewedEfd({ db: db as never, cacheDir: await cache(), candidateId, electionId,
      spenderName: payer, reports: reviews(), reviewedMapping: true, requestIntervalMs: 0,
      fetchImpl: vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
    })).rejects.toThrow("source_unavailable");
    expect(db.connect).not.toHaveBeenCalled();
  });
});

function writerDb(p: Awaited<ReturnType<typeof packet>>, options: { equal?: boolean; conflict?: boolean; owner?: boolean; movedContext?: boolean; newer?: boolean; missingPriorDocument?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM public.candidates c")) return { rows: [{ ...contextRow, ...(options.movedContext ? { official_ballot_title: "Phoenix City Council, District 4" } : {}) }] };
    if (sql.includes("FROM public.phx_reported_efd_families")) return { rows: options.equal || options.newer || options.missingPriorDocument ? [{ id: familyId, newer: Boolean(options.newer), equal: Boolean(options.equal),
      source_digest: p.sourceDigest, support_cents: String(p.supportCents), oppose_cents: String(p.opposeCents),
      occurrence_count: p.occurrenceCount, canonical_context: p.context, spender_name: p.spenderName }] : [] };
    if (sql.includes("SELECT document_id FROM public.phx_reported_efd_reports")) return { rows: [{ document_id: "900003" }] };
    if (sql.includes("FROM public.phx_reported_efd_reports")) return { rows: sql.includes("document_id=ANY")
      ? options.owner ? [{ family_id: "other" }] : []
      : p.reports.map(phoenixEfdReportProjection).map((r, i) => options.conflict && i === 1 ? { ...r, vendor_name: "Conflicting Vendor" } : r) };
    if (sql.includes("INSERT INTO public.phx_reported_efd_families")) return { rows: [{ id: familyId }] };
    return { rows: [] };
  });
  const release = vi.fn(); return { query, release, db: { query, connect: vi.fn(async () => ({ query, release })) } };
}
describe("Phoenix reviewed EFD transactional ownership", () => {
  it("rejects unminted packets before connecting", async () => {
    const p = await packet(), db = writerDb(p);
    await expect(writePhoenixReviewedEfdPacket({ db: db.db as never, packet: { ...p }, reviewedMapping: true })).rejects.toThrow("whole_source_packet_required");
    expect(db.db.connect).not.toHaveBeenCalled();
  });
  it("writes one atomic family without touching legacy tables", async () => {
    const p = await packet(), db = writerDb(p);
    expect(await writePhoenixReviewedEfdPacket({ db: db.db as never, packet: p, reviewedMapping: true })).toEqual({ status: "written", reportsWritten: 2 });
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO public.phx_reported_efd_reports"))).toHaveLength(2);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("phx_candidate_finance"))).toBe(false);
    expect(db.query).toHaveBeenCalledWith("COMMIT"); expect(db.release).toHaveBeenCalledOnce();
  });
  it("rolls back moved candidate context and globally owned references", async () => {
    const p = await packet();
    for (const options of [{ owner: true }, { movedContext: true }, { newer: true }, { missingPriorDocument: true }]) {
      const db = writerDb(p, options);
      await expect(writePhoenixReviewedEfdPacket({ db: db.db as never, packet: p, reviewedMapping: true })).rejects.toThrow();
      expect(db.query).toHaveBeenCalledWith("ROLLBACK");
      expect(db.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.phx_reported_efd_families"))).toBe(false);
    }
  });
  it("makes an identical packet a no-op and rejects same-clock review changes", async () => {
    const p = await packet(), same = writerDb(p, { equal: true });
    expect(await writePhoenixReviewedEfdPacket({ db: same.db as never, packet: p, reviewedMapping: true })).toEqual({ status: "unchanged", reportsWritten: 0 });
    expect(same.query.mock.calls.some(([sql]) => /^(INSERT|DELETE|UPDATE)/u.test(sql))).toBe(false);
    const conflict = writerDb(p, { equal: true, conflict: true });
    await expect(writePhoenixReviewedEfdPacket({ db: conflict.db as never, packet: p, reviewedMapping: true })).rejects.toThrow("same_clock_review_conflict");
    expect(conflict.query).toHaveBeenCalledWith("ROLLBACK");
  });
});

function storedFamily(p: Awaited<ReturnType<typeof packet>>) {
  return { id: familyId, candidate_id: candidateId, election_id: electionId, election_year: 2026, spender_name: payer,
    spender_name_key: payer.toUpperCase(), canonical_context: p.context, observed_at: p.observedAt, completed_at: p.completedAt,
    source_digest: p.sourceDigest, source_url: PHOENIX_EFD_INDEX_URL, occurrence_count: p.occurrenceCount,
    support_cents: String(p.supportCents), oppose_cents: String(p.opposeCents), reports: p.reports.map(phoenixEfdReportProjection) };
}
function readerDb(families: ReturnType<typeof storedFamily>[]) {
  return { query: vi.fn(async (sql: string) => ({ rows: sql.includes("FROM public.candidates c") ? [{ ...contextRow }]
    : sql.includes("JOIN public.phx_reported_efd_families") ? families : [] })) };
}
describe("Phoenix reviewed EFD read component", () => {
  it("keeps held data hidden with the new read flag off", async () => {
    const db = readerDb([]); vi.stubEnv("PHOENIX_REVIEWED_EFD_ENABLED", "false");
    await appendPhoenixReviewedEfdSummaries(db as never, [{ candidate_id: candidateId, election_id: electionId }], new Map());
    expect(db.query).not.toHaveBeenCalled();
  });
  it("appears without a direct-finance link through the ordinary loader", async () => {
    const p = await packet(), db = readerDb([storedFamily(p)]);
    const result = await loadPhoenixCandidateFinanceSummariesByCandidateElection(db as never,
      [{ candidate_id: candidateId, election_id: electionId }], [electionRow]);
    expect(result.get(key)?.direct_campaign.total_raised).toBeNull();
    expect(result.get(key)?.outside_spending).toMatchObject({ support_total: null, oppose_total: null,
      top_supporting_groups: [{ amount: 123.45, expenditure_count: 1 }], top_opposing_groups: [{ amount: 67.89, expenditure_count: 1 }] });
    expect(result.get(key)?.outside_spending.outside_coverage_note).toContain("do not establish statutory independence");
  });
  it("checks every family before caps instead of displaying a plausible valid prefix", async () => {
    const p = await packet(), base = storedFamily(p);
    const families = Array.from({ length: 6 }, (_, i) => ({ ...base, id: `${familyId}-${i}`, spender_name: `Invented Filer ${i}`,
      spender_name_key: `INVENTED FILER ${i}`, reports: base.reports.map((r, j) => ({ ...r, document_id: String(910001 + i * 2 + j),
        source_url: url(String(910001 + i * 2 + j)), reported_spender_name: `Invented Filer ${i}` })) }));
    const good = new Map<string, BallotLookupFinanceSummary>();
    await appendPhoenixReviewedEfdSummaries(readerDb(families) as never, [{ candidate_id: candidateId, election_id: electionId }], good);
    expect(good.get(key)?.outside_spending.top_supporting_groups).toHaveLength(5);
    expect(good.get(key)?.outside_spending.outside_coverage_note).toContain("12 expenditures from 6 named filers");
    families[5]!.reports[1]!.reported_candidate_name = "Unrelated Candidate";
    const bad = new Map<string, BallotLookupFinanceSummary>();
    await appendPhoenixReviewedEfdSummaries(readerDb(families) as never, [{ candidate_id: candidateId, election_id: electionId }], bad);
    expect(bad.size).toBe(0);
  });
  it("preserves direct money and withholds overlapping legacy payer amounts", async () => {
    const p = await packet(), db = readerDb([storedFamily(p)]), summaries = new Map<string, BallotLookupFinanceSummary>();
    await appendPhoenixReviewedEfdSummaries(db as never, [{ candidate_id: candidateId, election_id: electionId }], summaries);
    const prior = summaries.get(key)!; prior.direct_campaign.total_raised = 500;
    prior.outside_spending.top_supporting_groups = [{ committee_id: "legacy", committee_name: payer, support_oppose: "support", amount: 100, expenditure_count: 1, source_url: null }];
    prior.outside_spending.top_opposing_groups = [];
    const direct = prior.direct_campaign;
    await appendPhoenixReviewedEfdSummaries(db as never, [{ candidate_id: candidateId, election_id: electionId }], summaries);
    expect(summaries.get(key)?.direct_campaign).toBe(direct); expect(direct.total_raised).toBe(500);
    expect(summaries.get(key)?.outside_spending.top_supporting_groups).toHaveLength(1);
    expect(summaries.get(key)?.outside_spending.top_supporting_groups[0]?.amount).toBe(100);
    expect(summaries.get(key)?.outside_spending.outside_coverage_note).toContain("overlapping payer names");
  });
  it("detects a legacy overlap hidden below the legacy display cap", async () => {
    const p = await packet(), f = storedFamily(p), db = readerDb([f]), summaries = new Map<string, BallotLookupFinanceSummary>();
    await appendPhoenixReviewedEfdSummaries(db as never, [{ candidate_id: candidateId, election_id: electionId }], summaries);
    const summary = summaries.get(key)!;
    summary.outside_spending.top_supporting_groups = Array.from({ length: 5 }, (_, i) => ({ committee_id: `legacy-${i}`,
      committee_name: `Different Legacy Group ${i}`, support_oppose: "support" as const, amount: 500, expenditure_count: 1, source_url: null }));
    summary.outside_spending.top_opposing_groups = [];
    const overlapDb = { query: vi.fn(async (sql: string) => sql.includes("JOIN public.phx_candidate_finance_outside_groups")
      ? { rows: [{ candidate_id: candidateId, election_id: electionId, spender_name: payer }] }
      : db.query(sql)) };
    await appendPhoenixReviewedEfdSummaries(overlapDb as never, [{ candidate_id: candidateId, election_id: electionId }], summaries);
    expect(summaries.get(key)?.outside_spending.top_supporting_groups).toHaveLength(5);
    expect(summaries.get(key)?.outside_spending.top_supporting_groups.every(g => g.committee_id.startsWith("legacy-"))).toBe(true);
    expect(summaries.get(key)?.outside_spending.outside_coverage_note).toContain("overlapping payer names");
  });
});

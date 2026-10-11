import { describe, expect, it, vi } from "vitest";
import { writeArkansasOutsideEvidence } from "../../../src/pipeline/arkansasFinance/arkansasOutsideEvidenceWriter.js";
import {
  aggregateArkansasVerifiedOutsideEvidence, mergeArkansasVerifiedOutsideEvidence, validateArkansasVerifiedOutsideEvidence,
  type ArkansasOutsideIdentityCoverProof, type ArkansasVerifiedOutsideEvidence,
} from "../../../src/pipeline/arkansasFinance/arkansasVerifiedOutsideEvidence.js";
import { fingerprintArkansasVerifiedRawRows, type ArkansasVerifiedRegistryRow, type ArkansasVerifiedCollection, type ArkansasVerifiedCurrentReportRow } from "../../../src/pipeline/arkansasFinance/arkansasVerifiedSourceClient.js";
import type { ArkansasVerifiedCurrentIeProof, ArkansasVerifiedIeOccurrence } from "../../../src/pipeline/arkansasFinance/arkansasCurrentOriginalFinancialSource.js";
import type { ArkansasFinanceLinkInput } from "../../../src/pipeline/arkansasFinance/arkansasFinanceWriter.js";
const id = (n: number) => "00000000-0000-0000-0000-" + String(n).padStart(12, "0");
const h = (s = "a") => s.repeat(64);
const achor: ArkansasFinanceLinkInput = { candidateId: id(1), electionId: id(2), electionYear: 2026,
  candidateNameNormalized: "BRANDON ACHOR", officeName: "State Senator", district: "State Senate District 13 (2024); Arkansas", filingEntityId: 7387, filerName: "Brandon Achor" };
const fite: ArkansasFinanceLinkInput = { ...achor, candidateId: id(3), electionId: id(4), filingEntityId: 8277,
  candidateNameNormalized: "CHARLENE FITE", filerName: "Edna Fite", officeName: "State Lower Chamber Legislator", district: "State House District 24 (2024); Arkansas" };
function registered(n = 7387, overrides: Partial<ArkansasVerifiedRegistryRow> = {}): ArkansasVerifiedRegistryRow {
  return { registrationGuid: id(n), filerEntityId: n, filerEntityVersionId: 1, filerType: "Candidate", filerTypeCode: "CAN", filerStatus: "Active",
    filerName: "ACHOR, BRANDON", committeeName: null, firstName: "BRANDON", lastName: "ACHOR", suffix: null,
    office: "State Senate", officeDistrictName: "13", jurisdictionName: "Arkansas", politicalParty: null,
    electionYear: 2026, filingYear: null, isPaperFiler: false, totalRaised: 0, totalSpent: 0, balanceOfFunds: 0, rawFields: {}, ...overrides };
}
function registry(rows = [registered(), registered(8277, { filerName: "Fite, Edna C.", firstName: "Edna", lastName: "Fite", office: "State Representative", officeDistrictName: "24" })]): ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow> {
  rows = rows.map(r => ({ ...r, rawFields: { guid: r.registrationGuid, filerEntityID: r.filerEntityId, filerType: r.filerType,
    filerTypeCode: r.filerTypeCode, filerStatus: r.filerStatus, filerName: r.filerName, committeeName: r.committeeName, isPaperFiler: r.isPaperFiler, totalRows: rows.length } }));
  return { rows, complete: true, totalItems: rows.length, fingerprint: fingerprintArkansasVerifiedRawRows(rows),
    requests: [{ url: "https://api-ethics-disclosures.sos.arkansas.gov/api/PublicFilerDetails/GetCandidateCommitteDetails", method: "POST",
      requestBody: { pageNumber: 1, pageSize: 1000 }, startedAt: "2026-10-11T00:00:00Z", endedAt: "2026-10-11T00:00:01Z",
      status: 200, contentType: "application/json", bytes: 123, sha256: h() }] };
}
function expense(n: number, purpose: string, amountCents: number, overrides: Partial<ArkansasVerifiedIeOccurrence> = {}): ArkansasVerifiedIeOccurrence {
  return { guid: id(n), reportGuid: id(300), reportedName: "Published vendor", reportedAddress: "Full source address",
    transactionDate: "2026-03-04", amountCents, transactionSource: "Others", transactionSubTypeDescription: "Itemized Monetary", nativeFingerprint: h(),
    transactionId: n, transactionVersionId: 1, transactionTypeCode: "TEXP", transactionSubTypeCode: "ITMY", detailFingerprint: h("b"),
    sourceElectionYear: 2026, electionTypeCode: "PRMELEC", nativeCategory: null, detailOtherCategory: null, purpose, ...overrides };
}
function proof(): ArkansasVerifiedCurrentIeProof {
  const expenseRows = [
    expense(10, "CREATIVE DESIGN SERVICES IN SUPPORT OF BRANDON ACHOR, AR-SD-13", 1062),
    expense(11, "CREATIVE DESIGN SERVICES IN SUPPORT OF CHARLENE FITE, AR-HD-24", 1063),
    expense(12, "SMS MESSAGING IN SUPPORT OF BRANDON ACHOR, AR-SD- 13", 13485),
    expense(13, "SMS MESSAGING IN SUPPORT OF CHARLENE FITE AR HD 24", 18075),
    ...[14, 15, 16, 17, 18, 19].map((n, i) => expense(n, "BANK FEE", i === 0 ? 100191 : 1, { sourceElectionYear: null, electionTypeCode: null })),
  ];
  return { version: 1, payer: { entityId: "1085", registrationGuid: id(1085), sourceName: "NRA", electionYear: 2026, officeName: null, district: null },
    windowStart: "2025-01-01", windowEnd: "2026-12-31", expenditureCents: expenseRows.reduce((a, r) => a + r.amountCents, 0),
    reports: [{ reportGuid: id(300), reportVersion: 1, reportName: "2026 April Monthly Report", periodStart: "2026-01-01", periodEnd: "2026-04-30",
      filedAtRaw: "2026-05-19T12:00:00", filePath: "Reports/" + id(301) + ".pdf", pdfSha256: h("c"), reportFingerprint: h("d") }],
    expenseRows, sourceFingerprints: { nativeBefore: h(), nativeAfter: h(), reportsBefore: h("e"), reportsAfter: h("e") },
    rawResponseHashes: [h()], coverElectionConflicts: [{ reportGuid: id(300), electionTypeRaw: "No Election", electionDateRaw: "2020-11-03" }] };
}
function identityCover(): ArkansasOutsideIdentityCoverProof {
  const reg = registry(), r: ArkansasVerifiedCurrentReportRow = {
    registrationGuid: id(8277), filerReportGuid: id(400), filerReportVersionId: 2, reportName: "2026 August Monthly Report",
    reportType: null, reportStatus: "Amended", reportVersion: null, startDate: "2026-08-01T00:00:00", endDate: "2026-08-31T00:00:00",
    dueDate: null, filedDate: "2026-09-10T12:00:00", filerFilingCalendarGuid: null, electionTypeCode: "GRNELEC", reportElectionType: null,
    filePath: "Reports/" + id(401) + ".pdf", isPaperFile: false, hasChild: true, rawFields: { guid: id(400), totalRows: 1 } };
  const reports: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow> = { rows: [r], complete: true, totalItems: 1,
    fingerprint: fingerprintArkansasVerifiedRawRows([r]), requests: reg.requests };
  return { identity: { entityId: "8277", registrationGuid: id(8277), sourceName: "Fite, Edna C.", electionYear: 2026, officeName: "State Representative", district: "24" },
    registryBefore: reg, registryAfter: reg, reportsBefore: reports, reportsAfter: reports,
    pdf: { reportGuid: id(400), request: { ...reg.requests[0]!, url: "https://api-ethics-disclosures.sos.arkansas.gov/api/PublicFiledReportAndDownload/DownloadDocument",
      requestBody: { filerReportGuid: id(400), fileName: "2026 August Monthly Report V2", openInNewTab: true }, bytes: 123, sha256: h("f") },
      parsed: { sha256: h("f"), byteCount: 123, kind: "candidate", ownerName: "Edna Charlene Fite", filerId: "8277", officeName: "State Representative",
        district: "24", electionYear: 2026, periodStart: "2026-08-01", periodEnd: "2026-08-31", filedAt: "2026-09-10T12:00:00",
        reportLabel: "2026 August Monthly Report", electionTypeRaw: "General", electionDateRaw: null, currentCashCents: 999999,
        currentLoanCents: 0, currentExpenseCents: 0, noActivity: "unchecked", amendment: "checked_vector", returnedCashCents: null,
        cashRows: [], nonmoneyRows: [], expenseRows: [], sectionTotals: {}, sections: [], pages: [] } } };
}
function aggregate(link = achor, p = proof(), reg = registry(), cover?: ArkansasOutsideIdentityCoverProof) {
  return aggregateArkansasVerifiedOutsideEvidence({ link, financialEvidence: p, registryBefore: reg, registryAfter: reg, candidateIdentityCover: cover });
}
describe("Arkansas source-scoped positive outside allocation", () => {
  it("allocates exactly the two Achor rows and retains all 10 reconciled expenses and unallocated fees", () => {
    const r = aggregate(); expect(r.evidence?.allocations).toHaveLength(2);
    expect(r.evidence?.reportGroups).toEqual([{ reportGuid: id(300), supportCents: 14547 }]);
    expect(r.evidence?.expenseRows).toHaveLength(10); expect(r.evidence?.expenditureCents).toBe(133881);
    expect(r.evidence).not.toHaveProperty("outsideSupportTotal"); expect(r.evidence?.reportGroups[0]).not.toHaveProperty("opposeCents");
    expect(r.evidence?.coverElectionConflicts[0]?.electionTypeRaw).toBe("No Election");
    expect(r.diagnostics.join(" ")).toMatch(/explicit PRMELEC/);
  });
  it("uses finite Fite current amended cover for identity only and allocates 19138", () => {
    const r = aggregate(fite, proof(), registry(), identityCover());
    expect(r.evidence?.reportGroups[0]).toEqual({ reportGuid: id(300), supportCents: 19138 });
    expect(r.evidence?.identityCover).toMatchObject({ reportVersion: 2, ownerName: "Edna Charlene Fite" });
    expect(r.evidence?.expenditureCents).toBe(133881);
  });
  it("cannot guess Fite alias without complete current cover authority", () => {
    expect(aggregate(fite).evidence).toBeUndefined();
    const c = identityCover(); c.pdf.parsed.ownerName = "Edna Fite";
    expect(aggregate(fite, proof(), registry(), c).evidence).toBeUndefined();
    const wrong = identityCover(); wrong.identity.entityId = "99";
    expect(aggregate(fite, proof(), registry(), wrong).evidence).toBeUndefined();
  });
  it("checks current cover request/hash and full manifest bracket", () => {
    const c = identityCover(); c.pdf.request.sha256 = h("c");
    expect(aggregate(fite, proof(), registry(), c).evidence).toBeUndefined();
    const changed = identityCover(); changed.reportsAfter = { ...changed.reportsAfter, fingerprint: h("b") };
    expect(aggregate(fite, proof(), registry(), changed).evidence).toBeUndefined();
  });
  it("does not require Fite cover to accept independent Achor allocations", () => {
    const invalid = identityCover(); invalid.pdf.parsed.ownerName = "Unknown";
    expect(aggregate(achor, proof(), registry(), invalid).evidence?.allocations).toHaveLength(2);
  });
  it("rejects terminated same-name target collisions and wrong local office/seat/year/name", () => {
    const reg = registry([registered(), registered(777, { filerStatus: "Terminated" })]);
    expect(aggregate(achor, proof(), reg).evidence).toBeUndefined();
    for (const link of [{ ...achor, district: "14" }, { ...achor, officeName: "State Lower Chamber Legislator" },
      { ...achor, electionYear: 2028 }, { ...achor, candidateNameNormalized: "Brandon Achor Jr" }, { ...achor, filingEntityId: 99 }]) {
      expect(aggregate(link).evidence).toBeUndefined();
    }
  });
  it("does not override a conflicting exact full-name candidate with finite Fite policy", () => {
    const reg = registry([registered(), registered(8277, { filerName: "Fite, Edna C.", firstName: "Edna", lastName: "Fite", office: "State Representative", officeDistrictName: "24" }),
      registered(999, { firstName: "Charlene", lastName: "Fite", filerName: "Fite, Charlene", office: "State Representative", officeDistrictName: "24", filerStatus: "Terminated" })]);
    expect(aggregate(fite, proof(), reg, identityCover()).evidence).toBeUndefined();
  });
  it.each(["SMS MESSAGING FOR BRANDON ACHOR AR-SD-13", "ADVERTISING IN SUPPORT OF BRANDON ACHOR AR-SD-13",
    "SMS MESSAGING IN SUPPORT OF BRANDON ACHOR AND JANE DOE AR-SD-13", "BANK FEE"])("never invents allocation for %s", purpose => {
    const p = proof(); p.expenseRows = [expense(10, purpose, 100)]; p.expenditureCents = 100;
    expect(aggregate(achor, p).evidence).toBeUndefined();
  });
  it("requires explicit PRMELEC/2026 per row; report cycle does not substitute", () => {
    for (const overrides of [{ sourceElectionYear: null }, { sourceElectionYear: 2024 }, { electionTypeCode: null }, { electionTypeCode: "GRNELEC" }]) {
      const p = proof(); p.expenseRows = [expense(10, "SMS MESSAGING IN SUPPORT OF BRANDON ACHOR AR-SD-13", 100, overrides)]; p.expenditureCents = 100;
      expect(aggregate(achor, p).evidence).toBeUndefined();
    }
  });
  it("accepts strict explicit opposition while support remains unknown", () => {
    const p = proof(); p.expenseRows = [expense(10, "SMS MESSAGING IN OPPOSITION TO BRANDON ACHOR AR-SD-13", 100)]; p.expenditureCents = 100;
    expect(aggregate(achor, p).evidence?.reportGroups).toEqual([{ reportGuid: id(300), opposeCents: 100 }]);
  });
  it("retains source-proved blank bank-fee purpose as unallocated, never synthesized target", () => {
    const p = proof(); p.expenseRows = p.expenseRows.map(r => r.guid === id(14) ?
      { ...r, purpose: "", nativeCategory: "Other(list)(Bank Fee)", detailOtherCategory: "Bank Fee" } : r);
    const e = aggregate(achor, p).evidence!;
    expect(e.allocations).toHaveLength(2); expect(e.expenseRows.find(r => r.guid === id(14))?.purpose).toBe("");
    const bad = proof(); bad.expenseRows = bad.expenseRows.map(r => r.guid === id(14) ?
      { ...r, purpose: "", nativeCategory: "Other(list)(Bank Fee)", detailOtherCategory: null } : r);
    expect(aggregate(achor, bad).evidence).toBeUndefined();
  });
  it("retains equal distinct expense occurrences without economic dedupe", () => {
    const p = proof(); p.expenseRows = [expense(10, "SMS MESSAGING IN SUPPORT OF BRANDON ACHOR AR-SD-13", 100),
      expense(11, "SMS MESSAGING IN SUPPORT OF BRANDON ACHOR AR-SD-13", 100)]; p.expenditureCents = 200;
    expect(aggregate(achor, p).evidence?.allocations).toHaveLength(2);
  });
  it("rejects malformed full financial proof instead of publishing a positive subset", () => {
    const p = proof(); p.expenseRows = [...p.expenseRows, p.expenseRows[0]!]; p.expenditureCents += p.expenseRows[0]!.amountCents;
    expect(aggregate(achor, p).evidence).toBeUndefined();
    const changed = proof(); changed.sourceFingerprints.nativeAfter = h("b"); expect(aggregate(achor, changed).evidence).toBeUndefined();
    const missing = proof(); missing.reports = []; expect(aggregate(achor, missing).evidence).toBeUndefined();
  });
  it("validates exact positive sums/references/sourceURL at writer boundary", () => {
    const e = aggregate().evidence!;
    expect(validateArkansasVerifiedOutsideEvidence(JSON.parse(JSON.stringify(e)), achor)).toEqual(e);
    expect(() => validateArkansasVerifiedOutsideEvidence({ ...e, reportGroups: [{ reportGuid: id(300), supportCents: 0 }] }, achor)).toThrow(/totals mismatch/);
    expect(() => validateArkansasVerifiedOutsideEvidence({ ...e, sourceUrl: "https://example.org/" }, achor)).toThrow(/source binding/);
    expect(() => validateArkansasVerifiedOutsideEvidence({ ...e, allocations: [{ ...e.allocations[0]!, stance: "oppose" }] }, achor)).toThrow(/allocation source/);
  });
});
describe("Arkansas original-only per-payer merge", () => {
  it("retains prior source when no incoming generation is available", () => {
    const e = aggregate().evidence!; expect(mergeArkansasVerifiedOutsideEvidence({ link: achor, retained: [e], incoming: [] }).evidence).toEqual([e]);
  });
  it("never silently drops malformed legacy authority", () => {
    const legacy = { unknown: "legacy provenance" };
    const r = mergeArkansasVerifiedOutsideEvidence({ link: achor, retained: [legacy], incoming: [] });
    expect(r.evidence).toEqual([legacy]); expect(r.diagnostics.join(" ")).toMatch(/unknown prior/);
  });
  it("retains old payer on changed same-ID source purpose/hash with unchanged money", () => {
    const e = aggregate().evidence!, p = proof();
    p.expenseRows = p.expenseRows.map(r => r.guid === id(14) ? { ...r, nativeFingerprint: h("c") } : r);
    const next = aggregate(achor, p).evidence!;
    const merged = mergeArkansasVerifiedOutsideEvidence({ link: achor, retained: [e], incoming: [next] });
    expect(merged.evidence).toEqual([e]); expect(merged.diagnostics.join(" ")).toMatch(/expense disappeared or changed/);
  });
  it("retains disappeared full prior reports or expenses even when allocated totals stay equal", () => {
    const e = aggregate().evidence!, p = proof();
    p.expenseRows = p.expenseRows.filter(r => r.guid !== id(14)); p.expenditureCents -= 100191;
    const next = aggregate(achor, p).evidence!;
    expect(mergeArkansasVerifiedOutsideEvidence({ link: achor, retained: [e], incoming: [next] }).evidence).toEqual([e]);
  });
  it("reports no accepted scopes for prior identity failures and reports only independently accepted mixed payer", () => {
    const prior = aggregate().evidence!, badProof = proof();
    badProof.expenseRows = badProof.expenseRows.map(r => r.guid === id(14) ? { ...r, nativeFingerprint: h("c") } : r);
    const bad = aggregate(achor, badProof).evidence!;
    const other = { ...prior, payer: { ...prior.payer, entityId: "1090", registrationGuid: id(1090) },
      sourceUrl: prior.sourceUrl.replace(id(1085), id(1090)) };
    const failed = mergeArkansasVerifiedOutsideEvidence({ link: achor, retained: [prior], incoming: [bad] });
    expect(failed.acceptedRegistrationGuids).toEqual([]); expect(failed.evidence).toEqual([prior]);
    const mixed = mergeArkansasVerifiedOutsideEvidence({ link: achor, retained: [prior], incoming: [bad, other] });
    expect(mixed.acceptedRegistrationGuids).toEqual([id(1090)]); expect(mixed.evidence).toEqual([prior, other]);
  });
  it("permits append-only new originals while independently retaining a changed different payer", () => {
    const e = aggregate().evidence!, p = proof();
    p.reports = [...p.reports, { ...p.reports[0]!, reportGuid: id(310), periodStart: "2026-05-01", periodEnd: "2026-05-31",
      filedAtRaw: "2026-06-01T12:00:00", pdfSha256: h("b"), reportFingerprint: h("f") }];
    p.expenseRows = [...p.expenseRows, expense(20, "SMS MESSAGING IN SUPPORT OF BRANDON ACHOR AR-SD-13", 100,
      { reportGuid: id(310), transactionDate: "2026-05-15" })]; p.expenditureCents += 100;
    const next = aggregate(achor, p).evidence!;
    const other = { ...e, payer: { ...e.payer, registrationGuid: id(1090), entityId: "1090" },
      sourceUrl: e.sourceUrl.replace(id(1085), id(1090)) } satisfies ArkansasVerifiedOutsideEvidence;
    expect(mergeArkansasVerifiedOutsideEvidence({ link: achor, retained: [e, other], incoming: [next] }).evidence).toEqual([next, other]);
  });
});

describe("Arkansas scoped writer accepts only currently verified scopes", () => {
  function db(rows: { filing_entity_id: string; filer_name: string; support_oppose: string; amount: string }[] = [], failInsert = false) {
    return { query: vi.fn(async (sql: string, _args?: unknown[]) => {
      if (sql.includes("SELECT filing_entity_id")) return { rows };
      if (sql.includes("INSERT INTO public.ar_candidate_finance_outside_groups") && failInsert) throw new Error("DB insert failure");
      return { rows: [] };
    }) };
  }
  const prior = (e: unknown[]) => ({ version: 1, scope: "positive_current_original_report_allocations", evidence: e });
  it("inserts positive groups and full scoped authority without clearing headlines or directions", async () => {
    const e = aggregate().evidence!, database = db();
    expect(await writeArkansasOutsideEvidence({ db: database as never, link: achor, linkId: id(900), syncedAt: new Date("2026-10-11T00:00:00Z"),
      prior: null, incoming: [e] })).toMatchObject({ groupsWritten: 1 });
    const calls = database.query.mock.calls;
    expect(calls.some(([sql]) => /DELETE|outside_support_total|outside_oppose_total/.test(sql))).toBe(false);
    const insert = calls.find(([sql]) => sql.includes("INSERT INTO"))!;
    expect(JSON.parse(String(insert[1]?.[2]))).toEqual([{ filing_entity_id: "1085", filer_name: "NRA", support_oppose: "support", amount: 145.47, source_url: e.sourceUrl }]);
  });
  it("preserves groups without valid matching legacy authority and performs no writes", async () => {
    const database = db([{ filing_entity_id: "1085", filer_name: "Legacy", support_oppose: "support", amount: "145.47" }]);
    expect(await writeArkansasOutsideEvidence({ db: database as never, link: achor, linkId: id(900), syncedAt: new Date(), prior: null,
      incoming: [aggregate().evidence!] })).toMatchObject({ groupsWritten: 0 });
    expect(database.query.mock.calls.some(([sql]) => /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
  it("propagates DB failures for enclosing transaction rollback", async () => {
    const database = db([], true);
    await expect(writeArkansasOutsideEvidence({ db: database as never, link: achor, linkId: id(900), syncedAt: new Date(),
      prior: null, incoming: [aggregate().evidence!] })).rejects.toThrow("DB insert failure");
    expect(database.query.mock.calls.some(([sql]) => sql.includes("SET outside_report_provenance"))).toBe(false);
  });
  it("rejects repeated economic expense GUID across annual registration scopes without any DB write", async () => {
    const e = aggregate().evidence!, other = { ...e, payer: { ...e.payer, registrationGuid: id(1090) }, sourceUrl: e.sourceUrl.replace(id(1085), id(1090)) };
    const database = db();
    expect(await writeArkansasOutsideEvidence({ db: database as never, link: achor, linkId: id(900), syncedAt: new Date(),
      prior: null, incoming: [e, other] })).toMatchObject({ groupsWritten: 0 });
    expect(database.query).not.toHaveBeenCalled();
  });
  it("updates only accepted different-payer groups and retains failed payer source authority", async () => {
    const e = aggregate().evidence!, p = proof();
    p.expenseRows = p.expenseRows.map(r => r.guid === id(14) ? { ...r, nativeFingerprint: h("c") } : r);
    const accepted = { ...e, payer: { ...e.payer, registrationGuid: id(1090), entityId: "1090" }, sourceUrl: e.sourceUrl.replace(id(1085), id(1090)) };
    const database = db([{ filing_entity_id: "1085", filer_name: "NRA", support_oppose: "support", amount: "145.47" }]);
    expect(await writeArkansasOutsideEvidence({ db: database as never, link: achor, linkId: id(900), syncedAt: new Date(),
      prior: prior([e]), incoming: [aggregate(achor, p).evidence!, accepted] })).toMatchObject({ groupsWritten: 1 });
    const insert = database.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO"))!;
    expect(JSON.parse(String(insert[1]?.[2])).map((g: { filing_entity_id: string }) => g.filing_entity_id)).toEqual(["1090"]);
    const update = database.query.mock.calls.find(([sql]) => sql.includes("SET outside_report_provenance"))!;
    expect(JSON.parse(String(update[1]?.[2])).evidence).toEqual([e, accepted]);
  });
  it("does not refresh old groups when all incoming source identities fail original continuity", async () => {
    const e = aggregate().evidence!, p = proof();
    p.expenseRows = p.expenseRows.map(r => r.guid === id(14) ? { ...r, nativeFingerprint: h("c") } : r);
    const database = db([{ filing_entity_id: "1085", filer_name: "NRA", support_oppose: "support", amount: "145.47" }]);
    expect(await writeArkansasOutsideEvidence({ db: database as never, link: achor, linkId: id(900), syncedAt: new Date(),
      prior: prior([e]), incoming: [aggregate(achor, p).evidence!] })).toMatchObject({ groupsWritten: 0 });
    expect(database.query.mock.calls.some(([sql]) => /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
});

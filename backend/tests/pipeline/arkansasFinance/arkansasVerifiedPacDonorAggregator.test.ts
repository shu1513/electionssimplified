import { describe, expect, it } from "vitest";
import { aggregateArkansasVerifiedPacDonors } from "../../../src/pipeline/arkansasFinance/arkansasVerifiedPacDonorAggregator.js";
import { validateArkansasPacSnapshot, validateArkansasPacSourceProvenance } from "../../../src/pipeline/arkansasFinance/arkansasPacSourceEvidence.js";
import { fingerprintArkansasVerifiedRawRows, type ArkansasVerifiedRegistryRow, type ArkansasVerifiedCollection } from "../../../src/pipeline/arkansasFinance/arkansasVerifiedSourceClient.js";
import type { ArkansasVerifiedCurrentCashProof, ArkansasVerifiedCashOccurrence } from "../../../src/pipeline/arkansasFinance/arkansasCurrentOriginalFinancialSource.js";
import type { ArkansasFinanceLinkInput } from "../../../src/pipeline/arkansasFinance/arkansasFinanceWriter.js";
const hash = (n = "a") => n.repeat(64);
const guid = (n: number) => "00000000-0000-0000-0000-" + String(n).padStart(12, "0");
const link: ArkansasFinanceLinkInput = {
  candidateId: guid(100), electionId: guid(101), electionYear: 2026, filingEntityId: 7243,
  filerName: "Clark, Alan", candidateNameNormalized: "Alan Clark", officeName: "State Senator", district: "7",
};
function receipt(n = 1, overrides: Partial<ArkansasVerifiedCashOccurrence> = {}): ArkansasVerifiedCashOccurrence {
  return { guid: guid(n), reportGuid: guid(200), reportedName: "Example PAC", reportedAddress: "Full source address",
    transactionDate: "2026-04-22", amountCents: 50000, transactionSource: "Political Action Committee",
    transactionSubTypeDescription: "Itemized Monetary", nativeFingerprint: hash(), transactionId: n,
    transactionVersionId: 1, transactionTypeCode: "TCON", transactionSubTypeCode: "ITMY",
    transactionSourceTypeCode: "TPAC", sourceElectionYear: 2026, electionTypeCode: "PRMELEC",
    detailFingerprint: hash("b"), ...overrides };
}
function proof(rows = [receipt()]): ArkansasVerifiedCurrentCashProof {
  return { version: 1, receiver: { entityId: "7243", registrationGuid: guid(300), sourceName: "Clark, Alan",
    electionYear: 2026, officeName: "State Senate", district: "7" },
    windowStart: "2025-01-01", windowEnd: "2026-08-31", monetaryCashCents: rows.reduce((a, r) => a + r.amountCents, 0),
    reports: [{ reportGuid: guid(200), reportVersion: 1, reportName: "2026 April Monthly Report",
      periodStart: "2026-03-04", periodEnd: "2026-04-30", filedAtRaw: "2026-05-19T10:50:12.1234567",
      filePath: "Reports\\" + guid(900) + ".pdf", pdfSha256: hash("c"), reportFingerprint: hash("d"),
      returnedCashCents: 0, returnProof: "explicit_section19_zero" }],
    cashRows: rows, sourceFingerprints: { reportsBefore: hash("e"), reportsAfter: hash("e"),
      nativeBefore: hash("f"), nativeAfter: hash("f") }, rawResponseHashes: [hash()] };
}
function row(n = 700, overrides: Partial<ArkansasVerifiedRegistryRow> = {}): ArkansasVerifiedRegistryRow {
  return { registrationGuid: guid(n), filerEntityId: n, filerEntityVersionId: 1, filerType: "Political Action Committee",
    filerTypeCode: "PAC", filerStatus: "Active", filerName: "Example PAC", committeeName: "Example PAC",
    firstName: null, lastName: null, suffix: null, office: null, officeDistrictName: null, jurisdictionName: null,
    politicalParty: null, electionYear: null, filingYear: 2026, isPaperFiler: false, totalRaised: 0, totalSpent: 0,
    balanceOfFunds: 0, rawFields: {}, ...overrides };
}
function registry(rows = [row()]): ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow> {
  rows = rows.map(r => ({ ...r, rawFields: { guid: r.registrationGuid, filerEntityID: r.filerEntityId,
    filerType: r.filerType, filerTypeCode: r.filerTypeCode, filerStatus: r.filerStatus, filerName: r.filerName,
    committeeName: r.committeeName, isPaperFiler: r.isPaperFiler, totalRows: rows.length } }));
  return { rows, complete: true, totalItems: rows.length, fingerprint: fingerprintArkansasVerifiedRawRows(rows),
    requests: [{ url: "https://api-ethics-disclosures.sos.arkansas.gov/api/PublicFilerDetails/GetCandidateCommitteDetails",
      method: "POST", requestBody: { pageNumber: 1, pageSize: 1000 }, status: 200, bytes: 300,
      sha256: hash(), contentType: "application/json", startedAt: "2026-10-11T00:00:00Z", endedAt: "2026-10-11T00:00:01Z" }] };
}
function aggregate(p = proof(), r = registry(), prior?: unknown) {
  return aggregateArkansasVerifiedPacDonors({ link, financialEvidence: p, registryBefore: r, registryAfter: r, priorPacSourceProvenance: prior });
}
function preserved(result: ReturnType<typeof aggregate>, pattern?: RegExp) {
  expect(result.pacDonors).toBeUndefined(); expect(result.pacSourceProvenance).toBeUndefined();
  expect(result.diagnostics.join(" ")).toMatch(pattern ?? /PAC preserved/);
}
function nonPac(n = 2): ArkansasVerifiedCashOccurrence {
  const r = receipt(n, { reportedName: "Example PAC", transactionSource: "Business/Organization/Unlisted PAC" });
  delete r.transactionId; delete r.transactionVersionId; delete r.detailFingerprint;
  delete r.transactionTypeCode; delete r.transactionSubTypeCode; delete r.transactionSourceTypeCode;
  return r;
}

describe("Arkansas complete verified PAC cash grouping", () => {
  it("binds Clark source comma display to local full owner without changing donor matching", () => {
    const r = registry();
    expect(aggregateArkansasVerifiedPacDonors({ link: { ...link, filerName: "Alan Clark" }, financialEvidence: proof(), registryBefore: r, registryAfter: r }).pacDonors).toHaveLength(1);
    const p = proof(); p.receiver.sourceName = "Clark Jr, Alan Dewey";
    expect(aggregateArkansasVerifiedPacDonors({ link: { ...link, filerName: "Alan Dewey Clark Jr" }, financialEvidence: p, registryBefore: r, registryAfter: r }).pacDonors).toHaveLength(1);
    preserved(aggregateArkansasVerifiedPacDonors({ link: { ...link, filerName: "Alan Clark Jr" }, financialEvidence: p, registryBefore: r, registryAfter: r }), /receiver mismatch/);
    expect(aggregate(proof([receipt(1, { reportedName: "PAC, Example" })])).pacDonors?.[0].committeeId).toBe("reported:PAC EXAMPLE");
  });
  it("uses a unique exact legal PAC and keeps source cash separate from PAC totals", () => {
    const result = aggregate(proof([receipt(), nonPac()]));
    expect(result.pacDonors).toEqual([{ committeeId: "700", committeeName: "Example PAC",
      committeeType: "Political Action Committee", amount: 500, contributionCount: 1,
      sourceUrl: "https://ethics-disclosures.sos.arkansas.gov/public/cf/candidateprofile?guid=" + guid(300) + "&tabName=TCON" }]);
    expect(result.pacSourceProvenance?.monetaryCashCents).toBe(100000);
    expect(result.pacSourceProvenance?.pacCashCents).toBe(50000);
    expect(result.pacSourceProvenance?.cashRows).toHaveLength(2);
    expect(result.pacSourceProvenance?.cashRows[0]).not.toHaveProperty("reportedAddress");
  });
  it("binds exact supported local office and district number at persistence boundary", () => {
    const result = aggregate(), p = result.pacSourceProvenance!;
    expect(validateArkansasPacSourceProvenance(p, { ...link, district: "State Senate District 07 (2024); Arkansas" })).toEqual(p);
    expect(() => validateArkansasPacSourceProvenance(p, { ...link, district: "8" })).toThrow(/district mismatch/);
    expect(() => validateArkansasPacSourceProvenance(p, { ...link, district: null })).toThrow(/district mismatch/);
    expect(() => validateArkansasPacSourceProvenance(p, { ...link, officeName: "State Lower Chamber Legislator" })).toThrow(/office mismatch/);
    expect(() => validateArkansasPacSourceProvenance(p, { ...link, officeName: "Mayor" })).toThrow(/office mismatch/);
  });
  it("keeps equal distinct source gifts, even on the same day", () => {
    const result = aggregate(proof([receipt(), receipt(2)]));
    expect(result.pacDonors?.[0]).toMatchObject({ amount: 1000, contributionCount: 2 });
    expect(result.pacSourceProvenance?.groups[0].receiptGuids).toEqual([guid(1), guid(2)]);
  });
  it("retains unmatched exact TPAC name as reported group", () => {
    const result = aggregate(proof([receipt(1, { reportedName: "WSG Arkansas" })]));
    expect(result.pacDonors?.[0]).toMatchObject({ committeeId: "reported:WSG ARKANSAS", committeeName: "WSG Arkansas", amount: 500 });
  });
  it("does not remove words or reverse name order when matching", () => {
    expect(aggregate(proof([receipt(1, { reportedName: "Elect Example PAC" })])).pacDonors?.[0].committeeId).toBe("reported:ELECT EXAMPLE PAC");
    expect(aggregate(proof([receipt(1, { reportedName: "PAC Example" })])).pacDonors?.[0].committeeId).toBe("reported:PAC EXAMPLE");
  });
  it("preserves differing raw fallback names with the same normalized key", () => {
    preserved(aggregate(proof([receipt(1, { reportedName: "WSG-Arkansas" }), receipt(2, { reportedName: "WSG Arkansas" })])), /reported-name collision/);
  });
  it("counts repeated identical fallback labels separately", () => {
    expect(aggregate(proof([receipt(1, { reportedName: "WSG Arkansas" }), receipt(2, { reportedName: "WSG Arkansas" })])).pacDonors?.[0])
      .toMatchObject({ contributionCount: 2, amount: 1000 });
  });
  it("does not promote PAC-named business or person cash", () => {
    const result = aggregate(proof([nonPac()]));
    expect(result.pacDonors).toEqual([]); expect(result.pacSourceProvenance?.pacCashCents).toBe(0);
    expect(result.pacSourceProvenance?.monetaryCashCents).toBe(50000);
  });
  it("keeps explicitly nonitemized cash in complete proof without inventing PAC class", () => {
    const r = nonPac(); r.reportedName = ""; r.transactionSource = ""; r.transactionSubTypeDescription = "Non-Itemized Monetary";
    const result = aggregate(proof([r]));
    expect(result.pacDonors).toEqual([]); expect(result.pacSourceProvenance?.monetaryCashCents).toBe(50000);
  });
  it("preserves unknown future source class rather than publishing false empty PAC", () => {
    const r = nonPac(); r.transactionSource = "New Committee Class"; preserved(aggregate(proof([r])), /unknown cash source class/);
  });
  it("collapses annual registrations only for consistent legal identity, retaining null paper rows", () => {
    const r = registry([row(), row(700, { registrationGuid: guid(701), filingYear: 2024, isPaperFiler: null, filerStatus: "Inactive" })]);
    expect(aggregate(proof(), r).pacDonors?.[0].committeeId).toBe("700");
  });
  it.each([
    ["other entity", row(701)],
    ["same entity excluded class", row(700, { registrationGuid: guid(701), filerTypeCode: "CAN", filerType: "Candidate" })],
    ["inactive excluded entity", row(701, { filerStatus: "Inactive", filerTypeCode: "CPAC", filerType: "County Political Party Committee", isPaperFiler: null })],
  ])("preserves name collision across %s", (_label, extra) => {
    preserved(aggregate(proof(), registry([row(), extra as ArkansasVerifiedRegistryRow])));
  });
  it.each([
    ["CAN", "Candidate"], ["CPAC", "County Political Party Committee"], ["PP", "Political Party"], ["IEF", "Committee"],
  ])("does not fall back after a unique excluded legal %s match", (code, type) => {
    preserved(aggregate(proof(), registry([row(700, { filerTypeCode: code, filerType: type })])), /excluded legal class/);
  });
  it("preserves same-entity conflicting annual legal names", () => {
    preserved(aggregate(proof(), registry([row(), row(700, { registrationGuid: guid(701), committeeName: "Changed PAC", filerName: "Changed PAC" })])), /legal class\/name/);
  });
  it("preserves self identity or receiving full-name fallback", () => {
    preserved(aggregate(proof(), registry([row(7243)])), /self/);
    preserved(aggregate(proof([receipt(1, { reportedName: "Clark, Alan" })])), /self/);
  });
  it("preserves the entire component when one source-typed name is absent", () => {
    preserved(aggregate(proof([receipt(), receipt(2, { reportedName: "" })])), /missing/);
  });
  it("requires typed PAC details and excludes contradictory detail class", () => {
    preserved(aggregate(proof([receipt(1, { transactionId: undefined })])), /transaction ID/);
    preserved(aggregate(proof([receipt(1, { transactionSourceTypeCode: "TIND" })])), /typed PAC/);
    preserved(aggregate(proof([nonPac(1), receipt(2, { transactionSource: "Individual" })])), /contradictory/);
  });
  it.each([0, -50000, 50000.1, Number.MAX_SAFE_INTEGER + 1])("preserves invalid cash cents %s", amountCents => {
    preserved(aggregate(proof([receipt(1, { amountCents })])));
  });
  it("rejects duplicate cash GUIDs and repeated numeric transaction IDs", () => {
    preserved(aggregate(proof([receipt(), receipt()])), /duplicate cash/);
    preserved(aggregate(proof([receipt(), receipt(2, { transactionId: 1 })])), /transaction ID/);
  });
  it("requires complete stable full-registry requests and typed/raw fingerprint binding", () => {
    const r = registry(); r.requests[0]!.requestBody = { pageNumber: 1, pageSize: 1000, filerTypeCode: "PAC" };
    preserved(aggregate(proof(), r), /request scope/);
    const changed = registry(); changed.rows[0]!.filerEntityId = 999;
    preserved(aggregate(proof(), changed), /typed\/raw/);
    const before = registry(), after = registry([row(700, { filerStatus: "Inactive" })]);
    preserved(aggregateArkansasVerifiedPacDonors({ link, financialEvidence: proof(), registryBefore: before, registryAfter: after }), /generation changed/);
  });
  it("requires receiver identity, explicit original return proof, and stable source brackets", () => {
    const p = proof(); p.receiver.entityId = "99"; preserved(aggregate(p), /receiver mismatch/);
    const amended = proof(); amended.reports = [{ ...amended.reports[0]!, reportVersion: 2 } as never]; preserved(aggregate(amended), /original\/return/);
    const returns = proof(); returns.reports = [{ ...returns.reports[0]!, returnedCashCents: 1 } as never]; preserved(aggregate(returns), /original\/return/);
    const changed = proof(); changed.sourceFingerprints.nativeAfter = hash("b"); preserved(aggregate(changed), /generation changed/);
  });
});

describe("Arkansas prior original authority and persistence contract", () => {
  it("treats null prior authority as absent", () => { expect(aggregate(proof(), registry(), null).pacDonors).toHaveLength(1); });
  it("rejects malformed prior without accepting partial PAC", () => { preserved(aggregate(proof(), registry(), {}), /unsupported/); });
  it("preserves disappeared source receipts even when another receipt keeps totals equal", () => {
    const prior = aggregate().pacSourceProvenance;
    preserved(aggregate(proof([receipt(2)]), registry(), prior), /receipt disappeared/);
  });
  it("preserves same-GUID source identity changes with equal money", () => {
    const prior = aggregate().pacSourceProvenance;
    preserved(aggregate(proof([receipt(1, { nativeFingerprint: hash("c") })]), registry(), prior), /receipt disappeared or changed/);
    preserved(aggregate(proof([receipt(1, { detailFingerprint: hash("c") })]), registry(), prior), /receipt disappeared or changed/);
  });
  it("preserves replacement PDF/report identity with unchanged cash", () => {
    const prior = aggregate().pacSourceProvenance, p = proof();
    p.reports = [{ ...p.reports[0]!, pdfSha256: hash("b") }];
    preserved(aggregate(p, registry(), prior), /report disappeared or changed/);
  });
  it("permits append-only newly verified original reports and distinct receipts", () => {
    const prior = aggregate().pacSourceProvenance, p = proof([receipt(), receipt(2, { reportGuid: guid(201), transactionDate: "2026-05-10" })]);
    p.reports = [...p.reports, { ...p.reports[0]!, reportGuid: guid(201), periodStart: "2026-05-01", periodEnd: "2026-05-31",
      filedAtRaw: "2026-06-05T12:00:00", pdfSha256: hash("b"), reportFingerprint: hash("a") }];
    expect(aggregate(p, registry(), prior).pacDonors?.[0]).toMatchObject({ amount: 1000, contributionCount: 2 });
  });
  it("retains prior identity after JSONB removes optional undefined fields", () => {
    const r = nonPac(); r.transactionId = undefined; r.electionTypeCode = undefined;
    const p = proof([receipt(), r]);
    const prior = JSON.parse(JSON.stringify(aggregate(p).pacSourceProvenance));
    expect(aggregate(p, registry(), prior).pacDonors).toHaveLength(1);
  });
  it("permits irrelevant registry generation evolution but not legal identity reassignment", () => {
    const prior = aggregate().pacSourceProvenance;
    expect(aggregate(proof(), registry([row(), row(701, { committeeName: "Other PAC", filerName: "Other PAC" })]), prior).pacDonors).toHaveLength(1);
    preserved(aggregate(proof(), registry([row(701)]), prior), /identity reassigned/);
  });
  it("permits explicit zero only with complete cash/report authority and prevents deleting prior cash", () => {
    const empty = aggregate(proof([])); expect(empty.pacDonors).toEqual([]); expect(empty.pacSourceProvenance?.reports).toHaveLength(1);
    preserved(aggregate(proof([]), registry(), aggregate().pacSourceProvenance), /receipt disappeared/);
  });
  it("preserves changes to non-PAC complete cash identities even with identical PAC money", () => {
    const prior = aggregate(proof([receipt(), nonPac()])).pacSourceProvenance;
    preserved(aggregate(proof(), registry(), prior), /receipt disappeared/);
    preserved(aggregate(proof([receipt(), { ...nonPac(), nativeFingerprint: hash("d") }]), registry(), prior), /receipt disappeared or changed/);
  });
  it("rejects self reported groups at the persistence boundary", () => {
    const p = aggregate().pacSourceProvenance!;
    const self = { ...p, cashRows: [{ ...p.cashRows[0]!, reportedName: "Clark, Alan" }],
      groups: [{ ...p.groups[0]!, committeeId: "reported:CLARK ALAN", committeeName: "Clark, Alan" }] };
    expect(() => validateArkansasPacSourceProvenance(self, link)).toThrow(/self/);
  });
  it("validates stored money/counts/references and exact receiver source URL", () => {
    const result = aggregate(), p = result.pacSourceProvenance!;
    expect(validateArkansasPacSnapshot({ link, pacDonors: result.pacDonors!, pacSourceProvenance: JSON.parse(JSON.stringify(p)) })).toEqual(p);
    expect(() => validateArkansasPacSnapshot({ link, pacDonors: [{ ...result.pacDonors![0]!, amount: 500.0000000001 }], pacSourceProvenance: p })).toThrow(/snapshot donor/);
    expect(() => validateArkansasPacSourceProvenance({ ...p, sourceUrl: "https://example.org/" }, link)).toThrow(/source URL/);
    expect(() => validateArkansasPacSourceProvenance({ ...p, groups: [{ ...p.groups[0]!, contributionCount: 2 }] })).toThrow(/count mismatch/);
    expect(() => validateArkansasPacSourceProvenance({ ...p, groups: [{ ...p.groups[0]!, receiptGuids: [guid(999)] }] })).toThrow(/receipt reference/);
  });
});

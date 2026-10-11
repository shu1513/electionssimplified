import { describe, expect, it } from "vitest";
import { resolveTennesseeVerifiedCandidateContext, verifyTennesseeOutsideReport, type TennesseeOutsideReportVerificationInput } from "../../../src/pipeline/tennesseeFinance/tennesseeVerifiedOutsideEvidence.js";
import type { TennesseeNativeResult } from "../../../src/pipeline/tennesseeFinance/tennesseeVerifiedNativeClient.js";

// Synthetic complete inputs test policy; they are not live filing evidence.
const hash = (letter = "a") => letter.repeat(64);
function result<T>(rows: T[], query: Record<string,string>): TennesseeNativeResult<T> {
  return { rows,query,fingerprint: hash(),sourceUrl: "https://apps.tn.gov/tncamp/public/cesearch.htm",
    declaredCount: rows.length,complete: true,requests: [],chunks: [] };
}
function fixture(): TennesseeOutsideReportVerificationInput {
  const row = { campId: "136",ownerName: "Synthetic payer",reportId: "128190",electionYear: null,
    reportName: "Pre-Primary 2026",reportYear: 2026,amended: false,submittedDate: "2026-07-29",
    sourceUrl: "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=128190" };
  const candidate = result([{ campId: "794",name: "DOE, JANE",officeSought: "Senate",district: "03",electionYear: 2026,
    ownerName: "DOE, JANE",committeeAffiliation: "",created: "2024-01-01",closed: null,
    reportListUrl: "https://apps.tn.gov/tncamp/public/replist.htm?id=794&owner=DOE%2C+JANE",rawFields: {} }],
  { searchType: "candidate",name: "DOE",electionYearSelection: "234" });
  const registry = result([{ campId: "136",ownerName: row.ownerName,name: row.ownerName,committeeType: "PAC" as const,
    committeeAffiliation: "",created: "2020-01-01",closed: null,reportListUrl: "https://apps.tn.gov/tncamp/public/replist.htm?id=136&owner=Synthetic+payer",rawFields: {} }],{ searchType: "pac" });
  const manifest = { rows: [row],fingerprint: hash(),rawPages: [{ url: registry.rows[0]!.reportListUrl,
    bytes: new Uint8Array(),byteCount: 0,sha256: hash(),encoding: "utf-8" as const }] };
  const report = { manifestRow: row,heading: "Synthetic",reportedOwnerName: row.ownerName,
    period: { start: "2026-07-01",end: "2026-07-27",sourceUrl: "https://www.tn.gov/calendar.pdf",sourceContext: "Synthetic qualified interval" },
    covers: [],schedules: [],cashLedger: [],expenseLedger: [{ occurrence: 1,vendorName: "Vendor",publishedIdentityLines: ["Vendor","100 MAIN ST","NASHVILLE, TN, 37201"],
      sourceClass: "" as const,purpose: "CONTRIBUTION",inKind: null,independentTargetName: "DOE, JANE",supportOppose: "S" as const,date: "2026-07-27",amountCents: 591062,rawCells: [] }],
    rawSource: { url: row.sourceUrl,bytes: new Uint8Array(),byteCount: 0,sha256: hash(),encoding: "utf-8" as const },fingerprint: hash(),completeFullReport: true as const };
  const ie = result([{ occurrence: 0,reportId: row.reportId,reportUrl: row.sourceUrl,type: "Independent" as const,adjustment: "N",
    amountCents: 591062,date: "2026-07-27",electionYear: null,reportName: "Pre-Primary",payerName: row.ownerName,
    vendorName: "Vendor",vendorAddress: "100 MAIN ST, NASHVILLE , TN, 37201",vendorAddressLines: ["100 MAIN ST","NASHVILLE , TN, 37201"],purpose: "CONTRIBUTION",targetName: "DOE, JANE",supportOpposeCode: "S" as const,rawFields: {} }],
  { typeOf: "independent",yearSelection: "2026" });
  return structuredClone({ link: { candidateId: "local-candidate",electionId: "local-election",electionYear: 2026,
    candidateNameNormalized: "JANE DOE",officeName: "State Senator",district: "3",campCandidateId: "794",ownerName: "DOE, JANE" },
    candidateContextBefore: candidate,candidateContextAfter: structuredClone(candidate),registryBefore: registry,registryAfter: structuredClone(registry),
    manifestBefore: manifest,manifestAfter: structuredClone(manifest),reportBefore: report,reportAfter: structuredClone(report),
    nativeBefore: [result([],{ typeOf: "independent",yearSelection: "2024" }),result([],{ typeOf: "independent",yearSelection: "2025" }),ie],
    nativeAfter: [result([],{ typeOf: "independent",yearSelection: "2024" }),result([],{ typeOf: "independent",yearSelection: "2025" }),structuredClone(ie)] });
}

describe("Tennessee current ordinary outside verification", () => {
  it("accepts exact contextual evidence, retaining blank native year and contribution purpose", () => {
    const input = fixture();
    expect(verifyTennesseeOutsideReport(input)).toMatchObject({ diagnostics: [],evidence: {
      payerCampId: "136",reportId: "128190",occurrences: [{ targetCampId: "794",reportedTargetName: "DOE, JANE",
        resolutionMethod: "contextual_exact_name",amountCents: 591062,supportOppose: "support" }] } });
    expect(resolveTennesseeVerifiedCandidateContext({ link: input.link,nativeContext: input.candidateContextBefore,
      reportedTargetName: "Jane Doe" })?.campCandidateId).toBe("794");
  });
  it.each([
    ["State Lower Chamber Legislator", "House of Representatives"],
    ["State Lower Chamber Legislator", "House"],
    ["State Representative", "House of Representatives"],
    ["Governor", "Governor"],
  ])("accepts the stored link office %s against the CAMP label %s", (officeName, officeSought) => {
    const input = fixture();
    const district = officeName === "Governor" ? "" : "51";
    input.link.officeName = officeName; input.link.district = district || null;
    for (const context of [input.candidateContextBefore, input.candidateContextAfter]) {
      context.rows[0]!.officeSought = officeSought; context.rows[0]!.district = district;
    }
    expect(verifyTennesseeOutsideReport(input).evidence?.occurrences).toHaveLength(1);
    input.candidateContextBefore.rows[0]!.officeSought = officeName === "Governor" ? "Senate" : "Governor";
    expect(verifyTennesseeOutsideReport(input).evidence).toBeUndefined();
  });
  it("compares all report targets before allocating only this candidate, retaining equal occurrences", () => {
    const input = fixture();
    const native = input.nativeBefore[2]!, closing = input.nativeAfter[2]!;
    const extraNative = { ...native.rows[0]!,occurrence: 1,targetName: "OTHER, CANDIDATE",amountCents: 10000 };
    native.rows.push(extraNative,{ ...native.rows[0]!,occurrence: 2 }); closing.rows = structuredClone(native.rows);
    native.declaredCount = closing.declaredCount = 3;
    const report = input.reportBefore;
    report.expenseLedger.push({ ...report.expenseLedger[0]!,occurrence: 2,independentTargetName: extraNative.targetName,amountCents: 10000 },
      { ...report.expenseLedger[0]!,occurrence: 3 }); input.reportAfter = structuredClone(report);
    const verified = verifyTennesseeOutsideReport(input);
    expect(verified.evidence?.occurrences).toHaveLength(2);
    input.nativeBefore[2]!.rows[1]!.amountCents = 10001;
    expect(verifyTennesseeOutsideReport(input).diagnostics.join(" ")).toContain("whole-report");
  });
  it("a separately closed empty current report yields report authority, not a candidate total zero", () => {
    const input = fixture();
    input.reportBefore.expenseLedger = input.reportAfter.expenseLedger = [];
    input.nativeBefore[2]!.rows = input.nativeAfter[2]!.rows = [];
    input.nativeBefore[2]!.declaredCount = input.nativeAfter[2]!.declaredCount = 0;
    expect(verifyTennesseeOutsideReport(input).evidence?.occurrences).toEqual([]);
  });
  it("retains native-only Address2 while comparing published street/city identity", () => {
    const input = fixture();
    input.nativeBefore[2]!.rows[0]!.vendorAddressLines!.splice(1,0,"SUITE 1400");
    input.nativeAfter[2]!.rows = structuredClone(input.nativeBefore[2]!.rows);
    input.reportBefore.expenseLedger[0]!.publishedIdentityLines[2] = "NASHVILLE , TN 37201";
    input.reportAfter = structuredClone(input.reportBefore);
    expect(verifyTennesseeOutsideReport(input).evidence).toBeDefined();
    input.nativeBefore[2]!.rows[0]!.vendorAddressLines![0] += " SUITE 1400";
    expect(verifyTennesseeOutsideReport(input).evidence).toBeUndefined();
  });
  it.each([
    ["context generation", (x: TennesseeOutsideReportVerificationInput) => { x.candidateContextAfter.fingerprint = hash("b"); }],
    ["context office ambiguity", (x: TennesseeOutsideReportVerificationInput) => { x.candidateContextBefore.rows.push({ ...x.candidateContextBefore.rows[0]!,campId: "795",officeSought: "House" });x.candidateContextBefore.declaredCount++; }],
    ["context district", (x: TennesseeOutsideReportVerificationInput) => { x.link.district = "4"; }],
    ["wrong local candidate", (x: TennesseeOutsideReportVerificationInput) => { x.link.candidateNameNormalized = "JAMES ROE"; }],
    ["context closed", (x: TennesseeOutsideReportVerificationInput) => { x.candidateContextBefore.rows[0]!.closed = "2026-07-01"; }],
    ["registry generation", (x: TennesseeOutsideReportVerificationInput) => { x.registryAfter.fingerprint = hash("b"); }],
    ["registry identity", (x: TennesseeOutsideReportVerificationInput) => { x.registryBefore.rows[0]!.ownerName = "Wrong payer"; }],
    ["manifest generation", (x: TennesseeOutsideReportVerificationInput) => { x.manifestAfter.fingerprint = hash("b"); }],
    ["competing current versions", (x: TennesseeOutsideReportVerificationInput) => { x.manifestBefore.rows.push({ ...x.manifestBefore.rows[0]!,reportId: "128191" }); }],
    ["full body generation", (x: TennesseeOutsideReportVerificationInput) => { x.reportAfter.fingerprint = hash("b"); }],
    ["unknown period", (x: TennesseeOutsideReportVerificationInput) => { x.reportBefore.period = null; }],
    ["changed period", (x: TennesseeOutsideReportVerificationInput) => { x.reportAfter.period!.start = "2026-07-02"; }],
    ["partial native", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.complete = false as true; }],
    ["missing boundary year", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore.shift(); }],
    ["native election filter", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.query.electionYearSelection = "234"; }],
    ["native changed", (x: TennesseeOutsideReportVerificationInput) => { x.nativeAfter[2]!.fingerprint = hash("b"); }],
    ["native wrong payer", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.payerName = "Wrong payer"; }],
    ["native adjustment", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.adjustment = "Y"; }],
    ["native wrong year", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.electionYear = 2024; }],
    ["missing native address lines", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.vendorAddressLines = undefined; }],
    ["unknown native address layout", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.vendorAddressLines = ["UNKNOWN"]; }],
    ["changed embedded suite", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.vendorAddressLines![0] += " SUITE 2"; }],
    ["wrong native report name", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.reportName = "2nd Quarter"; }],
    ["native outside interval", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.date = "2026-07-28"; }],
    ["unresolved in-kind", (x: TennesseeOutsideReportVerificationInput) => { x.reportBefore.expenseLedger[0]!.inKind = "Y"; }],
    ["unknown direction", (x: TennesseeOutsideReportVerificationInput) => { x.reportBefore.expenseLedger[0]!.supportOppose = ""; }],
    ["negative amount", (x: TennesseeOutsideReportVerificationInput) => { x.reportBefore.expenseLedger[0]!.amountCents = -1; }],
    ["unexplained vendor", (x: TennesseeOutsideReportVerificationInput) => { x.nativeBefore[2]!.rows[0]!.vendorName = "Other vendor"; }],
  ])("preserves unavailable %s", (_label, change) => {
    const input = fixture();change(input);
    const checked = verifyTennesseeOutsideReport(input);
    expect(checked.evidence).toBeUndefined();expect(checked.diagnostics).not.toEqual([]);
  });
});

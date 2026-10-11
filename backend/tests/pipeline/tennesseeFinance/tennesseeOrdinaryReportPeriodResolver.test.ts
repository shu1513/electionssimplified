import { describe, expect, it } from "vitest";
import {
  resolveTennesseeOrdinaryReportPeriod,
  resolveTennesseeOrdinaryReportPeriodEnd,
  type TennesseeOrdinaryReportPeriodInput,
  type TennesseeOrdinaryReportPeriodContext,
} from "../../../src/pipeline/tennesseeFinance/tennesseeOrdinaryReportPeriodResolver.js";

const candidate: TennesseeOrdinaryReportPeriodContext = {
  filerType: "candidate", candidateElectionYear: 2026,
  electionSchedule: "august-primary-november-general",
  participatesInAugustPrimary: true, participatesInNovemberGeneral: true,
};
function input(label: string, reportYear: number, start: string,
  options: { reportId?: string; previousReportId?: string; pac?: boolean } = {}): TennesseeOrdinaryReportPeriodInput {
  const reportId = options.reportId ?? "128008";
  const priorEnd = new Date(Date.parse(start + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  return {
    manifestRow: { campId: options.pac ? "136" : "794",
      ownerName: options.pac ? "TMA PAC" : "CROWE, RUSTY", reportId,
      electionYear: options.pac ? null : 2026, reportName: label, reportYear,
      amended: false, submittedDate: "2026-07-30",
      sourceUrl: "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=" + reportId },
    context: options.pac ? { filerType: "pac" } : candidate,
    continuingReportProof: { reportId, previousReportId: options.previousReportId ?? "126857",
      previousPeriodEnd: priorEnd, completeManifestFingerprint: "a".repeat(64) },
  };
}
describe("Tennessee qualified ordinary period resolver", () => {
  it.each([
    ["120784", "115084", "Early Year End Supplemental 2024", 2024, "2024-07-01", "2025-01-15"],
    ["122149", "120784", "Early Mid Year Supplemental 2025", 2025, "2025-01-16", "2025-06-30"],
    ["123786", "122149", "Early Year End Supplemental 2025", 2025, "2025-07-01", "2026-01-15"],
    ["125419", "123786", "1st Quarter 2026", 2026, "2026-01-16", "2026-03-31"],
    ["126857", "125419", "2nd Quarter 2026", 2026, "2026-04-01", "2026-06-30"],
    ["128008", "126857", "Pre-Primary 2026", 2026, "2026-07-01", "2026-07-27"],
  ] as const)("resolves the reviewed source label %s only with qualified continuity", (id, prior, label, year, start, end) => {
    const result = resolveTennesseeOrdinaryReportPeriod(input(label, year, start, { reportId: id, previousReportId: prior }));
    expect(result).toMatchObject({ start, end });
    expect(result?.sourceUrl).toMatch(/^https:\/\/www\.tn\.gov\/content\/dam\/tn\/tref\/documents\//);
    expect(result?.sourceContext).toContain(prior + " through");
    expect(result?.sourceContext).toContain(id);
    if (label.startsWith("Early")) expect(result?.sourceContext).toContain("tref-candidate-faqs.html");
  });

  it("resolves TMA Pre-Primary without manufacturing a beneficiary election year", () => {
    const value = input("Pre-Primary 2026", 2026, "2026-07-01", { pac: true, reportId: "128190", previousReportId: "126431" });
    const result = resolveTennesseeOrdinaryReportPeriod(value);
    expect(result).toMatchObject({ start: "2026-07-01", end: "2026-07-27" });
    expect(result?.sourceUrl).toContain("2026%20PAC%20Filing%20Dates.pdf");
    expect(value.manifestRow.electionYear).toBeNull();
  });

  it.each([
    { isFirstReport: true }, { continuingReportProof: undefined },
    { continuingReportProof: { reportId: "999", previousReportId: "126857", previousPeriodEnd: "2026-06-30", completeManifestFingerprint: "a".repeat(64) } },
    { continuingReportProof: { reportId: "128008", previousReportId: "128008", previousPeriodEnd: "2026-06-30", completeManifestFingerprint: "a".repeat(64) } },
    { continuingReportProof: { reportId: "128008", previousReportId: "0126857", previousPeriodEnd: "2026-06-30", completeManifestFingerprint: "a".repeat(64) } },
    { continuingReportProof: { reportId: "128008", previousReportId: "126857", previousPeriodEnd: "2026-06-29", completeManifestFingerprint: "a".repeat(64) } },
    { continuingReportProof: { reportId: "128008", previousReportId: "126857", previousPeriodEnd: "2026-06-30", completeManifestFingerprint: "" } },
  ])("keeps unproven per-report continuity unknown %#", changed => {
    expect(resolveTennesseeOrdinaryReportPeriod({ ...input("Pre-Primary 2026", 2026, "2026-07-01"), ...changed })).toBeNull();
  });

  it.each(["may-primary-august-general", "november-general-only"] as const)("does not apply an August-primary interval to %s", electionSchedule => {
    expect(resolveTennesseeOrdinaryReportPeriod({ ...input("2nd Quarter 2026", 2026, "2026-04-01"),
      context: { ...candidate, electionSchedule } })).toBeNull();
  });

  it.each([
    { ...candidate, candidateElectionYear: 2024 },
    { ...candidate, participatesInAugustPrimary: undefined },
    { ...candidate, participatesInAugustPrimary: false },
  ])("requires the exact election/schedule/participation context %#", context => {
    expect(resolveTennesseeOrdinaryReportPeriod({ ...input("Pre-Primary 2026", 2026, "2026-07-01"), context })).toBeNull();
  });

  it("rejects candidate source election mismatch and noncanonical provenance", () => {
    const value = input("1st Quarter 2026", 2026, "2026-01-16");
    for (const changed of [{ electionYear: null }, { electionYear: 2024 }, { campId: "0794" },
      { sourceUrl: value.manifestRow.sourceUrl + "&x=1" }, { sourceUrl: value.manifestRow.sourceUrl.replace("128008", "%31%32%38%30%30%38") }]) {
      expect(resolveTennesseeOrdinaryReportPeriod({ ...value, manifestRow: { ...value.manifestRow, ...changed } })).toBeNull();
    }
  });

  it.each([
    ["Late Year End Supplemental 2025", 2025], ["Early Year End Supplemental 2023", 2023],
    ["Early Year End Supplemental 2025", 2024], ["1st Quarter 2025", 2025],
    ["Pre Primary 2026", 2026], ["Final 2026", 2026],
  ])("preserves unsupported or mismatched source label %s", (label, year) => {
    expect(resolveTennesseeOrdinaryReportPeriod(input(label, year, "2025-07-01"))).toBeNull();
  });

  it("keeps candidate Early and PAC Annual source families separate", () => {
    expect(resolveTennesseeOrdinaryReportPeriod(input("Early Mid Year Supplemental 2025", 2025, "2025-01-16", { pac: true }))).toBeNull();
    expect(resolveTennesseeOrdinaryReportPeriod(input("Annual Mid Year Supplemental 2025", 2025, "2025-01-16"))).toBeNull();
    expect(resolveTennesseeOrdinaryReportPeriod(input("Annual Mid Year Supplemental 2025", 2025, "2025-01-16", { pac: true })))
      .toMatchObject({ start: "2025-01-16", end: "2025-06-30" });
    expect(resolveTennesseeOrdinaryReportPeriod(input("Annual Year End Supplemental 2025", 2025, "2025-07-01", { pac: true })))
      .toMatchObject({ start: "2025-07-01", end: "2026-01-15" });
  });

  it("uses qualified post-primary Q3 and general-participating Q4 boundaries", () => {
    expect(resolveTennesseeOrdinaryReportPeriod(input("3rd Quarter 2026", 2026, "2026-07-28")))
      .toMatchObject({ start: "2026-07-28", end: "2026-09-30" });
    expect(resolveTennesseeOrdinaryReportPeriod(input("Pre-General 2026", 2026, "2026-10-01")))
      .toMatchObject({ start: "2026-10-01", end: "2026-10-24" });
    expect(resolveTennesseeOrdinaryReportPeriod(input("4th Quarter 2026", 2026, "2026-10-25")))
      .toMatchObject({ start: "2026-10-25", end: "2027-01-15" });
    const nonparticipant = { ...input("4th Quarter 2026", 2026, "2026-10-01"),
      context: { ...candidate, participatesInNovemberGeneral: false } };
    expect(resolveTennesseeOrdinaryReportPeriod(nonparticipant)).toMatchObject({ start: "2026-10-01", end: "2027-01-15" });
    for (const kind of ["Pre-General", "4th Quarter"]) {
      expect(resolveTennesseeOrdinaryReportPeriod({ ...input(kind + " 2026", 2026, "2026-10-01"),
        context: { ...candidate, participatesInNovemberGeneral: undefined } })).toBeNull();
    }
    expect(resolveTennesseeOrdinaryReportPeriod(input("4th Quarter 2026", 2026, "2026-10-25", { pac: true })))
      .toMatchObject({ start: "2026-10-25", end: "2027-01-15" });
  });

  it("derives the actual prior2024 MidYear endpoint without inventing an initial start or crawling2023", () => {
    const value = input("Early Mid Year Supplemental 2024", 2024, "2024-01-16",
      { reportId: "115084", previousReportId: "111197" });
    const firstOrUnproven = { ...value, isFirstReport: true, continuingReportProof: undefined };
    expect(resolveTennesseeOrdinaryReportPeriod(firstOrUnproven)).toBeNull();
    const end = resolveTennesseeOrdinaryReportPeriodEnd(firstOrUnproven);
    expect(end).toMatchObject({ end: "2024-06-30" });
    expect(end).not.toHaveProperty("start");
    expect(end?.sourceContext).toContain("first-report start unresolved");
    expect(end?.sourceUrl).toContain("2024%20Open%20Candidate");
    const current = input("Early Year End Supplemental 2024", 2024, "2024-07-01",
      { reportId: "120784", previousReportId: value.manifestRow.reportId });
    current.continuingReportProof!.previousPeriodEnd = end!.end;
    expect(resolveTennesseeOrdinaryReportPeriod(current)).toMatchObject({ start: "2024-07-01", end: "2025-01-15" });
  });

  it("endpoint-only resolution retains exact schedule/label/year qualification gates", () => {
    const value = input("Pre-Primary 2026", 2026, "2026-07-01");
    expect(resolveTennesseeOrdinaryReportPeriodEnd({ ...value, context: { ...candidate, participatesInAugustPrimary: undefined } })).toBeNull();
    expect(resolveTennesseeOrdinaryReportPeriodEnd({ ...value, manifestRow: { ...value.manifestRow, reportYear: 2025 } })).toBeNull();
    expect(resolveTennesseeOrdinaryReportPeriodEnd({ ...value, manifestRow: { ...value.manifestRow, reportName: "Interim 2026" } })).toBeNull();
  });

  it("resolves no financial currentness, modifies no source row and hardcodes no CAMP", () => {
    const value = input("1st Quarter 2026", 2026, "2026-01-16");
    value.manifestRow.campId = "99999";
    value.manifestRow.amended = true;
    const copy = structuredClone(value);
    expect(resolveTennesseeOrdinaryReportPeriod(value)?.sourceContext).toContain("same-CAMP 99999");
    expect(value).toEqual(copy);
  });
});

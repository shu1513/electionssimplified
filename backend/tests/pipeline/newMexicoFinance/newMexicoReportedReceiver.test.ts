import { describe, expect, it } from "vitest";
import {
  nmCanonicalDistrict,
  nmPersonMatches,
  parseNewMexicoNativeCandidate,
  qualifyNewMexicoReceiverDetail,
  qualifyNewMexicoReportedReceiver,
  type NewMexicoReportedReceiver,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedReceiver.js";

const receiver = (): NewMexicoReportedReceiver => ({
  linkId: "synthetic-link",
  candidateId: "synthetic-candidate",
  electionId: "synthetic-election",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingId: "12345",
  legacyCommitteeName: "Synthetic legacy name",
  candidateAliases: ["Avery Quinn Sample", "Avery Sample"],
  officeScope: "statewide",
  officeName: "Governor",
  linkOfficeName: "Governor",
  district: null,
  canonicalDistrictName: "New Mexico",
  canonicalDistrictType: "statewide",
  activeCandidateOwnerCount: 1,
});
const row = () => ({
  IDNumber: "synthetic-native-locator",
  RegistrationId: "synthetic-registration",
  CandidateName: "Sample, Avery Quinn",
  OfficeName: "GOVERNOR",
  ElectionYear: 2026,
  OfficeId: 1,
  ElectionId: 2,
  DistrictId: 0,
  District: null,
});
const detail = () => ({
  CandidateName: "Avery Quinn Sample",
  OfficeName: "GOVERNOR",
  ElectionYear: 2026,
  MemberID: "synthetic-native-member",
  IDNumber: 0,
  OfficeId: 0,
  DistrictId: 0,
  District: null,
});
describe("New Mexico canonical receiving context", () => {
  it("binds native full person/office/year without manufacturing an OrgID bridge", () => {
    const source = parseNewMexicoNativeCandidate(row(), 2026),
      current = receiver();
    expect(qualifyNewMexicoReportedReceiver(current, [source])).toBe(source);
    expect(() =>
      qualifyNewMexicoReceiverDetail(current, source, detail()),
    ).not.toThrow();
    expect(source.locator).not.toBe(current.receivingId);
    expect(detail().IDNumber).toBe(0);
  });
  it.each([
    "middle",
    "suffix",
    "office",
    "year",
    "owner",
    "linkOffice",
    "canonicalState",
    "electionDate",
  ])("holds conflicting %s evidence", (fault) => {
    const current = receiver(),
      native = row();
    if (fault === "middle") native.CandidateName = "Avery Riley Sample";
    if (fault === "suffix") {
      current.candidateAliases = ["Avery Quinn Sample Jr"];
      native.CandidateName = "Avery Quinn Sample Sr";
    }
    if (fault === "office") native.OfficeName = "STATE TREASURER";
    if (fault === "year") current.electionYear = 2024;
    if (fault === "owner") current.activeCandidateOwnerCount = 2;
    if (fault === "linkOffice") current.linkOfficeName = "Lieutenant Governor";
    if (fault === "canonicalState") current.canonicalDistrictName = "Arizona";
    if (fault === "electionDate") current.electionDate = "2024-11-05";
    expect(() =>
      qualifyNewMexicoReportedReceiver(current, [
        parseNewMexicoNativeCandidate(native, 2026),
      ]),
    ).toThrow();
  });
  it("does not deduplicate repeated native registrations to create uniqueness", () => {
    const source = parseNewMexicoNativeCandidate(row(), 2026);
    expect(() =>
      qualifyNewMexicoReportedReceiver(receiver(), [source, { ...source }]),
    ).toThrow("ambiguous_native_receiving_person_scope");
  });
  it("does not erase middle or generational conflicts using a shorter display alias", () => {
    expect(
      nmPersonMatches(
        ["Avery Quinn Sample", "Avery Sample"],
        "Avery Riley Sample",
      ),
    ).toBe(false);
    expect(
      nmPersonMatches(
        ["Avery Quinn Sample Jr", "Avery Sample"],
        "Avery Quinn Sample Sr",
      ),
    ).toBe(false);
  });
  it("retains unrelated native offices without assigning them statewide scope", () => {
    const unrelated = parseNewMexicoNativeCandidate(
      {
        ...row(),
        OfficeName: "SYNTHETIC LOCAL BOARD",
        DistrictId: 10,
        District: "At large",
      },
      2026,
    );
    const source = parseNewMexicoNativeCandidate(row(), 2026);
    expect(
      qualifyNewMexicoReportedReceiver(receiver(), [unrelated, source]),
    ).toBe(source);
  });
  it("accepts explicit legislative seat evidence and boundary vintage", () => {
    const current = {
      ...receiver(),
      officeScope: "state_upper",
      officeName: "State Senator",
      linkOfficeName: "State Senator",
      district: "12",
      canonicalDistrictType: "state_upper",
      canonicalDistrictName: "State Senate District 12 (2022); New Mexico",
    };
    const source = parseNewMexicoNativeCandidate(
      {
        ...row(),
        OfficeName: "STATE SENATOR",
        DistrictId: 12,
        District: "District 12",
      },
      2026,
    );
    expect(nmCanonicalDistrict(current)).toBe("12");
    expect(qualifyNewMexicoReportedReceiver(current, [source])).toBe(source);
    expect(() =>
      qualifyNewMexicoReportedReceiver({ ...current, district: "13" }, [
        source,
      ]),
    ).toThrow();
  });
  it("holds contradictory detail scope and identities rather than trusting default numeric fields", () => {
    const current = receiver(),
      source = parseNewMexicoNativeCandidate(row(), 2026);
    for (const d of [
      { ...detail(), CandidateName: "Avery Riley Sample" },
      { ...detail(), OfficeId: 99 },
      { ...detail(), DistrictId: 1 },
      { ...detail(), District: "District 1" },
      { ...detail(), MemberID: "" },
    ])
      expect(() =>
        qualifyNewMexicoReceiverDetail(current, source, d),
      ).toThrow();
  });
});

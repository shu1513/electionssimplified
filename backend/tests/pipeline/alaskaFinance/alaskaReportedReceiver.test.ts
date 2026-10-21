import { describe, expect, it } from "vitest";
import {
  qualifyAlaskaReportedReceiver,
  type AlaskaReportedReceiver,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedReceiver.js";
const receiver: AlaskaReportedReceiver = {
  linkId: "synthetic",
  candidateId: "synthetic",
  electionId: "synthetic",
  firstName: "Jane",
  lastName: "Example",
  receivingId: "synthetic",
  legacyCommitteeName: "Jane Example",
  candidateAliases: ["Jane A Example"],
  officeScope: "state_lower",
  officeName: "State Lower Chamber Legislator",
  linkOfficeName: "State Lower Chamber Legislator",
  district: "1",
  canonicalDistrictName: "State House District 1 (2022); Alaska",
  canonicalDistrictType: "state_lower",
  electionYear: 2026,
  electionDate: "2026-11-03",
  activeCandidateOwnerCount: 1,
};
const nominees = [{ name: "Jane A Example", district: "1", year: 2026 }];
describe("Alaska explicit receiver and target context", () => {
  it("allows IE independently of an absent receiving registration", () => {
    expect(
      qualifyAlaskaReportedReceiver(receiver, nominees, null).registrationHref,
    ).toBeNull();
    expect(() => qualifyAlaskaReportedReceiver(receiver, nominees, [])).toThrow(
      /native_receiving_registration/,
    );
  });
  it("rejects wrong seat, cycle, ambiguous person, changed owner and middle conflicts", () => {
    for (const rows of [
      [{ ...nominees[0]!, district: "2" }],
      [{ ...nominees[0]!, year: 2024 }],
      [...nominees, nominees[0]!],
      [{ ...nominees[0]!, name: "Jane B Example" }],
    ])
      expect(() =>
        qualifyAlaskaReportedReceiver(receiver, rows, null),
      ).toThrow();
    expect(() =>
      qualifyAlaskaReportedReceiver(
        { ...receiver, activeCandidateOwnerCount: 2 },
        nominees,
        null,
      ),
    ).toThrow(/exclusive_receiving_identity/);
    expect(() =>
      qualifyAlaskaReportedReceiver(
        { ...receiver, district: "2" },
        nominees,
        null,
      ),
    ).toThrow(/legacy_district_conflict/);
  });
});

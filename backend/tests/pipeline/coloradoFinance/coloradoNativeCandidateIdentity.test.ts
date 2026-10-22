import { describe, expect, it } from "vitest";
import {
  coloradoIePersonMatches,
  qualifyColoradoNativeCandidateProfile,
  type ColoradoIeCandidateIdentity,
} from "../../../src/pipeline/coloradoFinance/coloradoNativeCandidateIdentity.js";

const expected: ColoradoIeCandidateIdentity = {
  candidateName: "Ada Example",
  party: "Democratic",
  officeName: "Governor",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingId: "20260000001",
  receivingName: "Example Campaign",
  tracerCandidateId: "20260000002",
};
function profile(change: Record<string, string> = {}, extraRow = "") {
  const values = {
    lblCandName: "ADA EXAMPLE",
    lblCandidateID: "20260000002",
    lblCommitteeID: "20260000001",
    lblCommName: "Example Campaign",
    lblCommitteeType: "Candidate Committee",
    lblCandParty: "DEMOCRATIC",
    lblCandOffice: "Governor",
    lblCandJurisdiction: "STATEWIDE",
    lblCandStatus: "Active",
    lblCommStatus: "Active",
    ...change,
  };
  const row =
    "<tr><td>ADA EXAMPLE</td><td>2026 Election Cycle (12/9/2022 - 12/3/2026)</td><td>DEMOCRATIC</td><td>STATEWIDE</td><td>Governor</td><td></td><td>Active</td></tr>";
  return new TextEncoder().encode(
    `<html><body>${Object.entries(values)
      .map(([k, v]) => `<span id="_ctl0_Content_${k}">${v}</span>`)
      .join(
        "",
      )}<table id="_ctl0_Content_dgdCampaigns"><tr>${Array.from({ length: 7 }, () => "<th>Column</th>").join("")}</tr>${row}${extraRow}</table></body></html>`,
  );
}
const edit = (b: Uint8Array, from: string, to: string) =>
  new TextEncoder().encode(new TextDecoder().decode(b).replace(from, to));
describe("Colorado native person and financial cycle", () => {
  it("qualifies the published four-year period instead of substituting two calendar years", () =>
    expect(
      qualifyColoradoNativeCandidateProfile(profile(), expected),
    ).toMatchObject({
      cycleYear: 2026,
      cycleStart: "2022-12-09",
      cycleEnd: "2026-12-03",
      candidateName: "ADA EXAMPLE",
      party: "DEM",
    }));
  it("rejects an explicitly conflicting middle", () =>
    expect(coloradoIePersonMatches("Ada A Example", "Ada B Example")).toBe(
      false,
    ));
  it("keeps full source names and supports comma order", () =>
    expect(coloradoIePersonMatches("Ada Example", "Example, Ada")).toBe(true));
  it.each([
    ["lblCandName", "Grace Sample", "native_candidate_person_conflict"],
    ["lblCandParty", "REPUBLICAN", "native_candidate_party_conflict"],
    ["lblCandOffice", "Attorney General", "native_candidate_office_conflict"],
    ["lblCandJurisdiction", "ADAMS", "native_candidate_office_conflict"],
    ["lblCandidateID", "20260000003", "native_candidate_identifier_conflict"],
    ["lblCommitteeID", "20260000003", "native_candidate_identifier_conflict"],
    ["lblCommName", "Sample Campaign", "native_receiving_identity_conflict"],
    [
      "lblCommitteeType",
      "Political Committee",
      "native_receiving_identity_conflict",
    ],
    ["lblCandStatus", "Inactive", "inactive_native_candidate"],
    ["lblCommStatus", "Terminated", "inactive_native_candidate"],
  ])("holds %s conflicts", (key, value, code) =>
    expect(() =>
      qualifyColoradoNativeCandidateProfile(
        profile({ [key]: value }),
        expected,
      ),
    ).toThrow(code),
  );
  it("holds a contradictory campaign row even when the page heading matches", () =>
    expect(() =>
      qualifyColoradoNativeCandidateProfile(
        edit(profile(), "<td>Governor</td>", "<td>Attorney General</td>"),
        expected,
      ),
    ).toThrow("native_campaign_identity_conflict"));
  it("holds duplicate current campaign rows", () => {
    const raw = new TextDecoder().decode(profile()),
      row = raw.match(/<tr><td>[\s\S]*?<\/tr>/)![0];
    expect(() =>
      qualifyColoradoNativeCandidateProfile(profile({}, row), expected),
    ).toThrow("ambiguous_native_campaign_cycle");
  });
  it("holds when the election lies outside actual native bounds", () =>
    expect(() =>
      qualifyColoradoNativeCandidateProfile(
        edit(profile(), "12/3/2026", "10/1/2026"),
        expected,
      ),
    ).toThrow("native_financial_cycle_bounds"));
  it("holds missing bounds rather than inventing a cycle", () =>
    expect(() =>
      qualifyColoradoNativeCandidateProfile(
        edit(profile(), "(12/9/2022 - 12/3/2026)", ""),
        expected,
      ),
    ).toThrow("native_financial_cycle_bounds"));
  it("holds unsupported legislative identity until a source district bridge exists", () =>
    expect(() =>
      qualifyColoradoNativeCandidateProfile(profile(), {
        ...expected,
        officeName: "State Senator",
      }),
    ).toThrow("unqualified_ie_office_scope"));
  it("holds an error page", () =>
    expect(() =>
      qualifyColoradoNativeCandidateProfile(
        new TextEncoder().encode("<html>Unavailable</html>"),
        expected,
      ),
    ).toThrow("missing_native_candidate_control"));
});

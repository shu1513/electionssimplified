import { describe, expect, it } from "vitest";
import {
  bindMarylandLegislativeOutsideTarget,
  parseMaryland2026GeneralLegislativeRoster,
} from "../../../src/pipeline/marylandFinance/marylandLegislativeOutsideTarget.js";
const guid = "11111111-1111-4111-8111-111111111111";
const document = "22222222-2222-4222-8222-222222222222";
const person = (
  name: string,
  status = "Active",
  committee: string | null = "Example, Jane For Senate",
) =>
  `<h3>${name}</h3>Democratic<div class="candidate"><dl><dt>Status</dt><dd>${status}</dd>` +
  (committee === null ? "" : `<dt>Committee Name</dt><dd>${committee}</dd>`) +
  `<dt>Email</dt><dd>not projected</dd></dl></div>`;
const roster = (
  extra = "",
) => `<h1>2026 Gubernatorial General Election State Candidates List</h1>
  <details><summary>State Senator, by District</summary><h2>Legislative District 1</h2>${person("Jane A. Example")}${extra}</details>
  <details><summary>House of Delegates, by District</summary><h2>Legislative District 2A</h2>${person("John B. Other", "Withdrawn - 09/21/2026", null)}</details>`;
const dates = `<h1>Offices up for Election in 2026</h1><dt>General Election</dt><dd><dl><dt>Election Day</dt><dd>November 3, 2026 7AM–8PM</dd></dl></dd>`;
const input = () => ({
  canonical: {
    candidateName: "Jane A. Example",
    party: "Democratic",
    officeScope: "state_upper",
    officeName: "State Senator",
    districtGeoidCompact: "24001",
    electionYear: 2026,
    electionDate: "2026-11-03",
    electionStage: "general",
  },
  target: {
    candidateGuid: guid,
    candidateBallotIssueName: "Example, Jane For Senate",
  },
  registrationRows: [
    {
      filerRegistrationGuid: guid,
      registrationDocumentGuid: document,
      candidateName: "EXAMPLE, JANE A.",
      committeeName: "Example, Jane For Senate",
      committeeTypeCode: "CC",
      officeSought: "State Senator",
      officeSoughtId: 12,
      jurisdictionId: 1,
      partyAffiliation: "Democrat",
      electionYears: "2022, 2026",
      electionTypeCodes: "GBRELEC",
      isActive: true,
      accountStatus: "Active",
      accountStatusCode: "FACT",
      registrationTerminatedDate: null,
    },
  ],
  rosterHtml: roster(),
  electionDatesHtml: dates,
});
describe("Maryland official General legislative target association", () => {
  it("retains both complete office sections and non-active/missing-committee facts", () => {
    const rows = parseMaryland2026GeneralLegislativeRoster(roster());
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      officeScope: "state_lower",
      district: "2A",
      committeeName: null,
      status: "Withdrawn - 09/21/2026",
    });
    expect(JSON.stringify(rows)).not.toContain("not projected");
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });
  it("binds an exact native account to unique official owner, office, district and date", () => {
    const result = bindMarylandLegislativeOutsideTarget(input());
    expect(result.binding).toMatchObject({
      sourceCandidateAccountGuid: guid,
      sourceOwnerName: "EXAMPLE, JANE A.",
      officeScope: "state_upper",
      district: "1",
      electionYear: 2026,
      electionDate: "2026-11-03",
    });
    expect(result.diagnostics).toEqual([]);
    for (const key of [
      "money",
      "amount",
      "qualified",
      "observedAt",
      "directFinanceLink",
    ])
      expect(result.binding).not.toHaveProperty(key);
  });
  it.each([
    { electionYear: 2028 },
    { electionStage: "primary" },
    { electionDate: "2026-11-08" },
    { districtGeoidCompact: "24002" },
    { districtGeoidCompact: "25001" },
    { officeScope: "state_lower" },
    { officeName: "Governor" },
    { candidateName: "Jane B. Example" },
    { party: "Republican" },
  ])("preserves unresolved canonical election context %j", (extra) => {
    const i = input();
    Object.assign(i.canonical, extra);
    expect(bindMarylandLegislativeOutsideTarget(i).binding).toBeUndefined();
  });
  it.each([
    { officeSoughtId: null },
    { officeSoughtId: 0 },
    { jurisdictionId: null },
    { registrationDocumentGuid: null },
    { officeSought: "House of Delegates" },
    { electionYears: "2022" },
    { electionTypeCodes: "GPRI" },
    { isActive: false },
    { accountStatusCode: "FTRM" },
    { accountStatus: "Terminated" },
    { registrationTerminatedDate: "2026-01-01" },
    { candidateName: "EXAMPLE, JANE B." },
    { partyAffiliation: null },
    { committeeTypeCode: "SPAC" },
    { filerRegistrationGuid: document },
  ])("holds unavailable or conflicting native account facts %j", (extra) => {
    const i = input();
    Object.assign(i.registrationRows[0]!, extra);
    expect(bindMarylandLegislativeOutsideTarget(i).binding).toBeUndefined();
  });
  it("does not erase target label punctuation or select one registration document", () => {
    const i = input();
    i.target.candidateBallotIssueName = "Example Jane For Senate";
    expect(bindMarylandLegislativeOutsideTarget(i).binding).toBeUndefined();
    const duplicate = input();
    duplicate.registrationRows.push({
      ...duplicate.registrationRows[0]!,
      registrationDocumentGuid: guid,
    });
    expect(
      bindMarylandLegislativeOutsideTarget(duplicate).binding,
    ).toBeUndefined();
  });
  it("disambiguates across all official seats before the requested local district", () => {
    const i = input();
    i.rosterHtml = roster(
      `<h2>Legislative District 3</h2>${person("Jane A. Example")}`,
    );
    expect(bindMarylandLegislativeOutsideTarget(i).binding).toBeUndefined();
  });
  it("does not admit inactive roster or conflicting middle-name owner", () => {
    for (const html of [
      roster().replace("Jane A. Example", "Jane B. Example"),
      roster().replace("<dd>Active</dd>", "<dd>Declined - 07/31/2026</dd>"),
    ]) {
      const i = input();
      i.rosterHtml = html;
      expect(bindMarylandLegislativeOutsideTarget(i).binding).toBeUndefined();
    }
  });
  it.each(["comment", "script", "style"])(
    "rejects a roster present only in %s",
    (kind) => {
      const html =
        kind === "comment"
          ? `<!--${roster()}-->`
          : `<${kind}>${roster()}</${kind}>`;
      expect(() => parseMaryland2026GeneralLegislativeRoster(html)).toThrow(
        "invalid_maryland_legislative_roster",
      );
    },
  );
  it.each([
    roster().replace("State Senator, by District", "Primary State Senator"),
    roster().replace("Legislative District 1", "District unknown"),
    roster().replace("<dt>Status</dt><dd>Active</dd>", ""),
    roster().replace("<h1>", "<h1>Wrong "),
    roster().replace(
      "<h2>Legislative District 1</h2>",
      `<div class="candidate"><dl><dt>Status</dt><dd>Active</dd></dl></div><h2>Legislative District 1</h2>`,
    ),
    roster().replace(
      "<h2>Legislative District 1</h2>",
      "<h3>Orphan candidate</h3><h2>Legislative District 1</h2>",
    ),
  ])("holds incomplete official source structure", (html) => {
    expect(() => parseMaryland2026GeneralLegislativeRoster(html)).toThrow();
  });
});

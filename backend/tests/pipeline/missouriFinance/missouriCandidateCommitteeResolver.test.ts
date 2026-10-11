import { describe, expect, it, vi } from "vitest";

import {
  normalizeMissouriCandidateNameForStorage,
  resolveMissouriCandidateCommittee,
  searchAndResolveMissouriCandidateCommittee,
  type MissouriMecCandidateCommitteeRecord,
} from "../../../src/pipeline/missouriFinance/missouriCandidateCommitteeResolver.js";

function legislativeRecord(
  overrides: Partial<MissouriMecCandidateCommitteeRecord> = {}
): MissouriMecCandidateCommitteeRecord {
  return {
    mecid: "C221944",
    committeeName: "Forward With Farnan",
    candidateName: "Jeff Farnan",
    party: "R",
    officeSought: "State Representative - District 1 - Missouri House of Representatives",
    status: "A",
    searchElectionDate: "2026-11-03",
    searchPoliticalOffice: "State Representative",
    searchPoliticalSubdivision: null,
    searchPoliticalDistrict: "District 1",
    committeeInfo: {
      mecid: "C221944",
      committeeName: "Forward With Farnan",
      candidateName: "Jeff Farnan",
      sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CommInfo.aspx?MECID=C221944",
      electionHistory: [
        {
          electionDate: "2026-11-03",
          electionType: "General Election",
          office: "State Representative",
          politicalSubdivision: "Missouri House of Representatives",
        },
      ],
    },
    ...overrides,
  };
}

function resolveLegislative(records: readonly MissouriMecCandidateCommitteeRecord[]) {
  return resolveMissouriCandidateCommittee({
    candidateName: "Jeff Farnan",
    electionDate: "2026-11-03",
    officeScope: "state_lower",
    officeName: "State Lower Chamber Legislator",
    ballotTitle: "State Representative",
    districtName: "State House District 1 (2024); Missouri",
    legislativeDistrict: "1",
    records,
  });
}

describe("missouriCandidateCommitteeResolver", () => {
  it("matches only when export, search context, profile name, and exact election history agree", () => {
    expect(resolveLegislative([legislativeRecord()])).toEqual({
      status: "matched",
      mecid: "C221944",
      committeeName: "Forward With Farnan",
      candidateName: "Jeff Farnan",
      officeSought: "State Representative - District 1 - Missouri House of Representatives",
      confidence: "election_history_exact",
      source: "mec_portal",
      sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CommInfo.aspx?MECID=C221944",
      matchedCandidateRowCount: 1,
    });
  });

  it("matches a formal MEC first name through the VoteApp nickname, literal names first", () => {
    // Live: VoteApp "Ray Bruno" (House 120) is "Raymond E Bruno" on MEC.
    const formal = legislativeRecord({
      candidateName: "Raymond Bruno",
      committeeInfo: { ...legislativeRecord().committeeInfo, candidateName: "Raymond E Bruno" },
    });
    const input = {
      candidateName: "Ray Bruno",
      electionDate: "2026-11-03",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      ballotTitle: "State Representative",
      districtName: "State House District 1 (2024); Missouri",
      legislativeDistrict: "1",
    };
    expect(resolveMissouriCandidateCommittee({ ...input, records: [formal] })).toMatchObject({
      status: "matched",
      mecid: "C221944",
    });

    // A literal committee in the same race wins over the nickname one.
    const literal = legislativeRecord({
      mecid: "C260009",
      candidateName: "Ray Bruno",
      committeeInfo: { ...legislativeRecord().committeeInfo, mecid: "C260009", candidateName: "Ray Bruno" },
    });
    expect(resolveMissouriCandidateCommittee({ ...input, records: [formal, literal] })).toMatchObject({
      status: "matched",
      mecid: "C260009",
    });
  });

  it("rejects a historical committee with no exact target-election history row", () => {
    const record = legislativeRecord({
      committeeInfo: {
        ...legislativeRecord().committeeInfo,
        electionHistory: [
          {
            electionDate: "2024-11-05",
            electionType: "General Election",
            office: "State Representative",
            politicalSubdivision: "Missouri House of Representatives",
          },
        ],
      },
    });
    expect(resolveLegislative([record])).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
  });

  it("rejects same-name rows from the wrong legislative district", () => {
    expect(
      resolveLegislative([
        legislativeRecord({
          mecid: "C260002",
          officeSought: "State Representative - District 2 - Missouri House of Representatives",
          searchPoliticalDistrict: "District 2",
          committeeInfo: { ...legislativeRecord().committeeInfo, mecid: "C260002" },
        }),
      ])
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("requires exact local jurisdiction and ward evidence", () => {
    const municipal: MissouriMecCandidateCommitteeRecord = {
      mecid: "A222073",
      committeeName: "Seabaugh for Jackson",
      candidateName: "Paul Seabaugh",
      party: null,
      officeSought: "Alderperson - Ward 3 - City of Jackson",
      status: "T",
      searchElectionDate: "2024-04-02",
      searchPoliticalOffice: "Alderperson",
      searchPoliticalSubdivision: "City of Jackson",
      // MEC's Alderperson cascade has no district dropdown; ward evidence is
      // still explicit in the export's Office Sought value.
      searchPoliticalDistrict: null,
      committeeInfo: {
        mecid: "A222073",
        committeeName: "Seabaugh for Jackson",
        candidateName: "Paul Seabaugh",
        sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CommInfo.aspx?MECID=A222073",
        electionHistory: [
          {
            electionDate: "2024-04-02",
            electionType: "General Election",
            office: "Alderperson",
            politicalSubdivision: "City of Jackson",
          },
        ],
      },
    };

    expect(
      resolveMissouriCandidateCommittee({
        candidateName: "Paul Seabaugh",
        electionDate: "2024-04-02",
        officeScope: "place",
        officeName: "City Council Member",
        ballotTitle: "Alderperson Ward 3",
        districtName: "Jackson city, Missouri",
        records: [municipal],
      })
    ).toMatchObject({ status: "matched", mecid: "A222073" });

    expect(
      resolveMissouriCandidateCommittee({
        candidateName: "Paul Seabaugh",
        electionDate: "2024-04-02",
        officeScope: "place",
        officeName: "City Council Member",
        ballotTitle: "Alderperson Ward 3",
        districtName: "Cape Girardeau city, Missouri",
        records: [municipal],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("matches a place-level judge only through MEC Municipal Judge evidence", () => {
    const municipalJudge: MissouriMecCandidateCommitteeRecord = {
      mecid: "C232576",
      committeeName: "Committee to Elect Sam Buccero",
      candidateName: "Samuel Buccero",
      party: "I",
      officeSought: "Municipal Judge - City of Lees Summit",
      status: "T",
      searchElectionDate: "2024-04-02",
      searchPoliticalOffice: "Municipal Judge",
      searchPoliticalSubdivision: "City of Lees Summit",
      searchPoliticalDistrict: null,
      committeeInfo: {
        mecid: "C232576",
        committeeName: "Committee to Elect Sam Buccero",
        candidateName: "Samuel J Buccero",
        sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CommInfo.aspx?MECID=C232576",
        electionHistory: [
          {
            electionDate: "2024-04-02",
            electionType: "General Election",
            office: "Municipal Judge",
            politicalSubdivision: "City of Lees Summit",
          },
        ],
      },
    };

    expect(
      resolveMissouriCandidateCommittee({
        candidateName: "Samuel J. Buccero",
        electionDate: "2024-04-02",
        officeScope: "place",
        officeName: "Place Level Judge",
        ballotTitle: "Municipal Judge",
        districtName: "Lee's Summit city, Missouri",
        records: [municipalJudge],
      })
    ).toMatchObject({ status: "matched", mecid: "C232576" });
  });

  it("accepts known terminated status with exact history but rejects unknown status and middle conflict", () => {
    expect(resolveLegislative([legislativeRecord({ status: "T" })])).toMatchObject({
      status: "matched",
      mecid: "C221944",
    });
    expect(resolveLegislative([legislativeRecord({ status: "Pending review" })])).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(
      resolveMissouriCandidateCommittee({
        candidateName: "Jeff A. Farnan",
        electionDate: "2026-11-03",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        ballotTitle: "State Representative",
        districtName: "State House District 1 (2024); Missouri",
        legislativeDistrict: "1",
        records: [
          legislativeRecord({
            candidateName: "Jeff B. Farnan",
            committeeInfo: { ...legislativeRecord().committeeInfo, candidateName: "Jeff B. Farnan" },
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts a quoted MEC public-name alias without fuzzy nickname expansion", () => {
    const municipal = legislativeRecord({
      candidateName: "Michael 'Mike' A Seabaugh",
      committeeInfo: {
        ...legislativeRecord().committeeInfo,
        candidateName: "Michael 'Mike' A Seabaugh",
      },
    });
    expect(
      resolveMissouriCandidateCommittee({
        candidateName: "Mike A. Seabaugh",
        electionDate: "2026-11-03",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        ballotTitle: "State Representative",
        districtName: "State House District 1 (2024); Missouri",
        legislativeDistrict: "1",
        records: [municipal],
      })
    ).toMatchObject({ status: "matched", mecid: "C221944" });
  });

  it("does not treat an apostrophe inside a surname as an alias quote", () => {
    expect(
      resolveMissouriCandidateCommittee({
        candidateName: "Sean O'Brien",
        electionDate: "2026-11-03",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        ballotTitle: "State Representative",
        districtName: "State House District 1 (2024); Missouri",
        legislativeDistrict: "1",
        records: [
          legislativeRecord({
            candidateName: "Sean O'Brien",
            committeeInfo: { ...legislativeRecord().committeeInfo, candidateName: "Sean O'Brien" },
          }),
        ],
      })
    ).toMatchObject({ status: "matched", mecid: "C221944" });
  });

  it("fails closed when two active MECIDs carry all required evidence", () => {
    expect(
      resolveLegislative([
        legislativeRecord(),
        legislativeRecord({
          mecid: "C260002",
          committeeName: "Farnan 2026",
          committeeInfo: {
            ...legislativeRecord().committeeInfo,
            mecid: "C260002",
            committeeName: "Farnan 2026",
            sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CommInfo.aspx?MECID=C260002",
          },
        }),
      ])
    ).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      matches: [{ mecid: "C221944" }, { mecid: "C260002" }],
    });
  });

  it("reports missing district/jurisdiction before inspecting source rows", () => {
    expect(
      resolveMissouriCandidateCommittee({
        candidateName: "Jeff Farnan",
        electionDate: "2026-11-03",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        ballotTitle: "State Representative",
        districtName: null,
        records: [],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_legislative_district" });

    expect(
      resolveMissouriCandidateCommittee({
        candidateName: "Paul Seabaugh",
        electionDate: "2024-04-02",
        officeScope: "place",
        officeName: "City Council Member",
        ballotTitle: "Alderperson Ward 3",
        districtName: null,
        records: [],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_jurisdiction" });
  });

  it("normalizes comma-form candidate names for storage", () => {
    expect(normalizeMissouriCandidateNameForStorage("Farnan, Jeff A., Jr.")).toBe("JEFF A FARNAN");
  });

  it("acquires one exact MEC race partition, exports it, and verifies Committee Info", async () => {
    const hidden = '<input type="hidden" name="__VIEWSTATE" value="state" />';
    const pages = [
      hidden,
      `${hidden}<select id="x_ddElectionDate"><option value="-- Select Election --">-- Select Election --</option><option value="11/03/2026">11/03/2026</option></select>`,
      `${hidden}<select id="x_ddPoliticalOffice"><option value="0">--Select Political Office --</option><option value="State Representative">State Representative</option></select>`,
      `${hidden}<select id="x_ddPoliticalDistrict"><option value="0">-- Select District --</option><option value="District 1">District 1</option></select>`,
      `${hidden}<span>2 records found</span><input id="x_btnExport" value="Excel Export" />`,
    ];
    const exportHtml = `
      <table><tr><th>MECID</th><th>Committee Name</th><th>Candidate Name</th><th>Party</th><th>Office Sought</th><th>Status</th></tr>
      <tr><td>C221944</td><td>Forward With Farnan</td><td>Jeff Farnan</td><td>R</td><td>State Representative - District 1 - Missouri House of Representatives</td><td>A</td></tr>
      <tr><td>C264258E</td><td>Exempt Candidate</td><td>Other Person</td><td>R</td><td>State Representative - District 1 - Missouri House of Representatives</td><td>T</td></tr></table>
    `;
    const infoHtml = `
      <span id="x_lblMECID">C221944</span><span id="x_lblCommName">Forward With Farnan</span><span id="x_lblCandName">Jeff Farnan</span>
      <span id="x_gvElecHistory_lblElecYear_0">11/3/2026</span><span id="x_gvElecHistory_lblElectionType_0">General Election</span>
      <span id="x_gvElecHistory_lblSub_0">State Representative</span><span id="x_gvElecHistory_lblPolSub_0">Missouri House of Representatives</span>
    `;
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const index = call++;
      if (index < pages.length) {
        return new Response(pages[index], { status: 200, headers: { "content-type": "text/html" } });
      }
      if (index === pages.length) {
        return new Response(exportHtml, {
          status: 200,
          headers: {
            "content-type": "application/vnd.ms-excel",
            "content-disposition": "attachment;filename=CF_SearchElection.xls",
          },
        });
      }
      return new Response(infoHtml, { status: 200, headers: { "content-type": "text/html" } });
    });

    await expect(
      searchAndResolveMissouriCandidateCommittee(
        {
          candidateName: "Jeff Farnan",
          electionDate: "2026-11-03",
          officeScope: "state_lower",
          officeName: "State Lower Chamber Legislator",
          ballotTitle: "State Representative",
          districtName: "State House District 1 (2024); Missouri",
          legislativeDistrict: "1",
        },
        { fetchImpl, spacingMs: 0, sleep: async () => undefined }
      )
    ).resolves.toMatchObject({ status: "matched", mecid: "C221944" });

    expect(fetchImpl).toHaveBeenCalledTimes(7);
    const searchBody = new URLSearchParams(String(fetchImpl.mock.calls[4]?.[1]?.body));
    expect(searchBody.get("ctl00$ctl00$ContentPlaceHolder$ContentPlaceHolder1$ddPoliticalDistrict")).toBe(
      "District 1"
    );
    expect(searchBody.get("ctl00$ctl00$ContentPlaceHolder$ContentPlaceHolder1$ddStatus")).toBe("All");
    const exportBody = new URLSearchParams(String(fetchImpl.mock.calls[5]?.[1]?.body));
    expect(exportBody.get("ctl00$ctl00$ContentPlaceHolder$ContentPlaceHolder1$btnExport")).toBe(
      "Excel Export"
    );
  });
});

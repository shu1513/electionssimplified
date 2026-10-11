import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_SOURCE_URL,
  districtOfColumbiaFairElectionsCommitteeKey,
  districtOfColumbiaFairElectionsContributionRecordFromRow,
  districtOfColumbiaFairElectionsExpenditureRecordFromRow,
  districtOfColumbiaFairElectionsReceiptKind,
  downloadDistrictOfColumbiaFairElectionsData,
  isDistrictOfColumbiaFairElectionsCommitteeKey,
  parseDistrictOfColumbiaFairElectionsOffice,
  selectDistrictOfColumbiaFairElectionsElections,
  type DistrictOfColumbiaFairElectionsContributionRow,
  type DistrictOfColumbiaFairElectionsElection,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaFairElectionsClient.js";
import { resolveDistrictOfColumbiaCandidateCommittee } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaCandidateCommitteeResolver.js";
import { aggregateDistrictOfColumbiaDirectContributions } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaDirectContributionAggregator.js";

// Real response shape from fairelections.ocf.dc.gov/app/api/Public/SearchContributions
// (2026 cycle), with contributor names, addresses, and employers replaced.
const CONTRIBUTIONS_PAGE = JSON.parse(
  readFileSync(new URL("../../fixtures/districtOfColumbiaFinance/fairElectionsContributionsPage.json", import.meta.url), "utf8")
) as { totalCount: number; gridData: DistrictOfColumbiaFairElectionsContributionRow[] };

const ELECTIONS: DistrictOfColumbiaFairElectionsElection[] = [
  {
    electionId: 11,
    displayName: "Council At-Large Special Election 2026",
    electionDate: "2026-06-16T00:00:00Z",
    electionYear: 2026,
    electionTypeCode: "SE",
  },
  {
    electionId: 9,
    displayName: "General Election 2026",
    electionDate: "2026-11-03T00:00:00Z",
    electionYear: 2026,
    electionTypeCode: "GE",
  },
  {
    electionId: 8,
    displayName: "Primary Election 2026",
    electionDate: "2026-06-16T00:00:00Z",
    electionYear: 2026,
    electionTypeCode: "PE",
  },
];

function records() {
  return CONTRIBUTIONS_PAGE.gridData
    .map((row) => districtOfColumbiaFairElectionsContributionRecordFromRow(row, 2026))
    .filter((record) => record !== null);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("districtOfColumbiaFairElectionsClient", () => {
  it("maps Fair Elections offices onto OCF office labels", () => {
    expect(parseDistrictOfColumbiaFairElectionsOffice("Brian L. Schwalb (Attorney General)")).toEqual({
      office: "Attorney General",
    });
    expect(parseDistrictOfColumbiaFairElectionsOffice("Janeese  Lewis George  (Mayor)")).toEqual({ office: "Mayor" });
    expect(parseDistrictOfColumbiaFairElectionsOffice("Elissa Caren Silverman (Council At-Large)")).toEqual({
      office: "Councilmember",
      seat: "At-Large",
    });
    expect(parseDistrictOfColumbiaFairElectionsOffice("Aparna Raj (Council Ward 1)")).toEqual({
      office: "Councilmember",
      seat: "Ward 1",
    });
    expect(parseDistrictOfColumbiaFairElectionsOffice("Jack Evans (Council Chairman)")).toEqual({
      office: "Chairman of the Council",
    });
    expect(parseDistrictOfColumbiaFairElectionsOffice("Aaron Wesolowski (D.C. State Board of Education Ward 3)")).toEqual({
      office: "D.C. State Board of Education Ward 3",
    });
    expect(parseDistrictOfColumbiaFairElectionsOffice(null)).toEqual({});
  });

  it("labels receipts by schedule", () => {
    expect(districtOfColumbiaFairElectionsReceiptKind("A")).toBe("contribution");
    expect(districtOfColumbiaFairElectionsReceiptKind("A1")).toBe("contribution");
    expect(districtOfColumbiaFairElectionsReceiptKind("A2")).toBe("contribution");
    expect(districtOfColumbiaFairElectionsReceiptKind("A4")).toBe("contribution");
    expect(districtOfColumbiaFairElectionsReceiptKind("A3")).toBe("public_funds");
    expect(districtOfColumbiaFairElectionsReceiptKind("A5")).toBe("other");
    expect(districtOfColumbiaFairElectionsReceiptKind("A6")).toBe("other");
    expect(districtOfColumbiaFairElectionsReceiptKind("A7")).toBe("other");
  });

  it("maps contribution rows with a registration-based committee key", () => {
    const [schwalbDonor] = records();
    expect(schwalbDonor).toEqual({
      committeeName: "Brian for DC 2026",
      committeeKey: "DC FAIR ELECTIONS 159",
      candidateName: "Brian L. Schwalb",
      office: "Attorney General",
      electionYear: 2026,
      contributorName: "Sample Donor 1",
      contributorType: "Itemized Receipts from Individual District Residents",
      employer: "Example Employer",
      occupation: "CEO",
      amount: 200,
      date: "2025-09-03T00:00:00Z",
      receiptKind: "contribution",
    });
    const publicFunds = records().find((record) => record.receiptKind === "public_funds");
    expect(publicFunds).toMatchObject({ committeeKey: "DC FAIR ELECTIONS 159", amount: 3000 });
    // "N/A" placeholders are dropped, not stored as a contributor.
    expect(publicFunds?.contributorName).toBeUndefined();
    expect(publicFunds?.employer).toBeUndefined();
    expect(
      districtOfColumbiaFairElectionsContributionRecordFromRow({ ...CONTRIBUTIONS_PAGE.gridData[0]!, amount: 0 }, 2026)
    ).toBeNull();
    expect(isDistrictOfColumbiaFairElectionsCommitteeKey(districtOfColumbiaFairElectionsCommitteeKey(174))).toBe(true);
    expect(isDistrictOfColumbiaFairElectionsCommitteeKey("MENDELSON FOR CHAIRMAN 2026")).toBe(false);
  });

  it("maps expenditure rows", () => {
    expect(
      districtOfColumbiaFairElectionsExpenditureRecordFromRow({
        registrationId: 209,
        committeeName: "Aaron 4 Ward 3 SBOE",
        payeeName: "Affordable Signs & Banners",
        expenditureType: "Operating Expenditures",
        purposeReason: "Advertising",
        date: "2026-07-20T00:00:00Z",
        amount: 776.98,
      })
    ).toEqual({
      committeeName: "Aaron 4 Ward 3 SBOE",
      committeeKey: "DC FAIR ELECTIONS 209",
      payeeName: "Affordable Signs & Banners",
      purpose: "Advertising",
      amount: 776.98,
      date: "2026-07-20T00:00:00Z",
    });
  });

  it("drops special elections that are already over", () => {
    expect(
      selectDistrictOfColumbiaFairElectionsElections(ELECTIONS, new Date("2026-10-10T00:00:00Z")).map((e) => e.electionId)
    ).toEqual([9, 8]);
    expect(
      selectDistrictOfColumbiaFairElectionsElections(ELECTIONS, new Date("2026-06-01T00:00:00Z")).map((e) => e.electionId)
    ).toEqual([11, 9, 8]);
  });

  it("keeps a finished special for the batch sync's post-election grace days", () => {
    // Election night in D.C. (10pm ET on June 16) is already June 17 in UTC.
    const electionNight = new Date("2026-06-17T02:00:00Z");
    expect(selectDistrictOfColumbiaFairElectionsElections(ELECTIONS, electionNight).map((e) => e.electionId)).toEqual([9, 8]);
    expect(selectDistrictOfColumbiaFairElectionsElections(ELECTIONS, electionNight, 1).map((e) => e.electionId)).toEqual([
      11, 9, 8,
    ]);
    expect(
      selectDistrictOfColumbiaFairElectionsElections(ELECTIONS, new Date("2026-06-17T23:59:00Z"), 1).map((e) => e.electionId)
    ).toEqual([11, 9, 8]);
    expect(
      selectDistrictOfColumbiaFairElectionsElections(ELECTIONS, new Date("2026-06-18T00:00:00Z"), 1).map((e) => e.electionId)
    ).toEqual([9, 8]);
  });

  it("resolves Fair Elections candidates to one committee each", () => {
    const contributionRecords = records();
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Brian Schwalb",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2026,
        contributionRecords,
      })
    ).toMatchObject({ status: "matched", committeeKey: "DC FAIR ELECTIONS 159", committeeName: "Brian for DC 2026" });
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Janeese Lewis George",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords,
      })
    ).toMatchObject({ status: "matched", committeeKey: "DC FAIR ELECTIONS 174" });
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Elissa Silverman",
        officeScope: "place",
        officeName: "City Council Member",
        seat: "AT-LARGE",
        electionYear: 2026,
        contributionRecords,
      })
    ).toMatchObject({ status: "matched", committeeKey: "DC FAIR ELECTIONS 215" });
    // Wrong office: a Lewis George row never matches an Attorney General race.
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Janeese Lewis George",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2026,
        contributionRecords,
      })
    ).toMatchObject({ status: "unmatched" });
  });

  it("keeps public funds out of money raised", () => {
    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: "DC FAIR ELECTIONS 174",
      electionYear: 2026,
      contributionRecords: records(),
      sourceUrl: DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_SOURCE_URL,
    });
    expect(result.summary).toEqual({
      totalReceipts: 200 + 898038.25 + 10920,
      directContributionTotal: 200,
      publicFundsReceived: 898038.25,
      sourceUrl: DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_SOURCE_URL,
    });
    expect(result.directBreakdowns).toEqual([
      expect.objectContaining({ categoryType: "occupation", categoryName: "Temporary Library Assistant", amount: 200 }),
      expect.objectContaining({ categoryType: "contribution_size", categoryName: "$100-$249", amount: 200 }),
    ]);
  });

  it("pages through each current election and skips finished specials", async () => {
    const page = CONTRIBUTIONS_PAGE.gridData;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/Public/GetElectionsByYear/2026")) {
        return jsonResponse(ELECTIONS);
      }
      const body = JSON.parse(String(init?.body)) as { electionId: number; pageNum: number; recordsPerPage: number };
      if (href.endsWith("/Public/SearchContributions")) {
        if (body.electionId === 8) {
          // Two pages of 5 for the primary-registered committees.
          const rows = page.filter((row) => row.registrationId !== 215);
          return jsonResponse({
            totalCount: rows.length,
            gridData: rows.slice((body.pageNum - 1) * body.recordsPerPage, body.pageNum * body.recordsPerPage),
          });
        }
        return jsonResponse({ totalCount: 2, gridData: page.filter((row) => row.registrationId === 215) });
      }
      if (href.endsWith("/Public/SearchExpenditures")) {
        return jsonResponse({
          totalCount: 1,
          gridData: [{ registrationId: body.electionId === 8 ? 174 : 215, committeeName: "x", amount: 100 }],
        });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const data = await downloadDistrictOfColumbiaFairElectionsData(
      { electionYear: 2026, now: new Date("2026-10-10T00:00:00Z") },
      { fetchImpl: fetchImpl as typeof fetch, pageSize: 5 }
    );

    expect(data.sourceUrl).toBe(DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_SOURCE_URL);
    expect(data.contributionRecords).toHaveLength(page.length);
    expect(data.expenditureRecords.map((record) => record.committeeKey)).toEqual([
      "DC FAIR ELECTIONS 215",
      "DC FAIR ELECTIONS 174",
    ]);
    const searchedElections = fetchImpl.mock.calls
      .filter(([url]) => String(url).endsWith("/Public/SearchContributions"))
      .map(([, init]) => JSON.parse(String(init?.body)) as { electionId: number; pageNum: number });
    expect(searchedElections.map((body) => [body.electionId, body.pageNum])).toEqual([
      [9, 1],
      [8, 1],
      [8, 2],
    ]);
  });

  it("raises a client error on HTTP failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503, statusText: "Service Unavailable" }));
    await expect(
      downloadDistrictOfColumbiaFairElectionsData({ electionYear: 2026 }, { fetchImpl: fetchImpl as typeof fetch })
    ).rejects.toThrow("503 Service Unavailable");
  });
});

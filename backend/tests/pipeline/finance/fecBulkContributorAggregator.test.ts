import { describe, expect, it } from "vitest";

import {
  FecBulkContributorAggregator,
  PAYMENT_PLATFORM_MIN_RECIPIENT_COMMITTEES,
  parseFecCandidateCommitteeLinkLine,
  parseFecCommitteeContributionLine,
  parseFecCommitteeMasterLine,
  parseFecEarmarkedReceiptLine,
} from "../../../src/pipeline/finance/fecBulkContributorAggregator.js";

// All committees and people here are made up. The mix is deliberate: a union
// PAC, a corporate PAC, one ideological PAC from each side, a party committee,
// the candidate's own committees, two conduit groups and a payment platform.
const CANDIDATE = "H0XX01234";
const OTHER_CANDIDATE = "S0YY00567";
const CAMPAIGN = "C00000001";
const JOINT_FUNDRAISER = "C00000002";
const LEADERSHIP_PAC = "C00000003";
const UNION_PAC = "C00000011";
const CORPORATE_PAC = "C00000012";
const PROGRESSIVE_PAC = "C00000013";
const CONSERVATIVE_PAC = "C00000014";
const PARTY_COMMITTEE = "C00000015";
const CONDUIT_GROUP_A = "C00000021";
const CONDUIT_GROUP_B = "C00000022";
const PLATFORM = "C00000031";

function cmLine(id: string, name: string, designation: string, type: string, connectedOrg = "", candidateId = ""): string {
  return [id, name, "TREASURER", "1 MAIN ST", "", "CITY", "ST", "00000", designation, type, "", "Q", "", connectedOrg, candidateId].join("|");
}

function cclLine(candidateId: string, cycle: number, committeeId: string, type: string, designation: string): string {
  return [candidateId, String(cycle), String(cycle), committeeId, type, designation, "1"].join("|");
}

function pas2Line(input: {
  from: string;
  to?: string;
  candidate?: string;
  type?: string;
  amount: number;
  memoCode?: string;
  memoText?: string;
}): string {
  return [
    input.from, "N", "Q2", "P2026", "202607159000000001", input.type ?? "24K", "CCM", "FRIENDS OF A CANDIDATE",
    "CITY", "ST", "00000", "", "", "06152026", String(input.amount), input.to ?? CAMPAIGN,
    input.candidate ?? CANDIDATE, "TX1", "1", input.memoCode ?? "", input.memoText ?? "", "4000000000000000001",
  ].join("|");
}

function indivLine(input: { filer: string; conduit?: string; type?: string; amount: number; memoCode?: string }): string {
  return [
    input.filer, "N", "Q2", "P2026", "202607159000000002", input.type ?? "15E", "IND", "DOE, PAT", "CITY", "ST",
    "00000", "EMPLOYER", "OCCUPATION", "06152026", String(input.amount), input.conduit ?? "", "TX2", "1",
    input.memoCode ?? "", "* EARMARKED CONTRIBUTION: SEE BELOW", "4000000000000000002",
  ].join("|");
}

function buildAggregator(): FecBulkContributorAggregator {
  const aggregator = new FecBulkContributorAggregator({ cycle: 2026, fecCandidateIds: [CANDIDATE] });
  const committees = [
    cmLine(CAMPAIGN, "FRIENDS OF A CANDIDATE", "P", "H", "", CANDIDATE),
    cmLine(JOINT_FUNDRAISER, "A CANDIDATE VICTORY FUND", "J", "N"),
    cmLine(LEADERSHIP_PAC, "A CANDIDATE LEADERSHIP PAC", "D", "N", "", CANDIDATE),
    cmLine(UNION_PAC, "UNITED WORKERS UNION PAC", "B", "Q", "UNITED WORKERS UNION"),
    cmLine(CORPORATE_PAC, "ACME CORP PAC", "B", "Q", "ACME CORPORATION"),
    cmLine(PROGRESSIVE_PAC, "PROGRESS FORWARD PAC", "U", "Q", "NONE"),
    cmLine(CONSERVATIVE_PAC, "LIBERTY FIRST PAC", "U", "Q", ""),
    cmLine(PARTY_COMMITTEE, "STATE PARTY COMMITTEE", "U", "Y"),
    cmLine(CONDUIT_GROUP_A, "CONDUIT GROUP A PAC", "U", "Q"),
    cmLine(CONDUIT_GROUP_B, "CONDUIT GROUP B PAC", "U", "Q"),
    cmLine(PLATFORM, "DONATION PLATFORM", "U", "V"),
  ];
  for (const line of committees) {
    const committee = parseFecCommitteeMasterLine(line);
    if (committee) {
      aggregator.addCommittee(committee);
    }
  }
  for (const line of [
    cclLine(CANDIDATE, 2026, CAMPAIGN, "H", "P"),
    cclLine(CANDIDATE, 2026, JOINT_FUNDRAISER, "N", "J"),
  ]) {
    const link = parseFecCandidateCommitteeLinkLine(line);
    if (link) {
      aggregator.addCandidateCommitteeLink(link);
    }
  }
  return aggregator;
}

function addPas2(aggregator: FecBulkContributorAggregator, lines: string[]): void {
  for (const line of lines) {
    const row = parseFecCommitteeContributionLine(line);
    if (row) {
      aggregator.addCommitteeContribution(row);
    }
  }
}

function addIndiv(aggregator: FecBulkContributorAggregator, lines: string[]): void {
  for (const line of lines) {
    const row = parseFecEarmarkedReceiptLine(line);
    if (row) {
      aggregator.addEarmarkedReceipt(row);
    }
  }
}

describe("FEC bulk line parsing", () => {
  it("reads committee master rows and treats a NONE connected organization as absent", () => {
    expect(parseFecCommitteeMasterLine(cmLine(CORPORATE_PAC, "ACME CORP PAC", "B", "Q", "ACME CORPORATION"))).toEqual({
      committeeId: CORPORATE_PAC,
      name: "ACME CORP PAC",
      designation: "B",
      committeeType: "Q",
      connectedOrganization: "ACME CORPORATION",
      candidateId: null,
    });
    expect(parseFecCommitteeMasterLine(cmLine(PROGRESSIVE_PAC, "PROGRESS FORWARD PAC", "U", "Q", "NONE"))?.connectedOrganization).toBeNull();
    expect(parseFecCommitteeMasterLine("not a committee row")).toBeNull();
  });

  it("reads candidate-committee links", () => {
    expect(parseFecCandidateCommitteeLinkLine(cclLine(CANDIDATE, 2026, CAMPAIGN, "H", "P"))).toEqual({
      candidateId: CANDIDATE,
      fecElectionYear: 2026,
      committeeId: CAMPAIGN,
      designation: "P",
    });
  });

  it("keeps only 24K and 24Z rows from the committee contribution file", () => {
    expect(parseFecCommitteeContributionLine(pas2Line({ from: UNION_PAC, amount: 5000 }))).toEqual({
      committeeId: UNION_PAC,
      candidateId: CANDIDATE,
      recipientCommitteeId: CAMPAIGN,
      transactionType: "24K",
      amount: 5000,
      isMemo: false,
      isEarmarkForward: false,
    });
    expect(parseFecCommitteeContributionLine(pas2Line({ from: UNION_PAC, type: "24Z", amount: 750.5 }))?.transactionType).toBe("24Z");
    // 24E is an independent expenditure, not a contribution to the candidate.
    expect(parseFecCommitteeContributionLine(pas2Line({ from: UNION_PAC, type: "24E", amount: 90000 }))).toBeNull();
    expect(parseFecCommitteeContributionLine(pas2Line({ from: UNION_PAC, amount: Number.NaN }))).toBeNull();
  });

  it("flags memo entries and earmark pass-through rows", () => {
    const memo = parseFecCommitteeContributionLine(pas2Line({ from: UNION_PAC, amount: 100, memoCode: "X" }));
    expect(memo?.isMemo).toBe(true);
    const forward = parseFecCommitteeContributionLine(
      pas2Line({ from: CONDUIT_GROUP_A, amount: 250, memoText: "EARMARKED BY PAT DOE" })
    );
    expect(forward?.isEarmarkForward).toBe(true);
  });

  it("reads only 15E receipts that name a conduit committee", () => {
    expect(parseFecEarmarkedReceiptLine(indivLine({ filer: CAMPAIGN, conduit: PLATFORM, amount: 25 }))).toEqual({
      recipientCommitteeId: CAMPAIGN,
      conduitCommitteeId: PLATFORM,
      amount: 25,
      isMemo: false,
    });
    expect(parseFecEarmarkedReceiptLine(indivLine({ filer: CAMPAIGN, type: "15", amount: 25 }))).toBeNull();
    expect(parseFecEarmarkedReceiptLine(indivLine({ filer: CAMPAIGN, conduit: "", amount: 25 }))).toBeNull();
  });
});

describe("FecBulkContributorAggregator", () => {
  it("names each committee donor with its total, count and connected organization", () => {
    const aggregator = buildAggregator();
    addPas2(aggregator, [
      pas2Line({ from: UNION_PAC, amount: 5000 }),
      pas2Line({ from: UNION_PAC, amount: 5000 }),
      pas2Line({ from: CORPORATE_PAC, amount: 2500 }),
      pas2Line({ from: CORPORATE_PAC, type: "24Z", amount: 499.99 }),
      pas2Line({ from: PROGRESSIVE_PAC, amount: 1000 }),
      pas2Line({ from: CONSERVATIVE_PAC, amount: 1000 }),
      // Money to a different candidate never shows up here.
      pas2Line({ from: UNION_PAC, candidate: OTHER_CANDIDATE, to: "C00000099", amount: 5000 }),
    ]);

    expect(aggregator.getContributors(CANDIDATE).pacDonors).toEqual([
      { committeeId: UNION_PAC, committeeName: "UNITED WORKERS UNION PAC", connectedOrganization: "UNITED WORKERS UNION", amount: 10000, contributionCount: 2, recipientCommitteeId: CAMPAIGN },
      { committeeId: CORPORATE_PAC, committeeName: "ACME CORP PAC", connectedOrganization: "ACME CORPORATION", amount: 2999.99, contributionCount: 2, recipientCommitteeId: CAMPAIGN },
      // Equal amounts sort by name, so neither side is placed first by rule.
      { committeeId: CONSERVATIVE_PAC, committeeName: "LIBERTY FIRST PAC", connectedOrganization: null, amount: 1000, contributionCount: 1, recipientCommitteeId: CAMPAIGN },
      { committeeId: PROGRESSIVE_PAC, committeeName: "PROGRESS FORWARD PAC", connectedOrganization: null, amount: 1000, contributionCount: 1, recipientCommitteeId: CAMPAIGN },
    ]);
  });

  it("nets refunds and drops a committee whose contributions were fully returned", () => {
    const aggregator = buildAggregator();
    addPas2(aggregator, [
      pas2Line({ from: UNION_PAC, amount: 5000 }),
      pas2Line({ from: UNION_PAC, amount: -2000, memoText: "REFUND OF CONTRIBUTION" }),
      pas2Line({ from: CORPORATE_PAC, amount: 2500 }),
      pas2Line({ from: CORPORATE_PAC, amount: -2500, memoText: "VOIDED: ORIGINAL CHECK DATED 01/02/2026" }),
    ]);

    expect(aggregator.getContributors(CANDIDATE).pacDonors).toEqual([
      expect.objectContaining({ committeeId: UNION_PAC, amount: 3000, contributionCount: 1 }),
    ]);
  });

  it("skips memo entries", () => {
    const aggregator = buildAggregator();
    addPas2(aggregator, [
      pas2Line({ from: UNION_PAC, amount: 5000 }),
      pas2Line({ from: UNION_PAC, amount: 5000, memoCode: "X", memoText: "REDESIGNATION" }),
    ]);
    expect(aggregator.getContributors(CANDIDATE).pacDonors[0]?.amount).toBe(5000);
  });

  it("never lists the candidate's own committees or party committees as donors", () => {
    const aggregator = buildAggregator();
    addPas2(aggregator, [
      pas2Line({ from: JOINT_FUNDRAISER, amount: 40000 }),
      pas2Line({ from: LEADERSHIP_PAC, amount: 5000 }),
      pas2Line({ from: PARTY_COMMITTEE, amount: 5000 }),
      pas2Line({ from: CORPORATE_PAC, amount: 1000 }),
    ]);
    expect(aggregator.getContributors(CANDIDATE).pacDonors.map((donor) => donor.committeeId)).toEqual([CORPORATE_PAC]);
  });

  it("counts an earmarked contribution once: not as a committee donation, and only from the candidate's own filing", () => {
    const aggregator = buildAggregator();
    // The conduit group reports passing on Pat Doe's $250 as a 24K row. It
    // also gave $1,000 of its own money.
    addPas2(aggregator, [
      pas2Line({ from: CONDUIT_GROUP_A, amount: 250, memoText: "EARMARKED BY PAT DOE" }),
      pas2Line({ from: CONDUIT_GROUP_A, amount: 1000 }),
    ]);
    addIndiv(aggregator, [
      // The campaign's line for the same $250.
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_A, amount: 250 }),
      // The conduit's own receipt line for the same $250 names the campaign
      // in OTHER_ID. It is filed by the conduit, so it must not count.
      indivLine({ filer: CONDUIT_GROUP_A, conduit: CAMPAIGN, amount: 250 }),
      // The campaign's memo line repeating the conduit total.
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_A, amount: 250, memoCode: "X" }),
    ]);

    const contributors = aggregator.getContributors(CANDIDATE);
    expect(contributors.pacDonors).toEqual([
      expect.objectContaining({ committeeId: CONDUIT_GROUP_A, amount: 1000, contributionCount: 1 }),
    ]);
    expect(contributors.conduits).toEqual([
      {
        committeeId: CONDUIT_GROUP_A,
        committeeName: "CONDUIT GROUP A PAC",
        isPaymentPlatform: false,
        amount: 250,
        contributionCount: 1,
        recipientCommitteeId: CAMPAIGN,
      },
    ]);
  });

  it("totals conduits the same way whatever the group, and nets returned earmarks", () => {
    const aggregator = buildAggregator();
    addIndiv(aggregator, [
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_A, amount: 500 }),
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_A, amount: 300 }),
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_A, amount: -300 }),
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_B, amount: 500 }),
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_B, amount: 300 }),
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_B, amount: -300 }),
      // Money through the candidate's own joint fundraiser is not a group.
      indivLine({ filer: CAMPAIGN, conduit: JOINT_FUNDRAISER, amount: 900 }),
    ]);

    const conduits = aggregator.getContributors(CANDIDATE).conduits;
    expect(conduits.map(({ committeeId, amount, contributionCount }) => ({ committeeId, amount, contributionCount }))).toEqual([
      { committeeId: CONDUIT_GROUP_A, amount: 500, contributionCount: 2 },
      { committeeId: CONDUIT_GROUP_B, amount: 500, contributionCount: 2 },
    ]);
  });

  it("marks a conduit as a payment platform only from its reach and its lack of own contributions", () => {
    const aggregator = buildAggregator();
    // Both conduits forward to the same large number of committees. Only the
    // one that also gives its own money stays with the groups.
    addPas2(aggregator, [pas2Line({ from: CONDUIT_GROUP_A, candidate: OTHER_CANDIDATE, to: "C00000099", amount: 1000 })]);
    for (let index = 0; index < PAYMENT_PLATFORM_MIN_RECIPIENT_COMMITTEES; index += 1) {
      const filer = `C9${String(index).padStart(7, "0")}`;
      addIndiv(aggregator, [
        indivLine({ filer, conduit: PLATFORM, amount: 10 }),
        indivLine({ filer, conduit: CONDUIT_GROUP_A, amount: 10 }),
      ]);
    }
    addIndiv(aggregator, [
      indivLine({ filer: CAMPAIGN, conduit: PLATFORM, amount: 25 }),
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_A, amount: 25 }),
      indivLine({ filer: CAMPAIGN, conduit: CONDUIT_GROUP_B, amount: 25 }),
    ]);

    const platformFlags = Object.fromEntries(
      aggregator.getContributors(CANDIDATE).conduits.map((conduit) => [conduit.committeeId, conduit.isPaymentPlatform])
    );
    expect(platformFlags).toEqual({ [PLATFORM]: true, [CONDUIT_GROUP_A]: false, [CONDUIT_GROUP_B]: false });
  });

  it("returns empty lists for a candidate with no rows", () => {
    expect(buildAggregator().getContributors(CANDIDATE)).toEqual({ fecCandidateId: CANDIDATE, pacDonors: [], conduits: [] });
  });
});

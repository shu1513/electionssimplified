import { describe, expect, it } from "vitest";
import {
  aggregateSouthCarolinaCommitteeDonors,
  type SouthCarolinaCommitteeDonorInput,
} from "../../../src/pipeline/southCarolinaFinance/southCarolinaCommitteeDonorAggregator.js";
import type {
  SouthCarolinaItemizedContribution,
  SouthCarolinaReportDetails,
  SouthCarolinaContributionSearchRow,
} from "../../../src/pipeline/southCarolinaFinance/southCarolinaEthicsClient.js";

function fixture(): SouthCarolinaCommitteeDonorInput {
  const cash = (
    name: string,
    amount: number,
    day: string,
    actor: number,
    description = "",
  ): SouthCarolinaItemizedContribution => ({
    contributorId: actor,
    name,
    civilDate: day,
    amountCents: amount * 100,
    occupation: " ",
    description,
    sourceDate: day,
  });
  const items = [
    cash("SC Example PAC", 500, "2026-04-02", 50),
    cash("Manufactured Housing Institute of SC", 1000, "2026-04-03", 60),
    cash(
      "Manufactured Housing Institute of SC",
      1000,
      "2026-05-11",
      60,
      "Sent refund check, hasn't cleared bank as of June 30.",
    ),
    cash("Kevin R Dean", 100, "2026-05-15", 70),
  ];
  const lines = (values: Record<string, number>) =>
    Object.entries(values).map(([type, amount]) => ({
      type,
      filingPeriod: amount,
      electionCycleTotal: amount,
    }));
  const detail: SouthCarolinaReportDetails = {
    filerName: "Brandon Guffey",
    electionDate: "2026-11-03T05:00:00",
    electionType: "General",
    reportType: "Quarter 2",
    filingPeriod: "4/1/2026 - 6/30/2026",
    isAmendment: false,
    reportSequenceNumber: 32,
    contributionsTotal: 2600,
    expendituresTotal: 1000,
    income: lines({
      "Cash Contributions": 2600,
      "In-kind Contributions": 0,
      "Personal Contributions": 0,
      Loans: 0,
      "Account Credits": 0,
      "Debt Setoff Funds": 0,
      Total: 2600,
    }),
    expenditures: lines({
      Expenditures: 0,
      "Returned Contributions": 1000,
      "In-Kind Expenditures": 0,
      Total: 1000,
    }),
    totals: [],
    versions: [{ id: 422991, name: "Original Report" }],
    itemizedContributions: items,
    itemizedExpenditures: [
      {
        paidToId: 90,
        name: "Manufactured Housing Institute of SC ",
        civilDate: "2026-06-11",
        amountCents: 100000,
        description: "returned with check # 2640",
        sourceDate: "Jun 11, 2026",
        sourceDateSort: "0001-01-01T00:00:00",
      },
    ],
  };
  const annual: SouthCarolinaContributionSearchRow[] = items.map((r, i) => ({
    contributionId: i + 100,
    candidateId: 44315,
    officeRunId: 77205,
    candidateName: "Brandon Guffey",
    officeName: "SC House of Representatives District 48",
    electionDate: "2026-11-03T05:00:00",
    date: r.civilDate,
    amount: r.amountCents / 100,
    contributorName: i === 3 ? "Kevin Dean" : r.name,
    contributorOccupation: i === 3 ? "Retired" : null,
    group: i === 3 ? "No" : "Yes",
    description: r.description,
  }));
  items[3]!.occupation = "Retired";
  return {
    candidateFilerId: 44315,
    electionYear: 2026,
    acceptedElectionDates: ["11/3/2026"],
    filerName: "Guffey, Brandon",
    sourceUrl: "https://ethicsfiling.sc.gov/public",
    reports: [
      {
        reportId: 422991,
        reportName: "Quarter 2",
        reportType: "Quarterly",
        electionDate: "11/3/2026",
        contributions: 2600,
        expenses: 1000,
        balance: 1600,
        dateSubmitted: "2026-07-08",
        campaignId: 77205,
        candidateFilerId: 44315,
        filingStartDate: "2026-04-01T04:00:00",
        filingEndDate: "2026-06-30T00:00:00",
        isPrimary: false,
        isGeneral: true,
        isPreElection: false,
        isFinal: false,
      },
    ],
    detailsByReportId: new Map([[422991, detail]]),
    contributionRows: annual,
  };
}
const detail = (f: SouthCarolinaCommitteeDonorInput) => f.detailsByReportId.get(422991)!;
function addOrganization(f: SouthCarolinaCommitteeDonorInput, name: string, amount = 100, occupation = "") {
  const d = detail(f);
  const id = f.contributionRows.length + 100;
  d.itemizedContributions!.push({
    contributorId: id,
    name,
    civilDate: "2026-05-20",
    amountCents: amount * 100,
    occupation,
    description: "",
    sourceDate: "2026-05-20",
  });
  (f.contributionRows as SouthCarolinaContributionSearchRow[]).push({
    ...f.contributionRows[0]!,
    contributionId: id,
    contributorName: name,
    contributorOccupation: occupation,
    date: "2026-05-20",
    amount,
    description: "",
  });
  d.contributionsTotal += amount;
  for (const line of d.income) if (["Cash Contributions", "Total"].includes(line.type)) line.filingPeriod += amount;
}
function unknown(f: SouthCarolinaCommitteeDonorInput, message: RegExp) {
  const result = aggregateSouthCarolinaCommitteeDonors(f);
  expect(result.pacDonors).toBeUndefined();
  expect(result.diagnostics.join(" ")).toMatch(message);
}

describe("SC reported committee donor source facts", () => {
  it("matches organizations despite individual middle-name projection and nets literal unrecognized owner", () => {
    const result = aggregateSouthCarolinaCommitteeDonors(fixture());
    expect(result.pacDonors).toEqual([
      {
        committeeId: "reported:SC EXAMPLE PAC",
        committeeName: "SC Example PAC",
        amount: 500,
        contributionCount: 1,
        sourceUrl: "https://ethicsfiling.sc.gov/public",
        recognitionMethod: "political_name_hint",
        sourceReportedClass: "group_yes",
      },
    ]);
    expect(result.diagnostics.join(" ")).toMatch(/individual name projections/);
    expect(result.diagnostics.join(" ")).toMatch(/returns netted/);
  });
  it("does not promote associations/businesses/acronym suffixes or occupied organizations", () => {
    const f = fixture();
    for (const n of [
      "Business LLC",
      "Example Association",
      "Example Union",
      "CUPAC of SC",
      "SCOPAPAC",
      "Example Council",
      "Jennings Law Firm, P.A.",
    ])
      addOrganization(f, n);
    addOrganization(f, "Occupied PAC", 100, "Attorney");
    expect(aggregateSouthCarolinaCommitteeDonors(f).pacDonors).toHaveLength(1);
  });
  it("accepts P.A.C. and Committee names while preserving punctuation and distinct full names", () => {
    const f = fixture();
    addOrganization(f, "Example P.A.C.");
    addOrganization(f, "Example Committee");
    addOrganization(f, "SC Example PAC SC");
    const result = aggregateSouthCarolinaCommitteeDonors(f);
    expect(result.pacDonors?.map((x) => x.committeeId)).toContain("reported:EXAMPLE P.A.C.");
    expect(result.pacDonors?.map((x) => x.committeeId)).toContain("reported:SC EXAMPLE PAC SC");
    expect(result.pacDonors).toHaveLength(4);
  });
  it("retains equal gifts with distinct source IDs rather than economic dedupe", () => {
    const f = fixture();
    addOrganization(f, "SC Example PAC", 500);
    addOrganization(f, "SC Example PAC", 500);
    expect(aggregateSouthCarolinaCommitteeDonors(f).pacDonors?.[0]).toMatchObject({
      amount: 1500,
      contributionCount: 3,
    });
  });
  it("accepts current amendments without an Original-only rule", () => {
    const f = fixture();
    detail(f).isAmendment = true;
    detail(f).versions = [
      { id: 422991, name: "Amendment 1" },
      { id: 420000, name: "Original Report" },
    ];
    expect(aggregateSouthCarolinaCommitteeDonors(f).pacDonors).toHaveLength(1);
  });
  it("preserves missing full financial fields", () => {
    const f = fixture();
    delete detail(f).itemizedContributions;
    unknown(f, /unavailable/);
  });
  it("rejects current version mismatch rather than choosing a maximum ID", () => {
    const f = fixture();
    detail(f).versions[0]!.id = 999999;
    unknown(f, /version/);
  });
  it("rejects a same-total changed organization name", () => {
    const f = fixture();
    detail(f).itemizedContributions![0]!.name = "Other PAC";
    unknown(f, /Organization occurrence/);
  });
  it("rejects duplicate annual IDs", () => {
    const f = fixture();
    f.contributionRows[1]!.contributionId = 100;
    unknown(f, /Duplicate/);
  });
  it("rejects annual amount or count mismatch", () => {
    const f = fixture();
    f.contributionRows[0]!.amount = 400;
    unknown(f, /control/);
  });
  it("rejects a mixed GroupYes/No identity cohort", () => {
    const f = fixture();
    addOrganization(f, "SC Example PAC", 500);
    const last = f.contributionRows.at(-1)!;
    last.date = f.contributionRows[0]!.date;
    detail(f).itemizedContributions!.at(-1)!.civilDate = last.date;
    last.group = "No";
    unknown(f, /Ambiguous contributor class/);
  });
  it("rejects unexplained return owner or ambiguous class", () => {
    const f = fixture();
    detail(f).itemizedExpenditures![0]!.name = "Unknown Owner";
    unknown(f, /owner/);
  });
  it("rejects return-purpose/control mismatch", () => {
    const f = fixture();
    detail(f).itemizedExpenditures![0]!.description = "campaign printing";
    unknown(f, /purpose/);
  });
  it("preserves unsupported contribution reversal instead of creating another gift", () => {
    const f = fixture();
    f.contributionRows[0]!.description = "reversal";
    detail(f).itemizedContributions![0]!.description = "reversal";
    unknown(f, /refund\/recredit/);
  });
  it("retains signed and zero reported owner positions without clamping", () => {
    for (const refund of [500, 600]) {
      const f = fixture();
      const d = detail(f);
      d.itemizedExpenditures!.push({
        ...d.itemizedExpenditures![0]!,
        paidToId: 91,
        name: "SC Example PAC",
        amountCents: refund * 100,
        description: "returned with check # 7",
      });
      d.expendituresTotal += refund;
      for (const line of d.expenditures)
        if (["Returned Contributions", "Total"].includes(line.type)) line.filingPeriod += refund;
      expect(aggregateSouthCarolinaCommitteeDonors(f).pacDonors?.[0]?.amount).toBe(500 - refund);
    }
  });
  it("preserves unresolved in-kind mechanism rather than counting it as cash", () => {
    const f = fixture();
    detail(f).income.find((x) => x.type === "In-kind Contributions")!.filingPeriod = 100;
    unknown(f, /mechanism/);
  });
  it("rejects wrong owner and wrong applicable election", () => {
    const f = fixture();
    detail(f).filerName = "Someone Else";
    unknown(f, /owner/);
    const other = fixture();
    other.acceptedElectionDates = ["6/9/2026"];
    unknown(other, /No applicable/);
  });
  it("rejects missing/overlapping report periods", () => {
    const f = fixture();
    (f.reports as any[]).push({ ...f.reports[0], reportId: 422992 });
    (f.detailsByReportId as Map<number, SouthCarolinaReportDetails>).set(422992, {
      ...detail(f),
      versions: [{ id: 422992, name: "Original Report" }],
    });
    unknown(f, /overlap/);
  });
  it("accepts a current zero amendment only with actual arrays and zero controls", () => {
    const f = fixture();
    const d = detail(f);
    d.isAmendment = true;
    d.versions = [
      { id: 422991, name: "Amendment 1" },
      { id: 420000, name: "Original Report" },
    ];
    d.itemizedContributions = [];
    d.itemizedExpenditures = [];
    d.contributionsTotal = 0;
    d.expendituresTotal = 0;
    d.income.forEach((r) => {
      r.filingPeriod = 0;
      r.electionCycleTotal = 0;
    });
    d.expenditures.forEach((r) => {
      r.filingPeriod = 0;
      r.electionCycleTotal = 0;
    });
    f.contributionRows = [];
    expect(aggregateSouthCarolinaCommitteeDonors(f).pacDonors).toEqual([]);
  });
  it("preserves a same-total changed organization date", () => {
    const f = fixture();
    detail(f).itemizedContributions![0]!.civilDate = "2026-04-03";
    unknown(f, /Organization occurrence/);
  });
  it("refuses a gap between actual current filing periods", () => {
    const f = fixture();
    (f.reports as any[]).push({
      ...f.reports[0],
      reportId: 422992,
      filingStartDate: "2026-07-02",
      filingEndDate: "2026-09-30",
    });
    (f.detailsByReportId as Map<number, SouthCarolinaReportDetails>).set(422992, {
      ...detail(f),
      filingPeriod: "7/2/2026 - 9/30/2026",
      versions: [{ id: 422992, name: "Original Report" }],
    });
    unknown(f, /hole/);
  });
});

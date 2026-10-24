import { describe, it, expect } from "vitest";
import { aggregateSanJoseCommitteeCash as aggregate } from "../../../src/pipeline/sanJoseFinance/sanJoseCommitteeCash.js";
import type { EfileCalContributionRow } from "../../../src/pipeline/efileCalFinance/efileCalWorkbookParser.js";
const filing = {
  eFilingId: "100",
  reportNum: "001",
  fromDate: "2026-01-01",
  thruDate: "2026-06-30",
};
const row = (
  over: Partial<EfileCalContributionRow> = {},
): EfileCalContributionRow => ({
  ...filing,
  filerId: "1111111",
  filerName: "Alex Example Campaign",
  origEFilingId: "99",
  cmtteType: "C",
  rptDate: "2026-07-15",
  electDate: null,
  formType: "A",
  tranId: "A1",
  entityCd: "PTY",
  contributorLastName: "Example Party",
  contributorFirstName: null,
  contributorCommitteeId: "2222222",
  contributorOccupation: null,
  contributorEmployer: null,
  contributorSelfEmployed: false,
  amountCents: 10001,
  cumulativeYtdCents: null,
  receiptDate: "2026-06-01",
  memo: false,
  ...over,
});
const run = (scheduleA: EfileCalContributionRow[]) =>
  aggregate({
    filerId: "1111111",
    officeName: "City Council Member",
    seatNumber: 2,
    filings: [filing],
    reportedThrough: "2026-06-30",
    scheduleA,
  });
describe("San José native typed committee cash", () => {
  it.each(["COM", "PTY", "SCC"])(
    "accepts native %s with exact cents and reported donor ID",
    (entityCd) =>
      expect(run([row({ entityCd })])).toMatchObject({
        amountCents: 10001,
        contributionCount: 1,
        donors: [{ committeeKey: "id:2222222", committeeId: "2222222" }],
      }),
  );
  it("preserves equal gifts with distinct native occurrences and excludes superseded filings", () =>
    expect(
      run([
        row(),
        row({ tranId: "A2" }),
        row({ eFilingId: "99", amountCents: 999999 }),
      ]),
    ).toMatchObject({
      canonicalFilingCount: 1,
      amountCents: 20002,
      contributionCount: 2,
      donors: [{ contributionCount: 2 }],
    }));
  it.each([
    { entityCd: "IND" },
    { entityCd: "OTH", contributorLastName: "Example PAC" },
    { memo: true },
    { contributorCommitteeId: "1111111" },
    { contributorLastName: "Alex Example Campaign" },
    { amountCents: 0 },
  ])("excludes nonqualifying receipt %j", (over) =>
    expect(run([row(over)]).amountCents).toBe(0),
  );
  it.each([
    { formType: "C" },
    { amountCents: -1 },
    { amountCents: 1.5 },
    { contributorCommitteeId: "Pending" },
    { receiptDate: null },
    { receiptDate: "2026-02-30" },
    { receiptDate: "2026-07-01" },
    { fromDate: "2025-01-01" },
    { reportNum: "000" },
    { tranId: "" },
  ])("holds unsafe source %j", (over) =>
    expect(() => run([row(over)])).toThrow(),
  );
  it("rejects native occurrence collisions rather than losing equal gifts", () =>
    expect(() => run([row(), row()])).toThrow(/occurrence/));
  it("rejects conflicting reported donor types", () =>
    expect(() => run([row(), row({ tranId: "A2", entityCd: "COM" })])).toThrow(
      /types/,
    ));
  it("uses a reported name key only when native donor ID is absent", () =>
    expect(
      run([row({ contributorCommitteeId: null })]).donors[0]?.committeeKey,
    ).toBe("reported:EXAMPLE PARTY"));
  it("keeps complete zero evidence", () =>
    expect(run([])).toMatchObject({
      amountCents: 0,
      contributionCount: 0,
      donors: [],
    }));
});

it("holds overlapping canonical periods without silently dropping a filing", () =>
  expect(() =>
    aggregate({
      filerId: "1111111",
      officeName: "Mayor",
      seatNumber: null,
      filings: [
        filing,
        {
          ...filing,
          eFilingId: "101",
          fromDate: "2026-06-01",
          thruDate: "2026-09-30",
        },
      ],
      reportedThrough: "2026-09-30",
      scheduleA: [],
    }),
  ).toThrow(/Overlapping/));

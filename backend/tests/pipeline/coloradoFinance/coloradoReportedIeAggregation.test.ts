import { describe, expect, it } from "vitest";
import { aggregateColoradoReportedIe } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeAggregation.js";
import type {
  ColoradoReportedExpense,
  ColoradoReportedIeReport,
} from "../../../src/pipeline/coloradoFinance/coloradoTracerReports.js";
const identity = {
  candidateName: "ADA EXAMPLE",
  party: "DEM",
  officeName: "Governor",
  candidateId: "20260000002",
  receivingId: "20260000001",
  cycleYear: 2026,
  cycleStart: "2022-12-09",
  cycleEnd: "2026-12-03",
};
const expected = {
  candidateName: "Ada Example",
  party: "Democratic",
  officeName: "Governor",
  receivingId: identity.receivingId,
  receivingName: "Example Campaign",
  electionYear: 2026,
  electionDate: "2026-11-03",
  tracerCandidateId: identity.candidateId,
};
const target = (
  name = "Ada Example",
  stance: "support" | "oppose" = "support",
  office = "GOVERNOR",
) => ({
  asFiled: `${stance}: ${name}`,
  name,
  stance,
  party: "DEMOCRATIC",
  office,
});
const expense = (
  micros: string,
  targets = [target()],
  date = "2026-10-14",
): ColoradoReportedExpense => ({
  reportedName: "Example Action",
  reportingCaption: "Example Action,",
  amountMicros: micros,
  amountCents:
    BigInt(micros) % 10_000n === 0n ? Number(BigInt(micros) / 10_000n) : null,
  date,
  targets,
});
function run(expenses: ColoradoReportedExpense[]) {
  const totalMicros = expenses.reduce((n, e) => n + BigInt(e.amountMicros), 0n);
  const report: ColoradoReportedIeReport = {
    jurisdiction: "STATEWIDE",
    startDate: "2022-01-01",
    endDate: "2026-10-22",
    expenses,
    parentCount: expenses.length,
    targetCount: expenses.reduce((n, e) => n + e.targets.length, 0),
    signedParentMicros: String(totalMicros),
    signedParentCents:
      totalMicros % 10_000n === 0n ? Number(totalMicros / 10_000n) : null,
    negativeParents: expenses.filter((e) => BigInt(e.amountMicros) < 0n).length,
    multipleTargetParents: expenses.filter((e) => e.targets.length > 1).length,
    fractionalCentParents: expenses.filter((e) => e.amountCents === null)
      .length,
  };
  return aggregateColoradoReportedIe(
    {
      electionYear: 2026,
      startDate: report.startDate,
      endDate: report.endDate,
      reports: [report],
      registry: [
        {
          name: "Example Action",
          committeeType: "Independent Expenditure Committee",
          status: "Active",
        },
      ],
    },
    { identity, expected },
  );
}
describe("Colorado exact native IE allocations", () => {
  it("nets signed credits and retains repeated actual occurrences", () => {
    const r = run([
      expense("100000000"),
      expense("100000000"),
      expense("-10000000"),
    ]);
    expect(r.controls).toMatchObject({
      allocatedParents: 3,
      supportCents: 19000,
    });
    expect(r.groups[0]).toMatchObject({
      amountCents: 19000,
      occurrenceCount: 3,
    });
  });
  it("leaves every shared parent unallocated, even when a target repeats", () => {
    const r = run([
      expense("100000000", [target(), target()]),
      expense("1000000"),
    ]);
    expect(r.controls).toMatchObject({
      sourceParents: 2,
      sharedCandidateParents: 1,
      allocatedParents: 1,
      supportCents: 100,
    });
  });
  it("retains sub-cent shared source amounts without splitting or rounding", () => {
    const shared = [target(), target("Grace Sample")];
    const r = run([
      expense("3000", shared),
      expense("3000", shared),
      expense("4000", shared),
      expense("1000000"),
    ]);
    expect(r.controls).toMatchObject({
      sourceFractionalCentParents: 3,
      sourceSignedParentCents: 101,
      sharedCandidateParents: 3,
      supportCents: 100,
    });
  });
  it("retains a fractional-cent source total independently of candidate cents", () => {
    const r = run([
      expense("3000", [target(), target("Grace Sample")]),
      expense("1000000"),
    ]);
    expect(r.controls).toMatchObject({
      sourceSignedParentMicros: "1003000",
      sourceSignedParentCents: null,
      supportCents: 100,
      sharedCandidateParents: 1,
    });
    expect(r.groups[0]!.amountCents).toBe(100);
  });
  it("accepts only an exact-cent grouped sum of explicit single-target entries", () =>
    expect(run([expense("3000"), expense("7000")]).groups[0]).toMatchObject({
      amountCents: 1,
      occurrenceCount: 2,
    }));
  it("holds a non-cent candidate group despite an exact whole-source total", () =>
    expect(() =>
      run([
        expense("3000"),
        expense("7000", [target(), target("Grace Sample")]),
      ]),
    ).toThrow("non_cent_candidate_group"));
  it("uses published cycle bounds instead of source-calendar years", () => {
    const r = run([
      expense("100000000", [target()], "2022-11-01"),
      expense("1000000"),
    ]);
    expect(r.controls).toMatchObject({
      outsideCycleParents: 1,
      supportCents: 100,
    });
  });
  it("never reassigns spending for another office of the same person", () =>
    expect(
      run([
        expense("100000000", [
          target("Ada Example", "support", "ATTORNEY GENERAL"),
        ]),
      ]).controls.allocatedParents,
    ).toBe(0));
  it("leaves missing-party targets unassigned without suppressing proved allocations", () => {
    const unknown = expense("100000000");
    unknown.targets[0]!.party = "Unspecified";
    expect(run([unknown, expense("1000000")]).controls).toMatchObject({
      supportCents: 100,
      allocatedParents: 1,
      sourceUnidentifiedTargets: 1,
    });
  });
  it("holds explicit party contradictions", () => {
    const e = expense("1000000");
    e.targets[0]!.party = "REPUBLICAN";
    expect(() => run([e])).toThrow("ie_target_party_conflict");
  });
  it("holds negative net groups instead of clipping them to zero", () =>
    expect(() => run([expense("-1000000")])).toThrow("negative_net_ie_group"));
  it("keeps support and opposition distinct", () =>
    expect(
      run([
        expense("1000000"),
        expense("2000000", [target("Ada Example", "oppose")]),
      ]).controls,
    ).toMatchObject({ supportCents: 100, opposeCents: 200 }));
});

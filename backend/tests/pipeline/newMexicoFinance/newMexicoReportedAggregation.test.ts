import { describe, expect, it } from "vitest";
import {
  aggregateNewMexicoReportedCommittee,
  aggregateNewMexicoReportedIe,
  type NewMexicoReportedContext,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedAggregation.js";
import type { NewMexicoReportedReceiver } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedReceiver.js";
import type {
  NewMexicoNativeDataset,
  NewMexicoReportedAllocation,
  NewMexicoReportedReceipt,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedProtocol.js";

const receiver = (): NewMexicoReportedReceiver => ({
  linkId: "synthetic-link",
  candidateId: "synthetic-app-candidate",
  electionId: "synthetic-app-election",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingId: "42",
  legacyCommitteeName: "Synthetic legacy committee",
  candidateAliases: ["Avery Quinn Sample", "Avery Sample"],
  officeScope: "statewide",
  officeName: "Governor",
  linkOfficeName: "Governor",
  district: null,
  canonicalDistrictName: "New Mexico",
  canonicalDistrictType: "statewide",
  activeCandidateOwnerCount: 1,
});
const context = (): NewMexicoReportedContext => ({
  registration: {
    locator: "synthetic-native-candidate",
    registrationLocator: "synthetic-registration",
    candidateName: "Avery Quinn Sample",
    officeName: "GOVERNOR",
    officeId: 1,
    electionId: 2,
    electionYear: 2026,
    districtId: null,
    districtText: null,
  },
  detail: {
    candidateName: "Avery Quinn Sample",
    officeName: "GOVERNOR",
    electionYear: 2026,
    memberId: "synthetic-native-member",
  },
});
const gift = (): NewMexicoReportedReceipt => ({
  transactionId: 1,
  version: 1,
  financialCycleId: 3,
  reportedName: "Synthetic Political Committee",
  nativeDonorId: "synthetic-donor",
  amountCents: 1234,
  date: "2026-10-01",
  filedDate: "2026-10-05",
  category: "MOI",
  nameProof: "transaction",
});
const financial = (): NewMexicoNativeDataset => ({
  receipts: [gift()],
  receivingRows: 3,
  receivingAmountCents: 1734,
  currentCycleRows: 2,
  financialCycleId: 3,
  excludedRows: 2,
  excludedAmountCents: 500,
  receivingScopes: [
    {
      nativeReceivingId: "synthetic-source-receiver",
      nativeRegistrationId: "synthetic-source-registration",
      reportedName: "Avery Quinn Sample",
      officeId: 1,
      electionId: 2,
      electionYear: 2026,
      districtId: null,
      financialCycleId: 3,
      rowCount: 2,
    },
    {
      nativeReceivingId: "synthetic-historical-receiver",
      nativeRegistrationId: "synthetic-historical-registration",
      reportedName: "Avery Quinn Sample",
      officeId: 99,
      electionId: 1,
      electionYear: 2026,
      districtId: 1,
      financialCycleId: 2,
      rowCount: 1,
    },
  ],
});
const allocation = (): NewMexicoReportedAllocation => ({
  transactionId: 1,
  version: 1,
  reportingName: "Synthetic Spender",
  reportingId: "synthetic-spender",
  amountCents: 1234,
  date: "2026-10-01",
  filedDate: "2026-10-05",
  targetKind: "CAN",
  targetName: "Avery Quinn Sample",
  targetDescription: "Avery Quinn Sample",
  targetId: 42,
  support: "support",
  historyCount: 0,
});
const ie = (rows: NewMexicoReportedAllocation[]) => {
  const c = context();
  return aggregateNewMexicoReportedIe({
    receiver: receiver(),
    context: c,
    registrations: [c.registration],
    financial: { allocations: rows },
  });
};
describe("New Mexico complete candidate component admission", () => {
  it("includes all qualified cash/in-kind gifts with complete signed/excluded controls", () => {
    const result = aggregateNewMexicoReportedCommittee({
      receiver: receiver(),
      context: context(),
      financial: financial(),
    });
    expect(result.groups).toEqual([
      {
        key: "SYNTHETIC POLITICAL COMMITTEE",
        reportedName: "Synthetic Political Committee",
        stance: "committee",
        amountCents: 1234,
        occurrenceCount: 1,
      },
    ]);
    expect(result.controls).toMatchObject({
      totalAmountCents: 1234,
      contributionCount: 1,
      sourceReceivingRows: 3,
      excludedRows: 2,
      excludedAmountCents: 500,
      financialCycleId: 3,
    });
  });
  it("preserves repeated separate gifts under the reported donor name", () => {
    const data = financial();
    data.receipts!.push({ ...gift(), transactionId: 2, category: "IKD" });
    data.receivingRows!++;
    data.currentCycleRows!++;
    data.receivingAmountCents! += 1234;
    data.receivingScopes![0]!.rowCount!++;
    const result = aggregateNewMexicoReportedCommittee({
      receiver: receiver(),
      context: context(),
      financial: data,
    });
    expect(result.groups[0]).toMatchObject({
      amountCents: 2468,
      occurrenceCount: 2,
    });
  });
  it.each([
    "office",
    "election",
    "district",
    "middle",
    "count",
    "money",
    "cycle",
    "unfiled",
  ])("holds committee %s conflicts without dropping a gift", (fault) => {
    const data = financial();
    if (fault === "office") data.receivingScopes![0]!.officeId = 2;
    if (fault === "election") data.receivingScopes![0]!.electionId = 1;
    if (fault === "district") data.receivingScopes![0]!.districtId = 1;
    if (fault === "middle")
      data.receivingScopes![0]!.reportedName = "Avery Riley Sample";
    if (fault === "count") data.excludedRows!++;
    if (fault === "money") data.excludedAmountCents!++;
    if (fault === "cycle") data.receipts![0]!.financialCycleId = 2;
    if (fault === "unfiled") data.receipts![0]!.filedDate = "";
    expect(() =>
      aggregateNewMexicoReportedCommittee({
        receiver: receiver(),
        context: context(),
        financial: data,
      }),
    ).toThrow();
  });
  it("uses explicit target IDs, includes both stances and excludes ballot questions/other targets", () => {
    const result = ie([
      allocation(),
      {
        ...allocation(),
        transactionId: 2,
        support: "oppose",
        amountCents: 500,
      },
      {
        ...allocation(),
        transactionId: 3,
        targetId: 99,
        targetName: "Morgan Other",
        targetDescription: "Morgan Other",
      },
      {
        ...allocation(),
        transactionId: 4,
        targetKind: "BQC",
        targetId: null,
        targetName: null,
        targetDescription: null,
      },
    ]);
    expect(result.controls).toEqual({
      supportCents: 1234,
      opposeCents: 500,
      allocationCount: 2,
      sourceAllocationRows: 4,
      excludedAllocationRows: 2,
    });
  });
  it("does not cap source groups before calculating totals", () => {
    const result = ie(
      Array.from({ length: 8 }, (_, i) => ({
        ...allocation(),
        transactionId: i + 1,
        reportingName: `Synthetic spender ${i}`,
        amountCents: 100 + i,
      })),
    );
    expect(result.groups).toHaveLength(8);
    expect(result.controls.supportCents).toBe(828);
  });
  it.each(["wrongId", "wrongName", "middle", "suffix", "partial", "unfiled"])(
    "holds IE %s instead of publishing a partial sum or false zero",
    (fault) => {
      const row = allocation();
      if (fault === "wrongId") row.targetId = 99;
      if (fault === "wrongName") {
        row.targetName = "Morgan Other";
        row.targetDescription = "Morgan Other";
      }
      if (fault === "middle") row.targetDescription = "Avery Riley Sample";
      if (fault === "suffix") row.targetDescription = "Avery Quinn Sample Sr";
      if (fault === "partial") {
        row.targetName = "Sample";
        row.targetDescription = "Sample";
        row.targetId = 99;
      }
      if (fault === "unfiled") row.filedDate = null;
      if (fault === "suffix") {
        const c = context(),
          r = receiver();
        r.candidateAliases = ["Avery Quinn Sample Jr", "Avery Sample"];
        expect(() =>
          aggregateNewMexicoReportedIe({
            receiver: r,
            context: c,
            registrations: [c.registration],
            financial: { allocations: [row] },
          }),
        ).toThrow();
      } else
        expect(() =>
          ie([allocation(), { ...row, transactionId: 2 }]),
        ).toThrow();
    },
  );
  it("rejects a target registered for two current offices without inventing an allocation office", () => {
    const c = context();
    expect(() =>
      aggregateNewMexicoReportedIe({
        receiver: receiver(),
        context: c,
        registrations: [
          c.registration,
          {
            ...c.registration,
            locator: "another-native-context",
            officeName: "STATE TREASURER",
            officeId: 99,
          },
        ],
        financial: { allocations: [allocation()] },
      }),
    ).toThrow("ambiguous_ie_registered_target_scope");
  });
});

import { describe, expect, it } from "vitest";
import {
  aggregateNebraskaReportedCommittee,
  aggregateNebraskaReportedOutside,
} from "../../../src/pipeline/nebraskaFinance/nebraskaReportedAggregation.js";
import {
  qualifyNebraskaReportedReceiver,
  type NebraskaReportedReceiver,
} from "../../../src/pipeline/nebraskaFinance/nebraskaReportedReceiver.js";
import {
  NEBRASKA_COMMITTEE_CLASSES,
  type NebraskaNativeRegistration,
  type NebraskaReportedAllocation,
  type NebraskaReportedReceipt,
} from "../../../src/pipeline/nebraskaFinance/nebraskaReportedNative.js";

const receiver: NebraskaReportedReceiver = {
  linkId: "synthetic-link",
  candidateId: "synthetic-candidate",
  electionId: "synthetic-election",
  electionYear: 2026,
  electionDate: "2026-11-03",
  candidateAliases: ["John A. Doe", "John Doe"],
  receivingId: "101",
  legacyCommitteeName: "Synthetic former label",
  officeScope: "state_upper",
  officeName: "State Senator",
  linkOfficeName: "State Senator",
  district: "1",
  canonicalDistrictName: "State Senate District 1 (2024); Nebraska",
  canonicalDistrictType: "state_upper",
  activeCandidateOwnerCount: 1,
};
const native: NebraskaNativeRegistration = {
  receivingId: "101",
  candidateName: "Doe, John A.",
  committeeName: "Synthetic current committee",
  jurisdiction: "NEBRASKA",
  office: "STATE LEGISLATURE",
  district: "1",
  election: "2026 STATEWIDE ELECTIONS",
  status: "Active",
};
const context = qualifyNebraskaReportedReceiver(receiver, [native]);
function receipt(
  type = "MONETARY",
  amountCents = 100,
): NebraskaReportedReceipt {
  return {
    receivingId: "101",
    receivingName: native.committeeName,
    reportedName: "Synthetic donor",
    contributorClass: "pac",
    transactionType: type,
    date: "2025-01-02",
    amountCents,
  };
}
function allocation(
  targetName = "John A. Doe",
  amountCents = 100,
): NebraskaReportedAllocation {
  return {
    reportedSpenderName: "Synthetic spender",
    targetName,
    officeDistrict: "NEBRASKA - STATE LEGISLATURE - District 1",
    stance: "support",
    date: "2025-01-02",
    amountCents,
  };
}

describe("Nebraska canonical receiving qualification", () => {
  it("keeps map vintage separate from election year and accepts a renamed native committee", () => {
    expect(context).toMatchObject({
      receivingId: "101",
      committeeName: native.committeeName,
      electionYear: 2026,
      district: "1",
    });
  });
  it("keeps terminated committees available for late closeout filings", () => {
    expect(
      qualifyNebraskaReportedReceiver(receiver, [
        { ...native, status: "Terminated" },
      ]).receivingId,
    ).toBe("101");
  });
  it("rejects wrong canonical district or office even when the legacy link matches the source", () => {
    expect(() =>
      qualifyNebraskaReportedReceiver(
        {
          ...receiver,
          canonicalDistrictName: "State Senate District 2 (2024); Nebraska",
        },
        [native],
      ),
    ).toThrow(/canonical_district_scope/);
    expect(() =>
      qualifyNebraskaReportedReceiver(
        { ...receiver, linkOfficeName: "Governor" },
        [native],
      ),
    ).toThrow(/canonical_election_scope/);
  });
  it("does not let a short display alias erase contradictory middle or generation evidence", () => {
    expect(() =>
      qualifyNebraskaReportedReceiver(receiver, [
        { ...native, candidateName: "Doe, John B." },
      ]),
    ).toThrow(/native_receiving_person_scope/);
    expect(() =>
      qualifyNebraskaReportedReceiver(
        { ...receiver, candidateAliases: ["John A. Doe Jr.", "John Doe"] },
        [{ ...native, candidateName: "Doe Sr., John A." }],
      ),
    ).toThrow(/native_receiving_person_scope/);
  });
  it("requires exclusive app ownership and a single active native person registration", () => {
    expect(() =>
      qualifyNebraskaReportedReceiver(
        { ...receiver, activeCandidateOwnerCount: 2 },
        [native],
      ),
    ).toThrow(/exclusive_receiving_identity/);
    expect(() =>
      qualifyNebraskaReportedReceiver(receiver, [
        native,
        { ...native, receivingId: "102" },
      ]),
    ).toThrow(/ambiguous_native_receiving_registration/);
  });
});

describe("Nebraska current reported committee gifts", () => {
  it("includes all six explicit committee classes", () => {
    const rows = (
      Object.keys(
        NEBRASKA_COMMITTEE_CLASSES,
      ) as NebraskaReportedReceipt["contributorClass"][]
    ).map((contributorClass) => ({
      ...receipt(),
      contributorClass,
      reportedName: `Synthetic ${contributorClass}`,
    }));
    const result = aggregateNebraskaReportedCommittee({
      receiver,
      context,
      receipts: rows,
    });
    expect(result.totalAmountCents).toBe(600);
    expect(result.groups).toHaveLength(6);
  });
  it("counts paid pledges and forgiveness, excluding the pledge itself and loans", () => {
    const result = aggregateNebraskaReportedCommittee({
      receiver,
      context,
      receipts: [
        receipt("PLEDGE", 500),
        receipt("PLEDGE PAYMENT RECEIVED", 100),
        receipt("LOAN", 500),
        receipt("LOAN FORGIVENESS RECEIVED", 200),
        receipt("DEBT FORGIVENESS", 300),
      ],
    });
    expect(result.totalAmountCents).toBe(600);
    expect(result.contributionCount).toBe(3);
    expect(result.excludedRows).toBe(2);
  });
  it("retains all groups before any presentation cap", () => {
    const result = aggregateNebraskaReportedCommittee({
      receiver,
      context,
      receipts: Array.from({ length: 8 }, (_, n) => ({
        ...receipt(),
        reportedName: `Synthetic donor ${n}`,
      })),
    });
    expect(result.groups).toHaveLength(8);
    expect(result.totalAmountCents).toBe(800);
  });
  it("holds unknown types, current negative gifts and mismatched receiving labels", () => {
    expect(() =>
      aggregateNebraskaReportedCommittee({
        receiver,
        context,
        receipts: [receipt("NEW TYPE", 0)],
      }),
    ).toThrow(/unknown_receipt_transaction_type/);
    expect(() =>
      aggregateNebraskaReportedCommittee({
        receiver,
        context,
        receipts: [receipt("MONETARY", -100)],
      }),
    ).toThrow(/negative_current_committee_receipt/);
    expect(() =>
      aggregateNebraskaReportedCommittee({
        receiver,
        context,
        receipts: [{ ...receipt(), receivingName: "Other synthetic receiver" }],
      }),
    ).toThrow(/native_receiving_name_changed/);
  });
});

describe("Nebraska reported candidate allocations", () => {
  it("keeps every allocation and groups reported spenders without a display cap", () => {
    const result = aggregateNebraskaReportedOutside({
      receiver,
      context,
      registrations: [native],
      allocations: Array.from({ length: 8 }, (_, n) => ({
        ...allocation(),
        reportedSpenderName: `Synthetic spender ${n}`,
      })),
    });
    expect(result.supportCents).toBe(800);
    expect(result.groups).toHaveLength(8);
    expect(result.allocationCount).toBe(8);
  });
  it("rejects a short target ambiguous between different middles, including terminated registrations", () => {
    const other = {
      ...native,
      receivingId: "102",
      candidateName: "Doe, John B.",
      status: "Terminated",
    };
    expect(() =>
      aggregateNebraskaReportedOutside({
        receiver,
        context,
        registrations: [native, other],
        allocations: [allocation("John Doe")],
      }),
    ).toThrow(/ambiguous_candidate_allocation/);
  });
  it("keeps untargeted money unassigned and refuses to certify an empty candidate total", () => {
    const unknown = {
      ...allocation("", 500),
      officeDistrict: "",
      stance: null,
    };
    expect(() =>
      aggregateNebraskaReportedOutside({
        receiver,
        context,
        registrations: [native],
        allocations: [unknown],
      }),
    ).toThrow(/uncertified_zero_with_unattributed_source_rows/);
    const result = aggregateNebraskaReportedOutside({
      receiver,
      context,
      registrations: [native],
      allocations: [allocation(), unknown],
    });
    expect(result.supportCents).toBe(100);
    expect(result.unattributedSourceRows).toBe(1);
  });
  it("holds a matching name without office or stance while excluding a different district", () => {
    expect(() =>
      aggregateNebraskaReportedOutside({
        receiver,
        context,
        registrations: [native],
        allocations: [{ ...allocation(), officeDistrict: "" }],
      }),
    ).toThrow(/unresolved_candidate_allocation_scope/);
    expect(() =>
      aggregateNebraskaReportedOutside({
        receiver,
        context,
        registrations: [native],
        allocations: [{ ...allocation(), stance: null }],
      }),
    ).toThrow(/unresolved_candidate_allocation_stance/);
    expect(
      aggregateNebraskaReportedOutside({
        receiver,
        context,
        registrations: [native],
        allocations: [
          {
            ...allocation(),
            officeDistrict: "NEBRASKA - STATE LEGISLATURE - District 2",
          },
        ],
      }).supportCents,
    ).toBe(0);
  });
});

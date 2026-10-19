import { describe, expect, it } from "vitest";
import { parseArizonaReportedRow } from "../../../src/pipeline/arizonaFinance/arizonaReportedCore.js";
import { aggregateArizonaReportedCommittee, aggregateArizonaReportedIe, validateArizonaReportedClosure, AZ_NATIVE_INCOME_CLASSES, AZ_NATIVE_IE_CLASSES } from "../../../src/pipeline/arizonaFinance/arizonaReportedAggregation.js";
import { capturedAt, nativeRow } from "./arizonaReportedFixtures.js";

const receipt = (code: string, amount: string, name: string) => parseArizonaReportedRow(nativeRow({ TransactionTypeId: code, TransactionType: AZ_NATIVE_INCOME_CLASSES[code], Amount: amount, TransactionName: name }), capturedAt);
const expenditure = (code = "215", amount = "10.0000", id = "501", name = "Example Outside Committee") => parseArizonaReportedRow(nativeRow({ TransactionTypeId: code, TransactionType: AZ_NATIVE_IE_CLASSES[code], Amount: amount, CommitteeID: id, CommitteeName: name, TransactionTypeDispositionID: "2" }), capturedAt);

describe("Arizona complete reported component aggregation", () => {
  it("includes PAC, party and candidate-committee gifts, in-kind gifts and signed recorded returns", () => {
    const a = aggregateArizonaReportedCommittee([
      receipt("115", "100.0000", "Example PAC"), receipt("185", "20.0000", "Example PAC"),
      receipt("116", "30.0000", "Example Party"), receipt("114", "50.0000", "Example Candidate Committee"),
      receipt("184", "5.0000", "Example Candidate Committee"), receipt("128", "-15.0000", "Example Candidate Committee"),
      receipt("16", "1000.0000", "Example Family"), receipt("2", "10.0000", "Example Individual"),
    ]);
    expect(a.totalCents).toBe(19000); expect(a.positiveCents).toBe(20500); expect(a.returnedCents).toBe(1500);
    expect(a.sourceRows).toBe(8); expect(a.includedRows).toBe(6); expect(a.excludedRows).toBe(2);
    expect(a.groups.map(g => [g.name, g.cents, g.occurrences]).sort()).toEqual([
      ["Example Candidate Committee", 4000, 3], ["Example PAC", 12000, 2], ["Example Party", 3000, 1],
    ]);
  });
  it("does not classify an individual, corporation, labor organization or partnership as a PAC from its name", () => {
    const a = aggregateArizonaReportedCommittee(["2", "117", "118", "119", "120"].map(code => receipt(code, "10.0000", "Example PAC sounding label")));
    expect(a.totalCents).toBe(0); expect(a.groups).toEqual([]); expect(a.excludedRows).toBe(5);
  });
  it("keeps negative excluded cash flows in full-ledger controls", () => {
    const a = aggregateArizonaReportedCommittee([receipt("59", "-20.0000", "Example Family"), receipt("115", "10.0000", "Example PAC")]);
    expect(a.sourceCents).toBe(-1000); expect(a.excludedCents).toBe(-2000); expect(a.totalCents).toBe(1000);
  });
  it("does not deduplicate repeated identical gifts or case-only reported labels", () => {
    const a = aggregateArizonaReportedCommittee([receipt("115", "10.0000", "Example PAC"), receipt("115", "10.0000", "EXAMPLE PAC"), receipt("115", "10.0000", "Example PAC")]);
    expect(a.groups).toHaveLength(1); expect(a.groups[0]!.cents).toBe(3000); expect(a.groups[0]!.occurrences).toBe(3);
  });
  it("accepts a fully returned label as verified net zero without dropping its occurrence controls", () => {
    const a = aggregateArizonaReportedCommittee([receipt("114", "10.0000", "Example Candidate Committee"), receipt("128", "-10.0000", "Example Candidate Committee")]);
    expect(a.totalCents).toBe(0); expect(a.groups[0]!.cents).toBe(0); expect(a.groups[0]!.occurrences).toBe(2);
  });
  it("holds a negative label net or unexplained positive return instead of clamping or inferring a sign", () => {
    expect(() => aggregateArizonaReportedCommittee([receipt("128", "-10.0000", "Example Candidate Committee")])).toThrow("negative_committee_label_net");
    expect(() => aggregateArizonaReportedCommittee([receipt("128", "10.0000", "Example Candidate Committee")])).toThrow("unresolved_committee_return_sign");
    expect(() => aggregateArizonaReportedCommittee([receipt("115", "-10.0000", "Example PAC")])).toThrow("unqualified_negative_committee_receipt");
  });
  it("holds unknown or mismatched native classes, even for an otherwise excluded row", () => {
    const unknown = parseArizonaReportedRow(nativeRow({ TransactionTypeId: "999", TransactionType: "Unknown new receipt" }), capturedAt);
    expect(() => aggregateArizonaReportedCommittee([unknown])).toThrow("unknown_income_class");
    const mismatched = parseArizonaReportedRow(nativeRow({ TransactionTypeId: "2" }), capturedAt);
    expect(() => aggregateArizonaReportedCommittee([mismatched])).toThrow("unknown_income_class");
  });
  it("preserves source multiplicity and both positions, including reported credit expenditures", () => {
    const a = aggregateArizonaReportedIe([expenditure(), expenditure(), expenditure("217", "5.0000")], [expenditure("215", "7.0000", "502", "Example Opposing Committee")]);
    expect(a.totalCents).toBe(3200); expect(a.supportCents).toBe(2500); expect(a.opposeCents).toBe(700);
    expect(a.groups).toHaveLength(2); expect(a.groups.find(g => g.stance === "support")!.occurrences).toBe(3);
  });
  it("holds the whole IE component for unresolved refunds, fractional allocations or nonpositive expenditures", () => {
    for (const row of [expenditure("216"), expenditure("215", "0.3333"), expenditure("215", "0.0000"), expenditure("215", "-1.0000")])
      expect(() => aggregateArizonaReportedIe([expenditure(), row], [])).toThrow();
  });
  it("does not silently round fractional receipts, even if their pair would sum to whole cents", () => {
    expect(() => aggregateArizonaReportedCommittee([receipt("115", "0.0050", "Example PAC"), receipt("115", "0.0050", "Example PAC")])).toThrow("fractional_cent_allocation");
  });
  it("holds conflicting names for one native IE filer", () => {
    expect(() => aggregateArizonaReportedIe([expenditure(), expenditure("215", "5.0000", "501", "Different reported committee")], [])).toThrow("conflicting_ie_filer_labels");
  });
  it("verifies every group before any presentation cap, including names and group scope", () => {
    const a = aggregateArizonaReportedCommittee(Array.from({ length: 8 }, (_, i) => receipt("115", "10.0000", `Example Committee ${i}`)));
    const name = structuredClone(a); name.groups[7]!.name = "Changed label";
    expect(() => validateArizonaReportedClosure(name, "committee")).toThrow("component_group_digest");
    const amount = structuredClone(a); amount.groups[7]!.cents++;
    expect(() => validateArizonaReportedClosure(amount, "committee")).toThrow();
    expect(a.groups).toHaveLength(8);
  });
  it("keeps explicit zero distinct from fabricated or internally inconsistent controls", () => {
    const a = aggregateArizonaReportedIe([], []); expect(a.totalCents).toBe(0);
    const changed = structuredClone(a); changed.sourceRows = 1;
    expect(() => validateArizonaReportedClosure(changed, "ie")).toThrow("component_totals");
    expect(() => validateArizonaReportedClosure({ ...a, hiddenTotal: 5 } as any, "ie")).toThrow();
  });
});

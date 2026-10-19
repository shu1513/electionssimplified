import { describe, expect, it } from "vitest";
import { aggregateHawaiiReportedCommittees, type HawaiiPublishedRow } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedCommitteeAggregator.js";
import { hiAdd, hiCents, hiDay, hiNameKey } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedCore.js";

const receiver = "CC9999999001";
function row(id: string, changes: HawaiiPublishedRow = {}): HawaiiPublishedRow {
  return { source_row_id: `synthetic-${id}`, reg_no: receiver, election_period: "2024-2026",
    candidate_name: "Synthetic, Recipient", office: "House", district: "99",
    contributor_type: "Noncandidate Committee", contributor_name: "Synthetic Education PAC",
    date: "2026-09-20T00:00:00.000", amount: "100.00", non_monetary_yes_or_no: "N", ...changes };
}
function aggregate(rows: HawaiiPublishedRow[], registered: string[] = [], senders: string[] = []) {
  return aggregateHawaiiReportedCommittees({ receivingCommitteeId: receiver, electionPeriod: "2024-2026",
    windowStart: "2024-11-06", windowEnd: "2026-11-03", asOfDay: "2026-10-19", rows,
    registeredNoncandidateNames: new Set(registered.map(hiNameKey)), corroboratedSenderNames: new Set(senders.map(hiNameKey)) });
}

describe("Hawaii reported committee foundation", () => {
  it("keeps all 36 groups and exact cash/in-kind totals before display limits", () => {
    const rows = Array.from({ length: 35 }, (_, i) => row(String(i), { contributor_name: `Synthetic PAC ${i}`, amount: String(i + 1) }));
    rows.push(row("party", { contributor_type: "Political Party", contributor_name: "Synthetic Political Party", amount: "250.50", non_monetary_yes_or_no: "Y" }));
    const result = aggregate(rows);
    expect(result.groups).toHaveLength(36);
    expect(result.sourceRows).toBe(36);
    expect(result.includedRows).toBe(36);
    expect(result.totalCents).toBe(88_050);
    expect(result.ledgerCents).toBe(88_050);
    expect(result.groups[0]?.evidence).toBe("declared_party");
  });

  it("retains repeated identical gifts as distinct published occurrences", () => {
    const result = aggregate([row("one"), row("two")]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.occurrences).toBe(2);
    expect(result.totalCents).toBe(20_000);
  });

  it("uses registry plus actual sender identity for a generic entity", () => {
    const name = "Synthetic Registered Entity";
    const result = aggregate([row("entity", { contributor_type: "Other Entity", contributor_name: name })], [name], [name]);
    expect(result.groups[0]?.evidence).toBe("registry_and_sender");
    expect(result.totalCents).toBe(10_000);
  });

  it("holds an uncorroborated registry-name conflict instead of dropping it", () => {
    expect(() => aggregate([row("good"), row("conflict", { contributor_type: "Other Entity", contributor_name: "Synthetic Registered Entity" })], ["Synthetic Registered Entity"]))
      .toThrow("uncorroborated_registered_entity");
  });

  it("recognizes an explicit political committee name without making all organizations committees", () => {
    const result = aggregate([
      row("pac", { contributor_type: "Other Entity", contributor_name: "Synthetic Federal PAC" }),
      row("generic", { contributor_type: "Other Entity", contributor_name: "Synthetic Neighborhood Association" }),
      row("person", { contributor_type: "Individual", contributor_name: "Synthetic Person" }),
    ]);
    expect(result.sourceRows).toBe(3);
    expect(result.ledgerCents).toBe(30_000);
    expect(result.totalCents).toBe(10_000);
    expect(result.groups[0]?.evidence).toBe("explicit_committee_name");
    expect(result.classControls["Other Entity"]?.rows).toBe(2);
  });

  it("allows a fully known ledger to have no identified committee gifts", () => {
    const result = aggregate([row("person", { contributor_type: "Individual", contributor_name: "Synthetic Person" })]);
    expect(result.ledgerCents).toBe(10_000);
    expect(result.totalCents).toBe(0);
    expect(result.groups).toEqual([]);
  });

  it.each([
    ["Candidate", "candidate_donor_class_unresolved"],
    ["Candidate Committee", "unknown_contributor_class"],
    ["Future Source Class", "unknown_contributor_class"],
  ])("holds the whole receiver for %s", (contributor_type, failure) => {
    expect(() => aggregate([row("good"), row("held", { contributor_type })])).toThrow(failure);
  });

  it.each(["0", "-1.00", "(1.00)"])("does not hide a nonpositive receipt %s", amount => {
    expect(() => aggregate([row("good"), row("bad", { amount })])).toThrow("receipt_correction");
  });

  it("rejects duplicate published row identity even when the money matches", () => {
    expect(() => aggregate([row("same"), row("same")])).toThrow("published_row_identity");
  });

  it.each(["2026-02-29T00:00:00.000", "2026-09-20T24:00:00.000", "not a date"])("rejects malformed native date %s", date => {
    expect(() => aggregate([row("bad", { date })])).toThrow("invalid_source_date");
  });

  it.each(["2024-11-05T00:00:00.000", "2026-10-20T00:00:00.000"])("holds out-of-scope or future date %s", date => {
    expect(() => aggregate([row("bad", { date })])).toThrow("receipt_window");
  });

  it("keeps unknown cash/in-kind flags and missing names out of a successful zero", () => {
    expect(() => aggregate([row("bad", { non_monetary_yes_or_no: undefined })])).toThrow("invalid_text");
    expect(() => aggregate([row("bad", { contributor_name: "Unknown" })])).toThrow("unresolved_contributor_name");
  });

  it("holds conflicting person/employment evidence for a political name", () => {
    expect(() => aggregate([row("bad", { contributor_type: "Individual" })])).toThrow("contradictory_contributor_class");
    expect(() => aggregate([row("bad", { contributor_type: "Other Entity", employer: "Synthetic Employer" })])).toThrow("contradictory_entity_employment");
  });

  it("does not borrow another receiving committee or election period", () => {
    const result = aggregate([row("own"), row("other", { reg_no: "CC9999999002", amount: "9999.00" }), row("old", { election_period: "2022-2024" })]);
    expect(result.sourceRows).toBe(1);
    expect(result.totalCents).toBe(10_000);
    expect(() => aggregate([row("other", { reg_no: "CC9999999002" })])).toThrow("receiving_ledger_missing");
  });
});

describe("Hawaii exact source primitives", () => {
  it("retains cents and signs without binary-float rounding", () => {
    expect(hiCents("$ 1,234.5")).toBe(123_450);
    expect(hiCents("0.01")).toBe(1);
    expect(hiCents("(12.34)")).toBe(-1234);
    expect(hiCents("-12.34")).toBe(-1234);
    expect(hiDay("2024-02-29T23:59:59.000")).toBe("2024-02-29");
  });
  it.each(["1,23.45", "1 0.00", "1.005", "1e3", "NaN", "--1.00", "90071992547409.92", 100])("rejects invalid or unsafe money %s", value => {
    expect(() => hiCents(value)).toThrow();
  });
  it("rejects overflow while adding individually valid amounts", () => {
    expect(() => hiAdd(hiCents("90071992547409.91"), 1)).toThrow("unsafe_money");
  });
});

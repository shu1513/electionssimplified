import { describe, expect, it } from "vitest";
import { aggregateHawaiiReportedIe } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedIeAggregator.js";
import { parseHawaiiOfficialRoster, hiCsv, hiDirectLinkSeatMatches } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedIdentity.js";
import type { HawaiiPublishedRow } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedCommitteeAggregator.js";
import { hiCents } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedCore.js";

const official = { legalName: "Synthetic, Rowan A.", ballotName: "SYNTHETIC, Rowan", contest: "STATE REPRESENTATIVE, DIST 99", status: "In General" };
const seat = { officeScope: "state_lower", canonicalOffice: "State Lower Chamber Legislator", canonicalDistrict: "99" };
function row(id: string, changes: HawaiiPublishedRow = {}): HawaiiPublishedRow {
  return { source_row_id: id, reg_no: "NCC9999999001", noncandidate_committee_name: "Synthetic Education PAC", election_period: "2024-2026",
    date: "2026-09-20T00:00:00.000", amount: "100.25", independent_expenditure: "Y",
    candidate_name_s: "Rowan A. Synthetic", support_oppose: "Support", ...changes };
}
function input(rows: HawaiiPublishedRow[] = [row("one")]) {
  const parents = [...new Set(rows.filter(r => r.independent_expenditure === "Y").map(r => r.reg_no as string))];
  return { candidateName: "Rowan Synthetic", fullName: "Rowan A. Synthetic", seat, roster: [official], rows,
    parentControls: parents.map(registration => {
      const own = rows.filter(r => r.reg_no === registration);
      return { registration, name: own[0]!.noncandidate_committee_name as string, rows: own.length,
        cents: own.reduce((n, r) => n + hiCents(r.amount), 0) };
    }), electionPeriod: "2024-2026", windowStart: "2024-11-06", windowEnd: "2026-11-03", asOfDay: "2026-10-19" };
}
describe("Hawaii independent reported spending", () => {
  it("sums all 36 spender/stance groups without a display cap or donor link", () => {
    const rows = Array.from({ length: 35 }, (_, i) => row(String(i), { reg_no: `NCC-synthetic-${i}`, noncandidate_committee_name: `Synthetic PAC ${i}`, amount: String(i + 1) }));
    rows.push(row("oppose", { support_oppose: "Oppose", amount: "10.01" }));
    const a = aggregateHawaiiReportedIe(input(rows));
    expect(a.groups).toHaveLength(36); expect(a.includedRows).toBe(36);
    expect(a.supportCents).toBe(63_000); expect(a.opposeCents).toBe(1001); expect(a.totalCents).toBe(64_001);
  });
  it("retains identical repeated B2 occurrences without inventing a cash/in-kind flag and closes non-IE parent expenses", () => {
    const a = aggregateHawaiiReportedIe(input([row("one"), row("two"), row("non-ie", { independent_expenditure: "N", amount: "999.99" })]));
    expect(a.sourceRows).toBe(3); expect(a.includedRows).toBe(2); expect(a.totalCents).toBe(20_050);
    expect(a.groups[0]?.occurrences).toBe(2);
  });
  it("holds an incomplete or mismatched spender cover, even for an unrelated target", () => {
    const i = input([row("other", { candidate_name_s: "Unrelated Person" })]);
    i.parentControls[0]!.cents++; expect(() => aggregateHawaiiReportedIe(i)).toThrow("ie_parent_control");
    i.parentControls = []; expect(() => aggregateHawaiiReportedIe(i)).toThrow("ie_parent_population");
  });
  it("rejects duplicate native occurrences", () => {
    expect(() => aggregateHawaiiReportedIe(input([row("same"), row("same")]))).toThrow("published_row_identity");
  });
  it.each(["0", "-1.00"])("holds corrections %s rather than deleting them", amount => {
    expect(() => aggregateHawaiiReportedIe(input([row("bad", { amount })]))).toThrow("expense_correction");
  });
  it.each([
    [{ support_oppose: "Unknown" }, "unknown_ie_stance"],
    [{ independent_expenditure: "Unknown" }, "unknown_ie_flag"],
    [{ date: "2026-10-20T00:00:00.000" }, "expense_window"],
    [{ candidate_name_s: "Rowan Synthetic and Other Person" }, "unallocable_ie_target"],
    [{ candidate_name_s: "All candidates" }, "unallocable_ie_target"],
    [{ candidate_name_s: "Rowan B. Synthetic" }, "unallocable_ie_target"],
    [{ candidate_name_s: "Rowan A. Synthetic Jr" }, "unallocable_ie_target"],
  ] as const)("holds malformed, future or unallocable source rows", (change, error) => {
    expect(() => aggregateHawaiiReportedIe(input([row("bad", change)]))).toThrow(error);
  });
  it("does not let a weak ballot alias hide legal middle conflict", () => {
    const i = input(); i.roster = [{ ...official, legalName: "Synthetic, Rowan B." }];
    expect(() => aggregateHawaiiReportedIe(i)).toThrow("official_receiving_seat");
  });
  it("holds a middle-name conflict with the canonical name when the official roster omits the middle", () => {
    const i = input([row("b", { candidate_name_s: "Rowan B. Synthetic" })]);
    i.roster = [{ ...official, legalName: "Synthetic, Rowan" }];
    expect(() => aggregateHawaiiReportedIe(i)).toThrow("contradictory_ie_alias");
    expect(aggregateHawaiiReportedIe({ ...i, rows: [row("a")], parentControls: input([row("a")]).parentControls }).totalCents).toBe(10_025);
  });
  it("keeps Jr. and Sr. in the same contest as two identities for an unsuffixed target", () => {
    const sr = { ...official, legalName: "Synthetic, Rowan A. Sr.", ballotName: "SYNTHETIC, Rowan Sr." };
    const jr = { ...official, legalName: "Synthetic, Rowan A. Jr.", ballotName: "SYNTHETIC, Rowan Jr." };
    const i = { ...input(), candidateName: "Rowan Synthetic Sr.", fullName: "Rowan A. Synthetic Sr.", roster: [jr, sr] };
    expect(() => aggregateHawaiiReportedIe(i)).toThrow("unallocable_ie_target");
    expect(aggregateHawaiiReportedIe({ ...i, rows: [row("sr", { candidate_name_s: "Rowan A. Synthetic Sr." })] }).totalCents).toBe(10_025);
  });
  it("holds cross-seat name ambiguity instead of assigning by canonical district alone", () => {
    const i = input(); i.roster.push({ ...official, contest: "STATE REPRESENTATIVE, DIST 98" });
    expect(() => aggregateHawaiiReportedIe(i)).toThrow("unallocable_ie_target");
  });
  it("holds a vacancy or missing official receiving seat", () => {
    const i = input(); i.roster = [{ ...official, contest: official.contest + " VACANCY" }];
    expect(() => aggregateHawaiiReportedIe(i)).toThrow("official_receiving_seat");
  });
  it("excludes an unambiguous different person while preserving a qualified zero", () => {
    const i = input([row("other", { candidate_name_s: "Different Person" })]);
    i.roster.push({ ...official, legalName: "Person, Different", ballotName: "PERSON, Different" });
    expect(aggregateHawaiiReportedIe(i).totalCents).toBe(0);
  });
});
describe("Hawaii official CSV", () => {
  it("accepts existing canonical office labels on links while still requiring the exact seat", () => {
    expect(hiDirectLinkSeatMatches({ ...seat, linkOffice: "State Lower Chamber Legislator", linkDistrict: "District 99" })).toBe(true);
    expect(hiDirectLinkSeatMatches({ ...seat, linkOffice: "House", linkDistrict: "99" })).toBe(true);
    expect(hiDirectLinkSeatMatches({ ...seat, linkOffice: "State Senator", linkDistrict: "99" })).toBe(false);
    expect(hiDirectLinkSeatMatches({ ...seat, linkOffice: "House", linkDistrict: "98" })).toBe(false);
    expect(hiDirectLinkSeatMatches({ ...seat, linkOffice: "House", linkDistrict: null })).toBe(false);
  });
  it("preserves quoted commas, BOM and CRLF", () => {
    expect(hiCsv('\uFEFFA,B\r\n"quoted, value","double ""quote"""\r\n')).toEqual([["A", "B"], ["quoted, value", 'double "quote"']]);
  });
  it.each(['A,B\n"unfinished,B', 'A,B\n"closed"garbage,B', 'A,B\nwrong', 'A,A\nx,y'])
    ("rejects incomplete or inconsistent CSV", text => expect(() => hiCsv(text)).toThrow());
  it("requires the official complete schema", () => {
    expect(() => parseHawaiiOfficialRoster("Contests,LegalName\nGOVERNOR,Synthetic")).toThrow("roster_schema");
  });
});

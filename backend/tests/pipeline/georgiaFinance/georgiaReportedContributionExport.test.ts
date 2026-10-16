import { describe, expect, it } from "vitest";
import {
  GEORGIA_REPORTED_CONTRIBUTION_EXPORT_HEADER as header,
  GeorgiaReportedContributionExportError,
  parseGeorgiaReportedContributionExport,
} from "../../../src/pipeline/georgiaFinance/georgiaReportedContributionExport.js";

type Changes = Partial<Record<(typeof header)[number], string>>;
function fields(changes: Changes = {}): string[] {
  const values: Changes = {
    "Filing Entity ID": "10", "Filing Entity Name": "Example Campaign", "Campaign Committee Name": "Example Campaign",
    "Registration Type": "Candidate/Candidate Campaign Committee", "Transaction Id": "1001", "Transaction Type": "Contribution",
    "Transaction Sub Type": "Itemized Contribution", "Contributor Type": "Non-Candidate Committee", "Contributor Last Name": "Example Committee",
    "Contributor Address Zip Code": '="30303"', "Transaction Date": "01/01/2026", "Transaction Amount": "$10.25", "Election Type": "General",
    "Election Year": "2026", "Amended": "N", "Disclosure Report Name": "2026 CCDR", "Report Filed Date": "10/15/2026", ...changes,
  };
  return header.map((key) => values[key] ?? "");
}
const quote = (s: string): string => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
function row(changes: Changes = {}): string { return fields(changes).map((s, i) => i === 18 ? s : quote(s)).join(","); }
const title = header.map(quote).join(",");
function parse(lines: string[], ending = "\n") {
  return parseGeorgiaReportedContributionExport({ bytes: new Uint8Array(Buffer.from([title, ...lines].join("\n") + ending, "latin1")), filingYear: 2026, electionYear: 2026 });
}
function contributions(result: ReturnType<typeof parse>, owner = "10") { return result.rowsByReceivingCommitteeId.get(owner) ?? []; }

describe("Georgia reported committee contribution native export", () => {
  it("includes both explicit classes, exact cents and timed/amended reported rows without a date cutoff", () => {
    const result = parse([
      row({ "Transaction Date": "01/10/2001", "Amended": "Y", "Transaction Amount": ".80" }),
      row({ "Transaction Id": "1002", "Contributor Type": "Candidate / Candidate Committee", "Transaction Amount": "$1,000.25",
        "Disclosure Report Name": "", "Report Filed Date": "", "Timed Report Name": "Two Business Day Report", "Timed Report Filed Date": "10/15/2026" }),
    ]);
    expect(result.sourceBasis).toBe("reported_committee_itemized_contributions");
    expect(contributions(result).map((r) => [r.amountCents, r.contributorType, r.amended])).toEqual([
      [80, "Non-Candidate Committee", "Y"], [100025, "Candidate / Candidate Committee", "N"],
    ]);
    expect(contributions(result)[0]?.transactionDate).toBe("01/10/2001");
    expect(result.diagnostics).toMatchObject({ eligibleRoleOccurrenceCount: 2, eligiblePositiveOccurrenceCount: 2,
      eligibleAmendedOccurrenceCount: 1, eligibleTimedOnlyOccurrenceCount: 1, includedOccurrenceCount: 2, heldReceivingCommitteeCount: 0 });
  });

  it("preserves different native-ID equal gifts and literal name variants", () => {
    const result = parse([row(), row({ "Transaction Id": "1002" }), row({ "Transaction Id": "1003", "Contributor Last Name": "Example Committee, Inc." })]);
    expect(contributions(result)).toHaveLength(3);
    expect(contributions(result).map((r) => r.transactionId)).toEqual(["1001", "1002", "1003"]);
    expect(contributions(result)[2]?.contributorName).toBe("Example Committee, Inc.");
  });

  it("supports native literal Excel ZIP guards, doubled quotes, cp1252 and genuine quoted multiline cells", () => {
    const result = parse([row({ "Contributor Last Name": 'Café "Committee"\nFund' })]);
    expect(contributions(result)[0]?.contributorName).toBe('Café "Committee" Fund');
    expect(result.diagnostics.quotedMultilineRecordCount).toBe(1);
    expect(result.diagnostics.malformedRecordCount).toBe(0);
  });

  it("treats quotes in unquoted native fields as literals without accepting after-quote garbage", () => {
    const f = fields(); f[1] = 'Example "Campaign"';
    const native = f.map((s, i) => i === 1 || i === 18 ? s : quote(s)).join(",");
    expect(contributions(parse([native]))).toHaveLength(1);
    f[1] = '"Example" garbage';
    const broken = f.map((s, i) => i === 1 || i === 18 ? s : quote(s)).join(",");
    const result = parse([row(), broken, row({ "Filing Entity ID": "20", "Transaction Id": "2001" })]);
    expect([...result.heldReceivingCommitteeIds]).toEqual(["10"]);
    expect(result.rowsByReceivingCommitteeId.has("10")).toBe(false);
    expect(contributions(result, "20")).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({ malformedRecordCount: 1, heldReceivingCommitteeCount: 1 });
  });

  it.each([14, 37])("quarantines owner of uniquely adjacent malformed unquoted continuation at field %s without repairing money", (index) => {
    const f = fields();
    const broken = `${f.slice(0, index).map(quote).join(",")},first chunk\nsecond chunk,${f.slice(index + 1).map(quote).join(",")}`;
    const result = parse([row({ "Transaction Id": "1002" }), broken, row({ "Filing Entity ID": "20", "Transaction Id": "2001" })]);
    expect([...result.heldReceivingCommitteeIds]).toEqual(["10"]);
    expect(result.rowsByReceivingCommitteeId.has("10")).toBe(false);
    expect(contributions(result, "20")).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({ malformedRecordCount: 1, malformedContinuationLineCount: 1 });
  });

  it("quarantines a width error with a native owner while preserving another receiver", () => {
    const result = parse(["10,partial", row({ "Filing Entity ID": "20", "Transaction Id": "2001" })]);
    expect(result.heldReceivingCommitteeIds.has("10")).toBe(true);
    expect(contributions(result, "20")).toHaveLength(1);
  });

  it.each(["orphan fragment", "10,partial\nunassignable,fragment", ",".repeat(42)])("fails source-wide on an unassignable orphan boundary", (broken) => {
    expect(() => parse([broken])).toThrowError(expect.objectContaining({ code: "unassignable_orphan" }));
  });

  it("does not swallow a separately framed native row after an unterminated quote", () => {
    expect(() => parse(['10,"unterminated name', row({ "Filing Entity ID": "20", "Transaction Id": "2001" })]))
      .toThrowError(expect.objectContaining({ code: "ambiguous_multiline" }));
  });

  it("rejects a full-width final record without the native terminal LF", () => {
    expect(() => parse([row()], "")).toThrowError(expect.objectContaining({ code: "truncated_source" }));
  });

  it.each(["", "\n"])("rejects an unterminated quoted tail even when the body has a terminal line break", (ending) => {
    expect(() => parse(['10,"unterminated name'], ending)).toThrowError(expect.objectContaining({ code: "truncated_source" }));
  });

  it("isolates relevant duplicate IDs even when equal, while unrelated loan duplicates do not hold", () => {
    const held = parse([row(), row(), row({ "Filing Entity ID": "20", "Transaction Id": "2001" })]);
    expect([...held.heldReceivingCommitteeIds]).toEqual(["10"]);
    expect(contributions(held, "20")).toHaveLength(1);
    const loan = row({ "Transaction Type": "Loan Received", "Transaction Sub Type": "", "Contributor Type": "Self", "Transaction Id": "9001" });
    const good = parse([loan, loan, row()]);
    expect(contributions(good)).toHaveLength(1);
    expect(good.heldReceivingCommitteeIds.size).toBe(0);
    expect(good.diagnostics.duplicateTransactionIdOccurrenceCount).toBe(1);
  });

  it("holds every receiving owner when a native ID becomes relevant after earlier unrelated occurrences", () => {
    const result = parse([
      row({ "Filing Entity ID": "10", "Transaction Type": "Loan Received", "Contributor Type": "Self" }),
      row({ "Filing Entity ID": "20", "Transaction Type": "Loan Received", "Contributor Type": "Self" }),
      row({ "Filing Entity ID": "30" }),
    ]);
    expect([...result.heldReceivingCommitteeIds].sort()).toEqual(["10", "20", "30"]);
  });

  it("excludes explicit other roles/types/allocations before unknown fields on irrelevant rows", () => {
    const changes: Changes[] = [
      { "Registration Type": "Non-Candidate Committee", "Contributor Type": "new role" },
      { "Transaction Type": "Loan Received", "Contributor Type": "new role" },
      { "Transaction Type": "Return Contribution", "Transaction Amount": "($10.25)" },
      { "Transaction Sub Type": "In-Kind Contribution", "Contributor Type": "new role" },
      { "Transaction Sub Type": "Unitemized Contribution" }, { "Transaction Sub Type": "Anonymous Contribution" },
      { "Contributor Type": "Corporation / Business / Unregistered Committee", "Election Year": "" },
      { "Contributor Type": "", "Election Year": "" },
      { "Election Year": "2028", "Contributor Type": "new role" },
    ];
    const result = parse(changes.map((v, i) => row({ ...v, "Transaction Id": String(2000 + i) })));
    expect(contributions(result)).toHaveLength(0);
    expect(result.heldReceivingCommitteeIds.size).toBe(0);
    expect(result.diagnostics.exclusions).toMatchObject({ receiver_type: 1, transaction_type: 2, transaction_subtype: 3, contributor_class: 2, allocation_year: 1 });
  });

  it.each<Changes>([
    { "Registration Type": "New receiver role" }, { "Contributor Type": "New donor role" }, { "Transaction Type": "New money type" },
    { "Transaction Sub Type": "" }, { "Election Year": "" }, { "Transaction Id": "invalid" }, { "Contributor Last Name": "" },
  ])("holds potentially eligible ambiguous source fields without leaking their values", (change) => {
    const result = parse([row(change)]);
    expect(result.heldReceivingCommitteeIds.has("10")).toBe(true);
    expect(contributions(result)).toHaveLength(0);
  });

  it.each(["1.001", "1e3", "Infinity", "$1,00.00", "-1.00", "($1.00)", "90071992547409.92"])("holds unsupported eligible money %s without rounding", (amount) => {
    const result = parse([row({ "Transaction Amount": amount })]);
    expect(result.heldReceivingCommitteeIds.has("10")).toBe(true);
    expect(result.diagnostics.holdReasonOwnerCounts.invalid_amount).toBe(1);
    expect(contributions(result)).toHaveLength(0);
  });

  it("holds unsafe per-owner accumulated cents", () => {
    const result = parse([row({ "Transaction Amount": "90071992547409.91" }), row({ "Transaction Id": "1002", "Transaction Amount": ".01" })]);
    expect(result.diagnostics.holdReasonOwnerCounts.amount_sum_overflow).toBe(1);
    expect(contributions(result)).toHaveLength(0);
  });

  it("retains explicit zero as no positive contribution and never invents gift count", () => {
    const result = parse([row({ "Transaction Amount": "0.00" })]);
    expect(contributions(result)).toHaveLength(0);
    expect(result.heldReceivingCommitteeIds.size).toBe(0);
    expect(result.diagnostics.exclusions.zero_amount).toBe(1);
    expect(result.diagnostics.includedOccurrenceCount).toBe(0);
    const empty = parse([]);
    expect(empty.diagnostics.logicalRecordCount).toBe(0);
    expect(empty.heldReceivingCommitteeIds.size).toBe(0);
  });

  it("allows periodic/timed fields and amendment flags to describe a reported row without inventing version certification", () => {
    const result = parse([row({ "Amended": "", "Disclosure Report Name": "", "Report Filed Date": "" })]);
    expect(contributions(result)).toHaveLength(1);
    expect(contributions(result)[0]).toMatchObject({ amended: null, periodicReportName: null, timedReportName: null });
  });

  it("rejects missing, extra or reordered native headers including the metadata-only loan-total column", () => {
    for (const h of [title.replace("Filing Entity ID", "Unexpected header"), `${title},Total Loan Amount`, [...header].reverse().join(",")]) {
      expect(() => parseGeorgiaReportedContributionExport({ bytes: Buffer.from(`${h}\n${row()}\n`, "latin1"), filingYear: 2026, electionYear: 2026 }))
        .toThrowError(expect.objectContaining({ code: "header" }));
    }
  });

  it("quarantines a known receiving owner's entire component for an irrelevant NUL address without stripping it", () => {
    const result = parse([row(), row({ "Transaction Id": "1002", "Contributor Type": "Corporation / Business / Unregistered Committee", "Contributor Address Line 1": "Example\0Address" }), row({ "Filing Entity ID": "20", "Transaction Id": "2001" })]);
    expect([...result.heldReceivingCommitteeIds]).toEqual(["10"]);
    expect(result.rowsByReceivingCommitteeId.has("10")).toBe(false);
    expect(contributions(result, "20")).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({ nulRecordCount: 1, holdReasonOwnerCounts: { control_character: 1 } });
  });

  it.each<Changes>([{ "Transaction Amount": "1\0.00" }, { "Contributor Type": "Non-Candidate\0 Committee" }])("holds known-owner NUL in relevant fields without inferring their contents", (change) => {
    const result = parse([row(change)]);
    expect(result.heldReceivingCommitteeIds.has("10")).toBe(true);
    expect(result.diagnostics.nulRecordCount).toBe(1);
    expect(contributions(result)).toHaveLength(0);
  });

  it("preserves proper quoted multiline framing while quarantining its NUL owner", () => {
    const result = parse([row({ "Contributor Address Line 1": "First\0line\nSecond line" }), row({ "Filing Entity ID": "20", "Transaction Id": "2001" })]);
    expect([...result.heldReceivingCommitteeIds]).toEqual(["10"]);
    expect(result.diagnostics).toMatchObject({ quotedMultilineRecordCount: 1, nulRecordCount: 1 });
    expect(contributions(result, "20")).toHaveLength(1);
  });

  it("accounts for a NUL in an attributable malformed continuation without constructing a repaired financial row", () => {
    const f = fields();
    const broken = `${f.slice(0, 14).map(quote).join(",")},first chunk\nsecond\0chunk,${f.slice(15).map(quote).join(",")}`;
    const result = parse([broken]);
    expect(result.diagnostics).toMatchObject({ malformedRecordCount: 1, malformedContinuationLineCount: 1, nulRecordCount: 1 });
    expect(result.heldReceivingCommitteeIds.has("10")).toBe(true);
    expect(contributions(result)).toHaveLength(0);
  });

  it("fails source-wide for NUL-corrupted receiving identity or header", () => {
    expect(() => parse([row({ "Filing Entity ID": "1\0" })])).toThrowError(expect.objectContaining({ code: "unassignable_orphan" }));
    expect(() => parseGeorgiaReportedContributionExport({ bytes: Buffer.from(title.replace("Filing Entity ID", "Filing Entity\0ID") + "\n", "latin1"), filingYear: 2026, electionYear: 2026 }))
      .toThrowError(expect.objectContaining({ code: "header" }));
  });

  it.each([0x81, 0x8d, 0x8f, 0x90, 0x9d])("rejects unsupported native encoding byte %s", (b) => {
    expect(() => parseGeorgiaReportedContributionExport({ bytes: Uint8Array.of(b), filingYear: 2026, electionYear: 2026 }))
      .toThrowError(expect.objectContaining({ code: "encoding" }));
  });

  it("uses constant source errors and validates source scope", () => {
    expect(() => parseGeorgiaReportedContributionExport({ bytes: new Uint8Array(), filingYear: 2025, electionYear: 2026 }))
      .toThrowError(expect.objectContaining({ code: "invalid_scope" }));
    const error = new GeorgiaReportedContributionExportError("unassignable_orphan");
    expect(error.message).toBe("Georgia contribution export unavailable: unassignable_orphan");
  });
});

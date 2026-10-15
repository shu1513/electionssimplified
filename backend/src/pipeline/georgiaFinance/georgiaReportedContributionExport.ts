/** Native filing-year TCON snapshot adapter. Gross reported itemized committee
 * contributions before separate returns; no legal-PAC or net/current-cover claim.
 * HTTP completeness, immutable originals and source clock belong to the producer.
 */
export const GEORGIA_REPORTED_CONTRIBUTION_EXPORT_HEADER = [
  "Filing Entity ID", "Filing Entity Name", "Campaign Committee Name", "Registration Type", "Registration Subtype",
  "Transaction Id", "Transaction Type", "Transaction Sub Type", "Financial Institution Name", "Contributor Type",
  "Contributor Last Name", "Contributor First Name", "Contributor Middle Name", "Contributor Country",
  "Contributor Address Line 1", "Contributor Address Line 2", "Contributor Address City", "Contributor Address State",
  "Contributor Address Zip Code", "Fiduciary Relationship", "Fiduciary Relationship Details",
  "Person Responsible for Loan Repayment Last Name", "Person Responsible for Loan Repayment First Name",
  "Person Responsible for Loan Repayment Middle Name", "Person Responsible for Loan Repayment Address line 1",
  "Person Responsible for Loan Repayment Address line 2", "Person Responsible for Loan Repayment City",
  "Person Responsible for Loan Repayment State", "Person Responsible for Loan Repayment Zip Code",
  "Contributor/Person Responsible for Loan Occupation", "Contributor/Person Responsible for Loan Employer",
  "Regulated Entity", "Regulated Entity Name", "Transaction Date", "Transaction Amount", "Election Type", "Election Year",
  "Transaction Description", "Amended", "Timed Report Name", "Timed Report Filed Date", "Disclosure Report Name", "Report Filed Date",
] as const;

export type GeorgiaReportedCommitteeContributorType = "Non-Candidate Committee" | "Candidate / Candidate Committee";
export type GeorgiaReportedCommitteeContribution = {
  receivingCommitteeId: string;
  transactionId: string;
  contributorType: GeorgiaReportedCommitteeContributorType;
  /** Normalized literal source name parts in their native column order. */
  contributorName: string;
  amountCents: number;
  allocatedElectionYear: number;
  transactionDate: string | null;
  amended: "Y" | "N" | null;
  timedReportName: string | null;
  timedReportFiledDate: string | null;
  periodicReportName: string | null;
  periodicReportFiledDate: string | null;
};
export type GeorgiaReportedContributionOwnerHoldReason =
  | "csv_quote" | "csv_width" | "control_character" | "duplicate_transaction_id" | "unknown_role" | "unknown_transaction_kind"
  | "unknown_allocation_year" | "invalid_transaction_id" | "invalid_amount" | "missing_reported_name" | "amount_sum_overflow";
export type GeorgiaReportedContributionSourceErrorCode =
  | "invalid_scope" | "encoding" | "header" | "unassignable_orphan" | "ambiguous_multiline" | "resource_limit" | "truncated_source";
export class GeorgiaReportedContributionExportError extends Error {
  constructor(public readonly code: GeorgiaReportedContributionSourceErrorCode) {
    super(`Georgia contribution export unavailable: ${code}`);
    this.name = "GeorgiaReportedContributionExportError";
  }
}
export type GeorgiaReportedContributionExportDiagnostics = {
  physicalDataLineCount: number;
  logicalRecordCount: number;
  exactWidthRecordCount: number;
  quotedMultilineRecordCount: number;
  malformedRecordCount: number;
  malformedContinuationLineCount: number;
  nulRecordCount: number;
  duplicateTransactionIdOccurrenceCount: number;
  eligibleRoleOccurrenceCount: number;
  eligiblePositiveOccurrenceCount: number;
  eligibleAmendedOccurrenceCount: number;
  eligibleTimedOnlyOccurrenceCount: number;
  includedOccurrenceCount: number;
  heldEligiblePositiveOccurrenceCount: number;
  heldReceivingCommitteeCount: number;
  holdReasonOwnerCounts: Partial<Record<GeorgiaReportedContributionOwnerHoldReason, number>>;
  exclusions: Record<"receiver_type" | "transaction_type" | "transaction_subtype" | "contributor_class" | "allocation_year" | "zero_amount", number>;
};
export type GeorgiaReportedContributionExport = {
  sourceBasis: "reported_committee_itemized_contributions";
  filingYear: number;
  electionYear: number;
  rowsByReceivingCommitteeId: ReadonlyMap<string, readonly GeorgiaReportedCommitteeContribution[]>;
  heldReceivingCommitteeIds: ReadonlySet<string>;
  diagnostics: GeorgiaReportedContributionExportDiagnostics;
};

type RecordParse = { kind: "complete"; fields: string[] } | { kind: "open_quote" | "malformed" };
const WIDTH = GEORGIA_REPORTED_CONTRIBUTION_EXPORT_HEADER.length;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_RECORD_CHARS = 1024 * 1024;
const MAX_QUOTED_LINES = 64;
const CANDIDATE_RECEIVER = "Candidate/Candidate Campaign Committee";
const COMMITTEE_CLASSES = new Set<string>(["Non-Candidate Committee", "Candidate / Candidate Committee"]);
const OTHER_CLASSES = new Set([
  "", "Corporation / Business / Unregistered Committee", "Individual", "Self", "Spouse / Dependent Child", "Lobbyist", "Financial Institution",
]);
const OTHER_TYPES = new Set(["Loan Received", "Loan Payment", "Loan Forgiven", "Interest Earned (Non-Investment Account)", "Return Contribution"]);
const OTHER_SUBTYPES = new Set(["In-Kind Contribution", "Unitemized Contribution", "Anonymous Contribution"]);
const positiveId = (s: string): boolean => /^[1-9]\d*$/.test(s);
const optional = (s: string): string | null => s.trim() || null;

/** Quotes inside an unquoted field are native literals (notably ="ZIP").
 * A quote opening a field must close strictly; quoted newlines/doubled quotes
 * retain their normal meaning. Nothing rewrites malformed quoted source cells.
 */
function parseRecord(record: string): RecordParse {
  if (record.length > MAX_RECORD_CHARS) throw new GeorgiaReportedContributionExportError("resource_limit");
  const fields: string[] = [];
  let value = "";
  let state: "start" | "unquoted" | "quoted" | "closed" = "start";
  for (const ch of record) {
    if (state === "start") {
      if (ch === '"') state = "quoted";
      else if (ch === ",") fields.push("");
      else if (ch === "\r" || ch === "\n") return { kind: "malformed" };
      else { value += ch; state = "unquoted"; }
    } else if (state === "unquoted") {
      if (ch === ",") { fields.push(value); value = ""; state = "start"; }
      else if (ch === "\r" || ch === "\n") return { kind: "malformed" };
      else value += ch;
    } else if (state === "quoted") {
      if (ch === '"') state = "closed";
      else value += ch;
    } else {
      if (ch === '"') { value += '"'; state = "quoted"; }
      else if (ch === ",") { fields.push(value); value = ""; state = "start"; }
      else return { kind: "malformed" };
    }
  }
  if (state === "quoted") return { kind: "open_quote" };
  fields.push(value);
  return { kind: "complete", fields };
}

/** A malformed name cannot corrupt this separately closed native first cell. */
function firstOwner(line: string): string | null {
  const match = /^(?:([1-9]\d*)|"([1-9]\d*)"),/.exec(line);
  return match ? (match[1] ?? match[2]!) : null;
}

function decodeNative(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_BYTES) throw new GeorgiaReportedContributionExportError("resource_limit");
  // Undefined Windows-1252 octets are not an alternate financial dialect.
  // NUL is decoded losslessly and quarantined by known receiving owner below;
  // never strip/replace text or guess an alternate encoding.
  for (const b of bytes) {
    if (b === 0x81 || b === 0x8d || b === 0x8f || b === 0x90 || b === 0x9d) {
      throw new GeorgiaReportedContributionExportError("encoding");
    }
  }
  return new TextDecoder("windows-1252", { fatal: true }).decode(bytes);
}

function exactCents(input: string): number | null {
  let s = input.trim();
  const negative = s.startsWith("(") && s.endsWith(")");
  if (negative) s = s.slice(1, -1);
  if (s.startsWith("$")) s = s.slice(1);
  if (s.startsWith("-")) return null;
  if (!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?|\.\d{1,2})$/.test(s)) return null;
  const [whole = "", decimal = ""] = s.replace(/,/g, "").split(".");
  const cents = BigInt(whole || "0") * 100n + BigInt(decimal.padEnd(2, "0"));
  if (negative || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

export function parseGeorgiaReportedContributionExport(input: {
  bytes: Uint8Array;
  filingYear: number;
  electionYear: number;
}): GeorgiaReportedContributionExport {
  if (![input.filingYear, input.electionYear].every((v) => Number.isInteger(v) && v >= 2026 && v <= 2200)) {
    throw new GeorgiaReportedContributionExportError("invalid_scope");
  }
  const source = decodeNative(input.bytes);
  // The native complete export terminates with LF. A superficially full-width
  // last record is not evidence of a complete HTTP source without this closure.
  if (!source.endsWith("\n")) throw new GeorgiaReportedContributionExportError("truncated_source");
  const lines = source.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  const header = parseRecord(lines[0] ?? "");
  if (header.kind !== "complete" || header.fields.length !== WIDTH ||
      !header.fields.every((v, i) => v === GEORGIA_REPORTED_CONTRIBUTION_EXPORT_HEADER[i])) {
    throw new GeorgiaReportedContributionExportError("header");
  }
  const diagnostics: GeorgiaReportedContributionExportDiagnostics = {
    physicalDataLineCount: lines.slice(1).filter((line) => line !== "").length,
    logicalRecordCount: 0, exactWidthRecordCount: 0, quotedMultilineRecordCount: 0, malformedRecordCount: 0,
    malformedContinuationLineCount: 0, nulRecordCount: 0, duplicateTransactionIdOccurrenceCount: 0, eligibleRoleOccurrenceCount: 0,
    eligiblePositiveOccurrenceCount: 0, eligibleAmendedOccurrenceCount: 0, eligibleTimedOnlyOccurrenceCount: 0,
    includedOccurrenceCount: 0, heldEligiblePositiveOccurrenceCount: 0, heldReceivingCommitteeCount: 0,
    holdReasonOwnerCounts: {},
    exclusions: { receiver_type: 0, transaction_type: 0, transaction_subtype: 0, contributor_class: 0, allocation_year: 0, zero_amount: 0 },
  };
  const holds = new Map<string, Set<GeorgiaReportedContributionOwnerHoldReason>>();
  const rows = new Map<string, GeorgiaReportedCommitteeContribution[]>();
  const sums = new Map<string, number>();
  const seenIds = new Map<string, { owner: string; relevant: boolean; duplicateOwners?: Set<string> }>();
  const hold = (owner: string, reason: GeorgiaReportedContributionOwnerHoldReason): void => {
    let reasons = holds.get(owner);
    if (!reasons) { reasons = new Set(); holds.set(owner, reasons); }
    reasons.add(reason);
  };

  const quarantineControlCharacter = (owner: string, hasNul: boolean): boolean => {
    if (!hasNul) return false;
    diagnostics.nulRecordCount += 1;
    hold(owner, "control_character");
    return true;
  };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "") continue;
    const owner = firstOwner(line);
    if (owner === null) throw new GeorgiaReportedContributionExportError("unassignable_orphan");
    let result = parseRecord(line);
    let hasNul = line.includes("\0");
    let consumed = 1;
    if (result.kind === "open_quote") {
      let joined = line;
      while (result.kind === "open_quote" && i + consumed < lines.length) {
        if (consumed >= MAX_QUOTED_LINES) throw new GeorgiaReportedContributionExportError("resource_limit");
        const next = lines[i + consumed]!;
        // A complete independently framed native row inside an unterminated
        // field is ambiguous. Never swallow that row into the preceding owner.
        const standalone = firstOwner(next) === null ? null : parseRecord(next);
        if (standalone?.kind === "complete" && standalone.fields.length === WIDTH) {
          throw new GeorgiaReportedContributionExportError("ambiguous_multiline");
        }
        hasNul ||= next.includes("\0");
        joined += `\n${next}`;
        consumed += 1;
        result = parseRecord(joined);
      }
      if (result.kind === "open_quote") throw new GeorgiaReportedContributionExportError("truncated_source");
      if (result.kind === "complete") diagnostics.quotedMultilineRecordCount += 1;
    }
    diagnostics.logicalRecordCount += 1;
    if (result.kind !== "complete") {
      quarantineControlCharacter(owner, hasNul);
      diagnostics.malformedRecordCount += 1;
      hold(owner, "csv_quote");
      i += consumed - 1;
      continue;
    }
    if (result.fields.length !== WIDTH) {
      diagnostics.malformedRecordCount += 1;
      hold(owner, "csv_width");
      // Quarantine an observed unquoted-newline continuation only when its
      // independent closed width complements this partial record exactly.
      // No joined financial row is constructed or used.
      const next = lines[i + consumed];
      if (next !== undefined && next !== "" && firstOwner(next) === null) {
        const tail = parseRecord(next);
        if (result.fields.length >= WIDTH || tail.kind !== "complete" || result.fields.length + tail.fields.length - 1 !== WIDTH) {
          throw new GeorgiaReportedContributionExportError("unassignable_orphan");
        }
        hasNul ||= next.includes("\0");
        diagnostics.malformedContinuationLineCount += 1;
        consumed += 1;
      }
      quarantineControlCharacter(owner, hasNul);
      i += consumed - 1;
      continue;
    }
    i += consumed - 1;
    diagnostics.exactWidthRecordCount += 1;
    const r = result.fields;
    if (r[0] !== owner) throw new GeorgiaReportedContributionExportError("unassignable_orphan");
    if (quarantineControlCharacter(owner, hasNul)) continue;
    if (r[3] === CANDIDATE_RECEIVER && !rows.has(owner)) rows.set(owner, []);

    // Explicit source exclusions precede unknown-role checks, so excluded loans
    // and businesses do not disable an independent reported-committee component.
    let exclusion: keyof typeof diagnostics.exclusions | null = null;
    if (r[3] === "Non-Candidate Committee") exclusion = "receiver_type";
    else if (OTHER_TYPES.has(r[6]!)) exclusion = "transaction_type";
    else if (OTHER_SUBTYPES.has(r[7]!)) exclusion = "transaction_subtype";
    else if (OTHER_CLASSES.has(r[9]!)) exclusion = "contributor_class";
    else if (/^\d{4}$/.test(r[36]!) && Number(r[36]) !== input.electionYear) exclusion = "allocation_year";
    const relevant = exclusion === null;
    const id = r[5]!;
    if (positiveId(id)) {
      const seen = seenIds.get(id);
      if (seen) {
        diagnostics.duplicateTransactionIdOccurrenceCount += 1;
        seen.duplicateOwners ??= new Set([seen.owner]);
        seen.duplicateOwners.add(owner);
        if (seen.relevant || relevant) {
          for (const affected of seen.duplicateOwners) hold(affected, "duplicate_transaction_id");
        }
        seen.relevant ||= relevant;
      } else seenIds.set(id, { owner, relevant });
    } else if (relevant) hold(owner, "invalid_transaction_id");
    if (exclusion !== null) { diagnostics.exclusions[exclusion] += 1; continue; }
    if (r[3] !== CANDIDATE_RECEIVER || !COMMITTEE_CLASSES.has(r[9]!)) { hold(owner, "unknown_role"); continue; }
    if (r[6] !== "Contribution" || r[7] !== "Itemized Contribution") { hold(owner, "unknown_transaction_kind"); continue; }
    if (r[36] !== String(input.electionYear)) { hold(owner, "unknown_allocation_year"); continue; }
    diagnostics.eligibleRoleOccurrenceCount += 1;
    const cents = exactCents(r[34]!);
    if (cents === null) { hold(owner, "invalid_amount"); continue; }
    if (cents === 0) { diagnostics.exclusions.zero_amount += 1; continue; }
    const contributorName = [r[10], r[11], r[12]].join(" ").replace(/\s+/g, " ").trim();
    if (!contributorName) { hold(owner, "missing_reported_name"); continue; }
    const nextSum = (sums.get(owner) ?? 0) + cents;
    if (!Number.isSafeInteger(nextSum)) { hold(owner, "amount_sum_overflow"); continue; }
    sums.set(owner, nextSum);
    diagnostics.eligiblePositiveOccurrenceCount += 1;
    if (r[38] === "Y") diagnostics.eligibleAmendedOccurrenceCount += 1;
    if (!(r[41] || r[42]) && (r[39] || r[40])) diagnostics.eligibleTimedOnlyOccurrenceCount += 1;
    const bucket = rows.get(owner) ?? [];
    bucket.push({ receivingCommitteeId: owner, transactionId: id, contributorType: r[9] as GeorgiaReportedCommitteeContributorType,
      contributorName, amountCents: cents, allocatedElectionYear: input.electionYear, transactionDate: optional(r[33]!),
      amended: r[38] === "Y" || r[38] === "N" ? r[38] : null,
      timedReportName: optional(r[39]!), timedReportFiledDate: optional(r[40]!),
      periodicReportName: optional(r[41]!), periodicReportFiledDate: optional(r[42]!) });
    rows.set(owner, bucket);
  }
  for (const [owner, reasons] of holds) {
    rows.delete(owner);
    for (const reason of reasons) diagnostics.holdReasonOwnerCounts[reason] = (diagnostics.holdReasonOwnerCounts[reason] ?? 0) + 1;
  }
  diagnostics.heldReceivingCommitteeCount = holds.size;
  diagnostics.includedOccurrenceCount = [...rows.values()].reduce((sum, bucket) => sum + bucket.length, 0);
  diagnostics.heldEligiblePositiveOccurrenceCount = diagnostics.eligiblePositiveOccurrenceCount - diagnostics.includedOccurrenceCount;
  return { sourceBasis: "reported_committee_itemized_contributions", filingYear: input.filingYear, electionYear: input.electionYear,
    rowsByReceivingCommitteeId: rows, heldReceivingCommitteeIds: new Set(holds.keys()), diagnostics };
}

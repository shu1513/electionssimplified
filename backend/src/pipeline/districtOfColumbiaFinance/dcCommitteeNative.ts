import { isDeepStrictEqual } from "node:util";

export const DC_COMMITTEE_ORIGIN = "https://efiling.ocf.dc.gov";
export const DC_COMMITTEE_REVISION = "dc-traditional-committee-v1";
export class DcCommitteeSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DcCommitteeSourceError";
  }
}
export function dcHold(code: string): never {
  throw new DcCommitteeSourceError(code);
}
export function dcCheck(value: unknown, code: string): asserts value {
  if (!value) dcHold(code);
}
export const dcKey = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toUpperCase();
export const dcText = (value: unknown): string => {
  dcCheck(typeof value === "string", "source_text");
  return value.trim().replace(/\s+/g, " ");
};
export function dcObject(value: unknown): Record<string, unknown> {
  dcCheck(
    value && typeof value === "object" && !Array.isArray(value),
    "source_object",
  );
  return value as Record<string, unknown>;
}
export function dcInteger(value: unknown, minimum = 0): number {
  dcCheck(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum,
    "source_integer",
  );
  return value;
}
export function dcId(value: unknown): string {
  dcCheck(
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
      (typeof value === "string" && /^[1-9]\d*$/.test(value)),
    "native_id",
  );
  return String(value);
}
export function dcAdd(a: number, b: number): number {
  dcCheck(
    Number.isSafeInteger(a) &&
      Number.isSafeInteger(b) &&
      Number.isSafeInteger(a + b),
    "unsafe_sum",
  );
  return a + b;
}
/** Exact decimal cents; the publisher also emits $.xx and zero-padded
 * four-decimal amounts. Fractional cents are never rounded away. */
export function dcCents(value: unknown): number {
  dcCheck(
    typeof value === "string" || typeof value === "number",
    "source_amount",
  );
  const s = String(value).trim();
  dcCheck(
    /^-?\$?(?:\d+|\d{1,3}(?:,\d{3})+|)(?:\.\d{1,4})?$/.test(s) && /\d/.test(s),
    "source_amount_format",
  );
  const raw = s.replace(/[$,]/g, ""),
    negative = raw.startsWith("-"),
    [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
  dcCheck(!/[1-9]/.test(fraction.slice(2)), "fractional_cent");
  const n =
    (BigInt(whole || "0") * 100n +
      BigInt(fraction.slice(0, 2).padEnd(2, "0"))) *
    (negative ? -1n : 1n);
  dcCheck(
    n <= BigInt(Number.MAX_SAFE_INTEGER) &&
      n >= -BigInt(Number.MAX_SAFE_INTEGER),
    "unsafe_cents",
  );
  return Number(n);
}
export function dcDay(value: unknown): string {
  dcCheck(typeof value === "string", "source_date");
  const iso =
      /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(
        value,
      ),
    slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const day =
    iso?.[1] ??
    (slash
      ? `${slash[3]}-${slash[1]!.padStart(2, "0")}-${slash[2]!.padStart(2, "0")}`
      : "");
  dcCheck(
    day &&
      (!iso || !value.includes("T") || Number.isFinite(Date.parse(value))) &&
      Number.isFinite(Date.parse(day)) &&
      new Date(day).toISOString().slice(0, 10) === day,
    "source_date_format",
  );
  return day;
}
export function dcCsv(raw: Uint8Array): {
  headers: string[];
  rows: Record<string, string>[];
} {
  let bytes = raw,
    encoding = "utf-8";
  if (raw[0] === 255 && raw[1] === 254) {
    encoding = "utf-16le";
    bytes = raw.subarray(2);
  } else if (raw[0] === 254 && raw[1] === 255) {
    encoding = "utf-16be";
    bytes = raw.subarray(2);
  } else if (
    [...raw.subarray(0, 200)].filter((v, i) => i % 2 === 1 && v === 0).length >
    50
  )
    encoding = "utf-16le";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  dcCheck(!text.includes("\0"), "csv_nul");
  const records: string[][] = [];
  let row: string[] = [],
    field = "",
    state = "start";
  const finish = () => {
    row.push(field);
    records.push(row);
    row = [];
    field = "";
    state = "start";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (state === "quoted") {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else state = "closed";
      } else field += c;
    } else if (c === ",") {
      row.push(field);
      field = "";
      state = "start";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      finish();
    } else {
      dcCheck(state !== "closed", "csv_after_quote");
      if (c === '"') {
        dcCheck(state === "start", "csv_quote");
        state = "quoted";
      } else {
        field += c;
        state = "bare";
      }
    }
  }
  dcCheck(state !== "quoted", "csv_unterminated");
  if (field || row.length || state === "closed") finish();
  const title = records.shift();
  dcCheck(
    title?.length === 1 &&
      dcText(title[0]) === "Principal Campaign Committee Contributions Report",
    "csv_publisher_title",
  );
  const headers = records.shift()!;
  dcCheck(
    isDeepStrictEqual(headers, DC_RECEIPT_HEADERS) &&
      records.every((r) => r.length === headers.length),
    "csv_columns",
  );
  return {
    headers,
    rows: records.map((r) =>
      Object.fromEntries(headers.map((h, i) => [h, r[i]!])),
    ),
  };
}
export const DC_RECEIPT_HEADERS = [
  "Committee Name",
  "Candidate Name",
  "Contributor First Name",
  "Contributor Middle Name",
  "Contributor Last Name",
  "Contributor Organization Name",
  "Contributor Street",
  "Contributor City",
  "Contributor State",
  "Contributor ZipCode",
  "Contributor Type",
  "Contribution Type",
  "Employer Name",
  "Employer Address",
  "Occupation",
  "Receipt Date",
  "Amount",
];
export function dcGridBody(
  columns: readonly string[],
  start = 0,
  length = 5000,
  draw = 1,
  orders: readonly (readonly [number, string])[] = [[0, "asc"]],
): string {
  const b = new URLSearchParams({
    draw: String(draw),
    start: String(start),
    length: String(length),
    "search[value]": "",
    "search[regex]": "false",
  });
  columns.forEach((c, i) => {
    b.set(`columns[${i}][data]`, c);
    b.set(`columns[${i}][name]`, "");
    b.set(`columns[${i}][searchable]`, "true");
    b.set(`columns[${i}][orderable]`, "true");
    b.set(`columns[${i}][search][value]`, "");
    b.set(`columns[${i}][search][regex]`, "false");
  });
  orders.forEach(([c, d], i) => {
    b.set(`order[${i}][column]`, String(c));
    b.set(`order[${i}][dir]`, d);
  });
  return b.toString();
}
export type DcCommitteeRegistration = {
  committeeId: string;
  committeeKey: string;
  candidateKey: string;
  committeeName: string;
  candidateName: string;
  electionYear: number;
  electionLabel: string;
  office: string;
  candidateApproved: boolean;
  committeeApproved: boolean;
  terminated: boolean;
};
export type DcCommitteeReceipt = {
  id: string;
  parentId: string;
  committeeKey: string;
  candidateKey: string;
  committeeName: string;
  candidateName: string;
  electionYear: number;
  filingYear: number;
  reportName: string;
  version: number;
  date: string;
  amountCents: number;
  schedule: string;
  contributorClass: string;
  transactionType: string;
  reportedName: string;
};
export function dcRegistration(raw: unknown): DcCommitteeRegistration {
  const r = dcObject(raw),
    year = dcInteger(r.ElectionYear, 2000);
  dcCheck(
    year <= 2100 &&
      r.FilerTypeId === 2 &&
      ["CandidateApproved", "CommitteeApproved", "TerminationApproved"].every(
        (k) => typeof r[k] === "boolean",
      ),
    "registry_context",
  );
  const value = {
    committeeId: dcId(r.CommitteeId),
    committeeKey: dcText(r.CommitteeKey),
    candidateKey: dcText(r.CandidateKey),
    committeeName: dcText(r.CommitteeName),
    candidateName: dcText(r.CandidateName),
    electionYear: year,
    electionLabel: dcText(r.ElectionDescription),
    office: dcText(r.Office),
    candidateApproved: r.CandidateApproved as boolean,
    committeeApproved: r.CommitteeApproved as boolean,
    terminated: r.TerminationApproved as boolean,
  };
  // Unapproved historical registrations can have blank identity labels.
  // Preserve them; receiver qualification requires complete approved evidence.
  return value;
}
const POLITICAL_CLASSES = new Set([
  "Republican",
  "Democratic",
  "PAC",
  "Other PAC or Committee",
  "Labor Sponsored PAC",
  "Corporate Sponsored PAC",
  "Committee",
]);
const SCHEDULE_CLASSES: Record<string, readonly string[]> = {
  A1: ["Republican", "Democratic"],
  A2: [
    "PAC",
    "Other PAC or Committee",
    "Labor Sponsored PAC",
    "Corporate Sponsored PAC",
  ],
  A4: ["Committee"],
};
export function dcPoliticalReceipt(
  r: Pick<DcCommitteeReceipt, "schedule" | "contributorClass">,
): boolean {
  const political = Object.hasOwn(SCHEDULE_CLASSES, r.schedule);
  dcCheck(
    political
      ? SCHEDULE_CLASSES[r.schedule]!.includes(r.contributorClass)
      : !POLITICAL_CLASSES.has(r.contributorClass),
    "committee_schedule_class_conflict",
  );
  return political;
}
export function dcReceipt(raw: unknown, year: number): DcCommitteeReceipt {
  const r = dcObject(raw),
    date = dcDay(r.TransactionDate),
    schedule = dcText(r.ScheduleCode);
  dcCheck(
    r.FilerTypeId === 2 &&
      r.ScheduleGroup === "Contributions" &&
      /^(?:A|A[1-6])$/.test(schedule) &&
      date >= `${year - 1}-01-01` &&
      date <= `${year}-12-31`,
    "receipt_scope",
  );
  const value = {
    id: dcId(r.Id),
    parentId: dcId(r.ScheduleMasterId),
    committeeKey: dcText(r.CommitteeKey),
    candidateKey: dcText(r.CandidateKey),
    committeeName: dcText(r.CommitteeName),
    candidateName: dcText(r.CandidateName),
    electionYear: dcInteger(r.ElectionYear, 2000),
    filingYear: dcInteger(r.FilingYear, 2000),
    reportName: dcText(r.ReportName),
    version: dcInteger(r.Version),
    date,
    amountCents: dcCents(r.Amount),
    schedule,
    contributorClass: dcText(r.ContributorType ?? ""),
    transactionType: dcText(r.TransactionType),
    reportedName: dcText(r.ContributorName),
  };
  dcCheck(
    value.committeeKey &&
      value.candidateKey &&
      value.committeeName &&
      value.candidateName &&
      value.electionYear <= 2100 &&
      value.filingYear <= 2100,
    "receipt_identity",
  );
  dcPoliticalReceipt(value);
  return value;
}
export function dcCsvGridClosure(
  csv: readonly Record<string, string>[],
  grid: readonly Record<string, unknown>[],
): void {
  const bag = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
  const tupleCsv = (r: Record<string, string>, full: boolean) => [
    dcText(r["Committee Name"]),
    dcText(r["Candidate Name"]),
    dcText(
      r["Contributor Organization Name"] ||
        [
          r["Contributor First Name"],
          ...(full ? [r["Contributor Middle Name"]] : []),
          r["Contributor Last Name"],
        ]
          .filter(Boolean)
          .join(" "),
    ),
    dcText(r["Contributor Type"]),
    dcText(r["Contribution Type"]),
    dcDay(r["Receipt Date"]),
    dcCents(r.Amount),
    ...[
      "Contributor Street",
      "Contributor City",
      "Contributor State",
      "Contributor ZipCode",
      "Employer Name",
      "Employer Address",
      "Occupation",
    ].map((k) => dcText(r[k])),
  ];
  const tupleGrid = (r: Record<string, unknown>) => [
    dcText(r.CommitteeName),
    dcText(r.CandidateName),
    dcText(r.ContributorName),
    dcText(r.ContributorType ?? ""),
    dcText(r.TransactionType),
    dcDay(r.TransactionDate),
    dcCents(r.Amount),
    ...[
      "Street",
      "City",
      "State",
      "ZipCode",
      "Employer",
      "EmployerAddress",
      "Occupation",
    ].map((k) => dcText(r[k] ?? "")),
  ];
  dcCheck(
    isDeepStrictEqual(
      bag(csv.map((r) => tupleCsv(r, false))),
      bag(grid.map(tupleGrid)),
    ),
    "csv_grid_context_closure",
  );
  // Native grid omits individual middle names. Eligible political names must
  // match in full, without that lossy comparison. Originals retain all names.
  dcCheck(
    isDeepStrictEqual(
      bag(
        csv
          .filter((r) => POLITICAL_CLASSES.has(r["Contributor Type"]!))
          .map((r) => tupleCsv(r, true)),
      ),
      bag(
        grid
          .filter((r) => POLITICAL_CLASSES.has(String(r.ContributorType)))
          .map(tupleGrid),
      ),
    ),
    "political_full_name_closure",
  );
}
export function dcParentClosure(
  receipts: readonly DcCommitteeReceipt[],
  raw: readonly Record<string, unknown>[],
): void {
  const version = (r: Record<string, unknown>) => {
    const status = dcText(r.ReportStatus);
    if (status === "Original") return 0;
    const m = /^Amendment(\d+)$/.exec(status);
    dcCheck(m, "parent_version");
    return Number(m[1]);
  };
  const parents = new Map<string, Record<string, unknown>[]>(),
    latest = new Map<string, number>();
  const family = (p: Record<string, unknown>) =>
    JSON.stringify([
      p.CommitteeKey,
      p.CandidateKey,
      p.FilingYear,
      p.FilerTypeReportId,
      p.ReportName,
      p.Section,
    ]);
  for (const p of raw) {
    dcCheck(p.FilerTypeId === 2 && p.Section === 1, "parent_filer_scope");
    const id = dcId(p.ScheduleMasterId),
      occurrences = parents.get(id) ?? [];
    occurrences.push(p);
    parents.set(id, occurrences);
    const k = family(p);
    latest.set(k, Math.max(latest.get(k) ?? -1, version(p)));
  }
  for (const r of receipts) {
    const matches = parents.get(r.parentId);
    dcCheck(matches?.length === 1, "ambiguous_financial_parent");
    const p = matches[0];
    dcCheck(
      p &&
        dcText(p.CommitteeKey) === r.committeeKey &&
        dcText(p.CandidateKey) === r.candidateKey &&
        dcInteger(p.FilingYear, 2000) === r.filingYear &&
        dcText(p.ReportName) === r.reportName &&
        version(p) === r.version &&
        latest.get(family(p)) === r.version,
      "current_financial_parent_binding",
    );
  }
}

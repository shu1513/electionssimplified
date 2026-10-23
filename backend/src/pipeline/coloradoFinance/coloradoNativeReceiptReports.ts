import { createRequire } from "node:module";
import {
  ColoradoReportError,
  coloradoReportCents,
  coloradoReportDate,
  coloradoReportedNameKey,
  parseColoradoReportCsv,
} from "./coloradoTracerReports.js";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    source: string,
    options: Record<string, unknown>,
  ) => {
    window: { document: Document };
  };
  VirtualConsole: new () => unknown;
};
export function coloradoReceiptCheck(
  value: unknown,
  code: string,
): asserts value {
  if (!value) throw new ColoradoReportError(code);
}
const check: typeof coloradoReceiptCheck = coloradoReceiptCheck;
export const coloradoReceiptText = (v: string) =>
  v.normalize("NFKC").replace(/\s+/gu, " ").trim();
export function coloradoReceiptDocument(
  bytes: Uint8Array,
  url?: string,
  xml = false,
): Document {
  check(
    bytes.length > 0 && bytes.length <= 64 * 1024 * 1024,
    "receipt_document_size",
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ColoradoReportError("receipt_document_utf8");
  }
  check(
    !/[\u0000\uFFFD]/u.test(text) &&
      (!xml || !/<!DOCTYPE|<!ENTITY/iu.test(text)),
    "receipt_document_characters",
  );
  try {
    const doc = new JSDOM(text, {
      ...(url ? { url } : {}),
      ...(xml ? { contentType: "application/xml" } : {}),
      virtualConsole: new VirtualConsole(),
    }).window.document;
    check(
      !xml ||
        (doc.documentElement.localName === "Report" &&
          !doc.querySelector("parsererror")),
      "receipt_document_xml",
    );
    return doc;
  } catch (error) {
    if (error instanceof ColoradoReportError) throw error;
    throw new ColoradoReportError("receipt_document_xml");
  }
}
const elements = (doc: Document | Element, tag: string) =>
  [...doc.querySelectorAll("*")].filter((e) => e.localName === tag);
const attrs = (e: Element): Record<string, string> =>
  Object.fromEntries([...e.attributes].map((a) => [a.name, a.value]));
const sorted = (rows: readonly string[][]) =>
  rows.map((r) => JSON.stringify(r)).sort();
function equal(a: readonly string[][], b: readonly string[][]): void {
  check(
    JSON.stringify(sorted(a)) === JSON.stringify(sorted(b)),
    "receipt_csv_xml_population",
  );
}
/** Compare every original XML value across observations. SSRS alone changes
 * its schema-location URI; it is transport metadata, not a filing field. */
export function coloradoReceiptXmlSnapshot(bytes: Uint8Array): string {
  const doc = coloradoReceiptDocument(bytes, undefined, true);
  const visit = (e: Element): unknown => [
    e.localName,
    [...e.attributes]
      .filter((a) => a.localName !== "schemaLocation")
      .map((a) => [a.name, a.value])
      .sort(([a], [b]) => a!.localeCompare(b!)),
    [...e.children]
      .map(visit)
      .map((value) => ({ key: JSON.stringify(value), value }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((item) => item.value),
    [...e.childNodes]
      .filter((n) => n.nodeType === 3 && n.textContent?.trim())
      .map((n) => n.textContent),
  ];
  return JSON.stringify(visit(doc.documentElement));
}
const canonical = (column: string, value: string): string => {
  const v = coloradoReceiptText(value);
  if (!v) return "";
  if (
    [
      "Amount",
      "AggregateAmount",
      "ContributionAmount",
      "CommitteeCandidateName11",
    ].includes(column)
  )
    return String(coloradoReportCents(v));
  if (
    [
      "ReceiptDate",
      "DateAccepted",
      "DueDate",
      "FiledDate",
      "CommitteeCandidateName13",
      "CommitteeCandidateName14",
    ].includes(column)
  )
    return coloradoReportDate(v);
  return v;
};
type Pair = { csv: Uint8Array; xml: Uint8Array };
export const COLORADO_COMMITTEE_CLASSES = [
  "Candidate Committee",
  "Political Committee",
  "Federal PAC",
  "Political Party Committee",
  "527 Political Organization",
  "Issue Committee",
  "Small Scale Issue Committee",
  "Small Donor Committee",
  "Independent Expenditure Committee",
] as const;
export type ColoradoNativeCommittee = {
  name: string;
  committeeType: string;
  status: string;
};
const REGISTRY_COLUMNS = [
  "JurisdictionName",
  "CommitteeType",
  "CommitteeName",
  "CandidateName",
  "RegAgentName",
  "ReportingSchedule",
  "OrganizationStatus",
];
export function parseColoradoCommitteeRegistry(
  input: Pair & {
    committeeType: string;
    jurisdiction: string;
    asOf: string;
  },
): ColoradoNativeCommittee[] {
  check(
    (COLORADO_COMMITTEE_CLASSES as readonly string[]).includes(
      input.committeeType,
    ),
    "receipt_registry_class",
  );
  const doc = coloradoReceiptDocument(input.xml, undefined, true),
    root = doc.documentElement;
  const day = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(input.asOf));
  check(
    root.getAttribute("Name") === "rpt_CF_COMM_001" &&
      root.getAttribute("OfficeSelection") === input.committeeType &&
      coloradoReportedNameKey(
        root.getAttribute("JurisdictionSelection") ?? "",
      ) === coloradoReportedNameKey(input.jurisdiction) &&
      root.getAttribute("ActiveOnlySelection") === `All Statuses on ${day}`,
    "receipt_registry_scope",
  );
  const csv = parseColoradoReportCsv(input.csv),
    header = csv.findIndex(
      (r) => JSON.stringify(r) === JSON.stringify(REGISTRY_COLUMNS),
    );
  check(
    header === 3 &&
      csv[0]!.every(
        (k, i) =>
          coloradoReceiptText(csv[1]?.[i] ?? "") ===
          coloradoReceiptText(root.getAttribute(k) ?? ""),
      ) &&
      csv[1]!.length === csv[0]!.length &&
      csv[2]!.every((v) => !v),
    "receipt_registry_csv_metadata",
  );
  const expanded: string[][] = [],
    rows: ColoradoNativeCommittee[] = [];
  for (const e of elements(doc, "Detail")) {
    let parent = e.parentElement;
    while (parent && parent.localName !== "Group1")
      parent = parent.parentElement;
    check(
      parent &&
        [...e.attributes].every((a) => REGISTRY_COLUMNS.includes(a.name)),
      "receipt_registry_owner",
    );
    const all = { ...attrs(parent), ...attrs(e) },
      name = coloradoReceiptText(e.getAttribute("CommitteeName") ?? ""),
      status = coloradoReceiptText(e.getAttribute("OrganizationStatus") ?? "");
    check(
      name &&
        name.length <= 1000 &&
        status &&
        e.getAttribute("CommitteeType") === input.committeeType,
      "receipt_registry_row",
    );
    expanded.push(
      REGISTRY_COLUMNS.map((k) => coloradoReceiptText(all[k] ?? "")),
    );
    rows.push({ name, committeeType: input.committeeType, status });
  }
  const data = csv.slice(header + 1).filter((r) => r.some(Boolean));
  check(
    data.every((r) => r.length === REGISTRY_COLUMNS.length),
    "receipt_registry_csv_width",
  );
  equal(
    expanded,
    data.map((r) => r.map(coloradoReceiptText)),
  );
  return rows;
}
const RECEIPT_METADATA = [
  "Jurisdiction",
  "Election",
  "Committee",
  "ReportPeriod",
  "DueDate",
  "FiledDate",
];
export const COLORADO_RECEIPT_COLUMNS = [
  "ContributorName",
  "ContributorType",
  "ContributorEmployer",
  "ReceiptDate",
  "ReceiptType",
  "ContributorCity",
  "ContributorState",
  "ContributorZIP",
  "ContributorOccupation",
  "ContributionType",
  "ReferenceNumber",
  "Amount",
  "AggregateAmount",
];
export type ColoradoNativeReceipt = {
  name: string;
  contributorType: string;
  employer: string;
  occupation: string;
  date: string;
  kind: string;
  paymentMethod: string;
  amountCents: number;
};
export type ColoradoNativeReceiptReport = {
  start: string;
  end: string;
  due: string;
  filed: string;
  rows: ColoradoNativeReceipt[];
  itemizedCents: number;
  nonitemizedCents: number;
  returnedCents: number;
};
export function parseColoradoNativeReceiptReport(
  input: Pair & {
    receivingName: string;
    year: number;
    start: string;
    end: string;
  },
): ColoradoNativeReceiptReport {
  const doc = coloradoReceiptDocument(input.xml, undefined, true),
    root = doc.documentElement;
  const dates = (root.getAttribute("ReportPeriod") ?? "").match(
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/gu,
  );
  check(
    root.getAttribute("Name") === "rpt_CF_CONT_001" &&
      root.getAttribute("Jurisdiction") === "STATEWIDE" &&
      root.getAttribute("Election") === `${input.year} NOVEMBER ELECTION` &&
      coloradoReportedNameKey(root.getAttribute("Committee") ?? "") ===
        coloradoReportedNameKey(input.receivingName) &&
      dates?.length === 2 &&
      coloradoReportDate(dates[0]!) === input.start &&
      coloradoReportDate(dates[1]!) === input.end,
    "receipt_report_scope",
  );
  const csv = parseColoradoReportCsv(input.csv);
  check(
    JSON.stringify(csv[0]) === JSON.stringify(RECEIPT_METADATA) &&
      csv[1]?.length === RECEIPT_METADATA.length &&
      RECEIPT_METADATA.every(
        (k, i) =>
          canonical(k, csv[1]![i]!) ===
          canonical(k, root.getAttribute(k) ?? ""),
      ),
    "receipt_csv_metadata",
  );
  let header = 2;
  while (csv[header]?.every((v) => !v)) header++;
  check(
    JSON.stringify(csv[header]) === JSON.stringify(COLORADO_RECEIPT_COLUMNS),
    "receipt_csv_columns",
  );
  const data = csv.slice(header + 1).filter((r) => r.some(Boolean));
  check(
    data.every((r) => r.length === COLORADO_RECEIPT_COLUMNS.length),
    "receipt_csv_width",
  );
  const details = elements(doc, "Details");
  check(
    details.every(
      (e) =>
        e.hasAttribute("ReceiptDate") &&
        e.hasAttribute("Amount") &&
        [...e.attributes].every((a) =>
          COLORADO_RECEIPT_COLUMNS.includes(a.name),
        ),
    ),
    "receipt_xml_columns",
  );
  equal(
    details.map((e) =>
      COLORADO_RECEIPT_COLUMNS.map((k) =>
        canonical(k, e.getAttribute(k) ?? ""),
      ),
    ),
    data.map((r) =>
      r.map((v, i) => canonical(COLORADO_RECEIPT_COLUMNS[i]!, v)),
    ),
  );
  let itemizedCents = 0,
    nonitemizedCents = 0,
    returnedCents = 0;
  const rows = details.map((e) => {
    const get = (k: string) => coloradoReceiptText(e.getAttribute(k) ?? "");
    const kind = get("ContributionType"),
      amountCents = coloradoReportCents(get("Amount")),
      date = coloradoReportDate(get("ReceiptDate"));
    check(
      [
        "Monetary (Itemized)",
        "Monetary (Non-Itemized)",
        "Returned Contributions",
      ].includes(kind),
      "receipt_unqualified_kind",
    );
    check(
      kind === "Returned Contributions" ? amountCents < 0 : amountCents >= 0,
      "receipt_kind_sign",
    );
    // Nonitemized rows can carry an agency placeholder date outside this
    // period. They close the filing total but never identify named donors.
    check(
      kind === "Monetary (Non-Itemized)" ||
        (date >= input.start && date <= input.end),
      "receipt_date_outside_period",
    );
    if (kind === "Monetary (Itemized)")
      itemizedCents = coloradoReceiptAdd(itemizedCents, amountCents);
    else if (kind === "Monetary (Non-Itemized)")
      nonitemizedCents = coloradoReceiptAdd(nonitemizedCents, amountCents);
    else returnedCents = coloradoReceiptAdd(returnedCents, amountCents);
    return {
      name: get("ContributorName"),
      contributorType: get("ContributorType"),
      employer: get("ContributorEmployer"),
      occupation: get("ContributorOccupation"),
      date,
      kind,
      paymentMethod: get("ReceiptType"),
      amountCents,
    };
  });
  return {
    start: input.start,
    end: input.end,
    due: root.getAttribute("DueDate")!,
    filed: root.getAttribute("FiledDate")!,
    rows,
    itemizedCents,
    nonitemizedCents,
    returnedCents,
  };
}
export function coloradoReceiptAdd(a: number, b: number): number {
  check(
    Number.isSafeInteger(a) &&
      Number.isSafeInteger(b) &&
      Number.isSafeInteger(a + b),
    "receipt_unsafe_sum",
  );
  return a + b;
}
/** The native filing-history grid publishes local minute precision. Retain
 * full XML seconds separately; never turn a native local clock into UTC. */
export function coloradoReceiptFiledMinute(value: string): string {
  const m = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/iu.exec(
    value.trim(),
  );
  check(
    m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) <= 59,
    "receipt_history_filed_clock",
  );
  const hour = (Number(m[2]) % 12) + (m[4]!.toUpperCase() === "PM" ? 12 : 0);
  return `${coloradoReportDate(m[1]!)}T${String(hour).padStart(2, "0")}:${m[3]}`;
}
const MAJOR_METADATA = [
  "CommitteeName",
  "CommitteeCandidateName3",
  "CommitteeCandidateName4",
  "CommitteeCandidateName5",
  "CommitteeCandidateName8",
  "CommitteeCandidateName9",
  "CommitteeCandidateName13",
  "CommitteeCandidateName11",
  "txtRegAgtName",
  "CommitteeCandidateName14",
];
const MAJOR_COLUMNS = [
  "Textbox100",
  "Textbox252",
  "DateAccepted",
  "DonorName",
  "Textbox265",
  "DonorAddress",
  "Textbox256",
  "ContributionAmount",
  "Textbox119",
  "Description",
  "AggregateAmount",
  "EmployerName",
  "DonorOccupation",
  "ElectioneeringCommunication",
];
const MAJOR_LOAN_COLUMNS = [
  "Textbox165",
  "LoanSourceAddress",
  "Textbox231",
  "LoanAmount",
  "InterestRate",
  "DateLoanReceived",
  "Name",
  "Address",
  "GuaranteedAmount",
];
export type ColoradoNativeMajorNotice = {
  date: string;
  filed: string;
  rows: { name: string; date: string; amountCents: number }[];
};
/** Notices corroborate regular cash occurrences; they never add money. A
 * notice with loans or unrepresented rows holds this component for review. */
export function parseColoradoNativeMajorNotice(
  input: Pair & { receivingId: string; receivingName: string; date: string },
): ColoradoNativeMajorNotice {
  const doc = coloradoReceiptDocument(input.xml, undefined, true),
    meta = elements(doc, "Details"),
    gifts = elements(doc, "Details2"),
    loans = elements(doc, "ScheduleC_Loans");
  check(
    doc.documentElement.getAttribute("Name") === "rpt_CF_FILE_005" &&
      meta.length === 1 &&
      loans.length === 1 &&
      !loans[0]!.children.length,
    "receipt_major_definition",
  );
  const m = meta[0]!;
  check(
    m.getAttribute("CommitteeCandidateName8") === input.receivingId &&
      coloradoReportedNameKey(m.getAttribute("CommitteeName") ?? "") ===
        coloradoReportedNameKey(input.receivingName) &&
      coloradoReportDate(m.getAttribute("CommitteeCandidateName13") ?? "") ===
        input.date,
    "receipt_major_identity",
  );
  check(
    [...m.attributes].every((a) => MAJOR_METADATA.includes(a.name)) &&
      gifts.every((e) =>
        [...e.attributes].every((a) => MAJOR_COLUMNS.includes(a.name)),
      ),
    "receipt_major_columns",
  );
  const csv = parseColoradoReportCsv(input.csv);
  check(
    JSON.stringify(csv[0]) === JSON.stringify(MAJOR_METADATA) &&
      csv[1]?.length === MAJOR_METADATA.length &&
      csv[2]?.every((v) => !v) &&
      JSON.stringify(csv[3]) === JSON.stringify(MAJOR_COLUMNS),
    "receipt_major_csv_metadata",
  );
  equal(
    [MAJOR_METADATA.map((k) => canonical(k, m.getAttribute(k) ?? ""))],
    [csv[1]!.map((v, i) => canonical(MAJOR_METADATA[i]!, v))],
  );
  const data: string[][] = [];
  let edge = 4;
  for (; csv[edge]?.some(Boolean); edge++) {
    check(
      csv[edge]!.length === MAJOR_COLUMNS.length,
      "receipt_major_csv_width",
    );
    data.push(csv[edge]!);
  }
  check(
    csv[edge]?.every((v) => !v) &&
      JSON.stringify(csv[edge + 1]) === JSON.stringify(MAJOR_LOAN_COLUMNS) &&
      csv[edge + 2]?.length === MAJOR_LOAN_COLUMNS.length &&
      csv[edge + 2]!.every((v) => !v) &&
      csv.slice(edge + 3).every((r) => r.every((v) => !v)),
    "receipt_major_csv_suffix",
  );
  equal(
    gifts.map((e) =>
      MAJOR_COLUMNS.map((k) => canonical(k, e.getAttribute(k) ?? "")),
    ),
    data.map((r) => r.map((v, i) => canonical(MAJOR_COLUMNS[i]!, v))),
  );
  const rows = gifts.map((e) => ({
    name: coloradoReceiptText(e.getAttribute("DonorName") ?? ""),
    date: coloradoReportDate(e.getAttribute("DateAccepted") ?? ""),
    amountCents: coloradoReportCents(
      e.getAttribute("ContributionAmount") ?? "",
    ),
  }));
  check(
    rows.length > 0 &&
      rows.every((r) => r.name && r.date === input.date && r.amountCents > 0) &&
      rows.reduce((n, r) => coloradoReceiptAdd(n, r.amountCents), 0) ===
        coloradoReportCents(m.getAttribute("CommitteeCandidateName11") ?? ""),
    "receipt_major_total",
  );
  return {
    date: input.date,
    filed: m.getAttribute("CommitteeCandidateName14")!,
    rows,
  };
}

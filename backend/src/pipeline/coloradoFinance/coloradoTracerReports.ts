import { createRequire } from "node:module";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    source: string,
    options: { contentType: "application/xml" },
  ) => { window: { document: Document } };
};

/** Native SSRS exports are whole observations. CSV expands an expense once per
 * target; XML owns the monetary parent. Never sum the expanded CSV amounts. */
export type ColoradoReportedTarget = {
  asFiled: string;
  name: string | null;
  stance: "support" | "oppose" | null;
  party: string;
  office: string;
};
export type ColoradoReportedExpense = {
  reportedName: string;
  reportingCaption: string;
  date: string;
  amountCents: number;
  targets: ColoradoReportedTarget[];
};
export type ColoradoReportedIeReport = {
  jurisdiction: string;
  startDate: string;
  endDate: string;
  expenses: ColoradoReportedExpense[];
  parentCount: number;
  targetCount: number;
  signedParentCents: number;
  negativeParents: number;
  multipleTargetParents: number;
};
export type ColoradoRegisteredReporter = {
  name: string;
  committeeType: string;
  status: string;
};

const IE_COLUMNS = [
  "Textbox12",
  "Textbox20",
  "PayeeZipCode",
  "Textbox21",
  "ExpenditureDate",
  "Textbox48",
  "Textbox49",
  "Textbox6",
  "Office",
  "Textbox99",
] as const;
const REGISTRY_COLUMNS = [
  "JurisdictionName",
  "CommitteeType",
  "CommitteeName",
  "CandidateName",
  "RegAgentName",
  "ReportingSchedule",
  "OrganizationStatus",
] as const;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 1_000_000;
export class ColoradoReportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ColoradoReportError";
  }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ColoradoReportError(code);
}
function add(a: number, b: number): number {
  check(
    Number.isSafeInteger(a) &&
      Number.isSafeInteger(b) &&
      Number.isSafeInteger(a + b),
    "unsafe_source_sum",
  );
  return a + b;
}
export function coloradoReportedNameKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toUpperCase();
}
function text(value: string | null, code = "missing_source_field"): string {
  check(
    typeof value === "string" &&
      value.length <= 10_000 &&
      !value.includes("\uFFFD"),
    code,
  );
  return value;
}
/** Decimal arithmetic, including source decimal places beyond cents only when
 * they are zero. Floating-point multiplication is not a money parser. */
export function coloradoReportCents(value: string): number {
  let raw = value.trim().replace(/[$,]/gu, "");
  if (/^\(.*\)$/u.test(raw)) raw = `-${raw.slice(1, -1)}`;
  const m = /^(-?)(\d+)(?:\.(\d{1,8}))?$/u.exec(raw);
  check(m && (!m[3] || /^\d{0,2}0*$/u.test(m[3])), "invalid_source_cents");
  const n =
    BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0").slice(0, 2));
  const signed = m[1] ? -n : n;
  check(
    signed >= BigInt(Number.MIN_SAFE_INTEGER) &&
      signed <= BigInt(Number.MAX_SAFE_INTEGER),
    "unsafe_source_cents",
  );
  return Number(signed);
}
export function coloradoReportDate(value: string): string {
  const raw = value.trim();
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z)?)?$/u.exec(
      raw,
    );
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(raw);
  check(iso || us, "invalid_source_date");
  const y = Number(iso?.[1] ?? us![3]),
    m = Number(iso?.[2] ?? us![1]),
    d = Number(iso?.[3] ?? us![2]);
  check(
    y >= 1900 &&
      y <= 2100 &&
      (!iso?.[4] ||
        (Number(iso[4]) <= 23 && Number(iso[5]) <= 59 && Number(iso[6]) <= 59)),
    "invalid_source_date",
  );
  const day = new Date(Date.UTC(y, m - 1, d));
  check(
    day.getUTCFullYear() === y &&
      day.getUTCMonth() === m - 1 &&
      day.getUTCDate() === d,
    "invalid_source_date",
  );
  return day.toISOString().slice(0, 10);
}
function decode(bytes: Uint8Array): string {
  check(
    bytes.byteLength > 0 && bytes.byteLength <= MAX_BYTES,
    "source_byte_limit",
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ColoradoReportError("invalid_source_utf8");
  }
}
/** Strict framing, including every suffix after a row/resource limit. */
export function parseColoradoReportCsv(bytes: Uint8Array): string[][] {
  const input = decode(bytes).replace(/^\uFEFF/u, "");
  check(!input.includes("\0"), "invalid_source_csv");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    state: "start" | "bare" | "quoted" | "closed" = "start";
  const cell = () => {
    row.push(field);
    field = "";
    state = "start";
  };
  const line = () => {
    cell();
    rows.push(row);
    row = [];
    check(rows.length <= MAX_ROWS + 10, "source_row_limit");
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (state === "quoted") {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else state = "closed";
      } else field += c;
      continue;
    }
    if (c === ",") {
      cell();
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r") {
        check(input[i + 1] === "\n", "invalid_source_csv_newline");
        i++;
      }
      line();
      continue;
    }
    check(state !== "closed", "invalid_source_csv_quote_suffix");
    if (c === '"') {
      check(state === "start", "invalid_source_csv_quote");
      state = "quoted";
    } else {
      field += c;
      state = "bare";
    }
  }
  check(state !== "quoted", "unterminated_source_csv_quote");
  if (state !== "start" || field.length || row.length) line();
  return rows;
}
function xml(bytes: Uint8Array): Document {
  const source = decode(bytes);
  check(!/<!DOCTYPE|<!ENTITY/iu.test(source), "xml_declarations_prohibited");
  try {
    const doc = new JSDOM(source, { contentType: "application/xml" }).window
      .document;
    check(
      doc.documentElement.localName === "Report" &&
        !doc.querySelector("parsererror"),
      "invalid_source_xml",
    );
    return doc;
  } catch (e) {
    if (e instanceof ColoradoReportError) throw e;
    throw new ColoradoReportError("invalid_source_xml");
  }
}
function elements(root: Document | Element, name: string): Element[] {
  return [...root.getElementsByTagName("*")].filter(
    (e) => e.localName === name,
  );
}
function attributes(e: Element): Record<string, string> {
  return Object.fromEntries(
    [...e.attributes].map((a) => [a.name, text(a.value)]),
  );
}
function ancestor(e: Element, name: string): Element | null {
  for (let p = e.parentElement; p; p = p.parentElement)
    if (p.localName === name) return p;
  return null;
}
function caption(value: string): string {
  const m = /^(.*?)Expenditure Total:\s*(.*)$/su.exec(value);
  check(m && m[1]!.trim(), "missing_native_group_control");
  return `${coloradoReportedNameKey(m[1]!)}:${coloradoReportCents(m[2]!)}`;
}
function canonical(column: string, value: string): string {
  if (column === "Textbox12") return caption(value);
  if (column === "Textbox21") return String(coloradoReportCents(value));
  if (
    column === "ExpenditureDate" ||
    column === "BeginDate" ||
    column === "EndDate"
  )
    return coloradoReportDate(value);
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
function multiset(rows: readonly string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function equalOccurrences(
  a: readonly string[][],
  b: readonly string[][],
): void {
  check(a.length === b.length, "csv_xml_occurrence_count");
  const counts = multiset(a),
    other = multiset(b);
  check(
    counts.size === other.size &&
      [...counts].every(([k, n]) => other.get(k) === n),
    "csv_xml_occurrences_changed",
  );
}
function csvData(
  bytes: Uint8Array,
  columns: readonly string[],
  root: Element,
): string[][] {
  const rows = parseColoradoReportCsv(bytes);
  check(
    rows.length >= 3 &&
      rows[0]!.length === rows[1]!.length &&
      rows[0]!.length > 0,
    "native_csv_metadata",
  );
  const seen = new Set<string>();
  for (const [i, key] of rows[0]!.entries()) {
    check(!seen.has(key) && root.hasAttribute(key), "native_csv_metadata");
    seen.add(key);
    check(
      canonical(key, rows[1]![i]!) === canonical(key, root.getAttribute(key)!),
      "csv_xml_scope_changed",
    );
  }
  let index = 2;
  while (rows[index]?.every((c) => c === "")) index++;
  check(
    JSON.stringify(rows[index]) === JSON.stringify(columns),
    "native_csv_columns",
  );
  const data = rows.slice(index + 1).filter((r) => !r.every((c) => c === ""));
  check(
    data.length <= MAX_ROWS && data.every((r) => r.length === columns.length),
    "native_csv_row_width",
  );
  return data.map((r) => r.map((v, i) => canonical(columns[i]!, v)));
}
function labeled(value: string, label: string): string {
  const raw = value.trim();
  check(raw.startsWith(`${label}:`), "native_target_label");
  return raw.slice(label.length + 1).trim();
}
export function parseColoradoIndependentExpenditureReport(input: {
  csv: Uint8Array;
  xml: Uint8Array;
  startDate: string;
  endDate: string;
}): ColoradoReportedIeReport {
  const doc = xml(input.xml),
    root = doc.documentElement;
  check(
    root.getAttribute("Name") === "rpt_CF_EXPN_008",
    "native_ie_report_kind",
  );
  const startDate = coloradoReportDate(text(root.getAttribute("BeginDate"))),
    endDate = coloradoReportDate(text(root.getAttribute("EndDate")));
  check(
    startDate === input.startDate &&
      endDate === input.endDate &&
      startDate <= endDate,
    "native_ie_date_scope",
  );
  const jurisdiction = text(root.getAttribute("JurisdictionName")).trim();
  check(jurisdiction.length > 0, "native_ie_jurisdiction");
  const expenses: ColoradoReportedExpense[] = [],
    expanded: string[][] = [];
  let signedParentCents = 0,
    targetCount = 0,
    negativeParents = 0,
    multipleTargetParents = 0;
  for (const group of elements(doc, "Group1")) {
    const groupFields = attributes(group),
      control = caption(text(group.getAttribute("Textbox12")));
    let sum = 0;
    for (const parent of elements(group, "Group2").filter(
      (e) => ancestor(e, "Group1") === group,
    )) {
      const fields = attributes(parent),
        amountCents = coloradoReportCents(
          text(parent.getAttribute("Textbox21")),
        );
      const date = coloradoReportDate(
        text(parent.getAttribute("ExpenditureDate")),
      );
      check(
        date >= startDate && date <= endDate,
        "native_ie_event_outside_scope",
      );
      const reportingCaption = text(parent.getAttribute("Textbox20")).trim();
      check(reportingCaption.endsWith(","), "native_reporting_caption");
      const reportedName = reportingCaption.slice(0, -1).trim();
      check(
        reportedName.length > 0 && reportedName.length <= 1000,
        "native_reporting_name",
      );
      const targets: ColoradoReportedTarget[] = [];
      for (const detail of elements(parent, "Details").filter(
        (e) => ancestor(e, "Group2") === parent,
      )) {
        const targetFields = attributes(detail),
          asFiled = text(detail.getAttribute("Textbox6")).trim();
        const m = /^(Supporting|Opposing):\s*(.+)$/su.exec(asFiled);
        targets.push({
          asFiled,
          name: m?.[2]?.trim() ?? null,
          stance: m ? (m[1] === "Supporting" ? "support" : "oppose") : null,
          party: labeled(text(detail.getAttribute("Office")), "Party"),
          office: labeled(text(detail.getAttribute("Textbox99")), "Office"),
        });
        const all = { ...groupFields, ...fields, ...targetFields };
        expanded.push(
          IE_COLUMNS.map((k) => canonical(k, text(all[k] ?? null))),
        );
      }
      check(targets.length > 0, "native_ie_parent_without_targets");
      sum = add(sum, amountCents);
      targetCount = add(targetCount, targets.length);
      negativeParents += Number(amountCents < 0);
      multipleTargetParents += Number(targets.length > 1);
      expenses.push({
        reportingCaption,
        reportedName,
        date,
        amountCents,
        targets,
      });
      check(
        expenses.length <= MAX_ROWS && targetCount <= MAX_ROWS,
        "source_row_limit",
      );
    }
    check(
      Number(control.slice(control.lastIndexOf(":") + 1)) === sum,
      "native_ie_parent_money_control",
    );
    signedParentCents = add(signedParentCents, sum);
  }
  check(
    elements(doc, "Group2").length === expenses.length &&
      elements(doc, "Details").length === targetCount,
    "unowned_native_ie_rows",
  );
  equalOccurrences(expanded, csvData(input.csv, IE_COLUMNS, root));
  return {
    jurisdiction,
    startDate,
    endDate,
    expenses,
    parentCount: expenses.length,
    targetCount,
    signedParentCents,
    negativeParents,
    multipleTargetParents,
  };
}
export function parseColoradoIeReporterRegistry(input: {
  csv: Uint8Array;
  xml: Uint8Array;
}): ColoradoRegisteredReporter[] {
  const doc = xml(input.xml),
    root = doc.documentElement,
    rows: ColoradoRegisteredReporter[] = [],
    expanded: string[][] = [];
  check(
    root.getAttribute("Name") === "rpt_CF_COMM_001",
    "native_ie_registry_report_kind",
  );
  for (const group of elements(doc, "Group1")) {
    for (const detail of elements(group, "Detail").filter(
      (e) => ancestor(e, "Group1") === group,
    )) {
      const all = { ...attributes(group), ...attributes(detail) },
        name = text(detail.getAttribute("CommitteeName")).trim();
      const committeeType = text(detail.getAttribute("CommitteeType")).trim(),
        status = text(detail.getAttribute("OrganizationStatus")).trim();
      check(
        name.length > 0 &&
          name.length <= 1000 &&
          committeeType === "Independent Expenditure Committee" &&
          status.length > 0,
        "native_ie_registry_class",
      );
      rows.push({ name, committeeType, status });
      expanded.push(
        REGISTRY_COLUMNS.map((k) => canonical(k, text(all[k] ?? ""))),
      );
    }
  }
  check(
    elements(doc, "Detail").length === rows.length && rows.length > 0,
    "native_ie_registry_population",
  );
  equalOccurrences(expanded, csvData(input.csv, REGISTRY_COLUMNS, root));
  return rows;
}

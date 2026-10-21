import { createRequire } from "node:module";
import {
  firstNamesConflict,
  firstNameVariants,
} from "../finance/personFirstNameNicknames.js";
import {
  hasMiddleNameConflict,
  personNameParseVariants,
  personNamesMatchWithMiddleEvidence,
} from "../finance/personNameMiddleEvidence.js";

export const ALASKA_REPORTED_ORIGIN = "https://aws.state.ak.us";
export const ALASKA_REPORTED_URLS = {
  ie: `${ALASKA_REPORTED_ORIGIN}/ApocReports/IndependentExpenditures/IEExpenditures.aspx`,
  ieParents: `${ALASKA_REPORTED_ORIGIN}/ApocReports/IndependentExpenditures/IEForms.aspx`,
  paperIe: `${ALASKA_REPORTED_ORIGIN}/ApocReports/IndependentExpenditures/PaperIEForms.aspx`,
  campaign: `${ALASKA_REPORTED_ORIGIN}/ApocReports/CampaignDisclosure/CDForms.aspx`,
  groups: `${ALASKA_REPORTED_ORIGIN}/ApocReports/Registration/GroupRegistration/GRForms.aspx`,
  entities: `${ALASKA_REPORTED_ORIGIN}/ApocReports/Registration/EntityRegistration/ERForms.aspx`,
  candidates: `${ALASKA_REPORTED_ORIGIN}/ApocReports/Registration/CandidateRegistration/CRForms.aspx`,
  roster: "https://www.elections.alaska.gov/candidates/",
} as const;
export type AlaskaReportedComponent = "committee" | "ie";

export class AlaskaReportedSourceError extends Error {
  constructor(readonly code: string) {
    super(`Alaska reported finance held: ${code}`);
    this.name = "AlaskaReportedSourceError";
  }
}
export function akCheck(value: unknown, code: string): asserts value {
  if (!value) throw new AlaskaReportedSourceError(code);
}
export const akText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();
export const akKey = (value: string): string => akText(value).toUpperCase();
export function akAdd(a: number, b: number): number {
  const sum = a + b;
  akCheck(
    Number.isSafeInteger(a) &&
      Number.isSafeInteger(b) &&
      Number.isSafeInteger(sum),
    "amount_overflow",
  );
  return sum;
}

/** Parse filed signs and exact cents; never round producer decimals. */
export function akCents(value: string): number {
  let text = value.trim(),
    negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    akCheck(!negative, "amount_sign");
    negative = true;
    text = text.slice(1);
  }
  if (text.startsWith("$")) text = text.slice(1);
  if (text.startsWith("-")) {
    akCheck(!negative, "amount_sign");
    negative = true;
    text = text.slice(1);
  }
  akCheck(/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text), "amount_format");
  const [whole, fractional = ""] = text.replace(/,/g, "").split(".");
  akCheck(!/[1-9]/.test(fractional.slice(2)), "fractional_cent");
  const cents =
    (BigInt(whole!) * 100n + BigInt(fractional.slice(0, 2).padEnd(2, "0"))) *
    (negative ? -1n : 1n);
  akCheck(
    cents <= BigInt(Number.MAX_SAFE_INTEGER) &&
      cents >= BigInt(Number.MIN_SAFE_INTEGER),
    "amount_overflow",
  );
  return Number(cents);
}

/** A filing calendar date is not an observation timestamp. */
export function akDate(value: string): string {
  const raw = value.trim(),
    us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw),
    iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  akCheck(us || iso, "date_format");
  const year = Number(us?.[3] ?? iso![1]),
    month = Number(us?.[1] ?? iso![2]),
    day = Number(us?.[2] ?? iso![3]),
    date = new Date(Date.UTC(year, month - 1, day));
  akCheck(
    year >= 1900 &&
      year <= 2100 &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day,
    "date_value",
  );
  return date.toISOString().slice(0, 10);
}
export function akSubmittedDay(value: string): string {
  const match =
    /^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/.exec(
      value.trim(),
    );
  akCheck(match, "registration_date_format");
  if (match[2])
    akCheck(
      Number(match[3]) < 60 &&
        Number(match[4] ?? 0) < 60 &&
        (match[5]
          ? Number(match[2]) >= 1 && Number(match[2]) <= 12
          : Number(match[2]) <= 23),
      "registration_time_value",
    );
  return akDate(match[1]!);
}

const normalizePerson = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(?:JR|SR|II|III|IV)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const equivalentFirst = (a: string, b: string) =>
  a === b || firstNameVariants(a).includes(b);
export function akPersonMatches(
  aliases: readonly string[],
  sourceName: string,
  structuredGivenNames: readonly string[] = [],
): boolean {
  const names = aliases.filter((name) => name.trim()),
    firsts = [
      ...new Set(
        personNameParseVariants(sourceName, normalizePerson).map(
          (name) => name.first,
        ),
      ),
    ];
  return (
    firsts.length > 0 &&
    names.length > 0 &&
    structuredGivenNames.every((given) =>
      firsts.every(
        (first) =>
          !firstNamesConflict(
            normalizePerson(given).split(" ")[0] ?? "",
            first,
          ),
      ),
    ) &&
    names.every(
      (candidateName) =>
        !hasMiddleNameConflict({
          candidateName,
          rowNames: [sourceName],
          normalizePersonName: normalizePerson,
          firstNamesEquivalent: equivalentFirst,
        }),
    ) &&
    names.some((candidateName) =>
      personNamesMatchWithMiddleEvidence({
        candidateName,
        rowNames: [sourceName],
        normalizePersonName: normalizePerson,
        firstNamesEquivalent: equivalentFirst,
      }),
    )
  );
}

/** The year is part of APOC's published candidate choice, not report year. */
export function akCandidateChoice(value: string): {
  year: number;
  name: string;
} {
  const match = /^(20\d{2}) - (\S[\s\S]*)$/.exec(value.trim());
  akCheck(match && match[2]!.trim(), "candidate_choice_year");
  return { year: Number(match[1]), name: match[2]!.trim() };
}

export function akPublicUrl(value: string, base: string): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new AlaskaReportedSourceError("source_url");
  }
  akCheck(
    [ALASKA_REPORTED_ORIGIN, "https://www.elections.alaska.gov"].includes(
      url.origin,
    ) &&
      !url.username &&
      !url.password &&
      !url.hash,
    "source_origin",
  );
  return url.href;
}
const require = createRequire(import.meta.url);
export function akDocument(raw: Uint8Array, url: string): Document {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new AlaskaReportedSourceError("source_encoding");
  }
  akCheck(!html.includes("\u0000"), "source_nul");
  const { JSDOM, VirtualConsole } = require("jsdom") as {
    JSDOM: new (
      html: string,
      options: { url: string; virtualConsole: unknown },
    ) => { window: { document: Document } };
    VirtualConsole: new () => unknown;
  };
  return new JSDOM(html, {
    url: akPublicUrl(url, url),
    virtualConsole: new VirtualConsole(),
  }).window.document;
}
export const akNodeText = (node: Node): string =>
  akText(node.textContent ?? "");
/** Interpret HTML line breaks without changing the original source bytes. */
export function akRenderedText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  const element = node as Element;
  if (element.tagName === "BR") return " ";
  return [...node.childNodes]
    .map(akRenderedText)
    .join(["DIV", "P", "LI"].includes(element.tagName) ? " " : "");
}
export function akField(document: Document, label: string): string {
  const elements = [...document.querySelectorAll("div")].filter((node) =>
    [...node.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent?.trim() === label,
    ),
  );
  const values = [
    ...new Set(
      elements.flatMap((node) =>
        [...node.querySelectorAll("span")].map(akNodeText),
      ),
    ),
  ];
  akCheck(values.length === 1, "native_field_ambiguous");
  return values[0]!;
}

export type AlaskaNativeForm = {
  document: Document;
  fields: URLSearchParams;
  prefix: string;
};
export function akForm(raw: Uint8Array, url: string): AlaskaNativeForm {
  const document = akDocument(raw, url),
    fields = new URLSearchParams();
  for (const input of document.querySelectorAll("input"))
    if (input.name && ["hidden", "text"].includes(input.type))
      fields.set(input.name, input.value);
  for (const select of document.querySelectorAll("select"))
    if (select.name) fields.set(select.name, select.value);
  akCheck(
    fields.has("__EVENTTARGET") && fields.has("__EVENTARGUMENT"),
    "native_postback_fields",
  );
  fields.set("__EVENTTARGET", "");
  fields.set("__EVENTARGUMENT", "");
  const search = [...document.querySelectorAll("input")].filter((node) =>
    node.name.endsWith("$btnSearch"),
  );
  akCheck(search.length === 1, "native_search_control");
  return {
    document,
    fields,
    prefix: search[0]!.name.slice(0, -"btnSearch".length),
  };
}
export function akSetChoice(
  form: AlaskaNativeForm,
  name: string,
  value: string,
): void {
  const field = [...form.document.querySelectorAll("select")].find(
    (select) => select.name === form.prefix + name,
  );
  akCheck(
    field && [...field.options].some((option) => option.value === value),
    "unpublished_source_filter",
  );
  form.fields.set(form.prefix + name, value);
}

export type AlaskaNativeGridRow = { cells: string[]; href: string };
export type AlaskaNativeGrid = AlaskaNativeForm & {
  headers: string[];
  rows: AlaskaNativeGridRow[];
  total: number | null;
  pages: number | null;
  page: number | null;
  emptyDeclared: boolean;
};
export function akGrid(raw: Uint8Array, url: string): AlaskaNativeGrid {
  const form = akForm(raw, url),
    tables = form.document.querySelectorAll("table#M_C_grid_ctl00");
  akCheck(tables.length === 1, "native_grid");
  const table = tables[0]!,
    headers = [...table.querySelectorAll("th")]
      .map(akNodeText)
      .filter((s) => s !== "Data pager");
  akCheck(headers.length > 0, "native_grid_headers");
  const rows = [...table.querySelectorAll("tr.rgRow,tr.rgAltRow")].map(
    (row) => {
      const cells = [...row.children]
          .filter((node) => node.tagName === "TD")
          .map(akNodeText),
        links = [...row.querySelectorAll("a[href]")].filter((node) =>
          node.getAttribute("href")?.includes("/Common/View.aspx"),
        );
      akCheck(
        cells.length === headers.length && links.length === 1,
        "native_grid_row",
      );
      const href = akPublicUrl(links[0]!.getAttribute("href")!, url),
        parsed = new URL(href);
      akCheck(
        parsed.pathname === "/ApocReports/Common/View.aspx" &&
          /^[1-9]\d*$/.test(parsed.searchParams.get("ID") ?? "") &&
          /^[A-Z]{1,12}$/.test(parsed.searchParams.get("ViewType") ?? "") &&
          parsed.searchParams.size === 2,
        "native_report_link",
      );
      return { cells, href };
    },
  );
  const info = [...table.querySelectorAll(".rgInfoPart")]
      .map(akNodeText)
      .map((s) => /\b(\d+)\s+items?\s+in\s+(\d+)\s+pages?\b/i.exec(s))
      .filter((m): m is RegExpExecArray => m !== null),
    current = table.querySelectorAll("a.rgCurrentPage");
  const emptyDeclared =
    rows.length === 0 &&
    [...table.querySelectorAll(".rgNoRecords")].some((node) =>
      /^No records to display\.?$/i.test(akNodeText(node)),
    );
  akCheck(
    info.length <= 1 &&
      current.length <= 1 &&
      ((info.length === 0) === (current.length === 0) ||
        (emptyDeclared && info[0]?.[1] === "0")),
    "native_grid_pager",
  );
  return {
    ...form,
    headers,
    rows,
    total: info.length ? Number(info[0]![1]) : null,
    pages: info.length ? Number(info[0]![2]) : null,
    page: current.length ? Number(akNodeText(current[0]!)) : null,
    emptyDeclared,
  };
}
export function akColumn(
  headers: readonly string[],
  name: string,
  occurrence?: number,
): number {
  const indices = headers.flatMap((header, i) => (header === name ? [i] : []));
  akCheck(
    occurrence === undefined
      ? indices.length === 1
      : indices.length > occurrence,
    "native_column",
  );
  return indices[occurrence ?? 0]!;
}

/** Complete rows from one native table; unknown supplementary rows hold. */
export function akMoneyRows(
  document: Document,
  id: string,
  width: number,
): Element[][] {
  const tables = document.querySelectorAll(`table#${id}`);
  akCheck(tables.length === 1, "native_money_table");
  const table = tables[0]!,
    rows: Element[][] = [];
  const emptyLabel = (
    {
      tblIncome: "No Income / Nothing to Report",
      tblExpenditures: "No Expenditures / Nothing to Report",
      tblDebts: "No Debts / Nothing to Report",
    } as Record<string, string>
  )[id];
  const totalLabel = (
    {
      tblIncome: "Income Total:",
      tblExpenditures: "Expenditure Total:",
      tblDebts: "Remaining Debt Total:",
    } as Record<string, string>
  )[id];
  let emptySeen = false,
    footerSeen = false;
  for (const row of table.querySelectorAll("tr")) {
    if (row.closest("table") !== table) continue;
    const cells = [...row.children].filter((node) => node.tagName === "TD");
    if (!cells.length) {
      akCheck(
        row.querySelectorAll("th").length === width,
        "native_money_header",
      );
      continue;
    }
    if (cells.length === width) {
      akCheck(!emptySeen && !footerSeen, "mixed_empty_money_table");
      rows.push(cells);
      continue;
    }
    const footer =
      cells.length === 3 &&
      !akNodeText(cells[0]!) &&
      akNodeText(cells[1]!) === totalLabel &&
      cells.reduce(
        (n, cell) => n + Number(cell.getAttribute("colspan") ?? 1),
        0,
      ) === width;
    if (footer) {
      akCheck(!footerSeen, "duplicate_native_total");
      akCheck(
        akCents(akNodeText(cells[2]!)) ===
          rows.reduce(
            (sum, row) => akAdd(sum, akCents(akNodeText(row.at(-1)!))),
            0,
          ),
        "native_itemized_total",
      );
      footerSeen = true;
      continue;
    }
    const empty =
      cells.length === 1 &&
      cells[0]!.getAttribute("colspan") === String(width) &&
      akNodeText(cells[0]!) === emptyLabel;
    akCheck(empty, "unrecognized_native_money_row");
    akCheck(
      rows.length === 0 && !footerSeen && !emptySeen,
      "mixed_empty_money_table",
    );
    emptySeen = true;
  }
  return rows;
}

import { createRequire } from "node:module";

export const NEBRASKA_NATIVE_ORIGIN = "https://nadc-e.nebraska.gov";
export const NEBRASKA_NATIVE_URLS = {
  registry: `${NEBRASKA_NATIVE_ORIGIN}/PublicSite/SearchPages/Search.aspx?SearchTypeCodeHook=1F26BA5E-71EA-48E4-8D50-C1013E9FE0A7`,
  ie: `${NEBRASKA_NATIVE_ORIGIN}/PublicSite/SearchPages/Search.aspx?SearchTypeCodeHook=16D3B0E7-88E1-4105-AF0D-F241E7724D6B`,
  committee: `${NEBRASKA_NATIVE_ORIGIN}/PublicSite/SearchPages/Search.aspx?SearchTypeCodeHook=F0FEA582-08C3-42BA-B008-0F5067C5791B`,
} as const;
export const NEBRASKA_COMMITTEE_CLASSES = {
  pac: "PAC-Independent",
  sspf: "PAC-Separate Segregated Political Fund",
  party: "Political Party Committee",
  candidate: "Candidate Committee",
  federal: "Federal PAC",
  ballot: "Ballot Question Committee",
} as const;
export type NebraskaCommitteeClass = keyof typeof NEBRASKA_COMMITTEE_CLASSES;
export type NebraskaSourceKind = keyof typeof NEBRASKA_NATIVE_URLS;
export type NebraskaNativeLink = { text: string; href: string; cell: number };
export type NebraskaNativeRow = {
  cells: string[];
  links: NebraskaNativeLink[];
};
export type NebraskaNativeTable = {
  headers: string[];
  rows: NebraskaNativeRow[];
};
export type NebraskaNativeForm = {
  document: Document;
  fields: URLSearchParams;
};
export type NebraskaReceiptScope = {
  start: string;
  end: string;
  contributorClass: NebraskaCommitteeClass;
};
export type NebraskaReportedReceipt = {
  receivingId: string;
  receivingName: string;
  reportedName: string;
  contributorClass: NebraskaCommitteeClass;
  transactionType: string;
  date: string;
  amountCents: number;
};
export type NebraskaReportedAllocation = {
  reportedSpenderName: string;
  targetName: string;
  officeDistrict: string;
  stance: "support" | "oppose" | null;
  date: string;
  amountCents: number;
};
export type NebraskaNativeRegistration = {
  receivingId: string;
  candidateName: string;
  committeeName: string;
  jurisdiction: string;
  office: string;
  district: string;
  election: string;
  status: string;
};

export class NebraskaReportedSourceError extends Error {
  constructor(readonly code: string) {
    super(`Nebraska reported finance held: ${code}`);
    this.name = "NebraskaReportedSourceError";
  }
}
export function neHold(code: string): never {
  throw new NebraskaReportedSourceError(code);
}
export function neCheck(value: unknown, code: string): asserts value {
  if (!value) neHold(code);
}
export const neText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();
export const neKey = (value: string): string => neText(value).toUpperCase();
export function neAdd(a: number, b: number): number {
  const sum = a + b;
  neCheck(Number.isSafeInteger(sum), "amount_overflow");
  return sum;
}

/** FirstTuesday serializes CSV decimals with four places, HTML with currency
 * punctuation. Fractional cents are rejected rather than rounded. */
export function neCents(value: string): number {
  const clean = value.trim();
  neCheck(
    /^(?:-?\$?|\$-)(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?$/.test(clean),
    "amount_format",
  );
  const plain = clean.replace(/[$,]/g, ""),
    negative = plain.startsWith("-");
  const [whole, fractional = ""] = plain.replace(/^-/, "").split(".");
  neCheck(
    fractional.length <= 2 || /^0*$/.test(fractional.slice(2)),
    "fractional_cent",
  );
  const amount =
    (BigInt(whole!) * 100n + BigInt(fractional.slice(0, 2).padEnd(2, "0"))) *
    (negative ? -1n : 1n);
  neCheck(
    amount <= BigInt(Number.MAX_SAFE_INTEGER) &&
      amount >= BigInt(Number.MIN_SAFE_INTEGER),
    "amount_overflow",
  );
  return Number(amount);
}

/** No permissive Date.parse: reject rollovers and locale ambiguity. */
export function neDate(value: string): string {
  const raw = value.trim(),
    us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw),
    iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  neCheck(us || iso, "date_format");
  const year = Number(us?.[3] ?? iso![1]),
    month = Number(us?.[1] ?? iso![2]),
    day = Number(us?.[2] ?? iso![3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  neCheck(
    year >= 1900 &&
      year <= 2100 &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day,
    "date_value",
  );
  return date.toISOString().slice(0, 10);
}
export function neInputDate(value: string): string {
  const date = neDate(value);
  return `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
}
export function neNativeUrl(value: string, base: string): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return neHold("native_url");
  }
  neCheck(
    url.origin === NEBRASKA_NATIVE_ORIGIN &&
      !url.username &&
      !url.password &&
      !url.hash,
    "native_origin",
  );
  return url.href;
}

const require = createRequire(import.meta.url);
export function neDocument(raw: Uint8Array, url: string): Document {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return neHold("native_encoding");
  }
  neCheck(!html.includes("\u0000"), "native_nul");
  // JSDOM runs no scripts and loads no resources. Keep it out of ordinary API
  // startup when the acquisition feature is disabled.
  const { JSDOM, VirtualConsole } = require("jsdom") as {
    JSDOM: new (
      html: string,
      options: { url: string; virtualConsole: unknown },
    ) => { window: { document: Document } };
    VirtualConsole: new () => unknown;
  };
  return new JSDOM(html, {
    url: neNativeUrl(url, url),
    virtualConsole: new VirtualConsole(),
  }).window.document;
}
export function neForm(
  document: Document,
  kind: NebraskaSourceKind,
): NebraskaNativeForm {
  const form = document.querySelector("form"),
    fields = new URLSearchParams();
  neCheck(
    form?.method === "post" &&
      neNativeUrl(form.action, document.URL) === document.URL,
    "native_form",
  );
  neCheck(
    document.querySelector(
      `input[name*="$${kind === "registry" ? "Candidate" : kind === "ie" ? "Expenditure" : "Contribution"}_SearchButton$"]`,
    ),
    "native_search_context",
  );
  for (const element of Array.from(form.elements) as HTMLInputElement[]) {
    if (!element.name || element.disabled) continue;
    neCheck(
      !["password", "file"].includes(element.type),
      "native_authentication_form",
    );
    if (
      ["submit", "button", "image", "reset"].includes(element.type) ||
      (["checkbox", "radio"].includes(element.type) && !element.checked)
    )
      continue;
    fields.append(element.name, element.value ?? "");
  }
  neCheck(
    fields.has("__VIEWSTATE") && fields.has("__EVENTVALIDATION"),
    "native_state",
  );
  return { document, fields };
}
export function neControl(
  form: NebraskaNativeForm,
  suffix: string,
  tag: "input" | "select" = "input",
): HTMLInputElement | HTMLSelectElement {
  const controls = Array.from(
    form.document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      `${tag}[name]`,
    ),
  ).filter((e) => e.name.includes(`$${suffix}$`));
  neCheck(controls.length === 1, "native_control");
  return controls[0]!;
}
export function neSelect(
  form: NebraskaNativeForm,
  suffix: string,
  label: string,
): string {
  const select = neControl(form, suffix, "select") as HTMLSelectElement;
  const options = Array.from(select.options).filter(
    (o) => neText(o.textContent ?? "") === label,
  );
  neCheck(options.length === 1, "native_option");
  form.fields.set(select.name, options[0]!.value);
  return select.name;
}
export function neSelected(
  form: NebraskaNativeForm,
  suffix: string,
  expectedLabel: string,
): void {
  const select = neControl(form, suffix, "select") as HTMLSelectElement;
  neCheck(
    neText(select.selectedOptions[0]?.textContent ?? "") === expectedLabel,
    "native_type_scope",
  );
}
export function nePostback(
  form: NebraskaNativeForm,
  target: string,
  argument = "",
): URLSearchParams {
  const fields = new URLSearchParams(form.fields);
  fields.set("__EVENTTARGET", target);
  fields.set("__EVENTARGUMENT", argument);
  return fields;
}
export function nePageSize(form: NebraskaNativeForm): string {
  const controls = Array.from(
    form.document.querySelectorAll<HTMLSelectElement>("select[name]"),
  ).filter((e) => /PageSize/.test(e.name));
  neCheck(
    controls.length === 1 &&
      Array.from(controls[0]!.options).some((o) => o.value === "50"),
    "native_page_size",
  );
  form.fields.set(controls[0]!.name, "50");
  return controls[0]!.name;
}

/** Only rows owned by this table. A nested pager can itself have eight cells;
 * counting descendant TRs turns its page numbers into bogus financial rows. */
export function neTables(document: Document): NebraskaNativeTable[] {
  return Array.from(document.querySelectorAll("table")).map((table) => {
    const rows = Array.from(table.children).flatMap((child) =>
      child.tagName === "TR"
        ? [child]
        : ["THEAD", "TBODY", "TFOOT"].includes(child.tagName)
          ? Array.from(child.children).filter((n) => n.tagName === "TR")
          : [],
    );
    return {
      headers: rows.flatMap((row) =>
        Array.from(row.children)
          .filter((n) => n.tagName === "TH")
          .map((n) => neText(n.textContent ?? "")),
      ),
      rows: rows.map((row) => {
        const cells = Array.from(row.children).filter(
          (n) => n.tagName === "TD",
        );
        return {
          cells: cells.map((n) => neText(n.textContent ?? "")),
          links: Array.from(row.querySelectorAll("a[href]")).map((a) => ({
            text: neText(a.textContent ?? ""),
            href: a.getAttribute("href")!,
            cell: cells.findIndex((cell) => cell.contains(a)),
          })),
        };
      }),
    };
  });
}
export function neNextPage(
  table: NebraskaNativeTable,
  page: number,
): [string, string] | null {
  const links = table.rows
    .flatMap((row) => row.links)
    .filter((link) => link.text === String(page + 1));
  const events = links
    .map((link) => /__doPostBack\('([^']+)','([^']+)'\)/.exec(link.href))
    .filter((m): m is RegExpExecArray => !!m && m[2] === `Page$${page + 1}`);
  if (!events.length) return null;
  neCheck(
    events.every((m) => m[1] === events[0]![1]),
    "native_pager_ambiguous",
  );
  return [events[0]![1]!, events[0]![2]!];
}
function organizationId(
  row: NebraskaNativeRow,
  name: string,
  base: string,
  cell: number,
): string {
  const matches = row.links.filter(
    (link) =>
      link.cell === cell &&
      neKey(link.text) === neKey(name) &&
      link.href.includes("OrganizationDetail.aspx"),
  );
  neCheck(matches.length === 1, "native_receiving_link");
  const url = new URL(neNativeUrl(matches[0]!.href, base)),
    id = url.searchParams.get("OrganizationID");
  neCheck(
    url.pathname === "/PublicSite/SearchPages/OrganizationDetail.aspx" &&
      /^[1-9]\d*$/.test(id ?? ""),
    "native_receiving_id",
  );
  return id!;
}
export function neReceiptScope(
  form: NebraskaNativeForm,
  scope: NebraskaReceiptScope,
): void {
  neSelected(form, "OrganizationCodeHook", "Candidate Committee");
  neSelected(
    form,
    "DonorPayeeCodeHook",
    NEBRASKA_COMMITTEE_CLASSES[scope.contributorClass],
  );
  for (const [field, expected] of [
    ["DateFrom", scope.start],
    ["DateThrough", scope.end],
  ]) {
    neCheck(
      neDate(neControl(form, field!).value) === expected,
      "native_date_scope",
    );
  }
}
export function neExplicitNoRecords(form: NebraskaNativeForm): boolean {
  const walker = form.document.createTreeWalker(form.document, 4);
  let node: Node | null;
  while ((node = walker.nextNode()))
    if (
      neKey(node.textContent ?? "") ===
      "PLEASE CORRECT THE FOLLOWING ERRORS: NO RECORDS FOUND FOR THIS SEARCH CRITERIA."
    ) {
      let parent = node.parentElement,
        visible = true;
      while (parent) {
        if (
          ["SCRIPT", "STYLE", "TEMPLATE"].includes(parent.tagName) ||
          parent.hidden ||
          parent.getAttribute("aria-hidden") === "true" ||
          /display\s*:\s*none|visibility\s*:\s*hidden/i.test(
            parent.getAttribute("style") ?? "",
          )
        )
          visible = false;
        parent = parent.parentElement;
      }
      if (!visible) continue;
      return !neTables(form.document).some((table) => table.headers.length);
    }
  return false;
}
export function neReceiptPage(
  form: NebraskaNativeForm,
  scope: NebraskaReceiptScope,
): {
  table: NebraskaNativeTable;
  nativeRows: NebraskaNativeRow[];
  receipts: NebraskaReportedReceipt[];
  summary: string;
  summaryCents: number;
  explicitEmpty: boolean;
} {
  neReceiptScope(form, scope);
  const tables = neTables(form.document),
    grids = tables.filter(
      (t) =>
        t.headers.join("|") ===
        "Contributor or Source|City, State|Transaction/Contribution Type|Description|Amount|Date|Filer/Recipient|",
    ),
    summaries = tables.filter(
      (t) => t.headers.join("|") === "Summary Groupings|Total",
    );
  // This is the portal's observed no-results response, not a generic error,
  // missing table, empty body or successful source-health observation.
  if (neExplicitNoRecords(form))
    return {
      table: { headers: [], rows: [] },
      nativeRows: [],
      receipts: [],
      summary: "[]",
      summaryCents: 0,
      explicitEmpty: true,
    };
  neCheck(grids.length === 1 && summaries.length === 1, "native_receipt_grids");
  const table = grids[0]!,
    nativeRows = table.rows.filter((row) => row.cells.length === 8);
  neCheck(nativeRows.length > 0, "empty_receipt_grid_without_no_records");
  const summary = summaries[0]!.rows
    .filter((row) => row.cells.length === 2)
    .map((row) => ({
      label: neKey(row.cells[0]!),
      cents: neCents(row.cells[1]!),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  neCheck(
    summary.length > 0 &&
      new Set(summary.map((row) => row.label)).size === summary.length,
    "native_summary_groups",
  );
  const receipts = nativeRows.map((row) => {
    const date = neDate(row.cells[5]!);
    neCheck(
      date >= scope.start && date <= scope.end,
      "native_receipt_date_scope",
    );
    const receivingName = row.cells[6]!;
    neCheck(receivingName, "native_receiving_name");
    return {
      receivingId: organizationId(row, receivingName, form.document.URL, 6),
      receivingName,
      reportedName: row.cells[0]!,
      contributorClass: scope.contributorClass,
      transactionType: neKey(row.cells[2]!),
      date,
      amountCents: neCents(row.cells[4]!),
    };
  });
  return {
    table,
    nativeRows,
    receipts,
    summary: JSON.stringify(summary),
    summaryCents: summary.reduce((n, row) => neAdd(n, row.cents), 0),
    explicitEmpty: false,
  };
}
export function neRegistryPage(
  form: NebraskaNativeForm,
  year: number,
): {
  table: NebraskaNativeTable;
  registrations: NebraskaNativeRegistration[];
  nativeRows: NebraskaNativeRow[];
} {
  neSelected(form, "ElectionID", `${year} STATEWIDE ELECTIONS`);
  neSelected(form, "JurisdictionTypeCodeID", "State");
  neSelected(form, "JurisdictionCodeID", "NEBRASKA");
  const tables = neTables(form.document).filter(
    (t) =>
      t.headers.join("|") ===
      "Candidate Name|Committee Name|Jurisdiction|Office|District|Election|Status|Contact Email Address",
  );
  neCheck(tables.length === 1, "native_registry_grid");
  const table = tables[0]!,
    nativeRows = table.rows.filter((row) => row.cells.length === 8);
  const registrations = nativeRows.map((row) => {
    const [
      candidateName,
      committeeName,
      jurisdiction,
      office,
      district,
      election,
      status,
    ] = row.cells;
    neCheck(
      candidateName &&
        committeeName &&
        jurisdiction === "NEBRASKA" &&
        election === `${year} STATEWIDE ELECTIONS` &&
        ["Active", "Terminated"].includes(status!),
      "native_registry_context",
    );
    return {
      receivingId: organizationId(row, committeeName!, form.document.URL, 1),
      candidateName: candidateName!,
      committeeName: committeeName!,
      jurisdiction: jurisdiction!,
      office: office!,
      district: district!,
      election: election!,
      status: status!,
    };
  });
  return { table, nativeRows, registrations };
}

export function neCsv(raw: Uint8Array): {
  headers: string[];
  rows: string[][];
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return neHold("csv_encoding");
  }
  neCheck(!text.includes("\u0000"), "csv_nul");
  const records: string[][] = [];
  let row: string[] = [],
    field = "",
    state: "start" | "bare" | "quoted" | "closed" = "start";
  const finish = (): void => {
    row.push(field);
    neCheck(row.length > 1 || row[0] !== "", "csv_blank_record");
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
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      state = "start";
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      finish();
      continue;
    }
    neCheck(state !== "closed", "csv_after_quote");
    if (c === '"') {
      neCheck(state === "start", "csv_quote");
      state = "quoted";
    } else {
      field += c;
      state = "bare";
    }
  }
  neCheck((state as string) !== "quoted", "csv_unterminated");
  if (field || row.length || state === "closed") finish();
  const headers = records.shift()?.map(neText);
  neCheck(
    headers?.length &&
      new Set(headers).size === headers.length &&
      records.every((row) => row.length === headers.length),
    "csv_columns",
  );
  return { headers, rows: records };
}
export function neIeCsv(
  raw: Uint8Array,
  year: number,
): NebraskaReportedAllocation[] {
  const { headers, rows } = neCsv(raw);
  neCheck(
    headers.join("|") ===
      "Payee or Recipient or In-Kind Contributor|Transaction/Expense Type|Description|Amount|Current Balance|Date|Filer/Payer/Transaction Source|Support/Oppose|Candidate Name or Ballot Issue|Jurisdiction/Office/District or Ballot Description|Other Party",
    "ie_csv_schema",
  );
  return rows.map((row) => {
    neCheck(
      neText(row[1]!) === "Independent Expenditure",
      "ie_transaction_type",
    );
    const date = neDate(row[5]!);
    neCheck(
      date >= `${year - 1}-01-01` && date <= `${year}-12-31`,
      "ie_date_scope",
    );
    const stance = neKey(row[7]!);
    neCheck(["", "SUPPORT", "OPPOSE"].includes(stance), "ie_stance");
    const reportedSpenderName = neText(row[6]!);
    neCheck(reportedSpenderName, "ie_spender_name");
    const amountCents = neCents(row[3]!);
    neCheck(amountCents >= 0, "negative_current_ie");
    return {
      reportedSpenderName,
      targetName: neText(row[8]!),
      officeDistrict: neText(row[9]!),
      stance:
        stance === "SUPPORT"
          ? "support"
          : stance === "OPPOSE"
            ? "oppose"
            : null,
      date,
      amountCents,
    };
  });
}

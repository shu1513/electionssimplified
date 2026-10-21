import {
  akCheck,
  akForm,
  akGrid,
  akNodeText,
  akPublicUrl,
  ALASKA_REPORTED_URLS,
  type AlaskaNativeForm,
  type AlaskaNativeGrid,
} from "./alaskaReportedNative.js";
import {
  akSuccessfulOriginal,
  type AlaskaOriginal,
} from "./alaskaReportedOriginals.js";

export type AlaskaQueryKind =
  "ie" | "ieParents" | "campaign" | "groups" | "entities" | "candidates";
export type AlaskaQueryScope = {
  kind: AlaskaQueryKind;
  year: number;
  status: "Default" | "Complete";
  name: string;
  nameType: string;
};
export type AlaskaRecordedPopulation = {
  scope: AlaskaQueryScope;
  pages: Array<{
    original: AlaskaOriginal;
    grid: Omit<AlaskaNativeGrid, "document">;
  }>;
  exportDialog: AlaskaOriginal | null;
  exportUrl: string | null;
  csv: AlaskaOriginal | null;
};

/** RFC-style CSV parsing with explicit rejection of broken producer records. */
export function akCsv(raw: Uint8Array): {
  headers: string[];
  rows: string[][];
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    akCheck(false, "csv_encoding");
  }
  akCheck(!text.includes("\u0000"), "csv_nul");
  const records: string[][] = [];
  let record: string[] = [],
    field = "",
    state: "start" | "plain" | "quoted" | "closed" = "start";
  const endField = () => {
    record.push(field);
    field = "";
    state = "start";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    akCheck(records.length <= 100001, "csv_resource_limit");
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (state === "quoted") {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else state = "closed";
      } else field += char;
      continue;
    }
    if (char === ",") {
      endField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r") {
        akCheck(text[index + 1] === "\n", "csv_bare_cr");
        index++;
      }
      endRecord();
      continue;
    }
    if (char === '"') {
      akCheck(state === "start" && field === "", "csv_quote");
      state = "quoted";
      continue;
    }
    akCheck(state !== "closed", "csv_after_quote");
    field += char;
    state = "plain";
  }
  akCheck(state !== "quoted", "csv_unclosed_quote");
  if (state !== "start" || record.length > 0) endRecord();
  const headers = records.shift();
  akCheck(
    headers &&
      headers.length > 1 &&
      headers.every(Boolean) &&
      new Set(headers).size === headers.length &&
      records.every((row) => row.length === headers.length),
    "csv_columns",
  );
  return { headers, rows: records };
}
export function akCsvObjects(raw: Uint8Array): Record<string, string>[] {
  const parsed = akCsv(raw);
  return parsed.rows.map((row) =>
    Object.fromEntries(
      parsed.headers.map((header, index) => [header, row[index]!]),
    ),
  );
}

export function akQueryKind(url: string): AlaskaQueryKind | null {
  const parsed = new URL(url);
  return (
    (
      [
        "ie",
        "ieParents",
        "campaign",
        "groups",
        "entities",
        "candidates",
      ] as const
    ).find(
      (kind) =>
        new URL(ALASKA_REPORTED_URLS[kind]).origin === parsed.origin &&
        new URL(ALASKA_REPORTED_URLS[kind]).pathname === parsed.pathname,
    ) ?? null
  );
}
export function akScope(
  form: AlaskaNativeForm,
  kind: AlaskaQueryKind,
): AlaskaQueryScope {
  const value = form.fields.get(form.prefix + "ddlReportYear"),
    status = form.fields.get(form.prefix + "ddlStatus");
  akCheck(
    value &&
      /^(?:-1|20\d{2})$/.test(value) &&
      ["Default", "Complete"].includes(status ?? ""),
    "native_query_scope",
  );
  for (const suffix of [
    "txtBeginDate",
    "txtEndDate",
    "txtFromDate",
    "txtToDate",
    "txtText",
  ])
    akCheck(
      !form.fields.get(form.prefix + suffix),
      "narrowed_date_or_text_scope",
    );
  const filter = [...form.document.querySelectorAll("select")].find(
    (node) => node.name === form.prefix + "ddlValue",
  );
  if (filter) {
    const selected = [...filter.options].find(
      (option) => option.value === form.fields.get(filter.name),
    );
    akCheck(
      selected && akNodeText(selected) === "Any",
      "narrowed_native_field_scope",
    );
  }
  const name = form.fields.get(form.prefix + "txtName") ?? "";
  return {
    kind,
    year: Number(value),
    status: status as "Default" | "Complete",
    name,
    nameType: name ? (form.fields.get(form.prefix + "ddlNameType") ?? "") : "",
  };
}
export function akSameScope(a: AlaskaQueryScope, b: AlaskaQueryScope): boolean {
  return (
    a.kind === b.kind &&
    a.year === b.year &&
    a.status === b.status &&
    a.name === b.name &&
    a.nameType === b.nameType
  );
}
function scopeMatchesRequest(
  form: AlaskaNativeForm,
  request: URLSearchParams,
): void {
  for (const suffix of [
    "ddlReportYear",
    "ddlStatus",
    "ddlNameType",
    "txtName",
    "ddlValue",
    "txtBeginDate",
    "txtEndDate",
  ]) {
    const key = form.prefix + suffix;
    akCheck(
      !request.has(key) || form.fields.get(key) === request.get(key),
      "native_request_echo",
    );
  }
}

/** Recover actual search/export/page sequences without trusting a role label. */
export function akRecordedPopulations(
  originals: readonly AlaskaOriginal[],
): AlaskaRecordedPopulation[] {
  const directories = new Map<string, AlaskaOriginal[]>(),
    populations: AlaskaRecordedPopulation[] = [];
  for (const original of originals) {
    const list = directories.get(original.directory) ?? [];
    list.push(original);
    directories.set(original.directory, list);
  }
  for (const records of directories.values()) {
    records.sort(
      (a, b) =>
        Number(a.meta.file.split(".")[0]) - Number(b.meta.file.split(".")[0]),
    );
    const active = new Map<AlaskaQueryKind, AlaskaRecordedPopulation>();
    for (const original of records) {
      const kind = akQueryKind(original.meta.url);
      if (!kind) continue;
      if (original.meta.method === "POST" && original.request !== null) {
        const request = new URLSearchParams(original.request),
          search = [...request.keys()].some((key) =>
            key.endsWith("$btnSearch"),
          ),
          exporting = [...request.keys()].some((key) =>
            key.endsWith("$btnExport"),
          );
        if (search) active.delete(kind);
        if (!akSuccessfulOriginal(original, "html")) continue;
        let form: AlaskaNativeForm | null = null;
        try {
          form = akForm(original.raw, original.meta.url);
          scopeMatchesRequest(form, request);
          const scope = akScope(form, kind);
          if (search) {
            const grid = akGrid(original.raw, original.meta.url),
              { document, ...snapshot } = grid,
              population: AlaskaRecordedPopulation = {
                scope,
                pages: [{ original, grid: snapshot }],
                exportDialog: null,
                exportUrl: null,
                csv: null,
              };
            document.defaultView?.close();
            populations.push(population);
            active.set(kind, population);
          } else {
            const population = active.get(kind);
            akCheck(
              population && akSameScope(population.scope, scope),
              "changed_native_query_scope",
            );
            if (exporting) {
              const links = [
                ...form.document.querySelectorAll("a[href]"),
              ].filter((node) => node.id.endsWith("_ExportDialog_hlAllCSV"));
              akCheck(links.length === 1, "actual_all_csv_control");
              const href = akPublicUrl(
                  links[0]!.getAttribute("href")!,
                  original.meta.url,
                ),
                parsed = new URL(href);
              akCheck(
                parsed.pathname ===
                  new URL(ALASKA_REPORTED_URLS[kind]).pathname &&
                  parsed.searchParams.get("exportAll") === "True" &&
                  parsed.searchParams.get("exportFormat") === "CSV",
                "all_csv_scope",
              );
              population.exportDialog = original;
              population.exportUrl = href;
            } else {
              const grid = akGrid(original.raw, original.meta.url),
                { document, ...snapshot } = grid;
              document.defaultView?.close();
              population.pages.push({ original, grid: snapshot });
            }
          }
        } catch {
          // A broken newer observation never manufactures an empty population.
          active.delete(kind);
        } finally {
          form?.document.defaultView?.close();
        }
      } else if (original.meta.method === "GET") {
        const population = active.get(kind);
        if (
          population?.exportUrl === original.meta.url &&
          akSuccessfulOriginal(original, "csv")
        )
          population.csv = original;
      }
    }
  }
  return populations;
}

export function akNativePopulationComplete(
  population: AlaskaRecordedPopulation,
): boolean {
  const first = population.pages[0]?.grid;
  if (!first) return false;
  const headers = JSON.stringify(first.headers);
  if (
    !population.pages.every(
      ({ grid }) => JSON.stringify(grid.headers) === headers,
    )
  )
    return false;
  if (
    population.pages.length === 1 &&
    first.emptyDeclared &&
    first.rows.length === 0
  )
    return first.total === null || first.total === 0;
  if (first.total === null) {
    if (population.pages.length !== 1 || !population.csv) return false;
    return akCsv(population.csv.raw).rows.length === first.rows.length;
  }
  if (
    !Number.isSafeInteger(first.total) ||
    first.total < 0 ||
    first.total > 100000 ||
    !Number.isSafeInteger(first.pages) ||
    first.pages! < 1 ||
    population.pages.length !== first.pages
  )
    return false;
  const pages = new Set(population.pages.map(({ grid }) => grid.page));
  return (
    pages.size === first.pages &&
    population.pages.every(
      ({ grid }) =>
        grid.total === first.total &&
        grid.pages === first.pages &&
        grid.page !== null &&
        grid.page >= 1 &&
        grid.page <= first.pages!,
    ) &&
    population.pages.reduce(
      (count, page) => count + page.grid.rows.length,
      0,
    ) === first.total
  );
}
export function akCsvPopulationComplete(
  population: AlaskaRecordedPopulation,
): boolean {
  if (!population.csv || !population.exportDialog || !population.exportUrl)
    return false;
  const rows = akCsv(population.csv.raw).rows.length,
    first = population.pages[0]?.grid;
  return (
    !!first &&
    (first.total !== null
      ? first.total === rows
      : population.pages.length === 1 && first.rows.length === rows)
  );
}

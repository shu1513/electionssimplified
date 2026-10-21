import {
  akCandidateChoice,
  akCheck,
  akForm,
  akGrid,
  akNodeText,
  akPublicUrl,
} from "./alaskaReportedNative.js";
import {
  akSetChoice,
  ALASKA_REPORTED_URLS,
  type AlaskaNativeForm,
  type AlaskaNativeGrid,
} from "./alaskaReportedNative.js";
import {
  AlaskaOriginalArchive,
  akSuccessfulOriginal,
  type AlaskaOriginal,
} from "./alaskaReportedOriginals.js";
import {
  akCsv,
  akCsvPopulationComplete,
  akNativePopulationComplete,
  akRecordedPopulations,
  akSameScope,
  akScope,
  type AlaskaQueryScope,
  type AlaskaRecordedPopulation,
} from "./alaskaReportedProtocol.js";

function clearUnusedFilters(form: AlaskaNativeForm): void {
  for (const suffix of [
    "txtBeginDate",
    "txtEndDate",
    "txtFromDate",
    "txtToDate",
    "txtText",
  ])
    if (form.fields.has(form.prefix + suffix))
      form.fields.set(form.prefix + suffix, "");
  const filter = [...form.document.querySelectorAll("select")].find(
    (node) => node.name === form.prefix + "ddlValue",
  );
  if (filter) {
    const any = [...filter.options].find((node) => akNodeText(node) === "Any");
    akCheck(any, "native_any_filter");
    form.fields.set(filter.name, any.value);
  }
}
function nextPage(grid: AlaskaNativeGrid): URLSearchParams {
  const buttons = [
    ...grid.document.querySelectorAll("#M_C_grid_ctl00 input.rgPageNext"),
  ];
  if (buttons.length === 1) {
    const button = buttons[0] as HTMLInputElement;
    akCheck(!button.disabled && button.name, "native_next_page_disabled");
    grid.fields.set(button.name, button.value);
  } else {
    const next = [
      ...grid.document.querySelectorAll("#M_C_grid_ctl00 a[href]"),
    ].filter((node) => akNodeText(node) === String((grid.page ?? 0) + 1));
    akCheck(next.length === 1, "native_next_page_control");
    const event =
      /^javascript:__doPostBack\('([A-Za-z0-9_$]+)','([^']*)'\)$/.exec(
        next[0]!.getAttribute("href") ?? "",
      );
    akCheck(
      event && event[1]!.startsWith("M$C$grid$"),
      "native_next_page_event",
    );
    grid.fields.set("__EVENTTARGET", event[1]!);
    grid.fields.set("__EVENTARGUMENT", event[2]!);
  }
  return grid.fields;
}

/** Actual public controls determine every request; no synthetic page URLs. */
export async function collectAlaskaPopulation(
  archive: AlaskaOriginalArchive,
  scope: AlaskaQueryScope,
  format: "native" | "csv" | "cycle",
  electionYear = scope.year,
): Promise<AlaskaRecordedPopulation> {
  const url = ALASKA_REPORTED_URLS[scope.kind],
    observations: AlaskaOriginal[] = [];
  const request = async (
    body?: URLSearchParams,
    target: string = url,
    csv = false,
  ) => {
    const record = await archive.observe(
      target,
      body,
      csv ? "text/csv,*/*" : undefined,
    );
    observations.push(record);
    return record;
  };
  const initial = await request();
  akCheck(akSuccessfulOriginal(initial, "html"), "native_landing_unavailable");
  const form = akForm(initial.raw, url);
  akSetChoice(form, "ddlReportYear", String(scope.year));
  akSetChoice(form, "ddlStatus", scope.status);
  clearUnusedFilters(form);
  akCheck(form.fields.has(form.prefix + "txtName"), "native_name_control");
  form.fields.set(form.prefix + "txtName", scope.name);
  if (scope.name) akSetChoice(form, "ddlNameType", scope.nameType);
  form.fields.set(form.prefix + "btnSearch", "Search");
  const searched = await request(form.fields);
  form.document.defaultView?.close();
  akCheck(akSuccessfulOriginal(searched, "html"), "native_search_unavailable");
  let grid = akGrid(searched.raw, url);
  akCheck(akSameScope(scope, akScope(grid, scope.kind)), "native_search_scope");
  if (grid.emptyDeclared && grid.rows.length === 0) {
    grid.document.defaultView?.close();
    const population = akRecordedPopulations(observations)[0];
    akCheck(
      population && akNativePopulationComplete(population),
      "native_empty_scope_unproved",
    );
    return population;
  }
  const exportForm = akForm(searched.raw, url);
  exportForm.fields.set(exportForm.prefix + "btnExport", "Export");
  const dialogOriginal = await request(exportForm.fields);
  exportForm.document.defaultView?.close();
  if (akSuccessfulOriginal(dialogOriginal, "html")) {
    const dialog = akForm(dialogOriginal.raw, url),
      links = [...dialog.document.querySelectorAll("a[href]")].filter((node) =>
        node.id.endsWith("_ExportDialog_hlAllCSV"),
      );
    if (links.length === 1) {
      const href = akPublicUrl(links[0]!.getAttribute("href")!, url),
        parsed = new URL(href);
      akCheck(
        parsed.pathname === new URL(url).pathname &&
          parsed.searchParams.get("exportAll") === "True" &&
          parsed.searchParams.get("exportFormat") === "CSV",
        "native_all_export_scope",
      );
      await request(undefined, href, true);
    }
    dialog.document.defaultView?.close();
  }
  let population = akRecordedPopulations(observations)[0];
  akCheck(population, "native_query_unproved");
  const csvComplete = akCsvPopulationComplete(population);
  if (format === "csv") {
    grid.document.defaultView?.close();
    akCheck(csvComplete, "complete_export_unavailable");
    return population;
  }
  if (format === "cycle" && csvComplete) {
    const parsed = akCsv(population.csv!.raw),
      column = parsed.headers.indexOf("Candidate/Proposition");
    akCheck(column >= 0, "native_target_column");
    if (
      parsed.rows.every(
        (row) => akCandidateChoice(row[column]!).year !== electionYear,
      )
    ) {
      grid.document.defaultView?.close();
      return population;
    }
  }
  const total = grid.total,
    pages = grid.pages,
    headers = JSON.stringify(grid.headers);
  let observedRows = grid.rows.length;
  while (pages !== null && grid.page !== null && grid.page < pages) {
    akCheck(
      pages <= 5000 && total !== null && total <= 100000,
      "native_population_resource_limit",
    );
    const expected = grid.page + 1,
      fields = nextPage(grid);
    grid.document.defaultView?.close();
    const original = await request(fields);
    akCheck(akSuccessfulOriginal(original, "html"), "native_page_unavailable");
    grid = akGrid(original.raw, url);
    akCheck(
      grid.page === expected &&
        grid.pages === pages &&
        grid.total === total &&
        JSON.stringify(grid.headers) === headers &&
        akSameScope(scope, akScope(grid, scope.kind)),
      "changed_native_page_scope",
    );
    observedRows += grid.rows.length;
    akCheck(observedRows <= total!, "native_population_overflow");
  }
  grid.document.defaultView?.close();
  population = akRecordedPopulations(observations)[0]!;
  akCheck(
    akNativePopulationComplete(population),
    "native_population_incomplete",
  );
  return population;
}

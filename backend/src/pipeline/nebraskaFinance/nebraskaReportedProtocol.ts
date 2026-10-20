import {
  NEBRASKA_COMMITTEE_CLASSES,
  NEBRASKA_NATIVE_URLS,
  neAdd,
  neCheck,
  neControl,
  neDate,
  neDocument,
  neExplicitNoRecords,
  neForm,
  neIeCsv,
  neInputDate,
  neNextPage,
  nePageSize,
  nePostback,
  neReceiptPage,
  neRegistryPage,
  neSelect,
  neSelected,
  type NebraskaCommitteeClass,
  type NebraskaNativeForm,
  type NebraskaNativeRegistration,
  type NebraskaNativeRow,
  type NebraskaReceiptScope,
  type NebraskaReportedAllocation,
  type NebraskaReportedReceipt,
} from "./nebraskaReportedNative.js";
import { NebraskaOriginalSequence } from "./nebraskaReportedOriginals.js";

export type NebraskaNativeDataset = {
  registrations?: NebraskaNativeRegistration[];
  receipts?: NebraskaReportedReceipt[];
  allocations?: NebraskaReportedAllocation[];
};
const rowSignature = (rows: readonly NebraskaNativeRow[]): string =>
  JSON.stringify(rows);
async function html(
  sequence: NebraskaOriginalSequence,
  role: string,
  fields?: URLSearchParams,
): Promise<NebraskaNativeForm> {
  return neForm(
    neDocument(
      await sequence.request(role, fields),
      NEBRASKA_NATIVE_URLS[sequence.kind],
    ),
    sequence.kind,
  );
}
function clearInputs(form: NebraskaNativeForm, names: string[]): void {
  for (const name of names) {
    const control = neControl(form, name);
    if (control.disabled) form.fields.delete(control.name);
    else form.fields.set(control.name, "");
  }
}
function blankInputs(form: NebraskaNativeForm, names: string[]): void {
  neCheck(
    names.every((name) => !neControl(form, name).value.trim()),
    "query_unexpected_text_filter",
  );
}
function registryScope(form: NebraskaNativeForm): void {
  for (const key of ["OrganizationStatusCodeID", "OfficeCodeID", "DistrictID"])
    neSelected(form, key, "");
  blankInputs(form, ["FirstName", "LastName", "DateFrom", "DateThrough"]);
}
function setDates(form: NebraskaNativeForm, start: string, end: string): void {
  for (const [key, value] of [
    ["DateFrom", start],
    ["DateThrough", end],
  ])
    form.fields.set(neControl(form, key!).name, neInputDate(value!));
}
function checkDates(
  form: NebraskaNativeForm,
  start: string,
  end: string,
): void {
  neCheck(
    neDate(neControl(form, "DateFrom").value) === start &&
      neDate(neControl(form, "DateThrough").value) === end,
    "query_date_scope",
  );
}

async function registry(
  sequence: NebraskaOriginalSequence,
): Promise<NebraskaNativeDataset> {
  sequence.resetAnonymousSession();
  let form = await html(sequence, "registry:form");
  neSelect(form, "ElectionID", `${sequence.year} STATEWIDE ELECTIONS`);
  clearInputs(form, ["FirstName", "LastName", "DateFrom", "DateThrough"]);
  neSelect(form, "OrganizationStatusCodeID", "");
  let target = neSelect(form, "JurisdictionTypeCodeID", "State");
  form = await html(sequence, "registry:state", nePostback(form, target));
  target = neSelect(form, "JurisdictionCodeID", "NEBRASKA");
  form = await html(
    sequence,
    "registry:jurisdiction",
    nePostback(form, target),
  );
  neSelect(form, "OfficeCodeID", "");
  neSelect(form, "DistrictID", "");
  const search = neControl(form, "Candidate_SearchButton").name;
  form = await html(sequence, "registry:search", nePostback(form, search));
  target = nePageSize(form);
  form = await html(sequence, "registry:first", nePostback(form, target));
  const registrations: NebraskaNativeRegistration[] = [],
    opening: string[] = [];
  let page = 1;
  while (true) {
    neCheck(page <= 20, "registry_page_limit");
    registryScope(form);
    const parsed = neRegistryPage(form, sequence.year);
    neCheck(
      parsed.registrations.length > 0 && parsed.registrations.length <= 50,
      "registry_page_size",
    );
    registrations.push(...parsed.registrations);
    opening.push(rowSignature(parsed.nativeRows));
    const next = neNextPage(parsed.table, page);
    if (!next) break;
    form = await html(
      sequence,
      `registry:page-${++page}`,
      nePostback(form, ...next),
    );
  }
  neCheck(
    registrations.length < 500 &&
      new Set(registrations.map((row) => row.receivingId)).size ===
        registrations.length,
    "registry_incomplete_or_duplicate",
  );
  form = await html(
    sequence,
    "registry:closing-search",
    nePostback(form, search),
  );
  target = nePageSize(form);
  form = await html(
    sequence,
    "registry:closing-first",
    nePostback(form, target),
  );
  for (let index = 0; index < opening.length; index++) {
    registryScope(form);
    const parsed = neRegistryPage(form, sequence.year);
    neCheck(
      rowSignature(parsed.nativeRows) === opening[index],
      "registry_changed",
    );
    const next = neNextPage(parsed.table, index + 1);
    if (index + 1 === opening.length) neCheck(!next, "registry_new_page");
    else {
      neCheck(next, "registry_missing_closing_page");
      form = await html(
        sequence,
        `registry:closing-${index + 2}`,
        nePostback(form, ...next),
      );
    }
  }
  return { registrations };
}

function ieScope(form: NebraskaNativeForm, year: number): void {
  neSelected(form, "DisbursementCodeHook", "Independent Expenditure");
  neSelected(form, "OrganizationCodeHook", "");
  neSelected(form, "DonorPayeeCodeHook", "");
  checkDates(form, `${year - 1}-01-01`, `${year}-12-31`);
  blankInputs(form, [
    "FirstName",
    "LastName",
    "RegistrationID",
    "DonorPayeeFirstName",
    "DonorPayeeLastName",
    "AmountFrom",
    "AmountThrough",
  ]);
}
async function ieExport(
  sequence: NebraskaOriginalSequence,
  form: NebraskaNativeForm,
  role: string,
): Promise<Buffer> {
  ieScope(form, sequence.year);
  const buttons = Array.from(
    form.document.querySelectorAll<HTMLInputElement>(
      'input[type="image"][alt="CSV"]',
    ),
  ).filter((e) => e.name.includes("$Search_Export$"));
  neCheck(buttons.length === 1, "ie_export_control");
  const body = nePostback(form, "");
  body.set(`${buttons[0]!.name}.x`, "1");
  body.set(`${buttons[0]!.name}.y`, "1");
  return sequence.request(role, body);
}
async function outside(
  sequence: NebraskaOriginalSequence,
): Promise<NebraskaNativeDataset> {
  sequence.resetAnonymousSession();
  let form = await html(sequence, "ie:form");
  neSelect(form, "OrganizationCodeHook", "");
  neSelect(form, "DonorPayeeCodeHook", "");
  neSelect(form, "DisbursementCodeHook", "Independent Expenditure");
  clearInputs(form, [
    "FirstName",
    "LastName",
    "RegistrationID",
    "DonorPayeeFirstName",
    "DonorPayeeLastName",
    "AmountFrom",
    "AmountThrough",
  ]);
  setDates(form, `${sequence.year - 1}-01-01`, `${sequence.year}-12-31`);
  const search = neControl(form, "Expenditure_SearchButton").name;
  form = await html(sequence, "ie:search", nePostback(form, search));
  ieScope(form, sequence.year);
  const empty = neExplicitNoRecords(form),
    first = empty ? null : await ieExport(sequence, form, "ie:export");
  const allocations = first === null ? [] : neIeCsv(first, sequence.year);
  neCheck(
    empty || allocations.length > 0,
    "empty_ie_export_without_no_records",
  );
  form = await html(sequence, "ie:closing-search", nePostback(form, search));
  ieScope(form, sequence.year);
  neCheck(neExplicitNoRecords(form) === empty, "ie_empty_state_changed");
  if (first !== null) {
    const closing = await ieExport(sequence, form, "ie:closing-export");
    neIeCsv(closing, sequence.year);
    neCheck(first.equals(closing), "ie_export_changed");
  }
  return { allocations };
}

function receiptPage(form: NebraskaNativeForm, scope: NebraskaReceiptScope) {
  blankInputs(form, [
    "FirstName",
    "LastName",
    "RegistrationID",
    "DonorPayeeFirstName",
    "DonorPayeeLastName",
    "DonorPayeeCity",
    "DonorPayeeZip",
    "AmountFrom",
    "AmountThrough",
  ]);
  return neReceiptPage(form, scope);
}
async function receiptWindow(
  sequence: NebraskaOriginalSequence,
  scope: NebraskaReceiptScope,
  depth = 0,
): Promise<NebraskaReportedReceipt[]> {
  neCheck(depth < 12, "receipt_partition_depth");
  sequence.resetAnonymousSession();
  const prefix = `committee:${scope.contributorClass}:${scope.start}_${scope.end}`;
  let form = await html(sequence, `${prefix}:form`);
  // Recipient changes reset the contributor selection. Use the site's real
  // dependent postbacks; posting both changed values with Search loses type.
  let target = neSelect(form, "OrganizationCodeHook", "Candidate Committee");
  form = await html(sequence, `${prefix}:recipient`, nePostback(form, target));
  neSelected(form, "OrganizationCodeHook", "Candidate Committee");
  target = neSelect(
    form,
    "DonorPayeeCodeHook",
    NEBRASKA_COMMITTEE_CLASSES[scope.contributorClass],
  );
  form = await html(
    sequence,
    `${prefix}:contributor`,
    nePostback(form, target),
  );
  neSelected(form, "OrganizationCodeHook", "Candidate Committee");
  neSelected(
    form,
    "DonorPayeeCodeHook",
    NEBRASKA_COMMITTEE_CLASSES[scope.contributorClass],
  );
  clearInputs(form, [
    "FirstName",
    "LastName",
    "RegistrationID",
    "DonorPayeeFirstName",
    "DonorPayeeLastName",
    "DonorPayeeCity",
    "DonorPayeeZip",
    "AmountFrom",
    "AmountThrough",
  ]);
  setDates(form, scope.start, scope.end);
  const search = neControl(form, "Contribution_SearchButton").name;
  form = await html(sequence, `${prefix}:search`, nePostback(form, search));
  let parsed = receiptPage(form, scope);
  const summary = parsed.summary,
    summaryCents = parsed.summaryCents;
  if (!parsed.explicitEmpty) {
    target = nePageSize(form);
    form = await html(sequence, `${prefix}:first`, nePostback(form, target));
    parsed = receiptPage(form, scope);
    neCheck(parsed.summary === summary, "receipt_summary_changed");
  }
  const first = rowSignature(parsed.nativeRows),
    receipts = [...parsed.receipts];
  let page = 1;
  while (true) {
    neCheck(page <= 100, "receipt_page_limit");
    const next = neNextPage(parsed.table, page);
    if (!next) break;
    form = await html(
      sequence,
      `${prefix}:page-${++page}`,
      nePostback(form, ...next),
    );
    parsed = receiptPage(form, scope);
    neCheck(
      parsed.summary === summary &&
        parsed.receipts.length > 0 &&
        parsed.receipts.length <= 50,
      "receipt_page_changed",
    );
    receipts.push(...parsed.receipts);
  }
  const total = receipts.reduce((n, row) => neAdd(n, row.amountCents), 0);
  if (receipts.length >= 500 || total !== summaryCents) {
    // The receipt grid silently caps at 500 even while its summary is full.
    // Keep the rejected parent originals, then acquire disjoint child scopes.
    neCheck(scope.start < scope.end, "single_day_receipts_incomplete");
    const a = Date.parse(`${scope.start}T00:00:00Z`),
      b = Date.parse(`${scope.end}T00:00:00Z`),
      middle = new Date(a + Math.floor((b - a) / 86400000 / 2) * 86400000)
        .toISOString()
        .slice(0, 10),
      next = new Date(Date.parse(`${middle}T00:00:00Z`) + 86400000)
        .toISOString()
        .slice(0, 10);
    return [
      ...(await receiptWindow(sequence, { ...scope, end: middle }, depth + 1)),
      ...(await receiptWindow(sequence, { ...scope, start: next }, depth + 1)),
    ];
  }
  form = await html(
    sequence,
    `${prefix}:closing-search`,
    nePostback(form, search),
  );
  let closing = receiptPage(form, scope);
  neCheck(closing.summary === summary, "receipt_closing_summary_changed");
  if (receipts.length) {
    // Search resets the grid to ten rows. Restore the original page size
    // before checking every first-page value and identity link.
    target = nePageSize(form);
    form = await html(
      sequence,
      `${prefix}:closing-first`,
      nePostback(form, target),
    );
    closing = receiptPage(form, scope);
  }
  neCheck(
    closing.summary === summary &&
      rowSignature(closing.nativeRows) === first &&
      closing.explicitEmpty === parsed.explicitEmpty,
    "receipt_closing_changed",
  );
  return receipts;
}
async function committees(
  sequence: NebraskaOriginalSequence,
): Promise<NebraskaNativeDataset> {
  const receipts: NebraskaReportedReceipt[] = [];
  for (const contributorClass of Object.keys(
    NEBRASKA_COMMITTEE_CLASSES,
  ) as NebraskaCommitteeClass[]) {
    for (const year of [sequence.year - 1, sequence.year])
      for (const [start, end] of [
        ["01-01", "03-31"],
        ["04-01", "06-30"],
        ["07-01", "09-30"],
        ["10-01", "12-31"],
      ]) {
        receipts.push(
          ...(await receiptWindow(sequence, {
            start: `${year}-${start}`,
            end: `${year}-${end}`,
            contributorClass,
          })),
        );
      }
  }
  const names = new Map<string, Set<string>>();
  for (const row of receipts) {
    const reported = names.get(row.receivingId) ?? new Set<string>();
    reported.add(row.receivingName);
    names.set(row.receivingId, reported);
  }
  neCheck(
    [...names.values()].every((reported) => reported.size === 1),
    "receiving_name_changed_between_scopes",
  );
  return { receipts };
}

export async function runNebraskaNativeProtocol(
  sequence: NebraskaOriginalSequence,
): Promise<NebraskaNativeDataset> {
  neCheck(
    Number.isSafeInteger(sequence.year) &&
      sequence.year >= 2021 &&
      sequence.year <= 2100,
    "source_year",
  );
  if (sequence.kind === "registry") return registry(sequence);
  if (sequence.kind === "ie") return outside(sequence);
  return committees(sequence);
}

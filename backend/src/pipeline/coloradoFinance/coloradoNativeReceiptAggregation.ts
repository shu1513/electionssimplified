import { coloradoReportedNameKey } from "./coloradoTracerReports.js";
import {
  COLORADO_COMMITTEE_CLASSES,
  coloradoReceiptAdd,
  coloradoReceiptCheck as check,
  type ColoradoNativeCommittee,
  type ColoradoNativeReceiptReport,
  type ColoradoNativeMajorNotice,
} from "./coloradoNativeReceiptReports.js";

export type ColoradoNativeReceiptGroup = {
  key: string;
  name: string;
  cashCents: number;
  occurrences: number;
};
export type ColoradoNativeReceiptControls = {
  allRows: number;
  individualRows: number;
  nonitemizedRows: number;
  unmatchedRows: number;
  committeeRows: number;
  cashCents: number;
  regularReports: number;
  coveredNotices: number;
};
/** The receiving ledger owns money. A notice consumes a unique matching
 * regular occurrence, so repeated notices cannot multiply one cash gift. */
export function aggregateColoradoNativeReceipts(input: {
  reports: readonly ColoradoNativeReceiptReport[];
  registry: readonly ColoradoNativeCommittee[];
  notices: readonly ColoradoNativeMajorNotice[];
}) {
  check(
    input.reports.length > 0 && input.registry.length > 0,
    "receipt_complete_source_required",
  );
  const registered = new Set(
    input.registry.map((r) => coloradoReportedNameKey(r.name)),
  );
  check(
    input.registry.every(
      (r) =>
        r.name &&
        (COLORADO_COMMITTEE_CLASSES as readonly string[]).includes(
          r.committeeType,
        ),
    ),
    "receipt_registry_class",
  );
  const rows = input.reports.flatMap((r) => r.rows),
    witnesses = new Map<string, number>();
  const witnessKey = (r: { name: string; date: string; amountCents: number }) =>
    JSON.stringify([coloradoReportedNameKey(r.name), r.date, r.amountCents]);
  for (const r of rows)
    if (r.kind === "Monetary (Itemized)") {
      const k = witnessKey(r);
      witnesses.set(k, (witnesses.get(k) ?? 0) + 1);
    }
  for (const notice of input.notices)
    for (const r of notice.rows) {
      const key = witnessKey(r),
        available = witnesses.get(key) ?? 0;
      check(available > 0, "receipt_uncovered_major_notice");
      witnesses.set(key, available - 1);
    }
  const groups = new Map<string, ColoradoNativeReceiptGroup>();
  const controls: ColoradoNativeReceiptControls = {
    allRows: rows.length,
    individualRows: 0,
    nonitemizedRows: 0,
    unmatchedRows: 0,
    committeeRows: 0,
    cashCents: 0,
    regularReports: input.reports.length,
    coveredNotices: input.notices.length,
  };
  for (const r of rows) {
    check(
      Number.isSafeInteger(r.amountCents) &&
        [
          "Monetary (Itemized)",
          "Monetary (Non-Itemized)",
          "Returned Contributions",
        ].includes(r.kind),
      "receipt_unqualified_kind",
    );
    if (r.kind === "Monetary (Non-Itemized)") {
      controls.nonitemizedRows++;
      continue;
    }
    if (r.contributorType === "Individual") {
      controls.individualRows++;
      continue;
    }
    const key = coloradoReportedNameKey(r.name);
    // A blank type alone proves nothing. Exact typed registration is required;
    // personal names, businesses and fuzzy name hints do not supply that proof.
    if (
      !key ||
      !registered.has(key) ||
      (r.contributorType !== "" &&
        !(COLORADO_COMMITTEE_CLASSES as readonly string[]).includes(
          r.contributorType,
        ))
    ) {
      controls.unmatchedRows++;
      continue;
    }
    const g = groups.get(key) ?? {
      key,
      name: r.name,
      cashCents: 0,
      occurrences: 0,
    };
    g.cashCents = coloradoReceiptAdd(g.cashCents, r.amountCents);
    g.occurrences = coloradoReceiptAdd(g.occurrences, 1);
    groups.set(key, g);
    controls.cashCents = coloradoReceiptAdd(controls.cashCents, r.amountCents);
    controls.committeeRows++;
  }
  const result = {
    groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)),
    controls,
  };
  validateColoradoNativeReceiptClosure(result);
  return result;
}
export function validateColoradoNativeReceiptClosure(p: {
  groups: readonly ColoradoNativeReceiptGroup[];
  controls: ColoradoNativeReceiptControls;
}): void {
  const keys = [
    "allRows",
    "individualRows",
    "nonitemizedRows",
    "unmatchedRows",
    "committeeRows",
    "cashCents",
    "regularReports",
    "coveredNotices",
  ];
  const c = p.controls;
  check(
    c &&
      Object.keys(c).sort().join("|") === keys.sort().join("|") &&
      Object.entries(c).every(
        ([key, v]) =>
          Number.isSafeInteger(v) && (key === "cashCents" || v >= 0),
      ) &&
      c.regularReports > 0 &&
      c.individualRows +
        c.nonitemizedRows +
        c.unmatchedRows +
        c.committeeRows ===
        c.allRows,
    "receipt_stored_controls",
  );
  let cash = 0,
    count = 0;
  const seen = new Set<string>();
  for (const g of p.groups) {
    check(
      g &&
        typeof g.name === "string" &&
        g.name.trim().length > 0 &&
        g.name.length <= 1000 &&
        g.key === coloradoReportedNameKey(g.name) &&
        !seen.has(g.key) &&
        Number.isSafeInteger(g.cashCents) &&
        Number.isSafeInteger(g.occurrences) &&
        g.occurrences > 0,
      "receipt_stored_group",
    );
    seen.add(g.key);
    cash = coloradoReceiptAdd(cash, g.cashCents);
    count = coloradoReceiptAdd(count, g.occurrences);
  }
  check(
    cash === c.cashCents && count === c.committeeRows,
    "receipt_stored_group_closure",
  );
}

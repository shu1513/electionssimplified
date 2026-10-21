import {
  vaAdd,
  vaCents,
  vaCheck,
  vaDate,
  vaDocument,
  vaField,
  vaKey,
  vaNodeText,
  vaPostal,
  vaPublicUrl,
} from "./virginiaReportedNative.js";

export function vaDay(value: string): string {
  const match = /^(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(
    value.trim(),
  );
  vaCheck(match, "native_date");
  return vaDate(match[1]!);
}
export const vaAddress = (node: ParentNode): string[] =>
  ["Line1", "City", "State", "ZipCode"].map((k) => {
    const fields = node.querySelectorAll(`Address > ${k}`);
    vaCheck(fields.length <= 1, "ambiguous_address_field");
    return fields.length ? vaNodeText(fields[0]!) : "";
  });
export function vaInventory(raw: Uint8Array, id: string, url: string) {
  const d = vaDocument(raw);
  try {
    vaCheck(
      d.querySelectorAll("#ScheduledReports").length === 1 &&
        d.querySelectorAll("#LargeContributionReports").length === 1,
      "inventory_sections",
    );
    const titles = [...d.querySelectorAll("h2")]
      .map(vaNodeText)
      .filter((text) => text.startsWith("Reports for "));
    vaCheck(titles.length === 1, "inventory_title");
    const identity = /^Reports for (.+)\s+\(([^()]+)\)$/.exec(titles[0]!);
    vaCheck(identity, "inventory_receiving_identity");
    const parsed = {
      committeeId: id,
      committeeName: identity[1]!.trim(),
      committeeCode: identity[2]!.trim(),
      sourceUrl: url,
      scheduledReportIds: [] as number[],
      largeContributionReportIds: [] as number[],
    };
    const ids: number[] = [];
    for (const [selector, expected] of [
      ["#ScheduledReports", parsed.scheduledReportIds],
      ["#LargeContributionReports", parsed.largeContributionReportIds],
    ] as const) {
      const actual = [
        ...d.querySelectorAll(`${selector} a[href*='/Report/Index/']`),
      ].map((n) => {
        const href = vaPublicUrl(n.getAttribute("href")!, url),
          m = /^\/Report\/Index\/([1-9]\d*)$/.exec(new URL(href).pathname);
        vaCheck(m && !new URL(href).search, "inventory_report_link");
        return Number(m[1]);
      });
      vaCheck(
        new Set(actual).size === actual.length,
        "inventory_complete_reports",
      );
      expected.push(...actual);
      ids.push(...actual);
    }
    vaCheck(new Set(ids).size === ids.length, "duplicate_inventory_report");
    return parsed;
  } finally {
    d.defaultView?.close();
  }
}
export type VirginiaRegistration = {
  id: string;
  name: string;
  type: string;
  candidate: string;
  url: string;
};
export function vaRegistrations(
  raw: Uint8Array,
  url: string,
): VirginiaRegistration[] {
  const d = vaDocument(raw),
    u = new URL(url);
  try {
    vaCheck(
      u.searchParams.has("CommitteeName") &&
        u.searchParams.get("CommitteeType") === "",
      "registry_all_classes_request",
    );
    vaCheck(
      (d.querySelector("input#CommitteeName") as HTMLInputElement | null)
        ?.value === u.searchParams.get("CommitteeName") &&
        (d.querySelector("select#CommitteeType") as HTMLSelectElement | null)
          ?.value === "",
      "registry_query_echo",
    );
    const table = d.querySelectorAll("#CommitteeResults");
    vaCheck(table.length === 1, "registry_table");
    const rows = [...table[0]!.querySelectorAll("tbody tr")].filter((n) =>
      n.querySelector("a[href*='/Committee/Index/']"),
    );
    const rendered = (n: Node): string =>
      n.nodeType === 3
        ? (n.textContent ?? "")
        : [...n.childNodes].map(rendered).join(" ");
    const counts = [
      ...rendered(d.body)
        .replace(/\s+/g, " ")
        .matchAll(/\b([\d,]+) Records\b/g),
    ];
    vaCheck(
      counts.length === 1 &&
        Number(counts[0]![1]!.replace(/,/g, "")) === rows.length,
      "registry_incomplete_page",
    );
    return rows.map((r) => {
      const links = r.querySelectorAll("a[href*='/Committee/Index/']");
      vaCheck(links.length === 1, "registry_native_link");
      const href = vaPublicUrl(links[0]!.getAttribute("href")!, url),
        id = decodeURIComponent(new URL(href).pathname.split("/").at(-1)!);
      return {
        id,
        name: vaField(r, "td.committeeName"),
        type: vaField(r, "td.committeeType"),
        candidate: vaField(r, "td.candidateName", true),
        url: href,
      };
    });
  } finally {
    d.defaultView?.close();
  }
}
export type VirginiaReceipt = {
  name: string;
  individual: boolean;
  address: string[];
  day: string;
  cents: number;
  signature: string;
  kind: "A" | "B";
};
export type VirginiaNativeReport = {
  code: string;
  name: string;
  address: string[];
  filed: string;
  year: number;
  office: string;
  district: string;
  start: string;
  end: string;
  rapid: boolean;
  rows: VirginiaReceipt[];
};
/** A changed/amended family is held until its native replacement relationship
 * can be proved. The previous component survives; no silent version dedup. */
export function vaReport(raw: Uint8Array): VirginiaNativeReport {
  const d = vaDocument(raw, true);
  try {
    vaCheck(
      ["Report", "LargeContributionReport"].includes(d.documentElement.tagName),
      "native_report_root",
    );
    const h = d.querySelector("ReportHeader");
    vaCheck(h, "native_report_header");
    vaCheck(
      vaField(h, "IsAmendment") === "false" &&
        ["", "0"].includes(vaField(h, "AmendedReportNumber", true)),
      "unqualified_amendment_family",
    );
    const cycle = /^(\d{1,2})\/(20\d{2})$/.exec(vaField(h, "ElectionCycle"));
    vaCheck(
      cycle && Number(cycle[1]) >= 1 && Number(cycle[1]) <= 12,
      "explicit_election_cycle",
    );
    const rows: VirginiaReceipt[] = [];
    for (const kind of ["A", "B"] as const) {
      const schedules = d.querySelectorAll(`Schedule${kind}`);
      vaCheck(schedules.length <= 1, "duplicate_schedule");
      const entries = schedules.length ? [...schedules[0]!.children] : [];
      vaCheck(
        entries.every((n) => n.tagName === `Li${kind}`),
        "unrecognized_schedule_item",
      );
      const parsed = entries.map((n) => {
        const contributors = n.querySelectorAll("Contributor");
        vaCheck(contributors.length === 1, "receipt_contributor");
        const c = contributors[0]!,
          flag = c.getAttribute("IsIndividual");
        vaCheck(
          flag === "true" || flag === "false",
          "explicit_contributor_type",
        );
        const names = [...c.children]
          .filter((n) =>
            ["FirstName", "MiddleName", "LastName", "Suffix"].includes(
              n.tagName,
            ),
          )
          .map(vaNodeText)
          .filter(Boolean);
        const name = c.querySelector("OrganizationName")
          ? vaField(c, "OrganizationName")
          : names.join(" ");
        vaCheck(name, "receipt_name");
        const day = vaDay(vaField(n, "TransactionDate")),
          cents = vaCents(vaField(n, "Amount"));
        return {
          name,
          individual: flag === "true",
          address: vaAddress(c),
          day,
          cents,
          kind,
          signature: JSON.stringify([`Li${kind}`, vaNodeText(c), day, cents]),
        };
      });
      if (d.documentElement.tagName === "Report") {
        const count = vaField(d, `ScheduleG > Schedule${kind}Count`);
        vaCheck(
          /^\d+$/.test(count) &&
            Number(count) === parsed.length &&
            vaCents(vaField(d, `ScheduleG > Schedule${kind}Total`)) ===
              parsed.reduce((n, r) => vaAdd(n, r.cents), 0),
          "native_itemized_controls",
        );
      }
      rows.push(...parsed);
    }
    return {
      code: vaField(h, "CommitteeCode"),
      name: vaField(h, "CommitteeName"),
      address: vaAddress(h),
      filed: vaDay(vaField(h, "FilingDate")),
      year: Number(cycle[2]),
      office: vaField(h, "OfficeSought"),
      district: vaField(h, "District", true),
      start: vaDay(vaField(h, "StartDate")),
      end: vaDay(vaField(h, "EndDate")),
      rapid: d.documentElement.tagName === "LargeContributionReport",
      rows,
    };
  } finally {
    d.defaultView?.close();
  }
}
export function vaPartitionReports(
  reports: readonly VirginiaNativeReport[],
  year: number,
): VirginiaReceipt[] {
  const current = reports.filter((r) => r.year === year),
    scheduled = current
      .filter((r) => !r.rapid)
      .sort((a, b) => a.start.localeCompare(b.start));
  vaCheck(scheduled.length > 0, "no_current_scheduled_reports");
  for (let i = 0; i < scheduled.length; i++) {
    const r = scheduled[i]!;
    vaCheck(
      r.start <= r.end && (!i || scheduled[i - 1]!.end < r.start),
      "overlapping_scheduled_periods",
    );
    vaCheck(
      r.rows.every((row) => row.day >= r.start && row.day <= r.end),
      "receipt_outside_scheduled_period",
    );
  }
  const last = scheduled.at(-1)!.end,
    admitted = scheduled.flatMap((r) => r.rows),
    available = new Map<string, number>();
  for (const row of admitted)
    available.set(row.signature, (available.get(row.signature) ?? 0) + 1);
  const extra = new Set<string>();
  for (const report of current.filter((r) => r.rapid))
    for (const row of report.rows) {
      if (row.day <= last) {
        vaCheck(
          scheduled.some((r) => row.day >= r.start && row.day <= r.end),
          "rapid_in_uncovered_gap",
        );
        const count = available.get(row.signature) ?? 0;
        vaCheck(count > 0, "covered_rapid_occurrence_mismatch");
        available.set(row.signature, count - 1);
      } else {
        vaCheck(
          !extra.has(row.signature),
          "ambiguous_uncovered_rapid_duplicate",
        );
        extra.add(row.signature);
        admitted.push(row);
      }
    }
  return admitted;
}
export function vaPacIdentity(
  row: VirginiaReceipt,
  registration: VirginiaRegistration[],
  headers: readonly { name: string; address: string[]; filed: string }[],
): boolean {
  if (row.individual) return false;
  const matches = registration.filter((r) => vaKey(r.name) === vaKey(row.name));
  if (matches.length !== 1 || matches[0]!.type !== "Political Action Committee")
    return false;
  return (
    row.address.every(Boolean) &&
    headers.some(
      (h) =>
        vaKey(h.name) === vaKey(row.name) &&
        h.filed <= row.day &&
        h.address.every((p, i) => vaPostal(p) === vaPostal(row.address[i]!)),
    )
  );
}
export type VirginiaIeParent = {
  url: string;
  spender: string;
  cents: number;
  cells: string[];
};
export function vaIeIndex(raw: Uint8Array, url: string): VirginiaIeParent[] {
  const d = vaDocument(raw);
  try {
    const tables = d.querySelectorAll("table");
    vaCheck(tables.length === 1, "ie_index_table");
    vaCheck(
      JSON.stringify([...tables[0]!.querySelectorAll("th")].map(vaNodeText)) ===
        JSON.stringify([
          "Expenditure Date",
          "Status Date",
          "Funds Expended By",
          "Description of Expenditure",
          "Expenditure Amount",
          "",
        ]),
      "ie_index_headers",
    );
    vaCheck(
      !d.querySelector(".pagination, [rel='next']"),
      "unqualified_ie_paging",
    );
    const rows = [...tables[0]!.querySelectorAll("tbody tr")].map((r) => {
      const cells = [...r.children].map(vaNodeText),
        links = r.querySelectorAll("a[href]");
      vaCheck(cells.length === 6 && links.length === 1, "ie_index_row");
      const href = vaPublicUrl(links[0]!.getAttribute("href")!, url);
      vaCheck(new URL(href).pathname.startsWith("/IE/"), "ie_detail_link");
      vaCheck(cells[2], "ie_economic_spender");
      return {
        url: href,
        spender: cells[2]!,
        cents: vaCents(cells[4]!),
        cells,
      };
    });
    vaCheck(
      rows.length > 0 && new Set(rows.map((r) => r.url)).size === rows.length,
      "ie_index_complete_unique",
    );
    return rows;
  } finally {
    d.defaultView?.close();
  }
}
function detailFields(node: ParentNode) {
  return [...node.querySelectorAll("p > strong")]
    .filter((n) => n === n.parentElement!.firstElementChild)
    .map((n) => ({
      label: vaNodeText(n),
      value: vaNodeText(n.parentElement!).slice(vaNodeText(n).length).trim(),
      node: n.parentElement!,
    }));
}
export type VirginiaIeAllocation = {
  name: string;
  office: string;
  stance: "support" | "oppose";
  numerator: bigint;
  denominator: bigint;
};
export function vaIeDetail(
  raw: Uint8Array,
  parent: VirginiaIeParent,
): { day: string; targets: VirginiaIeAllocation[] } {
  const d = vaDocument(raw);
  try {
    const fields = detailFields(d),
      get = (label: string) => {
        const f = fields.filter((f) => f.label === label);
        vaCheck(f.length === 1, "ie_native_field");
        return f[0]!.value;
      };
    const amount = vaCents(get("Total Amount Paid:")),
      paid = fields.filter((f) => f.label === "Amount Paid:");
    vaCheck(
      amount === parent.cents &&
        paid.length > 0 &&
        paid.reduce((n, f) => vaAdd(n, vaCents(f.value)), 0) === amount,
      "ie_parent_money_closure",
    );
    const targets = fields
      .filter((f) => f.label === "Candidate Committee Name:")
      .map((c) => {
        vaCheck(c.value, "ie_explicit_candidate");
        const f = detailFields(c.node.parentElement!),
          v = (label: string) => {
            const a = f.filter((f) => f.label === label);
            vaCheck(a.length === 1 && a[0]!.value, "ie_target_field");
            return a[0]!.value;
          };
        const stance = v("Support or Oppose:"),
          percent = v("Percent of Expenditure:").replace(/%$/, ""),
          m = /^(\d+)(?:\.(\d+))?$/.exec(percent);
        vaCheck(
          ["Support", "Oppose"].includes(stance) && m,
          "ie_explicit_stance_percent",
        );
        const denominator = 10n ** BigInt((m[2] ?? "").length),
          numerator = BigInt(m[1]!) * denominator + BigInt(m[2] ?? "0");
        vaCheck(
          numerator >= 0n && numerator <= 100n * denominator,
          "ie_percentage_range",
        );
        return {
          name: c.value,
          office: v("Office Sought:"),
          stance:
            stance === "Support" ? ("support" as const) : ("oppose" as const),
          numerator,
          denominator,
        };
      });
    vaCheck(targets.length > 0, "ie_no_candidate_allocations");
    const scale = targets.reduce(
      (n, t) => (t.denominator > n ? t.denominator : n),
      1n,
    );
    vaCheck(
      targets.reduce(
        (n, t) => n + t.numerator * (scale / t.denominator),
        0n,
      ) ===
        100n * scale,
      "ie_percentage_closure",
    );
    return { day: vaDay(get("Date Funds Expended:")), targets };
  } finally {
    d.defaultView?.close();
  }
}
export function vaAllocatedCents(
  amount: number,
  target: VirginiaIeAllocation,
): number {
  const n = BigInt(amount) * target.numerator,
    d = 100n * target.denominator;
  vaCheck(n % d === 0n, "fractional_cent_allocation");
  const cents = Number(n / d);
  vaCheck(Number.isSafeInteger(cents), "amount_overflow");
  return cents;
}

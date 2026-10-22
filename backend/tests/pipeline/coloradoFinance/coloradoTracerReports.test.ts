import { describe, expect, it } from "vitest";
import {
  coloradoReportCents,
  coloradoReportDate,
  parseColoradoIndependentExpenditureReport,
  parseColoradoIeReporterRegistry,
  parseColoradoReportCsv,
} from "../../../src/pipeline/coloradoFinance/coloradoTracerReports.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const attrs = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}="${escape(v)}"`)
    .join(" ");
const csv = (rows: string[][]) =>
  bytes(
    rows
      .map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(","))
      .join("\r\n") + "\r\n",
  );
const columns = [
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
];
const target = (name = "Ada Example", stance = "Supporting") => ({
  Textbox6: `${stance}: ${name}`,
  Office: "Party: DEMOCRATIC",
  Textbox99: "Office: GOVERNOR",
});
function report(
  input: {
    amounts?: string[];
    targetCounts?: number[];
    control?: string;
    name?: string;
  } = {},
) {
  const amounts = input.amounts ?? ["100.0000"];
  const total = amounts.reduce((n, v) => n + coloradoReportCents(v), 0);
  const group = {
    Textbox12: `STATEWIDE Expenditure Total: ${input.control ?? (total / 100).toFixed(2)}`,
  };
  const scope = {
    JurisdictionName: "STATEWIDE",
    BeginDate: "2025-01-01T00:00:00",
    EndDate: "2026-10-22T00:00:00",
  };
  const expanded: string[][] = [];
  const parents = amounts.map((amount, index) => {
    const p = {
      Textbox20: `${input.name ?? "Example Action"}, `,
      PayeeZipCode: "Example Vendor, ",
      Textbox21: amount,
      ExpenditureDate: "2026-10-14T00:00:00",
      Textbox48: "N/A",
      Textbox49: "N/A",
    };
    const children = Array.from(
      { length: input.targetCounts?.[index] ?? 1 },
      (_, i) => target(i ? "Grace Sample" : "Ada Example"),
    );
    for (const child of children) {
      const all = { ...group, ...p, ...child } as Record<string, string>;
      expanded.push(columns.map((k) => all[k]!));
    }
    return `<Group2 ${attrs(p)}>${children.map((t) => `<Details ${attrs(t)}/>`).join("")}</Group2>`;
  });
  return {
    csv: csv([
      Object.keys(scope),
      Object.values(scope),
      [""],
      [""],
      columns,
      ...expanded,
    ]),
    xml: bytes(
      `<Report Name="rpt_CF_EXPN_008" ${attrs(scope)}><Group1 ${attrs(group)}>${parents.join("")}</Group1></Report>`,
    ),
    startDate: "2025-01-01",
    endDate: "2026-10-22",
  };
}
const str = (b: Uint8Array) => new TextDecoder().decode(b);
function registry(type = "Independent Expenditure Committee") {
  const root = {
    JurisdictionSelection: "STATEWIDE",
    ActiveOnlySelection: "No",
    OfficeSelection: type,
  };
  const group = { JurisdictionName: "STATEWIDE" };
  const detail = {
    CommitteeType: type,
    CommitteeName: "Example Action",
    CandidateName: "",
    RegAgentName: "Example Agent",
    ReportingSchedule: "Frequent",
    OrganizationStatus: "Active",
  };
  const head = ["JurisdictionName", ...Object.keys(detail)];
  return {
    csv: csv([
      Object.keys(root),
      Object.values(root),
      [""],
      [""],
      head,
      [group.JurisdictionName, ...Object.values(detail)],
    ]),
    xml: bytes(
      `<Report Name="rpt_CF_COMM_001" ${attrs(root)}><Group1 ${attrs(group)}><Detail ${attrs(detail)}/></Group1></Report>`,
    ),
  };
}

describe("strict Colorado native reports", () => {
  it("counts a shared expense once while preserving each source target", () => {
    const result = parseColoradoIndependentExpenditureReport(
      report({ targetCounts: [2] }),
    );
    expect(result).toMatchObject({
      parentCount: 1,
      targetCount: 2,
      signedParentCents: 10_000,
      multipleTargetParents: 1,
    });
    expect(result.expenses[0]).toMatchObject({
      reportedName: "Example Action",
      amountCents: 10_000,
    });
    expect(result.expenses[0]!.targets[0]).toEqual({
      asFiled: "Supporting: Ada Example",
      name: "Ada Example",
      stance: "support",
      party: "DEMOCRATIC",
      office: "GOVERNOR",
    });
  });
  it("retains signed credits and identical repeated occurrences", () => {
    const result = parseColoradoIndependentExpenditureReport(
      report({ amounts: ["3100.08", "3100.08", "-100.0000"] }),
    );
    expect(result).toMatchObject({
      parentCount: 3,
      targetCount: 3,
      signedParentCents: 610_016,
      negativeParents: 1,
    });
  });
  it("does not mistake the source party field for a district", () => {
    const t =
      parseColoradoIndependentExpenditureReport(report()).expenses[0]!
        .targets[0]!;
    expect(t.party).toBe("DEMOCRATIC");
    expect(t).not.toHaveProperty("district");
  });
  it("preserves an unrecognized stance as unassigned", () => {
    const input = report();
    input.csv = bytes(
      str(input.csv).replaceAll("Supporting: Ada Example", "Unspecified"),
    );
    input.xml = bytes(
      str(input.xml).replaceAll("Supporting: Ada Example", "Unspecified"),
    );
    expect(
      parseColoradoIndependentExpenditureReport(input).expenses[0]!.targets[0],
    ).toMatchObject({ name: null, stance: null, asFiled: "Unspecified" });
  });
  it("reconciles display formatting without dropping the group money control", () => {
    const input = report({ amounts: ["3100.08"] });
    input.csv = bytes(
      str(input.csv).replace(
        "STATEWIDE Expenditure Total: 3100.08",
        "STATEWIDE Expenditure Total: $3,100.08",
      ),
    );
    expect(
      parseColoradoIndependentExpenditureReport(input).signedParentCents,
    ).toBe(310_008);
  });
  it("rejects a changed native parent control", () =>
    expect(() =>
      parseColoradoIndependentExpenditureReport(report({ control: "101.00" })),
    ).toThrow("native_ie_parent_money_control"));
  it("rejects different CSV target identity even when amounts and row counts agree", () => {
    const input = report();
    input.csv = bytes(str(input.csv).replace("Ada Example", "Grace Sample"));
    expect(() => parseColoradoIndependentExpenditureReport(input)).toThrow(
      "csv_xml_occurrences_changed",
    );
  });
  it("rejects a missing repeated occurrence", () => {
    const input = report({ amounts: ["100", "100"] });
    const rows = parseColoradoReportCsv(input.csv);
    rows.pop();
    input.csv = csv(rows);
    expect(() => parseColoradoIndependentExpenditureReport(input)).toThrow(
      "csv_xml_occurrence_count",
    );
  });
  it("rejects an expense with no printed target", () =>
    expect(() =>
      parseColoradoIndependentExpenditureReport(report({ targetCounts: [0] })),
    ).toThrow("native_ie_parent_without_targets"));
  it("rejects rows outside the native report window", () => {
    const input = report();
    input.xml = bytes(
      str(input.xml).replace("2026-10-14T00:00:00", "2027-01-01T00:00:00"),
    );
    expect(() => parseColoradoIndependentExpenditureReport(input)).toThrow(
      "native_ie_event_outside_scope",
    );
  });
  it("rejects a different query scope", () =>
    expect(() =>
      parseColoradoIndependentExpenditureReport({
        ...report(),
        endDate: "2026-10-21",
      }),
    ).toThrow("native_ie_date_scope"));
  it("rejects malformed CSV suffixes after valid records", () => {
    const input = report();
    input.csv = bytes(str(input.csv) + '"bad"junk\r\n');
    expect(() => parseColoradoIndependentExpenditureReport(input)).toThrow(
      "invalid_source_csv_quote_suffix",
    );
  });
  it("rejects a wrong report definition", () => {
    const input = report();
    input.xml = bytes(
      str(input.xml).replace("rpt_CF_EXPN_008", "rpt_CF_CONT_001"),
    );
    expect(() => parseColoradoIndependentExpenditureReport(input)).toThrow(
      "native_ie_report_kind",
    );
  });
  it("rejects XML entity declarations", () => {
    const input = report();
    input.xml = bytes(
      '<!DOCTYPE Report [<!ENTITY x "changed">]>' + str(input.xml),
    );
    expect(() => parseColoradoIndependentExpenditureReport(input)).toThrow(
      "xml_declarations_prohibited",
    );
  });
  it("rejects an unproved reporting caption instead of inferring its name", () => {
    const input = report();
    input.xml = bytes(
      str(input.xml).replace(
        'Textbox20="Example Action, "',
        'Textbox20="Example Action"',
      ),
    );
    expect(() => parseColoradoIndependentExpenditureReport(input)).toThrow(
      "native_reporting_caption",
    );
  });
  it("parses a paired typed registry with names exactly as reported", () =>
    expect(parseColoradoIeReporterRegistry(registry())).toEqual([
      {
        name: "Example Action",
        committeeType: "Independent Expenditure Committee",
        status: "Active",
      },
    ]));
  it("rejects receiving committee type as a substitute for IE registry type", () =>
    expect(() =>
      parseColoradoIeReporterRegistry(registry("Candidate Committee")),
    ).toThrow("native_ie_registry_class"));
  it("rejects a changed registry name in one format", () => {
    const input = registry();
    input.csv = bytes(
      str(input.csv).replace("Example Action", "Sample Action"),
    );
    expect(() => parseColoradoIeReporterRegistry(input)).toThrow(
      "csv_xml_occurrences_changed",
    );
  });
});
describe("native scalar and framing guards", () => {
  it.each([
    ["3100.08", 310008],
    ["-0.10", -10],
    ["12.340000", 1234],
    ["($1,234.56)", -123456],
    ["0.1", 10],
  ])("reads exact cents %s", (value, expected) =>
    expect(coloradoReportCents(value)).toBe(expected),
  );
  it.each([
    "0.001",
    "1.000001",
    "NaN",
    "Infinity",
    "1e3",
    "",
    "9007199254740992",
  ])("rejects unsafe/nondecimal money %s", (value) =>
    expect(() => coloradoReportCents(value)).toThrow(),
  );
  it.each([
    "2026-02-30",
    "02/29/2026",
    "2026-01-01T24:00:00",
    "2026-01-01T00:00:00+99:99",
  ])("rejects invalid calendar/time %s", (value) =>
    expect(() => coloradoReportDate(value)).toThrow("invalid_source_date"),
  );
  it("preserves quoted commas and repeated field occurrences", () =>
    expect(
      parseColoradoReportCsv(bytes('a,b\r\n"one, two","three"\r\n')),
    ).toEqual([
      ["a", "b"],
      ["one, two", "three"],
    ]));
  it("rejects invalid UTF8 before interpreting rows", () =>
    expect(() =>
      parseColoradoReportCsv(new Uint8Array([0x61, 0x2c, 0xff])),
    ).toThrow("invalid_source_utf8"));
  it("rejects bare and unterminated quotes", () => {
    for (const s of ['ab"cd,x\n', '"ab,x\n'])
      expect(() => parseColoradoReportCsv(bytes(s))).toThrow();
  });
});

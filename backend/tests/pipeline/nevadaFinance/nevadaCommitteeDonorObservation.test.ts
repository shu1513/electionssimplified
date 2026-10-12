import { describe, expect, it } from "vitest";
import { validateNevadaCommitteeDonorObservation } from "../../../src/pipeline/nevadaFinance/nevadaCommitteeDonorObservation.js";

const SEARCH =
  "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx";
const OFFICE = "State Assembly, District 32";
const NOW = new Date("2026-10-12T10:00:00.000Z");
const DIGEST = "a".repeat(64);

type Row = {
  occurrence: number;
  contributorName: string;
  date: string;
  amount: string;
  loanCellBlank: boolean;
  loanCheckboxChecked: boolean | null;
};
type Report = {
  candidateName: string;
  reportLabel: string;
  reportYear: number;
  observedAt: string;
  reportFlags: { id: string; checked: boolean }[];
  periodChoices: { label: string; checked: boolean }[];
  loanColumnHeading: string;
  expenseReturnLiteralCount: number;
  summary: Record<string, string[]>;
  cashRows: Row[];
};

function cash(
  name: string,
  date: string,
  dollars: number,
  occurrence = 0,
): Row {
  return {
    occurrence,
    contributorName: name,
    date,
    amount: `$${dollars.toFixed(2)}`,
    loanCellBlank: true,
    loanCheckboxChecked: null,
  };
}
function summary(total: number): Record<string, string[]> {
  const rows: Record<string, string[]> = {};
  for (let line = 1; line <= 13; line += 1) {
    const amount = line === 1 || line === 8 ? `$${total.toFixed(2)}` : "$0.00";
    rows[String(line)] =
      line === 13
        ? [amount]
        : line === 8 || line === 12
          ? [amount, amount]
          : ["$100.00", amount, amount];
  }
  return rows;
}
function report(
  label: string,
  year: number,
  period: string,
  rows: Row[],
  minute: number,
): Report {
  const total = rows.reduce((sum, row) => sum + Number(row.amount.slice(1)), 0);
  return {
    candidateName: "Synthetic Candidate",
    reportLabel: label,
    reportYear: year,
    observedAt: `2026-10-12T09:${minute}:00.000Z`,
    reportFlags: [
      { id: "prefix_chkCANDIDATE", checked: true },
      { id: "prefix_chkLEGALDEFENSE", checked: false },
      { id: "prefix_chkAMENDED", checked: false },
      { id: "prefix_chkDeclaration", checked: true },
      { id: "prefix_chkTerms", checked: true },
    ],
    periodChoices: [{ label: `Period: ${period}`, checked: true }],
    loanColumnHeading: "CHECK HERE IF LOAN",
    expenseReturnLiteralCount: 0,
    summary: summary(total),
    cashRows: rows,
  };
}
function pages(rows: string[][], closing = false) {
  const count = Math.ceil(rows.length / 25);
  return Array.from({ length: count }, (_, index) => ({
    observedAt: `2026-10-12T09:${closing ? 20 + index : String(index).padStart(2, "0")}:00.000Z`,
    pager: [
      `Page ${index + 1} of ${count}, items ${index * 25 + 1} to ${Math.min(rows.length, (index + 1) * 25)} of ${rows.length}.`,
    ],
    rows: rows.slice(index * 25, (index + 1) * 25).map((row) => [...row]),
  }));
}
function fixture() {
  const financialObservations = [
    report(
      "2026 Annual CE Filing",
      2025,
      "Jan 01, 2025 - Dec 31, 2025",
      [cash("Synthetic P.A.C.", "6/1/2025", 1000)],
      10,
    ),
    report(
      "CE Report 1",
      2026,
      "Jan 01, 2026 - Mar 31, 2026",
      [
        cash("Equal Gift PAC", "2/1/2026", 500),
        cash("Equal Gift PAC", "2/1/2026", 500, 1),
      ],
      11,
    ),
    report(
      "CE Report 2",
      2026,
      "Apr 01, 2026 - Jun 30, 2026",
      [cash("Synthetic Individual", "5/1/2026", 300)],
      12,
    ),
  ];
  const manifestRows = [
    ["2026 Annual CE Filing", "2025", "1/15/2026", OFFICE, "View"],
    ["CE Report 1", "2026", "4/15/2026", OFFICE, "View"],
    ["CE Report 2", "2026", "7/15/2026", OFFICE, "View"],
  ];
  return {
    summaryLineLabels: {
      "1": "1. Total Monetary Contributions Received in Excess of $100",
      "8": "8. Total Amount of All Contributions (Add Lines 1 through 7)",
      "13": "13. Fund balance at the end of the reporting period",
    },
    version: 1,
    sourceMode: "browser_financial_observation",
    locatorValuesOmitted: true,
    httpResponseMetadataClaimed: false,
    sourceCanonicalPaths: {
      search: SEARCH,
      candidate:
        "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/CandidateDetails.aspx",
      report:
        "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/ViewCCEReport.aspx",
    },
    context: {
      candidateName: "Synthetic Candidate",
      office: OFFICE,
      electionYear: 2026,
      jurisdiction: "NV SOS",
    },
    openingManifest: pages(manifestRows),
    closingManifest: pages(manifestRows, true),
    financialObservations,
    priorFinancialObservations: financialObservations.map((row) => ({
      ...structuredClone(row),
      observedAt: "2026-10-12T08:00:00.000Z",
    })),
    // A research-only query without published cardinality cannot supply registry recognition.
    keystoneRegistryObservation: {
      declaredCount: null,
      rows: [
        { name: "Generic Corporation", type: "Political Action Committee" },
      ],
    },
  };
}
function validate(value: unknown, now = NOW) {
  return validateNevadaCommitteeDonorObservation(value, {
    now,
    captureDigest: DIGEST,
  });
}
function alterBoth(
  value: ReturnType<typeof fixture>,
  index: number,
  change: (report: Report) => void,
) {
  change(value.financialObservations[index]!);
  change(value.priorFinancialObservations[index]!);
}

describe("Nevada manually decoded financial observations", () => {
  it("closes the whole observed cash scope without claiming HTTP or legal-profile authority", () => {
    const result = validate(fixture());
    expect(result).toMatchObject({
      filerName: "Synthetic Candidate",
      electionYear: 2026,
      sourceOffice: OFFICE,
      cashRowCount: 4,
      cashCents: 230000,
      reportCount: 3,
      pacDonorSource: {
        periodStart: "2025-01-01",
        periodEnd: "2026-06-30",
        captureDigest: DIGEST,
      },
    });
    expect(result.pacDonorSource.observedAt).toEqual(
      new Date("2026-10-12T09:20:00.000Z"),
    );
    expect(result.pacDonors).toEqual([
      {
        committeeId: "reported:EQUAL GIFT PAC",
        committeeName: "Equal Gift PAC",
        recognitionMethod: "reported_name",
        totalAmount: 1000,
        contributionCount: 2,
        sourceUrl: SEARCH,
      },
      {
        committeeId: "reported:SYNTHETIC P.A.C.",
        committeeName: "Synthetic P.A.C.",
        recognitionMethod: "reported_name",
        totalAmount: 1000,
        contributionCount: 1,
        sourceUrl: SEARCH,
      },
    ]);
    expect(result.warnings[0]).toMatch(
      /registry-name acceptance requires complete query/,
    );
  });

  it("rejects relabeling intact report money as another candidate", () => {
    const value = fixture();
    value.context.candidateName = "Different Candidate";
    expect(() => validate(value)).toThrow(/report candidate ownership/);
  });

  it.each([undefined, "", "Different Candidate"])(
    "rejects missing or mismatched report owner %s in paired observations",
    (candidateName) => {
      const value = fixture();
      alterBoth(value, 1, (report) => {
        Object.assign(report, { candidateName });
      });
      expect(() => validate(value)).toThrow(/report candidate ownership/);
    },
  );

  it("accepts the same public candidate name with harmless formatting differences", () => {
    const value = fixture();
    alterBoth(value, 1, (report) => {
      report.candidateName = "  SYNTHETIC   CANDIDATE  ";
    });
    expect(validate(value).cashCents).toBe(230000);
  });

  it("allows an empty recognized-name subset without claiming the whole cash or PAC universe is zero", () => {
    const value = fixture();
    for (
      let index = 0;
      index < value.financialObservations.length;
      index += 1
    ) {
      alterBoth(value, index, (row) => {
        row.cashRows.forEach((cashRow) => {
          cashRow.contributorName = "Generic Corporation";
        });
      });
    }
    const result = validate(value);
    expect(result.pacDonors).toEqual([]);
    expect(result.cashCents).toBe(230000);
    expect(result.cashRowCount).toBe(4);
    expect(result.warnings[0]).toMatch(/Only literal reported PAC names/);
  });

  it.each(["1", "8", "13"])(
    "rejects a numbered but misidentified source financial role at line %s",
    (line) => {
      const value = fixture();
      value.summaryLineLabels[line as "1" | "8" | "13"] =
        `${line}. An unrelated financial role`;
      expect(() => validate(value)).toThrow("summary roles changed");
    },
  );

  it("retains distinct equal gifts instead of economic deduplication", () => {
    const result = validate(fixture());
    expect(result.cashRowCount).toBe(4);
    expect(
      result.pacDonors.find((row) => row.committeeName === "Equal Gift PAC")
        ?.contributionCount,
    ).toBe(2);
  });

  it("requires all physical rows and declared page ranges across a 25-row boundary", () => {
    const value = fixture();
    const rows = [
      ...value.openingManifest[0]!.rows,
      ...Array.from({ length: 23 }, (_, index) => [
        `Financial Disclosure historical ${index}`,
        "2024",
        "1/1/2025",
        OFFICE,
        "View",
      ]),
    ];
    value.openingManifest = pages(rows);
    value.closingManifest = pages(rows, true);
    expect(validate(value).manifestRows).toHaveLength(26);
    value.closingManifest[1]!.rows = [];
    expect(() => validate(value)).toThrow(/physical rows/);
  });

  it.each([
    "missing page",
    "changed count",
    "ambiguous descriptor",
    "changed closing row",
  ])("rejects %s", (reason) => {
    const value = fixture();
    if (reason === "missing page")
      value.openingManifest[0]!.pager = ["Page 1 of 2, items 1 to 25 of 26."];
    if (reason === "changed count")
      value.closingManifest[0]!.pager = ["Page 1 of 1, items 1 to 4 of 4."];
    if (reason === "ambiguous descriptor") {
      const rows = [
        ...value.openingManifest[0]!.rows,
        value.openingManifest[0]!.rows[0]!,
      ];
      value.openingManifest = pages(rows);
      value.closingManifest = pages(rows, true);
    }
    if (reason === "changed closing row")
      value.closingManifest[0]!.rows[0]![2] = "1/16/2026";
    expect(() => validate(value)).toThrow(/manifest/);
  });

  it.each([
    "missing financial report",
    "missing annual",
    "period hole",
    "unknown report kind",
  ])("rejects %s", (reason) => {
    const value = fixture();
    if (reason === "missing financial report")
      value.financialObservations.pop();
    if (reason === "missing annual") {
      const rows = value.openingManifest[0]!.rows.slice(1);
      value.openingManifest = pages(rows);
      value.closingManifest = pages(rows, true);
      value.financialObservations.shift();
      value.priorFinancialObservations.shift();
    }
    if (reason === "period hole") {
      const rows = value.openingManifest[0]!.rows.filter(
        (row) => row[0] !== "CE Report 1",
      );
      value.openingManifest = pages(rows);
      value.closingManifest = pages(rows, true);
      value.financialObservations.splice(1, 1);
      value.priorFinancialObservations.splice(1, 1);
    }
    if (reason === "unknown report kind") {
      const rows = [
        ...value.openingManifest[0]!.rows,
        ["An Unknown Filed Kind", "2026", "7/15/2026", OFFICE, "View"],
      ];
      value.openingManifest = pages(rows);
      value.closingManifest = pages(rows, true);
    }
    expect(() => validate(value)).toThrow(/scope|periods|kind/);
  });

  it("refuses a current-year annual report instead of silently omitting its overlapping money", () => {
    const value = fixture();
    const rows = [
      ...value.openingManifest[0]!.rows,
      ["2027 Annual CE Filing", "2026", "1/15/2027", OFFICE, "View"],
    ];
    value.openingManifest = pages(rows);
    value.closingManifest = pages(rows, true);
    for (const page of [...value.openingManifest, ...value.closingManifest])
      page.observedAt = "2027-01-16" + page.observedAt.slice(10);
    for (const report of [
      ...value.financialObservations,
      ...value.priorFinancialObservations,
    ])
      report.observedAt = "2027-01-16" + report.observedAt.slice(10);
    expect(() => validate(value, new Date("2027-01-16T10:00:00.000Z"))).toThrow(
      "overlapping current cash reports require review",
    );
  });

  it("refuses unhandled prior-year quarterly money instead of dropping it beside the selected annual", () => {
    const value = fixture();
    const rows = [
      ...value.openingManifest[0]!.rows,
      ["CE Report 4", "2025", "1/15/2026", OFFICE, "View"],
    ];
    value.openingManifest = pages(rows);
    value.closingManifest = pages(rows, true);
    expect(() => validate(value)).toThrow(
      "overlapping current cash reports require review",
    );
  });

  it.each(["cash occurrence", "cash control"])(
    "returns a static malformed-currency error without echoing the %s value",
    (location) => {
      const value = fixture();
      const privateValue = "SYNTHETIC_PRIVATE_CURRENCY_VALUE";
      alterBoth(value, 1, (row) => {
        if (location === "cash occurrence")
          row.cashRows[0]!.amount = privateValue;
        else row.summary["1"]![1] = privateValue;
      });
      let error: unknown;
      try {
        validate(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Nevada observed currency format is invalid",
      );
      expect((error as Error).message).not.toContain(privateValue);
    },
  );

  it("keeps unrelated amended historical reports outside the qualified cash scope", () => {
    const value = fixture();
    const rows = [
      ...value.openingManifest[0]!.rows,
      ["CE Report 4 (Amended)", "2024", "1/15/2026", OFFICE, "View"],
    ];
    value.openingManifest = pages(rows);
    value.closingManifest = pages(rows, true);
    expect(validate(value).cashCents).toBe(230000);
  });

  it("supports one original and one current amended edition with exact body flags", () => {
    const value = fixture();
    const rows = [
      ...value.openingManifest[0]!.rows,
      ["CE Report 1 (Amended)", "2026", "7/1/2026", OFFICE, "View"],
    ];
    value.openingManifest = pages(rows);
    value.closingManifest = pages(rows, true);
    alterBoth(value, 1, (row) => {
      row.reportLabel = "CE Report 1 (Amended)";
      row.reportFlags.find((flag) => flag.id.endsWith("chkAMENDED"))!.checked =
        true;
    });
    expect(validate(value).reportCount).toBe(3);
  });

  it("rejects multiple same-status editions even on different filing days without a uniquely bound public body descriptor", () => {
    const value = fixture();
    const rows = [
      ...value.openingManifest[0]!.rows,
      ["CE Report 1 (Amended)", "2026", "7/1/2026", OFFICE, "View"],
      ["CE Report 1 (Amended)", "2026", "7/2/2026", OFFICE, "View"],
    ];
    value.openingManifest = pages(rows);
    value.closingManifest = pages(rows, true);
    alterBoth(value, 1, (row) => {
      row.reportLabel = "CE Report 1 (Amended)";
      row.reportFlags.find((flag) => flag.id.endsWith("chkAMENDED"))!.checked =
        true;
    });
    expect(() => validate(value)).toThrow(/edition|descriptor|ambiguous/);
  });

  it.each(["version flag", "candidate flag", "declaration", "duplicate flag"])(
    "rejects unproved report body %s",
    (reason) => {
      const value = fixture();
      alterBoth(value, 1, (row) => {
        if (reason === "duplicate flag")
          row.reportFlags.push({ id: "another_chkAMENDED", checked: false });
        else
          row.reportFlags.find((flag) =>
            flag.id.endsWith(
              reason === "version flag"
                ? "chkAMENDED"
                : reason === "candidate flag"
                  ? "chkCANDIDATE"
                  : "chkDeclaration",
            ),
          )!.checked = reason === "version flag";
      });
      expect(() => validate(value)).toThrow(/flags/);
    },
  );

  it.each(["closing donor", "closing amount", "closing date"])(
    "rejects same-scope %s drift",
    (reason) => {
      const value = fixture();
      const row = value.financialObservations[1]!.cashRows[0]!;
      if (reason === "closing donor") row.contributorName = "A Different PAC";
      if (reason === "closing amount") row.amount = "$400.00";
      if (reason === "closing date") row.date = "2/2/2026";
      expect(() => validate(value)).toThrow(/changed/);
    },
  );

  it.each([
    "unknown loan",
    "marked loan",
    "unknown return",
    "known return",
    "cash control",
    "expense control",
    "noncash",
    "unitemized",
    "occurrence hole",
    "outside date",
  ])("preserves unsupported %s", (reason) => {
    const value = fixture();
    alterBoth(value, 1, (row) => {
      if (reason === "unknown loan") row.cashRows[0]!.loanCellBlank = false;
      if (reason === "marked loan") row.cashRows[0]!.loanCheckboxChecked = true;
      if (reason === "unknown return")
        row.expenseReturnLiteralCount = undefined as unknown as number;
      if (reason === "known return") row.expenseReturnLiteralCount = 1;
      if (reason === "cash control") row.summary["1"]![1] = "$999.00";
      if (reason === "expense control") row.summary["12"]![0] = "$10.00";
      if (reason === "noncash") row.summary["5"]![1] = "$20.00";
      if (reason === "unitemized") row.summary["7"]![1] = "$20.00";
      if (reason === "occurrence hole") row.cashRows[1]!.occurrence = 3;
      if (reason === "outside date") row.cashRows[0]!.date = "4/1/2026";
    });
    expect(() => validate(value)).toThrow(
      /loan|return|control|sum|cash|scope|period/,
    );
  });

  it.each([
    "stale",
    "future closing",
    "closing before reports",
    "old report not before opening",
    "long session",
  ])("rejects %s timing", (reason) => {
    const value = fixture();
    let now = NOW;
    if (reason === "stale") now = new Date("2026-10-14T10:00:00.000Z");
    if (reason === "future closing")
      value.closingManifest[0]!.observedAt = "2026-10-12T10:01:00.000Z";
    if (reason === "closing before reports")
      value.closingManifest[0]!.observedAt = "2026-10-12T09:05:00.000Z";
    if (reason === "old report not before opening")
      value.priorFinancialObservations[0]!.observedAt =
        "2026-10-12T09:00:00.000Z";
    if (reason === "long session")
      value.closingManifest[0]!.observedAt = "2026-10-12T12:00:00.000Z";
    expect(() => validate(value, now)).toThrow(/time|stale|bracket/);
  });

  it("does not promote an uncounted research registry query or generic corporation name", () => {
    const value = fixture();
    alterBoth(value, 2, (row) => {
      row.cashRows[0]!.contributorName = "Generic Corporation";
    });
    expect(
      validate(value).pacDonors.some(
        (row) => row.committeeName === "Generic Corporation",
      ),
    ).toBe(false);
  });

  it.each([
    "HTTP claim",
    "unredacted locators",
    "unsupported source URL",
    "bad digest",
  ])("rejects %s", (reason) => {
    const value = fixture();
    if (reason === "HTTP claim") value.httpResponseMetadataClaimed = true;
    if (reason === "unredacted locators") value.locatorValuesOmitted = false;
    if (reason === "unsupported source URL")
      value.sourceCanonicalPaths.search = "https://example.com/";
    expect(() =>
      validateNevadaCommitteeDonorObservation(value, {
        now: NOW,
        captureDigest: reason === "bad digest" ? "bad" : DIGEST,
      }),
    ).toThrow();
  });
});

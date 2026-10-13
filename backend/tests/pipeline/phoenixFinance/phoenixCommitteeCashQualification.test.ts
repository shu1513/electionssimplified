import { describe, expect, it } from "vitest";
import {
  qualifyPhoenixCommitteeCash,
  type PhoenixCommitteeCashQualificationInput,
  type PhoenixCommitteeCashObservation,
} from "../../../src/pipeline/phoenixFinance/phoenixCommitteeCashQualification.js";
import type {
  PhoenixPdfLine,
  PhoenixPdfPage,
} from "../../../src/pipeline/phoenixFinance/phoenixReportPdfParser.js";
const ID1 = "11111111-1111-1111-1111-111111111111",
  ID2 = "22222222-2222-2222-2222-222222222222";
const copId = "CAN-25-4";
const l = (
  y: number,
  text: string,
  values: [number, string][] = [],
): PhoenixPdfLine => ({
  y,
  cells: [{ x: 58, text }, ...values.map(([x, text]) => ({ x, text }))],
  text: [text, ...values.map(([, text]) => text)].join(" "),
});
const m = (c: number) => `$${(c / 100).toFixed(2)}`;
const header = () => l(739, copId);
const p = (pageNumber: number, lines: PhoenixPdfLine[]): PhoenixPdfPage => ({
  pageNumber,
  lines: [header(), ...lines],
});
function report(input: {
  annual?: boolean;
  pac?: number;
  individual?: number;
  refund?: number;
  returnName?: string;
  pacName?: string;
  begin?: number;
  priorReceipts?: number;
  duplicate?: boolean;
}) {
  const annual = input.annual ?? false,
    pac = input.pac ?? 5000,
    ind = input.individual ?? 0,
    refund = input.refund ?? 0,
    begin = input.begin ?? 20000,
    k = pac + ind,
    receipts = k - refund;
  const cash = (label: string, c: number, y: number) =>
    l(y, label, [
      [425, m(c)],
      [505, "$0.00"],
    ]);
  const pages = [
    p(1, [
      l(710, "FINANCIAL SUMMARY (required)"),
      l(670, "Committee Information: Committee Name: Example Campaign"),
      l(620, "Office Sought: City Office: Council Member District 4"),
      l(
        600,
        annual
          ? "Annual 2026 Report: April 01, 2025 to March 31, 2026"
          : "Q1 2026 Report: April 01, 2026 to June 30, 2026",
      ),
      l(550, "Committee value at the beginning of this reporting period", [
        [425, m(begin)],
      ]),
      l(540, "(a)"),
      l(530, "(b)"),
      l(520, "Total receipts this reporting period", [
        [425, m(receipts)],
        [505, m((input.priorReceipts ?? 0) + receipts)],
      ]),
      l(510, "(c)"),
      l(500, "minus"),
      l(490, "Total disbursements this reporting period", [
        [425, "$0.00"],
        [505, "$0.00"],
      ]),
      l(480, "(d)"),
      l(470, "equals"),
      l(460, "Balance at close of reporting period", [
        [425, m(begin + receipts)],
      ]),
    ]),
    p(2, [
      l(710, "SUMMARY OF RECEIPTS (Schedule A)"),
      ...[
        "In-State Individuals - More than $100",
        "In-State Individuals - $100 or Less",
        "Out-of-State Individuals",
        "Candidate Committees",
        "Political Action Committees",
        "Political Parties",
        "Partnerships",
        "Corporations & Limited Liability Companies",
        "Labor Organizations",
        "Candidate's Personal Monies",
        "Monetary Contributions Subtotal",
        "Refunds Given Back to Contributors",
        "Net Monetary Contributions",
      ].map((label, i) =>
        cash(
          `(${String.fromCharCode(97 + i)}) ${label}`,
          [ind, 0, 0, 0, pac, 0, 0, 0, 0, 0, k, refund, receipts][i]!,
          690 - i * 14,
        ),
      ),
      cash("(e) Loans Subtotal", 0, 490),
      ...[
        "3. Rebates and Refunds Received",
        "4. Interest Accrued",
        "8. Joint Fundraising",
        "9. Payments Received for Goods",
        "11. Transfer In Surplus",
        "12. Miscellaneous Receipts",
      ].map((label, i) => cash(label, 0, 470 - i * 14)),
      cash("13. Total Receipts", receipts, 365),
    ]),
    p(3, [
      l(710, "SUMMARY OF DISBURSEMENTS (Schedule B)"),
      cash("6. Independent Expenditures Made", 0, 680),
      cash("16. Total Disbursements", 0, 650),
    ]),
  ];
  const sourceDate = annual ? "04/30/2025" : "04/30/2026";
  if (ind)
    pages.push(
      p(4, [
        l(
          704,
          "MONETARY CONTRIBUTIONS RECEIVED FROM IN-STATE INDIVIDUALS - MORE THAN $100",
        ),
        l(631, "Name Date Contribution Received", [
          [371, m(ind)],
          [441, m(ind)],
          [510, m(ind)],
        ]),
        l(619, "Individual Donor", [[259, sourceDate]]),
        l(590, "Occupation Employer"),
        l(578, "Unknown"),
      ]),
    );
  if (pac) {
    const count = input.duplicate ? 2 : 1;
    const entries = Array.from({ length: count }, (_, i) => {
      const y = 631 - i * 104;
      return [
        l(y, "Committee Name", [
          [371, m(pac / count)],
          [441, m(pac)],
          [510, m(pac)],
        ]),
        l(y - 12, input.pacName ?? "Literal PAC"),
        l(y - 26, "Street Address"),
        l(y - 76, "Committee ID Number Date Contribution Received"),
        l(y - 87, "", [[186, sourceDate]]),
      ];
    }).flat();
    pages.push(
      p(5, [
        l(
          704,
          "MONETARY CONTRIBUTIONS FROM POLITICAL ACTION COMMITTEES: SCHEDULE A(1)(e)",
        ),
        ...entries,
        l(620 - count * 104, "Enter total only if last page of schedule", [
          [441, m(pac)],
          [510, m(pac)],
        ]),
        l(35, "SCHEDULE A(1)(e), page 1 of 1"),
      ]),
    );
  }
  if (refund)
    pages.push(
      p(6, [
        l(704, "REFUNDS GIVEN BACK TO CONTRIBUTORS: SCHEDULE A(1)(l)"),
        l(631, "Name Date Contribution Refunded", [
          [371, m(refund)],
          [441, m(refund)],
          [510, m(refund)],
        ]),
        l(619, input.returnName ?? "Individual Donor", [[259, "04/14/2026"]]),
        l(605, "Street Address"),
        l(555, "ID Number (if applicable) Date of Original Contribution"),
        l(544, "", [[258, "03/26/2026"]]),
        l(526, "Enter total only if last page of schedule", [
          [441, m(refund)],
          [510, m(refund)],
        ]),
        l(35, "SCHEDULE A(1)(l), page 1 of 1"),
      ]),
    );
  return pages;
}
function observation(): PhoenixCommitteeCashObservation {
  const row = (id: string) => ({
    COPID: copId,
    ReportPackageId: id,
    SubmittedDate: "/Date(1)/",
    RecentReport: "00000000-0000-0000-0000-000000000000",
    Amount: 1,
    SourceUnmodeledField: "retained",
  });
  return {
    grids: {
      contributors: [row(ID1), row(ID2)],
      expenditures: [],
      loans: [],
      noActivityContributors: [],
      noActivityExpenditures: [],
    },
    reports: [
      {
        reportPackageId: ID1,
        pages: report({
          annual: true,
          pac: 10000,
          individual: 10000,
          begin: 0,
        }),
      },
      {
        reportPackageId: ID2,
        pages: report({ refund: 1000, priorReceipts: 20000 }),
      },
    ],
  };
}
function fixture(): PhoenixCommitteeCashQualificationInput {
  const before = observation();
  return {
    copId,
    committeeName: "Example Campaign",
    officeSought: "Council Member District 4",
    portalCycleStart: "2025-04-01",
    portalCycleEnd: "2027-03-31",
    before,
    after: structuredClone(before),
  };
}
function editBoth(
  input: PhoenixCommitteeCashQualificationInput,
  edit: (o: PhoenixCommitteeCashObservation) => void,
) {
  edit(input.before);
  edit(input.after);
}
function text(
  pages: readonly PhoenixPdfPage[],
  find: string,
  replacement: string,
) {
  const row = pages
    .flatMap((p) => p.lines)
    .find((l) => l.text.startsWith(find))!;
  row.cells[0]!.text = replacement;
  row.text = row.cells.map((c) => c.text).join(" ");
}

describe("Phoenix complete published named committee cash qualification", () => {
  it("aggregates full disjoint cycle reports and excludes an independently classified individual return", () => {
    const result = qualifyPhoenixCommitteeCash(fixture());
    expect(result.positions).toEqual([
      expect.objectContaining({
        committeeId: "reported:LITERAL PAC",
        committeeName: "Literal PAC",
        committeeType: "Political Action Committee",
        grossCents: 15000,
        refundCents: 0,
        netCents: 15000,
        contributionCount: 2,
        refundCount: 0,
      }),
    ]);
    expect(result.reportedThrough).toBe("2026-06-30");
    expect(result.reportPeriods).toHaveLength(2);
  });
  it("nets an exact printed PAC return without choosing a gift or registry ID", () => {
    const input = fixture();
    editBoth(input, (o) =>
      text(o.reports[1]!.pages, "Individual Donor 04/14", "Literal PAC"),
    );
    const result = qualifyPhoenixCommitteeCash(input);
    expect(result.positions[0]).toMatchObject({
      grossCents: 15000,
      refundCents: 1000,
      netCents: 14000,
      contributionCount: 2,
      refundCount: 1,
    });
  });
  it("retains equal physical gift occurrences and groups only case/whitespace/NFKC variants", () => {
    const input = fixture();
    editBoth(input, (o) => {
      o.reports[1]!.pages = report({
        refund: 1000,
        priorReceipts: 20000,
        duplicate: true,
        pacName: "Ｌiteral   pac",
      });
    });
    expect(qualifyPhoenixCommitteeCash(input).positions[0]).toMatchObject({
      grossCents: 15000,
      contributionCount: 3,
    });
  });
  it("does not merge punctuation-distinct reported names", () => {
    const input = fixture();
    editBoth(input, (o) =>
      text(o.reports[1]!.pages, "Literal PAC", "Literal-PAC"),
    );
    expect(qualifyPhoenixCommitteeCash(input).positions).toHaveLength(2);
  });
  it("compares occurrence multisets irrespective of source row ordering or object key order", () => {
    const input = fixture();
    input.after.grids.contributors = [...input.after.grids.contributors]
      .reverse()
      .map((row) => Object.fromEntries(Object.entries(row).reverse()));
    expect(qualifyPhoenixCommitteeCash(input).positions[0]!.netCents).toBe(
      15000,
    );
  });
  it.each([
    "unknown returned name",
    "ambiguous individual/PAC name",
    "missing PDF",
    "extra PDF",
    "changed raw field",
    "duplicate multiplicity",
    "changed PDF field",
    "wrong PDF COP",
    "wrong PDF name",
    "wrong office",
    "period overlap",
    "period gap",
    "cycle control",
    "missing cycle control",
    "cash chain",
    "unknown source package",
    "wrong grid COP",
    "prior disappeared",
    "wrong cycle boundary",
  ])("preserves on %s", (reason) => {
    const input = fixture();
    switch (reason) {
      case "unknown returned name":
        editBoth(input, (o) =>
          text(
            o.reports[1]!.pages,
            "Individual Donor 04/14",
            "Unknown contributor",
          ),
        );
        break;
      case "ambiguous individual/PAC name":
        editBoth(input, (o) => {
          text(o.reports[0]!.pages, "Literal PAC", "Individual Donor");
        });
        break;
      case "missing PDF":
        input.before.reports = [input.before.reports[0]!];
        break;
      case "extra PDF":
        input.before.reports = [
          ...input.before.reports,
          {
            reportPackageId: "33333333-3333-3333-3333-333333333333",
            pages: report({}),
          },
        ];
        break;
      case "changed raw field":
        input.after.grids.contributors = [
          {
            ...input.after.grids.contributors[0],
            SourceUnmodeledField: "changed",
          },
          input.after.grids.contributors[1]!,
        ];
        break;
      case "duplicate multiplicity":
        input.after.grids.contributors = [
          ...input.after.grids.contributors,
          input.after.grids.contributors[0]!,
        ];
        break;
      case "changed PDF field":
        text(input.after.reports[1]!.pages, "Literal PAC", "Other PAC");
        break;
      case "wrong PDF COP":
        editBoth(input, (o) => text(o.reports[1]!.pages, copId, "CAN-25-5"));
        break;
      case "wrong PDF name":
        editBoth(input, (o) =>
          text(
            o.reports[1]!.pages,
            "Committee Information:",
            "Committee Information: Committee Name: Other Campaign",
          ),
        );
        break;
      case "wrong office":
        editBoth(input, (o) =>
          text(
            o.reports[1]!.pages,
            "Office Sought:",
            "Office Sought: City Office: Council Member District 6",
          ),
        );
        break;
      case "period overlap":
        editBoth(input, (o) =>
          text(
            o.reports[1]!.pages,
            "Q1 2026 Report:",
            "Q1 2026 Report: March 31, 2026 to June 30, 2026",
          ),
        );
        break;
      case "period gap":
        editBoth(input, (o) =>
          text(
            o.reports[1]!.pages,
            "Q1 2026 Report:",
            "Q1 2026 Report: April 02, 2026 to June 30, 2026",
          ),
        );
        break;
      case "cycle control":
        editBoth(input, (o) => {
          const r = o.reports[1]!.pages[0]!.lines.find((l) =>
            l.text.startsWith("Total receipts"),
          )!;
          r.cells[2]!.text = "$250.00";
        });
        break;
      case "missing cycle control":
        editBoth(input, (o) => {
          const r = o.reports[1]!.pages[0]!.lines.find((l) =>
            l.text.startsWith("Total receipts"),
          )!;
          r.cells.pop();
        });
        break;
      case "cash chain":
        editBoth(input, (o) => {
          o.reports[1]!.pages = report({
            refund: 1000,
            priorReceipts: 20000,
            begin: 19000,
          });
        });
        break;
      case "unknown source package":
        editBoth(input, (o) => {
          o.grids.contributors = [
            { ...o.grids.contributors[0], ReportPackageId: "not-an-ID" },
            o.grids.contributors[1]!,
          ];
        });
        break;
      case "wrong grid COP":
        editBoth(input, (o) => {
          o.grids.contributors = [
            { ...o.grids.contributors[0], COPID: "CAN-25-5" },
            o.grids.contributors[1]!,
          ];
        });
        break;
      case "prior disappeared":
        input.priorReportPeriods = [
          { periodFrom: "2026-07-01", periodTo: "2026-09-30" },
        ];
        break;
      case "wrong cycle boundary":
        input.portalCycleStart = "2025-05-01";
        break;
    }
    expect(() => qualifyPhoenixCommitteeCash(input)).toThrow();
  });
  it("retains valid individual period-outlier class evidence without changing PAC money", () => {
    const input = fixture();
    editBoth(input, (o) => {
      const row = o.reports[0]!.pages.flatMap((p) => p.lines).find((l) =>
        l.text.startsWith("Individual Donor"),
      )!;
      row.cells[1]!.text = "04/01/2026";
      row.text = row.cells.map((c) => c.text).join(" ");
    });
    const result = qualifyPhoenixCommitteeCash(input);
    expect(result.positions[0]).toMatchObject({
      grossCents: 15000,
      refundCents: 0,
      netCents: 15000,
    });
    expect(result.diagnostics.join(" ")).toContain(
      "1 source-typed individual date outlier",
    );
  });
  it("retains signed per-name positions after full receipt/control reconciliation", () => {
    const input = fixture();
    editBoth(input, (o) => {
      o.reports[1]!.pages = report({
        individual: 20000,
        refund: 20000,
        returnName: "Literal PAC",
        priorReceipts: 20000,
      });
    });
    expect(qualifyPhoenixCommitteeCash(input).positions[0]).toMatchObject({
      grossCents: 15000,
      refundCents: 20000,
      netCents: -5000,
      contributionCount: 2,
      refundCount: 1,
    });
  });
  it("preserves an unexplained nonzero report pointer without ranking submitted dates", () => {
    const input = fixture();
    editBoth(input, (o) => {
      o.grids.contributors = [
        { ...o.grids.contributors[0], RecentReport: ID2 },
        o.grids.contributors[1]!,
      ];
    });
    expect(() => qualifyPhoenixCommitteeCash(input)).toThrow(/pointer/);
  });
  it("retains full prefix-matched foreign rows without requiring or booking their PDFs", () => {
    const input = fixture();
    editBoth(input, (o) => {
      o.grids.contributors = [
        ...o.grids.contributors,
        {
          COPID: "CAN-25-40",
          ReportPackageId: "33333333-3333-3333-3333-333333333333",
          Amount: 99999999,
          OtherSourceField: "retained",
        },
      ];
    });
    expect(qualifyPhoenixCommitteeCash(input).positions[0]!.netCents).toBe(
      15000,
    );
    input.after.grids.contributors = input.after.grids.contributors.map(
      (row) =>
        row.COPID === "CAN-25-40"
          ? { ...row, OtherSourceField: "changed" }
          : row,
    );
    expect(() => qualifyPhoenixCommitteeCash(input)).toThrow(
      /full source census/,
    );
  });
  it("refuses a supplied foreign financial PDF rather than adding its money", () => {
    const input = fixture();
    editBoth(input, (o) => {
      const id = "33333333-3333-3333-3333-333333333333";
      o.grids.contributors = [
        ...o.grids.contributors,
        { COPID: "CAN-25-40", ReportPackageId: id },
      ];
      o.reports = [...o.reports, { reportPackageId: id, pages: report({}) }];
    });
    expect(() => qualifyPhoenixCommitteeCash(input)).toThrow(
      /coverage mismatch/,
    );
  });
  it.each(["CAN-25-5", "CAN-25-x", "unknown"])(
    "refuses unexplained source COP %s",
    (foreign) => {
      const input = fixture();
      editBoth(input, (o) => {
        o.grids.contributors = [
          ...o.grids.contributors,
          { COPID: foreign, ReportPackageId: ID1 },
        ];
      });
      expect(() => qualifyPhoenixCommitteeCash(input)).toThrow(/COPID/);
    },
  );
  it("does not use a foreign prefix-matched marker as this receiver's no-activity authority", () => {
    const input = fixture();
    editBoth(input, (o) => {
      o.reports = [
        {
          reportPackageId: ID1,
          pages: [
            report({ annual: true, pac: 0, individual: 0, begin: 0 })[0]!,
          ],
        },
      ];
      o.grids.contributors = [o.grids.contributors[0]!];
      o.grids.noActivityContributors = [
        { COPID: "CAN-25-40", ReportPackageId: ID1 },
      ];
    });
    expect(() => qualifyPhoenixCommitteeCash(input)).toThrow(/no-activity/);
  });
  it("retains prior period authority when current singleton period is independently present", () => {
    const input = fixture();
    input.priorReportPeriods = [
      { periodFrom: "2025-04-01", periodTo: "2026-03-31" },
    ];
    expect(qualifyPhoenixCommitteeCash(input).positions).toHaveLength(1);
  });
  it("discovers expense-only package membership and never ranks duplicate period IDs by SubmittedDate", () => {
    const input = fixture();
    editBoth(input, (o) => {
      const id = "33333333-3333-3333-3333-333333333333";
      o.grids.expenditures = [
        {
          COPID: copId,
          ReportPackageId: id,
          SubmittedDate: "/Date(9999999999999)/",
        },
      ];
      o.reports = [
        ...o.reports,
        {
          reportPackageId: id,
          pages: report({ refund: 1000, priorReceipts: 20000 }),
        },
      ];
    });
    expect(() => qualifyPhoenixCommitteeCash(input)).toThrow(/overlapping/);
  });
});

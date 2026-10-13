import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PhoenixPdfCell,
  PhoenixPdfPage,
} from "../../../src/pipeline/phoenixFinance/phoenixReportPdfParser.js";
const extracted = vi.hoisted(() => new Map<string, PhoenixPdfPage[]>());
vi.mock(
  "../../../src/pipeline/phoenixFinance/phoenixReportPdfParser.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../src/pipeline/phoenixFinance/phoenixReportPdfParser.js")
    >()),
    extractPhoenixPdfPages: async (bytes: Uint8Array) =>
      extracted.get(new TextDecoder().decode(bytes))!,
  }),
);
import {
  buildPhoenixCoverOfficeSoughtIndex,
  loadPhoenixFinanceRunContext,
} from "../../../src/pipeline/phoenixFinance/phoenixCandidateFinanceSync.js";

const copId = "PAC-25-2";
const first = "11111111-1111-1111-1111-111111111111";
const second = "22222222-2222-2222-2222-222222222222";
const registration = {
  COPID: copId,
  CommitteeName: "Example PAC",
  CommitteeType: "Political Action Committee",
  Approved: true,
  AppovedTimestamp: "/Date(1)/",
  IsStandingCommittee: false,
};
function line(
  text: string,
  y: number,
  cells: PhoenixPdfCell[] = [{ text, x: 40 }],
) {
  return { text, y, cells };
}
function pages(from: string, to: string, header = copId): PhoenixPdfPage[] {
  return [
    {
      pageNumber: 1,
      lines: [
        line(header, 780),
        line("FINANCIAL SUMMARY (required)", 680),
        line(`Quarterly Report: ${from} to ${to}`, 670),
        line("Committee value at the beginning", 650, [
          { text: "Committee value at the beginning", x: 40 },
          { text: "$100.00", x: 425 },
        ]),
        line("(a)", 640),
        line("(b)", 630),
        line("Total receipts", 620, [
          { text: "Total receipts", x: 40 },
          { text: "$0.00", x: 425 },
        ]),
        line("(c)", 610),
        line("minus", 600),
        line("Total disbursements", 590, [
          { text: "Total disbursements", x: 40 },
          { text: "$100.00", x: 425 },
        ]),
        line("(d)", 580),
        line("equals", 570),
        line("Balance at close of reporting period", 560, [
          { text: "Balance at close of reporting period", x: 40 },
          { text: "$0.00", x: 425 },
        ]),
      ],
    },
    {
      pageNumber: 2,
      lines: [
        line(header, 780),
        line("INDEPENDENT EXPENDITURES MADE: SCHEDULE B(6)", 680),
        line("Recipient Name", 660),
        line("$100.00 $100.00", 650, [
          { text: "$100.00", x: 369 },
          { text: "$100.00", x: 441 },
        ]),
        line("Vendor", 640),
        line(
          "Candidate(s) Supported (including % Supported) Candidate(s) Opposed (including % opposed)",
          630,
        ),
        line("Jane Doe 100", 620, [
          { text: "Jane Doe", x: 59 },
          { text: "100", x: 160 },
        ]),
        line("Date of First Publication, Display, Delivery, or Broadcast", 610),
        line("Election Month/Year Office Sought", 600),
        line("11/2026 City Council District 4", 590, [
          { text: "11/2026", x: 194 },
          { text: "City Council District 4", x: 261 },
        ]),
      ],
    },
  ];
}
function row(id = first, overrides: Record<string, unknown> = {}) {
  return {
    COPID: copId,
    ReportPackageId: id,
    ReportName: "Quarterly Report",
    SubmittedDate: "/Date(1)/",
    RecentReport: "00000000-0000-0000-0000-000000000000",
    ReportScheduleName: "B(6)",
    Amount: 100,
    ...overrides,
  };
}
function transport(rows: Record<string, unknown>[]) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url);
    if (text.includes("PrintReport")) {
      const id = text.split("/").at(-1)!;
      return new Response(`%PDF ${id}`, { status: 200 });
    }
    const data = text.endsWith("_SearchCommittees") ? [registration] : rows;
    return new Response(JSON.stringify({ Data: data, Total: data.length }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}
const cache = { read: async () => null, write: async () => {} };
beforeEach(() => {
  extracted.clear();
  extracted.set(`%PDF ${first}`, pages("January 01, 2026", "March 31, 2026"));
  extracted.set(`%PDF ${second}`, pages("April 01, 2026", "June 30, 2026"));
});
describe("Phoenix city IE run context", () => {
  it("retains equal report names across disjoint covers without timestamp edition ranking", async () => {
    const result = await loadPhoenixFinanceRunContext({
      cache,
      fetchImpl: transport([
        row(first, { SubmittedDate: "/Date(999)/" }),
        row(second),
      ]),
    });
    expect(result.outsidePool).toHaveLength(2);
    expect(result.diagnostics.b6Packages).toBe(2);
    expect(result.outsidePool.map((r) => r.reportPackageId)).toEqual([
      first,
      second,
    ]);
  });
  it("refuses overlapping editions even when their names or timestamps differ", async () => {
    extracted.set(`%PDF ${second}`, pages("March 01, 2026", "June 30, 2026"));
    await expect(
      loadPhoenixFinanceRunContext({
        cache,
        fetchImpl: transport([
          row(),
          row(second, {
            ReportName: "Amended Quarterly Report",
            SubmittedDate: "/Date(999)/",
          }),
        ]),
      }),
    ).rejects.toThrow(/overlapping B\(6\)/);
  });
  it.each([
    { COPID: "PAC-25-3" },
    { COPID: "PAC-25-02" },
    { RecentReport: second },
    { ReportPackageId: "invalid" },
    { ReportPackageId: "00000000-0000-0000-0000-000000000000" },
    { ReportName: "" },
  ])(
    "validates every physical expense row before B6 filtering (%j)",
    async (override) => {
      await expect(
        loadPhoenixFinanceRunContext({
          cache,
          fetchImpl: transport([
            row(),
            row(second, { ReportScheduleName: "B(1)", ...override }),
          ]),
        }),
      ).rejects.toThrow(/expense grid/);
    },
  );
  it("separates a merged report-period row from its adjacent filing-window cells", async () => {
    const source = pages("February 26, 2023", "March 31, 2023");
    const period = source[0]!.lines.find((line) =>
      line.text.startsWith("Quarterly Report:"),
    )!;
    period.cells = [
      {
        text: "2023 1st Quarter, Post-Election Report: February 26, 2023 to March 31, 2023",
        x: 72,
      },
      { text: "April 01, 2023 to April 17, 2023", x: 375.052 },
    ];
    period.text = period.cells.map((cell) => cell.text).join(" ");
    extracted.set(`%PDF ${first}`, source);
    extracted.set(`%PDF ${second}`, pages("April 01, 2023", "June 30, 2023"));
    expect(
      (
        await loadPhoenixFinanceRunContext({
          cache,
          fetchImpl: transport([row(), row(second)]),
        })
      ).outsidePool,
    ).toHaveLength(2);
  });

  it("reads the witnessed legacy wrapped PAC period without booking the adjacent filing window", async () => {
    const legacy = pages("January 01, 2021", "February 20, 2021");
    const period = legacy[0]!.lines.find((line) =>
      line.text.startsWith("Quarterly Report:"),
    )!;
    period.text =
      "2021 1st Quarter, Pre-Election Report (PAC): January 01, 2021 to February 20,";
    period.cells = [{ text: period.text, x: 72 }];
    period.y = 531.2;
    legacy[0]!.lines.push(
      line("February 21, 2021 to March 01, 2021", 526.6, [
        { text: "February 21, 2021 to March 01, 2021", x: 375 },
      ]),
      line("2021", 522, [{ text: "2021", x: 72 }]),
    );
    extracted.set(`%PDF ${first}`, legacy);
    extracted.set(
      `%PDF ${second}`,
      pages("February 21, 2021", "March 31, 2021"),
    );
    expect(
      (
        await loadPhoenixFinanceRunContext({
          cache,
          fetchImpl: transport([row(), row(second)]),
        })
      ).outsidePool,
    ).toHaveLength(2);
    legacy[0]!.lines = legacy[0]!.lines.filter((line) => line.text !== "2021");
    await expect(
      loadPhoenixFinanceRunContext({ cache, fetchImpl: transport([row()]) }),
    ).rejects.toThrow(/legacy reporting-period year/);
  });

  it("retains full prefix query closure but never fetches or books foreign packages", async () => {
    const fetchImpl = transport([
      row(),
      row(second, { COPID: "PAC-25-20", RecentReport: "foreign-pointer" }),
    ]);
    const result = await loadPhoenixFinanceRunContext({ cache, fetchImpl });
    expect(result.outsidePool).toHaveLength(1);
    expect(result.outsidePool[0]!.reportPackageId).toBe(first);
    const pdfUrls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("PrintReport"));
    expect(pdfUrls).toHaveLength(1);
    expect(pdfUrls[0]).toContain(first);
  });

  it("rejects a mismatched receiving PDF header instead of trusting its grid package", async () => {
    extracted.set(
      `%PDF ${first}`,
      pages("January 01, 2026", "March 31, 2026", "PAC-25-3"),
    );
    await expect(
      loadPhoenixFinanceRunContext({ cache, fetchImpl: transport([row()]) }),
    ).rejects.toThrow(/PDF receiving COPID/);
  });
  it("rejects missing PDF header and reversed cover", async () => {
    extracted.set(
      `%PDF ${first}`,
      pages("January 01, 2026", "March 31, 2026", "unknown"),
    );
    await expect(
      loadPhoenixFinanceRunContext({ cache, fetchImpl: transport([row()]) }),
    ).rejects.toThrow(/PDF receiving COPID/);
    extracted.set(`%PDF ${first}`, pages("April 01, 2026", "March 31, 2026"));
    await expect(
      loadPhoenixFinanceRunContext({ cache, fetchImpl: transport([row()]) }),
    ).rejects.toThrow(/reversed cover/);
  });
  it("rejects conflicting names for the same package and retains count reconciliation", async () => {
    await expect(
      loadPhoenixFinanceRunContext({
        cache,
        fetchImpl: transport([
          row(),
          row(first, { ReportName: "Different Report" }),
        ]),
      }),
    ).rejects.toThrow(/conflicting report names/);
    await expect(
      loadPhoenixFinanceRunContext({
        cache,
        fetchImpl: transport([row(), row()]),
      }),
    ).rejects.toThrow(/grid shows 2 rows/);
  });
});

function officePage(id: string, from: string, to: string, office: string) {
  const value = pages(from, to);
  value[0]!.lines.push(line(`Office Sought: City Office: ${office}`, 675));
  extracted.set(`%PDF ${id}`, value);
}
describe("Phoenix office cover index", () => {
  it("selects latest actual cover end rather than GUID or row timestamp", async () => {
    officePage(
      first,
      "April 01, 2026",
      "June 30, 2026",
      "Council Member District 4",
    );
    officePage(second, "January 01, 2026", "March 31, 2026", "Mayor");
    const index = await buildPhoenixCoverOfficeSoughtIndex({
      copIds: [copId],
      seams: {
        cache,
        fetchImpl: transport([
          row(first),
          row(second, { SubmittedDate: "/Date(999)/" }),
        ]),
      },
    });
    expect(index.get(copId)).toEqual(["Council Member District 4"]);
  });
  it("omits office when equally latest cover periods disagree", async () => {
    officePage(
      first,
      "April 01, 2026",
      "June 30, 2026",
      "Council Member District 4",
    );
    officePage(second, "April 01, 2026", "June 30, 2026", "Mayor");
    const index = await buildPhoenixCoverOfficeSoughtIndex({
      copIds: [copId],
      seams: { cache, fetchImpl: transport([row(first), row(second)]) },
    });
    expect(index.has(copId)).toBe(false);
  });
  it("accepts agreeing latest offices but omits a missing or foreign cover", async () => {
    officePage(
      first,
      "April 01, 2026",
      "June 30, 2026",
      "Council Member District 4",
    );
    officePage(
      second,
      "April 01, 2026",
      "June 30, 2026",
      "Council Member District 4",
    );
    const input = {
      copIds: [copId],
      seams: { cache, fetchImpl: transport([row(first), row(second)]) },
    };
    expect(
      (await buildPhoenixCoverOfficeSoughtIndex(input)).get(copId),
    ).toEqual(["Council Member District 4"]);
    extracted.set(
      `%PDF ${second}`,
      pages("April 01, 2026", "June 30, 2026", "PAC-25-3"),
    );
    expect((await buildPhoenixCoverOfficeSoughtIndex(input)).has(copId)).toBe(
      false,
    );
    extracted.set(`%PDF ${second}`, []);
    expect((await buildPhoenixCoverOfficeSoughtIndex(input)).has(copId)).toBe(
      false,
    );
  });
});

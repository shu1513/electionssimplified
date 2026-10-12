import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  bindDelawareCandidateFinancialFacts,
  type DelawareCandidateFinancialBindingInput,
  type DelawareCandidateFinancialObservation,
} from "../../../src/pipeline/delawareFinance/delawareCandidateFinancialBindings.js";
import {
  buildDelawareExpensesSearchFields,
  buildDelawareFiledReportsSearchFields,
  buildDelawareReceiptsSearchFields,
  isDelawareCfrsCaptureFieldAllowed,
} from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import {
  DELAWARE_EXPENSE_CSV_COLUMNS,
  DELAWARE_RECEIPT_CSV_COLUMNS,
} from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";
import {
  closeDelawareNativeLedger,
  decodeDelawareExpenseNativePage,
  decodeDelawareReceiptNativePage,
  DELAWARE_NATIVE_EXPENSE_FIELDS,
  DELAWARE_NATIVE_RECEIPT_FIELDS,
  projectDelawareNativeExpenseCsvRow,
  projectDelawareNativeReceiptCsvRow,
  type DelawareNativeLedgerPage,
} from "../../../src/pipeline/delawareFinance/delawareNativeLedger.js";
import type {
  DelawareCandidateFinancialReport,
  DelawareCandidatePdfOccurrence,
  DelawareCandidateScheduleName,
} from "../../../src/pipeline/delawareFinance/delawareCandidateFinancialReport.js";

// The facts parser has its own positioned-PDF tests and genuine seven-PDF replay.
// These protocol packets encode sanitized parsed facts so monetary/scope negatives
// exercise the real inventory, native schema, CSV closure and binder validators.
vi.mock(
  "../../../src/pipeline/delawareFinance/delawareCandidateFinancialReport.js",
  () => ({
    readDelawareCandidateFinancialReport: async (body: Buffer) => ({
      ...JSON.parse(body.toString()),
      pdfSha256: createHash("sha256").update(body).digest("hex"),
      byteCount: body.length,
    }),
  }),
);
const owner = {
  cfId: "01000001",
  memberId: 733862,
  committeeName: "Friends of Example Candidate",
};
const file = "CampaignFinanceReport_Prelim_733862_1273_example.pdf";
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const origin = "https://cfrs.elections.delaware.gov";
let clock = 0;
function capture(
  path: string,
  method: "GET" | "POST",
  body: string,
  fields: Record<string, string> | null = null,
): DelawareCandidateFinancialObservation {
  const bytes = Buffer.from(body);
  const startedAt = new Date(
      Date.UTC(2026, 9, 11, 12, 0, clock++),
    ).toISOString(),
    completedAt = new Date(Date.UTC(2026, 9, 11, 12, 0, clock++)).toISOString();
  return {
    body: bytes,
    url: origin + path,
    method,
    financeFields: fields,
    requestScopeRedacted: false,
    attempt: 1,
    status: 200,
    startedAt,
    completedAt,
    contentType: "text/plain",
    byteCount: bytes.length,
    sha256: sha(bytes),
  };
}
function receipt(id = 1, overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(
      DELAWARE_NATIVE_RECEIPT_FIELDS.map((key) => [key, ""]),
    ),
    ContributionType: "Check",
    TransactionDate: "/Date(1786507200000)/",
    Transaction_id: id,
    ContributorName: "Example PAC",
    ContributionAmount: 600,
    ContributorType: "Political Action Committee",
    ReceivingCommitteeName: owner.committeeName,
    GabId: "123456",
    WC_ID: owner.cfId,
    Office: null,
    Branch: null,
    EmployerAddress: null,
    EmployerAddressLine1: null,
    Fund_Type: null,
    Fixed_Asset: "No",
    FilingPeriodName: "2026 2026 General Election 11/03/2026 30 Day",
    ContributorAddress: "SOURCE ADDRESS",
    AddressLine1: "SANITIZED ADDRESS",
    City: "Example",
    State_Code: "DE",
    Zip_Code: "19901",
    ...overrides,
  };
}
function expense(id = 2, overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(
      DELAWARE_NATIVE_EXPENSE_FIELDS.map((key) => [key, ""]),
    ),
    Transaction_Id: id,
    RegistrantName: owner.committeeName,
    PayeeName: "Example Vendor",
    PayeeType: "Corporation, Partnership, and Other Entity",
    TransactionDate: "/Date(1786507200000)/",
    ExpenseAmount: 100,
    ExpenseCategory: "Other Expenses",
    ExpensePurpose: "Other",
    ExpenseMethod: "Check",
    District: null,
    FilingYear: null,
    CommitteeID: null,
    Comments: null,
    Fund_Type: null,
    Fixed_Asset: "No",
    CCF_ID: owner.cfId,
    FilingPeriodName: "2026 30 Day General",
    Address: "SOURCE ADDRESS",
    AddressLine1: "SANITIZED ADDRESS",
    City: "Example",
    State: "DE",
    ZipCode: "19901",
    ...overrides,
  };
}
function occurrence(
  name: string,
  amount: number,
  index = 0,
): DelawareCandidatePdfOccurrence {
  return {
    occurrence: index,
    pageNumber: 3,
    pageNumbers: [3],
    date: "2026-08-12",
    columns: {
      date: "08/12/2026",
      name,
      address: "SOURCE ADDRESS",
      vendor: "",
    },
    monetaryColumns: { amount, aggregate: amount },
    rawCells: [],
  };
}
function facts(): DelawareCandidateFinancialReport {
  const keys: DelawareCandidateScheduleName[] = [
    "receipts",
    "expenditures",
    "inKindReceipts",
    "inKindExpenditures",
    "loansReceived",
    "loansOutstanding",
    "reimbursementsReceived",
    "reimbursementsPaid",
    "assets",
    "assetsEliminated",
  ];
  const schedules = Object.fromEntries(
    keys.map((key) => [key, { rows: [], controls: { totalCents: 0 } }]),
  ) as unknown as DelawareCandidateFinancialReport["schedules"];
  const mutable = schedules as Record<
    string,
    { rows: DelawareCandidatePdfOccurrence[]; controls: Record<string, number> }
  >;
  mutable.receipts = {
    rows: [occurrence("Example PAC", 60000)],
    controls: {
      itemizedCents: 60000,
      anonymousCents: 124000,
      grandCents: 184000,
    },
  };
  mutable.expenditures = {
    rows: [occurrence("Example Vendor", 10000)],
    controls: { itemizedCents: 10000, anonymousCents: 0, grandCents: 10000 },
  };
  mutable.inKindReceipts = {
    rows: [],
    controls: { itemizedCents: 0, anonymousCents: 0, grandCents: 0 },
  };
  mutable.inKindExpenditures = {
    rows: [],
    controls: { itemizedCents: 0, anonymousCents: 0, grandCents: 0 },
  };
  mutable.loansOutstanding = {
    rows: [],
    controls: {
      previousCents: 3400000,
      paymentsCents: 0,
      balanceCents: 3400000,
    },
  };
  return {
    pdfSha256: "",
    byteCount: 0,
    accountNumber: owner.cfId,
    organizationName: owner.committeeName,
    periodStart: "2026-01-01",
    periodEnd: "2026-10-04",
    reportDate: "2026-10-05",
    cover: {
      pageNumber: 2,
      beginningBalanceCents: 0,
      receiptsCents: 184000,
      expendituresCents: 10000,
      endingBalanceCents: 174000,
      reportingPeriodFrom: "01/01/2026",
      reportingPeriodTo: "10/04/2026",
      documentVersion: 1,
      method: "rows",
    },
    supplementaryCoverControls: {
      assetsCents: 0,
      assetsEliminatedCents: 0,
      loansOutstandingCents: 3400000,
    },
    schedules,
    sourcePages: [],
  };
}
function csv(page: DelawareNativeLedgerPage) {
  const receipt = page.kind === "receipts",
    columns = receipt
      ? DELAWARE_RECEIPT_CSV_COLUMNS
      : DELAWARE_EXPENSE_CSV_COLUMNS;
  return (
    columns.join(",") +
    ",\n" +
    page.rows
      .map((row) => {
        const projected = (
          receipt
            ? projectDelawareNativeReceiptCsvRow
            : projectDelawareNativeExpenseCsvRow
        )(row);
        const dateKey = receipt ? "Contribution Date" : "Expenditure Date",
          amountKey = receipt ? "Contribution Amount" : "Amount($)";
        const [y, m, d] = projected[dateKey]!.split("-");
        projected[dateKey] = `${Number(m)}/${Number(d)}/${y}`;
        projected[amountKey] = (Number(projected[amountKey]) / 100).toFixed(4);
        return columns.map((key) => projected[key]).join(",");
      })
      .join("\n") +
    "\n"
  );
}
function nativeGroup(
  rows: Record<string, unknown>[],
  kind: "receipts" | "expenses",
) {
  const receipt = kind === "receipts",
    json = JSON.stringify({ data: rows, total: 999999 }),
    page = (
      receipt
        ? decodeDelawareReceiptNativePage
        : decodeDelawareExpenseNativePage
    )(json),
    sourceCsv = csv(page);
  const query = capture(
    receipt
      ? "/Public/ViewReceipts?theme=vista"
      : "/Public/OtherSearch?theme=vista",
    "POST",
    `jQuery('#Grid').tGrid({total:${rows.length}});`,
    receipt
      ? buildDelawareReceiptsSearchFields({
          txtReceivingRegistrant: owner.committeeName,
          MemberId: String(owner.memberId),
        })
      : buildDelawareExpensesSearchFields({
          txtRegistrant: owner.committeeName,
          MemberId: String(owner.memberId),
          CommitteeType: "01",
        }),
  );
  const native = capture(
    (receipt ? "/Public/_ViewReceiptsCustom" : "/Public/_ViewExpensesCustom") +
      "?Grid-size=15&theme=vista",
    "POST",
    json,
    { page: "1", size: "500", orderBy: "", groupBy: "", filter: "" },
  );
  const exported = capture(
    (receipt ? "/Public/ExportCSVNew" : "/Public/ExportExpensestoCsv") +
      "?page=1&orderBy=~&filter=~&Grid-size=15&theme=vista",
    "GET",
    sourceCsv,
  );
  return {
    ledger: closeDelawareNativeLedger({
      pages: [{ pageNumber: 1, pageSize: 500, page }],
      renderedCount: rows.length,
      csv: sourceCsv,
    }),
    captures: [query, native, exported],
  };
}
function packet(
  options: {
    receipts?: Record<string, unknown>[];
    expenses?: Record<string, unknown>[];
    facts?: DelawareCandidateFinancialReport;
  } = {},
): DelawareCandidateFinancialBindingInput {
  clock = 0;
  const report = options.facts ?? facts();
  const search = capture(
    "/Public/ViewFiledReports?theme=vista",
    "POST",
    "inventory search",
    buildDelawareFiledReportsSearchFields({
      MemberId: String(owner.memberId),
      txtCommitteeName: owner.committeeName,
    }),
  );
  const html = `jQuery('#Grid').tGrid({total:1});<div id="Grid"><table><tbody><tr><td>2026 30 Day 2026 General Election 11/03/2026</td><td><a onclick="downloadReport(&#39;${file}&#39;,&#39;733862&#39;,&#39;1273&#39;)">Amended Financial Statement</a></td><td>${owner.cfId}</td><td>${owner.committeeName}</td><td>Candidate Committee</td><td>10/05/2026</td><td>2026</td><td>State Office - State Representative</td><td>Active</td></tr></tbody></table></div>`;
  const inventory = capture(
    "/Public/_ViewFiledReports?ajax=True&Grid-page=1&Grid-orderBy=~&Grid-groupBy=~&Grid-filter=~&Grid-size=500&theme=vista",
    "GET",
    html,
  );
  const receipts = nativeGroup(options.receipts ?? [receipt()], "receipts"),
    expenses = nativeGroup(options.expenses ?? [expense()], "expenses");
  const pdfCapture = capture(
    `/Public/FiledReports?FileName=${file}&CommitteeID=733862&FilingCalendarID=1273`,
    "GET",
    JSON.stringify(report),
  );
  report.pdfSha256 = pdfCapture.sha256;
  report.byteCount = pdfCapture.byteCount;
  return {
    owner: { ...owner },
    inventoryCaptures: [search, inventory],
    reports: [{ facts: report, pdfCapture }],
    receipts,
    expenses,
  };
}
function replaceBody(c: DelawareCandidateFinancialObservation, body: string) {
  c.body = Buffer.from(body);
  c.byteCount = c.body.length;
  c.sha256 = sha(c.body);
}

describe("Delaware candidate source monetary occurrence bindings", () => {
  it("binds source file/calendar/owner, real full ledgers and amended-label facts without currentness authority", async () => {
    const result = await bindDelawareCandidateFinancialFacts(packet());
    expect(result.scope).toBe("candidate_financial_source_facts");
    expect(result.reports[0]!.inventoryRow.reportName).toBe(
      "Amended Financial Statement",
    );
    expect(
      result.reports[0]!.bindings.receipts![0]!.nativeTransactionIds,
    ).toEqual([1]);
    expect(result.reports[0]!.aggregates[0]).toMatchObject({
      controlCents: 124000,
      representedNativeCents: 0,
      pdfOnlyAggregateCents: 124000,
    });
    expect(
      result.reports[0]!.facts.schedules.loansOutstanding.controls.balanceCents,
    ).toBe(3400000);
    expect(result.reports[0]!.unsupportedMechanisms).toEqual([]);
    expect(result).not.toHaveProperty("currentVersionAuthority");
  });
  it("retains both address values with a diagnostic without changing monetary correspondence", async () => {
    const p = packet({
      receipts: [
        receipt(1, { ContributorAddress: "DIFFERENT SOURCE ADDRESS" }),
      ],
    });
    const result = await bindDelawareCandidateFinancialFacts(p);
    const binding = result.reports[0]!.bindings.receipts![0]!;
    expect(binding.addressDiagnostics).toHaveLength(1);
    expect(binding.nativeRows[0]!.rawFields.ContributorAddress).toBe(
      "DIFFERENT SOURCE ADDRESS",
    );
    expect(binding.pdfOccurrences[0]!.columns.address).toBe("SOURCE ADDRESS");
  });
  it("keeps repeated equal gifts as a complete equivalence set", async () => {
    const f = facts();
    (f.schedules.receipts.rows as DelawareCandidatePdfOccurrence[]).push(
      occurrence("Example PAC", 60000, 1),
    );
    const p = packet({ facts: f, receipts: [receipt(1), receipt(3)] });
    const result = await bindDelawareCandidateFinancialFacts(p);
    expect(result.reports[0]!.bindings.receipts).toHaveLength(1);
    expect(
      result.reports[0]!.bindings.receipts![0]!.nativeTransactionIds,
    ).toEqual([1, 3]);
    expect(
      result.reports[0]!.bindings.receipts![0]!.pdfOccurrences,
    ).toHaveLength(2);
  });
  it("corroborates and retains only exact published Return Contributions annotation", async () => {
    const f = facts();
    f.schedules.expenditures.rows[0]!.columns.name =
      "Example Vendor (Return Contributions)";
    const result = await bindDelawareCandidateFinancialFacts(
      packet({
        facts: f,
        expenses: [expense(2, { ExpenseCategory: "Return Contributions" })],
      }),
    );
    expect(
      result.reports[0]!.bindings.expenditures![0]!.categoryAnnotations,
    ).toEqual([{ occurrence: 0, literal: "(Return Contributions)" }]);
    expect(
      result.reports[0]!.bindings.expenditures![0]!.pdfOccurrences[0]!.columns
        .name,
    ).toBe("Example Vendor (Return Contributions)");
  });
  it("places actual native aggregates once and preserves the printed remainder separately", async () => {
    const p = packet({
      receipts: [
        receipt(),
        receipt(3, {
          ContributorName: "Anonymous",
          ContributionType: "Total of Contributions not exceeding $100",
          ContributorType: "Total of Contributions not exceeding $100",
          ContributionAmount: 1240,
        }),
      ],
    });
    const result = await bindDelawareCandidateFinancialFacts(p);
    expect(result.reports[0]!.aggregates[0]).toMatchObject({
      controlCents: 124000,
      representedNativeCents: 124000,
      nativeTransactionIds: [3],
      pdfOnlyAggregateCents: 0,
    });
    expect(result.reports[0]!.bindings.receipts).toHaveLength(1);
  });
  it("keeps a typed anonymous cash occurrence itemized when actually printed", async () => {
    const p = packet({
      receipts: [
        receipt(1, {
          ContributorType: "Total of Contributions not exceeding $100",
          ContributionType: "Cash",
        }),
      ],
    });
    const result = await bindDelawareCandidateFinancialFacts(p);
    expect(
      result.reports[0]!.bindings.receipts![0]!.nativeTransactionIds,
    ).toEqual([1]);
    expect(result.reports[0]!.aggregates[0]!.nativeTransactionIds).toEqual([]);
  });
  it("retains unknown loan/supplemental mechanisms as unsupported source facts", async () => {
    const p = packet({
      receipts: [
        receipt(),
        receipt(3, {
          ContributionType: "Candidate Loan",
          ContributionAmount: 1000,
        }),
      ],
    });
    const result = await bindDelawareCandidateFinancialFacts(p);
    expect(
      result.reports[0]!.unsupportedMechanisms[0]!.nativeTransactionIds,
    ).toEqual([3]);
  });
  it("does not synthesize omitted legacy capture fields", async () => {
    const p = packet();
    delete p.inventoryCaptures[0]!.attempt;
    delete p.inventoryCaptures[0]!.requestScopeRedacted;
    const result = await bindDelawareCandidateFinancialFacts(p);
    expect(
      result.diagnostics.some((d) =>
        d.includes("Legacy source-facts envelope"),
      ),
    ).toBe(true);
    expect(result.sourceMetadata[0]).not.toHaveProperty("attempt");
    expect(result.sourceMetadata[0]).not.toHaveProperty("requestScopeRedacted");
  });
  it("rejects invalid known metadata even when another legacy field is absent", async () => {
    const input = packet();
    input.inventoryCaptures[0]!.attempt = 0;
    delete input.inventoryCaptures[0]!.requestScopeRedacted;
    await expect(bindDelawareCandidateFinancialFacts(input)).rejects.toThrow(
      /provided observation attempt/,
    );
  });
  it.each([
    [
      "changed name with same total",
      () =>
        packet({
          receipts: [receipt(1, { ContributorName: "Different PAC" })],
        }),
    ],
    [
      "changed date with same total",
      () =>
        packet({
          receipts: [receipt(1, { TransactionDate: "/Date(1786593600000)/" })],
        }),
    ],
    ["missing occurrence", () => packet({ receipts: [] })],
    ["extra occurrence", () => packet({ receipts: [receipt(), receipt(3)] })],
    [
      "conflicting repeated class",
      () => {
        const f = facts();
        (f.schedules.receipts.rows as DelawareCandidatePdfOccurrence[]).push(
          occurrence("Example PAC", 60000, 1),
        );
        return packet({
          facts: f,
          receipts: [receipt(), receipt(3, { ContributorType: "Individual" })],
        });
      },
    ],
    [
      "conflicting repeated mechanism",
      () => {
        const f = facts();
        (f.schedules.receipts.rows as DelawareCandidatePdfOccurrence[]).push(
          occurrence("Example PAC", 60000, 1),
        );
        return packet({
          facts: f,
          receipts: [receipt(), receipt(3, { ContributionType: "Cash" })],
        });
      },
    ],
    [
      "wrong native owner",
      () => packet({ receipts: [receipt(1, { WC_ID: "01000002" })] }),
    ],
    [
      "wrong native report",
      () =>
        packet({
          receipts: [
            receipt(1, {
              FilingPeriodName: "2026 2026 Primary Election 09/15/2026 30 Day",
            }),
          ],
        }),
    ],
    [
      "partial anonymous projection",
      () =>
        packet({
          receipts: [
            receipt(),
            receipt(3, {
              ContributorName: "Anonymous",
              ContributionType: "Total of Contributions not exceeding $100",
              ContributorType: "Total of Contributions not exceeding $100",
              ContributionAmount: 200,
            }),
          ],
        }),
    ],
    [
      "anonymous excess",
      () =>
        packet({
          receipts: [
            receipt(),
            receipt(3, {
              ContributorName: "Anonymous",
              ContributionType: "Total of Contributions not exceeding $100",
              ContributorType: "Total of Contributions not exceeding $100",
              ContributionAmount: 2000,
            }),
          ],
        }),
    ],
    [
      "uncorroborated category suffix",
      () => {
        const f = facts();
        f.schedules.expenditures.rows[0]!.columns.name =
          "Example Vendor (Return Contributions)";
        return packet({ facts: f });
      },
    ],
  ] as const)("rejects %s", async (_label, make) => {
    await expect(bindDelawareCandidateFinancialFacts(make())).rejects.toThrow();
  });
  it("rejects supplied-ledger and supplied-PDF facts changed after the raw observations", async () => {
    const p = packet();
    p.receipts.ledger = {
      ...p.receipts.ledger,
      rawRowFingerprint: "0".repeat(64),
    };
    await expect(bindDelawareCandidateFinancialFacts(p)).rejects.toThrow(
      /reclosure/,
    );
    const q = packet();
    q.reports[0]!.facts.schedules.receipts.rows[0]!.columns.name = "Changed";
    await expect(bindDelawareCandidateFinancialFacts(q)).rejects.toThrow(
      /supplied PDF facts/,
    );
  });
  it("accepts the client capture contract without inventing omitted private blank controls", async () => {
    const p = packet();
    for (const c of [...p.inventoryCaptures, ...p.receipts.captures, ...p.expenses.captures]) {
      if (c.financeFields) c.financeFields = Object.fromEntries(Object.entries(c.financeFields)
        .filter(([key, value]) => isDelawareCfrsCaptureFieldAllowed(key, value)));
    }
    const result = await bindDelawareCandidateFinancialFacts(p);
    expect(result.reports).toHaveLength(1);
    expect(result.sourceMetadata.find(c => c.url.includes("ViewReceipts"))!.financeFields)
      .not.toHaveProperty("txtStreet");
    delete (p.receipts.captures[0]!.financeFields as Record<string, string>).ContributorType;
    await expect(bindDelawareCandidateFinancialFacts(p)).rejects.toThrow(/query scope/);
  });
  it("rejects narrowed query and wrong source file/calendar request", async () => {
    const p = packet();
    (
      p.receipts.captures[0]!.financeFields as Record<string, string>
    ).ContributorType = "PAC";
    await expect(bindDelawareCandidateFinancialFacts(p)).rejects.toThrow(
      /query scope/,
    );
    const q = packet();
    q.reports[0]!.pdfCapture.url = q.reports[0]!.pdfCapture.url.replace(
      "FilingCalendarID=1273",
      "FilingCalendarID=1272",
    );
    await expect(bindDelawareCandidateFinancialFacts(q)).rejects.toThrow(
      /inventory|report identity/,
    );
  });
  it("rejects redacted scope, changed raw hash and incomplete inventory", async () => {
    const p = packet();
    p.receipts.captures[0]!.requestScopeRedacted = true;
    await expect(bindDelawareCandidateFinancialFacts(p)).rejects.toThrow(
      /integrity/,
    );
    const q = packet();
    q.reports[0]!.pdfCapture.sha256 = "0".repeat(64);
    await expect(bindDelawareCandidateFinancialFacts(q)).rejects.toThrow(
      /integrity/,
    );
    const r = packet();
    replaceBody(
      r.inventoryCaptures[1]!,
      r.inventoryCaptures[1]!.body.toString().replace("total:1", "total:2"),
    );
    await expect(bindDelawareCandidateFinancialFacts(r)).rejects.toThrow(
      /inventory|report identity/,
    );
  });
  it("rejects opaque extra filters instead of assuming complete scope", async () => {
    const p = packet();
    (
      p.receipts.captures[0]!.financeFields as Record<string, string>
    ).NewFilter = "restricted";
    await expect(bindDelawareCandidateFinancialFacts(p)).rejects.toThrow(
      /query scope/,
    );
  });
  it("returns detached financial facts and source metadata", async () => {
    const p = packet();
    const result = await bindDelawareCandidateFinancialFacts(p);
    p.reports[0]!.facts.schedules.receipts.rows[0]!.columns.name =
      "Changed later";
    (p.receipts.captures[0]!.financeFields as Record<string, string>).MemberId =
      "changed";
    expect(
      result.reports[0]!.bindings.receipts![0]!.pdfOccurrences[0]!.columns.name,
    ).toBe("Example PAC");
    expect(
      result.sourceMetadata.find((m) => m.url.includes("ViewReceipts"))!
        .financeFields!.MemberId,
    ).toBe("733862");
  });
});

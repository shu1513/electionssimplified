import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchDelawareCfrsCandidateSourcePacket } from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactAcquisition.js";
import { decodeDelawareCandidateSourcePacketFromCaptures } from "../../../src/pipeline/delawareFinance/delawareCandidateSourcePacketReplay.js";
import type {
  DelawareCfrsFetchFn,
  DelawareCfrsResponseCapture,
} from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import {
  DELAWARE_NATIVE_RECEIPT_FIELDS,
  DELAWARE_NATIVE_EXPENSE_FIELDS,
  decodeDelawareReceiptNativePage,
  decodeDelawareExpenseNativePage,
  projectDelawareNativeReceiptCsvRow,
  projectDelawareNativeExpenseCsvRow,
} from "../../../src/pipeline/delawareFinance/delawareNativeLedger.js";
import {
  DELAWARE_RECEIPT_CSV_COLUMNS,
  DELAWARE_EXPENSE_CSV_COLUMNS,
} from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";

const cfId = "01009999",
  memberId = 600001,
  committeeName = "Jane Example for Delaware";
const file = `CampaignFinanceReport_Prelim_${memberId}_900_00000000-0000-4000-8000-000000000001.pdf`;
function receipt(id: number) {
  return {
    ...Object.fromEntries(DELAWARE_NATIVE_RECEIPT_FIELDS.map((k) => [k, ""])),
    Transaction_id: id,
    TransactionDate: `/Date(${Date.parse("2026-06-30T12:00:00Z")})/`,
    ContributionAmount: 500,
    ContributorName: "Jane Donor",
    ContributorType: "Individual",
    ContributionType: "Check",
    WC_ID: cfId,
    ReceivingCommitteeName: committeeName,
    FilingPeriodName: "2026 30 Day General",
    District: "(Attorney General)",
    AddressLine1: "1 Example St",
    City: "Wilmington",
    State_Code: "DE",
    Zip_Code: "19801",
    Fixed_Asset: "No",
    FileAmendedVersion: "30 Jun 2026 Version 1.0",
    EmployerAddress: null,
    EmployerAddressLine1: null,
    Fund_Type: null,
  };
}
function expense() {
  return {
    ...Object.fromEntries(DELAWARE_NATIVE_EXPENSE_FIELDS.map((k) => [k, ""])),
    Transaction_Id: 901,
    TransactionDate: `/Date(${Date.parse("2026-07-01T12:00:00Z")})/`,
    ExpenseAmount: 300,
    PayeeName: "Vendor",
    PayeeType: "Individual",
    ExpenseMethod: "Check",
    ExpenseCategory: "Media",
    ExpensePurpose: "Ads",
    RegistrantName: committeeName,
    CCF_ID: cfId,
    AddressLine1: "2 Example Rd",
    City: "Dover",
    State: "DE",
    ZipCode: "19901",
    FilingPeriodName: "2026 30 Day General",
    Fixed_Asset: "No",
    FileAmendedVersion: "1 Jul 2026 Version 1.0",
    District: null,
    FilingYear: null,
    CommitteeID: null,
    Comments: null,
    Fund_Type: null,
  };
}
function csv(rows: Record<string, unknown>[], kind: "receipts" | "expenses") {
  const decoder =
    kind === "receipts"
      ? decodeDelawareReceiptNativePage
      : decodeDelawareExpenseNativePage;
  const parsed = Array.from(
    { length: Math.ceil(rows.length / 500) },
    (_, i) =>
      decoder(
        JSON.stringify({ data: rows.slice(i * 500, (i + 1) * 500), total: 0 }),
      ).rows,
  ).flat();
  const columns =
    kind === "receipts"
      ? DELAWARE_RECEIPT_CSV_COLUMNS
      : DELAWARE_EXPENSE_CSV_COLUMNS;
  const dateKey =
    kind === "receipts" ? "Contribution Date" : "Expenditure Date";
  const amountKey = kind === "receipts" ? "Contribution Amount" : "Amount($)";
  return [
    columns.join(",") + ",",
    ...parsed.map((r) => {
      const projected = (
        kind === "receipts"
          ? projectDelawareNativeReceiptCsvRow
          : projectDelawareNativeExpenseCsvRow
      )(r);
      return columns
        .map((k) =>
          k === dateKey
            ? `${projected[k]!.slice(5, 7)}/${projected[k]!.slice(8, 10)}/${projected[k]!.slice(0, 4)}`
            : k === amountKey
              ? (Number(projected[k]) / 100).toFixed(4)
              : projected[k],
        )
        .join(",");
    }),
  ].join("\r\n");
}
function reportHtml() {
  return `<script>jQuery('#Grid').tGrid({columns:[],pageSize:15,total:1});</script><table><tbody><tr><td>2026 30 Day 2026 General Election 11/03/2026</td><td><a onclick=downloadReport(&#39;${file}&#39;,&#39;${memberId}&#39;,&#39;900&#39;)>Original Financial Statement</a></td><td>${cfId}</td><td>${committeeName}</td><td>Candidate Committee</td><td>10/06/2026</td><td>2026</td><td>(Attorney General)</td><td>Active</td></tr></tbody></table>`;
}
async function producer(
  options: {
    wholeMember?: boolean;
    many?: boolean;
    missingSo?: boolean;
    transient?: boolean;
    failedBootstrap?: boolean;
  } = {},
) {
  const receipts = Array.from({ length: options.many ? 501 : 2 }, (_, i) =>
    receipt(i + 1),
  );
  const expenses = [expense()];
  const requests: string[] = [];
  let receiptSearchCalls = 0;
  let bootstrapCalls = 0;
  const response = (body: string, contentType = "text/html") =>
    new Response(body, {
      status: 200,
      headers: { "Content-Type": contentType },
    });
  const fetchImpl: DelawareCfrsFetchFn = async (url, init) => {
    const u = new URL(url),
      fields = new URLSearchParams(init.body ?? "");
    requests.push(u.pathname);
    if (
      u.pathname === "/Public/ViewCommittees" &&
      ++bootstrapCalls === 1 &&
      options.failedBootstrap
    )
      return new Response("temporary failure", {
        status: 503,
        headers: { "Content-Type": "text/html" },
      });
    if (u.pathname === "/Public/Search")
      return response(
        options.missingSo
          ? "results"
          : `<a href='/Public/ShowReview?memberID=${memberId} &memVersID=7 &cTypeCode=01 &ftype=SO &fpath= &fname= &isPublic=true'>${committeeName}</a>`,
      );
    if (u.pathname === "/Public/_ViewCommittees")
      return response(
        JSON.stringify({
          data: [
            {
              MemberID: memberId,
              MemberVersID: 7,
              Committee_Id: cfId,
              CommitteeName: committeeName,
              CommitteeTypeCode: "01",
              CommitteeType: "Candidate Committee",
              CommitteeStatus: "Active",
              OfficeSought: "",
              DistrictName: "",
              County: "",
              RegisteredDateStr: "1/1/2026",
              Formtype: "SO",
              rawUnknown: "retained",
            },
          ],
          total: 1,
        }),
        "application/json",
      );
    if (u.pathname === "/Public/_ViewFiledReports")
      return response(reportHtml());
    if (u.pathname === "/Public/FiledReports")
      return response("%PDF-1.4 test", "application/pdf");
    if (u.pathname === "/Public/ViewReceipts") receiptSearchCalls += 1;
    if (
      u.pathname === "/Public/ViewReceipts" ||
      u.pathname === "/Public/OtherSearch"
    )
      return response(
        `<script>jQuery('#Grid').tGrid({columns:[],pageSize:15,total:${u.pathname === "/Public/ViewReceipts" ? (options.transient && receiptSearchCalls === 1 ? 0 : receipts.length) : expenses.length}});</script>`,
      );
    if (u.pathname === "/Public/_ViewReceiptsCustom") {
      const page = Number(fields.get("page"));
      const rows = options.many
        ? page === 1
          ? receipts.slice(0, 500)
          : receipts.slice(499)
        : receipts;
      return response(
        JSON.stringify({ data: rows, total: 99999 }),
        "application/json",
      );
    }
    if (u.pathname === "/Public/_ViewExpensesCustom")
      return response(
        JSON.stringify({ data: expenses, total: 0 }),
        "application/json",
      );
    if (u.pathname === "/Public/ExportCSVNew")
      return response(csv(receipts, "receipts"), "application/octet-stream");
    if (u.pathname === "/Public/ExportExpensestoCsv")
      return response(csv(expenses, "expenses"), "application/octet-stream");
    if (
      [
        "/Public/ViewCommittees",
        "/Public/ShowReview",
        "/Public/ViewFiledReports",
        "/Public/ViewReceiptsMain",
        "/Public/ViewExpenses",
      ].includes(u.pathname)
    )
      return response("published source form");
    throw new Error("Unexpected synthetic source route");
  };
  const input = {
    cfId,
    memberId,
    committeeName,
    requestWindow: options.wholeMember
      ? null
      : { start: "2023-01-01", end: "2026-12-31" },
    sessionOptions: {
      fetchImpl,
      spacingMs: 0,
      sleep: async () => {},
      maxAttempts: options.failedBootstrap ? 2 : 1,
    },
  };
  const packet = await fetchDelawareCfrsCandidateSourcePacket(input);
  return { input, packet, requests };
}
const replay = (p: Awaited<ReturnType<typeof producer>>) =>
  decodeDelawareCandidateSourcePacketFromCaptures({
    ...p.input,
    captures: p.packet.sourceCaptures,
  });
function changeBody(c: DelawareCfrsResponseCapture, body: string) {
  c.body = Buffer.from(body);
  c.byteCount = c.body.length;
  c.sha256 = createHash("sha256").update(c.body).digest("hex");
}

describe("Delaware candidate packet immutable replay", () => {
  it.each([false, true])(
    "matches the real packet producer for whole Member=%s without source calls",
    async (wholeMember) => {
      const p = await producer({ wholeMember });
      const beforeRequests = [...p.requests];
      expect(replay(p)).toEqual(p.packet);
      expect(p.requests).toEqual(beforeRequests);
      expect(
        replay(p).sourceCaptures.map((c) => [
          c.sha256,
          c.startedAt,
          c.completedAt,
        ]),
      ).toEqual(
        p.packet.sourceCaptures.map((c) => [
          c.sha256,
          c.startedAt,
          c.completedAt,
        ]),
      );
    },
  );
  it("retains page-boundary overlap and distinct equal gifts", async () => {
    const p = await producer({ many: true });
    const result = replay(p);
    expect(result).toEqual(p.packet);
    expect(result.receipts).toMatchObject({
      physicalRowCount: 502,
      transportOverlapCount: 1,
    });
    expect(result.receipts.rows).toHaveLength(501);
    expect(
      result.receipts.rows.slice(0, 2).map((r) => r.transactionId),
    ).toEqual([1, 2]);
    expect(result.receipts.rows[0]!.amountCents).toBe(
      result.receipts.rows[1]!.amountCents,
    );
  });
  it("uses the last actual rendered search count while retaining earlier attempts", async () => {
    const p = await producer({ transient: true });
    const result = replay(p);
    expect(result).toEqual(p.packet);
    expect(result.receiptRenderedCount).toBe(2);
    expect(
      result.sourceCaptures.filter(
        (c) =>
          new URL(c.url).pathname === "/Public/ViewReceipts" &&
          c.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("rejects a missing final native page rather than accepting a full first page", async () => {
    const p = await producer({ many: true });
    const caps = p.packet.sourceCaptures.filter(
      (c) =>
        !(
          new URL(c.url).pathname === "/Public/_ViewReceiptsCustom" &&
          c.financeFields?.page === "2"
        ),
    );
    expect(() =>
      decodeDelawareCandidateSourcePacketFromCaptures({
        ...p.input,
        captures: caps,
      }),
    ).toThrow(/terminal page/);
  });

  it("retains missing SO edition diagnostics without claiming source authority", async () => {
    const p = await producer({ missingSo: true });
    expect(replay(p)).toEqual(p.packet);
    expect(replay(p).diagnostics).toEqual([
      "No observed organization links; identity authority unavailable.",
      "Registry editions lack observed SO links; identity authority unresolved.",
    ]);
  });
  it("detaches original source bytes, fields and output facts", async () => {
    const p = await producer();
    const result = replay(p);
    result.sourceCaptures[0]!.body.fill(0);
    (result.registryRows[0]! as Record<string, unknown>).rawUnknown = "changed";
    expect(replay(p)).toEqual(p.packet);
    const search = result.sourceCaptures.find(
      (c) =>
        new URL(c.url).pathname === "/Public/ViewReceipts" &&
        c.method === "POST",
    )!;
    search.financeFields!.MemberId = "99";
    expect(
      p.packet.sourceCaptures.find(
        (c) =>
          new URL(c.url).pathname === "/Public/ViewReceipts" &&
          c.method === "POST",
      )!.financeFields!.MemberId,
    ).toBe(String(memberId));
  });
  it("retains original failed attempts from the producer without using their bytes as rows", async () => {
    const p = await producer({ failedBootstrap: true });
    const result = replay(p);
    expect(result).toEqual(p.packet);
    expect(result.sourceCaptures[0]).toMatchObject({ status: 503, attempt: 1 });
    expect(result.sourceCaptures[0]!.body.toString()).toBe("temporary failure");
    expect(result.sourceCaptures[1]).toMatchObject({ status: 200, attempt: 2 });
    expect(result.receipts).toEqual(p.packet.receipts);
  });
  it.each([
    "wrong_member",
    "wrong_window",
    "wrong_current",
    "hash",
    "extra_headers",
    "missing_csv",
    "missing_native",
    "page_gap",
    "changed_csv_name",
    "missing_pdf",
    "wrong_pdf_owner",
    "wrong_registry",
    "redacted",
  ])("rejects %s", async (kind) => {
    const p = await producer();
    const caps = [...p.packet.sourceCaptures];
    const receiptSearch = caps.find(
      (c) =>
        new URL(c.url).pathname === "/Public/ViewReceipts" &&
        c.method === "POST",
    )!;
    if (kind === "wrong_member") receiptSearch.financeFields!.MemberId = "12";
    if (kind === "wrong_window")
      receiptSearch.financeFields!.dtStartDate = "01/01/2026";
    if (kind === "wrong_current")
      caps.filter(
        (c) =>
          new URL(c.url).pathname === "/Public/ViewFiledReports" &&
          c.method === "POST",
      )[1]!.financeFields!.hdnViewCurrent = "false";
    if (kind === "hash") caps[0]!.sha256 = "a".repeat(64);
    if (kind === "extra_headers")
      (caps[0] as any).headers = { Cookie: "secret" };
    if (kind === "missing_csv")
      caps.splice(
        caps.findIndex(
          (c) => new URL(c.url).pathname === "/Public/ExportCSVNew",
        ),
        1,
      );
    if (kind === "missing_native")
      caps.splice(
        caps.findIndex(
          (c) => new URL(c.url).pathname === "/Public/_ViewReceiptsCustom",
        ),
        1,
      );
    if (kind === "page_gap")
      caps.find(
        (c) => new URL(c.url).pathname === "/Public/_ViewReceiptsCustom",
      )!.financeFields!.page = "2";
    if (kind === "changed_csv_name") {
      const c = caps.find(
        (c) => new URL(c.url).pathname === "/Public/ExportCSVNew",
      )!;
      changeBody(c, c.body.toString().replace(/Jane Donor/g, "Other Donor"));
    }
    if (kind === "missing_pdf")
      caps.splice(
        caps.findIndex(
          (c) => new URL(c.url).pathname === "/Public/FiledReports",
        ),
        1,
      );
    if (kind === "wrong_pdf_owner")
      caps.find(
        (c) => new URL(c.url).pathname === "/Public/FiledReports",
      )!.url = caps
        .find((c) => new URL(c.url).pathname === "/Public/FiledReports")!
        .url.replace("CommitteeID=600001", "CommitteeID=600002");
    if (kind === "wrong_registry") {
      const c = caps.find(
        (c) => new URL(c.url).pathname === "/Public/_ViewCommittees",
      )!;
      changeBody(
        c,
        c.body.toString().replace('"MemberID":600001', '"MemberID":600002'),
      );
    }
    if (kind === "redacted") receiptSearch.requestScopeRedacted = true;
    expect(() =>
      decodeDelawareCandidateSourcePacketFromCaptures({
        ...p.input,
        captures: caps,
      }),
    ).toThrow();
  });
});

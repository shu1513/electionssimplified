import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KY_CENSUS_COLUMNS,
  KY_RECEIPT_COLUMNS,
  KY_IE_COLUMNS,
  refreshKentuckyReportedSource,
  type KentuckyReportedKind,
  type KentuckyReportedRow,
} from "../../../src/pipeline/kentuckyFinance/kentuckyReportedSource.js";
import type { KentuckyReportedReceiver } from "../../../src/pipeline/kentuckyFinance/kentuckyReportedAggregation.js";
export const receiver: KentuckyReportedReceiver = {
  linkId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222",
  electionId: "33333333-3333-4333-8333-333333333333",
  electionYear: 2026,
  electionDate: "2026-11-03",
  candidateName: "Alice A Example",
  officeScope: "state_lower",
  officeName: "State Lower Chamber Legislator",
  canonicalOffice: "State Lower Chamber Legislator",
  location: "21",
  canonicalDistrict: "21",
  candidateKey:
    "alice a example|state lower chamber legislator|state lower|2026-11-03",
  committeeKey: "alice a example",
  committeeName: "Alice A Example",
};
export const csv = (columns: string[], rows: KentuckyReportedRow[]) =>
  [columns, ...rows.map((r) => columns.map((k) => r[k] ?? ""))]
    .map((cells) =>
      cells.map((v) => '"' + v.replaceAll('"', '""') + '"').join(","),
    )
    .join("\r\n") + "\r\n";
export function census(
  date = "11/3/2026",
  overrides: KentuckyReportedRow = {},
): KentuckyReportedRow {
  return {
    "Last Name": "Example",
    "First Name": "Alice A",
    "Office Sought": "STATE REPRESENTATIVE",
    "Is Active": "True",
    Location: "21ST DISTRICT",
    "Election Date": date,
    "Election Type": date.startsWith("5/") ? "PRIMARY" : "GENERAL",
    "Exemption Status": "None",
    "Total Receipts": "$10,000.00",
    "Total Disburse": "$1,000.00",
    ...overrides,
  };
}
export function receipt(
  overrides: KentuckyReportedRow = {},
): KentuckyReportedRow {
  return {
    ...Object.fromEntries(KY_RECEIPT_COLUMNS.map((k) => [k, ""])),
    "Recipient First Name": "Alice A",
    "Recipient Last Name": "Example",
    "Office Sought": "STATE REPRESENTATIVE",
    Location: "21ST DISTRICT",
    "Election Date": "11/3/2026",
    "Election Type": "GENERAL",
    "Contribution Type": "KYPAC",
    "Contribution Mode": "DIRECT",
    "From Organization Name": "Example Workers PAC",
    "Address 1": "10 TEST ROAD",
    Amount: "$1,000.00",
    "Statement Type": "30 DAY PRE",
    ...overrides,
  };
}
export function ie(overrides: KentuckyReportedRow = {}): KentuckyReportedRow {
  return {
    "To Whome Made": "Example Vendor",
    Name: "Example Independent Committee",
    Date: "10/1/2026",
    "Candidate Name": "Alice A Example",
    "Support / Oppose": "Supported",
    "Office / Ballot Measure": "STATE REPRESENTATIVE",
    "Election Date": "11/3/2026",
    Amount: "$4,000.00",
    ...overrides,
  };
}
export async function fixture(
  kind: KentuckyReportedKind,
  options: {
    rows?: KentuckyReportedRow[];
    censusExtra?: KentuckyReportedRow[];
    moveClosing?: boolean;
    badCount?: boolean;
    http?: number;
    reverseClosing?: boolean;
  } = {},
) {
  const cacheDir = await mkdtemp(join(tmpdir(), "ky-reported-test-"));
  let requestCount = 0;
  const fetchImpl = (async (raw: string | URL | Request) => {
    requestCount++;
    const u = new URL(String(raw)),
      primary = u.searchParams.get("ElectionDate") === "2026-05-19",
      date = primary ? "5/19/2026" : "11/3/2026",
      censusRows = [
        census(date),
        ...(options.censusExtra ?? []).filter(
          (r) => r["Election Date"] === date,
        ),
      ],
      dataRows = primary
        ? []
        : (options.rows ?? (kind === "committee" ? [receipt()] : [ie()]));
    const censusRequest = [
        "/kref/publicsearch/CandidateSearch",
        "/kref/publicsearch/ExportSearch",
      ].includes(u.pathname),
      html = [
        "/kref/publicsearch/CandidateSearch",
        "/kref/publicsearch/ToCandidateSearch",
        "/kref/publicsearch/IndependentExpenditureSearch",
      ].includes(u.pathname);
    let rows = censusRequest ? censusRows : dataRows;
    if (!censusRequest && !html && requestCount % 8 === 5) {
      if (options.moveClosing) rows = [...rows, ...rows.slice(0, 1)];
      if (options.reverseClosing) rows = [...rows].reverse();
    }
    const body = html
      ? `<html>${rows.length + (options.badCount ? 1 : 0)} Results</html>`
      : csv(
          censusRequest
            ? KY_CENSUS_COLUMNS
            : kind === "committee"
              ? KY_RECEIPT_COLUMNS
              : KY_IE_COLUMNS,
          rows,
        );
    return new Response(body, { status: options.http ?? 200 });
  }) as typeof fetch;
  return {
    cacheDir,
    fetchImpl,
    async source() {
      return refreshKentuckyReportedSource({ cacheDir, kind, fetchImpl });
    },
    async cleanup() {
      await rm(cacheDir, { recursive: true, force: true });
    },
    requests() {
      return requestCount;
    },
  };
}

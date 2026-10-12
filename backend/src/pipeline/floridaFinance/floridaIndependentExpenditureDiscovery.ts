import { createHash } from "node:crypto";
import type { FloridaFinanceRawRequest } from "./floridaFinanceRawSourceClient.js";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";

export const FLORIDA_EXPENDITURE_DISCOVERY_HEADERS = [
  "Candidate/Committee",
  "Date",
  "Amount",
  "Payee Name",
  "Address",
  "City State Zip",
  "Purpose",
  "Type",
] as const;
type Header = (typeof FLORIDA_EXPENDITURE_DISCOVERY_HEADERS)[number];
export type FloridaExpenditureDiscoveryRow = {
  occurrence: number;
  payerLabel: string;
  date: string;
  amountCents: number;
  payeeName: string;
  address: string;
  cityStateZip: string;
  purpose: string;
  sourceType: string;
  rawFields: Readonly<Record<Header, string>>;
};
export type FloridaExpenditureDiscoveryScope = {
  electionSelector: string;
  purposePrefix: string;
  rowLimit: number;
};
export type FloridaExpenditureDiscoveryResult =
  | {
      status: "discovered";
      /** A discovery subset, including an empty one, grants no financial authority. */
      authority: "discovery_only";
      scope: FloridaExpenditureDiscoveryScope;
      rows: readonly FloridaExpenditureDiscoveryRow[];
      sourceMetadata: Omit<FloridaProcessedRawEvidence, "bytesRaw"> & {
        byteCount: number;
      };
    }
  | { status: "preserve"; diagnostics: readonly string[] };
export type FloridaExpenditureDiscoveryRequest = (
  request: FloridaFinanceRawRequest,
  options?: { savedFirst?: boolean },
) => Promise<FloridaProcessedRawEvidence>;

const EXPORT_URL = "https://dos.elections.myflorida.com/cgi-bin/expend.exe";
// Literal values witnessed in the current official form, not generated dates.
const ELECTIONS = new Set([
  "20261103-GEN",
  "20261103-S01",
  "20260324-S01",
  "20260324-S02",
  "20260324-S03",
]);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fail(reason: string): never {
  throw new Error(`Florida expenditure discovery: ${reason}`);
}
function civilDate(raw: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) fail("invalid source date");
  const value = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    fail("invalid source date");
  return value;
}
function cents(raw: string): number {
  const value = raw.trim();
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(value))
    fail("invalid exact source cents");
  const [whole, fraction] = value
    .replace(/^-/, "")
    .replace(/,/g, "")
    .split(".");
  const amount = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(amount)) fail("unsafe source cents");
  return value.startsWith("-") ? -amount : amount;
}

/** Full source rows, not IE allocation or current-report proof. Retain unknown
 * source types, signed/zero amounts and identical occurrence multiplicity.
 */
export function decodeFloridaExpenditureDiscoveryTsv(
  raw: string,
): FloridaExpenditureDiscoveryRow[] {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (lines[0] !== FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.join("\t"))
    fail("wrong eight-column TSV schema");
  return lines.slice(1).map((line, occurrence) => {
    const cells = line.split("\t");
    if (
      cells.length !== 8 ||
      cells.some((cell) => /[\x00-\x08\x0b-\x1f\x7f]/.test(cell))
    )
      fail("partial source row");
    if (![cells[0], cells[3], cells[7]].every((cell) => cell.trim()))
      fail("missing source row identity");
    const rawFields = Object.fromEntries(
      FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.map((header, index) => [
        header,
        cells[index],
      ]),
    ) as Record<Header, string>;
    return {
      occurrence,
      payerLabel: cells[0],
      date: civilDate(cells[1]),
      amountCents: cents(cells[2]),
      payeeName: cells[3],
      address: cells[4],
      cityStateZip: cells[5],
      purpose: cells[6],
      sourceType: cells[7],
      rawFields,
    };
  });
}

function query(
  scope: FloridaExpenditureDiscoveryScope,
): FloridaFinanceRawRequest {
  return {
    url: EXPORT_URL,
    method: "POST",
    financeFields: {
      election: scope.electionSelector,
      search_on: "1",
      CanFName: "",
      CanLName: "",
      CanNameSrch: "2",
      office: "All",
      cdistrict: "",
      cgroup: "",
      party: "All",
      ComName: "",
      ComNameSrch: "2",
      committee: "All",
      cfname: "",
      clname: "",
      namesearch: "2",
      ccity: "",
      cstate: "",
      czipcode: "",
      cpurpose: scope.purposePrefix,
      cdollar_minimum: "",
      cdollar_maximum: "",
      rowlimit: String(scope.rowLimit),
      csort1: "DAT",
      csort2: "CAN",
      cdatefrom: "",
      cdateto: "",
      queryformat: "2",
      Submit: "Submit",
    },
  };
}
function sameFields(a: unknown, b: Readonly<Record<string, string>>): boolean {
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const fields = a as Record<string, unknown>;
  return (
    Object.keys(fields).length === Object.keys(b).length &&
    Object.entries(b).every(([key, value]) => fields[key] === value)
  );
}

/** PA-style saved-opening-first acquisition. The raw client's absent cache falls
 * back to live acquisition; refresh bypasses saved data. No money/zero intent.
 * Blank date selectors are intentional: observed dated requests returned errors.
 */
export function createFloridaIndependentExpenditureDiscovery(options: {
  request: FloridaExpenditureDiscoveryRequest;
  refresh?: boolean;
  maxRows?: number;
  maxResponseBytes?: number;
}) {
  const maxRows = options.maxRows ?? 2000;
  const byteCap = options.maxResponseBytes ?? 1024 * 1024;
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 2000 ||
    !Number.isSafeInteger(byteCap) ||
    byteCap < 1 ||
    byteCap > 4 * 1024 * 1024
  )
    fail("invalid acquisition bounds");
  return {
    async load(input: {
      electionSelector: string;
      purposePrefix: string;
      rowLimit?: number;
    }): Promise<FloridaExpenditureDiscoveryResult> {
      // Capture the query before any await or request callback can mutate it.
      const scope = {
        electionSelector: input.electionSelector,
        purposePrefix: input.purposePrefix,
        rowLimit: input.rowLimit ?? maxRows,
      };
      try {
        if (
          !ELECTIONS.has(scope.electionSelector) ||
          typeof scope.purposePrefix !== "string" ||
          !scope.purposePrefix.trim() ||
          scope.purposePrefix !== scope.purposePrefix.trim() ||
          scope.purposePrefix.length > 120 ||
          /[\x00-\x1f\x7f]/.test(scope.purposePrefix) ||
          !Number.isSafeInteger(scope.rowLimit) ||
          scope.rowLimit < 1 ||
          scope.rowLimit > maxRows
        )
          fail("unsupported exact query scope");
        const expected = query(scope);
        // Keep a separate expected request even if an injected transport mutates its input.
        const evidence = structuredClone(
          await options.request(structuredClone(expected), {
            // Discovery has no closing capture; refresh it to find new payers.
            savedFirst: false,
          }),
        );
        if (
          evidence.url !== expected.url ||
          evidence.method !== expected.method ||
          !sameFields(evidence.financeFields, expected.financeFields!) ||
          evidence.status !== 200 ||
          typeof evidence.contentType !== "string" ||
          !/^text\/(?:tab-separated-values|plain)(?:\s*;|$)/i.test(
            evidence.contentType,
          ) ||
          !(evidence.bytesRaw instanceof Uint8Array) ||
          evidence.bytesRaw.length > byteCap ||
          !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
          sha(evidence.bytesRaw) !== evidence.sha256 ||
          !Number.isFinite(Date.parse(evidence.startedAt)) ||
          !Number.isFinite(Date.parse(evidence.completedAt)) ||
          Date.parse(evidence.startedAt) > Date.parse(evidence.completedAt)
        )
          fail("invalid request-bound raw evidence");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          evidence.bytesRaw,
        );
        const rows = decodeFloridaExpenditureDiscoveryTsv(text);
        if (rows.length >= scope.rowLimit)
          fail("row cap reached; discovery incomplete");
        if (
          rows.some(
            (row) =>
              !row.purpose
                .toUpperCase()
                .startsWith(scope.purposePrefix.toUpperCase()),
          )
        )
          fail("source Purpose does not match requested prefix");
        const { bytesRaw, ...metadata } = evidence;
        return {
          status: "discovered",
          authority: "discovery_only",
          scope,
          rows,
          sourceMetadata: { ...metadata, byteCount: bytesRaw.length },
        };
      } catch (error) {
        return {
          status: "preserve",
          diagnostics: [
            error instanceof Error
              ? error.message
              : "Florida discovery unavailable",
          ],
        };
      }
    },
  };
}

import { createHash } from "node:crypto";
import type { FloridaFinanceRawRequest } from "./floridaFinanceRawSourceClient.js";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";

export const FLORIDA_CANDIDATE_ACCOUNT_HEADERS = [
  "AcctNum", "VoterID", "ElectionID", "OfficeCode", "OfficeDesc", "Juris1num",
  "Juris2num", "StatusCode", "StatusDesc", "PartyCode", "PartyDesc", "NameLast",
  "NameFirst", "NameMiddle", "SuppressAddress", "Addr1", "Addr2", "City", "State",
  "Zip", "County", "Phone", "TrsNameLast", "TrsNameFirst", "TrsNameMiddle", "Email",
] as const;

export type FloridaCandidateAccountRow = {
  account: string;
  electionId: string;
  electionYear: number;
  candidateName: string;
  officeCode: string;
  officeName: string;
  jurisdiction1: string;
  jurisdiction2: string;
  statusCode: string;
  statusName: string;
  occurrence: number;
  rawFields: Readonly<Record<typeof FLORIDA_CANDIDATE_ACCOUNT_HEADERS[number], string>>;
};
export type FloridaNativeCandidateAccountRow = {
  account: string;
  surnameFirstName: string;
  officeName: string;
  jurisdiction: string;
  statusName: string;
  primaryResult: string;
  generalResult: string;
  runningMates: readonly { account: string; surnameFirstName: string }[];
  rawCells: readonly string[];
};
export type FloridaCandidateAccountCatalog = {
  electionId: string;
  rows: readonly FloridaCandidateAccountRow[];
  nativeRows: readonly FloridaNativeCandidateAccountRow[];
  sources: readonly FloridaProcessedRawEvidence[];
};
export type FloridaCandidateAccountTarget = {
  candidateId: string;
  candidateName: string;
  electionYear: number;
  electionType: string;
  officeName: string;
  district: string | null;
};
export type FloridaCandidateAccountResolution =
  | { status: "matched"; account: string; officeName: string; district: string | null; row: FloridaCandidateAccountRow }
  | { status: "unmatched" | "ambiguous"; reason: string };

const ORIGIN = "https://dos.elections.myflorida.com";
const MAX_ROWS = 5000; // Application limit, not an asserted official cap.
const display = (value: string): string => value.trim().replace(/\s+/gu, " ");
const exact = (value: string): string => display(value).toUpperCase();
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never {
  throw new Error(`Florida candidate accounts: ${message}`);
}
function publicId(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail("invalid account");
  return value;
}
function electionYear(electionId: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})-GEN$/.exec(electionId);
  if (!match) fail("unsupported election scope");
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) fail("invalid election date");
  return year;
}
function entities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&([a-z]+|#\d+|#x[\da-f]+);/gi, (_, token: string) => {
    if (!token.startsWith("#")) return named[token.toLowerCase()] ?? fail("unknown HTML entity");
    const code = token.toLowerCase().startsWith("#x") ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      fail("invalid HTML entity");
    return String.fromCodePoint(code);
  });
}
const visible = (html: string): string => display(entities(html.replace(/<[^>]*>/g, " ")));
function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const key = match[1]!.toLowerCase();
    if (key in result) fail("duplicate HTML attribute");
    result[key] = entities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

/** Retains every source field. No financial or candidate ownership acceptance. */
export function decodeFloridaCandidateAccountTsv(raw: string, electionId: string): FloridaCandidateAccountRow[] {
  const year = electionYear(electionId);
  if (raw.includes("\0") || /<html|<!doctype/i.test(raw)) fail("invalid TSV body");
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (JSON.stringify(lines.shift()?.split("\t")) !== JSON.stringify(FLORIDA_CANDIDATE_ACCOUNT_HEADERS))
    fail("unexpected TSV header");
  if (!lines.length || lines.length >= MAX_ROWS) fail("empty or bounded catalog");
  const seen = new Set<string>();
  return lines.map((line, occurrence) => {
    const fields = line.split("\t");
    if (fields.length !== FLORIDA_CANDIDATE_ACCOUNT_HEADERS.length) fail("invalid TSV row width");
    const rawFields = Object.fromEntries(FLORIDA_CANDIDATE_ACCOUNT_HEADERS.map((key, index) =>
      [key, fields[index]!])) as FloridaCandidateAccountRow["rawFields"];
    const account = publicId(rawFields.AcctNum);
    if (seen.has(account)) fail("duplicate primary account");
    seen.add(account);
    if (rawFields.ElectionID !== electionId) fail("mixed election catalog");
    if (!rawFields.NameFirst.trim() || !rawFields.NameLast.trim() || !rawFields.OfficeCode.trim() ||
        !rawFields.OfficeDesc.trim() || !rawFields.StatusCode.trim() || !rawFields.StatusDesc.trim())
      fail("missing candidate identity");
    if (!/^[A-Z]{3}$/.test(rawFields.OfficeCode) || !/^[A-Z]{3}$/.test(rawFields.StatusCode) ||
        !["Y", "N"].includes(rawFields.SuppressAddress) ||
        [rawFields.Juris1num, rawFields.Juris2num].some(value => value !== "" && !/^\d{3}$/.test(value)))
      fail("invalid source identity field");
    return {
      account, electionId, electionYear: year, occurrence, rawFields,
      candidateName: display([rawFields.NameFirst, rawFields.NameMiddle, rawFields.NameLast].filter(Boolean).join(" ")),
      officeCode: rawFields.OfficeCode, officeName: display(rawFields.OfficeDesc),
      jurisdiction1: rawFields.Juris1num, jurisdiction2: rawFields.Juris2num,
      statusCode: rawFields.StatusCode, statusName: display(rawFields.StatusDesc),
    };
  });
}

/** ALL status/office/county scope is visible in the returned native form. Running
 * mates remain separate contexts; they are never Governor account aliases. */
export function decodeFloridaNativeCandidateAccountList(html: string, electionId: string): FloridaNativeCandidateAccountRow[] {
  const year = electionYear(electionId);
  if (!/<\/html\s*>/i.test(html) || !/<\/body\s*>/i.test(html) ||
      /access denied|runtime error|<input[^>]+type=["']?password/i.test(html)) fail("incomplete/error HTML");
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  if (![...clean.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].some(match =>
    visible(match[1]!) === `Candidate Listing for ${year} General Election`)) fail("wrong native election heading");
  const forms = [...clean.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
    .filter(match => attributes(match[1]!).name === "CandSelection");
  if (forms.length !== 1) fail("missing native query form");
  const form = forms[0]!;
  if (attributes(form[1]!).action?.toLowerCase() !== "canlist.asp" ||
      attributes(form[1]!).method?.toLowerCase() !== "post") fail("wrong native query form");
  const inputs = [...form[2]!.matchAll(/<input\b([^>]*)>/gi)].map(match => attributes(match[1]!));
  if (inputs.filter(input => input.name === "elecid" && input.value === electionId).length !== 1 ||
      inputs.filter(input => input.name === "CanName" && (input.value ?? "") === "").length !== 1)
    fail("wrong native election/name scope");
  for (const name of ["OfficeGroup", "StatusCode", "OfficeCode", "CountyCode"]) {
    const selects = [...form[2]!.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)]
      .filter(match => attributes(match[1]!).name === name);
    if (selects.length !== 1) fail("missing native scope selector");
    const selected = [...selects[0]![2]!.matchAll(/<option\b([^>]*)>/gi)]
      .filter(match => /(?:^|\s)selected(?:\s|=|$)/i.test(match[1]!));
    if (selected.length !== 1 || attributes(selected[0]![1]!).value !== "ALL") fail("incomplete native catalog scope");
  }
  const result: FloridaNativeCandidateAccountRow[] = [];
  const seen = new Set<string>();
  const tableOpenCount = [...clean.matchAll(/<table\b[^>]*class=["']results["'][^>]*>/gi)].length;
  const tables = [...clean.matchAll(/<table\b[^>]*class=["']results["'][^>]*>([\s\S]*?)<\/table>/gi)];
  if (!tables.length || tables.length !== tableOpenCount) fail("incomplete native result tables");
  for (const table of tables) {
    const headings = [...clean.slice(0, table.index).matchAll(/<br\s*\/?><center><font\b[^>]*><b>([\s\S]*?)<\/b>/gi)];
    const officeName = visible(headings.at(-1)?.[1] ?? "");
    if (!officeName) fail("missing native office heading");
    const rows = [...table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (!rows.length || rows.length !== (table[1]!.match(/<tr\b/gi) ?? []).length) fail("incomplete native rows");
    const headingCells = [...rows[0]![1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => visible(match[1]!));
    const hasJurisdiction = headingCells.length === 5;
    if (JSON.stringify(headingCells.slice(hasJurisdiction ? 1 : 0)) !== JSON.stringify(["Candidate", "Status", "Primary", "General"]))
      fail("unexpected native result columns");
    let jurisdiction = "";
    for (const row of rows.slice(1)) {
      const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]!);
      if (!cells.length && !visible(row[1]!)) continue;
      if (cells.length !== headingCells.length || cells.length !== (row[1]!.match(/<td\b/gi) ?? []).length)
        fail("invalid native row width");
      const offset = hasJurisdiction ? 1 : 0;
      if (hasJurisdiction && visible(cells[0]!)) jurisdiction = visible(cells[0]!);
      if (hasJurisdiction && !jurisdiction) fail("missing inherited jurisdiction");
      const anchors = [...cells[offset]!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
      if (!anchors.length) fail("missing native account link");
      const names = new Map<string, string[]>();
      for (const anchor of anchors) {
        const href = attributes(anchor[1]!).href;
        const match = /^CanDetail\.asp\?account=([1-9]\d*)$/i.exec(href ?? "");
        if (!match) fail("unexpected candidate account link");
        const account = publicId(match[1]!);
        const pieces = names.get(account) ?? [];
        pieces.push(visible(anchor[2]!));
        names.set(account, pieces);
      }
      const [account, primaryName] = [...names][0]!;
      if (seen.has(account)) fail("duplicate native primary account");
      seen.add(account);
      const runningMates = [...names].slice(1).map(([mateAccount, pieces]) => ({
        account: mateAccount, surnameFirstName: display(pieces.join(" ")).replace(/\s+,/g, ","),
      }));
      if (runningMates.length && (officeName !== "Governor" || runningMates.length !== 1 ||
          !visible(cells[offset]!).includes("/"))) fail("unexpected running-mate context");
      result.push({
        account, surnameFirstName: display(primaryName.join(" ")).replace(/\s+,/g, ","),
        officeName, jurisdiction, statusName: visible(cells[offset + 1]!),
        primaryResult: visible(cells[offset + 2]!), generalResult: visible(cells[offset + 3]!),
        runningMates, rawCells: cells.map(visible),
      });
    }
  }
  if (!result.length || result.length >= MAX_ROWS) fail("empty or bounded native catalog");
  return result;
}

export function reconcileFloridaCandidateAccountCatalog(
  rows: readonly FloridaCandidateAccountRow[], nativeRows: readonly FloridaNativeCandidateAccountRow[],
): void {
  if (!rows.length || rows.length !== nativeRows.length) fail("native/export catalog count mismatch");
  const native = new Map(nativeRows.map(row => [row.account, row]));
  if (native.size !== nativeRows.length) fail("duplicate native account");
  for (const row of rows) {
    const match = native.get(row.account);
    const surnameFirstName = `${row.rawFields.NameLast}, ${[row.rawFields.NameFirst, row.rawFields.NameMiddle].filter(Boolean).join(" ")}`;
    const jurisdiction = [row.jurisdiction1, row.jurisdiction2].filter(Boolean).map(value => String(Number(value))).join(" / ");
    if (!match || exact(match.surnameFirstName) !== exact(surnameFirstName) ||
        exact(match.officeName) !== exact(row.officeName) || exact(match.statusName) !== exact(row.statusName) ||
        match.jurisdiction !== jurisdiction) fail(`native/export identity mismatch for account ${row.account}`);
  }
}

const ELIGIBLE_OFFICES: Readonly<Record<string, { sourceName: string; localName: string; district: boolean }>> = {
  STR: { sourceName: "State Representative", localName: "State Lower Chamber Legislator", district: true },
  STS: { sourceName: "State Senator", localName: "State Senator", district: true },
  GOV: { sourceName: "Governor", localName: "Governor", district: false },
  ATG: { sourceName: "Attorney General", localName: "Attorney General", district: false },
  CFO: { sourceName: "Chief Financial Officer", localName: "Chief Financial Officer", district: false },
  AGR: { sourceName: "Commissioner of Agriculture", localName: "Commissioner of Agriculture", district: false },
};

/** Exact full person, office, seat and General election only. Uniqueness is
 * evaluated across all statuses before qualification. No receiving-key inference. */
export function resolveFloridaCandidateAccount(input: {
  rows: readonly FloridaCandidateAccountRow[];
  target: FloridaCandidateAccountTarget;
}): FloridaCandidateAccountResolution {
  const target = input.target;
  if (!target.candidateId || !target.candidateName.trim() || target.electionType.toLowerCase() !== "general" ||
      !Number.isInteger(target.electionYear)) return { status: "unmatched", reason: "unsupported local election identity" };
  const accounts = new Set<string>();
  for (const row of input.rows) {
    if (accounts.has(row.account)) return { status: "ambiguous", reason: "duplicate source account" };
    accounts.add(row.account);
  }
  const matches = input.rows.filter(row => {
    const office = ELIGIBLE_OFFICES[row.officeCode];
    if (!office || exact(row.officeName) !== exact(office.sourceName) || exact(target.officeName) !== exact(office.localName))
      return false;
    if (row.electionYear !== target.electionYear || exact(row.candidateName) !== exact(target.candidateName)) return false;
    if (office.district) return /^[1-9]\d*$/.test(target.district ?? "") && row.jurisdiction2 === "" &&
      Number(row.jurisdiction1) === Number(target.district) && Number(row.jurisdiction1) > 0 &&
      Number(row.jurisdiction1) <= (row.officeCode === "STR" ? 120 : 40);
    return target.district === null && row.jurisdiction1 === "" && row.jurisdiction2 === "";
  });
  if (matches.length > 1) return { status: "ambiguous", reason: "multiple exact all-status accounts" };
  const row = matches[0];
  if (!row) return { status: "unmatched", reason: "no exact eligible candidate account" };
  if (!((row.statusCode === "QUA" && exact(row.statusName) === "QUALIFIED") ||
        (row.statusCode === "UNO" && exact(row.statusName) === "UNOPPOSED")))
    return { status: "unmatched", reason: "candidate is not qualified or unopposed" };
  return { status: "matched", account: row.account, officeName: row.officeName,
    district: ELIGIBLE_OFFICES[row.officeCode]!.district ? String(Number(row.jurisdiction1)) : null, row };
}

function checkedRaw(raw: FloridaProcessedRawEvidence, request: FloridaFinanceRawRequest): string {
  const entries = (fields: Readonly<Record<string, string>> | null) => fields === null ? null : Object.entries(fields).sort();
  if (!(raw.bytesRaw instanceof Uint8Array) || !raw.bytesRaw.length || raw.bytesRaw.length > 4 * 1024 * 1024 ||
      raw.status !== 200 || raw.url !== request.url || raw.method !== request.method ||
      JSON.stringify(entries(raw.financeFields)) !== JSON.stringify(entries(request.financeFields)) ||
      sha(raw.bytesRaw) !== raw.sha256 || !/^[a-f0-9]{64}$/.test(raw.sha256)) fail("invalid request-bound raw source");
  const start = Date.parse(raw.startedAt), end = Date.parse(raw.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) fail("invalid source capture interval");
  const expectedType = request.url.endsWith("extractCanList.asp") ? "tab-separated-values" : "text/html";
  if (!raw.contentType.toLowerCase().includes(expectedType)) fail("unexpected source content type");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw.bytesRaw); }
  catch { return fail("unsupported source encoding"); }
}

export function createFloridaCandidateAccountSource(options: {
  requestRaw: (request: FloridaFinanceRawRequest, input?: { savedFirst?: boolean }) => Promise<FloridaProcessedRawEvidence>;
}) {
  return {
    async fetchCatalog(input: { electionId: string; savedFirst?: boolean }): Promise<FloridaCandidateAccountCatalog> {
      electionYear(input.electionId);
      const listRequest: FloridaFinanceRawRequest = {
        url: `${ORIGIN}/candidates/canlist.asp`, method: "POST",
        financeFields: { elecid: input.electionId, OfficeGroup: "ALL", StatusCode: "ALL", OfficeCode: "ALL",
          CountyCode: "ALL", CanName: "", OrderBy: "NAM", FormsButton1: "RUN QUERY" },
      };
      const exportRequest: FloridaFinanceRawRequest = {
        url: `${ORIGIN}/candidates/extractCanList.asp`, method: "POST",
        financeFields: { elecID: input.electionId, office: "All", status: "All", cantype: "STA",
          FormSubmit: "Download Candidate List" },
      };
      const nativeRaw = await options.requestRaw(listRequest, { savedFirst: input.savedFirst });
      const nativeRows = decodeFloridaNativeCandidateAccountList(checkedRaw(nativeRaw, listRequest), input.electionId);
      const exportRaw = await options.requestRaw(exportRequest, { savedFirst: input.savedFirst });
      const rows = decodeFloridaCandidateAccountTsv(checkedRaw(exportRaw, exportRequest), input.electionId);
      reconcileFloridaCandidateAccountCatalog(rows, nativeRows);
      return { electionId: input.electionId, rows, nativeRows, sources: [nativeRaw, exportRaw] };
    },
  };
}

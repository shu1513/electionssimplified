import { createHash } from "node:crypto";

const RESULT_COLUMNS = ["Candidate Name", "Party Name", "Machine Votes", "Absentee Votes",
  "Early Voting Votes", "Total Votes", "Percentage"];
const STATEWIDE_SINGLE_SEAT_OFFICES = new Set(["Attorney General", "Governor", "Lieutenant Governor",
  "Auditor of Accounts", "State Treasurer", "Insurance Commissioner", "Representative in Congress", "U.S. Senator"]);
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
function fail(message: string): never { throw new Error("Delaware official election facts: " + message); }
function text(html: string): string {
  return clean(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value))));
}
function source(bytes: Uint8Array) {
  const body = Buffer.from(bytes);
  if (!body.length || body.length > 64 * 1024 * 1024) fail("source size");
  return { html: new TextDecoder("utf-8", { fatal: true }).decode(body),
    sha256: createHash("sha256").update(body).digest("hex"), byteCount: body.length };
}
function unique<T>(items: T[], label: string): T {
  if (items.length !== 1) fail("missing/ambiguous " + label);
  return items[0]!;
}
function civil(year: number, day: string) {
  const iso = `${year}-11-${day.padStart(2, "0")}`;
  const milliseconds = Date.parse(iso + "T00:00:00Z");
  if (!Number.isSafeInteger(year) || year < 1900 || year > 2100 || !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== iso) fail("election date");
  return iso;
}
function cells(row: string, kind: "th" | "td"): { value: string; label: string | null }[] {
  return [...row.matchAll(new RegExp(`<${kind}\\b([^>]*)>([\\s\\S]*?)<\\/${kind}>`, "gi"))].map(match => ({
    value: text(match[2]!), label: /\bdata-label=["']([^"']+)["']/i.exec(match[1]!)?.[1] ?? null,
  }));
}
function votes(value: string) {
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) fail("vote count");
  const count = Number(value.replace(/,/g, ""));
  if (!Number.isSafeInteger(count)) fail("unsafe vote count");
  return count;
}

/** Published statewide single-seat election facts only; no committee or finance authority. */
export function parseDelawareOfficialStatewideGeneralResult(input: {
  bytes: Uint8Array; electionYear: number; officeName: string;
}) {
  const { html, sha256, byteCount } = source(input.bytes);
  const officeName = clean(input.officeName);
  if (!STATEWIDE_SINGLE_SEAT_OFFICES.has(officeName)) fail("unsupported statewide single-seat office");
  unique([...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .filter(match => text(match[1]!) === `${input.electionYear} General Election Report`), "result title");
  const status = unique([...html.matchAll(/<span\b[^>]*class=["']resultsType["'][^>]*>([\s\S]*?)<\/span>/gi)], "result status");
  if (text(status[1]!) !== "OFFICIAL RESULTS") fail("unofficial result");
  const heading = unique([...html.matchAll(/<h2\b[^>]*class=["']electionDate["'][^>]*>([\s\S]*?)<\/h2>/gi)], "result date");
  const date = /^November (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/.exec(text(heading[1]!));
  if (!date || Number(date[2]) !== input.electionYear) fail("result year/date");
  const electionDate = civil(input.electionYear, date[1]!);
  const section = unique([...html.matchAll(/<div\b[^>]*\bid=["']statewide["'][^>]*>([\s\S]*?)<\/div>/gi)], "statewide section")[1]!;
  const contests = [...section.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>\s*<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
    .filter(match => text(match[1]!) === officeName);
  const table = unique(contests, "statewide contest")[2]!;
  const header = unique([...table.matchAll(/<thead\b[^>]*>([\s\S]*?)<\/thead>/gi)], "result columns");
  if (JSON.stringify(cells(header[1]!, "th").map(cell => cell.value)) !== JSON.stringify(RESULT_COLUMNS)) fail("result column drift");
  const body = unique([...table.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)], "result rows");
  const candidates = [...body[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => {
    const row = cells(match[1]!, "td");
    if (row.length !== 7 || row.some((cell, index) => cell.label !== RESULT_COLUMNS[index])) fail("result row column drift");
    const [name, party, machine, absentee, early, total, percentage] = row.map(cell => cell.value);
    if (!name || !party || !/^\d+(?:\.\d+)?$/.test(percentage!) || Number(percentage) > 100) fail("result row identity");
    const machineVotes = votes(machine!), absenteeVotes = votes(absentee!), earlyVotes = votes(early!), totalVotes = votes(total!);
    if (!Number.isSafeInteger(machineVotes + absenteeVotes + earlyVotes) ||
      machineVotes + absenteeVotes + earlyVotes !== totalVotes) fail("result vote components disagree");
    return { candidateName: name!, party: party!, machineVotes, absenteeVotes, earlyVotes, totalVotes, percentage: percentage! };
  });
  if (candidates.length < 2 || new Set(candidates.map(row => row.candidateName)).size !== candidates.length) fail("incomplete/duplicate result candidates");
  const maximum = Math.max(...candidates.map(row => row.totalVotes));
  if (maximum === 0) fail("empty election result");
  const winner = unique(candidates.filter(row => row.totalVotes === maximum), "single-seat plurality");
  return { sha256, byteCount, electionYear: input.electionYear, electionDate, officeName, candidates, winner };
}

/** Official sample-ballot facts; a ballot does not prove committee ownership or incumbency. */
export function parseDelawareOfficialGeneralBallot(input: {
  bytes: Uint8Array; electionYear: number; officeName: string;
}) {
  const { html, sha256, byteCount } = source(input.bytes);
  const officeName = clean(input.officeName);
  if (!officeName) fail("office");
  unique([...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].filter(match => text(match[1]!) === "Sample Ballot"), "ballot title");
  const date = unique([...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(match => /^November (\d{1,2}), (\d{4}) General Election$/.exec(text(match[1]!)))
    .filter((match): match is RegExpExecArray => match !== null), "ballot election date");
  if (Number(date[2]) !== input.electionYear) fail("ballot year");
  const electionDate = civil(input.electionYear, date[1]!);
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].filter(match =>
    [...match[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .some(row => cells(row[1]!, "td")[0]?.value === officeName));
  const table = unique(tables, "ballot contest")[1]!;
  const columns = cells(unique([...table.matchAll(/<thead\b[^>]*>([\s\S]*?)<\/thead>/gi)], "ballot columns")[1]!, "th").map(cell => cell.value);
  if (columns.length < 4 || columns[0] !== "Race" || columns[1] !== "Instruction" || columns.at(-1) !== "Write-in" ||
    new Set(columns).size !== columns.length || columns.slice(2, -1).some(party => !party.endsWith(" Party") && party !== "Independent Party of Delaware")) fail("ballot column drift");
  const rows = [...unique([...table.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)], "ballot rows")[1]!
    .matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const row = cells(unique(rows, "single-seat ballot row")[1]!, "td");
  if (row.length !== columns.length || row.some((cell, index) => cell.label !== columns[index]) ||
    row[0]!.value !== officeName || row[1]!.value !== "Vote for 1" || row.at(-1)!.value !== "Write-in") fail("ballot row column drift");
  const candidates = row.slice(2, -1).flatMap((cell, index) => cell.value ? [{ party: columns[index + 2]!, candidateName: cell.value }] : []);
  if (!candidates.length || new Set(candidates.map(candidate => candidate.candidateName)).size !== candidates.length) fail("missing/duplicate ballot candidates");
  return { sha256, byteCount, electionYear: input.electionYear, electionDate, officeName, candidates };
}

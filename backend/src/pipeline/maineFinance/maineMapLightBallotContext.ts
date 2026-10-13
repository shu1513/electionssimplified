import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import XLSX from "xlsx";

export const MAINE_MAPLIGHT_BALLOT_PAGE_URL =
  "https://www11.maine.gov/sos/elections-voting/upcoming-elections";
const workbookBase =
  "https://www.maine.gov/sos/sites/maine.gov.sos/files/inline-files/";
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const norm = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
function fail(): never {
  throw new Error("Maine official general ballot source is unavailable");
}
function scope(year: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail();
}
function civil(year: number, month: number, day: number) {
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    fail();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function safeText(value: unknown, blank = false): string {
  if (
    typeof value !== "string" ||
    (!blank && !value.trim()) ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.length > 300
  )
    fail();
  return value;
}
function workbookUrl(raw: string, year: number): string {
  let u: URL;
  try {
    u = new URL(raw, MAINE_MAPLIGHT_BALLOT_PAGE_URL);
  } catch {
    fail();
  }
  if (
    u.origin !== "https://www.maine.gov" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    u.pathname !==
      new URL(`${workbookBase}${year} General Candidate List - FINAL.xlsx`)
        .pathname
  )
    fail();
  return u.href;
}
/** Selects a published link, not a fabricated filename or redirect. */
export function decodeMaineMapLightGeneralBallotLink(
  html: string,
  input: { year: number },
): string {
  scope(input.year);
  if (
    typeof html !== "string" ||
    html.length > 2 * 1024 * 1024 ||
    !/<\/html\s*>\s*$/i.test(html) ||
    !/<title>Upcoming Elections \| SOS<\/title>/i.test(html)
  )
    fail();
  const canonical = [
    ...html.matchAll(
      /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    ),
  ];
  if (
    canonical.length !== 1 ||
    canonical[0][1] !== MAINE_MAPLIGHT_BALLOT_PAGE_URL
  )
    fail();
  const urls = new Set<string>();
  for (const match of html.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi,
  )) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (!decoded.includes(`${input.year} General Candidate List - FINAL.xlsx`))
      continue;
    urls.add(workbookUrl(match[1], input.year));
  }
  if (urls.size !== 1) fail();
  return [...urls][0];
}
export interface MaineMapLightBallotRow {
  rowNumber: number;
  year: number;
  electionDate: string;
  officeCode: string;
  district: string;
  county: string;
  party: string;
  dateFiledRaw: string;
  firstName: string;
  middleName: string;
  lastName: string;
  suffix: string;
}
export interface MaineMapLightGeneralBallot {
  year: number;
  electionDate: string;
  rows: readonly MaineMapLightBallotRow[];
}
const headers = [
  "Office",
  "Dist",
  "County",
  "Party",
  "Date Filed",
  "Last Name",
  "First Name",
  "Middle Name",
  "Suffix",
  "Residence Municipality",
];
/** The actual workbook has ten named columns and five unused blank columns. Contacts are not output. */
export function decodeMaineMapLightGeneralBallotWorkbook(
  bytes: Uint8Array,
  input: { year: number },
): MaineMapLightGeneralBallot {
  scope(input.year);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 4 ||
    bytes.length > 8 * 1024 * 1024 ||
    bytes[0] !== 80 ||
    bytes[1] !== 75
  )
    fail();
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: false });
  } catch {
    fail();
  }
  if (book.SheetNames.length !== 1) fail();
  const title = book.SheetNames[0],
    m = /^November ([1-9]\d?), (20\d{2})$/.exec(title);
  if (!m || Number(m[2]) !== input.year) fail();
  const electionDate = civil(input.year, 11, Number(m[1]));
  if (input.year === 2026 && electionDate !== "2026-11-03") fail();
  // This is a General list published by SOS; compare its actual date with the local election later.
  const sheet = book.Sheets[title];
  if (!sheet || !sheet["!ref"] || sheet["!merges"]?.length) fail();
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (
    range.s.r !== 0 ||
    range.s.c !== 0 ||
    range.e.c !== 14 ||
    range.e.r > 10000
  )
    fail();
  for (const [key, value] of Object.entries(sheet)) {
    if (!key.startsWith("!") && (value as XLSX.CellObject).f) fail();
  }
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });
  if (
    !raw.length ||
    raw[0].length !== 15 ||
    headers.some((h, i) => raw[0][i] !== h) ||
    raw[0].slice(10).some((v) => v !== "")
  )
    fail();
  const rows: MaineMapLightBallotRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i];
    if (cells.every((v) => v === "")) continue;
    if (cells.length !== 15 || cells.slice(10).some((v) => v !== "")) fail();
    const c = cells.map((v) => safeText(v, true));
    if (!c[0].trim() || !c[5].trim() || !c[6].trim()) fail();
    if (!/^[A-Z]{2,3}\s?$/.test(c[0])) fail();
    // Register-of-deeds rows publish N/S. Only supported legislative seats must be numeric.
    if (["SS", "SR"].includes(c[0]) && !/^[1-9]\d{0,2}$/.test(c[1])) fail();
    const filed = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(c[4]);
    if (!filed) fail();
    civil(2000 + Number(filed[3]), Number(filed[1]), Number(filed[2]));
    rows.push({
      rowNumber: i + 1,
      year: input.year,
      electionDate,
      officeCode: c[0],
      district: c[1],
      county: c[2],
      party: c[3],
      dateFiledRaw: c[4],
      lastName: c[5],
      firstName: c[6],
      middleName: c[7],
      suffix: c[8],
    });
  }
  if (!rows.length) fail();
  return { year: input.year, electionDate, rows };
}
export interface MaineMapLightLocalBallotCandidate {
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
  party?: string | null;
  officeScope?: string;
  officeName: string;
  district: string | null;
  electionYear: number;
  electionDate: string;
}
export interface MaineMapLightSourceBallotCandidate {
  filerId: string;
  filerName: string;
  firstName: string;
  lastName: string;
  middleName?: string | null;
  suffix?: string | null;
  office: string;
  district: string;
}
// The official 2026 Candidate Office Order confirms SS/SR. GOV in the workbook
// differs from GV in that key and is intentionally unqualified here.
// https://www.maine.gov/sos/sites/maine.gov.sos/files/inline-files/2026%20Candidate%20Office%20Order.pdf
function localCode(name: string): "SS" | "SR" | null {
  const n = norm(name);
  if (["STATE UPPER CHAMBER LEGISLATOR", "STATE SENATOR"].includes(n))
    return "SS";
  if (["STATE LOWER CHAMBER LEGISLATOR", "STATE REPRESENTATIVE"].includes(n))
    return "SR";
  return null;
}
function sourceCode(name: string): "SS" | "SR" | null {
  const n = norm(name);
  return n === "SENATOR" ? "SS" : n === "REPRESENTATIVE" ? "SR" : null;
}
export function qualifyMaineMapLightBallotContext(input: {
  rows: readonly MaineMapLightBallotRow[];
  candidate: MaineMapLightLocalBallotCandidate;
  source: MaineMapLightSourceBallotCandidate;
}): {
  context?: {
    version: 1;
    candidate: MaineMapLightLocalBallotCandidate;
    source: MaineMapLightSourceBallotCandidate;
    ballot: MaineMapLightBallotRow;
    nameQualification:
      "exact_structured" | "structured_context_middle_unavailable";
  };
  diagnostics: readonly string[];
} {
  const omitted = (diagnostic: string) => ({ diagnostics: [diagnostic] });
  const c = input.candidate,
    s = input.source;
  if (
    !c ||
    !s ||
    !Array.isArray(input.rows) ||
    !c.firstName?.trim() ||
    !c.lastName?.trim() ||
    !s.firstName?.trim() ||
    !s.lastName?.trim() ||
    !/^f_[a-z0-9]{26}$/.test(s.filerId) ||
    !s.filerName?.trim()
  )
    return omitted("Ballot identity is unavailable");
  const office = localCode(c.officeName);
  if (
    !office ||
    office !== sourceCode(s.office) ||
    !c.district ||
    c.district !== s.district ||
    (c.officeScope !== undefined &&
      norm(c.officeScope) !== (office === "SS" ? "STATE_UPPER" : "STATE_LOWER"))
  )
    return omitted("Ballot office or district is unsupported or inconsistent");
  if (
    norm(c.firstName) !== norm(s.firstName) ||
    norm(c.lastName) !== norm(s.lastName)
  )
    return omitted("Ballot reported and local person identities differ");
  const matches = input.rows.filter(
    (r) =>
      norm(r.firstName) === norm(s.firstName) &&
      norm(r.lastName) === norm(s.lastName) &&
      r.officeCode === office &&
      r.district === s.district &&
      r.year === c.electionYear &&
      r.electionDate === c.electionDate,
  );
  // Unique full context precedes party filtering; do not select a favorable party/name edition.
  if (matches.length !== 1)
    return omitted(
      "Ballot person/office/seat/date context is missing or ambiguous",
    );
  const row = matches[0];
  const party = c.party
    ? (
        { DEMOCRATIC: "D", D: "D", REPUBLICAN: "R", R: "R" } as Record<
          string,
          string
        >
      )[norm(c.party)]
    : undefined;
  if (c.party && (!party || row.party !== party))
    return omitted("Known local party conflicts with the official ballot");
  const sourceDisplay = [
    s.firstName,
    s.middleName?.trim(),
    s.lastName,
    s.suffix?.trim(),
  ]
    .filter(Boolean)
    .join(" ");
  if (norm(s.filerName) !== norm(sourceDisplay))
    return omitted(
      "Reported filer name does not match its full structured person identity",
    );
  // Missing/blank middle fields are unknown. All actual ballot tokens remain in the context.
  // Exact first/last, source display, unique office/seat/year/date and known party bind this context;
  // no middle token is removed from a supplied name and no person receives a special exception.
  const middles = [c.middleName, s.middleName].filter(
    (v): v is string => typeof v === "string" && !!v.trim(),
  );
  if (middles.some((v) => norm(v) !== norm(row.middleName)))
    return omitted("Known middle name conflicts with the official ballot");
  const suffixes = [c.suffix, s.suffix].filter(
    (v): v is string => v !== undefined && v !== null,
  );
  if (
    suffixes.some((v) => norm(v) !== norm(row.suffix)) ||
    (row.suffix && !suffixes.some((v) => norm(v) === norm(row.suffix)))
  )
    return omitted("Ballot suffix lacks exact structured qualification");
  return {
    context: {
      version: 1,
      candidate: {
        firstName: c.firstName,
        middleName: c.middleName,
        lastName: c.lastName,
        suffix: c.suffix,
        party: c.party,
        officeScope: c.officeScope,
        officeName: c.officeName,
        district: c.district,
        electionYear: c.electionYear,
        electionDate: c.electionDate,
      },
      source: {
        filerId: s.filerId,
        filerName: s.filerName,
        firstName: s.firstName,
        lastName: s.lastName,
        middleName: s.middleName,
        suffix: s.suffix,
        office: s.office,
        district: s.district,
      },
      ballot: { ...row },
      nameQualification:
        row.middleName && !middles.length
          ? "structured_context_middle_unavailable"
          : "exact_structured",
    },
    diagnostics: [],
  };
}

type Artifact = {
  file: string;
  url: string;
  startedAt: string;
  completedAt: string;
  status: 200;
  bytes: number;
  sha256: string;
};
function projectArtifact(a: Artifact): Artifact {
  return {
    file: a.file,
    url: a.url,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    status: a.status,
    bytes: a.bytes,
    sha256: a.sha256,
  };
}
function projectManifest(m: Manifest): Manifest {
  return {
    version: 1,
    year: m.year,
    page: projectArtifact(m.page),
    workbook: projectArtifact(m.workbook),
    closingPage: projectArtifact(m.closingPage),
    closingWorkbook: projectArtifact(m.closingWorkbook),
  };
}
type Manifest = {
  version: 1;
  year: number;
  page: Artifact;
  workbook: Artifact;
  closingPage: Artifact;
  closingWorkbook: Artifact;
};
export type MaineMapLightBallotAcquisitionResult =
  | ({
      status: "available";
      sourceUrl: string;
      captureDigest: string;
      observedAt: string;
      directory: string;
      source: Manifest;
    } & MaineMapLightGeneralBallot)
  | {
      status: "unavailable";
      diagnostic: string;
      previousCacheVerified: boolean;
    };
/** Raw flags must explicitly set cacheOnly=false. Saved originals never receive new HTTP times. */
export async function acquireMaineMapLightBallot(input: {
  cacheDir: string;
  year: number;
  refresh?: boolean;
  cacheOnly?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<MaineMapLightBallotAcquisitionResult> {
  const { cacheDir, year } = input;
  const cacheOnly = input.cacheOnly !== false;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeout = input.timeoutMs ?? 30000;
  const max = input.maxBytes ?? 8 * 1024 * 1024;
  scope(year);
  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 8 * 1024 * 1024 ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  )
    fail();
  const pointerPath = join(cacheDir, `current-${year}.json`);
  let saved:
    | Extract<MaineMapLightBallotAcquisitionResult, { status: "available" }>
    | undefined;
  const decode = (bytes: Buffer) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail();
    }
  };
  async function body(dir: string, a: Artifact, file: string, url: string) {
    if (
      !a ||
      a.file !== file ||
      a.url !== url ||
      a.status !== 200 ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 1 ||
      a.bytes > max ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !Number.isFinite(Date.parse(a.startedAt)) ||
      !Number.isFinite(Date.parse(a.completedAt)) ||
      Date.parse(a.completedAt) < Date.parse(a.startedAt)
    )
      fail();
    const bytes = await readFile(join(dir, file));
    if (bytes.length !== a.bytes || sha(bytes) !== a.sha256) fail();
    return bytes;
  }
  try {
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    if (
      pointer.version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(pointer.generation) ||
      !/^[a-f0-9]{64}$/.test(pointer.sha256)
    )
      fail();
    const directory = join(cacheDir, pointer.generation),
      raw = await readFile(join(directory, "manifest.json"));
    if (sha(raw) !== pointer.sha256) fail();
    const m: Manifest = JSON.parse(raw.toString("utf8"));
    if (m.version !== 1 || m.year !== year) fail();
    const url = decodeMaineMapLightGeneralBallotLink(
      decode(
        await body(
          directory,
          m.page,
          "page.html",
          MAINE_MAPLIGHT_BALLOT_PAGE_URL,
        ),
      ),
      { year },
    );
    const before = await body(directory, m.workbook, "workbook.xlsx", url);
    const ballot = decodeMaineMapLightGeneralBallotWorkbook(before, { year });
    if (
      decodeMaineMapLightGeneralBallotLink(
        decode(
          await body(
            directory,
            m.closingPage,
            "closing-page.html",
            MAINE_MAPLIGHT_BALLOT_PAGE_URL,
          ),
        ),
        { year },
      ) !== url
    )
      fail();
    const after = await body(
      directory,
      m.closingWorkbook,
      "closing-workbook.xlsx",
      url,
    );
    if (sha(before) !== sha(after)) fail();
    if (
      Date.parse(m.workbook.startedAt) < Date.parse(m.page.completedAt) ||
      Date.parse(m.closingPage.startedAt) <
        Date.parse(m.workbook.completedAt) ||
      Date.parse(m.closingWorkbook.startedAt) <
        Date.parse(m.closingPage.completedAt)
    )
      fail();
    saved = {
      status: "available",
      ...ballot,
      sourceUrl: url,
      captureDigest: sha(raw),
      observedAt: m.closingWorkbook.completedAt,
      directory,
      source: projectManifest(m),
    };
  } catch {
    /* Invalid legacy or corrupt cache establishes no ballot authority. */
  }
  if (cacheOnly)
    return (
      saved ?? {
        status: "unavailable",
        previousCacheVerified: false,
        diagnostic:
          "Maine saved official ballot is unavailable; preserve financial components",
      }
    );
  const generation = randomUUID(),
    directory = join(cacheDir, generation);
  const tmp = join(cacheDir, `${generation}.pointer.json`);
  let createdDirectory = false;
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    createdDirectory = true;
    async function request(
      url: string,
      file: string,
    ): Promise<{ artifact: Artifact; bytes: Buffer }> {
      const startedAt = new Date().toISOString(),
        controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: {
            "User-Agent": "Mozilla/5.0 VoteApp public finance acquisition",
          },
          signal: controller.signal,
        });
        if (response.status !== 200 || !response.body) fail();
        const reader = response.body.getReader(),
          parts: Buffer[] = [];
        let count = 0;
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            count += r.value.byteLength;
            if (count > max) {
              await reader.cancel();
              fail();
            }
            parts.push(Buffer.from(r.value));
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = Buffer.concat(parts);
        if (!bytes.length) fail();
        const artifact: Artifact = {
          file,
          url,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 200,
          bytes: bytes.length,
          sha256: sha(bytes),
        };
        await writeFile(join(directory, file), bytes, {
          mode: 0o600,
          flag: "wx",
        });
        return { artifact, bytes };
      } finally {
        clearTimeout(timer);
      }
    }
    const page = await request(MAINE_MAPLIGHT_BALLOT_PAGE_URL, "page.html");
    const url = decodeMaineMapLightGeneralBallotLink(decode(page.bytes), {
      year,
    });
    const book = await request(url, "workbook.xlsx");
    const ballot = decodeMaineMapLightGeneralBallotWorkbook(book.bytes, {
      year,
    });
    const closingPage = await request(
      MAINE_MAPLIGHT_BALLOT_PAGE_URL,
      "closing-page.html",
    );
    if (
      decodeMaineMapLightGeneralBallotLink(decode(closingPage.bytes), {
        year,
      }) !== url
    )
      fail();
    const closingBook = await request(url, "closing-workbook.xlsx");
    if (sha(book.bytes) !== sha(closingBook.bytes)) fail();
    const source: Manifest = {
      version: 1,
      year,
      page: page.artifact,
      workbook: book.artifact,
      closingPage: closingPage.artifact,
      closingWorkbook: closingBook.artifact,
    };
    const raw = JSON.stringify(source, null, 2) + "\n",
      captureDigest = sha(raw);
    await writeFile(join(directory, "manifest.json"), raw, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      tmp,
      JSON.stringify({ version: 1, generation, sha256: captureDigest }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(tmp, pointerPath);
    return {
      status: "available",
      ...ballot,
      sourceUrl: url,
      captureDigest,
      observedAt: closingBook.artifact.completedAt,
      directory,
      source,
    };
  } catch {
    if (createdDirectory) {
      await rm(tmp, { force: true }).catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    return {
      status: "unavailable",
      previousCacheVerified: saved !== undefined,
      diagnostic:
        "Maine official ballot acquisition is unavailable; preserve financial components",
    };
  }
}

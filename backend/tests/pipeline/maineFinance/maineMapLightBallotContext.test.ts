import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import XLSX from "xlsx";
import {
  MAINE_MAPLIGHT_BALLOT_PAGE_URL as PAGE,
  decodeMaineMapLightGeneralBallotLink as link,
  decodeMaineMapLightGeneralBallotWorkbook as decode,
  qualifyMaineMapLightBallotContext as qualify,
  acquireMaineMapLightBallot as acquire,
  type MaineMapLightBallotAcquisitionResult,
} from "../../../src/pipeline/maineFinance/maineMapLightBallotContext.js";
const URL =
  "https://www.maine.gov/sos/sites/maine.gov.sos/files/inline-files/2026%20General%20Candidate%20List%20-%20FINAL.xlsx";
const html = `<!DOCTYPE html><html><head><title>Upcoming Elections | SOS</title><link rel="canonical" href="${PAGE}" /></head><body><h2>November 3, 2026 General Election</h2><a href="${URL.replaceAll("%20", " ")}">2026 General Election Candidates Lis</a></body></html>`;
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
  "",
  "",
  "",
  "",
  "",
];
const hickman = [
  "SS",
  "14",
  "",
  "D",
  "3/5/26",
  "Hickman",
  "Craig",
  "V.",
  "",
  "PRIVATE_MUNICIPALITY",
  "",
  "",
  "",
  "",
  "",
];
function workbook(
  rows: unknown[][] = [hickman],
  sheetName = "November 3, 2026",
  change?: (s: XLSX.WorkSheet) => void,
) {
  const book = XLSX.utils.book_new(),
    s = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  change?.(s);
  XLSX.utils.book_append_sheet(book, s, sheetName);
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}
const source = {
  filerId: `f_${"a".repeat(26)}`,
  filerName: "Craig Hickman",
  firstName: "Craig",
  lastName: "Hickman",
  office: "Senator",
  district: "14",
};
const candidate = {
  firstName: "Craig",
  lastName: "Hickman",
  party: "Democratic",
  officeScope: "state_upper",
  officeName: "State Upper Chamber Legislator",
  district: "14",
  electionYear: 2026,
  electionDate: "2026-11-03",
};
function input() {
  return {
    rows: decode(workbook(), { year: 2026 }).rows,
    candidate: { ...candidate },
    source: { ...source },
  };
}
const dirs: string[] = [];
async function temp() {
  const d = await mkdtemp(join(tmpdir(), "maine-ballot-test-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});
function available(r: MaineMapLightBallotAcquisitionResult) {
  expect(r.status).toBe("available");
  if (r.status !== "available") throw new Error("Expected ballot source");
  return r;
}
function network(
  options: {
    override?: (url: string, index: number) => Response | undefined;
  } = {},
) {
  let call = 0;
  const bytes = workbook();
  return vi.fn(async (u: RequestInfo | URL) => {
    const url = String(u);
    call++;
    const r = options.override?.(url, call);
    if (r) return r;
    if (url === PAGE) return new Response(html);
    if (url === URL) return new Response(bytes);
    throw new Error("SECRET arbitrary source route");
  }) as ReturnType<typeof vi.fn> & typeof fetch;
}
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

describe("Maine official General ballot source facts", () => {
  it("discovers the actual literal-space href and retains all safe structured identity fields", () => {
    expect(link(html, { year: 2026 })).toBe(URL);
    const result = decode(workbook(), { year: 2026 });
    expect(result.year).toBe(2026);
    expect(result.electionDate).toBe("2026-11-03");
    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        year: 2026,
        electionDate: "2026-11-03",
        officeCode: "SS",
        district: "14",
        county: "",
        party: "D",
        dateFiledRaw: "3/5/26",
        lastName: "Hickman",
        firstName: "Craig",
        middleName: "V.",
        suffix: "",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_MUNICIPALITY");
  });
  it("retains competing contexts, all unknown offices and wholly blank formatted rows without inventing candidates", () => {
    const gov = [...hickman];
    gov[0] = "GOV";
    gov[1] = "";
    gov[5] = "Example";
    const jp = [...hickman];
    jp[0] = "JP ";
    const result = decode(workbook([hickman, gov, jp, Array(15).fill("")]), {
      year: 2026,
    });
    expect(result.rows.map((r) => r.officeCode)).toEqual(["SS", "GOV", "JP "]);
  });
  it.each([
    html.replace(URL.replaceAll("%20", " "), URL + "?token=SECRET"),
    html.replace("www.maine.gov", "private.invalid"),
    html.replace(PAGE, "https://private.invalid/page"),
    html.replace("</html>", ""),
    "<html><title>Login</title></html>",
  ])(
    "rejects wrong-host/query/incomplete/non-source HTML without echoing values %#",
    (body) => {
      expect(() => link(body, { year: 2026 })).toThrow(
        "Maine official general ballot source is unavailable",
      );
    },
  );
  it("does not synthesize a missing year link", () => {
    expect(() => link(html, { year: 2025 })).toThrow();
    expect(() =>
      link(
        html.replace(
          "Candidate List - FINAL.xlsx",
          "Candidate List - DRAFT.xlsx",
        ),
        { year: 2026 },
      ),
    ).toThrow();
  });
  it.each([
    "November 4, 2026",
    "November 31, 2026",
    "November 3, 2025",
    "June 9, 2026",
  ])("rejects incompatible actual sheet date %s", (sheet) => {
    expect(() => decode(workbook([hickman], sheet), { year: 2026 })).toThrow();
  });
  it("rejects multiple sheets, altered header, unexpected columns, merged identity cells and formulas", () => {
    const b = XLSX.read(workbook(), { type: "buffer" });
    XLSX.utils.book_append_sheet(
      b,
      XLSX.utils.aoa_to_sheet([["other"]]),
      "Other",
    );
    expect(() =>
      decode(XLSX.write(b, { type: "buffer", bookType: "xlsx" }), {
        year: 2026,
      }),
    ).toThrow();
    for (const change of [
      (s: XLSX.WorkSheet) => {
        s.A1.v = "Wrong";
      },
      (s: XLSX.WorkSheet) => {
        s.K2.v = "UNKNOWN_COLUMN";
      },
      (s: XLSX.WorkSheet) => {
        s["!merges"] = [{ s: { r: 1, c: 5 }, e: { r: 1, c: 6 } }];
      },
      (s: XLSX.WorkSheet) => {
        s.G2.f = '"Craig"';
      },
    ])
      expect(() =>
        decode(workbook([hickman], undefined, change), { year: 2026 }),
      ).toThrow();
  });
  it.each([
    { Office: "" },
    { "Last Name": "" },
    { "Date Filed": "2/30/26" },
    { Dist: "14x" },
  ])("rejects malformed relevant physical rows %#", (change) => {
    const row = [...hickman];
    for (const [key, value] of Object.entries(change))
      row[headers.indexOf(key)] = value;
    expect(() => decode(workbook([row]), { year: 2026 })).toThrow();
  });
  it("retains source-published blank party on nonpartisan county/charter contexts", () => {
    const row = [...hickman];
    row[0] = "ACC";
    row[1] = "";
    row[3] = "";
    expect(decode(workbook([row]), { year: 2026 }).rows[0]).toMatchObject({
      officeCode: "ACC",
      party: "",
    });
    const v = input();
    v.rows = [{ ...v.rows[0], party: "" }];
    expect(qualify(v).context).toBeUndefined();
  });
  it("retains literal N/S register-of-deeds districts without treating them as legislative seats", () => {
    const row = [...hickman];
    row[0] = "RD";
    row[1] = "N";
    expect(decode(workbook([row]), { year: 2026 }).rows[0]).toMatchObject({
      officeCode: "RD",
      district: "N",
    });
  });
  it("does not export contacts or claim financial/currentness authority", () => {
    const r = decode(workbook(), { year: 2026 });
    expect(r).not.toHaveProperty("complete");
    expect(r).not.toHaveProperty("current");
    expect(r.rows[0]).not.toHaveProperty("residenceMunicipality");
    expect(() =>
      decode(Buffer.from("HTML SECRET challenge"), { year: 2026 }),
    ).toThrow("Maine official general ballot source is unavailable");
  });
});
describe("exact Maine local/source/ballot contextual qualification", () => {
  it("qualifies the exact structured person/office/seat/date/party context while retaining unknown middle", () => {
    const r = qualify(input());
    expect(r.context).toMatchObject({
      nameQualification: "structured_context_middle_unavailable",
      ballot: {
        middleName: "V.",
        officeCode: "SS",
        district: "14",
        party: "D",
      },
    });
    expect(r.diagnostics).toEqual([]);
  });
  it("accepts explicit matching middle fields and exact source Representative/local House mapping", () => {
    const row = [...hickman];
    row[0] = "SR";
    row[1] = "40";
    row[5] = "Example";
    row[6] = "Alex";
    row[7] = "Marie";
    const v = input();
    v.rows = decode(workbook([row]), { year: 2026 }).rows;
    v.candidate = {
      ...candidate,
      firstName: "Alex",
      lastName: "Example",
      officeName: "State Lower Chamber Legislator",
      officeScope: "state_lower",
      district: "40",
      middleName: "Marie",
    } as typeof v.candidate;
    v.source = {
      ...source,
      firstName: "Alex",
      lastName: "Example",
      office: "Representative",
      district: "40",
      filerName: "Alex Marie Example",
      middleName: "Marie",
    } as typeof v.source;
    expect(qualify(v).context).toMatchObject({
      nameQualification: "exact_structured",
      ballot: { middleName: "Marie", officeCode: "SR" },
    });
  });
  it.each([
    { district: "15" },
    { firstName: "Rusty" },
    { lastName: "Other" },
    { party: "Republican" },
    { electionYear: 2025 },
    { electionDate: "2026-06-09" },
    { officeName: "Governor" },
    { officeScope: "federal" },
    { officeScope: "state_lower" },
  ])("preserves wrong local context %#", (change) => {
    const v = input();
    Object.assign(v.candidate, change);
    expect(qualify(v).context).toBeUndefined();
  });
  it.each([
    { district: "15" },
    { firstName: "Other" },
    { lastName: "Other" },
    { office: "Senate" },
    { filerId: "505751" },
  ])("preserves wrong source or guessed legacy identity %#", (change) => {
    const v = input();
    Object.assign(v.source, change);
    expect(qualify(v).context).toBeUndefined();
  });
  it("checks unique context before party and preserves both duplicate occurrences", () => {
    const v = input();
    const competing = { ...v.rows[0], rowNumber: 3, party: "R" };
    v.rows = [...v.rows, competing];
    expect(qualify(v).context).toBeUndefined();
    expect(v.rows).toHaveLength(2);
  });
  it("retains unknown ballot middle context without removing any source-name token, and preserves unproven suffix", () => {
    const v = input();
    v.rows = [
      {
        ...v.rows[0],
        firstName: "Alex",
        lastName: "Example",
        middleName: "V.",
      },
    ];
    v.candidate.firstName = "Alex";
    v.candidate.lastName = "Example";
    v.source.firstName = "Alex";
    v.source.lastName = "Example";
    v.source.filerName = "Alex Example";
    expect(qualify(v).context?.ballot.middleName).toBe("V.");
    v.source.filerName = "Alex V. Example";
    expect(qualify(v).context).toBeUndefined();
    v.source.filerName = "Alex Example";
    v.rows = [{ ...v.rows[0], middleName: "", suffix: "Jr." }];
    expect(qualify(v).context).toBeUndefined();
  });
  it("rejects every known middle and suffix conflict", () => {
    const v = input();
    Object.assign(v.candidate, { middleName: "Q." });
    expect(qualify(v).context).toBeUndefined();
    delete (v.candidate as any).middleName;
    Object.assign(v.source, { suffix: "Jr." });
    expect(qualify(v).context).toBeUndefined();
  });
  it("keeps GOV unresolved despite its candidate label and does not confuse SS/SR seats", () => {
    const v = input();
    v.rows = [{ ...v.rows[0], officeCode: "GOV", district: "" }];
    v.candidate.officeName = "Governor";
    v.candidate.district = "";
    v.source.office = "Governor";
    v.source.district = "";
    expect(qualify(v).context).toBeUndefined();
    const house = input();
    house.rows = [{ ...house.rows[0], officeCode: "SR" }];
    expect(qualify(house).context).toBeUndefined();
  });
  it("returns detached safe identity fields", () => {
    const v = input();
    const r = qualify(v);
    v.rows[0].middleName = "changed";
    v.candidate.firstName = "changed";
    v.source.filerName = "changed";
    expect(r.context?.ballot.middleName).toBe("V.");
    expect(r.context?.candidate.firstName).toBe("Craig");
    expect(r.context?.source.filerName).toBe("Craig Hickman");
  });
});
describe("ordinary restricted ballot acquisition", () => {
  it("defaults to cache-only and never invokes source transport without explicit permission", async () => {
    const cacheDir = await temp(),
      fetchImpl = network();
    expect((await acquire({ cacheDir, year: 2026, fetchImpl })).status).toBe(
      "unavailable",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("records a genuine page/workbook bracket and returns safe parsed identity facts", async () => {
    const cacheDir = await temp(),
      fetchImpl = network(),
      start = Date.now();
    const r = available(
      await acquire({ cacheDir, year: 2026, cacheOnly: false, fetchImpl }),
    );
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      PAGE,
      URL,
      PAGE,
      URL,
    ]);
    expect(r.sourceUrl).toBe(URL);
    expect(r.rows[0].middleName).toBe("V.");
    for (const a of [
      r.source.page,
      r.source.workbook,
      r.source.closingPage,
      r.source.closingWorkbook,
    ]) {
      const bytes = await readFile(join(r.directory, a.file));
      expect(a.bytes).toBe(bytes.length);
      expect(a.sha256).toBe(sha(bytes));
      expect(Date.parse(a.startedAt)).toBeGreaterThanOrEqual(start);
      expect(Date.parse(a.completedAt)).toBeGreaterThanOrEqual(
        Date.parse(a.startedAt),
      );
      expect((await stat(join(r.directory, a.file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(r.directory)).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(r)).not.toContain("PRIVATE_MUNICIPALITY");
  });
  it("cache-only preserves original source intervals/digest with no request or retiming", async () => {
    const cacheDir = await temp(),
      original = available(
        await acquire({
          cacheDir,
          year: 2026,
          cacheOnly: false,
          fetchImpl: network(),
        }),
      ),
      fetchImpl = network();
    expect(
      await acquire({
        cacheDir,
        year: 2026,
        cacheOnly: true,
        refresh: true,
        fetchImpl,
      }),
    ).toEqual(original);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    "changed-book",
    "wrong-link",
    "challenge",
    "oversized",
    "stream-failure",
  ])("fresh %s failure keeps the good pointer", async (failure) => {
    const cacheDir = await temp();
    await acquire({
      cacheDir,
      year: 2026,
      cacheOnly: false,
      fetchImpl: network(),
    });
    const pointer = await readFile(join(cacheDir, "current-2026.json"), "utf8");
    const oldFiles = (await readdir(cacheDir)).sort();
    const fetchImpl = network({
      override: (url, index) => {
        if (failure === "changed-book" && index === 4)
          return new Response(
            workbook([[...hickman.slice(0, 7), "Q.", ...hickman.slice(8)]]),
          );
        if (failure === "wrong-link" && index === 3)
          return new Response(html.replace("FINAL.xlsx", "DRAFT.xlsx"));
        if (failure === "challenge" && index === 2)
          return new Response("SECRET access error", { status: 403 });
        if (failure === "oversized" && index === 2)
          return new Response(Buffer.alloc(8 * 1024 * 1024 + 1));
        if (failure === "stream-failure" && index === 2)
          return new Response(
            new ReadableStream({
              start(c) {
                c.error(new Error("SECRET source failure"));
              },
            }),
          );
      },
    });
    const r = await acquire({
      cacheDir,
      year: 2026,
      refresh: true,
      cacheOnly: false,
      fetchImpl,
    });
    expect(r).toMatchObject({
      status: "unavailable",
      previousCacheVerified: true,
    });
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(await readFile(join(cacheDir, "current-2026.json"), "utf8")).toBe(
      pointer,
    );
    expect((await readdir(cacheDir)).sort()).toEqual(oldFiles);
  });
  it("never fetches wrong-host source links or signed/unsafe redirects", async () => {
    const cacheDir = await temp();
    const fetchImpl = network({
      override: (url) =>
        url === PAGE
          ? new Response(html.replace("www.maine.gov", "private.invalid"))
          : undefined,
    });
    expect(
      (await acquire({ cacheDir, year: 2026, cacheOnly: false, fetchImpl }))
        .status,
    ).toBe("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const redirect = network({
      override: (url) =>
        url === URL
          ? new Response(null, {
              status: 302,
              headers: { location: "https://127.0.0.1/file?token=SECRET" },
            })
          : undefined,
    });
    expect(
      (
        await acquire({
          cacheDir,
          year: 2026,
          cacheOnly: false,
          fetchImpl: redirect,
        })
      ).status,
    ).toBe("unavailable");
    expect(redirect).toHaveBeenCalledTimes(2);
  });
  it("rejects corrupt cached bytes/hash/path and leaves the original pointer untouched", async () => {
    const cacheDir = await temp(),
      r = available(
        await acquire({
          cacheDir,
          year: 2026,
          cacheOnly: false,
          fetchImpl: network(),
        }),
      );
    const pointer = await readFile(join(cacheDir, "current-2026.json"), "utf8");
    await writeFile(join(r.directory, "workbook.xlsx"), "bad bytes");
    const fetchImpl = network();
    expect(
      (await acquire({ cacheDir, year: 2026, cacheOnly: true, fetchImpl }))
        .status,
    ).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(join(cacheDir, "current-2026.json"), "utf8")).toBe(
      pointer,
    );
  });
  it("rejects hash-consistent changed source route and path traversal metadata", async () => {
    const cacheDir = await temp(),
      r = available(
        await acquire({
          cacheDir,
          year: 2026,
          cacheOnly: false,
          fetchImpl: network(),
        }),
      );
    const raw = JSON.parse(
      await readFile(join(r.directory, "manifest.json"), "utf8"),
    );
    raw.workbook.file = "../workbook.xlsx";
    raw.workbook.url = "https://private.invalid/SECRET";
    const bytes = JSON.stringify(raw);
    await writeFile(join(r.directory, "manifest.json"), bytes);
    const p = JSON.parse(
      await readFile(join(cacheDir, "current-2026.json"), "utf8"),
    );
    p.sha256 = sha(bytes);
    await writeFile(join(cacheDir, "current-2026.json"), JSON.stringify(p));
    expect(
      (await acquire({ cacheDir, year: 2026, cacheOnly: true })).status,
    ).toBe("unavailable");
  });
  it("snapshots input scope before awaits and forces fresh observation when network is explicitly allowed", async () => {
    const cacheDir = await temp(),
      other = await temp();
    let input: {
      cacheDir: string;
      year: number;
      cacheOnly: boolean;
      refresh: boolean;
      fetchImpl: typeof fetch;
    };
    const fetchImpl = network({
      override: () => {
        input.cacheDir = other;
        input.year = 2025;
        input.cacheOnly = true;
        return undefined;
      },
    });
    input = {
      cacheDir,
      year: 2026,
      cacheOnly: false,
      refresh: true,
      fetchImpl,
    };
    const r = available(await acquire(input));
    expect(r.directory.startsWith(cacheDir)).toBe(true);
    expect(r.year).toBe(2026);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(await readdir(other)).toEqual([]);
  });
});

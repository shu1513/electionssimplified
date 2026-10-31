import { describe, expect, it } from "vitest";
import {
  decodeMaineMapLightDatasetGuide as guide,
  decodeMaineMapLightDatasetCatalog as catalog,
  selectMaineMapLightDatasetAttachment as select,
  sameMaineMapLightDatasetSelection as same,
  MAINE_MAPLIGHT_DATASET_CATALOG_URL as URL,
  MAINE_MAPLIGHT_DATASET_ORIGIN as ORIGIN,
} from "../../../src/pipeline/maineFinance/maineMapLightDatasetCatalog.js";
const header = `---\ntitle: "Maine Campaign Finance Datasets"\ncanonical: "${ORIGIN}/space/MESUPPORT/2763390977/Maine%20Campaign%20Finance%20Datasets"\nformat: markdown\n---\n`;
const ie =
  "- 2026 Independent Expenditures | Last Updated: October 11, 2026 9:55 AM ET";
const cash =
  "- 2026 Transactions - All Filers | Last Updated: October 11, 2026 9:59 AM ET";
function descriptor() {
  return guide(header + ie, {
    dataset: "independent_expenditures",
    year: 2026,
  });
}
function record(
  id = "att3044048898",
  title = "2026 Independent Expenditures 10112026 0955AM.csv",
) {
  const link = `/rest/api/content/2763390977/child/attachment/${id}/download`;
  return {
    id,
    title,
    pageId: "2763390977",
    status: "current",
    mediaType: "text/csv",
    fileSize: 379864,
    version: {
      number: 1,
      authorId: "PRIVATE_AUTHOR",
      message: "PRIVATE_COMMENT",
    },
    createdAt: "2026-10-11T14:07:32.106Z",
    downloadLink: link,
    _links: { download: link, webui: "PRIVATE_LINK" },
    comment: "PRIVATE_COMMENT",
    user: { name: "PRIVATE_USER" },
  };
}
function body(rows = [record()], next?: string) {
  return JSON.stringify({
    results: rows,
    _links: {
      base: "https://maplight.atlassian.net/wiki",
      ...(next === undefined ? {} : { next }),
    },
  });
}
function page(rows = [record()]) {
  return catalog(body(rows), { sourceUrl: URL });
}
function selected(rows = [record()]) {
  return select(descriptor(), [page(rows)]);
}

describe("Maine MapLight dataset publication discovery", () => {
  it("selects both actual dataset families by ET descriptor and exact filename", () => {
    const markdown = header + cash + "\n  - \n" + ie + "\n  - ";
    const d = guide(markdown, { dataset: "all_filers", year: 2026 });
    expect(d).toMatchObject({
      lastUpdatedRaw: "October 11, 2026 9:59 AM ET",
      lastUpdatedDate: "2026-10-11",
      lastUpdatedTime: "09:59",
      timeZone: "ET",
      expectedTitle: "2026 Transactions - All Filers 10112026 0959AM.csv",
    });
    const p = page([record(), record("att3044147202", d.expectedTitle)]);
    expect(select(d, [p]).attachment.id).toBe("att3044147202");
    expect(select(descriptor(), [p]).attachment.id).toBe("att3044048898");
  });
  it("does not use current status, upload order or later creation time to select history", () => {
    const old = {
      ...record(
        "att9999999999",
        "2026 Independent Expenditures 10102026 0955AM.csv",
      ),
      createdAt: "2026-10-12T20:00:00Z",
    };
    expect(selected([old, record()]).attachment.id).toBe("att3044048898");
    expect(() => selected([old])).toThrow("missing or ambiguous");
  });
  it("rejects two unique IDs with the same published filename", () => {
    expect(() => selected([record(), record("att123")])).toThrow("ambiguous");
  });
  it("excludes authors, comments, irrelevant links and unknown extras from safe projection", () => {
    const value = JSON.stringify(selected());
    expect(value).not.toContain("PRIVATE");
    expect(Object.keys(selected().attachment).sort()).toEqual(
      [
        "id",
        "title",
        "pageId",
        "status",
        "mediaType",
        "fileSize",
        "versionNumber",
        "createdAt",
        "downloadLink",
      ].sort(),
    );
  });
  it.each([
    "September 31, 2026 9:55 AM ET",
    "February 29, 2026 9:55 AM ET",
    "October 11, 2026 13:55 AM ET",
    "October 11, 2026 9:60 AM ET",
    "October 11, 2026 9:55 AM UTC",
    "October 11, 2026 9:55 AM EST",
    "October 11, 2026 9:55AM ET",
  ])("rejects malformed publication wall clock %s", (stamp) => {
    expect(() =>
      guide(header + ie.replace("October 11, 2026 9:55 AM ET", stamp), {
        dataset: "independent_expenditures",
        year: 2026,
      }),
    ).toThrow(/^Maine MapLight dataset catalog:/);
  });
  it.each([
    ["12:55 AM", "00:55", "1255AM"],
    ["12:55 PM", "12:55", "1255PM"],
    ["1:55 PM", "13:55", "0155PM"],
  ])("preserves noon/midnight wall clocks %s", (input, time, suffix) => {
    const d = guide(header + ie.replace("9:55 AM", input), {
      dataset: "independent_expenditures",
      year: 2026,
    });
    expect(d.lastUpdatedTime).toBe(time);
    expect(d.expectedTitle).toContain(suffix);
  });
  it("permits publication next year without changing source dataset year", () => {
    const d = guide(
      header + ie.replace("October 11, 2026", "January 2, 2027"),
      { dataset: "independent_expenditures", year: 2026 },
    );
    expect(d.expectedTitle).toBe(
      "2026 Independent Expenditures 01022027 0955AM.csv",
    );
  });
  it("rejects missing/duplicated descriptors or wrong guide source", () => {
    expect(() =>
      guide(header + cash, { dataset: "independent_expenditures", year: 2026 }),
    ).toThrow("missing or ambiguous");
    expect(() =>
      guide(header + ie + "\n" + ie, {
        dataset: "independent_expenditures",
        year: 2026,
      }),
    ).toThrow("missing or ambiguous");
    expect(() =>
      guide((header + ie).replace(ORIGIN, "https://private.invalid"), {
        dataset: "independent_expenditures",
        year: 2026,
      }),
    ).toThrow("guide source");
  });
  it.each([
    { pageId: "OTHER_PARENT" },
    { id: "3044048898" },
    { fileSize: 0 },
    { fileSize: 1.5 },
    { fileSize: 129 * 1024 * 1024 },
    { version: { number: 0 } },
    { mediaType: "text/html" },
    { title: "../private.csv" },
    { createdAt: "2026-02-30T14:00:00Z" },
    { createdAt: "2026-10-11T24:00:00Z" },
    { status: "current SECRET" },
    { downloadLink: "https://private.invalid/SECRET" },
    { _links: { download: "/wrong" } },
  ])("rejects malformed catalog record without echoing values %#", (change) => {
    expect(() =>
      catalog(
        body([{ ...record(), ...change }] as ReturnType<typeof record>[]),
        { sourceUrl: URL },
      ),
    ).toThrow(/^Maine MapLight dataset catalog:/);
    try {
      catalog(
        body([{ ...record(), ...change }] as ReturnType<typeof record>[]),
        { sourceUrl: URL },
      );
    } catch (e) {
      expect(String(e)).not.toMatch(/SECRET|OTHER_PARENT|private\.invalid/);
    }
  });
  it("validates unrelated malformed historical records instead of dropping them", () => {
    expect(() =>
      selected([
        record(),
        { ...record("att123", "historical.csv"), fileSize: -1 },
      ]),
    ).toThrow("integer");
    expect(() => page([record(), record()])).toThrow("duplicate");
  });
  it.each([
    "https://private.invalid/api/v2/pages/2763390977/attachments?limit=250",
    URL + "&token=SECRET",
    URL + "&limit=250",
    URL + "#SECRET",
    URL.replace("limit=250", "limit=500"),
    URL.replace("2763390977", "1"),
    URL.replace("https://", "https://user:SECRET@"),
  ])("rejects invalid catalog URL without leaking it %#", (url) => {
    expect(() => catalog(body(), { sourceUrl: url })).toThrow(
      /^Maine MapLight dataset catalog:/,
    );
  });
  it("follows only actual returned continuation and requires the entire page chain", () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      record(`att${i + 1}`, `history ${i}.csv`),
    );
    const next =
      "/api/v2/pages/2763390977/attachments?limit=250&cursor=source_cursor";
    const first = catalog(body(rows, next), { sourceUrl: URL });
    const second = catalog(body(), { sourceUrl: ORIGIN + next });
    expect(select(descriptor(), [first, second]).attachment.id).toBe(
      "att3044048898",
    );
    expect(() => select(descriptor(), [first])).toThrow("incomplete");
    expect(() => select(descriptor(), [second, first])).toThrow("sequence");
    expect(() =>
      select(descriptor(), [first, { ...second, sourceUrl: URL }]),
    ).toThrow("sequence");
    expect(() =>
      select(descriptor(), [
        first,
        { ...second, attachments: [first.attachments[0]] },
      ]),
    ).toThrow("duplicate");
  });
  it("maps Confluence /wiki continuation links onto the mirror origin", () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      record(`att${i + 1}`, `history ${i}.csv`),
    );
    const next =
      "/wiki/api/v2/pages/2763390977/attachments?limit=250&cursor=abc";
    expect(catalog(body(rows, next), { sourceUrl: URL }).nextUrl).toBe(
      `${ORIGIN}/api/v2/pages/2763390977/attachments?limit=250&cursor=abc`,
    );
  });
  it("rejects wrong-host/self/partial-page continuation and excessive physical pages", () => {
    expect(() => catalog(body([record()], URL), { sourceUrl: URL })).toThrow(
      "continuation",
    );
    expect(() =>
      catalog(body([record()], URL + "&cursor=source_cursor"), {
        sourceUrl: URL,
      }),
    ).toThrow("continuation");
    expect(() =>
      catalog(body([record()], "https://private.invalid/SECRET"), {
        sourceUrl: URL,
      }),
    ).toThrow("URL");
    expect(() =>
      select(
        descriptor(),
        Array.from({ length: 21 }, () => page()),
      ),
    ).toThrow("excessive");
  });
  it("requires selected current status even though that flag cannot identify the selected publication", () => {
    expect(() => selected([{ ...record(), status: "archived" }])).toThrow(
      "published attachment",
    );
  });
  it("ignores JSON object ordering and unrelated valid historical changes in closure", () => {
    const a = selected([record(), record("att1", "old.csv")]);
    const reversed = Object.fromEntries(Object.entries(record()).reverse());
    const b = select(descriptor(), [
      catalog(
        JSON.stringify({
          _links: { base: "https://maplight.atlassian.net/wiki" },
          results: [reversed, record("att2", "different old.csv")],
        }),
        { sourceUrl: URL },
      ),
    ]);
    expect(same(a, b)).toBe(true);
  });
  it.each([
    "id",
    "title",
    "pageId",
    "status",
    "mediaType",
    "fileSize",
    "versionNumber",
    "createdAt",
    "downloadLink",
  ] as const)("selected %s changes prevent closure", (key) => {
    const a = selected(),
      b = structuredClone(a);
    if (key === "fileSize" || key === "versionNumber") b.attachment[key] += 1;
    else b.attachment[key] += "changed";
    expect(same(a, b)).toBe(false);
  });
  it("descriptor change prevents closure and forged descriptor is rejected", () => {
    const a = selected(),
      b = structuredClone(a);
    b.descriptor.lastUpdatedTime = "10:55";
    expect(same(a, b)).toBe(false);
    expect(() =>
      select({ ...descriptor(), expectedTitle: "guessed.csv" }, [page()]),
    ).toThrow("descriptor");
  });
  it.each([
    "<html>Challenge SECRET</html>",
    "{}",
    '{"results":{},"_links":{}}',
    '{"results":[],"_links":{}}',
  ])("rejects errors or missing selection rather than zero %#", (json) => {
    expect(() =>
      select(descriptor(), [catalog(json, { sourceUrl: URL })]),
    ).toThrow(/^Maine MapLight dataset catalog:/);
  });
  it("revalidates altered metadata and strips caller extras at selection boundary", () => {
    const p = page();
    Object.assign(p.attachments[0], { author: "PRIVATE_AUTHOR" });
    expect(JSON.stringify(select(descriptor(), [p]))).not.toContain("PRIVATE");
    Object.assign(p.attachments[0], {
      downloadLink: "https://private.invalid/SECRET",
    });
    expect(() => select(descriptor(), [p])).toThrow("download binding");
  });
  it("returns detached selection objects and invents no observation timestamp", () => {
    const d = descriptor(),
      p = page(),
      s = select(d, [p]);
    d.lastUpdatedRaw = "changed";
    (
      p.attachments[0] as ReturnType<typeof record> & { versionNumber: number }
    ).title = "changed";
    expect(s.descriptor.lastUpdatedRaw).toBe("October 11, 2026 9:55 AM ET");
    expect(s.attachment.title).toBe(
      "2026 Independent Expenditures 10112026 0955AM.csv",
    );
    expect(s).not.toHaveProperty("retrievedAt");
    expect(s).not.toHaveProperty("complete");
  });
});

/** Publication discovery facts only. No current-report, completeness-of-money, or zero authority. */
export const MAINE_MAPLIGHT_DATASET_ORIGIN =
  "https://maine-disclosure-system.refined.site";
export const MAINE_MAPLIGHT_DATASET_PAGE_ID = "2763390977";
export const MAINE_MAPLIGHT_DATASET_CATALOG_URL = `${MAINE_MAPLIGHT_DATASET_ORIGIN}/api/v2/pages/${MAINE_MAPLIGHT_DATASET_PAGE_ID}/attachments?limit=250`;
export const MAINE_MAPLIGHT_DATASET_GUIDE_MD_URL = `${MAINE_MAPLIGHT_DATASET_ORIGIN}/space/MESUPPORT/${MAINE_MAPLIGHT_DATASET_PAGE_ID}.md`;
const path = `/api/v2/pages/${MAINE_MAPLIGHT_DATASET_PAGE_ID}/attachments`;
const guideUrl = `${MAINE_MAPLIGHT_DATASET_ORIGIN}/space/MESUPPORT/${MAINE_MAPLIGHT_DATASET_PAGE_ID}/Maine%20Campaign%20Finance%20Datasets`;
export type MaineMapLightDataset = "all_filers" | "independent_expenditures";
export interface MaineMapLightDatasetDescriptor {
  dataset: MaineMapLightDataset;
  year: number;
  label: string;
  lastUpdatedRaw: string;
  lastUpdatedDate: string;
  lastUpdatedTime: string;
  timeZone: "ET";
  expectedTitle: string;
}
export interface MaineMapLightDatasetAttachment {
  id: string;
  title: string;
  pageId: string;
  status: string;
  mediaType: string;
  fileSize: number;
  versionNumber: number;
  createdAt: string;
  downloadLink: string;
}
export interface MaineMapLightDatasetCatalogPage {
  sourceUrl: string;
  attachments: readonly MaineMapLightDatasetAttachment[];
  nextUrl: string | null;
}
export interface MaineMapLightDatasetSelection {
  descriptor: MaineMapLightDatasetDescriptor;
  attachment: MaineMapLightDatasetAttachment;
}
function fail(message: string): never {
  throw new Error(`Maine MapLight dataset catalog: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail("invalid metadata text");
  return value;
}
function integer(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  )
    fail("invalid metadata integer");
  return value;
}
function date(year: number, month: number, day: number): string {
  if (
    year < 1900 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    fail("invalid publication date");
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function timestamp(value: unknown): string {
  const raw = text(value);
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(
      raw,
    );
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59)
    fail("invalid creation timestamp");
  date(Number(m[1]), Number(m[2]), Number(m[3]));
  return raw;
}
function catalogUrl(value: string, relativeTo?: string): string {
  let url: URL;
  try {
    url = new URL(value, relativeTo);
  } catch {
    fail("invalid catalog URL");
  }
  if (
    url.origin !== MAINE_MAPLIGHT_DATASET_ORIGIN ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.pathname !== path ||
    /%|\\/.test(url.pathname)
  )
    fail("invalid catalog URL");
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !["limit", "start", "cursor"].includes(key))
      fail("invalid catalog query");
    seen.add(key);
    if (key === "limit" && value !== "250") fail("invalid catalog query");
    if (key === "start" && !/^(0|[1-9]\d{0,7})$/.test(value))
      fail("invalid catalog query");
    if (key === "cursor" && !/^[A-Za-z0-9_+=/-]{1,1024}$/.test(value))
      fail("invalid catalog query");
  }
  if (url.searchParams.get("limit") !== "250") fail("invalid catalog query");
  return url.href;
}

/** The ET wall clock is preserved; upload timestamps do not define publication time. */
export function decodeMaineMapLightDatasetGuide(
  markdown: string,
  input: { dataset: MaineMapLightDataset; year: number },
): MaineMapLightDatasetDescriptor {
  if (
    typeof markdown !== "string" ||
    markdown.length > 1024 * 1024 ||
    markdown.includes("\u0000")
  )
    fail("invalid guide");
  if (
    !["all_filers", "independent_expenditures"].includes(input.dataset) ||
    !Number.isInteger(input.year) ||
    input.year < 1900 ||
    input.year > 2100
  )
    fail("invalid dataset scope");
  const canonical = markdown.match(/^canonical: "([^"\r\n]+)"$/gm);
  if (canonical?.length !== 1 || canonical[0] !== `canonical: "${guideUrl}"`)
    fail("invalid guide source");
  const label = `${input.year} ${input.dataset === "all_filers" ? "Transactions - All Filers" : "Independent Expenditures"}`;
  const lines = markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`- ${label} |`));
  if (lines.length !== 1) fail("missing or ambiguous dataset descriptor");
  const m =
    /^- (.+) \| Last Updated: ([A-Z][a-z]+) ([1-9]\d?), (\d{4}) ([1-9]\d?):(\d{2}) (AM|PM) ET$/.exec(
      lines[0],
    );
  if (!m || m[1] !== label) fail("invalid dataset descriptor");
  const month =
    [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ].indexOf(m[2]) + 1;
  const day = Number(m[3]),
    year = Number(m[4]),
    hour = Number(m[5]),
    minute = Number(m[6]);
  const lastUpdatedDate = date(year, month, day);
  if (hour < 1 || hour > 12 || minute > 59) fail("invalid publication time");
  const time = `${String((hour % 12) + (m[7] === "PM" ? 12 : 0)).padStart(2, "0")}:${m[6]}`;
  return {
    dataset: input.dataset,
    year: input.year,
    label,
    lastUpdatedRaw: lines[0].slice(lines[0].indexOf("Last Updated: ") + 14),
    lastUpdatedDate,
    lastUpdatedTime: time,
    timeZone: "ET",
    expectedTitle: `${label} ${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}${year} ${String(hour).padStart(2, "0")}${m[6]}${m[7]}.csv`,
  };
}

/** Every record is structurally validated, but only safe discovery metadata leaves this decoder. */
export function decodeMaineMapLightDatasetCatalog(
  json: string,
  input: { sourceUrl: string },
): MaineMapLightDatasetCatalogPage {
  const sourceUrl = catalogUrl(input.sourceUrl);
  if (typeof json !== "string" || json.length > 4 * 1024 * 1024)
    fail("invalid catalog body");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail("invalid catalog JSON");
  }
  const root = object(parsed);
  if (!Array.isArray(root.results) || root.results.length > 250)
    fail("invalid catalog results");
  const links = object(root._links);
  let nextUrl: string | null = null;
  if (Object.hasOwn(links, "next")) {
    nextUrl = catalogUrl(text(links.next), sourceUrl);
    if (nextUrl === sourceUrl || root.results.length !== 250)
      fail("invalid catalog continuation");
  }
  const ids = new Set<string>();
  const attachments = root.results.map((value) => {
    const row = object(value),
      version = object(row.version),
      rowLinks = object(row._links);
    const id = text(row.id),
      title = text(row.title);
    if (!/^att[1-9]\d{0,19}$/.test(id) || ids.has(id))
      fail("duplicate or invalid attachment ID");
    ids.add(id);
    if (
      row.pageId !== MAINE_MAPLIGHT_DATASET_PAGE_ID ||
      title.length > 300 ||
      /[\\/]/.test(title)
    )
      fail("invalid attachment identity");
    const downloadLink = text(row.downloadLink);
    const expected = `/rest/api/content/${MAINE_MAPLIGHT_DATASET_PAGE_ID}/child/attachment/${id}/download`;
    if (downloadLink !== expected || rowLinks.download !== expected)
      fail("invalid attachment download binding");
    const status = text(row.status),
      mediaType = text(row.mediaType);
    if (!/^[a-z_]{1,32}$/.test(status) || mediaType !== "text/csv")
      fail("unsupported attachment metadata");
    return {
      id,
      title,
      pageId: MAINE_MAPLIGHT_DATASET_PAGE_ID,
      status,
      mediaType,
      fileSize: integer(row.fileSize, 128 * 1024 * 1024),
      versionNumber: integer(version.number, 1000000),
      createdAt: timestamp(row.createdAt),
      downloadLink,
    };
  });
  return { sourceUrl, attachments, nextUrl };
}

/** Caller supplies all actual pages in returned-link order. No inferred cursor or incomplete selection. */
export function selectMaineMapLightDatasetAttachment(
  descriptor: MaineMapLightDatasetDescriptor,
  pages: readonly MaineMapLightDatasetCatalogPage[],
): MaineMapLightDatasetSelection {
  // Rebuild the descriptor rather than trusting a caller-provided filename.
  const expected = decodeMaineMapLightDatasetGuide(
    `canonical: "${guideUrl}"\n- ${descriptor.label} | Last Updated: ${descriptor.lastUpdatedRaw}`,
    descriptor,
  );
  if (
    (Object.keys(expected) as (keyof MaineMapLightDatasetDescriptor)[]).some(
      (key) => expected[key] !== descriptor[key],
    )
  )
    fail("invalid dataset descriptor");
  if (!pages.length || pages.length > 20)
    fail("missing or excessive catalog pages");
  const ids = new Set<string>(),
    urls = new Set<string>();
  const matches: MaineMapLightDatasetAttachment[] = [];
  let requiredUrl = MAINE_MAPLIGHT_DATASET_CATALOG_URL;
  for (const supplied of pages) {
    // Revalidate detached decoder facts at the selection boundary; unknown extras never escape.
    const page = decodeMaineMapLightDatasetCatalog(
      JSON.stringify({
        results: supplied.attachments.map((row) => ({
          id: row.id,
          title: row.title,
          pageId: row.pageId,
          status: row.status,
          mediaType: row.mediaType,
          fileSize: row.fileSize,
          version: { number: row.versionNumber },
          createdAt: row.createdAt,
          downloadLink: row.downloadLink,
          _links: { download: row.downloadLink },
        })),
        _links: supplied.nextUrl === null ? {} : { next: supplied.nextUrl },
      }),
      { sourceUrl: supplied.sourceUrl },
    );
    if (page.sourceUrl !== requiredUrl || urls.has(page.sourceUrl))
      fail("incomplete or cyclic catalog sequence");
    urls.add(page.sourceUrl);
    for (const attachment of page.attachments) {
      if (ids.has(attachment.id)) fail("duplicate attachment across pages");
      ids.add(attachment.id);
      if (attachment.title === descriptor.expectedTitle)
        matches.push(attachment);
    }
    requiredUrl = page.nextUrl ?? "";
  }
  if (requiredUrl) fail("incomplete catalog sequence");
  if (matches.length !== 1 || matches[0].status !== "current")
    fail("missing or ambiguous published attachment");
  return { descriptor: expected, attachment: { ...matches[0] } };
}

/** Raw JSON ordering and unrelated history are not the selected publication's identity. */
export function sameMaineMapLightDatasetSelection(
  a: MaineMapLightDatasetSelection,
  b: MaineMapLightDatasetSelection,
): boolean {
  const keys: (keyof MaineMapLightDatasetDescriptor)[] = [
    "dataset",
    "year",
    "label",
    "lastUpdatedRaw",
    "lastUpdatedDate",
    "lastUpdatedTime",
    "timeZone",
    "expectedTitle",
  ];
  const metadata: (keyof MaineMapLightDatasetAttachment)[] = [
    "id",
    "title",
    "pageId",
    "status",
    "mediaType",
    "fileSize",
    "versionNumber",
    "createdAt",
    "downloadLink",
  ];
  return (
    keys.every((key) => a.descriptor[key] === b.descriptor[key]) &&
    metadata.every((key) => a.attachment[key] === b.attachment[key])
  );
}

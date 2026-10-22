// Saved native pages are the acquisition boundary. A challenge, missing page,
// partial census or incomplete receiving ledger is a hold, never an empty ledger.
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  resolveKansasCandidateFiler,
  kansasDistrictNumberFromGrid,
} from "./kansasCandidateFilerResolver.js";
import {
  parseKansasFilerKey,
  normalizeKansasNameForStorage,
} from "./kansasFinanceWriter.js";
import {
  buildKansasCandidateLedger,
  kansasLedgerCandidateName,
} from "./kansasCandidateLedger.js";
import {
  aggregateKansasDirectFinance,
  KANSAS_COUNTED_PERIOD_STATUSES,
} from "./kansasDirectContributionAggregator.js";
import {
  kansasCfrOfficeForRace,
  kansasCfrCycleStartYear,
} from "./kansasFinanceEligibleOffices.js";
import {
  kansasDateToIso,
  kansasFilingHeaderKey,
} from "./kansasReportInventory.js";
import {
  KANSAS_CFR_FILER_SEARCHES,
  kansasGridOfficeMatches,
  type KansasPooledFiling,
} from "./kansasFilingSearch.js";
import * as p from "./kansasCfrViewerParsers.js";
import type { KansasCandidateFinanceDueRow } from "./kansasCandidateFinanceDueList.js";

export const KANSAS_COMMITTEE_SOURCE_URL =
  "https://sos.ks.gov/elections/cfr_viewer/cfr_examiner_entry.aspx";
const fail = (): never => {
  throw new Error("kansas_committee_source_held");
};
const assert = (v: unknown): void => {
  if (!v) fail();
};
const digest = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export const kansasReportedNameKey = (s: string) =>
  s.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase();
const postalKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const span = (html: string, id: string) =>
  p
    .decodeKansasHtmlText(
      new RegExp(`<span[^>]*id="${id}"[^>]*>([^<]*)<\\/span>`).exec(
        html,
      )?.[1] ?? "",
    )
    .trim();
const checked = (html: string, id: string) => {
  const tag =
    new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`, "i").exec(html)?.[0] ?? "";
  return /\bchecked(?:\s*=|\s|>)/i.test(tag);
};
type Observation = {
  url: string;
  observedAt: string;
  html: string;
  controls: { id: string; value: string }[];
};
type Event = Observation & {
  file: string;
  sha256: string;
  bytes: number;
  query: Record<string, string> | null;
};
export type KansasReportedRegistryIdentity = {
  name: string;
  street: string;
  city: string;
  zip: string;
  kind: "PAC" | "party";
};
export function parseKansasReportedRegistryIdentity(
  html: string,
): KansasReportedRegistryIdentity | null {
  const pac = checked(html, "chkbxPAC"),
    party = checked(html, "chkbxParty");
  if (pac === party) return null;
  const value = {
    name: span(html, "lblCandOrgName"),
    street: [span(html, "lblAddress"), span(html, "lblOther")]
      .filter(Boolean)
      .join(" "),
    city: span(html, "lblCity"),
    zip: span(html, "lblZip"),
    kind: pac ? ("PAC" as const) : ("party" as const),
  };
  return value.name &&
    value.street &&
    value.city &&
    /^\d{5}(?:-\d{4})?$/.test(value.zip)
    ? value
    : null;
}
/** The native cover publishes street (including any unit), city and ZIP5.
 * ZIP+4 is optional routing detail; state is not rendered by this source. No
 * street/unit omission, nickname, keyword or occupation inference is allowed. */
export function kansasReceiptMatchesRegistry(
  row: p.KansasScheduleARow,
  identity: KansasReportedRegistryIdentity,
): boolean {
  if (
    kansasReportedNameKey(row.contributorName) !==
      kansasReportedNameKey(identity.name) ||
    row.addressLines.length < 2
  )
    return false;
  const last = row.addressLines.at(-1)!.trim();
  const city = /^(.*?)\s+([A-Z]{2})\s+(\d{5})(?:[ -]\d{4})?\s*$/i.exec(last);
  return (
    !!city &&
    /^\d{5}(?:[ -]\d{4})?$/.test(row.zip) &&
    row.zip.slice(0, 5) === city[3] &&
    city[3] === identity.zip.slice(0, 5) &&
    postalKey(city[1]!) === postalKey(identity.city) &&
    postalKey(row.addressLines.slice(0, -1).join(" ")) ===
      postalKey(identity.street)
  );
}
export type KansasCommitteeGroup = {
  reportedName: string;
  nameKey: string;
  amountCents: number;
  receiptCount: number;
};
export type KansasCommitteePacket = {
  target: KansasCandidateFinanceDueRow;
  observedAt: string;
  cycleStart: string;
  cycleEnd: string;
  coveredThrough: string;
  groups: readonly KansasCommitteeGroup[];
  totalCents: number;
  receiptCount: number;
  sourceCashRows: number;
  unmatchedGiftRows: number;
  excludedNonGiftRows: number;
  zeroGiftRows: number;
  provenance: readonly {
    file: string;
    sha256: string;
    bytes: number;
    url: string;
    observedAt: string;
  }[];
};
const qualified = new WeakSet<object>();
export function assertQualifiedKansasCommitteePacket(
  packet: KansasCommitteePacket,
): void {
  assert(qualified.has(packet));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
async function original(directory: string, file: string): Promise<Buffer> {
  assert(/^(?:[a-f0-9-]+\.json|manifest\.ndjson)$/.test(file));
  const path = join(directory, file),
    stat = await lstat(path);
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size < 64 * 1024 * 1024,
  );
  return readFile(path);
}
function isoQueryDate(value: string): string {
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(value))
    return kansasDateToIso(value.replaceAll("/", "-"));
  return kansasDateToIso(value);
}
const semanticRow = (row: p.KansasCfrGridRow) => {
  const { index: _index, postbackTarget: _target, ...value } = row;
  return value;
};
function census(
  events: Event[],
  grid: string,
  office: string,
  type: string,
  start: string,
  end: string,
): p.KansasCfrGridRow[] {
  const pages = events.filter(
    (e) =>
      e.url.endsWith("/cfr_examiner_search_results.aspx") &&
      e.query?.drpdownOffice === office &&
      e.query.drpdownFilingType === type &&
      e.query.txtFirstName === "" &&
      e.query.txtLastName === "" &&
      e.query.txtDistrictNo === "",
  );
  assert(pages.length > 0);
  for (const e of pages)
    assert(
      isoQueryDate(e.query!.txtStartDate!) === start &&
        isoQueryDate(e.query!.txtEndDate!) === end,
    );
  const count = p.parseKansasRecordCount(pages[0]!.html);
  assert(count !== null && count >= 0);
  const n = Math.max(1, Math.ceil(count! / 20));
  // Two independently submitted report censuses; appointments/exemptions need
  // one complete census. Financial reports are where version shifts matter.
  assert(
    pages.length >=
      n * (type === KANSAS_CFR_FILER_SEARCHES[0]!.filingType ? 2 : 1),
  );
  const take = (subset: Event[]) =>
    subset.flatMap((e, i) => {
      assert(p.parseKansasRecordCount(e.html) === count);
      assert((p.parseKansasCfrGridCurrentPage(e.html, grid) ?? 1) === i + 1);
      const rows = p.parseKansasCfrGridRows(e.html, grid);
      assert(rows.length === Math.min(20, Math.max(0, count! - i * 20)));
      assert(rows.every((r) => r.name && r.postbackTarget));
      return rows;
    });
  const opening = take(pages.slice(0, n)),
    closing = take(pages.slice(-n));
  assert(
    JSON.stringify(opening.map(semanticRow)) ===
      JSON.stringify(closing.map(semanticRow)),
  );
  return closing;
}
export async function acquireKansasCommitteeReceipts(input: {
  directory: string;
  target: KansasCandidateFinanceDueRow;
  now: Date;
}): Promise<KansasCommitteePacket> {
  const stat = await lstat(input.directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink());
  const manifest = (await original(input.directory, "manifest.ndjson"))
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(manifest.length > 0 && manifest.length <= 500);
  const events: Event[] = [];
  let query: Event["query"] = null;
  for (const m of manifest) {
    const raw = await original(input.directory, m.file);
    assert(
      raw.length === m.bytes &&
        digest(raw) === m.sha256 &&
        m.nativeChecksumVerified === true,
    );
    const v = JSON.parse(raw.toString("utf8")) as Observation;
    const u = new URL(v.url);
    assert(
      u.origin === "https://sos.ks.gov" &&
        u.pathname.startsWith("/elections/cfr_viewer/") &&
        !u.search &&
        !u.hash &&
        !u.username &&
        !u.password,
    );
    const observed = Date.parse(v.observedAt);
    assert(
      Number.isFinite(observed) &&
        observed <= input.now.getTime() &&
        input.now.getTime() - observed <= 36 * 3600_000,
    );
    assert(
      typeof v.html === "string" &&
        v.html.length === m.nativeHtmlLength &&
        v.html.trimEnd().endsWith("</html>") &&
        Array.isArray(v.controls),
    );
    if (u.pathname.endsWith("/cfr_examiner.aspx"))
      query = Object.fromEntries(v.controls.map((c) => [c.id, c.value]));
    events.push({
      ...v,
      file: m.file,
      sha256: m.sha256,
      bytes: raw.length,
      query,
    });
  }
  const office = kansasCfrOfficeForRace({
    officeScope: input.target.officeScope,
    officeCanonicalName: input.target.officeName,
  });
  assert(office);
  const start = `${kansasCfrCycleStartYear(office!, input.target.electionYear)}-01-01`;
  const firstCensus = events.find(
    (e) =>
      e.url.endsWith("/cfr_examiner_search_results.aspx") &&
      e.query?.drpdownOffice === office!.code &&
      e.query.drpdownFilingType === KANSAS_CFR_FILER_SEARCHES[0]!.filingType &&
      e.query.txtFirstName === "" &&
      e.query.txtLastName === "" &&
      e.query.txtDistrictNo === "",
  );
  assert(firstCensus);
  // Saved observations retain their actual query day after midnight. Their
  // source clock never advances to import time. An artificially shortened
  // query on the observation day is not a complete current census.
  const end = isoQueryDate(firstCensus!.query!.txtEndDate!);
  assert(end === firstCensus!.observedAt.slice(0, 10));
  const sequences: {
    cover: Event;
    a: Event;
    b: Event;
    parsed: p.KansasReportCover;
  }[] = [];
  for (let i = 0; i < events.length - 3; i++) {
    const [c, a, b, z] = events.slice(i, i + 4) as [Event, Event, Event, Event];
    if (
      c.url.endsWith("/exp_report_main.aspx") &&
      a.url.endsWith("/schedule_a_report.aspx") &&
      b.url.endsWith("/schedule_b_report.aspx") &&
      z.url.endsWith("/exp_report_main.aspx")
    ) {
      const cover = p.parseKansasReportCover(c.html);
      assert(
        JSON.stringify(cover) ===
          JSON.stringify(p.parseKansasReportCover(z.html)),
      );
      sequences.push({ cover: c, a, b, parsed: cover });
    }
  }
  const allCensuses = KANSAS_CFR_FILER_SEARCHES.map((search) => ({
    search,
    rows: census(
      events,
      search.gridId,
      office!.code,
      search.filingType,
      start,
      end,
    ),
  }));
  const recipe = parseKansasFilerKey(input.target.committeeId);
  const identity = resolveKansasCandidateFiler({
    candidateName: kansasLedgerCandidateName(
      recipe,
      input.target.committeeName,
    ),
    districtNumber: recipe.districtNumber,
    rows: allCensuses.flatMap(({ search, rows }) =>
      rows.map((r) => ({
        filedName: r.name,
        district: r.district,
        officeSought: r.officeSought,
        filingKind: search.filingKind,
        fileDate: r.fileDate,
      })),
    ),
  });
  assert(identity.status === "matched");
  if (identity.status !== "matched") return fail();
  const ownNames = new Set(
    identity.match.filedNames.map(normalizeKansasNameForStorage),
  );
  const filings: KansasPooledFiling[] = [];
  for (const search of KANSAS_CFR_FILER_SEARCHES) {
    const rows = census(
      events,
      search.gridId,
      office!.code,
      search.filingType,
      start,
      end,
    );
    const groups = new Map<string, p.KansasCfrGridRow[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.name, row.fileDate, row.amendmentDate]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      const row = group[0]!;
      const matching =
        search.filingKind !== "report" ||
        !ownNames.has(normalizeKansasNameForStorage(row.name))
          ? []
          : sequences.filter((s) => {
              // The grid supplies the intended race; the opened cover must
              // independently agree before its schedules can supply money.
              if (
                !kansasGridOfficeMatches(office!, s.parsed.officeSought) ||
                (office!.districted &&
                  kansasDistrictNumberFromGrid(s.parsed.district) !== recipe.districtNumber)
              ) return false;
              if (
                resolveKansasCandidateFiler({
                  candidateName: s.parsed.candidateName,
                  districtNumber: office!.districted
                    ? kansasDistrictNumberFromGrid(row.district)
                    : null,
                  rows: [
                    {
                      filedName: row.name,
                      district: row.district,
                      officeSought: row.officeSought,
                      filingKind: "report",
                      fileDate: row.fileDate,
                    },
                  ],
                }).status !== "matched"
              )
                return false;
              const date = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/.exec(
                s.parsed.electronicallyFiledOn ?? "",
              )?.[1];
              return (
                !!date &&
                kansasDateToIso(date) ===
                  kansasDateToIso(row.amendmentDate || row.fileDate) &&
                s.parsed.amended === !!row.amendmentDate &&
                (!row.amendmentDate ||
                  kansasDateToIso(span(s.cover.html, "lblFileDate")) ===
                    kansasDateToIso(row.fileDate))
              );
            });
      // Date-only ties may be interchanged ONLY when their entire ledger
      // headers agree. The existing ledger still holds a tied latest version.
      if (matching.length) {
        assert(matching.length === group.length);
        assert(
          new Set(
            matching.map((s) =>
              JSON.stringify([
                s.parsed.periodStart,
                s.parsed.periodEnd,
                s.parsed.amended,
                s.parsed.termination,
              ]),
            ),
          ).size === 1,
        );
      }
      group.forEach((r, i) => {
        const source = matching[i];
        const page = (event: Event) => ({
          url: event.url,
          html: event.html,
          hiddenFields: p.parseKansasHiddenFields(event.html),
        });
        filings.push({
          row: r,
          filingKind: search.filingKind,
          openReport: async () => (source ? page(source.cover) : fail()),
          openSchedule: async (letter) =>
            source && (letter === "A" || letter === "B")
              ? page(letter === "A" ? source.a : source.b)
              : fail(),
        });
      });
    }
  }
  const ledger = await buildKansasCandidateLedger({
    target: {
      committeeId: input.target.committeeId,
      committeeName: input.target.committeeName,
      office: office!,
      electionYear: input.target.electionYear,
    },
    now: input.now,
    loadFilingPool: async () => filings,
    openSchedules: true,
  });
  assert(ledger.status === "resolved");
  if (ledger.status !== "resolved") return fail();
  assert(
    ledger.complete &&
      aggregateKansasDirectFinance({
        ledger: ledger.ledger,
        covers: ledger.reports,
      }).status === "ok",
  );
  const registry: KansasReportedRegistryIdentity[] = [];
  for (const e of events) {
    if (
      !e.url.endsWith("/exp_report_main.aspx") ||
      !["12", "13"].includes(e.query?.drpdownOffice ?? "")
    )
      continue;
    const identity = parseKansasReportedRegistryIdentity(e.html);
    if (!identity) continue;
    assert(
      identity.kind === (e.query!.drpdownOffice === "12" ? "PAC" : "party"),
    );
    // Independently observed identical cover plus closed complete native query.
    assert(
      events.filter(
        (z) =>
          z.url === e.url && z.observedAt !== e.observedAt && z.html === e.html,
      ).length > 0,
    );
    const grids = events.filter(
      (z) =>
        z.query?.txtOrganizationName === e.query!.txtOrganizationName &&
        z.query?.drpdownOffice === e.query!.drpdownOffice &&
        z.url.endsWith("/cfr_examiner_search_results.aspx"),
    );
    const gridsClosed = grids.filter((z) => {
      const count = p.parseKansasRecordCount(z.html);
      const rows = p.parseKansasCfrGridRows(z.html, "grdviewCfrResults");
      return (
        count !== null &&
        count <= 20 &&
        count === rows.length &&
        rows.some(
          (r) =>
            kansasReportedNameKey(r.name) ===
            kansasReportedNameKey(identity.name),
        )
      );
    });
    assert(
      gridsClosed.length >= 2 &&
        JSON.stringify(
          p.parseKansasCfrGridRows(gridsClosed[0]!.html, "grdviewCfrResults"),
        ) ===
          JSON.stringify(
            p.parseKansasCfrGridRows(
              gridsClosed.at(-1)!.html,
              "grdviewCfrResults",
            ),
          ),
    );
    registry.push(identity);
  }
  assert(registry.length > 0);
  const uniqueRegistry = [
    ...new Map(
      registry.map((r) => [
        JSON.stringify([
          kansasReportedNameKey(r.name),
          postalKey(r.street),
          postalKey(r.city),
          r.zip.slice(0, 5),
          r.kind,
        ]),
        r,
      ]),
    ).values(),
  ];
  const canonical = new Set(
    ledger.ledger.entries
      .filter(
        (e) => e.canonical && KANSAS_COUNTED_PERIOD_STATUSES.has(e.status),
      )
      .map((e) => kansasFilingHeaderKey(e.canonical!)),
  );
  const reports = ledger.reports.filter((r) =>
    canonical.has(kansasFilingHeaderKey(r.header)),
  );
  const groups = new Map<string, KansasCommitteeGroup>();
  let sourceCashRows = 0,
    unmatchedGiftRows = 0,
    excludedNonGiftRows = 0,
    zeroGiftRows = 0;
  for (const report of reports)
    for (const row of report.scheduleA!.rows.rows) {
      const nativeDate = /^(\d{1,2}\/\d{1,2}\/)(\d{2})$/.exec(row.date);
      const periodYear = Number(
        kansasDateToIso(report.cover.periodStart).slice(0, 4),
      );
      const rowDate = kansasDateToIso(
        nativeDate
          ? `${nativeDate[1]}${Math.floor(periodYear / 100) * 100 + Number(nativeDate[2])}`
          : row.date,
      );
      assert(
        rowDate >= kansasDateToIso(report.cover.periodStart) &&
          rowDate <= kansasDateToIso(report.cover.periodEnd),
      );
      sourceCashRows++;
      const tender = row.tenderType
        .toUpperCase()
        .replace(/[\s-]+/g, " ")
        .trim();
      if (["LOAN", "REFUND"].includes(tender)) {
        excludedNonGiftRows++;
        continue;
      }
      assert(
        ["CASH", "CHECK", "CREDIT CARD", "E FUNDS", "OTHER"].includes(tender),
      );
      if (row.amountCents === 0) {
        zeroGiftRows++;
        continue;
      }
      const matches = uniqueRegistry.filter((identity) =>
        kansasReceiptMatchesRegistry(row, identity),
      );
      if (matches.length !== 1) {
        unmatchedGiftRows++;
        continue;
      }
      const key = kansasReportedNameKey(row.contributorName),
        prior = groups.get(key),
        cents = (prior?.amountCents ?? 0) + row.amountCents!;
      assert(Number.isSafeInteger(cents));
      groups.set(key, {
        nameKey: key,
        reportedName:
          prior?.reportedName ??
          row.contributorName.trim().replace(/\s+/g, " "),
        amountCents: cents,
        receiptCount: (prior?.receiptCount ?? 0) + 1,
      });
    }
  assert([...groups.values()].every((g) => g.amountCents > 0));
  const totalCents = [...groups.values()].reduce((n, g) => {
    const v = n + g.amountCents;
    assert(Number.isSafeInteger(v));
    return v;
  }, 0);
  const packet: KansasCommitteePacket = freeze({
    target: structuredClone(input.target),
    observedAt: new Date(
      Math.min(...events.map((e) => Date.parse(e.observedAt))),
    ).toISOString(),
    cycleStart: start,
    cycleEnd: `${input.target.electionYear}-12-31`,
    coveredThrough: reports
      .map((r) => kansasDateToIso(r.cover.periodEnd))
      .sort()
      .at(-1)!,
    groups: [...groups.values()],
    totalCents,
    receiptCount: [...groups.values()].reduce((n, g) => n + g.receiptCount, 0),
    sourceCashRows,
    unmatchedGiftRows,
    excludedNonGiftRows,
    zeroGiftRows,
    provenance: events.map(({ file, sha256, bytes, url, observedAt }) => ({
      file,
      sha256,
      bytes,
      url,
      observedAt,
    })),
  });
  qualified.add(packet);
  return packet;
}

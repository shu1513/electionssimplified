import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  isColoradoReportedIeEnabled,
  isColoradoReportedIeRawRefreshEnabled,
} from "../../config/featureFlags.js";
import {
  ColoradoReportError,
  coloradoReportDate,
  coloradoReportedNameKey,
  parseColoradoIndependentExpenditureReport,
  parseColoradoIeReporterRegistry,
  type ColoradoReportedIeReport,
  type ColoradoRegisteredReporter,
} from "./coloradoTracerReports.js";
import {
  qualifyColoradoNativeCandidateProfile,
  coloradoIeNativeDistrict,
  coloradoIePersonMatches,
  coloradoPartyKey,
  type ColoradoIeCandidateIdentity,
  type ColoradoNativeCandidateProof,
} from "./coloradoNativeCandidateIdentity.js";
import {
  parseColoradoNativePeerGrid,
  parseColoradoNativePeerProfile,
  type ColoradoNativePeerGridRow,
  type ColoradoNativePeerProfile,
  type ColoradoNativePostback,
} from "./coloradoNativePeerIdentity.js";
import {
  COLORADO_TRACER_ORIGIN,
  COLORADO_TRACER_REPORTS,
  ColoradoTracerObservations,
  coloradoOriginalSha,
  coloradoSourceDay,
  coloradoPrivateOriginal,
  coloradoSourceUrl,
  type ColoradoObservationManifest,
} from "./coloradoTracerObservations.js";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    source: string,
    options: { url?: string; contentType?: string; virtualConsole: unknown },
  ) => { window: { document: Document } };
  VirtualConsole: new () => unknown;
};
const check = (value: unknown, code: string): void => {
  if (!value) throw new ColoradoReportError(code);
};
const CACHE = resolve("scratch/colorado-native-finance");
export type ColoradoSourceFacts = {
  packetDirectory: string;
  observedAt: string;
  completedAt: string;
  manifestSha256: string;
  originals: readonly {
    file: string;
    sha256: string;
    bytes: number;
    startedAt: string;
    completedAt: string;
  }[];
};
export type ColoradoIeDataset = Readonly<{
  electionYear: number;
  startDate: string;
  endDate: string;
  reports: readonly ColoradoReportedIeReport[];
  registry: readonly ColoradoRegisteredReporter[];
  source: ColoradoSourceFacts;
}>;
export type ColoradoIeCandidateSource = Readonly<{
  expected: ColoradoIeCandidateIdentity;
  identity: ColoradoNativeCandidateProof;
  source: ColoradoSourceFacts;
  peers?: readonly ColoradoNativePeerProfile[];
}>;
type Options = { cacheDir?: string; refresh?: boolean; fetchFn?: typeof fetch };
const verifiedDatasets = new WeakSet<object>(),
  verifiedCandidates = new WeakSet<object>();
export const isVerifiedColoradoIeDataset = (
  value: unknown,
): value is ColoradoIeDataset =>
  !!value && typeof value === "object" && verifiedDatasets.has(value);
export const isVerifiedColoradoIeCandidateSource = (
  value: unknown,
): value is ColoradoIeCandidateSource =>
  !!value && typeof value === "object" && verifiedCandidates.has(value);
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
function html(raw: Uint8Array, url?: string, xml = false): Document {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new ColoradoReportError("invalid_native_document_utf8");
  }
  check(
    !/[\u0000\uFFFD]/u.test(text) &&
      (!xml || !/<!DOCTYPE|<!ENTITY/iu.test(text)),
    "invalid_native_document",
  );
  try {
    return new JSDOM(text, {
      ...(url ? { url } : {}),
      ...(xml ? { contentType: "application/xml" } : {}),
      virtualConsole: new VirtualConsole(),
    }).window.document;
  } catch {
    throw new ColoradoReportError("invalid_native_document");
  }
}
function form(doc: Document): HTMLFormElement {
  const value = doc.querySelector("form");
  check(value, "missing_native_form");
  return value!;
}
function controls(parent: HTMLFormElement): URLSearchParams {
  const values = new URLSearchParams();
  for (const item of parent.elements) {
    const e = item as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLButtonElement
      | HTMLTextAreaElement;
    if (!e.name || e.disabled) continue;
    const type = e.type.toLowerCase();
    if (["submit", "button", "image", "reset", "file"].includes(type)) continue;
    if (
      ["radio", "checkbox"].includes(type) &&
      !(e as HTMLInputElement).checked
    )
      continue;
    check(type !== "select-multiple", "unsupported_native_multiselect");
    values.append(e.name, e.value ?? "");
  }
  return values;
}
function input(doc: Document, id: string): HTMLInputElement {
  const value = doc.getElementById(id);
  check(value?.tagName === "INPUT", "missing_native_input");
  return value as HTMLInputElement;
}
function select(
  doc: Document,
  id: string,
  label: string,
  values: URLSearchParams,
): void {
  const element = doc.getElementById(id) as HTMLSelectElement | null;
  check(element?.tagName === "SELECT", "missing_native_select");
  const choices = [...element!.options].filter(
    (o) => o.textContent?.trim() === label,
  );
  check(choices.length === 1, "ambiguous_native_option");
  values.set(element!.name, choices[0]!.value);
}
function nativeLink(doc: Document, label: string, base: string): string {
  const links = [...doc.querySelectorAll("a[href]")].filter(
    (a) => a.textContent?.trim() === label,
  );
  const urls = [
    ...new Set(
      links.map((a) => coloradoSourceUrl(a.getAttribute("href")!, base).href),
    ),
  ];
  check(urls.length === 1, "missing_native_report_link");
  return urls[0]!;
}

function action(parent: HTMLFormElement, base: string): string {
  return coloradoSourceUrl(parent.getAttribute("action") || base, base).href;
}
function nativeDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}
function canonicalXml(bytes: Uint8Array): string {
  const doc = html(bytes, undefined, true);
  const visit = (e: Element): unknown => {
    const children = [...e.children].map((child) => {
      const value = visit(child);
      return { key: JSON.stringify(value), value };
    });
    children.sort((a, b) => a.key.localeCompare(b.key));
    return [
      e.localName,
      [...e.attributes]
        .filter((a) => a.localName !== "schemaLocation")
        .map((a) => [a.name, a.value])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
      children.map((child) => child.value),
      [...e.childNodes]
        .filter((n) => n.nodeType === 3 && n.textContent?.trim())
        .map((n) => n.textContent),
    ];
  };
  return JSON.stringify(visit(doc.documentElement));
}
async function exports(
  sequence: ColoradoTracerObservations,
  prefix: string,
  parameterUrl: string,
  scope: {
    jurisdiction: string;
    startDate: string;
    endDate: string;
    registry: boolean;
  },
) {
  const page = await sequence.request(`${prefix}_parameters`, parameterUrl),
    doc = html(page.bytes, page.url),
    parent = form(doc),
    values = controls(parent);
  select(
    doc,
    "ctl00_Content_ucJurisdiction_ucddlCounty",
    scope.jurisdiction,
    values,
  );
  values.set(
    input(doc, "ctl00_Content_dteBegin").name,
    nativeDate(scope.startDate),
  );
  values.set(
    input(doc, "ctl00_Content_dteEnd").name,
    nativeDate(scope.endDate),
  );
  if (scope.registry) {
    select(
      doc,
      "ctl00_Content_ucCommitteeType_ucddlOrganizationType",
      "Independent Expenditure Committee",
      values,
    );
    const activeOnly = input(doc, "ctl00_Content_chklstCheckboxes_0");
    check(activeOnly.type === "checkbox", "native_registry_activity_filter");
    values.delete(activeOnly.name);
  }
  const submit = input(doc, "ctl00_Content_btnGenerateReport");
  values.set(submit.name, submit.value);
  const generated = await sequence.request(
    `${prefix}_generate`,
    action(parent, page.url),
    values,
  );
  const generatedHtml = new TextDecoder("utf-8", { fatal: true }).decode(
    generated.bytes,
  );
  const viewerPath = /window\.open\(['"]([^'"]*ReportViewer\.aspx)['"]/u.exec(
    generatedHtml,
  )?.[1];
  check(viewerPath, "missing_native_viewer_action");
  const viewer = await sequence.request(
    `${prefix}_viewer`,
    coloradoSourceUrl(viewerPath!, page.url).href,
  );
  const viewerHtml = new TextDecoder("utf-8", { fatal: true }).decode(
    viewer.bytes,
  );
  const exportBase =
    /["']([^"']*Reserved\.ReportViewerWebControl\.axd\?[^"']*OpType=Export[^"']*Format=)["']/u.exec(
      viewerHtml,
    )?.[1];
  check(exportBase, "missing_native_export_action");
  const csv = await sequence.request(
    `${prefix}_csv`,
    coloradoSourceUrl(exportBase!.replaceAll("&amp;", "&") + "CSV", viewer.url)
      .href,
  );
  const xml = await sequence.request(
    `${prefix}_xml`,
    coloradoSourceUrl(exportBase!.replaceAll("&amp;", "&") + "XML", viewer.url)
      .href,
  );
  return { csv: csv.bytes, xml: xml.bytes };
}
async function globalProtocol(sequence: ColoradoTracerObservations) {
  const catalog = await sequence.request("catalog", COLORADO_TRACER_REPORTS),
    doc = html(catalog.bytes, catalog.url);
  const ieUrl = nativeLink(
      doc,
      "Independent Expenditures - Detail",
      catalog.url,
    ),
    registryUrl = nativeLink(doc, "Committee Listing", catalog.url);
  // Keep the first Colorado observation day fixed even across midnight.
  const endDate = coloradoSourceDay(sequence.manifest.records[0]!.startedAt),
    startDate = `${sequence.manifest.year - 4}-01-01`;
  check(startDate <= endDate, "native_report_window");
  const opening = new Map<string, { csv: Uint8Array; xml: Uint8Array }>(),
    reports: ColoradoReportedIeReport[] = [];
  let registry: ColoradoRegisteredReporter[] = [];
  for (const phase of ["opening", "closing"]) {
    for (const [i, jurisdiction] of [
      "All Counties",
      "STATEWIDE",
      "FEDERAL",
    ].entries()) {
      const data = await exports(sequence, `${phase}_ie_${i + 1}`, ieUrl, {
        jurisdiction,
        startDate,
        endDate,
        registry: false,
      });
      const report = parseColoradoIndependentExpenditureReport({
        ...data,
        startDate,
        endDate,
      });
      check(
        coloradoReportedNameKey(report.jurisdiction) ===
          coloradoReportedNameKey(jurisdiction),
        "native_ie_jurisdiction_scope",
      );
      if (phase === "opening") {
        opening.set(jurisdiction, data);
        reports.push(report);
      } else
        check(
          canonicalXml(opening.get(jurisdiction)!.xml) ===
            canonicalXml(data.xml),
          "native_ie_closing_population_changed",
        );
    }
    const data = await exports(sequence, `${phase}_registry`, registryUrl, {
      jurisdiction: "STATEWIDE",
      startDate: "1900-01-01",
      endDate,
      registry: true,
    });
    const rows = parseColoradoIeReporterRegistry(data);
    const registryScope = html(data.xml, undefined, true).documentElement;
    check(
      registryScope.getAttribute("JurisdictionSelection") === "STATEWIDE" &&
        registryScope.getAttribute("OfficeSelection") ===
          "Independent Expenditure Committee" &&
        registryScope.getAttribute("ActiveOnlySelection") ===
          `All Statuses on ${new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(endDate))}`,
      "native_registry_filter_scope",
    );
    if (phase === "opening") {
      opening.set("registry", data);
      registry = rows;
    } else
      check(
        canonicalXml(opening.get("registry")!.xml) === canonicalXml(data.xml),
        "native_registry_closing_population_changed",
      );
  }
  return {
    electionYear: sequence.manifest.year,
    startDate,
    endDate,
    reports,
    registry,
  };
}
async function candidateProtocol(
  sequence: ColoradoTracerObservations,
  expected: ColoradoIeCandidateIdentity,
) {
  let opening: ColoradoNativeCandidateProof | undefined;
  for (const phase of ["opening", "closing"]) {
    const catalog = await sequence.request(
        `${phase}_catalog`,
        COLORADO_TRACER_REPORTS,
      ),
      navigation = html(catalog.bytes, catalog.url);
    const url = nativeLink(navigation, "Committee Search", catalog.url),
      page = await sequence.request(`${phase}_search_form`, url),
      doc = html(page.bytes, page.url),
      parent = form(doc),
      values = controls(parent);
    select(doc, "_ctl0_Content_ddlJurisdiction", "STATEWIDE", values);
    const selector = input(doc, "_ctl0_Content_txtCommitteeID"),
      submit = input(doc, "_ctl0_Content_btnSearch");
    values.set(selector.name, expected.receivingId);
    values.set(submit.name, submit.value);
    const detail = await sequence.request(
      `${phase}_profile`,
      action(parent, page.url),
      values,
    );
    check(
      new URL(detail.url).pathname ===
        "/PublicSite/SearchPages/CandidateDetail.aspx",
      "native_candidate_detail_action",
    );
    const proof = qualifyColoradoNativeCandidateProfile(detail.bytes, expected);
    if (!opening) opening = proof;
    else
      check(
        isDeepStrictEqual(opening, proof),
        "native_candidate_identity_changed",
      );
  }
  if (coloradoIeNativeDistrict(expected)) {
    const peers = await legislativePeerProtocol(sequence, opening!);
    return {
      expected: { ...expected },
      identity: {
        ...opening!,
        peerCandidateCount: peers.length,
        peerCampaignCount: peers.reduce((n, p) => n + p.campaigns.length, 0),
      },
      peers,
    };
  }
  return { expected: { ...expected }, identity: opening! };
}

/** The source's all-years/all-status family census supplies every possible
 * native candidate ID. Each record action stays bound to its own saved page. */
async function legislativePeerProtocol(
  sequence: ColoradoTracerObservations,
  primary: ColoradoNativeCandidateProof,
): Promise<ColoradoNativePeerProfile[]> {
  const catalog = await sequence.request(
      "peer_catalog",
      COLORADO_TRACER_REPORTS,
    ),
    navigation = html(catalog.bytes, catalog.url),
    url = nativeLink(navigation, "Candidate Search", catalog.url);
  const rawFamily = primary.candidateName.includes(",")
    ? primary.candidateName.split(",")[0]!
    : primary.candidateName.replace(/\([^()]*\)/gu, "");
  const tokens = rawFamily
      .normalize("NFKC")
      .toUpperCase()
      .replace(/\b(?:JR|SR|II|III|IV)\b/gu, " ")
      .match(/[A-Z0-9]+/gu),
    family = tokens?.at(-1);
  check(family && family.length <= 100, "native_peer_family_scope");
  const stable = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
  const actionUrl = (
    parent: HTMLFormElement,
    base: string,
    action: ColoradoNativePostback,
  ) => {
    const target = coloradoSourceUrl(
      action.action || parent.getAttribute("action") || base,
      base,
    );
    check(
      target.pathname === "/PublicSite/SearchPages/CandidateSearch.aspx",
      "native_peer_action_scope",
    );
    return target.href;
  };
  let openingRows: unknown[] | undefined,
    openingProfiles: ColoradoNativePeerProfile[] | undefined;
  for (const phase of ["opening", "closing"]) {
    const response = await sequence.request(`${phase}_peer_form`, url),
      doc = html(response.bytes, response.url),
      parent = form(doc),
      values = controls(parent);
    for (const [id, label] of [
      ["lstElectionYear", "Select all years..."],
      ["ddlStatus", "Select all statuses..."],
      ["ddlParty_ucddlParty", "Select all parties..."],
      ["ddlJurisdiction", "Select all jurisdictions..."],
    ])
      select(doc, `_ctl0_Content_${id}`, label!, values);
    const contains = [
      ...parent.querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ].filter(
      (e) =>
        e.name.includes("rblLastNameSearchType") &&
        [...doc.querySelectorAll("label")].some(
          (l) =>
            l.getAttribute("for") === e.id &&
            /contains/iu.test(l.textContent ?? ""),
        ),
    );
    check(contains.length === 1, "native_peer_contains_control");
    values.set(contains[0]!.name, contains[0]!.value);
    values.set(input(doc, "_ctl0_Content_txtLastName").name, family!);
    for (const id of ["txtFirstName", "txtCandidateID"])
      values.set(input(doc, `_ctl0_Content_${id}`).name, "");
    const submit = input(doc, "_ctl0_Content_btnSearch");
    values.set(submit.name, submit.value);
    let result = await sequence.request(
      `${phase}_peer_search`,
      action(parent, response.url),
      values,
    );
    const census: unknown[] = [],
      seenRows = new Set<string>(),
      profiles = new Map<string, ColoradoNativePeerProfile>(),
      records: { row: ColoradoNativePeerGridRow; page: typeof result }[] = [];
    if (html(result.bytes).getElementById("_ctl0_Content_lblCandidateID")) {
      const profile = parseColoradoNativePeerProfile(result.bytes);
      profiles.set(profile.candidateId, profile);
    } else {
      for (let page = 1; ; page++) {
        check(page <= 100, "native_peer_page_budget");
        const parsed = parseColoradoNativePeerGrid(result.bytes, page);
        for (const row of parsed.rows) {
          const { action: ignored, ...identity } = row;
          void ignored;
          const key = JSON.stringify(identity);
          check(!seenRows.has(key), "native_peer_duplicate_grid_row");
          seenRows.add(key);
          census.push(identity);
          records.push({ row, page: result });
        }
        if (!parsed.next) break;
        const d = html(result.bytes, result.url),
          f = form(d),
          p = controls(f);
        p.set("__EVENTTARGET", parsed.next.target);
        p.set("__EVENTARGUMENT", parsed.next.argument);
        result = await sequence.request(
          `${phase}_peer_page_${page + 1}`,
          actionUrl(f, result.url, parsed.next),
          p,
        );
      }
      for (const record of records) {
        if (profiles.has(record.row.candidateId)) continue;
        const d = html(record.page.bytes, record.page.url),
          f = form(d),
          p = controls(f);
        p.set("__EVENTTARGET", record.row.action.target);
        p.set("__EVENTARGUMENT", record.row.action.argument);
        const profileReply = await sequence.request(
            `${phase}_peer_profile_${profiles.size}`,
            actionUrl(f, record.page.url, record.row.action),
            p,
          ),
          profile = parseColoradoNativePeerProfile(profileReply.bytes);
        check(
          new URL(profileReply.url).pathname ===
            "/PublicSite/SearchPages/CandidateDetail.aspx" &&
            profile.candidateId === record.row.candidateId,
          "native_peer_record_identifier",
        );
        profiles.set(profile.candidateId, profile);
      }
      for (const { row } of records) {
        const profile = profiles.get(row.candidateId)!;
        check(
          profile.campaigns.some(
            (c) =>
              c.cycleYear === row.electionYear &&
              coloradoIePersonMatches(c.candidateName, row.candidateName) &&
              coloradoPartyKey(c.party) === coloradoPartyKey(row.party) &&
              coloradoReportedNameKey(c.jurisdiction) ===
                coloradoReportedNameKey(row.jurisdiction) &&
              coloradoReportedNameKey(c.officeName) ===
                coloradoReportedNameKey(row.officeName) &&
              coloradoReportedNameKey(c.districtName) ===
                coloradoReportedNameKey(row.districtName) &&
              coloradoReportedNameKey(c.status) ===
                coloradoReportedNameKey(row.campaignStatus),
          ),
          "native_peer_grid_campaign_binding",
        );
      }
    }
    check(profiles.has(primary.candidateId), "native_peer_primary_missing");
    const primaryProfile = profiles.get(primary.candidateId)!;
    check(
      primaryProfile.receivingId === primary.receivingId &&
        coloradoIePersonMatches(
          primaryProfile.candidateName,
          primary.candidateName,
        ) &&
        primaryProfile.campaigns.some(
          (c) =>
            c.cycleYear === primary.cycleYear &&
            c.cycleStart === primary.cycleStart &&
            c.cycleEnd === primary.cycleEnd &&
            coloradoReportedNameKey(c.officeName) ===
              coloradoReportedNameKey(primary.nativeOfficeName!) &&
            coloradoReportedNameKey(c.districtName) ===
              coloradoReportedNameKey(primary.districtName!) &&
            coloradoPartyKey(c.party) === primary.party,
        ),
      "native_peer_primary_cycle_binding",
    );
    const fullProfiles = [...profiles.values()].sort((a, b) =>
      a.candidateId.localeCompare(b.candidateId),
    );
    for (const p of fullProfiles)
      p.campaigns.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    if (!openingProfiles) {
      openingRows = census;
      openingProfiles = fullProfiles;
    } else
      check(
        isDeepStrictEqual(stable(openingRows!), stable(census)) &&
          isDeepStrictEqual(openingProfiles, fullProfiles),
        "native_peer_closing_population_changed",
      );
  }
  return openingProfiles!;
}
async function facts(
  sequence: ColoradoTracerObservations,
): Promise<ColoradoSourceFacts> {
  const raw = await coloradoPrivateOriginal(
      resolve(sequence.directory, "manifest.json"),
      8 * 1024 * 1024,
    ),
    records = sequence.manifest.records;
  return {
    packetDirectory: basename(sequence.directory),
    observedAt: records[0]!.startedAt,
    completedAt: records.at(-1)!.completedAt,
    manifestSha256: coloradoOriginalSha(raw),
    originals: records.map((r) => ({
      file: r.file,
      sha256: r.sha256,
      bytes: r.bytes,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    })),
  };
}
async function source<T extends object>(
  input: Options & {
    kind: "ie" | "candidate" | "legislative-candidate";
    year: number;
    run: (sequence: ColoradoTracerObservations) => Promise<T>;
    verified: WeakSet<object>;
  },
): Promise<Readonly<T & { source: ColoradoSourceFacts }>> {
  check(isColoradoReportedIeEnabled(), "colorado_reported_ie_disabled");
  const root = resolve(input.cacheDir ?? CACHE);
  if (!input.refresh) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ColoradoReportError("native_cache_unavailable");
    }
    const candidates: {
      directory: string;
      manifest: ColoradoObservationManifest;
      first: string;
    }[] = [];
    for (const entry of entries) {
      if (!/^packet-[a-f0-9-]{36}$/u.test(entry)) continue;
      try {
        const directory = resolve(root, entry),
          raw = await coloradoPrivateOriginal(
            resolve(directory, "manifest.json"),
            8 * 1024 * 1024,
          ),
          manifest = JSON.parse(
            raw.toString("utf8"),
          ) as ColoradoObservationManifest;
        if (
          manifest.kind === input.kind &&
          manifest.year === input.year &&
          manifest.complete &&
          manifest.records?.length
        )
          candidates.push({
            directory,
            manifest,
            first: manifest.records[0]!.startedAt,
          });
      } catch {
        /* Partial observations are retained, never interpreted as absence. */
      }
    }
    for (const candidate of candidates.sort((a, b) =>
      b.first.localeCompare(a.first),
    )) {
      try {
        const sequence = await ColoradoTracerObservations.reopen(
            candidate.directory,
            candidate.manifest,
          ),
          data = await input.run(sequence);
        await sequence.finish();
        const packet = { ...data, source: await facts(sequence) };
        freeze(packet);
        input.verified.add(packet);
        return packet;
      } catch {
        /* Revalidate every original and exact native request before reuse. */
      }
    }
  }
  check(
    isColoradoReportedIeRawRefreshEnabled(),
    "native_ie_source_unavailable",
  );
  const sequence = await ColoradoTracerObservations.create(
      root,
      input.kind,
      input.year,
      input.fetchFn,
    ),
    data = await input.run(sequence);
  await sequence.finish();
  const packet = { ...data, source: await facts(sequence) };
  freeze(packet);
  input.verified.add(packet);
  return packet;
}
export async function getColoradoIeDataset(
  input: Options & { electionYear: number },
): Promise<ColoradoIeDataset> {
  check(
    Number.isSafeInteger(input.electionYear) &&
      input.electionYear >= 2022 &&
      input.electionYear <= 2100,
    "native_source_year",
  );
  return source({
    ...input,
    kind: "ie",
    year: input.electionYear,
    run: globalProtocol,
    verified: verifiedDatasets,
  });
}
export async function getColoradoIeCandidateSource(
  input: Options & { expected: ColoradoIeCandidateIdentity },
): Promise<ColoradoIeCandidateSource> {
  check(
    /^[1-9]\d{0,19}$/u.test(input.expected.receivingId) &&
      Number.isSafeInteger(input.expected.electionYear) &&
      typeof input.expected.party === "string" &&
      input.expected.party.trim().length > 0 &&
      typeof input.expected.candidateName === "string" &&
      input.expected.candidateName.trim().length > 0,
    "native_candidate_expected_scope",
  );
  return source({
    ...input,
    kind: coloradoIeNativeDistrict(input.expected)
      ? "legislative-candidate"
      : "candidate",
    year: input.expected.electionYear,
    run: (sequence) => candidateProtocol(sequence, input.expected),
    verified: verifiedCandidates,
  });
}

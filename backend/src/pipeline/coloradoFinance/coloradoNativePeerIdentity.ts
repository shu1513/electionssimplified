import { createRequire } from "node:module";
import {
  ColoradoReportError,
  coloradoReportDate,
  coloradoReportedNameKey,
  type ColoradoReportedTarget,
} from "./coloradoTracerReports.js";
import {
  coloradoIePersonMatches,
  coloradoPartyKey,
} from "./coloradoNativeCandidateIdentity.js";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    source: string,
    options: { virtualConsole: unknown },
  ) => { window: { document: Document } };
  VirtualConsole: new () => unknown;
};
const check = (value: unknown, code: string): void => {
  if (!value) throw new ColoradoReportError(code);
};
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
const key = coloradoReportedNameKey;
function document(bytes: Uint8Array): Document {
  check(
    bytes.length > 0 && bytes.length <= 32 * 1024 * 1024,
    "native_peer_document_size",
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ColoradoReportError("invalid_native_peer_utf8");
  }
  check(!/[\u0000\uFFFD]/u.test(text), "invalid_native_peer_characters");
  return new JSDOM(text, { virtualConsole: new VirtualConsole() }).window
    .document;
}
export type ColoradoNativePostback = {
  target: string;
  argument: string;
  action: string | null;
};
/** Parse only the two observed literal ASP.NET action grammars. Never execute
 * source JavaScript, accept expressions, or guess an event target. */
export function parseColoradoNativePostback(
  raw: string,
): ColoradoNativePostback {
  check(raw.length > 0 && raw.length <= 4096, "native_postback_size");
  const simple = /^javascript:__doPostBack\('([^'\\]*)','([^'\\]*)'\)$/u.exec(
    raw,
  );
  if (simple) {
    check(simple[1]!.length > 0, "native_postback_target");
    return { target: simple[1]!, argument: simple[2]!, action: null };
  }
  const head =
      "javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions(",
    tail = "))";
  check(raw.startsWith(head) && raw.endsWith(tail), "native_postback_framing");
  const source = raw.slice(head.length, -tail.length),
    values: (string | boolean)[] = [];
  let i = 0;
  while (i < source.length) {
    while (/\s/u.test(source[i] ?? "")) i++;
    const quote = source[i];
    if (quote === '"' || quote === "'") {
      const start = ++i;
      while (i < source.length && source[i] !== quote) {
        check(source[i] !== "\\", "native_postback_escape");
        i++;
      }
      check(i < source.length, "native_postback_quote");
      values.push(source.slice(start, i++));
    } else {
      const start = i;
      while (i < source.length && source[i] !== ",") i++;
      const value = source.slice(start, i).trim();
      check(value === "true" || value === "false", "native_postback_boolean");
      values.push(value === "true");
    }
    while (/\s/u.test(source[i] ?? "")) i++;
    if (i < source.length) {
      check(
        source[i] === "," && i + 1 < source.length,
        "native_postback_separator",
      );
      i++;
    }
  }
  check(
    values.length === 7 &&
      typeof values[0] === "string" &&
      typeof values[1] === "string" &&
      typeof values[2] === "boolean" &&
      typeof values[3] === "string" &&
      typeof values[4] === "string" &&
      typeof values[5] === "boolean" &&
      values[6] === true &&
      values[0].length > 0,
    "native_postback_options",
  );
  return {
    target: values[0] as string,
    argument: values[1] as string,
    action: (values[4] as string) || null,
  };
}
export type ColoradoNativePeerGridRow = {
  candidateName: string;
  party: string;
  electionYear: number;
  jurisdiction: string;
  officeName: string;
  districtName: string;
  campaignStatus: string;
  candidateStatus: string;
  candidateId: string;
  action: ColoradoNativePostback;
};
export function parseColoradoNativePeerGrid(
  bytes: Uint8Array,
  expectedPage: number,
) {
  const doc = document(bytes),
    table = doc.getElementById(
      "_ctl0_Content_dgdSearchResults",
    ) as HTMLTableElement | null;
  check(table?.tagName === "TABLE", "native_peer_grid_missing");
  const headers = [...table!.querySelectorAll("th")].map((e) =>
    clean(e.textContent ?? "")
      .replace(/[▲▼]/gu, "")
      .trim(),
  );
  check(
    JSON.stringify(headers) ===
      JSON.stringify([
        "Candidate Name",
        "Party",
        "Election Year",
        "Jurisdiction",
        "Office",
        "District",
        "Campaign Status",
        "Candidate Status",
        "Candidate ID",
      ]),
    "native_peer_grid_headers",
  );
  const rows: ColoradoNativePeerGridRow[] = [];
  let pager: HTMLTableRowElement | undefined;
  for (const row of [...table!.rows]) {
    if (row.querySelector("th")) continue;
    if (row.cells.length === 1 && row.cells[0]!.colSpan === 9) {
      check(!pager, "native_peer_multiple_pagers");
      pager = row;
      continue;
    }
    check(row.cells.length === 9, "native_peer_grid_columns");
    const values = [...row.cells].map((c) => clean(c.textContent ?? "")),
      actions = [...row.cells[0]!.querySelectorAll("a[href]")];
    check(
      actions.length === 1 &&
        /^[1-9]\d{0,19}$/u.test(values[8]!) &&
        /^(?:19|20)\d{2}$/u.test(values[2]!) &&
        values[0] &&
        values[4],
      "native_peer_grid_row",
    );
    rows.push({
      candidateName: values[0]!,
      party: values[1]!,
      electionYear: Number(values[2]),
      jurisdiction: values[3]!,
      officeName: values[4]!,
      districtName: values[5]!,
      campaignStatus: values[6]!,
      candidateStatus: values[7]!,
      candidateId: values[8]!,
      action: parseColoradoNativePostback(actions[0]!.getAttribute("href")!),
    });
  }
  check(rows.length > 0 && rows.length <= 10, "native_peer_grid_population");
  let next: ColoradoNativePostback | null = null;
  if (pager) {
    const selected = [...pager.querySelectorAll("span")].filter((s) =>
      /^\d+$/u.test(clean(s.textContent ?? "")),
    );
    check(
      selected.length === 1 &&
        Number(selected[0]!.textContent) === expectedPage,
      "native_peer_page_order",
    );
    const links = [...pager.querySelectorAll("a[href]")],
      numericNext = links.filter(
        (a) => clean(a.textContent ?? "") === String(expectedPage + 1),
      );
    check(numericNext.length <= 1, "native_peer_next_page_ambiguous");
    const forwardBlock = links.filter(
      (a) =>
        clean(a.textContent ?? "") === "..." &&
        (selected[0]!.compareDocumentPosition(a) & 4) !== 0,
    );
    check(forwardBlock.length <= 1, "native_peer_next_block_ambiguous");
    const action = numericNext[0] ?? forwardBlock[0];
    if (action)
      next = parseColoradoNativePostback(action.getAttribute("href")!);
    else
      check(
        !links.some(
          (a) =>
            /^\d+$/u.test(clean(a.textContent ?? "")) &&
            Number(a.textContent) > expectedPage,
        ),
        "native_peer_page_gap",
      );
  } else check(expectedPage === 1, "native_peer_missing_pager");
  return { rows, next };
}
export type ColoradoNativePeerCampaign = {
  candidateName: string;
  cycleYear: number;
  cycleStart: string;
  cycleEnd: string;
  party: string;
  jurisdiction: string;
  officeName: string;
  districtName: string;
  status: string;
};
export type ColoradoNativePeerProfile = {
  candidateId: string;
  candidateName: string;
  receivingId: string | null;
  receivingName: string | null;
  committeeType: string | null;
  party: string;
  officeName: string;
  jurisdiction: string;
  candidateStatus: string;
  receivingStatus: string | null;
  campaigns: ColoradoNativePeerCampaign[];
};
export function parseColoradoNativePeerProfile(
  bytes: Uint8Array,
): ColoradoNativePeerProfile {
  const doc = document(bytes),
    field = (suffix: string) => {
      const element = doc.getElementById(`_ctl0_Content_${suffix}`);
      check(element, "missing_native_peer_field");
      return clean(element!.textContent ?? "");
    };
  // Historical native profiles can omit the entire receiving panel. Their
  // candidate ID and campaign dates still constrain attribution; the current
  // candidate's separate qualifier requires its receiving hard ID.
  const optionalField = (suffix: string) => {
    const element = doc.getElementById(`_ctl0_Content_${suffix}`);
    return element ? clean(element.textContent ?? "") : null;
  };
  const candidateId = field("lblCandidateID"),
    receivingId = optionalField("lblCommitteeID"),
    table = doc.getElementById(
      "_ctl0_Content_dgdCampaigns",
    ) as HTMLTableElement | null;
  check(
    /^[1-9]\d{0,19}$/u.test(candidateId) &&
      (receivingId === null || /^[1-9]\d{0,19}$/u.test(receivingId)),
    "native_peer_identifiers",
  );
  check(table?.tagName === "TABLE", "native_peer_campaign_inventory");
  check(
    JSON.stringify(
      [...table!.querySelectorAll("th")].map((e) => clean(e.textContent ?? "")),
    ) ===
      JSON.stringify([
        "Candidate/Committee",
        "Election Cycle",
        "Party Affiliation",
        "Jurisdiction",
        "Office",
        "District",
        "Status",
      ]),
    "native_peer_campaign_headers",
  );
  const campaigns: ColoradoNativePeerCampaign[] = [];
  for (const row of [...table!.rows].filter((r) => !r.querySelector("th"))) {
    check(row.cells.length === 7, "native_peer_campaign_columns");
    const values = [...row.cells].map((c) => clean(c.textContent ?? "")),
      year = /^(\d{4})\b/u.exec(values[1]!),
      dates = values[1]!.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/gu);
    check(year && dates?.length === 2, "native_peer_campaign_dates");
    const cycleStart = coloradoReportDate(dates![0]!),
      cycleEnd = coloradoReportDate(dates![1]!);
    check(
      cycleStart <= cycleEnd &&
        Number(cycleEnd.slice(0, 4)) === Number(year![1]) &&
        values[0] &&
        values[3] &&
        values[4] &&
        values[6],
      "native_peer_campaign_scope",
    );
    campaigns.push({
      candidateName: values[0]!,
      cycleYear: Number(year![1]),
      cycleStart,
      cycleEnd,
      party: values[2]!,
      jurisdiction: values[3]!,
      officeName: values[4]!,
      districtName: values[5]!,
      status: values[6]!,
    });
  }
  check(
    campaigns.length > 0 && campaigns.length <= 100,
    "native_peer_campaign_population",
  );
  return {
    candidateId,
    candidateName: field("lblCandName"),
    receivingId,
    receivingName: optionalField("lblCommName"),
    committeeType: optionalField("lblCommitteeType"),
    party: field("lblCandParty"),
    officeName: field("lblCandOffice"),
    jurisdiction: field("lblCandJurisdiction"),
    candidateStatus: field("lblCandStatus"),
    receivingStatus: optionalField("lblCommStatus"),
    campaigns,
  };
}
/** Historical terminated campaigns still constrain attribution inside their
 * published financial dates. Missing party information cannot exclude a peer. */
export function coloradoTargetHasUniqueNativeCycle(input: {
  target: ColoradoReportedTarget;
  date: string;
  profiles: readonly ColoradoNativePeerProfile[];
  candidateId: string;
  cycleYear: number;
  party: string;
  officeName: string;
  districtName: string;
}): boolean {
  const { target } = input,
    party = coloradoPartyKey(input.party);
  if (
    !target.name ||
    !party ||
    coloradoPartyKey(target.party) !== party ||
    key(target.office) !== key(input.officeName)
  )
    return false;
  const matches = input.profiles.flatMap((p) =>
    p.campaigns
      .filter(
        (c) =>
          (coloradoIePersonMatches(p.candidateName, target.name!) ||
            coloradoIePersonMatches(c.candidateName, target.name!)) &&
          key(c.officeName) === key(target.office) &&
          (!coloradoPartyKey(c.party) || coloradoPartyKey(c.party) === party) &&
          c.cycleStart <= input.date &&
          c.cycleEnd >= input.date,
      )
      .map((c) => ({ p, c })),
  );
  return (
    matches.length === 1 &&
    matches[0]!.p.candidateId === input.candidateId &&
    matches[0]!.c.cycleYear === input.cycleYear &&
    key(matches[0]!.c.districtName) === key(input.districtName) &&
    coloradoPartyKey(matches[0]!.c.party) === party &&
    key(matches[0]!.c.jurisdiction) === "STATEWIDE"
  );
}

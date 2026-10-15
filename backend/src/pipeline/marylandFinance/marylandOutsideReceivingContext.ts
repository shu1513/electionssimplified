import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  decodeMarylandPublishedFilingCycles,
  type MarylandCurrentCycleCapture,
} from "./marylandCurrentCycleExportClient.js";
import {
  readMarylandPublicCommitteeCapture,
  validateMarylandPublicCommitteeRequest,
  marylandPublicCommitteeOccurrenceKey,
  type MarylandPublicCommitteeCapture,
} from "./marylandPublicCommitteeClient.js";
const norm = (v: string) => v.replace(/\s+/g, " ").trim();
function text(v: string) {
  return norm(
    v
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"'),
  );
}
const fail = (): never => {
  throw Error("invalid_receiving_context_source");
};
function structuralHtml(html: string) {
  if (typeof html !== "string" || !html.trim() || html.length > 4 * 1024 * 1024)
    return fail();
  const masked = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  if (/<!--|<(?:script|style)\b/i.test(masked)) return fail();
  return masked;
}
/** Only the actual2026 General Governor block; contacts/other dl fields excluded. */
export function parseMaryland2026GovernorRoster(html: string) {
  html = structuralHtml(html);
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
    text(m[1]!),
  );
  if (
    h1.filter(
      (t) => t === "2026 Gubernatorial General Election State Candidates List",
    ).length !== 1
  )
    return fail();
  const sections = [
    ...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi),
  ].map((m) => m[1]!);
  const selected = sections.filter((s) => {
    const summaries = [
      ...s.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi),
    ];
    return (
      summaries.length === 1 &&
      text(summaries[0]![1]!) === "Governor / Lt. Governor"
    );
  });
  if (selected.length !== 1) return fail();
  const section = selected[0]!,
    headings = [...section.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  if (!headings.length) return fail();
  const candidates: {
    candidateName: string;
    party: string;
    committeeName: string | null;
    relatedTo: string | null;
  }[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!,
      start = h.index! + h[0].length,
      end = headings[i + 1]?.index ?? section.length,
      segment = section.slice(start, end);
    const opening = /<div\b[^>]*\bclass=["']candidate["'][^>]*>/i.exec(segment);
    if (!opening) return fail();
    const party = text(segment.slice(0, opening.index));
    if (!party) return fail();
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = opening.index;
    let depth = 0,
      closed = -1;
    let m: RegExpExecArray | null;
    while ((m = tags.exec(segment))) {
      depth += /^<\/div/i.test(m[0]) ? -1 : 1;
      if (depth === 0) {
        closed = m.index;
        break;
      }
    }
    if (closed < 0) return fail();
    const block = segment.slice(opening.index + opening[0].length, closed);
    const terms = [
      ...block.matchAll(
        /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
      ),
    ];
    const committees = terms.filter((t) => text(t[1]!) === "Committee Name");
    const candidateName = text(h[1]!),
      related = /^(.+) - Related to (.+)$/.exec(candidateName);
    if (
      committees.length !== 1 &&
      !(
        committees.length === 0 &&
        related &&
        candidates.some(
          (c) =>
            c.candidateName === related[2] &&
            c.party === party &&
            c.committeeName !== null,
        )
      )
    )
      return fail();
    const committeeName =
      committees.length === 1 ? text(committees[0]![2]!) : null;
    if (!candidateName || committeeName === "") return fail();
    candidates.push(
      Object.freeze({
        candidateName,
        party,
        committeeName,
        relatedTo: related?.[2] ?? null,
      }),
    );
  }
  return Object.freeze({
    electionYear: 2026 as const,
    electionStage: "general" as const,
    officeHeading: "Governor / Lt. Governor" as const,
    candidates: Object.freeze(candidates),
  });
}

export type MarylandReceivingCanonicalContext = Readonly<{
  candidateId: string;
  electionId: string;
  linkId: string;
  candidateName: string;
  party: string;
  officeName: "Governor";
  state: "MD";
  districtId: string;
  canonicalDistrictId: string | null;
  districtType: "statewide";
  districtGeoidCompact: "24";
  officeScope: "statewide";
  electionYear: 2026;
  electionDate: "2026-11-03";
  electionStage: "general";
  candidateDeleted: boolean;
  candidateMerged: boolean;
  declared: boolean;
  linkActive: boolean;
  activeReceivingLinkCount: number;
}>;
type SourceCapture = MarylandCurrentCycleCapture<unknown, "POST" | "GET">;
const instant = (v: unknown): v is string =>
  typeof v === "string" &&
  !v.startsWith("0000") &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
async function body(
  c: SourceCapture,
  url: string,
  method: "POST" | "GET",
  requestBody: unknown,
) {
  if (
    c.url !== url ||
    c.method !== method ||
    JSON.stringify(c.requestBody) !== JSON.stringify(requestBody) ||
    c.httpStatus !== 200 ||
    c.bodyComplete !== true ||
    c.errorCode !== null ||
    !Number.isSafeInteger(c.byteCount) ||
    c.byteCount < 1 ||
    c.byteCount > 4 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(c.sha256) ||
    !instant(c.startedAt) ||
    !instant(c.completedAt) ||
    Date.parse(c.startedAt) > Date.parse(c.completedAt)
  )
    return fail();
  const info = await stat(c.outputPath);
  if (!info.isFile() || info.size !== c.byteCount) return fail();
  const raw = await readFile(c.outputPath);
  if (
    raw.length !== c.byteCount ||
    createHash("sha256").update(raw).digest("hex") !== c.sha256
  )
    return fail();
  return new TextDecoder("utf8", { fatal: true }).decode(raw);
}
async function registrations(
  captures: readonly MarylandPublicCommitteeCapture[],
  kind: "numeric" | "name",
) {
  if (!Array.isArray(captures) || !captures.length || captures.length > 40)
    return fail();
  const rows: Readonly<Record<string, unknown>>[] = [],
    seen = new Set<string>();
  let total: number | undefined,
    previousEnd = -Infinity,
    first:
      ReturnType<typeof validateMarylandPublicCommitteeRequest> | undefined;
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i]!,
      r = validateMarylandPublicCommitteeRequest(c.requestBody);
    if (
      r.pageNumber !== i + 1 ||
      Object.hasOwn(r, "filingEntityId") !== (kind === "numeric") ||
      Date.parse(c.startedAt) < previousEnd
    )
      return fail();
    previousEnd = Date.parse(c.completedAt);
    if (
      first &&
      JSON.stringify({ ...r, pageNumber: 1 }) !== JSON.stringify(first)
    )
      return fail();
    first ??= r;
    const page = await readMarylandPublicCommitteeCapture(c);
    if (total === undefined) {
      total = page.totalItems;
      if (Math.max(1, Math.ceil(total / 100)) !== captures.length)
        return fail();
    } else if (page.totalItems !== total) return fail();
    for (const row of page.rows) {
      const k = marylandPublicCommitteeOccurrenceKey(row);
      if (seen.has(k)) return fail();
      seen.add(k);
      rows.push(row);
    }
  }
  if (rows.length !== total) return fail();
  return { rows, request: first! };
}

/** Exact official definition-list role, separate from roster membership. */
export function parseMaryland2026GeneralElectionDate(html: string) {
  html = structuralHtml(html);
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(
    (m) => text(m[1]!),
  );
  if (
    headings.filter((h) => h === "Offices up for Election in 2026").length !== 1
  )
    return fail();
  const general = [
    ...html.matchAll(
      /<dt\b[^>]*>\s*General Election\s*<\/dt>\s*<dd\b[^>]*>\s*<dl\b[^>]*>([\s\S]*?)<\/dl>\s*<\/dd>/gi,
    ),
  ];
  if (general.length !== 1) return fail();
  const days = [
    ...general[0]![1]!.matchAll(
      /<dt\b[^>]*>\s*Election Day\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
    ),
  ];
  if (days.length !== 1) return fail();
  const literal = text(days[0]![1]!).replace(/&ndash;/g, "–");
  const m =
    /^(January|February|March|April|May|June|July|August|September|October|November|December) ([1-9]\d?), (2026) 7AM–8PM$/.exec(
      literal,
    );
  if (!m) return fail();
  const months = [
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
  ];
  const date = `${m[3]}-${String(months.indexOf(m[1]!) + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  if (
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    return fail();
  return Object.freeze({
    electionYear: 2026 as const,
    electionStage: "general" as const,
    electionDate: date,
    sourceElectionDay: literal,
  });
}
export type MarylandOutsideReceivingContextInput = {
  canonical: MarylandReceivingCanonicalContext & {
    committeeId: string;
    committeeName: string;
  };
  numericRegistration: { captures: readonly MarylandPublicCommitteeCapture[] };
  nameRegistration: { captures: readonly MarylandPublicCommitteeCapture[] };
  rosterCapture: MarylandCurrentCycleCapture<null, "GET">;
  dateCapture: MarylandCurrentCycleCapture<null, "GET">;
  cycleCapture: MarylandCurrentCycleCapture<null>;
};
/** Source receiving-account association only. Financial/expense dates remain unqualified. */
export async function bindMarylandOutsideReceivingContext(
  input: MarylandOutsideReceivingContextInput,
) {
  // Detach all source metadata/canonical values before the first await.
  try {
    const retained = structuredClone(input);
    const c = retained.canonical,
      id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      ![c.candidateId, c.electionId, c.linkId, c.districtId].every(
        (v) =>
          typeof v === "string" &&
          id.test(v) &&
          v !== "00000000-0000-0000-0000-000000000000",
      ) ||
      c.candidateName !== "Wes Moore" ||
      c.party !== "Democratic" ||
      c.officeName !== "Governor" ||
      c.state !== "MD" ||
      c.canonicalDistrictId !== null ||
      c.districtType !== "statewide" ||
      c.districtGeoidCompact !== "24" ||
      c.officeScope !== "statewide" ||
      c.electionYear !== 2026 ||
      c.electionDate !== "2026-11-03" ||
      c.electionStage !== "general" ||
      c.candidateDeleted !== false ||
      c.candidateMerged !== false ||
      c.declared !== true ||
      c.linkActive !== true ||
      c.activeReceivingLinkCount !== 1 ||
      typeof c.committeeId !== "string" ||
      !/^[1-9]\d*$/.test(c.committeeId) ||
      !Number.isSafeInteger(Number(c.committeeId)) ||
      c.committeeName !== "Moore, Wes For Maryland"
    )
      return fail();
    const numeric = await registrations(
        retained.numericRegistration.captures,
        "numeric",
      ),
      name = await registrations(retained.nameRegistration.captures, "name");
    if (
      numeric.request.filingEntityId !== Number(c.committeeId) ||
      name.request.filerName !== c.committeeName ||
      numeric.rows.length !== 1 ||
      name.rows.length !== 1
    )
      return fail();
    const a = numeric.rows[0]!,
      b = name.rows[0]!;
    const identityKeys = [
      "filerRegistrationGuid",
      "filingEntityId",
      "registrationDocumentGuid",
      "committeeName",
      "candidateName",
      "committeeType",
      "committeeTypeCode",
      "officeSought",
      "officeSoughtId",
      "jurisdiction",
      "jurisdictionId",
      "partyAffiliation",
      "accountStatus",
      "accountStatusCode",
      "electionYears",
      "electionCycleID",
      "electionTypeCodes",
      "elections",
      "registrationYear",
      "registrationSubmittalDate",
      "registrationApprovalDate",
      "registrationTerminatedDate",
      "lastRegistrationAmendedDate",
      "isActive",
    ];
    if (
      identityKeys.some((k) => a[k] !== b[k]) ||
      a.committeeName !== c.committeeName ||
      a.candidateName !== "MOORE, WESTLEY W." ||
      a.committeeType !== "Candidate" ||
      a.committeeTypeCode !== "CC" ||
      a.officeSought !== "Governor/Lieutenant Governor" ||
      a.partyAffiliation !== "Democrat" ||
      a.isActive !== true ||
      a.accountStatus !== "Active" ||
      a.accountStatusCode !== "FACT" ||
      a.registrationTerminatedDate !== null ||
      !(a.electionTypeCodes as string)
        .split(",")
        .map((v) => v.trim())
        .includes("GBRELEC") ||
      !(a.electionYears as string)
        .split(",")
        .map((v) => v.trim())
        .includes("2026")
    )
      return fail();
    const roster = parseMaryland2026GovernorRoster(
      await body(
        retained.rosterCapture,
        "https://elections.maryland.gov/elections/2026/general_candidates/2026_GG_statewide_candidatelist.html",
        "GET",
        null,
      ),
    );
    const selected = roster.candidates.filter(
      (r) =>
        r.candidateName === c.candidateName &&
        r.party === c.party &&
        r.committeeName === "Wes Moore For Maryland" &&
        r.relatedTo === null,
    );
    if (
      selected.length !== 1 ||
      roster.candidates.filter((r) => r.candidateName === c.candidateName)
        .length !== 1
    )
      return fail();
    const dates = parseMaryland2026GeneralElectionDate(
      await body(
        retained.dateCapture,
        "https://elections.maryland.gov/candidacy/ballot.html",
        "GET",
        null,
      ),
    );
    if (dates.electionDate !== c.electionDate) return fail();
    const cycle = decodeMarylandPublishedFilingCycles(
      JSON.parse(
        await body(
          retained.cycleCapture,
          "https://api-campaignfinance.maryland.gov/api/PublicLookup/GetAllFilingCycleList",
          "POST",
          null,
        ),
      ),
    ).defaultCycle;
    if (
      cycle.name !== "2023-2026" ||
      !(a.electionCycleID as string)
        .split(",")
        .map((v) => v.trim())
        .includes(cycle.value)
    )
      return fail();
    const sourceCaptures = [
      ...retained.numericRegistration.captures,
      ...retained.nameRegistration.captures,
      retained.rosterCapture,
      retained.dateCapture,
      retained.cycleCapture,
    ];
    const metadata = sourceCaptures.map((s) =>
      Object.freeze({
        url: s.url,
        method: s.method,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        sha256: s.sha256,
        byteCount: s.byteCount,
      }),
    );
    return {
      binding: Object.freeze({
        canonical: Object.freeze(c),
        filerRegistrationGuid: a.filerRegistrationGuid as string,
        filingEntityId: a.filingEntityId as number,
        officeSoughtId: a.officeSoughtId as number,
        sourceCommitteeName: a.committeeName as string,
        sourceCommitteeLabels: Object.freeze([
          a.committeeName as string,
          selected[0]!.committeeName!,
        ]),
        sourceOwnerName: a.candidateName as string,
        sourceParty: a.partyAffiliation as string,
        sourceElectionMembership: a.elections as string,
        sourceElectionYears: a.electionYears as string,
        sourceElectionTypeCodes: a.electionTypeCodes as string,
        sourceCycle: Object.freeze(cycle),
        committeeDisplayPolicy:
          "moore_complete_committee_label_pair_v1" as const,
        sourceMetadata: Object.freeze(metadata),
      }),
      diagnostics: [] as string[],
    };
  } catch {
    return {
      diagnostics: [
        "Maryland receiving account context unavailable or incompatible",
      ],
    };
  }
}

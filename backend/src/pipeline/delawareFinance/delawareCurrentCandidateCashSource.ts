import { createHash } from "node:crypto";
import type { DelawareCfrsCandidateSourcePacket } from "./delawareCfrsArtifactAcquisition.js";
import { bindDelawareCandidateFinancialFacts } from "./delawareCandidateFinancialBindings.js";
import { readDelawareCandidateFinancialReport } from "./delawareCandidateFinancialReport.js";
import {
  buildDelawareCommitteeSearchFields,
  isDelawareCfrsCaptureFieldAllowed,
  type DelawareCfrsResponseCapture,
} from "./delawareCfrsClient.js";
import { extractDelawareGridTotal } from "./delawareCfrsParsers.js";
import { decodeDelawareCompleteCommitteeRegistryPage } from "./delawareCfrsCompleteCommitteeRegistry.js";
import {
  decodeDelawareCandidateOwnerSource,
  decodeDelawareReportInventorySource,
  fingerprintDelawareThirdPartyOrganizationHtml,
  validateDelawareSourceCapturePacket,
  type DelawareOutsideCandidateScope,
} from "./delawareThirdPartyOutsideSource.js";
import {
  parseDelawareOfficialGeneralBallot,
  parseDelawareOfficialStatewideGeneralResult,
} from "./delawareOfficialElectionFacts.js";
import type { DelawareNativeLedgerRow } from "./delawareNativeLedger.js";

export type DelawareCurrentCashTarget = DelawareOutsideCandidateScope;
export type DelawareCurrentCashCampaignAuthority =
  | { kind: "new_account" }
  | {
      kind: "incumbent_same_office";
      before: { result: DelawareCfrsResponseCapture; ballot: DelawareCfrsResponseCapture };
      after: { result: DelawareCfrsResponseCapture; ballot: DelawareCfrsResponseCapture };
    };
export type DelawareVerifiedCommitteeDonor = {
  committeeId: string;
  committeeName: string;
  reportedContributorType: string;
  committeeType: "Political Action Committee" | "Political Committee";
  registeredCommitteeId: string | null;
  cashAmountCents: number;
  inKindAmountCents: number;
  contributionCount: number;
  sourceUrl: string;
};
export type DelawareCurrentCandidateCashInput = {
  target: DelawareCurrentCashTarget;
  campaignAuthority: DelawareCurrentCashCampaignAuthority;
  before: DelawareCfrsCandidateSourcePacket;
  after: DelawareCfrsCandidateSourcePacket;
  donorRegistryBefore: readonly DelawareCfrsResponseCapture[];
  donorRegistryAfter: readonly DelawareCfrsResponseCapture[];
};
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const display = (s: string) => s.replace(/\s+/gu, " ").trim();
const name = (s: string) => display(s).toUpperCase();
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && !Array.isArray(x) && typeof x === "object"
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const path = (c: DelawareCfrsResponseCapture) => new URL(c.url).pathname;
const text = (c: DelawareCfrsResponseCapture) =>
  new TextDecoder("utf-8", { fatal: true }).decode(c.body);
class DelawareCurrentCashSourceError extends Error {}
function fail(reason: string): never {
  throw new DelawareCurrentCashSourceError("Delaware current cash: " + reason);
}
function add(a: number, b: number) {
  const n = a + b;
  if (!Number.isSafeInteger(n)) fail("unsafe monetary sum");
  return n;
}
function civil(s: string) {
  if (
    !/^\d{4}-\d\d-\d\d$/.test(s) ||
    !Number.isFinite(Date.parse(s + "T00:00:00Z")) ||
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s
  )
    fail("invalid civil date");
  return s;
}
function usDate(s: string) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) fail("missing actual registration/origination date");
  return civil(`${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`);
}
function strip(s: string) {
  return display(
    s
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"'),
  );
}
function table(html: string, id: string) {
  const tables = [
    ...html.matchAll(
      new RegExp(`<table\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/table>`, "gi"),
    ),
  ];
  if (tables.length !== 1) fail("missing/ambiguous SO identity table");
  return [...tables[0]![1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((m) => {
    const values = [...m[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => strip(x[1]!));
    return values.length ? [values] : [];
  });
}
function label(html: string, key: string) {
  const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]!));
  const indexes = cells.flatMap((v, i) => (v === key ? [i] : []));
  if (indexes.length !== 1 || !cells[indexes[0]! + 1]) fail("missing/ambiguous SO source label");
  return cells[indexes[0]! + 1]!;
}
function metadata(c: DelawareCfrsResponseCapture) {
  return {
    url: c.url,
    sha256: c.sha256,
    byteCount: c.byteCount,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
  };
}
function owner(target: DelawareCurrentCashTarget) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (
    !uuid.test(target.candidateId) ||
    !uuid.test(target.electionId) ||
    target.electionStage !== "general" ||
    civil(target.electionDate).slice(0, 4) !== String(target.electionYear) ||
    !/^01\d{6}$/.test(target.receivingCfId) ||
    !Number.isSafeInteger(target.receivingMemberId) ||
    target.receivingMemberId <= 0 ||
    !target.candidateName.trim() ||
    !target.party.trim()
  )
    fail("invalid local/source target");
  if (target.officeName === "State Representative") {
    if (!target.district || !/^[1-9]\d*$/.test(target.district) || Number(target.district) > 41)
      fail("unsupported legislative seat");
  } else if (
    ![
      "Attorney General",
      "Governor",
      "Lieutenant Governor",
      "State Treasurer",
      "Insurance Commissioner",
      "Auditor of Accounts",
    ].includes(target.officeName) ||
    target.district !== null
  )
    fail("unsupported office/seat");
  return {
    cfId: target.receivingCfId,
    memberId: target.receivingMemberId,
    committeeName: target.receivingCommitteeName,
  };
}
function decodeOfficial(
  target: DelawareCurrentCashTarget,
  authority: { result: DelawareCfrsResponseCapture; ballot: DelawareCfrsResponseCapture },
) {
  for (const c of [authority.result, authority.ballot]) {
    const u = new URL(c.url);
    if (
      u.origin !== "https://elections.delaware.gov" ||
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      c.method !== "GET" ||
      c.financeFields !== null ||
      c.requestScopeRedacted !== false ||
      !Number.isSafeInteger(c.attempt) ||
      c.attempt < 1 ||
      c.status !== 200 ||
      hash(c.body) !== c.sha256 ||
      c.byteCount !== c.body.length ||
      c.body.length > 64 * 1024 * 1024 ||
      !Number.isFinite(Date.parse(c.startedAt)) ||
      !Number.isFinite(Date.parse(c.completedAt)) ||
      c.startedAt > c.completedAt
    )
      fail("invalid official election source");
  }
  // Only the independently sourced current 2026 / prior 2022 same-office case is approved here.
  if (
    target.electionYear !== 2026 ||
    target.officeName !== "Attorney General" ||
    target.district !== null ||
    new URL(authority.result.url).pathname !== "/reports/GE2022.html" ||
    !/^\/elections\/general\/sampleballots\/GE2026\/\d{2}-\d{2}\.html$/.test(
      new URL(authority.ballot.url).pathname,
    )
  )
    fail("unsupported official campaign authority");
  const result = parseDelawareOfficialStatewideGeneralResult({
    bytes: authority.result.body,
    electionYear: 2022,
    officeName: target.officeName,
  });
  const ballot = parseDelawareOfficialGeneralBallot({
    bytes: authority.ballot.body,
    electionYear: 2026,
    officeName: target.officeName,
  });
  if (
    name(result.winner.candidateName) !== name(target.candidateName) ||
    name(result.winner.party) !== name(target.party + " Party") ||
    ballot.electionDate !== target.electionDate ||
    ballot.candidates.filter(
      (c) =>
        name(c.candidateName) === name(target.candidateName) &&
        name(c.party) === name(target.party + " Party"),
    ).length !== 1
  )
    fail("official same-office winner/ballot mismatch");
  return { result, ballot };
}
function qualifyOfficial(
  target: DelawareCurrentCashTarget,
  authority: DelawareCurrentCashCampaignAuthority,
) {
  if (authority.kind === "new_account") return null;
  const before = decodeOfficial(target, authority.before),
    after = decodeOfficial(target, authority.after);
  const relevant = (p: typeof before) => ({
    winner: p.result.winner,
    candidates: p.result.candidates,
    electionDate: p.result.electionDate,
    ballotCandidates: p.ballot.candidates,
    ballotDate: p.ballot.electionDate,
    office: p.ballot.officeName,
  });
  if (!same(relevant(before), relevant(after))) fail("changed official candidacy authority");
  return {
    start: "2023-01-01",
    end: "2026-12-31",
    basis: "official_same_office_winner_and_current_ballot",
    sources: [
      authority.before.result,
      authority.before.ballot,
      authority.after.result,
      authority.after.ballot,
    ].map(metadata),
  };
}
function sourceGroups(packet: DelawareCfrsCandidateSourcePacket) {
  const caps = packet.sourceCaptures;
  validateDelawareSourceCapturePacket(caps);
  const searches = caps.flatMap((c, i) =>
    path(c) === "/Public/ViewFiledReports" && c.method === "POST" ? [i] : [],
  );
  const receipts = caps.findIndex((c) => path(c) === "/Public/ViewReceiptsMain");
  const expenses = caps.findIndex((c) => path(c) === "/Public/ViewExpenses");
  if (
    searches.length !== 2 ||
    searches[0]! >= searches[1]! ||
    searches[1]! >= receipts ||
    receipts >= expenses
  )
    fail("packet operation boundaries missing");
  return {
    owner: caps.filter((c) =>
      [
        "/Public/ViewCommittees",
        "/Public/Search",
        "/Public/_ViewCommittees",
        "/Public/ShowReview",
      ].includes(path(c)),
    ),
    inventory: caps.slice(searches[0], searches[1]),
    latest: caps.slice(searches[1], receipts).filter((c) => path(c) !== "/Public/FiledReports"),
    pdfs: caps.filter((c) => path(c) === "/Public/FiledReports"),
    receipts: caps.slice(receipts, expenses),
    expenses: caps.slice(expenses),
  };
}
async function phase(
  target: DelawareCurrentCashTarget,
  packet: DelawareCfrsCandidateSourcePacket,
  authority: ReturnType<typeof qualifyOfficial>,
) {
  const scope = owner(target),
    groups = sourceGroups(packet);
  const identity = decodeDelawareCandidateOwnerSource({ captures: groups.owner, owner: scope });
  const identities = identity.organizationHtml.map((html) => ({
    election: table(html, "Viewelection"),
    people: table(html, "CandidateList").map((r) => [r[0]]),
    origination: label(html, "Date of Origination:"),
  }));
  if (identities.some((i) => !same(i, identities[0])))
    fail("unequal unresolved SO candidacy identities");
  const election = identities[0]!.election,
    people = identities[0]!.people;
  if (
    election.length !== 1 ||
    election[0]!.length !== 5 ||
    election[0]![0] !== "State Office" ||
    election[0]![2] !== target.officeName ||
    election[0]![3] !==
      (target.district === null ? "-- Select District --" : "District " + target.district) ||
    election[0]![4] !== target.party ||
    people.length !== 1
  )
    fail("SO candidate office/seat/party mismatch");
  const person = display(people[0]![0]!).replace(/^(?:Ms\.|Mr\.|Mrs\.) /, "");
  const jennings =
    target.receivingCfId === "01004199" &&
    target.receivingMemberId === 458984 &&
    name(target.receivingCommitteeName) === "FRIENDS OF KATHY JENNINGS" &&
    name(target.candidateName) === "KATHY JENNINGS" &&
    person === "Kathleen Jennings" &&
    target.officeName === "Attorney General" &&
    target.party === "Democratic";
  if (name(person) !== name(target.candidateName) && !jennings)
    fail("SO candidate person mismatch");
  const inventory = decodeDelawareReportInventorySource({
    captures: groups.inventory,
    owner: scope,
  });
  const latest = decodeDelawareReportInventorySource({
    captures: groups.latest,
    owner: scope,
    current: true,
  });
  if (
    !same(inventory, packet.allVersionReportRows) ||
    !same(latest, packet.latestAccountReportRows)
  )
    fail("supplied report inventory mismatch");
  const window = authority ?? {
    start: usDate(identities[0]!.origination),
    end: `${target.electionYear}-12-31`,
    basis: "complete_new_account_current_candidacy",
    sources: [],
  };
  if (
    authority === null
      ? packet.queryScope.kind !== "whole_member" || packet.requestWindow !== null
      : packet.queryScope.kind !== "bounded_window" ||
        !same(packet.requestWindow, { start: window.start, end: window.end }) ||
        !same(packet.queryScope, { kind: "bounded_window", start: window.start, end: window.end })
  )
    fail("actual Member query scope does not cover qualified campaign");
  const selected = inventory.filter(
    (r) =>
      /^\d{4}$/.test(r.filingYear) &&
      Number(r.filingYear) >= Number(window.start.slice(0, 4)) &&
      Number(r.filingYear) <= target.electionYear,
  );
  if (
    !selected.length ||
    selected.some(
      (r) =>
        inventory.filter((x) => x.document!.filingCalendarId === r.document!.filingCalendarId)
          .length !== 1 ||
        !["Original Financial Statement", "Amended Financial Statement"].includes(r.reportName),
    )
  )
    fail("relevant current reports ambiguous/missing");
  if (
    authority === null &&
    (inventory.length !== 1 ||
      selected.length !== 1 ||
      !selected[0]!.filingPeriodName.includes(
        `General Election ${target.electionDate.slice(5, 7)}/${target.electionDate.slice(8)}/${target.electionYear}`,
      ) ||
      !(selected[0]!.office === "State Office - " + target.officeName ||
        (target.district !== null &&
          ["State Representative", "State Senator"].includes(target.officeName) &&
          selected[0]!.office === "State Office - " + target.officeName + " - District " + target.district)))
  )
    fail("new account whole-history candidacy not closed");
  const reports = await Promise.all(
    selected.map(async (r) => {
      const found = groups.pdfs.filter(
        (c) => new URL(c.url).searchParams.get("FileName") === r.document!.publicReportFileName,
      );
      if (found.length !== 1) fail("missing relevant PDF");
      return {
        facts: await readDelawareCandidateFinancialReport(found[0]!.body),
        pdfCapture: found[0]!,
      };
    }),
  );
  const bound = await bindDelawareCandidateFinancialFacts({
    owner: scope,
    reports,
    inventoryCaptures: groups.inventory,
    receipts: { ledger: packet.receipts, captures: groups.receipts },
    expenses: { ledger: packet.expenses, captures: groups.expenses },
  });
  const sorted = [...bound.reports].sort((a, b) =>
    a.facts.periodStart.localeCompare(b.facts.periodStart),
  );
  for (const [i, r] of sorted.entries()) {
    const previous = sorted[i - 1];
    if (
      r.facts.periodStart < window.start ||
      r.facts.periodEnd > window.end ||
      r.facts.periodStart > r.facts.periodEnd ||
      r.facts.reportDate < r.facts.periodEnd ||
      r.unsupportedMechanisms.length ||
      (previous &&
        (previous.facts.periodEnd >= r.facts.periodStart ||
          new Date(Date.parse(previous.facts.periodEnd + "T00:00:00Z") + 86400000)
            .toISOString()
            .slice(0, 10) !== r.facts.periodStart ||
          previous.facts.cover.endingBalanceCents !== r.facts.cover.beginningBalanceCents))
    )
      fail("incomplete/overlapping/unsupported current financial coverage");
  }
  if (
    sorted[0]!.facts.periodStart !== window.start ||
    latest[0]!.document!.publicReportFileName !==
      sorted.at(-1)!.inventoryRow.document!.publicReportFileName ||
    (authority === null && sorted[0]!.facts.cover.beginningBalanceCents !== 0)
  )
    fail("campaign beginning/current account pointer mismatch");
  for (const row of [...packet.receipts.rows, ...packet.expenses.rows])
    if (row.date < window.start || row.date > sorted.at(-1)!.facts.periodEnd)
      fail("native occurrence outside current qualified coverage");
  const proof = {
    target,
    window,
    ownerRegistry: identity.ownerRegistry,
    organizationFingerprints: identity.organizationHtml.map(
      fingerprintDelawareThirdPartyOrganizationHtml,
    ),
    inventory,
    reports: sorted.map((r) => ({
      fileName: r.inventoryRow.document!.publicReportFileName,
      calendarId: r.inventoryRow.document!.filingCalendarId,
      pdfSha256: r.facts.pdfSha256,
      periodStart: r.facts.periodStart,
      periodEnd: r.facts.periodEnd,
      cover: r.facts.cover,
      anonymous: r.aggregates,
    })),
    receiptFingerprint: packet.receipts.rawRowFingerprint,
    expenseFingerprint: packet.expenses.rawRowFingerprint,
  };
  return { proof, bound, sorted, groups, window };
}
function registry(caps: readonly DelawareCfrsResponseCapture[]) {
  validateDelawareSourceCapturePacket(caps);
  const searches = caps.filter((c) => path(c) === "/Public/Search" && c.method === "POST");
  const pages = caps.filter((c) => path(c) === "/Public/_ViewCommittees" && c.method === "POST");
  const fields = searches[0]?.financeFields;
  const expected = buildDelawareCommitteeSearchFields();
  // The client omits only excluded blank controls; retained safe selectors must be present.
  if (
    searches.length !== 1 ||
    !fields ||
    Object.entries(expected).some(
      ([k, v]) =>
        fields[k] !== v &&
        !(v === "" && !isDelawareCfrsCaptureFieldAllowed(k, v) && fields[k] === undefined),
    ) ||
    Object.entries(fields).some(([k, v]) => !Object.hasOwn(expected, k) && v !== "") ||
    !pages.length ||
    pages.length > 40
  )
    fail("donor registry scope missing");
  const count = extractDelawareGridTotal(text(searches[0]!));
  const rows: Record<string, unknown>[] = [];
  const seenPages = new Set<string>();
  pages.forEach((c, i) => {
    if (
      c.startedAt < searches[0]!.completedAt ||
      !same(c.financeFields, {
        page: String(i + 1),
        size: "500",
        orderBy: "",
        groupBy: "",
        filter: "",
      })
    )
      fail("donor registry page scope/order");
    const parsed = decodeDelawareCompleteCommitteeRegistryPage(text(c));
    if (
      parsed.total !== count ||
      parsed.rows.length > 500 ||
      (i < pages.length - 1 && parsed.rows.length !== 500)
    )
      fail("donor registry incomplete counts");
    const data = parsed.rows;
    const fingerprint = canonical(data);
    if (data.length && seenPages.has(fingerprint)) fail("donor registry repeated page");
    seenPages.add(fingerprint);
    rows.push(...data);
  });
  if (
    count === null ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    rows.length !== count ||
    JSON.parse(text(pages.at(-1)!)).data.length >= 500
  )
    fail("donor registry exhaustion missing");
  return rows;
}
function raw(row: DelawareNativeLedgerRow, key: string) {
  const s = row.rawFields[key];
  if (typeof s !== "string") fail("missing native financial identity");
  return display(s);
}
const eligible = new Map([
  ["02", "Political Action Committee"],
  ["03", "Political Committee"],
] as const);
const explicit = new Set(["Political Action Committee", "Political Committee", "PAC"]);
const personal = new Set(["Individual", "Self (Candidate)", "Candidate Committee"]);
const cashMethods = new Set(["Check", "Credit Card", "EFT", "Electronic Fund Transfer", "Cash"]);
function compose(
  target: DelawareCurrentCashTarget,
  packet: DelawareCfrsCandidateSourcePacket,
  rows: Record<string, unknown>[],
  reportUrls: Map<number, string>,
) {
  type Position = DelawareVerifiedCommitteeDonor & {
    sourceClasses: Set<string>;
    giftIds: number[];
    returnIds: number[];
  };
  const receiving = rows.filter((r) => r.Committee_Id === target.receivingCfId);
  if (
    !receiving.length ||
    receiving.some(
      (r) =>
        r.MemberID !== target.receivingMemberId ||
        r.CommitteeTypeCode !== "01" ||
        typeof r.CommitteeName !== "string" ||
        name(r.CommitteeName) !== name(target.receivingCommitteeName),
    )
  )
    fail("full registry receiving identity missing/contradictory");
  const positions = new Map<string, Position>();
  const index = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    if (typeof r.CommitteeName !== "string") fail("registry donor name missing");
    const k = name(r.CommitteeName);
    index.set(k, [...(index.get(k) ?? []), r]);
  }
  function resolve(reportedName: string, sourceClass: string, date: string) {
    if (personal.has(sourceClass)) return null;
    const matches = index.get(name(reportedName)) ?? [];
    const ids = new Set(matches.map((r) => r.Committee_Id));
    const types = new Set(matches.map((r) => r.CommitteeTypeCode));
    if (
      matches.some((r) => r.Committee_Id === target.receivingCfId) ||
      name(reportedName) === name(target.receivingCommitteeName)
    ) {
      if (ids.size > 1 || types.size > 1 || explicit.has(sourceClass))
        fail("ambiguous committee/self identity");
      return null;
    }
    if (types.has("01")) {
      if (types.size !== 1 || ids.size !== 1 || explicit.has(sourceClass))
        fail("committee/candidate class contradiction");
      return null;
    }
    if (matches.length && [...types].some((t) => !eligible.has(t as "02" | "03")))
      fail("cross-class/unknown committee identity");
    if (ids.size === 1 && types.size === 1) {
      const id = [...ids][0];
      if (typeof id !== "string" || !/^0[23]\d{6}$/.test(id)) fail("invalid public donor identity");
      const identityKeys = [
        "MemberID",
        "CommitteeTypeCode",
        "CommitteeType",
        "Office",
        "OfficeSought",
        "District",
        "DistrictName",
        "County",
      ];
      const contexts = matches.map((r) => Object.fromEntries(identityKeys.map((k) => [k, r[k]])));
      if (
        contexts.some((c) => !same(c, contexts[0])) ||
        matches.some((r) => r.CommitteeType !== eligible.get(r.CommitteeTypeCode as "02" | "03"))
      )
        fail("contradictory registered donor class/context");
      const registeredDates = matches.map((r) => usDate(String(r.RegisteredDateStr ?? "")));
      if (registeredDates.some((d) => d > date))
        fail("registry registration later than financial occurrence");
      return {
        committeeId: id,
        committeeName: display(String(matches[0]!.CommitteeName)),
        committeeType: eligible.get([...types][0] as "02" | "03")!,
        registeredCommitteeId: id,
      };
    }
    if (explicit.has(sourceClass))
      return {
        committeeId: "reported:" + hash(canonical([sourceClass, name(reportedName)])),
        committeeName: reportedName,
        committeeType:
          sourceClass === "Political Committee"
            ? ("Political Committee" as const)
            : ("Political Action Committee" as const),
        registeredCommitteeId: null,
      };
    if (
      ["Out-of-State or Federal Committee", "Dem or Rep National Sub-Committees"].includes(
        sourceClass,
      )
    )
      fail("unsupported broad committee classification");
    if (
      ![
        "Corporation, Partnership, and Other Entity",
        "Business/Group/Organization",
        "Labor Organization",
        "Other",
      ].includes(sourceClass)
    )
      fail("unknown nonpersonal contributor class");
    return null;
  }
  function position(row: DelawareNativeLedgerRow, isReturn: boolean) {
    const reported = raw(row, isReturn ? "PayeeName" : "ContributorName"),
      cls = raw(row, isReturn ? "PayeeType" : "ContributorType");
    if (
      isReturn &&
      personal.has(cls) &&
      [...positions.values()].some((p) => name(p.committeeName) === name(reported))
    )
      fail("personal/committee return identity contradiction");
    const identity = resolve(reported, cls, row.date);
    if (!identity) {
      if (isReturn && !personal.has(cls)) fail("unattributed potential committee return");
      return;
    }
    if (
      identity.registeredCommitteeId === null &&
      [...positions.values()].some(
        (p) =>
          p.registeredCommitteeId === null &&
          name(p.committeeName) === name(reported) &&
          [...p.sourceClasses].some((c) => c !== cls),
      )
    )
      fail("unregistered reported-name class drift cannot attribute gift/return");
    const method = raw(row, isReturn ? "ExpenseMethod" : "ContributionType");
    if (
      !cashMethods.has(method) &&
      method !== "In-Kind" &&
      !(isReturn && method === "Wire Transfer")
    )
      fail("unresolved committee money mechanism");
    if (isReturn && row.amountCents < 0) fail("unresolved signed outgoing return");
    const amount = isReturn ? -row.amountCents : row.amountCents;
    const p = positions.get(identity.committeeId) ?? {
      ...identity,
      reportedContributorType: cls,
      cashAmountCents: 0,
      inKindAmountCents: 0,
      contributionCount: 0,
      sourceUrl: reportUrls.get(row.transactionId)!,
      sourceClasses: new Set<string>(),
      giftIds: [],
      returnIds: [],
    };
    if (
      name(p.committeeName) !== name(identity.committeeName) ||
      p.committeeType !== identity.committeeType ||
      !p.sourceUrl
    )
      fail("inconsistent resolved donor/report source");
    p.sourceClasses.add(cls);
    if (method === "In-Kind") p.inKindAmountCents = add(p.inKindAmountCents, amount);
    else p.cashAmountCents = add(p.cashAmountCents, amount);
    if (!isReturn && amount > 0) {
      p.contributionCount++;
      if (p.contributionCount > 2147483647) fail("unsafe gift count");
      p.giftIds.push(row.transactionId);
    } else if (amount < 0) p.returnIds.push(row.transactionId);
    positions.set(identity.committeeId, p);
  }
  for (const r of packet.receipts.rows) {
    const cls = raw(r, "ContributorType"),
      method = raw(r, "ContributionType");
    if (cls === "Total of Contributions not exceeding $100") continue;
    if (["Candidate Loan", "Other Income", "Refund/Rebate"].includes(method)) {
      if (r.amountCents < 0) fail("unknown negative non-gift mechanism");
      continue;
    }
    if (!cashMethods.has(method) && method !== "In-Kind") fail("unknown receipt mechanism");
    position(r, false);
  }
  for (const r of packet.expenses.rows) {
    const category = raw(r, "ExpenseCategory");
    if (category === "Return Contributions") position(r, true);
    else if (r.amountCents < 0 || /refund|return|credit/i.test(category))
      fail("unknown possible returned contribution");
  }
  return [...positions.values()]
    .sort((a, b) => a.committeeId.localeCompare(b.committeeId))
    .map((p) => ({
      ...p,
      reportedContributorType: [...p.sourceClasses].sort().join(" | "),
      sourceClasses: [...p.sourceClasses].sort(),
    }));
}
function directTotal(
  packet: DelawareCfrsCandidateSourcePacket,
  reports: Awaited<ReturnType<typeof bindDelawareCandidateFinancialFacts>>["reports"],
) {
  let cents = 0;
  for (const row of packet.receipts.rows) {
    const method = raw(row, "ContributionType");
    if (["Candidate Loan", "Other Income", "Refund/Rebate"].includes(method)) {
      if (row.amountCents < 0) fail("unknown signed non-gift receipt");
      continue;
    }
    if (
      !cashMethods.has(method) &&
      method !== "In-Kind" &&
      method !== "Total of Contributions not exceeding $100"
    )
      fail("unknown gift mechanism");
    cents = add(cents, row.amountCents);
  }
  for (const r of reports)
    for (const aggregate of r.aggregates)
      if (aggregate.schedule === "receipts") cents = add(cents, aggregate.pdfOnlyAggregateCents);
  for (const row of packet.expenses.rows) {
    const category = raw(row, "ExpenseCategory");
    if (category === "Return Contributions") {
      if (
        row.amountCents < 0 ||
        (!cashMethods.has(raw(row, "ExpenseMethod")) &&
          !["In-Kind", "Wire Transfer"].includes(raw(row, "ExpenseMethod")))
      )
        fail("unknown return mechanism");
      cents = add(cents, -row.amountCents);
    } else if (row.amountCents < 0 || /refund|return|credit/i.test(category))
      fail("unknown possible gift offset");
  }
  return cents;
}
/** Replays raw source authority; outputs independent components, never candidate-wide outside zero. */
export async function verifyDelawareCurrentCandidateCash(
  original: DelawareCurrentCandidateCashInput,
) {
  const diagnostics: string[] = [];
  let input: DelawareCurrentCandidateCashInput;
  try {
    input = structuredClone(original);
    for (const p of [input.before, input.after])
      p.sourceCaptures = p.sourceCaptures.map((c) => ({ ...c, body: Buffer.from(c.body) }));
    for (const k of ["donorRegistryBefore", "donorRegistryAfter"] as const)
      input[k] = input[k].map((c) => ({ ...c, body: Buffer.from(c.body) }));
    if (input.campaignAuthority.kind === "incumbent_same_office") {
      for (const phase of [input.campaignAuthority.before, input.campaignAuthority.after]) {
        phase.result.body = Buffer.from(phase.result.body);
        phase.ballot.body = Buffer.from(phase.ballot.body);
      }
    }
    const authority = qualifyOfficial(input.target, input.campaignAuthority);
    if (input.campaignAuthority.kind === "incumbent_same_office") {
      const a = input.campaignAuthority;
      if (
        Math.max(Date.parse(a.before.result.completedAt), Date.parse(a.before.ballot.completedAt)) >
          Math.min(...input.before.sourceCaptures.map((c) => Date.parse(c.startedAt))) ||
        Math.min(Date.parse(a.after.result.startedAt), Date.parse(a.after.ballot.startedAt)) <
          Math.max(...input.after.sourceCaptures.map((c) => Date.parse(c.completedAt)))
      )
        fail("official candidacy source not nested around current financial source");
    }
    const before = await phase(input.target, input.before, authority),
      after = await phase(input.target, input.after, authority);
    if (
      Math.max(...input.before.sourceCaptures.map((c) => Date.parse(c.completedAt))) >
        Math.min(...input.after.sourceCaptures.map((c) => Date.parse(c.startedAt))) ||
      !same(before.proof, after.proof)
    )
      fail("changed/non-bracketed whole current financial source");
    const reports = after.sorted;
    const sourceProvenance = {
      version: 1,
      scope: "current_qualified_candidate_financial_reports",
      target: input.target,
      window: after.window,
      reports: after.proof.reports,
      organizationFingerprints: after.proof.organizationFingerprints,
      receiptFingerprint: after.proof.receiptFingerprint,
      expenseFingerprint: after.proof.expenseFingerprint,
      occurrences: [
        ...input.after.receipts.rows.map((row) => ({ row, kind: "receipt" as const })),
        ...input.after.expenses.rows.map((row) => ({ row, kind: "expense" as const })),
      ].map(({ row: r, kind }) => ({
        kind,
        sourceCategory: kind === "expense" ? raw(r, "ExpenseCategory") : null,
        transactionId: r.transactionId,
        date: r.date,
        amountCents: r.amountCents,
        identityFingerprint: hash(canonical(r.rawFields)),
        sourceClass: raw(r, kind === "receipt" ? "ContributorType" : "PayeeType"),
        sourceMechanism: raw(r, kind === "receipt" ? "ContributionType" : "ExpenseMethod"),
      })),
      sourceMetadata: [...input.before.sourceCaptures, ...input.after.sourceCaptures].map(metadata),
    };
    let directContributionCents: number | undefined;
    try {
      directContributionCents = directTotal(input.after, after.bound.reports);
    } catch {
      diagnostics.push("Direct gift total preserved: unresolved signed gift/return mechanism");
    }
    const cash = {
      directContributionCents,
      reportedReceiptsCents: reports.reduce((n, r) => add(n, r.facts.cover.receiptsCents), 0),
      reportedExpendituresCents: reports.reduce(
        (n, r) => add(n, r.facts.cover.expendituresCents),
        0,
      ),
      cashOnHandCents: reports.at(-1)!.facts.cover.endingBalanceCents,
      debtCents: reports.at(-1)!.facts.supplementaryCoverControls.loansOutstandingCents,
      sourceProvenance,
    };
    try {
      const rb = registry(input.donorRegistryBefore),
        ra = registry(input.donorRegistryAfter);
      if (
        Math.max(...input.donorRegistryBefore.map((c) => Date.parse(c.completedAt))) >
          Math.min(...input.before.sourceCaptures.map((c) => Date.parse(c.startedAt))) ||
        Math.min(...input.donorRegistryAfter.map((c) => Date.parse(c.startedAt))) <
          Math.max(...input.after.sourceCaptures.map((c) => Date.parse(c.completedAt))) ||
        !same(rb, ra)
      )
        fail("changed/non-nested complete donor registry");
      const reportUrls = new Map<number, string>();
      for (const r of after.bound.reports)
        for (const bs of Object.values(r.bindings))
          for (const b of bs ?? [])
            for (const id of b.nativeTransactionIds)
              reportUrls.set(
                id,
                after.groups.pdfs.find(
                  (c) =>
                    new URL(c.url).searchParams.get("FileName") ===
                    r.inventoryRow.document!.publicReportFileName,
                )!.url,
              );
      const positions = compose(input.target, input.after, ra, reportUrls);
      const donors = positions.map(({ sourceClasses, giftIds, returnIds, ...d }) => d);
      const pac = {
        donors,
        sourceProvenance: {
          ...sourceProvenance,
          scope: "current_qualified_named_committee_gift_positions",
          donors: positions.map((p) => ({
            committeeId: p.committeeId,
            reportedContributorType: p.reportedContributorType,
            committeeType: p.committeeType,
            registeredCommitteeId: p.registeredCommitteeId,
            sourceClasses: p.sourceClasses,
            giftIds: p.giftIds,
            returnIds: p.returnIds,
            cashAmountCents: p.cashAmountCents,
            inKindAmountCents: p.inKindAmountCents,
          })),
          registrySources: [...input.donorRegistryBefore, ...input.donorRegistryAfter].map(
            metadata,
          ),
        },
      };
      return { cash, pac, diagnostics };
    } catch (error) {
      diagnostics.push(
        error instanceof DelawareCurrentCashSourceError
          ? error.message
          : "PAC preserved: complete typed registry/attributable gift-return identity unavailable",
      );
      return { cash, diagnostics };
    }
  } catch (error) {
    diagnostics.push(
      error instanceof DelawareCurrentCashSourceError
        ? error.message
        : "Cash and PAC preserved: qualified complete current source authority unavailable",
    );
    return { diagnostics };
  }
}

export type DelawareCurrentCandidateCashResult = Awaited<
  ReturnType<typeof verifyDelawareCurrentCandidateCash>
>;

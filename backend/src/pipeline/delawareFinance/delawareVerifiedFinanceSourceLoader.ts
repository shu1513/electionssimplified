import { createHash } from "node:crypto";
import {
  buildDelawareCfrsUrl,
  buildDelawareCommitteeSearchFields,
  createDelawareCfrsSession,
  DELAWARE_CFRS_PAGES,
  DELAWARE_CFRS_THEME_QUERY,
  DelawareCfrsClientError,
  type DelawareCfrsResponseCapture,
  type DelawareCfrsSessionOptions,
} from "./delawareCfrsClient.js";
import {
  extractDelawareGridTotal,
  parseDelawareCommitteeGridJson,
} from "./delawareCfrsParsers.js";
import { fetchDelawareCfrsCompleteCommitteeRegistry } from "./delawareCfrsCompleteCommitteeRegistry.js";
import {
  fetchDelawareCfrsCandidateSourcePacket,
  fetchDelawareCfrsThirdPartySourcePacket,
  type DelawareCfrsCandidateSourcePacket,
} from "./delawareCfrsArtifactAcquisition.js";
import { decodeDelawareCandidateSourcePacketFromCaptures } from "./delawareCandidateSourcePacketReplay.js";
import {
  readDelawareCfrsCommitteeArtifacts,
  storeDelawareCfrsCommitteeArtifacts,
  type DelawareCfrsSourcePacketIndex,
} from "./delawareCfrsArtifactCache.js";
import {
  verifyDelawareCurrentCandidateCash,
  type DelawareCurrentCandidateCashResult,
  type DelawareCurrentCashCampaignAuthority,
} from "./delawareCurrentCandidateCashSource.js";
import {
  verifyDelawareThirdPartyOutsideSource,
  type DelawareOutsideSourcePacket,
  type DelawareOutsidePayerScope,
  type DelawareVerifiedThirdPartyOutsideProof,
} from "./delawareThirdPartyOutsideSource.js";
import type { DelawareVerifiedFinanceLocalContext } from "./delawareVerifiedFinanceLocalContext.js";

export type DelawareVerifiedFinanceSourceLoaderInput = {
  context: DelawareVerifiedFinanceLocalContext;
  cacheDir?: string;
  refresh?: boolean;
  priorOutsideProvenance?: unknown;
  sessionOptions?: DelawareCfrsSessionOptions;
  log?: (message: string) => void;
};
export type DelawareVerifiedFinanceSourceLoaderResult = {
  cash?: DelawareCurrentCandidateCashResult["cash"];
  pac?: DelawareCurrentCandidateCashResult["pac"];
  outsideEvidence: readonly DelawareVerifiedThirdPartyOutsideProof[];
  diagnostics: readonly string[];
};
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const display = (value: string) => value.replace(/\s+/gu, " ").trim();
const sameName = (a: string, b: string) =>
  display(a).toUpperCase() === display(b).toUpperCase();
const path = (c: DelawareCfrsResponseCapture) => new URL(c.url).pathname;
const text = (c: DelawareCfrsResponseCapture) =>
  new TextDecoder("utf-8", { fatal: true }).decode(c.body);
const signature = (c: DelawareCfrsResponseCapture) =>
  JSON.stringify([c.url, c.method, c.financeFields]);
const copy = (c: DelawareCfrsResponseCapture) => ({
  ...c,
  body: Buffer.from(c.body),
  financeFields: c.financeFields === null ? null : { ...c.financeFields },
});
function fail(): never {
  throw new Error("Delaware source closure unavailable");
}
function observerFailure(error: unknown) {
  if (
    error instanceof DelawareCfrsClientError &&
    error.code === "capture_error"
  )
    throw error;
}

/** Select only successful original retries; keep every attempt in the separate journal. */
function authorityCaptures(caps: readonly DelawareCfrsResponseCapture[]) {
  for (const [i, c] of caps.entries())
    if (c.status !== 200) {
      let found = false;
      for (let j = i + 1; j < caps.length; j++) {
        const next = caps[j]!;
        if (signature(next) !== signature(c)) break;
        if (next.status === 200 && next.attempt > c.attempt) {
          found = true;
          break;
        }
      }
      if (!found) fail();
    }
  const successful = caps.filter((c) => c.status === 200);
  if (successful.some((c) => c.requestScopeRedacted)) fail();
  const selected = new Set(successful);
  for (const route of [
    DELAWARE_CFRS_PAGES.receiptsSearch,
    DELAWARE_CFRS_PAGES.expensesSearchPost,
  ]) {
    const searches = successful.filter(
      (c) => path(c) === route && c.method === "POST",
    );
    if (searches.length > 1) {
      if (searches.some((c) => signature(c) !== signature(searches[0]!)))
        fail();
      for (const c of searches.slice(0, -1)) selected.delete(c);
    }
  }
  return successful.filter((c) => selected.has(c));
}
function candidateAuthority(packet: DelawareCfrsCandidateSourcePacket) {
  return {
    ...packet,
    sourceCaptures: authorityCaptures(packet.sourceCaptures),
  };
}
function payerAuthority(
  p: DelawareOutsideSourcePacket,
): DelawareOutsideSourcePacket {
  return {
    registry: authorityCaptures(p.registry),
    payerOrganization: authorityCaptures(p.payerOrganization),
    receiverIdentity: authorityCaptures(p.receiverIdentity),
    candidateCycleAuthority: authorityCaptures(p.candidateCycleAuthority),
    allVersionReports: authorityCaptures(p.allVersionReports),
    latestAccountReport: authorityCaptures(p.latestAccountReport),
    genericMemberReceipts: authorityCaptures(p.genericMemberReceipts),
    thirdPartyReceiptExport: authorityCaptures(p.thirdPartyReceiptExport),
    expenses: authorityCaptures(p.expenses),
    reportPdfs: authorityCaptures(p.reportPdfs),
    ...(p.unsupportedFacets ? { unsupportedFacets: p.unsupportedFacets } : {}),
  };
}
function resolveOwner(
  rows: readonly Readonly<Record<string, unknown>>[],
  cfId: string,
  expectedName?: string,
) {
  const found = rows.filter((r) => r.Committee_Id === cfId);
  const members = new Set(found.map((r) => r.MemberID)),
    names = new Set(
      found.map((r) =>
        typeof r.CommitteeName === "string" ? display(r.CommitteeName) : "",
      ),
    );
  if (
    !found.length ||
    members.size !== 1 ||
    names.size !== 1 ||
    found.some((r) => r.CommitteeTypeCode !== cfId.slice(0, 2))
  )
    fail();
  const memberId = [...members][0],
    committeeName = [...names][0]!;
  if (
    typeof memberId !== "number" ||
    !Number.isSafeInteger(memberId) ||
    memberId <= 0 ||
    !committeeName ||
    (expectedName !== undefined && !sameName(committeeName, expectedName))
  )
    fail();
  return { cfId, memberId, committeeName };
}
async function scopedRegistry(
  options: DelawareCfrsSessionOptions,
  type: "01" | "04",
  cfId?: string,
  organization = false,
) {
  const captures: DelawareCfrsResponseCapture[] = [];
  const observer = options.onResponseCapture;
  const session = createDelawareCfrsSession({
    ...options,
    onResponseCapture: async (c) => {
      captures.push(copy(c));
      await observer?.(c);
    },
  });
  await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch));
  const searched = await session.postForm(
    buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearchPost, {
      ...DELAWARE_CFRS_THEME_QUERY,
    }),
    buildDelawareCommitteeSearchFields({
      CommitteeType: type,
      ...(cfId ? { txtCommitteeID: cfId } : {}),
    }),
  );
  const count = extractDelawareGridTotal(searched.text());
  const rows: Record<string, unknown>[] = [];
  let exhausted = false;
  for (let page = 1; page <= 40; page++) {
    const response = await session.postForm(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeGridJson, {
        ...DELAWARE_CFRS_THEME_QUERY,
      }),
      { page: String(page), size: "500", orderBy: "", groupBy: "", filter: "" },
      { xhr: true },
    );
    const p = parseDelawareCommitteeGridJson(response.text());
    if (
      count === null ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      p.total !== count ||
      p.rows.length > 500
    )
      fail();
    rows.push(...JSON.parse(response.text()).data);
    if (rows.length > count) fail();
    if (p.rows.length < 500) {
      if (rows.length !== count) fail();
      exhausted = true;
      break;
    }
  }
  if (!exhausted) fail();
  if (organization && cfId) {
    const resolved = resolveOwner(rows, cfId);
    const editions = new Set(
      rows.filter((r) => r.Committee_Id === cfId).map((r) => r.MemberVersID),
    );
    const urls = new Set<string>();
    for (const m of searched
      .text()
      .matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
      const raw = m[1]!.replace(/&amp;|&#38;/g, "&");
      if (!raw.startsWith("/Public/ShowReview?")) continue;
      const u = new URL(raw, buildDelawareCfrsUrl("/"));
      const fields = Object.fromEntries(
        [...u.searchParams].map(([k, v]) => [k, v.trim()]),
      );
      if (
        fields.memberID !== String(resolved.memberId) ||
        fields.ftype !== "SO"
      )
        continue;
      const keys = [
        "memberID",
        "memVersID",
        "cTypeCode",
        "ftype",
        "fpath",
        "fname",
        "isPublic",
      ];
      if (
        [...u.searchParams].length !== keys.length ||
        Object.keys(fields).length !== keys.length ||
        keys.some((k) => !Object.hasOwn(fields, k)) ||
        fields.cTypeCode !== type ||
        fields.fpath !== "" ||
        fields.fname !== "" ||
        fields.isPublic !== "true" ||
        !editions.has(Number(fields.memVersID))
      )
        fail();
      urls.add(
        buildDelawareCfrsUrl(
          DELAWARE_CFRS_PAGES.statementOfOrganization,
          fields,
        ),
      );
    }
    if (urls.size !== editions.size) fail();
    for (const url of urls) await session.get(url);
  }
  return { rows, captures };
}
function cells(html: string, id: string) {
  const t = new RegExp(
    `<table\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/table>`,
    "gi",
  );
  const matches = [...html.matchAll(t)];
  if (matches.length !== 1) fail();
  const strip = (s: string) =>
    display(
      s
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/&amp;/g, "&"),
    );
  return [...matches[0]![1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(
    (m) => {
      const v = [...m[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) =>
        strip(x[1]!),
      );
      return v.length ? [v] : [];
    },
  );
}
function sourceCandidateNames(
  packet: DelawareCfrsCandidateSourcePacket,
  localName: string,
) {
  const names = new Set([localName]);
  for (const c of packet.sourceCaptures.filter(
    (c) =>
      path(c) === DELAWARE_CFRS_PAGES.statementOfOrganization &&
      c.status === 200,
  )) {
    const people = cells(text(c), "CandidateList");
    if (people.length !== 1) fail();
    const publishedName = display(people[0]![0]!);
    // A discovery edge may print the exact SO honorific. Keep that literal;
    // the financial verifier independently binds the actual local person.
    names.add(publishedName);
    names.add(publishedName.replace(/^(?:Ms\.|Mr\.|Mrs\.) /, ""));
  }
  return [...names];
}
function affiliationLead(
  caps: readonly DelawareCfrsResponseCapture[],
  names: readonly string[],
  context: DelawareVerifiedFinanceLocalContext,
) {
  const org = caps.filter(
    (c) =>
      path(c) === DELAWARE_CFRS_PAGES.statementOfOrganization &&
      c.status === 200,
  );
  if (!org.length) return false;
  return org.some((c) =>
    cells(text(c), "ViewCandiate").some(
      (row) =>
        names.some((n) => row.some((v) => sameName(v, n))) &&
        row.includes(context.party) &&
        (row.includes(context.officeName) ||
          row.includes("State Office - " + context.officeName)),
    ),
  );
}
async function officialGet(
  url: string,
  options: DelawareCfrsSessionOptions,
): Promise<DelawareCfrsResponseCapture> {
  const u = new URL(url);
  if (
    u.origin !== "https://elections.delaware.gov" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    fail();
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  const startedAt = new Date().toISOString();
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent":
          options.userAgent ??
          "Mozilla/5.0 (compatible; VoteApp public finance research)",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.length;
        if (bytes > 12 * 1024 * 1024) {
          await reader.cancel();
          fail();
        }
        chunks.push(Buffer.from(r.value));
      }
    }
    const body = Buffer.concat(chunks);
    return {
      body,
      url,
      method: "GET",
      financeFields: null,
      requestScopeRedacted: false,
      attempt: 1,
      startedAt,
      completedAt: new Date().toISOString(),
      status: response.status,
      contentType: response.headers.get("content-type"),
      byteCount: body.length,
      sha256: hash(body),
    };
  } finally {
    clearTimeout(timeout);
  }
}
function priorPayers(
  prior: unknown,
  context: DelawareVerifiedFinanceLocalContext,
): DelawareOutsidePayerScope[] {
  if (prior === undefined || prior === null) return [];
  if (!prior || typeof prior !== "object") fail();
  const p = prior as Record<string, unknown>;
  if (
    p.version !== 1 ||
    p.scope !== "reported_third_party_outside_expenses" ||
    !Array.isArray(p.evidence)
  )
    fail();
  return p.evidence.map((e: unknown) => {
    if (!e || typeof e !== "object") fail();
    const proof = e as DelawareVerifiedThirdPartyOutsideProof;
    if (
      proof.version !== 1 ||
      proof.scope !== "reported_third_party_outside_expenses" ||
      proof.candidateWideZeroAuthority !== false ||
      !proof.candidate ||
      !proof.payer ||
      Object.entries(context).some(
        ([k, v]) => proof.candidate[k as keyof typeof proof.candidate] !== v,
      ) ||
      !Array.isArray(proof.reports) ||
      !proof.reports.length ||
      !Array.isArray(proof.allocations) ||
      !proof.allocations.length ||
      !/^04\d{6}$/.test(proof.payer.cfId) ||
      proof.payer.committeeType !== "04" ||
      !Number.isSafeInteger(proof.payer.memberId) ||
      proof.payer.memberId <= 0 ||
      !proof.payer.committeeName.trim()
    )
      fail();
    return { ...proof.payer };
  });
}
function cacheCaps(
  caps: readonly DelawareCfrsResponseCapture[],
  indices: readonly number[],
) {
  const result = indices.map((i) => caps[i]);
  if (result.some((c) => !c)) fail();
  return result as DelawareCfrsResponseCapture[];
}
function cachedPayer(
  index: DelawareCfrsSourcePacketIndex["payers"][number],
  caps: readonly DelawareCfrsResponseCapture[],
): DelawareOutsideSourcePacket {
  const f = index.facets;
  return {
    registry: cacheCaps(caps, f.registry),
    payerOrganization: cacheCaps(caps, f.payerOrganization),
    receiverIdentity: cacheCaps(caps, f.receiverIdentity),
    candidateCycleAuthority: cacheCaps(caps, f.candidateCycleAuthority),
    allVersionReports: cacheCaps(caps, f.allVersionReports),
    latestAccountReport: cacheCaps(caps, f.latestAccountReport),
    genericMemberReceipts: cacheCaps(caps, f.genericMemberReceipts),
    thirdPartyReceiptExport: cacheCaps(caps, f.thirdPartyReceiptExport),
    expenses: cacheCaps(caps, f.expenses),
    reportPdfs: cacheCaps(caps, f.reportPdfs),
    ...(f.unsupportedFacets
      ? { unsupportedFacets: cacheCaps(caps, f.unsupportedFacets) }
      : {}),
  };
}
/** Saved openings are observations. Only genuine fresh closing and immutable raw replay can emit money. */
export async function loadDelawareVerifiedFinanceSource(
  original: DelawareVerifiedFinanceSourceLoaderInput,
): Promise<DelawareVerifiedFinanceSourceLoaderResult> {
  const input = {
    ...original,
    context: structuredClone(original.context),
    sessionOptions: { ...original.sessionOptions },
  };
  const context = input.context,
    diagnostics: string[] = [],
    journal: DelawareCfrsResponseCapture[] = [],
    officialSources: DelawareCfrsResponseCapture[] = [],
    outsideEvidence: DelawareVerifiedThirdPartyOutsideProof[] = [];
  let requests = 0,
    bytes = 0,
    budget = false;
  const fetchImpl = input.sessionOptions.fetchImpl ?? fetch,
    observer = input.sessionOptions.onResponseCapture;
  const options: DelawareCfrsSessionOptions = {
    ...input.sessionOptions,
    maxResponseBytes: Math.min(
      input.sessionOptions.maxResponseBytes ?? 4 * 1024 * 1024,
      4 * 1024 * 1024,
    ),
    fetchImpl: async (url, init) => {
      const reserve =
        new URL(url).origin === "https://elections.delaware.gov"
          ? 12 * 1024 * 1024
          : 4 * 1024 * 1024;
      if (requests >= 1000 || bytes + reserve > 128 * 1024 * 1024) {
        budget = true;
        fail();
      }
      requests++;
      return fetchImpl(url, init);
    },
    onResponseCapture: async (c) => {
      journal.push(copy(c));
      bytes += c.byteCount;
      await observer?.(c);
    },
  };
  const safeFailure = (error: unknown, reason: string) => {
    observerFailure(error);
    diagnostics.push(reason);
  };
  let saved:
    Awaited<ReturnType<typeof readDelawareCfrsCommitteeArtifacts>> | undefined;
  // Read the previous atomic bundle before any refresh. A failed refresh never replaces it.
  try {
    saved = await readDelawareCfrsCommitteeArtifacts({
      cacheDir: input.cacheDir,
      cfId: context.receivingCfId,
    });
  } catch {
    diagnostics.push(
      "Saved qualified source opening unavailable; fresh source required",
    );
  }
  let globalOpening: Awaited<
    ReturnType<typeof fetchDelawareCfrsCompleteCommitteeRegistry>
  >;
  try {
    globalOpening = await fetchDelawareCfrsCompleteCommitteeRegistry({
      sessionOptions: options,
    });
  } catch (error) {
    safeFailure(error, "Opening statewide registry transport unavailable");
    return { outsideEvidence, diagnostics };
  }
  diagnostics.push(...globalOpening.diagnostics);
  let resolved: ReturnType<typeof resolveOwner>;
  try {
    if (!globalOpening.rows) fail();
    resolved = resolveOwner(
      globalOpening.rows,
      context.receivingCfId,
      context.receivingCommitteeName,
    );
  } catch {
    try {
      const scoped = await scopedRegistry(options, "01", context.receivingCfId);
      resolved = resolveOwner(
        scoped.rows,
        context.receivingCfId,
        context.receivingCommitteeName,
      );
      diagnostics.push(
        "Receiving owner resolved independently; whole donor registry remains unavailable",
      );
    } catch (error) {
      safeFailure(
        error,
        "Current receiving CF/member/name identity unresolved",
      );
      return { outsideEvidence, diagnostics };
    }
  }
  const target = { ...context, receivingMemberId: resolved.memberId };
  let authorityKind: "incumbent_same_office" | "new_account" = "new_account";
  type Pair = {
    result: DelawareCfrsResponseCapture;
    ballot: DelawareCfrsResponseCapture;
  };
  let freshOfficialOpening: Pair | undefined;
  async function captureOfficial(capture: DelawareCfrsResponseCapture) {
    officialSources.push(copy(capture));
    bytes += capture.byteCount;
    // Deliver to the original observer without adding government pages to the
    // separate CFRS-only cache journal. Observers cannot mutate authority bytes.
    try {
      await observer?.(copy(capture));
    } catch {
      throw new DelawareCfrsClientError(
        "capture_error",
        "Official response capture failed",
        capture.status ?? undefined,
      );
    }
  }
  async function officialPair(): Promise<Pair> {
    const result = await officialGet(
      "https://elections.delaware.gov/reports/GE2022.html",
      options,
    );
    await captureOfficial(result);
    const ballot = await officialGet(
      "https://elections.delaware.gov/elections/general/sampleballots/GE2026/15-10.html",
      options,
    );
    await captureOfficial(ballot);
    return { result, ballot };
  }
  if (
    context.electionYear === 2026 &&
    context.officeName === "Attorney General" &&
    context.district === null
  ) {
    try {
      freshOfficialOpening = await officialPair();
      // The pure verifier rechecks these original sources. No incumbent identity is hardcoded.
      const {
        parseDelawareOfficialStatewideGeneralResult,
        parseDelawareOfficialGeneralBallot,
      } = await import("./delawareOfficialElectionFacts.js");
      const result = parseDelawareOfficialStatewideGeneralResult({
        bytes: freshOfficialOpening.result.body,
        electionYear: 2022,
        officeName: context.officeName,
      });
      const ballot = parseDelawareOfficialGeneralBallot({
        bytes: freshOfficialOpening.ballot.body,
        electionYear: 2026,
        officeName: context.officeName,
      });
      if (
        sameName(result.winner.candidateName, context.candidateName) &&
        sameName(result.winner.party, context.party + " Party") &&
        ballot.electionDate === context.electionDate &&
        ballot.candidates.some(
          (c) =>
            sameName(c.candidateName, context.candidateName) &&
            sameName(c.party, context.party + " Party"),
        )
      )
        authorityKind = "incumbent_same_office";
    } catch (error) {
      safeFailure(
        error,
        "Official same-office qualification unavailable; new-account history must independently qualify",
      );
    }
  }
  const requestWindow =
    authorityKind === "incumbent_same_office"
      ? { start: "2023-01-01", end: "2026-12-31" }
      : null;
  let before: DelawareCfrsCandidateSourcePacket | undefined,
    after: DelawareCfrsCandidateSourcePacket | undefined;
  let registryBefore: readonly DelawareCfrsResponseCapture[] =
    globalOpening.sourceCaptures;
  let officialBefore = freshOfficialOpening,
    usedSaved = false;
  if (!input.refresh && saved?.sourcePacketIndex && saved.sourceCaptures) {
    const index = saved.sourcePacketIndex;
    try {
      if (
        index.cfId !== resolved.cfId ||
        index.memberId !== resolved.memberId ||
        !sameName(index.committeeName, resolved.committeeName) ||
        JSON.stringify(index.requestWindow) !== JSON.stringify(requestWindow)
      )
        fail();
      before = decodeDelawareCandidateSourcePacketFromCaptures({
        ...resolved,
        requestWindow,
        captures: cacheCaps(
          saved.sourceCaptures,
          index.candidateCaptureIndices,
        ),
      });
      registryBefore = cacheCaps(
        saved.sourceCaptures,
        index.registryOpeningCaptureIndices,
      );
      if (authorityKind === "incumbent_same_office") {
        const start = Math.min(
          ...before.sourceCaptures.map((c) => Date.parse(c.startedAt)),
        );
        const prior = (saved.officialElectionSources ?? []).filter(
          (c) => Date.parse(c.completedAt) <= start,
        );
        const result = prior
            .filter((c) => new URL(c.url).pathname === "/reports/GE2022.html")
            .at(-1),
          ballot = prior
            .filter(
              (c) =>
                new URL(c.url).pathname ===
                "/elections/general/sampleballots/GE2026/15-10.html",
            )
            .at(-1);
        if (!result || !ballot) fail();
        officialBefore = { result, ballot };
      }
      usedSaved = true;
    } catch {
      before = undefined;
      registryBefore = globalOpening.sourceCaptures;
      officialBefore = freshOfficialOpening;
      diagnostics.push(
        "Saved opening scope/preceding authority incompatible; using fresh opening",
      );
    }
  }
  const candidateInput = {
    ...resolved,
    requestWindow,
    sessionOptions: options,
  };
  let structurallyClosed = false;
  try {
    if (!before)
      before = await fetchDelawareCfrsCandidateSourcePacket(candidateInput);
    after = await fetchDelawareCfrsCandidateSourcePacket(candidateInput);
    structurallyClosed = true;
  } catch (error) {
    safeFailure(
      error,
      "Candidate refresh structural closure unavailable; prior bundle unchanged",
    );
  }
  let globalClosing:
    | Awaited<ReturnType<typeof fetchDelawareCfrsCompleteCommitteeRegistry>>
    | undefined;
  try {
    globalClosing = await fetchDelawareCfrsCompleteCommitteeRegistry({
      sessionOptions: options,
    });
    diagnostics.push(...globalClosing.diagnostics);
  } catch (error) {
    safeFailure(error, "Closing donor registry unavailable; PAC must preserve");
  }
  let officialAfter: Pair | undefined;
  if (authorityKind === "incumbent_same_office")
    try {
      officialAfter = await officialPair();
    } catch (error) {
      safeFailure(error, "Fresh official closing unavailable");
    }
  let accepted: DelawareCurrentCandidateCashResult = { diagnostics: [] };
  async function verifyCandidate() {
    if (!before || !after)
      return {
        diagnostics: ["Candidate full opening/closing unavailable"],
      } as DelawareCurrentCandidateCashResult;
    const campaignAuthority: DelawareCurrentCashCampaignAuthority =
      authorityKind === "new_account"
        ? { kind: "new_account" }
        : officialBefore && officialAfter
          ? {
              kind: "incumbent_same_office",
              before: officialBefore,
              after: officialAfter,
            }
          : fail();
    const registryAuthority = (
      caps: readonly DelawareCfrsResponseCapture[],
    ) => {
      try {
        return authorityCaptures(caps);
      } catch {
        diagnostics.push(
          "Donor registry retry/scope closure unavailable; PAC preserved independently",
        );
        return [];
      }
    };
    return verifyDelawareCurrentCandidateCash({
      target,
      campaignAuthority,
      before: candidateAuthority(before),
      after: candidateAuthority(after),
      donorRegistryBefore: registryAuthority(registryBefore),
      donorRegistryAfter: globalClosing
        ? registryAuthority(globalClosing.sourceCaptures)
        : [],
    });
  }
  try {
    accepted = await verifyCandidate();
  } catch {
    diagnostics.push("Candidate source authority cannot close");
  }
  if (!accepted.cash && usedSaved && after && structurallyClosed && !budget) {
    diagnostics.push(
      "Saved opening changed/unresolved; one genuine fresh restart",
    );
    before = after;
    registryBefore = globalOpening.sourceCaptures;
    officialBefore = freshOfficialOpening;
    try {
      after = await fetchDelawareCfrsCandidateSourcePacket(candidateInput);
      globalClosing = await fetchDelawareCfrsCompleteCommitteeRegistry({
        sessionOptions: options,
      });
      if (authorityKind === "incumbent_same_office")
        officialAfter = await officialPair();
      accepted = await verifyCandidate();
    } catch (error) {
      structurallyClosed = false;
      safeFailure(
        error,
        "Fresh restart could not close; prior bundle unchanged",
      );
      accepted = { diagnostics: [] };
    }
  }
  diagnostics.push(...accepted.diagnostics);
  let discovered = globalOpening.rows ?? [];
  if (!globalOpening.rows)
    try {
      discovered = (await scopedRegistry(options, "04")).rows;
    } catch (error) {
      safeFailure(
        error,
        "Third-party catalog unavailable; outside discovery incomplete",
      );
    }
  let prior: DelawareOutsidePayerScope[] = [];
  try {
    prior = priorPayers(input.priorOutsideProvenance, context);
  } catch {
    diagnostics.push(
      "Prior payer authority malformed/incompatible; omission is not deletion",
    );
  }
  const priorIds = new Set(prior.map((p) => p.cfId));
  const catalogs = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const row of discovered)
    if (
      typeof row.Committee_Id === "string" &&
      /^04\d{6}$/.test(row.Committee_Id) &&
      row.CommitteeTypeCode === "04"
    )
      catalogs.set(row.Committee_Id, [
        ...(catalogs.get(row.Committee_Id) ?? []),
        row,
      ]);
  for (const p of prior) if (!catalogs.has(p.cfId)) catalogs.set(p.cfId, []);
  const recent = (rows: readonly Readonly<Record<string, unknown>>[]) =>
    Math.max(
      0,
      ...rows.map((r) =>
        typeof r.RegisteredDateStr === "string"
          ? Date.parse(r.RegisteredDateStr) || 0
          : 0,
      ),
    );
  const ordered = [...catalogs.entries()].sort(
    ([a, ar], [b, br]) =>
      Number(priorIds.has(b)) - Number(priorIds.has(a)) ||
      recent(br) - recent(ar) ||
      a.localeCompare(b),
  );
  const payerClosings: {
    payer: DelawareOutsidePayerScope;
    packet: DelawareOutsideSourcePacket;
  }[] = [];
  const names = after
    ? (() => {
        try {
          return sourceCandidateNames(after, context.candidateName);
        } catch {
          return [context.candidateName];
        }
      })()
    : [context.candidateName];
  let probes = 0,
    financial = 0;
  for (const [cfId, rows] of ordered) {
    if (probes >= 64 || budget) {
      diagnostics.push(
        "Outside discovery/probe bound reached; coverage incomplete, no zero authority",
      );
      break;
    }
    probes++;
    try {
      const discovery = await scopedRegistry(options, "04", cfId, true);
      const resolvedPayer = resolveOwner(discovery.rows, cfId);
      if (
        !priorIds.has(cfId) &&
        !affiliationLead(discovery.captures, names, context)
      )
        continue;
      if (financial >= 16) {
        if (
          !diagnostics.includes(
            "Outside financial-lead bound reached; additional affiliations remain unknown",
          )
        )
          diagnostics.push(
            "Outside financial-lead bound reached; additional affiliations remain unknown",
          );
        continue;
      }
      const payer: DelawareOutsidePayerScope = {
        ...resolvedPayer,
        committeeType: "04",
      };
      financial++;
      let opening: DelawareOutsideSourcePacket | undefined;
      const cached = saved?.sourcePacketIndex?.payers.find(
        (p) =>
          p.cfId === payer.cfId &&
          p.memberId === payer.memberId &&
          sameName(p.committeeName, payer.committeeName),
      );
      if (!input.refresh && cached && saved?.sourceCaptures)
        try {
          opening = cachedPayer(cached, saved.sourceCaptures);
        } catch {
          diagnostics.push("Saved payer opening incompatible");
        }
      if (!opening) {
        const fetched = await fetchDelawareCfrsThirdPartySourcePacket({
          payer,
          candidate: target,
          sessionOptions: options,
        });
        diagnostics.push(...fetched.diagnostics);
        opening = fetched.packet;
      }
      const closing = await fetchDelawareCfrsThirdPartySourcePacket({
        payer,
        candidate: target,
        sessionOptions: options,
      });
      diagnostics.push(...closing.diagnostics);
      if (!opening || !closing.packet) continue;
      let result = await verifyDelawareThirdPartyOutsideSource({
        payer,
        candidate: target,
        before: payerAuthority(opening),
        after: payerAuthority(closing.packet),
      });
      let final = closing.packet;
      if (!result.proof && cached && !input.refresh && !budget) {
        const restarted = await fetchDelawareCfrsThirdPartySourcePacket({
          payer,
          candidate: target,
          sessionOptions: options,
        });
        diagnostics.push(...restarted.diagnostics);
        if (restarted.packet) {
          result = await verifyDelawareThirdPartyOutsideSource({
            payer,
            candidate: target,
            before: payerAuthority(closing.packet),
            after: payerAuthority(restarted.packet),
          });
          final = restarted.packet;
        }
      }
      diagnostics.push(...result.diagnostics);
      if (result.proof) outsideEvidence.push(result.proof);
      payerClosings.push({ payer, packet: final });
    } catch (error) {
      safeFailure(
        error,
        "One payer source/affiliation/current financial closure unavailable; prior evidence preserved",
      );
    }
  }
  diagnostics.push(
    `Outside discovery inspected ${probes} payer identities and ${financial} financial leads; scoped positive reports only`,
  );
  let bundleCommitted = false;
  if (
    structurallyClosed &&
    after &&
    globalClosing?.sourceCaptures.length &&
    globalOpening.sourceCaptures.length
  ) {
    try {
      // Cache the complete current closing, not a synthesized fresh copy of an old opening.
      const all = [...journal];
      const indices = (caps: readonly DelawareCfrsResponseCapture[]) =>
        caps.map((c) => {
          let index = all.findIndex(
            (a) =>
              a.url === c.url &&
              a.method === c.method &&
              a.startedAt === c.startedAt &&
              a.completedAt === c.completedAt &&
              a.sha256 === c.sha256 &&
              a.attempt === c.attempt,
          );
          if (index < 0) {
            index = all.length;
            all.push(copy(c));
          }
          return index;
        });
      const candidateCaptureIndices = indices(after.sourceCaptures),
        registryOpeningCaptureIndices = indices(globalOpening.sourceCaptures),
        registryClosingCaptureIndices = indices(globalClosing.sourceCaptures);
      const payers = payerClosings.map(({ payer, packet }) => ({
        ...payer,
        facets: {
          registry: indices(packet.registry),
          payerOrganization: indices(packet.payerOrganization),
          receiverIdentity: indices(packet.receiverIdentity),
          candidateCycleAuthority: indices(packet.candidateCycleAuthority),
          allVersionReports: indices(packet.allVersionReports),
          latestAccountReport: indices(packet.latestAccountReport),
          genericMemberReceipts: indices(packet.genericMemberReceipts),
          thirdPartyReceiptExport: indices(packet.thirdPartyReceiptExport),
          expenses: indices(packet.expenses),
          reportPdfs: indices(packet.reportPdfs),
          ...(packet.unsupportedFacets
            ? { unsupportedFacets: indices(packet.unsupportedFacets) }
            : {}),
        },
      }));
      const reportSearch = after.sourceCaptures.findIndex(
        (c) =>
          path(c) === DELAWARE_CFRS_PAGES.filedReportsSearch &&
          c.method === "POST",
      );
      const nextSearch = after.sourceCaptures.findIndex(
        (c, i) =>
          i > reportSearch &&
          path(c) === DELAWARE_CFRS_PAGES.filedReportsSearch &&
          c.method === "POST",
      );
      const pages = after.sourceCaptures
        .slice(reportSearch, nextSearch)
        .filter(
          (c) =>
            path(c) === DELAWARE_CFRS_PAGES.filedReportsGridJson &&
            c.status === 200,
        );
      if (pages.length !== 1) fail(); // The legacy HTML artifact must itself be complete; raw multi-pages remain journaled.
      await storeDelawareCfrsCommitteeArtifacts({
        cacheDir: input.cacheDir,
        ...resolved,
        sourceUrl: buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch),
        receiptsCsv: after.receiptsCsv,
        receiptsSearchTotal: after.receiptRenderedCount,
        expensesCsv: after.expensesCsv,
        expensesSearchTotal: after.expenseRenderedCount,
        filedReportsHtml: text(pages[0]!),
        reportPdfs: after.reportPdfs,
        sourceCaptures: all,
        sourcePacketIndex: {
          version: 1,
          ...resolved,
          requestWindow,
          candidateCaptureIndices,
          registryOpeningCaptureIndices,
          registryClosingCaptureIndices,
          payers,
        },
        ...(officialSources.length
          ? { officialElectionSources: officialSources }
          : {}),
      });
      bundleCommitted = true;
    } catch (error) {
      safeFailure(
        error,
        "Current source bundle could not commit atomically; old bundle unchanged",
      );
    }
  }
  if (budget)
    diagnostics.push(
      "Source request/byte budget reached; unavailable components preserved",
    );
  diagnostics.push(
    "Independently timestamped public observations; later filings/amendments remain unknown and require post-deadline reruns",
  );
  for (const diagnostic of diagnostics) input.log?.(diagnostic);
  // Durable original authority and the modern index must accompany writable
  // evidence; otherwise an old unindexed bundle could later regain authority.
  return {
    ...(bundleCommitted && accepted.cash ? { cash: accepted.cash } : {}),
    ...(bundleCommitted && accepted.pac ? { pac: accepted.pac } : {}),
    outsideEvidence: bundleCommitted ? outsideEvidence : [],
    diagnostics,
  };
}

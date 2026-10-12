import type { Pool, PoolClient } from "pg";
import {
  DELAWARE_CFRS_PAGES,
  isDelawareCfrsPublicReportFileName,
  type DelawareCfrsResponseCapture,
} from "./delawareCfrsClient.js";
import { normalizeDelawareCandidateNameForStorage } from "./delawareCandidateCommitteeResolver.js";
import type { DelawareFinanceLinkInput } from "./delawareFinanceWriter.js";
import type { DelawareVerifiedThirdPartyOutsideProof as Proof } from "./delawareThirdPartyOutsideSource.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type Group = {
  committee_id: string;
  committee_name: string;
  support_oppose: "support" | "oppose";
  amount: number;
  source_url: string;
};
export type DelawareOutsideReportProvenance = {
  version: 1;
  scope: "reported_third_party_outside_expenses";
  evidence: readonly Proof[];
};
const scope = "reported_third_party_outside_expenses";
const origin = "https://cfrs.elections.delaware.gov";
const hash = /^[a-f0-9]{64}$/;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const display = (v: string) => v.replace(/\s+/gu, " ").trim();
const same = (a: string, b: string) =>
  display(a).toUpperCase() === display(b).toUpperCase();
function fail(): never {
  throw new Error("invalid scoped outside evidence");
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) fail();
  return v;
}
function integer(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) fail();
  return v as number;
}
function digest(v: unknown): string {
  if (typeof v !== "string" || !hash.test(v)) fail();
  return v;
}
function date(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v + "T00:00:00Z")) ||
    new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v
  )
    fail();
  return v;
}
function timestamp(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    fail();
  return v;
}
function official(v: unknown): URL {
  const u = new URL(text(v));
  if (
    u.origin !== origin ||
    u.username ||
    u.password ||
    u.hash ||
    u.port ||
    !new Set<string>(Object.values(DELAWARE_CFRS_PAGES)).has(u.pathname)
  )
    fail();
  const allowed = new Set([
    "theme",
    "ajax",
    "Grid-page",
    "Grid-size",
    "Grid-orderBy",
    "Grid-groupBy",
    "Grid-filter",
    "FileName",
    "CommitteeID",
    "FilingCalendarID",
    "memberID",
    "memVersID",
    "cTypeCode",
    "fpath",
    "ftype",
    "isPublic",
    "q",
    "fname",
    "filter",
    "orderBy",
    "page",
  ]);
  for (const [k, value] of u.searchParams) {
    if (
      !allowed.has(k) ||
      u.searchParams.getAll(k).length !== 1 ||
      value.length > 1000
    )
      fail();
    if (k === "FileName" && !isDelawareCfrsPublicReportFileName(value)) fail();
    if (["fpath", "fname"].includes(k) && value !== "") fail();
    if (
      [
        "filter",
        "Grid-filter",
        "orderBy",
        "Grid-orderBy",
        "Grid-groupBy",
      ].includes(k) &&
      !["", "~"].includes(value)
    )
      fail();
  }
  return u;
}
const financeKeys = new Set(
  "CommitteeStatus CommitteeType CommitteeTypeData ContributionType ContributorType FilingPeriodName FilingYear FormType MemberId ReportName Submit btnSearch chkTP chkViewCurrReport committeeNameData ddlCounty ddlElectiontype ddlExpenCategory ddlExpensePurpose ddlOffice ddlOfficeSought ddlPayeeType ddljurisdiction dtCloseEndDate dtCloseStartDate dtEndDate dtStartDate expenseCategoryData expensePruposeData filingYearData filter groupBy hdnCommitteeName hdnFilingPeriodName hdnFixedAssets hdnReportName hdnTP hdnViewCurrent hdnddlCounty hdnddlOffice hdnddlOfficeSought hdnddljurisdiction orderBy page payeeTypeData rdGroup size txtCommitteeID txtCommitteeName txtContributorName txtFirstName txtPayeeFirstName txtPayeeLastName txtReceivingRegistrant txtRegistrant".split(
    " ",
  ),
);
function metadata(
  m: Omit<DelawareCfrsResponseCapture, "body">,
): Omit<DelawareCfrsResponseCapture, "body"> {
  official(m.url);
  const url = m.url;
  if (
    !(["GET", "POST"] as const).includes(m.method) ||
    m.status !== 200 ||
    m.requestScopeRedacted !== false ||
    !Number.isSafeInteger(m.byteCount) ||
    m.byteCount <= 0 ||
    m.byteCount > 4 * 1024 * 1024 ||
    (m.contentType !== null && typeof m.contentType !== "string")
  )
    fail();
  const startedAt = timestamp(m.startedAt),
    completedAt = timestamp(m.completedAt);
  if (startedAt > completedAt) fail();
  let financeFields: Record<string, string> | null = null;
  if (m.method === "POST") {
    if (
      !m.financeFields ||
      typeof m.financeFields !== "object" ||
      Array.isArray(m.financeFields)
    )
      fail();
    financeFields = {};
    for (const [k, v] of Object.entries(m.financeFields)) {
      if (!financeKeys.has(k) || typeof v !== "string" || v.length > 1000)
        fail();
      financeFields[k] = v;
    }
  } else if (m.financeFields !== null) fail();
  return {
    url,
    method: m.method,
    financeFields,
    requestScopeRedacted: false,
    attempt: integer(m.attempt),
    startedAt,
    completedAt,
    status: 200,
    contentType: m.contentType,
    byteCount: m.byteCount,
    sha256: digest(m.sha256),
  };
}
function project(value: Proof, link: DelawareFinanceLinkInput): Proof {
  if (
    !value ||
    value.version !== 1 ||
    value.scope !== scope ||
    value.candidateWideZeroAuthority !== false ||
    value.qualificationBasis !== "source_reported_candidate_period_within_cycle"
  )
    fail();
  const c = value.candidate,
    p = value.payer;
  const expectedOffice =
    link.officeName === "State Auditor"
      ? "Auditor of Accounts"
      : link.officeName;
  if (
    !c ||
    !p ||
    !uuid.test(link.candidateId) ||
    !uuid.test(link.electionId) ||
    c.candidateId !== link.candidateId ||
    c.electionId !== link.electionId ||
    c.electionYear !== link.electionYear ||
    !Number.isSafeInteger(c.electionYear) ||
    c.electionYear < 2026 ||
    c.electionYear > 2100 ||
    c.electionStage !== "general" ||
    Number(date(c.electionDate).slice(0, 4)) !== c.electionYear ||
    normalizeDelawareCandidateNameForStorage(text(c.candidateName)) !==
      link.candidateNameNormalized ||
    c.receivingCfId !== link.committeeId ||
    !/^01\d{6}$/.test(c.receivingCfId) ||
    !same(text(c.receivingCommitteeName), link.committeeName) ||
    c.officeName !== expectedOffice ||
    // Legacy statewide links store the literal state label; the finite office
    // check below keeps this projection unavailable to legislative seats.
    c.district !==
      (link.district === "Delaware" ? null : (link.district ?? null)) ||
    c.district !== null ||
    ![
      "Attorney General",
      "Governor",
      "Lieutenant Governor",
      "State Treasurer",
      "Insurance Commissioner",
      "Auditor of Accounts",
    ].includes(c.officeName) ||
    !/^04\d{6}$/.test(p.cfId) ||
    p.committeeType !== "04"
  )
    fail();
  const candidate = {
    candidateId: c.candidateId,
    electionId: c.electionId,
    electionYear: c.electionYear,
    electionDate: c.electionDate,
    electionStage: c.electionStage,
    candidateName: c.candidateName,
    officeName: c.officeName,
    district: c.district,
    party: text(c.party),
    receivingCfId: c.receivingCfId,
    receivingMemberId: integer(c.receivingMemberId),
    receivingCommitteeName: c.receivingCommitteeName,
  };
  const payer = {
    cfId: p.cfId,
    memberId: integer(p.memberId),
    committeeName: text(p.committeeName),
    committeeType: p.committeeType,
  };
  if (
    !Array.isArray(value.reports) ||
    !value.reports.length ||
    !Array.isArray(value.allocations) ||
    !value.allocations.length ||
    !Array.isArray(value.sourceMetadata) ||
    !value.sourceMetadata.length ||
    value.sourceMetadata.length > 240
  )
    fail();
  const reports = value.reports.map((r) => {
    if (
      r.currentAuthority !== "sole_report_in_complete_period_inventory" ||
      !isDelawareCfrsPublicReportFileName(r.fileName) ||
      r.memberId !== payer.memberId ||
      date(r.periodStart) > date(r.periodEnd)
    )
      fail();
    const u = official(r.sourceUrl);
    if (
      u.pathname !== "/Public/FiledReports" ||
      [...u.searchParams].length !== 3 ||
      u.searchParams.get("FileName") !== r.fileName ||
      u.searchParams.get("CommitteeID") !== String(r.memberId) ||
      u.searchParams.get("FilingCalendarID") !== String(r.filingCalendarId)
    )
      fail();
    return {
      fileName: r.fileName,
      sourceUrl: r.sourceUrl,
      memberId: r.memberId,
      filingCalendarId: integer(r.filingCalendarId),
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      pdfSha256: digest(r.pdfSha256),
      inventoryFingerprint: digest(r.inventoryFingerprint),
      financialFingerprint: digest(r.financialFingerprint),
      currentAuthority: r.currentAuthority,
    };
  });
  if (new Set(reports.map((r) => r.fileName)).size !== reports.length) fail();
  const sorted = [...reports].sort((a, b) =>
    a.periodStart.localeCompare(b.periodStart),
  );
  if (sorted.some((r, i) => i > 0 && sorted[i - 1]!.periodEnd >= r.periodStart))
    fail();
  const allocations = value.allocations.map((a) => {
    const r = reports.find((r) => r.fileName === a.reportFileName);
    const literal =
      /^(Support|Oppose) of (.+) - State Office - (.+) - (.+)$/.exec(
        text(a.literalTarget),
      );
    const bridge =
      c.receivingCfId === "01004199" &&
      c.receivingMemberId === 458984 &&
      same(c.receivingCommitteeName, "Friends of Kathy Jennings") &&
      same(c.candidateName, "Kathy Jennings") &&
      literal?.[2] === "Kathleen Jennings" &&
      c.officeName === "Attorney General" &&
      c.party === "Democratic";
    if (
      !r ||
      !Number.isSafeInteger(a.occurrence) ||
      a.occurrence < 0 ||
      !["support", "oppose"].includes(a.direction) ||
      date(a.date) < r.periodStart ||
      a.date > r.periodEnd ||
      !literal ||
      literal[1]!.toLowerCase() !== a.direction ||
      (!same(literal[2]!, c.candidateName) && !bridge) ||
      literal[3] !== c.officeName ||
      literal[4] !== c.party ||
      a.sourceNativeCategory !== "Other Expenses" ||
      !isDelawareCfrsPublicReportFileName(a.qualificationReportFileName)
    )
      fail();
    return {
      transactionId: integer(a.transactionId),
      reportFileName: a.reportFileName,
      occurrence: a.occurrence,
      date: a.date,
      amountCents: integer(a.amountCents),
      direction: a.direction,
      literalTarget: a.literalTarget,
      sourceNativeCategory: a.sourceNativeCategory,
      nativeRowFingerprint: digest(a.nativeRowFingerprint),
      qualificationReportFileName: a.qualificationReportFileName,
    };
  });
  if (
    new Set(allocations.map((a) => a.transactionId)).size !==
      allocations.length ||
    new Set(allocations.map((a) => `${a.reportFileName}:${a.occurrence}`))
      .size !== allocations.length
  )
    fail();
  const sourceMetadata = value.sourceMetadata.map(metadata);
  // Original source envelopes do not have invented phase labels. Only exact
  // paired payer PDF captures can establish the closing watermark below.
  for (const r of reports) {
    const pair = sourceMetadata.filter(
      (m) =>
        m.url === r.sourceUrl &&
        m.method === "GET" &&
        m.sha256 === r.pdfSha256 &&
        m.contentType?.includes("pdf"),
    );
    if (pair.length !== 2 || pair[0]!.completedAt > pair[1]!.startedAt) fail();
  }
  const pairs = reports.map((r) =>
    sourceMetadata.filter(
      (m) =>
        m.url === r.sourceUrl && m.method === "GET" && m.sha256 === r.pdfSha256,
    ),
  );
  if (
    Math.max(...pairs.map((p) => Date.parse(p[0]!.completedAt))) >
    Math.min(...pairs.map((p) => Date.parse(p[1]!.startedAt)))
  )
    fail();
  return {
    version: 1,
    scope,
    candidateWideZeroAuthority: false,
    candidate,
    payer,
    qualificationBasis: "source_reported_candidate_period_within_cycle",
    reports,
    allocations,
    sourceMetadata,
  };
}
const periodKey = (r: Proof["reports"][number]) =>
  `${r.periodStart}:${r.periodEnd}`;
function closing(proof: Proof): number[] {
  return proof.reports.map((r) =>
    Date.parse(
      proof.sourceMetadata.filter(
        (m) =>
          m.url === r.sourceUrl &&
          m.sha256 === r.pdfSha256 &&
          m.method === "GET",
      )[1]!.completedAt,
    ),
  );
}
function groups(proofs: readonly Proof[]): Group[] {
  return proofs.flatMap((p) => {
    const byDirection = new Map<
      "support" | "oppose",
      { cents: number; first: Proof["allocations"][number] }
    >();
    for (const a of p.allocations) {
      const previous = byDirection.get(a.direction),
        cents = (previous?.cents ?? 0) + a.amountCents;
      if (!Number.isSafeInteger(cents) || cents > 9999999999999999) fail();
      byDirection.set(a.direction, {
        cents,
        first:
          previous && previous.first.transactionId < a.transactionId
            ? previous.first
            : a,
      });
    }
    for (const v of byDirection.values())
      if (cents(v.cents / 100) !== v.cents) fail();
    return [...byDirection].map(([support_oppose, v]) => ({
      committee_id: p.payer.cfId,
      committee_name: p.payer.committeeName,
      support_oppose,
      amount: v.cents / 100,
      source_url: p.reports.find((r) => r.fileName === v.first.reportFileName)!
        .sourceUrl,
    }));
  });
}
function cents(v: unknown): number | null {
  const s = String(v);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const n = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(n) ? n : null;
}
/** The caller holds the snapshot transaction, summary row and receiver/year lock. */
export async function writeDelawareOutsideEvidence(input: {
  db: Queryable;
  linkId: string;
  link: DelawareFinanceLinkInput;
  syncedAt: Date;
  prior: unknown;
  incoming: readonly Proof[];
}): Promise<{ groupsWritten: number; diagnostics: readonly string[] }> {
  const db = input.db;
  const diagnostics: string[] = [];
  let previous: Proof[],
    combined: Proof[],
    next: Group[],
    expected: Group[],
    link: DelawareFinanceLinkInput,
    linkId: string,
    syncedAt: Date;
  try {
    // Snapshot all caller data before any database await; keep the DB handle outside.
    link = structuredClone(input.link);
    linkId = input.linkId;
    syncedAt = new Date(input.syncedAt);
    const incoming = structuredClone(input.incoming),
      prior = structuredClone(input.prior);
    if (
      !uuid.test(linkId) ||
      !Number.isFinite(syncedAt.getTime()) ||
      (link.linkStatus !== undefined && link.linkStatus !== "active")
    )
      fail();
    if (!incoming.length) return { groupsWritten: 0, diagnostics };
    if (prior === null || prior === undefined) previous = [];
    else {
      if (
        !prior ||
        typeof prior !== "object" ||
        Array.isArray(prior) ||
        (prior as Record<string, unknown>).version !== 1 ||
        (prior as Record<string, unknown>).scope !== scope ||
        !Array.isArray((prior as Record<string, unknown>).evidence)
      )
        fail();
      const saved = prior as Record<string, unknown>;
      previous = (saved.evidence as Proof[]).map((p) => project(p, link));
    }
    if (new Set(previous.map((p) => p.payer.cfId)).size !== previous.length)
      fail();
    if (
      new Set(
        previous.flatMap((p) => p.allocations.map((a) => a.transactionId)),
      ).size !== previous.reduce((n, p) => n + p.allocations.length, 0)
    )
      fail();
    combined = [...previous];
    const counts = new Map<string, number>();
    for (const raw of incoming)
      if (raw?.payer?.cfId)
        counts.set(raw.payer.cfId, (counts.get(raw.payer.cfId) ?? 0) + 1);
    const incomingOwners = new Map<number, Set<string>>();
    for (const raw of incoming)
      if (raw?.payer?.cfId && Array.isArray(raw.allocations))
        for (const a of raw.allocations) {
          const owners =
            incomingOwners.get(a.transactionId) ?? new Set<string>();
          owners.add(raw.payer.cfId);
          incomingOwners.set(a.transactionId, owners);
        }
    const accepted = new Set<string>();
    for (const raw of incoming) {
      let p: Proof;
      try {
        p = project(raw, link);
        if (
          counts.get(p.payer.cfId) !== 1 ||
          p.allocations.some(
            (a) =>
              (incomingOwners.get(a.transactionId)?.size ?? 0) > 1 ||
              previous.some(
                (old) =>
                  old.payer.cfId !== p.payer.cfId &&
                  old.allocations.some(
                    (v) => v.transactionId === a.transactionId,
                  ),
              ),
          )
        )
          fail();
        const old = previous.find((v) => v.payer.cfId === p.payer.cfId);
        if (
          old &&
          (JSON.stringify(old.candidate) !== JSON.stringify(p.candidate) ||
            JSON.stringify(old.payer) !== JSON.stringify(p.payer) ||
            old.reports.some(
              (r) => !p.reports.some((n) => periodKey(n) === periodKey(r)),
            ) ||
            old.allocations.some(
              (a) =>
                !p.allocations.some(
                  (n) =>
                    n.transactionId === a.transactionId &&
                    n.direction === a.direction,
                ),
            ) ||
            Math.min(...closing(p)) <= Math.max(...closing(old)))
        )
          fail();
        const i = combined.findIndex((v) => v.payer.cfId === p.payer.cfId);
        if (i < 0) combined.push(p);
        else combined[i] = p;
        accepted.add(p.payer.cfId);
      } catch {
        diagnostics.push(
          "Outside payer refresh preserved: invalid, stale, changed scope or missing prior authority",
        );
      }
    }
    expected = groups(previous);
    next = groups(combined.filter((p) => accepted.has(p.payer.cfId)));
    if (!next.length) return { groupsWritten: 0, diagnostics };
  } catch {
    return {
      groupsWritten: 0,
      diagnostics: ["Outside snapshot preserved: invalid scoped provenance"],
    };
  }
  const stored = await db.query<{
    committee_id: string;
    committee_name: string;
    support_oppose: string;
    amount: string | number;
    source_url: string | null;
  }>(
    `SELECT committee_id, committee_name, support_oppose, amount, source_url FROM public.de_candidate_finance_outside_groups WHERE link_id = $1::uuid AND election_year = $2::integer FOR UPDATE`,
    [linkId, link.electionYear],
  );
  if (
    stored.rows.length !== expected.length ||
    !stored.rows.every((r) =>
      expected.some(
        (g) =>
          g.committee_id === r.committee_id &&
          g.committee_name === r.committee_name &&
          g.support_oppose === r.support_oppose &&
          cents(r.amount) === cents(g.amount) &&
          r.source_url === g.source_url,
      ),
    )
  )
    return {
      groupsWritten: 0,
      diagnostics: [
        ...diagnostics,
        "Outside snapshot preserved: stored groups lack matching scoped authority",
      ],
    };
  await db.query(
    `INSERT INTO public.de_candidate_finance_outside_groups (link_id, election_year, committee_id, committee_name, support_oppose, amount, source_url, last_synced_at, updated_at)
    SELECT $1::uuid, $2::integer, g.committee_id, g.committee_name, g.support_oppose, g.amount, g.source_url, $4::timestamptz, $4::timestamptz
    FROM jsonb_to_recordset($3::jsonb) AS g(committee_id text, committee_name text, support_oppose text, amount numeric, source_url text)
    ON CONFLICT (link_id, election_year, committee_id, support_oppose) DO UPDATE SET committee_name = EXCLUDED.committee_name, amount = EXCLUDED.amount, source_url = EXCLUDED.source_url, last_synced_at = EXCLUDED.last_synced_at, updated_at = EXCLUDED.updated_at`,
    [linkId, link.electionYear, JSON.stringify(next), syncedAt],
  );
  const saved = await db.query(
    `UPDATE public.de_candidate_finance_summaries SET outside_report_provenance = $3::jsonb WHERE link_id = $1::uuid AND election_year = $2::integer`,
    [
      linkId,
      link.electionYear,
      JSON.stringify({
        version: 1,
        scope,
        evidence: combined,
      } satisfies DelawareOutsideReportProvenance),
    ],
  );
  if (saved.rowCount !== 1)
    throw new Error("Delaware outside summary row unavailable");
  return { groupsWritten: next.length, diagnostics };
}

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { normalizeDelawareCandidateNameForStorage } from "./delawareCandidateCommitteeResolver.js";
import { isDelawareCfrsPublicReportFileName } from "./delawareCfrsClient.js";
import type { DelawareFinanceLinkInput } from "./delawareFinanceWriter.js";
import type { verifyDelawareCurrentCandidateCash } from "./delawareCurrentCandidateCashSource.js";
import {
  projectDelawareFinanceSourceMetadata as metadata,
  type DelawareFinanceSourceMetadata,
} from "./delawareOutsideEvidenceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
export type DelawarePacEvidence = Extract<
  Awaited<ReturnType<typeof verifyDelawareCurrentCandidateCash>>,
  { pac: unknown }
>["pac"];
const scope = "current_qualified_named_committee_gift_positions";
const digest = /^[a-f0-9]{64}$/;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const display = (s: string) => s.replace(/\s+/gu, " ").trim();
const name = (s: string) => display(s).toUpperCase();
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function fail(): never {
  throw new Error("invalid committee gift authority");
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) fail();
  return v;
}
function cents(v: unknown): number {
  if (!Number.isSafeInteger(v)) fail();
  return v as number;
}
function positive(v: unknown): number {
  const n = cents(v);
  if (n <= 0) fail();
  return n;
}
function hash(v: unknown): string {
  if (typeof v !== "string" || !digest.test(v)) fail();
  return v;
}
function date(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d\d-\d\d$/.test(v) ||
    !Number.isFinite(Date.parse(v + "T00:00:00Z")) ||
    new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v
  )
    fail();
  return v;
}
function sum(values: readonly number[]): number {
  return values.reduce((n, v) => cents(n + v), 0);
}
function decimal(n: number): string {
  cents(n);
  const absolute = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
function storedCents(v: unknown): number | null {
  if (
    (typeof v !== "string" && typeof v !== "number") ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(v))
  )
    return null;
  const [whole, fraction = ""] = String(v).replace(/^-/, "").split(".");
  const n = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  const signed = String(v).startsWith("-") ? -n : n;
  return signed > BigInt(Number.MAX_SAFE_INTEGER) ||
    signed < BigInt(Number.MIN_SAFE_INTEGER)
    ? null
    : Number(signed);
}
function context(
  p: DelawarePacEvidence["sourceProvenance"]["target"],
  link: DelawareFinanceLinkInput,
) {
  const office =
    link.officeName === "State Auditor"
      ? "Auditor of Accounts"
      : link.officeName === "State Lower Chamber Legislator"
        ? "State Representative"
        : link.officeName;
  const statewide = [
    "Attorney General",
    "Governor",
    "Lieutenant Governor",
    "State Treasurer",
    "Insurance Commissioner",
    "Auditor of Accounts",
  ].includes(office);
  if (
    !p ||
    !uuid.test(link.candidateId) ||
    !uuid.test(link.electionId) ||
    p.candidateId !== link.candidateId ||
    p.electionId !== link.electionId ||
    p.electionYear !== link.electionYear ||
    !Number.isSafeInteger(p.electionYear) ||
    p.electionYear < 2026 ||
    p.electionYear > 2100 ||
    p.electionStage !== "general" ||
    Number(date(p.electionDate).slice(0, 4)) !== p.electionYear ||
    normalizeDelawareCandidateNameForStorage(text(p.candidateName)) !==
      link.candidateNameNormalized ||
    p.receivingCfId !== link.committeeId ||
    !/^01\d{6}$/.test(p.receivingCfId) ||
    name(text(p.receivingCommitteeName)) !== name(link.committeeName) ||
    p.officeName !== office ||
    !text(p.party)
  )
    fail();
  if (
    statewide
      ? p.district !== null ||
        ![null, undefined, "Delaware"].includes(link.district)
      : office !== "State Representative" ||
        !p.district ||
        !/^[1-9]\d*$/.test(p.district) ||
        Number(p.district) > 41 ||
        !/^(?:District )?0*[1-9]\d*$/.test(link.district ?? "") ||
        Number((link.district ?? "").replace(/^District /, "")) !==
          Number(p.district)
  )
    fail();
  return {
    candidateId: p.candidateId,
    electionId: p.electionId,
    electionYear: p.electionYear,
    electionDate: p.electionDate,
    electionStage: p.electionStage,
    candidateName: p.candidateName,
    officeName: p.officeName,
    district: p.district,
    party: p.party,
    receivingCfId: p.receivingCfId,
    receivingMemberId: positive(p.receivingMemberId),
    receivingCommitteeName: p.receivingCommitteeName,
  };
}
function sourceReport(
  url: string,
  file: string,
  member: number,
  calendar: number,
) {
  const u = new URL(url);
  if (
    u.pathname !== "/Public/FiledReports" ||
    [...u.searchParams].length !== 3 ||
    u.searchParams.get("FileName") !== file ||
    u.searchParams.get("CommitteeID") !== String(member) ||
    u.searchParams.get("FilingCalendarID") !== String(calendar)
  )
    fail();
}
function project(
  incoming: DelawarePacEvidence,
  link: DelawareFinanceLinkInput,
) {
  const p = incoming.sourceProvenance;
  if (
    !p ||
    p.version !== 1 ||
    p.scope !== scope ||
    !Array.isArray(incoming.donors) ||
    !Array.isArray(p.donors)
  )
    fail();
  const target = context(p.target, link);
  const window = {
    start: date(p.window.start),
    end: date(p.window.end),
    basis: text(p.window.basis),
    sources: p.window.sources.map((m) => metadata(m, "official_election")),
  };
  if (
    window.start > window.end ||
    window.end !== `${target.electionYear}-12-31` ||
    ![
      "complete_new_account_current_candidacy",
      "official_same_office_winner_and_current_ballot",
    ].includes(window.basis) ||
    (window.basis === "complete_new_account_current_candidacy"
      ? window.sources.length !== 0
      : window.sources.length !== 4)
  )
    fail();
  const sourceMetadata = p.sourceMetadata.map((m) => metadata(m)),
    registrySources = p.registrySources.map((m) => metadata(m));
  if (
    !sourceMetadata.length ||
    sourceMetadata.length > 1000 ||
    !registrySources.length ||
    registrySources.length > 100
  )
    fail();
  const reports = p.reports
    .map((r) => {
      if (
        !isDelawareCfrsPublicReportFileName(r.fileName) ||
        date(r.periodStart) > date(r.periodEnd) ||
        r.periodStart < window.start ||
        r.periodEnd > window.end
      )
        fail();
      const pdfSha256 = hash(r.pdfSha256),
        calendarId = positive(r.calendarId);
      const pair = sourceMetadata.filter((m) => {
        const u = new URL(m.url);
        return (
          u.searchParams.get("FileName") === r.fileName &&
          m.sha256 === pdfSha256
        );
      });
      if (
        pair.length !== 2 ||
        pair[0]!.completedAt > pair[1]!.startedAt ||
        pair[0]!.url !== pair[1]!.url
      )
        fail();
      pair.forEach((m) =>
        sourceReport(m.url, r.fileName, target.receivingMemberId, calendarId),
      );
      const cover = {
        pageNumber: positive(r.cover.pageNumber),
        beginningBalanceCents: cents(r.cover.beginningBalanceCents),
        receiptsCents: cents(r.cover.receiptsCents),
        expendituresCents: cents(r.cover.expendituresCents),
        endingBalanceCents: cents(r.cover.endingBalanceCents),
        reportingPeriodFrom:
          r.cover.reportingPeriodFrom === null
            ? null
            : text(r.cover.reportingPeriodFrom),
        reportingPeriodTo:
          r.cover.reportingPeriodTo === null
            ? null
            : text(r.cover.reportingPeriodTo),
        documentVersion:
          r.cover.documentVersion === null
            ? null
            : positive(r.cover.documentVersion),
        method: r.cover.method,
      };
      if (
        !["rows", "sequence"].includes(cover.method) ||
        sum([
          cover.beginningBalanceCents,
          cover.receiptsCents,
          -cover.expendituresCents,
        ]) !== cover.endingBalanceCents
      )
        fail();
      const anonymous = r.anonymous.map((a) => {
        if (
          !["receipts", "expenditures"].includes(a.schedule) ||
          !Array.isArray(a.nativeTransactionIds)
        )
          fail();
        const ids = a.nativeTransactionIds.map(positive);
        if (new Set(ids).size !== ids.length) fail();
        const controlCents = cents(a.controlCents),
          representedNativeCents = cents(a.representedNativeCents),
          pdfOnlyAggregateCents = cents(a.pdfOnlyAggregateCents);
        if (
          Math.min(
            controlCents,
            representedNativeCents,
            pdfOnlyAggregateCents,
          ) < 0 ||
          sum([representedNativeCents, pdfOnlyAggregateCents]) !== controlCents
        )
          fail();
        return {
          schedule: a.schedule,
          controlCents,
          representedNativeCents,
          pdfOnlyAggregateCents,
          nativeTransactionIds: ids,
        };
      });
      return {
        fileName: r.fileName,
        calendarId,
        pdfSha256,
        sourceUrl: pair[0]!.url,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        cover,
        anonymous,
      };
    })
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  if (
    !reports.length ||
    new Set(reports.map((r) => r.fileName)).size !== reports.length ||
    reports[0]!.periodStart !== window.start ||
    reports.some(
      (r, i) =>
        i > 0 &&
        (reports[i - 1]!.periodEnd >= r.periodStart ||
          reports[i - 1]!.cover.endingBalanceCents !==
            r.cover.beginningBalanceCents),
    )
  )
    fail();
  const pairStarts = reports.map(
    (r) =>
      sourceMetadata.filter(
        (m) => m.url === r.sourceUrl && m.sha256 === r.pdfSha256,
      )[1]!.startedAt,
  );
  const firstEnds = reports.map(
    (r) =>
      sourceMetadata.filter(
        (m) => m.url === r.sourceUrl && m.sha256 === r.pdfSha256,
      )[0]!.completedAt,
  );
  if (
    Math.max(...firstEnds.map(Date.parse)) >
    Math.min(...pairStarts.map(Date.parse))
  )
    fail();
  const occurrences = p.occurrences.map((o) => {
    if (
      !["receipt", "expense"].includes(o.kind) ||
      (o.kind === "receipt"
        ? o.sourceCategory !== null
        : typeof o.sourceCategory !== "string" || !o.sourceCategory.trim())
    )
      fail();
    return {
      transactionId: positive(o.transactionId),
      date: date(o.date),
      amountCents: cents(o.amountCents),
      identityFingerprint: hash(o.identityFingerprint),
      sourceClass: text(o.sourceClass),
      sourceMechanism: text(o.sourceMechanism),
      kind: o.kind,
      sourceCategory: o.sourceCategory,
    };
  });
  if (
    new Set(occurrences.map((o) => o.transactionId)).size !==
      occurrences.length ||
    occurrences.some(
      (o) =>
        !reports.some((r) => o.date >= r.periodStart && o.date <= r.periodEnd),
    )
  )
    fail();
  const claimed = new Set<number>();
  const donors = incoming.donors.map((d) => {
    const a = p.donors.find((v) => v.committeeId === d.committeeId);
    if (
      !a ||
      !["Political Action Committee", "Political Committee"].includes(
        d.committeeType,
      ) ||
      !Number.isSafeInteger(d.contributionCount) ||
      d.contributionCount < 0 ||
      d.contributionCount > 2147483647 ||
      !Array.isArray(a.sourceClasses) ||
      !a.sourceClasses.length ||
      new Set(a.sourceClasses).size !== a.sourceClasses.length
    )
      fail();
    const committeeName = text(d.committeeName),
      reportedContributorType = text(d.reportedContributorType),
      sourceClasses = a.sourceClasses.map(text).sort();
    if (
      sourceClasses.some(
        (c) =>
          ![
            "PAC",
            "Political Action Committee",
            "Political Committee",
            "Corporation, Partnership, and Other Entity",
            "Business/Group/Organization",
            "Labor Organization",
            "Other",
            "Out-of-State or Federal Committee",
            "Dem or Rep National Sub-Committees",
          ].includes(c),
      )
    )
      fail();
    const fallback = d.registeredCommitteeId === null;
    if (
      fallback
        ? sourceClasses.length !== 1 ||
          ![
            "PAC",
            "Political Action Committee",
            "Political Committee",
          ].includes(sourceClasses[0]!) ||
          d.committeeId !==
            "reported:" +
              createHash("sha256")
                .update(JSON.stringify([sourceClasses[0], name(committeeName)]))
                .digest("hex") ||
          d.committeeType !==
            (sourceClasses[0] === "Political Committee"
              ? "Political Committee"
              : "Political Action Committee")
        : !/^0[23]\d{6}$/.test(d.committeeId) ||
          d.registeredCommitteeId !== d.committeeId ||
          d.committeeType !==
            (d.committeeId.startsWith("02")
              ? "Political Action Committee"
              : "Political Committee")
    )
      fail();
    if (
      sourceClasses.join(" | ") !== reportedContributorType ||
      a.reportedContributorType !== reportedContributorType ||
      a.committeeType !== d.committeeType ||
      a.registeredCommitteeId !== d.registeredCommitteeId ||
      a.cashAmountCents !== d.cashAmountCents ||
      a.inKindAmountCents !== d.inKindAmountCents
    )
      fail();
    const giftIds = a.giftIds.map(positive),
      returnIds = a.returnIds.map(positive);
    if (
      giftIds.length !== d.contributionCount ||
      new Set([...giftIds, ...returnIds]).size !==
        giftIds.length + returnIds.length
    )
      fail();
    let cash = 0,
      inKind = 0;
    for (const [ids, isReturn] of [
      [giftIds, false],
      [returnIds, true],
    ] as const)
      for (const id of ids) {
        if (claimed.has(id)) fail();
        claimed.add(id);
        const row = occurrences.find((o) => o.transactionId === id);
        if (
          !row ||
          !sourceClasses.includes(row.sourceClass) ||
          ![
            "Cash",
            "Check",
            "Credit Card",
            "EFT",
            "Electronic Fund Transfer",
            "Wire Transfer",
            "In-Kind",
          ].includes(row.sourceMechanism) ||
          (!isReturn && row.amountCents <= 0)
        )
          fail();
        if (
          isReturn
            ? !(
                (row.kind === "receipt" && row.amountCents < 0) ||
                (row.kind === "expense" &&
                  row.sourceCategory === "Return Contributions" &&
                  row.amountCents >= 0)
              )
            : row.kind !== "receipt" || row.sourceMechanism === "Wire Transfer"
        )
          fail();
        const amount = isReturn ? -Math.abs(row.amountCents) : row.amountCents;
        if (row.sourceMechanism === "In-Kind") inKind = sum([inKind, amount]);
        else cash = sum([cash, amount]);
      }
    if (
      cash !== cents(d.cashAmountCents) ||
      inKind !== cents(d.inKindAmountCents) ||
      !reports.some((r) => r.sourceUrl === d.sourceUrl)
    )
      fail();
    return {
      committeeId: d.committeeId,
      committeeName,
      reportedContributorType,
      committeeType: d.committeeType,
      registeredCommitteeId: d.registeredCommitteeId,
      cashAmountCents: cash,
      inKindAmountCents: inKind,
      contributionCount: d.contributionCount,
      sourceUrl: d.sourceUrl,
      sourceClasses,
      giftIds,
      returnIds,
    };
  });
  if (
    occurrences.some(
      (o) =>
        ["PAC", "Political Action Committee", "Political Committee"].includes(
          o.sourceClass,
        ) &&
        o.amountCents !== 0 &&
        (o.kind === "receipt" ||
          (o.kind === "expense" &&
            o.sourceCategory === "Return Contributions")) &&
        [
          "Cash",
          "Check",
          "Credit Card",
          "EFT",
          "Electronic Fund Transfer",
          "Wire Transfer",
          "In-Kind",
        ].includes(o.sourceMechanism) &&
        !claimed.has(o.transactionId),
    )
  )
    fail();
  if (
    new Set(donors.map((d) => d.committeeId)).size !== donors.length ||
    p.donors.length !== donors.length ||
    new Set(p.donors.map((d) => d.committeeId)).size !== p.donors.length
  )
    fail();
  return {
    version: 1,
    scope,
    target,
    window,
    reports,
    organizationFingerprints: p.organizationFingerprints.map(hash),
    receiptFingerprint: hash(p.receiptFingerprint),
    expenseFingerprint: hash(p.expenseFingerprint),
    occurrences,
    sourceMetadata,
    registrySources,
    donors,
  };
}
export type DelawarePacSourceProvenance = ReturnType<typeof project>;
function closing(p: DelawarePacSourceProvenance) {
  return p.reports.map((r) =>
    Date.parse(
      p.sourceMetadata.filter(
        (m) => m.url === r.sourceUrl && m.sha256 === r.pdfSha256,
      )[1]!.completedAt,
    ),
  );
}
function restored(prior: DelawarePacSourceProvenance): DelawarePacEvidence {
  return {
    donors: prior.donors.map(
      ({ sourceClasses: _s, giftIds: _g, returnIds: _r, ...d }) => d,
    ),
    sourceProvenance: prior,
  } as DelawarePacEvidence;
}
function sqlRows(p: DelawarePacSourceProvenance) {
  return p.donors.map((d) => ({
    committee_id: d.committeeId,
    committee_name: d.committeeName,
    reported_contributor_type: d.reportedContributorType,
    committee_type: d.committeeType,
    registered_committee_id: d.registeredCommitteeId,
    cash_amount: decimal(d.cashAmountCents),
    in_kind_amount: decimal(d.inKindAmountCents),
    contribution_count: d.contributionCount,
    source_url: d.sourceUrl,
  }));
}
/** Caller holds the snapshot transaction, summary row and receiver/year lock. */
export async function writeDelawarePacEvidence(input: {
  db: Queryable;
  linkId: string;
  link: DelawareFinanceLinkInput;
  syncedAt: Date;
  prior: unknown;
  incoming?: DelawarePacEvidence;
}): Promise<{ donorsWritten: number; diagnostics: readonly string[] }> {
  const db = input.db;
  let next: DelawarePacSourceProvenance,
    previous: DelawarePacSourceProvenance | null,
    rows: ReturnType<typeof sqlRows>,
    linkId: string,
    link: DelawareFinanceLinkInput,
    syncedAt: Date;
  try {
    link = structuredClone(input.link);
    linkId = input.linkId;
    syncedAt = new Date(input.syncedAt);
    const incoming = structuredClone(input.incoming),
      prior = structuredClone(input.prior);
    if (incoming === undefined) return { donorsWritten: 0, diagnostics: [] };
    if (
      !uuid.test(linkId) ||
      !Number.isFinite(syncedAt.getTime()) ||
      (link.linkStatus !== undefined && link.linkStatus !== "active")
    )
      fail();
    next = project(incoming, link);
    previous =
      prior === null || prior === undefined
        ? null
        : project(restored(prior as DelawarePacSourceProvenance), link);
    if (
      previous &&
      (!same(previous.target, next.target) ||
        previous.window.start !== next.window.start ||
        previous.window.end !== next.window.end ||
        previous.window.basis !== next.window.basis ||
        previous.reports.some(
          (r) =>
            !next.reports.some(
              (n) =>
                n.periodStart === r.periodStart && n.periodEnd === r.periodEnd,
            ),
        ) ||
        previous.donors.some((old) => {
          const n = next.donors.find((d) => d.committeeId === old.committeeId);
          return (
            !n ||
            n.committeeName !== old.committeeName ||
            n.committeeType !== old.committeeType ||
            n.registeredCommitteeId !== old.registeredCommitteeId ||
            old.sourceClasses.some((c) => !n.sourceClasses.includes(c)) ||
            [...old.giftIds, ...old.returnIds].some(
              (id) => ![...n.giftIds, ...n.returnIds].includes(id),
            )
          );
        }) ||
        Math.min(...closing(next)) <= Math.max(...closing(previous)))
    )
      fail();
    rows = sqlRows(next);
  } catch {
    return {
      donorsWritten: 0,
      diagnostics: [
        "PAC snapshot preserved: invalid, stale, changed identity or missing prior authority",
      ],
    };
  }
  const stored = await db.query<Record<string, unknown>>(
    `SELECT committee_id, committee_name, reported_contributor_type, committee_type, registered_committee_id, cash_amount, in_kind_amount, contribution_count, source_url FROM public.de_candidate_finance_pac_donors WHERE link_id = $1::uuid AND election_year = $2::integer FOR UPDATE`,
    [linkId, link.electionYear],
  );
  const expected = previous ? sqlRows(previous) : [];
  if (
    stored.rows.length !== expected.length ||
    !stored.rows.every((r) =>
      expected.some(
        (e) =>
          r.committee_id === e.committee_id &&
          r.committee_name === e.committee_name &&
          r.reported_contributor_type === e.reported_contributor_type &&
          r.committee_type === e.committee_type &&
          r.registered_committee_id === e.registered_committee_id &&
          storedCents(r.cash_amount) === storedCents(e.cash_amount) &&
          storedCents(r.in_kind_amount) === storedCents(e.in_kind_amount) &&
          r.contribution_count === e.contribution_count &&
          r.source_url === e.source_url,
      ),
    )
  )
    return {
      donorsWritten: 0,
      diagnostics: [
        "PAC snapshot preserved: stored donors lack matching scoped authority",
      ],
    };
  if (rows.length)
    await db.query(
      `INSERT INTO public.de_candidate_finance_pac_donors (link_id, election_year, committee_id, committee_name, reported_contributor_type, committee_type, registered_committee_id, cash_amount, in_kind_amount, contribution_count, source_url, last_synced_at, updated_at)
    SELECT $1::uuid, $2::integer, d.committee_id, d.committee_name, d.reported_contributor_type, d.committee_type, d.registered_committee_id, d.cash_amount, d.in_kind_amount, d.contribution_count, d.source_url, $4::timestamptz, $4::timestamptz
    FROM jsonb_to_recordset($3::jsonb) AS d(committee_id text, committee_name text, reported_contributor_type text, committee_type text, registered_committee_id text, cash_amount numeric, in_kind_amount numeric, contribution_count integer, source_url text)
    ON CONFLICT (link_id, election_year, committee_id) DO UPDATE SET committee_name = EXCLUDED.committee_name, reported_contributor_type = EXCLUDED.reported_contributor_type, committee_type = EXCLUDED.committee_type, registered_committee_id = EXCLUDED.registered_committee_id, cash_amount = EXCLUDED.cash_amount, in_kind_amount = EXCLUDED.in_kind_amount, contribution_count = EXCLUDED.contribution_count, source_url = EXCLUDED.source_url, last_synced_at = EXCLUDED.last_synced_at, updated_at = EXCLUDED.updated_at`,
      [linkId, link.electionYear, JSON.stringify(rows), syncedAt],
    );
  await db.query(
    `DELETE FROM public.de_candidate_finance_pac_donors WHERE link_id = $1::uuid AND election_year = $2::integer AND NOT (committee_id = ANY($3::text[]))`,
    [linkId, link.electionYear, rows.map((d) => d.committee_id)],
  );
  const saved = await db.query(
    `UPDATE public.de_candidate_finance_summaries SET pac_source_provenance = $3::jsonb WHERE link_id = $1::uuid AND election_year = $2::integer`,
    [linkId, link.electionYear, JSON.stringify(next)],
  );
  if (saved.rowCount !== 1)
    throw new Error("Delaware PAC summary row unavailable");
  return { donorsWritten: rows.length, diagnostics: [] };
}

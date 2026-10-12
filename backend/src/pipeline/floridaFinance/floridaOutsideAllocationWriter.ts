import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { fingerprintFloridaCommitteeDetailSemantics } from "./floridaCommitteeRegistrySource.js";
import { verifyFloridaOutsidePayerIdentity } from "./floridaOutsidePayerSource.js";
import {
  loadFloridaLocalFinanceContext,
  type FloridaLocalFinanceContext,
} from "./floridaLocalFinanceContext.js";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";
import {
  buildFloridaVerifiedOutsideAllocations,
  type FloridaOutsideAllocationSource,
} from "./floridaVerifiedOutsideAllocations.js";

export type FloridaOutsideAllocationWriteInput = {
  db: Pick<Pool, "connect">;
  localContext: FloridaLocalFinanceContext;
  payerIdentity?: {
    payerLabel: string;
    rawSource: readonly FloridaProcessedRawEvidence[];
  };
  source?: FloridaOutsideAllocationSource;
  now?: Date;
};
export type FloridaOutsideAllocationWriteResult = {
  status: "written" | "preserve";
  supportCents?: number;
  diagnostics: string[];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(reason: string): never {
  throw new Error(`Florida outside write: ${reason}`);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
      .join(",") +
    "}"
  );
}
function decimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) fail("unsafe allocated cents");
  const integer = BigInt(cents);
  return `${integer / 100n}.${String(integer % 100n).padStart(2, "0")}`;
}
function sourceMetadata(
  raw: Omit<FloridaProcessedRawEvidence, "bytesRaw"> & {
    byteCount: number;
    phase?: string;
  },
) {
  // Explicit fields prevent runtime extras or raw bodies becoming product/storage data.
  return {
    url: raw.url,
    method: raw.method,
    financeFields: raw.financeFields,
    status: raw.status,
    contentType: raw.contentType,
    sha256: raw.sha256,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    byteCount: raw.byteCount,
    ...(["before", "after", "opening", "closing"].includes(raw.phase ?? "")
      ? { phase: raw.phase }
      : {}),
  };
}

type StoredPayer = {
  support_amount: unknown;
  expenditure_count: unknown;
  current_report_count: unknown;
  payer_name: unknown;
  payer_type: unknown;
  source_url: unknown;
  provenance: unknown;
  verified_source_at: unknown;
};
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("malformed prior payer authority");
  return value as Record<string, any>;
}
function safeCount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= 2147483647
  );
}
function validDay(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
function checkedMetadata(
  value: unknown,
  phases: readonly string[],
): Record<string, any>[] {
  if (!Array.isArray(value) || !value.length)
    fail("missing prior source metadata");
  const rows = value.map(record);
  for (const r of rows) {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      fail("invalid prior source URL");
    }
    if (
      !phases.includes(r.phase) ||
      !phases.every((phase) => rows.some((row) => row.phase === phase)) ||
      !/^[a-f0-9]{64}$/.test(r.sha256 ?? "") ||
      r.status !== 200 ||
      !["GET", "POST"].includes(r.method) ||
      !safeCount(r.byteCount) ||
      !r.byteCount ||
      url.protocol !== "https:" ||
      !["dos.elections.myflorida.com", "efs.dos.state.fl.us"].includes(
        url.hostname,
      ) ||
      typeof r.startedAt !== "string" ||
      typeof r.completedAt !== "string" ||
      !Number.isFinite(Date.parse(r.startedAt)) ||
      !Number.isFinite(Date.parse(r.completedAt)) ||
      Date.parse(r.startedAt) > Date.parse(r.completedAt)
    )
      fail("malformed prior source metadata");
  }
  return rows;
}
/** Stored metadata is a preservation boundary, not a substitute for fresh raw verification. */
function reconcilePrior(old: StoredPayer, fresh: Record<string, any>): void {
  const p = record(old.provenance);
  if (
    p.version !== 1 ||
    p.authority !== fresh.authority ||
    p.scope !== fresh.scope ||
    p.candidateWideZeroAuthority !== false ||
    canonical(p.localContext) !== canonical(fresh.localContext) ||
    canonical(p.context) !== canonical(fresh.context) ||
    !/^[a-f0-9]{64}$/.test(p.ownerFingerprint ?? "") ||
    !/^[a-f0-9]{64}$/.test(p.financialFingerprint ?? "") ||
    old.payer_name !== p.context.payerName ||
    old.payer_type !== p.context.payerType ||
    !Array.isArray(p.reports) ||
    !p.reports.length ||
    !Array.isArray(p.allocations) ||
    !safeCount(p.unmatchedExpenseCount) ||
    !Number.isSafeInteger(p.supportCents) ||
    p.supportCents < 0
  )
    fail("malformed or incompatible prior payer authority");
  const periods = new Set<string>(),
    reports = new Map<number, Record<string, any>>();
  let expenseCount = 0;
  for (const value of p.reports) {
    const r = record(value),
      period = `${r.periodStart}/${r.periodEnd}`;
    if (
      !safeCount(r.sequence) ||
      !r.sequence ||
      reports.has(r.sequence) ||
      periods.has(period) ||
      !validDay(r.periodStart) ||
      !validDay(r.periodEnd) ||
      r.periodStart > r.periodEnd ||
      r.electionYear !== p.context.electionYear ||
      r.electionType !== p.context.electionType ||
      r.electionDescription !== p.context.electionDescription ||
      !safeCount(r.expenseCount) ||
      !Number.isSafeInteger(r.expenseCents) ||
      r.expenseCents < 0 ||
      typeof r.waiver !== "boolean" ||
      typeof r.amended !== "boolean" ||
      !safeCount(r.reportYear) ||
      r.reportYear < 2000 ||
      r.reportYear > 2100 ||
      typeof r.reportType !== "string" ||
      !r.reportType.trim() ||
      (r.waiver
        ? r.nativeSequence !== null ||
          r.completeness !== "No Detail Records Found"
        : !safeCount(r.nativeSequence) ||
          !r.nativeSequence ||
          r.expenseCount <= 0 ||
          r.expenseCents <= 0 ||
          r.completeness !== "Complete Detail Records") ||
      r.fileStatus !== "Filed Report" ||
      r.reviewStatus !== "Reviewed" ||
      r.queued !== 0 ||
      (r.waiver && (r.expenseCount !== 0 || r.expenseCents !== 0)) ||
      fresh.reports.filter(
        (next: Record<string, any>) =>
          next.periodStart === r.periodStart && next.periodEnd === r.periodEnd,
      ).length !== 1
    )
      fail("prior report period missing or malformed");
    periods.add(period);
    reports.set(r.sequence, r);
    expenseCount += r.expenseCount;
  }
  let total = 0;
  const occurrences = new Set<number>(),
    perReport = new Map<number, number>();
  for (const value of p.allocations) {
    const a = record(value);
    if (
      !safeCount(a.occurrence) ||
      occurrences.has(a.occurrence) ||
      !reports.has(a.reportSequence) ||
      a.supportOppose !== "support" ||
      !Number.isSafeInteger(a.amountCents) ||
      a.amountCents <= 0 ||
      !/^[a-f0-9]{64}$/.test(a.rowSha256 ?? "")
    )
      fail("malformed prior allocation authority");
    occurrences.add(a.occurrence);
    total += a.amountCents;
    perReport.set(
      a.reportSequence,
      (perReport.get(a.reportSequence) ?? 0) + a.amountCents,
    );
  }
  const seq = Math.min(
    ...(p.allocations.length
      ? p.allocations.map((a: any) => a.reportSequence)
      : [...reports.keys()]),
  );
  const metadata = checkedMetadata(p.sourceMetadata, ["before", "after"]);
  const registry = checkedMetadata(p.payerSourceMetadata, [
    "opening",
    "closing",
  ]);
  const financialStart = Math.min(
    ...metadata.map((r) => Date.parse(r.startedAt)),
  );
  const financialEnd = Math.max(
    ...metadata.map((r) => Date.parse(r.completedAt)),
  );
  if (
    registry.some((r) =>
      r.phase === "opening"
        ? Date.parse(r.completedAt) > financialStart
        : Date.parse(r.startedAt) < financialEnd,
    )
  )
    fail("prior payer authority does not bracket financial source");
  const closing = metadata.filter((r) => r.phase === "after");
  if (
    !closing.length ||
    closing.some(
      (r: any) =>
        !/^[a-f0-9]{64}$/.test(r.sha256 ?? "") ||
        !Number.isFinite(Date.parse(r.startedAt)) ||
        !Number.isFinite(Date.parse(r.completedAt)) ||
        Date.parse(r.startedAt) > Date.parse(r.completedAt),
    ) ||
    !Number.isFinite(Date.parse(String(old.verified_source_at))) ||
    Date.parse(String(old.verified_source_at)) !==
      Math.max(...closing.map((r: any) => Date.parse(r.completedAt))) ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(expenseCount) ||
    total !== p.supportCents ||
    String(old.support_amount) !== decimal(total) ||
    old.expenditure_count !== p.allocations.length ||
    old.current_report_count !== p.reports.length ||
    p.allocations.length + p.unmatchedExpenseCount !== expenseCount ||
    [...perReport].some(
      ([id, cents]) =>
        !Number.isSafeInteger(cents) || cents > reports.get(id)!.expenseCents,
    ) ||
    old.source_url !==
      `https://efs.dos.state.fl.us/PrintReportSubmitted.aspx?AcctNum=${p.context.payerAccount}&SeqNum=${seq}`
  )
    fail("prior payer materialization disagrees with authority");
}

/** Isolated current-payer authority. Revalidates raw evidence before BEGIN,
 * preserves legacy outside data, and never updates candidate headlines/groups.
 * Only genuine upstream acquisition establishes source authenticity.
 */
export async function writeFloridaOutsideAllocations(
  input: FloridaOutsideAllocationWriteInput,
): Promise<FloridaOutsideAllocationWriteResult> {
  const db = input.db;
  let client: PoolClient | undefined;
  let begun = false;
  try {
    // Capture the whole financial/local generation before any async replay/connect.
    const { db: _db, ...data } = input;
    const retained = structuredClone(data);
    if (!retained.source || !retained.payerIdentity)
      return {
        status: "preserve",
        diagnostics: ["Outside source component omitted."],
      };
    const local = retained.localContext;
    if (
      ![local.candidateId, local.electionId, local.candidateElectionId].every(
        (id) => typeof id === "string" && UUID.test(id),
      )
    )
      fail("invalid local candidate/election identifiers");
    const syncedAt = retained.now ?? new Date();
    if (!(syncedAt instanceof Date) || !Number.isFinite(syncedAt.getTime()))
      fail("invalid sync timestamp");
    const allocated = buildFloridaVerifiedOutsideAllocations({
      source: retained.source,
      localContext: local,
    });
    if (allocated.status !== "verified_payer_target")
      return { status: "preserve", diagnostics: [...allocated.diagnostics] };
    const { proof } = allocated;
    const first = proof.sourceMetadata.reduce((a, b) =>
      Date.parse(a.startedAt) < Date.parse(b.startedAt) ? a : b,
    );
    const last = proof.sourceMetadata.reduce((a, b) =>
      Date.parse(a.completedAt) > Date.parse(b.completedAt) ? a : b,
    );
    const payer = await verifyFloridaOutsidePayerIdentity({
      ...retained.payerIdentity,
      financialInterval: {
        startedAt: first.startedAt,
        completedAt: last.completedAt,
      },
    });
    if (payer.status !== "resolved")
      return { status: "preserve", diagnostics: [...payer.diagnostics] };
    if (
      payer.owner.committeeId !== proof.context.payerAccount ||
      payer.payerType !== proof.context.payerType ||
      fingerprintFloridaCommitteeDetailSemantics(payer.owner) !==
        fingerprintFloridaCommitteeDetailSemantics(proof.owner)
    )
      fail("payer registry and expense owner authority differ");
    if (
      allocated.allocations.length > 2147483647 ||
      proof.reports.length < 1 ||
      proof.reports.length > 2147483647
    )
      fail("unsafe allocation/report count");
    const supportAmount = decimal(allocated.supportCents);
    const closingCaptures = proof.sourceMetadata.filter(
      (raw) => raw.phase === "after",
    );
    if (!closingCaptures.length) fail("missing genuine closing source capture");
    const verifiedSourceAt = closingCaptures.reduce((latest, raw) =>
      Date.parse(raw.completedAt) > Date.parse(latest.completedAt)
        ? raw
        : latest,
    ).completedAt;
    const allocatedSequences = allocated.allocations.map(
      (row) => row.reportSequence,
    );
    const sequence = Math.min(
      ...(allocatedSequences.length
        ? allocatedSequences
        : proof.reports.map((report) => report.current.sequence)),
    );
    const sourceUrl = `https://efs.dos.state.fl.us/PrintReportSubmitted.aspx?AcctNum=${proof.context.payerAccount}&SeqNum=${sequence}`;
    const provenance = {
      version: 1,
      authority: "current_processed_expense_ledger",
      candidateWideZeroAuthority: false,
      scope: proof.scope,
      localContext: local,
      context: proof.context,
      ownerFingerprint: fingerprintFloridaCommitteeDetailSemantics(proof.owner),
      financialFingerprint: proof.financialFingerprint,
      supportCents: allocated.supportCents,
      unmatchedExpenseCount: allocated.unmatchedExpenseCount,
      payerSourceMetadata: payer.sourceMetadata.map(sourceMetadata),
      sourceMetadata: proof.sourceMetadata.map(sourceMetadata),
      reports: proof.reports.map(({ current, cover }) => ({
        sequence: current.sequence,
        nativeSequence: cover.nativeSequence,
        reportYear: current.reportYear,
        reportType: current.reportType,
        electionYear: current.electionYear,
        electionType: current.electionType,
        electionDescription: current.electionDescription,
        periodStart: current.periodStart,
        periodEnd: current.periodEnd,
        expenseCount: current.expenseCount,
        expenseCents: cover.expenseCents,
        amended: current.amended,
        waiver: current.waiver,
        fileStatus: current.fileStatus,
        reviewStatus: current.reviewStatus,
        completeness: current.completeness,
        queued: current.queued,
        filedAt: current.fullMetadata.lblDateFiled ?? null,
        reviewedAt: current.fullMetadata.lblDateReviewed ?? null,
      })),
      allocations: allocated.allocations.map((row) => ({
        occurrence: row.occurrence,
        reportSequence: row.reportSequence,
        supportOppose: row.supportOppose,
        amountCents: row.amountCents,
        rowSha256: sha(JSON.stringify(row.row.rawFields)),
      })),
    };
    if (
      typeof db?.connect !== "function" ||
      typeof (db as unknown as { release?: unknown }).release === "function"
    )
      fail("requires a transaction-capable Pool");
    client = await db.connect();
    await client.query("BEGIN");
    begun = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [
        "florida-outside-payer:" +
          JSON.stringify([
            local.candidateId,
            local.electionId,
            proof.context.payerAccount,
          ]),
      ],
    );
    const actual = await loadFloridaLocalFinanceContext({
      db: client,
      candidateId: local.candidateId,
      electionId: local.electionId,
      committeeId: local.committeeId,
      lock: true,
    });
    if (
      actual.status !== "resolved" ||
      canonical(actual.context) !== canonical(local)
    )
      fail("actual local outside ownership changed");
    const links = await client.query<{ id: string }>(
      `
      SELECT id::text FROM public.fl_candidate_finance_links
      WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND committee_id=$3 AND link_status='active'
      FOR SHARE
    `,
      [local.candidateId, local.electionId, local.committeeId],
    );
    if (links.rows.length !== 1 || !UUID.test(links.rows[0]!.id))
      fail("active outside storage link is not unique");
    const legacy = await client.query<{
      has_legacy_scalar: boolean;
      has_legacy_group: boolean;
    }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM public.fl_candidate_finance_links link
        JOIN public.fl_candidate_finance_summaries summary ON summary.link_id=link.id AND summary.election_year=link.election_year
        WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid
          AND (summary.outside_support_total IS NOT NULL OR summary.outside_oppose_total IS NOT NULL)
      ) AS has_legacy_scalar,
      EXISTS (
        SELECT 1 FROM public.fl_candidate_finance_links link
        JOIN public.fl_candidate_finance_outside_groups outside_group ON outside_group.link_id=link.id AND outside_group.election_year=link.election_year
        WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid
      ) AS has_legacy_group
    `,
      [local.candidateId, local.electionId],
    );
    if (
      legacy.rows.length !== 1 ||
      legacy.rows[0]!.has_legacy_scalar !== false ||
      legacy.rows[0]!.has_legacy_group !== false
    )
      fail("legacy outside amounts/groups require independent reconciliation");
    const prior = await client.query<StoredPayer>(
      `
      SELECT support_amount::text, expenditure_count, current_report_count, payer_name, payer_type,
        source_url, provenance, verified_source_at::text
      FROM public.fl_candidate_finance_ie_sources
      WHERE candidate_election_id=$1::uuid AND payer_account=$2 AND election_year=$3
      FOR UPDATE
    `,
      [
        local.candidateElectionId,
        proof.context.payerAccount,
        local.electionYear,
      ],
    );
    if (prior.rows.length > 1) fail("prior payer authority is not unique");
    if (prior.rows.length) reconcilePrior(prior.rows[0]!, provenance);
    const written = await client.query<{ payer_account: string }>(
      `
      INSERT INTO public.fl_candidate_finance_ie_sources (
        candidate_election_id, payer_account, election_year, link_id, payer_name, payer_type,
        support_amount, expenditure_count, current_report_count, source_url, provenance, last_synced_at, verified_source_at
      ) VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7::numeric,$8,$9,$10,$11::jsonb,$12::timestamptz,$13::timestamptz)
      ON CONFLICT (candidate_election_id,payer_account,election_year) DO UPDATE SET
        link_id=EXCLUDED.link_id, payer_name=EXCLUDED.payer_name, payer_type=EXCLUDED.payer_type,
        support_amount=EXCLUDED.support_amount, expenditure_count=EXCLUDED.expenditure_count,
        current_report_count=EXCLUDED.current_report_count, source_url=EXCLUDED.source_url,
        provenance=EXCLUDED.provenance, last_synced_at=EXCLUDED.last_synced_at,
        verified_source_at=EXCLUDED.verified_source_at
      WHERE EXCLUDED.verified_source_at >= fl_candidate_finance_ie_sources.verified_source_at
      RETURNING payer_account
    `,
      [
        local.candidateElectionId,
        proof.context.payerAccount,
        local.electionYear,
        links.rows[0]!.id,
        proof.context.payerName,
        proof.context.payerType,
        supportAmount,
        allocated.allocations.length,
        proof.reports.length,
        sourceUrl,
        JSON.stringify(provenance),
        syncedAt.toISOString(),
        verifiedSourceAt,
      ],
    );
    if (
      written.rows.length !== 1 ||
      written.rows[0]!.payer_account !== proof.context.payerAccount
    )
      fail("newer accepted payer source already exists");
    await client.query("COMMIT");
    begun = false;
    return {
      status: "written",
      supportCents: allocated.supportCents,
      diagnostics: [
        "Stored one verified payer/target component; candidate-wide outside totals remain unknown.",
      ],
    };
  } catch (error) {
    if (client && begun) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Retain original preservation reason. */
      }
    }
    return {
      status: "preserve",
      diagnostics: [
        error instanceof Error
          ? error.message
          : "Outside persistence unavailable.",
      ],
    };
  } finally {
    client?.release();
  }
}

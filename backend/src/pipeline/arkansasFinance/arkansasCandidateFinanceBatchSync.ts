// Arkansas finance batch sync: optional auto-link pass, then the due list,
// then verified PAC/IE acquisition and per-candidate receipt sync. The legacy
// registration sweep is shared by auto-link and receipt sync; verified source
// components acquire their own fresh opening/closing context. Per-candidate
// write failures are recorded and the batch continues. Steps are injectable.

import type { Pool, PoolClient } from "pg";

import {
  autoLinkMissingArkansasCandidateFinanceLinks,
  createArkansasRegistrationSweepLoader,
  type ArkansasFinanceAutoLinkResult,
} from "./arkansasCandidateFinanceAutoLink.js";
import {
  listDueArkansasCandidateFinanceSyncRows,
  type ArkansasCandidateFinanceDueRow,
} from "./arkansasCandidateFinanceDueList.js";
import {
  syncArkansasCandidateFinance,
  type ArkansasCandidateFinanceSyncResult,
} from "./arkansasCandidateFinanceSync.js";
import type { ArkansasCfisClientOptions } from "./arkansasCfisClient.js";
import type { ArkansasVerifiedRawCapture } from "./arkansasVerifiedRawCache.js";
import { createArkansasVerifiedFinanceLoader, type ArkansasVerifiedFinanceLoader } from "./arkansasVerifiedFinanceLoader.js";
import { aggregateArkansasVerifiedOutsideEvidence, type ArkansasOutsideIdentityCoverProof } from "./arkansasVerifiedOutsideEvidence.js";
import { normalizeArkansasCandidateNameForStorage } from "./arkansasCandidateFilerResolver.js";
import type { ArkansasFinanceLinkInput } from "./arkansasFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_STALE_AFTER_DAYS = 7;
const SCOPED_DUE_ROW_LIMIT = 10_000;
// The ordinary candidate final report is due January 20 after November's
// election. Keep the election eligible through that report and fresh retries.
const DEFAULT_ELECTION_LOOKBACK_DAYS = 100;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

export type ArkansasCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  /** Bypass staleness while retaining election and office eligibility. */
  refresh?: boolean;
  candidateId?: string;
  electionYear?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  autoLinkMissingLinks?: boolean;
  clientOptions?: ArkansasCfisClientOptions;
  onRawResponse?: (capture: ArkansasVerifiedRawCapture) => void | Promise<void>;
  verifiedFinanceLoader?: ArkansasVerifiedFinanceLoader;
  log?: (message: string) => void;
  autoLinkFn?: typeof autoLinkMissingArkansasCandidateFinanceLinks;
  listDueRowsFn?: typeof listDueArkansasCandidateFinanceSyncRows;
  syncCandidateFn?: typeof syncArkansasCandidateFinance;
};

export type ArkansasCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  autoLinkResults: ArkansasFinanceAutoLinkResult[];
  totalDueRows: number;
  attempted: number;
  succeeded: number;
  failed: number;
  candidates: {
    row: ArkansasCandidateFinanceDueRow;
    ok: boolean;
    result?: ArkansasCandidateFinanceSyncResult;
    error?: string;
  }[];
};

export async function syncDueArkansasCandidateFinance(
  input: ArkansasCandidateFinanceBatchSyncInput
): Promise<ArkansasCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  const log = input.log ?? ((message: string) => console.log(message));
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new Error("Invalid Arkansas maxCandidates");
  if (input.candidateId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.candidateId)) {
    throw new Error("Invalid Arkansas candidateId");
  }
  if (input.electionYear !== undefined && (!Number.isSafeInteger(input.electionYear)
    || input.electionYear < 2026 || input.electionYear > 2100)) throw new Error("Invalid Arkansas electionYear");
  const scoped = input.candidateId !== undefined || input.electionYear !== undefined;
  const staleAfterDays = input.refresh ? 0 : input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const electionLookbackDays =
    input.electionLookbackDays ?? DEFAULT_ELECTION_LOOKBACK_DAYS;
  const electionLookaheadDays = input.electionLookaheadDays ?? DEFAULT_ELECTION_LOOKAHEAD_DAYS;
  const dryRun = input.dryRun === true;

  // Shared across auto-link AND sync so the registry is swept once per batch.
  const loadRegistrations = createArkansasRegistrationSweepLoader({ clientOptions: input.clientOptions });

  let autoLinkResults: ArkansasFinanceAutoLinkResult[] = [];
  if (!dryRun && !scoped && input.autoLinkMissingLinks !== false) {
    const autoLink = input.autoLinkFn ?? autoLinkMissingArkansasCandidateFinanceLinks;
    try {
      autoLinkResults = await autoLink({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        loadRegistrations,
        clientOptions: input.clientOptions,
      });
    } catch (error) {
      log(
        `Arkansas auto-link pass failed (continuing with existing links): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const listDueRows = input.listDueRowsFn ?? listDueArkansasCandidateFinanceSyncRows;
  const due = await listDueRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates: scoped ? SCOPED_DUE_ROW_LIMIT : maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });
  if (scoped && due.totalDueRows > SCOPED_DUE_ROW_LIMIT) {
    throw new Error("Arkansas scoped due list exceeded its complete-row bound");
  }
  const scopedRows = scoped ? due.rows.filter(row =>
    (input.candidateId === undefined || row.candidateId.toLowerCase() === input.candidateId.toLowerCase())
    && (input.electionYear === undefined || row.electionYear === input.electionYear)) : due.rows;
  // Unscoped: the due list already capped stale rows at maxCandidates and
  // appended their race-mates; slicing again would drop those race-mates.
  const rows = scoped ? scopedRows.slice(0, maxCandidates) : scopedRows;

  const syncCandidate = input.syncCandidateFn ?? syncArkansasCandidateFinance;
  const toLink = (row: ArkansasCandidateFinanceDueRow): ArkansasFinanceLinkInput => ({
    candidateId: row.candidateId, electionId: row.electionId, electionYear: row.electionYear,
    candidateNameNormalized: normalizeArkansasCandidateNameForStorage(row.candidateName),
    officeName: row.officeName, district: row.district, filingEntityId: row.filingEntityId, filerName: row.filerName,
    linkStatus: "active", linkSource: row.linkSource, sourceUrl: row.sourceUrl,
  });
  const prepared: NonNullable<Parameters<typeof syncArkansasCandidateFinance>[0]["verifiedFinance"]>[] = [];
  if (rows.length && (!input.syncCandidateFn || input.verifiedFinanceLoader)) {
    const loader = input.verifiedFinanceLoader ?? createArkansasVerifiedFinanceLoader({
      clientOptions: input.clientOptions, onRawResponse: input.onRawResponse,
    });
    const prior = await input.db.query<{ candidate_id: string; election_id: string;
      filing_entity_id: string; pac_source_provenance: unknown }>(`
      SELECT link.candidate_id, link.election_id, link.filing_entity_id, summary.pac_source_provenance
      FROM public.ar_candidate_finance_links link
      JOIN jsonb_to_recordset($1::jsonb) AS selected(candidate_id uuid, election_id uuid)
        ON selected.candidate_id = link.candidate_id AND selected.election_id = link.election_id
      LEFT JOIN public.ar_candidate_finance_summaries summary
        ON summary.link_id = link.id AND summary.election_year = link.election_year
      WHERE link.link_status = 'active'`, [JSON.stringify(rows.map(row => ({
      candidate_id: row.candidateId, election_id: row.electionId,
    })))]);
    const outsideByYear = new Map<number, Awaited<ReturnType<ArkansasVerifiedFinanceLoader["loadIndependentSpending"]>>>();
    for (const year of new Set(rows.map(row => row.electionYear))) {
      outsideByYear.set(year, await loader.loadIndependentSpending({ electionYear: year }));
    }
    for (const row of rows) {
      const link = toLink(row), previous = prior.rows.find(p => p.candidate_id === row.candidateId
        && p.election_id === row.electionId && p.filing_entity_id === String(row.filingEntityId));
      const pac = await loader.loadCandidate({ link, officeScope: row.officeScope,
        priorPacSourceProvenance: previous?.pac_source_provenance });
      const outside = outsideByYear.get(row.electionYear)!;
      const diagnostics = [...pac.diagnostics, ...outside.diagnostics];
      let identityCover: ArkansasOutsideIdentityCoverProof | undefined;
      if (outside.ieProofs?.length && row.filingEntityId === 8277 && row.electionYear === 2026) {
        const identity = await loader.loadCandidateIdentity({ entityId: 8277, electionYear: 2026,
          officeName: "State Representative", district: "24", reportGuid: "0e3b5e5d-b829-4c96-9558-68935accb8d3" });
        diagnostics.push(...identity.diagnostics);
        if (identity.identity && identity.registryBefore && identity.registryAfter
          && identity.reportsBefore && identity.reportsAfter && identity.pdf) {
          identityCover = { identity: identity.identity, registryBefore: identity.registryBefore,
            registryAfter: identity.registryAfter, reportsBefore: identity.reportsBefore,
            reportsAfter: identity.reportsAfter, pdf: identity.pdf };
        }
      }
      const outsideEvidence = [];
      if (outside.registryBefore && outside.registryAfter) for (const proof of outside.ieProofs ?? []) {
        const allocated = aggregateArkansasVerifiedOutsideEvidence({ link, financialEvidence: proof,
          registryBefore: outside.registryBefore, registryAfter: outside.registryAfter, candidateIdentityCover: identityCover });
        diagnostics.push(...allocated.diagnostics);
        if (allocated.evidence) outsideEvidence.push(allocated.evidence);
      }
      prepared.push({ pacDonors: pac.pacDonors, pacSourceProvenance: pac.pacSourceProvenance, outsideEvidence, diagnostics });
    }
  }
  const candidates: ArkansasCandidateFinanceBatchSyncResult["candidates"] = [];
  let succeeded = 0;
  for (const [index, row] of rows.entries()) {
    try {
      const result = await syncCandidate({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        link: {
          filingEntityId: row.filingEntityId,
          filerName: row.filerName,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        now,
        dryRun,
        clientOptions: input.clientOptions,
        loadRegistrations,
        verifiedFinance: prepared[index],
      });
      succeeded += 1;
      candidates.push({ row, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Arkansas finance sync failed for ${row.candidateName} (filer entity ${row.filingEntityId}): ${message}`);
      candidates.push({ row, ok: false, error: message });
    }
  }

  return {
    dryRun,
    autoLinkResults,
    totalDueRows: scoped ? scopedRows.length : due.totalDueRows,
    attempted: rows.length,
    succeeded,
    failed: rows.length - succeeded,
    candidates,
  };
}

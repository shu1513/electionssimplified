import type { Pool, PoolClient } from "pg";
import type { OregonCandidateFinanceDueRow } from "./oregonCandidateFinanceBatchSync.js";
import type { OregonOrestarClientOptions } from "./oregonOrestarClient.js";
import { createOregonVerifiedSourceClient, type OregonVerifiedFetch } from "./oregonVerifiedSourceClient.js";
import { createOregonVerifiedSourceArtifactCache, DEFAULT_OREGON_VERIFIED_SOURCE_CACHE_DIR } from "./oregonVerifiedSourceArtifactCache.js";
import { loadOregonVerifiedFinanceSource } from "./oregonVerifiedFinanceSourceLoader.js";
import { loadOregonVerifiedLocalCandidateRow, type OregonVerifiedFinanceComponents } from "./oregonVerifiedFinancePersistence.js";
import { projectOregonVerifiedLocalCandidateContext } from "./oregonVerifiedLocalCandidateContext.js";

export type OregonVerifiedFinanceBatchLoadResult = {
  components?: OregonVerifiedFinanceComponents;
  diagnostics: readonly string[];
  generationDir?: string;
};

/** Normal sync acquisition: original saved opening GETs, fresh closing evidence. */
export async function loadOregonVerifiedFinanceForCandidate(input: {
  db: Pick<Pool | PoolClient, "query">;
  row: OregonCandidateFinanceDueRow;
  refresh?: boolean;
  rawCacheDir?: string;
  clientOptions?: OregonOrestarClientOptions;
}): Promise<OregonVerifiedFinanceBatchLoadResult> {
  const local = await loadOregonVerifiedLocalCandidateRow(input.db, input.row);
  const projected = local && projectOregonVerifiedLocalCandidateContext({ row: local, expectedYear: input.row.electionYear });
  if (!projected?.candidateContext || local!.candidateName !== input.row.candidateName ||
      local!.officeName !== input.row.officeName || local!.districtName !== input.row.district) {
    return { diagnostics: projected?.diagnostics.length ? projected.diagnostics : ["Oregon verified source local context is missing or differs from the due link"] };
  }
  const candidateContext = projected.candidateContext;
  // Prior authority is an acquisition constraint only. The writer rechecks
  // both authority and materialization under its transaction lock.
  const prior = await input.db.query<{ id: string; pac_source_provenance: unknown }>(`
    SELECT link.id::text, summary.pac_source_provenance FROM public.or_candidate_finance_links link
    LEFT JOIN public.or_candidate_finance_summaries summary ON summary.link_id=link.id AND summary.election_year=link.election_year
    WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid AND link.committee_id=$3
      AND link.election_year=$4 AND link.link_status='active'`,
    [input.row.candidateId,input.row.electionId,input.row.committeeId,input.row.electionYear]);
  if (prior.rows.length !== 1) return { diagnostics: ["Oregon verified source has no unique active receiving link"] };
  const outside = await input.db.query<{ payer_committee_id: string; source_provenance: unknown }>(`
    SELECT payer_committee_id,source_provenance FROM public.or_candidate_finance_outside_source_proofs
    WHERE link_id=$1::uuid AND election_year=$2`, [prior.rows[0]!.id,input.row.electionYear]);
  const delay = input.clientOptions?.requestDelayMs ?? 250;
  if (!Number.isInteger(delay) || delay < 0) throw new Error("Invalid Oregon verified source request delay");
  const fetchSource = (input.clientOptions?.fetchFn ?? globalThis.fetch) as unknown as OregonVerifiedFetch;
  const cache = await createOregonVerifiedSourceArtifactCache(input.rawCacheDir ?? DEFAULT_OREGON_VERIFIED_SOURCE_CACHE_DIR);
  const client = createOregonVerifiedSourceClient({
    userAgent: input.clientOptions?.userAgent, timeoutMs: input.clientOptions?.timeoutMs,
    fetchFn: async (url, init) => {
      // Existing Oregon production crawl pacing follows observed portal 403s.
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return fetchSource(url, init);
    },
    onRawResponse: capture => cache.writeCapture(capture),
  });
  const source = await loadOregonVerifiedFinanceSource({ candidateContext, client, refresh: input.refresh,
    readSavedPublicGet: url => cache.readSavedPublicGet(url),
    priorPacProvenance: prior.rows[0]!.pac_source_provenance,
    priorOutsideProvenanceByPayer: Object.fromEntries(outside.rows.map(row => [row.payer_committee_id,row.source_provenance])),
  });
  return { components: source.pac || source.positiveOutsideEvidence?.length
      ? { candidateContext, pac: source.pac, positiveOutsideEvidence: source.positiveOutsideEvidence } : undefined,
    diagnostics: source.diagnostics, generationDir: cache.generationDir };
}

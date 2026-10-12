import type { Pool, PoolClient } from "pg";
import { createFloridaCandidateAccountSource, resolveFloridaCandidateAccount,
  type FloridaCandidateAccountCatalog } from "./floridaCandidateAccountSource.js";
import { loadFloridaLocalFinanceContext, type FloridaLocalFinanceContext } from "./floridaLocalFinanceContext.js";
import { createFloridaProcessedFinanceSourceLoader, type FloridaProcessedSourceRequest } from "./floridaProcessedFinanceSourceLoader.js";
import type { FloridaProcessedFinanceProof } from "./floridaProcessedFinanceSource.js";

export type FloridaCandidateProcessedSourceResult = {
  status: "verified";
  localContext: FloridaLocalFinanceContext;
  proof: FloridaProcessedFinanceProof;
  accountCatalogHashes: readonly string[];
} | { status: "preserve"; diagnostics: readonly string[] };

/** Resolves the source account automatically from the all-status catalog, then
 * proves its current publication. No manually supplied account or money writes.
 */
export function createFloridaCandidateProcessedFinanceSource(options: {
  db: Pick<Pool | PoolClient, "query">;
  request: FloridaProcessedSourceRequest;
  refresh?: boolean;
}) {
  const accounts = createFloridaCandidateAccountSource({ requestRaw: options.request });
  const finance = createFloridaProcessedFinanceSourceLoader({ request: options.request, refresh: options.refresh });
  let catalog: Promise<FloridaCandidateAccountCatalog> | undefined;
  return {
    async load(input: { candidateId: string; electionId: string; committeeId: string }): Promise<FloridaCandidateProcessedSourceResult> {
      try {
        const local = await loadFloridaLocalFinanceContext({ ...input, db: options.db });
        if (local.status === "preserve") return { status: "preserve", diagnostics: [local.reason] };
        catalog ??= accounts.fetchCatalog({ electionId: "20261103-GEN", savedFirst: !options.refresh })
          .catch((error: unknown) => { catalog = undefined; throw error; });
        const directory = await catalog;
        const owner = resolveFloridaCandidateAccount({ rows: directory.rows, target: {
          candidateId: local.context.candidateId, candidateName: local.context.candidateName,
          electionYear: local.context.electionYear, electionType: "general",
          officeName: local.context.officeCanonicalName, district: local.context.district,
        } });
        if (owner.status !== "matched") return { status: "preserve", diagnostics: [owner.reason] };
        const result = await finance.load({ context: {
          sourceAccount: owner.account, candidateName: owner.row.candidateName,
          electionYear: local.context.electionYear, officeName: owner.officeName,
          district: owner.district, genericRecipientName: local.context.genericRecipientName,
        }, windowStart: "2025-01-01", windowEnd: "2026-12-31" });
        if (!result.proof) return { status: "preserve", diagnostics: result.diagnostics };
        return { status: "verified", localContext: { ...local.context }, proof: structuredClone(result.proof),
          accountCatalogHashes: directory.sources.map(source => source.sha256) };
      } catch (error) {
        return { status: "preserve", diagnostics: [error instanceof Error ? error.message : "Florida candidate source unavailable"] };
      }
    },
  };
}

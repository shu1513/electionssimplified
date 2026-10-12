import type { Pool, PoolClient } from "pg";
import { resolve } from "node:path";
import { createFloridaFinanceRawSourceClient } from "./floridaFinanceRawSourceClient.js";
import { createFloridaCandidateProcessedFinanceSource } from "./floridaCandidateProcessedFinanceSource.js";
import { createFloridaCommitteeRegistrySource, type FloridaCommitteeRegistryLookupResult, type FloridaReviewedCommitteeDates } from "./floridaCommitteeRegistrySource.js";
import { resolveFloridaCommitteeDonorIdentity } from "./floridaCommitteeDonorIdentity.js";
import { buildFloridaVerifiedCommitteeDonors } from "./floridaVerifiedCommitteeDonorSource.js";
import type { FloridaCommitteeDonorFinanceInput } from "./floridaCommitteeDonorWriter.js";

export type FloridaCandidateCommitteeSourceResult = { status: "accepted"; pacFinance: FloridaCommitteeDonorFinanceInput }
  | { status: "preserve"; diagnostics: readonly string[] };
export type FloridaCandidateCommitteeFinanceSource = {
  load(input: { candidateId: string; electionId: string; committeeId: string }): Promise<FloridaCandidateCommitteeSourceResult>;
};

export function createFloridaCandidateCommitteeFinanceSource(options: {
  db: Pick<Pool | PoolClient, "query">;
  cacheDir: string;
  refresh?: boolean;
  minIntervalMs?: number;
  reviewedDates?: readonly FloridaReviewedCommitteeDates[];
}): FloridaCandidateCommitteeFinanceSource {
  return {
    async load(input) {
      try {
        const raw = createFloridaFinanceRawSourceClient({ cacheDir: resolve(options.cacheDir, "verified-source"),
          refresh: options.refresh, minIntervalMs: options.minIntervalMs, maxRequests: 3000 });
        const processed = createFloridaCandidateProcessedFinanceSource({ db: options.db, request: raw.request, refresh: options.refresh });
        const registry = createFloridaCommitteeRegistrySource({ reviewedDates: options.reviewedDates,
          request: ({ phase, ...request }) => raw.request(request, { savedFirst: phase === "opening" && !options.refresh }) });
        const source = await processed.load(input);
        if (source.status === "preserve") return source;
        // Reuse only acquisition evidence within this candidate. Each occurrence
        // still resolves its own date/address and retains its own replay result.
        const acquisitions = new Map<string, Pick<FloridaCommitteeRegistryLookupResult,
          "registrations" | "queryProof" | "sourceHashes">>();
        const finance = await buildFloridaVerifiedCommitteeDonors({ proof: source.proof, lookupDonor: async receipt => {
          let evidence = acquisitions.get(receipt.reportedName);
          if (!evidence) {
            const result = await registry.lookupDonor(receipt);
            if (!result.registrations || !result.queryProof) return result;
            evidence = structuredClone({ registrations: result.registrations,
              queryProof: result.queryProof, sourceHashes: result.sourceHashes });
            acquisitions.set(receipt.reportedName, evidence);
          }
          return { ...resolveFloridaCommitteeDonorIdentity({ ...receipt, ...evidence }), ...structuredClone(evidence) };
        } });
        if (finance.status === "preserve") return { status: "preserve", diagnostics: [finance.reason] };
        return { status: "accepted", pacFinance: { source, finance } };
      } catch (error) {
        return { status: "preserve", diagnostics: [error instanceof Error ? error.message : "Florida committee source unavailable"] };
      }
    },
  };
}

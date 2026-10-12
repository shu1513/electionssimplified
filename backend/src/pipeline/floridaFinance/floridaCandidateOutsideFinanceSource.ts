import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { createFloridaFinanceRawSourceClient } from "./floridaFinanceRawSourceClient.js";
import { createFloridaIndependentExpenditureDiscovery } from "./floridaIndependentExpenditureDiscovery.js";
import { createFloridaOutsidePayerSource, selectFloridaOutsidePayerLeads, type FloridaOutsidePayerResult } from "./floridaOutsidePayerSource.js";
import { createFloridaProcessedExpenseSourceLoader } from "./floridaProcessedExpenseSourceLoader.js";
import { loadFloridaLocalFinanceContext, type FloridaLocalFinanceContext } from "./floridaLocalFinanceContext.js";
import { buildFloridaVerifiedOutsideAllocations, type FloridaOutsideAllocationSource } from "./floridaVerifiedOutsideAllocations.js";

type ResolvedPayer = Extract<FloridaOutsidePayerResult, { status: "resolved" }>;
export type FloridaCandidateOutsideFinanceComponent = {
  payerIdentity: Pick<ResolvedPayer, "payerLabel" | "rawSource">;
  source: FloridaOutsideAllocationSource;
};
export type FloridaCandidateOutsideFinanceSource = {
  load(input: { candidateId: string; electionId: string; committeeId: string }): Promise<
    | { status: "loaded"; localContext: FloridaLocalFinanceContext; components: readonly FloridaCandidateOutsideFinanceComponent[]; diagnostics: readonly string[] }
    | { status: "preserve"; diagnostics: readonly string[] }
  >;
};
const exact = (value: string) => value.trim().replace(/\s+/gu, " ").toUpperCase();

/** Partial explicit allocations only. Discovery absence supplies no zero;
 * previously accepted payers still refresh after an amendment removes a lead.
 * Independently failed payer components preserve while direct/PAC sync continues.
 */
export function createFloridaCandidateOutsideFinanceSource(options: {
  db: Pick<Pool | PoolClient, "query">;
  cacheDir: string;
  refresh?: boolean;
  minIntervalMs?: number;
}): FloridaCandidateOutsideFinanceSource {
  return {
    async load(input) {
      try {
        input = structuredClone(input);
        const local = await loadFloridaLocalFinanceContext({ db: options.db, ...input });
        if (local.status === "preserve") return { status: "preserve", diagnostics: [local.reason] };
        const context = local.context;
        if (context.officeScope !== "state_lower") return { status: "preserve", diagnostics: ["No source-witnessed explicit Purpose grammar for this office."] };
        const raw = createFloridaFinanceRawSourceClient({
          cacheDir: resolve(options.cacheDir, "outside-source"),
          refresh: options.refresh, minIntervalMs: options.minIntervalMs, maxRequests: 1000
        });
        const discovery = createFloridaIndependentExpenditureDiscovery({ request: raw.request, refresh: options.refresh });
        const payer = createFloridaOutsidePayerSource({ request: raw.request, refresh: options.refresh });
        // Financial captures must fit inside the registry opening/closing interval.
        // Reusing its just-captured opening owner GET would predate completion of the
        // opening registry authority, so this nested packet is always genuinely fresh.
        const expenses = createFloridaProcessedExpenseSourceLoader({ request: raw.request, refresh: true });
        const tracked = await options.db.query<{ payer_name: string; payer_type: string }>(`
          SELECT payer_name, payer_type FROM public.fl_candidate_finance_ie_sources
          WHERE candidate_election_id = $1::uuid AND election_year = $2
        `, [context.candidateElectionId, context.electionYear]);
        const labels = new Map<string, string>();
        for (const row of tracked.rows) {
          if (!row.payer_name?.trim() || !["PAC", "IXO"].includes(row.payer_type))
            return { status: "preserve", diagnostics: ["Invalid prior verified payer ownership."] };
          const label = `${row.payer_name} (${row.payer_type})`;
          labels.set(exact(label), label);
        }
        const found = await discovery.load({
          electionSelector: "20261103-GEN",
          purposePrefix: `TEXT MESSAGES; PRO-${context.candidateName}`
        });
        const diagnostics: string[] = [];
        if (found.status === "preserve") diagnostics.push(...found.diagnostics);
        else for (const row of selectFloridaOutsidePayerLeads({ rows: found.rows, localContext: context }))
          labels.set(exact(row.payerLabel), row.payerLabel);
        if (labels.size > 20) return { status: "preserve", diagnostics: ["Relevant payer acquisition bound exceeded."] };
        const components: FloridaCandidateOutsideFinanceComponent[] = [];
        for (const label of labels.values()) {
          let financialSource: FloridaOutsideAllocationSource | undefined;
          const identity = await payer.load({
            payerLabel: label, betweenOpeningAndClosing: async opening => {
              const loaded = await expenses.load({
                context: {
                  payerAccount: opening.owner.committeeId,
                  payerName: opening.owner.committeeName, payerType: opening.payerType,
                  electionYear: 2026, electionType: "general", electionDescription: "2026 General Election",
                  electionSelector: "20261103-GEN", genericPayerLabel: `${opening.owner.committeeName} (${opening.payerType})`
                }
              });
              diagnostics.push(...loaded.diagnostics);
              if (!loaded.source) return undefined;
              const allocated = buildFloridaVerifiedOutsideAllocations({ source: loaded.source, localContext: context });
              if (allocated.status === "preserve") { diagnostics.push(...allocated.diagnostics); return undefined; }
              const captures = allocated.proof.sourceMetadata;
              if (!captures.length) throw new Error("Verified expenses lack source capture metadata.");
              const first = captures.reduce((a, b) => Date.parse(a.startedAt) <= Date.parse(b.startedAt) ? a : b);
              const last = captures.reduce((a, b) => Date.parse(a.completedAt) >= Date.parse(b.completedAt) ? a : b);
              financialSource = loaded.source;
              // Preserve original capture strings, including saved opening times.
              return { startedAt: first.startedAt, completedAt: last.completedAt };
            }
          });
          if (identity.status === "preserve") { diagnostics.push(...identity.diagnostics); continue; }
          if (!financialSource) continue;
          components.push({ payerIdentity: { payerLabel: identity.payerLabel, rawSource: identity.rawSource }, source: financialSource });
        }
        if (!components.length) diagnostics.push("No verified payer allocation; existing outside spending remains unchanged.");
        return { status: "loaded", localContext: context, components, diagnostics };
      } catch (error) {
        return { status: "preserve", diagnostics: [error instanceof Error ? error.message : "Outside source unavailable."] };
      }
    },
  };
}

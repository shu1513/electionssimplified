import type { Pool } from "pg";
import { loadVermontCommitteeCashContext } from "./vermontCommitteeCashContext.js";
import {
  acquireVermontCommitteeCash,
  type VermontCommitteeCashResponseCapture,
} from "./vermontCommitteeCashAcquisition.js";
import { qualifyVermontCommitteeCash } from "./vermontCommitteeCashQualification.js";
import { storeVermontCommitteeCash } from "./vermontCommitteeCashWriter.js";
import {
  VermontCampaignFinanceClientError,
  type VermontCampaignFinanceClientOptions,
} from "./vermontCampaignFinanceClient.js";

export type VermontCommitteeCashSyncResult = {
  status: "qualified" | "held" | "failed";
  candidateId: string;
  electionId: string;
  dryRun: boolean;
  written: boolean;
  diagnostics: string[];
  failureStage?:
    "context" | "prior_source" | "acquisition" | "qualification" | "write";
  sourceErrorCode?: string;
  sourceHttpStatus?: number;
  observedAt?: string;
  periodStart?: string;
  periodEnd?: string;
  donorCount?: number;
  contributionCount?: number;
  netCents?: number;
  cashControlCents?: number;
  unclassifiedCashCents?: number;
  unclassifiedCashCount?: number;
};
export type VermontCommitteeCashSyncInput = {
  db: Pick<Pool, "query" | "connect">;
  candidateId: string;
  electionId: string;
  dryRun?: boolean;
  clientOptions?: VermontCampaignFinanceClientOptions;
  onCapture?: (
    capture: VermontCommitteeCashResponseCapture,
  ) => void | Promise<void>;
  loadContextFn?: typeof loadVermontCommitteeCashContext;
  acquireFn?: typeof acquireVermontCommitteeCash;
  qualifyFn?: typeof qualifyVermontCommitteeCash;
  storeFn?: typeof storeVermontCommitteeCash;
};

/** Opt-in isolated cash path. Failed or held source observations never invoke legacy writes. */
export async function syncVermontCommitteeCash(
  input: VermontCommitteeCashSyncInput,
): Promise<VermontCommitteeCashSyncResult> {
  const { db, candidateId, electionId, onCapture } = input;
  const dryRun = input.dryRun === true;
  const clientOptions = input.clientOptions
    ? { ...input.clientOptions }
    : undefined;
  const loadContext = input.loadContextFn ?? loadVermontCommitteeCashContext;
  const acquire = input.acquireFn ?? acquireVermontCommitteeCash;
  const qualify = input.qualifyFn ?? qualifyVermontCommitteeCash;
  const store = input.storeFn ?? storeVermontCommitteeCash;
  const base = { candidateId, electionId, dryRun, written: false };
  let stage: NonNullable<VermontCommitteeCashSyncResult["failureStage"]> =
    "context";
  try {
    const context = await loadContext({
      db,
      candidateId,
      electionId,
      clientOptions,
    });
    stage = "prior_source";
    const prior = await db.query<{ report_periods: unknown }>(
      `
      SELECT report_periods FROM public.vt_candidate_finance_pac_sources
      WHERE link_id=$1::uuid AND election_year=$2::integer`,
      [context.linkId, context.electionYear],
    );
    if (prior.rows.length > 1)
      throw new Error("Ambiguous Vermont prior cash source");
    const rawPeriods = prior.rows[0]?.report_periods;
    if (
      prior.rows.length &&
      (!Array.isArray(rawPeriods) ||
        rawPeriods.length === 0 ||
        rawPeriods.some(
          (p) =>
            !p ||
            typeof p.periodStart !== "string" ||
            typeof p.periodEnd !== "string",
        ))
    ) {
      throw new Error("Malformed Vermont prior cash report periods");
    }
    const priorReportPeriods = (
      rawPeriods as { periodStart: string; periodEnd: string }[] | undefined
    )?.map((p) => ({ periodStart: p.periodStart, periodEnd: p.periodEnd }));
    stage = "acquisition";
    const packet = await acquire({
      context,
      fetchImpl: clientOptions?.fetchImpl,
      timeoutMs: clientOptions?.timeoutMs,
      onCapture,
    });
    stage = "qualification";
    const result = qualify({
      context: packet.context,
      before: packet.before,
      after: packet.after,
      priorReportPeriods,
    });
    if (result.status === "held")
      return { ...base, status: "held", diagnostics: result.diagnostics };
    let netCents = 0,
      contributionCount = 0;
    for (const p of result.positions) {
      netCents += p.amountCents;
      contributionCount += p.contributionCount;
      if (
        !Number.isSafeInteger(netCents) ||
        !Number.isSafeInteger(contributionCount)
      )
        throw new Error("Unsafe Vermont cash output totals");
    }
    if (!dryRun) {
      stage = "write";
      await store({
        db,
        context: packet.context,
        qualified: result,
        observedAt: packet.observedAt,
      });
    }
    return {
      ...base,
      status: "qualified",
      written: !dryRun,
      diagnostics: result.diagnostics,
      observedAt: packet.observedAt.toISOString(),
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      donorCount: result.positions.length,
      contributionCount,
      netCents,
      cashControlCents: result.monetaryCashCents,
      unclassifiedCashCents: result.unclassifiedCashCents,
      unclassifiedCashCount: result.unclassifiedCashCount,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      failureStage: stage,
      diagnostics: [
        `Vermont committee cash ${stage} failed; existing finance preserved`,
      ],
      ...(error instanceof VermontCampaignFinanceClientError
        ? { sourceErrorCode: error.code, sourceHttpStatus: error.status }
        : {}),
    };
  }
}

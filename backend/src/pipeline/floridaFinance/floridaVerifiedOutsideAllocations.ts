import {
  verifyFloridaProcessedExpenseSource,
  type FloridaProcessedExpenseContext,
  type FloridaProcessedExpensePacket,
  type FloridaProcessedExpenseProof,
} from "./floridaProcessedExpenseSource.js";
import { matchFloridaExplicitIndependentExpenditure, type FloridaNativeExpenditure } from "./floridaExplicitIndependentExpenditure.js";
import type { FloridaLocalFinanceContext } from "./floridaLocalFinanceContext.js";

export type FloridaOutsideAllocationSource = {
  context: FloridaProcessedExpenseContext;
  before: FloridaProcessedExpensePacket;
  after: FloridaProcessedExpensePacket;
};
export type FloridaVerifiedOutsideAllocations = {
  status: "verified_payer_target";
  candidateWideZeroAuthority: false;
  localContext: FloridaLocalFinanceContext;
  proof: FloridaProcessedExpenseProof;
  allocations: readonly {
    occurrence: number;
    reportSequence: number;
    supportOppose: "support";
    amountCents: number;
    row: FloridaNativeExpenditure;
  }[];
  supportCents: number;
  unmatchedExpenseCount: number;
};

/** Reverify full untouched packets before filtering money. Empty is authority
 * for this specific payer/target only, never candidate-wide zero or completeness.
 * The caller independently resolves payer uniqueness and locks local ownership.
 */
export function buildFloridaVerifiedOutsideAllocations(input: {
  source: FloridaOutsideAllocationSource;
  localContext: FloridaLocalFinanceContext;
}): FloridaVerifiedOutsideAllocations | { status: "preserve"; diagnostics: readonly string[] } {
  try {
    input = structuredClone(input);
    const local = input.localContext;
    if (!local.candidateId || !local.candidateElectionId || !local.electionId || !local.committeeId ||
      !local.candidateName?.trim() || local.electionYear !== 2026 || local.electionDate !== "2026-11-03" ||
      local.officeScope !== "state_lower" || local.officeCanonicalName !== "State Lower Chamber Legislator" ||
      !/^(?:[1-9]\d?|1[01]\d|120)$/.test(local.district ?? "")) throw new Error("Unverified local General target scope.");
    const context = input.source.context;
    if (context.electionYear !== local.electionYear || context.electionType !== "general" ||
      context.electionDescription !== "2026 General Election" || context.electionSelector !== "20261103-GEN")
      throw new Error("Source and local target elections differ.");
    const verified = verifyFloridaProcessedExpenseSource(input.source);
    if (!verified.proof) return { status: "preserve", diagnostics: verified.diagnostics };
    const proof = verified.proof;
    const target = { candidateId: local.candidateId, electionId: local.electionId,
      candidateName: local.candidateName, electionYear: local.electionYear, electionType: "general" as const,
      electionDescription: "2026 General Election", officeScope: local.officeScope,
      officeName: local.officeCanonicalName, district: local.district };
    const allocations: FloridaVerifiedOutsideAllocations["allocations"][number][] = [];
    for (const row of proof.rows) {
      const reports = proof.reports.filter(({ current }) =>
        current.reportYear === row.reportYear && current.reportType === row.reportType);
      if (reports.length !== 1) throw new Error("Expense occurrence lacks one current source report.");
      const current = reports[0]!.current;
      const match = matchFloridaExplicitIndependentExpenditure({ row, reportContext: current, verifiedTarget: target });
      if (match.status === "matched") allocations.push({ occurrence: row.occurrence,
        reportSequence: current.sequence, supportOppose: match.target.supportOppose, amountCents: match.amountCents, row });
    }
    const supportCents = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
    if (!Number.isSafeInteger(supportCents)) throw new Error("Unsafe allocated expense cents.");
    return { status: "verified_payer_target", candidateWideZeroAuthority: false, localContext: local, proof,
      allocations, supportCents, unmatchedExpenseCount: proof.rows.length - allocations.length };
  } catch (error) {
    return { status: "preserve", diagnostics: [error instanceof Error ? error.message : "Outside allocation proof failed."] };
  }
}

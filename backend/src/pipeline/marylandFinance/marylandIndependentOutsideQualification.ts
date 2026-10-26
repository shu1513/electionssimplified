import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import { normalizeMarylandCandidateNameKeys } from "./marylandCandidateCommitteeResolver.js";
import {
  bindMarylandLegislativeOutsideTarget,
  type MarylandLegislativeOutsideCanonical,
} from "./marylandLegislativeOutsideTarget.js";
import type { MarylandPublishedOutsideReport } from "./marylandPublicReportClient.js";
import type { readMarylandOutsideParentControls } from "./marylandOutsideParentControls.js";
export type MarylandOutsideRow = Readonly<Record<string, unknown>>;
export type MarylandOutsideCanonical = MarylandLegislativeOutsideCanonical & {
  candidateId: string;
  electionId: string;
};
export type MarylandOutsideGroup = {
  payerGuid: string;
  filingEntityId: number;
  committeeName: string;
  stance: "support" | "oppose";
  amountCents: number;
};
export type MarylandOutsideQualifiedSnapshot = {
  context: MarylandOutsideCanonical;
  groups: MarylandOutsideGroup[];
  allocationCount: number;
  supportCents: number;
  opposeCents: number;
  sourceObservedAt: string;
  generationDirectory: string;
  nativeDirectory: string;
  targetAccountGuids: string[];
};
type Controls = Awaited<ReturnType<typeof readMarylandOutsideParentControls>>;
const fail = (code: string): never => {
  throw new Error(code);
};
export const marylandOutsideGuid = (v: unknown): string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v) &&
  !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v)
    ? v.toLowerCase()
    : fail("outside_invalid_identity");
export const marylandOutsideParentGuid = (r: MarylandOutsideRow) =>
  marylandOutsideGuid(r.parentTransactionGuid ?? r.transactionGuid);
export function marylandOutsideCents(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    return fail("outside_invalid_amount");
  const n = Math.round(v * 100);
  if (!Number.isSafeInteger(n) || Math.abs(n / 100 - v) > 1e-8)
    return fail("outside_invalid_amount");
  return n;
}
const add = (a: number, b: number) =>
  Number.isSafeInteger(a + b) ? a + b : fail("outside_amount_overflow");
const text = (v: unknown): string =>
  typeof v === "string" && !!v.trim() ? v : fail("outside_invalid_text");
const label = (v: unknown) => text(v).trim().replace(/\s+/g, " ").toUpperCase();
const normalize = (v: string) =>
  v
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
export function marylandOutsideOwnerMatches(
  canonicalName: string,
  row: MarylandOutsideRow,
): boolean {
  if (typeof row.candidateName !== "string") return false;
  const keys = normalizeMarylandCandidateNameKeys(canonicalName, {
    expandNicknames: true,
  });
  return (
    [...normalizeMarylandCandidateNameKeys(row.candidateName)].some((k) =>
      keys.has(k),
    ) &&
    !hasMiddleNameConflict({
      candidateName: canonicalName,
      rowNames: [row.candidateName],
      normalizePersonName: normalize,
    })
  );
}
export function marylandOutsideReportAuthority(
  row: MarylandOutsideRow,
  reports: readonly MarylandPublishedOutsideReport[],
) {
  const guid = marylandOutsideGuid(row.reportGuId),
    version = row.reportVersionId;
  const exact = reports.filter(
    (r) => r.reportGuid.toLowerCase() === guid && r.reportVersionId === version,
  );
  if (exact.length === 1) return { report: exact[0]!, current: true };
  const history = reports.filter((r) =>
    r.childResults?.some(
      (c) =>
        c.filerReportGuid.toLowerCase() === guid &&
        c.filerReportVersionID === version,
    ),
  );
  if (history.length === 1) return { report: history[0]!, current: false };
  return fail("outside_report_edition_unresolved");
}
/** Resolves every potentially owned source account before selecting monetary
 * rows. Unknown context on a sibling account holds the whole candidate. */
export function bindMarylandOutsideOwnedAccounts(input: {
  context: MarylandOutsideCanonical;
  rows: readonly MarylandOutsideRow[];
  registry: ReadonlyMap<string, readonly MarylandOutsideRow[]>;
  rosterHtml: string;
  electionDatesHtml: string;
}) {
  const targets = new Map<string, MarylandOutsideRow>();
  for (const r of input.rows)
    if (
      r.electionYear === input.context.electionYear &&
      r.candidateGuid !== null
    ) {
      const key = marylandOutsideGuid(r.candidateGuid);
      // Current census precedes retained evidence. Its exact current label wins;
      // an unrelated historical rename cannot invalidate every candidate.
      if (!targets.has(key)) targets.set(key, r);
    }
  const owned = new Set<string>();
  for (const [guid, target] of targets) {
    const registrations = input.registry.get(guid);
    if (!registrations) return fail("outside_registry_incomplete");
    const matches = registrations.filter(
      (r) => marylandOutsideGuid(r.filerRegistrationGuid) === guid,
    );
    if (matches.length !== 1) return fail("outside_registry_account_ambiguous");
    if (!marylandOutsideOwnerMatches(input.context.candidateName, matches[0]!))
      continue;
    const currentLabel = input.rows.find(
      (r) =>
        r.electionYear === input.context.electionYear &&
        r.candidateGuid !== null &&
        marylandOutsideGuid(r.candidateGuid) === guid &&
        label(r.candidateBallotIssueName) === label(matches[0]!.committeeName),
    );
    if (!currentLabel) return fail("outside_owned_account_context_unresolved");
    const result = bindMarylandLegislativeOutsideTarget({
      canonical: input.context,
      target: {
        candidateGuid: guid,
        candidateBallotIssueName: text(currentLabel.candidateBallotIssueName),
      },
      registrationRows: registrations,
      rosterHtml: input.rosterHtml,
      electionDatesHtml: input.electionDatesHtml,
    });
    if (!result.binding)
      return fail("outside_owned_account_context_unresolved");
    owned.add(guid);
  }
  return owned;
}
/** Complete, uncapped candidate aggregation. These inputs are reconstructed by
 * the normal whole-source readers; no ready/accepted/verified flags are used.
 * Retained parents must still have a qualified current source cohort, so an
 * unexplained disappearance cannot overwrite existing money with a subset. */
export function qualifyMarylandIndependentOutside(input: {
  context: MarylandOutsideCanonical;
  rows: readonly MarylandOutsideRow[];
  previousRows: readonly MarylandOutsideRow[];
  registry: ReadonlyMap<string, readonly MarylandOutsideRow[]>;
  rosterHtml: string;
  electionDatesHtml: string;
  reports: ReadonlyMap<string, readonly MarylandPublishedOutsideReport[]>;
  controls: ReadonlyMap<string, Controls>;
}): {
  groups: MarylandOutsideGroup[];
  allocationCount: number;
  supportCents: number;
  opposeCents: number;
} {
  const { context, rows } = input;
  const accounts = bindMarylandOutsideOwnedAccounts({
    ...input,
    rows: [...rows, ...input.previousRows],
  });
  const potentiallyOwned = (r: MarylandOutsideRow) =>
    r.electionYear === context.electionYear &&
    r.candidateGuid !== null &&
    accounts.has(marylandOutsideGuid(r.candidateGuid));
  const references = [...rows, ...input.previousRows].filter(
    (r) => potentiallyOwned(r) && r.expenditureTypeCode === "TIEXP",
  );
  if (!references.length) return fail("outside_no_qualified_positive_scope");
  const parents = new Set(references.map(marylandOutsideParentGuid)),
    groups = new Map<string, MarylandOutsideGroup>();
  let supportCents = 0,
    opposeCents = 0,
    allocationCount = 0;
  for (const parentGuid of parents) {
    const control = input.controls.get(parentGuid);
    if (!control || marylandOutsideGuid(control.detail.guid) !== parentGuid)
      return fail("outside_parent_control_missing");
    if (control.returns.length)
      return fail("outside_return_allocation_unresolved");
    const candidates = rows.filter(
      (r) => marylandOutsideParentGuid(r) === parentGuid,
    );
    if (!candidates.length)
      return fail("outside_retained_parent_current_scope_missing");
    const current: MarylandOutsideRow[] = [];
    for (const r of candidates) {
      const book = input.reports.get(
        marylandOutsideGuid(r.filerRegistrationGuid),
      );
      if (!book) return fail("outside_payer_inventory_missing");
      const authority = marylandOutsideReportAuthority(r, book);
      if (authority.current) current.push(r);
    }
    if (!current.length) return fail("outside_parent_current_edition_missing");
    const first = current[0]!,
      payer = marylandOutsideGuid(first.filerRegistrationGuid),
      entity = first.filingEntityId;
    if (
      typeof entity !== "number" ||
      !Number.isSafeInteger(entity) ||
      entity < 1
    )
      return fail("outside_invalid_payer");
    const report = marylandOutsideReportAuthority(
      first,
      input.reports.get(payer)!,
    ).report;
    if (
      report.filerRegistrationGuid.toLowerCase() !== payer ||
      report.reportingCycleId !== first.electionCycleId ||
      typeof control.detail.transactionDate !== "string" ||
      control.detail.transactionDate.slice(0, 10) !==
        String(first.transactionDate).slice(0, 10)
    )
      return fail("outside_parent_owner_date_conflict");
    for (const reference of references.filter(
      (r) => marylandOutsideParentGuid(r) === parentGuid,
    )) {
      const authority = marylandOutsideReportAuthority(
        reference,
        input.reports.get(payer)!,
      );
      if (
        marylandOutsideGuid(reference.filerRegistrationGuid) !== payer ||
        reference.filingEntityId !== entity ||
        authority.report.reportGuid !== report.reportGuid ||
        authority.report.reportVersionId !== report.reportVersionId
      )
        return fail("outside_retained_parent_authority_conflict");
    }
    const allocationValue = (r: MarylandOutsideRow) =>
      JSON.stringify([
        r.candidateGuid,
        r.positionCode,
        r.amountApplied,
        r.transactionAmount,
        r.transactionDate,
        r.electionYear,
        r.reportGuId,
        r.reportVersionId,
        r.transactionVersionID,
      ]);
    for (const old of input.previousRows.filter(
      (r) =>
        potentiallyOwned(r) &&
        marylandOutsideParentGuid(r) === parentGuid &&
        r.expenditureTypeCode === "TIEXP",
    )) {
      if (current.some((r) => allocationValue(r) === allocationValue(old)))
        continue;
      if (
        marylandOutsideReportAuthority(old, input.reports.get(payer)!).current
      )
        return fail("outside_retained_allocation_unversioned_change");
    }
    const role = control.detail.transactionSubTypeCode;
    if (!["TIEXP", "TECOM"].includes(String(role)))
      return fail("outside_parent_role_unresolved");
    const parentAmount = marylandOutsideCents(control.detail.transactionAmount);
    const sourceTuples: string[] = [],
      childTuples: string[] = [];
    let allocated = 0,
      childAllocated = 0;
    for (const r of current) {
      if (
        marylandOutsideGuid(r.filerRegistrationGuid) !== payer ||
        r.filingEntityId !== entity ||
        r.filingEntityId !== report.filingEntityId ||
        marylandOutsideGuid(r.reportGuId) !== report.reportGuid.toLowerCase() ||
        r.reportVersionId !== report.reportVersionId ||
        r.transactionVersionID !== first.transactionVersionID ||
        r.expenditureTypeCode !== role ||
        r.isActive !== true ||
        r.committeeTypeCode !== report.committeeTypeCode ||
        r.electionCycleId !== report.reportingCycleId ||
        !report.isActive ||
        report.zeroActivity ||
        marylandOutsideCents(r.transactionAmount) !== parentAmount ||
        typeof r.transactionDate !== "string" ||
        r.transactionDate.slice(0, 10) < report.startDate.slice(0, 10) ||
        r.transactionDate.slice(0, 10) > report.endDate.slice(0, 10)
      )
        return fail("outside_parent_report_control_conflict");
      const amount = marylandOutsideCents(r.amountApplied),
        stance =
          r.positionCode === "STSUPP"
            ? "support"
            : r.positionCode === "STOPP"
              ? "oppose"
              : fail("outside_stance_unresolved");
      const target =
        r.candidateGuid === null
          ? [null, label(r.candidateBallotIssueName)]
          : [marylandOutsideGuid(r.candidateGuid)];
      sourceTuples.push(JSON.stringify([target, stance, amount]));
      allocated = add(allocated, amount);
    }
    for (const child of control.allocations) {
      const amount = marylandOutsideCents(child.amount),
        stance =
          child.isSupport === true
            ? "support"
            : child.isSupport === false
              ? "oppose"
              : fail("outside_child_stance_unresolved");
      const target =
        child.filerRegistrationGuid === null
          ? [null, label(child.candidateMeasureTitle)]
          : [marylandOutsideGuid(child.filerRegistrationGuid)];
      childTuples.push(JSON.stringify([target, stance, amount]));
      childAllocated = add(childAllocated, amount);
    }
    if (
      JSON.stringify(sourceTuples.sort()) !==
        JSON.stringify(childTuples.sort()) ||
      allocated !== parentAmount ||
      childAllocated !== parentAmount
    )
      return fail("outside_complete_parent_allocation_conflict");
    for (const r of current) {
      if (!potentiallyOwned(r) || role !== "TIEXP") continue;
      if (
        r.isCandidateActivity !== true ||
        typeof r.transactionDate !== "string" ||
        Number(r.transactionDate.slice(0, 4)) > context.electionYear
      )
        return fail("outside_target_election_unresolved");
      const amount = marylandOutsideCents(r.amountApplied),
        stance = r.positionCode === "STSUPP" ? "support" : "oppose";
      allocationCount++;
      if (!amount) continue;
      const key = JSON.stringify([payer, stance]),
        previous = groups.get(key);
      if (
        previous &&
        (previous.filingEntityId !== entity ||
          label(previous.committeeName) !== label(r.committeeName))
      )
        return fail("outside_payer_identity_conflict");
      const group = previous ?? {
        payerGuid: payer,
        filingEntityId: entity,
        committeeName: text(r.committeeName),
        stance,
        amountCents: 0,
      };
      group.amountCents = add(group.amountCents, amount);
      groups.set(key, group);
      if (stance === "support") supportCents = add(supportCents, amount);
      else opposeCents = add(opposeCents, amount);
    }
  }
  return {
    groups: [...groups.values()].sort(
      (a, b) =>
        a.payerGuid.localeCompare(b.payerGuid) ||
        a.stance.localeCompare(b.stance),
    ),
    allocationCount,
    supportCents,
    opposeCents,
  };
}

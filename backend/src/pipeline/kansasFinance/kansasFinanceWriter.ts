// Kansas finance snapshot writer (docs/plans/plan-kansas-finance.md, Phase 3+).
// Thin wrapper over the standard state-finance writer. Identity: Kansas has
// no filer id (the viewer keeps report identity in server session state), so
// committee_id is the deterministic viewer SEARCH RECIPE
// "<officeCode>:<district>:<SURNAME>:<FIRST>" built by the resolver;
// committee_name is the most frequent filed display name.
//
// Direct figures retain their existing replacement semantics. Missing or
// rejected outside evidence preserves prior outside totals and rows; only an
// explicitly supplied outside component replaces it. A local transcription
// table's absence or shared allocation is not proof of a financial zero.

import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceLinkInput,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceSnapshotInput,
  type StandardStateFinanceSnapshotWriteResult,
} from "../finance/standardStateFinanceSnapshotWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type KansasFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type KansasFinanceLinkSource = "manual" | "cfr_viewer";

export type KansasFinanceLinkInput = Omit<StandardStateFinanceLinkInput, "linkSource"> & {
  linkSource?: KansasFinanceLinkSource;
};

export type KansasFinanceSnapshotInput = Omit<StandardStateFinanceSnapshotInput, "link"> & {
  link: KansasFinanceLinkInput;
};
export type KansasFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

export const KANSAS_FILER_KEY_PATTERN = /^[0-9]+:[0-9]*:[A-Z0-9][A-Z0-9 ]*:[A-Z0-9][A-Z0-9 ]*$/;

/** Stored-name normalization (the Delaware/Montana convention). */
export function normalizeKansasNameForStorage(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Recipe key "<officeCode>:<district>:<SURNAME>:<FIRST>"; the migration CHECK mirrors the pattern. */
export function buildKansasFilerKey(input: {
  officeCode: string;
  districtNumber: number | null;
  surname: string;
  firstName: string;
}): string {
  const key = [
    input.officeCode.trim(),
    input.districtNumber === null ? "" : String(input.districtNumber),
    normalizeKansasNameForStorage(input.surname),
    normalizeKansasNameForStorage(input.firstName),
  ].join(":");
  return normalizeKansasFilerKey(key);
}

export function normalizeKansasFilerKey(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, " ");
  if (!KANSAS_FILER_KEY_PATTERN.test(normalized)) {
    throw new Error(`Invalid Kansas filer key: ${value}`);
  }
  return normalized;
}

/** The recipe's parts; the sync re-runs the viewer search from them. */
export function parseKansasFilerKey(value: string): {
  officeCode: string;
  districtNumber: number | null;
  surname: string;
  firstName: string;
} {
  const [officeCode, district, surname, firstName] = normalizeKansasFilerKey(value).split(":") as [
    string,
    string,
    string,
    string,
  ];
  return {
    officeCode,
    districtNumber: district === "" ? null : Number.parseInt(district, 10),
    surname,
    firstName,
  };
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Kansas",
  minElectionYear: 2024,
  summaryUpdatePolicy: {
    total_receipts: "replace",
    direct_contribution_total: "replace",
    total_disbursements: "replace",
    cash_on_hand: "replace",
    source_url: "replace",
  },
  outsideGroupValidation: "pairing",
  // Link ids are canonicalized by upsertKansasFinanceLink before they reach
  // the writer; outside-group ids (Phase 5 IE filers) are free text. The
  // shared normalizer therefore only trims.
  normalizeCommitteeId: (value) => value.trim(),
  supersededLinkSource: "cfr_viewer",
  manualLinkProtection: true,
  tables: {
    links: "ks_candidate_finance_links",
    summaries: "ks_candidate_finance_summaries",
    directBreakdowns: "ks_candidate_finance_direct_breakdowns",
    outsideGroups: "ks_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "ks_candidate_finance_outside_group_breakdowns",
  },
});

export async function upsertKansasFinanceLink(input: {
  db: Queryable;
  link: KansasFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({
    db: input.db,
    link: { ...input.link, committeeId: normalizeKansasFilerKey(input.link.committeeId) },
  });
}

/**
 * Link + summary + direct breakdowns + outside groups in one transaction.
 * An explicit outside-group list replaces that component; omission preserves
 * it. Explicit numeric zero still replaces a stored scalar, while null does not.
 */
export async function replaceKansasCandidateFinanceSnapshot(
  input: KansasFinanceSnapshotInput
): Promise<KansasFinanceSnapshotWriteResult> {
  return writer.replaceSnapshot({
    ...input,
    link: { ...input.link, committeeId: normalizeKansasFilerKey(input.link.committeeId) },
  });
}

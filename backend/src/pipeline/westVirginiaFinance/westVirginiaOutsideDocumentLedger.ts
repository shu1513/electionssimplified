// Phase 3 evidence ledger for scanned F-7b / electioneering-communication
// report documents. Every entry is a reviewed reading of one PDF in the
// outside-documents inventory, pinned to that PDF's SHA-256. Only `accepted`
// entries publish; `review` and `rejected` entries are explicit reviewer
// decisions that stay in the file as the audit trail. Target candidates are
// recorded as the exact roster storage name, resolved at review time, so the
// sync matches by equality and never by fuzzy name logic.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeWestVirginiaCandidateNameForStorage } from "./westVirginiaCandidateCommitteeResolver.js";
import { westVirginiaDistrictNumberFromDistrictName } from "./westVirginiaFinanceEligibleOffices.js";
import type { WestVirginiaOutsideDocumentInventory } from "./westVirginiaOutsideDocumentInventory.js";

export const WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_SCOPE = "registered_iec_ecc_report_documents";
export const DEFAULT_WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_PATH = "evidence/west-virginia-finance/outside-document-ledger.json";
export const WEST_VIRGINIA_DOCUMENT_IE_COVERAGE_NOTE =
  "Includes independent expenditures and electioneering communications read from reports filed by committees registered with the West Virginia Secretary of State, plus electronically reported independent expenditures. Spending by filers without a registered committee is not covered.";

export type WestVirginiaOutsideTargetOffice = "House of Delegates" | "State Senate";
export const WEST_VIRGINIA_OUTSIDE_LINK_OFFICE_BY_TARGET: Readonly<Record<WestVirginiaOutsideTargetOffice, string>> = {
  "House of Delegates": "State Lower Chamber Legislator",
  "State Senate": "State Senator",
};

export type WestVirginiaOutsideDocumentExpenditure = {
  /** 1-based position on the form. */
  index: number;
  /** Candidate name as written on the form. */
  targetName: string;
  /** Exact roster storage name (`wv_candidate_finance_links.candidate_name_normalized`), or null when the target is not on the November roster. */
  targetRosterName: string | null;
  targetOffice: WestVirginiaOutsideTargetOffice | null;
  targetDistrict: number | null;
  stance: "support" | "oppose";
  amount: number;
  /** Civil date of the expenditure / dissemination, YYYY-MM-DD. */
  expenditureDate: string;
  payee: string;
  purpose: string | null;
};

export type WestVirginiaOutsideDocumentLedgerEntry = {
  documentID: number;
  orgID: number;
  spenderEntityId: string;
  spenderName: string;
  sha256: string;
  receivedDate: string;
  category: "independent_expenditure" | "electioneering_communication";
  reviewStatus: "accepted" | "review" | "rejected";
  reviewNote: string | null;
  reviewedAt: string;
  expenditures: WestVirginiaOutsideDocumentExpenditure[];
};

export type WestVirginiaOutsideDocumentLedger = {
  version: 1;
  scope: typeof WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_SCOPE;
  entries: WestVirginiaOutsideDocumentLedgerEntry[];
};

export type WestVirginiaDocumentIeProvenance = {
  kind: "document";
  documentID: number;
  orgID: number;
  spenderEntityId: string;
  sha256: string;
  expenditureIndex: number;
  category: WestVirginiaOutsideDocumentLedgerEntry["category"];
  expenditureDate: string;
  amount: number;
  supportOppose: "support" | "oppose";
  targetRosterName: string;
  receivedDate: string;
};

function fail(message: string): never { throw new Error(`West Virginia outside document ledger: ${message}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(`invalid ${label}`);
  return value.trim();
}
function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, label);
}
function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`invalid ${label}`);
  return value as number;
}
function day(value: unknown, label: string): string {
  const s = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(`invalid ${label}`);
  const parsed = new Date(`${s}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) fail(`invalid ${label}`);
  return s;
}
function amount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`invalid ${label}`);
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents / 100 - value) > 1e-9) fail(`${label} is not a cent amount`);
  return cents / 100;
}

function parseExpenditure(value: unknown, position: number): WestVirginiaOutsideDocumentExpenditure {
  const row = object(value, `expenditure ${position}`);
  const index = integer(row.index, "expenditure index", 1);
  if (index !== position) fail(`expenditure index ${index} out of order`);
  const stance = row.stance;
  if (stance !== "support" && stance !== "oppose") fail("invalid stance");
  const targetRosterName = optionalText(row.targetRosterName, "targetRosterName");
  if (targetRosterName !== null && normalizeWestVirginiaCandidateNameForStorage(targetRosterName) !== targetRosterName) {
    fail(`targetRosterName is not in storage form: ${targetRosterName}`);
  }
  const targetOffice = row.targetOffice === null || row.targetOffice === undefined ? null : row.targetOffice;
  if (targetOffice !== null && targetOffice !== "House of Delegates" && targetOffice !== "State Senate") fail("invalid targetOffice");
  const targetDistrict = row.targetDistrict === null || row.targetDistrict === undefined ? null : integer(row.targetDistrict, "targetDistrict", 1);
  if (targetRosterName !== null && (targetOffice === null || targetDistrict === null)) fail("roster target requires office and district");
  return {
    index, targetName: text(row.targetName, "targetName"), targetRosterName, targetOffice, targetDistrict, stance,
    amount: amount(row.amount, "amount"), expenditureDate: day(row.expenditureDate, "expenditureDate"),
    payee: text(row.payee, "payee"), purpose: optionalText(row.purpose, "purpose"),
  };
}

function parseEntry(value: unknown): WestVirginiaOutsideDocumentLedgerEntry {
  const row = object(value, "entry");
  const sha256 = text(row.sha256, "sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail("invalid sha256");
  const spenderEntityId = text(row.spenderEntityId, "spenderEntityId");
  if (!/^\d{10}$/.test(spenderEntityId)) fail("invalid spenderEntityId");
  const reviewStatus = row.reviewStatus;
  if (reviewStatus !== "accepted" && reviewStatus !== "review" && reviewStatus !== "rejected") fail("invalid reviewStatus");
  const category = row.category;
  if (category !== "independent_expenditure" && category !== "electioneering_communication") fail("invalid category");
  if (!Array.isArray(row.expenditures)) fail("expenditures is not an array");
  const reviewNote = optionalText(row.reviewNote, "reviewNote");
  if (reviewStatus !== "accepted" && reviewNote === null) fail("non-accepted entries need a reviewNote");
  return {
    documentID: integer(row.documentID, "documentID", 1), orgID: integer(row.orgID, "orgID", 1),
    spenderEntityId, spenderName: text(row.spenderName, "spenderName"), sha256,
    receivedDate: day(row.receivedDate, "receivedDate"), category, reviewStatus, reviewNote,
    reviewedAt: day(row.reviewedAt, "reviewedAt"),
    expenditures: row.expenditures.map((item, position) => parseExpenditure(item, position + 1)),
  };
}

export function parseWestVirginiaOutsideDocumentLedger(value: unknown): WestVirginiaOutsideDocumentLedger {
  const body = object(value, "ledger");
  if (body.version !== 1 || body.scope !== WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_SCOPE) fail("unsupported ledger version or scope");
  if (!Array.isArray(body.entries)) fail("entries is not an array");
  const entries = body.entries.map(parseEntry);
  const ids = new Set(entries.map((entry) => entry.documentID));
  if (ids.size !== entries.length) fail("duplicate documentID");
  return { version: 1, scope: WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_SCOPE, entries };
}

export async function readWestVirginiaOutsideDocumentLedger(input?: { path?: string }): Promise<WestVirginiaOutsideDocumentLedger> {
  const path = resolve(input?.path ?? (process.env.WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_PATH?.trim() || DEFAULT_WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_PATH));
  return parseWestVirginiaOutsideDocumentLedger(JSON.parse(await readFile(path, "utf8")));
}

/** Every ledger entry must describe a document the inventory still holds, byte-identical. */
export function assertWestVirginiaOutsideLedgerMatchesInventory(
  ledger: WestVirginiaOutsideDocumentLedger,
  inventory: WestVirginiaOutsideDocumentInventory
): { unreviewedDocumentIds: number[] } {
  const byId = new Map(inventory.documents.map((document) => [document.documentID, document]));
  for (const entry of ledger.entries) {
    const document = byId.get(entry.documentID);
    if (!document) fail(`document ${entry.documentID} is not in the inventory`);
    if (document.sha256 !== entry.sha256 || document.orgID !== entry.orgID || document.entityId !== entry.spenderEntityId) {
      fail(`document ${entry.documentID} identity changed since review`);
    }
  }
  const reviewed = new Set(ledger.entries.map((entry) => entry.documentID));
  return { unreviewedDocumentIds: inventory.documents.map((d) => d.documentID).filter((id) => !reviewed.has(id)).sort((a, b) => a - b) };
}

export type WestVirginiaDocumentOutsideGroup = {
  committeeId: string;
  committeeName: string;
  supportOppose: "support" | "oppose";
  amount: number;
  sourceUrl: string | null;
};

export type WestVirginiaDocumentOutsideSpendingResult = {
  groups: WestVirginiaDocumentOutsideGroup[];
  provenance: WestVirginiaDocumentIeProvenance[];
  supportTotal: number;
  opposeTotal: number;
  includedCount: number;
  excludedCount: number;
};

/** Accepted ledger expenditures aimed at one roster candidate inside the cycle window. */
export function aggregateWestVirginiaDocumentOutsideSpending(input: {
  candidateNameNormalized: string;
  officeName: string;
  district: string | null | undefined;
  window: { windowStart: string; windowEnd: string };
  ledger: WestVirginiaOutsideDocumentLedger;
  sourceUrl?: string | null;
}): WestVirginiaDocumentOutsideSpendingResult {
  const districtNumber = /^\d+$/.test((input.district ?? "").trim()) ? Number(input.district)
    : westVirginiaDistrictNumberFromDistrictName(input.district);
  const start = day(input.window.windowStart, "windowStart");
  const end = day(input.window.windowEnd, "windowEnd");
  if (start > end) fail("window start after end");
  const groups = new Map<string, { group: WestVirginiaDocumentOutsideGroup; cents: number }>();
  const provenance: WestVirginiaDocumentIeProvenance[] = [];
  let excludedCount = 0;
  const sourceUrl = input.sourceUrl ?? "https://cfrs.wvsos.gov/";
  for (const entry of input.ledger.entries) {
    if (entry.reviewStatus !== "accepted") { excludedCount += entry.expenditures.length; continue; }
    for (const expenditure of entry.expenditures) {
      if (expenditure.targetRosterName !== input.candidateNameNormalized ||
          expenditure.targetOffice === null || WEST_VIRGINIA_OUTSIDE_LINK_OFFICE_BY_TARGET[expenditure.targetOffice] !== input.officeName ||
          districtNumber === null || expenditure.targetDistrict !== districtNumber ||
          expenditure.expenditureDate < start || expenditure.expenditureDate > end) {
        excludedCount += 1; continue;
      }
      const cents = Math.round(expenditure.amount * 100);
      provenance.push({
        kind: "document", documentID: entry.documentID, orgID: entry.orgID, spenderEntityId: entry.spenderEntityId,
        sha256: entry.sha256, expenditureIndex: expenditure.index, category: entry.category,
        expenditureDate: expenditure.expenditureDate, amount: cents / 100, supportOppose: expenditure.stance,
        targetRosterName: expenditure.targetRosterName, receivedDate: entry.receivedDate,
      });
      const key = `${entry.spenderEntityId}\0${expenditure.stance}`;
      const current = groups.get(key) ?? {
        cents: 0,
        group: { committeeId: entry.spenderEntityId, committeeName: entry.spenderName, supportOppose: expenditure.stance, amount: 0, sourceUrl },
      };
      if (current.group.committeeName !== entry.spenderName) fail(`spender ${entry.spenderEntityId} name differs across entries`);
      current.cents += cents;
      if (!Number.isSafeInteger(current.cents)) fail("amount overflow");
      groups.set(key, current);
    }
  }
  const output = [...groups.values()].map(({ group, cents }) => ({ ...group, amount: cents / 100 }))
    .sort((a, b) => b.amount - a.amount || a.committeeId.localeCompare(b.committeeId) || a.supportOppose.localeCompare(b.supportOppose));
  const total = (stance: "support" | "oppose") =>
    [...groups.values()].filter((g) => g.group.supportOppose === stance).reduce((sum, g) => sum + g.cents, 0) / 100;
  return { groups: output, provenance, supportTotal: total("support"), opposeTotal: total("oppose"), includedCount: provenance.length, excludedCount };
}

export function isWestVirginiaDocumentIeProvenance(value: unknown): value is WestVirginiaDocumentIeProvenance {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "document";
}

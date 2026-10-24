import { describe, expect, it } from "vitest";
import {
  aggregateWestVirginiaDocumentOutsideSpending,
  assertWestVirginiaOutsideLedgerMatchesInventory,
  parseWestVirginiaOutsideDocumentLedger,
  WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_SCOPE,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaOutsideDocumentLedger.js";
import { parseWestVirginiaOutsideDocumentInventory } from "../../../src/pipeline/westVirginiaFinance/westVirginiaOutsideDocumentInventory.js";
import { validateWestVirginiaPreviouslyPublishedIe } from "../../../src/pipeline/westVirginiaFinance/westVirginiaElectronicOutsideSpendingPersistenceGuard.js";

const sha = "a".repeat(64);
const expenditure = {
  index: 1, targetName: "Robert Fluharty", targetRosterName: "ROBERT FLUHARTY", targetOffice: "House of Delegates", targetDistrict: 12,
  stance: "oppose", amount: 4000, expenditureDate: "2026-05-07", payee: "Mainstream Consulting, LLC", purpose: "Direct mail",
};
const entry = {
  documentID: 10001, orgID: 3981, spenderEntityId: "1040003981", spenderName: "Citizens for Better Communities", sha256: sha,
  receivedDate: "2026-05-08", category: "independent_expenditure", reviewStatus: "accepted", reviewNote: null, reviewedAt: "2026-10-23",
  expenditures: [expenditure],
};
const ledger = { version: 1, scope: WEST_VIRGINIA_OUTSIDE_DOCUMENT_LEDGER_SCOPE, entries: [entry] };
const inventoryDocument = {
  orgID: 3981, entityId: "1040003981", orgName: "Citizens for Better Communities", orgTypeCode: "104", orgStatus: "Active",
  documentID: 10001, documentName: "Independent Expenditure Report", documentType: "Independent Expenditure Report",
  receivedDate: "05/08/2026 10:00:00", receivedYear: 2026, s3DocName: "prd/Docs/3981/x.pdf", filePath: "outside-documents/3981/10001.pdf", bytes: 1200, sha256: sha,
};
const inventory = {
  version: 1, scope: "registered_iec_ecc_ie_documents", years: [2026], registrySha256: sha, downloadedAt: "2026-10-23T00:00:00.000Z",
  committees: [{ orgID: 3981, entityId: "1040003981", orgName: "Citizens for Better Communities", orgTypeCode: "104", orgStatus: "Active", documentCount: 3, ieDocumentCount: 1 }],
  documents: [inventoryDocument],
};
const window = { windowStart: "2025-07-01", windowEnd: "2026-12-31" };
const target = { candidateNameNormalized: "ROBERT FLUHARTY", officeName: "State Lower Chamber Legislator", district: "Delegate District 12 (2024); West Virginia", window };

describe("WV outside document ledger", () => {
  it("parses a valid ledger and rejects malformed entries", () => {
    expect(parseWestVirginiaOutsideDocumentLedger(ledger).entries).toHaveLength(1);
    expect(() => parseWestVirginiaOutsideDocumentLedger({ ...ledger, entries: [entry, entry] })).toThrow("duplicate documentID");
    expect(() => parseWestVirginiaOutsideDocumentLedger({ ...ledger, entries: [{ ...entry, reviewStatus: "review", reviewNote: null }] })).toThrow("reviewNote");
    expect(() => parseWestVirginiaOutsideDocumentLedger({ ...ledger, entries: [{ ...entry, expenditures: [{ ...expenditure, targetRosterName: "Robert Fluharty" }] }] })).toThrow("storage form");
    expect(() => parseWestVirginiaOutsideDocumentLedger({ ...ledger, entries: [{ ...entry, expenditures: [{ ...expenditure, amount: 4000.001 }] }] })).toThrow("cent amount");
    expect(() => parseWestVirginiaOutsideDocumentLedger({ ...ledger, entries: [{ ...entry, expenditures: [{ ...expenditure, index: 2 }] }] })).toThrow("out of order");
    expect(() => parseWestVirginiaOutsideDocumentLedger({ ...ledger, entries: [{ ...entry, expenditures: [{ ...expenditure, targetDistrict: null }] }] })).toThrow("requires office and district");
  });

  it("pins every reviewed document to the inventory's bytes", () => {
    const parsed = parseWestVirginiaOutsideDocumentLedger(ledger);
    const inv = parseWestVirginiaOutsideDocumentInventory(inventory);
    expect(assertWestVirginiaOutsideLedgerMatchesInventory(parsed, inv).unreviewedDocumentIds).toEqual([]);
    expect(() => assertWestVirginiaOutsideLedgerMatchesInventory(parsed, { ...inv, documents: [{ ...inventoryDocument, sha256: "b".repeat(64) }] })).toThrow("identity changed");
    expect(() => assertWestVirginiaOutsideLedgerMatchesInventory(parsed, { ...inv, documents: [] })).toThrow("not in the inventory");
    expect(assertWestVirginiaOutsideLedgerMatchesInventory({ ...parsed, entries: [] }, inv).unreviewedDocumentIds).toEqual([10001]);
  });

  it("aggregates accepted expenditures for the exact roster target inside the window", () => {
    const parsed = parseWestVirginiaOutsideDocumentLedger(ledger);
    const result = aggregateWestVirginiaDocumentOutsideSpending({ ...target, ledger: parsed });
    expect(result.opposeTotal).toBe(4000);
    expect(result.supportTotal).toBe(0);
    expect(result.groups).toEqual([{ committeeId: "1040003981", committeeName: "Citizens for Better Communities", supportOppose: "oppose", amount: 4000, sourceUrl: "https://cfrs.wvsos.gov/" }]);
    expect(result.provenance[0]).toMatchObject({ kind: "document", documentID: 10001, expenditureIndex: 1, sha256: sha });
    // Wrong district, wrong office, other name, out of window, or not accepted: excluded.
    expect(aggregateWestVirginiaDocumentOutsideSpending({ ...target, ledger: parsed, district: "Delegate District 13 (2024); West Virginia" }).includedCount).toBe(0);
    expect(aggregateWestVirginiaDocumentOutsideSpending({ ...target, ledger: parsed, officeName: "State Senator" }).includedCount).toBe(0);
    expect(aggregateWestVirginiaDocumentOutsideSpending({ ...target, ledger: parsed, candidateNameNormalized: "ROBERT FLUHARTY JR" }).includedCount).toBe(0);
    expect(aggregateWestVirginiaDocumentOutsideSpending({ ...target, ledger: parsed, window: { windowStart: "2026-06-01", windowEnd: "2026-12-31" } }).includedCount).toBe(0);
    const reviewOnly = parseWestVirginiaOutsideDocumentLedger({ ...ledger, entries: [{ ...entry, reviewStatus: "review", reviewNote: "illegible amount" }] });
    expect(aggregateWestVirginiaDocumentOutsideSpending({ ...target, ledger: reviewOnly }).includedCount).toBe(0);
  });

  it("guards previously published document rows alongside electronic rows", () => {
    const parsed = parseWestVirginiaOutsideDocumentLedger(ledger);
    const { provenance } = aggregateWestVirginiaDocumentOutsideSpending({ ...target, ledger: parsed });
    const stored = { committee_id: "1040003981", support_oppose: "oppose", source_transactions: provenance };
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [stored], currentProvenance: [], currentDocumentProvenance: provenance })).not.toThrow();
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [stored], currentProvenance: [], currentDocumentProvenance: [] })).toThrow("disappeared without an explicit ledger review decision");
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [stored], currentProvenance: [], currentDocumentProvenance: [], explicitlyUnpublishedDocumentIds: new Set([10001]) })).not.toThrow();
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [stored], currentProvenance: [], currentDocumentProvenance: [{ ...provenance[0]!, amount: 1 }] })).toThrow("changed amount");
  });
});

describe("committed WV outside document ledger", () => {
  it("parses and only publishes accepted entries with roster targets in storage form", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const raw = JSON.parse(await readFile(resolve(process.cwd(), "evidence/west-virginia-finance/outside-document-ledger.json"), "utf8"));
    const parsed = parseWestVirginiaOutsideDocumentLedger(raw);
    expect(parsed.entries.length).toBeGreaterThan(300);
    const accepted = parsed.entries.filter((entry) => entry.reviewStatus === "accepted");
    expect(accepted.length).toBeGreaterThan(300);
    for (const entry of parsed.entries) {
      if (entry.reviewStatus !== "accepted") expect(entry.reviewNote).toBeTruthy();
    }
  });
});

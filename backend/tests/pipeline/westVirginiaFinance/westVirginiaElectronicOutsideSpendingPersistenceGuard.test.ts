import { describe, expect, it } from "vitest";
import { validateWestVirginiaPreviouslyPublishedIe } from "../../../src/pipeline/westVirginiaFinance/westVirginiaElectronicOutsideSpendingPersistenceGuard.js";
const row = { transactionID: 562631, spenderEntityId: "1040002875", orgID: 2875, reportID: 32245,
  reportVersionID: 2, reportFileName: "2026 1st Quarter Report", filedDate: "2026-04-29",
  transactionDate: "2026-02-06", amount: 897.1, supportOppose: "support" as const,
  targetEntityId: "1010003582", documentBarCode: "F5BA3496AFAF45AE",
  s3ReportFilePath: "prd/Reports/2875/current.pdf" };
const group = { committee_id: row.spenderEntityId, support_oppose: row.supportOppose, source_transactions: [row] };
describe("WV previously published electronic IE preservation", () => {
  it("accepts a new positive, unchanged repeat, or verifiable newer amended amount", () => {
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [], currentProvenance: [row] })).not.toThrow();
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [group], currentProvenance: [row] })).not.toThrow();
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [group],
      currentProvenance: [{ ...row, reportVersionID: 3, amount: 450 }] })).not.toThrow();
  });
  it("rejects disappearing expense even if another spender still has a positive", () => {
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [group], currentProvenance: [
      { ...row, spenderEntityId: "1040003981", transactionID: 999999 },
    ] })).toThrow("independent current-report empty proof required");
  });
  it.each(["amount", "supportOppose", "targetEntityId", "documentBarCode"])("rejects changed %s within a stable report version", (field) => {
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [group],
      currentProvenance: [{ ...row, [field]: field === "amount" ? 100 : "changed" } as typeof row],
    })).toThrow("same report version");
  });
  it("rejects old versions, missing legacy evidence, and mismatched spender identity", () => {
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [group], currentProvenance: [{ ...row, reportVersionID: 1 }] })).toThrow("backwards");
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [{ ...group, source_transactions: null }], currentProvenance: [row] })).toThrow("lacks reviewed");
    expect(() => validateWestVirginiaPreviouslyPublishedIe({ previousGroups: [{ ...group, committee_id: "1040009999" }], currentProvenance: [row] })).toThrow("Invalid stored");
  });
});

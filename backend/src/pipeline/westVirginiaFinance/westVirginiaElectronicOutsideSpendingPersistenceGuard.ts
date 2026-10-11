import type { WestVirginiaElectronicIeProvenance } from "./westVirginiaElectronicOutsideSpendingAggregator.js";
export type WestVirginiaStoredOutsideEvidence = {
  committee_id: string;
  support_oppose: string;
  source_transactions: unknown;
};
/** Disappearing rows require independent empty-report proof, not merely a new version.
 * A stable current version may not silently change its economic or filing identity. */
export function validateWestVirginiaPreviouslyPublishedIe(input: {
  previousGroups: readonly WestVirginiaStoredOutsideEvidence[];
  currentProvenance: readonly WestVirginiaElectronicIeProvenance[];
}): void {
  const key = (row: Pick<WestVirginiaElectronicIeProvenance, "spenderEntityId" | "transactionID" | "reportID">) =>
    JSON.stringify([row.spenderEntityId, row.transactionID, row.reportID]);
  const current = new Map(input.currentProvenance.map((row) => [key(row), row]));
  for (const group of input.previousGroups) {
    if (!Array.isArray(group.source_transactions) || group.source_transactions.length === 0) {
      throw new Error("Stored West Virginia outside spending lacks reviewed transaction provenance");
    }
    for (const value of group.source_transactions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored West Virginia IE provenance");
      const prior = value as WestVirginiaElectronicIeProvenance;
      if (prior.spenderEntityId !== group.committee_id || prior.supportOppose !== group.support_oppose ||
          !Number.isSafeInteger(prior.transactionID) || prior.transactionID <= 0 ||
          !Number.isSafeInteger(prior.reportID) || prior.reportID <= 0 ||
          !Number.isSafeInteger(prior.reportVersionID) || prior.reportVersionID <= 0) {
        throw new Error("Invalid stored West Virginia IE provenance");
      }
      const row = current.get(key(prior));
      if (!row) throw new Error("Previously published West Virginia IE transaction disappeared; independent current-report empty proof required");
      if (row.reportVersionID < prior.reportVersionID) throw new Error("West Virginia IE source version moved backwards");
      if (row.reportVersionID === prior.reportVersionID) {
        for (const field of ["reportFileName", "filedDate", "transactionDate", "amount", "supportOppose", "targetEntityId", "documentBarCode", "s3ReportFilePath"] as const) {
          if (row[field] !== prior[field]) throw new Error("West Virginia IE transaction changed within the same report version");
        }
      }
    }
  }
}

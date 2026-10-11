// Positive-only electronic regular-report IE. No database or completeness
// claim: unknown/empty results have no summary and must preserve stored IE.
import {
  normalizeWestVirginiaCandidateNameForStorage,
  resolveWestVirginiaCandidateCommittee,
  westVirginiaRegistryElectionLabel,
} from "./westVirginiaCandidateCommitteeResolver.js";
import {
  westVirginiaDistrictNumberFromDistrictName,
  westVirginiaRegistryOfficeForRace,
} from "./westVirginiaFinanceEligibleOffices.js";
import type {
  WestVirginiaCommitteeRow,
  WestVirginiaCurrentFilingRow,
  WestVirginiaTransactionRow,
} from "./westVirginiaCfrsClient.js";
import type { WestVirginiaCycleWindow } from "./westVirginiaReportingCycleWindows.js";
import { apiAmountToCents } from "./westVirginiaPhaseZero.js";

export const WEST_VIRGINIA_ELECTRONIC_IE_COVERAGE_NOTE =
  "Counts electronically reported independent expenditures from regular CFRS campaign-finance reports. Scanned paper reports and separate rapid IE reports are excluded; these amounts do not represent all outside spending.";

export type WestVirginiaElectronicOutsideGroup = {
  committeeId: string;
  committeeName: string;
  supportOppose: "support" | "oppose";
  amount: number;
  sourceUrl: string | null;
};

export type WestVirginiaElectronicIeProvenance = {
  transactionID: number;
  spenderEntityId: string;
  orgID: number;
  reportID: number;
  reportVersionID: number;
  reportFileName: string;
  filedDate: string;
  transactionDate: string;
  amount: number;
  supportOppose: "support" | "oppose";
  targetEntityId: string;
  documentBarCode: string;
  s3ReportFilePath: string;
};

export type WestVirginiaElectronicOutsideSpendingInput = {
  candidateName: string;
  entityId: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  window: Pick<WestVirginiaCycleWindow, "windowStart" | "windowEnd">;
  registryRows: readonly WestVirginiaCommitteeRow[];
  transactionRows: readonly WestVirginiaTransactionRow[];
  currentFilingsByOrg: ReadonlyMap<number, readonly WestVirginiaCurrentFilingRow[]>;
};

export type WestVirginiaElectronicOutsideSpendingResult = {
  /** Undefined means preserve outside spending, including an empty harvest. */
  summary?: {
    supportTotal: number;
    opposeTotal: number;
    groups: WestVirginiaElectronicOutsideGroup[];
    sourceUrl: string | null;
  };
  diagnostics: string[];
  includedRowCount: number;
  excludedRowCount: number;
  provenance: WestVirginiaElectronicIeProvenance[];
};

const SPENDER_TYPES: Readonly<Record<string, string>> = {
  "102": "State Political Action Committee",
  "103": "State Political Party Committee / Caucus Campaign Committee",
  "104": "Independent Expenditure Committee",
  "105": "Electioneering Communication Committee",
};
const SOURCE_URL = "https://cfrs.wvsos.gov/";

function text(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

// The source uses Last, First; preserve full given names and suffix evidence.
// Source→registry names are exact, without nickname expansion or fuzzy matching.
function exactPersonKey(value: string | null | undefined): string {
  const name = text(value);
  const parts = name.split(",");
  const natural = parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
  return normalizeWestVirginiaCandidateNameForStorage(natural);
}

function day(value: string | null | undefined): string | null {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.test(date)) return null;
  const parsed = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date.slice(0, 10)
    ? date.slice(0, 10) : null;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sourceVersion(value: string | null): number | null {
  const version = text(value);
  if (!/^[1-9]\d*$/.test(version)) return null;
  const parsed = Number(version);
  return positiveInteger(parsed) ? parsed : null;
}

function validFilePath(path: string | null, orgID: number): path is string {
  if (!path || path.includes("..") || path.includes("?") || path.includes("#")) return false;
  const report = /^prd\/Reports\/(\d+)\/[A-Za-z0-9_-]+\.pdf$/.exec(path);
  return report ? Number(report[1]) === orgID : /^prd\/Legacy\/ReportsOutput\/\d+\/[A-Za-z0-9_-]+\.pdf$/.test(path);
}

export function aggregateWestVirginiaElectronicOutsideSpending(
  input: WestVirginiaElectronicOutsideSpendingInput
): WestVirginiaElectronicOutsideSpendingResult {
  let excludedRowCount = 0;
  const unknown = (diagnostic: string): WestVirginiaElectronicOutsideSpendingResult => ({
    diagnostics: [diagnostic], includedRowCount: 0, excludedRowCount, provenance: [],
  });
  const office = westVirginiaRegistryOfficeForRace({
    officeScope: input.officeScope, officeCanonicalName: input.officeName,
  });
  const district = /^\d+$/.test(text(input.district)) ? Number(input.district)
    : westVirginiaDistrictNumberFromDistrictName(input.district);
  const start = day(input.window.windowStart);
  const end = day(input.window.windowEnd);
  if (!office || district === null || !positiveInteger(district) || !start || !end || start > end ||
      !Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100) {
    return unknown("invalid_target_office_district_or_cycle_window");
  }
  const resolution = resolveWestVirginiaCandidateCommittee({
    candidateName: input.candidateName, electionYear: input.electionYear,
    registryOffice: office, districtNumber: district, committees: input.registryRows,
  });
  if (resolution.status !== "matched" || resolution.entityId !== input.entityId) {
    return unknown("target_link_registry_resolution_missing_or_ambiguous");
  }
  const targetKey = exactPersonKey(resolution.registryCandidateName);
  const targetRows = input.registryRows.filter((row) => row.orgTypeCode === "101" &&
    row.orgType === "State Candidate" && row.election === westVirginiaRegistryElectionLabel(input.electionYear) &&
    exactPersonKey(row.candidateName) === targetKey);
  const targetIdentities = new Set(targetRows.map((row) => `${row.entityId}\0${row.orgID}\0${row.office}\0${row.district}`));
  if (targetIdentities.size !== 1 || targetRows[0]?.office !== office || targetRows[0]?.district !== String(district)) {
    return unknown("target_year_name_not_unique_with_explicit_office_and_district");
  }

  const groups = new Map<string, { row: WestVirginiaElectronicOutsideGroup; cents: number }>();
  const provenance: WestVirginiaElectronicIeProvenance[] = [];
  const seenTransactions = new Map<number, string>();
  const siblingsById = new Map<number, WestVirginiaTransactionRow[]>();
  for (const row of input.transactionRows) {
    if (text(row.transactionTypeDesc) !== "Independent Expenditures") continue;
    const siblings = siblingsById.get(row.transactionID) ?? [];
    siblings.push(row);
    siblingsById.set(row.transactionID, siblings);
  }
  for (const row of input.transactionRows) {
    // Query modes also return ordinary CON/EXP. Do not inspect their outside fields.
    if (text(row.transactionTypeDesc) !== "Independent Expenditures") { excludedRowCount += 1; continue; }
    if (exactPersonKey(row.candidateNameAssocation) !== targetKey) { excludedRowCount += 1; continue; }
    if (!Number.isInteger(row.electionYear) || row.electionYear! < 2000 || row.electionYear! > 2100) {
      return unknown(`missing_or_invalid_target_election_year:${row.transactionID}`);
    }
    if (row.electionYear !== input.electionYear) { excludedRowCount += 1; continue; }
    const transactionDate = day(row.transactionDate);
    if (!transactionDate) return unknown(`invalid_ie_transaction_date:${row.transactionID}`);
    if (transactionDate < start || transactionDate > end) { excludedRowCount += 1; continue; }
    if (!positiveInteger(row.transactionID) || !positiveInteger(row.orgID) || !/^\d{10}$/.test(row.entityID)) {
      return unknown("invalid_ie_source_identity");
    }
    const spenderRows = input.registryRows.filter((item) => item.entityId === row.entityID);
    const spenderIdentities = new Set(spenderRows.map((item) => JSON.stringify([
      item.orgID, item.orgTypeCode, item.orgType, text(item.orgName),
    ])));
    const spender = spenderRows[0];
    if (!spender || spenderIdentities.size !== 1 || spender.orgID !== row.orgID ||
        SPENDER_TYPES[spender.orgTypeCode] !== spender.orgType || text(row.orgType) !== spender.orgType ||
        !text(spender.orgName) || text(row.committeeName) !== text(spender.orgName)) {
      return unknown(`ie_spender_registry_identity_unverified:${row.transactionID}`);
    }
    if (row.entityID === input.entityId) { excludedRowCount += 1; continue; }
    const version = sourceVersion(row.reportVersionID);
    const filedDate = day(row.filedDate);
    if (version === null || !filedDate || !text(row.reportFileName)) {
      return unknown(`missing_ie_report_identity:${row.transactionID}`);
    }
    const manifest = input.currentFilingsByOrg.get(row.orgID);
    if (!manifest) return unknown(`missing_current_filing_manifest:${row.orgID}`);
    const periodMatches = manifest.filter((filing) => filing.orgID === row.orgID && filing.registrantID === row.entityID &&
      text(filing.reportFileName) === text(row.reportFileName) && day(filing.startDate) !== null && day(filing.endDate) !== null &&
      transactionDate >= day(filing.startDate)! && transactionDate <= day(filing.endDate)!);
    // Explicit scope excludes standalone rapid reports; their periodic overlap
    // has no source-proven economic identity in this first phase.
    if (periodMatches.length === 1 && periodMatches[0]!.reportFormType === "Independent Expenditure Report") {
      excludedRowCount += 1; continue;
    }
    if (periodMatches.length !== 1) return unknown(`current_report_name_period_missing_or_ambiguous:${row.transactionID}`);
    const filing = periodMatches[0]!;
    if (filing.reportFormType !== "Campaign Financial Statement" || !positiveInteger(filing.reportID) ||
        !positiveInteger(filing.reportVersionID) || (filing.reportStatus !== "Original" && filing.reportStatus !== "Amended") ||
        !/^[A-Za-z0-9]+$/.test(filing.documentBarCode)) {
      return unknown(`unsupported_or_invalid_current_report:${row.transactionID}`);
    }
    if (version < filing.reportVersionID) { excludedRowCount += 1; continue; }
    if (version !== filing.reportVersionID || day(filing.filedDate) !== filedDate) {
      return unknown(`ie_row_not_current_report_version_or_file_date:${row.transactionID}`);
    }
    // A source transaction ID is global. A second current row for another
    // beneficiary cannot be allocated by copying the full amount to both.
    const rawEconomicKey = (item: WestVirginiaTransactionRow) => JSON.stringify([
      item.entityID, item.orgID, item.transactionAmount, day(item.transactionDate), item.electionYear,
      exactPersonKey(item.candidateNameAssocation), text(item.stanceDescription).toLowerCase(),
      text(item.reportFileName), sourceVersion(item.reportVersionID), day(item.filedDate),
      item.s3ReportFilePath, text(item.transactionCategoryDesc), text(item.orgType),
      text(item.contributorPayeeName), text(item.transactionPurpose), text(item.ballotMeasureDescription),
    ]);
    for (const sibling of siblingsById.get(row.transactionID) ?? []) {
      if (sibling.transactionID !== row.transactionID || text(sibling.transactionTypeDesc) !== "Independent Expenditures") continue;
      const siblingVersion = sourceVersion(sibling.reportVersionID);
      if (sibling.orgID === row.orgID && sibling.entityID === row.entityID &&
          text(sibling.reportFileName) === text(row.reportFileName) && siblingVersion !== null &&
          siblingVersion < filing.reportVersionID) continue;
      if (rawEconomicKey(sibling) !== rawEconomicKey(row)) return unknown(`conflicting_ie_transaction_id:${row.transactionID}`);
    }
    if (!validFilePath(row.s3ReportFilePath, row.orgID)) return unknown(`unverified_ie_report_file:${row.transactionID}`);
    if (text(row.ballotMeasureDescription)) return unknown(`candidate_and_ballot_target_requires_review:${row.transactionID}`);
    const stance = text(row.stanceDescription).toLowerCase();
    if (stance !== "support" && stance !== "oppose") return unknown(`missing_ie_support_oppose:${row.transactionID}`);
    if (text(row.transactionCategoryDesc) !== "Monetary") return unknown(`unsupported_ie_category:${row.transactionID}`);
    let cents: number;
    try { cents = apiAmountToCents(row.transactionAmount); } catch { return unknown(`invalid_ie_amount:${row.transactionID}`); }
    if (!positiveInteger(cents)) return unknown(`nonpositive_ie_amount_requires_review:${row.transactionID}`);
    const evidence: WestVirginiaElectronicIeProvenance = {
      transactionID: row.transactionID, spenderEntityId: row.entityID, orgID: row.orgID,
      reportID: filing.reportID, reportVersionID: filing.reportVersionID, reportFileName: filing.reportFileName,
      filedDate, transactionDate, amount: cents / 100, supportOppose: stance,
      targetEntityId: input.entityId, documentBarCode: filing.documentBarCode, s3ReportFilePath: row.s3ReportFilePath,
    };
    const identity = JSON.stringify([evidence, text(row.contributorPayeeName), text(row.transactionPurpose)]);
    const previous = seenTransactions.get(row.transactionID);
    if (previous !== undefined) {
      if (previous !== identity) return unknown(`conflicting_ie_transaction_id:${row.transactionID}`);
      excludedRowCount += 1; continue;
    }
    seenTransactions.set(row.transactionID, identity);
    provenance.push(evidence);
    const groupKey = `${row.entityID}\0${stance}`;
    const group = groups.get(groupKey) ?? {
      cents: 0, row: { committeeId: row.entityID, committeeName: text(spender.orgName),
        supportOppose: stance, amount: 0, sourceUrl: SOURCE_URL },
    };
    group.cents += cents;
    if (!Number.isSafeInteger(group.cents)) return unknown("ie_amount_total_overflow");
    groups.set(groupKey, group);
  }
  if (provenance.length === 0) return unknown("no_accepted_electronic_ie_rows_zero_requires_independent_current_report_proof");
  const outputGroups = [...groups.values()].map(({ row, cents }) => ({ ...row, amount: cents / 100 }))
    .sort((left, right) => right.amount - left.amount || left.committeeId.localeCompare(right.committeeId) ||
      left.supportOppose.localeCompare(right.supportOppose));
  const total = (stance: "support" | "oppose") => [...groups.values()]
    .filter((group) => group.row.supportOppose === stance).reduce((sum, group) => sum + group.cents, 0);
  const supportCents = total("support");
  const opposeCents = total("oppose");
  if (!Number.isSafeInteger(supportCents) || !Number.isSafeInteger(opposeCents)) return unknown("ie_amount_total_overflow");
  return {
    summary: { supportTotal: supportCents / 100, opposeTotal: opposeCents / 100, groups: outputGroups, sourceUrl: SOURCE_URL },
    diagnostics: [], includedRowCount: provenance.length, excludedRowCount, provenance,
  };
}

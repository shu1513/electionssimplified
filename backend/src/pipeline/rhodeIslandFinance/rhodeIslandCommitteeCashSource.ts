import { createHash } from "node:crypto";
import { aggregateRhodeIslandCommitteeCash, riCommitteeCashCheck as check } from "./rhodeIslandCommitteeCashAggregator.js";
import { resolveRhodeIslandCandidateCommitteeRows } from "./rhodeIslandCandidateCommitteeResolver.js";
import { aggregateRhodeIslandOrganizationCycleFinance } from "./rhodeIslandDirectContributionAggregator.js";
import { selectErtsCycleCf2Filings, ertsPdfGuidFromUrl } from "./rhodeIslandErtsArtifactAcquisition.js";
import { readErtsArtifact, ertsArtifactRelativePath, type ErtsArtifactKey, type ErtsArtifactManifest } from "./rhodeIslandErtsArtifactCache.js";
import { isErtsPortalUrl, ertsContributionReportUrl, ertsExpenditureReportUrl } from "./rhodeIslandErtsClient.js";
import {
  classifyErtsSearchResult, parseErtsContributionExport, parseErtsFilingListPage,
  parseErtsFilingVersionsPage, parseErtsOrganizationSearchPage, parseErtsSummaryGroupings,
  ERTS_CONTRIBUTION_RESULT_GRID_ID, ERTS_CONTRIBUTION_SUMMARY_GRID_ID,
} from "./rhodeIslandErtsParsers.js";

/** The initial manual mapping requires independent office/ballot/registration
 * review. The native name-only registry search cannot establish that mapping.
 * The source loader rechecks the reported account and current filing evidence.
 */
export type RhodeIslandCashContext = Readonly<{
  candidateId: string; electionId: string; electionYear: number;
  candidateName: string; officeScope: string; officeName: string; district: string | null;
  committeeId: string; committeeName: string; searchLastName: string;
}>;
export type RhodeIslandCashPacket = Readonly<{
  context: RhodeIslandCashContext;
  observedAt: string;
  sourceDigest: string;
  sourceUrl: string;
  coverageThrough: string;
  reportCount: number;
  receivingRows: number;
  totalCents: number;
  selectedOccurrences: number;
  donors: readonly Readonly<{ key: string; name: string; sourceClass: "PAC" | "Party"; amountCents: number; contributionCount: number }>[];
  summary: Readonly<{ totalReceipts: number; directContributionTotal: number; totalDisbursements: number; cashOnHand: number; sourceUrl: string }> | null;
  directBreakdowns: readonly Readonly<{ categoryType: "contribution_size"; categoryName: string; amount: number; contributorCount: number; sourceUrl: string | null }>[];
}>;
const accepted = new WeakSet<object>();
export function assertRhodeIslandCashPacket(packet: RhodeIslandCashPacket): void {
  check(accepted.has(packet), "unverified_packet");
}
const us = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
function normalizedUrl(raw: string): string {
  const url = new URL(raw); url.searchParams.sort(); return url.href;
}

/** No network and no caller-supplied aggregates. All mutable artifacts must
 * belong to one ordinary acquisition vintage. Immutable GUID PDFs may be
 * older only when the current version list still selects those exact bytes.
 * Recheck every whole artifact after legacy reconciliation to reject a cache
 * replacement during loading. Financial writes accept only these frozen packets.
 */
export async function loadRhodeIslandCashPacket(context: RhodeIslandCashContext, cacheDir: string): Promise<RhodeIslandCashPacket> {
  context = Object.freeze({ ...context });
  check(context.electionYear === 2026 && /^\d+$/.test(context.committeeId) && context.committeeName.trim() && context.searchLastName.trim(), "receiving_context");
  const start = `${context.electionYear - 1}-01-01`, end = `${context.electionYear}-12-31`;
  const seen = new Map<string, { key: ErtsArtifactKey; manifest: ErtsArtifactManifest }>();
  let observedAt: string | null = null;
  async function read(key: ErtsArtifactKey, expectedUrl?: string): Promise<string> {
    const artifact = await readErtsArtifact({ cacheDir, key });
    const m = artifact.manifest;
    check(isErtsPortalUrl(m.url) && m.source?.organizationName === context.committeeName, "artifact_receiving_identity");
    if (expectedUrl) check(normalizedUrl(m.url) === normalizedUrl(expectedUrl), "artifact_source_scope");
    if (key.type !== "filing_pdf") {
      const at = Date.parse(m.retrievedAt), now = Date.now();
      check(Number.isFinite(at) && at <= now && now - at <= 24 * 60 * 60 * 1000, "source_freshness");
      if (observedAt === null) observedAt = m.retrievedAt;
      check(observedAt === m.retrievedAt, "mixed_acquisition_vintages");
    }
    seen.set(ertsArtifactRelativePath(key), { key, manifest: m });
    return key.type === "filing_pdf" ? "" : new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
  }
  const search = parseErtsOrganizationSearchPage(await read({ type: "organization_search", query: context.searchLastName }));
  const match = resolveRhodeIslandCandidateCommitteeRows({ candidateName: context.candidateName,
    officeScope: context.officeScope, officeName: context.officeName, searchRows: search.rows, searchHasMorePages: search.hasMorePages });
  check(match.status === "matched" && match.match.organizationName === context.committeeName, "reported_receiving_account");
  const filings = parseErtsFilingListPage(await read({ type: "organization_filings", orgId: context.committeeId }));
  const selected = selectErtsCycleCf2Filings({ rows: filings, cycleBeginIso: start, cycleEndIso: end });
  check(selected.selected.length > 0 && selected.unusablePeriodRowCount === 0, "current_cf2_inventory");
  const snapshots = new Map<string, { pdfUrl: string; rows: ReturnType<typeof parseErtsContributionExport>; groupings: Map<string, number> }>();
  for (const filing of selected.selected) {
    const filingId = filing.filingId!;
    const versions = parseErtsFilingVersionsPage(await read({ type: "filing_versions", filingId }));
    const latest = versions[versions.length - 1]; check(latest, "current_cf2_version");
    await read({ type: "filing_pdf", filingId, guid: ertsPdfGuidFromUrl(latest.pdfUrl) }, latest.pdfUrl);
    const beginIso = `${filing.periodBegin.slice(6)}-${filing.periodBegin.slice(0, 2)}-${filing.periodBegin.slice(3, 5)}`;
    const endIso = `${filing.periodEnd.slice(6)}-${filing.periodEnd.slice(0, 2)}-${filing.periodEnd.slice(3, 5)}`;
    const window = { orgId: context.committeeId, beginIso, endIso };
    const report = await read({ type: "contribution_report", ...window }, ertsContributionReportUrl({ orgId: context.committeeId, begin: us(beginIso), end: us(endIso) }));
    const classification = classifyErtsSearchResult(report, ERTS_CONTRIBUTION_RESULT_GRID_ID);
    check(classification !== "unreadable", "receiving_report_unreadable");
    const rows = classification === "rows" ? parseErtsContributionExport(await read({ type: "contribution_export", ...window })) : [];
    const groupings = classification === "rows" ? parseErtsSummaryGroupings(report, ERTS_CONTRIBUTION_SUMMARY_GRID_ID) : new Map<string, number>();
    await read({ type: "expenditure_report", ...window }, ertsExpenditureReportUrl({ orgId: context.committeeId, begin: us(beginIso), end: us(endIso) }));
    check(!snapshots.has(filingId), "duplicate_current_cf2"); snapshots.set(filingId, { pdfUrl: latest.pdfUrl, rows, groupings });
  }
  const finance = await aggregateRhodeIslandOrganizationCycleFinance({ cacheDir, orgId: context.committeeId, cycleBeginIso: start, cycleEndIso: end });
  // PAC/Party gross receipts have their own complete export and CF-2 line
  // controls below. A discrepancy in other cash totals withholds direct
  // finance; it cannot erase independently reconciled committee receipts.
  // Invalid CF-2 periods and every other legacy quarantine still hold all.
  check(finance.cf2Selection.periods.length === snapshots.size &&
    finance.cf2Selection.quarantineReasons.length === 0 &&
    finance.quarantineReasons.every(reason => reason.reason === "cf2_reconciliation_mismatch"), "legacy_finance_reconciliation");
  for (const { key, manifest } of seen.values()) {
    const current = await readErtsArtifact({ cacheDir, key });
    check(current.manifest.sha256 === manifest.sha256 && current.manifest.retrievedAt === manifest.retrievedAt &&
      current.manifest.url === manifest.url && current.manifest.source?.organizationName === context.committeeName, "cache_changed_during_load");
  }
  const periods = finance.cf2Selection.periods;
  for (let i = 1; i < periods.length; i++) check(periods[i]!.beginningCashCents === periods[i - 1]!.endingCashCents, "cash_carry_forward");
  const cash = aggregateRhodeIslandCommitteeCash({ electionYear: context.electionYear, observedDay: observedAt!.slice(0, 10),
    periods: periods.map(p => {
      const source = snapshots.get(p.filingId); check(source && source.pdfUrl === p.pdfUrl, "current_cf2_changed");
      return { beginIso: p.beginIso, endIso: p.endIso, groupings: source.groupings,
        cf2PacCents: p.values.get("4. Political Action Committees")!, cf2PartyCents: p.values.get("3. Political Parties")! };
    }), rows: [...snapshots.values()].flatMap(p => p.rows) });
  const sourceDigest = createHash("sha256").update(JSON.stringify([...seen].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, { manifest }]) => [path, manifest.sha256]))).digest("hex");
  const packet: RhodeIslandCashPacket = Object.freeze({ context, observedAt: observedAt!, sourceDigest,
    sourceUrl: finance.summary?.sourceUrl ?? ertsContributionReportUrl({ orgId: context.committeeId, begin: us(start), end: us(end) }), coverageThrough: cash.coverageThrough, reportCount: periods.length,
    receivingRows: cash.receivingRows, totalCents: cash.totalCents, selectedOccurrences: cash.selectedOccurrences,
    donors: Object.freeze(cash.donors.map(d => Object.freeze({ ...d }))), summary: finance.publishable && finance.summary ? Object.freeze({ ...finance.summary }) : null,
    directBreakdowns: Object.freeze((finance.publishable ? finance.directBreakdowns : []).map(d => Object.freeze({ ...d }))) });
  accepted.add(packet); return packet;
}

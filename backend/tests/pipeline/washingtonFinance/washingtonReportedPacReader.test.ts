import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWashingtonPacSourceProducer } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacCache.js";
import { aggregateWashingtonPacRows } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacSource.js";
import { washingtonPacFacts } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacWriter.js";
import { overlayWashingtonReportedPacReceipts } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacReader.js";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { fixture, guid, receipt, scope } from "./washingtonReportedPacFixtures.js";
const receiver = { link_id: guid(1), candidate_id: guid(2), election_id: guid(3), election_year: 2026,
  filer_id: scope.filerId, committee_id: scope.committeeId, candidacy_id: "2000", link_source: "pdc_api",
  candidate_name: "Synthetic Candidate", full_name: "Synthetic Candidate", office_scope: "state_lower",
  office_name: "State Lower Chamber Legislator", district: "1", district_name: "Legislative District 1",
  ballot_title: null, election_date: "2026-11-03" };
const candidates = [{ candidate_id: guid(2), election_id: guid(3) }], elections = [{ election_id: guid(3), state: "WA" }], key = candidateElectionKey(guid(2), guid(3));
let dir: string, row: Record<string, unknown>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wa-pac-reader-")); vi.stubEnv("WASHINGTON_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("WASHINGTON_REPORTED_PAC_RECEIPTS_ENABLED", "true");
  const f = fixture(); f.state.rows = Array.from({ length: 40 }, (_, i) => receipt(String(i + 1), `Synthetic PAC ${i}`, "10.00"));
  const p = (await createWashingtonPacSourceProducer({ cacheDir: dir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(scope))!;
  const { groups, ...a } = aggregateWashingtonPacRows(p.rows);
  row = { ...receiver, pac_source: { link_id: guid(1), election_year: 2026, candidate_id: guid(2), election_id: guid(3),
    receiving_filer_id: scope.filerId, receiving_committee_id: scope.committeeId, total_cents: a.totalCents, group_count: groups.length,
    source_row_count: a.sourceRowCount, source_facts: washingtonPacFacts(p), aggregation_controls: a,
    source_retrieved_at: p.sourceRetrievedAt, source_completed_at: p.sourceCompletedAt, source_manifest_sha256: p.sourceManifestSha256,
    source_byte_size: p.sourceByteSize, last_synced_at: new Date().toISOString() }, pac_groups: groups.map(g => ({ link_id: guid(1), election_year: 2026,
    reported_name: g.name, reported_name_key: g.key, amount_cents: g.cents, source_row_count: g.rowCount })) };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const dbFor = (rows: unknown[]) => ({ query: vi.fn(async () => ({ rows })) }) as unknown as Pool;
describe("Washington production PAC reader", () => {
  it("keeps full forty-group totals and unsorted count before five named details", async () => {
    const map = await overlayWashingtonReportedPacReceipts(dbFor([row]), new Map(), candidates, elections), summary = map.get(key)!;
    expect(summary.direct_campaign.pac_money_by_interest).toMatchObject([{ interest: "unclassified", interest_name: "Not yet sorted", amount: 400, pac_count: 40 }]);
    expect(summary.direct_campaign.pac_money_by_interest![0]!.pacs).toHaveLength(5);
    expect(summary.direct_campaign.total_raised).toBeNull(); expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("Separate expenditure refunds are excluded");
    expect(summary.direct_campaign.pac_money_basis).toBe("reported_committee_itemized_contributions");
  });
  it("preserves fundraising, IE and their headline clock when adding the component", async () => {
    const summary = (await overlayWashingtonReportedPacReceipts(dbFor([row]), new Map(), candidates, elections)).get(key)!;
    delete summary.direct_campaign.pac_money_by_interest; delete summary.direct_campaign.pac_money_basis; delete summary.direct_campaign.pac_money_coverage_note;
    summary.direct_campaign.total_raised = 999; summary.outside_spending.support_total = 55; summary.last_synced_at = "2026-10-01T00:00:00.000Z";
    const before = structuredClone(summary), map = new Map<string, BallotLookupFinanceSummary>([[key, summary]]);
    await overlayWashingtonReportedPacReceipts(dbFor([row]), map, candidates, elections);
    expect(map.get(key)!.last_synced_at).toBe(before.last_synced_at); expect(map.get(key)!.direct_campaign.total_raised).toBe(999);
    expect(map.get(key)!.outside_spending).toEqual(before.outside_spending);
  });
  it("does no new-table queries when either gate is off", async () => {
    for (const flag of ["WASHINGTON_CAMPAIGN_FINANCE_ENABLED", "WASHINGTON_REPORTED_PAC_RECEIPTS_ENABLED"]) {
      vi.stubEnv(flag, "false"); const db = dbFor([row]);
      expect((await overlayWashingtonReportedPacReceipts(db, new Map(), candidates, elections)).size).toBe(0); expect(db.query).not.toHaveBeenCalled(); vi.stubEnv(flag, "true");
    }
  });
  it("holds a truncated uncapped group set, ambiguous source and retargeted registration", async () => {
    const groups = row.pac_groups as unknown[];
    for (const rows of [[{ ...row, pac_groups: groups.slice(0, 5) }], [row, row], [{ ...row, committee_id: "3000" }]])
      expect((await overlayWashingtonReportedPacReceipts(dbFor(rows), new Map(), candidates, elections)).size).toBe(0);
  });
});

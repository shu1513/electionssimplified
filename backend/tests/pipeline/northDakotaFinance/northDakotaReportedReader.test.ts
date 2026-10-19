import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../src/pipeline/northDakotaFinance/northDakotaReportedStore.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/pipeline/northDakotaFinance/northDakotaReportedStore.js")>(), listNorthDakotaReportedReceivers: h.list }));
import { acquireNorthDakotaReportedPacket, type NorthDakotaReportedPacket } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedSource.js";
import { aggregateNorthDakotaReported, northDakotaReportedSourceFacts } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedStore.js";
import { attachNorthDakotaReportedFinance, readStoredNorthDakotaReportedComponent } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedReader.js";
import { ndReportedTestReceiver as receiver, northDakotaReportedCommitteeFixture, northDakotaReportedIeFixture } from "./northDakotaReportedFixture.js";
import type { BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";

let cacheDir: string, committee: NorthDakotaReportedPacket, ie: NorthDakotaReportedPacket;
beforeEach(async () => {
  for (const name of ["NORTH_DAKOTA_CAMPAIGN_FINANCE_ENABLED", "NORTH_DAKOTA_CFRS_RAW_DATA_REFRESH_ENABLED", "NORTH_DAKOTA_REPORTED_COMMITTEE_RECEIPTS_ENABLED", "NORTH_DAKOTA_INDEPENDENT_IE_ENABLED"]) vi.stubEnv(name, "true");
  cacheDir = await mkdtemp(resolve(tmpdir(), "nd-reader-"));
  committee = await acquireNorthDakotaReportedPacket("committee", { cacheDir, clientOptions: northDakotaReportedCommitteeFixture() });
  ie = await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: northDakotaReportedIeFixture() }); h.list.mockResolvedValue([receiver]);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(cacheDir, { recursive: true, force: true }); });
function stored(source: NorthDakotaReportedPacket) {
  const { groups, ...controls } = aggregateNorthDakotaReported(receiver, source);
  return {
    row: { link_id: receiver.linkId, election_year: 2026, component: source.kind, candidate_id: receiver.candidateId, election_id: receiver.electionId, receiver_context: receiver,
      source_facts: northDakotaReportedSourceFacts(source), source_observed_at: source.sourceAt, last_synced_at: source.sourceAt, aggregation_controls: controls },
    groups: groups.map(g => ({ link_id: receiver.linkId, election_year: 2026, component: source.kind, group_key: g.key, reported_name: g.name, source_class: g.sourceClass, stance: g.stance, amount_cents: String(g.cents), occurrence_count: g.occurrences })),
  };
}
const key = candidateElectionKey(receiver.candidateId, receiver.electionId);
function legacy(): BallotLookupFinanceSummary { return {
  source: "NORTH_DAKOTA_CFRS", cycle: 2026, fec_candidate_id: null, controlled_committee_id: receiver.entityId, last_synced_at: "2026-10-01T00:00:00.000Z",
  direct_campaign: { total_raised: 4242, total_spent: null, cash_on_hand: null, debts_owed: null, top_occupations: [], top_employers: [], top_industries: [], contribution_size_buckets: [] },
  outside_spending: { support_total: 99, oppose_total: 0, top_supporting_groups: [], top_opposing_groups: [], top_supporting_industries: [], top_opposing_industries: [] },
  backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] },
}; }
async function attach(sources: ReturnType<typeof stored>[]) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("nd_reported_finance_components") ? sources.map(s => s.row) : sources.flatMap(s => s.groups) }));
  const result = await attachNorthDakotaReportedFinance({ db: { query } as unknown as Pool, requests: [{ candidate_id: receiver.candidateId, election_id: receiver.electionId }], summaries: new Map([[key, legacy()]]) });
  return { summary: result.get(key)!, query };
}
describe("North Dakota component reader", () => {
  it("checks stored scope, facts, money and original source clocks", () => {
    const s = stored(ie); expect(readStoredNorthDakotaReportedComponent(s.row, s.groups, receiver).supportCents).toBe(10000);
    expect(() => readStoredNorthDakotaReportedComponent({ ...s.row, candidate_id: receiver.electionId }, s.groups, receiver)).toThrow(/receiver_context/);
    expect(() => readStoredNorthDakotaReportedComponent({ ...s.row, source_observed_at: "2026-01-01" }, s.groups, receiver)).toThrow(/source_clock/);
    expect(() => readStoredNorthDakotaReportedComponent(s.row, [{ ...s.groups[0]!, amount_cents: "100.5" }], receiver)).toThrow(/integer/);
  });
  it("adds both card components while preserving legacy campaign totals and headline clock", async () => {
    const { summary } = await attach([stored(committee), stored(ie)]);
    expect(summary.direct_campaign.total_raised).toBe(4242); expect(summary.last_synced_at).toBe(legacy().last_synced_at);
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ amount: 100, pac_count: 1 });
    expect(summary.outside_spending.support_total).toBe(100);
    expect(summary.outside_spending.outside_coverage_note).toContain(ie.sourceAt.slice(0, 10));
  });
  it("closes every group before capping five displayed names", async () => {
    const s = stored(committee), first = s.groups[0]!;
    s.groups = Array.from({ length: 7 }, (_, n) => ({ ...first, group_key: JSON.stringify(["Committee/PAC", `EXAMPLE PAC ${n}`]), reported_name: `Example PAC ${n}` }));
    s.row.aggregation_controls = { ...s.row.aggregation_controls, totalCents: 70000, sourceRows: 7, includedRows: 7 };
    s.row.source_facts = { ...s.row.source_facts, sourceRows: 7, sourceCents: 70000 };
    const { summary, query } = await attach([s]);
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ amount: 700, pac_count: 7 });
    expect(summary.direct_campaign.pac_money_by_interest?.[0]!.pacs).toHaveLength(5);
    expect(query.mock.calls.every(([sql]) => !sql.includes("LIMIT"))).toBe(true);
    s.groups.pop(); const held = await attach([s, stored(ie)]);
    expect(held.summary.direct_campaign.pac_money_by_interest).toBeUndefined(); expect(held.summary.outside_spending.support_total).toBe(100);
  });
  it("retains prior outside values when the new IE component is inconsistent", async () => {
    const s = stored(ie); s.groups[0]!.amount_cents = "-1";
    const { summary } = await attach([stored(committee), s]);
    expect(summary.outside_spending.support_total).toBe(99); expect(summary.outside_spending.outside_coverage_note).toContain("acquisition date is unavailable");
    expect(summary.direct_campaign.pac_money_by_interest?.[0]!.amount).toBe(100);
  });
  it("keeps unsorted reported committees visible with coverage limits", async () => {
    const { summary } = await attach([stored(committee)]);
    expect(summary.direct_campaign.pac_money_by_interest?.[0]!.interest_name).toBe("Not yet sorted");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("not net PAC funding");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("Separate expenditure-side returns");
  });
});

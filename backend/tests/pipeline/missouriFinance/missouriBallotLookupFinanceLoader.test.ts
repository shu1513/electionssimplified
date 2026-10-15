import { afterEach, describe, expect, it, vi } from "vitest";

import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { loadMissouriCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/missouriFinance/missouriBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";

afterEach(() => vi.unstubAllEnvs());

describe("missouriBallotLookupFinanceLoader", () => {
  runStateFinanceLoaderCharacterization({
    load: loadMissouriCandidateFinanceSummariesByCandidateElection,
    flagEnvVar: "MISSOURI_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "MO",
    tablePrefix: "mo_candidate_finance",
    source: "MISSOURI_MEC",
    genericSourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/",
    eligibleOffice: { office_scope: "state_lower", office_canonical_name: "State Lower Chamber Legislator" },
    ineligibleOffice: { office_scope: "statewide", office_canonical_name: "United States Senator" },
    directCoverageNote:
      "Totals and donor breakdowns are summed from itemized Missouri Ethics Commission filings and are not reconciled to official report covers.",
    outsideCoverageNote:
      "Registered-committee reported spending only; Missouri non-committee expenditure reports (§ 130.047) are not included.",
    outsideSupportActionLabel:
      "independent spending supporting this candidate; listed contributions are committee-cycle funding, not money earmarked to that spending",
  });
});


const request = { candidate_id: "11111111-1111-4111-8111-111111111111", election_id: "22222222-2222-4222-8222-222222222222" };
const election = { election_id: request.election_id, state: "MO", office_scope: "state_lower",
  office_canonical_name: "State Lower Chamber Legislator" };
function receiptRow(amount: number) {
  const count = amount === 0 ? 0 : 1;
  return { ...request, link_id: "33333333-3333-4333-8333-333333333333", election_year: 2026, committee_id: "C123456", active_link_count: 1,
    source_link_id: "33333333-3333-4333-8333-333333333333", source_year: 2026, receiving_committee_id: "C123456",
    cycle_start: "2026-08-05", cycle_end: "2026-11-03", total_amount_cents: String(amount), group_count: count, receipt_count: count,
    source_row_count: count, in_cycle_row_count: count, outside_cycle_row_count: 0, canonical_row_count: count,
    matched_committee_row_count: count, excluded_noncommittee_row_count: 0, in_kind_row_count: 0, zero_monetary_row_count: 0,
    source_url: "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx",
    source_retrieved_at: "2026-10-12T11:00:00Z", last_synced_at: "2026-10-15T12:00:00Z", source_sha256: "a".repeat(64),
    source_byte_size: "1234", report_inventory_sha256: "b".repeat(64), reported_committee_name: count ? "Example committee" : null,
    reported_name_key: count ? "EXAMPLE COMMITTEE" : null, amount_cents: count ? String(amount) : null, group_receipt_count: count || null };
}
describe("Missouri independent receipt publication", () => {
  it("does not query new tables by default even with raw refresh forced", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect((await loadMissouriCandidateFinanceSummariesByCandidateElection(database, [request], [election])).size).toBe(0);
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(String(database.query.mock.calls[0]?.[0])).not.toContain("committee_receipt");
  });
  it.each([0, 12345])("attaches a qualified %i-cent source-only card through the real loader", async amount => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    const database = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("committee_receipt_sources") ? [receiptRow(amount)] : [] })) };
    const output = await loadMissouriCandidateFinanceSummariesByCandidateElection(database, [request], [election]);
    const summary = output.get(candidateElectionKey(request.candidate_id, request.election_id))!;
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(summary.direct_campaign.pac_money_basis).toBe("reported_committee_monetary_receipts");
    expect(summary.direct_campaign.pac_money_by_interest?.reduce((sum, group) => sum + group.amount, 0)).toBe(amount / 100);
    expect(summary.direct_campaign.total_raised).toBeNull();
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.last_synced_at).toBe("2026-10-12T11:00:00.000Z");
  });
  it("does not query receipt tables for an ineligible office", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    const database = { query: vi.fn() };
    await loadMissouriCandidateFinanceSummariesByCandidateElection(database, [request], [{ ...election,
      office_scope: "statewide", office_canonical_name: "United States Senator" }]);
    expect(database.query).not.toHaveBeenCalled();
  });
});


function registeredIeRow(amount: number) {
  const count=amount===0?0:1;
  return {...receiptRow(amount),basis:"reported_registered_committee_independent_expenditures",qualifying_link_id:"33333333-3333-4333-8333-333333333333",
    link_candidate_id:request.candidate_id,link_election_id:request.election_id,link_election_year:2026,link_committee_id:"C123456",link_status:"active",
    support_amount_cents:String(amount),oppose_amount_cents:"0",expenditure_count:count,source_year:2026,source_row_count:count,source_page_count:1,
    candidate_name_row_count:count,candidate_office_mismatch_row_count:0,outside_cycle_row_count:0,matched_row_count:count,zero_amount_row_count:0,
    negative_amount_row_count:0,ambiguous_lineage_row_count:0,timely_overlap_row_count:0,
    source_url:"https://www.mec.mo.gov/MEC/Campaign_Finance/CF_SearchDirExp.aspx",
    reported_committee_id:null,support_oppose:count?"support":null,group_expenditure_count:count||null};
}
describe("Missouri independent registered IE publication",()=>{
  it("keeps new IE queries off by default even with raw refresh enabled",async()=>{
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED","");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED","");vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED","true");
    const database={query:vi.fn().mockResolvedValue({rows:[]})};
    await loadMissouriCandidateFinanceSummariesByCandidateElection(database,[request],[election]);
    expect(database.query).toHaveBeenCalledTimes(1);expect(String(database.query.mock.calls[0]?.[0])).not.toContain("registered_ie");
  });
  it.each([0,12345])("attaches a genuine %i-cent registered IE source-only card through the loader",async amount=>{
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED","true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED","");
    const database={query:vi.fn(async(sql:string)=>({rows:sql.includes("registered_ie_sources")?[registeredIeRow(amount)]:[]}))};
    const output=await loadMissouriCandidateFinanceSummariesByCandidateElection(database,[request],[election]);
    const summary=output.get(candidateElectionKey(request.candidate_id,request.election_id))!;
    expect(database.query).toHaveBeenCalledTimes(2);expect(summary.outside_spending.support_total).toBe(amount/100);
    expect(summary.outside_spending.oppose_total).toBe(0);expect(summary.direct_campaign.total_raised).toBeNull();
    expect(summary.last_synced_at).toBe("2026-10-12T11:00:00.000Z");
    expect(summary.outside_spending.outside_coverage_note).toContain("CF14");
  });
  it("composes IE with independent reported cash without changing its observation age",async()=>{
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED","true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED","true");
    const ie={...registeredIeRow(25000),source_retrieved_at:"2026-10-14T11:00:00Z"};
    const database={query:vi.fn(async(sql:string)=>({rows:sql.includes("registered_ie_sources")?[ie]:sql.includes("committee_receipt_sources")?[receiptRow(12345)]:[]}))};
    const output=await loadMissouriCandidateFinanceSummariesByCandidateElection(database,[request],[election]);
    const summary=output.get(candidateElectionKey(request.candidate_id,request.election_id))!;
    expect(database.query).toHaveBeenCalledTimes(3);expect(summary.direct_campaign.pac_money_basis).toBe("reported_committee_monetary_receipts");
    expect(summary.direct_campaign.pac_money_by_interest?.[0]?.amount).toBe(123.45);
    expect(summary.outside_spending.support_total).toBe(250);expect(summary.last_synced_at).toBe("2026-10-12T11:00:00.000Z");
    expect(summary.outside_spending.outside_coverage_note).toContain("2026-10-14");
  });
});

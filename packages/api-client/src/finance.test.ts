import { describe, expect, it } from "vitest";

import {
  firstFinanceSourceUrl,
  hasFinanceContent,
  hasMemberCommunications,
  hasOutsideFinanceContent,
  shouldShowDirectCoverageNote,
  spendingExceedsCycleFunds,
} from "./finance";
import type { FinanceSummary } from "./types";

function emptySummary(): FinanceSummary {
  return {
    source: "NEW_YORK_CITY_CFB",
    cycle: 2025,
    last_synced_at: "2025-01-01T00:00:00Z",
    direct_campaign: {
      total_raised: null,
      total_spent: null,
      cash_on_hand: null,
      debts_owed: null,
      top_occupations: [],
      top_industries: [],
    },
    outside_spending: {
      support_total: null,
      oppose_total: null,
      top_supporting_groups: [],
      top_opposing_groups: [],
      top_supporting_industries: [],
      top_opposing_industries: [],
    },
  };
}

describe("NYC finance shared fields", () => {
  it("treats explicit zero public funds as content", () => {
    const summary = emptySummary();
    summary.direct_campaign.public_funds_received = 0;
    expect(hasFinanceContent(summary)).toBe(true);
  });

  it("treats positive loans as content, but not zero or absent loans", () => {
    const loansOnly = emptySummary();
    loansOnly.direct_campaign.loans_received = 30_752_614;
    expect(hasFinanceContent(loansOnly)).toBe(true);

    const zeroLoans = emptySummary();
    zeroLoans.direct_campaign.loans_received = 0;
    expect(hasFinanceContent(zeroLoans)).toBe(false);

    expect(hasFinanceContent(emptySummary())).toBe(false);
  });

  it("finds source URLs in employer breakdowns even though they no longer count as content", () => {
    const summary = emptySummary();
    summary.direct_campaign.top_employers = [
      { category_name: "NYC DOE", amount: 1, contributor_count: 1, source_url: "https://www.nyccfb.info/" },
    ];
    // Employers aren't rendered anymore, so alone they don't make the card show…
    expect(hasFinanceContent(summary)).toBe(false);
    // …but their rows still serve as a provenance-link fallback.
    expect(firstFinanceSourceUrl(summary)).toBe("https://www.nyccfb.info/");
  });

  it("counts direct industries when they are the source's only usable donor classification", () => {
    const summary = emptySummary();
    summary.direct_campaign.top_industries = [
      { category_name: "healthcare", amount: 100, contributor_count: 2, source_url: null },
    ];
    expect(hasFinanceContent(summary)).toBe(true);
  });
});

describe("finance source provenance and coverage notes", () => {
  it("falls back to the Missouri disclosure portal when a zero snapshot has no breakdown URLs", () => {
    const summary = emptySummary();
    summary.source = "MISSOURI_MEC";
    expect(firstFinanceSourceUrl(summary)).toBe("https://www.mec.mo.gov/MEC/Campaign_Finance/");
  });

  it("falls back to the New Hampshire portal when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "NEW_HAMPSHIRE_CFS";
    expect(firstFinanceSourceUrl(summary)).toBe("https://cfs.sos.nh.gov/");
  });

  it("falls back to the Idaho Sunshine portal when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "IDAHO_SUNSHINE";
    expect(firstFinanceSourceUrl(summary)).toBe("https://sunshine.voteidaho.gov/");
  });

  it("falls back to the Kansas viewer entry page when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "KANSAS_SOS";
    expect(firstFinanceSourceUrl(summary)).toBe("https://sos.ks.gov/elections/cfr_viewer/cfr_examiner_entry.aspx");
  });

  it("falls back to the Alabama FCPA portal when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "ALABAMA_FCPA";
    expect(firstFinanceSourceUrl(summary)).toBe("https://fcpa.alabamavotes.gov/");
  });

  it("falls back to the Arkansas CFIS home page when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "ARKANSAS_CFIS";
    expect(firstFinanceSourceUrl(summary)).toBe("https://ethics-disclosures.sos.arkansas.gov/");
  });

  it("falls back to the West Virginia CFRS home page when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "WEST_VIRGINIA_CFRS";
    expect(firstFinanceSourceUrl(summary)).toBe("https://cfrs.wvsos.gov/");
  });

  it("falls back to the North Dakota CFRS home page when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "NORTH_DAKOTA_CFRS";
    expect(firstFinanceSourceUrl(summary)).toBe("https://cfrs.sos.nd.gov/");
  });

  it("falls back to the Montana COPP home page when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "MONTANA_COPP";
    expect(firstFinanceSourceUrl(summary)).toBe("https://politicalpractices.mt.gov/");
  });

  it("falls back to the Nevada AURORA portal when no breakdown URL exists", () => {
    const summary = emptySummary();
    summary.source = "NEVADA_AURORA";
    expect(firstFinanceSourceUrl(summary)).toBe(
      "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx"
    );
  });

  it("shows Missouri's totals note for disclosed zeroes without changing breakdown-only notes", () => {
    const missouri = emptySummary();
    missouri.source = "MISSOURI_MEC";
    missouri.direct_campaign.total_raised = 0;
    missouri.direct_campaign.total_spent = 0;
    missouri.direct_campaign.direct_coverage_note = "Missouri itemized totals note";
    expect(shouldShowDirectCoverageNote(missouri)).toBe(true);

    const breakdownOnly = emptySummary();
    breakdownOnly.direct_campaign.total_raised = 0;
    breakdownOnly.direct_campaign.direct_coverage_note = "Breakdown-only note";
    expect(shouldShowDirectCoverageNote(breakdownOnly)).toBe(false);
    breakdownOnly.direct_campaign.top_occupations = [
      { category_name: "Teacher", amount: 10, contributor_count: 1, source_url: null },
    ];
    expect(shouldShowDirectCoverageNote(breakdownOnly)).toBe(true);

    breakdownOnly.direct_campaign.top_occupations = [];
    breakdownOnly.direct_campaign.top_industries = [
      { category_name: "education", amount: 10, contributor_count: 1, source_url: null },
    ];
    expect(shouldShowDirectCoverageNote(breakdownOnly)).toBe(true);
  });
});

describe("outside spending direction gating", () => {
  it("a disclosed $0 total with nothing behind it is not content", () => {
    const summary = emptySummary();
    summary.outside_spending.support_total = 0;
    summary.outside_spending.oppose_total = 0;
    expect(hasOutsideFinanceContent(summary)).toBe(false);
    expect(hasFinanceContent(summary)).toBe(false);
  });

  it("a positive total, a group, or an industry each count", () => {
    const withTotal = emptySummary();
    withTotal.outside_spending.oppose_total = 1;
    expect(hasOutsideFinanceContent(withTotal)).toBe(true);

    const withGroup = emptySummary();
    withGroup.outside_spending.support_total = 0;
    withGroup.outside_spending.top_supporting_groups = [
      { committee_id: "C1", committee_name: "Growth PAC", support_oppose: "support", amount: 5, source_url: null },
    ];
    expect(hasOutsideFinanceContent(withGroup)).toBe(true);

    const withIndustry = emptySummary();
    withIndustry.outside_spending.oppose_total = 0;
    withIndustry.outside_spending.top_opposing_industries = [
      { category_name: "technology", amount: 5, contributor_count: null, source_url: null },
    ];
    expect(hasOutsideFinanceContent(withIndustry)).toBe(true);
  });

  it("treats unallocated candidate evidence as content and exposes its source", () => {
    const summary = emptySummary();
    summary.outside_spending.unallocated_candidate_edges = [
      {
        filing_id: "ms-ie-2025-10-28",
        report_date: "2025-10-28",
        committee_id: "improve-mississippi-pac",
        committee_name: "Improve Mississippi PAC",
        support_oppose: "support",
        source_url:
          "https://cfportal.sos.ms.gov/online/ExecuteWorkflow.aspx?FilingId=ms-ie-2025-10-28",
      },
    ];

    expect(hasOutsideFinanceContent(summary)).toBe(true);
    expect(hasFinanceContent(summary)).toBe(true);
    expect(firstFinanceSourceUrl(summary)).toBe(
      "https://cfportal.sos.ms.gov/online/ExecuteWorkflow.aspx?FilingId=ms-ie-2025-10-28"
    );
  });
});

describe("member communications (LA)", () => {
  it("counts as card content on its own, but not as outside-groups content", () => {
    const summary = emptySummary();
    summary.outside_spending.membership_support_total = 203457;
    expect(hasMemberCommunications(summary)).toBe(true);
    expect(hasFinanceContent(summary)).toBe(true);
    // Member communications are legally distinct from independent
    // expenditures; they render as their own section, so they must not
    // trigger the outside-groups section.
    expect(hasOutsideFinanceContent(summary)).toBe(false);
  });

  it("hides on 0 — the LA sync writes 0 for every linked candidate", () => {
    const summary = emptySummary();
    summary.outside_spending.membership_support_total = 0;
    summary.outside_spending.membership_oppose_total = 0;
    expect(hasMemberCommunications(summary)).toBe(false);
    expect(hasFinanceContent(summary)).toBe(false);
  });

  it("an oppose-only disclosure also counts", () => {
    const summary = emptySummary();
    summary.outside_spending.membership_oppose_total = 1200;
    expect(hasMemberCommunications(summary)).toBe(true);
  });
});

describe("spendingExceedsCycleFunds", () => {
  it("is false when raised or spent is unreported", () => {
    const summary = emptySummary();
    summary.direct_campaign.total_spent = 100;
    expect(spendingExceedsCycleFunds(summary)).toBe(false);
  });

  it("is true only when spending tops raised plus public funds", () => {
    const summary = emptySummary();
    summary.direct_campaign.total_raised = 100;
    summary.direct_campaign.total_spent = 250;
    expect(spendingExceedsCycleFunds(summary)).toBe(true);
    // Public matching money explains the gap, so no note.
    summary.direct_campaign.public_funds_received = 200;
    expect(spendingExceedsCycleFunds(summary)).toBe(false);
  });

  it("is false when spending fits within money raised this cycle", () => {
    const summary = emptySummary();
    summary.direct_campaign.total_raised = 100;
    summary.direct_campaign.total_spent = 100;
    expect(spendingExceedsCycleFunds(summary)).toBe(false);
  });

  it("counts reported loans as visible funding for the gap note", () => {
    // The self-funder shape: tiny donations, huge spending, huge loans. The
    // Loans stat on the card already explains the gap, so no note.
    const summary = emptySummary();
    summary.direct_campaign.total_raised = 28_700;
    summary.direct_campaign.total_spent = 20_000_000;
    summary.direct_campaign.loans_received = 30_752_614;
    expect(spendingExceedsCycleFunds(summary)).toBe(false);
    // Spending beyond even the visible loans is unexplained again.
    summary.direct_campaign.total_spent = 31_000_000;
    expect(spendingExceedsCycleFunds(summary)).toBe(true);
  });
});

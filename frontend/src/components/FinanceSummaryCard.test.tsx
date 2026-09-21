import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FinanceSummaryCard, hasFinanceContent } from "./FinanceSummaryCard";
import { financeSummary, emptyFinanceSummary } from "../test/fixtures";

describe("hasFinanceContent", () => {
  it("is false for null and for a summary with only null money and empty lists", () => {
    expect(hasFinanceContent(null)).toBe(false);
    expect(hasFinanceContent(emptyFinanceSummary())).toBe(false);
  });

  it("treats an explicit $0 as content — 0 is a disclosure, null is absence", () => {
    const summary = emptyFinanceSummary();
    summary.direct_campaign.total_raised = 0;
    expect(hasFinanceContent(summary)).toBe(true);
  });

  it("is true when only a breakdown list is populated", () => {
    const summary = emptyFinanceSummary();
    summary.outside_spending.top_supporting_industries = [
      { category_name: "technology", amount: 100, contributor_count: null, source_url: null },
    ];
    expect(hasFinanceContent(summary)).toBe(true);
  });

  it("does not count employer rows because the card does not render them", () => {
    const summary = emptyFinanceSummary();
    summary.direct_campaign.top_employers = [
      { category_name: "NYC DOE", amount: 1, contributor_count: 1, source_url: null },
    ];
    expect(hasFinanceContent(summary)).toBe(false);
  });

  it("counts direct industries when occupations are unavailable", () => {
    const summary = emptyFinanceSummary();
    summary.direct_campaign.top_industries = [
      { category_name: "technology", amount: 1, contributor_count: 1, source_url: null },
    ];
    expect(hasFinanceContent(summary)).toBe(true);
  });
});

describe("FinanceSummaryCard", () => {
  it("renders money, occupations, outside spending, the updated date, and the source line", () => {
    const summary = financeSummary();
    summary.direct_campaign.public_funds_received = null;
    render(<FinanceSummaryCard summary={summary} />);

    // Freshness is surfaced up top, not buried in the footer.
    expect(screen.getByText("Data last updated July 1, 2026")).toBeInTheDocument();

    const raisedLabel = screen.getByText("Raised");
    expect(raisedLabel).toBeInTheDocument();
    expect(raisedLabel.closest("dl")).toHaveClass("sm:grid-cols-4");
    expect(raisedLabel.closest("dl")).not.toHaveClass("sm:grid-cols-5");
    expect(screen.queryByText("Public funds")).not.toBeInTheDocument();
    expect(screen.getByText("$120,000")).toBeInTheDocument();
    expect(screen.getByText("Top disclosed occupations of direct donors")).toBeInTheDocument();
    expect(screen.getByText("Retired")).toBeInTheDocument();
    // Employers stay hidden; direct industries do not duplicate occupations.
    expect(screen.queryByText("Top disclosed employers of direct donors")).not.toBeInTheDocument();
    expect(screen.queryByText("Industries represented among direct contributions")).not.toBeInTheDocument();
    expect(screen.queryByText("Oil, gas, and energy")).not.toBeInTheDocument();
    // Support and opposition stay distinct, with a plain-language intro. The
    // independence claim attaches to the spending, not the groups: PACs can
    // also give directly; the expenditure shown here doesn't.
    expect(screen.getByText("Spending by outside groups")).toBeInTheDocument();
    expect(
      screen.getByText(/Outside groups, such as PACs and super PACs, spend this money on the race/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The candidate's campaign does not spend it/)
    ).toBeInTheDocument();
    expect(
      screen.getByText("Outside groups spent $50,000 to support this candidate.")
    ).toBeInTheDocument();
    expect(screen.getByText("Growth PAC")).toBeInTheDocument();
    expect(
      screen.getByText("Outside groups spent $20,000 to oppose this candidate.")
    ).toBeInTheDocument();
    expect(screen.getByText("Stop Them PAC")).toBeInTheDocument();
    // Backing evidence names the organizations behind a supporting industry.
    // The fixture rows are employer-type: individuals who reported those
    // employers gave — the sentence must not read as the companies donating.
    expect(screen.getByText("Technology")).toBeInTheDocument();
    expect(
      screen.getByText("Money from contributors employed by Google and Anthropic, given to Growth PAC.")
    ).toBeInTheDocument();
    // Industry money flows into the groups, not necessarily onto this race —
    // the heading and note must not present it as candidate-specific spend.
    expect(screen.getByText("Donations to groups supporting this candidate, by donor industry")).toBeInTheDocument();
    expect(screen.getByText("Donations to groups opposing this candidate, by donor industry")).toBeInTheDocument();
    expect(
      screen.getByText("Industry amounts are donations to these groups, sorted by each donor's industry. They are not what the groups spent on this candidate.")
    ).toBeInTheDocument();
    // Source enum renders as a display label with the provenance link; the
    // sync date lives at the top of the card now.
    expect(screen.getByText(/Source: FEC · 2026 cycle/)).toBeInTheDocument();
    expect(screen.queryByText(/synced/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "fec.gov" })).toHaveAttribute(
      "href",
      "https://www.fec.gov/data/candidate/H0AK00001/"
    );
  });

  it("renders direct industries as the fallback when occupations are unavailable", () => {
    const summary = emptyFinanceSummary();
    summary.source = "NEW_HAMPSHIRE_CFS";
    summary.direct_campaign.direct_coverage_note =
      "Industries are derived from disclosed contributor employers.";
    summary.direct_campaign.top_industries = [
      { category_name: "healthcare", amount: 75.5, contributor_count: 2, source_url: null },
    ];

    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.queryByText("Top disclosed occupations of direct donors")).not.toBeInTheDocument();
    expect(screen.getByText("Industries represented among direct contributions")).toBeInTheDocument();
    expect(screen.getByText("Healthcare")).toBeInTheDocument();
    expect(screen.getByText(summary.direct_campaign.direct_coverage_note)).toBeInTheDocument();
  });

  it("renders the Montana source label, coverage notes, and COPP provenance fallback", () => {
    const summary = emptyFinanceSummary();
    summary.source = "MONTANA_COPP";
    summary.direct_campaign.total_raised = 66517.57;
    summary.direct_campaign.direct_coverage_note =
      "Totals are summed from itemized Montana CERS filings and cross-checked across the state's disclosure surfaces; where consecutive reports exist they are verified against the official cash-balance chain, which also supplies derived unitemized small-donor amounts.";
    summary.direct_campaign.top_occupations = [
      { category_name: "Retired", amount: 20000, contributor_count: 42, source_url: null },
    ];
    // The Phase 2b hard gate: Montana outside data ships with this footnote.
    summary.outside_spending.support_total = 1234.56;
    summary.outside_spending.outside_coverage_note =
      "Counts only independent expenditures whose disclosed target could be verified; many Montana filings name no verifiable candidate and are excluded. Montana support totals can include spending that benefits a candidate by opposing an opponent; opposition is shown only where the filer declared it.";
    summary.outside_spending.top_supporting_groups = [
      { committee_id: "100", committee_name: "Good PAC", support_oppose: "support", amount: 1234.56, source_url: null },
    ];

    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText(/Source: Montana Commissioner of Political Practices/)).toBeInTheDocument();
    expect(screen.getByText(summary.direct_campaign.direct_coverage_note)).toBeInTheDocument();
    expect(screen.getByText(summary.outside_spending.outside_coverage_note)).toBeInTheDocument();
    expect(screen.getByText(/Outside groups spent .* to support this candidate/)).toBeInTheDocument();
    // No row carries a source URL, so the footer link falls back to the COPP
    // home page (CERS deep links are POST/session driven).
    expect(screen.getByRole("link", { name: "politicalpractices.mt.gov" })).toHaveAttribute(
      "href",
      "https://politicalpractices.mt.gov/"
    );
  });

  it("renders Missouri occupations, coverage notes, and source provenance", () => {
    const summary = financeSummary();
    summary.source = "MISSOURI_MEC";
    summary.direct_campaign.direct_coverage_note =
      "Totals and donor breakdowns are summed from itemized Missouri Ethics Commission filings and are not reconciled to official report covers.";
    summary.outside_spending.outside_coverage_note =
      "Registered-committee reported spending only; Missouri non-committee expenditure reports (§ 130.047) are not included.";
    summary.direct_campaign.top_occupations[0]!.source_url =
      "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx";
    summary.direct_campaign.top_industries[0]!.source_url = null;

    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText("Top disclosed occupations of direct donors")).toBeInTheDocument();
    expect(screen.getByText("Retired")).toBeInTheDocument();
    expect(screen.getByText(summary.direct_campaign.direct_coverage_note)).toBeInTheDocument();
    expect(screen.getByText(summary.outside_spending.outside_coverage_note)).toBeInTheDocument();
    expect(screen.getByText(/Source: Missouri Ethics Commission · 2026 cycle/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "mec.mo.gov" })).toHaveAttribute(
      "href",
      "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx"
    );
  });

  it("renders the real zero-data Missouri shape with its totals caveat and portal link", () => {
    const summary = emptyFinanceSummary();
    summary.source = "MISSOURI_MEC";
    summary.direct_campaign.total_raised = 0;
    summary.direct_campaign.total_spent = 0;
    summary.outside_spending.support_total = 0;
    summary.outside_spending.oppose_total = 0;
    summary.direct_campaign.direct_coverage_note =
      "Totals and donor breakdowns are summed from itemized Missouri Ethics Commission filings and are not reconciled to official report covers.";
    summary.outside_spending.outside_coverage_note =
      "Registered-committee reported spending only; Missouri non-committee expenditure reports (§ 130.047) are not included.";

    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getAllByText("$0")).toHaveLength(2);
    expect(screen.getByText(summary.direct_campaign.direct_coverage_note)).toBeInTheDocument();
    expect(screen.queryByText(summary.outside_spending.outside_coverage_note)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "mec.mo.gov" })).toHaveAttribute(
      "href",
      "https://www.mec.mo.gov/MEC/Campaign_Finance/"
    );
  });

  it("explains prior-cycle money only when spending tops raised plus public funds", () => {
    const summary = financeSummary();
    summary.direct_campaign.total_raised = 40000;
    summary.direct_campaign.total_spent = 90000;
    const { rerender } = render(<FinanceSummaryCard summary={summary} />);
    expect(
      screen.getByText(/money that Raised does not count/)
    ).toBeInTheDocument();

    // Public matching money accounts for the gap — no note.
    const funded = financeSummary();
    funded.direct_campaign.total_raised = 40000;
    funded.direct_campaign.total_spent = 90000;
    funded.direct_campaign.public_funds_received = 60000;
    rerender(<FinanceSummaryCard summary={funded} />);
    expect(
      screen.queryByText(/money that Raised does not count/)
    ).not.toBeInTheDocument();

    // Normal case (fixture raises more than it spends) — no note.
    rerender(<FinanceSummaryCard summary={financeSummary()} />);
    expect(
      screen.queryByText(/money that Raised does not count/)
    ).not.toBeInTheDocument();
  });

  it("shows the outside coverage note only when the source discloses a gap", () => {
    // No note by default: most sources have no known systematic gap, and an
    // unconditional caveat would understate data that is in fact complete.
    const { rerender } = render(<FinanceSummaryCard summary={financeSummary()} />);
    expect(screen.queryByText(/not included yet/)).not.toBeInTheDocument();

    const summary = financeSummary();
    summary.outside_spending.outside_coverage_note =
      "Covers outside spending reported by committees registered with the Ohio Secretary of State. " +
      "Groups that spend without registering file separately and are not included yet.";
    rerender(<FinanceSummaryCard summary={summary} />);
    const note = screen.getByText(/Groups that spend without registering/);
    expect(note).toBeInTheDocument();
    // It must sit with the outside data, not down in the source footnote — a
    // reader who sees the claim has to see the caveat.
    const outsideHeading = screen.getByText("Spending by outside groups");
    const supportTotal = screen.getByText(/Outside groups spent .* to support this candidate/);
    expect(
      outsideHeading.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(note.compareDocumentPosition(supportTotal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The note qualifies SHOWN outside data. A summary whose only outside field
    // is the note renders no outside section and no note: with nothing
    // shown the card asserts nothing about outside money, so there is
    // nothing to caveat (same rule that hides a $0 direction). Deliberate —
    // pinned so a future edit doesn't silently change it in either
    // direction.
    const noteOnly = emptyFinanceSummary();
    noteOnly.direct_campaign.total_raised = 100;
    noteOnly.outside_spending.outside_coverage_note = summary.outside_spending.outside_coverage_note;
    rerender(<FinanceSummaryCard summary={noteOnly} />);
    expect(screen.queryByText("Spending by outside groups")).not.toBeInTheDocument();
    expect(screen.queryByText(/Groups that spend without registering/)).not.toBeInTheDocument();
  });

  it("renders filing-backed outside-spending directions without inventing amounts", () => {
    const summary = emptyFinanceSummary();
    summary.source = "MISSISSIPPI_SOS";
    summary.outside_spending.outside_coverage_note =
      "Mississippi Secretary of State filings only; candidate-level amounts were not reported.";
    summary.outside_spending.unallocated_candidate_edges = [
      {
        filing_id: "ms-ie-support-1",
        report_date: "2025-10-28",
        committee_id: "improve-mississippi-pac",
        committee_name: "Improve Mississippi PAC",
        support_oppose: "support",
        source_url: "https://cfportal.sos.ms.gov/online/portal/filing/ms-ie-support-1",
      },
      {
        filing_id: "ms-ie-oppose-1",
        report_date: "2025-10-29",
        committee_id: "mississippi-voters-pac",
        committee_name: "Mississippi Voters PAC",
        support_oppose: "oppose",
        source_url: "https://cfportal.sos.ms.gov/online/portal/filing/ms-ie-oppose-1",
      },
    ];

    expect(hasFinanceContent(summary)).toBe(true);
    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText("Spending by outside groups")).toBeInTheDocument();
    expect(
      screen.getByText("Outside spending with no amount reported for this candidate")
    ).toBeInTheDocument();
    expect(screen.getByText(/do not report how much/)).toBeInTheDocument();
    expect(screen.getByText("Improve Mississippi PAC")).toBeInTheDocument();
    expect(screen.getByText("Mississippi Voters PAC")).toBeInTheDocument();
    expect(
      screen.getByText(/Reported as supporting this candidate · October 28, 2025/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Reported as opposing this candidate · October 29, 2025/)
    ).toBeInTheDocument();
    expect(screen.getByText(/candidate-level amounts were not reported/)).toBeInTheDocument();
    expect(screen.queryByText(/Outside groups spent .* to support/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Outside groups spent .* to oppose/)).not.toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "View filing for Improve Mississippi PAC dated October 28, 2025",
      })
    ).toHaveAttribute(
      "href",
      "https://cfportal.sos.ms.gov/online/portal/filing/ms-ie-support-1"
    );
    expect(
      screen.getByRole("link", {
        name: "View filing for Mississippi Voters PAC dated October 29, 2025",
      })
    ).toHaveAttribute(
      "href",
      "https://cfportal.sos.ms.gov/online/portal/filing/ms-ie-oppose-1"
    );
  });

  it("shows the direct coverage note only with breakdowns to qualify", () => {
    // No note by default: most sources itemize everything the totals count.
    const { rerender } = render(<FinanceSummaryCard summary={financeSummary()} />);
    expect(screen.queryByText(/not shown in the breakdowns/)).not.toBeInTheDocument();

    const summary = financeSummary();
    summary.direct_campaign.direct_coverage_note =
      "Donor breakdowns reflect itemized contributions reported to Georgia's current filing system " +
      "(July 2025 onward). Official totals are cumulative and can include earlier or non-itemized money " +
      "not shown in the breakdowns.";
    rerender(<FinanceSummaryCard summary={summary} />);
    expect(screen.getByText(/not shown in the breakdowns/)).toBeInTheDocument();

    // The note qualifies the BREAKDOWNS. A summary with totals but no
    // occupation/size rows shows no note: under totals alone the card
    // asserts nothing about itemization.
    const noteOnly = emptyFinanceSummary();
    noteOnly.direct_campaign.total_raised = 100;
    noteOnly.direct_campaign.direct_coverage_note = summary.direct_campaign.direct_coverage_note;
    rerender(<FinanceSummaryCard summary={noteOnly} />);
    expect(screen.queryByText(/not shown in the breakdowns/)).not.toBeInTheDocument();
  });

  it("color-codes outside support green and opposition red", () => {
    const summary = financeSummary();
    const { container } = render(<FinanceSummaryCard summary={summary} />);
    const supportBox = screen
      .getByText("Outside groups spent $50,000 to support this candidate.")
      .closest("div");
    const opposeBox = screen
      .getByText("Outside groups spent $20,000 to oppose this candidate.")
      .closest("div");
    expect(supportBox).toHaveClass("bg-green-50");
    expect(opposeBox).toHaveClass("bg-red-50");
    // Exactly one box per direction — the tint marks direction, nothing else.
    expect(container.querySelectorAll(".bg-green-50")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-red-50")).toHaveLength(1);
  });

  it("shows only the top five occupations with no Show more disclosure", () => {
    const summary = emptyFinanceSummary();
    summary.direct_campaign.top_occupations = [
      { category_name: "Retired", amount: 60000, contributor_count: null, source_url: null },
      { category_name: "Attorney", amount: 50000, contributor_count: null, source_url: null },
      { category_name: "Physician", amount: 40000, contributor_count: null, source_url: null },
      { category_name: "Engineer", amount: 30000, contributor_count: null, source_url: null },
      { category_name: "Teacher", amount: 20000, contributor_count: null, source_url: null },
      { category_name: "Homemaker", amount: 10000, contributor_count: null, source_url: null },
    ];
    render(<FinanceSummaryCard summary={summary} />);

    // The fifth row renders in the top list; the sixth is dropped entirely.
    expect(screen.getByText("Teacher")).toBeInTheDocument();
    expect(screen.queryByText("Homemaker")).toBeNull();
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
  });

  it("orders size buckets largest-first regardless of payload order", () => {
    const summary = emptyFinanceSummary();
    summary.direct_campaign.contribution_size_buckets = [
      { category_name: "$1-$99", amount: 10_000, contributor_count: null, source_url: null },
      { category_name: "$5,000+", amount: 40_000, contributor_count: null, source_url: null },
      { category_name: "$1,000-$4,999", amount: 30_000, contributor_count: null, source_url: null },
      { category_name: "$500-$999", amount: 20_000, contributor_count: null, source_url: null },
    ];
    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText("Direct contributions by size")).toBeInTheDocument();
    const labels = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "")
      .filter((text) => text.includes("$"));
    expect(labels[0]).toContain("$5,000+");
    expect(labels[1]).toContain("$1,000-$4,999");
    expect(labels[2]).toContain("$500-$999");
    expect(labels[3]).toContain("$1-$99");
  });

  it("omits the opposition section when that direction has no disclosures", () => {
    const summary = financeSummary();
    summary.outside_spending.oppose_total = null;
    summary.outside_spending.top_opposing_groups = [];
    summary.outside_spending.top_opposing_industries = [];
    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText(/Outside groups spent .* to support/)).toBeInTheDocument();
    expect(screen.queryByText(/Outside groups spent .* to oppose/)).not.toBeInTheDocument();
  });

  it("hides a direction whose disclosed total is $0 with nothing behind it", () => {
    const summary = financeSummary();
    summary.outside_spending.oppose_total = 0;
    summary.outside_spending.top_opposing_groups = [];
    summary.outside_spending.top_opposing_industries = [];
    render(<FinanceSummaryCard summary={summary} />);

    // "$0 opposing this candidate" is noise, not information — the box hides.
    expect(screen.getByText(/Outside groups spent .* to support/)).toBeInTheDocument();
    expect(screen.queryByText(/Outside groups spent .* to oppose/)).not.toBeInTheDocument();
  });

  it("keeps a $0-total direction visible when it has groups, but drops the $0 from the heading", () => {
    const summary = financeSummary();
    summary.outside_spending.oppose_total = 0;
    render(<FinanceSummaryCard summary={summary} />);

    // The fixture's opposing group still discloses spending, so the box stays;
    // a "$0" amount on the heading would contradict the rows beneath it.
    const heading = screen.getByText(/Outside groups spent .* to oppose this candidate/);
    expect(heading).toBeInTheDocument();
    expect(heading.textContent).not.toContain("$0");
    expect(screen.getByText("Stop Them PAC")).toBeInTheDocument();
  });

  it("shows a researched committee label with its source links, and nothing when unlabeled", () => {
    const summary = financeSummary();
    summary.outside_spending.top_supporting_groups = [
      {
        ...summary.outside_spending.top_supporting_groups[0],
        label: "Super PAC funded primarily by real-estate developers",
        label_source_urls: ["https://www.opensecrets.org/pacs/lookup"],
      },
    ];
    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText("Growth PAC")).toBeInTheDocument();
    // The label is a factual claim, so its evidence renders beside it.
    const labelLine = screen.getByText(/Super PAC funded primarily by real-estate developers/);
    expect(labelLine).toBeInTheDocument();
    const sourceLink = screen.getByRole("link", { name: "opensecrets.org" });
    expect(sourceLink).toHaveAttribute("href", "https://www.opensecrets.org/pacs/lookup");
    // The unlabeled opposing group renders its name with no description
    // paragraph and no evidence links.
    const unlabeledItem = screen.getByText("Stop Them PAC").closest("li");
    expect(unlabeledItem).not.toBeNull();
    expect(unlabeledItem?.querySelector("p")).toBeNull();
    expect(unlabeledItem?.querySelector("a")).toBeNull();
  });

  it("keeps donor money direct and pairs each organization with its own committee", () => {
    const summary = financeSummary();
    summary.backing_summary = {
      top_outside_supporting_industries: [
        {
          category_name: "technology",
          amount: 35000,
          contributor_count: null,
          source_url: null,
          supporting_organizations: [
            {
              organization_name: "Google",
              organization_type: "donor",
              amount: 20000,
              contributor_count: null,
              committee_id: "pac-1",
              committee_name: "Growth PAC",
              source_url: null,
            },
            {
              organization_name: "Anthropic",
              organization_type: "employer",
              amount: 15000,
              contributor_count: 2,
              committee_id: "pac-3",
              committee_name: "Future PAC",
              source_url: null,
            },
          ],
        },
      ],
    };
    render(<FinanceSummaryCard summary={summary} />);

    // Two committees, two lines — no flattening Google onto Future PAC, and
    // the employer-type row never reads as Anthropic itself donating.
    expect(screen.getByText("Money from Google, given to Growth PAC.")).toBeInTheDocument();
    expect(
      screen.getByText("Money from contributors employed by Anthropic, given to Future PAC.")
    ).toBeInTheDocument();
  });

  it("falls back to the plain supporting-industries list without backing evidence", () => {
    const summary = financeSummary();
    delete summary.backing_summary;
    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText("Technology")).toBeInTheDocument();
    expect(screen.queryByText(/Money from/)).not.toBeInTheDocument();
  });

  it("renders member communications as its own section, hiding the $0 side", () => {
    const summary = emptyFinanceSummary();
    summary.outside_spending.membership_support_total = 203457;
    summary.outside_spending.membership_oppose_total = 0;
    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText("Member communications")).toBeInTheDocument();
    expect(
      screen.getByText(/spent this money to talk to their own members about this candidate/)
    ).toBeInTheDocument();
    expect(screen.getByText("These organizations spent $203,457 to support this candidate.")).toBeInTheDocument();
    // The $0 oppose side hides (the LA sync writes 0 for every candidate),
    // and member money must not appear under the outside-groups section —
    // it is legally distinct from independent expenditures.
    expect(screen.queryByText(/to oppose this candidate/)).not.toBeInTheDocument();
    expect(screen.queryByText("Spending by outside groups")).not.toBeInTheDocument();
  });

  it("renders no member-communications section when nothing was reported", () => {
    const summary = financeSummary();
    render(<FinanceSummaryCard summary={summary} />);
    expect(screen.queryByText("Member communications")).not.toBeInTheDocument();
  });

  it("renders an explicit $0 raised instead of hiding it", () => {
    const summary = emptyFinanceSummary();
    summary.direct_campaign.total_raised = 0;
    render(<FinanceSummaryCard summary={summary} />);

    expect(screen.getByText("Raised")).toBeInTheDocument();
    expect(screen.getByText("$0")).toBeInTheDocument();
    expect(screen.queryByText("Spent")).not.toBeInTheDocument();
  });

  it("renders a Loans stat with its explainer only when loans are positive", () => {
    // Self-funder: tiny donations, huge loans (the Perry Johnson shape).
    const summary = emptyFinanceSummary();
    summary.source = "MICHIGAN_MITN";
    summary.direct_campaign.total_raised = 28_699.83;
    summary.direct_campaign.loans_received = 30_752_614;
    render(<FinanceSummaryCard summary={summary} />);
    const loansLabel = screen.getByText("Loans");
    expect(loansLabel).toBeInTheDocument();
    expect(loansLabel.closest("dl")).toHaveClass("sm:grid-cols-5");
    expect(screen.getByText("$30,752,614")).toBeInTheDocument();
    expect(screen.getByText(/money the campaign borrowed, often from the candidate/)).toBeInTheDocument();
  });

  it("hides the Loans stat for zero and for sources that do not report loans", () => {
    // Known zero (source covers loans, candidate has none): hidden, no $0 noise.
    const zeroLoans = financeSummary();
    zeroLoans.direct_campaign.loans_received = 0;
    const { rerender } = render(<FinanceSummaryCard summary={zeroLoans} />);
    expect(screen.queryByText("Loans")).not.toBeInTheDocument();
    expect(screen.queryByText(/the campaign borrowed/)).not.toBeInTheDocument();

    // Field absent (source does not report loans): hidden.
    rerender(<FinanceSummaryCard summary={financeSummary()} />);
    expect(screen.queryByText("Loans")).not.toBeInTheDocument();
  });

  it("renders NYC public funds and size buckets", () => {
    const summary = emptyFinanceSummary();
    summary.source = "NEW_YORK_CITY_CFB";
    summary.direct_campaign.public_funds_received = 250_000;
    summary.direct_campaign.contribution_size_buckets = [
      { category_name: "$1-$99", amount: 10_000, contributor_count: 200, source_url: null },
    ];
    render(<FinanceSummaryCard summary={summary} />);
    const publicFundsLabel = screen.getByText("Public funds");
    expect(publicFundsLabel).toBeInTheDocument();
    expect(publicFundsLabel.closest("dl")).toHaveClass("sm:grid-cols-5");
    expect(screen.getByText("$250,000")).toBeInTheDocument();
    expect(screen.getByText("Direct contributions by size")).toBeInTheDocument();
    expect(screen.getByText(/Source: NYC Campaign Finance Board/)).toBeInTheDocument();
  });

  // Made-up groups, one from each side of an issue, so neither is singled out.
  it("lists the groups donations were sent through, each with its description and sources", () => {
    const summary = financeSummary();
    summary.direct_campaign.conduit_donations = [
      {
        committee_id: "C00000021",
        committee_name: "CONDUIT GROUP A PAC",
        amount: 40_000,
        contribution_count: 12,
        source_url: "https://www.fec.gov/data/receipts/?contributor_name=C00000021",
        label: "A group that backs candidates who support stricter gun laws.",
        label_source_urls: ["https://example.org/about-a"],
      },
      {
        committee_id: "C00000022",
        committee_name: "CONDUIT GROUP B PAC",
        amount: 40_000,
        contribution_count: 9,
        source_url: "https://www.fec.gov/data/receipts/?contributor_name=C00000022",
        label: "A group that backs candidates who oppose stricter gun laws.",
        label_source_urls: ["https://example.org/about-b"],
      },
      {
        committee_id: "C00000023",
        committee_name: "UNRESEARCHED GROUP PAC",
        amount: 500,
        contribution_count: 1,
        source_url: null,
      },
    ];
    render(<FinanceSummaryCard summary={summary} />);

    const list = screen.getByText("Donations sent through groups").parentElement as HTMLElement;
    expect(within(list).getByRole("link", { name: "CONDUIT GROUP A PAC" })).toHaveAttribute(
      "href",
      "https://www.fec.gov/data/receipts/?contributor_name=C00000021"
    );
    expect(within(list).getByText(/backs candidates who support stricter gun laws/)).toBeInTheDocument();
    expect(within(list).getByText(/backs candidates who oppose stricter gun laws/)).toBeInTheDocument();
    expect(within(list).getAllByRole("link", { name: "example.org" })).toHaveLength(2);
    expect(within(list).getByText("UNRESEARCHED GROUP PAC")).toBeInTheDocument();
    expect(within(list).getByText("$500")).toBeInTheDocument();
  });

  it("says so in one line when none were reported, and nothing when the list was not loaded", () => {
    const loaded = financeSummary();
    loaded.direct_campaign.conduit_donations = [];
    const { rerender } = render(<FinanceSummaryCard summary={loaded} />);
    expect(screen.getByText("No donations sent through groups reported.")).toBeInTheDocument();

    // State sources and unsynced federal candidates send no list at all.
    rerender(<FinanceSummaryCard summary={financeSummary()} />);
    expect(screen.queryByText("Donations sent through groups")).not.toBeInTheDocument();
  });
});

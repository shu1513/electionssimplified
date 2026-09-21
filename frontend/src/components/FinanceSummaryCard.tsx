import { useState } from "react";
import type {
  FinanceBreakdown,
  FinanceOutsideGroup,
  FinanceOutsideIndustrySupport,
  FinanceSummary,
  FinanceUnallocatedOutsideEdge,
} from "@voteapp/api-client";
import {
  VISIBLE_FINANCE_CONTRIBUTOR_ROWS,
  financeSourceLabel,
  firstFinanceSourceUrl,
  formatElectionDate,
  formatFinanceCategory,
  formatMoney,
  formatOutsideEvidenceLines,
  formatSourceHost,
  hasFinanceContent,
  hasOutsideDirectionContent,
  hasOutsideFinanceContent,
  pacDonorConnectedOrganizationLabel,
  shouldShowDirectCoverageNote,
  sortContributionSizeBuckets,
  spendingExceedsCycleFunds,
  splitConduitDonations,
} from "@voteapp/api-client";

// Campaign finance disclosure panel, rendered on the candidate profile page
// only (the election page's candidate cards deliberately omit finance).
// Wording is claims-precise:
// these are amounts and categories reported to the disclosing agency, so
// headings say "disclosed" / "reporting", and outside committees are
// "outside groups" (state terminology differs; not every one is a Super PAC).
//
// The card keeps a brief default view: top occupations (top five only),
// size buckets largest-first, and outside spending
// with a plain-language explanation. Employers stay hidden. Direct-donor
// industries render only when occupations are unavailable, avoiding duplicate
// views while preserving the only trustworthy classification some states have.

// "Anything to render" logic lives in the shared package (the mobile card
// uses the same definition); re-exported here for this component's callers.
export { hasFinanceContent };

// How many direct-breakdown rows show; anything past this is not rendered.
const VISIBLE_DIRECT_BREAKDOWNS = 5;

function MoneyStat({ label, amount }: { label: string; amount: number | null }) {
  if (amount === null) {
    return null;
  }
  return (
    <div>
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="text-sm font-semibold text-ink">{formatMoney(amount)}</dd>
    </div>
  );
}

function AmountRow({ name, right }: { name: string; right: string }) {
  return (
    <li className="flex justify-between gap-3 text-sm">
      <span className="text-ink">{name}</span>
      <span className="shrink-0 text-ink-soft">{right}</span>
    </li>
  );
}

function BreakdownRows({ rows }: { rows: FinanceBreakdown[] }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {rows.map((row) => (
        // contributor_count is deliberately not rendered: state adapters
        // disagree on its meaning (Colorado counts contribution rows, Utah
        // counts distinct contributors, FEC counts itemized receipts), so
        // any single label ("donors", "contributions") would be wrong for
        // some sources. Show it only once the backend guarantees one
        // semantic across every loader.
        <AmountRow key={row.category_name} name={formatFinanceCategory(row.category_name)} right={formatMoney(row.amount)} />
      ))}
    </ul>
  );
}

function BreakdownList({
  heading,
  rows,
  visibleCount,
}: {
  heading: string;
  rows: FinanceBreakdown[];
  /** When set, rows beyond this count are not rendered. */
  visibleCount?: number;
}) {
  if (rows.length === 0) {
    return null;
  }
  const visible = visibleCount !== undefined ? rows.slice(0, visibleCount) : rows;
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{heading}</h4>
      <BreakdownRows rows={visible} />
    </div>
  );
}

type ContributorRow = {
  committee_id: string;
  committee_name: string;
  amount: number;
  source_url: string | null;
  detail: string | null;
};

/**
 * A named list of committees with amounts: the top rows, then a "Show all"
 * control. Each name links to the FEC page the amount comes from. `rows` is
 * undefined when the source has not loaded the list (render nothing) and
 * empty when it loaded and found none (say so in one line).
 */
function ContributorList({
  heading,
  emptyText,
  rows,
  totalCount,
}: {
  heading: string;
  emptyText: string | null;
  rows: ContributorRow[] | undefined;
  totalCount?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  if (rows === undefined || (rows.length === 0 && emptyText === null)) {
    return null;
  }
  const visible = showAll ? rows : rows.slice(0, VISIBLE_FINANCE_CONTRIBUTOR_ROWS);
  const fullCount = Math.max(totalCount ?? rows.length, rows.length);
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{heading}</h4>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-ink-soft">{emptyText}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {visible.map((row) => (
            <li key={row.committee_id} className="flex justify-between gap-3 text-sm">
              <span className="text-ink">
                {row.source_url ? (
                  <a href={row.source_url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                    {row.committee_name}
                  </a>
                ) : (
                  row.committee_name
                )}
                {row.detail ? <span className="block text-xs text-ink-soft">{row.detail}</span> : null}
              </span>
              <span className="shrink-0 text-ink-soft">{formatMoney(row.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > VISIBLE_FINANCE_CONTRIBUTOR_ROWS ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="mt-1 text-xs text-ink-soft underline hover:text-ink"
        >
          {showAll ? "Show fewer" : `Show all (${fullCount})`}
        </button>
      ) : null}
      {showAll && fullCount > rows.length ? (
        <p className="mt-1 text-xs text-ink-soft">
          Showing the top {rows.length} of {fullCount}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One outside-spending industry with, when the backend supplies evidence,
 * a plain-language line naming the organizations behind it.
 */
function OutsideIndustryRow({ industry }: { industry: FinanceBreakdown | FinanceOutsideIndustrySupport }) {
  const organizations = "supporting_organizations" in industry ? industry.supporting_organizations : [];
  // One line per receiving committee; "employer" evidence reads as money from
  // that employer's contributors, never as the company donating (the shared
  // helper owns the distinction).
  const evidenceLines = formatOutsideEvidenceLines(organizations);
  return (
    <li className="text-sm">
      <div className="flex justify-between gap-3">
        <span className="text-ink">{formatFinanceCategory(industry.category_name)}</span>
        <span className="shrink-0 text-ink-soft">{formatMoney(industry.amount)}</span>
      </div>
      {evidenceLines.map((line) => (
        <p key={line} className="text-xs text-ink-soft">
          {line}
        </p>
      ))}
    </li>
  );
}

function OutsideSection({
  direction,
  total,
  groups,
  industries,
}: {
  direction: "support" | "opposition";
  total: number | null;
  groups: FinanceOutsideGroup[];
  industries: (FinanceBreakdown | FinanceOutsideIndustrySupport)[];
}) {
  // An empty direction renders nothing rather than a bare header — a race
  // often has disclosed support with no disclosed opposition. A disclosed
  // $0 total counts as empty (the shared helper's rule): "$0 opposing this
  // candidate" is noise, not information.
  if (!hasOutsideDirectionContent(total, groups, industries)) {
    return null;
  }
  const shownTotal = total !== null && total > 0 ? total : null;
  // Support/opposition are color-coded (green/red tint, same palette as the
  // ballot-measure YES/NO boxes) so the two directions read apart at a
  // glance. Vertical rhythm inside the box steps down with hierarchy:
  // blocks (heading / industries / groups) sit 16-20px apart, rows inside
  // a block 6-16px, a group's own name and label 4px — so the eye reads
  // three blocks, not one undifferentiated list. The heading is a plain sentence with the actor first ("Outside
  // groups spent $X to support this candidate"): "outside money" and
  // "reported support" both lost readers who never learned the terms.
  const isSupport = direction === "support";
  const directionLabel = isSupport ? "supporting" : "opposing";
  const verb = isSupport ? "support" : "oppose";
  return (
    <div
      className={`mt-3 rounded border px-7 py-5 ${
        isSupport ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"
      }`}
    >
      <p className={`text-base font-medium ${isSupport ? "text-green-900" : "text-red-900"}`}>
        Outside groups spent {shownTotal !== null ? formatMoney(shownTotal) : "money"} to {verb}{" "}
        this candidate.
      </p>
      {industries.length > 0 ? (
        <div className="mt-4">
          {/* These amounts are contributions INTO the groups (aggregated
              from committee income across the cycle), while the total above
              is candidate-specific expenditure — an industry can have given
              a group more than the group spent on this race. The heading and
              the section's shared note keep the two from being conflated. */}
          <h5 className="text-xs font-medium text-ink-soft">Donations to groups {directionLabel} this candidate, by donor industry</h5>
          <ul className="mt-2 space-y-1.5">
            {industries.map((row) => (
              <OutsideIndustryRow key={row.category_name} industry={row} />
            ))}
          </ul>
        </div>
      ) : null}
      {groups.length > 0 ? (
        // Open by default: the group list is the substance of this section,
        // not secondary detail — but it stays a <details> so readers can
        // collapse a long list out of the way.
        <details className="mt-5" open>
          <summary className="cursor-pointer select-none text-sm font-medium text-ink hover:underline">
            Groups that spent money {directionLabel} this candidate ({groups.length})
          </summary>
          <ul className="mt-3 space-y-4">
            {groups.map((row) => (
              <li key={row.committee_id} className="text-sm">
                <div className="flex justify-between gap-3">
                  <span className="font-medium text-ink">{row.committee_name}</span>
                  <span className="shrink-0 text-ink-soft">{formatMoney(row.amount)}</span>
                </div>
                {/* Researched one-line description of who is behind the
                    committee — the name alone ("Streets for All Los Angeles
                    PAC") tells a voter nothing. Absent until researched.
                    Body size and mid ink, so it still reads as substance
                    rather than a footnote; the name carries the weight, or a
                    wrapping two-line label competes with the name it belongs
                    to. The label is a factual claim, so the evidence behind
                    it rides along as quiet host links. */}
                {row.label ? (
                  <p className="mt-1 text-sm text-ink-mid">
                    {row.label}
                    {(row.label_source_urls ?? []).map((url) => (
                      <span key={url} className="text-xs text-ink-soft">
                        {" · "}
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-ink"
                        >
                          {formatSourceHost(url)}
                        </a>
                      </span>
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function UnallocatedOutsideEdges({ edges }: { edges: FinanceUnallocatedOutsideEdge[] }) {
  if (edges.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 rounded border border-line px-7 py-5">
      <p className="text-base font-medium text-ink">
        Outside spending with no amount reported for this candidate
      </p>
      <p className="mt-1 text-xs text-ink-soft">
        These filings name this candidate as supported or opposed but do not report how much of
        the spending applied to this candidate.
      </p>
      <ul className="mt-3 space-y-4">
        {edges.map((edge) => {
          const reportDate = formatElectionDate(edge.report_date);
          return (
            <li key={`${edge.filing_id}:${edge.committee_id}:${edge.support_oppose}`} className="text-sm">
              <p className="font-medium text-ink">{edge.committee_name}</p>
              <p className="text-xs text-ink-soft">
                Reported as {edge.support_oppose === "support" ? "supporting" : "opposing"} this
                candidate · {reportDate} ·{" "}
                <a
                  href={edge.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-ink"
                  aria-label={`View filing for ${edge.committee_name} dated ${reportDate}`}
                >
                  View filing
                </a>
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Member communications: an organization spending to reach its own members
 * about a candidate (a union mailing its membership, for example). Legally
 * distinct from independent expenditures — it may even be coordinated with
 * the campaign — so it gets its own section instead of joining the outside
 * totals. One direction line per side, same green/red tint as the outside
 * boxes so direction reads consistently. A $0 side renders nothing (the LA
 * sync writes 0 for every linked candidate).
 */
function MemberCommunicationsSection({
  supportTotal,
  opposeTotal,
}: {
  supportTotal: number | null | undefined;
  opposeTotal: number | null | undefined;
}) {
  const rows = [
    {
      verb: "support",
      amount: supportTotal,
      boxClass: "border-green-200 bg-green-50",
      textClass: "text-green-900",
    },
    {
      verb: "oppose",
      amount: opposeTotal,
      boxClass: "border-red-200 bg-red-50",
      textClass: "text-red-900",
    },
  ].filter((row) => (row.amount ?? 0) > 0);
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
        Member communications
      </h4>
      <p className="mt-1 text-xs text-ink-soft">
        Organizations such as unions or trade associations spent this money to talk to their own
        members about this candidate. It is reported separately from outside spending and does not
        go to the candidate.
      </p>
      {rows.map((row) => (
        <div key={row.verb} className={`mt-3 rounded border px-7 py-5 ${row.boxClass}`}>
          <p className={`text-base font-medium ${row.textClass}`}>
            These organizations spent {formatMoney(row.amount ?? 0)} to {row.verb} this candidate.
          </p>
        </div>
      ))}
    </div>
  );
}

export function FinanceSummaryCard({ summary }: { summary: FinanceSummary }) {
  const direct = summary.direct_campaign;
  const outside = summary.outside_spending;
  const publicFundsReceived = direct.public_funds_received;
  const hasPublicFunds = publicFundsReceived != null;
  // Loans render only when positive: a "Loans $0" stat tells voters nothing,
  // and sources that don't report loans leave the field absent entirely.
  const loansReceived = direct.loans_received ?? null;
  const hasLoans = loansReceived !== null && loansReceived > 0;
  const hasMoneyRow =
    direct.total_raised !== null ||
    direct.total_spent !== null ||
    direct.cash_on_hand !== null ||
    direct.debts_owed !== null ||
    hasLoans ||
    direct.public_funds_received != null;
  const moneyStatCount = 4 + (hasLoans ? 1 : 0) + (hasPublicFunds ? 1 : 0);
  const moneyGridClass =
    moneyStatCount === 6 ? "sm:grid-cols-6" : moneyStatCount === 5 ? "sm:grid-cols-5" : "sm:grid-cols-4";
  const sourceUrl = firstFinanceSourceUrl(summary);
  const directIndustries = direct.top_occupations.length === 0 ? direct.top_industries : [];
  const pacDonorRows = direct.pac_donors?.map((donor) => ({
    ...donor,
    detail: pacDonorConnectedOrganizationLabel(donor),
  }));
  const conduits = direct.conduit_donations ? splitConduitDonations(direct.conduit_donations) : undefined;
  const toConduitRow = (row: { committee_id: string; committee_name: string; amount: number; source_url: string | null }) => ({
    ...row,
    detail: null,
  });
  // Supporting industries prefer the backing-summary rows, which carry the
  // organizations behind each industry; fall back to the plain breakdown.
  const supportingIndustries: (FinanceBreakdown | FinanceOutsideIndustrySupport)[] =
    summary.backing_summary?.top_outside_supporting_industries?.length
      ? summary.backing_summary.top_outside_supporting_industries
      : outside.top_supporting_industries;

  return (
    <div className="text-sm">
      <p className="text-xs text-ink-soft">
        Data last updated {formatElectionDate(summary.last_synced_at.slice(0, 10))}
      </p>

      {hasMoneyRow ? (
        <dl className={`mt-3 grid grid-cols-2 gap-3 ${moneyGridClass}`}>
          <MoneyStat label="Raised" amount={direct.total_raised} />
          {hasLoans ? <MoneyStat label="Loans" amount={loansReceived} /> : null}
          <MoneyStat label="Spent" amount={direct.total_spent} />
          <MoneyStat label="Cash on hand" amount={direct.cash_on_hand} />
          <MoneyStat label="Debts" amount={direct.debts_owed} />
          {hasPublicFunds ? <MoneyStat label="Public funds" amount={publicFundsReceived} /> : null}
        </dl>
      ) : null}
      {hasLoans ? (
        <p className="mt-1 text-xs text-ink-soft">
          Loans are money the campaign borrowed, often from the candidate. Raised does not include
          them.
        </p>
      ) : null}
      {spendingExceedsCycleFunds(summary) ? (
        <p className="mt-1 text-xs text-ink-soft">
          Spent can be higher than Raised because campaigns can also use money that Raised does not
          count, like loans or funds from earlier years.
        </p>
      ) : null}

      {/* Most notes qualify breakdowns. Missouri's also qualifies its
          itemized totals, including a legitimate zero-row snapshot. */}
      {shouldShowDirectCoverageNote(summary) ? (
        <p className="mt-1 text-xs text-ink-soft">{direct.direct_coverage_note}</p>
      ) : null}
      <BreakdownList
        heading="Top disclosed occupations of direct donors"
        rows={direct.top_occupations}
        visibleCount={VISIBLE_DIRECT_BREAKDOWNS}
      />
      <BreakdownList
        heading="Industries represented among direct contributions"
        rows={directIndustries}
        visibleCount={VISIBLE_DIRECT_BREAKDOWNS}
      />
      {(direct.contribution_size_buckets ?? []).length > 0 ? (
        // Collapsed by default: size buckets are secondary detail next to
        // the money row and occupations.
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-ink-soft underline hover:text-ink">
            Direct contributions by size
          </summary>
          <BreakdownRows rows={sortContributionSizeBuckets(direct.contribution_size_buckets ?? [])} />
        </details>
      ) : null}

      <ContributorList
        heading="Top PAC donors"
        emptyText="No PAC donations reported."
        rows={pacDonorRows}
        totalCount={direct.pac_donor_count}
      />
      {/* Payment platforms process donations for any campaign, so they get
          their own short list instead of crowding out the groups. The count
          covers both lists, so it is passed only when there are no platforms. */}
      <ContributorList
        heading="Donations sent through groups"
        emptyText={conduits && conduits.platforms.length > 0 ? null : "No donations sent through groups reported."}
        rows={conduits?.groups.map(toConduitRow)}
        totalCount={conduits && conduits.platforms.length === 0 ? direct.conduit_donation_count : undefined}
      />
      <ContributorList
        heading="Donations sent through online payment platforms"
        emptyText={null}
        rows={conduits?.platforms.map(toConduitRow)}
      />

      {hasOutsideFinanceContent(summary) ? (
        <div className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Spending by outside groups
          </h4>
          <p className="mt-1 text-xs text-ink-soft">
            Outside groups, such as PACs and super PACs, spend this money on the race. The
            candidate's campaign does not spend it, and none of it goes to the candidate.
          </p>
          {/* Stated with the outside evidence, not in the footnote: a reader
              needs the source's known coverage gap beside the claim it
              qualifies. Deliberately inside the hasOutsideFinanceContent
              gate: with no outside data shown the card asserts nothing about
              outside money, and a disclaimer under an empty heading would
              imply there is data. */}
          {outside.outside_coverage_note ? (
            <p className="mt-1 text-xs text-ink-soft">{outside.outside_coverage_note}</p>
          ) : null}
          <OutsideSection
            direction="support"
            total={outside.support_total}
            groups={outside.top_supporting_groups}
            industries={supportingIndustries}
          />
          <OutsideSection
            direction="opposition"
            total={outside.oppose_total}
            groups={outside.top_opposing_groups}
            industries={outside.top_opposing_industries}
          />
          <UnallocatedOutsideEdges edges={outside.unallocated_candidate_edges ?? []} />
          {supportingIndustries.length > 0 || outside.top_opposing_industries.length > 0 ? (
            <p className="mt-1 text-xs text-ink-soft">
              Industry amounts are donations to these groups, sorted by each donor's industry. They
              are not what the groups spent on this candidate.
            </p>
          ) : null}
        </div>
      ) : null}

      <MemberCommunicationsSection
        supportTotal={outside.membership_support_total}
        opposeTotal={outside.membership_oppose_total}
      />

      <p className="mt-3 text-xs text-ink-soft">
        Source: {financeSourceLabel(summary.source)} · {summary.cycle} cycle
        {sourceUrl ? (
          <>
            {" · "}
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
              {formatSourceHost(sourceUrl)}
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}

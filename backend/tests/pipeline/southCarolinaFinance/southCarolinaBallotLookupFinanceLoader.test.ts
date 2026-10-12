import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SOUTH_CAROLINA_DIRECT_COVERAGE_NOTE } from "../../../src/pipeline/southCarolinaFinance/southCarolinaDirectContributionAggregator.js";
import {
  loadSouthCarolinaCandidateFinanceSummariesByCandidateElection,
  SOUTH_CAROLINA_DONOR_COVERAGE_NOTE,
} from "../../../src/pipeline/southCarolinaFinance/southCarolinaBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";

afterEach(() => vi.unstubAllEnvs());

describe("southCarolinaBallotLookupFinanceLoader", () => {
  runStateFinanceLoaderCharacterization({
    // Characterize the unchanged standard relations independently of the donor facet.
    load: (db, c, e) =>
      loadSouthCarolinaCandidateFinanceSummariesByCandidateElection(
        {
          query: (sql: string, params: unknown[]) =>
            sql.includes("sc_candidate_finance_pac_donors")
              ? Promise.resolve({ rows: [] })
              : db.query(sql, params),
        } as typeof db,
        c,
        e,
      ),
    flagEnvVar: "SOUTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "SC",
    tablePrefix: "sc_candidate_finance",
    source: "SOUTH_CAROLINA_CAMPAIGN_FINANCE",
    genericSourceUrl: "https://ethicsfiling.sc.gov/public",
    eligibleOffice: {
      office_scope: "statewide",
      office_canonical_name: "Governor",
    },
    ineligibleOffice: {
      office_scope: "county",
      office_canonical_name: "Sheriff",
    },
    directCoverageNote:
      SOUTH_CAROLINA_DIRECT_COVERAGE_NOTE +
      " " +
      SOUTH_CAROLINA_DONOR_COVERAGE_NOTE,
    outsideCoverageNote:
      "South Carolina outside spending coverage is incomplete. Unavailable totals do not mean zero.",
  });
});

const C = "11111111-1111-4111-8111-111111111111",
  E = "22222222-2222-4222-8222-222222222222",
  SOURCE = "https://ethicsfiling.sc.gov/public";
const candidates = [{ candidate_id: C, election_id: E }],
  elections = [
    {
      election_id: E,
      state: "SC",
      office_scope: "statewide",
      office_canonical_name: "Governor",
    },
  ];
function donor(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: C,
    election_id: E,
    committee_id: "reported:SOURCE PAC",
    committee_name: "Source PAC",
    recognition_method: "political_name_hint",
    source_reported_class: "group_yes",
    amount: "500",
    source_url: SOURCE,
    industry_slug: null,
    classification_source: null,
    confidence: null,
    ...overrides,
  };
}
function donorDb(rows: unknown[]) {
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("sc_candidate_finance_pac_donors")) return { rows };
      if (sql.includes("sc_candidate_finance_summaries"))
        return {
          rows: [
            {
              candidate_id: C,
              election_id: E,
              election_year: 2026,
              committee_id: "54395",
              total_receipts: "12000",
              direct_contribution_total: "10000",
              total_disbursements: "2000",
              cash_on_hand: "8000",
              outside_support_total: null,
              outside_oppose_total: null,
              last_synced_at: "2026-10-11T12:00:00.000Z",
            },
          ],
        };
      return { rows: [] };
    }),
  };
}
async function card(db: ReturnType<typeof donorDb>) {
  return [
    ...(
      await loadSouthCarolinaCandidateFinanceSummariesByCandidateElection(
        db,
        candidates,
        elections,
      )
    ).values(),
  ][0]!;
}
describe("SC political-name donor card", () => {
  it("nets active links/year before positive display and leaves Raised unchanged", async () => {
    vi.stubEnv("SOUTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "true");
    // SQL yields 700 after +1000 and -300 on two receiving links.
    const db = donorDb([
      donor({ amount: "700" }),
      donor({ amount: "0" }),
      donor({ amount: "-10" }),
    ]);
    const result = await card(db);
    expect(result.direct_campaign.total_raised).toBe(10000);
    expect(result.outside_spending.support_total).toBeNull();
    expect(result.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({
      interest: "unclassified",
      amount: 700,
      pac_count: 1,
    });
    const sql = db.query.mock.calls.find(([s]) =>
      s.includes("sc_candidate_finance_pac_donors"),
    )![0];
    for (const fragment of [
      "link.link_status = 'active'",
      "donor.election_year = link.election_year",
      "sum(donor.amount) AS amount",
      "GROUP BY selected.candidate_id, selected.election_id, donor.committee_id",
    ])
      expect(sql).toContain(fragment);
    expect(sql).not.toMatch(/donor.amount\s*>|LIMIT/);
    expect(result.direct_campaign.direct_coverage_note).toContain(
      "lacks an explicit PAC type",
    );
  });
  it("totals all groups before the five-name cap and retains hidden classifications as unsorted", async () => {
    vi.stubEnv("SOUTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "true");
    const result = await card(
      donorDb(
        Array.from({ length: 7 }, (_, i) =>
          donor({
            committee_id: `reported:SOURCE ${i} PAC`,
            committee_name: `Source ${i} PAC`,
            amount: String(100 + i),
            industry_slug: i === 0 ? "candidate_committees" : null,
            classification_source: i === 0 ? "manual" : null,
          }),
        ),
      ),
    );
    expect(result.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({
      interest: "unclassified",
      amount: 721,
      pac_count: 7,
    });
    expect(
      result.direct_campaign.pac_money_by_interest?.[0]?.pacs.map(
        (p) => p.amount,
      ),
    ).toEqual([106, 105, 104, 103, 102]);
  });
  it("uses trusted interests while low confidence stays unsorted and wrong source markers are excluded", async () => {
    vi.stubEnv("SOUTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "true");
    const result = await card(
      donorDb([
        donor({
          industry_slug: "healthcare",
          classification_source: "manual",
          confidence: "low",
        }),
        donor({
          committee_id: "reported:OTHER PAC",
          committee_name: "Other PAC",
          amount: "200",
          industry_slug: "technology",
          classification_source: "ai",
          confidence: "medium",
        }),
        donor({ amount: "99999", source_reported_class: "group_no" }),
      ]),
    );
    expect(
      result.direct_campaign.pac_money_by_interest?.map((i) => [
        i.interest,
        i.amount,
      ]),
    ).toEqual([
      ["healthcare", 500],
      ["unclassified", 200],
    ]);
  });
  it("retains every interest including the complete unsorted subtotal after five larger classified interests", async () => {
    vi.stubEnv("SOUTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "true");
    const interests = [
      "technology",
      "healthcare",
      "construction",
      "education",
      "labor_unions",
      "agriculture_and_food",
    ];
    const result = await card(
      donorDb([
        ...interests.map((interest, i) =>
          donor({
            committee_id: `reported:SECTOR ${i} PAC`,
            committee_name: `Sector ${i} PAC`,
            amount: String(1000 + i),
            industry_slug: interest,
            classification_source: "manual",
          }),
        ),
        donor({
          committee_id: "reported:SMALL PAC",
          committee_name: "Small PAC",
          amount: "10",
        }),
      ]),
    );
    expect(result.direct_campaign.pac_money_by_interest).toHaveLength(7);
    expect(
      result.direct_campaign.pac_money_by_interest?.find(
        (i) => i.interest === "unclassified",
      ),
    ).toMatchObject({ amount: 10, pac_count: 1 });
    expect(result.direct_campaign.total_raised).toBe(10000);
  });
  it("missing rows omit the card instead of reporting zero", async () => {
    vi.stubEnv("SOUTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "true");
    expect((await card(donorDb([]))).direct_campaign).not.toHaveProperty(
      "pac_money_by_interest",
    );
  });
  it("migration retains signed source facts with bounded identifiers and link/year ownership", () => {
    const sql = readFileSync(
      new URL(
        "../../../../db/migrations/335_add_south_carolina_reported_donors.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const [, name] of sql.matchAll(
      /(?:CONSTRAINT|CREATE TRIGGER|CREATE INDEX IF NOT EXISTS)\s+([a-z_]+)/g,
    ))
      expect(Buffer.byteLength(name!, "utf8")).toBeLessThanOrEqual(63);
    expect(sql).toContain("FOREIGN KEY (link_id, election_year)");
    expect(sql).toContain(
      "REFERENCES public.sc_candidate_finance_links(id, election_year)",
    );
    expect(sql).toContain("recognition_method = 'political_name_hint'");
    expect(sql).toContain("source_reported_class = 'group_yes'");
    expect(sql).not.toContain("committee_type");
    expect(sql).not.toContain("amount > 0");
  });
});

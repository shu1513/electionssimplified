import { describe, expect, it, vi } from "vitest";

import { syncMichiganCandidateFinance } from "../../../src/pipeline/michiganFinance/michiganCandidateFinanceSync.js";
import type {
  MichiganMitnLegacyContributionRow,
  MichiganMitnLegacyExpenditureRow,
} from "../../../src/pipeline/michiganFinance/michiganMitnLegacyRowTypes.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";
const SOURCE_URL = "https://www.michigan.gov/sos/example/2022_mi_cfr.7z";

function createMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
  };
}

function contribution(
  overrides: Partial<MichiganMitnLegacyContributionRow> = {}
): MichiganMitnLegacyContributionRow {
  return {
    doc_seq_no: "100",
    page_no: "1",
    contribution_id: "200",
    cont_detail_id: "300",
    doc_stmnt_year: "2022",
    doc_type_desc: "Post-General",
    com_legal_name: "WHITMER FOR GOVERNOR",
    common_name: "Whitmer for Governor",
    cfr_com_id: "514456",
    com_type: "CAN",
    can_first_name: "GRETCHEN",
    can_last_name: "WHITMER",
    contribtype: "Individual",
    f_name: "JANE",
    l_name_or_org: "DOE",
    address: "1 Main",
    city: "Lansing",
    state: "MI",
    zip: "48901",
    occupation: "Attorney",
    employer: "Law Firm",
    received_date: "10/01/2022",
    amount: "100.00",
    aggregate: "100.00",
    extra_desc: "",
    ...overrides,
  };
}

function expenditure(overrides: Partial<MichiganMitnLegacyExpenditureRow> = {}): MichiganMitnLegacyExpenditureRow {
  return {
    doc_seq_no: "900",
    doc_stmnt_year: "2022",
    doc_type_desc: "Post-General",
    com_legal_name: "GET MICHIGAN WORKING AGAIN (SUPERPAC)",
    common_name: "Get Michigan Working Again",
    cfr_com_id: "520012",
    com_type: "IND",
    schedule_desc: "Independent Expenditure",
    supp_opp: "2",
    can_or_ballot: "GRETCHEN WHITMER",
    _column_29: "GOVERNOR",
    amount: "863076.75",
    ...overrides,
  };
}

function baseInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Gretchen Whitmer",
    electionYear: 2022,
    officeScope: "statewide",
    officeName: "Governor",
    sourceUrl: SOURCE_URL,
    contributionSourceUrl: SOURCE_URL,
    outsideSourceUrl: SOURCE_URL,
    now: new Date("2022-02-03T04:05:06.000Z"),
  };
}

describe("michiganCandidateFinanceSync", () => {

  it("writes typed committee donors through the normal snapshot without changing raised totals", async () => {
    const db = createMockDb();
    const result = await syncMichiganCandidateFinance({
      db, ...baseInput(),
      contributionRows: [contribution({
        f_name: "", l_name_or_org: "UAW Michigan Voluntary Political Action Committee",
        occupation: "", employer: "", amount: "12250.00",
      })],
      committeeRegistryRows: [{
        committeeId: "508347", committeeName: "UAW Michigan Voluntary Political Action Committee",
        committeeType: "Independent", status: "Active",
      }],
    });
    expect(result).toMatchObject({ directContributionTotal: 12250, pacDonorsWritten: 1 });
    const donorInsert = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.mi_candidate_finance_pac_donors"));
    expect(donorInsert?.[1]).toEqual(expect.arrayContaining(["508347", "Independent", 12250, 1]));
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.mi_candidate_finance_outside_groups"))).toBe(false);
  });

  it("keeps PAC donors omitted when registry acquisition is unavailable", async () => {
    const db = createMockDb();
    const result = await syncMichiganCandidateFinance({
      db, ...baseInput(), contributionRows: [contribution()],
    });
    expect(result).not.toHaveProperty("pacDonorsWritten");
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("mi_candidate_finance_pac_donors"))).toBe(false);
  });

  it("clears stale PAC donors and outside breakdowns only after explicit available-empty data", async () => {
    const db = createMockDb();
    const result = await syncMichiganCandidateFinance({
      db, ...baseInput(), contributionRows: [contribution()],
      committeeRegistryRows: [], expenditureRows: [],
    });
    expect(result).toMatchObject({ pacDonorsWritten: 0, outsideSupportTotal: 0, outsideOpposeTotal: 0 });
    const sql = db.query.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) => statement.includes("DELETE FROM public.mi_candidate_finance_pac_donors"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.mi_candidate_finance_outside_group_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.mi_candidate_finance_outside_groups"))).toBe(true);
  });

  it("resolves a candidate committee, aggregates direct and outside data, and writes a snapshot", async () => {
    const db = createMockDb();

    const result = await syncMichiganCandidateFinance({
      db,
      ...baseInput(),
      contributionRows: [
        contribution({ cont_detail_id: "1", amount: "100.00", occupation: "Attorney" }),
        contribution({
          cont_detail_id: "2",
          amount: "250.00",
          occupation: "Teacher",
          l_name_or_org: "ROE",
        }),
        contribution({
          cont_detail_id: "3",
          cfr_com_id: "520012",
          com_legal_name: "GET MICHIGAN WORKING AGAIN (SUPERPAC)",
          common_name: "Get Michigan Working Again",
          com_type: "IND",
          can_first_name: "",
          can_last_name: "",
          contribtype: "Organization",
          f_name: "",
          l_name_or_org: "Energy Transfer LLC",
          occupation: "",
          employer: "",
          amount: "25000.00",
        }),
      ],
      expenditureRows: [expenditure()],
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2022,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 4,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 350,
      directContributionTotal: 350,
      outsideSupportTotal: 0,
      outsideOpposeTotal: 863076.75,
      matchedContributionRowCount: 2,
      includedContributionRowCount: 2,
      skippedContributionRowCount: 0,
      matchedOutsideExpenditureRowCount: 1,
      includedOutsideExpenditureRowCount: 1,
      skippedOutsideExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
    });
    expect(result.resolution).toMatchObject({
      status: "matched",
      committeeId: "514456",
      committeeName: "WHITMER FOR GOVERNOR",
    });

    const sql = db.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO public.mi_candidate_finance_links"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.mi_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.finance_label_classifications"))).toBe(true);
  });

  it("classifies every donor but caps the persisted donor rows per group", async () => {
    const db = createMockDb();
    function pacDonor(overrides: Partial<MichiganMitnLegacyContributionRow>): MichiganMitnLegacyContributionRow {
      return contribution({
        cfr_com_id: "520012",
        com_legal_name: "GET MICHIGAN WORKING AGAIN (SUPERPAC)",
        common_name: "Get Michigan Working Again",
        com_type: "IND",
        can_first_name: "",
        can_last_name: "",
        contribtype: "Organization",
        f_name: "",
        occupation: "",
        employer: "",
        ...overrides,
      });
    }

    const result = await syncMichiganCandidateFinance({
      db,
      ...baseInput(),
      // Cap of 1: the smaller IBEW donor must be dropped from the WRITTEN
      // donor rows, yet still feed the classifications and the rebuilt
      // labor_unions industry total.
      outsideMaxBreakdownsPerCategory: 1,
      contributionRows: [
        contribution({ cont_detail_id: "1", amount: "100.00" }),
        pacDonor({ cont_detail_id: "2", amount: "50000.00", l_name_or_org: "IBEW Local 540" }),
        pacDonor({ cont_detail_id: "3", amount: "30000.00", l_name_or_org: "IBEW Voluntary PAC" }),
      ],
      expenditureRows: [expenditure()],
    });

    // 1 capped donor row + 1 industry row built from BOTH donors.
    expect(result.outsideGroupBreakdownsWritten).toBe(2);
    const breakdownInsertParams = db.query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.mi_candidate_finance_outside_group_breakdowns"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(breakdownInsertParams).toContain("IBEW Local 540");
    expect(breakdownInsertParams).not.toContain("IBEW Voluntary PAC");
    // The rebuilt industry total covers the dropped donor too.
    expect(breakdownInsertParams).toContain("labor_unions");
    expect(breakdownInsertParams).toContain(80_000);
    // Both donors persisted classification rows.
    const classificationParams = db.query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(classificationParams).toContain("IBEW Local 540");
    expect(classificationParams).toContain("IBEW Voluntary PAC");
  });

  it("passes currentOffice through so a direct sync cannot unlink an office-mover", async () => {
    const db = createMockDb();

    const result = await syncMichiganCandidateFinance({
      db,
      ...baseInput(),
      officeScope: "statewide",
      officeName: "Governor",
      currentOffice: "Michigan Secretary of State",
      dryRun: true,
      contributionRows: [
        contribution({
          com_legal_name: "GRETCHEN WHITMER FOR SECRETARY OF STATE",
          common_name: "",
        }),
      ],
    });

    expect(result.resolution.status).toBe("matched");
  });

  it("can use a trusted committee and skip resolver name drift", async () => {
    const db = createMockDb();

    const result = await syncMichiganCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Gretchen M. Whitmer",
      trustedCommittee: {
        committeeId: "514456",
        committeeName: "WHITMER FOR GOVERNOR",
        sourceUrl: SOURCE_URL,
      },
      contributionRows: [
        contribution({
          can_first_name: "GRETCHEN",
          can_last_name: "WHITMER",
          amount: "100.00",
          occupation: "Attorney",
        }),
      ],
    });

    expect(result.resolution).toMatchObject({
      status: "matched",
      committeeId: "514456",
      matchedContributionRowCount: 0,
    });
    expect(result.linkWritten).toBe(true);
    expect(result.totalReceipts).toBe(100);
  });

  it("deactivates stale active links when committee resolution is unsafe", async () => {
    const db = createMockDb();

    const result = await syncMichiganCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Other Person",
      contributionRows: [contribution()],
    });

    expect(result.resolution).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(result.linkWritten).toBe(false);
    expect(result.summaryWritten).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("UPDATE public.mi_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("link_status = 'inactive'");
  });

  it("does not deactivate stale active links during dry-run resolution failure", async () => {
    const db = createMockDb();

    const result = await syncMichiganCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      candidateName: "Other Person",
      contributionRows: [contribution()],
    });

    expect(result.resolution).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(result.linkWritten).toBe(false);
    expect(result.summaryWritten).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not write in dry run mode but still returns computed totals", async () => {
    const db = createMockDb();

    const result = await syncMichiganCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      contributionRows: [contribution({ amount: "100.00", occupation: "Attorney" })],
    });

    expect(result.resolution.status).toBe("matched");
    expect(result.linkWritten).toBe(false);
    expect(result.summaryWritten).toBe(false);
    expect(result.totalReceipts).toBe(100);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses optional AI classification for high-dollar unknown organization donors", async () => {
    const db = createMockDb();
    const classifier = vi.fn().mockResolvedValue([
      {
        rawLabel: "Made Up Homes LLC",
        labelType: "donor",
        normalizedLabel: "MADE UP HOMES",
        industrySlug: "real_estate",
        confidence: "medium",
        classificationSource: "ai",
        matchedRule: null,
      },
    ]);

    await syncMichiganCandidateFinance({
      db,
      ...baseInput(),
      aiClassificationMinAmount: 25_000,
      financeIndustryClassifier: classifier,
      contributionRows: [
        contribution({ amount: "100.00", occupation: "Attorney" }),
        contribution({
          cont_detail_id: "3",
          cfr_com_id: "520012",
          com_legal_name: "GET MICHIGAN WORKING AGAIN (SUPERPAC)",
          common_name: "Get Michigan Working Again",
          com_type: "IND",
          can_first_name: "",
          can_last_name: "",
          contribtype: "Organization",
          f_name: "",
          l_name_or_org: "Made Up Homes LLC",
          occupation: "",
          employer: "",
          amount: "25000.00",
        }),
      ],
      expenditureRows: [expenditure()],
    });

    expect(classifier).toHaveBeenCalledWith({
      labels: [
        {
          rawLabel: "Made Up Homes LLC",
          labelType: "donor",
          normalizedLabel: "MADE UP HOMES",
          amount: 25000,
        },
      ],
    });
    const params = db.query.mock.calls.map((call) => call[1]).filter(Array.isArray);
    expect(params.some((paramList) => paramList.includes("real_estate"))).toBe(true);
  });
});

describe("verified outside target coverage", () => {
  it.each([
    { name: "complete available-empty snapshot", expenditureRows: [] as MichiganMitnLegacyExpenditureRow[], outsideTargetCommitteeNames: ["WHITMER FOR GOVERNOR"], expected: true },
    { name: "failed expenditure acquisition", expenditureRows: undefined, outsideTargetCommitteeNames: ["WHITMER FOR GOVERNOR"], expected: false },
    { name: "unverified target coverage", expenditureRows: [] as MichiganMitnLegacyExpenditureRow[], outsideTargetCommitteeNames: undefined, expected: false },
  ])("propagates siblings only with $name", async ({ expenditureRows, outsideTargetCommitteeNames, expected }) => {
    const db = createMockDb();
    await syncMichiganCandidateFinance({
      db, ...baseInput(), contributionRows: [contribution()],
      expenditureRows, outsideTargetCommitteeNames,
    });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("SELECT id::text AS id"))).toBe(expected);
  });

  it("does not propagate a legacy single-target refresh", async () => {
    const db = createMockDb();
    await syncMichiganCandidateFinance({
      db, ...baseInput(), contributionRows: [contribution()], expenditureRows: [],
      outsideTargetCommitteeName: "WHITMER FOR GOVERNOR",
    });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("SELECT id::text AS id"))).toBe(false);
  });
});

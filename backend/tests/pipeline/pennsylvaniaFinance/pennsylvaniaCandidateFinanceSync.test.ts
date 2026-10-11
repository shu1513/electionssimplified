import { describe, expect, it, vi } from "vitest";

import { syncPennsylvaniaCandidateFinance } from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaCandidateFinanceSync.js";
import type {
  PennsylvaniaCampaignFinanceContributionRow,
  PennsylvaniaCampaignFinanceFilerRow,
} from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaCampaignFinanceReader.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";
const SOURCE_URL = "https://www.pa.gov/content/dam/copapwp-pagov/en/dos/resources/voting-and-elections/campaign-finance/campaign-finance-data/2026.zip";

function createMockDb() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

function filerRow(overrides: Partial<PennsylvaniaCampaignFinanceFilerRow> = {}): PennsylvaniaCampaignFinanceFilerRow {
  return {
    CampaignfinanceID: "100",
    FILERID: "12345",
    EYEAR: "2026",
    SubmittedDate: "20260501",
    CYCLE: "2",
    AMMEND: "",
    TERMINATE: "",
    FILERTYPE: "1",
    FILERNAME: "JANE DOE FOR GOVERNOR",
    OFFICE: "GOV",
    DISTRICT: "",
    PARTY: "DEM",
    ADDRESS1: "",
    ADDRESS2: "",
    CITY: "",
    STATE: "PA",
    ZIPCODE: "",
    COUNTY: "",
    PHONE: "",
    BEGINNING: "",
    MONETARY: "",
    INKIND: "",
    ...overrides,
  };
}

function contribution(
  overrides: Partial<PennsylvaniaCampaignFinanceContributionRow> = {}
): PennsylvaniaCampaignFinanceContributionRow {
  return {
    CampaignFinanceID: "200",
    FilerID: "12345",
    EYEAR: "2026",
    SubmittedDate: "20260501",
    CYCLE: "2",
    Section: "IA",
    CONTRIBUTOR: "JANE ROE",
    ADDRESS1: "1 Main",
    ADDRESS2: "",
    CITY: "Harrisburg",
    STATE: "PA",
    ZIPCODE: "17101",
    OCCUPATION: "Attorney",
    ENAME: "Law Firm",
    EADDRESS1: "",
    EADDRESS2: "",
    ECITY: "",
    ESTATE: "",
    EZIPCODE: "",
    CONTDATE1: "20260115",
    CONTAMT1: "100.00",
    CONTDATE2: "",
    CONTAMT2: "",
    CONTDATE3: "",
    CONTAMT3: "",
    CONTDESC: "",
    ...overrides,
  };
}

function baseInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Jane Doe",
    electionYear: 2026,
    officeScope: "statewide",
    officeName: "Governor",
    sourceUrl: SOURCE_URL,
    contributionSourceUrl: SOURCE_URL,
    now: new Date("2026-02-03T04:05:06.000Z"),
  };
}

describe("pennsylvaniaCandidateFinanceSync", () => {
  it("resolves a PA filer, aggregates direct contributions, and writes a snapshot", async () => {
    const db = createMockDb();

    const result = await syncPennsylvaniaCandidateFinance({
      db,
      ...baseInput(),
      filerRows: [filerRow()],
      contributionRows: [
        contribution({ CampaignFinanceID: "1", CONTAMT1: "100.00", OCCUPATION: "Attorney" }),
        contribution({
          CampaignFinanceID: "2",
          CONTRIBUTOR: "JOHN SMITH",
          CONTAMT1: "250.00",
          OCCUPATION: "Teacher",
        }),
      ],
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 4,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 350,
      directContributionTotal: 350,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedContributionRowCount: 2,
      includedContributionEventCount: 2,
      skippedContributionEventCount: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionEventCount: 0,
      skippedOutsideContributionEventCount: 0,
    });
    expect(result.resolution).toMatchObject({
      status: "matched",
      filerId: "12345",
      filerName: "JANE DOE FOR GOVERNOR",
    });

    const sql = db.client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_links"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_summaries"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_outside_groups"))).toBe(false);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.pa_candidate_finance_outside_groups"))).toBe(false);
  });

  it("writes committee donors found in the candidate's contribution rows", async () => {
    const db = createMockDb();
    const result = await syncPennsylvaniaCandidateFinance({
      db,
      ...baseInput(),
      filerRows: [filerRow(), filerRow({ FILERID: "7001", FILERTYPE: "2", FILERNAME: "GREATER PA CARPENTERS PAC", OFFICE: "" })],
      contributionRows: [
        contribution({ CampaignFinanceID: "1", CONTAMT1: "100.00", OCCUPATION: "Attorney" }),
        contribution({ CampaignFinanceID: "2", CONTRIBUTOR: "Greater PA Carpenters PAC", OCCUPATION: "", ENAME: "", CONTAMT1: "1500.00" }),
      ],
    });

    expect(result).toMatchObject({ pacDonorsWritten: 1, totalReceipts: 1600 });
    const pacInsert = db.client.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO public.pa_candidate_finance_pac_donors"));
    expect(pacInsert?.[1]).toEqual([LINK_ID, 2026, "7001", "Greater PA Carpenters PAC", 1500, 1, SOURCE_URL, expect.any(String)]);
  });

  it("uses explicit outside groups to aggregate donor and industry support", async () => {
    const db = createMockDb();

    const result = await syncPennsylvaniaCandidateFinance({
      db,
      ...baseInput(),
      filerRows: [
        filerRow(),
        filerRow({
          FILERID: "PAC123",
          FILERTYPE: "4",
          FILERNAME: "PENNSYLVANIANS FOR ACTION",
          OFFICE: "",
        }),
      ],
      outsideGroups: [
        {
          groupId: "PENNSYLVANIANS FOR ACTION",
          groupName: "Pennsylvanians for Action",
          supportOppose: "support",
          amount: 100000,
          sourceUrl: SOURCE_URL,
        },
      ],
      contributionRows: [
        contribution({ CampaignFinanceID: "1", CONTAMT1: "100.00", OCCUPATION: "Attorney" }),
        contribution({
          CampaignFinanceID: "2",
          FilerID: "PAC123",
          CONTRIBUTOR: "Energy Transfer LLC",
          OCCUPATION: "",
          CONTAMT1: "25000.00",
        }),
      ],
    });

    expect(result).toMatchObject({
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 100,
      directContributionTotal: 100,
      outsideSupportTotal: 100000,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 1,
      includedContributionEventCount: 1,
      skippedContributionEventCount: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionEventCount: 1,
      skippedOutsideContributionEventCount: 0,
    });

    const sql = db.client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_outside_group_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.finance_label_classifications"))).toBe(true);
  });

  it("classifies every outside donor but caps the persisted donor rows per group", async () => {
    const db = createMockDb();

    // Cap of 1: the smaller Continental donor must be dropped from the WRITTEN
    // donor rows, yet still feed the classifications and the rebuilt
    // oil_gas_energy industry total.
    const result = await syncPennsylvaniaCandidateFinance({
      db,
      ...baseInput(),
      outsideMaxBreakdownsPerCategory: 1,
      filerRows: [
        filerRow(),
        filerRow({
          FILERID: "PAC123",
          FILERTYPE: "4",
          FILERNAME: "PENNSYLVANIANS FOR ACTION",
          OFFICE: "",
        }),
      ],
      outsideGroups: [
        {
          groupId: "PENNSYLVANIANS FOR ACTION",
          groupName: "Pennsylvanians for Action",
          supportOppose: "support",
          amount: 100000,
          sourceUrl: SOURCE_URL,
        },
      ],
      contributionRows: [
        contribution({ CampaignFinanceID: "1", CONTAMT1: "100.00", OCCUPATION: "Attorney" }),
        contribution({
          CampaignFinanceID: "2",
          FilerID: "PAC123",
          CONTRIBUTOR: "Energy Transfer LLC",
          OCCUPATION: "",
          CONTAMT1: "50000.00",
        }),
        contribution({
          CampaignFinanceID: "3",
          FilerID: "PAC123",
          CONTRIBUTOR: "Continental Resources Inc",
          OCCUPATION: "",
          CONTAMT1: "25000.00",
        }),
      ],
    });

    // 1 capped donor row + 1 industry row built from BOTH donors.
    expect(result.outsideGroupBreakdownsWritten).toBe(2);
    const breakdownInsertParams = db.client.query.mock.calls
      .filter((call) => String(call[0]).includes("pa_candidate_finance_outside_group_breakdowns"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(breakdownInsertParams).toContain("Energy Transfer LLC");
    expect(breakdownInsertParams).not.toContain("Continental Resources Inc");
    // The rebuilt industry total covers the dropped donor too.
    expect(breakdownInsertParams).toContain("oil_gas_energy");
    expect(breakdownInsertParams).toContain(75000);
    // Both donors persisted classification rows.
    const classificationParams = db.client.query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(classificationParams).toContain("Energy Transfer LLC");
    expect(classificationParams).toContain("Continental Resources Inc");
  });

  it("writes unmapped outside groups but skips donor and industry enrichment", async () => {
    const db = createMockDb();

    const result = await syncPennsylvaniaCandidateFinance({
      db,
      ...baseInput(),
      filerRows: [filerRow()],
      outsideGroups: [
        {
          groupId: "UNMAPPED ACTION",
          groupName: "Unmapped Action",
          supportOppose: "oppose",
          amount: 50000,
          sourceUrl: SOURCE_URL,
        },
      ],
      contributionRows: [
        contribution({ CampaignFinanceID: "1", CONTAMT1: "100.00", OCCUPATION: "Attorney" }),
        contribution({
          CampaignFinanceID: "2",
          FilerID: "PAC123",
          CONTRIBUTOR: "Energy Transfer LLC",
          OCCUPATION: "",
          CONTAMT1: "25000.00",
        }),
      ],
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 0,
      outsideSupportTotal: 0,
      outsideOpposeTotal: 50000,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionEventCount: 0,
      skippedOutsideContributionEventCount: 0,
    });

    const sql = db.client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_outside_group_breakdowns"))).toBe(false);
  });

  it("can use a trusted filer and skip resolver name drift", async () => {
    const db = createMockDb();

    const result = await syncPennsylvaniaCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Jane E. Doe",
      trustedFiler: {
        filerId: "12345",
        filerName: "JANE DOE FOR GOVERNOR",
        sourceUrl: SOURCE_URL,
      },
      filerRows: [],
      contributionRows: [contribution({ CONTAMT1: "100.00" })],
    });

    expect(result.resolution).toMatchObject({
      status: "matched",
      filerId: "12345",
      matchedFilerRowCount: 0,
    });
    expect(result.linkWritten).toBe(true);
    expect(result.totalReceipts).toBe(100);
  });

  it("deactivates stale active links when filer resolution is unsafe", async () => {
    const db = createMockDb();

    const result = await syncPennsylvaniaCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Other Person",
      filerRows: [filerRow()],
      contributionRows: [contribution()],
    });

    expect(result.resolution).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_filer_match",
    });
    expect(result.linkWritten).toBe(false);
    expect(result.summaryWritten).toBe(false);
    expect(result.outsideGroupsWritten).toBe(0);
    expect(result.outsideGroupBreakdownsWritten).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("UPDATE public.pa_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("link_status = 'inactive'");
  });

  it("does not write in dry run mode but still returns computed totals", async () => {
    const db = createMockDb();

    const result = await syncPennsylvaniaCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      filerRows: [filerRow()],
      contributionRows: [contribution({ CONTAMT1: "100.00" })],
    });

    expect(result.resolution.status).toBe("matched");
    expect(result.linkWritten).toBe(false);
    expect(result.summaryWritten).toBe(false);
    expect(result.outsideGroupsWritten).toBe(0);
    expect(result.outsideGroupBreakdownsWritten).toBe(0);
    expect(result.totalReceipts).toBe(100);
    expect(db.query).not.toHaveBeenCalled();
  });
});

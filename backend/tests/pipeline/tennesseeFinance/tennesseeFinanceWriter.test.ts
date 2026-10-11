import { describe, expect, it, vi } from "vitest";

import {
  replaceTennesseeCandidateFinanceSnapshot,
  upsertTennesseeFinanceLink,
} from "../../../src/pipeline/tennesseeFinance/tennesseeFinanceWriter.js";
import type { TennesseePacSourceProvenance } from "../../../src/pipeline/tennesseeFinance/tennesseePacDonorAggregator.js";
import { mergeTennesseeOutsideReportEvidence, type TennesseeVerifiedOutsideReportEvidence } from "../../../src/pipeline/tennesseeFinance/tennesseeOutsideReportEvidence.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "JANE DOE",
    officeName: "State Senator",
    district: "4",
    campCandidateId: "1234",
    ownerName: "DOE, JANE",
    committeeName: "DOE, JANE",
    linkStatus: "active" as const,
    linkSource: "tncamp_search" as const,
    sourceUrl: "https://apps.tn.gov/tncamp/public/cpsearch.htm",
    reportListUrl: "https://apps.tn.gov/tncamp/public/replist.htm?id=1234&owner=DOE,%20JANE",
    lastVerifiedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function createMockDb() {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 });
  const client = {
    query,
    release: vi.fn(),
  };
  return {
    query,
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

// Synthetic closures exercise persistence policy, not live-source completeness.
describe("Tennessee report-scoped outside persistence", () => {
  const candidateContext = { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, campCandidateId: "1234",
    electionYear: 2026, officeName: "State Senator", district: "4", candidateContextFingerprint: "a".repeat(64) };
  const report = (overrides: Partial<TennesseeVerifiedOutsideReportEvidence> = {}): TennesseeVerifiedOutsideReportEvidence => ({
    payerCampId: "136", payerName: "Synthetic payer", stream: "ordinary", periodIdentity: "Pre Primary 2026",
    periodStart: "2026-07-01", periodEnd: "2026-07-27", reportId: "128190",
    sourceUrl: "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=128190",
    manifestFingerprint: "b".repeat(64), fullLedgerFingerprint: "c".repeat(64), rawHashes: { ledger: "d".repeat(64) },
    occurrences: [{ occurrenceId: "row-1", targetCampId: "1234", reportedTargetName: "JANE DOE", resolutionMethod: "contextual_exact_name", supportOppose: "support", date: "2026-07-27", amountCents: 591062 }],
    ...overrides,
  });
  const authority = () => mergeTennesseeOutsideReportEvidence({ candidateContext, verifiedReports: [report()] }).update!;
  const owner = (stored = false) => ({ id: LINK_ID, election_year: 2026, outside_support_total: stored ? "5910.62" : null,
    outside_oppose_total: null, outside_report_provenance: stored ? authority().provenance : null, has_outside_money: stored });
  const groups = () => authority().outsideGroups.map(group => ({ committee_key: group.committeeKey,
    committee_name: group.committeeName, support_oppose: group.supportOppose, amount: String(group.amount),
    expenditure_count: group.expenditureCount, source_url: group.sourceUrl }));
  function dbWithOwners(owners = [owner()], storedGroups = groups(), fail?: string) {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (fail && sql.includes(fail)) throw new Error("synthetic storage failure");
      if (sql.includes("FOR UPDATE OF link")) return { rows: owners, rowCount: owners.length };
      if (sql.includes("SELECT committee_key,committee_name")) return { rows: storedGroups, rowCount: storedGroups.length };
      return { rows: [{ id: LINK_ID }], rowCount: 1 };
    });
    return db;
  }
  const evidence = (verifiedReports = [report()]) => ({ candidateContext, verifiedReports });
  const writesOutside = (db: ReturnType<typeof createMockDb>) => db.query.mock.calls.some(call =>
    /(?:INSERT INTO|DELETE FROM) public\.tn_candidate_finance_outside|SET outside_report_provenance/.test(String(call[0])));

  it("atomically stores current authority and groups while preserving omitted Raised and source URL", async () => {
    const db = dbWithOwners();
    const result = await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), outsideReportEvidence: evidence() });
    expect(result).toMatchObject({ outsideEvidenceAccepted: true, outsideEvidenceDiagnostics: [], outsideGroupsWritten: 1 });
    const summary = db.query.mock.calls.find(call => String(call[0]).includes("total_receipts,"));
    expect(summary?.[1]?.slice(4, 6)).toEqual([5910.62, null]);
    expect(summary?.[1]?.slice(8)).toEqual([true, true, false, false, false]);
    expect(String(summary?.[0])).toContain("ELSE tn_candidate_finance_summaries.direct_contribution_total END");
    const proof = db.query.mock.calls.find(call => String(call[0]).includes("SET outside_report_provenance"));
    expect(JSON.parse(String(proof?.[1]?.[2]))).toEqual(authority().provenance);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("preserves outside when no current closure is available, while independent Raised updates proceed", async () => {
    const db = dbWithOwners();
    const result = await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), summary: { totalReceipts: 50 },
      outsideReportEvidence: evidence([]) });
    expect(result.outsideEvidenceAccepted).toBe(false);
    expect(writesOutside(db)).toBe(false);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("FOR UPDATE OF link"))).toBe(false);
    const summary = db.query.mock.calls.find(call => String(call[0]).includes("total_receipts,"));
    expect(summary?.[1]?.slice(8)).toEqual([false, false, true, false, false]);
  });
  it.each([
    ["legacy money", [{ ...owner(), has_outside_money: true }], "legacy positive"],
    ["sibling ownership", [owner(), { ...owner(), id: ELECTION_ID }], "ambiguous"],
    ["wrong year", [{ ...owner(), election_year: 2024 }], "ambiguous"],
    ["wrong link", [{ ...owner(), id: ELECTION_ID }], "ambiguous"],
  ])("preserves %s without writing outside", async (_label, owners, reason) => {
    const db = dbWithOwners(owners);
    const result = await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), outsideReportEvidence: evidence() });
    expect(result.outsideEvidenceAccepted).toBe(false);
    expect(result.outsideEvidenceDiagnostics?.join(" ")).toContain(reason);
    expect(writesOutside(db)).toBe(false);
  });
  it.each(["scalar", "group", "missing", "invalid"])("preserves incompatible stored %s materialization", async kind => {
    const storedOwner = owner(true);
    const storedGroups = groups();
    if (kind === "scalar") storedOwner.outside_support_total = "5910.61";
    if (kind === "group") storedGroups[0]!.expenditure_count = 2;
    if (kind === "missing") storedGroups.length = 0;
    if (kind === "invalid") storedGroups[0]!.amount = "NaN";
    const db = dbWithOwners([storedOwner], storedGroups);
    const result = await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), outsideReportEvidence: evidence([
      report({ fullLedgerFingerprint: "e".repeat(64), occurrences: [] }),
    ]) });
    expect(result.outsideEvidenceAccepted).toBe(false);
    expect(result.outsideEvidenceDiagnostics?.join(" ")).toContain("materialization");
    expect(writesOutside(db)).toBe(false);
  });
  it("replaces a same-ID amended ledger without adding prior money", async () => {
    const db = dbWithOwners([owner(true)]);
    const updated = report({ fullLedgerFingerprint: "e".repeat(64), occurrences: [{ ...report().occurrences[0]!, amountCents: 30000 }] });
    const result = await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), outsideReportEvidence: evidence([updated]) });
    expect(result.outsideEvidenceAccepted).toBe(true);
    const group = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_outside_groups"));
    expect(group?.[1]?.[5]).toBe(300);
  });
  it("sole-report verified empty replacement removes its materialization and retains report authority", async () => {
    const db = dbWithOwners([owner(true)]);
    const result = await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), outsideReportEvidence: evidence([
      report({ fullLedgerFingerprint: "e".repeat(64), occurrences: [] }),
    ]) });
    expect(result).toMatchObject({ outsideEvidenceAccepted: true, outsideGroupsWritten: 0 });
    const summary = db.query.mock.calls.find(call => String(call[0]).includes("total_receipts,"));
    expect(summary?.[1]?.slice(4, 6)).toEqual([null, null]);
    const cleanup = db.query.mock.calls.find(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_groups"));
    expect(cleanup?.[1]).toEqual([LINK_ID, 2026, "[]"]);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_group_breakdowns"))).toBe(true);
    const proof = db.query.mock.calls.find(call => String(call[0]).includes("SET outside_report_provenance"));
    expect(JSON.parse(String(proof?.[1]?.[2])).reports[0].occurrences).toEqual([]);
  });
  it.each(["SET outside_report_provenance", "INSERT INTO public.tn_candidate_finance_outside_groups"])("rolls back failed %s write", async fail => {
    const db = dbWithOwners([owner()], groups(), fail);
    await expect(replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), outsideReportEvidence: evidence() })).rejects.toThrow("synthetic storage failure");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.query.mock.calls.some(call => call[0] === "COMMIT")).toBe(false);
    expect(db.client.release).toHaveBeenCalledOnce();
  });
  it("rejects mismatched context or legacy mixed evidence before opening a transaction", async () => {
    for (const override of [ { outsideGroups: [] }, { summary: { outsideSupportTotal: null } },
      { outsideReportEvidence: { ...evidence(), candidateContext: { ...candidateContext, district: "5" } } } ]) {
      const db = createMockDb();
      await expect(replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), outsideReportEvidence: evidence(), ...override })).rejects.toThrow("Tennessee");
      expect(db.connect).not.toHaveBeenCalled();
    }
  });
});

describe("tennesseeFinanceWriter", () => {
  it("upserts Tennessee finance links", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    };

    await expect(upsertTennesseeFinanceLink({ db, link: baseLink() })).resolves.toEqual({ linkId: LINK_ID });
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.tn_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("ON CONFLICT (candidate_id, election_id, camp_candidate_id)");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("pg_advisory_xact_lock");
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("WITH link_write_lock AS MATERIALIZED");
    expect(sql).toContain("camp_write_lock AS MATERIALIZED");
    expect(sql).toContain("'tn-camp:' || $7::text || ':' || $3::text");
    expect(sql).toContain("FROM link_write_lock");
    expect(sql).toContain("FROM camp_write_lock");
  });

  it("rejects noncanonical campaign IDs before querying", async () => {
    const db = createMockDb();
    await expect(upsertTennesseeFinanceLink({db,link:{...baseLink(),campCandidateId:"01234"}})).rejects.toThrow("Tennessee");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("replaces a Tennessee snapshot with outside groups", async () => {
    const db = createMockDb();

    const result = await replaceTennesseeCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-07-08T09:10:11.000Z"),
      summary: {
        totalReceipts: 120000,
        directContributionTotal: 120000,
        outsideSupportTotal: 35000,
        outsideOpposeTotal: 5000,
        sourceUrl: "https://apps.tn.gov/tncamp/public/ceresults.htm?d-1341904-e=1&6578706f7274=1",
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amount: 90000,
          contributorCount: 12,
        },
      ],
      outsideGroups: [
        {
          committeeKey: " right  tennessee ",
          committeeName: "RIGHT TENNESSEE",
          supportOppose: "support",
          amount: 35000,
          expenditureCount: 3,
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeKey: "RIGHT TENNESSEE",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "TENNESSEE BANK PAC",
          amount: 25000,
          contributorCount: 1,
        },
        {
          committeeKey: "RIGHT TENNESSEE",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "finance_investment",
          amount: 25000,
          contributorCount: 1,
        },
      ],
      classifications: [
        {
          rawLabel: "TENNESSEE BANK PAC",
          labelType: "donor",
          normalizedLabel: "TENNESSEE BANK PAC",
          industrySlug: "finance_investment",
          confidence: "medium",
          classificationSource: "rule",
          matchedRule: "organization_pattern_finance",
        },
      ],
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 1,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      pacDonorsWritten: 0,
    });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledTimes(1);

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries")
    );
    expect(String(summaryCall?.[0])).toContain("outside_support_total = CASE WHEN $9::boolean THEN EXCLUDED.outside_support_total");
    expect(String(summaryCall?.[0])).not.toContain("outside_support_total = COALESCE");
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      120000,
      120000,
      35000,
      5000,
      "https://apps.tn.gov/tncamp/public/ceresults.htm?d-1341904-e=1&6578706f7274=1",
      "2026-07-08T09:10:11.000Z",
      true,
      true,
      true,
      true,
      true,
    ]);
    const outsideGroupCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tn_candidate_finance_outside_groups")
    );
    expect(outsideGroupCall?.[1]?.[2]).toBe("RIGHT TENNESSEE");
    expect(outsideGroupCall?.[1]?.[6]).toBe(3);
    const outsideBreakdownCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tn_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCall?.[1]?.slice(2, 7)).toEqual([
      "RIGHT TENNESSEE",
      "support",
      "donor",
      "TENNESSEE BANK PAC",
      25000,
    ]);
    expect(
      db.query.mock.calls.some((call) =>
        String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_group_breakdowns")
      )
    ).toBe(true);
    expect(
      db.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))
    ).toBe(true);
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_groups"))).toBe(
      true
    );
  });

  it("deletes stale outside group breakdowns when outside groups are replaced without PAC breakdown data", async () => {
    const db = createMockDb();

    await replaceTennesseeCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-07-08T09:10:11.000Z"),
      outsideGroups: [],
    });

    const staleBreakdownDelete = db.query.mock.calls.find((call) =>
      String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_group_breakdowns")
    );
    expect(staleBreakdownDelete).toBeDefined();
    expect(staleBreakdownDelete?.[1]).toEqual([LINK_ID, 2026, "[]"]);
  });

  it("preserves outside scalars, groups and breakdowns on a direct-only update", async () => {
    const db = createMockDb();
    await replaceTennesseeCandidateFinanceSnapshot({
      db, link: baseLink(), summary: { totalReceipts: 1000, directContributionTotal: 1000 },
    });
    const summaryCall = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries"));
    expect(summaryCall?.[1]?.slice(4, 6)).toEqual([null, null]);
    expect(summaryCall?.[1]?.slice(8, 10)).toEqual([false, false]);
    expect(String(summaryCall?.[0])).toContain("ELSE tn_candidate_finance_summaries.outside_support_total END");
    expect(String(summaryCall?.[0])).toContain("ELSE tn_candidate_finance_summaries.outside_oppose_total END");
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside"))).toBe(false);
  });

  it("distinguishes explicit removal from unavailable scalars instead of coalescing old money", async () => {
    const db = createMockDb();
    await replaceTennesseeCandidateFinanceSnapshot({
      db, link: baseLink(), summary: { outsideSupportTotal: null }, outsideGroups: [],
    });
    const summaryCall = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries"));
    expect(summaryCall?.[1]?.slice(8, 10)).toEqual([true, false]);
    expect(String(summaryCall?.[0])).not.toContain("outside_support_total = COALESCE");
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_groups"))).toBe(true);
  });
});

describe("Tennessee independently optional PAC snapshots", () => {
  const sourceUrl = "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=123786";
  const donor = { committeeId: "reported:EXAMPLE PAC", committeeName: "Example PAC",
    committeeType: "Political Action Committee" as const, amount: 1000, contributionCount: 1, sourceUrl };
  const provenance = (empty = false): TennesseePacSourceProvenance => ({
    version: 1, candidateId: CANDIDATE_ID, electionId: ELECTION_ID, campCandidateId: "1234", electionYear: 2026,
    windowStart: "2025-01-01", windowEnd: "2026-12-31", registryFingerprint: "a".repeat(64),
    currentManifestFingerprint: "b".repeat(64), nativeAllFingerprint: "c".repeat(64), nativePacFingerprint: "d".repeat(64), candidateContextFingerprint: "a".repeat(64),
    reports: [{ reportId: "123786", periodIdentity: "Early Year End Supplemental 2025", periodStart: "2025-07-01",
      periodEnd: "2026-01-15", sourceUrl, rawSha256: "e".repeat(64), semanticFingerprint: "f".repeat(64) }],
    receipts: empty ? [] : [{ reportId: "123786", occurrence: 0, donorId: donor.committeeId,
      date: "2025-08-19", amountCents: 100000 }],
  });

  it("stores donor rows and matching provenance in the existing transaction, without changing Raised", async () => {
    const db = createMockDb();
    const result = await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(),
      summary: { totalReceipts: 5000, directContributionTotal: 5000 },
      pacDonors: [donor], pacSourceProvenance: provenance() });
    expect(result.pacDonorsWritten).toBe(1);
    const summary = db.query.mock.calls.find(call => String(call[0]).includes("total_receipts,"));
    expect(summary?.[1]?.slice(2, 4)).toEqual([5000, 5000]);
    const pac = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_pac_donors"));
    expect(pac?.[1]?.slice(2, 8)).toEqual([donor.committeeId, donor.committeeName, donor.committeeType, 1000, 1, sourceUrl]);
    const source = db.query.mock.calls.find(call => String(call[0]).includes("(link_id,election_year,pac_source_provenance,last_synced_at)"));
    expect(JSON.parse(String(source?.[1]?.[2]))).toEqual(provenance());
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("leaves PAC rows and provenance untouched when the source component is omitted", async () => {
    const db = createMockDb();
    await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), summary: { totalReceipts: 5000 } });
    expect(db.query.mock.calls.some(call => String(call[0]).includes("pac_donors") || String(call[0]).includes("pac_source_provenance"))).toBe(false);
  });
  it("stores original pre-period dates only with explicit source relation", async () => {
    const db=createMockDb(),p=provenance();
    const receipt={...p.receipts[0]!,date:"2025-06-23",dateRelation:"predates_report_period" as const};
    await replaceTennesseeCandidateFinanceSnapshot({db,link:baseLink(),pacDonors:[donor],pacSourceProvenance:{...p,receipts:[receipt]}});
    const stored=db.query.mock.calls.find(call=>String(call[0]).includes("(link_id,election_year,pac_source_provenance,last_synced_at)"));
    expect(JSON.parse(String(stored?.[1]?.[2])).receipts[0]).toEqual(receipt);
  });
  it.each([
    {date:"2025-06-23"},
    {date:"2025-08-19",dateRelation:"predates_report_period"},
    {date:"2026-01-16",dateRelation:"predates_report_period"},
  ])("rejects missing, misleading, or future date relation before writes %j", async override=>{
    const db=createMockDb(),p=provenance();
    await expect(replaceTennesseeCandidateFinanceSnapshot({db,link:baseLink(),pacDonors:[donor],
      pacSourceProvenance:{...p,receipts:[{...p.receipts[0]!,...override}]} as TennesseePacSourceProvenance})).rejects.toThrow("Invalid Tennessee PAC source provenance");
    expect(db.query).not.toHaveBeenCalled();
  });
  it("clears only the verified link/year donor snapshot on an independently proven empty result", async () => {
    const db = createMockDb();
    await replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [], pacSourceProvenance: provenance(true) });
    const cleanup = db.query.mock.calls.find(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_pac_donors"));
    expect(cleanup?.[1]).toEqual([LINK_ID, 2026, []]);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside"))).toBe(false);
  });
  it.each([
    { candidateId: ELECTION_ID }, { campCandidateId: "99" }, { electionYear: 2024 },
    { receipts: [] }, { nativePacFingerprint: "partial" }, { reports: [] },
    { windowStart: "2026-01-01" }, { windowEnd: "2026-10-11" },
    { reports: [{ reportId: "123786", sourceUrl, rawSha256: "e".repeat(64), semanticFingerprint: "f".repeat(64),
      periodIdentity: "Early Year End Supplemental 2025", periodStart: "2025-09-01", periodEnd: "2026-01-15" }] },
  ])("rejects mismatched or incomplete provenance before BEGIN: %j", async overrides => {
    const db = createMockDb();
    await expect(replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [donor],
      pacSourceProvenance: { ...provenance(), ...overrides } })).rejects.toThrow("Invalid Tennessee PAC source provenance");
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
  it("rejects a detached donor snapshot without provenance", async () => {
    const db = createMockDb();
    await expect(replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [donor] })).rejects.toThrow("require source provenance");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("rolls back summary, provenance and donor rows if any donor write fails", async () => {
    const db = createMockDb();
    db.query.mockImplementation(async sql => {
      if (String(sql).includes("INSERT INTO public.tn_candidate_finance_pac_donors")) throw new Error("synthetic write failure");
      return { rows: [{ id: LINK_ID }], rowCount: 1 };
    });
    await expect(replaceTennesseeCandidateFinanceSnapshot({ db, link: baseLink(),
      summary: { totalReceipts: 5000 }, pacDonors: [donor], pacSourceProvenance: provenance() })).rejects.toThrow("synthetic write failure");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.query.mock.calls.some(call => call[0] === "COMMIT")).toBe(false);
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });
});

describe("tennesseeFinanceWriter pool boundary", () => {
  it("rejects a supplied PoolClient before issuing any statement, so it can never commit an outer transaction", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      connect: vi.fn(),
      release: vi.fn(),
    };

    await expect(
      replaceTennesseeCandidateFinanceSnapshot({
        db: client as never,
        link: baseLink(),
        syncedAt: new Date("2026-02-03T04:05:06.000Z"),
        summary: { totalReceipts: 1000 },
      } as never)
    ).rejects.toThrow("Tennessee finance snapshot writes must receive a Pool, not a PoolClient");
    expect(client.query).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });
});

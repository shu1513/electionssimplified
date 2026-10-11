import { describe, expect, it, vi } from "vitest";
import { loadOregonVerifiedFinanceForCandidate } from "../../../src/pipeline/oregonFinance/oregonVerifiedFinanceBatchLoader.js";

vi.mock("../../../src/pipeline/oregonFinance/oregonVerifiedFinanceBatchLoader.js", () => ({
  loadOregonVerifiedFinanceForCandidate: vi.fn(async () => ({ diagnostics: [] })),
}));

import {
  buildOregonOrestarCommitteeExportWorkbook,
  buildOregonOrestarExportWorkbook,
} from "./orestarExportFixture.js";

import {
  listDueOregonCandidateFinanceSyncRows,
  syncDueOregonCandidateFinance,
} from "../../../src/pipeline/oregonFinance/oregonCandidateFinanceBatchSync.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const SOURCE_URL = "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do";
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Tina Kotek",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    committee_id: "4792",
    committee_name: "Friends of Tina Kotek",
    source_url: SOURCE_URL,
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

function htmlResponse(html: string, overrides: Partial<{ ok: boolean; status: number; statusText: string }> = {}) {
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    statusText: overrides.statusText ?? "OK",
    text: async () => html,
  };
}

describe("oregonCandidateFinanceBatchSync", () => {
  it("calls verified acquisition in the normal batch and forwards its independent components", async () => {
    const db = { query: vi.fn(async () => ({ rows: [dueRow()], rowCount: 1 })), connect: vi.fn() };
    const components = { candidateContext: {
      candidateId: CANDIDATE_ID, electionId: ELECTION_ID, committeeId: "4792", candidateName: "Tina Kotek",
      electionYear: 2026, electionType: "General" as const, officeName: "Governor", district: null,
    } };
    vi.mocked(loadOregonVerifiedFinanceForCandidate).mockResolvedValueOnce({
      components, diagnostics: ["Outside payer omitted"], generationDir: "/tmp/test-public-generation",
    });
    const sync = vi.fn(async (_input: unknown) => ({ candidateId: CANDIDATE_ID }));
    await syncDueOregonCandidateFinance({ db, now: NOW, maxCandidates: 1, refresh: true,
      rawCacheDir: "/tmp/test-public-cache", autoLinkMissingLinks: false,
      loadTransactionDetails: async () => [], syncOregonCandidateFinanceFn: sync as never });
    expect(loadOregonVerifiedFinanceForCandidate).toHaveBeenCalledWith(expect.objectContaining({
      db, refresh: true, rawCacheDir: "/tmp/test-public-cache", row: expect.objectContaining({ committeeId: "4792" }),
    }));
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ verifiedFinance: components,
      verifiedFinanceDiagnostics: ["Outside payer omitted"], verifiedSourceGenerationDir: "/tmp/test-public-generation" }));
  });

  it("preserves verified components on acquisition failure while syncing available receipts", async () => {
    const db = { query: vi.fn(async () => ({ rows: [dueRow()], rowCount: 1 })), connect: vi.fn() };
    vi.mocked(loadOregonVerifiedFinanceForCandidate).mockRejectedValueOnce(new Error("Portal blocked"));
    const sync = vi.fn(async (_input: unknown) => ({ candidateId: CANDIDATE_ID }));
    const result = await syncDueOregonCandidateFinance({ db, now: NOW, maxCandidates: 1, autoLinkMissingLinks: false,
      loadTransactionDetails: async () => [], syncOregonCandidateFinanceFn: sync as never });
    expect(result.syncedCandidateCount).toBe(1);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ verifiedFinance: undefined,
      verifiedFinanceDiagnostics: ["Oregon verified source acquisition failed: Portal blocked"] }));
    expect(sync.mock.calls[0]![0]).not.toHaveProperty("outsideTransactionDetails");
  });

  it("lists active Oregon finance links that are due for sync", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "Jane Doe",
            election_year: 2026,
            office_scope: "state_lower",
            office_name: "State Lower Chamber Legislator",
            district: "9",
            committee_id: "999",
            committee_name: "Jane Doe for Oregon",
            source_url: "https://secure.sos.state.or.us/orestar/cneSearch.do?candidate=999",
            last_synced_at: "2026-01-01 00:00:00+00",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
    };

    await expect(
      listDueOregonCandidateFinanceSyncRows(db, {
        now: NOW,
        staleAfterDays: 7,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      })
    ).resolves.toEqual({
      totalDueRows: 2,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Tina Kotek",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          committeeId: "4792",
          committeeName: "Friends of Tina Kotek",
          sourceUrl: SOURCE_URL,
          lastSyncedAt: null,
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "state_lower",
          officeName: "State Lower Chamber Legislator",
          district: "9",
          committeeId: "999",
          committeeName: "Jane Doe for Oregon",
          sourceUrl: "https://secure.sos.state.or.us/orestar/cneSearch.do?candidate=999",
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.or_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'OR'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($6::text[])");
    expect(sql).toContain("nullif(trim(link.source_url), '') IS NOT NULL");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.arrayContaining([
        "statewide::Governor",
        "statewide::Secretary of State",
        "state_upper::State Senator",
        "state_lower::State Lower Chamber Legislator",
      ]),
      false,
      null,
      null,
    ]);
  });

  it("refreshes one scoped candidate before the SQL limit and keeps post-deadline eligibility", async () => {
    const db = { query: vi.fn(async () => ({ rows: [dueRow()], rowCount: 1 })), connect: vi.fn() };
    const syncFn = vi.fn().mockResolvedValue({});
    await syncDueOregonCandidateFinance({
      db, now: NOW, refresh: true, candidateId: CANDIDATE_ID.toUpperCase(), electionYear: 2026,
      maxCandidates: 1, loadTransactionDetails: vi.fn().mockResolvedValue([]),
      syncOregonCandidateFinanceFn: syncFn,
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("$7::boolean");
    expect(sql).toContain("($8::uuid IS NULL OR link.candidate_id = $8::uuid)");
    expect(sql).toContain("($9::int IS NULL OR link.election_year = $9::int)");
    expect(sql.indexOf("link.candidate_id = $8::uuid")).toBeLessThan(sql.indexOf("LIMIT $3::int"));
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      NOW.toISOString(), 7, 1, 100, 730, expect.any(Array), true, CANDIDATE_ID, 2026,
    ]);
    expect(syncFn).toHaveBeenCalledTimes(1);
  });

  it.each([{ candidateId: "invalid" }, { electionYear: 1999 }, { electionYear: 2101 }, { electionYear: 2026.5 }])(
    "rejects invalid scope before discovery, fetching or writes: %j", async (scope) => {
      const db = { query: vi.fn(), connect: vi.fn() };
      const load = vi.fn();
      await expect(syncDueOregonCandidateFinance({ db, ...scope, loadTransactionDetails: load })).rejects.toThrow(/Oregon finance/);
      expect(db.query).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    }
  );

  it("syncs selected due candidates with injected ORESTAR transaction details and continues after failure", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            committee_id: "999",
            committee_name: "Jane Doe for Oregon",
            source_url: "https://secure.sos.state.or.us/orestar/cneSearch.do?candidate=999",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
      connect: vi.fn(),
    };
    const transactionDetails = [{ transactionId: "4458653" }] as never;
    const successfulSync = {
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 1,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 1,
      directContributionTotal: 100,
      outsideSupportTotal: 50,
      outsideOpposeTotal: 0,
      transactionDetailCount: 1,
      matchedDirectContributionRowCount: 1,
      includedDirectContributionRowCount: 1,
      skippedDirectContributionRowCount: 0,
      matchedExpenditureRowCount: 1,
      includedOutsideAssociationCount: 1,
      skippedOutsideAssociationCount: 0,
      matchedOutsideGroupContributionRowCount: 1,
      includedOutsideGroupContributionRowCount: 1,
      skippedOutsideGroupContributionRowCount: 0,
    };
    const loadTransactionDetails = vi.fn().mockResolvedValueOnce(transactionDetails).mockRejectedValueOnce(new Error("ORESTAR blocked"));
    const syncOregonCandidateFinanceFn = vi.fn().mockResolvedValueOnce(successfulSync);

    const result = await syncDueOregonCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      autoLinkMissingLinks: false,
      loadTransactionDetails,
      syncOregonCandidateFinanceFn: syncOregonCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      dryRun: false,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
    });
    expect(result.results[0]).toMatchObject({ ok: true, result: successfulSync });
    expect(result.results[1]).toMatchObject({ ok: false, error: "ORESTAR blocked" });
    expect(loadTransactionDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        committeeId: "4792",
      })
    );
    expect(syncOregonCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Tina Kotek",
        electionYear: 2026,
        officeName: "Governor",
        committeeId: "4792",
        committeeName: "Friends of Tina Kotek",
        sourceUrl: SOURCE_URL,
        transactionDetails,
        dryRun: false,
        now: NOW,
      })
    );
  });

  it("still auto-links the other election years when one year's directory fails to load", async () => {
    // Directory loads are per election year. A 2024 search that throws (the
    // portal blocked, or ORESTAR's 999-row cap) must not take the 2026
    // candidates down with it.
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: "33333333-3333-4333-8333-333333333333",
              election_id: "44444444-4444-4444-8444-444444444444",
              candidate_name: "Pat Older",
              election_year: 2024,
              office_scope: "statewide",
              office_name: "Governor",
              district: "Oregon",
            },
            {
              candidate_id: "55555555-5555-4555-8555-555555555555",
              election_id: "66666666-6666-4666-8666-666666666666",
              candidate_name: "Tina Kotek",
              election_year: 2026,
              office_scope: "statewide",
              office_name: "Governor",
              district: "Oregon",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: "77777777-7777-4777-8777-777777777777" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
    };
    const loadCandidateSearchRows = vi.fn(async (candidateElection: { electionYear: number }) => {
      if (candidateElection.electionYear === 2024) {
        throw new Error("ORESTAR committee search hit its 999-row cap; refusing to use a truncated directory");
      }
      return [
        {
          transactionId: "4458653",
          date: "10/12/2022",
          status: "Original",
          filerCommitteeName: "Friends of Tina Kotek",
          filerCommitteeId: "4792",
          committeeUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=4792",
          contributorPayee: "Jane Donor",
          transactionSubtype: "Cash Contribution",
          amount: 100,
          detailUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4458653",
        },
      ];
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await syncDueOregonCandidateFinance({
        db,
        now: NOW,
        loadCandidateSearchRows,
        loadTransactionDetails: vi.fn(async () => []),
        syncOregonCandidateFinanceFn: vi.fn() as never,
      });

      expect(result).toMatchObject({ autoLinkAttemptedCount: 2, autoLinkLinkedCount: 1 });
      expect(loadCandidateSearchRows).toHaveBeenCalledTimes(2);
      expect(String(db.query.mock.calls[1]?.[0])).toContain("INSERT INTO public.or_candidate_finance_links");
      expect(warn).toHaveBeenCalledWith(
        "Oregon finance auto-link did not link candidate election:",
        expect.objectContaining({
          electionId: "44444444-4444-4444-8444-444444444444",
          status: "skipped",
          reason: expect.stringContaining("directory for 2024 did not load: ORESTAR committee search hit its 999-row cap"),
        })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("auto-links missing Oregon finance links before syncing linked rows when configured", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: "55555555-5555-4555-8555-555555555555",
              election_id: "66666666-6666-4666-8666-666666666666",
              candidate_name: "Tina Kotek",
              election_year: 2026,
              office_scope: "statewide",
              office_name: "Governor",
              district: "Oregon",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: "77777777-7777-4777-8777-777777777777" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [dueRow()], rowCount: 1 }),
      connect: vi.fn(),
    };
    const loadCandidateSearchRows = vi.fn(async () => [
      {
        transactionId: "4458653",
        date: "10/12/2022",
        status: "Original",
        filerCommitteeName: "Friends of Tina Kotek",
        filerCommitteeId: "4792",
        committeeUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=4792",
        contributorPayee: "Jane Donor",
        transactionSubtype: "Cash Contribution",
        amount: 100,
        detailUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4458653",
      },
    ]);
    const loadTransactionDetails = vi.fn(async () => [{ transactionId: "4458653" }] as never);
    const syncOregonCandidateFinanceFn = vi.fn(async () => ({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      directContributionTotal: 0,
      outsideSupportTotal: 0,
      outsideOpposeTotal: 0,
      transactionDetailCount: 1,
      matchedDirectContributionRowCount: 0,
      includedDirectContributionRowCount: 0,
      skippedDirectContributionRowCount: 0,
      matchedExpenditureRowCount: 0,
      includedOutsideAssociationCount: 0,
      skippedOutsideAssociationCount: 0,
      matchedOutsideGroupContributionRowCount: 0,
      includedOutsideGroupContributionRowCount: 0,
      skippedOutsideGroupContributionRowCount: 0,
    }));

    const result = await syncDueOregonCandidateFinance({
      db,
      now: NOW,
      loadCandidateSearchRows,
      loadTransactionDetails,
      syncOregonCandidateFinanceFn: syncOregonCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
    });
    expect(loadCandidateSearchRows).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("LEFT JOIN public.or_candidate_finance_links AS link");
    expect(String(db.query.mock.calls[1]?.[0])).toContain("INSERT INTO public.or_candidate_finance_links");
    expect(String(db.query.mock.calls[2]?.[0])).toContain("FROM public.or_candidate_finance_links AS link");
  });

  it("loads one injected committee directory and reuses it for every candidate in the batch", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: "55555555-5555-4555-8555-555555555555",
              election_id: "66666666-6666-4666-8666-666666666666",
              candidate_name: "Tina Kotek",
              election_year: 2026,
              office_scope: "statewide",
              office_name: "Governor",
              district: "Oregon",
            },
            {
              candidate_id: "88888888-8888-4888-8888-888888888888",
              election_id: "99999999-9999-4999-8999-999999999999",
              candidate_name: "Jane Doe",
              election_year: 2026,
              office_scope: "state_lower",
              office_name: "State Lower Chamber Legislator",
              district: "9",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: "11111111-2222-4333-8444-555555555555" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: "22222222-3333-4444-8555-666666666666" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
    };
    const loadCandidateSearchRows = vi.fn(async () => [
      {
        filerCommitteeId: "4792",
        filerCommitteeName: "Friends of Tina Kotek",
        committeeUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=4792",
      },
      {
        filerCommitteeId: "999",
        filerCommitteeName: "Jane Doe for Oregon",
        committeeUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=999",
      },
    ]);

    const result = await syncDueOregonCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      loadCandidateSearchRows,
      loadTransactionDetails: vi.fn(async () => []),
      syncOregonCandidateFinanceFn: vi.fn(),
    });

    expect(result).toMatchObject({
      autoLinkAttemptedCount: 2,
      autoLinkLinkedCount: 2,
      selectedCandidateCount: 0,
    });
    expect(loadCandidateSearchRows).toHaveBeenCalledTimes(1);
    expect(loadCandidateSearchRows).toHaveBeenCalledWith(expect.objectContaining({ candidateName: "Tina Kotek" }));
  });

  it("uses the default ORESTAR candidate search loader when auto-linking missing finance links", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: "55555555-5555-4555-8555-555555555555",
              election_id: "66666666-6666-4666-8666-666666666666",
              candidate_name: "Tina Kotek",
              election_year: 2026,
              office_scope: "statewide",
              office_name: "Governor",
              district: "Oregon",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: "77777777-7777-4777-8777-777777777777" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
    };
    const workbook = buildOregonOrestarCommitteeExportWorkbook([
      {
        "Committee Id": 4792,
        "Committee Name": "Friends of Tina Kotek",
        "Committee Type": "CC",
        "Candidate Office": "Governor",
        "Candidate First Name": "Tina",
        "Candidate Last Name": "Kotek",
        "Active Election": "2026 General Election",
      },
    ]);
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/orestar/JavaScriptServlet")) {
        return htmlResponse("OWASP_CSRFTOKEN:csrf-token-from-script");
      }
      if (url.includes("CommitteeSearchSecondPage.do")) {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toContain("filerType=CANDALL");
        // Searched by the candidate's election year: the all-years search
        // stops at ORESTAR's 999-row cap.
        expect(String(init?.body)).toContain("yearActive=2026&election=");
        expect(String(init?.body)).toContain("OWASP_CSRFTOKEN=csrf-token-from-script");
        expect(init?.headers).toMatchObject({ cookie: "JSESSIONID_ORESTAR=abc123" });
        return htmlResponse(`
          <div>Results : 1 record found</div>
          <a href="XcelSooSearch">Export To Excel Format</a>
        `);
      }
      if (url.includes("XcelSooSearch")) {
        return {
          ...htmlResponse(""),
          arrayBuffer: async () => workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength),
        };
      }
      return {
        ...htmlResponse(`
          <form name="CommitteeSearchDynaFormSecond" action="/orestar/CommitteeSearchSecondPage.do;JSESSIONID_ORESTAR=abc123">
            <input type="hidden" name="buttonName" value="electionSearch">
          </form>
        `),
        headers: {
          get: (name: string) => (name.toLowerCase() === "set-cookie" ? "JSESSIONID_ORESTAR=abc123; Path=/orestar" : null),
        },
      };
    });

    const result = await syncDueOregonCandidateFinance({
      db,
      now: NOW,
      orestarClientOptions: { fetchFn, requestDelayMs: 0 },
      loadTransactionDetails: vi.fn(async () => []),
      syncOregonCandidateFinanceFn: vi.fn(),
    });

    expect(result).toMatchObject({
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 1,
      selectedCandidateCount: 0,
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("loads committee contributions from the ORESTAR export with the default loader when no override is configured", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [dueRow()], rowCount: 1 })),
      connect: vi.fn(),
    };
    const syncOregonCandidateFinanceFn = vi.fn(async () => ({ ok: true }));
    const searchBodies: string[] = [];
    const workbook = buildOregonOrestarExportWorkbook([
      {
        "Tran Id": "5500001",
        "Tran Date": "05/05/2025",
        Filer: "Friends of Tina Kotek",
        "Contributor/Payee": "Jane Donor",
        "Sub Type": "Cash Contribution",
        Amount: 100,
        "Filer Id": "4792",
      },
    ]);
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("XcelCNESearch")) {
        return {
          ...htmlResponse(""),
          arrayBuffer: async () => workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength),
        };
      }
      if (url.includes("gotoPublicTransactionSearchResults.do")) {
        searchBodies.push(String(init?.body));
        return htmlResponse(`
          <div>Results : 1 record found</div>
          <a href="XcelCNESearch">Export To Excel Format</a>
          <table></table>
        `);
      }
      return htmlResponse(`
        <form name="cneSearchForm" action="/orestar/gotoPublicTransactionSearchResults.do;JSESSIONID_ORESTAR=abc123">
          <input type="hidden" name="OWASP_CSRFTOKEN" value="csrf-token-1">
        </form>
      `);
    });

    const result = await syncDueOregonCandidateFinance({
      db,
      now: NOW,
      autoLinkMissingLinks: false,
      orestarClientOptions: { fetchFn, requestDelayMs: 0 },
      syncOregonCandidateFinanceFn: syncOregonCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 0 });
    // The default loader runs a committee-ID contribution search over the full
    // cycle window and downloads its export instead of scraping the
    // (transaction-free) sooDetail.do source URL.
    expect(searchBodies[0]).toContain("cneSearchFilerCommitteeId=4792");
    expect(searchBodies[0]).toContain("cneSearchTranType=C");
    expect(searchBodies[0]).toContain("cneSearchTranStartDate=01%2F01%2F2025");
    expect(searchBodies[0]).toContain("cneSearchTranEndDate=12%2F31%2F2026");
    expect(syncOregonCandidateFinanceFn.mock.calls[0]?.[0]).toMatchObject({
      transactionDetails: [
        expect.objectContaining({ transactionId: "5500001", transactionType: "Contribution", amount: 100 }),
      ],
    });
  });

  it("reports row failures without writing snapshots when no transaction detail loader is configured", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [dueRow({ committee_id: null })], rowCount: 1 })),
      connect: vi.fn(),
    };
    const syncOregonCandidateFinanceFn = vi.fn();

    const result = await syncDueOregonCandidateFinance({
      db,
      now: NOW,
      autoLinkMissingLinks: false,
      syncOregonCandidateFinanceFn: syncOregonCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 0,
      failedCandidateCount: 1,
    });
    expect(result.results[0]).toMatchObject({
      ok: false,
      error: "Oregon ORESTAR source URL must point to a transaction detail or populated search result",
    });
    expect(syncOregonCandidateFinanceFn).not.toHaveBeenCalled();
  });
});

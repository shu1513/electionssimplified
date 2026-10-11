import { describe, expect, it, vi } from "vitest";

import {
  listDueMichiganCandidateFinanceSyncRows,
  syncDueMichiganCandidateFinance,
} from "../../../src/pipeline/michiganFinance/michiganCandidateFinanceBatchSync.js";

import { buildMitnExportXlsx } from "./mitnXlsxTestFixture.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_URL = "https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do?page=page.miboeContributionPublicSearch";

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Aric Nesbitt",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    committee_id: "521877",
    committee_name: "ARIC NESBITT FOR GOVERNOR",
    source_url: SOURCE_URL,
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

describe("michiganCandidateFinanceBatchSync", () => {
  it("lists due Michigan finance sync rows from explicit active links", async () => {
    const db = createMockDb([dueRow()]);

    const result = await listDueMichiganCandidateFinanceSyncRows(db, {
      now: new Date("2026-07-26T00:00:00.000Z"),
      staleAfterDays: 7,
      maxCandidates: 25,
      electionLookbackDays: 30,
      electionLookaheadDays: 730,
    });

    expect(result).toEqual({
      totalDueRows: 1,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Aric Nesbitt",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          committeeId: "521877",
          committeeName: "ARIC NESBITT FOR GOVERNOR",
          sourceUrl: SOURCE_URL,
          lastSyncedAt: null,
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.mi_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'MI'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($6::text[])");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-07-26T00:00:00.000Z",
      7,
      25,
      30,
      730,
      expect.arrayContaining(["statewide::Governor", "state_upper::State Senator"]),
      2025,
    ]);
  });

  it("uses a one-day post-election grace window by default for due selection", async () => {
    const db = createMockDb();

    await syncDueMichiganCandidateFinance({
      db,
      syncMichiganCandidateFinanceFn: vi.fn(),
      now: new Date("2026-07-26T00:00:00.000Z"),
      autoLinkMissingLinks: false,
    });

    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))"
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-07-26T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.arrayContaining(["statewide::Governor", "state_upper::State Senator"]),
      2025,
    ]);
  });

  it("auto-links and syncs through the MiTN public search", async () => {
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED", "true");
    try {
      const exportXlsx = buildMitnExportXlsx([
        [
          "1",
          "26-1",
          "C",
          "Campaign Statements",
          "2026",
          "July CS",
          "ARIC NESBITT FOR GOVERNOR",
          "521877",
          "Candidate",
          "ARIC",
          "NESBITT",
          "Direct Contributions",
          "RAYMOND",
          "KOUZA",
          "RETIRED",
          "",
          "06/24/2026",
          "1000.00",
          "1000.00",
        ],
      ]);
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes("page.miboeCommitteePublicSearch")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              `<table><tr><td>521877</td><td>Candidate</td><td>ARIC NESBITT FOR GOVERNOR</td><td>Active</td></tr></table>`,
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () =>
            exportXlsx.buffer.slice(exportXlsx.byteOffset, exportXlsx.byteOffset + exportXlsx.byteLength),
        };
      });

      const db = {
        query: vi.fn(async (sql: string) => {
          const text = String(sql);
          if (text.includes("FROM public.candidate_elections AS candidate_election")) {
            return {
              rows: [
                {
                  candidate_id: CANDIDATE_ID,
                  election_id: ELECTION_ID,
                  candidate_name: "Aric Nesbitt",
                  election_year: 2026,
                  office_scope: "statewide",
                  office_name: "Governor",
                  district: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO public.mi_candidate_finance_links")) {
            return { rows: [{ id: "link-1" }], rowCount: 1 };
          }
          if (text.includes("FROM public.mi_candidate_finance_links AS link")) {
            return {
              rows: [
                dueRow({
                  candidate_name: "Aric Nesbitt",
                  election_year: 2026,
                  committee_id: "521877",
                  committee_name: "ARIC NESBITT FOR GOVERNOR",
                  source_url: null,
                }),
              ],
              rowCount: 1,
            };
          }
          throw new Error(`Unexpected query: ${text}`);
        }),
      };
      const syncMichiganCandidateFinanceFn = vi.fn().mockResolvedValue({ ok: true });

      const result = await syncDueMichiganCandidateFinance({
        db,
        syncMichiganCandidateFinanceFn,
        mitnPublicSearchFetchFn: fetchFn,
        currentContributionRowsFn: vi.fn(async (input) => input.rawRows),
        fetchIndependentExpenditureRowsFn: vi.fn().mockRejectedValue(new Error("Michigan MiTN IE export failed: status 503")),
        fetchCommitteeRegistryForNamesFn: vi.fn().mockResolvedValue([]),
        now: new Date("2026-07-26T00:00:00.000Z"),
      });

      // auto-link wrote the public-search link
      const insertCall = db.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO public.mi_candidate_finance_links")
      );
      expect(insertCall?.[1]).toContain("mitn_public_search");

      // the sync consumed export-mapped rows with a trusted committee and no expenditures
      expect(syncMichiganCandidateFinanceFn).toHaveBeenCalledWith(
        expect.objectContaining({
          electionYear: 2026,
          trustedCommittee: expect.objectContaining({ committeeId: "521877" }),
          linkSource: "mitn_public_search",
          // one export per cycle statement year (2025 + 2026), mapped rows
          contributionRows: expect.arrayContaining([
            expect.objectContaining({
              cfr_com_id: "521877",
              com_type: "CAN",
              amount: "1000.00",
              received_date: "06/24/2026",
            }),
          ]),
        })
      );
      // expenditureRows must be OMITTED — a defined array (even empty) marks
      // outside data available and would persist $0 totals
      expect("expenditureRows" in syncMichiganCandidateFinanceFn.mock.calls[0]![0]).toBe(false);
      const exportYears = fetchFn.mock.calls
        .filter(([url]) => String(url).includes("page.miboeContributionPublicSearch") && String(url).includes("action=export"))
        .map(([, init]) => new URLSearchParams((init as { body: string }).body).get("form.campaignStatementYear"));
      expect(exportYears.sort()).toEqual(["69", "76"]);
      expect(result.syncedCandidateCount).toBe(1);
      expect(result.outsideSpendingFetchErrors).toEqual({ "2026": "Michigan MiTN IE export failed: status 503" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails loudly when a cycle statement-year id is unknown instead of writing zeros", async () => {
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED", "true");
    try {
      const db = {
        query: vi.fn(async (sql: string) => {
          const text = String(sql);
          if (text.includes("FROM public.candidate_elections AS candidate_election")) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes("FROM public.mi_candidate_finance_links AS link")) {
            return {
              rows: [dueRow({ election_year: 2028, committee_id: "521877", source_url: null })],
              rowCount: 1,
            };
          }
          throw new Error(`Unexpected query: ${text}`);
        }),
      };
      const syncMichiganCandidateFinanceFn = vi.fn();

      const result = await syncDueMichiganCandidateFinance({
        db,
        syncMichiganCandidateFinanceFn,
        mitnPublicSearchFetchFn: vi.fn(),
        now: new Date("2028-06-01T00:00:00.000Z"),
      });

      expect(syncMichiganCandidateFinanceFn).not.toHaveBeenCalled();
      expect(result.failedCandidateCount).toBe(1);
      expect(result.results[0]?.error).toContain("No Michigan MiTN statement-year id for 2027");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails syncs loudly when the MiTN fetch flag is off", async () => {
    vi.stubEnv("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED", "false");
    try {
      const fetchFn = vi.fn();
      const db = {
        query: vi.fn(async (sql: string) => {
          const text = String(sql);
          if (text.includes("FROM public.candidate_elections AS candidate_election")) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes("FROM public.mi_candidate_finance_links AS link")) {
            return {
              rows: [dueRow({ election_year: 2026, committee_id: "521877", source_url: null })],
              rowCount: 1,
            };
          }
          throw new Error(`Unexpected query: ${text}`);
        }),
      };
      const syncMichiganCandidateFinanceFn = vi.fn();

      const result = await syncDueMichiganCandidateFinance({
        db,
        syncMichiganCandidateFinanceFn,
        mitnPublicSearchFetchFn: fetchFn,
        now: new Date("2026-07-26T00:00:00.000Z"),
      });

      expect(fetchFn).not.toHaveBeenCalled();
      expect(syncMichiganCandidateFinanceFn).not.toHaveBeenCalled();
      expect(result.failedCandidateCount).toBe(1);
      expect(result.results[0]?.error).toContain("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses pre-MiTN election years now that the archive path is removed", async () => {
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED", "true");
    try {
      const fetchFn = vi.fn();
      const db = {
        query: vi.fn(async (sql: string) => {
          const text = String(sql);
          if (text.includes("FROM public.candidate_elections AS candidate_election")) {
            return {
              rows: [
                {
                  candidate_id: CANDIDATE_ID,
                  election_id: ELECTION_ID,
                  candidate_name: "Gretchen Whitmer",
                  election_year: 2022,
                  office_scope: "statewide",
                  office_name: "Governor",
                  district: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes("FROM public.mi_candidate_finance_links AS link")) {
            return {
              rows: [dueRow({ candidate_name: "Gretchen Whitmer", election_year: 2022, committee_id: "514456" })],
              rowCount: 1,
            };
          }
          throw new Error(`Unexpected query: ${text}`);
        }),
      };
      const syncMichiganCandidateFinanceFn = vi.fn();

      const result = await syncDueMichiganCandidateFinance({
        db,
        syncMichiganCandidateFinanceFn,
        mitnPublicSearchFetchFn: fetchFn,
        now: new Date("2022-06-01T00:00:00.000Z"),
      });

      // no MiTN network call, no link insert, no sync — a loud refusal instead
      expect(fetchFn).not.toHaveBeenCalled();
      expect(syncMichiganCandidateFinanceFn).not.toHaveBeenCalled();
      expect(
        db.query.mock.calls.map((call) => String(call[0])).some((sql) => sql.includes("INSERT INTO"))
      ).toBe(false);
      expect(result.failedCandidateCount).toBe(1);
      expect(result.results[0]?.error).toContain("predates MiTN public-search coverage");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not auto-link missing finance links during dry-run", async () => {
    const db = createMockDb();

    await syncDueMichiganCandidateFinance({
      db,
      dryRun: true,
      syncMichiganCandidateFinanceFn: vi.fn(),
      now: new Date("2026-07-26T00:00:00.000Z"),
    });

    // dry-run skips the auto-link block entirely: the first (and only) query
    // is the due-row listing, and nothing is inserted
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.mi_candidate_finance_links AS link");
  });



  it("includes active target committees beyond the selected due-link limit", async () => {
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED", "true");
    try {
      const db = { query: vi.fn()
        .mockResolvedValueOnce({ rows: [dueRow()] })
        .mockResolvedValueOnce({ rows: [
          dueRow(), dueRow({ committee_id: "600002", committee_name: "Friends of Aric Nesbitt" }),
        ] }) };
      const empty = buildMitnExportXlsx([]);
      const syncFn = vi.fn().mockResolvedValue({});
      const registryFn = vi.fn(async (input: { names: readonly string[] }) =>
        input.names.map((name) => ({ committeeId: name === "Friends of Aric Nesbitt" ? "600002" : "521877",
          committeeName: name, committeeType: "Candidate", status: "Active" })));
      await syncDueMichiganCandidateFinance({
        db, autoLinkMissingLinks: false, maxCandidates: 1,
        mitnPublicSearchFetchFn: vi.fn().mockResolvedValue({
          ok: true, status: 200, text: async () => "",
          arrayBuffer: async () => empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength),
        }),
        fetchIndependentExpenditureRowsFn: vi.fn().mockResolvedValue([
          { target_committee_name: "ARIC NESBITT FOR GOVERNOR" },
          { target_committee_name: "Friends of Aric Nesbitt" },
        ]),
        fetchCommitteeRegistryForNamesFn: registryFn, syncMichiganCandidateFinanceFn: syncFn,
      });
      expect(syncFn.mock.calls[0]![0].outsideTargetCommitteeNames).toEqual([
        "ARIC NESBITT FOR GOVERNOR", "Friends of Aric Nesbitt",
      ]);
      expect(String(db.query.mock.calls[1]![0])).toContain("link.link_status = 'active'");
    } finally { vi.unstubAllEnvs(); }
  });

  it("fetches each outside cycle once and verifies exact candidate registry identity", async () => {
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED", "true");
    try {
      const db = createMockDb([dueRow(), dueRow({ election_id: "33333333-3333-4333-8333-333333333333" })]);
      const syncFn = vi.fn().mockResolvedValue({});
      const outsideFn = vi.fn().mockResolvedValue([{
        doc_seq_no: "26-1", doc_stmnt_year: "2026", doc_type_desc: "July CS",
        com_legal_name: "Outside PAC", common_name: "", cfr_com_id: "700",
        com_type: "IND", schedule_desc: "Independent Expenditures",
        supp_opp: "S", can_or_ballot: "Candidate", _column_29: "", amount: "1000.00",
        target_committee_name: "ARIC NESBITT FOR GOVERNOR", target_office: "Governor",
      }]);
      const registryFn = vi.fn().mockResolvedValue([{
        committeeId: "0521877", committeeName: "ARIC NESBITT FOR GOVERNOR",
        committeeType: "Candidate", status: "Active",
      }]);
      const empty = buildMitnExportXlsx([]);
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true, status: 200, text: async () => "",
        arrayBuffer: async () => empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength),
      });
      const result = await syncDueMichiganCandidateFinance({
        db, autoLinkMissingLinks: false, mitnPublicSearchFetchFn: fetchFn,
        fetchIndependentExpenditureRowsFn: outsideFn, fetchCommitteeRegistryForNamesFn: registryFn,
        syncMichiganCandidateFinanceFn: syncFn, rawDataCacheDir: "/explicit/test-cache",
        refreshSupplementalData: true,
      });
      expect(outsideFn).toHaveBeenCalledTimes(1);
      expect(outsideFn).toHaveBeenCalledWith(expect.objectContaining({
        statementYears: [2025, 2026], rawCacheDir: "/explicit/test-cache", refresh: true,
      }));
      expect(registryFn).toHaveBeenCalledTimes(1);
      expect(syncFn).toHaveBeenCalledTimes(2);
      expect(syncFn.mock.calls[0]![0]).toMatchObject({
        outsideTargetCommitteeName: "ARIC NESBITT FOR GOVERNOR",
        expenditureRows: expect.any(Array),
        committeeRegistryRows: [],
      });
      expect(result.outsideSpendingFetchedYears).toEqual([2026]);
      expect(result.outsideSpendingFetchErrors).toEqual({});
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps receipts syncing and omits outside data when acquisition fails", async () => {
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED", "true");
    try {
      const empty = buildMitnExportXlsx([]);
      const syncFn = vi.fn().mockResolvedValue({});
      const result = await syncDueMichiganCandidateFinance({
        db: createMockDb([dueRow()]), autoLinkMissingLinks: false,
        mitnPublicSearchFetchFn: vi.fn().mockResolvedValue({
          ok: true, status: 200, text: async () => "",
          arrayBuffer: async () => empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength),
        }),
        fetchIndependentExpenditureRowsFn: vi.fn().mockRejectedValue(new Error("outside source HTTP 503")),
        syncMichiganCandidateFinanceFn: syncFn,
      });
      expect(result.syncedCandidateCount).toBe(1);
      expect(result.outsideSpendingFetchErrors).toEqual({ "2026": "outside source HTTP 503" });
      expect(syncFn.mock.calls[0]![0]).not.toHaveProperty("expenditureRows");
    } finally { vi.unstubAllEnvs(); }
  });

  it("preserves outside data for an ambiguous or wrong target registry identity", async () => {
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED", "true");
    try {
      const empty = buildMitnExportXlsx([]);
      const syncFn = vi.fn().mockResolvedValue({});
      const result = await syncDueMichiganCandidateFinance({
        db: createMockDb([dueRow()]), autoLinkMissingLinks: false,
        mitnPublicSearchFetchFn: vi.fn().mockResolvedValue({
          ok: true, status: 200, text: async () => "",
          arrayBuffer: async () => empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength),
        }),
        fetchIndependentExpenditureRowsFn: vi.fn().mockResolvedValue([{
          target_committee_name: "ARIC NESBITT FOR GOVERNOR",
        }]),
        fetchCommitteeRegistryForNamesFn: vi.fn().mockResolvedValue([{
          committeeId: "999999", committeeName: "ARIC NESBITT FOR GOVERNOR",
          committeeType: "Candidate", status: "Active",
        }]),
        syncMichiganCandidateFinanceFn: syncFn,
      });
      expect(syncFn.mock.calls[0]![0]).not.toHaveProperty("expenditureRows");
      expect(result.outsideSpendingFetchErrors?.["2026:521877"]).toContain("unique candidate registry match");
      expect(result.syncedCandidateCount).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it("validates positive integer options", async () => {
    const db = createMockDb();

    await expect(
      syncDueMichiganCandidateFinance({
        db,
        maxCandidates: 0,
        autoLinkMissingLinks: false,
      })
    ).rejects.toThrow("Invalid Michigan finance batch sync maxCandidates");
    await expect(
      syncDueMichiganCandidateFinance({
        db,
        staleAfterDays: -1,
        autoLinkMissingLinks: false,
      })
    ).rejects.toThrow("Invalid Michigan finance batch sync staleAfterDays");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listDueDcCommitteeFinance,
  syncDueDcCommitteeFinance,
} from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeBatchSync.js";
import * as sourceModule from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeSource.js";
import * as storeModule from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeStore.js";
import * as batchModule from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeBatchSync.js";
import { syncDueDistrictOfColumbiaCandidateFinance } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaCandidateFinanceBatchSync.js";
import { runDcCommitteeFinanceCli } from "../../../src/scripts/syncDueDcCommitteeFinance.js";
import { receiver } from "./dcCommitteeSynthetic.js";
beforeEach(() => {
  vi.stubEnv("DISTRICT_OF_COLUMBIA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("DISTRICT_OF_COLUMBIA_REPORTED_COMMITTEE_ENABLED", "true");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("DC independent ordinary committee batch", () => {
  it("is default-off and never queries while disabled", async () => {
    vi.stubEnv("DISTRICT_OF_COLUMBIA_REPORTED_COMMITTEE_ENABLED", "false");
    const query = vi.fn(),
      connect = vi.fn();
    expect(
      (await syncDueDcCommitteeFinance({ db: { query, connect } as never }))
        .enabled,
    ).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it("selects the ordinary 25 fairly and includes post-election losers for 98 days", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
        ...receiver,
        linkId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      })),
      query = vi.fn(async () => ({ rows }));
    const due = await listDueDcCommitteeFinance({ db: { query } as never });
    expect(due.totalDueRows).toBe(30);
    expect(due.rows).toHaveLength(25);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("a.last_attempted_at ASC NULLS FIRST");
    expect(sql).toContain("interval '24 hours'");
    expect(sql).toContain("receiver_context IS DISTINCT FROM");
    expect(params[2]).toBe(98);
    expect(params[4]).toBe(7);
    expect(sql).not.toContain("is_winner");
  });
  it("dry runs perform no source or transaction work", async () => {
    const query = vi.fn(async () => ({ rows: [receiver] })),
      connect = vi.fn(),
      fetchSource = vi.spyOn(sourceModule, "getDcCommitteeSource");
    const r = await syncDueDcCommitteeFinance({
      db: { query, connect } as never,
      dryRun: true,
    });
    expect(r.selectedCandidates).toBe(1);
    expect(r.attemptedComponents).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSource).not.toHaveBeenCalled();
  });
  it("continues other receivers after failure and shares one acquisition per year", async () => {
    const second = {
      ...receiver,
      linkId: "00000000-0000-4000-8000-000000000004",
    };
    const query = vi.fn(async () => ({ rows: [receiver, second] }));
    const connectionQuery = vi.fn(async (sql: string, args?: unknown[]) =>
      sql.startsWith("SELECT l.id")
        ? { rows: [args?.[1] === receiver.linkId ? receiver : second] }
        : sql.startsWith("SELECT candidate_id")
          ? {
              rows: [
                { candidate_id: receiver.candidateId, link_status: "active" },
              ],
            }
          : { rows: [] },
    );
    const db = {
      query,
      connect: vi.fn(async () => ({
        query: connectionQuery,
        release: vi.fn(),
      })),
    };
    const fetchSource = vi
        .spyOn(sourceModule, "getDcCommitteeSource")
        .mockResolvedValue({} as never),
      write = vi
        .spyOn(storeModule, "writeDcCommitteeComponent")
        .mockRejectedValueOnce(Error("synthetic failure"))
        .mockResolvedValueOnce({ groups: 3, idempotent: false });
    const r = await syncDueDcCommitteeFinance({ db: db as never });
    expect(r.heldComponents).toBe(1);
    expect(r.writtenComponents).toBe(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(fetchSource).toHaveBeenCalledOnce();
    expect(fetchSource).toHaveBeenCalledWith({
      year: 2026,
      cacheDir: undefined,
      refresh: undefined,
    });
  });
  it("runs committee work even when legacy acquisition fails", async () => {
    const own = vi
      .spyOn(batchModule, "syncDueDcCommitteeFinance")
      .mockResolvedValue({
        enabled: true,
        dryRun: false,
        totalDueRows: 1,
        selectedCandidates: 1,
        attemptedComponents: 1,
        writtenComponents: 1,
        idempotentComponents: 0,
        heldComponents: 0,
        groups: 1,
        holds: {},
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Error("synthetic legacy acquisition unavailable");
      }),
    );
    try {
      const query = vi.fn(async () => ({
        rows: [
          {
            candidate_id: receiver.candidateId,
            election_id: receiver.electionId,
            candidate_name: "Jordan Example",
            election_year: 2026,
            office_scope: "place",
            office_name: "Mayor",
            district: null,
            committee_key: receiver.receivingKey,
            committee_name: receiver.legacyCommitteeName,
            source_url: null,
            last_synced_at: null,
            total_due_rows: "1",
          },
        ],
      }));
      const r = await syncDueDistrictOfColumbiaCandidateFinance({
        db: { query, connect: vi.fn() } as never,
        autoLinkMissingLinks: false,
      });
      expect(own).toHaveBeenCalledOnce();
      expect(r.reportedCommittees?.writtenComponents).toBe(1);
      expect(r.failedCandidateCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("requires the ordinary recurring-sync gate and rejects misspelled overrides", async () => {
    vi.stubEnv("DISTRICT_OF_COLUMBIA_CAMPAIGN_FINANCE_SYNC_ENABLED", "false");
    const query = vi.fn();
    expect(await runDcCommitteeFinanceCli([], { query } as never)).toEqual({
      enabled: false,
    });
    expect(query).not.toHaveBeenCalled();
    await expect(
      runDcCommitteeFinanceCli(["--candidate-id", "synthetic"], {
        query,
      } as never),
    ).rejects.toThrow();
  });
});

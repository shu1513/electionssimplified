import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  candidateElectionKey,
  type BallotLookupFinanceSummary,
} from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { replaceMarylandIndependentOutsideSnapshot } from "../../../src/pipeline/marylandFinance/marylandIndependentOutsideWriter.js";
import { attachMarylandIndependentOutsideFinance } from "../../../src/pipeline/marylandFinance/marylandIndependentOutsideReader.js";
import { qualifyMarylandIndependentOutside } from "../../../src/pipeline/marylandFinance/marylandIndependentOutsideQualification.js";
import {
  fixture,
  id,
  owner,
} from "./marylandIndependentOutsideTestFixtures.js";
function snapshot() {
  const f = fixture();
  return {
    context: f.context,
    ...qualifyMarylandIndependentOutside(f),
    targetAccountGuids: [owner],
    sourceObservedAt: "2026-10-26T00:00:00.000Z",
    generationDirectory: "/private/synthetic/generation",
    nativeDirectory: "/private/synthetic/native",
  };
}
function writer(
  options: {
    contextChanged?: boolean;
    older?: boolean;
    insertFails?: boolean;
    rollbackError?: unknown;
  } = {},
) {
  const s = snapshot(),
    c = s.context,
    release = vi.fn(),
    insertError = Error("synthetic_insert_failure");
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && "rollbackError" in options) throw options.rollbackError;
    if (sql.includes("SELECT c.display_name"))
      return {
        rows: [
          {
            display_name: options.contextChanged ? "Changed" : c.candidateName,
            party: c.party,
            scope: c.officeScope,
            canonical_name: c.officeName,
            geoid_compact: c.districtGeoidCompact,
            election_date: c.electionDate,
            election_stage: c.electionStage,
          },
        ],
      };
    if (sql.includes("SELECT candidate_id"))
      return { rows: options.older ? [{ candidate_id: c.candidateId }] : [] };
    if (
      options.insertFails &&
      sql.includes("INSERT INTO public.md_candidate_finance_ie_groups")
    )
      throw insertError;
    return { rows: [] };
  });
  const db = {
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as Pick<Pool, "connect">;
  return { s, db, query, release, insertError };
}
function stored(n = 1) {
  const s = snapshot();
  return Array.from({ length: n }, (_, i) => ({
    candidate_id: s.context.candidateId,
    election_id: s.context.electionId,
    election_year: 2026,
    support_cents: String(n * 100),
    oppose_cents: "0",
    group_count: n,
    allocation_count: n,
    source_observed_at: s.sourceObservedAt,
    last_synced_at: "2026-10-26T00:01:00.000Z",
    financial_basis: "complete_native_ie_with_current_report_controls",
    payer_guid: id(i + 100),
    filing_entity_id: String(i + 1),
    committee_name: `Synthetic payer ${i}`,
    stance: "support",
    amount_cents: "100",
    source_url: "https://campaignfinance.maryland.gov/",
  }));
}
const request = () => [
  {
    candidate_id: snapshot().context.candidateId,
    election_id: snapshot().context.electionId,
  },
];
const key = () =>
  candidateElectionKey(
    snapshot().context.candidateId,
    snapshot().context.electionId,
  );
describe("Maryland independent outside store boundaries", () => {
  it("replaces its own complete source and groups atomically after canonical locking", async () => {
    const t = writer();
    await expect(
      replaceMarylandIndependentOutsideSnapshot({
        db: t.db,
        snapshot: t.s,
        syncedAt: new Date("2026-10-26T00:01:00Z"),
      }),
    ).resolves.toMatchObject({ groupsWritten: 1 });
    const sql = t.query.mock.calls.map((c) => c[0]);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql[1]).toContain("FOR UPDATE OF ce,c,e");
    expect(t.release).toHaveBeenCalledOnce();
    expect(
      sql
        .filter((s) => /INSERT|DELETE/.test(s))
        .every((s) => s.includes("md_candidate_finance_ie_")),
    ).toBe(true);
  });
  it.each(["contextChanged", "older", "insertFails"] as const)(
    "rolls back on %s without advancing source freshness",
    async (kind) => {
      const t = writer({ [kind]: true });
      await expect(
        replaceMarylandIndependentOutsideSnapshot({
          db: t.db,
          snapshot: t.s,
          syncedAt: new Date("2026-10-26T00:01:00Z"),
        }),
      ).rejects.toThrow();
      expect(t.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
      expect(t.query.mock.calls.some((c) => c[0] === "COMMIT")).toBe(false);
      expect(t.release).toHaveBeenCalledOnce();
    },
  );
  it.each([Error("synthetic_rollback_failure"), "synthetic_rollback_failure"])(
    "keeps the original write error and discards the client when rollback fails (%s)",
    async (rollbackError) => {
      const t = writer({ insertFails: true, rollbackError });
      await expect(replaceMarylandIndependentOutsideSnapshot({
        db: t.db, snapshot: t.s, syncedAt: new Date("2026-10-26T00:01:00Z"),
      })).rejects.toBe(t.insertError);
      expect(t.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
      expect(t.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
      expect(t.release).toHaveBeenCalledOnce();
      const releasedError = t.release.mock.calls[0]![0];
      expect(releasedError).toBeInstanceOf(Error);
      expect(releasedError.message).toBe("synthetic_rollback_failure");
      if (rollbackError instanceof Error) expect(releasedError).toBe(rollbackError);
    },
  );
  it("returns a successfully rolled-back client without marking it broken", async () => {
    const t = writer({ insertFails: true });
    await expect(replaceMarylandIndependentOutsideSnapshot({
      db: t.db, snapshot: t.s, syncedAt: new Date("2026-10-26T00:01:00Z"),
    })).rejects.toBe(t.insertError);
    expect(t.release).toHaveBeenCalledOnce();
    expect(t.release).toHaveBeenCalledWith(undefined);
  });
  it("rejects mismatched uncapped sums before opening a transaction", async () => {
    const t = writer();
    t.s.supportCents++;
    await expect(
      replaceMarylandIndependentOutsideSnapshot({ db: t.db, snapshot: t.s }),
    ).rejects.toThrow();
    expect(t.db.connect).not.toHaveBeenCalled();
  });
  it("creates an IE-only summary for an unlinked candidate and validates every group before display cap", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: stored(60) })),
    } as unknown as Pick<Pool, "query">;
    const result = await attachMarylandIndependentOutsideFinance({
      db,
      requests: request(),
      summaries: new Map(),
    });
    const summary = result.get(key())!;
    expect(summary.direct_campaign.total_raised).toBeNull();
    expect(summary.controlled_committee_id).toBeNull();
    expect(summary.outside_spending.support_total).toBe(60);
    expect(summary.outside_spending.top_supporting_groups).toHaveLength(5);
  });
  it("preserves existing direct and donor components and their older freshness", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: stored() })),
    } as unknown as Pick<Pool, "query">;
    const initial = await attachMarylandIndependentOutsideFinance({
      db,
      requests: request(),
      summaries: new Map(),
    });
    const existing = initial.get(key())!;
    existing.direct_campaign.total_raised = 123;
    existing.last_synced_at = "2026-10-01T00:00:00.000Z";
    existing.direct_campaign.top_industries = [
      { industry: "Synthetic sector", amount: 12 } as never,
    ];
    const before = structuredClone(existing);
    const result = await attachMarylandIndependentOutsideFinance({
      db,
      requests: request(),
      summaries: initial,
    });
    expect(result.get(key())!.direct_campaign).toEqual(before.direct_campaign);
    expect(result.get(key())!.last_synced_at).toBe(before.last_synced_at);
    expect(existing).toEqual(before);
  });
  it.each([Error("synthetic_query_failure"), "synthetic_query_failure"])(
    "logs query failures without replacing existing summaries (%s)",
    async (error) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const existing = { source: "MARYLAND_CFS", cycle: 2026 } as BallotLookupFinanceSummary;
      const summaries = new Map([[key(), existing]]);
      const db = { query: vi.fn().mockRejectedValue(error) } as unknown as Pick<Pool, "query">;
      const result = await attachMarylandIndependentOutsideFinance({ db, summaries, requests: request() });
      expect(result).toBe(summaries);
      expect(result.get(key())).toBe(existing);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "Maryland independent outside finance query failed; keeping existing summaries:",
        "synthetic_query_failure",
      );
    },
  );
  it("logs a held candidate while continuing to attach other valid candidates", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = stored();
    bad[0]!.support_cents = "101";
    const good = stored().map(row => ({ ...row, candidate_id: id(999) }));
    const goodKey = candidateElectionKey(id(999), good[0]!.election_id);
    const existing = { source: "MARYLAND_CFS", cycle: 2026 } as BallotLookupFinanceSummary;
    const summaries = new Map([[key(), existing]]);
    const db = { query: vi.fn().mockResolvedValue({ rows: [...bad, ...good] }) } as unknown as Pick<Pool, "query">;
    const result = await attachMarylandIndependentOutsideFinance({
      db, summaries, requests: [...request(), { candidate_id: id(999), election_id: good[0]!.election_id }],
    });
    expect(result.get(key())).toBe(existing);
    expect(result.get(goodKey)!.outside_spending.support_total).toBe(1);
    expect(summaries.has(goodKey)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      `Maryland independent outside finance held for ${key()}:`, "outside_group_totals_mismatch",
    );
  });
  it.each(["bad_last_group", "bad_total", "wrong_basis", "future_clock"])(
    "holds malformed %s even outside display cap",
    async (kind) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const rows = stored(60);
      if (kind === "bad_last_group") rows.at(-1)!.amount_cents = "-1";
      if (kind === "bad_total") rows[0]!.support_cents = "1";
      if (kind === "wrong_basis") rows[0]!.financial_basis = "unknown";
      if (kind === "future_clock")
        rows[0]!.source_observed_at = "2027-01-01T00:00:00Z";
      const existing = {
          source: "MARYLAND_CFS",
          cycle: 2026,
        } as BallotLookupFinanceSummary,
        summaries = new Map([[key(), existing]]),
        db = { query: vi.fn(async () => ({ rows })) } as unknown as Pick<
          Pool,
          "query"
        >;
      expect(
        (
          await attachMarylandIndependentOutsideFinance({
            db,
            requests: request(),
            summaries,
          })
        ).get(key()),
      ).toBe(existing);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        `Maryland independent outside finance held for ${key()}:`, expect.stringMatching(/\S/),
      );
    },
  );
});

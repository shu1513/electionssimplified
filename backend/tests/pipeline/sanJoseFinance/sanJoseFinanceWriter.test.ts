import { describe, expect, it, vi } from "vitest";
import {
  replaceSanJoseCandidateFinanceSnapshot,
  upsertSanJoseFinanceLink,
} from "../../../src/pipeline/sanJoseFinance/sanJoseFinanceWriter.js";

// A query mock that answers the link INSERT with an id and everything else
// with empty rows — the writer's control flow (manual SELECT, deactivate
// UPDATE, detail deletes/inserts) all tolerate empty results.
function queryMock(overrides?: (sql: string) => { rows: unknown[] } | null) {
  return vi.fn().mockImplementation((sql: unknown) => {
    const s = String(sql);
    const override = overrides?.(s);
    if (override) return Promise.resolve(override);
    if (s.startsWith("INSERT INTO public.sjc_candidate_finance_links"))
      return Promise.resolve({ rows: [{ id: "link-1" }] });
    return Promise.resolve({ rows: [] });
  });
}

const link = {
  candidateId: "c",
  electionId: "e",
  electionYear: 2026,
  candidateNameNormalized: "BIEN DOAN",
  fppcId: "1484291",
  committeeName: "Bien Doan for City Council 2026",
};

const summary = {
  totalRaisedCents: 11712537,
  totalSpentCents: 10890571,
  cashOnHandCents: 3266866,
  debtsOwedCents: 0,
  loansReceivedCents: 2000000,
  outsideSupportCents: 10124954,
  outsideOpposeCents: 0,
  directCoverageNote: null,
  methodologyVersion: "sj-cal-v1",
  sourceUrl: "https://efile.sanjoseca.gov",
  reportedThrough: "2026-06-30",
};

describe("San José finance writer", () => {
  it("writes a full snapshot in one transaction with exact dollar strings", async () => {
    const query = queryMock();
    const release = vi.fn();
    const db = { connect: vi.fn().mockResolvedValue({ query, release }) };
    await replaceSanJoseCandidateFinanceSnapshot({
      db: db as never,
      link,
      summary,
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Retired",
          amountCents: 123456,
          contributorCount: 7,
        },
      ],
      outsideGroups: [
        {
          spenderFilerId: "1487288",
          spenderName: "SOME IE COMMITTEE",
          supportOppose: "support",
          amountCents: 10124954,
          expenditureCount: 12,
        },
      ],
    });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sjc_candidate_finance_summaries"),
        expect.stringContaining(
          "DELETE FROM public.sjc_candidate_finance_direct_breakdowns",
        ),
        expect.stringContaining(
          "DELETE FROM public.sjc_candidate_finance_outside_groups",
        ),
      ]),
    );
    const summaryCall = query.mock.calls.find((call) =>
      String(call[0]).includes("sjc_candidate_finance_summaries"),
    );
    // Cents → exact dollar strings, never floats: raised, spent, cash, loans.
    expect(summaryCall?.[1]).toEqual(
      expect.arrayContaining(["117125.37", "108905.71", "32668.66", "20000.00"]),
    );
    expect(release).toHaveBeenCalled();
  });

  it("passes negative cash on hand through as a signed balance", async () => {
    const query = queryMock();
    const db = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    await replaceSanJoseCandidateFinanceSnapshot({
      db: db as never,
      link,
      summary: { ...summary, cashOnHandCents: -4200 },
      directBreakdowns: [],
      outsideGroups: [],
    });
    const summaryCall = query.mock.calls.find((call) =>
      String(call[0]).includes("sjc_candidate_finance_summaries"),
    );
    expect(summaryCall?.[1]).toEqual(expect.arrayContaining(["-42.00"]));
  });

  it("rejects a negative flow and rolls the snapshot back", async () => {
    const query = queryMock();
    const release = vi.fn();
    const db = { connect: vi.fn().mockResolvedValue({ query, release }) };
    await expect(
      replaceSanJoseCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary: { ...summary, totalRaisedCents: -1 },
        directBreakdowns: [],
        outsideGroups: [],
      }),
    ).rejects.toThrow(/total raised must be nonnegative/);
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalled();
  });

  it("rejects non-integer cents", async () => {
    const db = {
      connect: vi
        .fn()
        .mockResolvedValue({ query: queryMock(), release: vi.fn() }),
    };
    await expect(
      replaceSanJoseCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary: { ...summary, totalSpentCents: 100.5 },
        directBreakdowns: [],
        outsideGroups: [],
      }),
    ).rejects.toThrow(/total spent must be integer cents/);
  });

  it('never links the "Pending" placeholder filer id, in any casing', async () => {
    // Live data says "Pending", but an upstream re-casing must still fail
    // loudly here rather than store a placeholder as a durable identity.
    for (const fppcId of ["Pending", "PENDING", "pending", " Pending "]) {
      await expect(
        upsertSanJoseFinanceLink({
          db: { query: queryMock() } as never,
          link: { ...link, fppcId },
        }),
      ).rejects.toThrow(/assigned FPPC id, not Pending/);
    }
  });

  it("reuses a matching protected manual link and advances last_verified_at", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_id")
        ? {
            rows: [
              { id: "manual-1", fppc_id: "1484291", link_status: "active" },
            ],
          }
        : null,
    );
    const verifiedAt = new Date("2026-08-11T00:00:00Z");
    const result = await upsertSanJoseFinanceLink({
      db: { query } as never,
      link: { ...link, linkSource: "efile_export", lastVerifiedAt: verifiedAt },
    });
    expect(result.linkId).toBe("manual-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    // Only the manual probe and the last_verified_at touch — never an INSERT
    // that would rewrite the operator's row.
    expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
    const touch = query.mock.calls.find((call) =>
      String(call[0]).includes("SET last_verified_at"),
    );
    expect(touch?.[1]).toEqual(["manual-1", verifiedAt.toISOString()]);
  });

  it("errors when an automatic link conflicts with a protected manual link", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_id")
        ? {
            rows: [
              { id: "manual-1", fppc_id: "1480385", link_status: "active" },
            ],
          }
        : null,
    );
    await expect(
      upsertSanJoseFinanceLink({
        db: { query } as never,
        link: { ...link, linkSource: "efile_export" },
      }),
    ).rejects.toThrow(/conflicts with protected manual link/);
  });

  it("never resurrects an operator-disabled manual link with the same filer id", async () => {
    // The disabled manual row is the ON CONFLICT target — without the
    // any-status probe the upsert would silently flip it back to
    // active/efile_export.
    for (const linkStatus of ["inactive", "needs_review"]) {
      const query = queryMock((sql) =>
        sql.startsWith("SELECT id::text,fppc_id")
          ? {
              rows: [
                { id: "manual-1", fppc_id: "1484291", link_status: linkStatus },
              ],
            }
          : null,
      );
      await expect(
        upsertSanJoseFinanceLink({
          db: { query } as never,
          link: { ...link, linkSource: "efile_export" },
        }),
      ).rejects.toThrow(/matches an operator-disabled manual link/);
      const sql = query.mock.calls.map((call) => String(call[0]));
      expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
      expect(sql.some((s) => s.includes("SET last_verified_at"))).toBe(false);
    }
  });

  it("allows a new automatic identity past a disabled manual link with a different fppc id", async () => {
    // The operator disabled that association, not the candidate.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_id")
        ? {
            rows: [
              { id: "manual-1", fppc_id: "1480385", link_status: "inactive" },
            ],
          }
        : null,
    );
    const result = await upsertSanJoseFinanceLink({
      db: { query } as never,
      link: { ...link, linkSource: "efile_export" },
    });
    expect(result.linkId).toBe("link-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(
      sql.some((s) =>
        s.startsWith("INSERT INTO public.sjc_candidate_finance_links"),
      ),
    ).toBe(true);
  });

  it("deactivates other automatic links before an active upsert", async () => {
    const query = queryMock();
    await upsertSanJoseFinanceLink({ db: { query } as never, link });
    const deactivate = query.mock.calls.find((call) =>
      String(call[0]).includes("SET link_status='inactive'"),
    );
    expect(String(deactivate?.[0])).toContain("link_source<>'manual'");
    expect(deactivate?.[1]).toEqual(["c", "e", "1484291"]);
  });

  it("normalizes the fppc id before the manual probe, not only before the INSERT", async () => {
    // A padded id must still hit the disabled manual row in the probe —
    // otherwise it slips past, trims at the INSERT, and reaches the manual
    // row through ON CONFLICT.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_id")
        ? {
            rows: [
              { id: "manual-1", fppc_id: "1484291", link_status: "inactive" },
            ],
          }
        : null,
    );
    await expect(
      upsertSanJoseFinanceLink({
        db: { query } as never,
        link: { ...link, fppcId: " 1484291 ", linkSource: "efile_export" },
      }),
    ).rejects.toThrow(/matches an operator-disabled manual link/);
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("refuses to rewrite a manual row that appeared between the probe and the upsert", async () => {
    // The DO UPDATE's WHERE guard makes the write update nothing when the
    // conflict target turned manual after the probe — empty RETURNING must
    // throw, never silently resurrect.
    const query = queryMock((sql) =>
      sql.startsWith("INSERT INTO public.sjc_candidate_finance_links")
        ? { rows: [] }
        : null,
    );
    await expect(
      upsertSanJoseFinanceLink({
        db: { query } as never,
        link: { ...link, linkSource: "efile_export" },
      }),
    ).rejects.toThrow(/blocked by a concurrent protected manual link/);
    const insert = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.sjc_candidate_finance_links",
      ),
    );
    expect(String(insert?.[0])).toContain(
      "WHERE sjc_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual'",
    );
  });
});

const typedCash={officeName:"City Council Member" as const,seatNumber:8,receivingFppcId:link.fppcId,canonicalFilingCount:2,amountCents:10001,contributionCount:1,reportedThrough:summary.reportedThrough,donors:[{committeeKey:"id:2222222",committeeId:"2222222",committeeName:"Example Party",contributorType:"PTY" as const,amountCents:10001,contributionCount:1}]};
const typedInput={link,summary,directBreakdowns:[],outsideGroups:[]};
describe("San José atomic typed cash",()=>{
 it("writes source and all groups atomically in exact cents",async()=>{const query=queryMock(),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await replaceSanJoseCandidateFinanceSnapshot({...typedInput,db:db as never,committeeCash:typedCash});expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");const call=query.mock.calls.find(c=>String(c[0]).startsWith("INSERT INTO public.sjc_candidate_finance_pac_sources"));expect(call?.[1]).toHaveLength(11);expect(call?.[1]?.[4]).toBe("10001");});
 it.each(["amount","count","duplicate","scope","date","seat"])("holds bad %s before connecting",async kind=>{const value=structuredClone(typedCash);if(kind==="amount")value.amountCents++;if(kind==="count")value.contributionCount++;if(kind==="duplicate")value.donors.push({...value.donors[0]!});if(kind==="scope")value.receivingFppcId="3333333";if(kind==="date")value.reportedThrough="2026-02-30";if(kind==="seat")value.seatNumber=11;const db={connect:vi.fn()};await expect(replaceSanJoseCandidateFinanceSnapshot({...typedInput,db:db as never,committeeCash:value})).rejects.toThrow();expect(db.connect).not.toHaveBeenCalled();});
 it("locks matching manual/automatic links and rejects older observations before money writes",async()=>{const query=queryMock(sql=>sql.includes("observed_at >")?{rows:[{newer:true}]}:null),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await expect(replaceSanJoseCandidateFinanceSnapshot({...typedInput,db:db as never,committeeCash:typedCash})).rejects.toThrow(/Older/);const calls=query.mock.calls.map(c=>String(c[0]));expect(calls.at(-1)).toBe("ROLLBACK");expect(calls.some(c=>c.startsWith("INSERT INTO public.sjc_candidate_finance_summaries"))).toBe(false);});
 it("preserves prior cash evidence when optional component is omitted",async()=>{const query=queryMock(),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await replaceSanJoseCandidateFinanceSnapshot({...typedInput,db:db as never});expect(query.mock.calls.some(c=>String(c[0]).includes("finance_pac_"))).toBe(false);});
});

import { describe, expect, it, vi } from "vitest";
import {
  replaceSanDiegoCityCandidateFinanceSnapshot,
  upsertSanDiegoCityFinanceLink,
} from "../../../src/pipeline/sanDiegoCityFinance/sanDiegoCityFinanceWriter.js";

// A query mock that answers the link INSERT with an id and everything else
// with empty rows — the writer's control flow (manual SELECT, deactivate
// UPDATE, detail deletes/inserts) all tolerate empty results.
function queryMock(overrides?: (sql: string) => { rows: unknown[] } | null) {
  return vi.fn().mockImplementation((sql: unknown) => {
    const s = String(sql);
    const override = overrides?.(s);
    if (override) return Promise.resolve(override);
    if (s.startsWith("INSERT INTO public.sdcity_candidate_finance_links"))
      return Promise.resolve({ rows: [{ id: "link-1" }] });
    return Promise.resolve({ rows: [] });
  });
}

// Phase 0 probe fixture: Antonio Martinez's council committee (FPPC 1460125),
// cycle totals verified cent-exact against the live 2025+2026 workbooks —
// including the cross-year spend (Σ line 11A, never Σ yearly 11B).
const link = {
  candidateId: "c",
  electionId: "e",
  electionYear: 2026,
  candidateNameNormalized: "ANTONIO MARTINEZ",
  fppcId: "1460125",
  committeeName: "Antonio Martinez for City Council 2026",
};

const summary = {
  totalRaisedCents: 9767034,
  totalSpentCents: 12157679,
  cashOnHandCents: 1131522,
  debtsOwedCents: 140783,
  loansReceivedCents: 0,
  outsideSupportCents: 0,
  outsideOpposeCents: 0,
  directCoverageNote:
    "Committee activity before 2025 is not covered by the electronic filings.",
  outsideCoverageNote:
    "Outside spending combines e-filed Form 496 and Schedule D reports; paper filings are not included.",
  methodologyVersion: "sd-cal-v1",
  sourceUrl: "https://efile.sandiego.gov",
  reportedThrough: "2026-06-30",
};

describe("San Diego city finance writer", () => {
  it("writes a full snapshot in one transaction with exact dollar strings", async () => {
    const query = queryMock();
    const release = vi.fn();
    const db = { connect: vi.fn().mockResolvedValue({ query, release }) };
    await replaceSanDiegoCityCandidateFinanceSnapshot({
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
          spenderFilerId: "1490398",
          spenderName: "WORKING FAMILIES SUPPORTING GERARDO RAMIREZ",
          supportOppose: "support",
          amountCents: 19593471,
          expenditureCount: 11,
        },
      ],
    });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sdcity_candidate_finance_summaries"),
        expect.stringContaining(
          "DELETE FROM public.sdcity_candidate_finance_direct_breakdowns",
        ),
        expect.stringContaining(
          "DELETE FROM public.sdcity_candidate_finance_outside_groups",
        ),
      ]),
    );
    const summaryCall = query.mock.calls.find((call) =>
      String(call[0]).includes("sdcity_candidate_finance_summaries"),
    );
    // Cents → exact dollar strings, never floats: raised, spent, cash, debts.
    expect(summaryCall?.[1]).toEqual(
      expect.arrayContaining(["97670.34", "121576.79", "11315.22", "1407.83"]),
    );
    // Both coverage notes persist on the summary row.
    expect(summaryCall?.[1]).toEqual(
      expect.arrayContaining([
        summary.directCoverageNote,
        summary.outsideCoverageNote,
      ]),
    );
    const outsideCall = query.mock.calls.find((call) =>
      String(call[0]).includes(
        "INSERT INTO public.sdcity_candidate_finance_outside_groups",
      ),
    );
    expect(outsideCall?.[1]).toEqual(expect.arrayContaining(["195934.71"]));
    expect(release).toHaveBeenCalled();
  });

  it("passes negative cash on hand through as a signed balance", async () => {
    const query = queryMock();
    const db = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    await replaceSanDiegoCityCandidateFinanceSnapshot({
      db: db as never,
      link,
      summary: { ...summary, cashOnHandCents: -4200 },
      directBreakdowns: [],
      outsideGroups: [],
    });
    const summaryCall = query.mock.calls.find((call) =>
      String(call[0]).includes("sdcity_candidate_finance_summaries"),
    );
    expect(summaryCall?.[1]).toEqual(expect.arrayContaining(["-42.00"]));
  });

  it("rejects a negative flow and rolls the snapshot back", async () => {
    const query = queryMock();
    const release = vi.fn();
    const db = { connect: vi.fn().mockResolvedValue({ query, release }) };
    await expect(
      replaceSanDiegoCityCandidateFinanceSnapshot({
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
      replaceSanDiegoCityCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary: { ...summary, totalSpentCents: 100.5 },
        directBreakdowns: [],
        outsideGroups: [],
      }),
    ).rejects.toThrow(/total spent must be integer cents/);
  });

  it('never links the "Pending" placeholder filer id, in any casing', async () => {
    // Live data says "Pending" — and San Diego workbooks additionally carry
    // blank Filer_ID cells the shared parser normalizes to "Pending" — but
    // an upstream re-casing must still fail loudly here rather than store a
    // placeholder as a durable identity.
    for (const fppcId of ["Pending", "PENDING", "pending", " Pending "]) {
      await expect(
        upsertSanDiegoCityFinanceLink({
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
              { id: "manual-1", fppc_id: "1460125", link_status: "active" },
            ],
          }
        : null,
    );
    const verifiedAt = new Date("2026-08-12T00:00:00Z");
    const result = await upsertSanDiegoCityFinanceLink({
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

  it("matches a protected manual link on a whitespace-padded FPPC id", async () => {
    // The trimmed id must drive the manual comparison — a padded input that
    // matches the stored id is a reuse, never a false conflict.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_id")
        ? {
            rows: [
              { id: "manual-1", fppc_id: "1460125", link_status: "active" },
            ],
          }
        : null,
    );
    const result = await upsertSanDiegoCityFinanceLink({
      db: { query } as never,
      link: { ...link, fppcId: " 1460125 ", linkSource: "efile_export" },
    });
    expect(result.linkId).toBe("manual-1");
  });

  it("validates inputs before deactivating any existing link", async () => {
    // Standalone (bare Pool) callers get no transaction: a validation throw
    // must happen before the deactivate UPDATE, or a bad payload would leave
    // the candidate with no active link.
    const query = queryMock();
    await expect(
      upsertSanDiegoCityFinanceLink({
        db: { query } as never,
        link: { ...link, committeeName: "   " },
      }),
    ).rejects.toThrow(/committee name is required/);
    expect(query).not.toHaveBeenCalled();
  });

  it("errors when an automatic link conflicts with a protected manual link", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_id")
        ? {
            rows: [
              { id: "manual-1", fppc_id: "1481166", link_status: "active" },
            ],
          }
        : null,
    );
    await expect(
      upsertSanDiegoCityFinanceLink({
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
                { id: "manual-1", fppc_id: "1460125", link_status: linkStatus },
              ],
            }
          : null,
      );
      await expect(
        upsertSanDiegoCityFinanceLink({
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
              { id: "manual-1", fppc_id: "1481166", link_status: "inactive" },
            ],
          }
        : null,
    );
    const result = await upsertSanDiegoCityFinanceLink({
      db: { query } as never,
      link: { ...link, linkSource: "efile_export" },
    });
    expect(result.linkId).toBe("link-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(
      sql.some((s) =>
        s.startsWith("INSERT INTO public.sdcity_candidate_finance_links"),
      ),
    ).toBe(true);
  });

  it("deactivates other automatic links before an active upsert", async () => {
    const query = queryMock();
    await upsertSanDiegoCityFinanceLink({ db: { query } as never, link });
    const deactivate = query.mock.calls.find((call) =>
      String(call[0]).includes("SET link_status='inactive'"),
    );
    expect(String(deactivate?.[0])).toContain("link_source<>'manual'");
    expect(deactivate?.[1]).toEqual(["c", "e", "1460125"]);
  });

  it("refuses to rewrite a manual row that appeared between the probe and the upsert", async () => {
    // The DO UPDATE's WHERE guard makes the write update nothing when the
    // conflict target turned manual after the probe — empty RETURNING must
    // throw, never silently resurrect.
    const query = queryMock((sql) =>
      sql.startsWith("INSERT INTO public.sdcity_candidate_finance_links")
        ? { rows: [] }
        : null,
    );
    await expect(
      upsertSanDiegoCityFinanceLink({
        db: { query } as never,
        link: { ...link, linkSource: "efile_export" },
      }),
    ).rejects.toThrow(/blocked by a concurrent protected manual link/);
    const insert = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.sdcity_candidate_finance_links",
      ),
    );
    expect(String(insert?.[0])).toContain(
      "WHERE sdcity_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual'",
    );
  });
});

const typedCash={officeName:"City Council Member" as const,seatNumber:8,receivingFppcId:link.fppcId,canonicalFilingCount:2,amountCents:10001,contributionCount:1,reportedThrough:summary.reportedThrough,donors:[{committeeKey:"id:2222222",committeeId:"2222222",committeeName:"Example Party",contributorType:"PTY" as const,amountCents:10001,contributionCount:1}]};
const typedInput={link,summary,directBreakdowns:[],outsideGroups:[]};
describe("San Diego atomic typed cash",()=>{
 it("writes source and all groups atomically in exact cents",async()=>{const query=queryMock(),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await replaceSanDiegoCityCandidateFinanceSnapshot({...typedInput,db:db as never,committeeCash:typedCash});expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");const call=query.mock.calls.find(c=>String(c[0]).startsWith("INSERT INTO public.sdcity_candidate_finance_pac_sources"));expect(call?.[1]).toHaveLength(11);expect(call?.[1]?.[4]).toBe("10001");});
 it.each(["amount","count","duplicate","scope","date","seat"])("holds bad %s before connecting",async kind=>{const value=structuredClone(typedCash);if(kind==="amount")value.amountCents++;if(kind==="count")value.contributionCount++;if(kind==="duplicate")value.donors.push({...value.donors[0]!});if(kind==="scope")value.receivingFppcId="3333333";if(kind==="date")value.reportedThrough="2026-02-30";if(kind==="seat")value.seatNumber=10;const db={connect:vi.fn()};await expect(replaceSanDiegoCityCandidateFinanceSnapshot({...typedInput,db:db as never,committeeCash:value})).rejects.toThrow();expect(db.connect).not.toHaveBeenCalled();});
 it("locks matching manual/automatic links and rejects older observations before money writes",async()=>{const query=queryMock(sql=>sql.includes("observed_at >")?{rows:[{newer:true}]}:null),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await expect(replaceSanDiegoCityCandidateFinanceSnapshot({...typedInput,db:db as never,committeeCash:typedCash})).rejects.toThrow(/Older/);const calls=query.mock.calls.map(c=>String(c[0]));expect(calls.at(-1)).toBe("ROLLBACK");expect(calls.some(c=>c.startsWith("INSERT INTO public.sdcity_candidate_finance_summaries"))).toBe(false);});
 it("preserves prior cash evidence when optional component is omitted",async()=>{const query=queryMock(),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await replaceSanDiegoCityCandidateFinanceSnapshot({...typedInput,db:db as never});expect(query.mock.calls.some(c=>String(c[0]).includes("finance_pac_"))).toBe(false);});
});

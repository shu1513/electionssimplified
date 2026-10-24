import { describe, expect, it, vi } from "vitest";
import {
  replaceLosAngelesCandidateFinanceSnapshot,
  upsertLosAngelesFinanceLink,
} from "../../../src/pipeline/losAngelesCityFinance/losAngelesFinanceWriter.js";

// A query mock that answers the link INSERT with an id and everything else
// with empty rows — the writer's control flow (manual SELECT, deactivate
// UPDATE) all tolerate empty results.
function queryMock(overrides?: (sql: string) => { rows: unknown[] } | null) {
  return vi.fn().mockImplementation((sql: unknown) => {
    const s = String(sql);
    const override = overrides?.(s);
    if (override) return Promise.resolve(override);
    if (s.startsWith("INSERT INTO public.lacity_candidate_finance_links"))
      return Promise.resolve({ rows: [{ id: "link-1" }] });
    return Promise.resolve({ rows: [] });
  });
}

const AUTOMATIC_LINK = {
  candidateId: "c",
  electionId: "e",
  electionYear: 2026,
  candidateNameNormalized: "KAREN BASS",
  officeName: "Mayor",
  ethicsElectionId: "76",
  ethicsCandidatePersonId: "172",
  ethicsSeatCandidateId: "1509",
  fppcCommitteeId: "1471359",
  committeeName: "Bass",
  linkSource: "lacity_ethics" as const,
};

describe("upsertLosAngelesFinanceLink manual protection", () => {
  it("reuses a protected manual link with the same committee", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_committee_id")
        ? {
            rows: [
              {
                id: "manual-1",
                fppc_committee_id: "1471359",
                link_status: "active",
              },
            ],
          }
        : null,
    );
    const result = await upsertLosAngelesFinanceLink({
      db: { query } as never,
      link: AUTOMATIC_LINK,
    });
    expect(result.linkId).toBe("manual-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("refuses to rewrite a manual row that appeared between the probe and the upsert", async () => {
    // The DO UPDATE's WHERE guard makes the write update nothing when the
    // conflict target turned manual after the probe — empty RETURNING must
    // throw, never silently resurrect.
    const query = queryMock((sql) =>
      sql.startsWith("INSERT INTO public.lacity_candidate_finance_links")
        ? { rows: [] }
        : null,
    );
    await expect(
      upsertLosAngelesFinanceLink({
        db: { query } as never,
        link: AUTOMATIC_LINK,
      }),
    ).rejects.toThrow(/blocked by a concurrent protected manual link/);
  });

  it("validates every field before issuing any statement", async () => {
    // The writer runs standalone on a bare Pool (auto-link) — a validation
    // throw after the deactivate UPDATE would strand a candidate with no
    // active link, so every field must fail before the first query.
    const query = queryMock();
    await expect(
      upsertLosAngelesFinanceLink({
        db: { query } as never,
        link: { ...AUTOMATIC_LINK, committeeName: "  " },
      }),
    ).rejects.toThrow(/committee name is required/);
    expect(query).not.toHaveBeenCalled();
  });

  it("protects a manual link from a needs_review automatic write too", async () => {
    // Without status-independent protection, this upsert would hit
    // ON CONFLICT on the manual row and rewrite it to lacity_ethics.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_committee_id")
        ? {
            rows: [
              {
                id: "manual-1",
                fppc_committee_id: "1471359",
                link_status: "active",
              },
            ],
          }
        : null,
    );
    const result = await upsertLosAngelesFinanceLink({
      db: { query } as never,
      link: { ...AUTOMATIC_LINK, linkStatus: "needs_review" },
    });
    expect(result.linkId).toBe("manual-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("matches a protected manual link on a whitespace-padded committee id", async () => {
    // The trimmed id must drive the manual comparison — a padded input that
    // matches the stored id is a reuse, never a probe miss that reaches the
    // stored row through ON CONFLICT.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_committee_id")
        ? {
            rows: [
              {
                id: "manual-1",
                fppc_committee_id: "1471359",
                link_status: "active",
              },
            ],
          }
        : null,
    );
    const result = await upsertLosAngelesFinanceLink({
      db: { query } as never,
      link: { ...AUTOMATIC_LINK, fppcCommitteeId: " 1471359 " },
    });
    expect(result.linkId).toBe("manual-1");
  });

  it("errors when an automatic link conflicts with a protected manual link", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_committee_id")
        ? {
            rows: [
              {
                id: "manual-1",
                fppc_committee_id: "9999999",
                link_status: "active",
              },
            ],
          }
        : null,
    );
    await expect(
      upsertLosAngelesFinanceLink({
        db: { query } as never,
        link: AUTOMATIC_LINK,
      }),
    ).rejects.toThrow(/conflicts with protected manual link/);
  });

  it("never resurrects an operator-disabled manual link", async () => {
    // The disabled manual row is the ON CONFLICT target — without the
    // any-status probe the upsert would silently flip it back to
    // active/lacity_ethics.
    for (const linkStatus of ["inactive", "needs_review"]) {
      const query = queryMock((sql) =>
        sql.startsWith("SELECT id::text,fppc_committee_id")
          ? {
              rows: [
                {
                  id: "manual-1",
                  fppc_committee_id: "1471359",
                  link_status: linkStatus,
                },
              ],
            }
          : null,
      );
      await expect(
        upsertLosAngelesFinanceLink({
          db: { query } as never,
          link: AUTOMATIC_LINK,
        }),
      ).rejects.toThrow(/matches an operator-disabled manual link/);
      const sql = query.mock.calls.map((call) => String(call[0]));
      expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
    }
  });

  it("allows a new automatic identity past a disabled manual link with a different committee", async () => {
    // The operator disabled that association, not the candidate.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,fppc_committee_id")
        ? {
            rows: [
              {
                id: "manual-1",
                fppc_committee_id: "9999999",
                link_status: "inactive",
              },
            ],
          }
        : null,
    );
    const result = await upsertLosAngelesFinanceLink({
      db: { query } as never,
      link: AUTOMATIC_LINK,
    });
    expect(result.linkId).toBe("link-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    const insert = sql.find((s) =>
      s.startsWith("INSERT INTO public.lacity_candidate_finance_links"),
    );
    expect(insert).toBeDefined();
    // The in-statement race backstop: a row concurrently flipped to manual
    // must block the update instead of being rewritten.
    expect(insert).toContain(
      "WHERE lacity_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual'",
    );
  });
});

describe("Los Angeles finance writer", () => {
  it("writes a full snapshot in one transaction", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "link" }] })
      .mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const db = { connect: vi.fn().mockResolvedValue({ query, release }) };
    await replaceLosAngelesCandidateFinanceSnapshot({
      db: db as never,
      link: {
        candidateId: "c",
        electionId: "e",
        electionYear: 2026,
        candidateNameNormalized: "KAREN BASS",
        officeName: "Mayor",
        ethicsElectionId: "76",
        ethicsCandidatePersonId: "172",
        ethicsSeatCandidateId: "1509",
        fppcCommitteeId: "1471359",
        committeeName: "Bass",
        linkSource: "lacity_ethics",
      },
      summary: {
        totalReceipts: 1,
        totalDisbursements: 1,
        cashOnHand: 1,
        matchingFunds: 1,
        outsideSupportTotal: 1,
        outsideOpposeTotal: 1,
        membershipSupportTotal: 1,
        membershipOpposeTotal: 1,
        sourceUrl: null,
        reportedThrough: null,
      },
      directBreakdowns: [],
      outsideGroups: [],
    });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toBe("BEGIN");
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lacity_candidate_finance_summaries"),
        expect.stringContaining(
          "DELETE FROM public.lacity_candidate_finance_direct_breakdowns",
        ),
        expect.stringContaining(
          "DELETE FROM public.lacity_candidate_finance_outside_groups",
        ),
      ]),
    );
    expect(sql.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalled();
  });

  it("stores a validated council seat on every snapshot upsert", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "link" }] })
      .mockResolvedValue({ rows: [] });
    const db = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    await replaceLosAngelesCandidateFinanceSnapshot({
      db: db as never,
      link: {
        candidateId: "c",
        electionId: "e",
        electionYear: 2026,
        candidateNameNormalized: "JORDAN LEE",
        officeName: "City Council Member",
        seatNumber: 3,
        ethicsElectionId: "76",
        ethicsCandidatePersonId: "303",
        ethicsSeatCandidateId: "1503",
        fppcCommitteeId: "1471303",
        committeeName: "Lee",
        linkSource: "lacity_ethics",
      },
      summary: {
        totalReceipts: 1,
        totalDisbursements: 1,
        cashOnHand: 1,
        matchingFunds: 1,
        outsideSupportTotal: 1,
        outsideOpposeTotal: 1,
        membershipSupportTotal: 1,
        membershipOpposeTotal: 1,
        sourceUrl: null,
        reportedThrough: null,
      },
      directBreakdowns: [],
      outsideGroups: [],
    });
    const insert = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.lacity_candidate_finance_links",
      ),
    );
    expect(String(insert?.[0])).toContain("office_name,seat_number");
    expect(insert?.[1]?.[5]).toBe(3);
  });

  it("rejects missing, out-of-range, and citywide seat numbers", async () => {
    const db = {
      connect: vi.fn().mockResolvedValue({ query: vi.fn(), release: vi.fn() }),
    };
    const base = {
      candidateId: "c",
      electionId: "e",
      electionYear: 2026,
      candidateNameNormalized: "JORDAN LEE",
      ethicsElectionId: "76",
      ethicsCandidatePersonId: "303",
      ethicsSeatCandidateId: "1503",
      fppcCommitteeId: "1471303",
      committeeName: "Lee",
    };
    const summary = {
      totalReceipts: 1,
      totalDisbursements: 1,
      cashOnHand: 1,
      matchingFunds: 1,
      outsideSupportTotal: 1,
      outsideOpposeTotal: 1,
      membershipSupportTotal: 1,
      membershipOpposeTotal: 1,
      sourceUrl: null,
      reportedThrough: null,
    };
    for (const link of [
      { ...base, officeName: "City Council Member" },
      { ...base, officeName: "City Council Member", seatNumber: 16 },
      { ...base, officeName: "School Board Member" },
      { ...base, officeName: "School Board Member", seatNumber: 8 },
      { ...base, officeName: "Mayor", seatNumber: 3 },
    ]) {
      await expect(
        replaceLosAngelesCandidateFinanceSnapshot({
          db: db as never,
          link,
          summary,
          directBreakdowns: [],
          outsideGroups: [],
        }),
      ).rejects.toThrow(/seat number/);
    }
  });
});

const cash = { donors:[{committeeKey:"EXAMPLE PAC",committeeName:"Example PAC",amountCents:10001,contributionCount:1}],amountCents:10001,contributionCount:1,reportedThrough:"2026-10-17",receivingCommitteeIds:["1471359"] };
const cashInput = {link:AUTOMATIC_LINK,summary:{totalReceipts:100.01,totalDisbursements:0,cashOnHand:100.01,matchingFunds:0,outsideSupportTotal:0,outsideOpposeTotal:0,membershipSupportTotal:0,membershipOpposeTotal:0,sourceUrl:null,reportedThrough:"2026-10-17"},directBreakdowns:[],outsideGroups:[]};
describe("Los Angeles atomic committee cash", () => {
 it("commits exact cents, source scope and all donor groups in one transaction", async () => {
  const query=queryMock(),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await replaceLosAngelesCandidateFinanceSnapshot({...cashInput,db:db as never,reportedCommitteeCash:cash});
  expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");const linkCall=query.mock.calls.find(c=>String(c[0]).startsWith("INSERT INTO public.lacity_candidate_finance_links"));expect(linkCall?.[1]).toHaveLength(17);expect(String(linkCall?.[0])).toContain("$17::text[]");expect(linkCall?.[1]?.at(-1)).toEqual(["1471359"]);
  expect(query.mock.calls.find(c=>String(c[0]).startsWith("INSERT INTO public.lacity_candidate_finance_pac_donors"))?.[1]).toContain("10001");
 });
 it("omission leaves prior donor evidence untouched", async () => {
  const query=queryMock(),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await replaceLosAngelesCandidateFinanceSnapshot({...cashInput,db:db as never});expect(query.mock.calls.some(c=>String(c[0]).includes("finance_pac_"))).toBe(false);
 });
 it.each(["amount","count","duplicate","scope","date"])("rejects invalid %s evidence before connecting", async kind => {
  const value=structuredClone(cash);if(kind==="amount")value.amountCents++;if(kind==="count")value.contributionCount++;if(kind==="duplicate")value.donors.push({...value.donors[0]!});if(kind==="scope")value.receivingCommitteeIds=["1480000"];if(kind==="date")value.reportedThrough="2026-02-30";
  const db={connect:vi.fn()};await expect(replaceLosAngelesCandidateFinanceSnapshot({...cashInput,db:db as never,reportedCommitteeCash:value})).rejects.toThrow();expect(db.connect).not.toHaveBeenCalled();
 });
 it("serializes the link and rejects a newer stored clock before money writes", async () => {
  const query=queryMock(sql=>sql.includes("observed_at >")?{rows:[{newer:true}]}:null),db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};await expect(replaceLosAngelesCandidateFinanceSnapshot({...cashInput,db:db as never,reportedCommitteeCash:cash})).rejects.toThrow(/older/);
  const calls=query.mock.calls.map(c=>String(c[0]));expect(calls.at(-1)).toBe("ROLLBACK");expect(calls.findIndex(c=>c.includes("links WHERE id=$1::uuid FOR UPDATE"))).toBeLessThan(calls.findIndex(c=>c.includes("observed_at >")));expect(calls.some(c=>c.startsWith("INSERT INTO public.lacity_candidate_finance_summaries"))).toBe(false);
 });
});

import { describe, expect, it, vi } from "vitest";

import {
  replaceMissouriCandidateFinanceSnapshot,
  upsertMissouriFinanceLink,
} from "../../../src/pipeline/missouriFinance/missouriFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://www.mec.mo.gov/MEC/Campaign_Finance/CommInfo.aspx?MECID=A222073";
import type { MissouriCommitteeMonetaryReceiptComponent } from "../../../src/pipeline/missouriFinance/missouriCommitteeMonetaryReceiptWriter.js";

const VERIFIED_AT = new Date("2026-08-12T00:00:00.000Z");

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "JANE EXAMPLE",
    officeName: "State Representative",
    district: "District 1",
    committeeId: "A222073",
    committeeName: "Jane Example for Missouri",
    linkSource: "mec_portal" as const,
    sourceUrl: SOURCE_URL,
    lastVerifiedAt: VERIFIED_AT,
  };
}

function automaticQueryResult(sql: unknown, _values?: unknown[]) {
  const statement = String(sql);
  if (statement.includes("INSERT INTO public.mo_candidate_finance_links")) {
    return Promise.resolve({ rows: [{ id: LINK_ID }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

describe("missouriFinanceWriter", () => {
  it("upserts normalized MEC links through the canonical Missouri table", async () => {
    const db = { query: vi.fn(automaticQueryResult) };

    await expect(
      upsertMissouriFinanceLink({
        db: db as never,
        link: { ...baseLink(), committeeId: " a222073 " },
      })
    ).resolves.toEqual({ linkId: LINK_ID });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("link_source='manual'");
    const insertCall = db.query.mock.calls[1];
    expect(String(insertCall?.[0])).toContain("INSERT INTO public.mo_candidate_finance_links");
    expect(String(insertCall?.[0])).toContain(
      "WHERE mo_candidate_finance_links.link_source <> 'manual' OR EXCLUDED.link_source = 'manual'"
    );
    expect(insertCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "JANE EXAMPLE",
      "State Representative",
      "District 1",
      "A222073",
      "Jane Example for Missouri",
      "active",
      "mec_portal",
      SOURCE_URL,
      VERIFIED_AT.toISOString(),
    ]);
  });

  it("reuses an exact active manual MECID and refreshes only verification time", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: LINK_ID, committee_id: "A222073", link_status: "active", election_year: 2026 }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };

    await expect(upsertMissouriFinanceLink({ db, link: baseLink() })).resolves.toEqual({ linkId: LINK_ID });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(String(db.query.mock.calls[1]?.[0])).toBe(
      "UPDATE public.mo_candidate_finance_links SET last_verified_at=$2::timestamptz WHERE id=$1::uuid"
    );
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO"))).toBe(false);
  });

  it("rejects an exact manual MECID carrying a different election year", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: LINK_ID, committee_id: "A222073", link_status: "active", election_year: 2024 }],
        rowCount: 1,
      }),
    };

    await expect(upsertMissouriFinanceLink({ db, link: baseLink() })).rejects.toThrow(
      "Missouri automatic finance link year 2026 does not match the protected manual link year 2024"
    );
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("fails closed for disabled exact manual links and conflicting active manual links", async () => {
    const disabledDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: LINK_ID, committee_id: "A222073", link_status: "inactive" }],
        rowCount: 1,
      }),
    };
    await expect(upsertMissouriFinanceLink({ db: disabledDb, link: baseLink() })).rejects.toThrow(
      "Missouri automatic finance link matches an operator-disabled manual link"
    );

    const conflictDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: LINK_ID, committee_id: "C263985", link_status: "active" }],
        rowCount: 1,
      }),
    };
    await expect(upsertMissouriFinanceLink({ db: conflictDb, link: baseLink() })).rejects.toThrow(
      "Missouri automatic finance link conflicts with protected manual link"
    );
  });

  it("replaces a complete snapshot transactionally and supersedes stale MEC links", async () => {
    const client = {
      query: vi.fn(automaticQueryResult),
      release: vi.fn(),
    };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };

    await expect(
      replaceMissouriCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        syncedAt: new Date("2026-08-13T00:00:00.000Z"),
        summary: {
          totalReceipts: 100_000,
          directContributionTotal: 90_000,
          totalDisbursements: 50_000,
          cashOnHand: 50_000,
          outsideSupportTotal: 12_000,
          outsideOpposeTotal: 3_000,
          sourceUrl: SOURCE_URL,
        },
        directBreakdowns: [
          { categoryType: "occupation", categoryName: "Attorney", amount: 10_000 },
          { categoryType: "contribution_size", categoryName: "$100-$499", amount: 20_000 },
        ],
        outsideGroups: [
          {
            committeeId: " c263985 ",
            committeeName: "Example Missouri PAC",
            supportOppose: "support",
            amount: 12_000,
          },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "C263985",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Example Donor",
            amount: 5_000,
          },
        ],
      })
    ).resolves.toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 1,
    });

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    const calls = client.query.mock.calls;
    const summarySql = String(
      calls.find((call) => String(call[0]).includes("INSERT INTO public.mo_candidate_finance_summaries"))?.[0]
    );
    expect(summarySql).toContain("outside_support_total = COALESCE(EXCLUDED.outside_support_total");
    expect(summarySql).toContain("outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total");
    const supersede = calls.find(
      (call) => String(call[0]).includes("UPDATE public.mo_candidate_finance_links") && String(call[0]).includes("id <>")
    );
    expect(String(supersede?.[0])).toContain("link_source = 'mec_portal'");
    expect(supersede?.[1]).toEqual([CANDIDATE_ID, ELECTION_ID, LINK_ID]);
    const outsideInsert = calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.mo_candidate_finance_outside_groups")
    );
    expect(outsideInsert?.[1]?.[2]).toBe("C263985");
  });

  it("requires outside breakdowns to pair with groups before opening a transaction", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };

    await expect(
      replaceMissouriCandidateFinanceSnapshot({
        db: db as never,
        link: baseLink(),
        outsideGroups: [
          { committeeId: "C263985", committeeName: "Example PAC", supportOppose: "support", amount: 1_000 },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "C263985",
            supportOppose: "oppose",
            categoryType: "donor",
            categoryName: "Example Donor",
            amount: 1_000,
          },
        ],
      })
    ).rejects.toThrow("Missouri outside group breakdowns must reference outside groups in the same snapshot");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects out-of-scope years and malformed MECIDs before DB writes", async () => {
    const db = { query: vi.fn(automaticQueryResult) };

    await expect(
      upsertMissouriFinanceLink({ db: db as never, link: { ...baseLink(), electionYear: 2023 } })
    ).rejects.toThrow("Invalid Missouri finance election year: 2023");
    await expect(
      upsertMissouriFinanceLink({ db: db as never, link: { ...baseLink(), committeeId: "222073" } })
    ).rejects.toThrow("Invalid Missouri MECID: 222073");
    expect(db.query).not.toHaveBeenCalled();
  });
});

function cashComponent(): MissouriCommitteeMonetaryReceiptComponent {
  return {
    receivingCommitteeId: "A222073", cycleStart: "2025-01-01", cycleEnd: "2026-11-03",
    sourceRetrievedAt: new Date("2026-08-12T00:00:00Z"),
    sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx",
    sourceSha256: "a".repeat(64), sourceByteSize: 100, reportInventorySha256: "b".repeat(64),
    aggregation: { status: "qualified", sourceRowCount: 1, inCycleRowCount: 1, outsideCycleRowCount: 0,
      canonicalRowCount: 1, matchedCommitteeRowCount: 1, excludedNonCommitteeRowCount: 0,
      inKindRowCount: 0, zeroMonetaryRowCount: 0, includedReceiptRowCount: 1,
      relevantUnresolvedLineageCount: 0, excludedLineageRowCount: 0, excludedLineageAmountCents: 0, lineageDiagnosticCodes: [],
      committees: [{reportedCommitteeName: "Example Committee", reportedNameKey: "EXAMPLE COMMITTEE", amountCents: 101, receiptCount: 1}],
      totalAmountCents: 101,
    },
  };
}
function cashDb(options: {manualConflict?: boolean; failGroup?: boolean; mutateOnConnect?: () => void} = {}) {
  const client = {query: vi.fn(async (sql: unknown, _values?: unknown[]) => {
    const text = String(sql);
    if(options.manualConflict && text.includes("link_source='manual'")) return {rows: [{id: LINK_ID, committee_id: "C123456", link_status: "active", election_year: 2026}], rowCount: 1};
    if(text.includes("INSERT INTO public.mo_candidate_finance_links") || text.startsWith("SELECT id FROM public.mo_candidate_finance_links")) return {rows: [{id: LINK_ID}], rowCount: 1};
    if(options.failGroup && text.includes("INSERT INTO public.mo_candidate_finance_committee_receipts")) throw new Error("synthetic private source payload");
    return {rows: [], rowCount: 0};
  }), release: vi.fn()};
  return {client, db: {query: vi.fn(), connect: vi.fn(async () => {options.mutateOnConnect?.(); return client;})}};
}
describe("Missouri optional cash component protected transaction", () => {
  it("writes cash alone without touching summary, direct, or outside money and times", async () => {
    const {client, db} = cashDb();
    await expect(replaceMissouriCandidateFinanceSnapshot({db: db as never, link: baseLink(), syncedAt: new Date("2026-08-13"), committeeMonetaryReceipts: cashComponent()})).resolves.toEqual({
      linkId: LINK_ID, summaryWritten: false, directBreakdownsWritten: 0, outsideGroupsWritten: 0, outsideGroupBreakdownsWritten: 0,
    });
    const statements = client.query.mock.calls.map(call => String(call[0]));
    expect(statements[0]).toBe("BEGIN"); expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some(sql => sql.includes("INSERT INTO public.mo_candidate_finance_committee_receipts"))).toBe(true);
    expect(statements.some(sql => /mo_candidate_finance_(summaries|direct_breakdowns|outside_groups|outside_group_breakdowns)/.test(sql))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it.each(["absent", "held"])("preserves previous cash rows and observation time for %s input", async mode => {
    const {client, db} = cashDb(); const c = cashComponent();
    c.aggregation = {...c.aggregation, status: "held", reason: "negative_eligible_adjustment"};
    await replaceMissouriCandidateFinanceSnapshot({db: db as never, link: baseLink(), committeeMonetaryReceipts: mode === "held" ? c : undefined});
    expect(client.query.mock.calls.some(call => String(call[0]).includes("mo_candidate_finance_committee_receipt"))).toBe(false);
  });
  it("validates receiver and aggregate controls before opening a transaction", async () => {
    const {db} = cashDb(); const c = cashComponent(); c.receivingCommitteeId = "A999999";
    await expect(replaceMissouriCandidateFinanceSnapshot({db: db as never, link: baseLink(), committeeMonetaryReceipts: c})).rejects.toThrow("invalid_component");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("rolls back a protected manual conflict before component SQL", async () => {
    const {client, db} = cashDb({manualConflict: true});
    await expect(replaceMissouriCandidateFinanceSnapshot({db: db as never, link: baseLink(), committeeMonetaryReceipts: cashComponent()})).rejects.toThrow("protected manual link");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some(call => String(call[0]).includes("mo_candidate_finance_committee_receipt"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it("rolls back all snapshot writes when the component write fails", async () => {
    const {client, db} = cashDb({failGroup: true});
    await expect(replaceMissouriCandidateFinanceSnapshot({db: db as never, link: baseLink(), committeeMonetaryReceipts: cashComponent()})).rejects.toThrow("Missouri committee monetary receipts write_failed");
    expect(client.query.mock.calls.some(call => String(call[0]).startsWith("DELETE FROM public.mo_candidate_finance_committee_receipts"))).toBe(true);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some(call => call[0] === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it("holds a stable validated copy across connection acquisition", async () => {
    const c = cashComponent(); const {client, db} = cashDb({mutateOnConnect: () => { if(c.aggregation.status === "qualified") c.aggregation.committees[0]!.amountCents = 999; }});
    await replaceMissouriCandidateFinanceSnapshot({db: db as never, link: baseLink(), committeeMonetaryReceipts: c});
    const insert = client.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.mo_candidate_finance_committee_receipts"));
    expect(insert?.[1]?.[4]).toBe("101");
  });
});

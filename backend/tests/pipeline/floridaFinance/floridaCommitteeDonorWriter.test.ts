import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  replaceFloridaCandidateFinanceSnapshot,
  type FloridaFinanceLinkInput,
} from "../../../src/pipeline/floridaFinance/floridaFinanceWriter.js";
import {
  prepareFloridaCommitteeDonorFinance,
  writeFloridaCommitteeDonorFinance,
  type FloridaCommitteeDonorFinanceInput,
} from "../../../src/pipeline/floridaFinance/floridaCommitteeDonorWriter.js";
import { buildFloridaVerifiedCommitteeDonors } from "../../../src/pipeline/floridaFinance/floridaVerifiedCommitteeDonorSource.js";
import type { FloridaProcessedFinanceProof } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";
import type { FloridaContributionRow } from "../../../src/pipeline/floridaFinance/floridaCampaignFinanceRows.js";
import type { FloridaLocalFinanceContext } from "../../../src/pipeline/floridaFinance/floridaLocalFinanceContext.js";

// Synthetic accepted-source structures. Actual source authority is established
// by the separate raw verifier, not by these fixture hashes.
const candidateId = "11111111-1111-1111-1111-111111111111";
const electionId = "22222222-2222-2222-2222-222222222222";
const candidateElectionId = "33333333-3333-3333-3333-333333333333";
const linkId = "44444444-4444-4444-4444-444444444444";
const h = "a".repeat(64);
const origin = "https://dos.elections.myflorida.com";
const sourceContext = {
  sourceAccount: "88773",
  candidateName: "Example Candidate",
  electionYear: 2026,
  officeName: "State Representative",
  district: "9",
  genericRecipientName: "Candidate, Example (DEM)(STR)",
};
const localContext: FloridaLocalFinanceContext = {
  candidateId,
  candidateElectionId,
  electionId,
  candidateName: "Example Candidate",
  electionYear: 2026,
  electionDate: "2026-11-03",
  officeScope: "state_lower",
  officeCanonicalName: "State Lower Chamber Legislator",
  district: "9",
  committeeId: "CANDIDATE_EXAMPLE_DEM_STR",
  genericRecipientName: sourceContext.genericRecipientName,
};
const link = (): FloridaFinanceLinkInput => ({
  candidateId,
  electionId,
  electionYear: 2026,
  candidateNameNormalized: "EXAMPLE CANDIDATE",
  officeName: localContext.officeCanonicalName,
  district: "9",
  committeeId: localContext.committeeId,
  committeeName: localContext.genericRecipientName,
  linkSource: "dos_export",
});
const syncedAt = new Date("2026-10-11T20:30:00Z");
function row(
  change: Partial<FloridaContributionRow> = {},
): FloridaContributionRow {
  return {
    recipientName: sourceContext.genericRecipientName,
    contributionDate: "2026-01-05",
    amount: "1000.00",
    transactionType: "CHE",
    contributorName: "Example PAC",
    address: "1 Main St.",
    cityStateZip: "City FL 12345",
    city: "",
    state: "",
    zip: "",
    occupation: "",
    inKindDescription: "",
    ...change,
  };
}
function proof(rows: FloridaContributionRow[]): FloridaProcessedFinanceProof {
  const nativeRows = rows.map((r) => ({
    reportYear: 2026,
    reportType: "Q1",
    date: r.contributionDate,
    amountCents: Math.round(Number(r.amount) * 100),
    contributorName: r.contributorName,
    address: r.address,
    cityStateZip: r.cityStateZip!,
    occupation: r.occupation,
    transactionType: r.transactionType,
    inKindDescription: r.inKindDescription,
  }));
  const identities = nativeRows.map((r) => [
    r.date,
    r.amountCents,
    r.contributorName,
    r.address,
    r.cityStateZip,
    r.occupation,
    r.transactionType,
    r.inKindDescription,
  ]);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(identities.map((r) => JSON.stringify(r)).sort()))
    .digest("hex");
  const metadata = Array.from({ length: 8 }, (_, i) => ({
    url: origin + "/candidates/CanDetail.asp?account=88773",
    method: "GET" as const,
    financeFields: null,
    status: 200,
    contentType: "text/html",
    sha256: h,
    byteCount: 100,
    startedAt: new Date(Date.UTC(2026, 9, 11, 20, 0, i)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 9, 11, 20, 0, i, 100)).toISOString(),
    phase: i < 4 ? ("before" as const) : ("after" as const),
  }));
  return {
    version: 1,
    authority: "current_processed",
    context: { ...sourceContext },
    windowStart: "2025-01-01",
    windowEnd: "2026-12-31",
    rows,
    nativeRows,
    reports: [
      {
        account: "88773",
        candidateName: sourceContext.candidateName,
        electionYear: 2026,
        sequence: 6,
        reportYear: 2026,
        reportType: "Q1",
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        dueDate: "2026-04-10",
        filedAt: "2026-04-10",
        reviewedAt: "2026-04-11",
        fileStatus: "Filed Report",
        reviewStatus: "Reviewed",
        completeness: "Complete Detail Records",
        queued: 0,
        contributionCount: rows.length,
        amended: true,
        waiver: false,
        fullMetadata: { current: true },
        nativeSequence: 6,
        monetaryCents: nativeRows
          .filter((r) => r.transactionType !== "INK")
          .reduce((n, r) => n + r.amountCents, 0),
        loanCents: 0,
        inKindCents: nativeRows
          .filter((r) => r.transactionType === "INK")
          .reduce((n, r) => n + r.amountCents, 0),
        financialFingerprint: h,
      },
    ],
    financialFingerprint: fingerprint,
    sourceHashes: metadata.map((m) => m.sha256),
    sourceMetadata: metadata,
  };
}
async function pacFinance(
  rows = [
    row(),
    row(),
    row({ amount: "-500.00", transactionType: "REF" }),
    row({ amount: "100.00", contributorName: "Unclassified Business" }),
    row({
      amount: "750.00",
      transactionType: "INK",
      inKindDescription: "Services",
    }),
  ],
): Promise<FloridaCommitteeDonorFinanceInput> {
  const p = proof(rows);
  const finance = await buildFloridaVerifiedCommitteeDonors({
    proof: p,
    lookupDonor: async (q) =>
      q.reportedName === "Unclassified Business"
        ? {
            status: "not_found",
            diagnostics: [],
            sourceHashes: Array(4).fill(h),
          }
        : {
            status: "resolved",
            diagnostics: [],
            sourceHashes: Array(6).fill(h),
            identity: {
              committeeId: "64858",
              committeeName: q.reportedName,
              committeeType: "PAC",
              sourceUrl: origin + "/committees/ComDetail.asp?account=64858",
              includedInCommitteeDonorScope: true,
              resolution: "unique_exact_name",
            },
          },
  });
  if (finance.status !== "accepted") throw new Error(finance.reason);
  return {
    source: {
      status: "verified",
      localContext: { ...localContext },
      proof: p,
      accountCatalogHashes: [h, h],
    },
    finance,
  };
}
function db(localChange: Record<string, unknown> = {}, failSql?: string, priorSources: unknown[] = []) {
  const local = {
    candidate_id: candidateId,
    candidate_election_id: candidateElectionId,
    election_id: electionId,
    candidate_name: localContext.candidateName,
    candidate_status: "running",
    election_date: "2026-11-03",
    election_stage: "general",
    race_type: "office",
    state: "FL",
    office_scope: "state_lower",
    office_canonical_name: localContext.officeCanonicalName,
    district_type: "state_lower",
    geoid_compact: "12009",
    committee_id: localContext.committeeId,
    committee_name: localContext.genericRecipientName,
    election_year: 2026,
    ...localChange,
  };
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (failSql && sql.includes(failSql))
      throw new Error("fixture write failed");
    if (sql.includes("SELECT source_account, election_year, provenance"))
      return { rows: priorSources, rowCount: priorSources.length };
    if (sql.includes("candidate_election.status AS candidate_status"))
      return { rows: [local], rowCount: 1 };
    return { rows: [{ id: linkId }], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  const pool = { query: vi.fn(), connect: vi.fn(async () => client) };
  return { pool, client, query };
}
const statements = (mock: ReturnType<typeof db>) =>
  mock.query.mock.calls.map((c) => c[0]);
const call = (mock: ReturnType<typeof db>, marker: string) =>
  mock.query.mock.calls.find((c) => c[0].includes(marker))!;

describe("Florida atomic verified committee donor writer", () => {
  it("writes net/refund/counts, full source provenance and snapshot atomically without adding PAC to Raised", async () => {
    const mock = db();
    const result = await replaceFloridaCandidateFinanceSnapshot({
      db: mock.pool,
      link: link(),
      syncedAt,
      summary: { totalReceipts: 5000, directContributionTotal: 5000 },
      pacFinance: await pacFinance(),
    });
    expect(result.pacDonorsWritten).toBe(1);
    const sql = statements(mock);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(sql[2]).toContain(
      "FOR SHARE OF candidate, candidate_election, election, district, office, link",
    );
    expect(
      sql.findIndex((s) => s.includes("candidate_election.status")),
    ).toBeLessThan(
      sql.findIndex((s) =>
        s.includes("INSERT INTO public.fl_candidate_finance_links"),
      ),
    );
    expect(
      call(mock, "INSERT INTO public.fl_candidate_finance_pac_donors")[1],
    ).toEqual([
      linkId,
      2026,
      "64858",
      "Example PAC",
      "PAC",
      1500,
      2000,
      500,
      2,
      1,
      origin + "/committees/ComDetail.asp?account=64858",
      syncedAt.toISOString(),
    ]);
    const source = call(
      mock,
      "INSERT INTO public.fl_candidate_finance_pac_sources",
    )[1]!;
    expect(source.slice(0, 6)).toEqual([linkId, 2026, "88773", 1500, 100, 1]);
    expect(JSON.parse(String(source[6]))).toMatchObject({
      version: 1,
      authority: "current_processed",
      localContext,
      accountCatalogHashes: [h, h],
    });
    expect(
      call(mock, "INSERT INTO public.fl_candidate_finance_summaries")[1]?.[2],
    ).toBe(5000);
    expect(
      call(mock, "DELETE FROM public.fl_candidate_finance_pac_donors")[1],
    ).toEqual([linkId, 2026, ["64858"]]);
    expect(
      sql.findIndex((s) =>
        s.includes("INSERT INTO public.fl_candidate_finance_pac_sources"),
      ),
    ).toBeLessThan(
      sql.findIndex((s) =>
        s.includes("DELETE FROM public.fl_candidate_finance_pac_donors"),
      ),
    );
    expect(mock.client.release).toHaveBeenCalledOnce();
  });
  it("preserves PAC without any PAC/context query for omitted legacy input", async () => {
    const mock = db();
    const result = await replaceFloridaCandidateFinanceSnapshot({
      db: mock.pool,
      link: link(),
      summary: { totalReceipts: 42 },
    });
    expect(result).not.toHaveProperty("pacDonorsWritten");
    expect(
      statements(mock).some(
        (s) =>
          s.includes("_pac_") ||
          s.includes("candidate_election.status") ||
          s.includes("advisory"),
      ),
    ).toBe(false);
  });
  it("allows independently verified empty donors and scoped clearing without needing a summary", async () => {
    const mock = db();
    const finance = await pacFinance([]);
    const result = await replaceFloridaCandidateFinanceSnapshot({
      db: mock.pool,
      link: link(),
      pacFinance: finance,
    });
    expect(result).toMatchObject({
      pacDonorsWritten: 0,
      summaryWritten: false,
    });
    expect(
      statements(mock).some((s) =>
        s.includes("INSERT INTO public.fl_candidate_finance_pac_donors"),
      ),
    ).toBe(false);
    expect(
      call(mock, "DELETE FROM public.fl_candidate_finance_pac_donors")[1],
    ).toEqual([linkId, 2026, []]);
    expect(
      call(
        mock,
        "INSERT INTO public.fl_candidate_finance_pac_sources",
      )[1]?.slice(2, 6),
    ).toEqual(["88773", 0, 0, 0]);
  });
  it("stores a proven unclassified positive-cash amount separately from known committee zero", async () => {
    const mock = db();
    const finance = await pacFinance([
      row({ contributorName: "Unclassified Business" }),
    ]);
    await replaceFloridaCandidateFinanceSnapshot({
      db: mock.pool,
      link: link(),
      pacFinance: finance,
    });
    expect(
      call(
        mock,
        "INSERT INTO public.fl_candidate_finance_pac_sources",
      )[1]?.slice(2, 6),
    ).toEqual(["88773", 0, 1000, 1]);
  });
  it.each([
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.donors[0].amount = 1600;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.donors[0].grossAmount = 2100;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.donors[0].refundAmount = 400;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.donors[0].contributionCount = 1;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.donors[0].refundCount = 0;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.netCommitteeAmount = 1600;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.unclassifiedPositiveCashAmount = 0;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.unclassifiedPositiveCashCount = 0;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.donors[0].committeeType = "PTY";
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.donors[0].sourceUrl = "https://example.test";
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.donors.push(f.finance.donors[0]);
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.provenance.registryLookups[0].rowFingerprint = "b".repeat(64);
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.provenance.registryLookups[1].occurrence = 0;
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.provenance.registryLookups = [];
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.finance.provenance.context.sourceAccount = "123";
    },
    (f: FloridaCommitteeDonorFinanceInput) => {
      f.source.accountCatalogHashes = [];
    },
  ])(
    "rejects mutated materialization/occurrence authority before connect %#",
    async (change) => {
      const mock = db(),
        finance = await pacFinance();
      change(finance);
      await expect(
        replaceFloridaCandidateFinanceSnapshot({
          db: mock.pool,
          link: link(),
          pacFinance: finance,
        }),
      ).rejects.toThrow();
      expect(mock.pool.connect).not.toHaveBeenCalled();
      expect(mock.query).not.toHaveBeenCalled();
    },
  );
  it("rejects a bare donor array instead of treating it as authoritative clear", async () => {
    const mock = db();
    await expect(
      replaceFloridaCandidateFinanceSnapshot({
        db: mock.pool,
        link: link(),
        pacFinance: [] as never,
      }),
    ).rejects.toThrow("verified source");
    expect(mock.pool.connect).not.toHaveBeenCalled();
  });
  it.each([
    { geoid_compact: "12010" },
    { candidate_name: "Different Candidate" },
    { election_stage: "primary" },
    { election_date: "2026-11-04" },
    { state: "GA" },
    { candidate_id: electionId },
    { committee_name: "Different Committee" },
    { candidate_election_id: linkId },
  ])(
    "rolls back changed actual local race/owner before link writes %#",
    async (change) => {
      const mock = db(change);
      await expect(
        replaceFloridaCandidateFinanceSnapshot({
          db: mock.pool,
          link: link(),
          pacFinance: await pacFinance(),
        }),
      ).rejects.toThrow();
      expect(statements(mock).at(-1)).toBe("ROLLBACK");
      expect(statements(mock).some((s) => s.includes("INSERT INTO"))).toBe(
        false,
      );
      expect(mock.client.release).toHaveBeenCalledOnce();
    },
  );
  it("rejects nonunique active local ownership under the transaction", async () => {
    const mock = db();
    mock.query.mockImplementation(async (sql) =>
      sql.includes("candidate_election.status")
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: linkId }], rowCount: 1 },
    );
    await expect(
      replaceFloridaCandidateFinanceSnapshot({
        db: mock.pool,
        link: link(),
        pacFinance: await pacFinance(),
      }),
    ).rejects.toThrow("ownership is not unique");
    expect(statements(mock).at(-1)).toBe("ROLLBACK");
  });
  it.each([
    "INSERT INTO public.fl_candidate_finance_pac_donors",
    "INSERT INTO public.fl_candidate_finance_pac_sources",
    "DELETE FROM public.fl_candidate_finance_pac_donors",
  ])("rolls back snapshot plus PAC on failure during %s", async (marker) => {
    const mock = db({}, marker);
    await expect(
      replaceFloridaCandidateFinanceSnapshot({
        db: mock.pool,
        link: link(),
        summary: { totalReceipts: 5000 },
        pacFinance: await pacFinance(),
      }),
    ).rejects.toThrow("fixture write failed");
    expect(statements(mock)).toContain("ROLLBACK");
    expect(statements(mock)).not.toContain("COMMIT");
    expect(
      statements(mock).some((s) =>
        s.includes("INSERT INTO public.fl_candidate_finance_summaries"),
      ),
    ).toBe(true);
  });
  it("retains caller generation before connection and all asynchronous writes", async () => {
    const mock = db(),
      finance = await pacFinance(),
      originalLink = link(),
      time = new Date(syncedAt);
    mock.pool.connect.mockImplementation(async () => {
      finance.finance.donors[0].amount = 999999;
      finance.source.proof.rows[0].contributorName = "Changed";
      originalLink.committeeName = "Changed";
      time.setUTCFullYear(2030);
      return mock.client;
    });
    await replaceFloridaCandidateFinanceSnapshot({
      db: mock.pool,
      link: originalLink,
      syncedAt: time,
      pacFinance: finance,
      summary: { totalReceipts: 5000 },
    });
    expect(
      call(
        mock,
        "INSERT INTO public.fl_candidate_finance_pac_donors",
      )[1]?.slice(5, 10),
    ).toEqual([1500, 2000, 500, 2, 1]);
    expect(
      call(mock, "INSERT INTO public.fl_candidate_finance_pac_donors")[1]?.at(
        -1,
      ),
    ).toBe(syncedAt.toISOString());
    expect(
      call(mock, "INSERT INTO public.fl_candidate_finance_links")[1]?.[7],
    ).toBe(localContext.genericRecipientName);
  });
  it("accepts equivalent JSON object key order but keeps occurrence arrays and fields exact", async () => {
    const finance = await pacFinance();
    finance.finance.provenance.context = Object.fromEntries(
      Object.entries(finance.finance.provenance.context).reverse(),
    ) as typeof sourceContext;
    await expect(
      prepareFloridaCommitteeDonorFinance({
        pacFinance: finance,
        link: link(),
      }),
    ).resolves.toMatchObject({ finance: { netCommitteeAmount: 1500 } });
  });
});

function storedSource(finance: FloridaCommitteeDonorFinanceInput) {
  const provenance = structuredClone({ ...finance.finance.provenance,
    localContext: finance.source.localContext, accountCatalogHashes: finance.source.accountCatalogHashes });
  provenance.sourceMetadata = provenance.sourceMetadata.map((m,i) => ({ ...m,
    startedAt:new Date(Date.UTC(2026,9,11,19,0,i)).toISOString(),
    completedAt:new Date(Date.UTC(2026,9,11,19,0,i,100)).toISOString() }));
  return { source_account:"88773", election_year:2026, provenance };
}
const pacMutations = (mock: ReturnType<typeof db>) => statements(mock).filter(sql =>
  /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(sql) && /fl_candidate_finance_pac_(?:donors|sources)/.test(sql));

describe("locked prior accepted PAC source replacement", () => {
  it("locks prior provenance before any PAC mutation and accepts a genuinely newer complete source", async () => {
    const finance=await pacFinance(),prior=storedSource(finance),mock=db({},undefined,[prior]);
    await replaceFloridaCandidateFinanceSnapshot({db:mock.pool,link:link(),summary:{totalReceipts:5000},pacFinance:finance});
    const sql=statements(mock), index=sql.findIndex(s=>s.includes("SELECT source_account, election_year, provenance"));
    expect(sql[index]).toContain("FOR UPDATE");
    expect(call(mock,"SELECT source_account")[1]).toEqual([linkId,2026]);
    expect(index).toBeLessThan(sql.findIndex(s=>s.includes("INSERT INTO public.fl_candidate_finance_pac_donors")));
    expect(sql.at(-1)).toBe("COMMIT");
    expect(pacMutations(mock)).toHaveLength(3);
  });
  it("preserves older genuine closing source even with a newer supplied write time while direct commits", async () => {
    const finance=await pacFinance(),prior=storedSource(finance);
    prior.provenance.sourceMetadata=prior.provenance.sourceMetadata.map(m=>({...m,
      startedAt:m.startedAt.replace("2026-10-11","2026-10-12"),completedAt:m.completedAt.replace("2026-10-11","2026-10-12")}));
    const mock=db({},undefined,[prior]);
    const result=await replaceFloridaCandidateFinanceSnapshot({db:mock.pool,link:link(),summary:{totalReceipts:9999},
      syncedAt:new Date("2030-01-01T00:00:00Z"),pacFinance:finance});
    expect(result).toMatchObject({summaryWritten:true,pacDonorsWritten:0});
    expect(pacMutations(mock)).toEqual([]);
    expect(call(mock,"INSERT INTO public.fl_candidate_finance_summaries")[1]?.[2]).toBe(9999);
    expect(statements(mock).at(-1)).toBe("COMMIT");
  });
  it("preserves an omitted prior period even when current amounts and closing source are valid", async () => {
    const finance=await pacFinance(),prior=storedSource(finance);
    prior.provenance.reports=[...prior.provenance.reports,{...prior.provenance.reports[0]!,
      sequence:7,nativeSequence:7,reportType:"Q2",periodStart:"2026-04-01",periodEnd:"2026-06-30"}];
    const mock=db({},undefined,[prior]);
    expect((await replaceFloridaCandidateFinanceSnapshot({db:mock.pool,link:link(),summary:{totalReceipts:5000},pacFinance:finance}))
      .pacDonorsWritten).toBe(0);
    expect(pacMutations(mock)).toEqual([]);
    expect(statements(mock).at(-1)).toBe("COMMIT");
  });
  it("accepts independently verified same-period amendment despite changed sequence and fingerprint", async () => {
    const finance=await pacFinance(),prior=storedSource(finance);
    prior.provenance.reports=prior.provenance.reports.map(r=>({...r,sequence:5,nativeSequence:5,amended:false,
      financialFingerprint:"b".repeat(64)}));
    const mock=db({},undefined,[prior]);
    expect((await replaceFloridaCandidateFinanceSnapshot({db:mock.pool,link:link(),pacFinance:finance})).pacDonorsWritten).toBe(1);
    expect(pacMutations(mock)).toHaveLength(3);
  });
  it("accepts a current same-period independently verified waiver clear", async () => {
    const priorFinance=await pacFinance(),prior=storedSource(priorFinance),finance=await pacFinance([]);
    for(const reports of [finance.source.proof.reports,finance.finance.provenance.reports]){
      reports[0]!.waiver=true;reports[0]!.completeness="No Detail Records Found";
      reports[0]!.nativeSequence=null;
    }
    const mock=db({},undefined,[prior]);
    await replaceFloridaCandidateFinanceSnapshot({db:mock.pool,link:link(),pacFinance:finance});
    expect(pacMutations(mock)).toHaveLength(2);
    expect(call(mock,"DELETE FROM public.fl_candidate_finance_pac_donors")[1]).toEqual([linkId,2026,[]]);
  });
  it("does not let a verified empty component clear an absent prior period", async () => {
    const prior=storedSource(await pacFinance()),finance=await pacFinance([]);
    for(const reports of [finance.source.proof.reports,finance.finance.provenance.reports]){
      reports[0]!.reportType="Q2";reports[0]!.periodStart="2026-04-01";reports[0]!.periodEnd="2026-06-30";
    }
    const mock=db({},undefined,[prior]);
    await replaceFloridaCandidateFinanceSnapshot({db:mock.pool,link:link(),summary:{totalReceipts:1},pacFinance:finance});
    expect(pacMutations(mock)).toEqual([]);
    expect(statements(mock).at(-1)).toBe("COMMIT");
  });
  it.each([
    (p:ReturnType<typeof storedSource>)=>{p.source_account="123";},
    (p:ReturnType<typeof storedSource>)=>{p.election_year=2025;},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.version=2 as never;},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.authority="legacy" as never;},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.localContext.district="10";},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.context.sourceAccount="123";},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.windowStart="2026-01-01";},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.reports=[];},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.reports=[...p.provenance.reports,p.provenance.reports[0]!];},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.sourceMetadata=p.provenance.sourceMetadata.filter(m=>m.phase!=="after");},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.sourceMetadata[4]!.startedAt="not-a-source-time";},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.sourceMetadata[4]!.status=500;},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.sourceMetadata[4]!.url="https://example.com/";},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.sourceMetadata[4]!.sha256="b".repeat(64);},
    (p:ReturnType<typeof storedSource>)=>{p.provenance.reports[0]!.reviewStatus="Pending";},
  ])("preserves malformed/incompatible stored authority independently of direct %#",async change=>{
    const finance=await pacFinance(),prior=storedSource(finance);change(prior);
    const mock=db({},undefined,[prior]);
    await replaceFloridaCandidateFinanceSnapshot({db:mock.pool,link:link(),summary:{totalReceipts:5000},pacFinance:finance});
    expect(pacMutations(mock)).toEqual([]);
    expect(statements(mock).at(-1)).toBe("COMMIT");
  });
  it("throws on locked source-read failure so the existing transaction rolls back",async()=>{
    const mock=db({},"SELECT source_account");
    await expect(replaceFloridaCandidateFinanceSnapshot({db:mock.pool,link:link(),summary:{totalReceipts:5000},
      pacFinance:await pacFinance()})).rejects.toThrow("fixture write failed");
    expect(pacMutations(mock)).toEqual([]);
    expect(statements(mock).at(-1)).toBe("ROLLBACK");
  });
  it("retains the incoming generation before the newly awaited prior-source read",async()=>{
    const finance=await pacFinance(),prepared=await prepareFloridaCommitteeDonorFinance({pacFinance:finance,link:link()}),
      prior=storedSource(finance);
    const input={db:{query:vi.fn(async()=>({rows:[prior],rowCount:1}))},linkId,electionYear:2026,syncedAt:new Date(syncedAt),prepared};
    input.db.query.mockImplementationOnce(async()=>{
      input.linkId=candidateId;input.electionYear=2025;input.syncedAt.setUTCFullYear(2030);
      prepared.finance.donors[0]!.amount=999999;prepared.finance.provenance.reports=[];
      return {rows:[prior],rowCount:1};
    });
    await writeFloridaCommitteeDonorFinance(input);
    const mutation=input.db.query.mock.calls.find(c=>String(c[0]).includes("INSERT INTO public.fl_candidate_finance_pac_donors"));
    expect(mutation?.[1]?.slice(0,2)).toEqual([linkId,2026]);
    expect(mutation?.[1]?.[5]).toBe(1500);
    expect(mutation?.[1]?.at(-1)).toBe(syncedAt.toISOString());
  });
});

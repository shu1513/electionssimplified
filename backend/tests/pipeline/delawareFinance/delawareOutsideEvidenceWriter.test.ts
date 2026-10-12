import { describe, expect, it, vi } from "vitest";
import { writeDelawareOutsideEvidence } from "../../../src/pipeline/delawareFinance/delawareOutsideEvidenceWriter.js";
import type { DelawareVerifiedThirdPartyOutsideProof as Proof } from "../../../src/pipeline/delawareFinance/delawareThirdPartyOutsideSource.js";
import type { DelawareFinanceLinkInput } from "../../../src/pipeline/delawareFinance/delawareFinanceWriter.js";
const linkId = "33333333-3333-4333-8333-333333333333";
const link: DelawareFinanceLinkInput = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  electionId: "22222222-2222-4222-8222-222222222222",
  electionYear: 2026,
  candidateNameNormalized: "JANE EXAMPLE",
  officeName: "Attorney General",
  district: null,
  committeeId: "01005311",
  committeeName: "Jane Example for Delaware",
};
const sha = "a".repeat(64);
const file =
  "CampaignFinanceReport_Prelim_739099_315_829eb639-f068-43f2-8f7a-38576c55fbc6.pdf";
function proof(day = "02", cfId = "04006716"): Proof {
  const sourceUrl = `https://cfrs.elections.delaware.gov/Public/FiledReports?FileName=${file}&CommitteeID=739099&FilingCalendarID=315`;
  return {
    version: 1,
    scope: "reported_third_party_outside_expenses",
    candidateWideZeroAuthority: false,
    candidate: {
      candidateId: link.candidateId,
      electionId: link.electionId,
      electionYear: 2026,
      electionDate: "2026-11-03",
      electionStage: "general",
      candidateName: "Jane Example",
      officeName: "Attorney General",
      district: null,
      party: "Democratic",
      receivingCfId: link.committeeId,
      receivingMemberId: 458984,
      receivingCommitteeName: link.committeeName,
    },
    payer: {
      cfId,
      memberId: 739099,
      committeeName: "Example Third Party",
      committeeType: "04",
    },
    qualificationBasis: "source_reported_candidate_period_within_cycle",
    reports: [
      {
        fileName: file,
        sourceUrl,
        memberId: 739099,
        filingCalendarId: 315,
        periodStart: "2026-08-05",
        periodEnd: "2026-08-18",
        pdfSha256: sha,
        inventoryFingerprint: sha,
        financialFingerprint: sha,
        currentAuthority: "sole_report_in_complete_period_inventory",
      },
    ],
    allocations: [
      {
        transactionId: 786022,
        reportFileName: file,
        occurrence: 0,
        date: "2026-08-17",
        amountCents: 49901500,
        direction: "support",
        literalTarget:
          "Support of Jane Example - State Office - Attorney General - Democratic",
        sourceNativeCategory: "Other Expenses",
        nativeRowFingerprint: sha,
        qualificationReportFileName: file,
      },
    ],
    sourceMetadata: [0, 1].map((i) => ({
      url: sourceUrl,
      method: "GET",
      financeFields: null,
      requestScopeRedacted: false,
      attempt: 1,
      startedAt: `2026-10-${day}T0${i + 1}:00:00.000Z`,
      completedAt: `2026-10-${day}T0${i + 1}:01:00.000Z`,
      status: 200,
      contentType: "application/pdf",
      byteCount: 1000,
      sha256: sha,
    })),
  };
}
function provenance(...evidence: Proof[]) {
  return {
    version: 1,
    scope: "reported_third_party_outside_expenses",
    evidence,
  };
}
function stored(p: Proof) {
  return {
    committee_id: p.payer.cfId,
    committee_name: p.payer.committeeName,
    support_oppose: "support",
    amount: "499015.00",
    source_url: p.reports[0]!.sourceUrl,
  };
}
function db(rows: unknown[] = []) {
  return {
    query: vi.fn(async (_sql: string, _args?: unknown[]) => ({
      rows,
      rowCount: 1,
    })),
  };
}
function execute(
  database = db(),
  incoming: Proof[] = [proof()],
  prior: unknown = null,
) {
  return writeDelawareOutsideEvidence({
    db: database as never,
    linkId,
    link,
    syncedAt: new Date("2026-10-03T00:00:00Z"),
    incoming,
    prior,
  });
}
const mutations = (d: ReturnType<typeof db>) =>
  d.query.mock.calls.filter((c) => /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(c[0]));

describe("Delaware scoped positive outside writer", () => {
  it("writes exact positive groups and projected provenance without deleting or setting headline totals", async () => {
    const d = db(),
      p = proof();
    (p as unknown as Record<string, unknown>).rawAddress =
      "must never serialize";
    (p.sourceMetadata[0] as unknown as Record<string, unknown>).headers = {
      cookie: "must never serialize",
    };
    expect(await execute(d, [p])).toEqual({
      groupsWritten: 1,
      diagnostics: [],
    });
    expect(d.query.mock.calls[0]![0]).toContain("FOR UPDATE");
    const group = JSON.parse(d.query.mock.calls[1]![1]![2] as string);
    expect(group).toEqual([
      {
        committee_id: "04006716",
        committee_name: "Example Third Party",
        support_oppose: "support",
        amount: 499015,
        source_url: p.reports[0]!.sourceUrl,
      },
    ]);
    expect(JSON.stringify(d.query.mock.calls)).not.toContain(
      "must never serialize",
    );
    expect(d.query.mock.calls.map((c) => c[0]).join()).not.toMatch(
      /DELETE|outside_support_total|outside_oppose_total|breakdowns/,
    );
  });
  it("retains actual safe export URL controls and rejects nonblank opaque filenames", async () => {
    const p = proof(),
      d = db();
    p.sourceMetadata = [
      ...p.sourceMetadata,
      {
        ...p.sourceMetadata[0]!,
        url: "https://cfrs.elections.delaware.gov/Public/ExportCSVNew_TP?theme=vista&Grid-page=1&Grid-size=15&Grid-filter=~&fname=&filter=~&orderBy=&page=1",
        contentType: "text/csv",
      },
    ];
    expect((await execute(d, [p])).groupsWritten).toBe(1);
    const rejected = db();
    p.sourceMetadata[2]!.url += "secret";
    // A nonblank fname is not an observed public financial document identity.
    p.sourceMetadata[2]!.url = p.sourceMetadata[2]!.url.replace(
      "fname=&",
      "fname=opaque&",
    );
    expect((await execute(rejected, [p])).groupsWritten).toBe(0);
    expect(mutations(rejected)).toHaveLength(0);
  });
  it("accepts only the exact legacy Delaware statewide label as null seat", async () => {
    const d = db();
    const r = await writeDelawareOutsideEvidence({
      db: d as never,
      linkId,
      link: { ...link, district: "Delaware" },
      syncedAt: new Date("2026-10-03T00:00:00Z"),
      prior: null,
      incoming: [proof()],
    });
    expect(r.groupsWritten).toBe(1);
    expect(
      JSON.parse(d.query.mock.calls[2]![1]![2] as string).evidence[0].candidate
        .district,
    ).toBeNull();
  });
  it.each(["1", "District 1", "delaware", "State of Delaware", ""])(
    "preserves unsupported local seat %s",
    async (district) => {
      const d = db();
      const r = await writeDelawareOutsideEvidence({
        db: d as never,
        linkId,
        link: { ...link, district },
        syncedAt: new Date("2026-10-03T00:00:00Z"),
        prior: null,
        incoming: [proof()],
      });
      expect(r.groupsWritten).toBe(0);
      expect(mutations(d)).toHaveLength(0);
    },
  );
  it("does not apply the legacy state-label projection to a legislative office", async () => {
    const d = db(),
      p = proof();
    p.candidate.officeName = "State Representative";
    p.allocations[0]!.literalTarget =
      "Support of Jane Example - State Office - State Representative - Democratic";
    const r = await writeDelawareOutsideEvidence({
      db: d as never,
      linkId,
      link: {
        ...link,
        officeName: "State Lower Chamber Legislator",
        district: "Delaware",
      },
      syncedAt: new Date("2026-10-03T00:00:00Z"),
      prior: null,
      incoming: [p],
    });
    expect(r.groupsWritten).toBe(0);
    expect(mutations(d)).toHaveLength(0);
  });
  it("sums every uncapped allocation and retains distinct equal gift IDs", async () => {
    const p = proof(),
      d = db();
    p.allocations = Array.from({ length: 7 }, (_, i) => ({
      ...p.allocations[0]!,
      transactionId: 786022 + i,
      occurrence: i,
      amountCents: 100,
    }));
    expect((await execute(d, [p])).groupsWritten).toBe(1);
    expect(JSON.parse(d.query.mock.calls[1]![1]![2] as string)[0].amount).toBe(
      7,
    );
  });
  it("retains unrelated payer provenance and writes only the independently refreshed payer", async () => {
    const a = proof("01"),
      b = proof("01", "04009999");
    b.allocations[0]!.transactionId = 888888;
    const d = db([stored(a), stored(b)]);
    expect(
      (await execute(d, [proof("02")], provenance(a, b))).groupsWritten,
    ).toBe(1);
    expect(JSON.parse(d.query.mock.calls[1]![1]![2] as string)).toHaveLength(1);
    expect(
      JSON.parse(d.query.mock.calls[2]![1]![2] as string).evidence.map(
        (p: Proof) => p.payer.cfId,
      ),
    ).toEqual(["04006716", "04009999"]);
  });
  it.each([
    "older",
    "same_time",
    "missing_id",
    "direction",
    "scope",
    "missing_period",
  ])("preserves prior payer for %s replacement", async (kind) => {
    const old = proof("02"),
      next = proof("03"),
      d = db([stored(old)]);
    if (kind === "older") next.sourceMetadata = proof("01").sourceMetadata;
    if (kind === "same_time") next.sourceMetadata = old.sourceMetadata;
    if (kind === "missing_id") next.allocations[0]!.transactionId++;
    if (kind === "direction") {
      next.allocations[0]!.direction = "oppose";
      next.allocations[0]!.literalTarget =
        next.allocations[0]!.literalTarget.replace("Support", "Oppose");
    }
    if (kind === "scope") next.candidate.electionDate = "2026-11-04";
    if (kind === "missing_period") {
      next.reports[0]!.periodStart = "2026-08-06";
    }
    const r = await execute(d, [next], provenance(old));
    expect(r.groupsWritten).toBe(0);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(mutations(d)).toHaveLength(0);
  });
  it("refreshes legacy reversed occurrence bindings without changing the outside total", async () => {
    const old = proof("01"),
      next = proof("02");
    for (const p of [old, next]) {
      p.allocations = [0, 1].map((occurrence) => ({
        ...p.allocations[0]!,
        occurrence,
        transactionId: 786022 + occurrence,
        amountCents: 24950750,
      }));
    }
    old.allocations[0]!.transactionId = 786023;
    old.allocations[1]!.transactionId = 786022;
    next.reports[0]!.financialFingerprint = "b".repeat(64);
    const d = db([stored(old)]);
    expect((await execute(d, [next], provenance(old))).groupsWritten).toBe(1);
    expect(JSON.parse(d.query.mock.calls[1]![1]![2] as string)[0].amount).toBe(
      499015,
    );
    const update = d.query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE public.de_candidate_finance_summaries"),
    )!;
    expect(JSON.parse(update[1]![2] as string).evidence[0].allocations).toEqual(
      next.allocations,
    );
  });
  it("accepts independently verified same-period amendment identity with retained IDs and newer closure", async () => {
    const old = proof("01"),
      next = proof("02"),
      d = db([stored(old)]);
    next.reports[0]!.financialFingerprint = "b".repeat(64);
    next.allocations[0]!.amountCents = 60000000;
    expect((await execute(d, [next], provenance(old))).groupsWritten).toBe(1);
    expect(JSON.parse(d.query.mock.calls[1]![1]![2] as string)[0].amount).toBe(
      600000,
    );
  });
  it.each([
    "candidate",
    "election",
    "year",
    "receiver",
    "name",
    "office",
    "seat",
    "literal",
    "payer",
    "duplicate_id",
    "zero",
    "unsafe",
    "missing_closing",
    "redacted",
    "bad_hash",
  ])("omits malformed %s proof before mutations", async (kind) => {
    const p = proof(),
      d = db();
    if (kind === "candidate")
      p.candidate.candidateId = "44444444-4444-4444-8444-444444444444";
    if (kind === "election")
      p.candidate.electionId = "44444444-4444-4444-8444-444444444444";
    if (kind === "year") p.candidate.electionYear = 2028;
    if (kind === "receiver") p.candidate.receivingCfId = "01009999";
    if (kind === "name") p.candidate.candidateName = "Other Person";
    if (kind === "office") p.candidate.officeName = "Governor";
    if (kind === "seat") p.candidate.district = "1";
    if (kind === "literal")
      p.allocations[0]!.literalTarget =
        "Support of Other Person - State Office - Attorney General - Democratic";
    if (kind === "payer") p.payer.cfId = "02006716";
    if (kind === "duplicate_id")
      p.allocations = [
        p.allocations[0]!,
        { ...p.allocations[0]!, occurrence: 1 },
      ];
    if (kind === "zero") p.allocations[0]!.amountCents = 0;
    if (kind === "unsafe")
      p.allocations[0]!.amountCents = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "missing_closing")
      p.sourceMetadata = p.sourceMetadata.slice(0, 1);
    if (kind === "redacted") p.sourceMetadata[0]!.requestScopeRedacted = true;
    if (kind === "bad_hash") p.sourceMetadata[0]!.sha256 = "bad";
    expect((await execute(d, [p])).groupsWritten).toBe(0);
    expect(mutations(d)).toHaveLength(0);
  });
  it("preserves duplicate payer submissions instead of accepting the first", async () => {
    const d = db();
    expect((await execute(d, [proof(), proof()])).groupsWritten).toBe(0);
    expect(mutations(d)).toHaveLength(0);
  });
  it("rejects a source transaction claimed by two different payers", async () => {
    const d = db();
    expect(
      (await execute(d, [proof(), proof("02", "04009999")])).groupsWritten,
    ).toBe(0);
    expect(mutations(d)).toHaveLength(0);
    const old = proof("01"),
      retained = db([stored(old)]);
    expect(
      (await execute(retained, [proof("03", "04009999")], provenance(old)))
        .groupsWritten,
    ).toBe(0);
    expect(mutations(retained)).toHaveLength(0);
  });
  it("preserves omitted and malformed prior components without false zeros", async () => {
    const d = db([stored(proof())]);
    expect((await execute(d, [])).groupsWritten).toBe(0);
    expect(
      (await execute(d, [proof()], { version: 1, evidence: [] })).groupsWritten,
    ).toBe(0);
    expect(mutations(d)).toHaveLength(0);
  });
  it.each(["legacy", "amount", "url", "missing"])(
    "preserves stored %s materialization mismatch",
    async (kind) => {
      const old = proof("01"),
        row = stored(old),
        d = db(
          kind === "missing"
            ? []
            : [
                {
                  ...row,
                  ...(kind === "amount" ? { amount: "499014.99" } : {}),
                  ...(kind === "url"
                    ? { source_url: "https://example.com" }
                    : {}),
                },
              ],
        );
      expect(
        (
          await execute(
            d,
            [proof()],
            kind === "legacy" ? null : provenance(old),
          )
        ).groupsWritten,
      ).toBe(0);
      expect(mutations(d)).toHaveLength(0);
    },
  );
  it("preserves amounts whose dollar-number serialization would lose a cent", async () => {
    const d = db(),
      p = proof();
    p.allocations[0]!.amountCents = Number.MAX_SAFE_INTEGER;
    expect((await execute(d, [p])).groupsWritten).toBe(0);
    expect(mutations(d)).toHaveLength(0);
  });
  it("fails for enclosing rollback if the summary provenance row vanished", async () => {
    const d = db();
    d.query.mockImplementation(async (sql) => ({
      rows: [],
      rowCount: /^UPDATE/.test(sql) ? 0 : 1,
    }));
    await expect(execute(d)).rejects.toThrow("summary row unavailable");
  });
  it("allows an independent new payer when another payer refresh is unproven", async () => {
    const old = proof("02"),
      d = db([stored(old)]);
    const independent = proof("03", "04009999");
    independent.allocations[0]!.transactionId = 888888;
    const r = await execute(d, [proof("01"), independent], provenance(old));
    expect(r.groupsWritten).toBe(1);
    expect(r.diagnostics).toHaveLength(1);
    expect(
      JSON.parse(d.query.mock.calls[1]![1]![2] as string)[0].committee_id,
    ).toBe("04009999");
  });
  it("retains the synchronous caller generation across a database await", async () => {
    let release!: (value: unknown) => void;
    const d = db(),
      p = proof(),
      l = { ...link },
      syncedAt = new Date("2026-10-03T00:00:00Z");
    d.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as never,
    );
    const pending = writeDelawareOutsideEvidence({
      db: d as never,
      linkId,
      link: l,
      syncedAt,
      prior: null,
      incoming: [p],
    });
    p.allocations[0]!.amountCents = 1;
    l.electionYear = 2028;
    syncedAt.setFullYear(2028);
    release({ rows: [], rowCount: 0 });
    await pending;
    expect(JSON.parse(d.query.mock.calls[1]![1]![2] as string)[0].amount).toBe(
      499015,
    );
    expect(d.query.mock.calls[1]![1]![1]).toBe(2026);
    expect(d.query.mock.calls[1]![1]![3]).toEqual(
      new Date("2026-10-03T00:00:00Z"),
    );
  });
  it.each([0, 1, 2])(
    "propagates database failure at query %s for enclosing rollback",
    async (index) => {
      const d = db();
      d.query.mockImplementationOnce(
        index === 0
          ? async () => {
              throw new Error("database failure");
            }
          : async () => ({ rows: [], rowCount: 0 }),
      );
      if (index > 0)
        d.query.mockImplementationOnce(
          index === 1
            ? async () => {
                throw new Error("database failure");
              }
            : async () => ({ rows: [], rowCount: 0 }),
        );
      if (index > 1)
        d.query.mockImplementationOnce(async () => {
          throw new Error("database failure");
        });
      await expect(execute(d)).rejects.toThrow("database failure");
    },
  );
});

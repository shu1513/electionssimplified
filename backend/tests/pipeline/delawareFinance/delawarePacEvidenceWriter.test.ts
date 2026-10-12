import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  writeDelawarePacEvidence,
  type DelawarePacEvidence,
} from "../../../src/pipeline/delawareFinance/delawarePacEvidenceWriter.js";
import { projectDelawareFinanceSourceMetadata } from "../../../src/pipeline/delawareFinance/delawareOutsideEvidenceWriter.js";
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
const sha = "a".repeat(64),
  file =
    "CampaignFinanceReport_Prelim_458984_315_829eb639-f068-43f2-8f7a-38576c55fbc6.pdf";
const sourceUrl = `https://cfrs.elections.delaware.gov/Public/FiledReports?FileName=${file}&CommitteeID=458984&FilingCalendarID=315`;
function evidence(
  day = "02",
  options: {
    fallback?: boolean;
    returnCents?: number;
    inKind?: boolean;
    classes?: boolean;
  } = {},
): DelawarePacEvidence {
  const primary = "Political Action Committee",
    sourceClasses = options.classes ? ["PAC", primary] : [primary];
  const reportedContributorType = sourceClasses.join(" | ");
  const committeeId = options.fallback
    ? "reported:" +
      createHash("sha256")
        .update(JSON.stringify([primary, "EXAMPLE PAC"]))
        .digest("hex")
    : "02006666";
  const giftIds = options.inKind ? [1, 3] : [1],
    returnIds = options.returnCents === undefined ? [] : [2];
  const cashAmountCents = 60000 - (options.returnCents ?? 0),
    inKindAmountCents = options.inKind ? 10000 : 0;
  const donors = [
    {
      committeeId,
      committeeName: "Example PAC",
      committeeType: "Political Action Committee" as const,
      reportedContributorType,
      registeredCommitteeId: options.fallback ? null : committeeId,
      cashAmountCents,
      inKindAmountCents,
      contributionCount: giftIds.length,
      sourceUrl,
    },
  ];
  const sourceMetadata = [0, 1].map((i) => ({
    url: sourceUrl,
    sha256: sha,
    byteCount: 1000,
    startedAt: `2026-10-${day}T0${i + 1}:00:00.000Z`,
    completedAt: `2026-10-${day}T0${i + 1}:01:00.000Z`,
  }));
  return {
    donors,
    sourceProvenance: {
      version: 1,
      scope: "current_qualified_named_committee_gift_positions",
      target: {
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
      window: {
        start: "2026-01-01",
        end: "2026-12-31",
        basis: "complete_new_account_current_candidacy",
        sources: [],
      },
      reports: [
        {
          fileName: file,
          calendarId: 315,
          pdfSha256: sha,
          periodStart: "2026-01-01",
          periodEnd: "2026-08-18",
          cover: {
            pageNumber: 1,
            beginningBalanceCents: 0,
            receiptsCents: 60000 + inKindAmountCents,
            expendituresCents: options.returnCents ?? 0,
            endingBalanceCents: cashAmountCents + inKindAmountCents,
            reportingPeriodFrom: "01/01/2026",
            reportingPeriodTo: "08/18/2026",
            documentVersion: 1,
            method: "rows",
          },
          anonymous: [],
        },
      ],
      organizationFingerprints: [sha],
      receiptFingerprint: sha,
      expenseFingerprint: sha,
      occurrences: [
        {
          transactionId: 1,
          kind: "receipt",
          sourceCategory: null,
          date: "2026-08-01",
          amountCents: 60000,
          identityFingerprint: sha,
          sourceClass: primary,
          sourceMechanism: "Check",
        },
        ...(options.inKind
          ? [
              {
                transactionId: 3,
                kind: "receipt" as const,
                sourceCategory: null,
                date: "2026-08-02",
                amountCents: 10000,
                identityFingerprint: sha,
                sourceClass: primary,
                sourceMechanism: "In-Kind",
              },
            ]
          : []),
        ...(options.returnCents === undefined
          ? []
          : [
              {
                transactionId: 2,
                kind: "expense" as const,
                sourceCategory: "Return Contributions",
                date: "2026-08-03",
                amountCents: options.returnCents,
                identityFingerprint: sha,
                sourceClass: options.classes ? "PAC" : primary,
                sourceMechanism: "Check",
              },
            ]),
      ],
      sourceMetadata,
      registrySources: [
        {
          ...sourceMetadata[0]!,
          url: "https://cfrs.elections.delaware.gov/Public/Search?theme=vista",
        },
      ],
      donors: donors.map((d) => ({
        committeeId: d.committeeId,
        committeeType: d.committeeType,
        reportedContributorType,
        registeredCommitteeId: d.registeredCommitteeId,
        sourceClasses,
        giftIds,
        returnIds,
        cashAmountCents,
        inKindAmountCents,
      })),
    },
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
function run(
  d = db(),
  incoming: DelawarePacEvidence | undefined = evidence(),
  prior: unknown = null,
  l = link,
) {
  return writeDelawarePacEvidence({
    db: d as never,
    linkId,
    link: l,
    syncedAt: new Date("2026-10-03T00:00:00Z"),
    incoming,
    prior,
  });
}
function writes(d: ReturnType<typeof db>) {
  return d.query.mock.calls.filter((c) =>
    /^\s*(INSERT|UPDATE|DELETE)\b/.test(c[0]),
  );
}
function saved(d: ReturnType<typeof db>) {
  const c = d.query.mock.calls.find((c) => c[0].startsWith("UPDATE"))!;
  return JSON.parse(c[1]![2] as string);
}
function table(p: DelawarePacEvidence) {
  return p.donors.map((d) => ({
    committee_id: d.committeeId,
    committee_name: d.committeeName,
    committee_type: d.committeeType,
    reported_contributor_type: d.reportedContributorType,
    registered_committee_id: d.registeredCommitteeId,
    cash_amount: (d.cashAmountCents / 100).toFixed(2),
    in_kind_amount: (d.inKindAmountCents / 100).toFixed(2),
    contribution_count: d.contributionCount,
    source_url: d.sourceUrl,
  }));
}
async function prior(p = evidence("01")) {
  const d = db();
  expect((await run(d, p)).donorsWritten).toBe(1);
  return { source: saved(d), rows: table(p) };
}

describe("Delaware complete committee-position writer (fake database)", () => {
  it("accepts the actual-sized official result metadata without widening CFRS limits or domains", () => {
    const meta = {
      url: "https://elections.delaware.gov/reports/GE2022.html",
      sha256: sha,
      byteCount: Math.ceil(9.4 * 1024 * 1024),
      startedAt: "2026-10-01T01:00:00.000Z",
      completedAt: "2026-10-01T01:01:00.000Z",
    };
    expect(
      projectDelawareFinanceSourceMetadata(meta, "official_election"),
    ).toEqual(meta);
    expect(() =>
      projectDelawareFinanceSourceMetadata(
        { ...meta, byteCount: 12 * 1024 * 1024 + 1 },
        "official_election",
      ),
    ).toThrow();
    expect(() =>
      projectDelawareFinanceSourceMetadata({ ...meta, url: sourceUrl }),
    ).toThrow();
    for (const url of [
      "https://elections.delaware.gov.evil.test/reports/GE2022.html",
      "https://user@elections.delaware.gov/reports/GE2022.html",
      "https://elections.delaware.gov/reports/GE2022.html?token=opaque",
      "https://elections.delaware.gov/unknown.html",
    ])
      expect(() =>
        projectDelawareFinanceSourceMetadata(
          { ...meta, url },
          "official_election",
        ),
      ).toThrow();
  });
  it("stores all exact signed positions and projected authority without headline/outside mutation", async () => {
    const d = db(),
      p = evidence("02", { inKind: true });
    (p.sourceProvenance as unknown as Record<string, unknown>).rawAddress =
      "do not serialize";
    (
      p.sourceProvenance.reports[0] as unknown as Record<string, unknown>
    ).sourcePages = "do not serialize";
    (
      p.sourceProvenance.sourceMetadata[0] as unknown as Record<string, unknown>
    ).headers = { cookie: "do not serialize" };
    expect(await run(d, p)).toEqual({ donorsWritten: 1, diagnostics: [] });
    expect(d.query.mock.calls[0]![0]).toContain("FOR UPDATE");
    expect(
      JSON.parse(d.query.mock.calls[1]![1]![2] as string)[0],
    ).toMatchObject({
      committee_id: "02006666",
      cash_amount: "600.00",
      in_kind_amount: "100.00",
      contribution_count: 2,
    });
    expect(
      d.query.mock.calls.find((c) => c[0].startsWith("DELETE"))![1],
    ).toEqual([linkId, 2026, ["02006666"]]);
    expect(JSON.stringify(d.query.mock.calls)).not.toMatch(
      /do not serialize|outside_|total_receipts|direct_contribution_total/,
    );
  });
  it.each([60000, 70000])(
    "retains exact zero/negative positions after return %s",
    async (returnCents) => {
      const d = db();
      expect(
        (await run(d, evidence("02", { returnCents }))).donorsWritten,
      ).toBe(1);
      expect(
        JSON.parse(d.query.mock.calls[1]![1]![2] as string)[0].cash_amount,
      ).toBe(returnCents === 60000 ? "0.00" : "-100.00");
    },
  );
  it("retains multiple literal classes on a unique registered CF and source-only nohit namespace", async () => {
    const legal = db();
    expect(
      (await run(legal, evidence("02", { returnCents: 10000, classes: true })))
        .donorsWritten,
    ).toBe(1);
    expect(saved(legal).donors[0].reportedContributorType).toBe(
      "PAC | Political Action Committee",
    );
    const reported = db();
    expect(
      (await run(reported, evidence("02", { fallback: true }))).donorsWritten,
    ).toBe(1);
    expect(saved(reported).donors[0].committeeId).toMatch(
      /^reported:[a-f0-9]{64}$/,
    );
    expect(saved(reported).donors[0].registeredCommitteeId).toBeNull();
  });
  it("accepts newer whole-component append while carrying all original gift identities", async () => {
    const old = await prior(),
      next = evidence("02");
    next.donors[0]!.cashAmountCents += 10000;
    next.donors[0]!.contributionCount++;
    next.sourceProvenance.donors[0]!.cashAmountCents += 10000;
    next.sourceProvenance.donors[0]!.giftIds.push(4);
    next.sourceProvenance.occurrences.push({
      ...next.sourceProvenance.occurrences[0]!,
      transactionId: 4,
      amountCents: 10000,
    });
    next.sourceProvenance.reports[0]!.cover.receiptsCents += 10000;
    next.sourceProvenance.reports[0]!.cover.endingBalanceCents += 10000;
    expect((await run(db(old.rows), next, old.source)).donorsWritten).toBe(1);
  });
  it.each([
    "older",
    "same_time",
    "missing_gift",
    "missing_return",
    "missing_report",
    "type",
    "name",
    "window",
  ])("preserves prior component for %s", async (kind) => {
    const old = await prior(evidence("02", { returnCents: 10000 })),
      next = evidence("03", { returnCents: 10000 }),
      d = db(old.rows);
    if (kind === "older")
      next.sourceProvenance.sourceMetadata =
        evidence("01").sourceProvenance.sourceMetadata;
    if (kind === "same_time")
      next.sourceProvenance.sourceMetadata =
        evidence("02").sourceProvenance.sourceMetadata;
    if (kind === "missing_gift") {
      next.sourceProvenance.occurrences[0]!.transactionId = 4;
      next.sourceProvenance.donors[0]!.giftIds = [4];
    }
    if (kind === "missing_return") {
      next.sourceProvenance.occurrences[1]!.transactionId = 5;
      next.sourceProvenance.donors[0]!.returnIds = [5];
    }
    if (kind === "missing_report")
      next.sourceProvenance.reports[0]!.periodEnd = "2026-08-17";
    if (kind === "type") next.donors[0]!.committeeType = "Political Committee";
    if (kind === "name") next.donors[0]!.committeeName = "Changed PAC Name";
    if (kind === "window") {
      next.sourceProvenance.window.start = "2026-01-02";
      next.sourceProvenance.reports[0]!.periodStart = "2026-01-02";
    }
    const r = await run(d, next, old.source);
    expect(r.donorsWritten).toBe(0);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(writes(d)).toHaveLength(0);
  });
  it.each([
    "candidate",
    "election",
    "year",
    "cf",
    "seat",
    "office",
    "person",
    "primary",
    "duplicate_donor",
    "claimed_id",
    "sum",
    "count",
    "source",
    "hash",
    "closing",
    "reported_id",
    "personal_class",
  ])("preserves malformed %s authority before mutation", async (kind) => {
    const p = evidence(),
      d = db();
    if (kind === "candidate")
      p.sourceProvenance.target.candidateId =
        "44444444-4444-4444-8444-444444444444";
    if (kind === "election")
      p.sourceProvenance.target.electionId =
        "44444444-4444-4444-8444-444444444444";
    if (kind === "year") p.sourceProvenance.target.electionYear = 2028;
    if (kind === "cf") p.sourceProvenance.target.receivingCfId = "01009999";
    if (kind === "seat") p.sourceProvenance.target.district = "1";
    if (kind === "office") p.sourceProvenance.target.officeName = "Governor";
    if (kind === "person")
      p.sourceProvenance.target.candidateName = "Other Person";
    if (kind === "primary")
      p.sourceProvenance.target.electionStage = "primary" as "general";
    if (kind === "duplicate_donor") {
      p.donors.push(p.donors[0]!);
      p.sourceProvenance.donors.push(p.sourceProvenance.donors[0]!);
    }
    if (kind === "claimed_id") p.sourceProvenance.donors[0]!.giftIds = [999];
    if (kind === "sum") p.donors[0]!.cashAmountCents++;
    if (kind === "count") p.donors[0]!.contributionCount++;
    if (kind === "source") p.donors[0]!.sourceUrl = "https://example.com/";
    if (kind === "hash") p.sourceProvenance.sourceMetadata[0]!.sha256 = "bad";
    if (kind === "closing") p.sourceProvenance.sourceMetadata.pop();
    if (kind === "reported_id") p.donors[0]!.registeredCommitteeId = null;
    if (kind === "personal_class") {
      p.donors[0]!.reportedContributorType = "Individual";
      p.sourceProvenance.donors[0]!.reportedContributorType = "Individual";
      p.sourceProvenance.donors[0]!.sourceClasses = ["Individual"];
    }
    expect((await run(d, p)).donorsWritten).toBe(0);
    expect(writes(d)).toHaveLength(0);
  });
  it.each(["legacy", "amount", "class", "count", "url", "missing"])(
    "preserves stored %s parity mismatch",
    async (kind) => {
      const old = await prior(),
        row = old.rows[0]!,
        d = db(
          kind === "missing"
            ? []
            : [
                {
                  ...row,
                  ...(kind === "amount" ? { cash_amount: "599.99" } : {}),
                  ...(kind === "class"
                    ? { committee_type: "Political Committee" }
                    : {}),
                  ...(kind === "count" ? { contribution_count: 2 } : {}),
                  ...(kind === "url"
                    ? { source_url: "https://example.com" }
                    : {}),
                },
              ],
        );
      expect(
        (await run(d, evidence(), kind === "legacy" ? null : old.source))
          .donorsWritten,
      ).toBe(0);
      expect(writes(d)).toHaveLength(0);
    },
  );
  it("accepts exact legacy statewide or canonical legislative seat projections only", async () => {
    expect(
      (await run(db(), evidence(), null, { ...link, district: "Delaware" }))
        .donorsWritten,
    ).toBe(1);
    const p = evidence();
    p.sourceProvenance.target.officeName = "State Representative";
    p.sourceProvenance.target.district = "40";
    expect(
      (
        await run(db(), p, null, {
          ...link,
          officeName: "State Lower Chamber Legislator",
          district: "District 040",
        })
      ).donorsWritten,
    ).toBe(1);
    const d = db();
    expect(
      (
        await run(d, p, null, {
          ...link,
          officeName: "State Lower Chamber Legislator",
          district: "District 39",
        })
      ).donorsWritten,
    ).toBe(0);
    expect(writes(d)).toHaveLength(0);
  });
  it("omits unknown input and preserves malformed prior without deleting rows", async () => {
    const d = db();
    expect(
      (
        await writeDelawarePacEvidence({
          db: d as never,
          linkId,
          link,
          syncedAt: new Date(),
          prior: null,
        })
      ).donorsWritten,
    ).toBe(0);
    expect((await run(d, evidence(), {})).donorsWritten).toBe(0);
    expect(writes(d)).toHaveLength(0);
  });
  it("allows a genuinely verified empty component only with matching empty prior materialization", async () => {
    const p = evidence();
    p.donors = [];
    p.sourceProvenance.donors = [];
    p.sourceProvenance.occurrences[0]!.sourceClass = "Individual";
    const d = db();
    expect((await run(d, p)).donorsWritten).toBe(0);
    expect(
      d.query.mock.calls.find((c) => c[0].startsWith("DELETE"))![1],
    ).toEqual([linkId, 2026, []]);
    expect(saved(d).version).toBe(1);
    const retained = db(table(evidence()));
    expect((await run(retained, p)).donorsWritten).toBe(0);
    expect(writes(retained)).toHaveLength(0);
  });
  it("rejects a component that omits an explicitly reported committee gift", async () => {
    const p = evidence(),
      d = db();
    p.donors = [];
    p.sourceProvenance.donors = [];
    expect((await run(d, p)).donorsWritten).toBe(0);
    expect(writes(d)).toHaveLength(0);
  });
  it("excludes ordinary committee payee expenses from required donor claims", async () => {
    const p = evidence(),
      d = db();
    p.sourceProvenance.occurrences.push({
      ...p.sourceProvenance.occurrences[0]!,
      transactionId: 8,
      kind: "expense",
      sourceCategory: "Other Expenses",
      amountCents: 1000,
    });
    p.sourceProvenance.reports[0]!.cover.expendituresCents += 1000;
    p.sourceProvenance.reports[0]!.cover.endingBalanceCents -= 1000;
    expect((await run(d, p)).donorsWritten).toBe(1);
  });
  it("rejects a typed returned contribution omitted from donor attribution", async () => {
    const p = evidence(),
      d = db();
    p.sourceProvenance.occurrences.push({
      ...p.sourceProvenance.occurrences[0]!,
      transactionId: 8,
      kind: "expense",
      sourceCategory: "Return Contributions",
      amountCents: 1000,
    });
    expect((await run(d, p)).donorsWritten).toBe(0);
    expect(writes(d)).toHaveLength(0);
  });
  it("retains caller data before the first await and preserves exact database handle", async () => {
    const d = db(),
      another = db(),
      p = evidence(),
      l = { ...link },
      syncedAt = new Date("2026-10-03T00:00:00Z");
    let resolve!: (value: unknown) => void;
    d.query.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }) as never,
    );
    const input = {
      db: d as never,
      linkId,
      link: l,
      syncedAt,
      incoming: p,
      prior: null,
    };
    const pending = writeDelawarePacEvidence(input);
    p.donors[0]!.cashAmountCents = 1;
    l.electionYear = 2028;
    syncedAt.setFullYear(2028);
    input.db = another as never;
    resolve({ rows: [], rowCount: 0 });
    await pending;
    expect(another.query).not.toHaveBeenCalled();
    expect(
      JSON.parse(d.query.mock.calls[1]![1]![2] as string)[0].cash_amount,
    ).toBe("600.00");
    expect(d.query.mock.calls[1]![1]![1]).toBe(2026);
  });
  it.each([0, 1, 2, 3])(
    "propagates database failure at query %s for atomic rollback",
    async (index) => {
      const d = db();
      let call = 0;
      d.query.mockImplementation(async () => {
        if (call++ === index) throw new Error("database failure");
        return { rows: [], rowCount: 1 };
      });
      await expect(run(d)).rejects.toThrow("database failure");
    },
  );
  it("throws if the provenance summary row vanished after donor writes", async () => {
    const d = db();
    d.query.mockImplementation(async (sql) => ({
      rows: [],
      rowCount: sql.startsWith("UPDATE") ? 0 : 1,
    }));
    await expect(run(d)).rejects.toThrow("summary row unavailable");
  });
});

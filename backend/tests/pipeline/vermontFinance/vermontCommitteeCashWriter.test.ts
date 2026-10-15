import type { Pool, PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  storeVermontCommitteeCash,
  projectVermontCommitteeCashReceivingContext,
  type VermontCommitteeCashWriteInput,
} from "../../../src/pipeline/vermontFinance/vermontCommitteeCashWriter.js";
const ID = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const OBSERVED = new Date("2026-10-12T12:00:00Z");
const GUARD = {
  link_id: ID,
  election_year: 2026,
  filer_registration_guid: ID,
  entity_id: 123,
  filer_name: "TEST, PERSON",
  candidate_name: "Person Test",
  link_office_name: "Governor",
  office_scope: "statewide",
  office_name: "Governor",
  election_date: "2026-11-03",
  district_type: "statewide",
  geoid_compact: "50",
};
function harness(
  options: {
    guards?: unknown[];
    otherOwners?: unknown[];
    marker?: unknown;
    fail?: string;
    retainedCount?: number;
    mutate?: () => void;
  } = {},
) {
  const donors = new Map<string, unknown[]>();
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (options.fail && sql.includes(options.fail))
      throw new Error("synthetic database failure");
    if (sql.includes("FROM public.vt_candidate_finance_links other_link"))
      return { rows: options.otherOwners ?? [] };
    if (sql.includes("FOR UPDATE OF link"))
      return { rows: options.guards ?? [GUARD] };
    if (sql.includes("FROM public.vt_candidate_finance_pac_sources"))
      return { rows: options.marker ? [options.marker] : [] };
    if (sql.includes("INSERT INTO public.vt_candidate_finance_pac_donors")) {
      const key = String(values[2]) + ":" + values[3];
      const previous = donors.get(key);
      if (
        previous &&
        JSON.stringify(previous.slice(4, 9)) !==
          JSON.stringify(values.slice(4, 9))
      )
        return { rows: [] };
      if (!previous) donors.set(key, [...values]);
      return { rows: [{ committee_id: values[3] }] };
    }
    if (sql.includes("count(*)"))
      return {
        rows: [
          {
            count:
              options.retainedCount ??
              [...donors.keys()].filter((k) => k.startsWith(String(values[2])))
                .length,
          },
        ],
      };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => {
    options.mutate?.();
    return { query, release } as unknown as PoolClient;
  });
  return {
    db: { connect } as Pick<Pool, "connect">,
    query,
    connect,
    release,
    donors,
  };
}
function input(
  db: VermontCommitteeCashWriteInput["db"],
): VermontCommitteeCashWriteInput {
  return {
    db,
    observedAt: new Date(OBSERVED),
    context: {
      linkId: ID,
      candidateId: ID,
      electionId: ID,
      electionYear: 2026,
      candidateName: "Person Test",
      receivingFilerName: "TEST, PERSON",
      filerRegistrationGuid: ID,
      entityId: 123,
      officeId: 19,
      officeName: "Governor",
      electionDate: "2026-11-03",
      electionType: "general",
      sourceElectionId: 45,
      sourceElection: { electionId: 45, name: "General Election 2026" },
    },
    qualified: {
      status: "qualified",
      positions: [
        {
          committeeId: "reported:SAMPLE PAC",
          committeeName: "Sample PAC",
          committeeType: "Political Action Committee",
          amountCents: 60000,
          contributionCount: 1,
          giftTransactions: [
            {
              transactionId: 1,
              transactionVersionId: 1,
              guid: ID,
              reportGuid: REPORT,
              date: "2025-01-01",
              amountCents: 60000,
            },
          ],
          sourceUrl: "https://campaignfinance.vermont.gov/",
        },
      ],
      periodStart: "2024-12-13",
      periodEnd: "2026-09-28",
      reportPeriods: [
        {
          filerReportGuid: REPORT,
          filerReportVersionId: 1,
          periodStart: "2024-12-13",
          periodEnd: "2026-09-28",
          pdfSha256: "a".repeat(64),
        },
      ],
      sourceElectionId: 45,
      monetaryCashCents: 100000,
      unclassifiedCashCents: 20000,
      unclassifiedCashCount: 2,
      captureDigest: "b".repeat(64),
      diagnostics: [],
    },
  };
}
function marker(i: VermontCommitteeCashWriteInput) {
  return {
    receiving_context: projectVermontCommitteeCashReceivingContext(i.context),
    observed_at: i.observedAt.toISOString(),
    period_start: i.qualified.periodStart,
    period_end: i.qualified.periodEnd,
    report_periods: structuredClone(i.qualified.reportPeriods),
    source_election_id: 45,
    capture_digest: i.qualified.captureDigest,
    cash_control_total: "1000.00",
    unclassified_cash_amount: "200.00",
    unclassified_cash_count: 2,
  };
}
const statements = (h: ReturnType<typeof harness>) =>
  h.query.mock.calls.map((c) => c[0]);
describe("Vermont retained committee cash writer", () => {
  it("retains a generation and writes only donor/source tables atomically", async () => {
    const h = harness();
    const i = input(h.db);
    await expect(storeVermontCommitteeCash(i)).resolves.toEqual({
      linkId: ID,
      captureDigest: "b".repeat(64),
      positionsWritten: 1,
    });
    const sql = statements(h).join("\n");
    expect(sql).toContain(
      "FOR UPDATE OF link,candidate,ce,election,office,district",
    );
    expect(sql).toContain("ce.status='declared'");
    expect(sql).toContain("candidate.merged_into_candidate_id IS NULL");
    expect(sql).not.toMatch(
      /DELETE|INSERT INTO public\.vt_candidate_finance_links|UPDATE public\.vt_candidate_finance_links|summaries|breakdowns|outside/,
    );
    expect(statements(h).at(-1)).toBe("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
    expect([...h.donors.values()][0]![6]).toBe("600.00");
  });
  it("serializes receiver ownership and rejects another canonical General owner", async () => {
    const h = harness({ otherOwners: [{ id: REPORT }] });
    await expect(storeVermontCommitteeCash(input(h.db))).rejects.toThrow(
      "conflicting active General owners",
    );
    expect(h.donors.size).toBe(0);
    expect(statements(h).at(-1)).toBe("ROLLBACK");
    const guardSql = statements(h).find((s) => s.includes("other_link"))!;
    expect(guardSql).toContain("election.election_stage='general'");
    expect(
      h.query.mock.calls.some(
        ([s, v]) =>
          s.includes("pg_advisory_xact_lock") &&
          String(v?.[0]).startsWith("vt-pac-filer:"),
      ),
    ).toBe(true);
  });
  it("preserves prior marker when a link was retargeted and checks projection fields", async () => {
    const i = input(harness().db),
      prior = marker(i);
    prior.receiving_context.candidateId = REPORT;
    const h = harness({ marker: prior });
    i.db = h.db;
    await expect(storeVermontCommitteeCash(i)).rejects.toThrow(
      "stored receiving context",
    );
    expect(h.donors.size).toBe(0);
    expect(
      projectVermontCommitteeCashReceivingContext(i.context),
    ).not.toHaveProperty("sourceElection");
    expect(
      Object.keys(projectVermontCommitteeCashReceivingContext(i.context)),
    ).toHaveLength(13);
  });
  it("stores complete empty metadata without removing older generations", async () => {
    const h = harness();
    const i = input(h.db);
    await storeVermontCommitteeCash(i);
    i.qualified.positions = [];
    i.qualified.captureDigest = "c".repeat(64);
    i.observedAt = new Date("2026-10-13T12:00:00Z");
    await expect(storeVermontCommitteeCash(i)).resolves.toMatchObject({
      positionsWritten: 0,
    });
    expect(h.donors.size).toBe(1);
    expect(
      statements(h).filter((s) =>
        s.includes("INSERT INTO public.vt_candidate_finance_pac_sources"),
      ),
    ).toHaveLength(2);
    expect(statements(h).join("\n")).not.toContain("DELETE");
  });
  it.each([-100, 0])(
    "retains signed/zero source donor positions (%i)",
    async (amount) => {
      const h = harness();
      const i = input(h.db);
      i.qualified.positions[0]!.amountCents = amount;
      i.qualified.positions[0]!.giftTransactions[0]!.amountCents = amount;
      i.qualified.positions[0]!.contributionCount = 0;
      await storeVermontCommitteeCash(i);
      expect([...h.donors.values()][0]![6]).toBe(
        amount === -100 ? "-1.00" : "0.00",
      );
    },
  );
  it("nets all signed occurrences and counts only positive occurrences", async () => {
    const h = harness(),
      i = input(h.db),
      p = i.qualified.positions[0]!;
    p.giftTransactions.push({
      ...p.giftTransactions[0]!,
      transactionId: 2,
      amountCents: -10000,
    });
    p.giftTransactions.push({
      ...p.giftTransactions[0]!,
      transactionId: 3,
      amountCents: 0,
    });
    p.amountCents = 50000;
    await storeVermontCommitteeCash(i);
    expect([...h.donors.values()][0]!.slice(6, 8)).toEqual(["500.00", 1]);
  });
  it("rejects a donor net inconsistent with its signed occurrences", async () => {
    const h = harness(),
      i = input(h.db);
    i.qualified.positions[0]!.amountCents = -100;
    await expect(storeVermontCommitteeCash(i)).rejects.toThrow();
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("snapshots caller data before connection awaits", async () => {
    let i: VermontCommitteeCashWriteInput;
    const h = harness({
      mutate: () => {
        i.context.entityId = 999;
        i.qualified.positions.length = 0;
        i.observedAt.setFullYear(2000);
      },
    });
    i = input(h.db);
    await expect(storeVermontCommitteeCash(i)).resolves.toMatchObject({
      positionsWritten: 1,
    });
    expect([...h.donors.values()][0]![9]).toEqual(OBSERVED);
  });
  it.each([
    { guards: [] },
    { guards: [GUARD, GUARD] },
    { guards: [{ ...GUARD, entity_id: 999 }] },
    { guards: [{ ...GUARD, filer_registration_guid: REPORT }] },
    { guards: [{ ...GUARD, candidate_name: "Other Person" }] },
    { guards: [{ ...GUARD, election_date: "2026-08-11" }] },
    { guards: [{ ...GUARD, geoid_compact: "51" }] },
    { guards: [{ ...GUARD, office_name: "Attorney General" }] },
  ])("refuses changed or ambiguous canonical ownership %#", async (options) => {
    const h = harness(options);
    await expect(storeVermontCommitteeCash(input(h.db))).rejects.toThrow(
      "unchanged active canonical",
    );
    expect(statements(h).at(-1)).toBe("ROLLBACK");
    expect(h.donors.size).toBe(0);
  });
  it.each([
    "older",
    "shorter",
    "missing-period",
    "equal-conflict",
    "malformed-prior",
  ])("preserves on %s source", async (kind) => {
    const i = input(harness().db);
    const prior = marker(i);
    if (kind === "older") prior.observed_at = "2026-10-13T12:00:00Z";
    if (kind === "shorter") prior.period_start = "2024-12-12";
    if (kind === "missing-period")
      prior.report_periods[0]!.periodEnd = "2026-08-31";
    if (kind === "equal-conflict") prior.capture_digest = "c".repeat(64);
    if (kind === "malformed-prior") prior.report_periods = [];
    const h = harness({ marker: prior });
    i.db = h.db;
    await expect(storeVermontCommitteeCash(i)).rejects.toThrow();
    expect(statements(h).at(-1)).toBe("ROLLBACK");
    expect(h.donors.size).toBe(0);
  });
  it("accepts a verified same-period edition replacement with newer observation", async () => {
    const i = input(harness().db);
    const prior = marker(i);
    i.db = harness({ marker: prior }).db;
    i.observedAt = new Date("2026-10-13T12:00:00Z");
    i.qualified.captureDigest = "c".repeat(64);
    i.qualified.reportPeriods[0]!.filerReportVersionId = 2;
    await expect(storeVermontCommitteeCash(i)).resolves.toMatchObject({
      positionsWritten: 1,
    });
  });
  it("preserves a same digest whose financial metadata changed despite a later observation", async () => {
    const i = input(harness().db),
      prior = marker(i);
    i.observedAt = new Date("2026-10-13T12:00:00Z");
    i.qualified.monetaryCashCents = 100001;
    const h = harness({ marker: prior });
    i.db = h.db;
    await expect(storeVermontCommitteeCash(i)).rejects.toThrow(
      "conflicts with its watermark",
    );
    expect(h.donors.size).toBe(0);
  });
  it("permits an identical pointer replay without changing retained observation timestamps", async () => {
    const i = input(harness().db),
      h = harness({ marker: marker(i) });
    i.db = h.db;
    await storeVermontCommitteeCash(i);
    await storeVermontCommitteeCash(i);
    expect(h.donors.size).toBe(1);
    expect([...h.donors.values()][0]![9]).toEqual(OBSERVED);
  });
  it("refuses immutable same-digest donor changes and membership loss", async () => {
    const h = harness();
    const i = input(h.db);
    await storeVermontCommitteeCash(i);
    i.qualified.positions[0]!.amountCents = 50000;
    i.qualified.positions[0]!.giftTransactions[0]!.amountCents = 50000;
    await expect(storeVermontCommitteeCash(i)).rejects.toThrow(
      "generation conflicts",
    );
    i.qualified.positions = [];
    await expect(storeVermontCommitteeCash(i)).rejects.toThrow(
      "membership conflicts",
    );
  });
  it.each([
    "INSERT INTO public.vt_candidate_finance_pac_donors",
    "INSERT INTO public.vt_candidate_finance_pac_sources",
  ])("rolls back failed %s", async (fail) => {
    const h = harness({ fail });
    await expect(storeVermontCommitteeCash(input(h.db))).rejects.toThrow(
      "synthetic database",
    );
    expect(statements(h).at(-1)).toBe("ROLLBACK");
    expect(statements(h)).not.toContain("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it.each([
    "namespace",
    "role",
    "unsafe",
    "gift-count",
    "source-url",
    "period-date",
    "election",
    "duplicate-gift",
  ])("rejects malformed %s before connecting", async (kind) => {
    const h = harness();
    const i = input(h.db);
    const p = i.qualified.positions[0]!;
    if (kind === "namespace") p.committeeId = "registry:123";
    if (kind === "role") p.committeeType = "Political Party" as never;
    if (kind === "unsafe") p.amountCents = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "gift-count") p.contributionCount = 2;
    if (kind === "source-url") p.sourceUrl = "https://example.com/";
    if (kind === "period-date") i.qualified.periodStart = "2024-02-30";
    if (kind === "election") i.qualified.sourceElectionId = 46;
    if (kind === "duplicate-gift") {
      p.giftTransactions.push({ ...p.giftTransactions[0]! });
      p.contributionCount = 2;
    }
    await expect(storeVermontCommitteeCash(i)).rejects.toThrow();
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("migration has retained generation keys, finite money and no year-window shortcut", () => {
    const sql = readFileSync(
      new URL(
        "../../../../db/migrations/342_add_vermont_committee_cash.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain(
      "PRIMARY KEY (link_id,election_year,capture_digest,committee_id)",
    );
    expect(sql).toContain("'NaN','Infinity','-Infinity'");
    expect(sql).not.toMatch(/amount > 0|make_date|DELETE FROM/); // CASCADE is referential lifecycle, not generation replacement.
  });
});

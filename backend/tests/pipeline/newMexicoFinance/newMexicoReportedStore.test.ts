import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock(
  "../../../src/pipeline/newMexicoFinance/newMexicoReportedEligibility.js",
  async (original) => ({
    ...(await original<object>()),
    loadNewMexicoReportedReceiver: mocks.load,
  }),
);
import { NM_REPORTED_PATHS } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedNative.js";
import { getNewMexicoReportedSource } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedSource.js";
import {
  readNewMexicoReportedComponent,
  validateNewMexicoStoredClosure,
  writeNewMexicoReportedComponent,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedStore.js";
import { overlayNewMexicoReportedComponent } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedReader.js";
import { loadNewMexicoCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/newMexicoFinance/newMexicoBallotLookupFinanceLoader.js";
import type { NewMexicoReportedReceiver } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedReceiver.js";
const receiver: NewMexicoReportedReceiver = {
  linkId: "synthetic-link",
  candidateId: "synthetic-candidate",
  electionId: "synthetic-election",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingId: "42",
  legacyCommitteeName: "Synthetic legacy",
  candidateAliases: ["Avery Quinn Sample", "Avery Sample"],
  officeScope: "statewide",
  officeName: "Governor",
  linkOfficeName: "Governor",
  district: null,
  canonicalDistrictName: "New Mexico",
  canonicalDistrictType: "statewide",
  activeCandidateOwnerCount: 1,
};
const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T18:00:00.000Z"));
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_REPORTED_COMMITTEE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", "true");
  mocks.load.mockReset();
  mocks.load.mockResolvedValue(receiver);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function packets() {
  const cacheDir = await fs.mkdtemp(
    join(await fs.realpath(tmpdir()), "nm-store-synthetic-"),
  );
  roots.push(cacheDir);
  await fs.chmod(cacheDir, 0o700);
  const transport = async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const value =
      path === NM_REPORTED_PATHS.registry
        ? [
            {
              IDNumber: "synthetic-native",
              RegistrationId: "synthetic-registration",
              CandidateName: "Avery Quinn Sample",
              OfficeName: "GOVERNOR",
              ElectionYear: 2026,
              OfficeId: 1,
              ElectionId: 2,
              DistrictId: 0,
              District: null,
              TotalRows: 1,
            },
          ]
        : path === NM_REPORTED_PATHS.receiver
          ? [
              {
                IDNumber: 0,
                MemberID: "synthetic-member",
                CandidateName: "Avery Quinn Sample",
                OfficeName: "GOVERNOR",
                OfficeId: 1,
                ElectionYear: 2026,
                DistrictId: 0,
                District: null,
              },
            ]
          : path === NM_REPORTED_PATHS.transactions
            ? [
                {
                  TransactionId: 10,
                  TransactionVersionId: 1,
                  Amount: 12.34,
                  TransactionDate: "2026-10-01T00:00:00",
                  FiledDate: "2026-10-05T00:00:00",
                  Name: "Synthetic Spender",
                  CommitteeId: "synthetic-spender",
                  CommitteeVersionId: 1,
                  ElectionYear: 2026,
                  ElectionCycleId: 3,
                  Type: "Independent Expenditure",
                  Stance: "Support",
                  TotalRows: 1,
                },
              ]
            : path === NM_REPORTED_PATHS.expenditure
              ? {
                  Transaction: {
                    TransactionId: 10,
                    TransactionVersid: 1,
                    TransactionAmount: 12.34,
                    TransactionDate: "2026-10-01T00:00:00",
                    FiledDate: "2026-10-05T00:00:00",
                    TransactionCategoryDesc: "Independent Expenditure",
                    TransactionCategoryCode: "IIE",
                    TransactionTypeCode: "IE",
                    Amended: 0,
                    DeleteFlag: null,
                    StatusFlag: null,
                    CommitteeVersid: 1,
                    ElectionId: 3,
                    TransactionHistory: 0,
                  },
                  MemberCandidate: {
                    CandidateType: "CAN",
                    CandidateName: "Avery Quinn Sample",
                    CandidateDescription: "Avery Quinn Sample",
                    CandidateId: 42,
                    SupportFlag: 1,
                    BallotQuestion: null,
                    TransactionAmount: null,
                    Amount: null,
                  },
                }
              : (() => {
                  throw Error("Unexpected synthetic request");
                })();
    return new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  };
  const registry = await getNewMexicoReportedSource({
    scope: { kind: "registry", year: 2026, selector: null },
    cacheDir,
    transport,
  });
  const identity = await getNewMexicoReportedSource({
    scope: { kind: "receiver", year: 2026, selector: "synthetic-native" },
    cacheDir,
    transport,
  });
  const financial = await getNewMexicoReportedSource({
    scope: { kind: "ie", year: 2026, selector: null },
    cacheDir,
    transport,
  });
  return { registry, identity, financial, cacheDir, transport };
}
function database(failGroup = false) {
  let stored: Record<string, unknown> | null = null;
  const groups: Record<string, unknown>[] = [];
  const query = vi.fn(async (sql: string, v: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO public.nm_reported_finance_components"))
      stored = {
        link_id: v[0],
        election_year: v[1],
        component: v[2],
        candidate_id: v[3],
        election_id: v[4],
        receiver_context: JSON.parse(String(v[5])),
        receiving_context: JSON.parse(String(v[6])),
        source_facts: JSON.parse(String(v[7])),
        aggregation_controls: JSON.parse(String(v[8])),
        source_observed_at: v[9],
        source_completed_at: v[10],
        last_synced_at: v[11],
      };
    if (sql.startsWith("DELETE")) groups.splice(0);
    if (sql.startsWith("INSERT INTO public.nm_reported_finance_groups")) {
      if (failGroup) throw Error("Synthetic insert failure");
      groups.push({
        link_id: v[0],
        election_year: v[1],
        component: v[2],
        group_key: v[3],
        reported_name: v[4],
        stance: v[5],
        amount_cents: v[6],
        occurrence_count: v[7],
      });
    }
    return {
      rows: sql.startsWith(
        "SELECT * FROM public.nm_reported_finance_components",
      )
        ? stored
          ? [stored]
          : []
        : sql.startsWith("SELECT *,amount_cents")
          ? groups
          : [],
    };
  });
  const release = vi.fn();
  return {
    query,
    connect: vi.fn(async () => ({ query, release })),
    release,
    stored: () => stored!,
    groups,
  };
}
describe("New Mexico atomic verified store and complete reader", () => {
  it("rejects unsealed source DTOs before opening a transaction", async () => {
    const db = database();
    await expect(
      writeNewMexicoReportedComponent({
        db: db as never,
        receiver,
        component: "ie",
        registry: {} as never,
        identity: {} as never,
        financial: {} as never,
      }),
    ).rejects.toThrow("unverified_source_packet");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("writes replay-verified originals, reads the complete stored graph, and preserves clocks on replay", async () => {
    const sources = await packets(),
      db = database(),
      input = {
        db: db as never,
        receiver,
        component: "ie" as const,
        ...sources,
      };
    expect(await writeNewMexicoReportedComponent(input)).toEqual({
      groups: 1,
      idempotent: false,
    });
    const clock = db.stored().last_synced_at;
    const value = readNewMexicoReportedComponent(
      db.stored(),
      db.groups,
      receiver,
      "ie",
    );
    expect(value.controls.supportCents).toBe(1234);
    expect(value.observedAt).toBe(sources.financial.source.observedAt);
    expect(await writeNewMexicoReportedComponent(input)).toEqual({
      groups: 1,
      idempotent: true,
    });
    expect(db.stored().last_synced_at).toBe(clock);
    expect(db.release).toHaveBeenCalledTimes(2);
  });
  it("writes a refreshed registry packet beside a reused financial packet", async () => {
    const { cacheDir, transport, ...sources } = await packets(),
      db = database();
    await writeNewMexicoReportedComponent({
      db: db as never,
      receiver,
      component: "ie",
      ...sources,
    });
    vi.setSystemTime(new Date("2026-10-21T18:00:00.000Z"));
    const registry = await getNewMexicoReportedSource({
      scope: { kind: "registry", year: 2026, selector: null },
      cacheDir,
      transport,
      refresh: true,
    });
    expect(registry.source.manifestSha256).not.toBe(
      sources.registry.source.manifestSha256,
    );
    expect(
      await writeNewMexicoReportedComponent({
        db: db as never,
        receiver,
        component: "ie",
        ...sources,
        registry,
      }),
    ).toEqual({ groups: 1, idempotent: false });
    expect(db.stored().source_observed_at).toBe(
      sources.financial.source.observedAt,
    );
    expect(db.stored().source_facts).toMatchObject({
      registry: { source: { manifestSha256: registry.source.manifestSha256 } },
    });
  });
  it("rolls back an insert failure and always releases its connection", async () => {
    const sources = await packets(),
      db = database(true);
    await expect(
      writeNewMexicoReportedComponent({
        db: db as never,
        receiver,
        component: "ie",
        ...sources,
      }),
    ).rejects.toThrow("Synthetic insert failure");
    expect(db.query.mock.calls.map((call) => call[0])).toContain("ROLLBACK");
    expect(db.query.mock.calls.map((call) => call[0])).not.toContain("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });
  it("rechecks canonical ownership under lock before financial writes", async () => {
    const sources = await packets(),
      db = database();
    mocks.load.mockResolvedValue({ ...receiver, activeCandidateOwnerCount: 2 });
    await expect(
      writeNewMexicoReportedComponent({
        db: db as never,
        receiver,
        component: "ie",
        ...sources,
      }),
    ).rejects.toThrow("canonical_receiving_context_changed");
    expect(
      db.query.mock.calls.some((call) => call[0].startsWith("INSERT")),
    ).toBe(false);
  });
  it("holds a stale source graph without replacing money", async () => {
    const sources = await packets(),
      db = database(),
      input = {
        db: db as never,
        receiver,
        component: "ie" as const,
        ...sources,
      };
    await writeNewMexicoReportedComponent(input);
    db.stored().source_observed_at = "2099-01-01T00:00:00.000Z";
    await expect(writeNewMexicoReportedComponent(input)).rejects.toThrow(
      "stale_source_observation",
    );
    expect(
      db.query.mock.calls.filter((call) =>
        call[0].startsWith("INSERT INTO public.nm_reported_finance_components"),
      ),
    ).toHaveLength(1);
  });
  it("keeps default-off gates ahead of acquisition/storage", async () => {
    vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", "false");
    const db = database();
    await expect(
      writeNewMexicoReportedComponent({
        db: db as never,
        receiver,
        component: "ie",
      } as never),
    ).rejects.toThrow("component_disabled");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("loads a native card without an annual summary and rejects corrupt uncapped rows", async () => {
    const sources = await packets(),
      db = database();
    await writeNewMexicoReportedComponent({
      db: db as never,
      receiver,
      component: "ie",
      ...sources,
    });
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("to_jsonb(s) stored")
        ? [{ ...receiver, stored: db.stored(), groups: db.groups }]
        : [],
    }));
    const candidates = [
        {
          candidate_id: receiver.candidateId,
          election_id: receiver.electionId,
        },
      ],
      elections = [
        {
          election_id: receiver.electionId,
          state: "NM",
          office_scope: "statewide",
          office_canonical_name: "Governor",
        },
      ];
    const summaries =
      await loadNewMexicoCandidateFinanceSummariesByCandidateElection(
        { query } as never,
        candidates,
        elections,
      );
    expect([...summaries.values()][0]?.outside_spending.support_total).toBe(
      12.34,
    );
    expect([...summaries.values()][0]?.direct_campaign.total_raised).toBeNull();
    db.groups[0]!.amount_cents = "1235";
    expect(
      (
        await loadNewMexicoCandidateFinanceSummariesByCandidateElection(
          { query } as never,
          candidates,
          elections,
        )
      ).size,
    ).toBe(0);
  });
  it("validates every group before presentation limits and keeps the legacy headline", () => {
    const groups = Array.from({ length: 8 }, (_, i) => ({
      key: `SYNTHETIC ${i}`,
      reportedName: `Synthetic ${i}`,
      stance: "committee" as const,
      amountCents: 100,
      occurrenceCount: 1,
    }));
    const controls = {
      totalAmountCents: 800,
      contributionCount: 8,
      sourceReceivingRows: 9,
      sourceReceivingAmountCents: 850,
      currentCycleRows: 9,
      financialCycleId: 3,
      excludedRows: 1,
      excludedAmountCents: 50,
    };
    expect(() =>
      validateNewMexicoStoredClosure("committee", controls, groups),
    ).not.toThrow();
    expect(() =>
      validateNewMexicoStoredClosure("committee", controls, groups.slice(0, 5)),
    ).toThrow("stored_committee_closure");
    expect(() =>
      validateNewMexicoStoredClosure(
        "committee",
        controls,
        groups.map((g, i) => (i === 7 ? { ...g, amountCents: 101 } : g)),
      ),
    ).toThrow("stored_committee_closure");
    const value = {
      receiver,
      facts: { component: "committee" },
      controls,
      groups,
      observedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T01:00:00.000Z",
    } as never;
    const base = overlayNewMexicoReportedComponent(undefined, value);
    base.direct_campaign.total_raised = 12345;
    const result = overlayNewMexicoReportedComponent(base, value);
    expect(result.direct_campaign.total_raised).toBe(12345);
    expect(result.direct_campaign.pac_money_by_interest![0]).toMatchObject({
      amount: 8,
      pac_count: 8,
    });
    expect(result.direct_campaign.pac_money_by_interest![0]!.pacs).toHaveLength(
      5,
    );
  });
});

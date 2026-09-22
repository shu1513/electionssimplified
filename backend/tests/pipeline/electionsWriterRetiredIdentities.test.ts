import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQueryMock = vi.fn();
const poolEndMock = vi.fn(async () => {});
const poolConnectMock = vi.fn();
const clientQueryMock = vi.fn();
const clientReleaseMock = vi.fn();

const redisConnectMock = vi.fn(async () => {});
const redisQuitMock = vi.fn(async () => {});
const redisXGroupCreateMock = vi.fn(async () => "OK");
const redisXAutoClaimMock = vi.fn(async () => ({ nextId: "0-0", messages: [] }));
const redisXReadGroupMock = vi.fn();
const redisXAckMock = vi.fn(async () => 1);
const redisXAddMock = vi.fn(async () => "1-0");
const redisSendCommandMock = vi.fn(async () => 1);

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ query: poolQueryMock, connect: poolConnectMock, end: poolEndMock })),
}));

vi.mock("redis", () => ({
  createClient: vi.fn(() => ({
    connect: redisConnectMock,
    quit: redisQuitMock,
    xGroupCreate: redisXGroupCreateMock,
    xAutoClaim: redisXAutoClaimMock,
    xReadGroup: redisXReadGroupMock,
    xAck: redisXAckMock,
    xAdd: redisXAddMock,
    sendCommand: redisSendCommandMock,
  })),
}));

vi.mock("../../src/config/env.js", () => ({
  getPipelineEnv: () => ({
    DATABASE_URL: "postgresql://localhost:5432/test",
    REDIS_URL: "redis://localhost:6379/0",
    AI_PROVIDER: "openai",
    AI_MODEL: "gpt-5.4-mini",
    AI_TIMEOUT_MS: 90000,
    ANTHROPIC_WEB_SEARCH_MAX_USES: 3,
    STATE_RESOURCES_PROMPT_VERSION: "state_resources_v2",
    CENSUS_API_KEYS: [],
  }),
}));

import { runElectionsWriter } from "../../src/pipeline/writers/electionsWriter.js";
import { STAGING_ITEM_TYPE_ELECTION, STAGING_VALIDATED_STREAM } from "../../src/config/electionsPipeline.js";

const DISTRICT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const RETIRED = "22222222-2222-2222-2222-222222222222";
const SURVIVOR = "33333333-3333-3333-3333-333333333333";
const INGEST_KEY = "manual:elections:test:2026";

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ledger-1",
    district_id: DISTRICT,
    election_date: "2099-11-03",
    official_ballot_title_key: "united states senator",
    official_ballot_title: "United States Senator",
    race_type: "office",
    election_id: RETIRED,
    action: "retired_spurious",
    reason: "Neither Senate class is up this cycle.",
    source_url: "https://example.org/not-up",
    superseded_by_election_ids: [],
    retired_on: "2026-09-21",
    ...overrides,
  };
}

function entry(title: string) {
  return {
    official_ballot_title: title,
    election_date: "2099-11-03",
    race_type: "office",
    discovery_contest_family: "non_judicial_office",
    sources: ["https://example.org/election"],
  };
}

function basePayload(extra: Record<string, unknown> = {}) {
  return {
    district_id: DISTRICT,
    district_name: "Vermont",
    district_type: "statewide",
    state: "VT",
    entries: [entry("Governor"), entry("United States Senator")],
    ...extra,
  };
}

function stageRow(payload: unknown, status = "validated", aiRawDebug: unknown = { manual_research: true }) {
  poolQueryMock
    .mockResolvedValueOnce({
      rows: [{ ingest_key: INGEST_KEY, payload, status, run_id: "run_1", ai_raw_debug: aiRawDebug }],
    })
    .mockResolvedValue({ rowCount: 1, rows: [] });
}

function mockClient(ledgerRows: unknown[], liveRows: unknown[] = []) {
  const upserts: unknown[][] = [];
  clientQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM public.retired_election_identities")) {
      return { rowCount: ledgerRows.length, rows: ledgerRows };
    }
    if (sql.includes("FROM public.elections") && sql.includes("election_date = ANY")) {
      return { rowCount: liveRows.length, rows: liveRows };
    }
    if (sql.includes("FROM public.office_title_aliases")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM public.offices")) {
      return { rowCount: 1, rows: [{ id: "00000000-0000-0000-0000-000000000010", canonical_name: "Governor" }] };
    }
    if (sql.includes("INSERT INTO public.elections")) {
      upserts.push(values ?? []);
      return {
        rowCount: 1,
        rows: [{ id: `00000000-0000-0000-0000-0000000000${10 + upserts.length}`, race_type: "office", inserted: false }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  return { upserts };
}

function stagingReasonUpdate(): unknown[] | undefined {
  return clientQueryMock.mock.calls.find((call) => String(call[0]).includes("SET reason = $2"))?.[1] as
    | unknown[]
    | undefined;
}

describe("elections writer retired-identity gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    poolConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });
    redisXReadGroupMock.mockResolvedValue([
      {
        name: STAGING_VALIDATED_STREAM,
        messages: [{ id: "1-0", message: { ingest_key: INGEST_KEY, item_type: STAGING_ITEM_TYPE_ELECTION } }],
      },
    ]);
  });

  it("retire, then re-inject the same contest: the entry is skipped and the reason is recorded", async () => {
    stageRow(basePayload());
    const { upserts } = mockClient([ledgerRow()]);

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.[1]).toBe("Governor");
    const reason = stagingReasonUpdate();
    expect(reason?.[0]).toBe(INGEST_KEY);
    expect(String(reason?.[1])).toContain("writer skipped 1 retired contest(s)");
    expect(String(reason?.[1])).toContain('"United States Senator" 2099-11-03: contest retired on 2026-09-21: Neither Senate class is up this cycle.');
    expect(String(reason?.[1])).toContain("--reinstate-retired");
    // The district was still researched: the row is written, not failed.
    const statusUpdate = clientQueryMock.mock.calls.find((call) => String(call[0]).includes("SET status = $3"));
    expect(statusUpdate?.[1]?.[2]).toBe("written");
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("supersede, then re-inject the old title: the entry is skipped and points at the replacement", async () => {
    stageRow(basePayload());
    const { upserts } = mockClient([
      ledgerRow({
        action: "superseded",
        superseded_by_election_ids: [SURVIVOR],
        reason: "Combined shell replaced by per-seat contests.",
      }),
    ]);

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(1);
    const reason = String(stagingReasonUpdate()?.[1]);
    expect(reason).toContain(`contest superseded on 2026-09-21 by election id(s) ${SURVIVOR}`);
    expect(reason).toContain("write to the replacement instead");
  });

  it("blocks a near-duplicate title that normalizes to the same compact key", async () => {
    stageRow(basePayload({ entries: [entry("Governor"), entry("U.S. Senator")] }));
    const { upserts } = mockClient([
      ledgerRow({ official_ballot_title_key: "us senator", official_ballot_title: "US Senator" }),
    ]);

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(1);
    expect(String(stagingReasonUpdate()?.[1])).toContain('near-duplicate of retired title "US Senator"');
  });

  it("supersede U.S. Senate by US Senate, then update the survivor: written, not blocked", async () => {
    stageRow(basePayload({ entries: [entry("Governor"), entry("US Senate")] }));
    const { upserts } = mockClient(
      [
        ledgerRow({
          official_ballot_title_key: "u s senate",
          official_ballot_title: "U.S. Senate",
          action: "superseded",
          superseded_by_election_ids: [SURVIVOR],
        }),
      ],
      [{ election_date: "2099-11-03", official_ballot_title_key: "us senate" }]
    );

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(2);
    expect(String(stagingReasonUpdate()?.[1] ?? "")).not.toContain("retired contest");
  });

  it("writes a genuinely different contest on the same date untouched", async () => {
    stageRow(basePayload({ entries: [entry("Governor")] }));
    const { upserts } = mockClient([ledgerRow()]);

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(1);
    expect(stagingReasonUpdate()).toBeUndefined();
  });

  it("override: an inject staged with --reinstate-retired writes the contest and closes the ledger row", async () => {
    stageRow(
      basePayload({ reinstate_retired: true, review_reason: "Official candidate list shows the race is on the ballot." }),
      "validated",
      { manual_research: true, reinstate_retired_approved: true }
    );
    const { upserts } = mockClient([ledgerRow()]);

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(2);
    expect(String(stagingReasonUpdate()?.[1] ?? "")).not.toContain("retired contest");
    const reinstate = clientQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE public.retired_election_identities")
    );
    expect(reinstate?.[1]).toEqual([
      "ledger-1",
      "00000000-0000-0000-0000-000000000012",
      "Official candidate list shows the race is on the ballot.",
    ]);
    // The ledger closes inside the write transaction.
    const commitIndex = clientQueryMock.mock.calls.findIndex((call) => call[0] === "COMMIT");
    const reinstateIndex = clientQueryMock.mock.calls.indexOf(reinstate!);
    expect(reinstateIndex).toBeGreaterThan(0);
    expect(reinstateIndex).toBeLessThan(commitIndex);
  });

  it("rollover path: an AI-enriched payload cannot reinstate, even if it carries the flag", async () => {
    stageRow(basePayload({ reinstate_retired: true, review_reason: "not a manual row" }), "validated", {
      provider: "openai",
    });
    const { upserts } = mockClient([ledgerRow()]);

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(1);
    expect(String(stagingReasonUpdate()?.[1])).toContain("contest retired on 2026-09-21");
    expect(
      clientQueryMock.mock.calls.some((call) => String(call[0]).includes("UPDATE public.retired_election_identities"))
    ).toBe(false);
  });

  it("a manual row without the inject stamp cannot reinstate either", async () => {
    stageRow(basePayload({ reinstate_retired: true, review_reason: "file still carries the flag" }), "validated", {
      manual_research: true,
    });
    const { upserts } = mockClient([ledgerRow()]);

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(1);
    expect(String(stagingReasonUpdate()?.[1])).toContain("contest retired on 2026-09-21");
  });

  it("a staging row already 'written' is replayed for handoff only and never re-upserted", async () => {
    // The stale copy of a retired contest lives on in staging_items as a
    // 'written' row. The writer only upserts from 'validated' rows; a written
    // row re-resolves its live election ids for the roster handoff and
    // nothing else, so the old payload cannot write the contest back.
    stageRow(basePayload(), "written");
    const { upserts } = mockClient([]);

    await runElectionsWriter({ once: true, batchSize: 5, blockMs: 10 });

    expect(upserts).toHaveLength(0);
    expect(poolConnectMock).not.toHaveBeenCalled();
    const resolveCalls = poolQueryMock.mock.calls.filter((call) => String(call[0]).includes("FROM public.elections AS e"));
    expect(resolveCalls.length).toBeGreaterThan(0);
    expect(redisXAckMock).toHaveBeenCalledWith(STAGING_VALIDATED_STREAM, expect.any(String), "1-0");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQueryMock = vi.fn();
const poolEndMock = vi.fn(async () => {});

const redisConnectMock = vi.fn(async () => {});
const redisQuitMock = vi.fn(async () => {});
const redisXGroupCreateMock = vi.fn(async () => "OK");
const redisXAutoClaimMock = vi.fn(async () => ({ nextId: "0-0", messages: [] }));
const redisXReadGroupMock = vi.fn();
const redisXAckMock = vi.fn(async () => 1);
const redisXAddMock = vi.fn(async () => "1-0");

vi.mock("pg", () => {
  return {
    Pool: vi.fn(() => ({
      query: poolQueryMock,
      end: poolEndMock,
    })),
  };
});

vi.mock("redis", () => {
  return {
    createClient: vi.fn(() => ({
      connect: redisConnectMock,
      quit: redisQuitMock,
      xGroupCreate: redisXGroupCreateMock,
      xAutoClaim: redisXAutoClaimMock,
      xReadGroup: redisXReadGroupMock,
      xAck: redisXAckMock,
      xAdd: redisXAddMock,
    })),
  };
});

vi.mock("../../src/config/env.js", () => {
  return {
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
  };
});

import { runElectionsValidator } from "../../src/pipeline/validators/electionsValidator.js";
import {
  STAGING_DRAFT_STREAM,
  STAGING_ELECTIONS_VALIDATOR_GROUP,
  STAGING_ITEM_TYPE_ELECTION,
  STAGING_PENDING_STREAM,
  STAGING_REJECTED_STREAM,
  STAGING_VALIDATED_STREAM,
} from "../../src/config/electionsPipeline.js";
import { ELECTION_ENRICHMENT_SCHEMA_VERSION } from "../../src/contracts/electionEnrichmentContract.js";

describe("runElectionsValidator", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    redisXReadGroupMock.mockResolvedValue([
      {
        name: STAGING_PENDING_STREAM,
        messages: [
          {
            id: "1-0",
            message: {
              ingest_key: "elections:test:1",
              item_type: STAGING_ITEM_TYPE_ELECTION,
            },
          },
        ],
      },
    ]);
  });

  it("accepts Massachusetts' official 'Senator in General Court' state-upper title", async () => {
    const payload = {
      district_id: "d-ma-hampden",
      district_name: "Hampden District (2024); Massachusetts",
      district_type: "state_upper",
      state: "MA",
      entries: [
        {
          official_ballot_title: "Senator in General Court",
          election_date: "2099-09-01",
          race_type: "office",
          election_stage: "primary",
          sources: ["https://www.sec.state.ma.us/example"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:ma-hampden",
            payload,
            status: "pending",
            run_id: "run_ma_hampden",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("soft_fail")
    );
    expect(softFailCall).toBeUndefined();
  });

  it("accepts 'United States Representative' as a clear us_house title without a review pass", async () => {
    const payload = {
      district_id: "d-ak",
      district_name: "Congressional District (at Large) (119th Congress), Alaska",
      district_type: "us_house",
      state: "AK",
      entries: [
        {
          official_ballot_title: "United States Representative",
          election_date: "2099-08-18",
          race_type: "office",
          election_stage: "primary",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:ak",
            payload,
            status: "pending",
            run_id: "run_ak",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts 'Representative to the 120th United States Congress - District 2' as a clear us_house title without a review pass", async () => {
    const payload = {
      district_id: "d-co",
      district_name: "Congressional District 2 (119th Congress), Colorado",
      district_type: "us_house",
      state: "CO",
      entries: [
        {
          official_ballot_title: "Representative to the 120th United States Congress - District 2",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:co",
            payload,
            status: "pending",
            run_id: "run_co",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts bare 'Council Member for District 2' and one-word 'Councilmember' as clear place titles without a review pass", async () => {
    const payload = {
      district_id: "d-ftw",
      district_name: "Fort Worth city, Texas",
      district_type: "place",
      state: "TX",
      entries: [
        {
          // Fort Worth's official title omits "City" (live: all ten council
          // entries soft-failed and needed per-run review approval).
          official_ballot_title: "Council Member for District 2",
          election_date: "2099-05-01",
          race_type: "office",
          election_stage: "general",
          sources: ["https://example.org/election"],
          discovery_contest_family: "non_judicial_office",
        },
        {
          // Flagstaff's one-word official form (live).
          official_ballot_title: "Councilmember",
          election_date: "2099-07-21",
          race_type: "office",
          election_stage: "primary",
          sources: ["https://example.org/election"],
          discovery_contest_family: "non_judicial_office",
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:ftw",
            payload,
            status: "pending",
            run_id: "run_ftw",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts Rhode Island's 'SENATOR IN GENERAL ASSEMBLY' without the article, like the House form", async () => {
    const payload = {
      district_id: "d-ri-sd5",
      district_name: "State Senate District 5 (2024); Rhode Island",
      district_type: "state_upper",
      state: "RI",
      entries: [
        {
          // The RI Department of State candidate list drops "the" (live
          // soft-fail); STATE_LOWER_MARKERS already carries both forms of the
          // House equivalent.
          official_ballot_title: "SENATOR IN GENERAL ASSEMBLY",
          election_date: "2099-09-09",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:ri-sd5",
            payload,
            status: "pending",
            run_id: "run_ri_sd5",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts Illinois' ordinal-only '3RD SENATE' as a clear state_upper title without a review pass", async () => {
    const payload = {
      district_id: "d-il-sd3",
      district_name: "State Senate District 3 (2024), Illinois",
      district_type: "state_upper",
      state: "IL",
      entries: [
        {
          // The Illinois State Board of Elections candidate list uses this
          // form verbatim (live soft-fail).
          official_ballot_title: "3RD SENATE",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:il-sd3",
            payload,
            status: "pending",
            run_id: "run_il_sd3",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts 'Judge of the Superior Court, Office No. 64' as a clear county title without a review pass", async () => {
    const payload = {
      district_id: "d-la",
      district_name: "Los Angeles County, California",
      district_type: "county",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Judge of the Superior Court, Office No. 64",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "runoff",
          is_partisan: false,
          discovery_contest_family: "judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:la",
            payload,
            status: "pending",
            run_id: "run_la",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts 'Assessor' as a clear county title without a review pass", async () => {
    const payload = {
      district_id: "d-la",
      district_name: "Los Angeles County, California",
      district_type: "county",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Assessor",
          election_date: "2099-06-02",
          race_type: "office",
          election_stage: "primary",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:la-assessor",
            payload,
            status: "pending",
            run_id: "run_la",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts St. Louis City county-equivalent collector titles without added jurisdiction text", async () => {
    const payload = {
      district_id: "d-st-louis-city-mo",
      district_name: "St. Louis city, Missouri",
      district_type: "county",
      state: "MO",
      entries: [
        {
          official_ballot_title: "Collector of Revenue",
          election_date: "2099-08-04",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "License Collector",
          election_date: "2099-08-04",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:st-louis-city-mo",
            payload,
            status: "pending",
            run_id: "run_st_louis_city_mo",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts verified historical dates only when manual import is explicitly approved", async () => {
    const payload = {
      district_id: "d-lausd",
      district_name: "Los Angeles Unified School District",
      district_type: "school_unified",
      state: "CA",
      review_decision: "approve",
      review_reason: "official election schedule verified",
      entries: [
        {
          official_ballot_title: "Member of the Board of Education, District 6",
          election_date: "2000-06-06",
          race_type: "office",
          election_stage: "primary",
          is_partisan: false,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:lausd-historical",
            payload,
            status: "pending",
            run_id: "run_lausd_historical",
            failure_debug: null,
            ai_raw_debug: { manual_research: true, historical_import_approved: true },
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const rejectionCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("election_date is too far in the past")
    );
    expect(rejectionCall).toBeUndefined();
  });

  it("still hard-rejects a past election_date on a manual row without historical approval", async () => {
    const payload = {
      district_id: "d-lausd",
      district_name: "Los Angeles Unified School District",
      district_type: "school_unified",
      state: "CA",
      review_decision: "approve",
      review_reason: "official election schedule verified",
      entries: [
        {
          official_ballot_title: "Member of the Board of Education, District 6",
          election_date: "2000-06-06",
          race_type: "office",
          election_stage: "primary",
          is_partisan: false,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:lausd-unapproved",
            payload,
            status: "pending",
            run_id: "run_lausd_unapproved",
            failure_debug: null,
            ai_raw_debug: { manual_research: true },
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const rejectionCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("election_date is too far in the past")
    );
    expect(rejectionCall).toBeTruthy();
    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeUndefined();
  });

  it("does not enqueue a soft-failed manual row to the AI draft stream", async () => {
    const payload = {
      district_id: "d-kings",
      district_name: "Kings County",
      district_type: "county",
      state: "NY",
      entries: [
        {
          official_ballot_title: "Supreme Court Justice - 2nd Judicial District",
          election_date: "2099-11-03",
          race_type: "office",
          discovery_contest_family: "judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:manual-soft",
            payload,
            status: "pending",
            run_id: "run_manual_soft",
            failure_debug: null,
            ai_raw_debug: { manual_research: true },
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const softFailUpdate = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").startsWith("soft_fail:")
    );
    expect(softFailUpdate).toBeTruthy();
    const draftCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_DRAFT_STREAM);
    expect(draftCall).toBeUndefined();
    expect(redisXAckMock).toHaveBeenCalledWith(
      STAGING_PENDING_STREAM,
      STAGING_ELECTIONS_VALIDATOR_GROUP,
      "1-0"
    );
  });

  it("prints the parked soft-fail reason to the terminal so a parked row is not mistaken for a starved worker", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const payload = {
        district_id: "d-kings",
        district_name: "Kings County",
        district_type: "county",
        state: "NY",
        entries: [
          {
            official_ballot_title: "Supreme Court Justice - 2nd Judicial District",
            election_date: "2099-11-03",
            race_type: "office",
            discovery_contest_family: "judicial_office",
            sources: ["https://example.org/election"],
          },
        ],
      };

      poolQueryMock
        .mockResolvedValueOnce({
          rows: [
            {
              ingest_key: "elections:test:manual-soft",
              payload,
              status: "pending",
              run_id: "run_manual_soft",
              failure_debug: null,
              ai_raw_debug: { manual_research: true },
              schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
            },
          ],
        })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValue({ rowCount: 1, rows: [] });

      await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

      const parkedLine = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("parked pending (soft_fail)"));
      expect(parkedLine).toBeTruthy();
      // The stream fixture delivers ingest_key=elections:test:1; the log line
      // must carry the stream's key and the stored soft-fail reason.
      expect(parkedLine).toContain("ingest_key=elections:test:1");
      expect(parkedLine).toContain("Supreme Court Justice");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("includes the stored reason in the targeted-mode summary", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ingestKey = "manual:elections:targeted:parked";
      poolQueryMock
        .mockResolvedValueOnce({
          rows: [
            {
              ingest_key: ingestKey,
              payload: { district_id: "d-x", entries: [] },
              status: "rejected",
              run_id: "run_x",
              reason: "soft_fail_final: something ambiguous",
              failure_debug: null,
              schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              ingest_key: ingestKey,
              status: "rejected",
              reason: "soft_fail_final: something ambiguous",
            },
          ],
        });

      await runElectionsValidator({ ingestKey });

      const summaryLine = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"targeted":true'));
      expect(summaryLine).toBeTruthy();
      const summary = JSON.parse(summaryLine!) as { status: string; reason: string };
      expect(summary.status).toBe("rejected");
      expect(summary.reason).toBe("soft_fail_final: something ambiguous");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not republish a redelivered soft-failed manual row to the AI draft stream", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          ingest_key: "elections:test:1",
          payload: { district_id: "d-x", entries: [] },
          status: "pending",
          run_id: "run_x",
          failure_debug: null,
          ai_raw_debug: { manual_research: true },
          schema_version: "elections_draft_v1",
        },
      ],
    });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const draftCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_DRAFT_STREAM);
    expect(draftCall).toBeUndefined();
    expect(redisXAckMock).toHaveBeenCalledWith(
      STAGING_PENDING_STREAM,
      STAGING_ELECTIONS_VALIDATOR_GROUP,
      "1-0"
    );
  });

  it("soft-fails 'Judge of the Superior Court' in a Pennsylvania county, where the Superior Court is statewide appellate", async () => {
    const payload = {
      district_id: "d-pa",
      district_name: "Allegheny County, Pennsylvania",
      district_type: "county",
      state: "PA",
      entries: [
        {
          official_ballot_title: "Judge of the Superior Court",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          discovery_contest_family: "judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:pa",
            payload,
            status: "pending",
            run_id: "run_pa",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeTruthy();
    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeUndefined();
  });

  it("soft-fails municipal assessor titles like 'Town Assessor' in county scope", async () => {
    const payload = {
      district_id: "d-ny",
      district_name: "Erie County, New York",
      district_type: "county",
      state: "NY",
      entries: [
        {
          official_ballot_title: "Town Assessor",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:ny",
            payload,
            status: "pending",
            run_id: "run_ny",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeTruthy();
    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeUndefined();
  });

  it("accepts Louisiana parish-scope titles like 'Justice of the Peace 2nd Justice Court' without a review pass", async () => {
    // Louisiana calls its counties parishes, so no Louisiana ballot title ever
    // contains the word "county", and the verbatim SOS form is what folds at
    // 1.000 in the office matcher.
    const payload = {
      district_id: "d-jefferson-la",
      district_name: "Jefferson Parish, Louisiana",
      district_type: "county",
      state: "LA",
      entries: [
        {
          official_ballot_title: "Justice of the Peace 2nd Justice Court",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Constable 4th Justice Court",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Judge Civil District Court, Division F",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          discovery_contest_family: "judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Assessor, Orleans Parish",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Police Juror District 3",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:jefferson-la",
            payload,
            status: "pending",
            run_id: "run_jefferson_la",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("still hard-rejects a New Orleans city-court contest filed on the parish row", async () => {
    // "Constable 1st City Court" is a city-court contest covering part of the
    // parish; it belongs on the "New Orleans city" place row, so the Louisiana
    // parish markers must not rescue it.
    const payload = {
      district_id: "d-orleans-la",
      district_name: "Orleans Parish, Louisiana",
      district_type: "county",
      state: "LA",
      entries: [
        {
          official_ballot_title: "Constable 1st City Court",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "primary",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:orleans-city-court",
            payload,
            status: "pending",
            run_id: "run_orleans_city_court",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const hardFailCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("county scope contains clearly non-county race")
    );
    expect(hardFailCall).toBeTruthy();
    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeUndefined();
  });

  it("still soft-fails a city Home Rule Charter amendment filed on the parish row", async () => {
    // A parishwide vote does not make a City of New Orleans charter amendment a
    // parish question, and a ballot measure never reaches the office-only hard
    // city check.
    const payload = {
      district_id: "d-orleans-la",
      district_name: "Orleans Parish, Louisiana",
      district_type: "county",
      state: "LA",
      entries: [
        {
          official_ballot_title: "City of New Orleans Home Rule Charter Amendment, Orleans Parish",
          election_date: "2099-11-03",
          race_type: "ballot_measure",
          discovery_contest_family: "ballot_measure",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:orleans-hrc",
            payload,
            status: "pending",
            run_id: "run_orleans_hrc",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeTruthy();
    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeUndefined();
  });

  it("accepts Alaska borough and census-area county-equivalent titles without a review pass", async () => {
    // Alaska has no counties either: boroughs and, in the unorganized borough,
    // census areas are the county-equivalents. "City and Borough of Juneau" is
    // a consolidated borough, not a city race.
    const payload = {
      district_id: "d-ak-borough",
      district_name: "Fairbanks North Star Borough, Alaska",
      district_type: "county",
      state: "AK",
      entries: [
        {
          official_ballot_title: "Assembly Member, Fairbanks North Star Borough",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Assembly Member, City and Borough of Juneau, Areawide Seat B",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Mayor, City and Borough of Juneau",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Hoonah-Angoon Census Area Proposition 1",
          election_date: "2099-11-03",
          race_type: "ballot_measure",
          discovery_contest_family: "ballot_measure",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:ak-borough",
            payload,
            status: "pending",
            run_id: "run_ak_borough",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("still hard-rejects an Alaska city mayor title in county scope", async () => {
    // A city inside a borough ("Mayor, City of Fairbanks") is a municipal
    // race; the borough-mayor carve-out must not rescue it, because the bare
    // "city" token (without "and borough") still marks it city-like.
    const payload = {
      district_id: "d-ak-borough",
      district_name: "Fairbanks North Star Borough, Alaska",
      district_type: "county",
      state: "AK",
      entries: [
        {
          official_ballot_title: "Mayor, City of Fairbanks",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:ak-city-mayor",
            payload,
            status: "pending",
            run_id: "run_ak_city_mayor",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const hardFailCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("county scope contains clearly non-county race")
    );
    expect(hardFailCall).toBeTruthy();
  });

  it("still hard-rejects a New York state assembly title in county scope", async () => {
    // The Alaska carve-out above is state-gated: everywhere with a real state
    // assembly, an assembly title on a county row is still a mis-scoped race.
    const payload = {
      district_id: "d-erie-ny",
      district_name: "Erie County, New York",
      district_type: "county",
      state: "NY",
      entries: [
        {
          official_ballot_title: "Member of the Assembly, District 142",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:erie-assembly",
            payload,
            status: "pending",
            run_id: "run_erie_assembly",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const hardFailCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("county scope contains clearly non-county race")
    );
    expect(hardFailCall).toBeTruthy();
  });

  it("soft-fails a New Jersey borough council title in county scope, where a borough is a municipality", async () => {
    const payload = {
      district_id: "d-bergen-nj",
      district_name: "Bergen County, New Jersey",
      district_type: "county",
      state: "NJ",
      entries: [
        {
          official_ballot_title: "Borough Council",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:bergen-nj",
            payload,
            status: "pending",
            run_id: "run_bergen_nj",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeTruthy();
    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeUndefined();
  });

  it("accepts 'US House of Representatives District 1' without hard-rejecting it as a state-house race", async () => {
    const payload = {
      district_id: "d-nc",
      district_name: "Congressional District 1 (119th Congress), North Carolina",
      district_type: "us_house",
      state: "NC",
      entries: [
        {
          official_ballot_title: "US House of Representatives District 1",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:nc",
            payload,
            status: "pending",
            run_id: "run_nc",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("accepts El Paso's 'City Representative District 1, City of El Paso' as a place race", async () => {
    // "City Representative" is El Paso's official council title; the bare
    // `representative district` state-house marker must not hard-reject it.
    const payload = {
      district_id: "d-elpaso",
      district_name: "El Paso city, Texas",
      district_type: "place",
      state: "TX",
      entries: [
        {
          official_ballot_title: "City Representative District 1, City of El Paso",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:elpaso",
            payload,
            status: "pending",
            run_id: "run_elpaso",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const hardFailCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("place scope contains clearly non-place race")
    );
    expect(hardFailCall).toBeUndefined();
    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
  });

  it("still hard-rejects a bare 'Representative District' state-house title in place scope", async () => {
    const payload = {
      district_id: "d-place-statehouse",
      district_name: "Some city, Texas",
      district_type: "place",
      state: "TX",
      entries: [
        {
          official_ballot_title: "Representative District 145",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:place-statehouse",
            payload,
            status: "pending",
            run_id: "run_place_statehouse",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const hardFailCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("place scope contains clearly non-place race")
    );
    expect(hardFailCall).toBeTruthy();
  });

  it("accepts 'County Mayor' as a county race instead of hard-rejecting it as city-like", async () => {
    // Orange County FL (also Miami-Dade, Nashville) titles the elected county
    // executive "County Mayor"; the bare `mayor` city marker must not
    // hard-reject it, or the County Mayor -> County Executive alias is
    // unreachable for fresh county-scope injects.
    const payload = {
      district_id: "d-orange",
      district_name: "Orange County, Florida",
      district_type: "county",
      state: "FL",
      entries: [
        {
          official_ballot_title: "County Mayor",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:orange-county-mayor",
            payload,
            status: "pending",
            run_id: "run_orange_county_mayor",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const hardFailCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("county scope contains clearly non-county race")
    );
    expect(hardFailCall).toBeUndefined();
    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
  });

  it("accepts source-exact Indiana county office labels without added jurisdiction text", async () => {
    const payload = {
      district_id: "d-hamilton-in",
      district_name: "Hamilton County, Indiana",
      district_type: "county",
      state: "IN",
      entries: [
        {
          official_ballot_title: "Clerk of the Circuit Court",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Recorder",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Coroner",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Commissioner - District 1",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Circuit Court Clerk",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
        {
          official_ballot_title: "Register of Deeds",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:hamilton-in",
            payload,
            status: "pending",
            run_id: "run_hamilton_in",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts a Florida circuit-judge title in county discovery even when the circuit spans counties", async () => {
    const payload = {
      district_id: "d-st-lucie-fl",
      district_name: "St. Lucie County, Florida",
      district_type: "county",
      state: "FL",
      entries: [
        {
          official_ballot_title: "Circuit Judge, 19th Judicial Circuit, Group 4",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:st-lucie-fl",
            payload,
            status: "pending",
            run_id: "run_st_lucie_fl",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("still hard-rejects a bare 'Mayor' title in county scope as a city-like race", async () => {
    const payload = {
      district_id: "d-county-mayor-bare",
      district_name: "Some County, Texas",
      district_type: "county",
      state: "TX",
      entries: [
        {
          official_ballot_title: "Mayor",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:county-bare-mayor",
            payload,
            status: "pending",
            run_id: "run_county_bare_mayor",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const hardFailCall = poolQueryMock.mock.calls.find((call) =>
      String(call[1]?.[1] ?? "").includes("county scope contains clearly non-county race")
    );
    expect(hardFailCall).toBeTruthy();
  });

  it("accepts Ohio's 'For Representative to Congress' phrasing as a clear us_house title", async () => {
    const payload = {
      district_id: "d-oh",
      district_name: "Congressional District 1 (119th Congress), Ohio",
      district_type: "us_house",
      state: "OH",
      entries: [
        {
          official_ballot_title: "For Representative to Congress (1st District)",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:oh",
            payload,
            status: "pending",
            run_id: "run_oh",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts 'District Attorney' as a clear county title without a review pass", async () => {
    const payload = {
      district_id: "d-bexar",
      district_name: "Bexar County, Texas",
      district_type: "county",
      state: "TX",
      entries: [
        {
          official_ballot_title: "District Attorney",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:bexar",
            payload,
            status: "pending",
            run_id: "run_bexar",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts the spelled-out 'United States House of Representatives District 1' title in us_house scope", async () => {
    const payload = {
      district_id: "d-nc2",
      district_name: "Congressional District 1 (119th Congress), North Carolina",
      district_type: "us_house",
      state: "NC",
      entries: [
        {
          official_ballot_title: "United States House of Representatives District 1",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:nc2",
            payload,
            status: "pending",
            run_id: "run_nc2",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("hard-rejects 'District Attorney' in statewide scope as a county-like race", async () => {
    const payload = {
      district_id: "d-tx-sw",
      district_name: "Texas",
      district_type: "statewide",
      state: "TX",
      entries: [
        {
          official_ballot_title: "District Attorney",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_txsw",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_REJECTED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );
  });

  it("accepts soft-fail entries on review pass when review_decision=approve", async () => {
    const payload = {
      district_id: "d-1",
      district_name: "California's 31st congressional district",
      district_type: "us_house",
      state: "CA",
      entries: [
        {
          official_ballot_title: "General Election",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
      review_decision: "approve",
      review_reason: "scope is acceptable",
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_1",
            failure_debug: { soft_retry_count: 1, validation_feedback: ["x"] },
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXGroupCreateMock).toHaveBeenCalledWith(
      STAGING_PENDING_STREAM,
      STAGING_ELECTIONS_VALIDATOR_GROUP,
      "0",
      { MKSTREAM: true }
    );

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();

    const requeueSoftRetryCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("schema_version = $4")
    );
    expect(requeueSoftRetryCall).toBeUndefined();

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );
  });

  it("hard-rejects statewide entries that look like state legislative races", async () => {
    const payload = {
      district_id: "d-2",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "State Senator, District 12",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_2",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_REJECTED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    expect(redisXAddMock).not.toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
      })
    );
  });

  it("accepts statewide entries for U.S. Senate contests", async () => {
    const payload = {
      district_id: "d-3",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "United States Senator",
          election_date: "2099-11-03",
          race_type: "office",
          discovery_contest_family: "us_senate",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_3",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("soft-retries when standard election discovery returns only presidential contests", async () => {
    const payload = {
      district_id: "d-president",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "President and Vice President",
          election_date: "2099-11-03",
          race_type: "office",
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_president",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_DRAFT_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();

    expect(redisXAddMock).not.toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
      })
    );
  });

  it("drops presidential contests while validating remaining statewide offices", async () => {
    const payload = {
      district_id: "d-president-mixed",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2099-11-03",
          race_type: "office",
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election/governor"],
        },
        {
          official_ballot_title: "President and Vice President",
          election_date: "2099-11-03",
          race_type: "office",
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election/president"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_president_mixed",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const validatedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_VALIDATED_STREAM);
    const validatedPayload = JSON.parse(String((validatedCall?.[2] as Record<string, string> | undefined)?.payload));
    expect(validatedPayload.entries).toEqual([
      expect.objectContaining({ official_ballot_title: "Governor" }),
    ]);

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("payload = $3::jsonb")
    );
    expect(updateValidatedCall).toBeTruthy();
    const storedPayload = JSON.parse(String(updateValidatedCall?.[1]?.[2]));
    expect(storedPayload.entries).toEqual([
      expect.objectContaining({ official_ballot_title: "Governor" }),
    ]);

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("accepts state_upper entries with legislature-style upper chamber titles", async () => {
    const payload = {
      district_id: "d-4",
      district_name: "Nebraska Legislative District 12",
      district_type: "state_upper",
      state: "NE",
      entries: [
        {
          official_ballot_title: "Member of the Legislature, District 12",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_4",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("accepts a DC ward's State Board of Education seat on the ward's state_upper row", async () => {
    // DC ward rows are typed state_upper for the Council seat; the same ward
    // ballot elects the ward's member of the DC State Board of Education
    // (DCBOE certified list, live). It is the one board-of-education title
    // that belongs on a state_upper row, and it carries no senate marker.
    const payload = {
      district_id: "d-dc-5",
      district_name: "Ward 5 (2024); District of Columbia",
      district_type: "state_upper",
      state: "DC",
      entries: [
        {
          official_ballot_title: "Ward 5 Member of the State Board of Education",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_dc_5",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("accepts Colorado's congressional-district State Board of Education seat on a us_house row", async () => {
    const payload = {
      district_id: "d-co-1",
      district_name: "Congressional District 1 (119th Congress), Colorado",
      district_type: "us_house",
      state: "CO",
      entries: [
        {
          official_ballot_title: "State Board of Education Member - Congressional District 1",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_co_1",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("accepts Colorado's congressional-district CU regent seat on a us_house row", async () => {
    const payload = {
      district_id: "d-co-2",
      district_name: "Congressional District 2 (119th Congress), Colorado",
      district_type: "us_house",
      state: "CO",
      entries: [
        {
          official_ballot_title: "Regent of the University of Colorado - Congressional District 2",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_co_2",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("still hard-rejects a State Board of Education title on another state's us_house row", async () => {
    const payload = {
      district_id: "d-tx-3",
      district_name: "Congressional District 3 (119th Congress), Texas",
      district_type: "us_house",
      state: "TX",
      entries: [
        {
          official_ballot_title: "State Board of Education Member - Congressional District 3",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_tx_3",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_REJECTED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );
  });

  it("still hard-rejects a State Board of Education title on another state's state_upper row", async () => {
    const payload = {
      district_id: "d-tx-5",
      district_name: "State Senate District 5, Texas",
      district_type: "state_upper",
      state: "TX",
      entries: [
        {
          official_ballot_title: "District 5 Member of the State Board of Education",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_tx_5",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_REJECTED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );
  });

  it("accepts a statewide State Board of Education contest on the statewide row", async () => {
    // Michigan elects two State Board of Education members statewide
    // (official 2026 candidate listing, live).
    const payload = {
      district_id: "d-mi",
      district_name: "Michigan",
      district_type: "statewide",
      state: "MI",
      entries: [
        {
          official_ballot_title: "Member of the State Board of Education",
          discovery_contest_family: "non_judicial_office",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_mi_sbe",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
      })
    );
  });

  it("still hard-rejects a local school board title on the statewide row", async () => {
    const payload = {
      district_id: "d-mi",
      district_name: "Michigan",
      district_type: "statewide",
      state: "MI",
      entries: [
        {
          official_ballot_title: "Lansing School District Board of Education Member",
          discovery_contest_family: "non_judicial_office",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_mi_school",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_REJECTED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
      })
    );
  });

  it("accepts state_lower entries with lower chamber alias titles", async () => {
    const payload = {
      district_id: "d-5",
      district_name: "Massachusetts State House District 7",
      district_type: "state_lower",
      state: "MA",
      entries: [
        {
          official_ballot_title: "Representative in General Court, District 7",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_5",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("hard-rejects state_upper entries that look like lower chamber races", async () => {
    const payload = {
      district_id: "d-6",
      district_name: "California State Senate District 12",
      district_type: "state_upper",
      state: "CA",
      entries: [
        {
          official_ballot_title: "State Representative, District 12",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_6",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_REJECTED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    expect(redisXAddMock).not.toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
      })
    );
  });

  it("soft-fails ambiguous general-assembly wording in state_upper instead of hard-rejecting it", async () => {
    const payload = {
      district_id: "d-7",
      district_name: "State Legislative District 12",
      district_type: "state_upper",
      state: "NJ",
      entries: [
        {
          official_ballot_title: "Member of the General Assembly, District 12",
          election_date: "2099-11-03",
          race_type: "office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_7",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_DRAFT_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    const rejectedCall = redisXAddMock.mock.calls.find((call) => call[0] === STAGING_REJECTED_STREAM);
    expect(rejectedCall).toBeUndefined();
  });

  it("hard-rejects non-statewide entries that look like U.S. Senate contests", async () => {
    const payload = {
      district_id: "d-8",
      district_name: "Los Angeles County",
      district_type: "county",
      state: "CA",
      entries: [
        {
          official_ballot_title: "United States Senator",
          election_date: "2099-11-03",
          race_type: "office",
          // Family present so this keeps exercising the SCOPE rejection, not
          // the missing-family rejection.
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_8",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_REJECTED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );

    expect(redisXAddMock).not.toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
      })
    );
  });

  it("accepts a '* County School District' board title in school scope without a review pass", async () => {
    const payload = {
      district_id: "d-nv-ccsd",
      district_name: "Clark County School District, Nevada",
      district_type: "school_unified",
      state: "NV",
      entries: [
        {
          official_ballot_title: "Clark County School District Board of Trustees, District D",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_ccsd",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts a '* City Schools' board title in school scope without a review pass", async () => {
    const payload = {
      district_id: "d-tn-mcs",
      district_name: "Murfreesboro City School District, Tennessee",
      district_type: "school_elementary",
      state: "TN",
      entries: [
        {
          official_ballot_title: "Murfreesboro City Schools Board of Education",
          election_date: "2099-08-06",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_mcs",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts Arizona's official 'Governing Board Member' title in school scope without a review pass", async () => {
    const payload = {
      district_id: "d-az-puhsd",
      district_name: "Phoenix Union High School District, Arizona",
      district_type: "school_secondary",
      state: "AZ",
      entries: [
        {
          official_ballot_title: "Governing Board Member",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_puhsd",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("accepts a plural '* City Schools' title without another board phrase in school scope", async () => {
    const payload = {
      district_id: "d-tn-mcs",
      district_name: "Murfreesboro City School District, Tennessee",
      district_type: "school_elementary",
      state: "TN",
      entries: [
        {
          official_ballot_title: "Murfreesboro City Schools Board Member, Zone 1",
          election_date: "2099-08-06",
          race_type: "office",
          election_stage: "general",
          is_partisan: false,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_mcs_plural",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    const updateValidatedCall = poolQueryMock.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'validated'")
    );
    expect(updateValidatedCall).toBeTruthy();
    const softFailCall = poolQueryMock.mock.calls.find((call) => String(call[1]?.[1] ?? "").includes("soft_fail"));
    expect(softFailCall).toBeUndefined();
  });

  it("still hard-rejects a county race without school markers in school scope", async () => {
    const payload = {
      district_id: "d-nv-ccsd",
      district_name: "Clark County School District, Nevada",
      district_type: "school_unified",
      state: "NV",
      entries: [
        {
          official_ballot_title: "Clark County Sheriff",
          election_date: "2099-11-03",
          race_type: "office",
          election_stage: "general",
          is_partisan: true,
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_ccsd_sheriff",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_REJECTED_STREAM,
      "*",
      expect.objectContaining({
        ingest_key: "elections:test:1",
        item_type: STAGING_ITEM_TYPE_ELECTION,
      })
    );
  });

  it("validates a targeted ingest key without reading or acknowledging the pending stream", async () => {
    const ingestKey = "manual:elections:targeted:2026";
    const payload = {
      district_id: "d-targeted",
      district_name: "Targeted District",
      district_type: "place",
      state: "WA",
      entries: [],
    };
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: ingestKey,
            payload,
            status: "pending",
            run_id: "run_targeted",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "validated" }] });

    await runElectionsValidator({ ingestKey });

    expect(redisXAutoClaimMock).not.toHaveBeenCalled();
    expect(redisXReadGroupMock).not.toHaveBeenCalled();
    expect(redisXAckMock).not.toHaveBeenCalled();
    expect(redisXAddMock).toHaveBeenCalledWith(
      STAGING_VALIDATED_STREAM,
      "*",
      expect.objectContaining({ ingest_key: ingestKey })
    );
  });

  it("republishes the validated-stream message for a redelivered row already marked validated", async () => {
    // A prior run died between UPDATE ... status='validated' and the XADD:
    // the redelivered pending message must rebuild the missing message, not
    // ack it away and strand the row.
    const payload = { district_id: "d-x", entries: [] };
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          ingest_key: "elections:test:1",
          payload,
          status: "validated",
          run_id: "run_x",
          failure_debug: null,
          schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
        },
      ],
    });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(STAGING_VALIDATED_STREAM, "*", {
      ingest_key: "elections:test:1",
      item_type: STAGING_ITEM_TYPE_ELECTION,
      run_id: "run_x",
      payload: JSON.stringify(payload),
    });
    expect(redisXAckMock).toHaveBeenCalledWith(STAGING_PENDING_STREAM, STAGING_ELECTIONS_VALIDATOR_GROUP, "1-0");
    const updateCall = poolQueryMock.mock.calls.find((call) => String(call[0]).includes("UPDATE"));
    expect(updateCall).toBeUndefined();
  });

  it("republishes the draft-stream message for a redelivered soft-fail requeue whose publish never landed", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          ingest_key: "elections:test:1",
          payload: { district_id: "d-x", entries: [] },
          status: "pending",
          run_id: "run_x",
          failure_debug: null,
          schema_version: "elections_draft_v1",
        },
      ],
    });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(STAGING_DRAFT_STREAM, "*", {
      ingest_key: "elections:test:1",
      item_type: STAGING_ITEM_TYPE_ELECTION,
      run_id: "run_x",
    });
    expect(redisXAckMock).toHaveBeenCalledWith(STAGING_PENDING_STREAM, STAGING_ELECTIONS_VALIDATOR_GROUP, "1-0");
  });

  it("republishes the rejected-stream event for a redelivered row already marked rejected", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          ingest_key: "elections:test:1",
          payload: {},
          status: "rejected",
          run_id: "run_x",
          reason: "hard_fail: out of scope",
          failure_debug: null,
          schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
        },
      ],
    });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).toHaveBeenCalledWith(STAGING_REJECTED_STREAM, "*", {
      ingest_key: "elections:test:1",
      item_type: STAGING_ITEM_TYPE_ELECTION,
      run_id: "run_x",
      reason: "hard_fail: out of scope",
    });
    expect(redisXAckMock).toHaveBeenCalledWith(STAGING_PENDING_STREAM, STAGING_ELECTIONS_VALIDATOR_GROUP, "1-0");
  });

  it("leaves the message unacked when the rejected-stream publish fails after the row was marked rejected", async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload: "not-a-valid-payload",
            status: "pending",
            run_id: "run_x",
            reason: null,
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      // UPDATE ... status='rejected' (hard-fail on unparseable payload)
      .mockResolvedValueOnce({ rowCount: 1 })
      // catch-path getStagingStatus: row already transitioned
      .mockResolvedValueOnce({ rows: [{ status: "rejected" }] });
    redisXAddMock.mockRejectedValueOnce(new Error("redis down"));

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAckMock).not.toHaveBeenCalled();
  });

  it("still acks terminal rows without republishing anything", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          ingest_key: "elections:test:1",
          payload: {},
          status: "written",
          run_id: "run_x",
          failure_debug: null,
          schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
        },
      ],
    });

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAddMock).not.toHaveBeenCalled();
    expect(redisXAckMock).toHaveBeenCalledWith(STAGING_PENDING_STREAM, STAGING_ELECTIONS_VALIDATOR_GROUP, "1-0");
  });

  it("leaves the message unacked when the validated-stream publish fails after the row was marked validated", async () => {
    const payload = {
      district_id: "d-ak",
      district_name: "Congressional District (at Large) (119th Congress), Alaska",
      district_type: "us_house",
      state: "AK",
      entries: [
        {
          official_ballot_title: "United States Representative",
          election_date: "2099-08-18",
          race_type: "office",
          election_stage: "primary",
          sources: ["https://example.org/election"],
        },
      ],
    };

    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            ingest_key: "elections:test:1",
            payload,
            status: "pending",
            run_id: "run_x",
            failure_debug: null,
            schema_version: ELECTION_ENRICHMENT_SCHEMA_VERSION,
          },
        ],
      })
      // UPDATE ... status='validated'
      .mockResolvedValueOnce({ rowCount: 1 })
      // catch-path getStagingStatus: row already transitioned
      .mockResolvedValueOnce({ rows: [{ status: "validated" }] });
    redisXAddMock.mockRejectedValueOnce(new Error("redis down"));

    await runElectionsValidator({ once: true, batchSize: 5, blockMs: 10 });

    expect(redisXAckMock).not.toHaveBeenCalled();
  });
});

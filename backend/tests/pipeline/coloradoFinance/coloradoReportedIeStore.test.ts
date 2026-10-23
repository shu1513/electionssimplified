import { coloradoSourceDay } from "../../../src/pipeline/coloradoFinance/coloradoTracerObservations.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  validateColoradoIeStored,
  writeColoradoReportedIe,
  CO_IE_REVISION,
  type ColoradoIeStoredFacts,
} from "../../../src/pipeline/coloradoFinance/coloradoReportedIeStore.js";
import { aggregateColoradoReportedIe } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeAggregation.js";
import {
  isVerifiedColoradoIeDataset,
  isVerifiedColoradoIeCandidateSource,
  type ColoradoIeDataset,
  type ColoradoIeCandidateSource,
} from "../../../src/pipeline/coloradoFinance/coloradoReportedIeSource.js";
import {
  lockColoradoIeReceiver,
  type ColoradoIeReceiver,
} from "../../../src/pipeline/coloradoFinance/coloradoReportedIeReceiver.js";
vi.mock(
  "../../../src/pipeline/coloradoFinance/coloradoReportedIeSource.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isVerifiedColoradoIeDataset: vi.fn(),
    isVerifiedColoradoIeCandidateSource: vi.fn(),
  }),
);
vi.mock(
  "../../../src/pipeline/coloradoFinance/coloradoReportedIeReceiver.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    lockColoradoIeReceiver: vi.fn(),
  }),
);
const receiver: ColoradoIeReceiver = {
  linkId: "00000000-0000-4000-8000-000000000001",
  candidateId: "00000000-0000-4000-8000-000000000002",
  electionId: "00000000-0000-4000-8000-000000000003",
  candidateName: "Ada Example",
  fullName: "Ada Example",
  linkCandidateName: "ADA EXAMPLE",
  party: "Democratic",
  officeName: "Governor",
  linkOffice: "Governor",
  linkSource: "manual",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingId: "202600001",
  receivingName: "Example Campaign",
  tracerCandidateId: "202600002",
};
function packet() {
  const time = new Date().toISOString(),
    day = coloradoSourceDay(time),
    body = {
      packetDirectory: "packet-00000000-0000-4000-8000-000000000004",
      observedAt: time,
      completedAt: time,
      manifestSha256: "a".repeat(64),
    };
  const source = (n: number) => ({
    ...body,
    originals: Array.from({ length: n }, (_, i) => ({
      file: `${String(i + 1).padStart(4, "0")}.response`,
      sha256: "b".repeat(64),
      bytes: 1,
      startedAt: time,
      completedAt: time,
    })),
  });
  const dataset: ColoradoIeDataset = {
    electionYear: 2026,
    startDate: "2022-01-01",
    endDate: day,
    registry: [
      {
        name: "Example Action",
        committeeType: "Independent Expenditure Committee",
        status: "Active",
      },
    ],
    reports: [
      {
        jurisdiction: "STATEWIDE",
        startDate: "2022-01-01",
        endDate: day,
        expenses: [
          {
            reportedName: "Example Action",
            reportingCaption: "Example Action,",
            date: "2026-01-01",
            amountCents: 100,
            amountMicros: "1000000",
            targets: [
              {
                name: "Ada Example",
                asFiled: "Supporting: Ada Example",
                party: "DEMOCRATIC",
                office: "GOVERNOR",
                stance: "support",
              },
            ],
          },
        ],
        parentCount: 1,
        targetCount: 1,
        signedParentMicros: "1000000",
        signedParentCents: 100,
        negativeParents: 0,
        multipleTargetParents: 0,
        fractionalCentParents: 0,
      },
    ],
    source: source(41),
  };
  const candidate: ColoradoIeCandidateSource = {
    expected: receiver,
    identity: {
      candidateName: "Ada Example",
      candidateId: receiver.tracerCandidateId!,
      receivingId: receiver.receivingId,
      party: "DEM",
      officeName: "Governor",
      cycleYear: 2026,
      cycleStart: "2022-12-09",
      cycleEnd: "2026-12-03",
    },
    source: source(8),
  };
  const facts: ColoradoIeStoredFacts = {
    revision: CO_IE_REVISION,
    startDate: dataset.startDate,
    endDate: day,
    dataset: dataset.source,
    candidate: candidate.source,
  };
  return {
    dataset,
    candidate,
    facts,
    projection: aggregateColoradoReportedIe(dataset, candidate),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const k of [
    "CANDIDATE_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_SYNC_ENABLED",
    "COLORADO_REPORTED_IE_ENABLED",
  ])
    vi.stubEnv(k, "true");
});
afterEach(() => vi.unstubAllEnvs());
describe("Colorado protected IE storage", () => {
  it("validates complete group and original closure", () => {
    const p = packet();
    expect(() =>
      validateColoradoIeStored(
        receiver,
        p.candidate.identity,
        p.facts,
        p.projection,
      ),
    ).not.toThrow();
  });
  it("rejects a missing group even when source counts remain", () => {
    const p = packet();
    p.projection.groups = [];
    expect(() =>
      validateColoradoIeStored(
        receiver,
        p.candidate.identity,
        p.facts,
        p.projection,
      ),
    ).toThrow("stored_ie_group_closure");
  });
  it("rejects corrupt group money", () => {
    const p = packet();
    p.projection.groups[0]!.amountCents = 101;
    expect(() =>
      validateColoradoIeStored(
        receiver,
        p.candidate.identity,
        p.facts,
        p.projection,
      ),
    ).toThrow("stored_ie_group_closure");
  });
  it("rejects a changed original observation edge", () => {
    const p = packet();
    p.facts.dataset.originals[0]!.startedAt = "2026-01-01T00:00:00.000Z";
    expect(() =>
      validateColoradoIeStored(
        receiver,
        p.candidate.identity,
        p.facts,
        p.projection,
      ),
    ).toThrow("stored_ie_original_facts");
  });
  it("rejects a canonical party mismatch", () => {
    const p = packet();
    expect(() =>
      validateColoradoIeStored(
        { ...receiver, party: "Republican" },
        p.candidate.identity,
        p.facts,
        p.projection,
      ),
    ).toThrow("stored_ie_identity");
  });
  it("rejects forged sources before connecting", async () => {
    const p = packet(),
      connect = vi.fn();
    await expect(
      writeColoradoReportedIe({ db: { connect } as never, receiver, ...p }),
    ).rejects.toThrow("unverified_colorado_ie_source");
    expect(connect).not.toHaveBeenCalled();
  });
  it("cannot write with the state sync flag off", async () => {
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_SYNC_ENABLED", "false");
    const p = packet(),
      connect = vi.fn();
    await expect(
      writeColoradoReportedIe({ db: { connect } as never, receiver, ...p }),
    ).rejects.toThrow("colorado_ie_write_disabled");
    expect(connect).not.toHaveBeenCalled();
  });
  it("rolls back a changed canonical context before any component mutation", async () => {
    vi.mocked(isVerifiedColoradoIeDataset).mockReturnValue(true);
    vi.mocked(isVerifiedColoradoIeCandidateSource).mockReturnValue(true);
    vi.mocked(lockColoradoIeReceiver).mockRejectedValue(
      Error("canonical_changed"),
    );
    const query = vi.fn().mockResolvedValue({ rows: [] }),
      release = vi.fn(),
      connect = vi.fn().mockResolvedValue({ query, release });
    await expect(
      writeColoradoReportedIe({
        db: { connect } as never,
        receiver,
        ...packet(),
      }),
    ).rejects.toThrow("canonical_changed");
    expect(query.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledOnce();
  });
  it("rolls back a group insert failure after the source replacement", async () => {
    vi.mocked(isVerifiedColoradoIeDataset).mockReturnValue(true);
    vi.mocked(isVerifiedColoradoIeCandidateSource).mockReturnValue(true);
    const query = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.startsWith("INSERT INTO public.co_reported_ie_groups"))
          throw Error("group_failure");
        return { rows: [] };
      }),
      release = vi.fn(),
      connect = vi.fn().mockResolvedValue({ query, release });
    await expect(
      writeColoradoReportedIe({
        db: { connect } as never,
        receiver,
        ...packet(),
      }),
    ).rejects.toThrow("group_failure");
    expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(
      query.mock.calls.some((c) =>
        String(c[0]).includes("co_candidate_finance_summaries"),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});

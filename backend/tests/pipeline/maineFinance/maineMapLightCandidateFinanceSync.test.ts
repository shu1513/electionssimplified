import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  ballot: vi.fn(),
  qualify: vi.fn(),
  writer: vi.fn(),
  all: vi.fn(),
  ie: vi.fn(),
  read: vi.fn(),
  report: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read }));
vi.mock("../../../src/config/featureFlags.js", () => ({
  isMaineCfisRawDataRefreshEnabled: mocks.raw,
}));
vi.mock(
  "../../../src/pipeline/maineFinance/maineMapLightDatasetClient.js",
  () => ({ captureMaineMapLightDatasets: mocks.capture }),
);
vi.mock(
  "../../../src/pipeline/maineFinance/maineMapLightBallotContext.js",
  () => ({
    acquireMaineMapLightBallot: mocks.ballot,
    qualifyMaineMapLightBallotContext: mocks.qualify,
  }),
);
vi.mock("../../../src/pipeline/maineFinance/maineFinanceWriter.js", () => ({
  replaceMaineCandidateFinanceSnapshot: mocks.writer,
}));
vi.mock(
  "../../../src/pipeline/maineFinance/maineMapLightAllFilerCsv.js",
  () => ({ parseMaineMapLightAllFilerCsv: mocks.all }),
);
vi.mock(
  "../../../src/pipeline/maineFinance/maineMapLightIndependentExpenditureCsv.js",
  () => ({ parseMaineMapLightIndependentExpenditureCsv: mocks.ie }),
);
vi.mock(
  "../../../src/pipeline/maineFinance/maineMapLightReportClient.js",
  () => ({ captureMaineMapLightReport: mocks.report }),
);
import {
  resolveMaineMapLightCandidateSource,
  syncDueMaineMapLightFinance,
} from "../../../src/pipeline/maineFinance/maineMapLightCandidateFinanceSync.js";
import type { MaineMapLightAllFilerTransaction } from "../../../src/pipeline/maineFinance/maineMapLightAllFilerCsv.js";

const candidateId = "11111111-1111-1111-1111-111111111111";
const filerId = `f_${"a".repeat(26)}`;
const payerId = `f_${"b".repeat(26)}`;
const cashId = `a_${"c".repeat(26)}`;
const ieId = `a_${"d".repeat(26)}`;
const own: MaineMapLightAllFilerTransaction = {
  occurrence: 1,
  transactionId: cashId,
  filerId,
  filerName: "Casey Example",
  filerFirstName: "Casey",
  filerLastName: "Example",
  filerOffice: "Senator",
  filerDistrict: "14",
  filerCounty: "",
  sourceRole: "contribution - monetary",
  transactionDate: "2026-09-10",
  amount: "$500.00",
  amountCents: 50000,
  election: "2026 General Election",
  description: "",
  counterpartyClass: "political_action_committee",
  counterpartyName: "Example PAC",
  purpose: "",
  expenditureTargets: "",
};
const expenditure: MaineMapLightAllFilerTransaction = {
  ...own,
  occurrence: 2,
  transactionId: ieId,
  filerId: payerId,
  filerName: "Outside PAC",
  filerFirstName: "",
  filerLastName: "",
  filerOffice: "",
  filerDistrict: "",
  sourceRole: "independent_expenditure - independent_expenditure",
  election: "",
  counterpartyClass: "",
  counterpartyName: "",
};
const allocation = {
  occurrence: 1,
  transactionId: ieId,
  filerId: payerId,
  filerName: "Outside PAC",
  transactionType: "independent_expenditure",
  transactionDate: expenditure.transactionDate,
  totalTransactionAmount: "$500.00",
  totalTransactionAmountCents: 50000,
  description: "",
  purpose: "",
  candidateName: own.filerName,
  candidateId: filerId,
  supportOppose: "support",
  amountSpentOnCandidate: "$500.00",
  amountSpentOnCandidateCents: 50000,
};
const due = {
  id: "33333333-3333-3333-3333-333333333333",
  candidate_id: candidateId,
  election_id: "22222222-2222-2222-2222-222222222222",
  election_year: 2026,
  candidate_name_normalized: "CASEY EXAMPLE",
  office_name: "State Senator",
  district: "14",
  committee_id: "505751",
  committee_name: "Legacy Candidate Committee",
  link_source: "cfis_bulk",
  source_url: "https://legacy.example/",
  last_verified_at: new Date("2026-07-21T17:18:57.586Z"),
  first_name: "Casey",
  last_name: "Example",
  display_name: "Casey Example",
  party: "Democratic",
  office_scope: "state_upper",
  canonical_office_name: "State Senator",
  election_date: "2026-11-03",
  total_due: "9",
};
const run = (options: Record<string, unknown> = {}) => {
  const db = {
    query: vi.fn().mockResolvedValue({ rows: [due] }),
    connect: vi.fn(),
  };
  return {
    db,
    promise: syncDueMaineMapLightFinance({
      db,
      now: new Date("2026-10-12T22:00:00Z"),
      rawDataCacheDir: "/saved",
      ...options,
    }),
  };
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.raw.mockReturnValue(false);
  mocks.read.mockResolvedValue(Buffer.from("validated source originals"));
  mocks.all.mockReturnValue([own, expenditure]);
  mocks.ie.mockReturnValue([allocation]);
  const descriptor = {
    lastUpdatedDate: "2026-10-11",
    lastUpdatedTime: "09:59",
  };
  const body = Buffer.from("validated source originals");
  const control = {
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  mocks.capture.mockResolvedValue({
    status: "captured",
    capture: {
      capturedAt: "2026-10-12T21:20:21Z",
      captureDigest: "a".repeat(64),
      selections: {
        all_filers: { descriptor },
        independent_expenditures: { descriptor },
      },
      datasets: {
        all_filers: { path: "/saved/all.csv", ...control },
        independent_expenditures: { path: "/saved/ie.csv", ...control },
      },
    },
  });
  mocks.ballot.mockResolvedValue({
    status: "available",
    rows: [],
    observedAt: "2026-10-12T21:21:00Z",
    captureDigest: "b".repeat(64),
  });
  mocks.qualify.mockReturnValue({
    context: { qualified: true },
    diagnostics: [],
  });
  mocks.writer.mockResolvedValue({ linkId: due.id });
});
afterEach(() => vi.unstubAllEnvs());
describe("ordinary Maine MapLight batch", () => {
  it("writes independent components through the normal writer without reading legacy CON or changing direct freshness", async () => {
    const { db, promise } = run({ candidateId, electionYear: 2026 });
    const result = await promise;
    expect(result).toMatchObject({
      dueCandidateCount: 9,
      syncedCandidateCount: 1,
      results: [
        {
          ok: true,
          mapLight: {
            committeeDonorAmount: 500,
            outsideAllocationCount: 1,
            knownSupportAmount: 500,
            knownOpposeAmount: 0,
            written: true,
          },
        },
      ],
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ cacheOnly: true, year: 2026 }),
    );
    expect(mocks.writer).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({
          committeeId: "505751",
          lastVerifiedAt: due.last_verified_at,
        }),
        mapLightSource: expect.objectContaining({
          linkId: due.id,
          sourceFilerId: filerId,
          sourceOffice: "Senator",
          qualifiedBallotContext: { qualified: true },
        }),
      }),
    );
    const write = mocks.writer.mock.calls[0][0];
    for (const field of [
      "summary",
      "directBreakdowns",
      "outsideGroups",
      "outsideGroupBreakdowns",
      "classifications",
    ])
      expect(write).not.toHaveProperty(field);
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql.indexOf("link.candidate_id=$6")).toBeLessThan(
      sql.indexOf("LIMIT"),
    );
    expect(sql.indexOf("link.election_year=$7")).toBeLessThan(
      sql.indexOf("LIMIT"),
    );
    expect(sql).toContain("ce.status='declared'");
    expect(sql).toContain("candidate.deleted_at IS NULL");
  });
  it("caps the source period at year end while preserving next-year publication times", async () => {
    const captured = await mocks.capture();
    captured.capture.capturedAt = "2027-01-12T21:20:21Z";
    captured.capture.selections.all_filers.descriptor = {
      lastUpdatedDate: "2027-01-11",
      lastUpdatedTime: "09:59",
    };
    captured.capture.selections.independent_expenditures.descriptor = {
      lastUpdatedDate: "2027-01-10",
      lastUpdatedTime: "09:55",
    };
    const result = await run({ now: new Date("2027-01-12T22:00:00Z") }).promise;
    expect(result.syncedCandidateCount).toBe(1);
    expect(mocks.writer.mock.calls[0][0].mapLightSource).toMatchObject({
      sourceCalendarYear: 2026,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      observedAt: new Date("2027-01-12T21:20:21Z"),
      publishedSourceTimes: {
        allFiler: "2027-01-11 09:59 ET",
        independentExpenditures: "2027-01-10 09:55 ET",
      },
    });
    expect(result.results[0].mapLight?.sourceThrough).toBe("2027-01-10");
  });
  it("requires the raw flag for genuine refresh and keeps force separate", async () => {
    await expect(run({ refresh: true }).promise).rejects.toThrow(
      "MAINE_CFIS_RAW_DATA_REFRESH_ENABLED",
    );
    mocks.raw.mockReturnValue(true);
    await run({ refresh: true }).promise;
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: true, cacheOnly: false }),
    );
    expect(mocks.ballot).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: true, cacheOnly: false }),
    );
  });
  it.each(["dataset", "ballot"])(
    "preserves all money when %s is unavailable",
    async (which) => {
      (which === "dataset" ? mocks.capture : mocks.ballot).mockResolvedValue({
        status: "unavailable",
      });
      const result = await run().promise;
      expect(result.failedCandidateCount).toBe(1);
      expect(mocks.writer).not.toHaveBeenCalled();
      expect(result.results[0].mapLight).toBeUndefined();
    },
  );
  it("preserves the entire outside component when a payer return becomes ambiguous", async () => {
    mocks.all.mockReturnValue([
      own,
      expenditure,
      {
        ...expenditure,
        transactionId: `a_${"e".repeat(26)}`,
        sourceRole: "returned - returned_expenditure",
        amountCents: 10000,
      },
    ]);
    const result = await run().promise;
    expect(
      mocks.writer.mock.calls[0][0].mapLightOutsideAllocations,
    ).toBeUndefined();
    expect(mocks.writer.mock.calls[0][0].mapLightCommitteeDonors).toHaveLength(
      1,
    );
    expect(result.results[0].mapLight).toMatchObject({
      knownSupportAmount: null,
      knownOpposeAmount: null,
      omittedPayerCount: 1,
    });
  });
  it.each([
    "ambiguous source",
    "changed own identity",
    "ballot conflict",
    "known display conflict",
  ])("refuses %s", async (which) => {
    if (which === "ambiguous source")
      mocks.all.mockReturnValue([
        own,
        expenditure,
        {
          ...own,
          filerId: `f_${"e".repeat(26)}`,
          transactionId: `a_${"f".repeat(26)}`,
        },
      ]);
    if (which === "changed own identity")
      mocks.all.mockReturnValue([
        own,
        expenditure,
        {
          ...own,
          transactionId: `a_${"f".repeat(26)}`,
          filerOffice: "Representative",
        },
      ]);
    if (which === "ballot conflict")
      mocks.qualify.mockReturnValue({ diagnostics: ["conflict"] });
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            ...due,
            ...(which === "known display conflict"
              ? { display_name: "Wrong Person" }
              : {}),
          },
        ],
      }),
      connect: vi.fn(),
    };
    const result = await syncDueMaineMapLightFinance({ db });
    expect(result.failedCandidateCount).toBe(1);
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("dry-run validates source facts without writing canonical money", async () => {
    expect(
      (await run({ dryRun: true }).promise).results[0].mapLight?.written,
    ).toBe(false);
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("keeps the original dry-run and timestamp when caller options change during acquisition", async () => {
    let release!: (value: { rows: (typeof due)[] }) => void;
    const db = {
      query: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
      connect: vi.fn(),
    };
    const now = new Date("2026-10-12T22:00:00Z");
    const options = {
      db,
      dryRun: true,
      now,
      mapLightReportUrls: [] as string[],
    };
    const result = syncDueMaineMapLightFinance(options);
    options.dryRun = false;
    now.setFullYear(2030);
    options.mapLightReportUrls.push("https://bad.example/");
    release({ rows: [due] });
    expect(await result).toMatchObject({
      dryRun: true,
      now: "2026-10-12T22:00:00.000Z",
    });
    expect(mocks.writer).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("rejects invalid scope before querying or downloading", async () => {
    const { db, promise } = run({ candidateId: "bad" });
    await expect(promise).rejects.toThrow("candidate ID");
    expect(db.query).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("does not turn a zero-row source into financial zeros", async () => {
    mocks.all.mockReturnValue([]);
    mocks.ie.mockReturnValue([]);
    expect((await run().promise).failedCandidateCount).toBe(1);
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("refuses a captured body that changes between verification and production parsing", async () => {
    mocks.read.mockResolvedValue(Buffer.from("tampered after capture"));
    expect((await run().promise).failedCandidateCount).toBe(1);
    expect(mocks.writer).not.toHaveBeenCalled();
  });
});
describe("Maine whole-source own filer uniqueness", () => {
  it("refuses unknown statewide office bindings", () => {
    expect(
      resolveMaineMapLightCandidateSource({
        rows: [own],
        firstName: own.filerFirstName,
        lastName: own.filerLastName,
        officeScope: "statewide",
        district: "14",
      }),
    ).toBeUndefined();
  });
});

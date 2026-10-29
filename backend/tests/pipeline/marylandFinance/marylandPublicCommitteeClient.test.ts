import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireMarylandPublicCommitteeCensus,
  buildMarylandPublicCommitteeRequest,
  decodeMarylandPublicCommitteePage,
  fetchMarylandPublicCommitteePage,
} from "../../../src/pipeline/marylandFinance/marylandPublicCommitteeClient.js";
const uuid = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
function row(n = 1, extra: Record<string, unknown> = {}) {
  return {
    filerRegistrationGuid: uuid(n),
    registrationDocumentGuid: uuid(n + 1000),
    filingEntityId: n,
    committeeName: "Exact committee",
    candidateName: "Source person",
    committeeType: "Candidate",
    committeeTypeCode: "CC",
    officeSought: "Governor/Lieutenant Governor",
    officeSoughtId: 40,
    jurisdiction: "Maryland State",
    jurisdictionId: 1,
    partyAffiliation: "Democrat",
    accountStatus: "Active",
    accountStatusCode: "FACT",
    electionYears: "2026,2022",
    electionCycleID: "12023",
    electionTypeCodes: "GBRELEC",
    elections: "Gubernatorial - 11/08/2026",
    registrationYear: 2021,
    isActive: true,
    registrationSubmittalDate: "2021-01-01T00:00:00",
    registrationApprovalDate: "2021-01-02T00:00:00",
    registrationTerminatedDate: null,
    lastRegistrationAmendedDate: "2026-01-01T00:00:00",
    unknownSource: { retained: true },
    ...extra,
  };
}
function env(rows = [row()], totalItems = rows.length) {
  return {
    succeeded: true,
    error: null,
    data: { items: rows, totalItems, pageNumber: 0, pageSize: 0 },
  };
}
const numeric = {
  query: { kind: "numeric" as const, filingEntityId: 1 },
  pageNumber: 1,
};
const named = {
  query: { kind: "name" as const, committeeName: "Exact committee" },
  pageNumber: 1,
};
const dirs: string[] = [];
async function dir() {
  const d = await mkdtemp(join(tmpdir(), "md-reg-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
describe("closed Maryland committee registration facts", () => {
  it("uses20 numeric/19 literal fields, no type/status/year/amount filters", () => {
    const n = buildMarylandPublicCommitteeRequest(numeric),
      s = buildMarylandPublicCommitteeRequest(named);
    expect(Object.keys(n)).toHaveLength(20);
    expect(Object.keys(s)).toHaveLength(19);
    expect(n).toMatchObject({
      filingEntityId: 1,
      filerName: "1",
      pageSize: 100,
      sortBy: "CommitteeName",
      sortType: "asc",
      accountStatus: null,
      electionYear: null,
      committeeType: null,
    });
    expect(s).not.toHaveProperty("filingEntityId");
    for (const k of [
      "totalRaisedMin",
      "totalRaisedMax",
      "totalSpentMin",
      "totalSpentMax",
    ])
      expect(n).not.toHaveProperty(k);
  });
  it.each([
    { query: { kind: "numeric", filingEntityId: "1" } },
    { query: { kind: "numeric", filingEntityId: 0 } },
    { query: { kind: "name", committeeName: " " } },
    {
      query: {
        kind: "name",
        committeeName: "Exact committee",
        accountStatus: "Active",
      },
    },
    { pageNumber: 0 },
    { pageNumber: 1.5 },
    { accountStatus: null },
  ])("rejects invalid or extended scope %j", (extra) => {
    expect(() =>
      buildMarylandPublicCommitteeRequest({ ...numeric, ...extra } as never),
    ).toThrow("invalid_request");
  });
  it("keeps source-unknown class/status and full physical historical rows", () => {
    const v = env([
      row(),
      row(2, {
        committeeType: "Unknown",
        committeeTypeCode: "NEW",
        isActive: false,
        accountStatus: "Terminated",
        registrationTerminatedDate: "2026-01-01",
      }),
    ]);
    const p = decodeMarylandPublicCommitteePage(
      v,
      buildMarylandPublicCommitteeRequest(named),
    );
    expect(p.rows).toHaveLength(2);
    expect(p.rows[1]!.committeeTypeCode).toBe("NEW");
    v.data.items[0]!.unknownSource = { retained: false };
    expect(p.rows[0]!.unknownSource).toEqual({ retained: true });
    expect(p).not.toHaveProperty("current");
  });
  it("retains null historical context beside a fully identified account", async () => {
    const historical = row(2, {
      officeSought: null,
      officeSoughtId: null,
      jurisdiction: null,
      jurisdictionId: null,
      partyAffiliation: null,
      electionCycleID: null,
      registrationDocumentGuid: null,
      isActive: false,
      accountStatus: "Terminated",
    });
    const response = env([row(), historical]);
    const outputDirectory = join(await dir(), "nullable-history");
    const census = await acquireMarylandPublicCommitteeCensus({
      query: named.query,
      outputDirectory,
      fetchImpl: async () => new Response(JSON.stringify(response)),
    });
    expect(census).toMatchObject({
      declaredRows: 2,
      physicalRows: 2,
      completedPages: 1,
    });
    const decoded = decodeMarylandPublicCommitteePage(
      response,
      buildMarylandPublicCommitteeRequest(named),
    );
    expect(decoded.rows[1]).toMatchObject({
      officeSought: null,
      officeSoughtId: null,
      jurisdiction: null,
      jurisdictionId: null,
      partyAffiliation: null,
      electionCycleID: null,
      registrationDocumentGuid: null,
    });
    expect(decoded).not.toHaveProperty("binding");
  });
  it.each([
    { officeSoughtId: null },
    { officeSought: null },
    { jurisdictionId: null },
    { jurisdiction: null },
    { partyAffiliation: undefined },
    { electionCycleID: undefined },
    { partyAffiliation: 1 },
    { electionCycleID: [] },
    { registrationDocumentGuid: undefined },
    { registrationDocumentGuid: "" },
    { registrationDocumentGuid: "00000000-0000-0000-0000-000000000000" },
  ])("holds missing, mistyped or incoherent optional context %j", (extra) => {
    expect(() =>
      decodeMarylandPublicCommitteePage(
        env([row(1, extra)]),
        buildMarylandPublicCommitteeRequest(named),
      ),
    ).toThrow("invalid_committee_page");
  });
  it.each([
    { filerRegistrationGuid: null },
    { registrationDocumentGuid: "bad" },
    { filingEntityId: 2 },
    { officeSoughtId: 0 },
    { isActive: null },
    { candidateName: 1 },
    { electionYears: [2026] },
    { registrationYear: 2026.5 },
  ])("holds wrong scope/malformed contextual scalar %j", (extra) => {
    expect(() =>
      decodeMarylandPublicCommitteePage(
        env([row(1, extra)]),
        buildMarylandPublicCommitteeRequest(numeric),
      ),
    ).toThrow("invalid_committee_page");
  });
  it("holds repeated occurrences, short interior pages and wrong source echo", () => {
    const r = buildMarylandPublicCommitteeRequest(named);
    expect(() =>
      decodeMarylandPublicCommitteePage(env([row(), row()]), r),
    ).toThrow();
    expect(() =>
      decodeMarylandPublicCommitteePage(env([row()], 101), r),
    ).toThrow();
    const v = env();
    v.data.pageNumber = 2;
    expect(() => decodeMarylandPublicCommitteePage(v, r)).toThrow();
  });
  it("keeps different actual registration documents without selecting max", () => {
    const p = decodeMarylandPublicCommitteePage(
      env([
        row(),
        row(1, { registrationDocumentGuid: uuid(9999), isActive: false }),
      ]),
      buildMarylandPublicCommitteeRequest(named),
    );
    expect(p.rows).toHaveLength(2);
  });
  it("returns only safe counts/capture and preserves raw HTTP failure", async () => {
    const outputPath = join(await dir(), "raw");
    const result = await fetchMarylandPublicCommitteePage({
      ...numeric,
      outputPath,
      fetchImpl: async () => new Response(JSON.stringify(env())),
    });
    expect(result.physicalCount).toBe(1);
    expect(result).not.toHaveProperty("rows");
    expect(result.capture).not.toHaveProperty("headers");
    await expect(
      fetchMarylandPublicCommitteePage({
        ...numeric,
        outputPath: join(await dir(), "bad"),
        fetchImpl: async () => new Response("failure", { status: 403 }),
      }),
    ).rejects.toMatchObject({ code: "http_status" });
  });
  it("collects every physical name-match page, no current/legal verdict", async () => {
    const outputDirectory = join(await dir(), "gen");
    const f = vi.fn<typeof fetch>(async (_u, i) => {
      const n = JSON.parse(String(i!.body)).pageNumber;
      return new Response(
        JSON.stringify(
          env(
            Array.from({ length: n === 1 ? 100 : 1 }, (_, j) =>
              row((n - 1) * 100 + j + 1),
            ),
            101,
          ),
        ),
      );
    });
    const r = await acquireMarylandPublicCommitteeCensus({
      query: named.query,
      outputDirectory,
      fetchImpl: f,
    });
    expect(r).toMatchObject({
      physicalRows: 101,
      declaredRows: 101,
      completedPages: 2,
    });
    expect(r).not.toHaveProperty("rows");
    expect(
      (await readFile(r.journalPath, "utf8")).trim().split("\n"),
    ).toHaveLength(2);
  });
  it.each(["count", "duplicate", "account"])(
    "holds cross-page %s drift",
    async (kind) => {
      const outputDirectory = join(await dir(), "gen");
      const f = vi.fn<typeof fetch>(async (_u, i) => {
        const n = JSON.parse(String(i!.body)).pageNumber;
        const rs =
          n === 1
            ? Array.from({ length: 100 }, (_, j) => row(j + 1))
            : [
                kind === "duplicate"
                  ? row()
                  : kind === "account"
                    ? row(999, { filerRegistrationGuid: uuid(1) })
                    : row(101),
              ];
        return new Response(
          JSON.stringify(env(rs, kind === "count" && n === 2 ? 102 : 101)),
        );
      });
      await expect(
        acquireMarylandPublicCommitteeCensus({
          query: named.query,
          outputDirectory,
          fetchImpl: f,
        }),
      ).rejects.toThrow();
    },
  );
  it("bounds never-settling observer and retains original journal", async () => {
    const outputDirectory = join(await dir(), "gen");
    await expect(
      acquireMarylandPublicCommitteeCensus({
        query: numeric.query,
        outputDirectory,
        totalTimeoutMs: 40,
        fetchImpl: async () => new Response(JSON.stringify(env())),
        onCapture: () => new Promise(() => {}),
      }),
    ).rejects.toMatchObject({ code: "census_timeout" });
    expect(
      (
        await readFile(join(outputDirectory, "captures.private.jsonl"), "utf8")
      ).trim(),
    ).not.toBe("");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMarylandIndependentOutsideSource } from "../../../src/pipeline/marylandFinance/marylandIndependentOutsideSource.js";
import {
  fixture,
  id,
  owner,
  payer,
} from "./marylandIndependentOutsideTestFixtures.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const response = (data: unknown) =>
  new Response(JSON.stringify({ succeeded: true, error: null, data }));
const page = (items: unknown[]) => ({
  items,
  totalItems: items.length,
  pageNumber: 0,
  pageSize: 0,
});
function transport() {
  const f = fixture();
  const rows = f.rows.map((r, i) => ({
    ...r,
    committeeType: "Independent",
    officeSought: "",
    officeSoughtId: null,
    position: "Support",
    expenditureType: "Independent Expenditure",
    fundType: "Electoral",
    fundTypeCode: "ELECT",
    report: "Report",
    reportTypeCode: "IEXPR",
    reportId: 10,
    createdDate: "2026-10-02T12:30:45.12",
    filedDate: "2026-10-02T12:30:45",
    isAmended: false,
    transactionStatusCode: "FIL",
    candidateMeasureGuid: id(100 + i),
  }));
  let failReturns = false;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const route = String(url),
      body = init?.body ? JSON.parse(String(init.body)) : null;
    if (route.includes("candidatelist")) return new Response(f.rosterHtml);
    if (route.endsWith("candidacy/ballot.html"))
      return new Response(f.electionDatesHtml);
    if (route.endsWith("GetAllFilingCycleList"))
      return response([{ value: "12023", name: "2023-2026", isDefault: true }]);
    if (route.endsWith("GetIndependentExpenditureList"))
      return response(page(rows));
    if (route.endsWith("GetCommitteeList")) {
      if (body.filerName === "Former committee label")
        return response(page([]));
      const r = rows.find(
        (r) => r.candidateBallotIssueName === body.filerName,
      )!;
      const reg = f.registry.get(r.candidateGuid)![0]!;
      return response(
        page([
          {
            ...reg,
            committeeType: "Candidate",
            jurisdiction: "State",
            electionCycleID: "12023",
            elections: "General",
            registrationYear: 2021,
            registrationSubmittalDate: "2021-01-01T00:00:00",
            registrationApprovalDate: "2021-01-02T00:00:00",
            lastRegistrationAmendedDate: "2026-01-01T00:00:00",
          },
        ]),
      );
    }
    if (route.endsWith("GetCfPublicProfileFiling"))
      return response(page(f.reports.get(payer)!));
    if (route.endsWith("GetTransactionDetailsByGuid"))
      return response(f.controls.values().next().value!.detail);
    if (route.endsWith("GetPublicCandidateMeasureList"))
      return response(page([...f.controls.values().next().value!.allocations]));
    if (route.endsWith("GetChildTransactionDetails"))
      return failReturns
        ? new Response("unavailable", { status: 503 })
        : response(page([]));
    throw Error("unexpected_mock_route:" + new URL(route).pathname);
  });
  return {
    f,
    rows,
    fetchImpl,
    fail: () => {
      failReturns = true;
    },
  };
}
describe("normal Maryland composite outside source", () => {
  it("qualifies complete genuine transports and reopens saved sources before fresh closings", async () => {
    const rawCacheDir = await mkdtemp(join(tmpdir(), "md-outside-source-"));
    dirs.push(rawCacheDir);
    const t = transport(),
      input = {
        contexts: [t.f.context],
        previousSources: new Map(),
        rawCacheDir,
        fetchImpl: t.fetchImpl,
      };
    const first = await loadMarylandIndependentOutsideSource(input);
    expect(first.results).toEqual([{ dueIndex: 0, diagnostics: [] }]);
    expect(first.snapshots).toHaveLength(1);
    expect(first.snapshots[0]).toMatchObject({
      supportCents: 6000,
      allocationCount: 1,
      targetAccountGuids: [owner],
    });
    const second = await loadMarylandIndependentOutsideSource(input);
    expect(second.snapshots).toHaveLength(1);
    expect(second.savedOpeningQueries).toBe(3);
    expect(second.snapshots[0]!.supportCents).toBe(6000);
    const controls = t.fetchImpl.mock.calls.filter(([u]) =>
      String(u).endsWith("GetChildTransactionDetails"),
    );
    expect(controls).toHaveLength(2);
    expect(JSON.parse(String(controls[0]![1]!.body))).not.toHaveProperty(
      "sortBy",
    );
  });
  it("queries every observed label when transport order starts with a former committee name", async () => {
    const rawCacheDir = await mkdtemp(join(tmpdir(), "md-outside-source-"));
    dirs.push(rawCacheDir);
    const t = transport();
    t.rows.unshift({
      ...t.rows[0]!,
      candidateBallotIssueName: "Former committee label",
      transactionGuid: id(900),
      candidateMeasureGuid: id(901),
      expenditureTypeCode: "TECOM",
    });
    const result = await loadMarylandIndependentOutsideSource({
      contexts: [t.f.context],
      previousSources: new Map(),
      rawCacheDir,
      fetchImpl: t.fetchImpl,
    });
    expect(result.results).toEqual([{ dueIndex: 0, diagnostics: [] }]);
    expect(result.snapshots[0]!.supportCents).toBe(6000);
    const names = t.fetchImpl.mock.calls
      .filter(([u]) => String(u).endsWith("GetCommitteeList"))
      .map(([, init]) => JSON.parse(String(init!.body)).filerName);
    expect(names).toContain("Former committee label");
    expect(names).toContain(t.f.rows[0]!.candidateBallotIssueName);
  });
  it("preserves when a parent source fails", async () => {
    const rawCacheDir = await mkdtemp(join(tmpdir(), "md-outside-source-"));
    dirs.push(rawCacheDir);
    const t = transport(),
      input = {
        contexts: [t.f.context],
        previousSources: new Map(),
        rawCacheDir,
        fetchImpl: t.fetchImpl,
      };
    const first = await loadMarylandIndependentOutsideSource(input);
    expect(first.snapshots).toHaveLength(1);
    t.fail();
    const failed = await loadMarylandIndependentOutsideSource(input);
    expect(failed.snapshots).toHaveLength(0);
    expect(failed.results[0]!.diagnostics).not.toHaveLength(0);
  });
});

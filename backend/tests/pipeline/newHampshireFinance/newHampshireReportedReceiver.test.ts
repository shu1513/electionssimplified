import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aggregateNewHampshireReportedIe } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedFinanceAggregation.js";
import { createNewHampshireReportedSourceProducer } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedSourceCache.js";
import { qualifyNewHampshireReportedReceiver, type NewHampshireReportedReceiver } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedReceiver.js";
import type { NewHampshireReportedBase } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedSourceGraph.js";

import { guid, nativeFixture } from "./newHampshireReportedTestFixtures.js";

let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), "nh-reported-receiver-test-")); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

// Synthetic registry rows: a linked State Senate committee and an unlinked
// State Representative committee registered under the same candidate name.
const registration = (n: number, office: string, district: string, town: string | null) => ({
  guid: guid(n), filerEntityId: n, filerName: `Synthetic filer ${n}`, electionId: 10, electionYear: 2026,
  electionCycle: "2026 Election Cycle", filerStatus: "Active", filerTypeCode: "CC", filerSubTypeCode: null, filerSubTypeName: null,
  firstnameLastname: "Synthetic Candidate", firstName: "Synthetic", lastName: "Candidate", committeeName: `Friends of ${n}`,
  officeSoughtName: office, districtName: district, town,
});
const base = (registry: Record<string, unknown>[]): NewHampshireReportedBase => ({ electionYear: 2026, electionCycleId: 10, registry });
const receiver: NewHampshireReportedReceiver = {
  linkId: guid(1), candidateId: guid(2), electionId: guid(3), electionYear: 2026, electionDate: "2026-11-03",
  candidateName: "Synthetic Candidate", candidateAliases: ["Synthetic Candidate"], officeScope: "state_upper",
  officeName: "State Senate", district: "3", filingEntityId: 1000, filerName: "Synthetic filer 1000", linkSource: "cfs_registration",
};

describe("qualifyNewHampshireReportedReceiver", () => {
  it("keeps the candidate's own name as an IE target when the registry has one race for it", () => {
    const context = qualifyNewHampshireReportedReceiver(receiver, base([registration(1000, "State Senate", "District 3", null)]));
    expect(context.candidateAliases).toEqual(["Synthetic Candidate"]);
  });

  it("drops a name an unlinked same-name committee claims for another race, so IE is held", async () => {
    const context = qualifyNewHampshireReportedReceiver(receiver, base([
      registration(1000, "State Senate", "District 3", null),
      registration(3000, "State Representative", "District 5", "Hillsborough"),
    ]));
    expect(context.candidateAliases).toEqual([]);
    const producer = createNewHampshireReportedSourceProducer({ cacheDir, fetchImpl: nativeFixture().fetchImpl, minimumGapMs: 0 });
    const acquired = await producer.refreshBase(2026);
    const source = await producer.refreshComponent({ kind: "ie", electionYear: 2026, base: acquired!.reference });
    expect(() => aggregateNewHampshireReportedIe({ source: source!, candidateAliases: context.candidateAliases })).toThrow("ambiguous_candidate_target");
  });

  it("holds when the receiver's name resolves to a different filer", () => {
    expect(() => qualifyNewHampshireReportedReceiver({ ...receiver, filingEntityId: 3000 }, base([
      registration(1000, "State Senate", "District 3", null),
      registration(3000, "State Representative", "District 5", "Hillsborough"),
    ]))).toThrow("receiving_registration_changed");
  });
});

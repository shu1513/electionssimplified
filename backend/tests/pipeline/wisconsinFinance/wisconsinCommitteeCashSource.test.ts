import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertWisconsinCashPacket, loadWisconsinCommitteeCashPacket, selectWisconsinCashReceiver } from "../../../src/pipeline/wisconsinFinance/wisconsinCommitteeCashSource.js";

import { context, receiver, entity, source } from "./wisconsinCashTestFixture.js";

const paths: string[] = [];
async function cache() { const p = await mkdtemp(join(tmpdir(), "wi-cash-test-")); paths.push(p); return p; }
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(new Date("2026-10-24T05:00:00Z")));
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function load(f = source(), ctx = context) { return loadWisconsinCommitteeCashPacket(ctx, { cacheDir: await cache(), allowNetwork: true, fetchImpl: f.fetchImpl }); }

describe("Wisconsin reported committee cash qualification", () => {
  it("requires the candidate role rather than an administrator or a committee-name hint", () => {
    const r = receiver(); r.entityConnections[0].entity.name = context.candidateName; r.entityConnections[1].entity.name = "Another Candidate";
    expect(() => selectWisconsinCashReceiver([r], context)).toThrow("receiver_identity_ambiguous");
  });
  it("rejects conflicting middle-name evidence despite first/last overlap", () => {
    const r = receiver(); r.entityConnections[1].entity.name = "Example, Alex B.";
    expect(() => selectWisconsinCashReceiver([r], { ...context, candidateName: "Alex A. Example" })).toThrow("receiver_identity_ambiguous");
  });
  it("rejects the primary event and a different office", () => {
    const r = receiver(); r.eventConnections[0].event.date = "2026-08-11T00:00:00.000Z";
    expect(() => selectWisconsinCashReceiver([r], context)).toThrow("receiver_identity_ambiguous");
    r.eventConnections[0].event.date = "2026-11-03T00:00:00.000Z"; r.eventConnections[0].office.name = "Governor";
    expect(() => selectWisconsinCashReceiver([r], context)).toThrow("receiver_identity_ambiguous");
  });
  it("holds multiple matching receivers or multiple event contexts", () => {
    expect(() => selectWisconsinCashReceiver([receiver(), { ...receiver(), id: 99 }], context)).toThrow("receiver_identity_ambiguous");
    const r = receiver(); r.eventConnections.push({ ...r.eventConnections[0] });
    expect(() => selectWisconsinCashReceiver([r], context)).toThrow("receiver_identity_ambiguous");
  });
  it("verifies complete coverage and parent counts, excludes non-gifts and subtracts returned cash", async () => {
    const p = await load(); expect(p.occurrenceCount).toBe(6); expect(p.reportCount).toBe(5); expect(p.monetaryReceiptCount).toBe(2);
    expect(p.regularCoverageThrough).toBe("2026-09-23"); expect(p.excludedInKindCount).toBe(1); expect(p.excludedLoanCount).toBe(1); expect(p.excludedOtherIncomeCount).toBe(1); expect(p.returnedContributionCount).toBe(1);
    expect(p.donors).toEqual([{ committeeId: "77", committeeName: "Example Labor PAC", amountCents: 95000, contributionCount: 1,
      evidence: "native_registry_class", sourceUrl: "https://campaignfinance.wi.gov/browse-data/registrant/77" }]);
    expect(() => assertWisconsinCashPacket(p)).not.toThrow(); expect(() => assertWisconsinCashPacket({ ...p })).toThrow("unverified_packet");
    expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.context)).toBe(true); expect(Object.isFrozen(p.donors)).toBe(true); expect(Object.isFrozen(p.donors[0])).toBe(true);
    expect(() => { (p as any).entityId = "999"; }).toThrow(TypeError);
    expect(() => { (p.context as any).officeName = "Governor"; }).toThrow(TypeError);
    expect(() => { (p.donors[0] as any).amountCents = 1; }).toThrow(TypeError);
  });
  it("classifies refund-only non-person recipients and preserves a signed negative position", async () => {
    const f = source(); f.fixture.ledger.push({ ...f.fixture.ledger[5], id: 7, amount: 100, to_entity: entity(99, "Refund Only Party", "BUSINESS_OR_ORG") });
    const p = await load(f);
    expect(p.donors.map(d => [d.amountCents, d.contributionCount])).toEqual([[95000, 1], [-10000, 0]]);
  });
  it("counts global transaction IDs once when native periodic template bounds overlap", async () => {
    const f = source(); f.fixture.templates[4]!.transactionsStartDate = "2026-07-01T00:00:00.000Z";
    f.fixture.ledger[0].date = "2026-07-10T00:00:00.000Z"; f.fixture.ledger[0].reports = [{ id: 104 }];
    f.fixture.parentCounts = { 104: 1, 105: 5 };
    const p = await load(f); expect(p.occurrenceCount).toBe(6); expect(p.donors[0]?.amountCents).toBe(95000);
  });
  it("keeps distinct native gifts even when donor, date and amount look identical", async () => {
    const f = source(); f.fixture.ledger.push({ ...f.fixture.ledger[0], id: 7 });
    const p = await load(f); expect(p.donors[0]?.contributionCount).toBe(2); expect(p.donors[0]?.amountCents).toBe(195000);
  });
  it("rejects a repeated native transaction ID across report references", async () => {
    const f = source(); f.fixture.ledger.push({ ...f.fixture.ledger[0], reports: [{ id: 104 }] });
    await expect(load(f)).rejects.toThrow("duplicate_or_invalid_row_id");
  });
  it("copies canonical context before asynchronous acquisition", async () => {
    const f = source(), mutable = { ...context }; f.fixture.onRequest = () => { mutable.candidateName = "Changed Candidate"; };
    expect((await load(f, mutable)).context.candidateName).toBe(context.candidateName);
  });
  it("keeps an explicit reported PAC-name tier distinct from registry classification", async () => {
    const f = source(); f.fixture.registered = false;
    expect((await load(f)).donors[0]?.evidence).toBe("reported_pac_name");
  });
  it("requires the native unregistered profile for the reported-name tier", async () => {
    const f = source(); f.fixture.registered = false; f.fixture.profileType = "Unknown";
    await expect(load(f)).rejects.toThrow("reported_pac_profile");
  });
  it("does not label a generic unregistered registrant a PAC", async () => {
    const f = source(); f.fixture.registered = false; f.fixture.ledger[0].from_entity.name = "Community Fund";
    await expect(load(f)).rejects.toThrow("registrant_class_unqualified");
  });
  it("holds an unqualified native committee class rather than dropping its cash", async () => {
    const f = source(); f.fixture.donorClass = "Conduit";
    await expect(load(f)).rejects.toThrow("donor_class_unqualified");
  });
  it("holds unsupported amendment lineage", async () => {
    const f = source(); f.fixture.reports[4]!.reportSubmissions.push({ id: 999 });
    await expect(load(f)).rejects.toThrow("amendment_lineage_unqualified");
  });
  it("rejects an independently inconsistent parent occurrence count", async () => {
    const f = source(); f.fixture.countDelta = 1;
    await expect(load(f)).rejects.toThrow("parent_count_mismatch");
  });
  it("holds a missing periodic interval instead of declaring a full cycle", async () => {
    const f = source(); f.fixture.reports.splice(1, 1);
    await expect(load(f)).rejects.toThrow("regular_coverage_gap");
  });
  it("rejects unfiled and unknown-parent rows", async () => {
    const f = source(); f.fixture.ledger[0].reports = [];
    await expect(load(f)).rejects.toThrow("unfiled_or_repeated_parent");
    const other = source(); other.fixture.ledger[0].reports = [{ id: 999 }];
    await expect(load(other)).rejects.toThrow("unknown_current_parent");
  });
  it("holds a new cash category, unsupported related payer or invalid money", async () => {
    const f = source(); f.fixture.cats[0].code = "NEW_CASH";
    await expect(load(f)).rejects.toThrow("other_cash_receipt_unqualified");
    const related = source(); related.fixture.ledger[0].relatedPayer = entity(89, "Underlying Person", "PERSON");
    await expect(load(related)).rejects.toThrow("related_payer_unqualified");
    const money = source(); money.fixture.ledger[0].amount = 100.001;
    await expect(load(money)).rejects.toThrow("source_money");
  });
  it("holds a notice inside regular coverage unless the same transaction references the regular parent", async () => {
    const f = source(); f.fixture.templates[4]!.templateType = "EVENT_TRIGGERED";
    f.fixture.templates[3]!.transactionsEndDate = "2026-09-23T23:59:59.999Z";
    await expect(load(f)).rejects.toThrow("notice_overlap_unqualified");
  });
});

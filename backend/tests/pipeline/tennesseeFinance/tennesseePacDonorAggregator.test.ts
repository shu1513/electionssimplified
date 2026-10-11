import { describe, expect, it } from "vitest";
import {
  aggregateTennesseePacDonors, validateTennesseePacDonors,
  type TennesseeFinancePacDonor, type TennesseePacCashReceipt,
} from "../../../src/pipeline/tennesseeFinance/tennesseePacDonorAggregator.js";

// Synthetic policy fixtures; financial/current-report closure is tested separately.
const sourceUrl = "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=123786";
const receipt = (overrides: Partial<TennesseePacCashReceipt> = {}): TennesseePacCashReceipt => ({
  reportId: "123786", occurrence: 0, contributorName: "Example Employees PAC", contributorClass: "P",
  date: "2025-08-19", amountCents: 100000, sourceUrl, ...overrides,
});
const run = (receipts = [receipt()], registry = [{ campId: "261", name: "EXAMPLE EMPLOYEES PAC" }]) =>
  aggregateTennesseePacDonors({ receipts, registry, windowStart: "2025-01-01", windowEnd: "2026-12-31" });

describe("Tennessee typed PAC identity enrichment", () => {
  it("retains two identical gifts as distinct current occurrences", () => {
    const result = run([receipt(), receipt({ occurrence: 1 })]);
    expect(result.diagnostics).toEqual([]);
    expect(result.donors).toEqual([{ committeeId: "261", committeeName: "EXAMPLE EMPLOYEES PAC",
      committeeType: "Political Action Committee", amount: 2000, contributionCount: 2, sourceUrl }]);
  });
  it("retains independently typed unmatched names under a reported namespace", () => {
    expect(run([receipt()], []).donors?.[0]).toMatchObject({
      committeeId: "reported:EXAMPLE EMPLOYEES PAC", committeeName: "Example Employees PAC", amount: 1000,
    });
  });
  it("does not infer PAC class from a committee keyword or registry name", () => {
    expect(run([receipt({ contributorClass: "C" })]).donors).toEqual([]);
    expect(run([receipt({ contributorClass: "" })]).donors).toEqual([]);
  });
  it("retains registered aliases and repeated metadata under one legal identity", () => {
    const result = run([receipt(), receipt({ occurrence: 1, contributorName: "OTHER SOURCE ALIAS" })], [
      { campId: "261", name: "EXAMPLE EMPLOYEES PAC" }, { campId: "261", name: "EXAMPLE EMPLOYEES PAC" },
      { campId: "261", name: "OTHER SOURCE ALIAS" },
    ]);
    expect(result.donors).toHaveLength(1);
    expect(result.donors?.[0]).toMatchObject({ amount: 2000, contributionCount: 2 });
  });
  it("preserves the entire component on multiple legal identities", () => {
    expect(run([receipt()], [{ campId: "1", name: "EXAMPLE EMPLOYEES PAC" },
      { campId: "2", name: "EXAMPLE EMPLOYEES PAC" }]).donors).toBeUndefined();
  });
  it("preserves contradictory current source classes rather than enriching over them", () => {
    expect(run([receipt(), receipt({ occurrence: 1, contributorClass: "C" })]).donors).toBeUndefined();
  });
  it("includes January receipts from a prior source-report year, excludes dated historical cash", () => {
    const result = run([receipt({ reportId: "120784", sourceUrl: sourceUrl.replace("123786", "120784"), date: "2025-01-06" }),
      receipt({ occurrence: 1, date: "2024-12-31" })]);
    expect(result.donors?.[0]).toMatchObject({ amount: 1000, contributionCount: 1 });
  });
  it.each([
    { date: "2025-02-29" }, { amountCents: -1000 }, { amountCents: 0 }, { amountCents: 1.5 },
    { contributorName: " " }, { reportId: "0123786" }, { occurrence: -1 },
    { sourceUrl: sourceUrl + "&reportId=123786" }, { sourceUrl: sourceUrl.replace("123786", "128008") },
    { sourceUrl: sourceUrl + "#ledger" }, { sourceUrl: sourceUrl.replace("apps.tn.gov", "example.org") },
  ])("preserves invalid receipt identities or money: %j", overrides => {
    expect(run([receipt(overrides)]).donors).toBeUndefined();
  });
  it("rejects repeated occurrence identities instead of deduplicating money", () => {
    expect(run([receipt(), receipt()]).donors).toBeUndefined();
  });
  it("preserves safe-sum overflow", () => {
    expect(run([receipt({ amountCents: Number.MAX_SAFE_INTEGER }), receipt({ occurrence: 1 })]).donors).toBeUndefined();
  });
  it("preserves cent loss when converting a very large source integer to stored dollars", () => {
    expect(run([receipt({ amountCents: Number.MAX_SAFE_INTEGER })]).donors).toBeUndefined();
  });
});

describe("Tennessee PAC snapshot validation", () => {
  const donor = (overrides: Partial<TennesseeFinancePacDonor> = {}): TennesseeFinancePacDonor => ({
    committeeId: "reported:EXAMPLE EMPLOYEES PAC", committeeName: "Example Employees PAC",
    committeeType: "Political Action Committee", amount: 10.01, contributionCount: 1, sourceUrl, ...overrides,
  });
  it("accepts exact decimal cents and independently proven empty snapshots", () => {
    expect(() => validateTennesseePacDonors([donor()])).not.toThrow();
    expect(() => validateTennesseePacDonors([])).not.toThrow();
  });
  it.each([
    { amount: 10.001 }, { amount: 0 }, { amount: NaN }, { amount: Infinity },
    { contributionCount: 2147483648 }, { contributionCount: 0 }, { contributionCount: 1.5 },
    { committeeId: "reported:OTHER NAME" }, { committeeId: "01" }, { committeeId: "9007199254740992" },
    { sourceUrl: sourceUrl + "&extra=1" }, { sourceUrl: sourceUrl.replace("https://", "http://") },
    { sourceUrl: sourceUrl.replace("https://", "https://user@") },
  ])("rejects invalid storage input before any write: %j", overrides => {
    expect(() => validateTennesseePacDonors([donor(overrides)])).toThrow("Invalid Tennessee typed PAC donor snapshot");
  });
  it("rejects duplicate donor IDs", () => {
    expect(() => validateTennesseePacDonors([donor(), donor()])).toThrow();
  });
});

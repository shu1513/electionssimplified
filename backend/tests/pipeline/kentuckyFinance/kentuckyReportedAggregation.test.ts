import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateKentuckyReported,
  qualifyKentuckyReportedReceiver,
  kyLocation,
} from "../../../src/pipeline/kentuckyFinance/kentuckyReportedAggregation.js";
import {
  fixture,
  receipt,
  ie,
  census,
  receiver,
} from "./kentuckyReportedFixture.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
async function source(
  kind: "ie" | "committee",
  options: Parameters<typeof fixture>[1] = {},
) {
  const f = await fixture(kind, options);
  cleanups.push(f.cleanup);
  return f.source();
}
describe("Kentucky signed receipt and explicit target attribution", () => {
  it.each(["21ST DISTRICT", "21", "District 021"])(
    "normalizes verified district formats %s",
    (v) => expect(kyLocation(v)).toBe("21"),
  );
  it("nets signed corrections, preserves duplicate occurrences, excludes untyped and non-receipt modes", async () => {
    const s = await source("committee", {
      rows: [
        receipt(),
        receipt(),
        receipt({ Amount: "($250.00)" }),
        receipt({ "Contribution Type": "OTHER", Amount: "$99999.00" }),
        receipt({ "Contribution Mode": "TRANSFER" }),
        receipt({ "Contribution Mode": "LOAN" }),
        receipt({ "Contribution Mode": "LOAN_REPAYMENT" }),
        receipt({ "Contribution Type": "INDIVIDUAL" }),
        receipt({ "From Organization Name": "Alice A Example" }),
      ],
    });
    const a = aggregateKentuckyReported(receiver, s);
    expect(a.totalCents).toBe(175000);
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0]!.occurrences).toBe(3);
    expect(a.matchedRows).toBe(9);
    expect(a.includedRows).toBe(3);
    expect(a.excludedRows).toBe(6);
  });
  it("retains full class/name/address identity instead of merging same-name entities", async () => {
    const a = aggregateKentuckyReported(
      receiver,
      await source("committee", {
        rows: [
          receipt(),
          receipt({ "Address 1": "20 SECOND ROAD" }),
          receipt({ "Contribution Type": "OTHER_CANDIDATES" }),
        ],
      }),
    );
    expect(a.groups).toHaveLength(3);
    expect(a.totalCents).toBe(300000);
  });
  it("omits a verified zero net group while closing signed occurrence counts", async () => {
    const a = aggregateKentuckyReported(
      receiver,
      await source("committee", {
        rows: [receipt(), receipt({ Amount: "($1,000.00)" })],
      }),
    );
    expect(a.groups).toEqual([]);
    expect(a.zeroNetRows).toBe(2);
    expect(a.includedRows).toBe(2);
    expect(a.totalCents).toBe(0);
  });
  it("holds a negative net donor group", async () => {
    const s = await source("committee", {
      rows: [receipt({ Amount: "($10.00)" })],
    });
    expect(() => aggregateKentuckyReported(receiver, s)).toThrow(
      "negative_reported_group_net",
    );
  });
  it("requires a verified source packet and unchanged receiving context", async () => {
    const s = await source("committee");
    expect(() => qualifyKentuckyReportedReceiver(receiver, { ...s })).toThrow(
      "receiver_scope",
    );
    expect(() =>
      qualifyKentuckyReportedReceiver(
        { ...receiver, canonicalDistrict: "22" },
        s,
      ),
    ).toThrow("receiver_scope");
    expect(() =>
      qualifyKentuckyReportedReceiver(
        { ...receiver, committeeName: "Someone Else" },
        s,
      ),
    ).toThrow("receiving_link_name_changed");
  });
  it("retains legislative IE when the complete census proves one district", async () => {
    const a = aggregateKentuckyReported(
      receiver,
      await source("ie", {
        rows: [ie(), ie({ "Support / Oppose": "Opposed", Amount: "$700.00" })],
      }),
    );
    expect(a.supportCents).toBe(400000);
    expect(a.opposeCents).toBe(70000);
    expect(a.groups).toHaveLength(2);
  });
  it("holds a namesake district even when the other candidate has no receipts or is closed", async () => {
    const s = await source("ie", {
      censusExtra: [
        census("11/3/2026", {
          Location: "22ND DISTRICT",
          "Is Active": "False",
          "Total Receipts": "$0.00",
        }),
      ],
    });
    expect(() => aggregateKentuckyReported(receiver, s)).toThrow(
      "ie_target_district_ambiguous",
    );
  });
  it("holds an incomplete target label and unknown stance", async () => {
    const shorter = await source("ie", {
      rows: [ie({ "Candidate Name": "Alice Example" })],
    });
    expect(() => aggregateKentuckyReported(receiver, shorter)).toThrow(
      "ie_target_unresolved",
    );
    const unknown = await source("ie", {
      rows: [ie({ "Support / Oppose": "Unknown" })],
    });
    expect(() => aggregateKentuckyReported(receiver, unknown)).toThrow(
      "ie_stance_unresolved",
    );
  });
  it("does not treat candidate absence as a financial zero", async () => {
    const s = await source("ie");
    expect(() =>
      aggregateKentuckyReported(
        { ...receiver, candidateName: "Nobody Else" },
        s,
      ),
    ).toThrow("receiving_census_ambiguous_or_missing");
  });
  it("holds duplicate receiving registrations", async () => {
    const s = await source("committee", { censusExtra: [census()] });
    expect(() => aggregateKentuckyReported(receiver, s)).toThrow(
      "receiving_census_ambiguous_or_missing",
    );
  });
  it("accepts a real empty ledger only after census/count closure", async () => {
    const a = aggregateKentuckyReported(
      receiver,
      await source("ie", { rows: [] }),
    );
    expect(a.totalCents).toBe(0);
    expect(a.groups).toEqual([]);
    expect(a.sourceRows).toBe(0);
  });
});

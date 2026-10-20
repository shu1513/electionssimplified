import { describe, expect, it } from "vitest";
import {
  validateNebraskaStoredClosure,
  buildNebraskaReportedComponent,
  type NebraskaStoredGroup,
} from "../../../src/pipeline/nebraskaFinance/nebraskaReportedStore.js";
import { overlayNebraskaReportedComponent } from "../../../src/pipeline/nebraskaFinance/nebraskaReportedReader.js";
import type { NebraskaStoredComponent } from "../../../src/pipeline/nebraskaFinance/nebraskaReportedStore.js";
const groups: NebraskaStoredGroup[] = Array.from({ length: 8 }, (_, i) => ({
  key: `SYNTHETIC ${i}`,
  reportedName: `Synthetic ${i}`,
  stance: "committee",
  amountCents: 100,
  occurrenceCount: 1,
}));
const controls = {
  totalAmountCents: 800,
  contributionCount: 8,
  sourceReceivingRows: 9,
  excludedRows: 1,
};
describe("Nebraska uncapped stored component closure", () => {
  it("reconciles all groups before any presentation cap", () => {
    expect(() =>
      validateNebraskaStoredClosure("committee", controls, groups),
    ).not.toThrow();
    expect(() =>
      validateNebraskaStoredClosure("committee", controls, groups.slice(0, 5)),
    ).toThrow(/stored_committee_closure/);
  });
  it("rejects corruption in a group below the displayed five", () => {
    expect(() =>
      validateNebraskaStoredClosure(
        "committee",
        controls,
        groups.map((g, i) => (i === 7 ? { ...g, amountCents: 101 } : g)),
      ),
    ).toThrow(/stored_committee_closure/);
  });
  it("rejects duplicate names, missing controls, negative and fractional money", () => {
    expect(() =>
      validateNebraskaStoredClosure("committee", controls, [
        ...groups,
        groups[0]!,
      ]),
    ).toThrow(/duplicate_stored_group/);
    expect(() =>
      validateNebraskaStoredClosure(
        "committee",
        { totalAmountCents: 800 },
        groups,
      ),
    ).toThrow(/stored_controls/);
    for (const amountCents of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        validateNebraskaStoredClosure("committee", controls, [
          { ...groups[0]!, amountCents },
        ]),
      ).toThrow(/stored_group/);
  });
  it("never accepts a health DTO as a verified monetary packet", () => {
    expect(() =>
      buildNebraskaReportedComponent({} as never, {} as never, {} as never),
    ).toThrow(/unverified_source/);
  });
  it("holds a zero IE component when source allocations remain unassigned", () => {
    expect(() =>
      validateNebraskaStoredClosure(
        "ie",
        {
          supportCents: 0,
          opposeCents: 0,
          allocationCount: 0,
          unattributedSourceRows: 1,
        },
        [],
      ),
    ).toThrow(/stored_ie_closure/);
  });
  it("keeps a zero leg unknown while publishing reported positive allocations", () => {
    const v = {
      receiver: { electionYear: 2026, receivingId: "101" },
      facts: { component: "ie" },
      controls: {
        supportCents: 100,
        opposeCents: 0,
        allocationCount: 1,
        unattributedSourceRows: 1,
      },
      groups: [{ ...groups[0]!, stance: "support" }],
      observedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T01:00:00.000Z",
    } as NebraskaStoredComponent;
    const summary = overlayNebraskaReportedComponent(undefined, v);
    expect(summary.outside_spending.support_total).toBe(1);
    expect(summary.outside_spending.oppose_total).toBeNull();
    expect(summary.outside_spending.outside_coverage_note).toContain(
      "1 source rows",
    );
  });
  it("keeps full committee totals and count while capping names and preserving the legacy headline", () => {
    const v = {
      receiver: { electionYear: 2026, receivingId: "101" },
      facts: { component: "committee" },
      controls,
      groups,
      observedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T01:00:00.000Z",
    } as NebraskaStoredComponent;
    const original = overlayNebraskaReportedComponent(undefined, v);
    original.last_synced_at = "2026-09-01T00:00:00.000Z";
    original.direct_campaign.total_raised = 12345;
    const result = overlayNebraskaReportedComponent(original, v),
      interest = result.direct_campaign.pac_money_by_interest![0]!;
    expect(interest.amount).toBe(8);
    expect(interest.pac_count).toBe(8);
    expect(interest.pacs).toHaveLength(5);
    expect(interest.interest_name).toBe("Not yet sorted");
    expect(result.last_synced_at).toBe(original.last_synced_at);
    expect(result.direct_campaign.total_raised).toBe(12345);
    expect(result.direct_campaign.pac_money_coverage_note).toContain(
      "before separately reported",
    );
  });
});

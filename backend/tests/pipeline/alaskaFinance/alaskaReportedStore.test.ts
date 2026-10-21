import { describe, expect, it } from "vitest";
import {
  buildAlaskaReportedComponent,
  validateAlaskaStoredClosure,
  type AlaskaStoredGroup,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedStore.js";
import { overlayAlaskaReportedComponent } from "../../../src/pipeline/alaskaFinance/alaskaReportedReader.js";
import {
  akManifestHash,
  type AlaskaOriginalMeta,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedOriginals.js";
const groups: AlaskaStoredGroup[] = Array.from({ length: 8 }, (_, i) => ({
  key: `SYNTHETIC ${i}`,
  reportedName: `Synthetic ${i}`,
  stance: "committee",
  amountCents: 100,
  occurrenceCount: 2,
}));
const controls = {
  totalAmountCents: 800,
  occurrenceCount: 16,
  sourceRows: 17,
  excludedRows: 1,
  debtRows: 0,
  supportCents: 0,
  opposeCents: 0,
};
describe("Alaska full stored closure", () => {
  it("binds provenance values across JSONB property reordering", () => {
    const observation = {
      url: "https://aws.state.ak.us/ApocReports/",
      method: "GET",
      status: 200,
      eof: true,
      bytes: 5,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    } as AlaskaOriginalMeta;
    const reordered = Object.fromEntries(
      Object.entries(observation).reverse(),
    ) as AlaskaOriginalMeta;
    expect(akManifestHash([observation])).toBe(akManifestHash([reordered]));
    expect(akManifestHash([observation])).not.toBe(
      akManifestHash([{ ...reordered, eof: false }]),
    );
    expect(akManifestHash([observation])).not.toBe(
      akManifestHash([{ ...reordered, bytes: 6 }]),
    );
  });
  it("reconciles every group before applying presentation caps", () => {
    expect(() =>
      validateAlaskaStoredClosure("committee", controls, groups),
    ).not.toThrow();
    expect(() =>
      validateAlaskaStoredClosure("committee", controls, groups.slice(0, 5)),
    ).toThrow(/stored_full_closure/);
    expect(() =>
      validateAlaskaStoredClosure(
        "committee",
        controls,
        groups.map((g, i) => (i === 7 ? { ...g, amountCents: 101 } : g)),
      ),
    ).toThrow(/stored_full_closure/);
  });
  it("preserves zero-net groups and occurrences without admitting negative or fractional nets", () => {
    const zero = { ...groups[0]!, amountCents: 0 };
    expect(() =>
      validateAlaskaStoredClosure(
        "committee",
        {
          ...controls,
          totalAmountCents: 0,
          occurrenceCount: 2,
          sourceRows: 2,
          excludedRows: 0,
        },
        [zero],
      ),
    ).not.toThrow();
    for (const amountCents of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        validateAlaskaStoredClosure("committee", controls, [
          { ...zero, amountCents },
        ]),
      ).toThrow(/stored_group/);
  });
  it("keeps debt obligations outside paid IE and rejects duplicate groups", () => {
    const paid = [{ ...groups[0]!, stance: "support" as const }];
    const c = {
      totalAmountCents: 100,
      occurrenceCount: 2,
      sourceRows: 5,
      excludedRows: 0,
      debtRows: 3,
      supportCents: 100,
      opposeCents: 0,
    };
    expect(() => validateAlaskaStoredClosure("ie", c, paid)).not.toThrow();
    expect(() =>
      validateAlaskaStoredClosure("ie", { ...c, supportCents: 400 }, paid),
    ).toThrow(/stored_full_closure/);
    expect(() =>
      validateAlaskaStoredClosure("committee", controls, [
        ...groups,
        groups[0]!,
      ]),
    ).toThrow(/duplicate_stored_group/);
  });
  it("rejects forged success DTOs before monetary aggregation", () => {
    expect(() =>
      buildAlaskaReportedComponent({} as never, {} as never),
    ).toThrow(/unverified_source/);
  });
  it("shows full totals/counts with only five names and clears incompatible outside industries", () => {
    const value = {
      receiver: { electionYear: 2026, receivingId: "synthetic" },
      groups,
      controls,
      facts: { component: "committee" },
      observedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z",
    };
    const summary = overlayAlaskaReportedComponent(undefined, value as never);
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({
      amount: 8,
      pac_count: 8,
    });
    expect(
      summary.direct_campaign.pac_money_by_interest?.[0]?.pacs,
    ).toHaveLength(5);
    const outside = overlayAlaskaReportedComponent(summary, {
      ...value,
      facts: { component: "ie" },
      groups: [{ ...groups[0], stance: "support" }],
      controls: { ...controls, supportCents: 100 },
    } as never);
    expect(outside.outside_spending.support_total).toBe(1);
    expect(outside.outside_spending.top_supporting_groups[0]?.source_url).toBe(
      "https://aws.state.ak.us/ApocReports/IndependentExpenditures/IEExpenditures.aspx",
    );
    expect(
      summary.direct_campaign.pac_money_by_interest?.[0]?.pacs.every(
        (g) =>
          g.source_url ===
          "https://aws.state.ak.us/ApocReports/CampaignDisclosure/CDForms.aspx",
      ),
    ).toBe(true);
    expect(outside.backing_summary.top_outside_supporting_industries).toEqual(
      [],
    );
  });
});

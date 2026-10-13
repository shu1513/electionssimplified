import { describe, expect, it } from "vitest";
import {
  aggregateNevadaObservedPacDonors,
  nevadaReportedCommitteeNameKey,
  NEVADA_PUBLIC_FINANCE_SEARCH_URL,
  type NevadaObservedCashOccurrence,
  type NevadaObservedGroupNameQuery,
} from "../../../src/pipeline/nevadaFinance/nevadaPacDonorAggregator.js";

function cash(
  name = "Example PAC",
  amountCents = 10000,
  overrides: Partial<NevadaObservedCashOccurrence> = {},
): NevadaObservedCashOccurrence {
  return {
    contributorName: name,
    amountCents,
    date: "2026-03-01",
    loanCellBlank: true,
    loanCheckboxChecked: null,
    ...overrides,
  };
}
function query(
  rows: NevadaObservedGroupNameQuery["rows"],
  overrides: Partial<NevadaObservedGroupNameQuery> = {},
): NevadaObservedGroupNameQuery {
  return {
    nameQuery: "Example",
    groupTypeBlank: true,
    resultCount: rows.length,
    rows,
    ...overrides,
  };
}
function aggregate(
  rows: readonly NevadaObservedCashOccurrence[],
  queries: readonly NevadaObservedGroupNameQuery[] = [],
) {
  return aggregateNevadaObservedPacDonors({
    cashRows: rows,
    groupQueries: queries,
  });
}

describe("Nevada observed committee donor positions", () => {
  it("retains equal gift occurrences and nets signed returns without economic deduplication", () => {
    const gift = cash("Example PAC", 250000);
    const result = aggregate([gift, { ...gift }, cash("Example PAC", -75000)]);
    expect(result).toEqual([
      {
        committeeId: "reported:EXAMPLE PAC",
        committeeName: "Example PAC",
        totalAmount: 4250,
        contributionCount: 2,
        recognitionMethod: "reported_name",
        sourceUrl: NEVADA_PUBLIC_FINANCE_SEARCH_URL,
      },
    ]);
  });
  it("retains fully returned and negative positions while counting only positive gifts", () => {
    const result = aggregate([
      cash("Zero PAC", 10000),
      cash("Zero PAC", -10000),
      cash("Negative PAC", 1000),
      cash("Negative PAC", -2000),
    ]);
    expect(
      result.map((d) => [d.committeeName, d.totalAmount, d.contributionCount]),
    ).toEqual([
      ["Zero PAC", 0, 1],
      ["Negative PAC", -10, 1],
    ]);
  });
  it("does not erase a return-only or zero source occurrence", () => {
    expect(aggregate([cash("Example PAC", -1000)])[0]).toMatchObject({
      totalAmount: -10,
      contributionCount: 0,
    });
    expect(aggregate([cash("Example PAC", 0)])[0]).toMatchObject({
      totalAmount: 0,
      contributionCount: 0,
    });
  });
  it("uses full reported name keys with punctuation and every word retained", () => {
    const result = aggregate([
      cash("  Workers'  P.A.C.  "),
      cash("Workers PAC"),
      cash("Workers-Action PAC"),
    ]);
    expect(result.map((d) => d.committeeId).sort()).toEqual(
      [
        "reported:WORKERS PAC",
        "reported:WORKERS' P.A.C.",
        "reported:WORKERS-ACTION PAC",
      ].sort(),
    );
    expect(
      result.find((d) => d.committeeId === "reported:WORKERS' P.A.C.")
        ?.committeeName,
    ).toBe("Workers' P.A.C.");
    expect(nevadaReportedCommitteeNameKey(" Full  NAME, P.A.C. ")).toBe(
      "FULL NAME, P.A.C.",
    );
  });
  it.each([
    "Example PAC",
    "Example P.A.C.",
    "Example P. A. C.",
    "Example political action committee",
  ])(
    "recognizes explicit reported name %s without claiming a legal ID",
    (name) => {
      const result = aggregate([cash(name)]);
      expect(result).toHaveLength(1);
      expect(result[0]?.recognitionMethod).toBe("reported_name");
      expect(result[0]?.committeeId).toBe(
        "reported:" + nevadaReportedCommitteeNameKey(name),
      );
    },
  );
  it.each([
    "Jane Pac",
    "Jane pac",
    "Example P.a.c.",
    "Keystone Corporation",
    "Example Association",
    "Example Labor Union",
    "Example League",
    "Example Committee",
    "Example Caucus",
    "Nevada HealthPAC",
    "NADEAC",
    "Example PACIFIC",
    "Example PACs",
  ])("does not promote personal/generic/acronym label %s", (name) => {
    expect(aggregate([cash(name)])).toEqual([]);
  });
  it("does not expand a reported alias to a different legal registry name", () => {
    expect(
      aggregate(
        [cash("Nevada HealthPAC")],
        [
          query(
            [
              {
                name: "Nevada Hospital Association HealthPAC",
                type: "Political Action Committee",
              },
            ],
            { nameQuery: "HealthPAC" },
          ),
        ],
      ),
    ).toEqual([]);
    expect(
      aggregate(
        [cash("Keystone Corp.")],
        [
          query(
            [
              {
                name: "Keystone Corporation",
                type: "Political Action Committee",
              },
            ],
            { nameQuery: "Keystone" },
          ),
        ],
      ),
    ).toEqual([]);
  });
  it("uses an exact all-class registry name match while keeping the reported namespace", () => {
    const result = aggregate(
      [cash("Keystone Corporation", 250000)],
      [
        query(
          [
            { name: "Keystone Corp.", type: "Nonprofit" },
            {
              name: "Keystone Corporation",
              type: "Political Action Committee",
            },
          ],
          { nameQuery: "Keystone" },
        ),
      ],
    );
    expect(result).toEqual([
      {
        committeeId: "reported:KEYSTONE CORPORATION",
        committeeName: "Keystone Corporation",
        totalAmount: 2500,
        contributionCount: 1,
        recognitionMethod: "registry_name",
        sourceUrl: NEVADA_PUBLIC_FINANCE_SEARCH_URL,
      },
    ]);
  });
  it("matches exact full names case/space only and keeps duplicate same-class observations as name evidence", () => {
    const result = aggregate(
      [cash("Example Group")],
      [
        query([
          { name: "EXAMPLE   GROUP", type: "PAC" },
          { name: "Example Group", type: "Political Action Committee" },
        ]),
      ],
    );
    expect(result[0]).toMatchObject({
      committeeId: "reported:EXAMPLE GROUP",
      recognitionMethod: "registry_name",
      contributionCount: 1,
      totalAmount: 100,
    });
  });
  it("does not take PAC rows returned by an unrelated name query as matching authority", () => {
    expect(
      aggregate(
        [cash("Example Group")],
        [
          query([{ name: "Example Group", type: "PAC" }], {
            nameQuery: "Unrelated",
          }),
        ],
      ),
    ).toEqual([]);
  });
  it("an exact non-PAC registry class defeats a PAC-looking label", () => {
    expect(
      aggregate(
        [cash("Example PAC")],
        [query([{ name: "Example PAC", type: "Nonprofit" }])],
      ),
    ).toEqual([]);
  });
  it("rejects cross-class name ambiguity instead of choosing a PAC row", () => {
    expect(() =>
      aggregate(
        [cash("Example Group")],
        [
          query([
            { name: "Example Group", type: "Political Action Committee" },
            { name: "Example Group", type: "Nonprofit" },
          ]),
        ],
      ),
    ).toThrow("conflicting group classes");
  });
  it.each([
    { resultCount: 2 },
    { resultCount: -1 },
    { resultCount: 1.5 },
    { nameQuery: "" },
    { groupTypeBlank: false as true },
  ])("rejects incomplete/restrictive registry packet %j", (overrides) => {
    expect(() =>
      aggregate(
        [cash()],
        [query([{ name: "Example PAC", type: "PAC" }], overrides)],
      ),
    ).toThrow("incomplete");
  });
  it("excludes explicitly checked loans before donor grouping", () => {
    const result = aggregate([
      cash("Example PAC", 10000),
      cash("Example PAC", 90000, {
        loanCellBlank: false,
        loanCheckboxChecked: true,
      }),
    ]);
    expect(result[0]).toMatchObject({ totalAmount: 100, contributionCount: 1 });
  });
  it.each([{ loanCellBlank: false }, { loanCheckboxChecked: false }])(
    "rejects unreviewed loan-column evidence %j",
    (overrides) => {
      expect(() => aggregate([cash("Example PAC", 10000, overrides)])).toThrow(
        "unreviewed loan",
      );
    },
  );
  it.each([NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid cash cents %s",
    (amount) => {
      expect(() => aggregate([cash("Example PAC", amount)])).toThrow(
        "invalid name or amount",
      );
    },
  );
  it("rejects an overflowing signed donor position", () => {
    expect(() =>
      aggregate([
        cash("Example PAC", Number.MAX_SAFE_INTEGER),
        cash("Example PAC", 1),
      ]),
    ).toThrow("out of range");
  });
  it("outputs only the public search entrypoint without report/query locators", () => {
    const result = aggregate([cash()]);
    expect(result[0]?.sourceUrl).toBe(NEVADA_PUBLIC_FINANCE_SEARCH_URL);
    expect(result[0]?.sourceUrl).not.toMatch(/[?&](?:o|syn)=|ViewCCEReport/);
  });
});

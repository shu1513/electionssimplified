import { describe, expect, it } from "vitest";
import { parseSanFranciscoContestManifest } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoDashboardManifestClient.js";
import { aggregateSanFranciscoHeadlineTotals } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoHeadlineTotals.js";
import type {
  SanFranciscoContestManifest,
  SanFranciscoManifestCandidate,
  SanFranciscoManifestOutsideRelation,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoDashboardManifestClient.js";

const wong: SanFranciscoManifestCandidate = {
  filerNid: "n-wong",
  fppcId: "1481230",
  committeeName: "Alan Wong for Supervisor 2026",
  candidateName: "ALAN WONG",
  fundsCents: 41_237_100,
  expensesCents: 41_072_779,
};

const lee: SanFranciscoManifestCandidate = {
  filerNid: "n-lee",
  fppcId: "1482000",
  committeeName: "David Lee for Supervisor 2026",
  candidateName: "DAVID LEE",
  fundsCents: 10_000_000,
  expensesCents: 9_000_000,
};

function manifest(
  outsideRelations: SanFranciscoManifestOutsideRelation[],
): SanFranciscoContestManifest {
  return {
    electionDate: "2026-06-02",
    contestCode: "bos04",
    title: "Member, Board of Supervisors, District 4",
    candidates: [wong, lee],
    outsideRelations,
    sourceUrl: "https://example.test/bos04.md",
    schemaFingerprint: "top:|candidate:|ie_candidate:|ie_committee:",
  };
}

describe("aggregateSanFranciscoHeadlineTotals", () => {
  it("passes the manifest funds/expenses through and sums relations by direction", () => {
    const result = aggregateSanFranciscoHeadlineTotals({
      manifest: manifest([
        {
          candidateName: "ALAN WONG",
          candidateFppcId: "1481230",
          position: "support",
          spenderFppcId: "1490001",
          spenderName: "GROWSF",
          amountCents: 70_000_000,
        },
        {
          candidateName: "ALAN WONG",
          candidateFppcId: "1481230",
          position: "oppose",
          spenderFppcId: "1490002",
          spenderName: "NEIGHBORS PAC",
          amountCents: 2_475_392,
        },
        // Same spender opposing the OTHER candidate — must not leak in.
        {
          candidateName: "DAVID LEE",
          candidateFppcId: "1482000",
          position: "oppose",
          spenderFppcId: "1490001",
          spenderName: "GROWSF",
          amountCents: 1_000_000,
        },
      ]),
      candidate: wong,
    });
    expect(result.totalRaisedCents).toBe(41_237_100);
    expect(result.totalSpentCents).toBe(41_072_779);
    expect(result.outsideSupportCents).toBe(70_000_000);
    expect(result.outsideOpposeCents).toBe(2_475_392);
    expect(result.groups).toEqual([
      {
        spenderId: "1490001",
        spenderName: "GROWSF",
        supportOppose: "support",
        amountCents: 70_000_000,
        sourceUrl: "https://example.test/bos04.md",
      },
      {
        spenderId: "1490002",
        spenderName: "NEIGHBORS PAC",
        supportOppose: "oppose",
        amountCents: 2_475_392,
        sourceUrl: "https://example.test/bos04.md",
      },
    ]);
  });

  it("targets id-less relations by name and derives synthetic spender ids", () => {
    const result = aggregateSanFranciscoHeadlineTotals({
      manifest: manifest([
        {
          candidateName: "Alan Wong",
          candidateFppcId: null,
          position: "support",
          spenderFppcId: null,
          spenderName: "Friends of the Sunset",
          amountCents: 5_000_000,
        },
      ]),
      candidate: wong,
    });
    expect(result.groups).toEqual([
      {
        spenderId: "name:FRIENDS OF THE SUNSET",
        spenderName: "Friends of the Sunset",
        supportOppose: "support",
        amountCents: 5_000_000,
        sourceUrl: "https://example.test/bos04.md",
      },
    ]);
  });

  it("a relation id naming another committee is decisive over an equal name", () => {
    const result = aggregateSanFranciscoHeadlineTotals({
      manifest: manifest([
        {
          candidateName: "ALAN WONG",
          candidateFppcId: "1482000", // David Lee's committee id
          position: "support",
          spenderFppcId: "1490001",
          spenderName: "GROWSF",
          amountCents: 5_000_000,
        },
      ]),
      candidate: wong,
    });
    expect(result.groups).toEqual([]);
    expect(result.outsideSupportCents).toBe(0);
  });

  it("sums duplicate rows for the same spender and direction", () => {
    const result = aggregateSanFranciscoHeadlineTotals({
      manifest: manifest([
        {
          candidateName: "ALAN WONG",
          candidateFppcId: "1481230",
          position: "support",
          spenderFppcId: "1490001",
          spenderName: "GROWSF",
          amountCents: 1_000_000,
        },
        {
          candidateName: "ALAN WONG",
          candidateFppcId: "1481230",
          position: "support",
          spenderFppcId: "1490001",
          spenderName: "GROWSF",
          amountCents: 2_000_000,
        },
      ]),
      candidate: wong,
    });
    expect(result.groups.length).toBe(1);
    expect(result.groups[0]!.amountCents).toBe(3_000_000);
  });
  it("returns zero outside totals for a source-validated explicit empty IE list", () => {
    const parsed = parseSanFranciscoContestManifest({
      markdown: `---
 election: '2026-06-02'
 title: Board of Supervisors D04
 candidates:
 - filer_nid: '215112140'
   filer_id: '1481230'
   committee_name: Alan Wong for Supervisor 2026
   candidate_name: ALAN WONG
   funds: 100
   expenses: 50
 ie_candidates: []
---
`,
      electionDate: "2026-06-02",
      contestCode: "bos04",
      sourceUrl: "https://example.test/bos04.md",
    });
    expect(
      aggregateSanFranciscoHeadlineTotals({
        manifest: parsed,
        candidate: parsed.candidates[0]!,
      }),
    ).toEqual({
      totalRaisedCents: 10_000,
      totalSpentCents: 5_000,
      outsideSupportCents: 0,
      outsideOpposeCents: 0,
      groups: [],
    });
  });

  it.each([undefined, null, {}, [null]])(
    "rejects missing or malformed cached relation scope %s",
    (outsideRelations) => {
      const cached = {
        ...manifest([]),
        outsideRelations,
      } as unknown as SanFranciscoContestManifest;
      expect(() =>
        aggregateSanFranciscoHeadlineTotals({
          manifest: cached,
          candidate: wong,
        }),
      ).toThrow(/outside relation/);
    },
  );

  it.each([
    { position: "assist" },
    { amountCents: Number.NaN },
    { amountCents: 100.5 },
    { amountCents: -100 },
    { candidateFppcId: undefined },
    { spenderName: "" },
  ])(
    "rejects malformed cached rows even for another candidate: %s",
    (invalid) => {
      const relation = {
        candidateName: "DAVID LEE",
        candidateFppcId: "1482000",
        position: "support",
        spenderFppcId: "1490001",
        spenderName: "GROWSF",
        amountCents: 100,
        ...invalid,
      } as unknown as SanFranciscoManifestOutsideRelation;
      expect(() =>
        aggregateSanFranciscoHeadlineTotals({
          manifest: manifest([relation]),
          candidate: wong,
        }),
      ).toThrow(/invalid/);
    },
  );

  it.each([true, false])(
    "rejects overflow across %s same-spender rows",
    (sameSpender) => {
      const relations = ["1490001", sameSpender ? "1490001" : "1490002"].map(
        (spenderFppcId) => ({
          candidateName: "ALAN WONG",
          candidateFppcId: wong.fppcId,
          position: "support" as const,
          spenderFppcId,
          spenderName: "GROWSF",
          amountCents: Number.MAX_SAFE_INTEGER,
        }),
      );
      expect(() =>
        aggregateSanFranciscoHeadlineTotals({
          manifest: manifest(relations),
          candidate: wong,
        }),
      ).toThrow(/invalid money/);
    },
  );
});

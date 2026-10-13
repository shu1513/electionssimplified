import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  replaceNevadaCandidateFinanceSnapshot,
  type NevadaFinanceSnapshotInput,
  type NevadaFinancePacDonorInput,
} from "../../../src/pipeline/nevadaFinance/nevadaFinanceWriter.js";

const CANDIDATE = "11111111-1111-4111-8111-111111111111";
const ELECTION = "22222222-2222-4222-8222-222222222222";
const LINK = "33333333-3333-4333-8333-333333333333";
const SOURCE =
  "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx";
const OBSERVED = "2026-10-12T10:00:00.000Z";
const GUARD = {
  id: LINK,
  election_year: 2026,
  candidate_name_normalized: "Alexis M Hansen",
  office_name: "State Lower Chamber Legislator",
  district: "State House District 32 (2024); Nevada",
  filer_key: "ALEXIS M HANSEN",
  filer_name: "Alexis M Hansen",
  link_source: "aurora_search",
  last_verified_at: null,
  source_url: SOURCE,
  office_scope: "state_lower",
  canonical_office_name: "State Lower Chamber Legislator",
  district_type: "state_lower",
  geoid_compact: "32032",
};

function harness(
  options: { guard?: unknown[]; marker?: unknown[]; failDonor?: boolean } = {},
) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("FOR UPDATE OF link"))
      return { rows: options.guard ?? [GUARD], rowCount: 1 };
    if (sql.includes("FROM public.nv_candidate_finance_pac_sources"))
      return { rows: options.marker ?? [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.nv_candidate_finance_links"))
      return { rows: [{ id: LINK }], rowCount: 1 };
    if (
      sql.includes("INSERT INTO public.nv_candidate_finance_pac_donors") &&
      options.failDonor
    )
      throw new Error("donor insert failed");
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const connect = vi.fn(
    async () => ({ query, release }) as unknown as PoolClient,
  );
  const db = { query, connect } as unknown as Pick<Pool, "query" | "connect">;
  return { db, query, connect, release };
}
function donor(
  changes: Partial<NevadaFinancePacDonorInput> = {},
): NevadaFinancePacDonorInput {
  return {
    committeeId: "reported:A PAC",
    committeeName: "A PAC",
    recognitionMethod: "reported_name",
    totalAmount: 600,
    contributionCount: 1,
    sourceUrl: SOURCE,
    ...changes,
  };
}
function input(
  db: NevadaFinanceSnapshotInput["db"],
  changes: Partial<NevadaFinanceSnapshotInput> = {},
): NevadaFinanceSnapshotInput {
  return {
    db,
    link: {
      candidateId: CANDIDATE,
      electionId: ELECTION,
      electionYear: 2026,
      candidateNameNormalized: GUARD.candidate_name_normalized,
      officeName: GUARD.office_name,
      district: GUARD.district,
      filerName: GUARD.filer_name,
      sourceUrl: SOURCE,
      linkSource: "aurora_search",
    },
    pacDonors: [donor()],
    pacDonorSource: {
      observedAt: new Date(OBSERVED),
      periodStart: "2025-01-01",
      periodEnd: "2026-06-30",
      captureDigest: "a".repeat(64),
    },
    ...changes,
  };
}
function marker(changes: Record<string, unknown> = {}) {
  return {
    observed_at: OBSERVED,
    period_start: "2025-01-01",
    period_end: "2026-06-30",
    capture_digest: "a".repeat(64),
    ...changes,
  };
}

describe("Nevada committee donor writer", () => {
  it("writes donor-only data atomically without updating direct summaries, freshness, breakdowns or outside rows", async () => {
    const h = harness();
    const result = await replaceNevadaCandidateFinanceSnapshot(input(h.db));
    expect(result).toMatchObject({
      summaryWritten: false,
      pacDonorsWritten: 1,
    });
    const sql = h.query.mock.calls.map(([value]) => value).join("\n");
    expect(sql).toContain("roster.status = 'declared'");
    expect(sql).toContain("election.election_stage = 'general'");
    expect(sql).toContain(
      "INSERT INTO public.nv_candidate_finance_pac_sources",
    );
    expect(sql).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM) public.nv_candidate_finance_(?:summaries|direct_breakdowns|outside_groups|outside_group_breakdowns)/,
    );
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("preserves the exact existing non-null link verification stamp during donor-only replacement", async () => {
    const verified = "2026-08-26T12:00:00.000Z";
    const h = harness({ guard: [{ ...GUARD, last_verified_at: verified }] });
    const value = input(h.db);
    value.link.lastVerifiedAt = new Date(verified);
    await expect(
      replaceNevadaCandidateFinanceSnapshot(value),
    ).resolves.toMatchObject({ pacDonorsWritten: 1 });
    const insert = h.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO public.nv_candidate_finance_links"),
    );
    expect(insert?.[1]).toContain(verified);
  });

  it("rejects a concurrent link verification change rather than overwriting it", async () => {
    const h = harness({
      guard: [{ ...GUARD, last_verified_at: "2026-10-12T09:00:00.000Z" }],
    });
    const value = input(h.db);
    value.link.lastVerifiedAt = new Date("2026-08-26T12:00:00.000Z");
    await expect(replaceNevadaCandidateFinanceSnapshot(value)).rejects.toThrow(
      "unchanged",
    );
    expect(
      h.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO")),
    ).toBe(false);
  });

  it("does not erase a non-null verification stamp when the caller supplies null", async () => {
    const h = harness({
      guard: [{ ...GUARD, last_verified_at: "2026-08-26T12:00:00.000Z" }],
    });
    const value = input(h.db);
    value.link.lastVerifiedAt = null;
    await expect(replaceNevadaCandidateFinanceSnapshot(value)).rejects.toThrow(
      "unchanged",
    );
    expect(
      h.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO")),
    ).toBe(false);
  });

  it.each([
    "EXAMPLE PAC",
    "Example P. A. C.",
    "Example political action committee",
  ])(
    "shares the producer's strict reported-name recognition for %s",
    async (name) => {
      const h = harness();
      const key = name
        .normalize("NFKC")
        .toUpperCase()
        .replace(/\s+/g, " ")
        .trim();
      await expect(
        replaceNevadaCandidateFinanceSnapshot(
          input(h.db, {
            pacDonors: [
              donor({
                committeeName: name,
                committeeId: `reported:${key}`,
              }),
            ],
          }),
        ),
      ).resolves.toMatchObject({ pacDonorsWritten: 1 });
    },
  );

  it.each(["John Pac", "HealthPAC"])(
    "does not promote a surname or acronym suffix in %s",
    async (name) => {
      const h = harness();
      await expect(
        replaceNevadaCandidateFinanceSnapshot(
          input(h.db, {
            pacDonors: [
              donor({
                committeeName: name,
                committeeId: `reported:${name.toUpperCase()}`,
              }),
            ],
          }),
        ),
      ).rejects.toThrow("Invalid Nevada committee donor");
      expect(h.connect).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy direct calls usable and preserves unavailable donors without querying their tables", async () => {
    const h = harness();
    await replaceNevadaCandidateFinanceSnapshot(
      input(h.db, {
        pacDonors: undefined,
        pacDonorSource: undefined,
        summary: {
          totalReceipts: 500,
          directContributionTotal: 500,
          totalDisbursements: 20,
          cashOnHand: 480,
          sourceUrl: SOURCE,
        },
      }),
    );
    const sql = h.query.mock.calls.map(([value]) => value).join("\n");
    expect(sql).toContain("INSERT INTO public.nv_candidate_finance_summaries");
    expect(sql).not.toContain("nv_candidate_finance_pac_");
  });

  it("persists a complete empty source watermark and clears only that receiving link/year donor rows", async () => {
    const h = harness();
    await replaceNevadaCandidateFinanceSnapshot(input(h.db, { pacDonors: [] }));
    expect(
      h.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO public.nv_candidate_finance_pac_sources"),
      ),
    ).toBe(true);
    expect(
      h.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO public.nv_candidate_finance_pac_donors"),
      ),
    ).toBe(false);
    const deletion = h.query.mock.calls.find(([sql]) =>
      sql.includes("DELETE FROM public.nv_candidate_finance_pac_donors"),
    );
    expect(deletion?.[1]).toEqual([LINK, 2026, []]);
  });

  it("retains signed and zero positions and exact punctuation in reported identities", async () => {
    const h = harness();
    const punctuation = donor({
      committeeName: "A P.A.C.",
      committeeId: "reported:A P.A.C.",
      totalAmount: -0.29,
      contributionCount: 0,
    });
    const registry = donor({
      committeeName: "Keystone Corporation",
      committeeId: "reported:KEYSTONE CORPORATION",
      recognitionMethod: "registry_name",
      totalAmount: 0,
    });
    await replaceNevadaCandidateFinanceSnapshot(
      input(h.db, { pacDonors: [punctuation, registry] }),
    );
    const inserts = h.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO public.nv_candidate_finance_pac_donors"),
    );
    expect(inserts[0]?.[1]?.slice(2, 7)).toEqual([
      "reported:A P.A.C.",
      "A P.A.C.",
      "reported_name",
      -0.29,
      0,
    ]);
    expect(inserts[1]?.[1]?.[5]).toBe(0);
  });

  it.each([
    ["wrong seat", [{ ...GUARD, geoid_compact: "32031" }]],
    ["changed link source", [{ ...GUARD, link_source: "manual" }]],
    ["changed source URL", [{ ...GUARD, source_url: null }]],
    ["wrong office", [{ ...GUARD, canonical_office_name: "State Senator" }]],
    ["wrong year", [{ ...GUARD, election_year: 2024 }]],
    ["sibling receiving ambiguity", [GUARD, { ...GUARD, id: "other-link" }]],
    ["no eligible canonical roster", []],
  ])(
    "rejects %s before any link or donor replacement",
    async (_reason, guard) => {
      const h = harness({ guard });
      await expect(
        replaceNevadaCandidateFinanceSnapshot(input(h.db)),
      ).rejects.toThrow(/receiving|ownership/);
      expect(
        h.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO")),
      ).toBe(false);
      expect(h.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    },
  );

  it.each([
    ["older observation", marker({ observed_at: "2026-10-13T10:00:00Z" })],
    ["shorter source", marker({ period_end: "2026-09-30" })],
    ["equal-time changed bytes", marker({ capture_digest: "b".repeat(64) })],
  ])(
    "preserves a prior complete empty marker for %s",
    async (_reason, previous) => {
      const h = harness({ marker: [previous] });
      await expect(
        replaceNevadaCandidateFinanceSnapshot(input(h.db, { pacDonors: [] })),
      ).rejects.toThrow("watermark");
      expect(
        h.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO")),
      ).toBe(false);
    },
  );

  it("allows a genuinely newer source with equal or longer coverage", async () => {
    const h = harness({ marker: [marker()] });
    const original = input(h.db);
    await expect(
      replaceNevadaCandidateFinanceSnapshot({
        ...original,
        pacDonorSource: {
          ...original.pacDonorSource!,
          observedAt: new Date("2026-10-13T10:00:00Z"),
          periodEnd: "2026-09-30",
          captureDigest: "b".repeat(64),
        },
      }),
    ).resolves.toMatchObject({ pacDonorsWritten: 1 });
  });

  it("rolls back donor rows and source watermark together on insert failure", async () => {
    const h = harness({ failDonor: true });
    await expect(
      replaceNevadaCandidateFinanceSnapshot(input(h.db)),
    ).rejects.toThrow("donor insert failed");
    expect(
      h.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO public.nv_candidate_finance_pac_sources"),
      ),
    ).toBe(true);
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(h.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });

  it.each([
    { pacDonorSource: undefined },
    { pacDonors: undefined },
    {
      pacDonors: [
        donor({ committeeId: "reported:A P A C", committeeName: "A P.A.C." }),
      ],
    },
    {
      pacDonors: [
        donor({
          committeeId: "reported:HEALTHPAC",
          committeeName: "HealthPAC",
        }),
      ],
    },
    { pacDonors: [donor({ sourceUrl: "https://example.com/" })] },
    { pacDonors: [donor({ sourceUrl: SOURCE + "?opaque=not-allowed" })] },
    { pacDonors: [donor({ totalAmount: 0.001 })] },
    { pacDonors: [donor({ totalAmount: Number.POSITIVE_INFINITY })] },
    { pacDonors: [donor({ contributionCount: -1 })] },
    { pacDonors: [donor(), donor()] },
  ])(
    "rejects malformed or detached donor input before connecting: %j",
    async (change) => {
      const h = harness();
      await expect(
        replaceNevadaCandidateFinanceSnapshot(input(h.db, change)),
      ).rejects.toThrow();
      expect(h.connect).not.toHaveBeenCalled();
    },
  );
});

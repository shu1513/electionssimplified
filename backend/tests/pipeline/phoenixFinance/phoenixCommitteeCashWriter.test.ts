import { describe, expect, it, vi } from "vitest";
import { storePhoenixCommitteeCash } from "../../../src/pipeline/phoenixFinance/phoenixCommitteeCashWriter.js";

function setup(over: Record<string, unknown> = {}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT id::text")) return { rows: [{ id: "link" }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  const input = {
    db: { connect } as never,
    candidateId: "candidate",
    electionId: "election",
    electionYear: 2026,
    copId: "CAN-25-4",
    portalCycleStart: "2025-04-01",
    portalCycleEnd: "2027-03-31",
    observedAt: new Date("2026-10-13T00:00:00Z"),
    captureDigest: "a".repeat(64),
    cash: {
      positions: [
        {
          committeeId: "reported:EXAMPLE PAC",
          committeeName: "Example PAC",
          committeeType: "Political Action Committee" as const,
          grossCents: 200000,
          refundCents: 25000,
          netCents: 175000,
          contributionCount: 2,
          refundCount: 1,
          sourceUrl:
            "https://apps-secure.phoenix.gov/CampaignFinance/Reports/PrintReport/11111111-1111-1111-1111-111111111111",
        },
      ],
      reportPeriods: [
        {
          reportPackageId: "11111111-1111-1111-1111-111111111111",
          periodFrom: "2025-04-01",
          periodTo: "2026-06-30",
        },
      ],
      reportedThrough: "2026-06-30",
    },
    ...over,
  } as Parameters<typeof storePhoenixCommitteeCash>[0];
  return { input, query, release, connect };
}

describe("Phoenix committee cash generations", () => {
  it("retains prior donor generations and publishes the accepted pointer atomically", async () => {
    const { input, query, release } = setup();
    await storePhoenixCommitteeCash(input);
    const sql = query.mock.calls.map(([value]) => String(value));
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.some((value) => value.startsWith("DELETE"))).toBe(false);
    expect(
      sql.some((value) => value.includes("phx_candidate_finance_summaries")),
    ).toBe(false);
    expect(
      sql.some((value) =>
        value.includes("phx_candidate_finance_outside_groups"),
      ),
    ).toBe(false);
    const donor = query.mock.calls.find(([value]) =>
      String(value).startsWith(
        "INSERT INTO public.phx_candidate_finance_pac_donors",
      ),
    );
    expect(donor?.[1]).toContain("1750.00");
    expect(donor?.[1]).toContain(input.captureDigest);
    expect(release).toHaveBeenCalledOnce();
  });

  it("accepts a complete empty generation without deleting earlier evidence", async () => {
    const { input, query } = setup();
    input.cash.positions = [];
    await storePhoenixCommitteeCash(input);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes(
          "INSERT INTO public.phx_candidate_finance_pac_donors",
        ),
      ),
    ).toHaveLength(0);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "INSERT INTO public.phx_candidate_finance_pac_sources",
        ),
      ),
    ).toBe(true);
  });

  it("rolls back when the receiving link changed", async () => {
    const { input, query, release } = setup();
    query.mockImplementation(async () => ({ rows: [] }));
    await expect(storePhoenixCommitteeCash(input)).rejects.toThrow(
      "receiving link changed",
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { observed_at: "2026-10-14T00:00:00Z", report_periods: [] },
      "older than stored evidence",
    ],
    [
      {
        observed_at: "2026-10-12T00:00:00Z",
        report_periods: [{ periodFrom: "2025-04-01", periodTo: "2026-03-31" }],
      },
      "prior reporting period disappeared",
    ],
  ])("preserves a newer or missing prior period", async (source, message) => {
    const { input, query } = setup();
    query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("SELECT id::text")
        ? [{ id: "link" }]
        : sql.startsWith("SELECT observed_at")
          ? [source]
          : [],
    }));
    await expect(storePhoenixCommitteeCash(input)).rejects.toThrow(message);
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT")),
    ).toBe(false);
  });

  it("rejects unsafe or duplicate positions before starting a transaction", async () => {
    const { input, connect } = setup();
    input.cash.positions.push(input.cash.positions[0]!);
    await expect(storePhoenixCommitteeCash(input)).rejects.toThrow(
      "Invalid Phoenix PAC donor position",
    );
    expect(connect).not.toHaveBeenCalled();
  });
});

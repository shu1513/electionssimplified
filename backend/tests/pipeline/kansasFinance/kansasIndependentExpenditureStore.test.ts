import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  replaceKansasIEDocument,
  type KansasIEDocumentInput,
} from "../../../src/pipeline/kansasFinance/kansasIndependentExpenditureStore.js";

const CANDIDATE = "11111111-1111-4111-8111-111111111111";
const ELECTION = "22222222-2222-4222-8222-222222222222";
const SOURCE =
  "https://sos.ks.gov/srvimages/campaignfinance/filings/cy2026/cm09/65555.pdf";
const OBSERVED = "2026-10-12T10:00:00.000Z";
const TARGET = {
  candidate_id: CANDIDATE,
  election_id: ELECTION,
  candidate_name: "Kyler Sweely",
  geoid_compact: "20102",
};

function harness(
  options: {
    prior?: unknown[];
    targets?: unknown[];
    failInsert?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("ORDER BY row_index FOR UPDATE"))
      return { rows: options.prior ?? [] };
    if (sql.includes("FROM public.candidate_elections roster"))
      return { rows: options.targets ?? [TARGET] };
    if (sql.startsWith("INSERT") && options.failInsert)
      throw new Error("insert failed");
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return {
    db: { connect } as unknown as Pick<Pool, "connect">,
    query,
    release,
    connect,
  };
}
function document(
  db: Pick<Pool, "connect">,
  changes: Partial<KansasIEDocumentInput> = {},
): KansasIEDocumentInput {
  return {
    db,
    electionYear: 2026,
    sourceUrl: SOURCE,
    sha256: "a".repeat(64),
    observedAt: OBSERVED,
    payerName: "A Reported Payer",
    filingDate: "2026-09-17",
    periodDueKey: "202610",
    statementTotalCents: 109855,
    rows: [
      {
        rowIndex: 1,
        rowDate: "2026-09-15",
        candidateName: "Kyler Sweely",
        houseDistrict: 102,
        supportOppose: "support",
        amountCents: 109855,
      },
    ],
    ...changes,
  };
}
function prior(changes: Record<string, unknown> = {}) {
  return {
    sha256: "a".repeat(64),
    observed_at: OBSERVED,
    election_year: 2026,
    payer_name: "A Reported Payer",
    filing_date: "2026-09-17",
    period_due_key: "202610",
    statement_total_cents: "109855",
    row_index: 1,
    row_date: "2026-09-15",
    candidate_name: "Kyler Sweely",
    target_as_filed: "Kyler Sweely",
    house_district: 102,
    support_oppose: "support",
    amount_cents: "109855",
    ...changes,
  };
}

describe("replaceKansasIEDocument", () => {
  it("maps a no-filer candidate from exact name and canonical House seat without touching direct finance", async () => {
    const h = harness();
    expect(await replaceKansasIEDocument(document(h.db))).toEqual({
      rowCount: 1,
      mappedRowCount: 1,
      unmappedRowCount: 0,
    });
    const insert = h.query.mock.calls.find(([sql]) => sql.startsWith("INSERT"));
    expect(insert?.[1]).toEqual([
      SOURCE,
      1,
      "a".repeat(64),
      OBSERVED,
      2026,
      "A Reported Payer",
      "2026-09-17",
      "202610",
      109855,
      "2026-09-15",
      "Kyler Sweely",
      102,
      "support",
      109855,
      CANDIDATE,
      ELECTION,
      "Kyler Sweely",
    ]);
    const sql = h.query.mock.calls.map(([value]) => value).join("\n");
    expect(sql).toContain("election.election_stage = 'general'");
    expect(sql).not.toMatch(
      /ks_candidate_finance_links|ks_candidate_finance_summaries/,
    );
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["wrong seat", [{ ...TARGET, geoid_compact: "20072" }]],
    [
      "different middle name",
      [{ ...TARGET, candidate_name: "Kyler James Sweely" }],
    ],
    [
      "same full-name ambiguity",
      [
        TARGET,
        { ...TARGET, candidate_id: "33333333-3333-4333-8333-333333333333" },
      ],
    ],
    ["noncanonical state seat", [{ ...TARGET, geoid_compact: "19102" }]],
  ])("retains the literal row unmapped for %s", async (_reason, targets) => {
    const h = harness({ targets });
    expect(await replaceKansasIEDocument(document(h.db))).toMatchObject({
      mappedRowCount: 0,
      unmappedRowCount: 1,
    });
    const insert = h.query.mock.calls.find(([sql]) => sql.startsWith("INSERT"));
    expect(insert?.[1]?.slice(14, 16)).toEqual([null, null]);
  });

  it("preserves a shared printed target and distinct equal financial rows", async () => {
    const h = harness();
    const shared = {
      rowIndex: 2,
      rowDate: "2026-09-15",
      candidateName: null,
      targetAsFiled: "Two targets / no allocation",
      houseDistrict: null,
      supportOppose: null,
      amountCents: 109855,
    } as const;
    const input = document(h.db);
    expect(
      await replaceKansasIEDocument({
        ...input,
        rows: [...input.rows, shared],
      }),
    ).toMatchObject({ rowCount: 2, mappedRowCount: 1 });
    const inserts = h.query.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[1]?.[1]?.[16]).toBe(shared.targetAsFiled);
  });

  it("rejects an older capture before any document deletion", async () => {
    const h = harness({
      prior: [prior({ observed_at: "2026-10-13T10:00:00Z" })],
    });
    await expect(replaceKansasIEDocument(document(h.db))).rejects.toThrow(
      "older",
    );
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
      false,
    );
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rejects conflicting facts for unchanged bytes, while equal evidence can remap exact roster authority", async () => {
    const h = harness({ prior: [prior()] });
    await expect(
      replaceKansasIEDocument(document(h.db, { payerName: "Different Payer" })),
    ).rejects.toThrow("conflicts");
    const same = harness({ prior: [prior()] });
    await expect(
      replaceKansasIEDocument(document(same.db)),
    ).resolves.toMatchObject({ mappedRowCount: 1 });
  });

  it("rejects a different hash at the same observation and permits a genuinely newer replacement", async () => {
    const h = harness({ prior: [prior()] });
    await expect(
      replaceKansasIEDocument(document(h.db, { sha256: "b".repeat(64) })),
    ).rejects.toThrow("conflicts");
    const newer = harness({ prior: [prior()] });
    await expect(
      replaceKansasIEDocument(
        document(newer.db, {
          sha256: "b".repeat(64),
          observedAt: "2026-10-13T10:00:00Z",
        }),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("rolls back document replacement when a row fails, releasing the same connection", async () => {
    const h = harness({ failInsert: true });
    await expect(replaceKansasIEDocument(document(h.db))).rejects.toThrow(
      "insert failed",
    );
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
      true,
    );
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(h.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([
    { sourceUrl: "https://example.com/65555.pdf" },
    { rows: [] },
    { filingDate: "2026-02-30" },
    { statementTotalCents: 1.5 },
    { electionYear: 2023 },
  ])("rejects malformed evidence before connecting: %j", async (change) => {
    const h = harness();
    await expect(
      replaceKansasIEDocument(document(h.db, change)),
    ).rejects.toThrow("Invalid");
    expect(h.connect).not.toHaveBeenCalled();
  });
});

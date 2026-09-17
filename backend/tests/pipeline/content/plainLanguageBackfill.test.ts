import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import {
  loadPlainLanguageBackfillTargets,
  mechanicalCheckFailure,
  runPlainLanguageBackfill,
  type PlainLanguageBackfillDeps,
} from "../../../src/pipeline/content/plainLanguageBackfill.js";

describe("mechanicalCheckFailure", () => {
  const original =
    "Announced he would not enforce the county COVID-19 vaccine mandate on department employees, out of step with county policy.";

  it("passes a faithful rewrite", () => {
    expect(
      mechanicalCheckFailure(
        "record_description",
        original,
        "Said he would not make department workers follow the county COVID-19 vaccine rule, which went against county policy."
      )
    ).toBeNull();
  });

  it("rejects an empty rewrite", () => {
    expect(mechanicalCheckFailure("record_description", original, "  ")).toContain("empty");
  });

  it("rejects a rewrite that is too short for its kind", () => {
    expect(mechanicalCheckFailure("record_description", original, "He said no.")).toContain("too short");
  });

  it("allows candidate summaries to shrink further than other kinds", () => {
    const summary =
      "Jane Doe served as county treasurer for a decade. She led the June primary with 42.04% and faces John Roe in the November runoff for Sheriff of Los Angeles County in the November 3, 2026 election.";
    const stripped = "Jane Doe served as county treasurer for ten years.";
    expect(mechanicalCheckFailure("candidate_summary", summary, stripped)).toBeNull();
    expect(mechanicalCheckFailure("record_description", summary, stripped)).toContain("too short");
  });

  it("rejects a rewrite that balloons past the upper bound", () => {
    expect(mechanicalCheckFailure("record_description", "Short claim.", "x".repeat(200))).toContain("too long");
  });

  it("rejects a rewrite over the absolute cap even when the relative bounds pass", () => {
    const longOriginal = `The measure ${"details ".repeat(75)}ends.`; // ~620 chars
    const stillLongRewrite = `Plainly, ${"words ".repeat(85)}done.`; // ~520 chars, ~84% of original
    // measure_summary carries the generation-time cap (300)...
    expect(mechanicalCheckFailure("measure_summary", longOriginal, stillLongRewrite)).toContain(
      "absolute max 300 for measure_summary"
    );
    // ...record_description has none, so the same lengths pass.
    expect(mechanicalCheckFailure("record_description", longOriginal, stillLongRewrite)).toBeNull();
  });

  it("allowSourcedFacts relaxes only the same-facts checks (numbers, upper length)", () => {
    const stub = "Sponsored HB 231 (2021 RS), enacted as Acts Ch. 155.";
    const repaired =
      "Sponsored the law creating a single accounting system for all state Treasury funds, replacing the separate ledgers each agency kept on its own. The House and Senate overrode the governor's veto to pass it, and it took effect that year (HB 231, 2021 Acts Chapter 155).";
    // Adds no new number tokens beyond the original's, but ~5x the original length.
    expect(mechanicalCheckFailure("record_description", stub, repaired)).toContain("too long");
    expect(
      mechanicalCheckFailure("record_description", stub, repaired, { allowSourcedFacts: true })
    ).toBeNull();

    const withTally = "Voted yes on the budget bill. It passed the House 84-41 (Senate Bill 4).";
    expect(mechanicalCheckFailure("record_description", "Voted yes on the budget bill and Senate Bill 4.", withTally)).toContain(
      "introduced a number"
    );
    expect(
      mechanicalCheckFailure("record_description", "Voted yes on the budget bill and Senate Bill 4.", withTally, {
        allowSourcedFacts: true,
      })
    ).toBeNull();

    // Content-LOSS and URL checks stay armed in the relaxed mode.
    expect(mechanicalCheckFailure("record_description", stub, "  ", { allowSourcedFacts: true })).toContain("empty");
    expect(
      mechanicalCheckFailure("record_description", "A long stored description of a completed legislative action here.", "Too little.", {
        allowSourcedFacts: true,
      })
    ).toContain("too short");
    expect(
      mechanicalCheckFailure("record_description", "See the report for details on this.", "Read https://evil.example/x for details.", {
        allowSourcedFacts: true,
      })
    ).toContain("introduced a URL");
  });

  it("rejects an introduced URL but allows kept URLs", () => {
    const withUrl = "See https://example.com/report for details.";
    expect(mechanicalCheckFailure("record_description", withUrl, "Read https://example.com/report for details.")).toBeNull();
    expect(
      mechanicalCheckFailure("record_description", "See the report for details on this.", "Read https://evil.example/x for details.")
    ).toContain("introduced a URL");
  });

  it("licenses ISO-date components and truncation-ellipsis tokens", () => {
    // Live flag: "2024-04-07" rewritten as "April 7, 2024" — the unpadded "7"
    // read as invented against the padded "07".
    expect(
      mechanicalCheckFailure(
        "record_description",
        "Sponsored SB 58, enacted on 2024-04-07, simplifying the petition process for voters challenging rates.",
        "Sponsored SB 58, enacted on April 7, 2024. It simplified the petition process for voters challenging rates."
      )
    ).toBeNull();

    // Live flag: source truncation "Secs. 15-13-104,...." tokenized as
    // "104...", so a clean rewrite's "104" read as invented.
    expect(
      mechanicalCheckFailure(
        "record_description",
        "Amended Secs. 15-13-2, 15-13-3, 15-13-7, 15-13-104,.... of the code, providing for pretrial detention.",
        "It amended Sections 15-13-2, 15-13-3, 15-13-7 and 15-13-104 of the code. It provided for pretrial detention."
      )
    ).toBeNull();

    // A number the original never carried in any form still flags.
    expect(
      mechanicalCheckFailure(
        "record_description",
        "Sponsored SB 58, enacted on 2024-04-07, simplifying the petition process for voters challenging rates.",
        "Sponsored SB 58, enacted on April 7, 2024, cutting 9 requirements for voters challenging rates."
      )
    ).toMatch(/introduced a number/);

    // The ISO license is anchored to the date EXPRESSION, never granted
    // corpus-wide: the day digit reused outside a date phrase is an invented
    // number ("cutting 7 requirements" while the only 7 is in 2024-04-07).
    expect(
      mechanicalCheckFailure(
        "record_description",
        "Sponsored SB 58, enacted on 2024-04-07, simplifying the petition process for voters challenging rates.",
        "Sponsored SB 58, enacted on April 7, 2024, cutting 7 requirements for voters challenging rates."
      )
    ).toMatch(/introduced a number/);

    // A month-day pairing the original's ISO dates never carried is not
    // licensed either — a shifted date must flag, not silently pass.
    expect(
      mechanicalCheckFailure(
        "record_description",
        "Sponsored SB 58, enacted on 2024-04-07, simplifying the petition process for voters challenging rates.",
        "Sponsored SB 58, enacted on April 9, 2024. It simplified the petition process for voters challenging rates."
      )
    ).toMatch(/introduced a number/);

    // Casing does not affect the license — a faithful lowercase date is a
    // date (the sentence-boundary protection lives in the full/abbreviated
    // month branch split, not in casing).
    expect(
      mechanicalCheckFailure(
        "record_description",
        "Enacted on 2024-04-07 by the governor.",
        "the governor signed it on april 7, 2024."
      )
    ).toBeNull();

    // A sentence ENDING on a full month name plus the next sentence's leading
    // number is not a date — the license must not leak across the boundary
    // ("in April. 7 counties opted out" was passing).
    expect(
      mechanicalCheckFailure(
        "record_description",
        "Voted for HB 44, which took effect 2024-04-07 across the state.",
        "Voted for HB 44. It took effect in April. 7 counties opted out of the program."
      )
    ).toMatch(/introduced a number/);
    expect(
      mechanicalCheckFailure(
        "record_description",
        "Voted for HB 44, which took effect 2024-04-07 across the state.",
        "Voted for HB 44. It took effect in April.\n7 counties opted out of the program."
      )
    ).toMatch(/introduced a number/);
  });

  it("rejects an introduced number but allows dropped or reformatted numbers", () => {
    expect(
      mechanicalCheckFailure("record_description", "The bond is $11.25 billion in total funds.", "The bond totals $11.25 billion.")
    ).toBeNull();
    expect(
      mechanicalCheckFailure("record_description", "The bond is $11,250,000,000 in total funding.", "The bond totals $11250000000.")
    ).toBeNull();
    expect(
      mechanicalCheckFailure("candidate_summary", "She led the primary with 42.04% of the vote.", "She led the earlier vote.")
    ).toBeNull();
    expect(
      mechanicalCheckFailure("record_description", "The budget grew under his tenure a lot.", "The budget grew 300% under his tenure.")
    ).toContain("introduced a number");
  });

  it("licenses digits that spell out number words from the original", () => {
    expect(
      mechanicalCheckFailure(
        "record_description",
        "He was the first challenger in over a century to unseat an incumbent county sheriff.",
        "He was the first person in over 100 years to beat the sitting county sheriff in an election."
      )
    ).toBeNull();
    expect(
      mechanicalCheckFailure(
        "record_description",
        "The measure funds a thousand new housing units in the county over the years.",
        "The measure pays for 1000 new housing units in the county over the years."
      )
    ).toBeNull();
    expect(
      mechanicalCheckFailure(
        "record_description",
        "The budget grew sharply during his tenure at the department, records show.",
        "The budget grew 100-fold during his tenure at the department, records show."
      )
    ).toContain("introduced a number"); // no number word in the original licenses "100"
  });

  it("composes number phrases so a licensed word cannot excuse a changed quantity", () => {
    // "two million" licenses 2 and 2000000 — never a bare 1000000.
    expect(
      mechanicalCheckFailure(
        "record_description",
        "The settlement cost the county two million dollars, according to court records.",
        "The settlement cost the county 1,000,000 dollars, according to court records."
      )
    ).toContain("not in the original: 1000000");
    expect(
      mechanicalCheckFailure(
        "record_description",
        "The settlement cost the county two million dollars, according to court records.",
        "The settlement cost the county 2 million dollars, according to court records."
      )
    ).toBeNull();
    expect(
      mechanicalCheckFailure(
        "record_description",
        "The settlement cost the county two million dollars, according to court records.",
        "The settlement cost the county $2,000,000, according to court records."
      )
    ).toBeNull();
    // "half a million" licenses 500000 — never 50.
    expect(
      mechanicalCheckFailure(
        "record_description",
        "The program spent half a million dollars on outreach efforts in the county.",
        "The program spent 50 million dollars on outreach efforts in the county."
      )
    ).toContain("not in the original: 50");
    expect(
      mechanicalCheckFailure(
        "record_description",
        "The program spent half a million dollars on outreach efforts in the county.",
        "The program spent 500,000 dollars on outreach efforts in the county."
      )
    ).toBeNull();
    // Hyphenated compounds compose: "twenty-five" licenses 25 — never a bare 20.
    expect(
      mechanicalCheckFailure(
        "record_description",
        "He spent twenty-five years working in the county Public Defender's Office.",
        "He spent 25 years working in the county Public Defender's Office."
      )
    ).toBeNull();
    expect(
      mechanicalCheckFailure(
        "record_description",
        "He spent twenty-five years working in the county Public Defender's Office.",
        "He spent 20 years working in the county Public Defender's Office."
      )
    ).toContain("not in the original: 20");
    // Multi-scale chains compose: "two hundred thousand" -> 200000.
    expect(
      mechanicalCheckFailure(
        "record_description",
        "The fund distributed two hundred thousand dollars to local housing groups.",
        "The fund distributed 200,000 dollars to local housing groups."
      )
    ).toBeNull();
    // A bare "half" licenses 0.5 only, never 50.
    expect(
      mechanicalCheckFailure(
        "record_description",
        "More than half the commission members disagreed with the sheriff's decision.",
        "More than 50 of the commission members disagreed with the sheriff's decision."
      )
    ).toContain("not in the original: 50");
  });
});

type FakeQuery = { text: string; params: unknown[] | undefined };

function makeFakePool(options: {
  candidateRows?: Array<Record<string, unknown>>;
  measureRows?: Array<Record<string, unknown>>;
  processedMeasureRows?: Array<Record<string, unknown>>;
  recordRows?: Array<Record<string, unknown>>;
  auditCounts?: Array<{ status: string; count: string }>;
  /** rowCount returned for write statements; 0 simulates the staleness guard rejecting. */
  writeRowCount?: number;
}) {
  const writes: FakeQuery[] = [];
  const pool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      if (text.includes("GROUP BY status")) {
        return { rows: options.auditCounts ?? [] };
      }
      if (text.includes("FROM public.candidates c")) {
        return { rows: options.candidateRows ?? [] };
      }
      if (text.includes("FROM public.ballot_measures")) {
        return { rows: options.measureRows ?? [] };
      }
      if (text.includes("WHERE target_table = 'ballot_measures'")) {
        return { rows: options.processedMeasureRows ?? [] };
      }
      if (text.includes("FROM public.candidate_records cr")) {
        return { rows: options.recordRows ?? [] };
      }
      writes.push({ text, params });
      return { rows: [], rowCount: options.writeRowCount ?? 1 };
    }),
  } as unknown as Pool;
  return { pool, writes };
}

function makeDeps(overrides: Partial<PlainLanguageBackfillDeps> = {}): PlainLanguageBackfillDeps {
  return {
    rewrite: vi.fn(async (input) => ({
      ok: true as const,
      provider: "gemini" as const,
      model: "gemini-2.5-flash-lite",
      rewrittenText: `plain: ${input.text}`,
    })),
    verify: vi.fn(async () => ({
      ok: true as const,
      provider: "openai" as const,
      model: "gpt-5.4-mini",
      verdict: "same_facts" as const,
      reason: null,
    })),
    aiConfig: { timeoutMs: 1000 },
    dryRun: false,
    log: () => {},
    ...overrides,
  };
}

const RECORD_TEXT = "Repeatedly rebuffed subpoenas to appear before the county oversight commission during hearings.";

function recordRow(id: string) {
  return { id, description: RECORD_TEXT, source_url: "https://example.com/report", event_date: "2022-12-02" };
}

describe("loadPlainLanguageBackfillTargets filtering", () => {
  function issuedQueries(pool: Pool): string[] {
    return (pool.query as unknown as { mock: { calls: [string, unknown[]?][] } }).mock.calls.map(
      (call) => call[0]
    );
  }

  it("loads every table when no filter is given", async () => {
    const { pool } = makeFakePool({
      candidateRows: [{ id: "c1", summary: "A summary." }],
      recordRows: [recordRow("r1")],
    });

    const targets = await loadPlainLanguageBackfillTargets(pool);

    expect(targets.map((target) => target.targetTable)).toEqual(["candidates", "candidate_records"]);
    expect(issuedQueries(pool).some((text) => text.includes("FROM public.ballot_measures"))).toBe(true);
  });

  it("skips the other tables entirely when onlyTable is candidate_records", async () => {
    const { pool } = makeFakePool({
      candidateRows: [{ id: "c1", summary: "A summary." }],
      recordRows: [recordRow("r1")],
    });

    const targets = await loadPlainLanguageBackfillTargets(pool, { onlyTable: "candidate_records" });

    expect(targets).toHaveLength(1);
    expect(targets[0]?.targetTable).toBe("candidate_records");
    // The point of the flag: --limit slices from the front of the target list,
    // so the candidate-summary query must not run at all.
    const texts = issuedQueries(pool);
    expect(texts.some((text) => text.includes("FROM public.candidates c"))).toBe(false);
    expect(texts.some((text) => text.includes("FROM public.ballot_measures"))).toBe(false);
  });

  it("passes candidateIds to the candidate and record queries and drops ballot measures", async () => {
    const { pool } = makeFakePool({
      candidateRows: [{ id: "c1", summary: "A summary." }],
      recordRows: [recordRow("r1")],
    });
    const ids = ["11111111-1111-1111-1111-111111111111"];

    await loadPlainLanguageBackfillTargets(pool, { candidateIds: ids });

    const calls = (pool.query as unknown as { mock: { calls: [string, unknown[]?][] } }).mock.calls;
    const candidateCall = calls.find((call) => call[0].includes("FROM public.candidates c"));
    const recordCall = calls.find((call) => call[0].includes("FROM public.candidate_records cr"));
    expect(candidateCall?.[1]).toEqual([ids]);
    // The record query also carries the recordIds slot, unused here.
    expect(recordCall?.[1]).toEqual([ids, null]);
    // Ballot measures belong to no candidate, so a candidate-scoped run skips them.
    expect(calls.some((call) => call[0].includes("FROM public.ballot_measures"))).toBe(false);
  });

  it("passes null rather than an array when unfiltered so the query matches every row", async () => {
    const { pool } = makeFakePool({ recordRows: [recordRow("r1")] });

    await loadPlainLanguageBackfillTargets(pool);

    const calls = (pool.query as unknown as { mock: { calls: [string, unknown[]?][] } }).mock.calls;
    const recordCall = calls.find((call) => call[0].includes("FROM public.candidate_records cr"));
    expect(recordCall?.[1]).toEqual([null, null]);
  });

  it("defers originals already over their absolute cap to the re-research sweep", async () => {
    const { pool } = makeFakePool({
      candidateRows: [{ id: "c1", summary: "x".repeat(301) }],
      measureRows: [
        {
          id: "m1",
          summary: "y".repeat(501),
          what_yes_means: "Approves the bond.",
          what_no_means: "z".repeat(251),
        },
      ],
      recordRows: [{ ...recordRow("r1"), description: "w".repeat(600) }],
    });

    const targets = await loadPlainLanguageBackfillTargets(pool);

    // Over-cap candidate summary, measure summary, and no-meaning are all
    // deferred; the within-cap yes-meaning stays, and record descriptions
    // have no cap so length never defers them.
    expect(targets.map((target) => `${target.targetTable}:${target.targetColumn}`)).toEqual([
      "ballot_measures:what_yes_means",
      "candidate_records:description",
    ]);
  });

  it("restricts to recordIds so an operator work list cannot pull in uncovered rows", async () => {
    const { pool } = makeFakePool({ recordRows: [recordRow("r1")] });
    const recordIds = ["22222222-2222-2222-2222-222222222222"];

    await loadPlainLanguageBackfillTargets(pool, { onlyTable: "candidate_records", recordIds });

    const calls = (pool.query as unknown as { mock: { calls: [string, unknown[]?][] } }).mock.calls;
    const recordCall = calls.find((call) => call[0].includes("FROM public.candidate_records cr"));
    expect(recordCall?.[1]).toEqual([null, recordIds]);
  });
});

describe("operator-authored rewrites", () => {
  const manualRewrite = vi.fn(async () => ({
    ok: true as const,
    provider: "manual" as const,
    model: "manual-research",
    rewrittenText: "Refused subpoenas to appear before the county oversight commission during hearings.",
  }));

  it("skips the verifier and records the manual provider", async () => {
    const { pool, writes } = makeFakePool({ recordRows: [recordRow("r1")] });
    const verify = vi.fn();

    const summary = await runPlainLanguageBackfill(
      pool,
      makeDeps({ rewrite: manualRewrite, verify, manualAttestation: true })
    );

    expect(summary.applied).toBe(1);
    // The verifier exists to be independent of the rewriting MODEL; with a
    // human author there is no second model to be independent of.
    expect(verify).not.toHaveBeenCalled();
    const audit = writes.find((write) => write.text.includes("INSERT INTO public.plain_language_rewrites"));
    expect(audit?.params).toContain("manual");
    expect(audit?.params).toContain("manual-research");
  });

  it("refuses manual text when the run did not declare manualAttestation", async () => {
    const { pool } = makeFakePool({ recordRows: [recordRow("r1")] });

    await expect(
      runPlainLanguageBackfill(pool, makeDeps({ rewrite: manualRewrite }))
    ).rejects.toThrow(/without manualAttestation/);
  });

  it("refuses allowSourcedFacts without manualAttestation", async () => {
    const { pool } = makeFakePool({ recordRows: [recordRow("r1")] });

    await expect(
      runPlainLanguageBackfill(pool, makeDeps({ allowSourcedFacts: true }))
    ).rejects.toThrow(/allowSourcedFacts requires manualAttestation/);
  });

  it("applies a sourced-facts operator rewrite that the strict checks would flag", async () => {
    const { pool } = makeFakePool({ recordRows: [recordRow("r1")] });
    const addsATally = vi.fn(async () => ({
      ok: true as const,
      provider: "manual" as const,
      model: "manual-research",
      rewrittenText: "Refused 47 subpoenas to appear before the county oversight commission during hearings.",
    }));

    const strict = await runPlainLanguageBackfill(
      pool,
      makeDeps({ rewrite: addsATally, manualAttestation: true })
    );
    expect(strict.flagged).toBe(1);

    const { pool: pool2 } = makeFakePool({ recordRows: [recordRow("r1")] });
    const relaxed = await runPlainLanguageBackfill(
      pool2,
      makeDeps({ rewrite: addsATally, manualAttestation: true, allowSourcedFacts: true })
    );
    expect(relaxed.applied).toBe(1);
    expect(relaxed.flagged).toBe(0);
  });

  it("still applies every mechanical check to operator text", async () => {
    const { pool } = makeFakePool({ recordRows: [recordRow("r1")] });
    const inventsANumber = vi.fn(async () => ({
      ok: true as const,
      provider: "manual" as const,
      model: "manual-research",
      rewrittenText: "Refused 47 subpoenas to appear before the county oversight commission during hearings.",
    }));

    const summary = await runPlainLanguageBackfill(
      pool,
      makeDeps({ rewrite: inventsANumber, manualAttestation: true })
    );

    expect(summary.applied).toBe(0);
    expect(summary.flagged).toBe(1);
  });
});

describe("runPlainLanguageBackfill", () => {
  it("applies a verified rewrite atomically with staleness guard and recomputed record identity key", async () => {
    const { pool, writes } = makeFakePool({ recordRows: [recordRow("r1")] });
    const deps = makeDeps();

    const summary = await runPlainLanguageBackfill(pool, deps);

    expect(summary).toMatchObject({ processed: 1, applied: 1, flagged: 0, staleSkipped: 0, remaining: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("SET description = $4");
    expect(writes[0].text).toContain("record_identity_key = $8");
    expect(writes[0].text).toContain("WHERE id = $2 AND description IS NOT DISTINCT FROM $5");
    expect(writes[0].text).toContain("RETURNING id");
    expect(writes[0].text).toContain("SELECT $1, $2, $3, 'applied', $5, $4, NULL, $6, $7 FROM updated");
    expect(writes[0].params?.slice(0, 7)).toEqual([
      "candidate_records",
      "r1",
      "description",
      `plain: ${RECORD_TEXT}`,
      RECORD_TEXT,
      "gemini",
      "gemini-2.5-flash-lite",
    ]);
    expect(writes[0].params?.[7]).toMatch(/^v3_[0-9a-f]{32}$/);
  });

  it("audit upserts on both paths never overwrite original_text (first original is kept)", async () => {
    // A repair pass can re-target an already-rewritten row (A -> B -> C); the
    // conflict update must keep A in original_text — EXCLUDED.original_text
    // would be B, and overwriting erases the only stored copy of A.
    const applied = makeFakePool({ recordRows: [recordRow("r1")] });
    await runPlainLanguageBackfill(applied.pool, makeDeps());
    expect(applied.writes[0].text).toContain("ON CONFLICT (target_table, target_id, target_column) DO UPDATE");
    expect(applied.writes[0].text).not.toContain("original_text = EXCLUDED.original_text");

    const flagged = makeFakePool({ recordRows: [recordRow("r1")] });
    await runPlainLanguageBackfill(
      flagged.pool,
      makeDeps({
        verify: vi.fn(async () => ({
          ok: true as const,
          provider: "openai" as const,
          model: "gpt-5.4-mini",
          verdict: "mismatch" as const,
          reason: "dropped the negation",
        })),
      })
    );
    expect(flagged.writes[0].text).toContain("'flagged'");
    expect(flagged.writes[0].text).toContain("ON CONFLICT (target_table, target_id, target_column) DO UPDATE");
    expect(flagged.writes[0].text).not.toContain("original_text = EXCLUDED.original_text");
  });

  it("does not touch record_identity_key for non-record targets", async () => {
    const { pool, writes } = makeFakePool({
      measureRows: [
        {
          id: "m1",
          summary: null,
          what_yes_means: "Approves issuing the housing bonds described in the measure text.",
          what_no_means: "",
        },
      ],
    });

    await runPlainLanguageBackfill(pool, makeDeps());

    expect(writes).toHaveLength(1);
    expect(writes[0].text).not.toContain("record_identity_key");
    expect(writes[0].params).toHaveLength(7);
  });

  it("counts a stale row (text changed mid-run) without writing an audit row", async () => {
    const { pool, writes } = makeFakePool({ recordRows: [recordRow("r1")], writeRowCount: 0 });

    const summary = await runPlainLanguageBackfill(pool, makeDeps());

    expect(summary).toMatchObject({ processed: 1, applied: 0, flagged: 0, staleSkipped: 1 });
    expect(writes).toHaveLength(1); // the guarded statement ran but wrote nothing
  });

  it("passes the rewriter provider to the verifier", async () => {
    const { pool } = makeFakePool({ recordRows: [recordRow("r1")] });
    const deps = makeDeps();

    await runPlainLanguageBackfill(pool, deps);

    expect(deps.verify).toHaveBeenCalledWith(expect.anything(), expect.anything(), "gemini");
  });

  it("halts immediately when prior audit history already exceeds the flag rate", async () => {
    const { pool } = makeFakePool({
      recordRows: [recordRow("r1"), recordRow("r2")],
      auditCounts: [
        { status: "applied", count: "50" },
        { status: "flagged", count: "10" },
      ],
    });

    await expect(runPlainLanguageBackfill(pool, makeDeps())).rejects.toThrow("halting: flag rate");
  });

  it("exempts operator-attested runs from the flag-rate gate", async () => {
    // The gate is a model-quality circuit breaker; an operator run has no
    // model, and the flagged rows it exists to REPAIR sit in the gate's own
    // baseline (updated in place, not deleted) — counting them would halt any
    // repair in a corpus whose historical flag rate exceeds the threshold.
    const { pool } = makeFakePool({
      recordRows: [recordRow("r1"), recordRow("r2")],
      auditCounts: [
        { status: "applied", count: "50" },
        { status: "flagged", count: "10" },
      ],
    });

    const operatorRewrite = vi.fn(async () => ({
      ok: true as const,
      provider: "manual" as const,
      model: "manual-research",
      rewrittenText: "Refused subpoenas to appear before the county oversight commission during hearings.",
    }));
    const summary = await runPlainLanguageBackfill(
      pool,
      makeDeps({ rewrite: operatorRewrite, manualAttestation: true, allowSourcedFacts: true })
    );
    expect(summary).toMatchObject({ processed: 2, applied: 2, flagged: 0 });
  });

  it("flags a verifier mismatch, keeps the column untouched, and records the reason", async () => {
    const { pool, writes } = makeFakePool({ recordRows: [recordRow("r1")] });
    const deps = makeDeps({
      verify: vi.fn(async () => ({
        ok: true as const,
        provider: "openai" as const,
        model: "gpt-5.4-mini",
        verdict: "mismatch" as const,
        reason: "dropped the negation",
      })),
    });

    const summary = await runPlainLanguageBackfill(pool, deps);

    expect(summary).toMatchObject({ processed: 1, applied: 0, flagged: 1 });
    expect(writes).toHaveLength(1);
    // The audit upsert carries its own ON CONFLICT DO UPDATE, so the check is
    // that the flag path never touches the content table.
    expect(writes[0].text).not.toContain("UPDATE public.candidate_records");
    expect(writes[0].text).toContain("'flagged'");
    expect(writes[0].params?.[5]).toBe("verifier mismatch: dropped the negation");
  });

  it("skips the verifier call entirely when the mechanical check fails", async () => {
    const { pool, writes } = makeFakePool({ recordRows: [recordRow("r1")] });
    const verify = vi.fn();
    const deps = makeDeps({
      rewrite: vi.fn(async () => ({
        ok: true as const,
        provider: "gemini" as const,
        model: "gemini-2.5-flash-lite",
        rewrittenText: "Too short.",
      })),
      verify: verify as unknown as PlainLanguageBackfillDeps["verify"],
    });

    const summary = await runPlainLanguageBackfill(pool, deps);

    expect(summary).toMatchObject({ applied: 0, flagged: 1 });
    expect(verify).not.toHaveBeenCalled();
    expect(writes[0].text).toContain("'flagged'");
  });

  it("aborts without an audit row when the rewrite provider call fails, so resume retries", async () => {
    const { pool, writes } = makeFakePool({ recordRows: [recordRow("r1")] });
    const deps = makeDeps({
      rewrite: vi.fn(async () => ({ ok: false as const, reason: "rate limited" })),
    });

    await expect(runPlainLanguageBackfill(pool, deps)).rejects.toThrow("rewrite call failed");
    expect(writes).toHaveLength(0);
  });

  it("writes nothing in dry-run mode but reports the would-be outcome", async () => {
    const { pool, writes } = makeFakePool({ recordRows: [recordRow("r1")] });
    const lines: string[] = [];
    const deps = makeDeps({ dryRun: true, log: (line) => lines.push(line) });

    const summary = await runPlainLanguageBackfill(pool, deps);

    expect(summary).toMatchObject({ processed: 1, applied: 1, dryRun: true });
    expect(writes).toHaveLength(0);
    expect(lines.join("\n")).toContain("would apply");
    expect(lines.join("\n")).toContain("before:");
    expect(lines.join("\n")).toContain("after:");
  });

  it("halts when the flag rate exceeds 5% after the minimum sample", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => recordRow(`r${index}`));
    const { pool } = makeFakePool({ recordRows: rows });
    let calls = 0;
    const deps = makeDeps({
      verify: vi.fn(async () => {
        calls += 1;
        // Every 10th rewrite mismatches: by row 40 that is 4/40 = 10% > 5%.
        return calls % 10 === 0
          ? {
              ok: true as const,
              provider: "openai" as const,
              model: "gpt-5.4-mini",
              verdict: "mismatch" as const,
              reason: "changed a fact",
            }
          : {
              ok: true as const,
              provider: "openai" as const,
              model: "gpt-5.4-mini",
              verdict: "same_facts" as const,
              reason: null,
            };
      }),
    });

    await expect(runPlainLanguageBackfill(pool, deps)).rejects.toThrow("halting: flag rate");
  });

  it("respects --limit and reports the remainder", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => recordRow(`r${index}`));
    const { pool, writes } = makeFakePool({ recordRows: rows });
    const deps = makeDeps({ limit: 2 });

    const summary = await runPlainLanguageBackfill(pool, deps);

    expect(summary).toMatchObject({ processed: 2, applied: 2, remaining: 3 });
    expect(writes).toHaveLength(2);
  });

  it("passes contest context through for candidate summaries and skips processed measure columns", async () => {
    const rewrite = vi.fn(async (input: { text: string }) => ({
      ok: true as const,
      provider: "gemini" as const,
      model: "gemini-2.5-flash-lite",
      rewrittenText: `plain: ${input.text}`,
    }));
    const { pool, writes } = makeFakePool({
      candidateRows: [
        {
          id: "c1",
          summary: "Jane Doe served as county treasurer for a decade before this campaign season began.",
          official_ballot_title: "Sheriff",
          district_name: "Los Angeles County, California",
          election_date: "2026-11-03",
        },
      ],
      measureRows: [
        {
          id: "m1",
          summary: "Authorizes bonds for affordable housing programs statewide.",
          what_yes_means: "Approves issuing the bonds described in the measure.",
          what_no_means: "Rejects the bond authorization described in the measure.",
        },
      ],
      processedMeasureRows: [
        { target_id: "m1", target_column: "summary" },
        { target_id: "m1", target_column: "what_yes_means" },
      ],
    });
    const deps = makeDeps({ rewrite: rewrite as unknown as PlainLanguageBackfillDeps["rewrite"] });

    const summary = await runPlainLanguageBackfill(pool, deps);

    // c1 summary + only the unprocessed measure column (what_no_means).
    expect(summary).toMatchObject({ processed: 2, applied: 2 });
    expect(rewrite).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "candidate_summary",
        contestContext: {
          officialBallotTitle: "Sheriff",
          districtName: "Los Angeles County, California",
          electionDate: "2026-11-03",
        },
      }),
      expect.anything()
    );
    expect(rewrite).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "measure_what_no_means" }),
      expect.anything()
    );
    expect(
      writes.some(
        (write) => write.text.includes("UPDATE public.ballot_measures") && write.text.includes("SET what_no_means = $4")
      )
    ).toBe(true);
  });
});

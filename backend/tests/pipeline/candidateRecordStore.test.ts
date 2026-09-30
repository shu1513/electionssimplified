import { describe, expect, it, vi } from "vitest";

import {
  buildCandidateRecordIdentityKey,
  deleteCandidateRecordsForReplacementRefresh,
  findRepeatExistingRecords,
  findWithinPayloadRecordCollisions,
  findWithinPayloadRepeatRows,
  isRepeatDescription,
  normalizeDescriptionForRepeatDetection,
  scoreCandidateRecordDescriptionSimilarity,
  upsertCandidateRecords,
} from "../../src/pipeline/candidates/candidateRecordStore.js";

describe("buildCandidateRecordIdentityKey", () => {
  it("normalizes casing, punctuation, spacing, and trailing slash", () => {
    const left = buildCandidateRecordIdentityKey({
      description: "  City-Council   Vote  ",
      sourceUrl: "HTTPS://Example.com/path///",
      eventDate: "2026-05-01",
    });

    const right = buildCandidateRecordIdentityKey({
      description: "city council vote",
      sourceUrl: "https://example.com/path",
      eventDate: new Date("2026-05-01T12:00:00.000Z"),
    });

    expect(left).toBe(right);
  });

  it("changes when event date changes", () => {
    const first = buildCandidateRecordIdentityKey({
      description: "City Council Vote",
      sourceUrl: "https://example.com/path",
      eventDate: "2026-05-01",
    });
    const second = buildCandidateRecordIdentityKey({
      description: "City Council Vote",
      sourceUrl: "https://example.com/path",
      eventDate: "2026-05-02",
    });

    expect(first).not.toBe(second);
  });
});

describe("scoreCandidateRecordDescriptionSimilarity", () => {
  it("scores normalized-equivalent descriptions as exact matches", () => {
    expect(
      scoreCandidateRecordDescriptionSimilarity(
        "Candidate sponsored Bill A.",
        " candidate sponsored bill a "
      )
    ).toBe(1);
  });

  it("scores unrelated descriptions below the update threshold", () => {
    expect(
      scoreCandidateRecordDescriptionSimilarity(
        "Candidate sponsored a transit funding bill.",
        "Candidate was listed on the primary ballot."
      )
    ).toBeLessThan(0.86);
  });
});

describe("upsertCandidateRecords", () => {
  it("counts inserted and updated rows from upsert RETURNING marker", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "record-1", inserted: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "record-2", inserted: false }] });
    const client = { query };

    const result = await upsertCandidateRecords(client, [
      {
        candidateId: "cand-1",
        description: "Desc A",
        sourceUrl: "https://example.com/a",
        eventDate: "2026-04-01",
        origin: "ai_enricher",
        originRunId: "run-42",
      },
      {
        candidateId: "cand-1",
        description: "Desc B",
        sourceUrl: "https://example.com/b",
        eventDate: "2026-04-02",
        origin: "repair",
        originRunId: null,
      },
    ]);

    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.processed).toBe(2);
    expect(result.recordIdsByIdentityKey.size).toBe(2);
    expect(result.insertedRecordIds).toEqual(["record-1"]);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[1]?.[0]).toContain("ON CONFLICT (candidate_id, record_identity_key)");
    // Provenance is stamped on insert, but a conflict on the identity key is
    // an identical re-import: origin must NOT rotate to the latest writer,
    // or cleanup-by-run queries lose the introducing run's cohort.
    expect(query.mock.calls[1]?.[0]).not.toContain("origin = EXCLUDED.origin");
    expect(query.mock.calls[1]?.[0]).not.toContain("origin_run_id = EXCLUDED.origin_run_id");
    expect(query.mock.calls[1]?.[1]?.slice(-2)).toEqual(["ai_enricher", "run-42"]);
    expect(query.mock.calls[3]?.[1]?.slice(-2)).toEqual(["repair", null]);
  });

  it("updates a highly similar existing record for the same candidate, source, and date", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "existing-record",
            description: "Candidate sponsored a transit funding bill.",
            record_identity_key: "v3_old",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query };

    const result = await upsertCandidateRecords(client, [
      {
        candidateId: "cand-1",
        description: "Candidate sponsored transit funding bill",
        sourceUrl: "https://example.com/a",
        eventDate: "2026-04-01",
        origin: "manual",
        originRunId: "manual:candidate-records:election-1:cand-1",
      },
    ]);

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.recordIdsByIdentityKey.size).toBe(1);
    expect(result.insertedRecordIds).toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[0]).toContain("UPDATE public.candidate_records");
    // The description actually changed (identity key differs from v3_old), so
    // the similar-record UPDATE re-attributes the row to the current writer:
    // contentUnchanged=false lets the CASE take the new origin params.
    expect(query.mock.calls[1]?.[1]?.slice(-3)).toEqual([
      "manual",
      "manual:candidate-records:election-1:cand-1",
      false,
    ]);
    // A real content change re-keys the row in place, so the writer must
    // ledger the old->new identity transition for promotion to follow.
    expect(query.mock.calls[2]?.[0]).toContain("candidate_record_identity_transitions");
    expect(query.mock.calls[2]?.[1]?.slice(0, 2)).toEqual(["cand-1", "v3_old"]);
    expect(query.mock.calls[2]?.[1]?.[3]).toBe("research_refresh");
  });

  it("preserves existing provenance when a re-import carries identical normalized content", async () => {
    const identityKey = buildCandidateRecordIdentityKey({
      description: "Candidate sponsored a transit funding bill.",
      sourceUrl: "https://example.com/a",
      eventDate: "2026-04-01",
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "existing-record",
            description: "Candidate sponsored a transit funding bill.",
            record_identity_key: identityKey,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query };

    await upsertCandidateRecords(client, [
      {
        candidateId: "cand-1",
        description: "Candidate sponsored a transit funding bill.",
        sourceUrl: "https://example.com/a",
        eventDate: "2026-04-01",
        origin: "ai_enricher",
        originRunId: "rerun-later",
      },
    ]);

    // Identity key unchanged → contentUnchanged=true → the CASE keeps the
    // stored origin/origin_run_id, so a later rerun rediscovering the same
    // record cannot rotate it out of the introducing run's cohort.
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("CASE WHEN $8 THEN origin");
    expect(query.mock.calls[1]?.[1]?.slice(-3)).toEqual(["ai_enricher", "rerun-later", true]);
  });
});

describe("deleteCandidateRecordsForReplacementRefresh", () => {
  it("deletes only ACTIVE candidate records and returns the deleted count", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 4 });

    await expect(
      deleteCandidateRecordsForReplacementRefresh({ query }, " candidate-1 ")
    ).resolves.toEqual({ deletedCount: 4 });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM public.candidate_records"), [
      "candidate-1",
    ]);
    // Retirement tombstones survive the refresh: deleting one would cascade
    // away its notification history and let the next research run recreate
    // the withdrawn claim as active.
    expect(query).toHaveBeenCalledWith(expect.stringContaining("retired_at IS NULL"), ["candidate-1"]);
  });

  it("does not query when candidate ID is blank", async () => {
    const query = vi.fn();

    await expect(deleteCandidateRecordsForReplacementRefresh({ query }, "   ")).resolves.toEqual({
      deletedCount: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("findWithinPayloadRecordCollisions", () => {
  it("flags same-date same-source rows with near-identical descriptions", () => {
    const collisions = findWithinPayloadRecordCollisions([
      {
        description:
          "Voted yes on House Bill 204 to expand the state income tax credit for families",
        sourceUrl: "https://example.gov/session/2025",
        eventDate: "2025-03-26",
      },
      {
        description:
          "Voted yes on House Bill 205 to expand the state income tax credit for families",
        sourceUrl: "https://example.gov/session/2025",
        eventDate: "2025-03-26",
      },
    ]);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      firstIndex: 0,
      secondIndex: 1,
      eventDate: "2025-03-26",
      sourceUrl: "https://example.gov/session/2025",
    });
    expect(collisions[0]!.similarity).toBeGreaterThanOrEqual(0.86);
  });

  it("normalizes source URLs and date forms before grouping", () => {
    const collisions = findWithinPayloadRecordCollisions([
      {
        description: "Voted yes on Senate Bill 402 concurrence with House amendments",
        sourceUrl: "HTTPS://Example.gov/journal/",
        eventDate: new Date("1986-04-24T12:00:00.000Z"),
      },
      {
        description: "Voted yes on Senate Bill 402 concurrence with House changes",
        sourceUrl: "https://example.gov/journal",
        eventDate: "1986-04-24",
      },
    ]);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      eventDate: "1986-04-24",
      sourceUrl: "https://example.gov/journal",
    });
  });

  it("ignores rows that differ in event date or source URL", () => {
    const description = "Voted yes on House Bill 204 to expand the tax credit";
    expect(
      findWithinPayloadRecordCollisions([
        { description, sourceUrl: "https://example.gov/a", eventDate: "2025-03-26" },
        { description, sourceUrl: "https://example.gov/b", eventDate: "2025-03-26" },
        { description, sourceUrl: "https://example.gov/a", eventDate: "2025-03-27" },
      ])
    ).toEqual([]);
  });

  it("ignores same-day same-source rows with clearly distinct descriptions", () => {
    expect(
      findWithinPayloadRecordCollisions([
        {
          description: "Voted yes on the fiscal year 2026 operating budget",
          sourceUrl: "https://example.gov/session/2025",
          eventDate: "2025-03-26",
        },
        {
          description: "Spoke against the proposed surveillance camera contract during public comment",
          sourceUrl: "https://example.gov/session/2025",
          eventDate: "2025-03-26",
        },
      ])
    ).toEqual([]);
  });
});

describe("repeat detection (one row per bill)", () => {
  it("strips bill numbers, dates, years, tallies and stage words", () => {
    expect(
      normalizeDescriptionForRepeatDetection(
        "Filed H.866, a bill enabling cities and towns to extend voting rights in municipal elections to certain noncitizens, on January 16, 2025."
      )
    ).toBe(
      normalizeDescriptionForRepeatDetection(
        "Filed H.707, a bill enabling cities and towns to extend voting rights in municipal elections to certain noncitizens, on January 17, 2019."
      )
    );
    expect(normalizeDescriptionForRepeatDetection("Voted for the fiscal 2019 House budget. It passed 122-23.")).toBe(
      normalizeDescriptionForRepeatDetection("Voted for the fiscal 2020 House budget. It passed 130-20.")
    );
    expect(normalizeDescriptionForRepeatDetection("Voted for House Bill 4432 at second reading.")).toBe(
      normalizeDescriptionForRepeatDetection("Voted for HB 4347 at first reading.")
    );
  });

  it("treats re-filed bills and yearly repeats as repeats", () => {
    const pairs: [string, string][] = [
      [
        "Introduced House Bill 4432 proposing tenant protections and landlord notice rules for rental property. It stayed in committee.",
        "Introduced House Bill 4347 proposing tenant protections and landlord notice rules for rental property. It stayed in committee.",
      ],
      ["Filed H2667, a bill requiring municipalities to place insurance out to bid.", "Filed H2982, a bill requiring municipalities to place insurance out to bid."],
      [
        "Received the endorsement of Planned Parenthood Votes! Rhode Island PAC for her 2022 House District 63 race.",
        "Received the endorsement of Planned Parenthood Votes! Rhode Island PAC for her 2026 House District 63 race.",
      ],
      ["Filed H538, a bill on the safety of schools, residences, and public assemblies.", "Filed H399, a bill on the safety of schools, residences, and public assemblies."],
    ];
    for (const [left, right] of pairs) {
      expect(isRepeatDescription(left, right), left).toBe(true);
    }
  });

  it("keeps adjacent bills and different actions on the same subject distinct", () => {
    const pairs: [string, string][] = [
      ["Voted yes on HB 204, which raised the state gas tax by three cents.", "Voted yes on HB 205, which created a rural broadband grant fund."],
      [
        "Voted against the Secure DC amendment allowing DNA collection and testing before conviction.",
        "Voted for the Secure DC amendment removing the requirement that police officers' names be withheld from the public during adverse-action proceedings.",
      ],
      ["Voted for the fiscal 2019 House budget.", "Voted against the fiscal 2020 House budget."],
      ["Was elected vice chair of the Board of Equalization for 2024.", "Was elected chair of the Board of Equalization for 2025."],
      ["Filed H.1316, a bill on the stabilization of rents in distressed towns.", "Filed H.1440, a bill on the stabilization of rents and evictions in distressed towns."],
      ["Sponsored SB 252 on protection from discrimination based on health-care choices.", "Sponsored SB 253 creating a rural hospital loan program."],
      ["", "Filed H399, a bill on school safety."],
    ];
    for (const [left, right] of pairs) {
      expect(isRepeatDescription(left, right), `${left} | ${right}`).toBe(false);
    }
  });

  it("finds repeats inside a payload but ignores same-slot rows (the update path)", () => {
    const rows = [
      { description: "Filed H.707, a bill enabling noncitizen voting in municipal elections.", sourceUrl: "https://malegislature.gov/Bills/191/H707", eventDate: "2019-01-17" },
      { description: "Voted yes on HB 204, which raised the state gas tax by three cents.", sourceUrl: "https://example.gov/hb204", eventDate: "2021-03-01" },
      { description: "Filed H.866, a bill enabling noncitizen voting in municipal elections.", sourceUrl: "https://malegislature.gov/Bills/194/H866", eventDate: "2025-01-16" },
      { description: "Filed H.866, a bill enabling noncitizen voting in municipal elections", sourceUrl: "https://malegislature.gov/Bills/194/H866/", eventDate: "2025-01-16" },
    ];
    expect(findWithinPayloadRepeatRows(rows)).toEqual([
      { firstIndex: 0, secondIndex: 2 },
      { firstIndex: 0, secondIndex: 3 },
    ]);
  });

  it("finds stored repeats for the candidate, skipping the row's own identity slot", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: "old-1", description: "Filed H.707, a bill enabling noncitizen voting in municipal elections.", source_url: "https://malegislature.gov/Bills/191/H707", event_date: "2019-01-17" },
          { id: "old-2", description: "Voted for the annual budget.", source_url: "https://example.gov/budget-2024", event_date: "2024-06-30" },
        ],
      }),
    };
    const matches = await findRepeatExistingRecords(client, "cand", [
      { description: "Filed H.866, a bill enabling noncitizen voting in municipal elections.", sourceUrl: "https://malegislature.gov/Bills/194/H866", eventDate: "2025-01-16" },
      { description: "Filed H.707, a bill enabling noncitizen voting in municipal elections.", sourceUrl: "https://malegislature.gov/Bills/191/H707/", eventDate: "2019-01-17" },
      { description: "Voted for the annual budget.", sourceUrl: "https://example.gov/budget-2025", eventDate: "2025-06-30" },
      { description: "Spoke at a town hall on housing.", sourceUrl: "https://example.com/news", eventDate: "2025-02-01" },
    ]);
    expect(matches).toEqual([
      { index: 0, existingRecordId: "old-1", existingEventDate: "2019-01-17", existingDescription: "Filed H.707, a bill enabling noncitizen voting in municipal elections." },
      { index: 2, existingRecordId: "old-2", existingEventDate: "2024-06-30", existingDescription: "Voted for the annual budget." },
    ]);
    expect(await findRepeatExistingRecords(client, "cand", [])).toEqual([]);
  });
});

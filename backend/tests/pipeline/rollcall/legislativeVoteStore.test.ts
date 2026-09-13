import { describe, expect, it, vi } from "vitest";

import {
  applyLegislativeVoteDescriptionRewrite,
  applyLegislativeVoteJudgment,
  assertLegislativeVoteStillApproved,
  loadLegislativeVote,
  upsertLegislativeVoteSource,
  type LegislativeVoteSourceRow,
} from "../../../src/pipeline/rollcall/legislativeVoteStore.js";
import { migrationTableColumns } from "../../helpers/migrationTableColumns.js";

const ROW: LegislativeVoteSourceRow = {
  jurisdiction: "US",
  chamber: "house",
  session: "119-1",
  rollNumber: 145,
  voteDate: "2025-05-22",
  measureId: "H R 1",
  exactQuestion: "On Passage",
  isFloorVote: true,
  result: "Passed",
  yeas: 215,
  nays: 214,
  displayUrl: "https://clerk.house.gov/Votes/2025145",
  machineUrl: "https://clerk.house.gov/evs/2025/roll145.xml",
  billUrl: "https://www.congress.gov/bill/119th-congress/house-bill/1",
  sourceSha256: "a".repeat(64),
  fetchedAt: new Date("2026-08-22T12:00:00.000Z"),
  importerVersion: "rollcall-fetch-v1",
};

const EXISTING = {
  id: "row-1",
  review_status: "pending",
  vote_date: "2025-05-22",
  measure_id: "H R 1",
  exact_question: "On Passage",
  is_floor_vote: true,
  result: "Passed",
  yeas: 215,
  nays: 214,
  display_url: ROW.displayUrl,
  machine_url: ROW.machineUrl,
  bill_url: ROW.billUrl,
  source_sha256: ROW.sourceSha256,
};

function fakeDb(existingRows: unknown[]) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: existingRows })
    .mockResolvedValue({ rows: [{ id: "row-new", review_status: "pending" }] });
  return { query };
}

describe("upsertLegislativeVoteSource", () => {
  it("inserts when no row exists", async () => {
    const db = fakeDb([]);
    await expect(upsertLegislativeVoteSource(db, ROW)).resolves.toEqual({
      outcome: "inserted",
      id: "row-new",
      reviewStatus: "pending",
      judgmentCleared: false,
    });
    const [sql, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO legislative_votes/);
    expect(params).toHaveLength(17);
    expect(params[4]).toBe("2025-05-22");
    expect(params[15]).toBe("2026-08-22T12:00:00.000Z");
  });

  it("touches only the bookkeeping columns when nothing changed", async () => {
    const db = fakeDb([EXISTING]);
    await expect(upsertLegislativeVoteSource(db, ROW)).resolves.toEqual({
      outcome: "unchanged",
      id: "row-1",
      reviewStatus: "pending",
      judgmentCleared: false,
    });
    const [sql, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/SET fetched_at = \$2::timestamptz,\s+importer_version = \$3\s+WHERE id = \$1/);
    expect(sql).not.toMatch(/source_sha256/);
    expect(params).toEqual(["row-1", "2026-08-22T12:00:00.000Z", "rollcall-fetch-v1"]);
  });

  it("rewrites the source columns when the feed changed, keeping the judgment", async () => {
    const db = fakeDb([{ ...EXISTING, source_sha256: "b".repeat(64), yeas: 216 }]);
    await expect(upsertLegislativeVoteSource(db, ROW)).resolves.toEqual({
      outcome: "updated",
      id: "row-1",
      reviewStatus: "pending",
      judgmentCleared: false,
    });
    const [sql, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE legislative_votes/);
    expect(sql).toMatch(/source_sha256 = \$12/);
    expect(sql).not.toMatch(/review_status|yea_description|nay_description|labels_json|reviewed_at/);
    expect(params[0]).toBe("row-1");
    expect(params[11]).toBe(ROW.sourceSha256);
  });

  it("clears the judgment and returns to pending when the question or measure changed", async () => {
    for (const existing of [
      { ...EXISTING, review_status: "rejected", exact_question: "On Motion to Recommit" },
      { ...EXISTING, review_status: "pending", measure_id: "H R 2" },
    ]) {
      const db = fakeDb([existing]);
      await expect(upsertLegislativeVoteSource(db, ROW)).resolves.toEqual({
        outcome: "updated",
        id: "row-1",
        reviewStatus: "pending",
        judgmentCleared: true,
      });
      const [sql] = db.query.mock.calls[1] as [string];
      expect(sql).toMatch(/yea_description = NULL,\s+nay_description = NULL,\s+labels_json = NULL/);
      expect(sql).toMatch(/review_status = 'pending',\s+reviewed_at = NULL/);
    }
  });

  it("treats an is_floor_vote flip alone as a change", async () => {
    const db = fakeDb([{ ...EXISTING, is_floor_vote: false }]);
    await expect(upsertLegislativeVoteSource(db, ROW)).resolves.toMatchObject({ outcome: "updated" });
  });

  it("never writes over an approved row whose source differs", async () => {
    const db = fakeDb([{ ...EXISTING, review_status: "approved", source_sha256: "b".repeat(64) }]);
    await expect(upsertLegislativeVoteSource(db, ROW)).resolves.toEqual({
      outcome: "approved_conflict",
      id: "row-1",
      reviewStatus: "approved",
      judgmentCleared: false,
    });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("still advances fetched_at on an approved row whose source is identical", async () => {
    const db = fakeDb([{ ...EXISTING, review_status: "approved" }]);
    await expect(upsertLegislativeVoteSource(db, ROW)).resolves.toMatchObject({ outcome: "unchanged" });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("only names columns the migrations build", async () => {
    const columns = migrationTableColumns("legislative_votes");
    const db = fakeDb([{ ...EXISTING, exact_question: "On Passage, as Amended" }]);
    await upsertLegislativeVoteSource(db, ROW);
    for (const [sql] of db.query.mock.calls as [string][]) {
      for (const match of sql.matchAll(/\b([a-z_]+) = (?:\$\d+|NULL|'pending')/g)) {
        expect(columns.has(match[1]!), match[1]).toBe(true);
      }
      const insertColumns = /INSERT INTO legislative_votes \(([\s\S]*?)\) VALUES/.exec(sql)?.[1];
      for (const column of insertColumns?.split(",").map((name) => name.trim()) ?? []) {
        expect(columns.has(column), column).toBe(true);
      }
    }
  });
});

describe("loadLegislativeVote", () => {
  it("returns the reviewed row the importer needs, or null, naming only migration columns", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "row-1",
          vote_date: "2025-05-22",
          official_vote_date: null,
          measure_id: "H R 1",
          exact_question: "On Passage",
          is_floor_vote: true,
          yeas: 215,
          nays: 214,
          machine_url: ROW.machineUrl,
          source_sha256: "a".repeat(64),
          yea_description: "Voted to pass H.R. 1.",
          nay_description: "Voted against passing H.R. 1.",
          labels_json: [{ slug: "immigration", yea: "for" }],
          review_status: "approved",
        },
      ],
    });
    const key = { jurisdiction: "US", chamber: "house" as const, session: "119-1", rollNumber: 145 };
    const loaded = await loadLegislativeVote({ query }, key);
    expect(query.mock.calls[0]?.[1]).toEqual(["US", "house", "119-1", 145]);
    expect(loaded).toEqual({
      id: "row-1",
      voteDate: "2025-05-22",
      officialVoteDate: null,
      measureId: "H R 1",
      exactQuestion: "On Passage",
      isFloorVote: true,
      yeas: 215,
      nays: 214,
      machineUrl: ROW.machineUrl,
      sourceSha256: "a".repeat(64),
      yeaDescription: "Voted to pass H.R. 1.",
      nayDescription: "Voted against passing H.R. 1.",
      labelsJson: [{ slug: "immigration", yea: "for" }],
      reviewStatus: "approved",
    });
    const columns = migrationTableColumns("legislative_votes");
    const selected = /SELECT ([\s\S]*?)FROM legislative_votes/.exec(query.mock.calls[0]?.[0] as string)?.[1] ?? "";
    const names = [...selected.matchAll(/\b([a-z_]+)(?:::text AS [a-z_]+)?,?\s*$/gm)].map((match) => match[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(columns.has(name), name).toBe(true);
    }

    query.mockResolvedValueOnce({ rows: [] });
    expect(await loadLegislativeVote({ query }, key)).toBeNull();
  });
});

describe("assertLegislativeVoteStillApproved", () => {
  const vote = {
    id: "row-1",
    voteDate: "2025-05-22",
    officialVoteDate: null,
    measureId: "H R 1",
    exactQuestion: "On Passage",
    isFloorVote: true,
    yeas: 215,
    nays: 214,
    machineUrl: ROW.machineUrl,
    sourceSha256: "a".repeat(64),
    yeaDescription: "Voted to pass H.R. 1.",
    nayDescription: "Voted against passing H.R. 1.",
    labelsJson: [{ slug: "immigration", yea: "for" }],
    reviewStatus: "approved" as const,
  };
  const current = {
    review_status: "approved",
    source_sha256: vote.sourceSha256,
    official_vote_date: null,
    yea_description: vote.yeaDescription,
    nay_description: vote.nayDescription,
    labels_json: [{ slug: "immigration", yea: "for" }],
  };

  it("locks the row with FOR SHARE and passes when the approved judgment is unchanged", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [current] });
    await expect(assertLegislativeVoteStillApproved({ query }, vote)).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toMatch(/FOR SHARE/);
    expect(query.mock.calls[0]?.[1]).toEqual(["row-1"]);
  });

  it("fails when approval was withdrawn, the content was re-approved differently, or the row is gone", async () => {
    const pending = vi.fn().mockResolvedValue({ rows: [{ ...current, review_status: "pending" }] });
    await expect(assertLegislativeVoteStillApproved({ query: pending }, vote)).rejects.toThrow(/is pending now/);
    const reworded = vi.fn().mockResolvedValue({ rows: [{ ...current, nay_description: "Voted no." }] });
    await expect(assertLegislativeVoteStillApproved({ query: reworded }, vote)).rejects.toThrow(/different content/);
    const relabeled = vi.fn().mockResolvedValue({ rows: [{ ...current, labels_json: [{ slug: "immigration", yea: "against" }] }] });
    await expect(assertLegislativeVoteStillApproved({ query: relabeled }, vote)).rejects.toThrow(/different content/);
    const refetched = vi.fn().mockResolvedValue({ rows: [{ ...current, source_sha256: "b".repeat(64) }] });
    await expect(assertLegislativeVoteStillApproved({ query: refetched }, vote)).rejects.toThrow(/different content/);
    const redated = vi.fn().mockResolvedValue({ rows: [{ ...current, official_vote_date: "2025-05-23" }] });
    await expect(assertLegislativeVoteStillApproved({ query: redated }, vote)).rejects.toThrow(/different content/);
    const gone = vi.fn().mockResolvedValue({ rows: [] });
    await expect(assertLegislativeVoteStillApproved({ query: gone }, vote)).rejects.toThrow(/no longer exists/);
  });
});

describe("applyLegislativeVoteJudgment", () => {
  const judgment = {
    jurisdiction: "US",
    chamber: "house" as const,
    session: "119-1",
    rollNumber: 145,
    measureId: "H.R. 1",
    voteDate: "2025-05-22",
    officialVoteDate: null,
    yeaDescription: "Voted to pass H.R. 1. It passed the House 215-214.",
    nayDescription: "Voted against passing H.R. 1. It passed the House 215-214.",
    labels: [{ slug: "immigration", yea: "for" as const, nay: null }],
    acknowledgeLaterRolls: [] as number[],
    reviewStatus: "approved" as const,
  };
  const stored = {
    id: "row-1",
    is_floor_vote: true,
    // The Clerk's spelling; the judgment's `H.R. 1` must still match.
    measure_id: "H R 1",
    vote_date: "2025-05-22",
    official_vote_date: null,
    review_status: "pending",
    yeas: 215,
    nays: 214,
    yea_description: null,
    nay_description: null,
    labels_json: null,
  };

  function db(row: Record<string, unknown> | null) {
    // The catch-all answers the approval gates' later-stage SELECT (no
    // later floor votes) and the UPDATEs alike.
    return { query: vi.fn().mockResolvedValueOnce({ rows: row ? [row] : [] }).mockResolvedValue({ rows: [], rowCount: 1 }) };
  }

  it("locks the row, writes the judgment, and stamps reviewed_at only when approving", async () => {
    const approved = db(stored);
    await expect(applyLegislativeVoteJudgment(approved, judgment)).resolves.toBe("updated");
    // select FOR UPDATE, the later-stage gate's select, the write.
    expect(approved.query).toHaveBeenCalledTimes(3);
    expect(approved.query.mock.calls[0]?.[0]).toMatch(/FOR UPDATE/);
    expect(approved.query.mock.calls[0]?.[1]).toEqual(["US", "house", "119-1", 145]);
    expect(approved.query.mock.calls[1]?.[0]).toMatch(/is_floor_vote = true/);
    // An overnight peer raw-dated earlier but officially on/after this
    // vote's date must still be scanned.
    expect(approved.query.mock.calls[1]?.[0]).toMatch(
      /vote_date >= \$4::date OR COALESCE\(official_vote_date, vote_date\) >= \$4::date/
    );
    // A federal bill lives across both calendar sessions of its Congress.
    expect(approved.query.mock.calls[1]?.[1]).toEqual(["US", "house", ["119-1", "119-2"], "2025-05-22", "row-1"]);
    const [sql, params] = approved.query.mock.calls[2]!;
    expect(sql).toMatch(/reviewed_at = CASE WHEN \$6 = 'approved' THEN now\(\) ELSE NULL END/);
    expect(params).toEqual([
      "row-1",
      judgment.yeaDescription,
      judgment.nayDescription,
      JSON.stringify(judgment.labels),
      null,
      "approved",
    ]);

    const pending = db(stored);
    await expect(applyLegislativeVoteJudgment(pending, { ...judgment, reviewStatus: "pending" })).resolves.toBe("updated");
    expect(pending.query).toHaveBeenCalledTimes(2);
    expect(pending.query.mock.calls[1]?.[1]?.[5]).toBe("pending");
  });

  it("writes the official_vote_date override alongside the judgment", async () => {
    const overridden = db(stored);
    await expect(applyLegislativeVoteJudgment(overridden, { ...judgment, officialVoteDate: "2025-05-23" })).resolves.toBe(
      "updated"
    );
    expect(overridden.query.mock.calls[2]?.[0]).toMatch(/official_vote_date = \$5::date/);
    expect(overridden.query.mock.calls[2]?.[1]?.[4]).toBe("2025-05-23");
  });

  it("refuses approval when a description is a bill digest instead of vote + effect + tally", async () => {
    const digest =
      "Voted to pass H.R. 1. It cuts taxes. It raises the debt limit. It changes Medicaid work rules. It passed the House 215-214.";
    await expect(
      applyLegislativeVoteJudgment(db(stored), { ...judgment, yeaDescription: digest })
    ).rejects.toThrow(/yea_description has 5 sentences \(max 3\)/);
    const runOn = `Voted to pass H.R. 1, which ${"cuts taxes and ".repeat(10)}more. It passed the House 215-214.`;
    await expect(
      applyLegislativeVoteJudgment(db(stored), { ...judgment, nayDescription: runOn })
    ).rejects.toThrow(/nay_description has a \d+-word sentence/);
  });

  it("refuses approval when a description does not cite this roll call's tally", async () => {
    await expect(
      applyLegislativeVoteJudgment(db(stored), {
        ...judgment,
        // Written about a different stage: PA HB 103's first-passage prose
        // cited 148-55 while the approved roll call was another vote.
        nayDescription: "Voted against passing H.R. 1. It passed the House 148-55.",
      })
    ).rejects.toThrow(/nay_description does not cite this roll call's tally 215-214/);
    // Substring containment is not citation: a 15-1 roll call is not
    // satisfied by prose whose only match sits inside 215-14.
    await expect(
      applyLegislativeVoteJudgment(db({ ...stored, yeas: 15, nays: 1 }), {
        ...judgment,
        yeaDescription: "Voted to pass H.R. 1. It passed the House 215-14.",
        nayDescription: "Voted against passing H.R. 1. It passed the House 215-14.",
      })
    ).rejects.toThrow(/does not cite this roll call's tally 15-1;/);
    await expect(
      applyLegislativeVoteJudgment(db({ ...stored, yeas: 15, nays: 1 }), {
        ...judgment,
        yeaDescription: "Voted to pass H.R. 1. It passed the House 15-1.",
        nayDescription: "Voted against passing H.R. 1. It passed the House 15-1.",
      })
    ).resolves.toBe("updated");
    // A pending judgment is not gated; the tally check runs on approval only.
    await expect(
      applyLegislativeVoteJudgment(db(stored), {
        ...judgment,
        nayDescription: "Voted against passing H.R. 1. It passed the House 148-55.",
        reviewStatus: "pending",
      })
    ).resolves.toBe("updated");
  });

  it("refuses to approve a stage superseded by a later kept floor vote unless acknowledged", async () => {
    const laterVote = {
      session: "119-1",
      roll_number: 320,
      vote_date: "2025-06-30",
      measure_id: "H R 1",
      exact_question: "On Motion to Concur in the Senate Amendment",
    };
    function dbWithLater() {
      return {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [stored] })
          .mockResolvedValueOnce({ rows: [laterVote] })
          .mockResolvedValue({ rows: [], rowCount: 1 }),
      };
    }
    await expect(applyLegislativeVoteJudgment(dbWithLater(), judgment)).rejects.toThrow(
      /final kept floor vote on H R 1: 119-1 roll 320 on 2025-06-30 \(On Motion to Concur in the Senate Amendment\)/
    );
    // A SAME-DAY peer blocks too: a re-vote after a motion to reconsider
    // lands on the same date, and within a day the sources give no order.
    const sameDay = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [stored] })
        .mockResolvedValueOnce({ rows: [{ ...laterVote, roll_number: 146, vote_date: "2025-05-22" }] })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    await expect(applyLegislativeVoteJudgment(sameDay, judgment)).rejects.toThrow(/119-1 roll 146 on 2025-05-22/);
    // A next-calendar-session peer stays acknowledgeable by number — the
    // error names its session, so the operator knows what the number covers.
    const nextSession = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [stored] })
        .mockResolvedValueOnce({ rows: [{ ...laterVote, session: "119-2", vote_date: "2026-01-15" }] })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    await expect(
      applyLegislativeVoteJudgment(nextSession, { ...judgment, acknowledgeLaterRolls: [320] })
    ).resolves.toBe("updated");
    // A malformed US session would derive scan keys matching nothing and
    // skip the gate silently; it fails loud instead.
    await expect(applyLegislativeVoteJudgment(db(stored), { ...judgment, session: "119" })).rejects.toThrow(
      /US session '119' is not <congress>-<1\|2>/
    );
    // Acknowledging the exact later roll approves the earlier stage on purpose.
    await expect(
      applyLegislativeVoteJudgment(dbWithLater(), { ...judgment, acknowledgeLaterRolls: [320] })
    ).resolves.toBe("updated");
    // A later vote on ANOTHER measure never blocks.
    const otherMeasure = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [stored] })
        .mockResolvedValueOnce({ rows: [{ ...laterVote, measure_id: "H R 2" }] })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    await expect(applyLegislativeVoteJudgment(otherMeasure, judgment)).resolves.toBe("updated");
    // A state entry scans exactly its own session key (the session already
    // spans the whole term; bill numbers repeat across sessions).
    const state = db(stored);
    await expect(
      applyLegislativeVoteJudgment(state, { ...judgment, jurisdiction: "OH", session: "136" })
    ).resolves.toBe("updated");
    expect(state.query.mock.calls[1]?.[1]).toEqual(["OH", "house", ["136"], "2025-05-22", "row-1"]);
  });

  it("is a no-op when the row already holds the same judgment and status", async () => {
    const same = db({
      ...stored,
      review_status: "approved",
      yea_description: judgment.yeaDescription,
      nay_description: judgment.nayDescription,
      // jsonb hands keys back in its own order.
      labels_json: [{ yea: "for", slug: "immigration" }],
    });
    await expect(applyLegislativeVoteJudgment(same, judgment)).resolves.toBe("unchanged");
    expect(same.query).toHaveBeenCalledTimes(1);
  });

  it("moves an approved row back to pending before writing a different judgment", async () => {
    const reworded = db({
      ...stored,
      review_status: "approved",
      yea_description: "Voted yes.",
      nay_description: judgment.nayDescription,
      labels_json: [{ slug: "immigration", yea: "for" }],
    });
    await expect(applyLegislativeVoteJudgment(reworded, judgment)).resolves.toBe("updated");
    // select, the later-stage gate's select, pending-first, the write.
    expect(reworded.query).toHaveBeenCalledTimes(4);
    expect(reworded.query.mock.calls[2]?.[0]).toMatch(/SET review_status = 'pending',\s+reviewed_at = NULL/);
    expect(reworded.query.mock.calls[3]?.[1]?.[5]).toBe("approved");

    // A changed override alone is a judgment change too: same pending-first
    // path, since the freeze trigger covers official_vote_date.
    const redated = db({
      ...stored,
      review_status: "approved",
      yea_description: judgment.yeaDescription,
      nay_description: judgment.nayDescription,
      labels_json: [{ slug: "immigration", yea: "for" }],
    });
    await expect(applyLegislativeVoteJudgment(redated, { ...judgment, officialVoteDate: "2025-05-23" })).resolves.toBe(
      "updated"
    );
    expect(redated.query).toHaveBeenCalledTimes(4);
    expect(redated.query.mock.calls[2]?.[0]).toMatch(/SET review_status = 'pending',\s+reviewed_at = NULL/);
    expect(redated.query.mock.calls[3]?.[1]?.[4]).toBe("2025-05-23");
  });

  it("refuses a judgment written about a different measure or date than the row holds", async () => {
    await expect(applyLegislativeVoteJudgment(db(stored), { ...judgment, measureId: "H.R. 2" })).rejects.toThrow(
      /house 119-1 roll 145 is H R 1 on 2025-05-22, but the judgment says H\.R\. 2 on 2025-05-22/
    );
    await expect(applyLegislativeVoteJudgment(db(stored), { ...judgment, voteDate: "2025-07-03" })).rejects.toThrow(
      /but the judgment says H\.R\. 1 on 2025-07-03/
    );
    await expect(applyLegislativeVoteJudgment(db({ ...stored, measure_id: null }), judgment)).rejects.toThrow(
      /is no measure on 2025-05-22, but the judgment says H\.R\. 1/
    );
    await expect(
      applyLegislativeVoteJudgment(db({ ...stored, measure_id: null, is_floor_vote: false }), {
        ...judgment,
        measureId: null,
        reviewStatus: "pending",
      })
    ).resolves.toBe("updated");
  });

  it("refuses to move an approved row back to pending once records were fanned out", async () => {
    const approved = {
      ...stored,
      review_status: "approved",
      yea_description: judgment.yeaDescription,
      nay_description: judgment.nayDescription,
      labels_json: [{ yea: "for", slug: "immigration" }],
    };
    const fannedOut = {
      query: vi.fn().mockResolvedValueOnce({ rows: [approved] }).mockResolvedValueOnce({ rows: [{ n: "89" }] }),
    };
    await expect(applyLegislativeVoteJudgment(fannedOut, { ...judgment, reviewStatus: "pending" })).rejects.toThrow(
      /already fanned out 89 live candidate records; setting it back to pending would not withdraw them/
    );
    expect(fannedOut.query.mock.calls[1]?.[1]).toEqual(["rollcall:US:house:119-1:145:"]);

    const nothingYet = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [approved] })
        .mockResolvedValueOnce({ rows: [{ n: "0" }] })
        .mockResolvedValue({ rowCount: 1 }),
    };
    await expect(applyLegislativeVoteJudgment(nothingYet, { ...judgment, reviewStatus: "pending" })).resolves.toBe("updated");
    expect(nothingYet.query.mock.calls[2]?.[1]?.[5]).toBe("pending");
  });

  it("refuses a missing row and refuses to approve a non-floor vote", async () => {
    await expect(applyLegislativeVoteJudgment(db(null), judgment)).rejects.toThrow(
      /house 119-1 roll 145 is not in legislative_votes; run rollcall:fetch first/
    );
    await expect(applyLegislativeVoteJudgment(db({ ...stored, is_floor_vote: false }), judgment)).rejects.toThrow(
      /not a kept floor vote \(is_floor_vote = false\); it cannot be approved/
    );
    // Storing a pending judgment on an excluded vote is fine.
    await expect(
      applyLegislativeVoteJudgment(db({ ...stored, is_floor_vote: null }), { ...judgment, reviewStatus: "pending" })
    ).resolves.toBe("updated");
  });
});

describe("applyLegislativeVoteDescriptionRewrite", () => {
  const rewrite = {
    jurisdiction: "DE",
    chamber: "house" as const,
    session: "2163",
    rollNumber: 1529458,
    measureId: "HB 67",
    voteDate: "2025-03-27",
    yeaDescription: "Voted for House Bill 67, which caps tow fees. The Delaware House passed it 23-14.",
    nayDescription: "Voted against House Bill 67, which caps tow fees. The Delaware House passed it 23-14.",
  };
  const stored = {
    id: "row-de",
    measure_id: "HB 67",
    vote_date: "2025-03-27",
    review_status: "approved",
    yeas: 23,
    nays: 14,
    yea_description: "Voted for House Bill 67, long digest. The Delaware House passed it 23-14.",
    nay_description: "Voted against House Bill 67, long digest. The Delaware House passed it 23-14.",
  };
  function db(row: Record<string, unknown> | null) {
    return { query: vi.fn().mockResolvedValueOnce({ rows: row ? [row] : [] }).mockResolvedValue({ rows: [], rowCount: 1 }) };
  }

  it("updates only the two sentences and reports the old text", async () => {
    const client = db(stored);
    await expect(applyLegislativeVoteDescriptionRewrite(client, rewrite)).resolves.toEqual({
      outcome: "updated",
      id: "row-de",
      oldYeaDescription: stored.yea_description,
      oldNayDescription: stored.nay_description,
    });
    // select FOR UPDATE, the pass through pending (freeze trigger), the re-approving write.
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[1]![0]).toMatch(/SET review_status = 'pending',\s+reviewed_at = NULL/);
    const [sql, params] = client.query.mock.calls[2]! as [string, unknown[]];
    expect(sql).toMatch(/SET yea_description = \$2,\s+nay_description = \$3,\s+review_status = 'approved',\s+reviewed_at = now\(\)/);
    expect(sql).not.toMatch(/labels_json|official_vote_date/);
    expect(params).toEqual(["row-de", rewrite.yeaDescription, rewrite.nayDescription]);
  });

  it("is a no-op when the text already matches", async () => {
    const same = db({ ...stored, yea_description: rewrite.yeaDescription, nay_description: rewrite.nayDescription });
    await expect(applyLegislativeVoteDescriptionRewrite(same, rewrite)).resolves.toMatchObject({ outcome: "unchanged" });
    expect(same.query).toHaveBeenCalledTimes(1);
  });

  it("refuses a pending row, a wrong measure or date, a missing tally, and a digest", async () => {
    await expect(applyLegislativeVoteDescriptionRewrite(db({ ...stored, review_status: "pending" }), rewrite)).rejects.toThrow(
      /is pending; rollcall:rewrite only rewords approved/
    );
    await expect(applyLegislativeVoteDescriptionRewrite(db(stored), { ...rewrite, measureId: "HB 68" })).rejects.toThrow(/is HB 67 on 2025-03-27/);
    await expect(applyLegislativeVoteDescriptionRewrite(db(stored), { ...rewrite, voteDate: "2025-03-28" })).rejects.toThrow(/is HB 67 on 2025-03-27/);
    await expect(
      applyLegislativeVoteDescriptionRewrite(db(stored), { ...rewrite, yeaDescription: "Voted for House Bill 67. It passed 24-14." })
    ).rejects.toThrow(/yea_description does not cite this roll call's tally 23-14/);
    await expect(
      applyLegislativeVoteDescriptionRewrite(db(stored), {
        ...rewrite,
        nayDescription: "Voted against House Bill 67. It caps fees. It posts signs. It photographs cars. It passed 23-14.",
      })
    ).rejects.toThrow(/nay_description has 5 sentences/);
    await expect(applyLegislativeVoteDescriptionRewrite(db(null), rewrite)).rejects.toThrow(/is not in legislative_votes/);
  });
});

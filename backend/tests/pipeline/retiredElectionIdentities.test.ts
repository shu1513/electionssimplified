import { describe, expect, it, vi } from "vitest";

import {
  compactTitleKey,
  describeRetiredElectionIdentity,
  findRetiredElectionIdentities,
  findStagingIngestKeysForIdentity,
  insertRetiredElectionIdentity,
  isReinstateRetiredApproved,
  markRetiredElectionIdentityReinstated,
  type RetiredElectionIdentityRow,
} from "../../src/pipeline/elections/retiredElectionIdentities.js";

const DISTRICT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const RETIRED = "22222222-2222-2222-2222-222222222222";

function ledgerRow(overrides: Partial<RetiredElectionIdentityRow> = {}): RetiredElectionIdentityRow {
  return {
    id: "ledger-1",
    district_id: DISTRICT,
    election_date: "2026-11-03",
    official_ballot_title_key: "united states senator",
    official_ballot_title: "United States Senator",
    race_type: "office",
    election_id: RETIRED,
    action: "retired_spurious",
    reason: "Neither California Senate class is up before 2028.",
    source_url: "https://example.org/not-up",
    superseded_by_election_ids: [],
    retired_on: "2026-09-21",
    ...overrides,
  };
}

function client(rows: unknown[] = [], liveRows: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values: values ?? [] });
    if (text.includes("FROM public.elections")) return { rows: liveRows, rowCount: liveRows.length };
    return { rows, rowCount: rows.length };
  });
  return { query, calls };
}

describe("findRetiredElectionIdentities", () => {
  it("matches on the writer's title key and date", async () => {
    const db = client([ledgerRow()]);
    const matches = await findRetiredElectionIdentities({ query: db.query }, DISTRICT, [
      { official_ballot_title: "Governor", election_date: "2026-11-03" },
      { official_ballot_title: "United States Senator", election_date: "2026-11-03" },
    ]);
    expect(matches).toEqual([{ entryIndex: 1, row: ledgerRow(), matchedBy: "title_key" }]);
    expect(db.calls[0]?.values).toEqual([DISTRICT, ["2026-11-03"]]);
    expect(db.calls[0]?.text).toContain("reinstated_at IS NULL");
  });

  it("matches a near-duplicate title that differs only in spacing or punctuation", async () => {
    const db = client([ledgerRow({ official_ballot_title_key: "u s senate", official_ballot_title: "U.S. Senate" })]);
    const matches = await findRetiredElectionIdentities({ query: db.query }, DISTRICT, [
      { official_ballot_title: "US Senate", election_date: "2026-11-03" },
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedBy).toBe("compact_title_key");
    expect(compactTitleKey("u s senate")).toBe("ussenate");
  });

  it("does not match a different contest, seat, or date", async () => {
    const db = client([ledgerRow({ official_ballot_title_key: "city council seat 3" })]);
    const matches = await findRetiredElectionIdentities({ query: db.query }, DISTRICT, [
      { official_ballot_title: "City Council Seat 4", election_date: "2026-11-03" },
      { official_ballot_title: "City Council Seat 3", election_date: "2027-11-02" },
      { official_ballot_title: "Mayor", election_date: "2026-11-03" },
    ]);
    expect(matches).toEqual([]);
  });

  it("never blocks an update to a live contest, even through the compact key", async () => {
    // "U.S. Senate" was superseded in favour of "US Senate": the survivor's
    // own updates must keep flowing, and only the retired spelling is held.
    const db = client(
      [
        ledgerRow({
          official_ballot_title_key: "u s senate",
          official_ballot_title: "U.S. Senate",
          action: "superseded",
          superseded_by_election_ids: ["33333333-3333-3333-3333-333333333333"],
        }),
      ],
      [{ election_date: "2026-11-03", official_ballot_title_key: "us senate" }]
    );
    const matches = await findRetiredElectionIdentities({ query: db.query }, DISTRICT, [
      { official_ballot_title: "US Senate", election_date: "2026-11-03" },
      { official_ballot_title: "U.S. Senate", election_date: "2026-11-03" },
    ]);
    expect(matches.map((match) => [match.entryIndex, match.matchedBy])).toEqual([[1, "title_key"]]);
  });

  it("after reinstating one spelling, the other spelling's tombstone no longer blocks the live contest", async () => {
    const db = client(
      [ledgerRow({ official_ballot_title_key: "u s senate", official_ballot_title: "U.S. Senate" })],
      [{ election_date: "2026-11-03", official_ballot_title_key: "us senate" }]
    );
    const matches = await findRetiredElectionIdentities({ query: db.query }, DISTRICT, [
      { official_ballot_title: "US Senate", election_date: "2026-11-03" },
    ]);
    expect(matches).toEqual([]);
  });

  it("skips the query for an empty payload", async () => {
    const db = client();
    expect(await findRetiredElectionIdentities({ query: db.query }, DISTRICT, [])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("describeRetiredElectionIdentity", () => {
  it("names the retirement date, reason, and source", () => {
    const text = describeRetiredElectionIdentity({ entryIndex: 0, row: ledgerRow(), matchedBy: "title_key" });
    expect(text).toContain("contest retired on 2026-09-21: Neither California Senate class is up before 2028.");
    expect(text).toContain("[source https://example.org/not-up]");
    expect(text).toContain(`[retired election ${RETIRED}]`);
  });

  it("points a superseded identity at its replacements and flags near-duplicates", () => {
    const text = describeRetiredElectionIdentity({
      entryIndex: 0,
      row: ledgerRow({
        action: "superseded",
        superseded_by_election_ids: ["33333333-3333-3333-3333-333333333333"],
        reason: "Combined shell replaced by per-seat contests.",
      }),
      matchedBy: "compact_title_key",
    });
    expect(text).toContain("contest superseded on 2026-09-21 by election id(s) 33333333-3333-3333-3333-333333333333");
    expect(text).toContain("write to the replacement instead");
    expect(text).toContain('near-duplicate of retired title "United States Senator"');
  });
});

describe("insertRetiredElectionIdentity / markRetiredElectionIdentityReinstated", () => {
  it("derives the title key from the title when none is given", async () => {
    const db = client([{ id: "ledger-9" }]);
    const result = await insertRetiredElectionIdentity({ query: db.query }, {
      districtId: DISTRICT,
      electionDate: "2026-11-03",
      officialBallotTitle: "U.S. Senator, Class II",
      raceType: "office",
      electionId: RETIRED,
      action: "superseded",
      reason: "Duplicate spelling of the same seat.",
      supersededByElectionIds: ["33333333-3333-3333-3333-333333333333"],
    });
    expect(result.id).toBe("ledger-9");
    expect(db.calls[0]?.values).toEqual([
      DISTRICT,
      "2026-11-03",
      "u s senator class ii",
      "U.S. Senator, Class II",
      "office",
      RETIRED,
      "superseded",
      "Duplicate spelling of the same seat.",
      null,
      ["33333333-3333-3333-3333-333333333333"],
      null,
      null,
    ]);
  });

  it("closes only an open ledger row", async () => {
    const db = client();
    await markRetiredElectionIdentityReinstated({ query: db.query }, "ledger-1", RETIRED, "Official list shows the race.");
    expect(db.calls[0]?.text).toContain("SET reinstated_at = now()");
    expect(db.calls[0]?.text).toContain("AND reinstated_at IS NULL");
    expect(db.calls[0]?.values).toEqual(["ledger-1", RETIRED, "Official list shows the race."]);
  });
});

describe("isReinstateRetiredApproved", () => {
  it("requires both the manual-research marker and the inject stamp", () => {
    expect(isReinstateRetiredApproved({ manual_research: true, reinstate_retired_approved: true })).toBe(true);
    expect(isReinstateRetiredApproved({ manual_research: true })).toBe(false);
    expect(isReinstateRetiredApproved({ reinstate_retired_approved: true })).toBe(false);
    expect(isReinstateRetiredApproved(null)).toBe(false);
  });
});

describe("findStagingIngestKeysForIdentity", () => {
  it("returns the written staging rows whose payload carries the identity", async () => {
    const db = client([
      {
        ingest_key: "manual:elections:d:2026",
        entries: [{ official_ballot_title: "United States Senator", election_date: "2026-11-03" }],
      },
      {
        ingest_key: "manual:elections:d:historical:2026",
        entries: [{ official_ballot_title: "Governor", election_date: "2026-11-03" }],
      },
    ]);
    const keys = await findStagingIngestKeysForIdentity(
      { query: db.query },
      DISTRICT,
      "united states senator",
      "2026-11-03"
    );
    expect(keys).toEqual(["manual:elections:d:2026"]);
    expect(db.calls[0]?.text).toContain("status = 'written'");
  });
});

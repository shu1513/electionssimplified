import { describe, expect, it, vi } from "vitest";

import {
  applyManifest,
  buildDiscoveryRow,
  classifyStagingEntry,
  identityKey,
  matchRetireListRows,
  parseManifest,
  parseRetireList,
  type DiscoveryContext,
} from "../../src/scripts/backfillRetiredElectionIdentities.js";

const DISTRICT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const OTHER_DISTRICT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const ELECTION = "22222222-2222-2222-2222-222222222222";
const SURVIVOR = "33333333-3333-3333-3333-333333333333";

const HEADER = "election_id\tdistrict_id\telection_date\tofficial_ballot_title\taction\treason\tsource_url\tsuperseded_by";

function context(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return {
    liveIdentities: new Set([identityKey(DISTRICT, "2026-11-03", "governor")]),
    liveDistrictKeyDates: new Map([[`${DISTRICT}|governor`, new Set(["2026-11-03"])]]),
    liveDistrictDateCounts: new Map([[`${DISTRICT}|2026-11-03`, 1]]),
    openLedgerIdentities: new Set(),
    districts: new Map([
      [DISTRICT, { name: "Bryan County, Oklahoma", state: "OK", canonicalDistrictId: null }],
      [OTHER_DISTRICT, { name: "Arlington CDP, Virginia", state: "VA", canonicalDistrictId: DISTRICT }],
    ]),
    ...overrides,
  };
}

describe("parseRetireList / matchRetireListRows", () => {
  const list = parseRetireList(
    [
      `${ELECTION}\tNo November race. Kylie House was the only filer for Bryan County Assessor.\thttp://example.org/ok\t`,
      `${SURVIVOR}\tNo race on the November 3, 2026 ballot (Unopposed).\thttps://example.org/la\tMember of School Board District 10`,
      "not-a-uuid\tskipped line\thttps://example.org/x",
    ].join("\n"),
    "retire.tsv"
  );

  it("keeps only uuid-led rows and the optional title column", () => {
    expect(list).toHaveLength(2);
    expect(list[0]?.title).toBeNull();
    expect(list[1]?.title).toBe("Member of School Board District 10");
  });

  it("matches by title key when the list carries a title", () => {
    const matches = matchRetireListRows(
      { officialBallotTitle: "Member of School Board, District 10", districtName: "Lincoln Parish School District" },
      list
    );
    expect(matches.map((row) => row.electionId)).toEqual([SURVIVOR]);
  });

  it("matches by the title spelled out inside the reason otherwise", () => {
    const matches = matchRetireListRows(
      { officialBallotTitle: "Bryan County Assessor", districtName: "Bryan County, Oklahoma" },
      list
    );
    expect(matches.map((row) => row.electionId)).toEqual([ELECTION]);
    expect(matchRetireListRows({ officialBallotTitle: "Bryan County Treasurer", districtName: "Bryan County" }, list)).toEqual([]);
  });

  it("uses the district name to split a title shared by several districts", () => {
    const shared = parseRetireList(
      [
        `${ELECTION}\tOnly one filer for Sheriff in Carter County.\thttps://example.org/a\tSheriff`,
        `${SURVIVOR}\tOnly one filer for Sheriff in Douglas County.\thttps://example.org/b\tSheriff`,
      ].join("\n"),
      "x.tsv"
    );
    expect(
      matchRetireListRows({ officialBallotTitle: "Sheriff", districtName: "Douglas County, Nevada" }, shared).map(
        (row) => row.electionId
      )
    ).toEqual([SURVIVOR]);
    expect(matchRetireListRows({ officialBallotTitle: "Sheriff", districtName: "Osage County" }, shared)).toHaveLength(2);
  });
});

describe("classifyStagingEntry", () => {
  const entry = {
    ingestKey: "manual:elections:d:2026",
    districtId: DISTRICT,
    electionDate: "2026-11-03",
    officialBallotTitle: "Bryan County Assessor",
    raceType: "office",
  };

  it("returns null for a live identity or one already in the ledger", () => {
    expect(classifyStagingEntry({ ...entry, officialBallotTitle: "Governor" }, context())).toBeNull();
    expect(
      classifyStagingEntry(
        entry,
        context({ openLedgerIdentities: new Set([identityKey(DISTRICT, "2026-11-03", "bryan county assessor")]) })
      )
    ).toBeNull();
  });

  it("flags date moves and non-canonical districts instead of proposing a tombstone", () => {
    expect(
      classifyStagingEntry(
        entry,
        context({ liveDistrictKeyDates: new Map([[`${DISTRICT}|bryan county assessor`, new Set(["2027-11-02"])]]) })
      )?.classification
    ).toBe("date_moved");
    expect(classifyStagingEntry({ ...entry, districtId: OTHER_DISTRICT }, context())?.classification).toBe(
      "district_not_canonical"
    );
    expect(classifyStagingEntry({ ...entry, districtId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }, context())?.classification).toBe(
      "district_missing"
    );
  });

  it("separates identities with live same-date siblings from lone ones", () => {
    expect(classifyStagingEntry(entry, context())?.classification).toBe("same_date_siblings");
    expect(classifyStagingEntry(entry, context({ liveDistrictDateCounts: new Map() }))?.classification).toBe(
      "no_same_date_rows"
    );
  });

  it("prefills a uniquely matched retire-list row into the discovery output", () => {
    const classified = classifyStagingEntry(entry, context())!;
    const row = buildDiscoveryRow(classified, [
      { electionId: ELECTION, reason: "No November race for the assessor.", sourceUrl: "https://example.org", title: null, file: "r.tsv" },
    ]);
    expect(row.election_id).toBe(ELECTION);
    expect(row.action).toBe("retired_spurious");
    expect(row.district_name).toBe("Bryan County, Oklahoma");
    const ambiguous = buildDiscoveryRow(classified, [
      { electionId: ELECTION, reason: "a", sourceUrl: "", title: null, file: "r.tsv" },
      { electionId: SURVIVOR, reason: "b", sourceUrl: "", title: null, file: "r.tsv" },
    ]);
    expect(ambiguous.election_id).toBe("");
    expect(ambiguous.action).toBe("");
    expect(ambiguous.tsv_candidates).toBe(`${ELECTION},${SURVIVOR}`);
  });
});

describe("parseManifest", () => {
  it("validates every column and refuses supersessions without replacements", () => {
    const text = [
      HEADER,
      `${ELECTION}\t${DISTRICT}\t2026-11-03\tBryan County Assessor\tretired_spurious\tOnly filer elected without a vote.\thttps://example.org\t`,
      `${SURVIVOR}\t${DISTRICT}\t2026-11-03\tBoard Member\tsuperseded\tShell replaced by seat rows.\t\t`,
      `bad\t${DISTRICT}\t2026-13-99\t\tnope\tshort\tftp://x\tnot-uuid`,
      `${ELECTION}\t${DISTRICT}\t2026-11-03\tBryan County Assessor\tbackfilled\tDuplicate identity in file.\t\t`,
    ].join("\n");
    const manifest = parseManifest(text);
    expect(manifest.rows).toHaveLength(1);
    expect(manifest.rows[0]).toMatchObject({ line: 2, action: "retired_spurious", sourceUrl: "https://example.org" });
    expect(manifest.invalid).toHaveLength(3);
    expect(manifest.invalid[0]).toContain("superseded rows need superseded_by");
    expect(manifest.invalid[1]).toContain("election_id is not a uuid");
    expect(
      parseManifest([HEADER, `\t${DISTRICT}\t2026-11-03\tOld Shell\tbackfilled\tId survives only as a log prefix.\t\t`].join("\n")).rows[0]
        ?.electionId
    ).toBeNull();
    expect(manifest.invalid[2]).toContain("duplicate identity in manifest");
  });

  it("refuses a file without the manifest columns", () => {
    expect(parseManifest("id\ttitle\n1\t2").invalid[0]).toContain("missing column(s)");
  });
});

describe("applyManifest", () => {
  function fakeClient(state: { liveElection?: string; ledger?: string; survivors?: string[] }) {
    const calls: { text: string; values: unknown[] }[] = [];
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (text.includes("FROM public.districts")) return { rows: [{ canonical_district_id: null }] };
      if (text.includes("FROM public.elections") && text.includes("official_ballot_title_key = $3")) {
        return { rows: state.liveElection ? [{ id: state.liveElection }] : [] };
      }
      if (text.includes("FROM public.retired_election_identities")) {
        return { rows: state.ledger ? [{ id: state.ledger }] : [] };
      }
      if (text.includes("WHERE id = ANY($1::uuid[])")) {
        return { rows: (state.survivors ?? []).map((id) => ({ id })) };
      }
      if (text.includes("FROM public.staging_items")) {
        return { rows: [{ ingest_key: "manual:elections:d:2026", entries: [{ official_ballot_title: "Bryan County Assessor", election_date: "2026-11-03" }] }] };
      }
      if (text.includes("INSERT INTO public.retired_election_identities")) return { rows: [{ id: "ledger-new" }] };
      return { rows: [] };
    });
    return { query, calls };
  }

  const manifest = parseManifest(
    [
      HEADER,
      `${ELECTION}\t${DISTRICT}\t2026-11-03\tBryan County Assessor\tretired_spurious\tOnly filer elected without a vote.\thttps://example.org\t`,
    ].join("\n")
  );

  it("dry-run counts the plan and inserts nothing", async () => {
    const db = fakeClient({});
    const result = await applyManifest({ query: db.query }, manifest, { dryRun: true, retiredOn: "2026-09-21" });
    expect(result.wouldInsert).toBe(1);
    expect(result.inserted).toBe(0);
    expect(db.calls.some((call) => call.text.includes("INSERT INTO"))).toBe(false);
    expect(db.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("inserts with the original retirement date and the producing staging key", async () => {
    const db = fakeClient({});
    const result = await applyManifest({ query: db.query }, manifest, { dryRun: false, retiredOn: "2026-09-21" });
    expect(result.inserted).toBe(1);
    const insert = db.calls.find((call) => call.text.includes("INSERT INTO public.retired_election_identities"));
    expect(insert?.values).toEqual([
      DISTRICT,
      "2026-11-03",
      "bryan county assessor",
      "Bryan County Assessor",
      null,
      ELECTION,
      "retired_spurious",
      "Only filer elected without a vote.",
      "https://example.org",
      [],
      "manual:elections:d:2026",
      "2026-09-21T12:00:00Z",
    ]);
    expect(db.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("skips identities that are live again or already tombstoned", async () => {
    const live = await applyManifest({ query: fakeClient({ liveElection: SURVIVOR }).query }, manifest, {
      dryRun: true,
      retiredOn: "2026-09-21",
    });
    expect(live.wouldInsert).toBe(0);
    expect(live.skippedLiveRow[0]).toContain(SURVIVOR);

    const ledgered = await applyManifest({ query: fakeClient({ ledger: "ledger-old" }).query }, manifest, {
      dryRun: true,
      retiredOn: "2026-09-21",
    });
    expect(ledgered.skippedAlreadyInLedger[0]).toContain("ledger-old");
  });

  it("refuses a supersession whose replacement ids do not exist", async () => {
    const superseded = parseManifest(
      [
        HEADER,
        `${ELECTION}\t${DISTRICT}\t2026-11-03\tBoard Member\tsuperseded\tShell replaced by seat rows.\t\t${SURVIVOR}`,
      ].join("\n")
    );
    const result = await applyManifest({ query: fakeClient({ survivors: [] }).query }, superseded, {
      dryRun: true,
      retiredOn: "2026-09-21",
    });
    expect(result.wouldInsert).toBe(0);
    expect(result.invalid[0]).toContain(`superseded_by id(s) not found: ${SURVIVOR}`);
  });
});

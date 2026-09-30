import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertConfirmedTarget,
  assertPromotionEndpoints,
  assertTransportableArrays,
  chunk,
  countUnresolvedTags,
  diffCandidateFingerprints,
  findIdentityKeyMismatches,
  guardedCandidateIds,
  LABEL_PROJECTION_SQL,
  RECORD_PROJECTION_SQL,
  REKEY_RECORDS_SQL,
  describeEndpoint,
  diffMigrationSets,
  isLocalHost,
  parseEndpoint,
  planRecordRekeys,
  planRows,
  planTagReconciliation,
  RECONCILE_TAGS_DELETE_SQL,
  recordKey,
  rekeyWireRows,
  resolveIdentityTransitions,
  sameRecord,
  type RecordRow,
  type TagRow,
  sameScalar,
  sameStringArray,
  TAG_PROJECTION_SQL,
  UPSERT_LABELS_SQL,
  UPSERT_RECORDS_SQL,
  UPSERT_TAGS_SQL,
  upsertBatched,
  readCandidateScope,
} from "../../src/scripts/promoteResearchData.js";

const LOCAL = "postgresql://localhost:5432/voteapp";
const REMOTE = "postgresql://voteapp_api:secret@db.example.render.com:5432/voteapp_prod";

describe("parseEndpoint", () => {
  it("reads host, port, database and user", () => {
    expect(parseEndpoint("target", REMOTE)).toEqual({
      host: "db.example.render.com",
      port: 5432,
      database: "voteapp_prod",
      user: "voteapp_api",
    });
  });

  it("defaults the port when the URL omits it", () => {
    expect(parseEndpoint("source", "postgresql://localhost/voteapp").port).toBe(5432);
  });

  it("honours the libpq host parameter, which overrides the URL authority", () => {
    // The same reason localDatabaseGuard parses with pg-connection-string: a
    // URL that looks local can point somewhere else entirely.
    const endpoint = parseEndpoint("target", "postgresql://localhost:5432/voteapp?host=/tmp/pgsock");
    expect(endpoint.host).toBe("/tmp/pgsock");
  });

  it("rejects blank, malformed and non-postgres URLs", () => {
    expect(() => parseEndpoint("target", "  ")).toThrow(/required/);
    expect(() => parseEndpoint("target", "not a url")).toThrow(/postgres/);
    expect(() => parseEndpoint("target", "mysql://localhost/db")).toThrow(/unsupported protocol/);
  });

  it("rejects a URL with no database name", () => {
    expect(() => parseEndpoint("target", "postgresql://localhost:5432")).toThrow(/does not name a database/);
  });
});

describe("describeEndpoint", () => {
  it("never includes the password", () => {
    const described = describeEndpoint(parseEndpoint("target", REMOTE));
    expect(described).toBe("voteapp_api@db.example.render.com:5432/voteapp_prod");
    expect(described).not.toContain("secret");
  });

  it("says so when the URL omits the user rather than printing a bare @", () => {
    // libpq falls back to PGUSER or the OS user, so we do not actually know
    // who will authenticate; claiming to would be worse than admitting it.
    expect(describeEndpoint(parseEndpoint("source", LOCAL))).toBe(
      "<environment default>@localhost:5432/voteapp"
    );
  });
});

describe("isLocalHost", () => {
  it("accepts loopback names and unix sockets, rejects remote hosts", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("/tmp/pgsock")).toBe(true);
    expect(isLocalHost("db.example.render.com")).toBe(false);
  });
});

describe("assertPromotionEndpoints", () => {
  it("accepts a local source with a remote target", () => {
    const endpoints = assertPromotionEndpoints({ sourceUrl: LOCAL, targetUrl: REMOTE, env: {} });
    expect(endpoints.source.host).toBe("localhost");
    expect(endpoints.target.host).toBe("db.example.render.com");
  });

  it("allows a local target so a promotion can be rehearsed against a scratch database", () => {
    expect(() =>
      assertPromotionEndpoints({
        sourceUrl: LOCAL,
        targetUrl: "postgresql://localhost:5432/voteapp_promotion_target",
        env: {},
      })
    ).not.toThrow();
  });

  it("fails closed when ALLOW_REMOTE_DB_WRITES is set", () => {
    // That variable relaxes the manual-writer localhost guard. A shell holding
    // it must not silently loosen the tool that writes to production.
    expect(() =>
      assertPromotionEndpoints({
        sourceUrl: LOCAL,
        targetUrl: REMOTE,
        env: { ALLOW_REMOTE_DB_WRITES: "1" },
      })
    ).toThrow(/ALLOW_REMOTE_DB_WRITES/);
  });

  it("rejects a non-local source", () => {
    expect(() =>
      assertPromotionEndpoints({ sourceUrl: REMOTE, targetUrl: LOCAL, env: {} })
    ).toThrow(/non-local source/);
  });

  it("rejects promoting a database into itself", () => {
    expect(() =>
      assertPromotionEndpoints({ sourceUrl: LOCAL, targetUrl: LOCAL, env: {} })
    ).toThrow(/into itself/);
  });

  it("treats a different database on the same host as a distinct target", () => {
    expect(() =>
      assertPromotionEndpoints({
        sourceUrl: LOCAL,
        targetUrl: "postgresql://localhost:5432/other",
        env: {},
      })
    ).not.toThrow();
  });
});

describe("planRows", () => {
  type Row = { key: string; value: string | null };
  const keyOf = (row: Row) => row.key;
  const isEqual = (a: Row, b: Row) => sameScalar(a.value, b.value);

  it("classifies inserts, updates, unchanged and target-only rows", () => {
    const plan = planRows({
      sourceRows: [
        { key: "new", value: "a" },
        { key: "changed", value: "b2" },
        { key: "same", value: "c" },
      ],
      targetRows: [
        { key: "changed", value: "b1" },
        { key: "same", value: "c" },
        { key: "target-only", value: "d" },
      ],
      keyOf,
      isEqual,
    });

    expect(plan.inserts.map(keyOf)).toEqual(["new"]);
    expect(plan.updates.map(keyOf)).toEqual(["changed"]);
    expect(plan.unchangedCount).toBe(1);
    // Never deleted — production is allowed to be a superset.
    expect(plan.targetOnlyCount).toBe(1);
  });

  it("is a pure no-op when source and target already agree", () => {
    const rows = [
      { key: "a", value: "1" },
      { key: "b", value: null },
    ];
    const plan = planRows({ sourceRows: rows, targetRows: rows, keyOf, isEqual });

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(2);
    expect(plan.targetOnlyCount).toBe(0);
  });

  it("treats null and a value as distinct, like IS DISTINCT FROM", () => {
    const plan = planRows({
      sourceRows: [{ key: "a", value: null }],
      targetRows: [{ key: "a", value: "set" }],
      keyOf,
      isEqual,
    });
    expect(plan.updates).toHaveLength(1);
  });

  it("handles an empty target as all inserts", () => {
    const plan = planRows({
      sourceRows: [{ key: "a", value: "1" }],
      targetRows: [],
      keyOf,
      isEqual,
    });
    expect(plan.inserts).toHaveLength(1);
    expect(plan.targetOnlyCount).toBe(0);
  });
});

describe("sameScalar / sameStringArray", () => {
  it("treats null and undefined as equal absence", () => {
    expect(sameScalar(null, undefined)).toBe(true);
    expect(sameScalar("", null)).toBe(false);
  });

  it("compares string arrays by order and content", () => {
    expect(sameStringArray(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameStringArray(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameStringArray([], null)).toBe(true);
    expect(sameStringArray(["a"], ["a", "b"])).toBe(false);
  });
});

describe("diffMigrationSets", () => {
  const known = ["001_init.sql", "002_next.sql"];

  it("passes when both sides have every on-disk migration at the same checksum", () => {
    const both = new Map([
      ["001_init.sql", "a"],
      ["002_next.sql", "b"],
    ]);
    expect(diffMigrationSets({ source: both, target: both, knownFilenames: known })).toEqual({
      missingOnSource: [],
      missingOnTarget: [],
      checksumMismatch: [],
    });
  });

  it("ignores applied rows whose migration file no longer exists", () => {
    // The local database carries 9 such rows from renamed migrations (e.g.
    // 196_add_county_council_chairman_alias.sql). Comparing raw sets would
    // report a permanent mismatch and block every promotion.
    const source = new Map([
      ["001_init.sql", "a"],
      ["002_next.sql", "b"],
      ["196_add_county_council_chairman_alias.sql", "ghost"],
    ]);
    const target = new Map([
      ["001_init.sql", "a"],
      ["002_next.sql", "b"],
    ]);
    const diff = diffMigrationSets({ source, target, knownFilenames: known });
    expect(diff.missingOnTarget).toEqual([]);
    expect(diff.checksumMismatch).toEqual([]);
  });

  it("reports a target that is behind, and a checksum disagreement", () => {
    const source = new Map([
      ["001_init.sql", "a"],
      ["002_next.sql", "b"],
    ]);
    const target = new Map([["001_init.sql", "different"]]);
    const diff = diffMigrationSets({ source, target, knownFilenames: known });
    expect(diff.missingOnTarget).toEqual(["002_next.sql"]);
    expect(diff.checksumMismatch).toEqual(["001_init.sql"]);
  });
});

describe("chunk", () => {
  it("splits rows into batches and keeps every row", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("rejects a non-positive size rather than looping forever", () => {
    expect(() => chunk([1], 0)).toThrow(/positive/);
  });
});

describe("upsert statements", () => {
  const statements = [UPSERT_RECORDS_SQL, UPSERT_TAGS_SQL, UPSERT_LABELS_SQL];

  it("never delete, truncate, or issue DDL — the property that makes this safe on production", () => {
    for (const sql of statements) {
      expect(sql).not.toMatch(/\bDELETE\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
      expect(sql).not.toMatch(/\bDROP\b/i);
      expect(sql).not.toMatch(/\bALTER\b/i);
    }
  });

  it("the whole file holds exactly one DELETE — the opt-in tag reconciliation — and no TRUNCATE or DDL", async () => {
    // The bounded exception to "never deletes" is RECONCILE_TAGS_DELETE_SQL
    // and nothing else. Check the source text, not just the exported
    // constants, so a DELETE written inline in main() cannot slip past.
    const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/scripts/promoteResearchData.ts");
    const source = await readFile(file, "utf8");
    expect(source).toContain(RECONCILE_TAGS_DELETE_SQL);
    // Judge code, not prose: the comments are allowed to name the words.
    const rest = source
      .replace(RECONCILE_TAGS_DELETE_SQL, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(rest).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(rest).not.toMatch(/\bTRUNCATE\b/i);
    expect(rest).not.toMatch(/\bDROP\s+(TABLE|INDEX|COLUMN)\b/i);
    expect(rest).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("guard every update with a distinctness check so unchanged rows never fire updated_at", () => {
    for (const sql of statements) {
      expect(sql).toMatch(/ON CONFLICT/i);
      expect(sql).toMatch(/IS DISTINCT FROM/i);
    }
  });

  it("touch only the three allowlisted tables", () => {
    const written = statements.map((sql) => /INSERT INTO (public\.\w+)/i.exec(sql)?.[1]);
    expect(written).toEqual([
      "public.candidate_records",
      "public.candidate_record_area_tags",
      "public.finance_committee_labels",
    ]);
  });

  it("resolves tag parents through the target's own rows, never a transported id", () => {
    expect(UPSERT_TAGS_SQL).toMatch(/JOIN public\.candidate_records/i);
    expect(UPSERT_TAGS_SQL).toMatch(/r\.record_identity_key/i);
    expect(UPSERT_TAGS_SQL).toMatch(/JOIN public\.research_areas AS a ON a\.slug/i);
    // candidate_record_id may appear in the projection's JOIN (that is how the
    // source denormalises), but must never be one of the transported columns —
    // carrying it across is exactly the bug that attaches tags to the wrong
    // record when the target's record id differs.
    const selectedColumns = /SELECT([\s\S]*?)FROM/i.exec(TAG_PROJECTION_SQL)?.[1] ?? "";
    expect(selectedColumns).not.toMatch(/candidate_record_id/i);
    expect(selectedColumns).toMatch(/record_identity_key/i);
    expect(selectedColumns).toMatch(/research_area_slug/i);
  });

  it("copies researched_at rather than stamping now(), so history is not falsified", () => {
    expect(UPSERT_LABELS_SQL).toMatch(/researched_at_utc/);
    expect(UPSERT_LABELS_SQL).not.toMatch(/now\(\)/i);
  });

  it("renders dates and timestamps style-independently, never via ::text", () => {
    // ::text honours the session DateStyle: the same row projects as
    // "08/06/2022" under DateStyle='SQL, DMY' and "2022-06-08" under ISO
    // (verified against the live database). Two servers set differently would
    // see a false diff and then write each other's dates back with day and
    // month swapped.
    expect(RECORD_PROJECTION_SQL).toMatch(/to_char\(event_date, 'YYYY-MM-DD'\)/);
    expect(RECORD_PROJECTION_SQL).toMatch(/to_char\(created_at AT TIME ZONE 'UTC'/);
    expect(RECORD_PROJECTION_SQL).not.toMatch(/event_date::text/);
    expect(LABEL_PROJECTION_SQL).toMatch(/to_char\(researched_at AT TIME ZONE 'UTC'/);
    expect(LABEL_PROJECTION_SQL).not.toMatch(/researched_at AT TIME ZONE 'UTC'\)::text/);
  });
});

describe("upsertBatched", () => {
  it("sends one statement per batch and sums the rows written", async () => {
    const calls: unknown[][] = [];
    const client = {
      query: async (_text: string, values?: readonly unknown[]) => {
        calls.push(values as unknown[]);
        return { rows: [], rowCount: 2 };
      },
    };
    const written = await upsertBatched(client, "SQL", [1, 2, 3], 2);

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]![0] as string)).toEqual([1, 2]);
    expect(JSON.parse(calls[1]![0] as string)).toEqual([3]);
    expect(written).toBe(4);
  });

  it("issues no statement at all when there is nothing to write", async () => {
    let called = false;
    const client = {
      query: async () => {
        called = true;
        return { rows: [], rowCount: 0 };
      },
    };
    expect(await upsertBatched(client, "SQL", [])).toBe(0);
    expect(called).toBe(false);
  });
});

describe("assertConfirmedTarget", () => {
  const target = parseEndpoint("target", REMOTE);

  it("accepts the matching host/database, case-insensitively", () => {
    expect(() => assertConfirmedTarget(target, "DB.example.render.com:5432/voteapp_prod")).not.toThrow();
  });

  it("names the required flag value when confirmation is missing", () => {
    expect(() => assertConfirmedTarget(target, "")).toThrow(
      /--confirm-target db\.example\.render\.com:5432\/voteapp_prod/
    );
  });

  it("rejects the host alone — two databases commonly share one host", () => {
    // Confirming only the host would let a promotion land in the wrong
    // database while the operator believed they had named it.
    expect(() => assertConfirmedTarget(target, "db.example.render.com")).toThrow(/does not match/);
  });

  it("rejects the right host with the wrong database", () => {
    expect(() => assertConfirmedTarget(target, "db.example.render.com:5432/voteapp_staging")).toThrow(
      /does not match/
    );
  });
});

describe("sameRecord", () => {
  const base = {
    candidate_id: "c",
    record_identity_key: "k",
    description: "d",
    source_url: "u",
    event_date: "2026-01-01",
    created_at_utc: "2026-01-01 00:00:00.000000", retired_at_utc: null, retired_reason: null,
    origin: "manual",
    origin_run_id: "r1",
  };

  it("ignores provenance, so promotion does not rewrite target history", () => {
    expect(sameRecord(base, { ...base, origin: "ai_enricher", origin_run_id: "r2" })).toBe(true);
  });

  it("ignores created_at — the upsert never updates it, so comparing it would fire a no-op UPDATE forever", () => {
    expect(sameRecord(base, { ...base, created_at_utc: "2020-05-05 12:00:00.000000" })).toBe(true);
  });

  it("reports a real content change", () => {
    expect(sameRecord(base, { ...base, description: "different" })).toBe(false);
    expect(sameRecord(base, { ...base, source_url: "other" })).toBe(false);
    expect(sameRecord(base, { ...base, event_date: "2025-12-31" })).toBe(false);
  });
});

describe("planRecordRekeys", () => {
  const recordRow = (overrides: Partial<RecordRow>): RecordRow => ({
    candidate_id: "c1",
    record_identity_key: "key",
    description: "Voted to adopt the budget for fiscal year 2025.",
    source_url: "https://example.gov/doc/1",
    event_date: "2024-03-06",
    created_at_utc: "2026-07-28 06:14:50.777574", retired_at_utc: null, retired_reason: null,
    origin: null,
    origin_run_id: null,
    ...overrides,
  });
  // Similarity by exact match keeps the tests deterministic; the production
  // scorer's behavior is candidateRecordStore's own test surface.
  const similarityOf = (a: string, b: string) => (a === b ? 1 : 0);
  const normalizeUrl = (url: string) => url.trim().toLowerCase().replace(/\/+$/g, "");

  // Keys in the transition map are recordKey-joined (NUL separator), never a
  // hand-built "cand key" string.
  const candKey = (candidateId: string, key: string) =>
    recordKey({ candidate_id: candidateId, record_identity_key: key });

  it("re-attaches an insert to the target-only row it re-keys", () => {
    const sourceRow = recordRow({ record_identity_key: "new-key" });
    const targetRow = recordRow({ record_identity_key: "old-key" });
    const plan = planRecordRekeys({
      inserts: [sourceRow],
      targetOnlyRows: [targetRow],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });

    expect(plan.rekeys).toEqual([{ sourceRow, oldKey: "old-key", via: "similarity" }]);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.redatedSuspects).toHaveLength(0);
  });

  it("matches on the normalized URL, like the ingest writer", () => {
    const sourceRow = recordRow({ record_identity_key: "new-key", source_url: "https://EXAMPLE.gov/doc/1/" });
    const plan = planRecordRekeys({
      inserts: [sourceRow],
      targetOnlyRows: [recordRow({ record_identity_key: "old-key" })],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    expect(plan.rekeys).toHaveLength(1);
  });

  it("keeps a below-threshold insert as an insert", () => {
    const sourceRow = recordRow({ record_identity_key: "new-key", description: "Something else entirely." });
    const plan = planRecordRekeys({
      inserts: [sourceRow],
      targetOnlyRows: [recordRow({ record_identity_key: "old-key" })],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    expect(plan.rekeys).toHaveLength(0);
    expect(plan.inserts).toEqual([sourceRow]);
  });

  it("never matches across candidates or dates or URLs", () => {
    const sourceRow = recordRow({ record_identity_key: "new-key" });
    for (const targetRow of [
      recordRow({ record_identity_key: "old-key", candidate_id: "c2" }),
      recordRow({ record_identity_key: "old-key", event_date: "2024-03-07" }),
      recordRow({ record_identity_key: "old-key", source_url: "https://example.gov/doc/2" }),
    ]) {
      const plan = planRecordRekeys({
        inserts: [sourceRow],
        targetOnlyRows: [targetRow],
        normalizeUrl,
        similarityOf,
        threshold: 0.86,
      });
      expect(plan.rekeys).toHaveLength(0);
      expect(plan.inserts).toEqual([sourceRow]);
    }
  });

  it("reports a same-URL different-date near-duplicate for review instead of merging it", () => {
    const sourceRow = recordRow({ record_identity_key: "new-key", event_date: "2024-03-08" });
    const targetRow = recordRow({ record_identity_key: "old-key" });
    const plan = planRecordRekeys({
      inserts: [sourceRow],
      targetOnlyRows: [targetRow],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
    });
    // A date repair re-keys too, but two real records can legitimately share
    // a URL across dates — so this is a warning, never an auto-merge.
    expect(plan.rekeys).toHaveLength(0);
    expect(plan.inserts).toEqual([sourceRow]);
    expect(plan.redatedSuspects).toEqual([{ sourceRow, targetRow, similarity: 1 }]);
  });

  it("rekeys via the transition ledger even when the rewrite is beyond the similarity threshold", () => {
    // The live gap: 278 of 817 plain-language rewrites scored below 0.86
    // against their originals, so the similarity pass alone would still
    // duplicate them. The ledger is exact.
    const sourceRow = recordRow({
      record_identity_key: "new-key",
      description: "A completely rephrased plain-language description.",
    });
    const targetRow = recordRow({ record_identity_key: "old-key" });
    const plan = planRecordRekeys({
      inserts: [sourceRow],
      targetOnlyRows: [targetRow],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
      transitions: new Map([[candKey("c1", "old-key"), "new-key"]]),
    });
    expect(plan.rekeys).toEqual([{ sourceRow, oldKey: "old-key", via: "transition" }]);
    expect(plan.inserts).toHaveLength(0);
  });

  it("rekeys via the ledger even when the edit changed the event date", () => {
    // A date repair moves the row out of the (candidate, date, url) slot the
    // similarity heuristic matches on; only the ledger can follow it.
    const sourceRow = recordRow({ record_identity_key: "new-key", event_date: "2024-04-01" });
    const targetRow = recordRow({ record_identity_key: "old-key", event_date: "2024-03-06" });
    const plan = planRecordRekeys({
      inserts: [sourceRow],
      targetOnlyRows: [targetRow],
      normalizeUrl,
      similarityOf: () => 0,
      threshold: 0.86,
      transitions: new Map([[candKey("c1", "old-key"), "new-key"]]),
    });
    expect(plan.rekeys).toEqual([{ sourceRow, oldKey: "old-key", via: "transition" }]);
  });

  it("ignores a ledger entry whose final key matches no planned insert", () => {
    const targetRow = recordRow({ record_identity_key: "old-key" });
    const plan = planRecordRekeys({
      inserts: [],
      targetOnlyRows: [targetRow],
      normalizeUrl,
      similarityOf,
      threshold: 0.86,
      transitions: new Map([[candKey("c1", "old-key"), "already-on-target"]]),
    });
    expect(plan.rekeys).toHaveLength(0);
  });

  it("refuses when the ledger maps two target rows onto one local record", () => {
    expect(() =>
      planRecordRekeys({
        inserts: [recordRow({ record_identity_key: "new-key" })],
        targetOnlyRows: [
          recordRow({ record_identity_key: "old-key-1" }),
          recordRow({ record_identity_key: "old-key-2" }),
        ],
        normalizeUrl,
        similarityOf: () => 0,
        threshold: 0.86,
        transitions: new Map([
          [candKey("c1", "old-key-1"), "new-key"],
          [candKey("c1", "old-key-2"), "new-key"],
        ]),
      })
    ).toThrow(/maps two target rows onto one local record/);
  });

  it("refuses when two local records claim the same target row", () => {
    const targetRow = recordRow({ record_identity_key: "old-key" });
    expect(() =>
      planRecordRekeys({
        inserts: [
          recordRow({ record_identity_key: "new-key-1" }),
          recordRow({ record_identity_key: "new-key-2" }),
        ],
        targetOnlyRows: [targetRow],
        normalizeUrl,
        similarityOf,
        threshold: 0.86,
      })
    ).toThrow(/both match the same target row/);
  });

  it("refuses when one insert matches two target rows equally", () => {
    expect(() =>
      planRecordRekeys({
        inserts: [recordRow({ record_identity_key: "new-key" })],
        targetOnlyRows: [
          recordRow({ record_identity_key: "old-key-1" }),
          recordRow({ record_identity_key: "old-key-2" }),
        ],
        normalizeUrl,
        similarityOf,
        threshold: 0.86,
      })
    ).toThrow(/cannot tell which the local edit re-keyed/);
  });
});

describe("resolveIdentityTransitions", () => {
  const candKeyOf = (candidateId: string, key: string) =>
    recordKey({ candidate_id: candidateId, record_identity_key: key });
  // seq orders the history: later seq = later created_at. The resolver sorts
  // internally, so tests may hand rows in any order.
  const transition = (candidateId: string, oldKey: string, newKey: string, seq = 0) => ({
    id: `t-${seq}`,
    candidate_id: candidateId,
    old_record_identity_key: oldKey,
    new_record_identity_key: newKey,
    created_at_utc: `2026-08-01 00:00:0${seq}.000000`,
  });

  it("maps each old key to its terminal key across a chain", () => {
    // Rewritten, then date-repaired: a target promoted at k1 must land on k3.
    const resolved = resolveIdentityTransitions([
      transition("c1", "k1", "k2"),
      transition("c1", "k2", "k3"),
    ]);
    expect(resolved.get(candKeyOf("c1", "k1"))).toBe("k3");
    expect(resolved.get(candKeyOf("c1", "k2"))).toBe("k3");
  });

  it("keeps candidates separate", () => {
    const resolved = resolveIdentityTransitions([
      transition("c1", "k1", "k2"),
      transition("c2", "k2", "k3"),
    ]);
    expect(resolved.get(candKeyOf("c1", "k1"))).toBe("k2");
  });

  it("resolves a multi-successor history to the NEWEST edit, regardless of row order", () => {
    // Edit -> revert -> re-edit legally leaves k1 with two successors
    // (k1->k2 and k1->k3); only the newest says where the row actually is.
    const history = [
      transition("c1", "k1", "k2", 0),
      transition("c1", "k2", "k1", 1),
      transition("c1", "k1", "k3", 2),
    ];
    const shuffled = [history[2]!, history[0]!, history[1]!];
    for (const rows of [history, shuffled]) {
      const resolved = resolveIdentityTransitions(rows);
      expect(resolved.get(candKeyOf("c1", "k1"))).toBe("k3");
    }
  });

  it("breaks same-timestamp ties by id so resolution stays deterministic", () => {
    const a = { ...transition("c1", "k1", "kA", 0), id: "t-a" };
    const b = { ...transition("c1", "k1", "kB", 0), id: "t-b" };
    expect(resolveIdentityTransitions([a, b]).get(candKeyOf("c1", "k1"))).toBe("kB");
    expect(resolveIdentityTransitions([b, a]).get(candKeyOf("c1", "k1"))).toBe("kB");
  });

  it("terminates on a hand-corrupted cycle instead of looping", () => {
    const resolved = resolveIdentityTransitions([
      transition("c1", "k1", "k2"),
      transition("c1", "k2", "k1"),
    ]);
    expect(resolved.get(candKeyOf("c1", "k1"))).toBe("k2");
    expect(resolved.get(candKeyOf("c1", "k2"))).toBe("k1");
  });
});

describe("RECONCILE_TAGS_DELETE_SQL", () => {
  it("deletes only from candidate_record_area_tags and issues nothing else", () => {
    expect(RECONCILE_TAGS_DELETE_SQL).toMatch(/^\s*DELETE FROM public\.candidate_record_area_tags AS t\b/);
    expect(RECONCILE_TAGS_DELETE_SQL.match(/\bDELETE\b/gi)).toHaveLength(1);
    expect(RECONCILE_TAGS_DELETE_SQL).not.toMatch(/\b(INSERT|UPDATE|TRUNCATE|DROP|ALTER)\b/i);
  });

  it("resolves the record and area by natural key on the target, never by a transported id", () => {
    expect(RECONCILE_TAGS_DELETE_SQL).toMatch(/r\.candidate_id = s\.candidate_id/);
    expect(RECONCILE_TAGS_DELETE_SQL).toMatch(/r\.record_identity_key = s\.record_identity_key/);
    expect(RECONCILE_TAGS_DELETE_SQL).toMatch(/a\.slug = s\.research_area_slug/);
    expect(RECONCILE_TAGS_DELETE_SQL).toMatch(/t\.candidate_record_id = r\.id/);
    expect(RECONCILE_TAGS_DELETE_SQL).toMatch(/t\.research_area_id = a\.id/);
    const wireColumns = /jsonb_to_recordset\(\$1::jsonb\) AS s\(([\s\S]*?)\)/.exec(RECONCILE_TAGS_DELETE_SQL)?.[1] ?? "";
    expect(wireColumns).not.toMatch(/\bid\b|candidate_record_id|research_area_id/);
  });
});

describe("planTagReconciliation", () => {
  const recordRow = (overrides: Partial<RecordRow>): RecordRow => ({
    candidate_id: "c1",
    record_identity_key: "key",
    description: "Voted to adopt the budget for fiscal year 2025.",
    source_url: "https://example.gov/doc/1",
    event_date: "2024-03-06",
    created_at_utc: "2026-07-28 06:14:50.777574", retired_at_utc: null, retired_reason: null,
    origin: null,
    origin_run_id: null,
    ...overrides,
  });
  const tag = (candidate_id: string, record_identity_key: string, research_area_slug: string, stance: string | null = "for"): TagRow => ({
    candidate_id,
    record_identity_key,
    research_area_slug,
    stance,
  });
  const noSkips = { noLocalRecord: 0, similarityRekeyOnly: 0, carriedByRekey: 0 };

  it("removes a tag the local record no longer carries when the record matches by key", () => {
    const plan = planTagReconciliation({
      targetOnlyTags: [tag("c1", "key", "housing"), tag("c1", "key", "taxes")],
      sourceTags: [tag("c1", "key", "budget")],
      sourceRecords: [recordRow({})],
      rekeys: [],
    });
    expect(plan.records).toEqual([
      {
        candidate_id: "c1",
        target_record_identity_key: "key",
        local_record_identity_key: "key",
        matched_via: "same_key",
        remove: ["housing", "taxes"],
        keep: ["budget"],
      },
    ]);
    expect(plan.removals).toEqual([
      { candidate_id: "c1", record_identity_key: "key", research_area_slug: "housing" },
      { candidate_id: "c1", record_identity_key: "key", research_area_slug: "taxes" },
    ]);
    expect(plan.skipped).toEqual(noSkips);
  });

  it("never touches a target record that has no local counterpart", () => {
    const plan = planTagReconciliation({
      targetOnlyTags: [tag("c1", "orphan", "housing")],
      sourceTags: [],
      sourceRecords: [recordRow({ record_identity_key: "other" })],
      rekeys: [],
    });
    expect(plan.records).toHaveLength(0);
    expect(plan.removals).toHaveLength(0);
    expect(plan.skipped).toEqual({ ...noSkips, noLocalRecord: 1 });
  });

  it("keeps candidates apart — the same key under another candidate is not a match", () => {
    const plan = planTagReconciliation({
      targetOnlyTags: [tag("c2", "key", "housing")],
      sourceTags: [],
      sourceRecords: [recordRow({ candidate_id: "c1" })],
      rekeys: [],
    });
    expect(plan.removals).toHaveLength(0);
    expect(plan.skipped).toEqual({ ...noSkips, noLocalRecord: 1 });
  });

  it("re-addresses a ledger-rekeyed record's tags to the NEW key and judges them there", () => {
    // The target still holds old-key; the local edit moved the row to new-key
    // and dropped the 'housing' tag in the same pass (the roll-call importer's
    // normalization does exactly this). The rekey runs first in apply, so the
    // delete must name the new key.
    const sourceRow = recordRow({ record_identity_key: "new-key" });
    const plan = planTagReconciliation({
      targetOnlyTags: [tag("c1", "old-key", "housing"), tag("c1", "old-key", "budget")],
      sourceTags: [tag("c1", "new-key", "budget")],
      sourceRecords: [sourceRow],
      rekeys: [{ sourceRow, oldKey: "old-key", via: "transition" }],
    });
    expect(plan.records).toEqual([
      {
        candidate_id: "c1",
        target_record_identity_key: "old-key",
        local_record_identity_key: "new-key",
        matched_via: "transition",
        remove: ["housing"],
        keep: ["budget"],
      },
    ]);
    expect(plan.removals).toEqual([
      { candidate_id: "c1", record_identity_key: "new-key", research_area_slug: "housing" },
    ]);
    // 'budget' survives the rekey under the new key: a planned upsert, not a removal.
    expect(plan.skipped).toEqual({ ...noSkips, carriedByRekey: 1 });
  });

  it("skips a record matched only by the similarity heuristic", () => {
    const sourceRow = recordRow({ record_identity_key: "new-key" });
    const plan = planTagReconciliation({
      targetOnlyTags: [tag("c1", "old-key", "housing")],
      sourceTags: [],
      sourceRecords: [sourceRow],
      rekeys: [{ sourceRow, oldKey: "old-key", via: "similarity" }],
    });
    expect(plan.removals).toHaveLength(0);
    expect(plan.skipped).toEqual({ ...noSkips, similarityRekeyOnly: 1 });
  });

  it("is empty when source and target agree", () => {
    const plan = planTagReconciliation({
      targetOnlyTags: [],
      sourceTags: [tag("c1", "key", "budget")],
      sourceRecords: [recordRow({})],
      rekeys: [],
    });
    expect(plan).toEqual({ records: [], removals: [], skipped: noSkips });
  });

  it("orders records and slugs deterministically so the report and the wire rows are stable", () => {
    const plan = planTagReconciliation({
      targetOnlyTags: [tag("c2", "k", "z"), tag("c1", "k2", "b"), tag("c1", "k1", "y"), tag("c1", "k2", "a")],
      sourceTags: [],
      sourceRecords: [
        recordRow({ candidate_id: "c1", record_identity_key: "k1" }),
        recordRow({ candidate_id: "c1", record_identity_key: "k2" }),
        recordRow({ candidate_id: "c2", record_identity_key: "k" }),
      ],
      rekeys: [],
    });
    expect(plan.records.map((r) => [r.candidate_id, r.local_record_identity_key, r.remove])).toEqual([
      ["c1", "k1", ["y"]],
      ["c1", "k2", ["a", "b"]],
      ["c2", "k", ["z"]],
    ]);
  });
});

describe("guardedCandidateIds", () => {
  const records = [{ candidate_id: "c1" }, { candidate_id: "c1" }, { candidate_id: "c2" }];
  const removals = [{ candidate_id: "c2" }, { candidate_id: "c3" }];

  it("covers removal-only candidates under --reconcile-tags, so a deletion never skips the identity guards", () => {
    // c3 has no record being written — only a tag being removed — and must
    // still be fingerprinted: a same-key roll-call record on a drifted target
    // could belong to a different person under the same UUID.
    expect(guardedCandidateIds({ preflightRecords: records, removals, reconcileTags: true }).sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("leaves removal-only candidates out when reconciliation is off, since nothing will be deleted", () => {
    expect(guardedCandidateIds({ preflightRecords: records, removals, reconcileTags: false }).sort()).toEqual([
      "c1",
      "c2",
    ]);
  });
});

describe("REKEY_RECORDS_SQL", () => {
  it("updates in place — never deletes, inserts, or issues DDL", () => {
    expect(REKEY_RECORDS_SQL).toMatch(/UPDATE public\.candidate_records/);
    expect(REKEY_RECORDS_SQL).not.toMatch(/\bDELETE\b/i);
    expect(REKEY_RECORDS_SQL).not.toMatch(/\bINSERT\b/i);
    expect(REKEY_RECORDS_SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(REKEY_RECORDS_SQL).not.toMatch(/\bDROP\b/i);
  });

  it("addresses rows by the OLD key and never touches created_at, so the row keeps its id and research date", () => {
    expect(REKEY_RECORDS_SQL).toMatch(/record_identity_key = s\.old_key/);
    expect(REKEY_RECORDS_SQL).not.toMatch(/created_at/);
  });

  it("rekeyWireRows carries the new key and the old key side by side", () => {
    const sourceRow: RecordRow = {
      candidate_id: "c1",
      record_identity_key: "new-key",
      description: "d",
      source_url: "u",
      event_date: "2024-01-01",
      created_at_utc: "2026-01-01 00:00:00.000000", retired_at_utc: null, retired_reason: null,
      origin: "manual",
      origin_run_id: "run-9",
    };
    expect(rekeyWireRows([{ sourceRow, oldKey: "old-key", via: "transition" }])).toEqual([
      {
        candidate_id: "c1",
        old_key: "old-key",
        record_identity_key: "new-key",
        description: "d",
        source_url: "u",
        event_date: "2024-01-01",
        origin: "manual",
        origin_run_id: "run-9",
        retired_at_utc: null,
        retired_reason: null,
      },
    ]);
  });
});

describe("candidate identity fingerprints", () => {
  const local = { candidate_id: "c1", display_name: "jane doe", state: "CA" };

  it("passes when the target's uuid names the same person", () => {
    expect(diffCandidateFingerprints([local], [{ ...local }])).toEqual([]);
  });

  it("flags a uuid that names a different person on the target", () => {
    // FK and uniqueness checks cannot catch this: the uuid exists, so records
    // would be filed under the wrong candidate and the tag remap would
    // faithfully follow them there.
    const conflicts = diffCandidateFingerprints(
      [local],
      [{ candidate_id: "c1", display_name: "john smith", state: "CA" }]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.source).toBe("jane doe (CA)");
    expect(conflicts[0]!.target).toBe("john smith (CA)");
  });

  it("flags a same-name candidate in a different state", () => {
    expect(
      diffCandidateFingerprints([local], [{ ...local, state: "TX" }])
    ).toHaveLength(1);
  });

  it("leaves absent candidates to the missing-parent check", () => {
    expect(diffCandidateFingerprints([local], [])).toEqual([]);
  });
});

describe("findIdentityKeyMismatches", () => {
  const buildKey = (input: { description: string; sourceUrl: string; eventDate: string }) =>
    `key:${input.description}|${input.sourceUrl}|${input.eventDate}`;

  const row = {
    candidate_id: "c1",
    record_identity_key: "key:desc|https://x|2026-01-01",
    description: "desc",
    source_url: "https://x",
    event_date: "2026-01-01",
    created_at_utc: "2026-01-01 00:00:00.000000", retired_at_utc: null, retired_reason: null,
    origin: null,
    origin_run_id: null,
  };

  it("accepts a row whose stored key matches its own content", () => {
    expect(findIdentityKeyMismatches([row], buildKey)).toEqual([]);
  });

  it("flags a row edited without recomputing its key", () => {
    const edited = { ...row, description: "edited after the fact" };
    const mismatches = findIdentityKeyMismatches([edited], buildKey);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.stored).not.toBe(mismatches[0]!.computed);
  });
});

describe("assertTransportableArrays", () => {
  const label = {
    source: "CALIFORNIA_SOS",
    committee_id: "1",
    cycle: 2026,
    committee_name: "n",
    label: "l",
    source_urls: ["https://a"],
    researched_at_utc: "2026-01-01 00:00:00.000000",
    source_urls_ndims: 1,
    source_urls_lower: 1,
  };

  it("accepts a one-dimensional, one-based array", () => {
    expect(() => assertTransportableArrays([label])).not.toThrow();
  });

  it("refuses a multidimensional array rather than silently flattening it", () => {
    expect(() => assertTransportableArrays([{ ...label, source_urls_ndims: 2 }])).toThrow(
      /one-dimensional/
    );
  });

  it("refuses a non-one-based array", () => {
    expect(() => assertTransportableArrays([{ ...label, source_urls_lower: 0 }])).toThrow(
      /one-based/
    );
  });
});

describe("countUnresolvedTags", () => {
  function fakeClient() {
    const calls: unknown[][] = [];
    return {
      calls,
      client: {
        query: async (_text: string, values?: readonly unknown[]) => {
          calls.push(values as unknown[]);
          return { rows: [{ unresolved: 1 }], rowCount: 1 };
        },
      },
    };
  }

  const tag = (index: number) => ({
    candidate_id: `c${index}`,
    record_identity_key: "k",
    research_area_slug: "s",
    stance: null,
  });

  it("sums unresolved tags across batches so none can be silently dropped", async () => {
    // 501 rows crosses the 500-row batch boundary, so this actually exercises
    // the accumulation. At 3 rows it was one query and the sum was untested.
    const { calls, client } = fakeClient();
    expect(await countUnresolvedTags(client, Array.from({ length: 501 }, (_, i) => tag(i)))).toBe(2);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]![0] as string)).toHaveLength(500);
    expect(JSON.parse(calls[1]![0] as string)).toHaveLength(1);
  });

  it("issues no query when there are no tags to check", async () => {
    const { calls, client } = fakeClient();
    expect(await countUnresolvedTags(client, [])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("readCandidateScope", () => {
  it("reads one uuid per line, ignoring blanks and comments, and rejects junk", async () => {
    const { mkdtemp, writeFile: write } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "scope-"));
    const ok = join(dir, "ok.txt");
    await write(ok, "# scope\n11111111-2222-4333-8444-555555555555\n\n11111111-2222-4333-8444-555555555555\n");
    const scope = await readCandidateScope(ok);
    expect([...scope]).toEqual(["11111111-2222-4333-8444-555555555555"]);
    const bad = join(dir, "bad.txt");
    await write(bad, "not-a-uuid\n");
    await expect(readCandidateScope(bad)).rejects.toThrow(/not a uuid/);
    const empty = join(dir, "empty.txt");
    await write(empty, "# nothing\n");
    await expect(readCandidateScope(empty)).rejects.toThrow(/empty/);
  });
});

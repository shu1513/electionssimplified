import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseBlockerKey,
  parseFlags,
  runCommand,
  type DeferralClient,
} from "../../src/scripts/manualResearchDeferrals.js";

const DISTRICT_ID = "00000000-0000-4000-8000-000000000001";
const ELECTION_ID = "00000000-0000-4000-8000-000000000002";
const EXISTING_ID = "00000000-0000-4000-8000-0000000000ff";
const NEW_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ID = "00000000-0000-4000-8000-0000000000bb";
const OTHER_ID_2 = "00000000-0000-4000-8000-0000000000cc";

type Statement = { text: string; values?: unknown[] };

// Answers the district lookup, the election lookup, and the open-row probe
// (with `existing` or nothing), and records every statement so assertions can
// pin which write path ran.
function fakeClient(
  input: {
    existing?: { reason: string; blocked_until: string };
    // Simulates a row that appears only AFTER the pre-write probe ran: the
    // probe misses, the INSERT hits the unique index, the re-read finds it.
    racedIn?: { reason: string; blocked_until: string };
    // Simulates the --replace target being resolved between probe and UPDATE.
    updateMatchesNothing?: boolean;
    // Other open rows for the same election|district + stage under a
    // different blocker key: what the --replace supersede step closes.
    others?: { id: string; blocker_key: string | null }[];
  } = {}
): {
  client: DeferralClient;
  statements: Statement[];
} {
  const statements: Statement[] = [];
  let probes = 0;
  const client: DeferralClient = {
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      statements.push({ text, values });
      if (text.includes("FROM public.districts")) {
        return { rows: [{ name: "Testville, Ohio" }] as T[] };
      }
      if (text.includes("FROM public.elections")) {
        return { rows: [{ id: ELECTION_ID }] as T[] };
      }
      if (text.includes("SELECT id, reason, blocked_until")) {
        probes += 1;
        // First call is the pre-write probe; a second call is the post-23505
        // re-read, which is where `racedIn` becomes visible.
        const row = probes === 1 ? input.existing : (input.racedIn ?? input.existing);
        return { rows: (row ? [{ id: EXISTING_ID, ...row }] : []) as T[] };
      }
      if (text.includes("SET status = 'cancelled'")) {
        return { rows: (input.others ?? []) as T[] };
      }
      if (text.includes("UPDATE public.manual_research_deferrals")) {
        return { rows: (input.updateMatchesNothing ? [] : [{ id: EXISTING_ID }]) as T[] };
      }
      if (text.includes("INSERT INTO public.manual_research_deferrals")) {
        if (input.racedIn) {
          throw Object.assign(
            new Error('duplicate key value violates unique constraint "uq_..."'),
            { code: "23505" }
          );
        }
        return { rows: [{ id: NEW_ID }] as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  return { client, statements };
}

function printed(): Record<string, unknown> {
  const spy = console.log as unknown as { mock: { calls: unknown[][] } };
  const last = spy.mock.calls.at(-1)?.[0];
  return JSON.parse(String(last)) as Record<string, unknown>;
}

function supersedeStatement(statements: Statement[]): Statement | undefined {
  return statements.find((s) => s.text.includes("SET status = 'cancelled'"));
}

function recordFlags(extra: string[] = []): Map<string, string> {
  return parseFlags([
    "--district-id",
    DISTRICT_ID,
    "--stage",
    "elections",
    "--reason",
    "ballot questions not yet certified",
    "--blocked-until",
    "2026-09-19",
    ...extra,
  ]);
}

describe("parseBlockerKey", () => {
  it("accepts a lowercase slug", () => {
    expect(parseBlockerKey("ballot_measure_family")).toBe("ballot_measure_family");
    expect(parseBlockerKey("office-matcher")).toBe("office-matcher");
    expect(parseBlockerKey(null)).toBeNull();
  });

  // Free text as the discriminator would mint a new row on every retry
  // instead of updating the one already recorded.
  it("rejects free text, capitals, and over-long values", () => {
    expect(() => parseBlockerKey("waiting on the clerk")).toThrow(/short lowercase slug/);
    expect(() => parseBlockerKey("BallotMeasure")).toThrow(/short lowercase slug/);
    expect(() => parseBlockerKey("_leading")).toThrow(/short lowercase slug/);
    expect(() => parseBlockerKey("a".repeat(41))).toThrow(/short lowercase slug/);
  });
});

describe("manual:deferral record", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts when no open row exists, carrying the blocker key", async () => {
    const { client, statements } = fakeClient();
    await runCommand(client, "record", recordFlags(["--blocker-key", "ballot_measure_family"]));

    const insert = statements.find((s) => s.text.includes("INSERT INTO"));
    expect(insert).toBeDefined();
    expect(insert?.values).toContain("ballot_measure_family");
  });

  // The regression this whole change exists for: a second district-wide
  // blocker on the same stage used to silently replace the first.
  it("refuses to overwrite an existing open row and names the escape hatches", async () => {
    const { client, statements } = fakeClient({
      existing: { reason: "judicial retention slate unresolved", blocked_until: "2026-10-05" },
    });

    await expect(runCommand(client, "record", recordFlags())).rejects.toThrow(
      /already exists/
    );
    await expect(runCommand(client, "record", recordFlags())).rejects.toThrow(
      /--blocker-key/
    );

    expect(statements.some((s) => s.text.includes("UPDATE public.manual_research_deferrals"))).toBe(
      false
    );
    expect(statements.some((s) => s.text.includes("INSERT INTO"))).toBe(false);
  });

  // Live 2026-09-21 (Crittenden County AR): the open row had a blank key, the
  // re-record carried no key, and the agent read the no-op as success. The
  // command must refuse in a way that cannot be mistaken for a write.
  it("leads with 'Nothing was written' when a blank-key row blocks a no-key record", async () => {
    const { client, statements } = fakeClient({
      existing: { reason: "shell mismatch hard stop", blocked_until: "2026-09-15" },
    });
    const error = await runCommand(
      client,
      "record",
      recordFlags(["--election-id", ELECTION_ID])
    ).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Nothing was written: an open elections deferral already exists/);
    expect((error as Error).message).toMatch(/--replace/);
    const probe = statements.find((s) => s.text.includes("SELECT id, reason, blocked_until"));
    expect(probe?.values).toEqual([DISTRICT_ID, "elections", ELECTION_ID, null]);
    expect(statements.some((s) => s.text.includes("UPDATE public.manual_research_deferrals"))).toBe(
      false
    );
    expect(statements.some((s) => s.text.includes("INSERT INTO"))).toBe(false);
    expect((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });

  it("names the conflicting row's id, date, and reason so the caller can act", async () => {
    const { client } = fakeClient({
      existing: { reason: "judicial retention slate unresolved", blocked_until: "2026-10-05" },
    });
    await expect(runCommand(client, "record", recordFlags())).rejects.toThrow(
      /judicial retention slate unresolved/
    );
    await expect(runCommand(client, "record", recordFlags())).rejects.toThrow(/2026-10-05/);
    await expect(runCommand(client, "record", recordFlags())).rejects.toThrow(new RegExp(EXISTING_ID));
  });

  it("updates in place when --replace is given", async () => {
    const { client, statements } = fakeClient({
      existing: { reason: "old reason", blocked_until: "2026-10-05" },
    });
    await runCommand(client, "record", recordFlags(["--replace"]));

    const update = statements.find((s) => s.text.includes("UPDATE public.manual_research_deferrals"));
    expect(update).toBeDefined();
    expect(update?.values).toContain(EXISTING_ID);
    expect(statements.some((s) => s.text.includes("INSERT INTO"))).toBe(false);
  });

  // Live 2026-09-21: the old row was keyed `district_discovery_roster` (or
  // blank) and the --replace call used a new key, so --replace inserted a
  // second open row and left the old one for a later session to cancel by
  // hand. --replace now closes every other open row for the same
  // election + stage, whatever its key, and reports which ones.
  it("--replace under a new key inserts and closes the other open rows for the unit", async () => {
    const { client, statements } = fakeClient({
      others: [
        { id: OTHER_ID, blocker_key: "district_discovery_roster" },
        { id: OTHER_ID_2, blocker_key: null },
      ],
    });
    await runCommand(
      client,
      "record",
      recordFlags(["--election-id", ELECTION_ID, "--blocker-key", "voterview-recheck", "--replace"])
    );

    expect(statements.some((s) => s.text.includes("INSERT INTO"))).toBe(true);
    const supersede = supersedeStatement(statements);
    expect(supersede).toBeDefined();
    expect(supersede?.text).toContain("status = 'deferred'");
    expect(supersede?.text).toContain("id <> $4");
    expect(supersede?.values?.slice(0, 4)).toEqual([DISTRICT_ID, "elections", ELECTION_ID, NEW_ID]);
    expect(supersede?.values?.[4]).toMatch(new RegExp(`superseded by deferral ${NEW_ID}`));
    // The write comes first so a failure in the supersede step cannot lose
    // the new deferral.
    const insertAt = statements.findIndex((s) => s.text.includes("INSERT INTO"));
    expect(statements.indexOf(supersede as Statement)).toBeGreaterThan(insertAt);

    const out = printed();
    expect(out.deferral_id).toBe(NEW_ID);
    expect(out.recorded).toBe(true);
    expect(out.superseded).toEqual([
      { id: OTHER_ID, blocker_key: "district_discovery_roster" },
      { id: OTHER_ID_2, blocker_key: null },
    ]);
  });

  it("--replace with a same-key row rewrites it in place and closes the others", async () => {
    const { client, statements } = fakeClient({
      existing: { reason: "old reason", blocked_until: "2026-10-05" },
      others: [{ id: OTHER_ID, blocker_key: "district_discovery_roster" }],
    });
    await runCommand(client, "record", recordFlags(["--election-id", ELECTION_ID, "--replace"]));

    expect(statements.some((s) => s.text.includes("INSERT INTO"))).toBe(false);
    const supersede = supersedeStatement(statements);
    expect(supersede?.values?.slice(0, 4)).toEqual([DISTRICT_ID, "elections", ELECTION_ID, EXISTING_ID]);
    const out = printed();
    expect(out.deferral_id).toBe(EXISTING_ID);
    expect(out.replaced).toBe(true);
    expect(out.superseded).toEqual([{ id: OTHER_ID, blocker_key: "district_discovery_roster" }]);
  });

  it("--replace with no open row at all inserts and reports nothing superseded", async () => {
    const { client, statements } = fakeClient();
    await runCommand(client, "record", recordFlags(["--replace"]));

    expect(statements.some((s) => s.text.includes("INSERT INTO"))).toBe(true);
    // District-wide scope: the supersede step matches election_id IS NULL.
    expect(supersedeStatement(statements)?.values?.slice(0, 3)).toEqual([DISTRICT_ID, "elections", null]);
    const out = printed();
    expect(out.deferral_id).toBe(NEW_ID);
    expect(out.recorded).toBe(true);
    expect(out.superseded).toEqual([]);
  });

  it("a plain record never runs the supersede step", async () => {
    const { client, statements } = fakeClient({
      others: [{ id: OTHER_ID, blocker_key: "district_discovery_roster" }],
    });
    await runCommand(client, "record", recordFlags(["--election-id", ELECTION_ID]));
    expect(supersedeStatement(statements)).toBeUndefined();
    expect(printed().superseded).toBeUndefined();
  });

  // Per-candidate profile deferrals share one election + candidate_profile
  // stage under `profile-<id>` keys (live: up to 7 per election). They are
  // separate units, so a blanket supersede would close other candidates'
  // rechecks.
  it("keeps per-candidate profile rows out of the supersede step", async () => {
    const profileCall = fakeClient({ others: [{ id: OTHER_ID, blocker_key: null }] });
    await runCommand(
      profileCall.client,
      "record",
      parseFlags([
        "--district-id", DISTRICT_ID, "--election-id", ELECTION_ID,
        "--stage", "candidate_profile", "--blocker-key", "profile-4f34a876",
        "--reason", "insufficient public profile", "--blocked-until", "2026-10-21", "--replace",
      ])
    );
    expect(supersedeStatement(profileCall.statements)).toBeUndefined();
    expect(printed().superseded).toEqual([]);

    const electionWide = fakeClient();
    await runCommand(
      electionWide.client,
      "record",
      parseFlags([
        "--district-id", DISTRICT_ID, "--election-id", ELECTION_ID,
        "--stage", "candidate_profile", "--reason", "profiles blocked",
        "--blocked-until", "2026-10-21", "--replace",
      ])
    );
    expect(supersedeStatement(electionWide.statements)?.text).toContain("NOT LIKE 'profile-%'");
  });

  // A distinct blocker key is a distinct row, so the probe must not match the
  // NULL-keyed row and the write must be an INSERT.
  it("scopes the open-row probe by blocker key and election id", async () => {
    const { client, statements } = fakeClient();
    await runCommand(
      client,
      "record",
      recordFlags(["--election-id", ELECTION_ID, "--blocker-key", "office-matcher"])
    );

    const probe = statements.find((s) => s.text.includes("SELECT id, reason, blocked_until"));
    expect(probe?.text).toContain("blocker_key IS NOT DISTINCT FROM");
    expect(probe?.values).toEqual([DISTRICT_ID, "elections", ELECTION_ID, "office-matcher"]);
    expect(statements.some((s) => s.text.includes("INSERT INTO"))).toBe(true);
  });

  // The probe is a read, so two sessions can both miss and both insert. The
  // index stops the second write; this turns the raw 23505 into the same
  // actionable message the probe path produces.
  it("translates a concurrent-insert unique violation into the collision message", async () => {
    const { client } = fakeClient({
      racedIn: { reason: "recorded by the other session", blocked_until: "2026-11-02" },
    });
    const error = await runCommand(client, "record", recordFlags()).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/while this command was running/);
    expect((error as Error).message).toMatch(/recorded by the other session/);
    expect((error as Error).message).toMatch(/2026-11-02/);
    expect((error as Error).message).toMatch(/--blocker-key/);
    expect((error as Error).message).not.toMatch(/23505|duplicate key/);
  });

  it("tells a racing --replace caller to re-run rather than re-offering --replace", async () => {
    const { client } = fakeClient({
      racedIn: { reason: "recorded by the other session", blocked_until: "2026-11-02" },
    });
    const error = await runCommand(client, "record", recordFlags(["--replace"])).catch(
      (e: Error) => e
    );

    expect((error as Error).message).toMatch(/Re-run the same command to apply your --replace/);
    expect((error as Error).message).not.toMatch(/Pick the one that matches your intent/);
  });

  it("rethrows a non-unique-violation insert failure untouched", async () => {
    const boom = new Error("connection terminated");
    const client: DeferralClient = {
      async query<T>(text: string): Promise<{ rows: T[] }> {
        if (text.includes("FROM public.districts")) {
          return { rows: [{ name: "Testville, Ohio" }] as T[] };
        }
        if (text.includes("INSERT INTO")) {
          throw boom;
        }
        return { rows: [] as T[] };
      },
    };
    await expect(runCommand(client, "record", recordFlags())).rejects.toThrow(boom);
  });

  // Regression: the UPDATE must carry its own status guard, or a row another
  // session resolved in the gap gets its reason and date rewritten while
  // staying closed -- and we would print `replaced: true` over it.
  it("guards the --replace update on status and reports when the row was closed underneath it", async () => {
    const { client, statements } = fakeClient({
      existing: { reason: "old reason", blocked_until: "2026-10-05" },
      updateMatchesNothing: true,
    });

    await expect(runCommand(client, "record", recordFlags(["--replace"]))).rejects.toThrow(
      /resolved or cancelled by another session/
    );

    const update = statements.find((s) => s.text.includes("UPDATE public.manual_research_deferrals"));
    expect(update?.text).toContain("status = 'deferred'");
  });

  it("rejects an invalid blocker key before touching the ledger", async () => {
    const { client, statements } = fakeClient();
    await expect(
      runCommand(client, "record", recordFlags(["--blocker-key", "Not A Slug"]))
    ).rejects.toThrow(/Invalid --blocker-key/);
    expect(statements.some((s) => s.text.includes("INSERT INTO"))).toBe(false);
  });
});

describe("manual:deferral due", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Without this the due list cannot tell two same-stage blockers apart.
  it("selects blocker_key so the worklist can itemize blockers", async () => {
    const { client, statements } = fakeClient();
    await runCommand(client, "due", parseFlags([]));
    const select = statements.find((s) => s.text.includes("FROM public.manual_research_deferrals"));
    expect(select?.text).toContain("blocker_key");
  });
});

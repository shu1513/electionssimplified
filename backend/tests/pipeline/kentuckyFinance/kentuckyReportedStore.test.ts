import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateKentuckyReported } from "../../../src/pipeline/kentuckyFinance/kentuckyReportedAggregation.js";
import {
  writeKentuckyReportedComponent,
  kentuckyReportedSourceFacts,
  validateKentuckyReportedClosure,
} from "../../../src/pipeline/kentuckyFinance/kentuckyReportedStore.js";
import {
  readStoredKentuckyReportedComponent,
  attachKentuckyReportedFinance,
} from "../../../src/pipeline/kentuckyFinance/kentuckyReportedReader.js";
import { fixture, receipt, receiver } from "./kentuckyReportedFixture.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of cleanups.splice(0)) await c();
});
async function prepared(count = 1) {
  const f = await fixture("committee", {
    rows: Array.from({ length: count }, (_, i) =>
      receipt({ "From Organization Name": `Synthetic Committee ${i}` }),
    ),
  });
  cleanups.push(f.cleanup);
  const source = await f.source(),
    a = aggregateKentuckyReported(receiver, source),
    { groups, ...controls } = a,
    row = {
      link_id: receiver.linkId,
      election_year: 2026,
      component: "committee",
      candidate_id: receiver.candidateId,
      election_id: receiver.electionId,
      receiver_context: receiver,
      source_facts: kentuckyReportedSourceFacts(source),
      aggregation_controls: controls,
      source_retrieved_at: new Date(source.retrievedAt),
      last_synced_at: new Date(source.completedAt),
    },
    storedGroups = groups.map((g) => ({
      link_id: receiver.linkId,
      election_year: 2026,
      component: "committee",
      group_key: g.key,
      reported_name: g.name,
      source_class: g.sourceClass,
      stance: g.stance,
      amount_cents: String(g.cents),
      occurrence_count: g.occurrences,
    }));
  return { source, a, row, groups: storedGroups };
}
function dbFor(
  p: Awaited<ReturnType<typeof prepared>>,
  options: {
    prior?: Record<string, any>;
    changed?: boolean;
    failGroupWrite?: boolean;
  } = {},
) {
  const statements: string[] = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("SELECT id::text FROM public.ky_candidate"))
        return { rows: [{ id: receiver.linkId }] };
      if (sql.startsWith("SELECT l.id"))
        return {
          rows: [
            options.changed
              ? { ...receiver, candidateName: "Changed Person" }
              : receiver,
          ],
        };
      if (sql.startsWith("SELECT * FROM public.ky_reported_finance_components"))
        return { rows: options.prior ? [options.prior] : [] };
      if (sql.startsWith("SELECT group_key key")) return { rows: p.a.groups };
      if (
        options.failGroupWrite &&
        sql.startsWith("INSERT INTO public.ky_reported_finance_groups")
      )
        throw Error("synthetic_insert_failure");
      return { rows: [] };
    }),
  };
  return { db: { connect: vi.fn(async () => client) }, client, statements };
}
describe("Kentucky independent component transactions and reader closure", () => {
  it("writes only independent tables under locked canonical context", async () => {
    const p = await prepared(),
      d = dbFor(p);
    await expect(
      writeKentuckyReportedComponent({
        db: d.db as any,
        receiver,
        source: p.source,
      }),
    ).resolves.toEqual({ groups: 1, idempotent: false });
    expect(d.statements.at(-1)).toBe("COMMIT");
    expect(
      d.statements
        .filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s))
        .every((s) =>
          /public\.ky_reported_finance_(components|groups)/.test(s),
        ),
    ).toBe(true);
    expect(d.client.release).toHaveBeenCalledOnce();
  });
  it("rolls back on canonical changes before any financial mutation", async () => {
    const p = await prepared(),
      d = dbFor(p, { changed: true });
    await expect(
      writeKentuckyReportedComponent({
        db: d.db as any,
        receiver,
        source: p.source,
      }),
    ).rejects.toThrow("canonical_receiver_changed");
    expect(d.statements.at(-1)).toBe("ROLLBACK");
    expect(d.statements.some((s) => s.startsWith("INSERT"))).toBe(false);
  });
  it("rolls back the whole source/group replacement on insertion failure", async () => {
    const p = await prepared(),
      d = dbFor(p, { failGroupWrite: true });
    await expect(
      writeKentuckyReportedComponent({
        db: d.db as any,
        receiver,
        source: p.source,
      }),
    ).rejects.toThrow("synthetic_insert_failure");
    expect(d.statements.at(-1)).toBe("ROLLBACK");
  });
  it("rejects older source clocks", async () => {
    const p = await prepared(),
      d = dbFor(p, {
        prior: {
          ...p.row,
          source_retrieved_at: new Date(Date.parse(p.source.retrievedAt) + 1),
        },
      });
    await expect(
      writeKentuckyReportedComponent({
        db: d.db as any,
        receiver,
        source: p.source,
      }),
    ).rejects.toThrow("older_source");
    expect(d.statements.some((s) => s.startsWith("DELETE"))).toBe(false);
  });
  it("equal-source replay validates every stored group and preserves clocks", async () => {
    const p = await prepared(),
      d = dbFor(p, { prior: p.row });
    await expect(
      writeKentuckyReportedComponent({
        db: d.db as any,
        receiver,
        source: p.source,
      }),
    ).resolves.toEqual({ groups: 1, idempotent: true });
    expect(d.statements.some((s) => /^(UPDATE|DELETE|INSERT)/.test(s))).toBe(
      false,
    );
  });
  it("equal-source conflict cannot silently repair stored totals", async () => {
    const p = await prepared(),
      d = dbFor(p, {
        prior: {
          ...p.row,
          aggregation_controls: {
            ...p.row.aggregation_controls,
            totalCents: 1,
          },
        },
      });
    await expect(
      writeKentuckyReportedComponent({
        db: d.db as any,
        receiver,
        source: p.source,
      }),
    ).rejects.toThrow("equal_source_conflict");
    expect(d.statements.at(-1)).toBe("ROLLBACK");
  });
  it("rejects unbranded packets before connecting", async () => {
    const p = await prepared(),
      d = dbFor(p);
    await expect(
      writeKentuckyReportedComponent({
        db: d.db as any,
        receiver,
        source: { ...p.source },
      }),
    ).rejects.toThrow("unverified_source");
    expect(d.db.connect).not.toHaveBeenCalled();
  });
  it("replays full stored financial controls, names, groups and counts", async () => {
    const p = await prepared(7);
    expect(
      readStoredKentuckyReportedComponent(p.row, p.groups, receiver),
    ).toEqual(p.a);
  });
  it.each([
    "money",
    "name",
    "count",
    "missing",
    "extra",
    "clock",
    "hash",
    "receiver",
  ])("holds corrupted stored %s", async (type) => {
    const p = await prepared(),
      row = structuredClone(p.row),
      groups = structuredClone(p.groups);
    if (type === "money") groups[0]!.amount_cents = "1";
    if (type === "name") groups[0]!.reported_name = "Invented";
    if (type === "count") groups[0]!.occurrence_count = 10;
    if (type === "missing") groups.pop();
    if (type === "extra") groups.push(groups[0]!);
    if (type === "clock")
      row.source_facts.retrievedAt = "2099-01-01T00:00:00.000Z";
    if (type === "hash") row.source_facts.controls[0]!.sha256 = "bad";
    if (type === "receiver")
      row.receiver_context = { ...receiver, candidateName: "Changed" };
    expect(() =>
      readStoredKentuckyReportedComponent(row, groups, receiver),
    ).toThrow();
  });
  it("sums all seven groups before capping named details to five", async () => {
    const p = await prepared(7);
    vi.stubEnv("KENTUCKY_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("KENTUCKY_REPORTED_COMMITTEE_ENABLED", "true");
    const db = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.startsWith("SELECT l.id")
          ? [receiver]
          : sql.includes("FROM public.ky_reported_finance_components")
            ? [p.row]
            : p.groups,
      })),
    };
    const output = await attachKentuckyReportedFinance({
      db: db as any,
      requests: [
        {
          candidate_id: receiver.candidateId,
          election_id: receiver.electionId,
        },
      ],
      summaries: new Map(),
    });
    const summary = [...output.values()][0]!;
    expect(summary.direct_campaign.total_raised).toBeNull();
    const interests = summary.direct_campaign.pac_money_by_interest!;
    expect(interests[0]!.amount).toBe(7000);
    expect(interests[0]!.pac_count).toBe(7);
    expect(interests[0]!.pacs).toHaveLength(5);
    expect(summary.last_synced_at).toBe(p.source.retrievedAt);
  });
  it("checks aggregate occurrence closure independently of money totals", async () => {
    const p = await prepared();
    expect(() =>
      validateKentuckyReportedClosure({ ...p.a, includedRows: 2 }, "committee"),
    ).toThrow();
  });
  it("notes retained legacy IE only on 2026 summaries", async () => {
    vi.stubEnv("KENTUCKY_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("KENTUCKY_REPORTED_IE_ENABLED", "true");
    const { candidateElectionKey } =
      await import("../../../src/pipeline/address/ballotLookupFinanceShared.js");
    const req = (election: string) => ({
      candidate_id: receiver.candidateId,
      election_id: election,
    });
    const legacy = (cycle: number) =>
      ({ cycle, outside_spending: { support_total: 100 } }) as any;
    const output = await attachKentuckyReportedFinance({
      db: { query: vi.fn(async () => ({ rows: [] })) } as any,
      requests: [req("e2026"), req("e2027")],
      summaries: new Map([
        [candidateElectionKey(receiver.candidateId, "e2026"), legacy(2026)],
        [candidateElectionKey(receiver.candidateId, "e2027"), legacy(2027)],
      ]),
    });
    const note = (election: string) =>
      output.get(candidateElectionKey(receiver.candidateId, election))!
        .outside_spending.outside_coverage_note;
    expect(note("e2026")).toMatch(/retained/);
    expect(note("e2027")).toBeUndefined();
  });
});

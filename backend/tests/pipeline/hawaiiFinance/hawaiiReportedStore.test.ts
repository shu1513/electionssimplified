import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ aggregate: vi.fn() }));
vi.mock("../../../src/pipeline/hawaiiFinance/hawaiiReportedAggregation.js", () => ({
  isHawaiiReceiverPacket: () => true, aggregateHawaiiReported: mocks.aggregate, validateHawaiiReportedClosure: () => {},
}));
vi.mock("../../../src/pipeline/hawaiiFinance/hawaiiReportedReceiver.js", async () => ({
  ...await vi.importActual("../../../src/pipeline/hawaiiFinance/hawaiiReportedReceiver.js"), lockHawaiiReportedReceiver: async () => {},
}));
import { hawaiiReportedSourceFacts, writeHawaiiReportedComponent } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedStore.js";

const t0 = "2026-10-01T00:00:00.000Z", t1 = "2026-10-01T00:01:00.000Z", hash = "a".repeat(64);
const source = { packet: { kind: "ie", acquisitionStartedAt: t0, capturedAt: t1, publisherUpdatedAt: t0, rows: [{}], parentControls: [{}], nativeVersions: 1, supersededVersions: 0 },
  sourceAt: t1, sourceHash: hash, profileAt: t1, profileStartedAt: t0, profileHash: hash, nativeLedgerCents: null } as any;
const receiver = { candidateId: "c", electionId: "e", electionYear: 2026, electionDate: "2026-11-03", candidateName: "Rowan Synthetic", fullName: "Rowan A. Synthetic",
  officeScope: "state_lower", canonicalOffice: "State Lower Chamber Legislator", canonicalDistrict: "99",
  linkId: null, entityId: null, committeeName: null, electionPeriod: null, linkOffice: null, linkDistrict: null };
const group = { key: JSON.stringify(["SYNTHETIC PAC", "support"]), name: "Synthetic PAC", sourceClass: "reported independent spender", evidence: "native_closed_b2", stance: "support", cents: 100, occurrences: 1 };
const controls = { sourceRows: 1, includedRows: 1, totalCents: 100, supportCents: 100, opposeCents: 0 };
function database(prior: any[], storedGroups: any[] = [group]) {
  const client = { query: vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM") ? prior : sql.startsWith("SELECT group_key") ? storedGroups : [] })), release: vi.fn() };
  return { db: { connect: vi.fn(async () => client) } as any, ran: (prefix: string) => client.query.mock.calls.some(([sql]) => String(sql).startsWith(prefix)) };
}
const prior = (receiverContext: unknown) => [{ source_observed_at: t1, receiver_context: receiverContext, source_facts: hawaiiReportedSourceFacts(source), aggregation_controls: controls }];
beforeEach(() => mocks.aggregate.mockReturnValue({ ...controls, groups: [group] }));

describe("Hawaii reported component writer at an equal source clock", () => {
  it("confirms an identical observation without rewriting it", async () => {
    const { db, ran } = database(prior(receiver));
    expect(await writeHawaiiReportedComponent({ db, receiver, source })).toEqual({ groups: 1, idempotent: true });
    expect(ran("INSERT")).toBe(false); expect(ran("COMMIT")).toBe(true);
  });
  it("holds when the same receiver and source reproduce different money", async () => {
    const { db, ran } = database(prior(receiver), [{ ...group, cents: 99 }]);
    await expect(writeHawaiiReportedComponent({ db, receiver, source })).rejects.toThrow("equal_source_conflict");
    expect(ran("ROLLBACK")).toBe(true);
  });
  it("replaces the stored observation when the receiver context changed", async () => {
    const { db, ran } = database(prior({ ...receiver, candidateName: "Former Display Name" }));
    expect(await writeHawaiiReportedComponent({ db, receiver, source })).toEqual({ groups: 1, idempotent: false });
    expect(ran("INSERT INTO public.hi_reported_finance_components")).toBe(true); expect(ran("SELECT group_key")).toBe(false);
  });
});

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { HawaiiReportedHold } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedCore.js";
const mocks = vi.hoisted(() => ({ list: vi.fn(), lock: vi.fn(), write: vi.fn(), aggregate: vi.fn(), packet: vi.fn(), receiver: vi.fn() }));
vi.mock("../../../src/pipeline/hawaiiFinance/hawaiiReportedReceiver.js", async () => ({
  ...await vi.importActual("../../../src/pipeline/hawaiiFinance/hawaiiReportedReceiver.js"),
  listHawaiiReportedReceivers: mocks.list, lockHawaiiReportedReceiver: mocks.lock,
}));
vi.mock("../../../src/pipeline/hawaiiFinance/hawaiiReportedStore.js", () => ({ writeHawaiiReportedComponent: mocks.write }));
vi.mock("../../../src/pipeline/hawaiiFinance/hawaiiReportedAggregation.js", () => ({ aggregateHawaiiReported: mocks.aggregate, loadHawaiiReceiverPacket: mocks.receiver }));
vi.mock("../../../src/pipeline/hawaiiFinance/hawaiiReportedSource.js", () => ({ loadHawaiiReportedPacket: mocks.packet }));
import { syncDueHawaiiReportedFinance } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedBatchSync.js";
const r = { candidateId: "synthetic-candidate", electionId: "synthetic-election", electionDate: "2026-11-03", electionYear: 2026, linkId: null };
function database(stored: any[] = [], attempts: any[] = []) {
  const client = { query: vi.fn(async (sql: string) => ({ rows: sql.startsWith("INSERT") ? [{}] : [] })), release: vi.fn() };
  return { query: vi.fn(async (sql: string) => ({ rows: sql.includes("components") ? stored : attempts })), connect: vi.fn(async () => client) } as any;
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["CANDIDATE_FINANCE_ENABLED", "HAWAII_CAMPAIGN_FINANCE_ENABLED", "HAWAII_REPORTED_COMMITTEE_ENABLED", "HAWAII_INDEPENDENT_IE_ENABLED"]) vi.stubEnv(k, "true");
  mocks.list.mockResolvedValue([r]); mocks.lock.mockResolvedValue(undefined); mocks.write.mockResolvedValue({ groups: 0, idempotent: false });
  mocks.packet.mockImplementation(async (kind: string) => ({ kind })); mocks.receiver.mockImplementation(async (packet: any, receiver: any) => ({ receiver, packet }));
  mocks.aggregate.mockReturnValue({ groups: [], totalCents: 0, supportCents: 0, opposeCents: 0 });
});
afterEach(() => vi.unstubAllEnvs());
describe("Hawaii independent component scheduling", () => {
  it.each(["CANDIDATE_FINANCE_ENABLED", "HAWAII_CAMPAIGN_FINANCE_ENABLED"])("disabled %s performs no DB/source work even with force", async flag => {
    vi.stubEnv(flag, "false"); const db = database(); expect((await syncDueHawaiiReportedFinance({ db, refresh: true })).enabled).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.packet).not.toHaveBeenCalled(); expect(db.query).not.toHaveBeenCalled();
  });
  it("empty cohort does not acquire global IE", async () => {
    mocks.list.mockResolvedValue([]); await syncDueHawaiiReportedFinance({ db: database() }); expect(mocks.packet).not.toHaveBeenCalled();
  });
  it("committee acquisition failure does not suppress unlinked IE", async () => {
    mocks.packet.mockImplementation(async (kind: string) => { if (kind === "committee") throw Error("unavailable"); return { kind }; });
    const result = await syncDueHawaiiReportedFinance({ db: database() });
    expect(result.sourceUnavailableCount).toBe(1); expect(result.ieWrittenCount).toBe(1); expect(result.committeeWrittenCount).toBe(0);
  });
  it("held donor identity does not suppress IE storage", async () => {
    mocks.receiver.mockImplementation(async (packet: any, receiver: any) => { if (packet.kind === "committee") throw new HawaiiReportedHold("direct_receiving_link"); return { receiver, packet }; });
    const result = await syncDueHawaiiReportedFinance({ db: database() }); expect(result.heldCount).toBe(1); expect(result.ieWrittenCount).toBe(1);
  });
  it("an ordinary thrown donor parser error is isolated from other components", async () => {
    mocks.receiver.mockImplementation(async (packet: any, receiver: any) => { if (packet.kind === "committee") throw Error("unavailable"); return { receiver, packet }; });
    const result = await syncDueHawaiiReportedFinance({ db: database() }); expect(result.heldReasons.component_unavailable).toBe(1); expect(result.ieWrittenCount).toBe(1);
  });
  it("fresh components do not fetch sources", async () => {
    const now = new Date("2026-10-19T00:00:00.000Z"), stored = ["committee", "ie"].map(component => ({ candidate_id: r.candidateId, election_id: r.electionId, component, receiver_context: r, last_synced_at: now.toISOString() }));
    expect((await syncDueHawaiiReportedFinance({ db: database(stored), now })).selectedCount).toBe(0); expect(mocks.packet).not.toHaveBeenCalled();
  });
  it("gives each component its own default 25 receivers", async () => {
    mocks.list.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({ ...r, candidateId: String(i).padStart(2, "0") })));
    const result = await syncDueHawaiiReportedFinance({ db: database() }); expect(result.selectedCount).toBe(50); expect(result.attemptedCount).toBe(50);
    expect(result.ieWrittenCount).toBe(25); expect(result.committeeWrittenCount).toBe(25);
  });
  it("a fresh direct component cannot suppress due IE", async () => {
    const now = new Date("2026-10-19T00:00:00.000Z"), stored = [{ candidate_id: r.candidateId, election_id: r.electionId, component: "committee", receiver_context: r, last_synced_at: now.toISOString() }];
    const result = await syncDueHawaiiReportedFinance({ db: database(stored), now }); expect(result.ieWrittenCount).toBe(1); expect(result.committeeWrittenCount).toBe(0);
  });
  it("creating a direct link does not make fresh IE due again", async () => {
    const now = new Date("2026-10-19T00:00:00.000Z");
    mocks.list.mockResolvedValue([{ ...r, linkId: "new-direct-link", entityId: "new-direct-receiver" }]);
    const stored = [{ candidate_id: r.candidateId, election_id: r.electionId, component: "ie", receiver_context: r, last_synced_at: now.toISOString() }];
    const result = await syncDueHawaiiReportedFinance({ db: database(stored), now });
    expect(result.ieWrittenCount).toBe(0); expect(result.committeeWrittenCount).toBe(1);
  });
  it("retains cohort through the February supplemental rerun", async () => {
    expect((await syncDueHawaiiReportedFinance({ db: database(), now: new Date("2027-02-04T00:00:00.000Z") })).eligibleCount).toBe(1);
    expect((await syncDueHawaiiReportedFinance({ db: database(), now: new Date("2027-02-11T00:00:00.000Z") })).eligibleCount).toBe(0);
  });
});

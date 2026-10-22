import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listDueIndianaNativePac,
  syncDueIndianaNativePac,
} from "../../../src/pipeline/indianaFinance/indianaNativePacBatchSync.js";
import { IN_NATIVE_PAC_REVISION } from "../../../src/pipeline/indianaFinance/indianaNativePacSource.js";
const receiver = {
  linkId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222",
  electionId: "33333333-3333-4333-8333-333333333333",
  electionYear: 2026,
  electionDate: "2026-11-03",
  firstName: "Synthetic",
  lastName: "Candidate",
  candidateAliases: ["Synthetic Candidate"],
  receivingId: "123",
  committeeName: "Synthetic Committee",
  officeScope: "state_lower",
  officeName: "State Lower Chamber Legislator",
  linkOfficeName: "State Lower Chamber Legislator",
  district: "1",
  canonicalDistrictName: "State House District 1; Indiana",
  canonicalDistrictType: "state_lower",
  activeOwnerCount: 1,
};
const now = new Date("2026-10-21T12:00:00.000Z");
function enable() {
  vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
}
afterEach(() => vi.unstubAllEnvs());
describe("Indiana independent native PAC due mechanics", () => {
  it("does not query or connect with the new feature disabled", async () => {
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "false");
    const db = { query: vi.fn(), connect: vi.fn() };
    expect(
      (await syncDueIndianaNativePac({ db: db as never, now })).enabled,
    ).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("uses its own source clock and a 24-hour failed-attempt cooldown", async () => {
    enable();
    const query = vi
      .fn()
      .mockResolvedValue({
        rows: [
          {
            receiver,
            source: null,
            attempt: {
              receiver_context: receiver,
              source_revision: IN_NATIVE_PAC_REVISION,
              last_attempted_at: "2026-10-21T00:00:00.000Z",
            },
          },
        ],
      });
    const db = { query } as never;
    expect((await listDueIndianaNativePac({ db, now })).totalDueRows).toBe(0);
    query.mockResolvedValue({
      rows: [
        {
          receiver,
          source: null,
          attempt: {
            receiver_context: receiver,
            source_revision: IN_NATIVE_PAC_REVISION,
            last_attempted_at: "2026-10-20T12:00:00.000Z",
          },
        },
      ],
    });
    expect((await listDueIndianaNativePac({ db, now })).totalDueRows).toBe(1);
    expect(query.mock.calls[0]![0]).toContain("in_native_pac_sources");
    expect(query.mock.calls[0]![1].slice(1, 3)).toEqual([112, 730]);
  });
  it("holds a fresh unchanged component, retries immediately after canonical drift", async () => {
    enable();
    const source = {
        receiver_context: receiver,
        source_facts: { revision: IN_NATIVE_PAC_REVISION },
        source_observed_at: "2026-10-21T01:00:00.000Z",
      },
      attempt = {
        receiver_context: receiver,
        source_revision: IN_NATIVE_PAC_REVISION,
        last_attempted_at: "2026-10-21T01:00:00.000Z",
      };
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ receiver, source, attempt }] });
    const db = { query } as never;
    expect((await listDueIndianaNativePac({ db, now })).totalDueRows).toBe(0);
    query.mockResolvedValue({
      rows: [
        { receiver: { ...receiver, activeOwnerCount: 2 }, source, attempt },
      ],
    });
    expect((await listDueIndianaNativePac({ db, now })).totalDueRows).toBe(1);
  });
  it("dry-run never stamps attempts or loads originals", async () => {
    enable();
    const db = {
      query: vi
        .fn()
        .mockResolvedValue({
          rows: [{ receiver, source: null, attempt: null }],
        }),
      connect: vi.fn(),
    };
    const out = await syncDueIndianaNativePac({
      db: db as never,
      now,
      dryRun: true,
      linkId: receiver.linkId,
    });
    expect(out.selectedCandidates).toBe(1);
    expect(out.attemptedComponents).toBe(0);
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query.mock.calls[0]![1][3]).toBe(receiver.linkId);
  });
});

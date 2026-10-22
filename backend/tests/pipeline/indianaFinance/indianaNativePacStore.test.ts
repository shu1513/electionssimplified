import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as financialEvidence from "../../../src/pipeline/indianaFinance/indianaNativeFinancialEvidence.js";
import * as receivers from "../../../src/pipeline/indianaFinance/indianaNativeReceiver.js";
import {
  inHash,
  type IndianaNativeOriginal,
} from "../../../src/pipeline/indianaFinance/indianaNativeOriginals.js";
import {
  IndianaNativePacSource,
  type IndianaNativePacPacket,
} from "../../../src/pipeline/indianaFinance/indianaNativePacSource.js";
import {
  readIndianaNativeStoredPac,
  writeIndianaNativePac,
} from "../../../src/pipeline/indianaFinance/indianaNativePacStore.js";

const receiver: receivers.IndianaNativeReceiver = {
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
const clock = (hour: number) =>
  new Date(Date.UTC(2027, 0, 21, hour)).toISOString();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock(12));
  vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
  vi.stubEnv("INDIANA_NATIVE_PAC_RAW_REFRESH_ENABLED", "false");
  vi.spyOn(receivers, "loadIndianaNativeReceiver").mockResolvedValue(receiver);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function packet(
  observed: number,
  completed: number,
  cents: number,
  through = "2026-12-31",
) {
  const gift = {
    url: "https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionDetail.aspx?Synthetic=one",
    cells: [],
    name: "Synthetic PAC",
    committee: receiver.committeeName,
    kind: "Direct" as const,
    day: "2026-12-01",
    cents,
    donorClass: "Political Action Committee" as const,
  };
  const originals: IndianaNativeOriginal[] = [observed, completed].map(
    (hour, index) => ({
      directory:
        "/synthetic/source-originals-00000000-0000-0000-0000-000000000000",
      request: null,
      raw: Buffer.from("synthetic"),
      meta: {
        file: `${String(index + 1).padStart(5, "0")}.original`,
        url: "https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionSearch.aspx",
        method: "GET",
        requestFile: null,
        requestSha256: null,
        status: 200,
        contentType: "text/html",
        startedAt: clock(hour),
        completedAt: clock(hour),
        bytes: 9,
        sha256: inHash("synthetic"),
        eof: true,
      },
    }),
  );
  // Stub HTML qualification while preserving real source branding,
  // manifests, closure checks and protected writer admission checks.
  vi.spyOn(
    financialEvidence,
    "readIndianaNativeFinancialEvidence",
  ).mockReturnValue({
    receiver,
    reports: [
      {
        period: { begin: "2025-01-01", end: "2026-12-31", filed: clock(1) },
        rows: [gift],
        report: {
          file: receiver.receivingId,
          committee: receiver.committeeName,
          committeeClass: "Candidate",
          reportingPeriod: "Synthetic period",
          itemizedReceipts: cents,
          unitemizedReceipts: 0,
          itemizedExpenses: 0,
          unitemizedExpenses: 0,
          contributionsUrl: gift.url,
          expendituresUrl: gift.url,
          returnsUrl: gift.url,
        },
      },
    ],
    supplements: [],
    originals,
    receipts: {
      originals,
      periods: [
        {
          begin: "2025-01-01",
          end: "2026-12-31",
          gifts: [gift],
          cashCents: cents,
          inKindCents: 0,
          all: [gift],
          pac: [gift],
          excludedNonGiftRows: 0,
        },
      ],
    },
  });
  return new IndianaNativePacSource({
    read: async () => originals,
  } as never).get(receiver, through);
}
function storedDb(p: IndianaNativePacPacket) {
  const stored = {
    link_id: receiver.linkId,
    election_year: receiver.electionYear,
    candidate_id: receiver.candidateId,
    election_id: receiver.electionId,
    receiver_context: receiver,
    source_facts: p.facts,
    aggregation_controls: p.controls,
    source_observed_at: p.facts.observedAt,
    source_completed_at: p.facts.completedAt,
    last_synced_at: clock(12),
  };
  const donors = p.groups.map((g) => ({
    donor_key: g.key,
    reported_name: g.name,
    cash_cents: g.cashCents,
    in_kind_cents: g.inKindCents,
    occurrence_count: g.occurrences,
  }));
  expect(readIndianaNativeStoredPac(stored, donors, receiver)).toEqual(p);
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.startsWith("SELECT to_jsonb(s)")) return { rows: [{ stored }] };
      if (sql.startsWith("SELECT * FROM public.in_native_pac_donors"))
        return { rows: donors };
      return { rows: [] };
    }),
  };
  return { client, db: { connect: async () => client } as never };
}

describe("Indiana native PAC evidence ordering", () => {
  it.each([
    [1, 3, "shared earliest observation"],
    [2, 3, "later earliest observation"],
    [0, 5, "regressing earliest observation"],
  ])("rejects stale evidence: %s/%s (%s)", async (observed, completed) => {
    const current = await packet(1, 4, 20000);
    const incoming = await packet(observed, completed, 10000);
    const { db, client } = storedDb(current);
    await expect(
      writeIndianaNativePac({ db, packet: incoming }),
    ).rejects.toThrow("native_pac_source_regression");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(
      client.query.mock.calls.some(([sql]) => /^(INSERT|DELETE)/.test(sql)),
    ).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it("allows newer completion with a shared earliest observation", async () => {
    const old = await packet(1, 3, 10000),
      newer = await packet(1, 4, 20000);
    const { db, client } = storedDb(old);
    await expect(
      writeIndianaNativePac({ db, packet: newer }),
    ).resolves.toMatchObject({ idempotent: false });
    const insert = client.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO public.in_native_pac_sources"),
    );
    expect(insert?.[1]?.[8]).toBe(newer.facts.completedAt);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });
  it("keeps an identical replay idempotent", async () => {
    const current = await packet(1, 4, 20000);
    const { db, client } = storedDb(current);
    await expect(
      writeIndianaNativePac({ db, packet: current }),
    ).resolves.toMatchObject({ idempotent: true });
    expect(
      client.query.mock.calls.some(([sql]) => /^(INSERT|DELETE)/.test(sql)),
    ).toBe(false);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });
  it("caps a January packet's receipt cutoff without backdating fresh observations", async () => {
    const current = await packet(1, 4, 20000, "2027-01-21");
    expect(current.facts.through).toBe("2026-12-31");
    expect(current.facts.regularThrough).toBe("2026-12-31");
    expect(current.facts.observedAt).toBe(clock(1));
    expect(current.facts.completedAt).toBe(clock(4));
  });
});

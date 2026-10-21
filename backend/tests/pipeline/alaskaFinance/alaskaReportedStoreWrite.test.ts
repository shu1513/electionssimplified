import { describe, expect, it, vi } from "vitest";
import {
  akManifestHash,
  type AlaskaOriginalMeta,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedOriginals.js";
import type { AlaskaReportedReceiver } from "../../../src/pipeline/alaskaFinance/alaskaReportedReceiver.js";

const receiver: AlaskaReportedReceiver = {
  linkId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222",
  electionId: "33333333-3333-4333-8333-333333333333",
  electionYear: 2026,
  electionDate: "2026-11-03",
  firstName: "Jane",
  lastName: "Doe",
  receivingId: "R1",
  legacyCommitteeName: "Jane Doe",
  candidateAliases: ["Jane Doe"],
  officeScope: "state_lower",
  officeName: "State Lower Chamber Legislator",
  linkOfficeName: "State Lower Chamber Legislator",
  district: "7",
  canonicalDistrictName: "State House District 7; Alaska",
  canonicalDistrictType: "state_lower",
  activeCandidateOwnerCount: 1,
};
vi.mock(
  "../../../src/pipeline/alaskaFinance/alaskaReportedEligibility.js",
  () => ({ loadAlaskaReportedReceiver: async () => receiver }),
);
vi.mock(
  "../../../src/pipeline/alaskaFinance/alaskaReportedSource.js",
  () => ({ isVerifiedAlaskaReportedPacket: () => true }),
);
import { writeAlaskaReportedComponent } from "../../../src/pipeline/alaskaFinance/alaskaReportedStore.js";

const observation = (
  file: string,
  startedAt: string,
  completedAt: string,
): AlaskaOriginalMeta => ({
  url: "https://aws.state.ak.us/ApocReports/IndependentExpenditures/IEExpenditures.aspx",
  file,
  requestFile: null,
  requestSha256: null,
  method: "GET",
  status: 200,
  contentType: "text/html",
  startedAt,
  completedAt,
  bytes: 1,
  sha256: "a".repeat(64),
  eof: true,
});
const roster = observation(
  "00001.original",
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T00:00:01.000Z",
);
const fresh = observation(
  "00002.original",
  "2026-01-03T00:00:00.000Z",
  "2026-01-03T00:00:01.000Z",
);
function packet(observations: AlaskaOriginalMeta[], amountCents: number) {
  return {
    component: "ie" as const,
    receiver,
    receiving: {
      receivingId: "R1",
      candidateName: "Jane Doe",
      committeeName: "Jane Doe",
      officeName: receiver.officeName,
      district: "7",
      electionYear: 2026,
      registrationHref: null,
    },
    groups: [
      {
        key: "GROUP A",
        reportedName: "Group A",
        stance: "support" as const,
        amountCents,
        occurrenceCount: 1,
      },
    ],
    controls: {
      totalAmountCents: amountCents,
      occurrenceCount: 1,
      sourceRows: 1,
      excludedRows: 0,
      debtRows: 0,
      supportCents: amountCents,
      opposeCents: 0,
    },
    source: {
      manifestSha256: akManifestHash(observations),
      observedAt: observations.map((o) => o.startedAt).sort()[0]!,
      completedAt: observations.map((o) => o.completedAt).sort().at(-1)!,
      observations,
    },
  };
}
function storedRow(p: ReturnType<typeof packet>) {
  return {
    row: {
      link_id: receiver.linkId,
      candidate_id: receiver.candidateId,
      election_id: receiver.electionId,
      election_year: receiver.electionYear,
      component: "ie",
      receiver_context: receiver,
      receiving_context: p.receiving,
      source_facts: {
        revision: "ak-current-native-v3",
        year: 2026,
        component: "ie",
        source: p.source,
      },
      aggregation_controls: p.controls,
      source_observed_at: p.source.observedAt,
      source_completed_at: p.source.completedAt,
      last_synced_at: "2026-01-05T00:00:00.000Z",
    },
    groups: p.groups.map((g) => ({
      link_id: receiver.linkId,
      election_year: 2026,
      component: "ie",
      group_key: g.key,
      reported_name: g.reportedName,
      stance: g.stance,
      amount_cents: g.amountCents,
      occurrence_count: g.occurrenceCount,
    })),
  };
}
function database(stored: ReturnType<typeof storedRow>) {
  const sql: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes("FROM public.ak_reported_finance_components"))
        return { rows: [stored.row] };
      if (text.includes("FROM public.ak_reported_finance_groups"))
        return { rows: stored.groups };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { db: { connect: async () => client }, sql };
}

describe("Alaska reported component writes", () => {
  it("replaces stored money when fresh originals reuse the oldest observation", async () => {
    const stored = storedRow(packet([roster], 1234)),
      { db, sql } = database(stored);
    const result = await writeAlaskaReportedComponent({
      db: db as never,
      receiver,
      packet: packet([roster, fresh], 2500) as never,
    });
    expect(result).toEqual({ groups: 1, idempotent: false });
    expect(sql.some((s) => s.includes("INSERT INTO public.ak_reported_finance_components"))).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
  });
  it("is idempotent for identical originals and rejects changed money under them", async () => {
    const stored = storedRow(packet([roster], 1234));
    const same = await writeAlaskaReportedComponent({
      db: database(stored).db as never,
      receiver,
      packet: packet([roster], 1234) as never,
    });
    expect(same).toEqual({ groups: 1, idempotent: true });
    const { db, sql } = database(stored);
    await expect(
      writeAlaskaReportedComponent({
        db: db as never,
        receiver,
        packet: packet([roster], 2500) as never,
      }),
    ).rejects.toThrow(/equal_source_conflict/);
    expect(sql.at(-1)).toBe("ROLLBACK");
  });
});

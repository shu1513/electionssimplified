import { describe, expect, it } from "vitest";
import { overlayIndianaNativePac } from "../../../src/pipeline/indianaFinance/indianaNativePacReader.js";
import { readIndianaNativeStoredPac } from "../../../src/pipeline/indianaFinance/indianaNativePacStore.js";
import {
  validateIndianaNativePacClosure,
  type IndianaNativePacPacket,
} from "../../../src/pipeline/indianaFinance/indianaNativePacSource.js";
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
const groups = Array.from({ length: 8 }, (_, n) => ({
  key: `SYNTHETIC ${n}`,
  name: `Synthetic ${n}`,
  cashCents: 8000 - n * 100,
  inKindCents: 0,
  occurrences: 1,
}));
const packet = {
  receiver,
  groups,
  controls: {
    cashCents: 61200,
    inKindCents: 0,
    totalCents: 61200,
    occurrences: 8,
    allRows: 10,
    pacRows: 8,
    excludedNonGiftRows: 0,
    regularReports: 3,
    coveredSupplements: 0,
  },
  facts: {
    from: "2025-01-01",
    through: "2026-10-21",
    regularThrough: "2026-10-09",
    observedAt: "2026-10-21T10:00:00.000Z",
    completedAt: "2026-10-21T11:00:00.000Z",
  },
} as IndianaNativePacPacket;
describe("Indiana native PAC display", () => {
  it("keeps full sums and reported-name count before the five-name display cap", () => {
    expect(() =>
      validateIndianaNativePacClosure(packet.controls, packet.groups),
    ).not.toThrow();
    const s = overlayIndianaNativePac(undefined, packet),
      p = s.direct_campaign.pac_money_by_interest![0]!;
    expect(p.amount).toBe(612);
    expect(p.pac_count).toBe(8);
    expect(p.pacs).toHaveLength(5);
    expect(s.outside_spending.support_total).toBeNull();
    expect(s.outside_spending.oppose_total).toBeNull();
    expect(s.direct_campaign.total_raised).toBeNull();
    expect(s.direct_campaign.pac_money_coverage_note).toContain(
      "Reported-name groups",
    );
    expect(() =>
      validateIndianaNativePacClosure(
        packet.controls,
        packet.groups.slice(0, 5),
      ),
    ).toThrow("native_pac_full_group_closure");
  });
  it("preserves legacy direct amounts and headline clock while replacing the old PAC-backed chart", () => {
    const base = overlayIndianaNativePac(undefined, packet);
    base.last_synced_at = "2026-09-01T00:00:00.000Z";
    base.direct_campaign.total_raised = 1234;
    base.backing_summary.top_pac_backed_industries = [
      {
        category_name: "synthetic",
        amount: 100,
        contributor_count: 1,
        source_url: null,
        explanation: "Synthetic",
        supporting_organizations: [],
      },
    ];
    const result = overlayIndianaNativePac(base, packet);
    expect(result.direct_campaign.total_raised).toBe(1234);
    expect(result.last_synced_at).toBe(base.last_synced_at);
    expect(result.backing_summary.top_pac_backed_industries).toEqual([]);
    expect(base.backing_summary.top_pac_backed_industries).toHaveLength(1);
  });
  it("rejects changed canonical ownership before reading stored money", () => {
    expect(() =>
      readIndianaNativeStoredPac(
        {
          link_id: receiver.linkId,
          election_year: 2026,
          candidate_id: receiver.candidateId,
          election_id: receiver.electionId,
          receiver_context: receiver,
        },
        [],
        { ...receiver, activeOwnerCount: 2 },
      ),
    ).toThrow("stored_native_pac_context_changed");
  });
});

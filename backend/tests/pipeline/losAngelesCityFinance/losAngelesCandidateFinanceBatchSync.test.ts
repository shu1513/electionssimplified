import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncDueLosAngelesCandidateFinance } from "../../../src/pipeline/losAngelesCityFinance/losAngelesCandidateFinanceBatchSync.js";
import { syncLosAngelesCandidateFinance } from "../../../src/pipeline/losAngelesCityFinance/losAngelesCandidateFinanceSync.js";
import {
  getLosAngelesEthicsCandidateTotals,
  type LosAngelesEthicsCandidateTotal,
} from "../../../src/pipeline/losAngelesCityFinance/losAngelesCityEthicsClient.js";

vi.mock(
  "../../../src/pipeline/losAngelesCityFinance/losAngelesCityEthicsClient.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getLosAngelesEthicsCandidateTotals: vi.fn(),
  }),
);
vi.mock(
  "../../../src/pipeline/losAngelesCityFinance/losAngelesCandidateFinanceSync.js",
  () => ({ syncLosAngelesCandidateFinance: vi.fn() }),
);

const NOW = new Date("2026-07-12T00:00:00.000Z");

function candidateTotal(
  officeName: string,
  candidatePersonId: string,
): LosAngelesEthicsCandidateTotal {
  return {
    electionId: "76",
    electionSeatId: "276",
    electionSeatCandidateId: `seat-${candidatePersonId}`,
    candidatePersonId,
    candidateName: officeName === "Mayor" ? "Alex Mayor" : "Casey Controller",
    officeName,
    reportedThrough: "2026-07-01",
    fppcCommitteeId: `committee-${candidatePersonId}`,
    committeeName: `${officeName} Committee`,
    internalCommitteePersonId: null,
    totalContributions: 100,
    totalExpenditures: 50,
    cashOnHand: 50,
    matchingFunds: 0,
    outsideSupportTotal: 0,
    outsideOpposeTotal: 0,
    membershipSupportTotal: 0,
    membershipOpposeTotal: 0,
    sourceUrl: "https://ethics.lacity.gov/election/76",
  };
}

function dueRow(
  officeName: string,
  candidatePersonId: string,
  seatNumber: number | null = null,
) {
  return {
    candidate_id: `candidate-${candidatePersonId}`,
    election_id: `election-${candidatePersonId}`,
    candidate_name: officeName === "Mayor" ? "Alex Mayor" : "Casey Controller",
    election_year: 2026,
    election_date: "2026-06-02",
    office_name: officeName,
    seat_number: seatNumber,
    ethics_election_id: "76",
    ethics_candidate_person_id: candidatePersonId,
    last_synced_at: null,
    total_due_rows: "2",
  };
}

describe("Los Angeles candidate finance batch sync", () => {
  beforeEach(() => {
    vi.mocked(getLosAngelesEthicsCandidateTotals).mockImplementation(
      async ({ officeName }) => [
        candidateTotal(officeName, officeName === "Mayor" ? "101" : "202"),
      ],
    );
    vi.mocked(syncLosAngelesCandidateFinance).mockResolvedValue({
      linkWritten: true,
      reportedCommitteeCashGroupCount: 0,
      reportedCommitteeCashCents: 0,
      reportedCommitteeCashGiftCount: 0,
      directBreakdownCount: 0,
      outsideGroupCount: 0,
      reconciledContributionTotal: 100,
      headlineContributionTotal: 100,
      reconciliationDifference: 0,
    });
  });

  it("caches candidate totals by election and office", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [dueRow("Mayor", "101"), dueRow("Municipal Controller", "202")],
        rowCount: 2,
      }),
      connect: vi.fn(),
    };

    await expect(
      syncDueLosAngelesCandidateFinance({
        db,
        now: NOW,
        autoLinkMissingLinks: false,
      }),
    ).resolves.toMatchObject({
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 2,
      failedCandidateCount: 0,
    });
    expect(getLosAngelesEthicsCandidateTotals).toHaveBeenCalledTimes(2);
    expect(getLosAngelesEthicsCandidateTotals).toHaveBeenNthCalledWith(
      2,
      { electionId: "76", officeName: "City Controller" },
      undefined,
    );
    expect(syncLosAngelesCandidateFinance).toHaveBeenCalledTimes(2);
    expect(syncLosAngelesCandidateFinance).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ officeName: "Municipal Controller" }),
    );
  });

  it("syncs council links through their stored exact seat", async () => {
    vi.mocked(getLosAngelesEthicsCandidateTotals).mockResolvedValue([
      candidateTotal("Council District 3", "303"),
    ]);
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [dueRow("City Council Member", "303", 3)],
        rowCount: 1,
      }),
      connect: vi.fn(),
    };

    await expect(
      syncDueLosAngelesCandidateFinance({
        db,
        now: NOW,
        autoLinkMissingLinks: false,
      }),
    ).resolves.toMatchObject({
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(getLosAngelesEthicsCandidateTotals).toHaveBeenCalledWith(
      { electionId: "76", officeName: "Council District 3" },
      undefined,
    );
    expect(syncLosAngelesCandidateFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        officeName: "City Council Member",
        seatNumber: 3,
      }),
    );
  });

  it("syncs only exact LAUSD board links through their stored seat", async () => {
    vi.mocked(getLosAngelesEthicsCandidateTotals).mockResolvedValue([
      candidateTotal("LAUSD District 6", "13549"),
    ]);
    const query = vi.fn().mockResolvedValue({
      rows: [dueRow("School Board Member", "13549", 6)],
      rowCount: 1,
    });
    await expect(
      syncDueLosAngelesCandidateFinance({
        db: { query, connect: vi.fn() },
        now: NOW,
        autoLinkMissingLinks: false,
      }),
    ).resolves.toMatchObject({
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "district.geoid_compact='0622710' AND link.office_name='School Board Member'",
    );
    expect(getLosAngelesEthicsCandidateTotals).toHaveBeenCalledWith(
      { electionId: "76", officeName: "LAUSD District 6" },
      undefined,
    );
    expect(syncLosAngelesCandidateFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        officeName: "School Board Member",
        seatNumber: 6,
      }),
    );
  });
});

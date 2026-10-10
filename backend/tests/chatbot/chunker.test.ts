import { describe, expect, it } from "vitest";

import type { BallotLookupElection } from "../../src/pipeline/address/ballotLookup.js";
import {
  CONTENT_MAX_CHARS,
  extractChunksFromElection,
  formatElectionDateProse,
} from "../../src/chatbot/chunker.js";
import { dedupeChunkDrafts } from "../../src/chatbot/indexer.js";

// Minimal-but-typed election detail payload. Only the fields the chunker
// reads are meaningful; the rest satisfy the type.
function makeElection(overrides: Partial<BallotLookupElection> = {}): BallotLookupElection {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    district_id: "22222222-2222-2222-2222-222222222222",
    district: {
      id: "22222222-2222-2222-2222-222222222222",
      geoid_compact: "0400000US13",
      name: "Georgia",
      district_type: "statewide",
      state: "GA",
      representation_power_score: null,
      population: null,
    },
    race_type: "office",
    official_ballot_title: "US Senate",
    sub_district_seat: null,
    election_date: "2026-11-03",
    election_stage: "general",
    is_partisan: true,
    seats_to_fill: 1,
    discovery_contest_family: "us_senate",
    sources: ["https://sos.ga.gov/elections"],
    candidates: [
      {
        candidate_election_id: "33333333-3333-3333-3333-333333333333",
        candidate_id: "44444444-4444-4444-4444-444444444444",
        display_name: "Jon Ossoff",
        party: "Democratic",
        is_incumbent: true,
        status: "declared",
        summary: "Incumbent US Senator for Georgia.",
        current_office: "US Senator",
        state: "GA",
        fec_ids: [],
        state_filing_ids: [],
        records: [
          {
            id: "55555555-5555-5555-5555-555555555555",
            description: "Voted yes on the infrastructure bill.",
            source_url: "https://www.congress.gov/roll-call",
            event_date: "2025-03-14",
            created_at: "2025-03-15T00:00:00Z",
            research_area_tags: [
              { research_area_id: "r1", slug: "infrastructure", name: "Infrastructure", stance: "for" },
            ],
          },
        ],
        finance_summary: {
          source: "FEC",
          cycle: 2026,
          fec_candidate_id: "S0GA00001",
          last_synced_at: "2026-08-01T00:00:00Z",
          direct_campaign: {
            total_raised: 77_300_000,
            total_spent: 40_000_000,
            cash_on_hand: 37_300_000,
            debts_owed: 0,
            top_occupations: [
              { category_name: "Attorney", amount: 1_000_000, contributor_count: 500, source_url: null },
            ],
            top_industries: [],
          },
          outside_spending: { support_total: 2_000_000, oppose_total: 5_000_000 },
        },
      },
    ],
    candidate_roster_status: null,
    ballot_measure: null,
    results: [],
    office: null,
    research_areas: [],
    historical_competitiveness: null,
    vote_power: {
      score: 1,
      level: "high",
      components: {},
      explanation: {},
    } as unknown as BallotLookupElection["vote_power"],
    ...overrides,
  };
}

describe("chatbot chunker", () => {
  it("produces election, profile, record, and finance chunks with prose dates", () => {
    const chunks = extractChunksFromElection(makeElection());
    const byType = new Map(chunks.map((chunk) => [chunk.sourceType, chunk]));

    expect(chunks).toHaveLength(4);
    const election = byType.get("election");
    expect(election?.content).toContain("US Senate");
    expect(election?.content).toContain("November 3, 2026");
    expect(election?.content).toContain("Jon Ossoff (Democratic, incumbent)");
    expect(election?.sourceId).toBe("11111111-1111-1111-1111-111111111111");

    const profile = byType.get("candidate_profile");
    expect(profile?.sourceId).toBe("44444444-4444-4444-4444-444444444444");
    expect(profile?.content).toContain("Incumbent US Senator for Georgia.");
    expect(profile?.state).toBe("GA");

    const record = byType.get("candidate_record");
    expect(record?.chunkKey).toBe("record:55555555-5555-5555-5555-555555555555");
    expect(record?.content).toContain("infrastructure bill");
    expect(record?.content).toContain("Infrastructure (for)");
    expect(record?.evidenceUrls).toEqual(["https://www.congress.gov/roll-call"]);

    const finance = byType.get("finance_summary");
    expect(finance?.content).toContain("raised $77,300,000");
    expect(finance?.content).toContain("$2,000,000 supporting");
    expect(finance?.content).toContain("Top donor occupations: Attorney");
    // debts_owed of 0 must not read as "owes $0 in debts".
    expect(finance?.content).not.toContain("owes");
  });

  it("emits a ballot measure chunk with yes/no meanings", () => {
    const election = makeElection({
      race_type: "ballot_measure",
      candidates: [],
      official_ballot_title: "Proposition 39",
      ballot_measure: {
        id: "66666666-6666-6666-6666-666666666666",
        official_ballot_title: "Proposition 39",
        summary: "A bond measure.",
        what_yes_means: "The bond is issued.",
        what_no_means: "The bond is not issued.",
        result: null,
        source_urls: ["https://example.gov/prop39"],
        official_measure_url: null,
        proposed_by: {
          name: "State Legislature (SB 5, Sen. Ada Lee)",
          about: "Sen. Lee is a Democrat from Oakland.",
          source_url: "https://legislature.example.gov/sb5",
        },
        research_area_tags: [],
        results: [],
      },
    });
    const chunks = extractChunksFromElection(election);
    const measure = chunks.find((chunk) => chunk.sourceType === "ballot_measure");
    expect(measure?.content).toContain("A yes vote means: The bond is issued.");
    expect(measure?.content).toContain("A no vote means: The bond is not issued.");
    expect(measure?.content).toContain(
      "It was put on the ballot by State Legislature (SB 5, Sen. Ada Lee): Sen. Lee is a Democrat from Oakland."
    );
    // Measure cards link to the election page.
    expect(measure?.sourceId).toBe("11111111-1111-1111-1111-111111111111");
    expect(measure?.electionId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("clamps content below the embedding cap", () => {
    const election = makeElection();
    (election.candidates[0] as { summary: string | null }).summary = "word ".repeat(2000);
    const chunks = extractChunksFromElection(election);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CONTENT_MAX_CHARS);
    }
  });

  it("hashes content deterministically", () => {
    const [a] = extractChunksFromElection(makeElection());
    const [b] = extractChunksFromElection(makeElection());
    expect(a?.contentHash).toBe(b?.contentHash);
  });

  it("dedupes repeated record chunks across elections (shared candidate)", () => {
    const first = extractChunksFromElection(makeElection());
    const second = extractChunksFromElection(
      makeElection({ id: "77777777-7777-7777-7777-777777777777" })
    );
    const deduped = dedupeChunkDrafts([...first, ...second]);
    const recordChunks = deduped.filter((chunk) => chunk.sourceType === "candidate_record");
    expect(recordChunks).toHaveLength(1);
    // Election-scoped chunks stay distinct.
    expect(deduped.filter((chunk) => chunk.sourceType === "election")).toHaveLength(2);
  });
});

describe("formatElectionDateProse", () => {
  it("renders ISO dates as prose", () => {
    expect(formatElectionDateProse("2026-11-03")).toBe("November 3, 2026");
    expect(formatElectionDateProse("2025-01-31")).toBe("January 31, 2025");
  });

  it("passes through unparseable input", () => {
    expect(formatElectionDateProse("unknown")).toBe("unknown");
  });
});

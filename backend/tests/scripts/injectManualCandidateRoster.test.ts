import { describe, expect, it } from "vitest";

import { listRosterNoFecIdExceptions } from "../../src/pipeline/candidates/candidateRosterNoFecIdException.js";
import { buildInjectedCandidateRosterStagingPayload } from "../../src/scripts/injectManualCandidateRoster.js";

describe("buildInjectedCandidateRosterStagingPayload", () => {
  it("preserves raw roster identity hints when staging parsed injected rosters", () => {
    const payload = buildInjectedCandidateRosterStagingPayload({
      electionId: "election-1",
      rawPayload: {
        candidates: [
          {
            display_name: "Jane Candidate",
            roster_index: 7,
            disambiguation_hint: "  incumbent on official filing  ",
            skip_per_election_name_dedupe: true,
            ignored_raw_field: "drop me",
          },
          {
            display_name: "John Candidate",
            roster_index: -1,
            disambiguation_hint: "   ",
            skip_per_election_name_dedupe: "yes",
          },
        ],
      },
      candidates: [
        {
          display_name: "Jane Candidate",
          sources: ["https://example.org/jane"],
        },
        {
          display_name: "John Candidate",
          sources: ["https://example.org/john"],
        },
      ],
    });

    expect(payload).toEqual({
      election_id: "election-1",
      candidates: [
        {
          display_name: "Jane Candidate",
          sources: ["https://example.org/jane"],
          roster_index: 7,
          disambiguation_hint: "incumbent on official filing",
          skip_per_election_name_dedupe: true,
        },
        {
          display_name: "John Candidate",
          sources: ["https://example.org/john"],
        },
      ],
    });
  });

  it("aligns raw hints by original row position when federal filtering drops rows", () => {
    const payload = buildInjectedCandidateRosterStagingPayload({
      electionId: "election-1",
      rawPayload: {
        candidates: [
          {
            display_name: "No Fec Filer",
            disambiguation_hint: "belongs to the dropped row",
          },
          {
            display_name: "Jane Candidate",
            fec_ids: ["S0XX00001"],
            disambiguation_hint: "state senator from Juneau",
          },
        ],
      },
      candidates: [
        {
          display_name: "Jane Candidate",
          fec_ids: ["S0XX00001"],
          sources: ["https://example.org/jane"],
        },
      ],
      keptCandidateIndexes: [1],
    });

    expect(payload).toEqual({
      election_id: "election-1",
      candidates: [
        {
          display_name: "Jane Candidate",
          fec_ids: ["S0XX00001"],
          sources: ["https://example.org/jane"],
          disambiguation_hint: "state senator from Juneau",
        },
      ],
    });
  });
});

describe("manual no-FEC-ID exception staging", () => {
  const exception = {
    reason: "Certified for the ballot; no FEC candidate ID issued.",
    official_roster_url: "https://elections.example.gov/certified",
  };
  const candidates = [
    { display_name: "Rhea Registered", fec_ids: ["H6OH04082"], sources: ["https://example.org/rhea"] },
    {
      display_name: "Ivy Independent",
      no_fec_id_exception: exception,
      sources: ["https://elections.example.gov/certified"],
    },
  ];

  it("stores the exception on the staged row so later refreshes can see it", () => {
    const payload = buildInjectedCandidateRosterStagingPayload({
      electionId: "election-1",
      rawPayload: { candidates },
      candidates,
    });

    expect(payload.candidates[0]).not.toHaveProperty("no_fec_id_exception");
    expect(payload.candidates[1]?.no_fec_id_exception).toEqual(exception);
  });

  it("lists exception rows for the staging audit trail", () => {
    expect(listRosterNoFecIdExceptions(candidates)).toEqual([{ display_name: "Ivy Independent", ...exception }]);
    expect(listRosterNoFecIdExceptions([candidates[0]!])).toEqual([]);
  });
});

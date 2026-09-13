import { describe, expect, it } from "vitest";

import type { CandidateProfilePayload } from "../../src/contracts/candidateProfilePayloadContract.js";
import {
  applyRegularElectionProfileContext,
  applyConfirmedGaps,
  buildCandidateProfileQualityGaps,
  noPublicInfoNextStep,
} from "../../src/scripts/writeManualCandidateProfile.js";

function profile(overrides: Partial<CandidateProfilePayload> = {}): CandidateProfilePayload {
  return {
    display_name: "Jane Candidate",
    first_name: "Jane",
    last_name: "Candidate",
    official_website_url: "https://jane.example",
    summary: "A source-backed profile summary.",
    has_held_public_office: false,
    sources: ["https://jane.example/about"],
    ...overrides,
  };
}

describe("noPublicInfoNextStep", () => {
  const election = {
    election_id: "22222222-2222-4222-8222-222222222222",
    district_id: "11111111-1111-4111-8111-111111111111",
  };

  it("prints the deferral command keyed to the written candidate", () => {
    const step = noPublicInfoNextStep(election, "33333333-3333-4333-8333-333333333333");
    expect(step).toContain("npm run manual:deferral:record -- --district-id 11111111-1111-4111-8111-111111111111");
    expect(step).toContain("--election-id 22222222-2222-4222-8222-222222222222");
    expect(step).toContain("--blocker-key profile-33333333 --stage candidate_profile");
    expect(step).toContain("--replace-profile-fields summary");
  });

  it("leaves the candidate id as a placeholder on a dry run", () => {
    expect(noPublicInfoNextStep(election, "<candidateId>")).toContain("--blocker-key profile-<first 8 chars of candidateId>");
  });
});

describe("writeManualCandidateProfile quality gaps", () => {
  it("does not report a current-office gap when current_office is present", () => {
    const gaps = buildCandidateProfileQualityGaps({
      profile: profile({ current_office: "Governor" }),
      includeParty: false,
    });

    expect(gaps.some((gap) => gap.id === "candidate_profile.current_office")).toBe(false);
  });

  it("reports missing current_office as a focused repair gap", () => {
    const gaps = buildCandidateProfileQualityGaps({
      profile: profile(),
      includeParty: false,
    });

    expect(gaps).toContainEqual(
      expect.objectContaining({
        id: "candidate_profile.current_office",
        outcome: "needs_repair",
        field: "current_office",
        reason: "Candidate current office is missing.",
      })
    );
  });

  it("reports a null office-history routing answer as a focused repair gap", () => {
    const unanswered = buildCandidateProfileQualityGaps({
      profile: profile({ has_held_public_office: null }),
      includeParty: false,
    });
    expect(unanswered).toContainEqual(
      expect.objectContaining({
        id: "candidate_profile.has_held_public_office",
        outcome: "needs_repair",
        field: "has_held_public_office",
      })
    );

    const answered = buildCandidateProfileQualityGaps({
      profile: profile({ has_held_public_office: false }),
      includeParty: false,
    });
    expect(answered.some((gap) => gap.id === "candidate_profile.has_held_public_office")).toBe(false);
  });

  it("lets confirmed-gap mark missing current_office as confirmed_null", () => {
    const gaps = buildCandidateProfileQualityGaps({
      profile: profile(),
      includeParty: false,
    });

    const confirmed = applyConfirmedGaps(gaps, new Set(["candidate_profile.current_office"]));

    expect(confirmed).toContainEqual(
      expect.objectContaining({
        id: "candidate_profile.current_office",
        outcome: "confirmed_null",
      })
    );
  });
});

describe("applyRegularElectionProfileContext", () => {
  it("injects roster FEC IDs and strips fields the regular federal profile path strips", () => {
    const result = applyRegularElectionProfileContext({
      profile: profile({
        party: "Republican",
        state_filing_ids: ["AK-state-id"],
      }),
      researchMode: "federal_us_senate",
      rosterHints: {
        rosterIndex: 0,
        displayName: "Jane Candidate",
        fecIds: ["S6AK00001"],
        stateFilingIds: ["AK-state-id"],
      },
    });

    expect(result.fec_ids).toEqual(["S6AK00001"]);
    expect(result.party).toBeUndefined();
    expect(result.date_of_birth).toBeUndefined();
    expect(result.state_filing_ids).toBeUndefined();
  });

  it("refuses a federal payload that carries date_of_birth instead of silently stripping it", () => {
    expect(() =>
      applyRegularElectionProfileContext({
        profile: profile({
          party: "Republican",
          date_of_birth: "1970-01-01",
        }),
        researchMode: "federal_us_senate",
        rosterHints: {
          rosterIndex: 0,
          displayName: "Jane Candidate",
          fecIds: ["S6AK00001"],
          stateFilingIds: [],
        },
      })
    ).toThrow("payload.date_of_birth is not allowed for federal contests");
  });

  it("keeps date_of_birth for state-level profiles", () => {
    const result = applyRegularElectionProfileContext({
      profile: profile({ party: "Independent", date_of_birth: "1970-01-01" }),
      researchMode: "state_level",
      rosterHints: null,
    });

    expect(result.date_of_birth).toBe("1970-01-01");
  });

  it("requires roster FEC IDs for federal profiles", () => {
    expect(() =>
      applyRegularElectionProfileContext({
        profile: profile(),
        researchMode: "federal_us_senate",
        rosterHints: null,
      })
    ).toThrow("candidate_fec_ids is required in roster context for federal profile import");
  });

  it("injects roster state filing IDs for state-level profiles", () => {
    const result = applyRegularElectionProfileContext({
      profile: profile({ party: "Independent" }),
      researchMode: "state_level",
      rosterHints: {
        rosterIndex: 0,
        displayName: "Jane Candidate",
        fecIds: [],
        stateFilingIds: ["AK-2026-1"],
      },
    });

    expect(result.state_filing_ids).toEqual(["AK-2026-1"]);
    expect(result.party).toBeUndefined();
  });

  it("strips profile state filing IDs when roster state filing IDs are absent", () => {
    const result = applyRegularElectionProfileContext({
      profile: profile({
        party: "Independent",
        state_filing_ids: ["profile-only-id"],
      }),
      researchMode: "state_level",
      rosterHints: null,
    });

    expect(result.state_filing_ids).toBeUndefined();
    expect(result.party).toBeUndefined();
  });
});

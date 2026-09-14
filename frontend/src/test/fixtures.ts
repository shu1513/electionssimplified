// Minimal typed payload builders for page tests. Only the fields the pages
// actually render get non-trivial values; everything else is a quiet default.

import { TERMS_VERSION } from "@voteapp/api-client";
import type {
  BallotSummary,
  CandidateDetail,
  CandidateElection,
  CandidateFollow,
  ElectionDetail,
  ElectionSummary,
  FinanceSummary,
  VotePower,
} from "@voteapp/api-client";

export const ME_VERIFIED = {
  user: {
    id: "user-1",
    email: "voter@example.com",
    first_name: "Sam",
    email_verified: true,
    accepted_terms_version: TERMS_VERSION,
    has_password: true,
  },
};

export const ME_UNVERIFIED = {
  user: {
    id: "user-1",
    email: "voter@example.com",
    first_name: "Sam",
    email_verified: false,
    accepted_terms_version: TERMS_VERSION,
    has_password: true,
  },
};

/** A Google-created account: verified at birth, no password yet. */
export const ME_GOOGLE_NO_PASSWORD = {
  user: {
    id: "user-1",
    email: "voter@gmail.com",
    first_name: "Sam",
    email_verified: true,
    accepted_terms_version: TERMS_VERSION,
    has_password: false,
  },
};

export const VOTE_POWER: VotePower = {
  score: 42,
  label: "high",
  confidence: "medium",
  representation_level: "medium",
  decisiveness_level: "high",
};

// Detail payloads carry a backend-authored explanation; list payloads do not.
export const VOTE_POWER_WITH_EXPLANATION: VotePower = {
  ...VOTE_POWER,
  explanation: {
    how: "What goes into the rating:",
    parts: [
      {
        title: "Representation",
        grade: "Average",
        stat: "50 out of 100",
        detail: "This district is mid-sized for its type, so each vote carries average weight.",
        formula: "score = 100 × ln(9,808,667 ÷ 104,650) ÷ ln(9,808,667 ÷ 1,204) = 50",
      },
      {
        title: "Decisiveness",
        grade: "High",
        stat: "3.3-point margin in 2022",
        detail: "Past results here were very close — a small number of votes could decide the winner.",
        formula: null,
      },
    ],
    result: "Average representation + high decisiveness → My vote power: High.",
    caveat: "Some data is missing.",
  },
};

export const DISTRICT = { id: "dddddddd-1111-4111-8111-111111111111", district_type: "state", name: "Alaska", state: "AK" };

/** GET /api/me/districts body putting the fixture district on the viewer's
 * ballot — pick controls only render for races in the viewer's districts
 * (useMyDistricts), so signed-in pick tests stub this route. Guest tests
 * seed the same id via setDraftBallotContext instead. */
export const MY_DISTRICTS = { district_ids: [DISTRICT.id] };

export function electionSummary(overrides: Partial<ElectionSummary> = {}): ElectionSummary {
  return {
    id: "e-1",
    district_id: DISTRICT.id,
    district: DISTRICT,
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    election_stage: null,
    is_partisan: true,
    candidate_count: 2,
    candidate_roster_status: null,
    ballot_measure_id: null,
    has_results: false,
    current_result_outcome: null,
    office: null,
    research_areas: [],
    historical_competitiveness: null,
    vote_power: VOTE_POWER,
    ...overrides,
  };
}

export function ballotSummary(elections: ElectionSummary[]): BallotSummary {
  return { district_ids: [DISTRICT.id], districts: [DISTRICT], elections };
}

export function electionDetail(overrides: Partial<ElectionDetail> = {}): ElectionDetail {
  return {
    id: "e-1",
    district_id: DISTRICT.id,
    district: DISTRICT,
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    election_stage: null,
    is_partisan: true,
    seats_to_fill: null,
    sources: ["https://elections.example.gov"],
    candidates: [
      {
        candidate_id: "c-1",
        display_name: "Jordan Voter",
        party: "Independent",
        is_incumbent: false,
        status: "active",
        summary: "A candidate summary.",
        finance_summary: null,
        records: [],
      },
      {
        candidate_id: "c-2",
        display_name: "Riley Runner",
        party: "Independent",
        is_incumbent: true,
        status: "active",
        summary: null,
        finance_summary: null,
        records: [],
      },
    ],
    candidate_roster_status: null,
    ballot_measure: null,
    results: [],
    office: null,
    research_areas: [],
    historical_competitiveness: null,
    vote_power: VOTE_POWER,
    ...overrides,
  };
}

export function candidateDetail(
  overrides: Partial<CandidateDetail["candidate"]> = {}
): CandidateDetail {
  return {
    candidate: {
      candidate_id: "c-1",
      display_name: "Jordan Voter",
      party: "Independent",
      state: "AK",
      current_office: null,
      summary: "A candidate summary.",
      twitter_handle: null,
      linkedin_url: null,
      official_website_url: null,
      profile_sources: ["https://example.gov/profile"],
      last_researched: "2026-06-01T00:00:00.000Z",
      records_researched_through: "2026-06-01",
      records: [
        {
          id: "r-1",
          description: "Voted for the clean water act.",
          source_url: "https://example.gov/record",
          event_date: "2026-05-01",
          created_at: "2026-05-02T00:00:00.000Z",
          research_area_tags: [
            { research_area_id: "a-env", slug: "environment", name: "Environment", stance: "for" },
          ],
        },
      ],
      elections: [],
      is_following: false,
      ...overrides,
    },
  };
}

export function candidateElection(overrides: Partial<CandidateElection> = {}): CandidateElection {
  return {
    candidate_election_id: "ce-1",
    election_id: "e-1",
    district: DISTRICT,
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2099-11-03",
    is_incumbent: false,
    status: "active",
    office_canonical_name: null,
    ...overrides,
  };
}

/** A summary with every money field null and every list empty — the shape a
 * state adapter emits when a committee exists but nothing is disclosed yet. */
export function emptyFinanceSummary(): FinanceSummary {
  return {
    source: "FEC",
    cycle: 2026,
    last_synced_at: "2026-07-01T00:00:00.000Z",
    direct_campaign: {
      total_raised: null,
      total_spent: null,
      cash_on_hand: null,
      debts_owed: null,
      top_occupations: [],
      top_industries: [],
    },
    outside_spending: {
      support_total: null,
      oppose_total: null,
      top_supporting_groups: [],
      top_opposing_groups: [],
      top_supporting_industries: [],
      top_opposing_industries: [],
    },
  };
}

/** A fully populated summary covering every section the card renders. */
export function financeSummary(): FinanceSummary {
  return {
    source: "FEC",
    cycle: 2026,
    last_synced_at: "2026-07-01T00:00:00.000Z",
    direct_campaign: {
      total_raised: 120000,
      total_spent: 80000,
      cash_on_hand: 40000,
      debts_owed: 0,
      top_occupations: [
        { category_name: "Retired", amount: 30000, contributor_count: 40, source_url: null },
        { category_name: "Attorney", amount: 20000, contributor_count: 12, source_url: null },
      ],
      top_industries: [
        {
          category_name: "oil_gas_energy",
          amount: 25000,
          contributor_count: 9,
          source_url: "https://www.fec.gov/data/candidate/H0AK00001/",
        },
      ],
    },
    outside_spending: {
      support_total: 50000,
      oppose_total: 20000,
      top_supporting_groups: [
        { committee_id: "pac-1", committee_name: "Growth PAC", support_oppose: "support", amount: 50000, source_url: null },
      ],
      top_opposing_groups: [
        { committee_id: "pac-2", committee_name: "Stop Them PAC", support_oppose: "oppose", amount: 20000, source_url: null },
      ],
      top_supporting_industries: [
        { category_name: "technology", amount: 35000, contributor_count: null, source_url: null },
      ],
      top_opposing_industries: [
        { category_name: "labor_unions", amount: 15000, contributor_count: null, source_url: null },
      ],
    },
    backing_summary: {
      top_outside_supporting_industries: [
        {
          category_name: "technology",
          amount: 35000,
          contributor_count: null,
          source_url: null,
          explanation:
            "The Technology category is a top outside-spending support industry because Google and Anthropic contributed to Growth PAC, which reported independent spending supporting this candidate.",
          supporting_organizations: [
            {
              organization_name: "Google",
              organization_type: "employer",
              amount: 20000,
              contributor_count: 3,
              committee_id: "pac-1",
              committee_name: "Growth PAC",
              source_url: null,
            },
            {
              organization_name: "Anthropic",
              organization_type: "employer",
              amount: 15000,
              contributor_count: 2,
              committee_id: "pac-1",
              committee_name: "Growth PAC",
              source_url: null,
            },
          ],
        },
      ],
    },
  };
}

export function candidateFollow(overrides: Partial<CandidateFollow> = {}): CandidateFollow {
  return {
    candidate_id: "c-1",
    display_name: "Jordan Voter",
    party: "Independent",
    state: "AK",
    current_office: null,
    latest_record: null,
    active_election: null,
    notify_elections: true,
    notify_updates: true,
    created_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Judicial retention fixture shared by grouping and progress regressions. */
export function retentionElection(id: string, overrides: Partial<ElectionSummary> = {}): ElectionSummary {
  return electionSummary({
    id,
    official_ballot_title: `Shall Judge ${id} be retained in office?`,
    candidate_count: 1,
    vote_power: { ...VOTE_POWER, label: "retention", score: null },
    ...overrides,
  });
}

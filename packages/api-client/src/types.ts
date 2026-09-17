// Hand-written mirrors of the backend's JSON payloads (snake_case on the
// wire, kept snake_case here so the mapping is greppable). Only the fields
// Phase 1 renders plus stable identifiers; extend as later phases need more.

export type ResolvedDistrict = {
  id: string;
  district_type: string;
  geoid_compact: string;
  name: string;
  state: string;
  population: number;
  representation_power_score: number | null;
};

export type AddressResolution = {
  matched_address: string;
  // Geocoder candidate count; above 1 means the search was ambiguous and the
  // ballot is for the first match, so the UI must flag the matched address.
  address_match_count: number;
  districts: ResolvedDistrict[];
  // "exact" = geocoded street address, all district types. "zip" = partial
  // ballot from a bare ZIP (statewide, plus county when the ZIP maps to one
  // county). "region" = partial ballot from an area selection (statewide,
  // plus the city when it matches an incorporated place). The UI labels
  // partial results and invites the street address.
  scope: "exact" | "zip" | "region";
};

export type AddressSuggestion = {
  place_id: string;
  description: string;
  main_text: string;
  secondary_text: string;
};

export type AddressAutocompleteResponse = {
  suggestions: AddressSuggestion[];
};

export type AddressLocation = {
  lat: number;
  lng: number;
};

export type AddressRetrieveResponse = {
  address: string;
  // Place coordinates from Google, or null/absent when unavailable — and
  // always null for coarse (zip/region) selections. Held in memory only and
  // sent with resolve so venue addresses missing from the Census street data
  // still find their districts. Never persisted.
  location?: AddressLocation | null;
  // Server-side classification of the selected place. "zip" carries
  // postal_code for the ZIP partial-ballot flow; "region" (city,
  // neighborhood, road…) carries state (and locality when Google names one)
  // for the region partial-ballot flow — without a state the UI can only ask
  // for an address or ZIP. Optional so a stale API omitting it reads as
  // today's "address".
  granularity?: "address" | "zip" | "region";
  postal_code?: string | null;
  state?: string | null;
  locality?: string | null;
};

export type ResearchAreaSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
};

export type OfficeSummary = {
  id: string;
  scope: string;
  canonical_name: string;
  summary: string;
};

// Mirrors VotePowerExplanation (backend votePower.ts): backend-authored,
// ready-to-render copy explaining how the rating was calculated and why this
// election got its rating. Only the election detail payload carries it.
// parts render as a compact formula — one graded row per measure with this
// election's actual numbers — and result states how the grades combine.
export type VotePowerExplanationPart = {
  title: string;
  grade: string;
  stat: string | null;
  detail: string;
  /** Exact scoring formula with this election's real numbers; null when the
   * measure has no numeric input. Optional while pre-formula backends roll. */
  formula?: string | null;
};

export type VotePowerExplanation = {
  how: string;
  parts: VotePowerExplanationPart[];
  result: string;
  caveat: string | null;
};

export type VotePower = {
  score: number | null;
  /** "retention" = a judicial retention race: no rating at all (score
   * null), the ballot list hides the badge and the detail page names the
   * race kind instead. */
  label: "very_low" | "low" | "medium" | "above_average" | "high" | "very_high" | "unknown" | "retention";
  confidence: string;
  representation_level: string;
  decisiveness_level: string;
  /** Present on the election detail payload only. */
  explanation?: VotePowerExplanation;
};

export type HistoricalCompetitiveness = {
  display_label: string;
  display_description: string;
  source: string;
  source_url: string | null;
  election_year: number;
  margin_percent: number;
  competitiveness_label: string;
  stale_after_redistricting: boolean;
};

/**
 * Current-cycle analyst rating. Non-null ONLY when it drove the vote-power
 * decisiveness grade, so render its chip INSTEAD of the historic one when
 * present. Optional field: a not-yet-redeployed backend omits it — treat
 * undefined as null (historic chip).
 */
export type CurrentCompetitiveness = {
  display_label: string;
  display_description: string;
  competitiveness_label: string;
  method: string;
  confidence: string;
  as_of: string;
};

export type BallotDistrict = {
  id: string;
  district_type: string;
  name: string;
  state: string;
};

// Mirrors BallotLookupCandidateRosterStatus (backend ballotLookup.ts): why an
// office election currently shows zero candidates. `reason` is an open enum —
// render unknown values with the generic unavailable copy (formatRosterStatus
// does this) so new backend reasons never break older clients. check_after is
// always a FUTURE date when present.
export type CandidateRosterStatus = {
  reason: "awaiting_official_roster" | "roster_processing" | "candidate_information_unavailable" | (string & {});
  check_after: string | null;
};

export type ElectionSummary = {
  id: string;
  district_id: string;
  district: BallotDistrict;
  race_type: string;
  official_ballot_title: string;
  /**
   * The seat's own ward/district designator ("Ward 3", "District 06") when the
   * office is one whose seats have separate electorates, else null. A ballot is
   * assembled from district rows, and a county row carries every seat attached
   * to it — so ward-level races reach every county resident. This flags that;
   * it does NOT mean the seat was filtered to the reader. `?? null` on read: a
   * not-yet-redeployed backend omits the field.
   */
  sub_district_seat?: string | null;
  election_date: string;
  election_stage: string | null;
  is_partisan: boolean | null;
  /**
   * The backend's contest family ("us_senate" | "non_judicial_office" |
   * "judicial_office" | "ballot_measure"). Read only to place US Senate
   * races in the Federal level section — their office scope is "statewide".
   * Optional: older payloads omit it.
   */
  discovery_contest_family?: string | null;
  candidate_count: number;
  /** null unless race_type is "office" and candidate_count is 0. */
  candidate_roster_status: CandidateRosterStatus | null;
  ballot_measure_id: string | null;
  has_results: boolean;
  current_result_outcome: string | null;
  /**
   * Winners of the current (most authoritative) result row — who advanced or
   * won, for the card's result chip. Empty for ballot measures. `?? []` on
   * read: a not-yet-redeployed backend omits the field.
   */
  current_result_winners?: ElectionResultWinner[];
  office: OfficeSummary | null;
  research_areas: ResearchAreaSummary[];
  historical_competitiveness: HistoricalCompetitiveness | null;
  /** See CurrentCompetitiveness: replaces the historic chip when present. */
  current_competitiveness?: CurrentCompetitiveness | null;
  vote_power: VotePower;
  /** Present on ordered results; non-empty when the viewer follows a candidate in this election. */
  followed_candidates?: { candidate_id: string; display_name: string }[];
  /** Present only when the ballot was fetched with include=preview. */
  preview?: ElectionPreview;
};

/**
 * Ballot-preview roster row. Unlike the election page's roster this INCLUDES
 * withdrawn candidacies (status "withdrawn") — a late withdrawal may still be
 * printed on the paper ballot, so the preview strikes it through instead of
 * hiding it.
 */
export type ElectionPreviewCandidate = {
  candidate_election_id: string;
  candidate_id: string;
  display_name: string;
  party: string;
  is_incumbent: boolean;
  status: string;
  running_mate?: { candidate_id: string; display_name: string; party: string };
};

/**
 * `summary`/what-yes/what-no are VoteApp explanations, NOT the printed ballot
 * question — always label them as such, never style them as ballot text.
 */
export type ElectionPreviewMeasure = {
  id: string;
  official_ballot_title: string;
  summary: string | null;
  what_yes_means: string;
  what_no_means: string;
};

/** Mirrors BallotLookupElectionPreview (backend ballotLookup.ts). */
export type ElectionPreview = {
  /** null = seat count never recorded; render as one seat ("Vote for One"). */
  seats_to_fill: number | null;
  candidates: ElectionPreviewCandidate[];
  measure: ElectionPreviewMeasure | null;
};

export type BallotSummary = {
  district_ids: string[];
  districts: BallotDistrict[];
  elections: ElectionSummary[];
};

// Mirrors StateVotingResources (backend api/stateVotingResources.ts): the
// official how-to-vote links for one state. mail_ballot_request_type explains
// how a voter obtains a mail ballot; "not_required" means every registered
// voter is mailed a ballot automatically (request URL is the official
// explanatory page and the request deadline is null).
export type StateVotingResources = {
  state_abbreviation: string;
  state_name: string;
  // Optional on the client only: an SSR build and an API deploy can be
  // minutes apart in either direction, so the UI renders the block only
  // when the field arrives.
  voter_registration_url?: string;
  polling_place_url: string;
  mail_voting_available: boolean;
  mail_ballot_request_url: string | null;
  mail_ballot_request_type: "online_portal" | "form" | "instructions" | "not_required" | null;
  mail_ballot_request_deadline_rule: string | null;
};

export type StateVotingResourcesResult = {
  state_resources: StateVotingResources;
};

// Mirrors BallotLookupFinanceBreakdown (backend ballotLookupFinanceShared.ts).
// Industry category_name values arrive as slugs (oil_gas_energy) — display
// them through formatFinanceCategory; occupation names arrive as free text.
export type FinanceBreakdown = {
  category_name: string;
  amount: number;
  contributor_count: number | null;
  source_url: string | null;
};

// Mirrors BallotLookupFinanceOutsideGroup (backend ballotLookupFinanceShared.ts).
export type FinanceOutsideGroup = {
  committee_id: string;
  committee_name: string;
  support_oppose: "support" | "oppose";
  amount: number;
  source_url: string | null;
  /** Manually researched one-line description of the committee's interest;
   * absent until a label has been researched for this summary's cycle
   * (finance_committee_labels). */
  label?: string;
  /** Evidence URLs behind `label` — present exactly when `label` is. */
  label_source_urls?: string[];
};

// Mirrors BallotLookupFinanceOutsideIndustrySupportEvidence (backend
// ballotLookupFinanceShared.ts): a named organization whose contributions to
// an outside group put its industry on the supporting-industries list.
export type FinanceOutsideIndustryEvidence = {
  organization_name: string;
  organization_type: "employer" | "donor";
  amount: number;
  contributor_count: number | null;
  committee_id: string;
  committee_name: string;
  source_url: string | null;
};

export type FinanceUnallocatedOutsideEdge = {
  filing_id: string;
  report_date: string;
  committee_id: string;
  committee_name: string;
  support_oppose: "support" | "oppose";
  source_url: string;
};

// Mirrors BallotLookupFinanceOutsideIndustrySupportSummary (backend): an
// outside-spending support industry plus the organizations behind it.
// explanation is optional defensively: the backend always sends it, but the
// cards build their own evidence sentence and older cached payloads predate
// the field.
export type FinanceOutsideIndustrySupport = FinanceBreakdown & {
  explanation?: string;
  supporting_organizations: FinanceOutsideIndustryEvidence[];
};

// Mirrors BallotLookupFinanceSummary (backend ballotLookupFinanceShared.ts):
// the money lives under direct_campaign, not at the top level. Deliberately
// partial — only what the UI renders. backing_summary is typed for the
// outside-spending evidence the card shows ("who is behind this industry");
// its other fields stay backend-only. null money values mean "not reported";
// 0 is a real disclosed amount.
export type FinanceSummary = {
  source: string;
  cycle: number;
  last_synced_at: string;
  direct_campaign: {
    total_raised: number | null;
    total_spent: number | null;
    cash_on_hand: number | null;
    debts_owed: number | null;
    public_funds_received?: number | null;
    loans_received?: number | null;
    top_occupations: FinanceBreakdown[];
    top_employers?: FinanceBreakdown[];
    top_industries: FinanceBreakdown[];
    contribution_size_buckets?: FinanceBreakdown[];
    direct_coverage_note?: string | null;
  };
  outside_spending: {
    support_total: number | null;
    oppose_total: number | null;
    /** "Member communications" (LA): spending by organizations to their own
     * members about this candidate — legally distinct from independent
     * expenditures, never folded into support_total/oppose_total. Only set
     * by sources that disclose it. */
    membership_support_total?: number | null;
    membership_oppose_total?: number | null;
    /** One sentence naming what these totals do not cover. Set only by
     * sources with a known, systematic gap (e.g. Ohio, where unregistered
     * spenders disclose through filings the pipeline does not read yet). */
    outside_coverage_note?: string | null;
    top_supporting_groups: FinanceOutsideGroup[];
    top_opposing_groups: FinanceOutsideGroup[];
    /** Filing-backed direction with no candidate-level amount; never $0. */
    unallocated_candidate_edges?: FinanceUnallocatedOutsideEdge[];
    top_supporting_industries: FinanceBreakdown[];
    top_opposing_industries: FinanceBreakdown[];
  };
  /** Optional defensively: the backend always sends it, but older cached
   * payloads may not. Only the evidence-bearing field is typed. */
  backing_summary?: {
    top_outside_supporting_industries: FinanceOutsideIndustrySupport[];
  };
};

export type ElectionCandidate = {
  candidate_id: string;
  display_name: string;
  party: string;
  is_incumbent: boolean;
  status: string;
  summary: string | null;
  /** Optional: a not-yet-redeployed backend omits it. */
  official_website_url?: string | null;
  finance_summary: FinanceSummary | null;
  /** Full record history with research-area stance tags; drives the stance chips. */
  records: CandidateRecord[];
  [key: string]: unknown;
};

// Mirrors BallotLookupBallotMeasureResult (backend ballotLookup.ts): one row
// per results pass (election_night, certified) for the measure.
export type BallotMeasureResult = {
  id: string;
  pass_type: string;
  result_status: string;
  outcome: string;
  source_url: string;
  source_type: string;
  retrieved_at: string;
};

export type BallotMeasureFundingDonor = {
  name: string;
  amount: number;
  type: "organization" | "individual";
  /** Two-letter state code from the filing, when the filing gives one. */
  state?: string;
  /** Who is behind a pass-through donor, as named by the filing agency. */
  funded_by?: string[];
  /** What the donor is, in a few plain words ("Google co-founder"). Absent only on rows written before it was required. */
  about?: string;
};

export type BallotMeasureFundingSide = {
  /**
   * True when a group these donors gave to also works on other measures, so
   * their money cannot be assigned to this measure alone.
   */
  shared_with_other_measures: boolean;
  /** Largest first, at most five. Empty = no donors reported on this side. */
  top_donors: BallotMeasureFundingDonor[];
  /** Official filing pages the numbers were read from. */
  source_urls: string[];
};

/** Who funds each side of a measure, from official campaign finance filings. */
export type BallotMeasureFunding = {
  /** YYYY-MM-DD the filings were read. */
  as_of: string;
  support: BallotMeasureFundingSide;
  oppose: BallotMeasureFundingSide;
};

export type BallotMeasure = {
  id: string;
  official_ballot_title: string;
  summary: string | null;
  what_yes_means: string;
  what_no_means: string;
  /** Canonical outcome, set only from a certified official verified source. */
  result: "passed" | "failed" | null;
  source_urls: string[];
  official_measure_url: string | null;
  research_area_tags: { research_area_id: string; slug: string; name: string; stance: string | null }[];
  results: BallotMeasureResult[];
  /** null = not researched. Absent on API builds older than this field. */
  funding?: BallotMeasureFunding | null;
};

export type ElectionResultWinner = {
  candidate_id?: string;
  candidate_name?: string;
  party?: string;
};

export type ElectionResult = {
  id: string;
  pass_type: string;
  result_status: string;
  outcome: string;
  winners: ElectionResultWinner[];
  source_url: string;
  retrieved_at: string;
};

// Mirrors BALLOT_SUMMARY_SORTS (backend ballotElectionOrdering.ts). my_areas
// is also the backend's default for users who saved research areas but never
// chose a sort, so this list must always be able to represent it. Every sort
// orders races WITHIN an election date — the date sections' order is fixed
// (earliest first), which is why there is no "soonest first" option.
export const BALLOT_SORTS = [
  { value: "my_areas", label: "My issues" },
  { value: "vote_power", label: "My vote power" },
  { value: "district_size_smallest", label: "Smallest districts" },
  { value: "district_size", label: "Biggest districts" },
] as const;

export type BallotSort = (typeof BALLOT_SORTS)[number]["value"];

// Sorts the anonymous /api/ballot page may offer. my_areas needs a signed-in
// user with saved research areas — the public endpoint has no user, so the
// backend would silently degrade it to vote_power while the UI claimed an
// issue-based order.
export const PUBLIC_BALLOT_SORTS = BALLOT_SORTS.filter((option) => option.value !== "my_areas");

export const BALLOT_SORT_DESCRIPTIONS: Record<BallotSort, string> = {
  my_areas: "ordered by how much each race affects the issues you care about.",
  vote_power: "ordered by where your vote carries the most weight.",
  district_size: "grouped by level, biggest districts first.",
  district_size_smallest: "grouped by level, smallest districts first.",
};

export type ElectionDetail = {
  id: string;
  district_id: string;
  district: BallotDistrict;
  race_type: string;
  official_ballot_title: string;
  /** Same meaning as ElectionSummary.sub_district_seat: the seat's own
   * ward/district, flagged because the ballot cannot filter to it. */
  sub_district_seat?: string | null;
  election_date: string;
  election_stage: string | null;
  is_partisan: boolean | null;
  /** Seats this contest fills; null = never recorded (treat like 1). */
  seats_to_fill: number | null;
  sources: string[];
  candidates: ElectionCandidate[];
  /** null unless race_type is "office" and candidates is empty. */
  candidate_roster_status: CandidateRosterStatus | null;
  ballot_measure: BallotMeasure | null;
  results: ElectionResult[];
  /** Same shapes as ElectionSummary, so the detail page can show the office
   * description and affected areas without a second request. */
  office: OfficeSummary | null;
  research_areas: ResearchAreaSummary[];
  historical_competitiveness: HistoricalCompetitiveness | null;
  /** See CurrentCompetitiveness: replaces the historic chip when present. */
  current_competitiveness?: CurrentCompetitiveness | null;
  vote_power: VotePower;
};

export type CandidateSearchMatch = {
  candidate_id: string;
  display_name: string;
  party: string;
  state: string;
  current_office: string | null;
};

export type CandidateSearchResponse = {
  candidates: CandidateSearchMatch[];
};

export type CandidateFollow = {
  candidate_id: string;
  display_name: string;
  party: string;
  state: string;
  current_office: string | null;
  latest_record: { description: string; event_date: string } | null;
  active_election: { election_id: string; official_ballot_title: string; election_date: string } | null;
  notify_elections: boolean;
  notify_updates: boolean;
  created_at: string;
};

export type CandidateFollowsResult = {
  follows: CandidateFollow[];
};

export type CandidateFollowUpdate = {
  candidate_id: string;
  following: boolean;
  notify_elections?: boolean;
  notify_updates?: boolean;
};

export type ElectionChoicePick = {
  candidate_id: string;
  display_name: string;
  /** candidate_elections.status at read time; e.g. "withdrawn" lets the UI
   * flag a pick whose candidate has since dropped out. */
  candidacy_status: string;
  /** 'auto' while the row is auto-pick's; a manual re-pick flips it back to
   * 'manual'. Optional to tolerate a pre-field backend (deploy skew) and the
   * guest draft's localStorage choices: absent renders as manual. */
  origin?: "manual" | "auto";
};

export type ElectionChoice = {
  election_id: string;
  race_type: "office" | "ballot_measure";
  official_ballot_title: string;
  election_date: string;
  seats_to_fill: number | null;
  picks: ElectionChoicePick[];
  measure_position: "yes" | "no" | null;
  /** The measure row's origin (measures have no picks array to carry it);
   * null when there is no measure position. Optional for deploy skew and
   * guest drafts, like ElectionChoicePick.origin. */
  measure_origin?: "manual" | "auto" | null;
  /** ballot_measures.result at read time ("passed"/"failed" once certified
   * results land, null before) — the measure counterpart of a pick's
   * candidacy_status. Optional to tolerate a pre-field backend (deploy
   * skew): absent renders as "no result yet". */
  measure_result?: string | null;
  /** Same contract as ElectionSummary.current_result_outcome/_winners,
   * attached on the list read only — picks history outlives the ballot's
   * just-finished window, and these keep an election-night call visible
   * there until certification flips candidacy_status. Optional for deploy
   * skew and absent on the post-write read-back. */
  current_result_outcome?: string | null;
  current_result_winners?: ElectionResultWinner[];
  updated_at: string;
};

export type ElectionChoicesResult = {
  choices: ElectionChoice[];
};

export type ElectionChoiceUpdate =
  | { election_id: string; candidate_id: string; chosen: boolean }
  | { election_id: string; measure_position: "yes" | "no" | null };

// --- Auto-pick ("Pick for me") — POST /api/me/auto-picks -------------------

export type AutoPickMode = "fill_empty" | "replace";

export type AutoPickReason =
  | "by_elimination"
  | "insufficient_evidence"
  | "only_negative_evidence"
  | "tie"
  | "all_vetoed"
  | "veto"
  | "too_few_issues"
  | "election_closed";

export type AutoPickRequest = {
  election_ids: string[];
  mode: AutoPickMode;
  dry_run?: boolean;
};

export type AutoPickPerIssue = {
  research_area_id: string;
  /** −1..1 in thirds: sign says aligned/conflicting, magnitude the capped
   * record depth (±3 records = full conviction). */
  net: number;
  /** Records agreeing with the user's direction on this issue. */
  for_count: number;
  /** Records conflicting with the user's direction on this issue. */
  against_count: number;
};

export type AutoPickCandidateReport = {
  candidate_id: string;
  display_name: string;
  score: number;
  has_evidence: boolean;
  /** Non-empty = excluded by a "line in the sand", with the offending records. */
  vetoed_by: { research_area_id: string; record_id: string; description: string }[];
  per_issue: AutoPickPerIssue[];
};

export type AutoPickElectionResult = {
  election_id: string;
  race_type: "office" | "ballot_measure";
  outcome: "picked" | "skipped_existing" | "no_pick";
  reason: AutoPickReason | null;
  picked_candidate_ids: string[];
  measure_position: "yes" | "no" | null;
  /** On a "tie"/"only_negative_evidence" no-pick: the narrowed field the
   * user should decide among. */
  shortlist_candidate_ids: string[];
  candidates: AutoPickCandidateReport[];
  /** Measure races: per-issue alignment (net = ±1 after the user's direction). */
  measure_per_issue: { research_area_id: string; net: number }[];
  unresearched: { candidate_id: string; display_name: string; never_researched: boolean }[];
};

export type AutoPicksResult = { results: AutoPickElectionResult[] };

/** DELETE /api/me/auto-picks — one-statement clear of every auto pick on
 * the user's upcoming elections (rows whose origin is still 'auto'). */
export type AutoPicksClearResult = { cleared_count: number };

/** One race on a shared pick card (public payload behind /picks/:token). */
export type PickCardEntry = {
  election_id: string;
  official_ballot_title: string;
  race_type: "office" | "ballot_measure";
  district_name: string;
  picks: { candidate_id: string; display_name: string; candidacy_status: string }[];
  measure_position: "yes" | "no" | null;
  /** Same contract as ElectionChoice.measure_result. */
  measure_result?: string | null;
  /** Same contract as ElectionSummary.current_result_outcome/_winners: the
   * election's canonical result, so the card can flag a pick that
   * won/advanced before certification flips candidacy_status. Optional to
   * tolerate a pre-field backend (deploy skew). */
  current_result_outcome?: string | null;
  current_result_winners?: ElectionResultWinner[];
};

export type PickCard = {
  /** Card owner's first name — the only identity field on the public
   * payload (the owner shares the link themselves). null for legacy shares
   * minted before the named page existed — those stay anonymous until the
   * owner clicks Share again. Optional to tolerate a backend from before
   * the field existed (deploy skew): absent and null alike degrade to the
   * unnamed heading, never a crash. */
  first_name?: string | null;
  election_date: string;
  entries: PickCardEntry[];
};

export type PickCardShare = {
  token: string;
  election_date: string;
};

export type BallotPreferences = {
  sort: BallotSort;
  followed_first: boolean;
};

export type EmailPreferences = {
  email_digest: boolean;
  email_election_reminders: boolean;
  email_new_election_alerts: boolean;
  email_issue_updates: boolean;
  /** Member-only newsletters (Terms 14.5); meaningful for active members. */
  email_member_newsletter: boolean;
};

// GET /api/me/membership. `enabled: false` = Stripe not configured on this
// deployment; the frontend hides the whole support section. Mirrors the
// backend's MembershipStatusResult (backend/src/api/membership).
export type MembershipKind = "one_time" | "monthly";

export type MembershipPayment = {
  amount_cents: number;
  refunded_amount_cents: number;
  kind: MembershipKind;
  currency: string;
  paid_at: string;
};

export type MembershipMembership = {
  /** Raw Stripe subscription status, verbatim. */
  stripe_status: string;
  /** What the current billing period costs. */
  monthly_amount_cents: number;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  started_at: string;
  /** A requested amount change that has not billed yet
   * (docs/plans/membership-manage-page.md). `applied` = the new price is
   * set at Stripe and the advance notice sent, so `starts_at` is firm;
   * otherwise `starts_at` is the projected renewal (null when unknown). */
  pending_amount_change: {
    new_amount_cents: number;
    starts_at: string | null;
    applied: boolean;
  } | null;
};

export type MembershipStatus =
  | { enabled: false }
  | {
      enabled: true;
      /** The one nonterminal subscription, or null when not a member. */
      membership: MembershipMembership | null;
      /** Net of refunds, across both payment kinds. */
      total_net_cents: number;
      /** Latest 50, newest first. */
      payments: MembershipPayment[];
    };

export type ResearchAreaCatalog = {
  research_areas: { id: string; slug: string; name: string; description: string | null }[];
};

export type ResearchAreaPreferenceDirection = "support" | "oppose";

export type ResearchAreaPreference = {
  research_area_id: string;
  slug: string;
  name: string;
  description: string | null;
  rank: number | null;
  /** Support or oppose the area's stated goal (catalog rows are goals). */
  direction: ResearchAreaPreferenceDirection;
  /** "Line in the sand": never auto-pick a candidate/measure that opposes this. */
  hard_veto: boolean;
};

/** One PUT /api/me/research-area-preferences item; omitted direction/hard_veto keep the stored value. */
export type ResearchAreaPreferenceInput = {
  research_area_id: string;
  rank: number;
  direction?: ResearchAreaPreferenceDirection;
  hard_veto?: boolean;
};

export type ResearchAreaPreferencesResult = {
  preferences: ResearchAreaPreference[];
};

export type CandidateRecordTag = {
  research_area_id: string;
  slug: string;
  name: string;
  stance: "for" | "against" | null;
};

export type CandidateRecord = {
  id: string;
  description: string;
  source_url: string;
  event_date: string;
  created_at: string;
  research_area_tags: CandidateRecordTag[];
};

export type CandidateElection = {
  candidate_election_id: string;
  election_id: string;
  district: { id: string; name: string; district_type: string; state: string };
  race_type: string;
  official_ballot_title: string;
  election_date: string;
  is_incumbent: boolean;
  status: string;
  /** elections.seats_to_fill; NULL (or absent under deploy skew) renders as
   * a single seat. Feeds the choice controls' seat cap. */
  seats_to_fill?: number | null;
  office_canonical_name: string | null;
};

export type CandidateDetail = {
  candidate: {
    candidate_id: string;
    display_name: string;
    party: string;
    state: string;
    current_office: string | null;
    summary: string | null;
    twitter_handle: string | null;
    linkedin_url: string | null;
    official_website_url: string | null;
    profile_sources: string[];
    last_researched: string | null;
    /**
     * Date the record history has been researched through. Null means no
     * records search has completed yet, so an empty `records` array is "not
     * researched" rather than "researched and none found".
     */
    records_researched_through: string | null;
    records: CandidateRecord[];
    elections: CandidateElection[];
    is_following: boolean;
  };
};

export type ContentReportEntityType = "candidate" | "candidate_record" | "election" | "ballot_measure";

export type CreateContentReportResponse = {
  report: { id: string };
};

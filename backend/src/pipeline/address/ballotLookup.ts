import type { Pool, PoolClient } from "pg";

import { captureError } from "../../observability/sentry.js";
import { describeError } from "../../observability/scrubText.js";
import type {
  ElectionContestFamily,
  ElectionDistrictType,
  ElectionRaceType,
  ElectionStage,
  OfficeScope,
} from "../../types/election.js";
import type { CandidateElectionStatus, ElectionResultPassType } from "../../types/electionResults.js";
import { US_LATEST_LOCAL_DATE_SQL, usLatestLocalDateIso } from "../../utils/usLocalDate.js";
import {
  loadBallotMeasureFundingByMeasure,
  type BallotMeasureFundingView,
} from "../ballotMeasures/ballotMeasureFunding.js";
import {
  calculateWeightedHistoricalContestMargin,
  lookupHistoricalContestMarginRows,
  type HistoricalContestWeightedMarginLookupRecord,
} from "../competitiveness/historicalContestMarginLookup.js";
import type { HistoricalContestCompetitivenessLabel } from "../competitiveness/competitivenessLabels.js";
import {
  loadOverridingCurrentRaceRatings,
  type CurrentRaceRatingLookupRecord,
} from "../competitiveness/currentRaceRatingLookup.js";
import {
  calculateVotePower,
  explainVotePower,
  formatRatingDate,
  isUncontestedOfficeRace,
  ratingOutletDisplay,
  type VotePowerCurrentRating,
  type VotePowerExplanation,
  type VotePowerResult,
} from "./votePower.js";
import { applyFinanceCommitteeLabels } from "./financeCommitteeLabels.js";
import {
  GENERAL_RESEARCH_AREA_SLUG,
  INTEGRITY_AND_ETHICS_RESEARCH_AREA_SLUG,
} from "../candidates/candidateRecordResearchAreaPolicy.js";
import { loadKentuckyCandidateFinanceSummariesByCandidateElection } from "../kentuckyFinance/kentuckyBallotLookupFinanceLoader.js";
import { loadAlabamaCandidateFinanceSummariesByCandidateElection } from "../alabamaFinance/alabamaBallotLookupFinanceLoader.js";
import { loadArkansasCandidateFinanceSummariesByCandidateElection } from "../arkansasFinance/arkansasBallotLookupFinanceLoader.js";
import { loadWestVirginiaCandidateFinanceSummariesByCandidateElection } from "../westVirginiaFinance/westVirginiaBallotLookupFinanceLoader.js";
import { loadNorthDakotaCandidateFinanceSummariesByCandidateElection } from "../northDakotaFinance/northDakotaBallotLookupFinanceLoader.js";
import { loadIdahoCandidateFinanceSummariesByCandidateElection } from "../idahoFinance/idahoBallotLookupFinanceLoader.js";
import { loadKansasCandidateFinanceSummariesByCandidateElection } from "../kansasFinance/kansasBallotLookupFinanceLoader.js";
import { loadAlaskaCandidateFinanceSummariesByCandidateElection } from "../alaskaFinance/alaskaCandidateFinanceBallotLookup.js";
import { loadArizonaCandidateFinanceSummariesByCandidateElection } from "../arizonaFinance/arizonaFinanceBallotLookup.js";
import { loadFloridaCandidateFinanceSummariesByCandidateElection } from "../floridaFinance/floridaFinanceBallotSummary.js";
import { loadLouisianaCandidateFinanceSummariesByCandidateElection } from "../louisianaFinance/louisianaBallotLookupFinanceLoader.js";
import { extractSubDistrictSeat } from "../elections/subDistrictSeat.js";
import { loadPennsylvaniaCandidateFinanceSummariesByCandidateElection } from "../pennsylvaniaFinance/pennsylvaniaBallotLookupFinance.js";
import { loadUtahCandidateFinanceSummariesByCandidateElection } from "../utahFinance/utahBallotLookupFinanceLoader.js";
import { loadVermontCandidateFinanceSummariesByCandidateElection } from "../vermontFinance/vermontBallotLookupFinanceLoader.js";
import { loadFecCandidateFinanceSummariesByCandidateElection } from "../finance/fecBallotLookupFinanceLoader.js";
import { loadManualCandidateFinanceSummariesByCandidateElection } from "../finance/manualCandidateFinanceBallotLookup.js";
import { loadMinnesotaCandidateFinanceSummariesByCandidateElection } from "../minnesotaFinance/minnesotaBallotLookupFinanceLoader.js";
import { loadNewJerseyCandidateFinanceSummariesByCandidateElection } from "../newJerseyFinance/newJerseyBallotLookupFinanceLoader.js";
import { loadTennesseeCandidateFinanceSummariesByCandidateElection } from "../tennesseeFinance/tennesseeBallotLookupFinanceLoader.js";
import { loadIllinoisCandidateFinanceSummariesByCandidateElection } from "../illinoisFinance/illinoisBallotLookupFinanceLoader.js";
import { loadVirginiaCandidateFinanceSummariesByCandidateElection } from "../virginiaFinance/virginiaBallotLookupFinanceLoader.js";
import { loadMaineCandidateFinanceSummariesByCandidateElection } from "../maineFinance/maineBallotLookupFinanceLoader.js";
import { loadMarylandCandidateFinanceSummariesByCandidateElection } from "../marylandFinance/marylandBallotLookupFinanceLoader.js";
import { loadOhioCandidateFinanceSummariesByCandidateElection } from "../ohioFinance/ohioBallotLookupFinanceLoader.js";
import { loadNorthCarolinaCandidateFinanceSummariesByCandidateElection } from "../northCarolinaFinance/northCarolinaBallotLookupFinanceLoader.js";
import { loadGeorgiaCandidateFinanceSummariesByCandidateElection } from "../georgiaFinance/georgiaBallotLookupFinanceLoader.js";
import { loadMissouriCandidateFinanceSummariesByCandidateElection } from "../missouriFinance/missouriBallotLookupFinanceLoader.js";
import { loadMontanaCandidateFinanceSummariesByCandidateElection } from "../montanaFinance/montanaBallotLookupFinanceLoader.js";
import { loadRhodeIslandCandidateFinanceSummariesByCandidateElection } from "../rhodeIslandFinance/rhodeIslandBallotLookupFinanceLoader.js";
import { loadMichiganCandidateFinanceSummariesByCandidateElection } from "../michiganFinance/michiganBallotLookupFinanceLoader.js";
import { loadMassachusettsCandidateFinanceSummariesByCandidateElection } from "../massachusettsFinance/massachusettsBallotLookupFinanceLoader.js";
import { loadWisconsinCandidateFinanceSummariesByCandidateElection } from "../wisconsinFinance/wisconsinBallotLookupFinanceLoader.js";
import { loadDistrictOfColumbiaCandidateFinanceSummariesByCandidateElection } from "../districtOfColumbiaFinance/districtOfColumbiaBallotLookupFinanceLoader.js";
import { loadHawaiiCandidateFinanceSummariesByCandidateElection } from "../hawaiiFinance/hawaiiBallotLookupFinanceLoader.js";
import { loadOregonCandidateFinanceSummariesByCandidateElection } from "../oregonFinance/oregonBallotLookupFinanceLoader.js";
import { loadWashingtonCandidateFinanceSummariesByCandidateElection } from "../washingtonFinance/washingtonBallotLookupFinanceLoader.js";
import { loadCombinedNewYorkCandidateFinanceSummariesByCandidateElection } from "../newYorkFinance/newYorkCombinedBallotLookupFinanceLoader.js";
import { loadTexasCandidateFinanceSummariesByCandidateElection } from "../texasFinance/texasBallotLookupFinanceLoader.js";
import { loadHoustonCandidateFinanceSummariesByCandidateElection } from "../houstonFinance/houstonBallotLookupFinanceLoader.js";
import { loadAustinCandidateFinanceSummariesByCandidateElection } from "../austinFinance/austinBallotLookupFinanceLoader.js";
import { loadNewMexicoCandidateFinanceSummariesByCandidateElection } from "../newMexicoFinance/newMexicoBallotLookupFinanceLoader.js";
import { loadNewHampshireCandidateFinanceSummariesByCandidateElection } from "../newHampshireFinance/newHampshireBallotLookupFinanceLoader.js";
import { loadNevadaCandidateFinanceSummariesByCandidateElection } from "../nevadaFinance/nevadaBallotLookupFinanceLoader.js";
import { loadIndianaCandidateFinanceSummariesByCandidateElection } from "../indianaFinance/indianaBallotLookupFinanceLoader.js";
import { loadOklahomaCandidateFinanceSummariesByCandidateElection } from "../oklahomaFinance/oklahomaBallotLookupFinanceLoader.js";
import { loadNebraskaCandidateFinanceSummariesByCandidateElection } from "../nebraskaFinance/nebraskaBallotLookupFinanceLoader.js";
import { loadConnecticutCandidateFinanceSummariesByCandidateElection } from "../connecticutFinance/connecticutBallotLookupFinanceLoader.js";
import { loadDelawareCandidateFinanceSummariesByCandidateElection } from "../delawareFinance/delawareBallotLookupFinanceLoader.js";
import { loadColoradoCandidateFinanceSummariesByCandidateElection } from "../coloradoFinance/coloradoBallotLookupFinanceLoader.js";
import { loadDenverCandidateFinanceSummariesByCandidateElection } from "../denverFinance/denverBallotLookupFinanceLoader.js";
import { loadCaliforniaCandidateFinanceSummariesByCandidateElection } from "../californiaFinance/californiaBallotLookupFinanceLoader.js";
import { loadLosAngelesCandidateFinanceSummariesByCandidateElection } from "../losAngelesCityFinance/losAngelesBallotLookupFinanceLoader.js";
import { loadPhoenixCandidateFinanceSummariesByCandidateElection } from "../phoenixFinance/phoenixBallotLookupFinanceLoader.js";
import { loadSanDiegoCityCandidateFinanceSummariesByCandidateElection } from "../sanDiegoCityFinance/sanDiegoCityBallotLookupFinanceLoader.js";
import { loadSanFranciscoCandidateFinanceSummariesByCandidateElection } from "../sanFranciscoFinance/sanFranciscoBallotLookupFinanceLoader.js";
import { loadSanJoseCandidateFinanceSummariesByCandidateElection } from "../sanJoseFinance/sanJoseBallotLookupFinanceLoader.js";
import { loadSouthCarolinaCandidateFinanceSummariesByCandidateElection } from "../southCarolinaFinance/southCarolinaBallotLookupFinanceLoader.js";

import {
  electionYear,
  candidateElectionKey,
  type BallotLookupFinanceSummary,
} from "./ballotLookupFinanceShared.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type BallotLookupDistrict = {
  id: string;
  district_type: ElectionDistrictType;
  geoid_compact: string;
  name: string;
  state: string;
  state_fips: string;
  representation_power_score: number | null;
  population: number | null;
};

export type BallotLookupResearchAreaTag = {
  research_area_id: string;
  slug: string;
  name: string;
  stance: "for" | "against" | null;
};

export type BallotLookupResearchAreaSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
};

export type BallotLookupOfficeSummary = {
  id: string;
  scope: OfficeScope;
  canonical_name: string;
  summary: string;
};

export type BallotLookupHistoricalCompetitivenessMethod = "latest" | "weighted_last_3";

export type BallotLookupHistoricalCompetitivenessContest = {
  source: string;
  source_url: string | null;
  election_year: number;
  winner_party: string | null;
  runner_up_party: string | null;
  margin_percent: number;
  competitiveness_label: HistoricalContestCompetitivenessLabel;
  stale_after_redistricting: boolean;
  weight?: number;
};

export type BallotLookupHistoricalCompetitiveness = {
  display_label: string;
  display_description: string;
  source: string;
  source_url: string | null;
  election_year: number;
  winner_party: string | null;
  runner_up_party: string | null;
  margin_percent: number;
  competitiveness_label: HistoricalContestCompetitivenessLabel;
  stale_after_redistricting: boolean;
  method?: BallotLookupHistoricalCompetitivenessMethod;
  weights?: number[];
  election_years?: number[];
  contests_used?: BallotLookupHistoricalCompetitivenessContest[];
};

// Current-cycle analyst rating, present ONLY when it drove the vote-power
// decisiveness label (fresh + rated + high|medium confidence + upcoming, per
// currentRaceRatingOverridesHistory). Clients render this chip INSTEAD of the
// historic one when present; fallback races keep the historic chip.
export type BallotLookupCurrentCompetitiveness = {
  display_label: string;
  display_description: string;
  competitiveness_label: HistoricalContestCompetitivenessLabel;
  method: "outlet_consensus" | "mayoral_rubric";
  confidence: "high" | "medium";
  as_of: string;
};

export type BallotLookupCandidateRecord = {
  id: string;
  description: string;
  source_url: string;
  event_date: string;
  created_at: string;
  research_area_tags: BallotLookupResearchAreaTag[];
};

export type BallotLookupRunningMate = {
  candidate_id: string;
  display_name: string;
  party: string;
};

export type CandidateRosterStatusReason =
  | "awaiting_official_roster"
  | "roster_processing"
  | "candidate_information_unavailable";

// Public "why is the candidate list empty" signal for office elections with
// zero visible candidates. Derived from internal research state (roster
// staging + deferral ledger) but exposes only a fixed enum and an optional
// re-check date — never internal free-text reasons. null on elections that
// have candidates and on ballot measures.
export type BallotLookupCandidateRosterStatus = {
  reason: CandidateRosterStatusReason;
  check_after: string | null;
};

export type BallotLookupCandidate = {
  candidate_election_id: string;
  candidate_id: string;
  display_name: string;
  party: string;
  is_incumbent: boolean;
  status: CandidateElectionStatus;
  summary: string | null;
  current_office: string | null;
  // The campaign/office site, for the retention layout that shows the
  // judge inline on the election page (no profile hop).
  official_website_url: string | null;
  state: string;
  fec_ids: string[];
  state_filing_ids: string[];
  running_mate?: BallotLookupRunningMate;
  records: BallotLookupCandidateRecord[];
  finance_summary: BallotLookupFinanceSummary | null;
};

export type BallotLookupElectionResultWinner = {
  candidate_election_id?: string;
  candidate_id?: string;
  candidate_name?: string;
  party?: string;
};

export type BallotLookupElectionResult = {
  id: string;
  pass_type: ElectionResultPassType;
  result_status: string;
  outcome: string;
  winners: BallotLookupElectionResultWinner[];
  match_status: string;
  source_url: string;
  source_type: string;
  retrieved_at: string;
};

export type BallotLookupBallotMeasureResult = {
  id: string;
  pass_type: ElectionResultPassType;
  result_status: string;
  outcome: string;
  source_url: string;
  source_type: string;
  retrieved_at: string;
};

export type BallotLookupBallotMeasure = {
  id: string;
  official_ballot_title: string;
  summary: string | null;
  what_yes_means: string;
  what_no_means: string;
  result: "passed" | "failed" | null;
  source_urls: string[];
  official_measure_url: string | null;
  research_area_tags: BallotLookupResearchAreaTag[];
  results: BallotLookupBallotMeasureResult[];
  // Who funds each side, from official filings; null = not researched.
  funding: BallotMeasureFundingView | null;
};

export type BallotLookupElection = {
  id: string;
  district_id: string;
  district: BallotLookupDistrict;
  race_type: ElectionRaceType;
  official_ballot_title: string;
  // The seat's own ward/district designator when the office is one whose seats
  // have SEPARATE electorates ("Ward 3", "District 06"), else null. The ballot
  // is assembled per district row, so a county's ward-level seats all reach
  // every county resident; this is the signal that lets the card say the seat
  // may not be the reader's. It is not a filter — see subDistrictSeat.ts.
  sub_district_seat: string | null;
  election_date: string;
  election_stage: ElectionStage | null;
  is_partisan: boolean | null;
  // null = seat count never recorded (display treats null and 1 the same).
  seats_to_fill: number | null;
  discovery_contest_family: ElectionContestFamily | null;
  sources: string[];
  candidates: BallotLookupCandidate[];
  candidate_roster_status: BallotLookupCandidateRosterStatus | null;
  ballot_measure: BallotLookupBallotMeasure | null;
  results: BallotLookupElectionResult[];
  // Same office/research-area shape as the summary list, so the detail page
  // can show the office description and affected areas without a second
  // request.
  office: BallotLookupOfficeSummary | null;
  research_areas: BallotLookupResearchAreaSummary[];
  historical_competitiveness: BallotLookupHistoricalCompetitiveness | null;
  current_competitiveness: BallotLookupCurrentCompetitiveness | null;
  // The detail payload carries the explanation; the ballot summary list
  // (BallotLookupElectionSummary) deliberately does not.
  vote_power: VotePowerResult & { explanation: VotePowerExplanation };
};

type BallotLookupElectionBase = Omit<
  BallotLookupElection,
  "office" | "research_areas" | "historical_competitiveness" | "current_competitiveness" | "vote_power"
>;

// Ballot-preview roster row: the minimal facts a paper-ballot-style render
// needs per candidate. Unlike the detail roster (BallotLookupCandidate) this
// INCLUDES withdrawn candidacies — a late withdrawal may still be printed on
// the paper ballot, and a preview that silently drops a printed name reads as
// a missing race to the voter; `status` lets the UI strike it through instead.
export type BallotLookupPreviewCandidate = {
  candidate_election_id: string;
  candidate_id: string;
  display_name: string;
  party: string;
  is_incumbent: boolean;
  status: CandidateElectionStatus;
  running_mate?: BallotLookupRunningMate;
};

// The `summary`/what-yes/what-no fields are VoteApp explanations, NOT the
// printed ballot question — the UI must label them as such, never render
// them styled as ballot text.
export type BallotLookupPreviewMeasure = {
  id: string;
  official_ballot_title: string;
  summary: string | null;
  what_yes_means: string;
  what_no_means: string;
};

// Attached to each summary election only when the caller opts in
// (include=preview): everything the ballot-preview render needs that the
// plain list card does not.
export type BallotLookupElectionPreview = {
  // null = seat count never recorded; display treats null and 1 the same
  // ("Vote for One").
  seats_to_fill: number | null;
  candidates: BallotLookupPreviewCandidate[];
  measure: BallotLookupPreviewMeasure | null;
};

export type BallotLookupElectionSummary = {
  id: string;
  district_id: string;
  district: BallotLookupDistrict;
  race_type: ElectionRaceType;
  official_ballot_title: string;
  // Mirrors BallotLookupElection.sub_district_seat: the ballot list is where a
  // ward-level seat is most likely to be mistaken for a countywide one.
  sub_district_seat: string | null;
  election_date: string;
  election_stage: ElectionStage | null;
  is_partisan: boolean | null;
  discovery_contest_family: ElectionContestFamily | null;
  sources: string[];
  candidate_count: number;
  candidate_roster_status: BallotLookupCandidateRosterStatus | null;
  ballot_measure_id: string | null;
  has_results: boolean;
  current_result_outcome: string | null;
  // Winners of the current (most authoritative) result row, so the ballot
  // card can say WHO advanced/won, not just that a result exists. Empty for
  // ballot measures (the outcome alone — passed/failed — is the answer).
  current_result_winners: BallotLookupElectionResultWinner[];
  office: BallotLookupOfficeSummary | null;
  research_areas: BallotLookupResearchAreaSummary[];
  historical_competitiveness: BallotLookupHistoricalCompetitiveness | null;
  current_competitiveness: BallotLookupCurrentCompetitiveness | null;
  vote_power: VotePowerResult;
  // Present only when the lookup ran with includePreview (include=preview).
  preview?: BallotLookupElectionPreview;
};

export type BallotSummaryResult = {
  district_ids: string[];
  districts: BallotLookupDistrict[];
  elections: BallotLookupElectionSummary[];
};

type DistrictRow = Omit<BallotLookupDistrict, "representation_power_score" | "population"> & {
  representation_power_score: string | number | null;
  population?: string | number | null;
};

type ElectionRow = {
  election_id: string;
  district_id: string;
  district_type: ElectionDistrictType;
  geoid_compact: string;
  district_name: string;
  state: string;
  state_fips: string;
  representation_power_score: string | number | null;
  population?: string | number | null;
  race_type: ElectionRaceType;
  official_ballot_title: string;
  election_date: string;
  election_stage: ElectionStage | null;
  is_partisan: boolean | null;
  seats_to_fill: number | null;
  // Roster size promised by the candidate_roster staging row (see the
  // query comment); absent on older row shapes and test fixtures.
  staged_roster_size?: number | null;
  discovery_contest_family: ElectionContestFamily | null;
  sources: unknown;
  office_id?: string | null;
  office_scope?: OfficeScope | null;
  office_canonical_name?: string | null;
};

// The scope column is optional: only loadElectionRowById selects it, and the
// explanation degrades to a symbolic formula when it is absent.
type ElectionDetailRow = ElectionRow & {
  office_summary?: string | null;
  scope_state_population?: string | number | null;
};

type ElectionSummaryRow = ElectionRow & {
  office_id: string | null;
  office_scope: OfficeScope | null;
  office_canonical_name: string | null;
  office_summary: string | null;
};

type CandidateCountRow = {
  election_id: string;
  candidate_count: number;
};

type BallotMeasureSummaryRow = {
  election_id: string;
  ballot_measure_id: string;
};

type OfficeResearchAreaSummaryRow = {
  office_id: string;
  research_area_id: string;
  slug: string;
  name: string;
  description: string | null;
};

type MeasureResearchAreaSummaryRow = {
  election_id: string;
  research_area_id: string;
  slug: string;
  name: string;
  description: string | null;
};

// Shared by the ballot-summary list and the election-detail lookup so both
// payloads describe an election's research areas identically.
async function loadOfficeResearchAreaSummaryRows(
  db: Queryable,
  officeIds: readonly string[]
): Promise<OfficeResearchAreaSummaryRow[]> {
  if (officeIds.length === 0) {
    return [];
  }
  const result = await db.query<OfficeResearchAreaSummaryRow>(
    `
      SELECT
        link.office_id,
        area.id AS research_area_id,
        area.slug,
        area.name,
        area.description
      FROM public.office_research_areas AS link
      JOIN public.research_areas AS area
        ON area.id = link.research_area_id
      WHERE link.office_id = ANY($1::uuid[])
      ORDER BY link.office_id, area.slug
    `,
    [officeIds]
  );
  return result.rows;
}

async function loadMeasureResearchAreaSummaryRows(
  db: Queryable,
  electionIds: readonly string[]
): Promise<MeasureResearchAreaSummaryRow[]> {
  if (electionIds.length === 0) {
    return [];
  }
  const result = await db.query<MeasureResearchAreaSummaryRow>(
    `
      SELECT
        bm.election_id,
        area.id AS research_area_id,
        area.slug,
        area.name,
        area.description
      FROM public.ballot_measures AS bm
      JOIN public.ballot_measure_research_area_tags AS tag
        ON tag.ballot_measure_id = bm.id
      JOIN public.research_areas AS area
        ON area.id = tag.research_area_id
      WHERE bm.election_id = ANY($1::uuid[])
      ORDER BY bm.election_id, area.slug
    `,
    [electionIds]
  );
  return result.rows;
}

function mergeResearchAreaSummaries(
  officeRows: readonly OfficeResearchAreaSummaryRow[],
  measureRows: readonly MeasureResearchAreaSummaryRow[]
): BallotLookupResearchAreaSummary[] {
  const merged: BallotLookupResearchAreaSummary[] = [];
  const seen = new Set<string>();
  for (const row of [...officeRows, ...measureRows]) {
    if (seen.has(row.research_area_id)) {
      continue;
    }
    seen.add(row.research_area_id);
    merged.push({
      id: row.research_area_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
    });
  }
  return merged;
}

type ElectionResultSummaryRow = {
  election_id: string;
  outcome: string;
  winners: unknown;
};

type CandidateRow = {
  election_id: string;
  candidate_election_id: string;
  candidate_id: string;
  display_name: string;
  party: string;
  is_incumbent: boolean;
  status: CandidateElectionStatus;
  summary: string | null;
  current_office: string | null;
  official_website_url: string | null;
  state: string;
  fec_ids: unknown;
  state_filing_ids: unknown;
  running_mate_candidate_id: string | null;
  running_mate_display_name: string | null;
  running_mate_party: string | null;
};

type CandidateRecordRow = {
  candidate_id: string;
  candidate_record_id: string;
  description: string;
  source_url: string;
  event_date: string;
  created_at: string;
};

type CandidateRecordTagRow = {
  candidate_record_id: string;
  research_area_id: string;
  slug: string;
  name: string;
  stance: "for" | "against" | null;
};

// office_id is null for the universal areas (general, integrity_and_ethics),
// which are allowed for every office.
type OfficeAllowedResearchAreaRow = {
  office_id: string | null;
  research_area_id: string;
};

type BallotMeasureRow = {
  election_id: string;
  ballot_measure_id: string;
  official_ballot_title: string;
  summary: string | null;
  what_yes_means: string;
  what_no_means: string;
  result: "passed" | "failed" | null;
  source_url: unknown;
  official_measure_url: string | null;
};

type BallotMeasureTagRow = {
  ballot_measure_id: string;
  research_area_id: string;
  slug: string;
  name: string;
  stance: "for" | "against";
};

type ElectionResultRow = {
  election_id: string;
  id: string;
  pass_type: ElectionResultPassType;
  result_status: string;
  outcome: string;
  winners: unknown;
  match_status: string;
  source_url: string;
  source_type: string;
  retrieved_at: string;
};

type BallotMeasureResultRow = {
  ballot_measure_id: string;
  id: string;
  pass_type: ElectionResultPassType;
  result_status: string;
  outcome: string;
  source_url: string;
  source_type: string;
  retrieved_at: string;
};

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return [
    ...new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    ),
  ];
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseWinners(raw: unknown): BallotLookupElectionResultWinner[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item): BallotLookupElectionResultWinner[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    const row = item as Record<string, unknown>;
    const winner: BallotLookupElectionResultWinner = {};
    const candidateElectionId = normalizeOptionalString(row.candidate_election_id);
    const candidateId = normalizeOptionalString(row.candidate_id);
    const candidateName = normalizeOptionalString(row.candidate_name);
    const party = normalizeOptionalString(row.party);
    if (candidateElectionId) {
      winner.candidate_election_id = candidateElectionId;
    }
    if (candidateId) {
      winner.candidate_id = candidateId;
    }
    if (candidateName) {
      winner.candidate_name = candidateName;
    }
    if (party) {
      winner.party = party;
    }
    return Object.keys(winner).length > 0 ? [winner] : [];
  });
}

function groupBy<T, K extends string>(rows: readonly T[], getKey: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const key = getKey(row);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return grouped;
}

function parseRepresentationPowerScore(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.min(100, Math.max(0, parsed));
}

function toDistrict(row: DistrictRow | ElectionRow | ElectionSummaryRow): BallotLookupDistrict {
  const id = "district_id" in row ? row.district_id : row.id;
  const name = "district_name" in row ? row.district_name : row.name;
  return {
    id,
    district_type: row.district_type,
    geoid_compact: row.geoid_compact,
    name,
    state: row.state,
    state_fips: row.state_fips,
    representation_power_score: parseRepresentationPowerScore(row.representation_power_score),
    population: parseDistrictPopulation(row.population),
  };
}

function parseDistrictPopulation(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapResearchAreaTag(row: CandidateRecordTagRow | BallotMeasureTagRow): BallotLookupResearchAreaTag {
  return {
    research_area_id: row.research_area_id,
    slug: row.slug,
    name: row.name,
    stance: row.stance,
  };
}

// How long a finished election stays on the ballot list. Users only see
// upcoming elections, except a just-finished one sticks around briefly so
// its result (the ElectionCard result badge and the detail page's results
// section) is discoverable without a direct link. After this window the
// election disappears from ballot summaries; the detail endpoint still
// serves it by ID indefinitely.
//
// Deliberately anchored to the election date, not result arrival: certified
// results landing weeks later (E+38..E+81 in some states) must not make old
// elections reappear on the ballot — delivering late results to users is a
// notification concern (results email), not a ballot-list concern.
export const BALLOT_PAST_ELECTION_VISIBILITY_DAYS = 3;

function priorElectionYear(electionDate: string): number | null {
  const year = Number.parseInt(electionDate.slice(0, 4), 10);
  return Number.isInteger(year) ? year - 1 : null;
}

function toHistoricalCompetitiveness(
  row: HistoricalContestWeightedMarginLookupRecord | null | undefined
): BallotLookupHistoricalCompetitiveness | null {
  const latestContest = row?.contests_used[0];
  if (!row || !latestContest) {
    return null;
  }

  return {
    display_label: historicalCompetitivenessDisplayLabel(row.competitiveness_label),
    display_description: historicalCompetitivenessDisplayDescription(row),
    source: row.source,
    source_url: row.source_url,
    election_year: latestContest.election_year,
    winner_party: latestContest.winner_party,
    runner_up_party: latestContest.runner_up_party,
    margin_percent: row.margin_percent,
    competitiveness_label: row.competitiveness_label,
    stale_after_redistricting: row.stale_after_redistricting,
    method: row.method,
    weights: [...row.weights],
    election_years: row.election_years,
    contests_used: row.contests_used.map((contest) => ({
      source: contest.source,
      source_url: contest.source_url,
      election_year: contest.election_year,
      winner_party: contest.winner_party,
      runner_up_party: contest.runner_up_party,
      margin_percent: contest.margin_percent,
      competitiveness_label: contest.competitiveness_label,
      stale_after_redistricting: contest.stale_after_redistricting,
      weight: contest.weight,
    })),
  };
}

function historicalCompetitivenessDisplayLabel(label: HistoricalContestCompetitivenessLabel): string {
  switch (label) {
    case "toss_up":
      return "Historically a toss-up";
    case "very_competitive":
      return "Historically very competitive";
    case "competitive":
      return "Historically competitive";
    case "somewhat_competitive":
      return "Historically somewhat competitive";
    case "safe":
      return "Historically not competitive";
  }
}

function historicalOfficeDisplayName(officeType: HistoricalContestWeightedMarginLookupRecord["office_type"]): string {
  switch (officeType) {
    case "US_PRESIDENT":
      return "President";
    case "US_SENATE":
      return "U.S. Senate";
    case "US_HOUSE":
      return "U.S. House";
    case "GOVERNOR":
      return "Governor";
    case "LIEUTENANT_GOVERNOR":
      return "Lieutenant Governor";
    case "SECRETARY_OF_STATE":
      return "Secretary of State";
    case "ATTORNEY_GENERAL":
      return "Attorney General";
    case "STATE_TREASURER":
      return "State Treasurer";
    case "STATE_AUDITOR":
      return "State Auditor";
    case "COMPTROLLER":
      return "Comptroller";
    case "SUPERINTENDENT_OF_PUBLIC_INSTRUCTION":
      return "Superintendent of Public Instruction";
    case "COMMISSIONER_OF_AGRICULTURE":
      return "Commissioner of Agriculture";
    case "COMMISSIONER_OF_INSURANCE":
      return "Commissioner of Insurance";
    case "LABOR_COMMISSIONER":
      return "Labor Commissioner";
    case "LAND_COMMISSIONER":
      return "Land Commissioner";
    case "STATE_SENATE":
      return "State Senate";
    case "STATE_HOUSE":
      return "State House";
    case "COUNTY_SHERIFF":
      return "Sheriff";
    case "DISTRICT_ATTORNEY":
      return "District Attorney";
    case "COUNTY_CLERK":
      return "County Clerk";
    case "COUNTY_ASSESSOR":
      return "County Assessor";
    case "COUNTY_AUDITOR":
      return "County Auditor";
    case "COUNTY_TREASURER":
      return "County Treasurer";
    case "COUNTY_RECORDER":
      return "County Recorder";
    case "COUNTY_CORONER":
      return "County Coroner";
  }
}

function formatYearList(years: readonly number[]): string {
  if (years.length === 1) {
    return String(years[0]);
  }
  if (years.length === 2) {
    return `${years[0]} and ${years[1]}`;
  }
  return `${years.slice(0, -1).join(", ")}, and ${years[years.length - 1]}`;
}

function historicalCompetitivenessDisplayDescription(row: HistoricalContestWeightedMarginLookupRecord): string {
  const office = historicalOfficeDisplayName(row.office_type);
  if (row.election_years.length === 1) {
    return `Based on the ${row.election_years[0]} ${office} result.`;
  }
  return `Based on weighted margins from ${formatYearList(row.election_years)} ${office} results.`;
}

// Mirrors historicalCompetitivenessDisplayLabel tier-for-tier so the two
// chips read as the same scale ("Currently ..." vs "Historically ...").
// very_competitive and competitive stay distinct: they grade different
// decisiveness levels (high vs medium), so collapsing them made two races
// with the same chip text show different vote power ratings.
function currentCompetitivenessDisplayLabel(label: HistoricalContestCompetitivenessLabel): string {
  switch (label) {
    case "toss_up":
      return "Currently a toss-up";
    case "very_competitive":
      return "Currently very competitive";
    case "competitive":
      return "Currently competitive";
    case "somewhat_competitive":
      return "Currently somewhat competitive";
    case "safe":
      return "Currently not competitive";
  }
}

// The stored evidence shape is writer-controlled ({ observations: [{ outlet,
// raw_rating, intensity, ... }] }); the guards only protect against
// hand-edited rows, dropping malformed entries rather than crashing a ballot.
function parseRatingEvidenceObservations(
  evidence: unknown
): { outlet: string; rawRating: string; intensity: number }[] {
  if (typeof evidence !== "object" || evidence === null || !("observations" in evidence)) {
    return [];
  }
  const observations = (evidence as { observations: unknown }).observations;
  if (!Array.isArray(observations)) {
    return [];
  }
  return observations.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { outlet, raw_rating: rawRating, intensity } = entry as Record<string, unknown>;
    if (typeof outlet !== "string" || typeof rawRating !== "string" || typeof intensity !== "number") {
      return [];
    }
    return [{ outlet, rawRating, intensity }];
  });
}

function currentCompetitivenessDisplayDescription(
  record: CurrentRaceRatingLookupRecord,
  outlets: { outlet: string }[]
): string {
  const names = outlets.map((entry) => ratingOutletDisplay(entry.outlet).full);
  const sourcePhrase =
    names.length === 0
      ? "current race ratings"
      : names.length === 1
        ? `the current race rating from ${names[0]}`
        : `current race ratings from ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Based on ${sourcePhrase} as of ${formatRatingDate(record.as_of!)}.`;
}

// null when the row's invariants don't hold (the override filter guarantees
// them, but the types allow null label/confidence/as_of).
function toCurrentCompetitiveness(
  record: CurrentRaceRatingLookupRecord
): BallotLookupCurrentCompetitiveness | null {
  if (
    record.competitiveness_label === null ||
    record.as_of === null ||
    (record.confidence !== "high" && record.confidence !== "medium")
  ) {
    return null;
  }
  return {
    display_label: currentCompetitivenessDisplayLabel(record.competitiveness_label),
    display_description: currentCompetitivenessDisplayDescription(
      record,
      parseRatingEvidenceObservations(record.evidence)
    ),
    competitiveness_label: record.competitiveness_label,
    method: record.method,
    confidence: record.confidence,
    as_of: record.as_of,
  };
}

// The votePower explanation context for a rating that drove decisiveness.
function toCurrentRatingExplanationContext(record: CurrentRaceRatingLookupRecord): VotePowerCurrentRating | null {
  if (record.as_of === null || (record.confidence !== "high" && record.confidence !== "medium")) {
    return null;
  }
  return {
    asOf: record.as_of,
    method: record.method,
    confidence: record.confidence,
    outlets: parseRatingEvidenceObservations(record.evidence),
  };
}

// Only the rows that pass the full override rule (rated + high|medium +
// upcoming + fresh as_of) come back; everything else falls through to
// historic margins. Office races only — measures are never rated.
// "Today" is the latest US local date (usLocalDate.ts), matching every other
// upcoming/past election check here: on the UTC clock the rating would fall
// back to historic data while Hawaii was still voting on election day.
async function loadCurrentCompetitivenessByElection(
  db: Queryable,
  electionRows: readonly (ElectionSummaryRow | ElectionDetailRow)[]
): Promise<Map<string, CurrentRaceRatingLookupRecord>> {
  return loadOverridingCurrentRaceRatings(
    db,
    electionRows.filter((row) => row.race_type === "office").map((row) => row.election_id),
    { today: new Date(`${usLatestLocalDateIso()}T00:00:00.000Z`) }
  );
}

async function loadHistoricalCompetitivenessByElection(
  db: Queryable,
  electionRows: readonly (ElectionSummaryRow | ElectionDetailRow)[]
): Promise<Map<string, BallotLookupHistoricalCompetitiveness>> {
  const historicalRowsByElection = await lookupHistoricalContestMarginRows(
    db,
    electionRows.map((row) => ({
      lookupId: row.election_id,
      officeCanonicalName: row.office_canonical_name,
      districtType: row.district_type,
      geoidCompact: row.geoid_compact,
      stateFips: row.state_fips,
      currentElectionYear: electionYear(row.election_date),
      maxElectionYear: priorElectionYear(row.election_date),
    }))
  );

  return new Map(
    [...historicalRowsByElection].flatMap(([electionId, rows]) => {
      const weightedMargin = calculateWeightedHistoricalContestMargin(rows);
      const historicalCompetitiveness = toHistoricalCompetitiveness(weightedMargin);
      return historicalCompetitiveness ? [[electionId, historicalCompetitiveness] as const] : [];
    })
  );
}

// Every ballot-lookup finance source, in the order the old hand-written
// aggregator awaited them. Each loader gates itself on its own feature flag
// and returns an empty map when disabled, so the registry carries no
// enabled-checks. Order is inherited, not semantic: since the federal-office
// gate (#214), no two sources can produce a summary for the same
// candidate/election key. Adding a state = write the family-folder loader
// and add one entry here.
// Everything the finance sources read off a candidate row: the shared
// request builder uses candidate_id/election_id and the FEC loader reads
// fec_ids. Declaring the narrow shape here lets the profile finance lookup
// query only these columns while the full-row callers pass CandidateRow
// unchanged (structural subtyping).
type FinanceLookupCandidateRow = Pick<CandidateRow, "candidate_id" | "election_id" | "fec_ids">;

type StateFinanceLookupAdapter = {
  state: string;
  load: (
    db: Queryable,
    candidateRows: readonly FinanceLookupCandidateRow[],
    electionRows: readonly ElectionRow[]
  ) => Promise<Map<string, BallotLookupFinanceSummary>>;
};

const STATE_FINANCE_LOOKUP_ADAPTERS: readonly StateFinanceLookupAdapter[] = [
  { state: "WI", load: loadWisconsinCandidateFinanceSummariesByCandidateElection },
  { state: "MA", load: loadMassachusettsCandidateFinanceSummariesByCandidateElection },
  { state: "VT", load: loadVermontCandidateFinanceSummariesByCandidateElection },
  { state: "LA", load: loadLouisianaCandidateFinanceSummariesByCandidateElection },
  { state: "MD", load: loadMarylandCandidateFinanceSummariesByCandidateElection },
  { state: "ME", load: loadMaineCandidateFinanceSummariesByCandidateElection },
  { state: "AK", load: loadAlaskaCandidateFinanceSummariesByCandidateElection },
  { state: "MI", load: loadMichiganCandidateFinanceSummariesByCandidateElection },
  { state: "IL", load: loadIllinoisCandidateFinanceSummariesByCandidateElection },
  { state: "MN", load: loadMinnesotaCandidateFinanceSummariesByCandidateElection },
  { state: "OR", load: loadOregonCandidateFinanceSummariesByCandidateElection },
  {
    state: "PA",
    load: (db, candidateRows, electionRows) =>
      loadPennsylvaniaCandidateFinanceSummariesByCandidateElection({ db, candidateRows, electionRows }),
  },
  { state: "WA", load: loadWashingtonCandidateFinanceSummariesByCandidateElection },
  { state: "HI", load: loadHawaiiCandidateFinanceSummariesByCandidateElection },
  { state: "DC", load: loadDistrictOfColumbiaCandidateFinanceSummariesByCandidateElection },
  { state: "KY", load: loadKentuckyCandidateFinanceSummariesByCandidateElection },
  { state: "FL", load: loadFloridaCandidateFinanceSummariesByCandidateElection },
  { state: "VA", load: loadVirginiaCandidateFinanceSummariesByCandidateElection },
  { state: "TN", load: loadTennesseeCandidateFinanceSummariesByCandidateElection },
  { state: "TX", load: loadTexasCandidateFinanceSummariesByCandidateElection },
  { state: "TX", load: loadHoustonCandidateFinanceSummariesByCandidateElection },
  // Austin city filers are not in TEC either (Texas already skips every
  // place-scope Mayor / City Council Member election), and the atx_ link
  // table is disjoint from Houston's — no exclusion needed.
  { state: "TX", load: loadAustinCandidateFinanceSummariesByCandidateElection },
  { state: "AZ", load: loadArizonaCandidateFinanceSummariesByCandidateElection },
  { state: "AZ", load: loadPhoenixCandidateFinanceSummariesByCandidateElection },
  {
    state: "UT",
    load: (db, candidateRows, electionRows) =>
      loadUtahCandidateFinanceSummariesByCandidateElection({ db, candidateRows, electionRows }),
  },
  { state: "IN", load: loadIndianaCandidateFinanceSummariesByCandidateElection },
  { state: "NE", load: loadNebraskaCandidateFinanceSummariesByCandidateElection },
  { state: "OK", load: loadOklahomaCandidateFinanceSummariesByCandidateElection },
  { state: "NV", load: loadNevadaCandidateFinanceSummariesByCandidateElection },
  { state: "NH", load: loadNewHampshireCandidateFinanceSummariesByCandidateElection },
  { state: "NJ", load: loadNewJerseyCandidateFinanceSummariesByCandidateElection },
  { state: "NM", load: loadNewMexicoCandidateFinanceSummariesByCandidateElection },
  { state: "NY", load: loadCombinedNewYorkCandidateFinanceSummariesByCandidateElection },
  { state: "CT", load: loadConnecticutCandidateFinanceSummariesByCandidateElection },
  { state: "DE", load: loadDelawareCandidateFinanceSummariesByCandidateElection },
  { state: "CO", load: loadColoradoCandidateFinanceSummariesByCandidateElection },
  // Denver municipal filers are not in TRACER, so the two CO adapters can
  // never both return a summary for one candidate/election (the CA pattern,
  // disjoint link tables); Denver registers later so it would win anyway.
  { state: "CO", load: loadDenverCandidateFinanceSummariesByCandidateElection },
  { state: "CA", load: loadCaliforniaCandidateFinanceSummariesByCandidateElection },
  { state: "CA", load: loadLosAngelesCandidateFinanceSummariesByCandidateElection },
  { state: "CA", load: loadSanDiegoCityCandidateFinanceSummariesByCandidateElection },
  { state: "CA", load: loadSanFranciscoCandidateFinanceSummariesByCandidateElection },
  { state: "CA", load: loadSanJoseCandidateFinanceSummariesByCandidateElection },
  { state: "OH", load: loadOhioCandidateFinanceSummariesByCandidateElection },
  { state: "NC", load: loadNorthCarolinaCandidateFinanceSummariesByCandidateElection },
  { state: "GA", load: loadGeorgiaCandidateFinanceSummariesByCandidateElection },
  { state: "MO", load: loadMissouriCandidateFinanceSummariesByCandidateElection },
  { state: "MT", load: loadMontanaCandidateFinanceSummariesByCandidateElection },
  { state: "MS", load: loadManualCandidateFinanceSummariesByCandidateElection },
  { state: "RI", load: loadRhodeIslandCandidateFinanceSummariesByCandidateElection },
  { state: "SC", load: loadSouthCarolinaCandidateFinanceSummariesByCandidateElection },
  { state: "AL", load: loadAlabamaCandidateFinanceSummariesByCandidateElection },
  { state: "AR", load: loadArkansasCandidateFinanceSummariesByCandidateElection },
  { state: "WV", load: loadWestVirginiaCandidateFinanceSummariesByCandidateElection },
  { state: "ND", load: loadNorthDakotaCandidateFinanceSummariesByCandidateElection },
  { state: "ID", load: loadIdahoCandidateFinanceSummariesByCandidateElection },
  { state: "KS", load: loadKansasCandidateFinanceSummariesByCandidateElection },
];

// Fault-isolated sources swallow errors that previously reached the API
// error middleware (and through it, Sentry), so this is a capture point of
// its own: scrubbed log line for local visibility, captureError so a broken
// finance module still pages instead of degrading silently forever.
function reportFinanceSummarySourceFailure(source: string, loader: string, error: unknown): void {
  console.warn("candidate finance summaries failed; continuing without this source:", {
    source,
    loader,
    reason: describeError(error),
  });
  captureError(error, { finance_source: source, finance_loader: loader });
}

// Exported for the fault-isolation unit tests; production code reaches this
// only through the ballot lookup entry points.
export async function loadCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly FinanceLookupCandidateRow[],
  electionRows: readonly ElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const merged = new Map<string, BallotLookupFinanceSummary>();
  // Sequential on purpose: parallelizing changes query interleaving for no
  // practical win and would break the ordered query mocks across the test
  // suite. At most one adapter is non-empty per election, but the two states
  // with multiple adapters get there differently: TX excludes the overlap in
  // code (Texas skips Houston's offices at read time), while CA does not gate
  // its reads — its state, LA, and SF adapters stay disjoint only because
  // their link tables hold different candidate/elections; on the (in-practice
  // unreached) overlap the latest-registered adapter wins.
  //
  // Each source is fault-isolated: finance summaries enrich the ballot
  // lookup, so a broken finance module must degrade to "no summaries from
  // that source" instead of failing the whole lookup for every state.
  for (const adapter of STATE_FINANCE_LOOKUP_ADAPTERS) {
    let summaries: ReadonlyMap<string, BallotLookupFinanceSummary>;
    try {
      summaries = await adapter.load(db, candidateRows, electionRows);
    } catch (error) {
      reportFinanceSummarySourceFailure(adapter.state, adapter.load.name, error);
      continue;
    }
    for (const [key, summary] of summaries) {
      merged.set(key, summary);
    }
  }
  // Federal FEC summaries intentionally win when both sources exist for the
  // same candidate/election (unreachable since the federal-office gate, and
  // pinned by the no-leak regression tests).
  try {
    for (const [key, summary] of await loadFecCandidateFinanceSummariesByCandidateElection(db, candidateRows, electionRows)) {
      merged.set(key, summary);
    }
  } catch (error) {
    reportFinanceSummarySourceFailure("FEC", loadFecCandidateFinanceSummariesByCandidateElection.name, error);
  }
  return merged;
}

type CandidateRosterStatusRow = {
  election_id: string;
  election_date: string;
  staging_status: string | null;
  staged_candidate_count: string | number | null;
  has_candidate_links: boolean;
  blocked_until: string | null;
};

// Pure derivation so tests can pin every branch without a database.
// Past elections always fall through to the generic reason: "coming soon"
// and "we'll check again" are promises, and a finished race gets neither
// (a staged-but-never-linked roster otherwise reads as roster_processing
// forever once its election day passes). For upcoming elections the
// precedence is: staged names beat an open deferral (the roster is already
// known, profiles are just pending), which beats the generic fallback.
// check_after is only ever a FUTURE date — an overdue deferral renders no
// date rather than a stale promise.
export function deriveCandidateRosterStatus(
  row: Pick<
    CandidateRosterStatusRow,
    "election_date" | "staging_status" | "staged_candidate_count" | "has_candidate_links" | "blocked_until"
  >,
  todayIso: string
): BallotLookupCandidateRosterStatus {
  const electionIsUpcoming = row.election_date >= todayIso;
  const stagedCount = Number(row.staged_candidate_count ?? 0);
  // has_candidate_links counts EVERY link, including withdrawn candidates and
  // deleted candidate rows that the visible-candidate queries filter out. Any
  // link means the staged roster was already processed — a race emptied by
  // withdrawals must not read as "profiles are being prepared" forever. An
  // open deferral can still apply there (a party replacing a withdrawn
  // nominee is genuinely awaiting a new official roster).
  if (
    electionIsUpcoming &&
    !row.has_candidate_links &&
    (row.staging_status === "written" || row.staging_status === "validated") &&
    stagedCount > 0
  ) {
    return { reason: "roster_processing", check_after: null };
  }
  if (electionIsUpcoming && row.blocked_until !== null) {
    return {
      reason: "awaiting_official_roster",
      check_after: row.blocked_until > todayIso ? row.blocked_until : null,
    };
  }
  return { reason: "candidate_information_unavailable", check_after: null };
}

// Batched "why is this roster empty" lookup. Callers pass only office
// elections that currently show zero candidates, so ballots with fully
// populated rosters issue no extra query (and existing ordered query mocks
// in tests stay untouched).
async function loadCandidateRosterStatusesByElection(
  db: Queryable,
  electionIds: readonly string[]
): Promise<Map<string, BallotLookupCandidateRosterStatus>> {
  if (electionIds.length === 0) {
    return new Map();
  }
  const result = await db.query<CandidateRosterStatusRow>(
    `
      SELECT
        e.id AS election_id,
        e.election_date::text AS election_date,
        s.status AS staging_status,
        -- typeof-guarded: one malformed staging row (candidates not an
        -- array) must degrade this secondary metadata to zero, never 500
        -- the whole ballot request via jsonb_array_length.
        CASE
          WHEN jsonb_typeof(s.payload->'candidates') = 'array'
            THEN jsonb_array_length(s.payload->'candidates')
          ELSE 0
        END AS staged_candidate_count,
        EXISTS (
          SELECT 1 FROM public.candidate_elections AS ce
          WHERE ce.election_id = e.id
        ) AS has_candidate_links,
        d.blocked_until::text AS blocked_until
      FROM public.elections AS e
      LEFT JOIN public.staging_items AS s
        ON s.item_type = 'candidate_roster'
       AND s.ingest_key = 'candidate_roster:' || e.id::text
      LEFT JOIN LATERAL (
        SELECT md.blocked_until
        FROM public.manual_research_deferrals AS md
        WHERE md.status = 'deferred'
          AND md.stage = 'candidate_roster'
          AND (md.election_id = e.id OR (md.election_id IS NULL AND md.district_id = e.district_id))
        -- An election-specific deferral beats a district-wide one; ties
        -- resolve to the earliest re-check date.
        ORDER BY (md.election_id IS NOT NULL) DESC, md.blocked_until ASC
        LIMIT 1
      ) AS d ON true
      WHERE e.id = ANY($1::uuid[])
    `,
    [electionIds]
  );
  const todayIso = usLatestLocalDateIso();
  return new Map(result.rows.map((row) => [row.election_id, deriveCandidateRosterStatus(row, todayIso)]));
}

async function loadFullElectionDetails(
  db: Queryable,
  electionRows: readonly ElectionRow[]
): Promise<BallotLookupElectionBase[]> {
  const electionIds = electionRows.map((row) => row.election_id);
  if (electionIds.length === 0) {
    return [];
  }

  const candidateResult = await db.query<CandidateRow>(
    `
        SELECT
          ce.election_id,
          ce.id AS candidate_election_id,
          c.id AS candidate_id,
          COALESCE(NULLIF(trim(c.display_name), ''), trim(c.first_name || ' ' || c.last_name)) AS display_name,
          c.party,
          ce.is_incumbent,
          ce.status,
          c.summary,
          c.current_office,
          c.official_website_url,
          c.state,
          c.fec_ids,
          c.state_filing_ids,
          rm.id AS running_mate_candidate_id,
          CASE
            WHEN rm.id IS NULL THEN NULL
            ELSE COALESCE(NULLIF(trim(rm.display_name), ''), trim(rm.first_name || ' ' || rm.last_name))
          END AS running_mate_display_name,
          rm.party AS running_mate_party
        FROM public.candidate_elections AS ce
        JOIN public.candidates AS c
          ON c.id = ce.candidate_id
        LEFT JOIN public.candidates AS rm
          ON rm.id = ce.running_mate_candidate_id
          AND rm.deleted_at IS NULL
        WHERE ce.election_id = ANY($1::uuid[])
          AND c.deleted_at IS NULL
          -- Withdrawn candidates are hidden from election pages entirely
          -- (product decision); their own candidate page still shows the link.
          AND ce.status <> 'withdrawn'
        ORDER BY
          ce.election_id,
          lower(COALESCE(NULLIF(trim(c.display_name), ''), trim(c.first_name || ' ' || c.last_name))),
          ce.id
      `,
    [electionIds]
  );
  const ballotMeasureResult = await db.query<BallotMeasureRow>(
    `
        SELECT
          bm.election_id,
          bm.id AS ballot_measure_id,
          bm.official_ballot_title,
          bm.summary,
          bm.what_yes_means,
          bm.what_no_means,
          bm.result,
          bm.source_url,
          bm.official_measure_url
        FROM public.ballot_measures AS bm
        WHERE bm.election_id = ANY($1::uuid[])
        ORDER BY bm.election_id, bm.id
      `,
    [electionIds]
  );
  const officeResult = await db.query<ElectionResultRow>(
    `
        SELECT
          er.election_id,
          er.id,
          er.pass_type,
          er.result_status,
          er.outcome,
          er.winners,
          er.match_status,
          er.source_url,
          er.source_type,
          er.retrieved_at::text AS retrieved_at
        FROM public.election_results AS er
        WHERE er.election_id = ANY($1::uuid[])
          -- unknown-outcome rows (not_found / not_final_yet sweeps) have
          -- nothing to show; on the page they would render as "Unknown ·
          -- Not found" above a decisive election-night row. Matches the
          -- summary ranking filter.
          AND er.outcome <> 'unknown'
        ORDER BY er.election_id, er.pass_type, er.retrieved_at DESC
      `,
    [electionIds]
  );
  const ballotMeasureOutcomeResult = await db.query<BallotMeasureResultRow>(
    `
        SELECT
          bmr.ballot_measure_id,
          bmr.id,
          bmr.pass_type,
          bmr.result_status,
          bmr.outcome,
          bmr.source_url,
          bmr.source_type,
          bmr.retrieved_at::text AS retrieved_at
        FROM public.ballot_measure_results AS bmr
        JOIN public.ballot_measures AS bm
          ON bm.id = bmr.ballot_measure_id
        WHERE bm.election_id = ANY($1::uuid[])
          AND bmr.outcome <> 'unknown'
        ORDER BY bmr.ballot_measure_id, bmr.pass_type, bmr.retrieved_at DESC
      `,
    [electionIds]
  );

  const candidateIds = [...new Set(candidateResult.rows.map((row) => row.candidate_id))];
  const ballotMeasureIds = ballotMeasureResult.rows.map((row) => row.ballot_measure_id);

  const candidateRecordResult =
    candidateIds.length === 0
      ? { rows: [] as CandidateRecordRow[] }
      : await db.query<CandidateRecordRow>(
          `
            SELECT
              cr.candidate_id,
              cr.id AS candidate_record_id,
              cr.description,
              cr.source_url,
              cr.event_date::text AS event_date,
              cr.created_at::text AS created_at
            FROM public.candidate_records AS cr
            WHERE cr.candidate_id = ANY($1::uuid[])
              AND cr.retired_at IS NULL
            ORDER BY cr.candidate_id, cr.event_date DESC, cr.created_at DESC, cr.id
          `,
          [candidateIds]
        );
  const candidateRecordTagResult =
    candidateIds.length === 0
      ? { rows: [] as CandidateRecordTagRow[] }
      : await db.query<CandidateRecordTagRow>(
          `
            SELECT
              cr.id AS candidate_record_id,
              ra.id AS research_area_id,
              ra.slug,
              ra.name,
              tag.stance
            FROM public.candidate_records AS cr
            JOIN public.candidate_record_area_tags AS tag
              ON tag.candidate_record_id = cr.id
            JOIN public.research_areas AS ra
              ON ra.id = tag.research_area_id
            WHERE cr.candidate_id = ANY($1::uuid[])
              AND cr.retired_at IS NULL
            ORDER BY cr.id, ra.slug
          `,
          [candidateIds]
        );
  const ballotMeasureTagResult =
    ballotMeasureIds.length === 0
      ? { rows: [] as BallotMeasureTagRow[] }
      : await db.query<BallotMeasureTagRow>(
          `
            SELECT
              tag.ballot_measure_id,
              ra.id AS research_area_id,
              ra.slug,
              ra.name,
              tag.stance
            FROM public.ballot_measure_research_area_tags AS tag
            JOIN public.research_areas AS ra
              ON ra.id = tag.research_area_id
            WHERE tag.ballot_measure_id = ANY($1::uuid[])
            ORDER BY tag.ballot_measure_id, ra.slug
          `,
          [ballotMeasureIds]
        );
  // Fault-isolated like the finance summaries: funding enriches the measure
  // page, so a failed read degrades to "no funding shown" instead of failing
  // the whole lookup (the live case is an API deployed ahead of migration 286).
  let ballotMeasureFundingByMeasure = new Map<string, BallotMeasureFundingView>();
  if (ballotMeasureIds.length > 0) {
    try {
      ballotMeasureFundingByMeasure = await loadBallotMeasureFundingByMeasure(db, ballotMeasureIds);
    } catch (error) {
      console.warn("ballot measure funding failed; continuing without it:", { reason: describeError(error) });
      captureError(error, { ballot_measure_funding: "load" });
    }
  }

  // Candidate records and their area tags are candidate-wide: a tag can point
  // at a research area that is not allowed for THIS election's office (e.g. a
  // legacy tag from before the office's allowed set was curated, or a tag that
  // only applies to an office the candidate ran for previously). Tags are
  // never deleted for that reason, so the election view must scope them here:
  // keep a tag only when its area is in the election office's allowed set
  // (office_research_areas) or is one of the universal areas. Elections with
  // no linked office have no allowed set and keep every tag.
  const electionOfficeIds = [
    ...new Set(
      electionRows
        .map((row) => row.office_id)
        .filter((officeId): officeId is string => typeof officeId === "string" && officeId.length > 0)
    ),
  ];
  const shouldScopeTagsToOffice = candidateRecordTagResult.rows.length > 0 && electionOfficeIds.length > 0;
  const officeAllowedAreaResult = !shouldScopeTagsToOffice
    ? { rows: [] as OfficeAllowedResearchAreaRow[] }
    : await db.query<OfficeAllowedResearchAreaRow>(
        `
          SELECT
            ora.office_id,
            ora.research_area_id
          FROM public.office_research_areas AS ora
          WHERE ora.office_id = ANY($1::uuid[])
          UNION ALL
          SELECT
            NULL::uuid AS office_id,
            ra.id AS research_area_id
          FROM public.research_areas AS ra
          WHERE ra.slug = ANY($2::text[])
        `,
        [electionOfficeIds, [GENERAL_RESEARCH_AREA_SLUG, INTEGRITY_AND_ETHICS_RESEARCH_AREA_SLUG]]
      );
  const universalAreaIds = new Set<string>();
  const allowedAreaIdsByOffice = new Map<string, Set<string>>();
  for (const row of officeAllowedAreaResult.rows) {
    if (row.office_id === null) {
      universalAreaIds.add(row.research_area_id);
      continue;
    }
    const set = allowedAreaIdsByOffice.get(row.office_id) ?? new Set<string>();
    set.add(row.research_area_id);
    allowedAreaIdsByOffice.set(row.office_id, set);
  }
  const scopeRecordTagsToOffice = (
    records: BallotLookupCandidateRecord[],
    officeId: string | null
  ): BallotLookupCandidateRecord[] => {
    // Gate on whether the allowed-areas query ran, not on its row count: a
    // query that runs and finds nothing means nothing is allowed for these
    // offices beyond what the rows say, so filtering must still apply
    // (matching loadAllowedResearchAreasForOfficeId, where an empty result
    // rejects every non-listed area) rather than silently passing tags through.
    if (officeId === null || !shouldScopeTagsToOffice) {
      return records;
    }
    const allowed = allowedAreaIdsByOffice.get(officeId);
    return records.map((record) => ({
      ...record,
      research_area_tags: record.research_area_tags.filter(
        (tag) => universalAreaIds.has(tag.research_area_id) || allowed?.has(tag.research_area_id) === true
      ),
    }));
  };

  const financeSummaryByCandidateElection = await loadCandidateFinanceSummariesByCandidateElection(
    db,
    candidateResult.rows,
    electionRows
  );
  const candidateRecordTagsByRecord = groupBy(candidateRecordTagResult.rows, (row) => row.candidate_record_id);
  const candidateRecordsByCandidate = new Map<string, BallotLookupCandidateRecord[]>();
  for (const row of candidateRecordResult.rows) {
    const list = candidateRecordsByCandidate.get(row.candidate_id) ?? [];
    list.push({
      id: row.candidate_record_id,
      description: row.description,
      source_url: row.source_url,
      event_date: row.event_date,
      created_at: row.created_at,
      research_area_tags: (candidateRecordTagsByRecord.get(row.candidate_record_id) ?? []).map(mapResearchAreaTag),
    });
    candidateRecordsByCandidate.set(row.candidate_id, list);
  }

  const officeIdByElection = new Map<string, string | null>(
    electionRows.map((row) => [row.election_id, row.office_id ?? null])
  );
  const candidatesByElection = new Map<string, BallotLookupCandidate[]>();
  for (const row of candidateResult.rows) {
    const list = candidatesByElection.get(row.election_id) ?? [];
    list.push({
      candidate_election_id: row.candidate_election_id,
      candidate_id: row.candidate_id,
      display_name: row.display_name,
      party: row.party,
      is_incumbent: row.is_incumbent,
      status: row.status,
      summary: row.summary,
      current_office: row.current_office,
      official_website_url: row.official_website_url ?? null,
      state: row.state,
      fec_ids: parseStringArray(row.fec_ids),
      state_filing_ids: parseStringArray(row.state_filing_ids),
      ...(row.running_mate_candidate_id && row.running_mate_display_name
        ? {
            running_mate: {
              candidate_id: row.running_mate_candidate_id,
              display_name: row.running_mate_display_name,
              party: row.running_mate_party ?? "",
            },
          }
        : {}),
      records: scopeRecordTagsToOffice(
        candidateRecordsByCandidate.get(row.candidate_id) ?? [],
        officeIdByElection.get(row.election_id) ?? null
      ),
      finance_summary:
        financeSummaryByCandidateElection.get(candidateElectionKey(row.candidate_id, row.election_id)) ?? null,
    });
    candidatesByElection.set(row.election_id, list);
  }

  const ballotMeasureTagsByMeasure = groupBy(ballotMeasureTagResult.rows, (row) => row.ballot_measure_id);
  const ballotMeasureResultsByMeasure = groupBy(ballotMeasureOutcomeResult.rows, (row) => row.ballot_measure_id);
  const ballotMeasureByElection = new Map<string, BallotLookupBallotMeasure>();
  for (const row of ballotMeasureResult.rows) {
    ballotMeasureByElection.set(row.election_id, {
      id: row.ballot_measure_id,
      official_ballot_title: row.official_ballot_title,
      summary: row.summary,
      what_yes_means: row.what_yes_means,
      what_no_means: row.what_no_means,
      result: row.result,
      source_urls: parseStringArray(row.source_url),
      official_measure_url: row.official_measure_url,
      research_area_tags: (ballotMeasureTagsByMeasure.get(row.ballot_measure_id) ?? []).map(mapResearchAreaTag),
      results: (ballotMeasureResultsByMeasure.get(row.ballot_measure_id) ?? []).map((result) => ({
        id: result.id,
        pass_type: result.pass_type,
        result_status: result.result_status,
        outcome: result.outcome,
        source_url: result.source_url,
        source_type: result.source_type,
        retrieved_at: result.retrieved_at,
      })),
      funding: ballotMeasureFundingByMeasure.get(row.ballot_measure_id) ?? null,
    });
  }

  // Empty office rosters get a "why" status; issued last so populated
  // ballots skip the query and ordered test mocks keep their slots.
  const rosterStatusByElection = await loadCandidateRosterStatusesByElection(
    db,
    electionRows
      .filter(
        (row) => row.race_type === "office" && (candidatesByElection.get(row.election_id) ?? []).length === 0
      )
      .map((row) => row.election_id)
  );

  const officeResultsByElection = groupBy(officeResult.rows, (row) => row.election_id);
  return electionRows.map((row) => ({
    id: row.election_id,
    district_id: row.district_id,
    district: toDistrict(row),
    race_type: row.race_type,
    official_ballot_title: row.official_ballot_title,
    sub_district_seat: extractSubDistrictSeat(row.official_ballot_title, row.office_canonical_name, {
      state: row.state,
      districtName: row.district_name,
      electionStage: row.election_stage,
    }),
    election_date: row.election_date,
    election_stage: row.election_stage,
    is_partisan: row.is_partisan,
    seats_to_fill: row.seats_to_fill ?? null,
    discovery_contest_family: row.discovery_contest_family,
    sources: parseStringArray(row.sources),
    candidates: candidatesByElection.get(row.election_id) ?? [],
    candidate_roster_status: rosterStatusByElection.get(row.election_id) ?? null,
    ballot_measure: ballotMeasureByElection.get(row.election_id) ?? null,
    results: (officeResultsByElection.get(row.election_id) ?? []).map((result) => ({
      id: result.id,
      pass_type: result.pass_type,
      result_status: result.result_status,
      outcome: result.outcome,
      winners: parseWinners(result.winners),
      match_status: result.match_status,
      source_url: result.source_url,
      source_type: result.source_type,
      retrieved_at: result.retrieved_at,
    })),
  }));
}

export async function lookupBallotSummariesByDistrictIds(
  db: Queryable,
  districtIds: readonly string[],
  // includePreview attaches the ballot-preview roster/measure payload to each
  // election. Issued as trailing queries so the ordered query mocks of every
  // preview-less test keep their slots. electionDate (YYYY-MM-DD) pins the
  // list to one election day instead of the rolling recent-past window.
  options: { includePreview?: boolean; electionDate?: string } = {}
): Promise<BallotSummaryResult> {
  const ids = normalizeIds(districtIds);
  if (ids.length === 0) {
    return { district_ids: [], districts: [], elections: [] };
  }

  const districtResult = await db.query<DistrictRow>(
    `
      SELECT
        id,
        district_type,
        geoid_compact,
        name,
        state,
        state_fips,
        representation_power_score,
        population
      FROM public.districts
      WHERE id = ANY($1::uuid[])
      ORDER BY array_position($1::uuid[], id), district_type, name
    `,
    [ids]
  );

  const electionResult = await db.query<ElectionSummaryRow>(
    `
      SELECT
        e.id AS election_id,
        d.id AS district_id,
        d.district_type,
        d.geoid_compact,
        d.name AS district_name,
        d.state,
        d.state_fips,
        d.representation_power_score,
        d.population,
        e.race_type,
        e.official_ballot_title,
        e.election_date::text AS election_date,
        e.election_stage,
        e.is_partisan,
        e.seats_to_fill,
        -- Roster size the staging row promises (validated or written). Links
        -- appear one per profile write, so between the first and last write
        -- a contested race can show fewer links than seats; the vote-power
        -- uncontested rule reads this so it never calls that race decided.
        -- The linked count field stays as is. typeof-guarded like the
        -- roster-status query: one malformed row degrades to 0, never 500s.
        -- A withdrawal marks the link but leaves the staged name, so each
        -- withdrawn link comes off the staged size; a withdrawn candidate
        -- who was never staged under-counts by one, which only falls back
        -- toward the linked count.
        (
          SELECT GREATEST(
            0,
            CASE
              WHEN jsonb_typeof(s.payload->'candidates') = 'array'
                THEN jsonb_array_length(s.payload->'candidates')
              ELSE 0
            END
            - (
              SELECT count(*)::int
              FROM public.candidate_elections AS withdrawn
              WHERE withdrawn.election_id = e.id
                AND withdrawn.status = 'withdrawn'
            )
          )
          FROM public.staging_items AS s
          WHERE s.item_type = 'candidate_roster'
            AND s.ingest_key = 'candidate_roster:' || e.id::text
            AND s.status IN ('validated', 'written')
        ) AS staged_roster_size,
        e.discovery_contest_family,
        e.sources,
        office.id AS office_id,
        office.scope AS office_scope,
        office.canonical_name AS office_canonical_name,
        office.summary AS office_summary
      FROM public.elections AS e
      JOIN public.districts AS d
        ON d.id = e.district_id
      LEFT JOIN public.offices AS office
        ON office.id = e.office_id
      WHERE e.district_id = ANY($1::uuid[])
        ${
          options.electionDate
            ? "AND e.election_date = $2::date"
            : `AND e.election_date >= ${US_LATEST_LOCAL_DATE_SQL} - ${BALLOT_PAST_ELECTION_VISIBILITY_DAYS}`
        }
      ORDER BY e.election_date ASC, e.race_type ASC, e.official_ballot_title ASC, e.id ASC
    `,
    options.electionDate ? [ids, options.electionDate] : [ids]
  );

  const electionIds = electionResult.rows.map((row) => row.election_id);
  if (electionIds.length === 0) {
    return {
      district_ids: ids,
      districts: districtResult.rows.map(toDistrict),
      elections: [],
    };
  }

  const candidateCountResult = await db.query<CandidateCountRow>(
    `
      SELECT
        ce.election_id,
        COUNT(*)::int AS candidate_count
      FROM public.candidate_elections AS ce
      JOIN public.candidates AS c
        ON c.id = ce.candidate_id
      WHERE ce.election_id = ANY($1::uuid[])
        AND c.deleted_at IS NULL
        -- Mirrors the detail query: withdrawn candidates are hidden from
        -- election pages, so they must not inflate the summary count either.
        AND ce.status <> 'withdrawn'
      GROUP BY ce.election_id
    `,
    [electionIds]
  );

  const ballotMeasureResult = await db.query<BallotMeasureSummaryRow>(
    `
      SELECT
        bm.election_id,
        bm.id AS ballot_measure_id
      FROM public.ballot_measures AS bm
      WHERE bm.election_id = ANY($1::uuid[])
      ORDER BY bm.election_id, bm.id
    `,
    [electionIds]
  );

  const officeIds = [
    ...new Set(
      electionResult.rows
        .map((row) => row.office_id)
        .filter((officeId): officeId is string => typeof officeId === "string" && officeId.length > 0)
    ),
  ];
  const officeResearchAreaRows = await loadOfficeResearchAreaSummaryRows(db, officeIds);

  // Ballot-measure elections have no office, so without this their
  // research_areas would always be empty and area-based personalization
  // (the my_areas sort, saved-area highlighting) could never match them.
  // Skipped entirely when the ballot has no measures, mirroring the office
  // research-area guard above.
  const measureElectionIds = [...new Set(ballotMeasureResult.rows.map((row) => row.election_id))];
  const measureResearchAreaRows = await loadMeasureResearchAreaSummaryRows(db, measureElectionIds);

  const resultSummaryResult = await db.query<ElectionResultSummaryRow>(
    `
      WITH all_results AS (
        -- outcome = 'unknown' rows (not_found / not_final_yet sweeps) carry no
        -- reportable result: without this filter a later certified-but-unknown
        -- row would outrank a decisive election-night outcome, and a lone
        -- unknown row would flag has_results for an election with nothing to
        -- show. Mirrors the decisive-only gate on result notification fanout.
        SELECT
          er.election_id,
          er.outcome,
          er.winners,
          er.pass_type,
          er.retrieved_at
        FROM public.election_results AS er
        WHERE er.election_id = ANY($1::uuid[])
          AND er.outcome <> 'unknown'

        UNION ALL

        SELECT
          bm.election_id,
          bmr.outcome,
          '[]'::jsonb AS winners,
          bmr.pass_type,
          bmr.retrieved_at
        FROM public.ballot_measure_results AS bmr
        JOIN public.ballot_measures AS bm
          ON bm.id = bmr.ballot_measure_id
        WHERE bm.election_id = ANY($1::uuid[])
          AND bmr.outcome <> 'unknown'
      ),
      ranked AS (
        SELECT
          election_id,
          outcome,
          winners,
          row_number() OVER (
            PARTITION BY election_id
            ORDER BY
              CASE pass_type
                WHEN 'certified' THEN 1
                WHEN 'election_night' THEN 2
                ELSE 3
              END,
              retrieved_at DESC,
              outcome ASC
          ) AS rn
        FROM all_results
      )
      SELECT election_id, outcome, winners
      FROM ranked
      WHERE rn = 1
    `,
    [electionIds]
  );

  const candidateCountsByElection = new Map(
    candidateCountResult.rows.map((row) => [row.election_id, row.candidate_count])
  );
  const ballotMeasureIdsByElection = new Map<string, string>();
  for (const row of ballotMeasureResult.rows) {
    if (!ballotMeasureIdsByElection.has(row.election_id)) {
      ballotMeasureIdsByElection.set(row.election_id, row.ballot_measure_id);
    }
  }
  const researchAreasByOffice = groupBy(officeResearchAreaRows, (row) => row.office_id);
  const measureResearchAreasByElection = groupBy(measureResearchAreaRows, (row) => row.election_id);
  const resultOutcomeByElection = new Map(resultSummaryResult.rows.map((row) => [row.election_id, row.outcome]));
  const resultWinnersByElection = new Map(
    resultSummaryResult.rows.map((row) => [row.election_id, parseWinners(row.winners)])
  );
  const historicalCompetitivenessByElection = await loadHistoricalCompetitivenessByElection(db, electionResult.rows);

  // Empty office rosters get a "why" status; issued last so populated
  // ballots skip the query and ordered test mocks keep their slots.
  const rosterStatusByElection = await loadCandidateRosterStatusesByElection(
    db,
    electionResult.rows
      .filter(
        (row) => row.race_type === "office" && (candidateCountsByElection.get(row.election_id) ?? 0) === 0
      )
      .map((row) => row.election_id)
  );

  // Preview payload (roster + measure text) is opt-in and loaded last — after
  // every unconditional query — so existing ordered mocks stay valid.
  const previewByElection = options.includePreview ? await loadElectionPreviews(db, electionIds) : null;

  // Current-cycle ratings load after every pre-existing query so ordered
  // test mocks keep their slots (same convention as the loaders above).
  const currentRatingByElection = await loadCurrentCompetitivenessByElection(db, electionResult.rows);

  const elections: BallotLookupElectionSummary[] = electionResult.rows.map((row) => {
    const currentResultOutcome = resultOutcomeByElection.get(row.election_id) ?? null;
    // Office columns are nullable only because this is a LEFT JOIN; resolved office rows have non-empty fields.
    const office =
      row.office_id && row.office_scope && row.office_canonical_name && row.office_summary
        ? {
            id: row.office_id,
            scope: row.office_scope,
            canonical_name: row.office_canonical_name,
            summary: row.office_summary,
          }
        : null;

    const district = toDistrict(row);
    const candidateCount = candidateCountsByElection.get(row.election_id) ?? 0;
    const historicalCompetitiveness = historicalCompetitivenessByElection.get(row.election_id) ?? null;
    const currentRatingRecord = currentRatingByElection.get(row.election_id) ?? null;
    // Uncontested races (no more candidates than seats) grade decisiveness
    // "none" regardless of any label, so a rating there did NOT drive the
    // grade — and the payload contract says the field exists only when it
    // did. A "Currently a toss-up" chip beside an unopposed race would
    // contradict.
    // Linked count or the staged roster size, whichever is larger: a roster
    // mid-fanout has fewer links than names, and must not read as decided.
    const rosterCandidateCount = Math.max(candidateCount, row.staged_roster_size ?? 0);
    const uncontested = isUncontestedOfficeRace({
      raceType: row.race_type,
      candidateCount: rosterCandidateCount,
      seatsToFill: row.seats_to_fill,
    });
    const currentCompetitiveness =
      currentRatingRecord && !uncontested ? toCurrentCompetitiveness(currentRatingRecord) : null;

    return {
      id: row.election_id,
      district_id: row.district_id,
      district,
      race_type: row.race_type,
      official_ballot_title: row.official_ballot_title,
      sub_district_seat: extractSubDistrictSeat(row.official_ballot_title, row.office_canonical_name, {
        state: row.state,
        districtName: row.district_name,
        electionStage: row.election_stage,
      }),
      election_date: row.election_date,
      election_stage: row.election_stage,
      is_partisan: row.is_partisan,
      discovery_contest_family: row.discovery_contest_family,
      sources: parseStringArray(row.sources),
      candidate_count: candidateCount,
      candidate_roster_status: rosterStatusByElection.get(row.election_id) ?? null,
      ballot_measure_id: ballotMeasureIdsByElection.get(row.election_id) ?? null,
      has_results: currentResultOutcome !== null,
      current_result_outcome: currentResultOutcome,
      current_result_winners: resultWinnersByElection.get(row.election_id) ?? [],
      office,
      // Office links first, then ballot-measure tags not already present
      // (deduped by area id); both sources arrive slug-ordered, so the
      // combined list stays deterministic.
      research_areas: mergeResearchAreaSummaries(
        row.office_id ? (researchAreasByOffice.get(row.office_id) ?? []) : [],
        measureResearchAreasByElection.get(row.election_id) ?? []
      ),
      historical_competitiveness: historicalCompetitiveness,
      current_competitiveness: currentCompetitiveness,
      vote_power: calculateVotePower({
        raceType: row.race_type,
        officialBallotTitle: row.official_ballot_title,
        candidateCount: rosterCandidateCount,
        seatsToFill: row.seats_to_fill,
        representationPowerScore: district.representation_power_score,
        // A fresh, confident current rating outranks historic margins.
        competitivenessLabel:
          currentCompetitiveness?.competitiveness_label ?? historicalCompetitiveness?.competitiveness_label,
      }),
      // Conditional spread, not `preview: undefined`: preview-less responses
      // must not grow a key that JSON.stringify would drop anyway but toEqual
      // assertions and API snapshots would see.
      ...(previewByElection
        ? {
            preview: {
              seats_to_fill: row.seats_to_fill ?? null,
              candidates: previewByElection.candidates.get(row.election_id) ?? [],
              measure: previewByElection.measures.get(row.election_id) ?? null,
            },
          }
        : {}),
    };
  });

  return {
    district_ids: ids,
    districts: districtResult.rows.map(toDistrict),
    elections,
  };
}

type PreviewCandidateRow = {
  election_id: string;
  candidate_election_id: string;
  candidate_id: string;
  display_name: string;
  party: string;
  is_incumbent: boolean;
  status: CandidateElectionStatus;
  running_mate_candidate_id: string | null;
  running_mate_display_name: string | null;
  running_mate_party: string | null;
};

type PreviewMeasureRow = {
  election_id: string;
  ballot_measure_id: string;
  official_ballot_title: string;
  summary: string | null;
  what_yes_means: string;
  what_no_means: string;
};

// Loads the opt-in ballot-preview payload for the summary lookup: per-race
// roster (withdrawn INCLUDED — see BallotLookupPreviewCandidate) and measure
// text. seats_to_fill is not loaded here — the summary's election row already
// carries it. Candidate order is alphabetical, the reader's only honest
// default: real ballots order candidates by state-specific rules (rotation,
// random draw) this lookup cannot know.
async function loadElectionPreviews(
  db: Queryable,
  electionIds: readonly string[]
): Promise<{
  candidates: Map<string, BallotLookupPreviewCandidate[]>;
  measures: Map<string, BallotLookupPreviewMeasure>;
}> {
  const candidateResult = await db.query<PreviewCandidateRow>(
    `
      SELECT
        ce.election_id,
        ce.id AS candidate_election_id,
        c.id AS candidate_id,
        COALESCE(NULLIF(trim(c.display_name), ''), trim(c.first_name || ' ' || c.last_name)) AS display_name,
        c.party,
        ce.is_incumbent,
        ce.status,
        rm.id AS running_mate_candidate_id,
        CASE
          WHEN rm.id IS NULL THEN NULL
          ELSE COALESCE(NULLIF(trim(rm.display_name), ''), trim(rm.first_name || ' ' || rm.last_name))
        END AS running_mate_display_name,
        rm.party AS running_mate_party
      FROM public.candidate_elections AS ce
      JOIN public.candidates AS c
        ON c.id = ce.candidate_id
      LEFT JOIN public.candidates AS rm
        ON rm.id = ce.running_mate_candidate_id
        AND rm.deleted_at IS NULL
      WHERE ce.election_id = ANY($1::uuid[])
        AND c.deleted_at IS NULL
      ORDER BY
        ce.election_id,
        lower(COALESCE(NULLIF(trim(c.display_name), ''), trim(c.first_name || ' ' || c.last_name))),
        ce.id
    `,
    [electionIds]
  );
  const measureResult = await db.query<PreviewMeasureRow>(
    `
      SELECT
        bm.election_id,
        bm.id AS ballot_measure_id,
        bm.official_ballot_title,
        bm.summary,
        bm.what_yes_means,
        bm.what_no_means
      FROM public.ballot_measures AS bm
      WHERE bm.election_id = ANY($1::uuid[])
      ORDER BY bm.election_id, bm.id
    `,
    [electionIds]
  );
  const candidates = new Map<string, BallotLookupPreviewCandidate[]>();
  for (const row of candidateResult.rows) {
    const list = candidates.get(row.election_id) ?? [];
    list.push({
      candidate_election_id: row.candidate_election_id,
      candidate_id: row.candidate_id,
      display_name: row.display_name,
      party: row.party,
      is_incumbent: row.is_incumbent,
      status: row.status,
      ...(row.running_mate_candidate_id && row.running_mate_display_name
        ? {
            running_mate: {
              candidate_id: row.running_mate_candidate_id,
              display_name: row.running_mate_display_name,
              party: row.running_mate_party ?? "",
            },
          }
        : {}),
    });
    candidates.set(row.election_id, list);
  }
  const measures = new Map<string, BallotLookupPreviewMeasure>();
  for (const row of measureResult.rows) {
    // First row wins, mirroring the summary's ballot_measure_id pick.
    if (!measures.has(row.election_id)) {
      measures.set(row.election_id, {
        id: row.ballot_measure_id,
        official_ballot_title: row.official_ballot_title,
        summary: row.summary,
        what_yes_means: row.what_yes_means,
        what_no_means: row.what_no_means,
      });
    }
  }
  return { candidates, measures };
}

// The single-election ElectionRow projection shared by the detail and
// finance lookups; both issue it as their leading query, so extracting it
// leaves every ordered query mock in the test suite untouched.
async function loadElectionRowById(db: Queryable, electionId: string): Promise<ElectionDetailRow[]> {
  const result = await db.query<ElectionDetailRow>(
    `
      SELECT
        e.id AS election_id,
        d.id AS district_id,
        d.district_type,
        d.geoid_compact,
        d.name AS district_name,
        d.state,
        d.state_fips,
        d.representation_power_score,
        d.population,
        e.race_type,
        e.official_ballot_title,
        e.election_date::text AS election_date,
        e.election_stage,
        e.is_partisan,
        e.seats_to_fill,
        -- Roster size the staging row promises (validated or written). Links
        -- appear one per profile write, so between the first and last write
        -- a contested race can show fewer links than seats; the vote-power
        -- uncontested rule reads this so it never calls that race decided.
        -- The linked count field stays as is. typeof-guarded like the
        -- roster-status query: one malformed row degrades to 0, never 500s.
        -- A withdrawal marks the link but leaves the staged name, so each
        -- withdrawn link comes off the staged size; a withdrawn candidate
        -- who was never staged under-counts by one, which only falls back
        -- toward the linked count.
        (
          SELECT GREATEST(
            0,
            CASE
              WHEN jsonb_typeof(s.payload->'candidates') = 'array'
                THEN jsonb_array_length(s.payload->'candidates')
              ELSE 0
            END
            - (
              SELECT count(*)::int
              FROM public.candidate_elections AS withdrawn
              WHERE withdrawn.election_id = e.id
                AND withdrawn.status = 'withdrawn'
            )
          )
          FROM public.staging_items AS s
          WHERE s.item_type = 'candidate_roster'
            AND s.ingest_key = 'candidate_roster:' || e.id::text
            AND s.status IN ('validated', 'written')
        ) AS staged_roster_size,
        e.discovery_contest_family,
        e.sources,
        office.id AS office_id,
        office.scope AS office_scope,
        office.canonical_name AS office_canonical_name,
        office.summary AS office_summary,
        -- Population of the district's own state (its statewide row), the
        -- anchor of the state-anchored model in
        -- recomputeRepresentationPowerScores, so the detail page can show
        -- the representation formula with real numbers.
        (
          SELECT d2.population
          FROM public.districts AS d2
          WHERE d2.district_type = 'statewide'
            AND d2.state_fips = d.state_fips
            AND d2.population IS NOT NULL
            AND d2.population > 0
          -- Deterministic under duplicate statewide rows (the schema only
          -- keys (district_type, geoid_compact)): largest population, the
          -- same rule the recompute's MAX() aggregate applies.
          ORDER BY d2.population DESC
          LIMIT 1
        ) AS scope_state_population
      FROM public.elections AS e
      JOIN public.districts AS d
        ON d.id = e.district_id
      LEFT JOIN public.offices AS office
        ON office.id = e.office_id
      WHERE e.id = $1::uuid
      LIMIT 1
    `,
    [electionId]
  );
  return result.rows;
}

// Human name for the state-anchored baseline behind
// representation_power_score, matching recomputeRepresentationPowerScores.
function toRepresentationScope(
  row: ElectionDetailRow | undefined,
  district: { state: string }
): { statePopulation: number; description: string } | null {
  const statePopulation = parseDistrictPopulation(row?.scope_state_population);
  if (statePopulation === null) {
    return null;
  }
  return {
    statePopulation,
    description: `a statewide vote in ${district.state}`,
  };
}

export async function lookupElectionDetailById(db: Queryable, electionId: string): Promise<BallotLookupElection | null> {
  const trimmedElectionId = electionId.trim();
  if (trimmedElectionId.length === 0) {
    return null;
  }

  const electionRows = await loadElectionRowById(db, trimmedElectionId);

  const details = await loadFullElectionDetails(db, electionRows);
  const detail = details[0];
  if (!detail) {
    return null;
  }

  const historicalCompetitivenessByElection = await loadHistoricalCompetitivenessByElection(db, electionRows);
  const historicalCompetitiveness = historicalCompetitivenessByElection.get(detail.id) ?? null;

  // Office + research areas, mirroring the ballot-summary shape. Both
  // loaders no-op on empty input, so these queries only run (and only need
  // test mocks) when the election actually has an office or a measure.
  // Issued after every pre-existing query so ordered test mocks keep their
  // slots.
  const electionRow = electionRows[0];
  // Office columns are nullable only because of the LEFT JOIN (and summary
  // is NOT NULL in the schema); resolved office rows have non-empty fields.
  // Same guard as the ballot-summary path.
  const office =
    electionRow?.office_id && electionRow.office_scope && electionRow.office_canonical_name && electionRow.office_summary
      ? {
          id: electionRow.office_id,
          scope: electionRow.office_scope,
          canonical_name: electionRow.office_canonical_name,
          summary: electionRow.office_summary,
        }
      : null;
  const officeResearchAreaRows = await loadOfficeResearchAreaSummaryRows(
    db,
    electionRow?.office_id ? [electionRow.office_id] : []
  );
  const measureResearchAreaRows = await loadMeasureResearchAreaSummaryRows(
    db,
    detail.ballot_measure ? [detail.id] : []
  );

  // Fault-isolated committee-label pass: mutates the finance summaries
  // already embedded in detail.candidates.
  await applyFinanceCommitteeLabels(
    db,
    detail.candidates.map((candidate) => candidate.finance_summary)
  );

  // Current-cycle rating load stays the LAST query so every pre-existing
  // ordered test mock keeps its slot.
  const currentRatingByElection = await loadCurrentCompetitivenessByElection(db, electionRows);
  const currentRatingRecord = currentRatingByElection.get(detail.id) ?? null;
  // Same uncontested gate as the summary list: a roster that fits the seats
  // grades "none" whatever the label, so the rating did not drive the grade
  // and the payload contract keeps the field null.
  // Same larger-of rule as the summary list (see staged_roster_size).
  const rosterCandidateCount = Math.max(detail.candidates.length, electionRow?.staged_roster_size ?? 0);
  const uncontested = isUncontestedOfficeRace({
    raceType: detail.race_type,
    candidateCount: rosterCandidateCount,
    seatsToFill: detail.seats_to_fill,
  });
  const currentCompetitiveness =
    currentRatingRecord && !uncontested ? toCurrentCompetitiveness(currentRatingRecord) : null;

  const votePowerInput = {
    raceType: detail.race_type,
    officialBallotTitle: detail.official_ballot_title,
    candidateCount: rosterCandidateCount,
    seatsToFill: detail.seats_to_fill,
    representationPowerScore: detail.district.representation_power_score,
    // A fresh, confident current rating outranks historic margins.
    competitivenessLabel:
      currentCompetitiveness?.competitiveness_label ?? historicalCompetitiveness?.competitiveness_label,
  };
  const votePower = calculateVotePower(votePowerInput);
  // When the current rating drove the label, the explanation carries the
  // rating context and NONE of the historic margin fields — mixing the two
  // sources would caption one source's grade with the other's numbers.
  const decisivenessExplanationContext = currentCompetitiveness
    ? {
        currentRating: currentRatingRecord ? toCurrentRatingExplanationContext(currentRatingRecord) : null,
        marginPercent: null,
        marginElectionYears: null,
        marginContests: null,
      }
    : {
        staleAfterRedistricting: historicalCompetitiveness?.stale_after_redistricting,
        marginPercent: historicalCompetitiveness?.margin_percent ?? null,
        // Full year list: a weighted multi-year margin must not be pinned
        // on the single latest election_year.
        marginElectionYears: historicalCompetitiveness
          ? (historicalCompetitiveness.election_years ?? [historicalCompetitiveness.election_year])
          : null,
        marginContests:
          historicalCompetitiveness?.contests_used?.map((contest) => ({
            marginPercent: contest.margin_percent,
            electionYear: contest.election_year,
            weight: contest.weight ?? 1,
          })) ?? null,
      };
  return {
    ...detail,
    office,
    // Office links first, then ballot-measure tags not already present —
    // the same merge the summary list uses.
    research_areas: mergeResearchAreaSummaries(officeResearchAreaRows, measureResearchAreaRows),
    historical_competitiveness: historicalCompetitiveness,
    current_competitiveness: currentCompetitiveness,
    vote_power: {
      ...votePower,
      explanation: explainVotePower(
        // Explanation-only context (population, margin or rating source,
        // scope extremes): the rating itself ignores it (calculateVotePower
        // above).
        {
          ...votePowerInput,
          districtPopulation: detail.district.population,
          representationScope: toRepresentationScope(electionRows[0], detail.district),
          ...decisivenessExplanationContext,
        },
        votePower
      ),
    },
  };
}

export type CandidateElectionFinanceResult = {
  finance_summary: BallotLookupFinanceSummary | null;
};

// Narrow read for the candidate-profile page: one candidate's finance
// summary in one election, without loading every opponent's records and
// tags the way lookupElectionDetailById must. null = the election does not
// exist or the candidate is not in it — including deleted or merged
// candidates, matching the profile reader's identity guards, so this
// sub-resource 404s whenever the profile itself does. An existing pairing
// with no finance coverage is { finance_summary: null }.
export async function lookupCandidateElectionFinanceSummaryById(
  db: Queryable,
  electionId: string,
  candidateId: string
): Promise<CandidateElectionFinanceResult | null> {
  const trimmedElectionId = electionId.trim();
  const trimmedCandidateId = candidateId.trim();
  if (trimmedElectionId.length === 0 || trimmedCandidateId.length === 0) {
    return null;
  }

  const electionRows = await loadElectionRowById(db, trimmedElectionId);
  if (electionRows.length === 0) {
    return null;
  }

  const candidateResult = await db.query<FinanceLookupCandidateRow>(
    `
      SELECT
        ce.election_id,
        c.id AS candidate_id,
        c.fec_ids
      FROM public.candidate_elections AS ce
      JOIN public.candidates AS c
        ON c.id = ce.candidate_id
      WHERE ce.election_id = $1::uuid
        AND ce.candidate_id = $2::uuid
        AND c.deleted_at IS NULL
        AND c.merged_into_candidate_id IS NULL
      LIMIT 1
    `,
    [trimmedElectionId, trimmedCandidateId]
  );
  const candidateRow = candidateResult.rows[0];
  if (!candidateRow) {
    return null;
  }

  const financeSummaryByCandidateElection = await loadCandidateFinanceSummariesByCandidateElection(
    db,
    candidateResult.rows,
    electionRows
  );
  // Key on the DB-canonical row ids, not the request strings: the loaders
  // key their maps on lowercase ids from the database, and isUuid accepts
  // uppercase hex that Postgres matches but a string-keyed Map does not.
  const financeSummary =
    financeSummaryByCandidateElection.get(candidateElectionKey(candidateRow.candidate_id, candidateRow.election_id)) ??
    null;
  // Last query of the lookup, fault-isolated inside.
  await applyFinanceCommitteeLabels(db, [financeSummary]);
  return { finance_summary: financeSummary };
}

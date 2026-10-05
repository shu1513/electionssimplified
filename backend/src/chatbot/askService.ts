// The "Ask" pipeline: intent router → answer cache → hybrid retrieval →
// answerability gate → LLM answer (flag/cap/budget permitting) or template
// answer / result cards — docs/plans/chatbot-rag.md.
//
// Every outcome logs one anonymous, redacted row to chatbot.questions
// (fire-and-forget; a failed insert never fails the answer).

import type { Pool } from "pg";

import { answerWithLlm, buildScopeKey, getCachedAskResponse, type LlmAnswering } from "./answer.js";
import { suggestClosestCandidates } from "./didYouMean.js";
import {
  detectBareStateReply,
  detectIntent,
  detectStateInQuestion,
  hasPersonalIssuesPhrase,
  STATE_TEMPLATE_INTENTS,
  type IntentMatch,
} from "./intents.js";
import { normalizeQuestion, normalizeQuestionForCacheKey } from "./redact.js";
import {
  classifyRaceQuestion,
  getActiveGeneration,
  isAnswerable,
  retrieveChunks,
  GATE_MIN_ENTITY_SIMILARITY,
  RACE_COLLECTIVE_RE,
  type CandidateEntityMatch,
  type RetrievalResult,
  type RetrievedChunk,
} from "./retrieval.js";
import { REFUSAL_NO_DATA_ANSWER, toResultCards, type AskResultCard } from "./shared.js";
import type { EmbeddingsClient } from "./embeddingsClient.js";
import {
  lookupBallotSummariesByDistrictIds,
  type BallotLookupElectionSummary,
} from "../pipeline/address/ballotLookup.js";
import { COMPETITIVENESS_LABELS } from "../pipeline/competitiveness/competitivenessLabels.js";
import { listUserDistrictIds, UserDistrictReaderError } from "../pipeline/users/userDistrictReader.js";
import {
  loadUserResearchAreaWeights,
  scoreResearchAreaMatch,
  type UserResearchAreaWeights,
} from "../pipeline/users/userResearchAreaScoring.js";
import { displayElectionTitle } from "../utils/displayElectionTitle.js";

export type AskOutcome = "template" | "retrieval" | "clarify" | "refuse_no_data" | "refuse_policy";

export type { AskResultCard } from "./shared.js";

export type AskResponse = {
  outcome: AskOutcome;
  answer: string;
  results: AskResultCard[];
  /** Active generation activation time for retrieval answers; null for
   * deterministic templates (they are live, not indexed). */
  data_current_as_of: string | null;
  /** True only for model-generated prose (Phase 2). Absent/false everywhere
   * else — the widget uses it for the AI label + report control
   * (BEHAVIOR.md rule 9). */
  ai_generated?: boolean;
  /** Opaque 👍/👎 token for POST /api/chatbot/feedback (feedback.ts).
   * Attached per ask AFTER the answer cache — cached JSON never carries one,
   * so every asker votes on their own token. Absent for operator scripts
   * (eval) that run without a token minter. */
  feedback_token?: string;
  /** Deterministic server copy the widget shows as a muted line when the
   * answer silently degraded — today only the daily-limit fallbacks, which
   * would otherwise serve cards indistinguishable from a plain retrieval
   * answer. Never model output, and never cached (the cards path is not
   * cached; LLM answers carry no notice). */
  notice?: string;
};

export type AskContext =
  | { kind: "candidate"; id: string }
  | { kind: "election"; id: string };

export type AskService = {
  /** userId enables the Phase 2 LLM path (per-user cap + provider abuse
   * identifier). The endpoint is verified-accounts-only, so the API always
   * has one; operator scripts (eval) may omit it — they stay retrieval-only. */
  ask: (
    question: string,
    previousQuestion?: string | null,
    context?: AskContext | null,
    userId?: string | null
  ) => Promise<AskResponse>;
};

// Context only applies to questions that point at it: "tell me more about
// THIS candidate", "what's THEIR voting record". A non-deictic question on a
// candidate page ("what will the weather be on election day?") must still be
// judged on its own evidence, or every off-topic question asked from a
// candidate page would pass the gate on the page's chunks.
const DEICTIC_RE = /\b(?:this|that|these|those|his|her|hers|their|theirs|its|he|she|they|him|them|it)\b/i;

type ResolvedContext = {
  kind: "candidate" | "election";
  id: string;
  state: string | null;
};

/** Lowercased, diacritic-stripped word tokens — the unit page-candidate name
 * matching compares on. */
export function nameTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Name tokens that are also common question grammar: matching on these
 * would hand page context — and its answerability-gate bypass — to
 * unrelated questions asked on a page listing a candidate named Will, May,
 * or June ("Will there be a runoff?", "When may I register?", "the June
 * primary"). Such candidates stay reachable by their OTHER name tokens,
 * deictic phrasing, or the entity branch. Auxiliaries/modals that are
 * plausible names, name-plausible months, and "justice" (judicial-page
 * questions say it constantly). */
const NAME_TOKEN_STOPWORDS = new Set([
  "will",
  "bill",
  "may",
  "march",
  "april",
  "june",
  "july",
  "august",
  "justice",
]);

/** Pure core of page-candidate name matching: does the question exactly
 * contain a usable name token (3+ chars, so initials and stray "de"/"la"
 * particles don't count; not question grammar per NAME_TOKEN_STOPWORDS) of
 * any of these display names? Exact whole-word match on purpose: fuzzy
 * matching here would re-attach off-topic questions to the page and bypass
 * the answerability gate. */
export function questionNamesAnyOf(displayNames: readonly string[], question: string): boolean {
  const questionTokens = new Set(nameTokens(question));
  return displayNames.some((name) =>
    nameTokens(name).some(
      (token) => token.length >= 3 && !NAME_TOKEN_STOPWORDS.has(token) && questionTokens.has(token)
    )
  );
}

/** Non-deictic questions can still point at the viewed page by NAME:
 * "what's the difference between Maria and Rhonda" asked on the election
 * page listing them both. True when the question names (per
 * questionNamesAnyOf) a candidate in the contexted election — or, for
 * candidate context, in any of that candidate's races (so opponents count
 * too). */
async function questionNamesPageCandidate(
  db: Pool,
  generationId: string,
  context: AskContext,
  question: string
): Promise<boolean> {
  const result = await db.query<{ display_name: string }>(
    `
      SELECT DISTINCT COALESCE(
        NULLIF(trim(candidate.display_name), ''),
        trim(concat_ws(' ', candidate.first_name, candidate.last_name))
      ) AS display_name
      FROM chatbot.chunks AS chunk
      JOIN public.candidates AS candidate ON candidate.id = chunk.source_id
      WHERE chunk.generation_id = $1::uuid
        AND chunk.source_type = 'candidate_profile'
        AND chunk.election_id IN (
          SELECT ctx.election_id
          FROM chatbot.chunks AS ctx
          WHERE ctx.generation_id = $1::uuid
            AND ctx.election_id IS NOT NULL
            AND (
              ($2 = 'election' AND ctx.election_id = $3::uuid)
              OR ($2 = 'candidate' AND ctx.source_id = $3::uuid)
            )
        )
    `,
    [generationId, context.kind, context.id]
  );
  return questionNamesAnyOf(
    result.rows.map((row) => row.display_name),
    question
  );
}

/** Validates the page context against the ACTIVE generation (a stale or
 * out-of-corpus id resolves to null and the question stands on its own). */
async function resolveContext(db: Pool, generationId: string, context: AskContext): Promise<ResolvedContext | null> {
  const result = await db.query<{ state: string | null }>(
    `
      SELECT state
      FROM chatbot.chunks
      WHERE generation_id = $1::uuid
        AND source_type = $2
        AND source_id = $3::uuid
      LIMIT 1
    `,
    [generationId, context.kind === "candidate" ? "candidate_profile" : "election", context.id]
  );
  const row = result.rows[0];
  return row ? { kind: context.kind, id: context.id, state: row.state } : null;
}

const POLICY_REFUSAL_ANSWER =
  "I can't recommend how to vote — no endorsements, ever. I can share neutral information from our data instead: who is running, their backgrounds and records, and campaign finance.";

// Fixed for the current cycle the corpus covers; revisit with the 2027+
// cohorts. Deterministic on purpose (BEHAVIOR.md rule 6).
const GENERAL_ELECTION_DATE_ANSWER =
  "The November 2026 general election is on Tuesday, November 3, 2026. Some places also have earlier primaries, runoffs, or special elections — check the election pages for exact dates.";

// Countdown to the same fixed date — pure date math, no data. Election day is
// a LOCAL calendar date and the server (or its clock) can sit in any
// timezone, so "today" is anchored to US Eastern (UTC-5; DST has ended by
// election week): without the client's timezone that is the least-wrong
// boundary — exact for the earliest US clocks, off only for a few
// late-evening hours further west. Uses only UTC accessors so the answer
// never depends on the server's own timezone.
const ELECTION_DAY_UTC = Date.UTC(2026, 10, 3);
const EASTERN_UTC_OFFSET_MS = 5 * 3_600_000;
export function electionCountdownAnswer(now: Date = new Date()): string {
  const eastern = new Date(now.getTime() - EASTERN_UTC_OFFSET_MS);
  const todayUtc = Date.UTC(eastern.getUTCFullYear(), eastern.getUTCMonth(), eastern.getUTCDate());
  const days = Math.round((ELECTION_DAY_UTC - todayUtc) / 86_400_000);
  if (days > 1) {
    return `The November 2026 general election is on Tuesday, November 3, 2026 — ${days} days from today.`;
  }
  if (days === 1) {
    return "The November 2026 general election is tomorrow: Tuesday, November 3, 2026.";
  }
  if (days === 0) {
    return "The November 2026 general election is today, Tuesday, November 3, 2026!";
  }
  return "The November 2026 general election was on Tuesday, November 3, 2026.";
}

type StateLogisticsRow = {
  state_abbreviation: string;
  state_name: string;
  polling_place_url: string;
  voter_registration_url: string;
  id_requirements: string;
  online_registration_available: boolean;
  online_registration_deadline_rule: string | null;
  in_person_registration_deadline_rule: string;
  same_day_registration_available: boolean;
  mail_voting_available: boolean;
  mail_ballot_request_url: string | null;
  mail_ballot_request_deadline_rule: string | null;
  /** First research-evidence URL behind id_requirements / the mail fields
   * (state_resources.sources is a field→[urls] map). May be third-party
   * (NCSL), so cards label these as sources, never as official. */
  id_requirements_source_url: string | null;
  mail_voting_source_url: string | null;
};

// Chatbot-local read of the manually researched official links (BEHAVIOR.md
// rule 5: logistics answers come only from state_resources). Deliberately not
// widening the shared stateVotingResources reader: this module must stay
// deletable without touching shared code.
async function loadStateLogistics(db: Pool, stateAbbreviation: string): Promise<StateLogisticsRow | null> {
  const result = await db.query<StateLogisticsRow>(
    `
      SELECT
        state_abbreviation,
        state_name,
        polling_place_url,
        voter_registration_url,
        id_requirements,
        online_registration_available,
        online_registration_deadline_rule,
        in_person_registration_deadline_rule,
        same_day_registration_available,
        mail_voting_available,
        mail_ballot_request_url,
        mail_ballot_request_deadline_rule,
        sources->'id_requirements'->>0 AS id_requirements_source_url,
        sources->'mail_voting_available'->>0 AS mail_voting_source_url
      FROM public.state_resources
      WHERE state_abbreviation = $1
    `,
    [stateAbbreviation]
  );
  return result.rows[0] ?? null;
}

// Researched deadline rules are sentences that usually end in a period; the
// templates add their own punctuation, so strip the trailing one ("…election..").
function trimRule(rule: string): string {
  return rule.trim().replace(/\.+$/, "");
}

/** The asker's state from their saved districts — logged-in members should
 * not be asked "which state do you vote in" when their account already says.
 * Exactly one distinct state or null: multi-state saves (moved, researching
 * elsewhere) fall back to asking. Failure → null: a template answer must
 * degrade to the ask-which-state copy, never 500. */
async function lookupUserState(db: Pool, userId: string): Promise<string | null> {
  try {
    const result = await db.query<{ state: string }>(
      `
        SELECT DISTINCT d.state
        FROM public.user_districts AS ud
        JOIN public.districts AS d ON d.id = ud.district_id
        WHERE ud.user_id = $1::uuid
        LIMIT 2
      `,
      [userId]
    );
    return result.rows.length === 1 ? (result.rows[0] as { state: string }).state : null;
  } catch (error: unknown) {
    console.warn(
      "chatbot user-state lookup failed; falling back to state-less template:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

// /me/ballot, not /ballot: the ask endpoint is verified-accounts-only, so the
// asker always has the saved-ballot page — it uses their saved districts and,
// when none are saved yet, walks them through the address search itself. The
// public /ballot page renders "No districts selected" without ?d= params.
const BALLOT_CARD: AskResultCard = {
  title: "Look up your ballot",
  url: "/me/ballot",
  snippet: "See every election and candidate on your ballot.",
  source_type: "page",
};

const SETTINGS_ISSUES_CARD: AskResultCard = {
  title: "Choose your issues",
  url: "/me/settings",
  snippet: "Pick and rank the issues you care about.",
  source_type: "page",
};

/** How many matched races the answer names — the rest stay on the ballot
 * page (the answer says how many matched in total). */
const MY_ISSUES_MAX_RACES = 5;

export type MyIssuesBallotElection = Pick<
  BallotLookupElectionSummary,
  "id" | "official_ballot_title" | "election_date" | "research_areas"
>;

/**
 * Matches the asker's saved research areas against their ballot's elections
 * (offices and ballot measures both carry research-area tags). Pure: the
 * ask() wrapper loads the weights and ballot, this ranks and renders.
 * Ranking reuses scoreResearchAreaMatch — the exact scorer behind the ballot
 * page's my_areas sort — so the chat answer and the sorted ballot page agree
 * on what "matters most" means. Races only, never candidates: pointing
 * at a race that touches a saved issue is navigation; ranking candidates by
 * issue alignment would edge into rule 1 territory.
 */
export function myIssuesBallotAnswer(
  weights: UserResearchAreaWeights,
  elections: readonly MyIssuesBallotElection[]
): AskResponse {
  const matched = elections
    .map((election) => {
      const areas = election.research_areas
        .filter((area) => weights.has(area.id))
        .sort(
          (a, b) =>
            (weights.get(a.id)?.rank ?? 0) - (weights.get(b.id)?.rank ?? 0) || a.name.localeCompare(b.name)
        );
      const match = scoreResearchAreaMatch(areas.map((area) => area.id), weights);
      return { election, areas, match };
    })
    .filter((entry) => entry.areas.length > 0)
    .sort(
      // Same first two keys as the ballot page's my_areas sort (weight sum,
      // then best matched rank — two weak matches must not outrank the
      // user's #1 issue on a tie), then a deterministic date/title tail.
      (a, b) =>
        b.match.score - a.match.score ||
        a.match.bestRank - b.match.bestRank ||
        a.election.election_date.localeCompare(b.election.election_date) ||
        a.election.official_ballot_title.localeCompare(b.election.official_ballot_title)
    );

  if (matched.length === 0) {
    return {
      outcome: "template",
      answer:
        "None of the races on your ballot are tagged with the issues you saved. You can still browse your full ballot, or adjust your issues in Settings.",
      results: [BALLOT_CARD, SETTINGS_ISSUES_CARD],
      data_current_as_of: null,
    };
  }

  const top = matched.slice(0, MY_ISSUES_MAX_RACES);
  const listed = top
    .map((entry) => `${entry.election.official_ballot_title} (${entry.areas.map((area) => area.name).join(", ")})`)
    .join("; ");
  const lead =
    matched.length === 1
      ? "1 race on your ballot touches the issues you saved"
      : `${matched.length} races on your ballot touch the issues you saved${
          matched.length > MY_ISSUES_MAX_RACES ? ` — the closest ${MY_ISSUES_MAX_RACES} matches` : ""
        }`;
  return {
    outcome: "template",
    answer: `${lead}: ${listed}.`,
    results: top.map((entry) => ({
      title: entry.election.official_ballot_title,
      url: `/elections/${entry.election.id}`,
      snippet: `Touches your saved issues: ${entry.areas.map((area) => area.name).join(", ")}.`,
      source_type: "election",
    })),
    data_current_as_of: null,
  };
}

/** How many measures / close races the answer names outright; the rest stay
 * on the ballot page (the answer says the total). Same idea as
 * MY_ISSUES_MAX_RACES. */
const MY_MEASURES_MAX = 8;
const MY_CLOSE_RACES_MAX = 5;

/** The subset of the ballot summary the personalized ballot templates read.
 * Pick-typed like MyIssuesBallotElection so tests build small literals. */
export type MyBallotElection = Pick<
  BallotLookupElectionSummary,
  | "id"
  | "official_ballot_title"
  | "election_date"
  | "race_type"
  | "vote_power"
  | "current_competitiveness"
  | "historical_competitiveness"
>;

/** my_measures_ballot: the saved ballot's measure races, reader order kept
 * (election_date, race_type, title — already deterministic). Same rule-11
 * posture as myIssuesBallotAnswer: template only, no retrieval/cache/LLM. */
export function myMeasuresBallotAnswer(elections: readonly MyBallotElection[]): AskResponse {
  const measures = elections.filter((election) => election.race_type === "ballot_measure");
  if (measures.length === 0) {
    return {
      outcome: "template",
      answer:
        "I don't see any ballot measures on your ballot right now. You can browse your full ballot, or check back — measures are added as they're researched.",
      results: [BALLOT_CARD],
      data_current_as_of: null,
    };
  }
  const top = measures.slice(0, MY_MEASURES_MAX);
  const listed = top.map((measure) => measure.official_ballot_title).join("; ");
  const lead =
    measures.length === 1
      ? "1 ballot measure is on your ballot"
      : `${measures.length} ballot measures are on your ballot${
          measures.length > MY_MEASURES_MAX ? ` — the first ${MY_MEASURES_MAX}` : ""
        }`;
  return {
    outcome: "template",
    answer: `${lead}: ${listed}.`,
    results: top.map((measure) => ({
      title: measure.official_ballot_title,
      url: `/elections/${measure.id}`,
      snippet: "Ballot measure on your ballot.",
      source_type: "election",
    })),
    data_current_as_of: null,
  };
}

/** Effective competitiveness rating for one race: the current-cycle analyst
 * rating when the payload carries one (it is present ONLY when it drove the
 * vote-power decisiveness label), else the historical-margin rating — the
 * same precedence the ballot page's chip render uses. */
function effectiveCompetitiveness(election: MyBallotElection) {
  return election.current_competitiveness ?? election.historical_competitiveness ?? null;
}

/** Labels the answer counts as "close". Ordered enum: toss_up is index 0. */
const CLOSE_LABEL_MAX_INDEX = COMPETITIVENESS_LABELS.indexOf("competitive");

/** my_close_races: rated races on the saved ballot, closest first. Rank =
 * label order (COMPETITIVENESS_LABELS, most competitive first), then the
 * ballot page's vote_power tiebreak (score desc, unknown last), then the
 * reader's date/title order. Deliberately mirrors compareBySort's vote_power
 * branch (ballotElectionOrdering.ts) instead of importing it: that comparator
 * needs the full ordered-summary shape and followed-candidate plumbing this
 * template never loads. */
export function myCloseRacesAnswer(elections: readonly MyBallotElection[]): AskResponse {
  const rated = elections
    .map((election) => ({ election, rating: effectiveCompetitiveness(election) }))
    .filter((entry): entry is { election: MyBallotElection; rating: NonNullable<ReturnType<typeof effectiveCompetitiveness>> } =>
      entry.rating !== null
    );
  if (rated.length === 0) {
    return {
      outcome: "template",
      answer:
        "I don't have competitiveness ratings for the races on your ballot yet. You can browse your full ballot in the meantime.",
      results: [BALLOT_CARD],
      data_current_as_of: null,
    };
  }
  const close = rated
    .filter((entry) => COMPETITIVENESS_LABELS.indexOf(entry.rating.competitiveness_label) <= CLOSE_LABEL_MAX_INDEX)
    .sort(
      (a, b) =>
        COMPETITIVENESS_LABELS.indexOf(a.rating.competitiveness_label) -
          COMPETITIVENESS_LABELS.indexOf(b.rating.competitiveness_label) ||
        (typeof b.election.vote_power.score === "number" ? b.election.vote_power.score : Number.NEGATIVE_INFINITY) -
          (typeof a.election.vote_power.score === "number" ? a.election.vote_power.score : Number.NEGATIVE_INFINITY) ||
        a.election.election_date.localeCompare(b.election.election_date) ||
        a.election.official_ballot_title.localeCompare(b.election.official_ballot_title)
    );
  if (close.length === 0) {
    return {
      outcome: "template",
      answer:
        rated.length === 1
          ? "The 1 rated race on your ballot doesn't look especially close right now. You can browse your full ballot for the details."
          : `None of the ${rated.length} rated races on your ballot look especially close right now. You can browse your full ballot for the details.`,
      results: [BALLOT_CARD],
      data_current_as_of: null,
    };
  }
  const top = close.slice(0, MY_CLOSE_RACES_MAX);
  const listed = top
    .map((entry) => `${entry.election.official_ballot_title} (${entry.rating.display_label})`)
    .join("; ");
  const lead =
    close.length === 1
      ? "1 race on your ballot looks close"
      : `${close.length} races on your ballot look close${
          close.length > MY_CLOSE_RACES_MAX ? ` — the closest ${MY_CLOSE_RACES_MAX}` : ""
        }`;
  return {
    outcome: "template",
    answer: `${lead}: ${listed}. Ratings describe how contested a race looks — they are not predictions or endorsements.`,
    results: top.map((entry) => ({
      title: entry.election.official_ballot_title,
      url: `/elections/${entry.election.id}`,
      snippet: `${entry.rating.display_label} — ${entry.rating.display_description}`,
      source_type: "election",
    })),
    data_current_as_of: null,
  };
}

/**
 * my_issues_ballot intent: personalized, so it must stay on this template
 * path — never retrieval (the public corpus knows nothing about the asker)
 * and never the shared answer cache or LLM (rule 11: account data stays out
 * of prompts; the cache is keyed per-question, not per-user).
 */
async function renderMyIssuesBallotAnswer(db: Pool, userId: string | null): Promise<AskResponse> {
  const weights: UserResearchAreaWeights = userId ? await loadUserResearchAreaWeights(db, userId) : new Map();
  if (weights.size === 0) {
    return {
      outcome: "template",
      answer:
        "I don't know which issues you care about yet. Pick your issues in Settings, then ask again and I'll match them against your ballot.",
      results: [SETTINGS_ISSUES_CARD],
      data_current_as_of: null,
    };
  }
  const elections = await loadAskerBallotElections(db, userId);
  if (elections === null) {
    return {
      outcome: "template",
      answer:
        "I have your saved issues, but not where you vote. Set up your ballot page first — then I can point at the races that touch them.",
      results: [BALLOT_CARD],
      data_current_as_of: null,
    };
  }
  return myIssuesBallotAnswer(weights, elections);
}

/** The asker's saved-ballot elections, or null when the account saved no
 * districts. A vanished/deleted account mid-chat (UserDistrictReaderError)
 * degrades to null — a setup prompt, never a 500. */
async function loadAskerBallotElections(
  db: Pool,
  userId: string | null
): Promise<BallotLookupElectionSummary[] | null> {
  let districtIds: string[] = [];
  if (userId) {
    try {
      districtIds = await listUserDistrictIds(db, userId);
    } catch (error) {
      if (!(error instanceof UserDistrictReaderError)) {
        throw error;
      }
    }
  }
  if (districtIds.length === 0) {
    return null;
  }
  const summary = await lookupBallotSummariesByDistrictIds(db, districtIds);
  // The template answers print these titles, so they carry display casing.
  return summary.elections.map((election) => ({
    ...election,
    official_ballot_title: displayElectionTitle(election.official_ballot_title),
  }));
}

/** Shared "set up your ballot first" prompt for the personalized ballot
 * templates that need only the saved ballot (no saved issues involved). */
const NO_SAVED_BALLOT_ANSWER: AskResponse = {
  outcome: "template",
  answer:
    "I don't know where you vote yet. Set up your ballot page first — then I can answer this from your saved ballot.",
  results: [BALLOT_CARD],
  data_current_as_of: null,
};

async function renderMyMeasuresBallotAnswer(db: Pool, userId: string | null): Promise<AskResponse> {
  const elections = await loadAskerBallotElections(db, userId);
  return elections === null ? NO_SAVED_BALLOT_ANSWER : myMeasuresBallotAnswer(elections);
}

async function renderMyCloseRacesAnswer(db: Pool, userId: string | null): Promise<AskResponse> {
  const elections = await loadAskerBallotElections(db, userId);
  return elections === null ? NO_SAVED_BALLOT_ANSWER : myCloseRacesAnswer(elections);
}

function describeEntityOption(match: CandidateEntityMatch): string {
  const officePart = match.currentOffice ? `, ${match.currentOffice}` : "";
  const partyPart = match.party ? ` (${match.party})` : "";
  return `${match.displayName}${partyPart} — ${match.state}${officePart}`;
}

// Scope-ambiguity heuristic (rule 7): a race-level question with no named
// candidate whose election-title matches tie across races the question
// cannot separate — across 2+ states when no state is known ("the sheriff
// race" fits dozens of counties equally), or across districts inside a
// known state (retrieval's raceTitleAmbiguous). A question with one clearly
// dominant title match (its place tokens named, or an exact measure title)
// is not tied. Restricted to listing phrasings PLUS money/records questions
// that name a race ("who has raised more in the Senate race?" — PR-4
// review: these skipped clarify and answered from an arbitrary state's
// chunks) so entity and measure questions never trip it.
// 0.8, not 0.85: office-alias expansion (PR 4) puts the strongest cross-
// office confusion at EXACTLY 0.8 ("State Senator" against a federally
// aliased question, 30+ states) — at 0.85 an arbitrary state's 1.0 match
// looked "clearly dominant" over that band and skipped clarification.
const SCOPE_TIE_RATIO = 0.8;
const RACE_LISTING_RE = /\bwho(?:'s| is| are)?\s+(?:running|on\s+the\s+ballot|the\s+candidates?)\b|\bcandidates\s+for\b/i;
const RACE_NOUN_RE = /\brace\b|\belection\b|\bseat\b|\bcontest\b/i;

function isRaceScopedQuestion(question: string): boolean {
  return (
    RACE_LISTING_RE.test(question) ||
    (classifyRaceQuestion(question) !== "neutral" && RACE_NOUN_RE.test(question))
  );
}

function needsScopeClarification(question: string, retrieval: RetrievalResult, scopeState: string | null): boolean {
  // The viewed page already determines the race — a deictic question must
  // never be bounced for scope.
  if (retrieval.contextMatched) {
    return false;
  }
  if (retrieval.bestEntitySimilarity >= GATE_MIN_ENTITY_SIMILARITY) {
    return false;
  }
  if (!isRaceScopedQuestion(question)) {
    return false;
  }
  // Within a known state the office phrase can still fit many races the
  // question can't tell apart (Georgia has 178 "State Representative"
  // races — review catch: District 24 was silently picked). Retrieval
  // detects the tie; ask which district/place is meant.
  if (scopeState) {
    return retrieval.raceTitleAmbiguous;
  }
  const [top] = retrieval.electionTitleMatches;
  if (!top || !top.state) {
    return false;
  }
  // The question names a place some matched race is in ("Los Angeles mayor",
  // "San Jose City Council District 5") → it IS scoped; retrieval decides.
  if (retrieval.electionTitleMatches.some((match) => match.placeSimilarity >= 0.4)) {
    return false;
  }
  const tiedStates = new Set(
    retrieval.electionTitleMatches
      .filter((match) => match.state && match.similarity / top.similarity >= SCOPE_TIE_RATIO)
      .map((match) => match.state)
  );
  return tiedStates.size >= 2;
}

async function renderIntentAnswer(db: Pool, intent: IntentMatch): Promise<AskResponse> {
  // Smalltalk: friendly fixed lines, no data, no cards (BEHAVIOR-neutral —
  // nothing here asserts a fact). Checked before the state-resources fetch.
  if (intent.kind === "greeting") {
    return {
      outcome: "template",
      answer:
        "Hi! Ask me about the November 2026 elections we cover — candidates, their records, campaign finance, elections, and ballot measures.",
      results: [],
      data_current_as_of: null,
    };
  }
  if (intent.kind === "thanks") {
    return { outcome: "template", answer: "My pleasure — ask any time.", results: [], data_current_as_of: null };
  }
  if (intent.kind === "goodbye") {
    return {
      outcome: "template",
      answer: "Goodbye! Come back whenever you have election questions.",
      results: [],
      data_current_as_of: null,
    };
  }
  if (intent.kind === "help") {
    return {
      outcome: "template",
      answer:
        'I answer questions from our November 2026 election data: who\'s running, candidates\' backgrounds and records, campaign finance, elections, and ballot measures. I can also link your state\'s official pages for registering and voting. Try: "Who is running for US Senate in Georgia?"',
      // No ballot card: the capabilities text stands alone — a card here read
      // as an answer to a question nobody asked.
      results: [],
      data_current_as_of: null,
    };
  }
  if (intent.kind === "election_countdown") {
    return {
      outcome: "template",
      answer: electionCountdownAnswer(),
      results: [BALLOT_CARD],
      data_current_as_of: null,
    };
  }

  const resources = intent.state ? await loadStateLogistics(db, intent.state) : null;

  if (intent.kind === "policy_refusal") {
    return { outcome: "refuse_policy", answer: POLICY_REFUSAL_ANSWER, results: [], data_current_as_of: null };
  }

  if (intent.kind === "needs_scope") {
    return {
      outcome: "clarify",
      answer:
        "That depends on where you vote — runoff and primary dates differ by state and race. Which state, county, or city do you mean?",
      results: [],
      data_current_as_of: null,
    };
  }

  if (intent.kind === "untracked_data") {
    return {
      outcome: "refuse_no_data",
      answer:
        "I don't track candidates' social media posts. I can share what's in our data: candidate profiles, records, campaign finance, elections, and ballot measures.",
      results: [],
      data_current_as_of: null,
    };
  }

  if (intent.kind === "out_of_cycle") {
    return {
      outcome: "refuse_no_data",
      answer:
        "Our data covers the November 2026 elections, so I can't answer questions about other election years.",
      results: [],
      data_current_as_of: null,
    };
  }

  if (intent.kind === "results") {
    return {
      outcome: "template",
      answer:
        "Election results are posted on each election's page as official sources report and certify them. Look the election up from your ballot page or a candidate's page to see its current status.",
      results: [BALLOT_CARD],
      data_current_as_of: null,
    };
  }

  if (intent.kind === "ballot_lookup") {
    return {
      outcome: "template",
      answer:
        "Your ballot page shows every election and candidate for where you vote. Please don't share your address here in chat — the ballot page handles it privately.",
      results: [BALLOT_CARD],
      data_current_as_of: null,
    };
  }

  if (intent.kind === "election_date") {
    return { outcome: "template", answer: GENERAL_ELECTION_DATE_ANSWER, results: [BALLOT_CARD], data_current_as_of: null };
  }

  // Primary/runoff/special dates vary by race and are not in the Nov-2026
  // corpus — never serve the general-election date for them (rule 6). No
  // card either: state_resources has no election-calendar URL, and a
  // registration link would not support a date claim.
  if (intent.kind === "other_election_date") {
    const stateName = resources?.state_name ?? "your state";
    return {
      outcome: "template",
      answer: `Primary, runoff, and special election dates vary by state and race, and our data covers the November 2026 general election. Check ${stateName}'s official election website (usually the Secretary of State) for those dates.`,
      results: [],
      data_current_as_of: null,
    };
  }

  if (intent.kind === "where_to_vote") {
    if (resources) {
      return {
        outcome: "template",
        answer: `${resources.state_name} lists polling places through its official lookup — that's the authoritative source for where to vote.`,
        results: [
          {
            title: `${resources.state_name} official polling place lookup`,
            url: resources.polling_place_url,
            snippet: "Official state resource.",
            source_type: "official_state_resource",
          },
          BALLOT_CARD,
        ],
        data_current_as_of: null,
      };
    }
    return {
      outcome: "template",
      answer:
        "Polling places are listed by each state's official lookup. Tell me which state you vote in, or use the ballot page to find your elections.",
      results: [BALLOT_CARD],
      data_current_as_of: null,
    };
  }

  if (intent.kind === "voter_registration") {
    if (resources) {
      const deadlineParts: string[] = [];
      if (resources.online_registration_available && resources.online_registration_deadline_rule) {
        deadlineParts.push(`Online registration: ${trimRule(resources.online_registration_deadline_rule)}`);
      }
      deadlineParts.push(`In person: ${trimRule(resources.in_person_registration_deadline_rule)}`);
      if (resources.same_day_registration_available) {
        deadlineParts.push(`${resources.state_name} offers same-day registration`);
      }
      return {
        outcome: "template",
        answer: `Register to vote in ${resources.state_name} through the official state site. ${deadlineParts.join(". ")}.`,
        results: [
          {
            title: `${resources.state_name} official voter registration`,
            url: resources.voter_registration_url,
            snippet: "Official state resource.",
            source_type: "official_state_resource",
          },
        ],
        data_current_as_of: null,
      };
    }
    return {
      outcome: "template",
      answer:
        "Each state runs its own voter registration with its own deadlines. Tell me which state you vote in and I'll link its official registration page.",
      results: [],
      data_current_as_of: null,
    };
  }

  if (intent.kind === "voter_id") {
    if (resources) {
      // The ID rules are our researched data; the card links the research
      // source behind them (possibly third-party, labeled as a source — a
      // registration portal would not support an ID claim). No source
      // recorded → answer text stands alone.
      return {
        outcome: "template",
        answer: `${resources.state_name} ID rules: ${resources.id_requirements}`,
        results: resources.id_requirements_source_url
          ? [
              {
                title: `Source for ${resources.state_name}'s voter ID rules`,
                url: resources.id_requirements_source_url,
                snippet: "Where this answer's ID information comes from.",
                source_type: "source_link",
              },
            ]
          : [],
        data_current_as_of: null,
      };
    }
    return {
      outcome: "template",
      answer: "Voter ID rules differ by state. Tell me which state you vote in and I'll share its official requirements.",
      results: [],
      data_current_as_of: null,
    };
  }

  // mail_voting. The dedicated request URL is the official destination; when
  // a state has none, fall back to the research source behind the mail
  // fields (labeled as a source, never as official — a registration or
  // polling link would not support a mail-voting claim).
  if (resources) {
    const mailCard: AskResultCard[] = resources.mail_ballot_request_url
      ? [
          {
            title: `${resources.state_name} official mail ballot information`,
            url: resources.mail_ballot_request_url,
            snippet: "Official state resource.",
            source_type: "official_state_resource",
          },
        ]
      : resources.mail_voting_source_url
        ? [
            {
              title: `Source for ${resources.state_name}'s mail voting rules`,
              url: resources.mail_voting_source_url,
              snippet: "Where this answer's mail voting information comes from.",
              source_type: "source_link",
            },
          ]
        : [];
    if (!resources.mail_voting_available) {
      return {
        outcome: "template",
        answer: `${resources.state_name} does not offer general mail voting according to its official resources. Check the official site for absentee eligibility rules.`,
        results: mailCard,
        data_current_as_of: null,
      };
    }
    const deadline = resources.mail_ballot_request_deadline_rule
      ? ` Request deadline: ${trimRule(resources.mail_ballot_request_deadline_rule)}.`
      : "";
    return {
      outcome: "template",
      answer: `${resources.state_name} offers voting by mail.${deadline}`,
      results: mailCard,
      data_current_as_of: null,
    };
  }
  return {
    outcome: "template",
    answer:
      "Mail voting rules differ by state. Tell me which state you vote in and I'll link its official mail ballot information.",
    results: [],
    data_current_as_of: null,
  };
}

type QuestionLogRow = {
  questionNorm: string;
  answeredBy: string;
  scopeKey: string | null;
  matchedChunkIds: string[];
  latencyMs: number;
  /** Actual billed tokens for LLM-answered asks; null everywhere else
   * (cache hits, templates, cards). */
  tokensIn: number | null;
  tokensOut: number | null;
};

/** Honest degradation copy (PR 3): the daily-limit fallbacks serve retrieval
 * cards that look exactly like a normal card answer, so without this the
 * user can't tell the AI limit was hit. Only the limit reasons get a notice —
 * llm_failed / invalid_output are transient faults where the cards ARE the
 * best next answer, and announcing an internal error there helps nobody.
 * From the user's seat both limits mean the same thing: no AI answer today. */
export function fallbackNotice(reason: string): string | null {
  return reason === "rate_limited" || reason === "budget_exhausted"
    ? "Daily AI-answer limit reached — showing matching data instead."
    : null;
}

function logQuestion(db: Pool, row: QuestionLogRow): void {
  // Fire-and-forget: the log must never delay or fail an answer.
  void db
    .query(
      `
        INSERT INTO chatbot.questions (question_norm, answered_by, scope_key, matched_chunk_ids, latency_ms, tokens_in, tokens_out)
        VALUES ($1, $2, $3, $4::bigint[], $5, $6, $7)
      `,
      [row.questionNorm, row.answeredBy, row.scopeKey, row.matchedChunkIds, row.latencyMs, row.tokensIn, row.tokensOut]
    )
    .catch((error: unknown) => {
      console.warn(
        "chatbot question log insert failed; answer unaffected:",
        error instanceof Error ? error.message : String(error)
      );
    });
}

export type CreateAskServiceOptions = {
  db: Pool;
  embeddings: EmbeddingsClient | null;
  /** Phase 2 LLM answering (adapter client + limits Redis + config). Absent
   * → Phase 1 behavior exactly: retrieval cards, no cache, no model. */
  llm?: LlmAnswering | null;
  /** Default true. Operator scripts (chatbot:eval) pass false so golden-set
   * runs never land in chatbot.questions — the report would otherwise
   * measure test bursts, not users. */
  logQuestions?: boolean;
  /** Mints the per-answer feedback token (feedback.ts). Absent (operator
   * scripts) → responses carry no feedback_token. Structural type on purpose:
   * the ask service needs only mint, never verify. */
  feedbackTokens?: { mint: (answeredBy: string) => string } | null;
};

export function createAskService(options: CreateAskServiceOptions): AskService {
  const { db, embeddings } = options;
  const llm = options.llm ?? null;
  const logQuestions = options.logQuestions ?? true;
  const feedbackTokens = options.feedbackTokens ?? null;

  return {
    async ask(
      question: string,
      previousQuestion?: string | null,
      context?: AskContext | null,
      userId?: string | null
    ): Promise<AskResponse> {
      const startedAt = Date.now();
      const questionNorm = normalizeQuestion(question);
      const finish = (
        response: AskResponse,
        answeredBy: string,
        scopeKey: string | null = null,
        matchedChunkIds: string[] = [],
        tokensIn: number | null = null,
        tokensOut: number | null = null
      ): AskResponse => {
        if (logQuestions) {
          logQuestion(db, {
            questionNorm,
            answeredBy,
            scopeKey,
            matchedChunkIds,
            latencyMs: Date.now() - startedAt,
            tokensIn,
            tokensOut,
          });
        }
        // Token attached to a COPY, after the answer cache: answerWithLlm
        // caches the raw response object before finish() runs, so cached JSON
        // never carries a token and mutation-order can never change that.
        // Cache hits mint their own fresh token (answeredBy "cache").
        return feedbackTokens ? { ...response, feedback_token: feedbackTokens.mint(answeredBy) } : response;
      };

      // 1. Deterministic intents (policy refusals, logistics, results).
      let intent = detectIntent(question);
      // A bare-state reply ("California") to a logistics clarification
      // completes the PREVIOUS turn's intent — on its own it has no intent
      // and would fall through to retrieval, where a lone state name matches
      // nothing and refuses.
      const bareStateReply = detectBareStateReply(question);
      if (!intent && bareStateReply && previousQuestion) {
        const previousIntent = detectIntent(previousQuestion);
        if (previousIntent && STATE_TEMPLATE_INTENTS.has(previousIntent.kind)) {
          intent = {
            // needs_scope is the state-less date ask; with a state it IS one.
            kind: previousIntent.kind === "needs_scope" ? "other_election_date" : previousIntent.kind,
            state: bareStateReply,
          };
        }
      }
      if (intent) {
        // State-parameterized logistics with no state named: the asker's
        // saved districts usually say where they vote — answer for that
        // state instead of asking (rule 5 still holds; only the state
        // parameter comes from the account, coarse and non-identifying).
        if (!intent.state && userId && STATE_TEMPLATE_INTENTS.has(intent.kind)) {
          const userState = await lookupUserState(db, userId);
          if (userState) {
            intent = {
              kind: intent.kind === "needs_scope" ? "other_election_date" : intent.kind,
              state: userState,
            };
          }
        }
        // Account-scoped intent: needs the asker, not just the question text,
        // so it renders here where userId is in hand (same pattern as the
        // saved-state resolution above).
        if (intent.kind === "my_issues_ballot") {
          const response = await renderMyIssuesBallotAnswer(db, userId ?? null);
          return finish(response, "intent:my_issues_ballot", intent.state);
        }
        if (intent.kind === "my_measures_ballot") {
          const response = await renderMyMeasuresBallotAnswer(db, userId ?? null);
          return finish(response, "intent:my_measures_ballot", intent.state);
        }
        if (intent.kind === "my_close_races") {
          const response = await renderMyCloseRacesAnswer(db, userId ?? null);
          return finish(response, "intent:my_close_races", intent.state);
        }
        const response = await renderIntentAnswer(db, intent);
        const answeredBy =
          response.outcome === "refuse_policy"
            ? "refused_policy"
            : response.outcome === "refuse_no_data"
              ? "refused"
              : response.outcome === "clarify"
                ? "clarify"
                : `intent:${intent.kind}`;
        return finish(response, answeredBy, intent.state);
      }

      // 2. Retrieval over the active generation.
      const generation = await getActiveGeneration(db);
      if (!generation) {
        return finish(
          { outcome: "refuse_no_data", answer: REFUSAL_NO_DATA_ANSWER, results: [], data_current_as_of: null },
          "refused"
        );
      }

      // Page context: applied only when the question points at it — a
      // deictic word ("this", "their"), a race-collective phrasing ("compare
      // the candidates for me"; RACE_COLLECTIVE_RE, which also arms the
      // members branch in retrieval), or a page candidate named outright
      // ("what's the difference between Maria and Rhonda" on the election
      // page listing them) — and the id still exists in the active
      // generation. A question doing none of these ("what will the weather
      // be on election day?") is judged on its own evidence.
      const resolvedContext =
        context &&
        (DEICTIC_RE.test(question) ||
          RACE_COLLECTIVE_RE.test(question) ||
          (await questionNamesPageCandidate(db, generation.id, context, question)))
          ? await resolveContext(db, generation.id, context)
          : null;

      // Deterministic follow-up scope carry-over (no LLM rewrite in v1): a
      // scopeless follow-up appends the previous turn's text so its district/
      // candidate tokens participate in matching — append-only, so nothing
      // from the current question can be dropped.
      // A bare-state reply is pure scope: it MUST carry the previous turn
      // (the question being scoped) even though it names a state itself —
      // "California" alone matches nothing. The bareStateReply fallback
      // covers bare abbreviations ("GA"): detectStateInQuestion deliberately
      // requires place context around an abbreviation, so a lone "GA" is
      // invisible to it and would leave retrieval unscoped.
      let scopeState = detectStateInQuestion(question) ?? bareStateReply;
      let retrievalText = question;
      if (previousQuestion && !resolvedContext && (!scopeState || bareStateReply)) {
        scopeState = scopeState ?? detectStateInQuestion(previousQuestion);
        retrievalText = `${question} ${previousQuestion}`;
      }
      if (!scopeState && resolvedContext) {
        scopeState = resolvedContext.state;
      }

      // Phase 2 exact-answer cache, checked BEFORE retrieval is paid for (a
      // hit skips the query embedding too). The key text is the normalized
      // FULL retrieval text — a carried-over previous turn changes the
      // answer, so it must change the key. Un-redacted, un-truncated cache
      // normalizer on purpose (see normalizeQuestionForCacheKey): the log
      // normalizer would collide distinct questions onto one key. Only
      // questions that passed the gate ever get cached, and never
      // time-sensitive ones (those returned from the intent router above;
      // BEHAVIOR.md rule 6).
      const carriedPrevious = retrievalText === question ? null : (previousQuestion ?? null);
      const cacheQuestionNorm = normalizeQuestionForCacheKey(retrievalText);
      const scopeKey = buildScopeKey(
        scopeState,
        resolvedContext ? { kind: resolvedContext.kind, id: resolvedContext.id } : null
      );
      if (llm && userId) {
        const cached = await getCachedAskResponse(llm, {
          questionNorm: cacheQuestionNorm,
          scopeKey,
          generationId: generation.id,
        });
        if (cached) {
          return finish(cached, "cache", scopeState);
        }
      }

      const retrieval = await retrieveChunks({
        db,
        embeddings,
        generationId: generation.id,
        question: retrievalText,
        scopeState,
        contextCandidateId: resolvedContext?.kind === "candidate" ? resolvedContext.id : null,
        contextElectionId: resolvedContext?.kind === "election" ? resolvedContext.id : null,
      });

      // 3. Same-name candidates → clarify, never silently pick (rule 7).
      if (retrieval.ambiguousEntities.length > 0) {
        const options_ = retrieval.ambiguousEntities.map(describeEntityOption);
        return finish(
          {
            outcome: "clarify",
            answer: `I found more than one candidate with that name. Which one do you mean? ${options_.join("; ")}.`,
            results: [],
            data_current_as_of: generation.activatedAt,
          },
          "clarify",
          scopeState
        );
      }

      // 3b. Race-collective question, but the page candidate is on more than
      // one covered ballot → ask which race, never compare an arbitrary pick
      // (rule 7). Must precede the gate: contextMatched would pass it and
      // the LLM would answer over BOTH races' listings mixed together.
      if (retrieval.contextRaceAmbiguousTitles.length > 0) {
        return finish(
          {
            outcome: "clarify",
            answer: `They're in more than one race we cover. Which one do you mean? ${retrieval.contextRaceAmbiguousTitles.join("; ")}.`,
            results: [],
            data_current_as_of: generation.activatedAt,
          },
          "clarify",
          scopeState
        );
      }

      // 4. Scopeless race questions that tie across states → clarify.
      if (needsScopeClarification(question, retrieval, scopeState)) {
        return finish(
          {
            outcome: "clarify",
            answer:
              "There are races like that in several places. Which state, county, city, or district do you mean?",
            results: [],
            data_current_as_of: generation.activatedAt,
          },
          "clarify",
          null
        );
      }

      // 5. Answerability gate on raw scores; a deictic question about the
      // viewed page is answerable on the page's own chunks.
      if (!isAnswerable(retrieval) && !retrieval.contextMatched) {
        // Before flatly refusing: a question span close to a matched
        // candidate's WHOLE name is a probable typo ("Jon Osoff") — offer
        // the closest names instead (didYouMean.ts filters the surname-only
        // noise that must keep refusing).
        const suggestions = suggestClosestCandidates(retrievalText, retrieval.entityMatches);
        if (suggestions.length > 0) {
          return finish(
            {
              outcome: "clarify",
              answer: `I couldn't find that exact name. Did you mean: ${suggestions
                .map(describeEntityOption)
                .join("; ")}?`,
              results: [],
              data_current_as_of: generation.activatedAt,
            },
            "clarify",
            scopeState
          );
        }
        // A personal-issues phrase in an otherwise unanswerable question is a
        // strong hint the asker wants their own saved data, which lives on
        // the account pages, not in the corpus. Still a refusal — serving the
        // race list here answered the wrong question for "What issues do I
        // care about?" / "How do I change my saved issues?" (PR #715 review;
        // the router's election-frame requirement exists precisely to block
        // that hijack) — but one that points at the right place instead of
        // dead-ending.
        if (hasPersonalIssuesPhrase(question)) {
          return finish(
            {
              outcome: "refuse_no_data",
              answer: `${REFUSAL_NO_DATA_ANSWER} If you're asking about your saved issues, they're in Settings — or try "Which races affect issues I care about?"`,
              results: [SETTINGS_ISSUES_CARD],
              data_current_as_of: null,
            },
            "refused_personal_hint",
            scopeState
          );
        }
        return finish(
          { outcome: "refuse_no_data", answer: REFUSAL_NO_DATA_ANSWER, results: [], data_current_as_of: null },
          "refused",
          scopeState
        );
      }

      // 6. LLM answer over the gated chunks (Phase 2), when configured and
      // the ask is user-attributed. Every guard trip or failure inside falls
      // back to the Phase 1 cards below — the LLM can only ADD an answer.
      const matchedChunkIds = retrieval.chunks.map((chunk) => chunk.id);
      // Fallbacks log their REASON as answered_by (rate_limited /
      // budget_exhausted / llm_failed / invalid_output) plus any tokens the
      // failed call still billed — llm_failed and invalid_output rates are
      // the primary canary signals for the Phase 2 rollout, and the spend
      // must stay attributable per question.
      let cardsAnsweredBy = "retrieval";
      let cardsTokensIn: number | null = null;
      let cardsTokensOut: number | null = null;
      if (llm && userId) {
        const step = await answerWithLlm({
          db,
          llm,
          userId,
          question,
          previousQuestion: carriedPrevious,
          questionNorm: cacheQuestionNorm,
          scopeKey,
          generationId: generation.id,
          generationActivatedAt: generation.activatedAt,
          chunks: retrieval.chunks,
        });
        if (step.kind === "answered") {
          return finish(step.response, "llm", scopeState, matchedChunkIds, step.tokensIn, step.tokensOut);
        }
        cardsAnsweredBy = step.reason;
        cardsTokensIn = step.tokensIn;
        cardsTokensOut = step.tokensOut;
      }

      const cards = toResultCards(retrieval.chunks);
      const notice = fallbackNotice(cardsAnsweredBy);
      return finish(
        {
          outcome: "retrieval",
          answer:
            "Here's what our data has on that. These summaries come from our election database — open a result for the full picture.",
          results: cards,
          data_current_as_of: generation.activatedAt,
          ...(notice ? { notice } : {}),
        },
        cardsAnsweredBy,
        scopeState,
        matchedChunkIds,
        cardsTokensIn,
        cardsTokensOut
      );
    },
  };
}

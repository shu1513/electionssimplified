import { findBlockedSourceReason } from "../pipeline/candidates/candidateRecordSourcePolicy.js";
import { normalizeHttpUrl } from "../utils/normalizeHttpUrl.js";
import { normalizeTwitterHandle, stripNameFootnoteMarkers } from "../utils/candidateIdentity.js";

export type CandidateProfilePayload = {
  display_name: string;
  first_name: string;
  last_name: string;
  party?: string;
  date_of_birth?: string;
  twitter_handle?: string;
  linkedin_url?: string;
  official_website_url?: string;
  fec_ids?: string[];
  state_filing_ids?: string[];
  current_office?: string;
  // Has this person EVER held public office (current or former, elected or
  // appointed)? Routing fact for candidate-record discovery sweeps; the key is
  // required so every profile pass answers it once and the sweep never
  // re-derives it. null is the explicit "sources don't cover it" answer: a
  // partisan-race aggregator page has no office-history field at all, so a
  // pass sourced from it alone can never surface a nonpartisan borough,
  // school-board, or tribal seat — forcing a boolean there manufactured false
  // for a whole class of local officeholders. false is reserved for research
  // that actually covered office history and found none.
  has_held_public_office: boolean | null;
  summary?: string;
  sources: string[];
};

export type CandidateProfilePayloadParseOptions = {
  requireFecIds?: boolean;
  allowFecIds?: boolean;
};

// Voters skim the summary next to the contest; the formula is 2 sentences —
// current role, 1-2 credentials, top 2 priorities. 300 characters holds that
// comfortably (live over-cap example: a 560-character organizer bio with
// runoff percentages). The prompt states the formula; this cap and the
// horse-race patterns below are the enforcement, so manual-research payloads
// hit the same wall as AI ones. The sentence count itself stays prompt
// guidance only: counting sentences mechanically false-rejects legitimate
// abbreviations ("St. Paul", "Jr.", "D.C."), so the cap is the enforceable
// proxy for it.
export const CANDIDATE_PROFILE_SUMMARY_MAX_LENGTH = 300;

// The honest "nothing found" outcome. When a profile pass (plus a deeper
// browser pass) finds no citable job, background, or priorities, the summary
// is this one fixed sentence — never blank, never ballot-only filler. The
// fixed wording is what makes it machine-recognizable: the demand ledger
// counts it as an open profile gap once its recheck deferral passes, and
// manual:candidate-profile:placeholders lists it for replacement. Payloads
// that carry this sentence must keep has_held_public_office null (nothing is
// known) and name the candidate exactly as display_name.
const NO_PUBLIC_INFO_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const NO_PUBLIC_INFO_MONTH_ALTERNATION = NO_PUBLIC_INFO_MONTHS.join("|");
export const NO_PUBLIC_INFO_SUMMARY_PATTERN = new RegExp(
  `^As of (${NO_PUBLIC_INFO_MONTH_ALTERNATION}) (\\d{4}), we found no public information about (.+)'s job, background, or goals\\.$`
);
// Same sentence as a POSIX regex for Postgres `~`, so SQL work queues select
// exactly the rows the JS helper recognizes.
export const NO_PUBLIC_INFO_SUMMARY_SQL_PATTERN =
  `^As of (${NO_PUBLIC_INFO_MONTH_ALTERNATION}) [0-9]{4}, we found no public information about .+'s job, background, or goals\\.$`;
// Loose cue that catches near-miss rewordings so they are rejected instead
// of shipping as unrecognizable placeholders.
const NO_PUBLIC_INFO_CUE = /no public information/i;

export function buildNoPublicInfoSummary(displayName: string, asOf: Date = new Date()): string {
  const month = NO_PUBLIC_INFO_MONTHS[asOf.getUTCMonth()];
  return `As of ${month} ${asOf.getUTCFullYear()}, we found no public information about ${displayName.trim()}'s job, background, or goals.`;
}

export type NoPublicInfoSummary = { month: string; year: number; displayName: string };

export function parseNoPublicInfoSummary(summary: string | null | undefined): NoPublicInfoSummary | null {
  if (typeof summary !== "string") {
    return null;
  }
  const match = NO_PUBLIC_INFO_SUMMARY_PATTERN.exec(summary.trim());
  if (!match) {
    return null;
  }
  return { month: match[1]!, year: Number(match[2]), displayName: match[3]! };
}

export function isNoPublicInfoSummary(summary: string | null | undefined): boolean {
  return parseNoPublicInfoSummary(summary) !== null;
}

// The app renders the contest name, date, and stage beside the summary, so
// race content inside it is always redundant and goes stale after election
// day. Patterns stay narrow on purpose — "primary" alone would reject
// "primary care physician". These phrases are horse-race in any context:
const SUMMARY_HORSE_RACE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\brunning for\b/i, label: 'the phrase "running for"' },
  { pattern: /\bseeking\s+re-?election\b/i, label: 'the phrase "seeking re-election"' },
];

// A percentage or "runoff" is horse-race content only inside a result
// CONSTRUCTION — "won 52%", "advanced with 26%", "26% of the vote", "won the
// runoff" — never as a bare word co-occurrence. Cue-word lists over-matched
// ("registered 20% more voters as election commissioner" is a credential),
// and sentence-scoped cues mis-split on "U.S.", letting "won 52% in the U.S.
// Senate primary" through. Tight constructions need no sentence splitting,
// and English discriminates naturally at the article: vote shares read
// "won 52%" while biography statistics read "secured a 40% increase".
const RESULT_QUALIFIER = String.raw`(?:(?:about|around|nearly|roughly|over|almost|approximately|under)\s+)?`;
const PERCENT = String.raw`\d+(?:\.\d+)?\s*(?:%|percent\b)`;
// Words allowed between an article and an electoral "runoff" ("the November
// 2026 runoff", "a Democratic primary runoff") — whitelisted so "won the
// fight against runoff" (environmental) never matches through a free gap.
const RUNOFF_FILLER_WORD = String.raw`(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{4}|primar(?:y|ies)|mayoral|special|general|citywide|city|county|statewide|democratic|republican|nonpartisan)`;
const RUNOFF_FILLER = String.raw`(?:${RUNOFF_FILLER_WORD}\s+){0,2}`;
const RUNOFF_FILLER_REQUIRED = String.raw`(?:${RUNOFF_FILLER_WORD}\s+){1,2}`;

const PERCENT_LABEL = "a vote percentage (horse-race content)";
const RUNOFF_LABEL = '"runoff" as an election result (horse-race content)';

const SUMMARY_HORSE_RACE_CONSTRUCTIONS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // "won 52%", "received about 31 percent", "garnered nearly 26%"
  {
    pattern: new RegExp(String.raw`\b(?:won|lost|received|garnered|polled)\s+${RESULT_QUALIFIER}${PERCENT}`, "i"),
    label: PERCENT_LABEL,
  },
  // "advanced with 26%", "finished with about 31 percent"
  {
    pattern: new RegExp(String.raw`\b(?:advanc(?:e[ds]?|ing)|finish(?:ed|ing)?)\s+with\s+${RESULT_QUALIFIER}${PERCENT}`, "i"),
    label: PERCENT_LABEL,
  },
  // "26% of the vote"
  {
    pattern: new RegExp(String.raw`${PERCENT}\s+of\s+(?:the\s+)?votes?\b`, "i"),
    label: PERCENT_LABEL,
  },
  // "26% in the June primary", "52 percent in the U.S. Senate primary"
  {
    pattern: new RegExp(
      String.raw`${PERCENT}\s+in\s+the\s+(?:\S+\s+){0,3}(?:primar(?:y|ies)|runoff|caucus(?:es)?|general|election)\b`,
      "i"
    ),
    label: PERCENT_LABEL,
  },
  // "won the runoff", "lost a runoff", "won the June primary", "won the
  // Democratic nomination" — stage results are race trivia even without a
  // percentage. "election" is deliberately NOT a terminal noun: "won the 2020
  // election" is the same credential as "elected in 2020", which stays legal
  // biography (past office is exactly what the formula asks for).
  {
    pattern: new RegExp(
      String.raw`\b(?:won|lost|forced|entered)\s+(?:the|a)\s+${RUNOFF_FILLER}(?:runoff|primar(?:y|ies)|nomination|caucus(?:es)?)\b`,
      "i"
    ),
    label: RUNOFF_LABEL,
  },
  // "advanced to the November 2026 runoff" — requires "to the/a", so
  // "advanced legislation to curb runoff" stays a biography fact
  {
    pattern: new RegExp(String.raw`\badvanc(?:e[ds]?|ing)\s+to\s+(?:the|a)\s+(?:\S+\s+){0,3}runoff\b`, "i"),
    label: RUNOFF_LABEL,
  },
  // "in the November runoff" — the filler is REQUIRED here: a bare "in the
  // runoff" is how environmental summaries read ("measured contaminants in
  // the runoff"), so it only counts with an electoral filler word present
  {
    pattern: new RegExp(String.raw`\bin\s+(?:the|a)\s+${RUNOFF_FILLER_REQUIRED}runoff\b`, "i"),
    label: RUNOFF_LABEL,
  },
  // "faces X in the runoff" — a contest verb supplies the electoral context
  // that the bare construction above no longer assumes
  {
    pattern: new RegExp(
      String.raw`\b(?:fac(?:es?|ing)|meets?|meeting|compet(?:es?|ing))\s+[^!?]{0,30}\bin\s+(?:the|a)\s+${RUNOFF_FILLER}runoff\b`,
      "i"
    ),
    label: RUNOFF_LABEL,
  },
  // "runoff election", "runoff against"
  { pattern: /\brunoff\s+(?:election|against)\b/i, label: RUNOFF_LABEL },
];

function findSummaryHorseRaceContent(summary: string): string | null {
  const phrase = SUMMARY_HORSE_RACE_PATTERNS.find(({ pattern }) => pattern.test(summary));
  if (phrase) {
    return phrase.label;
  }
  const construction = SUMMARY_HORSE_RACE_CONSTRUCTIONS.find(({ pattern }) => pattern.test(summary));
  return construction ? construction.label : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizeSources(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    const url = normalizeHttpUrl(item);
    if (!url) {
      return null;
    }
    if (!seen.has(url)) {
      seen.add(url);
      normalized.push(url);
    }
  }
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isNonEmptyString(item)) {
      return null;
    }
    const text = item.trim();
    if (!seen.has(text)) {
      seen.add(text);
      normalized.push(text);
    }
  }
  return normalized;
}

export function parseCandidateProfilePayload(
  payload: unknown,
  options: CandidateProfilePayloadParseOptions = {}
):
  | { ok: true; payload: CandidateProfilePayload }
  | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be an object" };
  }

  const input = payload as Record<string, unknown>;
  if (!isNonEmptyString(input.display_name)) {
    return { ok: false, reason: "payload.display_name must be non-empty string" };
  }
  if (!isNonEmptyString(input.first_name)) {
    return { ok: false, reason: "payload.first_name must be non-empty string" };
  }
  if (!isNonEmptyString(input.last_name)) {
    return { ok: false, reason: "payload.last_name must be non-empty string" };
  }

  const displayName = stripNameFootnoteMarkers(input.display_name);
  const firstName = stripNameFootnoteMarkers(input.first_name);
  const lastName = stripNameFootnoteMarkers(input.last_name);
  // Re-checked after stripping: a value of "*" alone clears the non-empty
  // checks above and would otherwise be stored as an empty name.
  if (displayName.length === 0 || firstName.length === 0 || lastName.length === 0) {
    return {
      ok: false,
      reason: "payload display_name/first_name/last_name must contain a name, not only footnote markers",
    };
  }

  // A given name that ends in a comma or is wholly parenthetical is not a
  // given name — it is the wreckage of a bad split, and it persists silently
  // because the columns only ever get trimmed. Live examples: first_name
  // "Franks," with last_name "Jr." (the given name is absent from the source
  // entirely), and first_name "(Butch)" where a nickname displaced it.
  // Rejected rather than normalised: the correct value cannot be derived from
  // what is here, so the payload needs a human, not a cleanup rule.
  if (firstName.endsWith(",")) {
    return {
      ok: false,
      reason: `payload.first_name "${firstName}" ends with a comma, which means the name was split wrongly (the surname was probably placed in first_name); supply the given name`,
    };
  }
  if (/^\(.*\)$/u.test(firstName)) {
    return {
      ok: false,
      reason: `payload.first_name "${firstName}" is only a parenthetical nickname; supply the given name and keep the nickname in display_name`,
    };
  }

  const sources = normalizeSources(input.sources);
  if (!sources) {
    return { ok: false, reason: "payload.sources must contain valid URL strings" };
  }
  // Same domain policy as candidate records: UGC/social platforms, generated
  // candidate directories, and bot-check interstitials are discovery leads,
  // never profile citations. Gates only the citation `sources` array —
  // linkedin_url / official_website_url / twitter_handle are profile LINK
  // fields, not evidence, and stay exempt.
  const blockedSourceReason = findBlockedSourceReason(sources);
  if (blockedSourceReason) {
    return { ok: false, reason: `payload.sources: ${blockedSourceReason}` };
  }

  let party: string | undefined;
  if (input.party !== undefined && input.party !== null) {
    if (!isNonEmptyString(input.party)) {
      return { ok: false, reason: "payload.party must be non-empty string when present" };
    }
    party = input.party.trim();
  }

  let dateOfBirth: string | undefined;
  if (input.date_of_birth !== undefined && input.date_of_birth !== null) {
    if (!isNonEmptyString(input.date_of_birth) || !isIsoDate(input.date_of_birth.trim())) {
      return { ok: false, reason: "payload.date_of_birth must be YYYY-MM-DD when present" };
    }
    dateOfBirth = input.date_of_birth.trim();
  }

  let twitterHandle: string | undefined;
  if (input.twitter_handle !== undefined && input.twitter_handle !== null) {
    if (!isNonEmptyString(input.twitter_handle)) {
      return { ok: false, reason: "payload.twitter_handle must be non-empty string when present" };
    }
    const normalized = normalizeTwitterHandle(input.twitter_handle);
    if (!normalized) {
      return { ok: false, reason: "payload.twitter_handle must be a valid handle when present" };
    }
    twitterHandle = normalized;
  }

  let linkedinUrl: string | undefined;
  if (input.linkedin_url !== undefined && input.linkedin_url !== null) {
    if (!isNonEmptyString(input.linkedin_url)) {
      return { ok: false, reason: "payload.linkedin_url must be non-empty string when present" };
    }
    const normalized = normalizeHttpUrl(input.linkedin_url);
    if (!normalized) {
      return { ok: false, reason: "payload.linkedin_url must be valid http(s) URL when present" };
    }
    linkedinUrl = normalized;
  }

  let officialWebsiteUrl: string | undefined;
  if (input.official_website_url !== undefined && input.official_website_url !== null) {
    if (!isNonEmptyString(input.official_website_url)) {
      return { ok: false, reason: "payload.official_website_url must be non-empty string when present" };
    }
    const normalized = normalizeHttpUrl(input.official_website_url);
    if (!normalized) {
      return { ok: false, reason: "payload.official_website_url must be valid http(s) URL when present" };
    }
    officialWebsiteUrl = normalized;
  }

  const allowFecIds = options.allowFecIds !== false;
  const requireFecIds = options.requireFecIds === true;
  if (!allowFecIds && input.fec_ids !== undefined && input.fec_ids !== null) {
    return {
      ok: false,
      reason:
        "payload.fec_ids is not allowed for this contest mode; omit fec_ids from the profile payload — identity IDs are inherited from the staged roster row",
    };
  }
  const fecIds = allowFecIds ? normalizeOptionalStringArray(input.fec_ids) : undefined;
  if (allowFecIds && fecIds === null) {
    return { ok: false, reason: "payload.fec_ids must be string array when present" };
  }
  const normalizedFecIds = fecIds ?? undefined;
  if (requireFecIds && (!normalizedFecIds || normalizedFecIds.length === 0)) {
    return { ok: false, reason: "payload.fec_ids must contain at least one FEC ID for federal contests" };
  }

  const stateFilingIds = normalizeOptionalStringArray(input.state_filing_ids);
  if (stateFilingIds === null) {
    return { ok: false, reason: "payload.state_filing_ids must be string array when present" };
  }

  let currentOffice: string | undefined;
  if (input.current_office !== undefined && input.current_office !== null) {
    if (!isNonEmptyString(input.current_office)) {
      return { ok: false, reason: "payload.current_office must be non-empty string when present" };
    }
    currentOffice = input.current_office.trim();
  }

  // Tri-state on purpose, and the key must be present: true/false assert what
  // the cited sources' office-history coverage actually shows, while null is
  // the explicit "no cited source carries office history" answer. An OMITTED
  // key is still rejected — silence and "I checked and the sources are silent"
  // must stay distinguishable, or the field degrades back to unanswered.
  if (
    input.has_held_public_office !== true &&
    input.has_held_public_office !== false &&
    input.has_held_public_office !== null
  ) {
    return {
      ok: false,
      reason:
        "payload.has_held_public_office must be true, false, or null: has this person EVER held elected or appointed public office (current or former)? Answer true/false only when a cited source actually carries office history (bio, experience/elected-experience field, financial disclosure, incumbency marker); use null when every cited source is silent on office history — a source with no office-history field is not evidence of never having held office.",
    };
  }
  // Holding an office NOW implies having held one: a payload carrying
  // current_office alongside false is internally contradictory, and alongside
  // null it under-claims a fact the payload itself asserts. This also catches
  // the recurring misuse of current_office for an occupation ("Attorney,
  // Noble Law") — occupation belongs in summary.
  if (currentOffice && input.has_held_public_office !== true) {
    return {
      ok: false,
      reason:
        `payload.current_office ("${currentOffice}") requires has_held_public_office=true (got ${JSON.stringify(input.has_held_public_office)}) — a candidate holding a public office now HAS held public office. If the office is real, set has_held_public_office=true; if current_office actually holds an occupation or past office, remove it (occupation belongs in summary).`,
    };
  }

  let summary: string | undefined;
  if (input.summary !== undefined && input.summary !== null) {
    if (!isNonEmptyString(input.summary)) {
      return { ok: false, reason: "payload.summary must be non-empty string when present" };
    }
    const trimmedSummary = input.summary.trim();
    if (trimmedSummary.length > CANDIDATE_PROFILE_SUMMARY_MAX_LENGTH) {
      return {
        ok: false,
        reason:
          `payload.summary is ${trimmedSummary.length} characters (max ${CANDIDATE_PROFILE_SUMMARY_MAX_LENGTH}) — voters skim it next to the contest. Rewrite as 2 sentences: current role, 1-2 credentials, top 2 priorities; cut everything else.`,
      };
    }
    const horseRaceLabel = findSummaryHorseRaceContent(trimmedSummary);
    if (horseRaceLabel) {
      return {
        ok: false,
        reason:
          `payload.summary contains ${horseRaceLabel} — the app already names the contest next to the summary, so campaign-status and horse-race content is banned. Describe who the person is (current role, 1-2 credentials, top 2 priorities), not the race.`,
      };
    }
    const noPublicInfo = parseNoPublicInfoSummary(trimmedSummary);
    if (!noPublicInfo && NO_PUBLIC_INFO_CUE.test(trimmedSummary)) {
      return {
        ok: false,
        reason:
          `payload.summary reads as a "no public information" outcome but does not match the fixed template. Use exactly: ${buildNoPublicInfoSummary(displayName)} (month and year = when the search ran).`,
      };
    }
    if (noPublicInfo) {
      if (noPublicInfo.displayName !== displayName) {
        return {
          ok: false,
          reason:
            `payload.summary names "${noPublicInfo.displayName}" but display_name is "${displayName}" — the no-public-information template must carry display_name verbatim.`,
        };
      }
      if (input.has_held_public_office !== null) {
        return {
          ok: false,
          reason:
            "payload.summary is the no-public-information template, so has_held_public_office must be null — a placeholder asserts that nothing is known, including office history.",
        };
      }
    }
    summary = trimmedSummary;
  }

  return {
    ok: true,
    payload: {
      display_name: displayName,
      first_name: firstName,
      last_name: lastName,
      ...(party ? { party } : {}),
      ...(dateOfBirth ? { date_of_birth: dateOfBirth } : {}),
      ...(twitterHandle ? { twitter_handle: twitterHandle } : {}),
      ...(linkedinUrl ? { linkedin_url: linkedinUrl } : {}),
      ...(officialWebsiteUrl ? { official_website_url: officialWebsiteUrl } : {}),
      ...(normalizedFecIds !== undefined ? { fec_ids: normalizedFecIds } : {}),
      ...(stateFilingIds !== undefined ? { state_filing_ids: stateFilingIds } : {}),
      ...(currentOffice ? { current_office: currentOffice } : {}),
      has_held_public_office: input.has_held_public_office,
      ...(summary ? { summary } : {}),
      sources,
    },
  };
}

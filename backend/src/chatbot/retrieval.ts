// Hybrid retrieval over the active chunk generation — docs/plans/chatbot-rag.md
// component 4.
//
// Three ranked lists merged with Reciprocal Rank Fusion:
//   A. lexical: content_tsv @@ websearch_to_tsquery, ranked by ts_rank_cd
//   B. vector: exact-scan cosine over halfvec embeddings (no HNSW in v1 —
//      see the migration comment), scope-filtered by state when known
//   C. entity: chunks belonging to candidates whose names fuzzy-match the
//      question (pg_trgm word_similarity against public.candidates)
// RRF decides ORDER; the answerability gate thresholds on the RAW scores
// (kept per chunk) because RRF rank is relative, never absolute relevance.
//
// The embeddings service being down degrades to lists A+C (keyword-only)
// with a warning log — nothing else changes.

import type { Pool } from "pg";

import { EmbeddingsError, toVectorLiteral, type EmbeddingsClient } from "./embeddingsClient.js";

export const RETRIEVAL_TOP_K = 5;
const BRANCH_LIMIT = 20;
const RRF_K = 60;

// Race-members branch fires only on a title match this strong: an exact
// office-word hit ("mayor", "sheriff") scores 1.0 while the strongest
// cross-office confusion sits at exactly 0.8 ("State Senator" against a
// federally aliased question) — 0.85 sits above that band, so a lookalike
// office never pulls a whole race in. Selection scans PAST sub-band rows:
// district titles carry the question's own words in their place part
// ("State Senate District 2" matches "Senate race"), which can rank a 0.8
// confusion row above the 1.0 real race on the score+place ordering.
const RACE_MEMBERS_MIN_SIMILARITY = 0.85;
// Without a scope state, the question must name the race's place ("Los
// Angeles mayor") for members to fire — office similarity alone ties across
// every state ("Senate race" scores 1.0 in all 30+ states) and the id
// tie-break would pull an arbitrary state's race (observed: Montana). Same
// threshold the scope-ambiguity heuristic uses for "the question IS scoped".
const RACE_MEMBERS_MIN_PLACE_SIMILARITY = 0.4;
// A runner-up race "ties" the top qualifier when both its office score and
// its place score sit this close — a state scope alone doesn't pick one of
// Georgia's 178 identically-titled State Representative races (review
// catch: District 24 won on the id tie-break). A named district separates
// on place ("District 2" sits well above "District 23"); a distinct office
// phrase separates on score ("…District 5" vs "…District 2" in the office
// part). A tied set never pulls members and is surfaced to the caller as
// raceTitleAmbiguous for clarification.
const RACE_TIE_SCORE_EPSILON = 0.05;
const RACE_TIE_PLACE_MARGIN = 0.1;

/** What a race-level question is actually asking for, deciding which member
 * chunks matter (review round: fixed finance-first ordering served finance
 * chunks to a records question). Word lists stay short and literal — grow
 * them only on demonstrated misses. */
export function classifyRaceQuestion(question: string): "money" | "records" | "neutral" {
  if (/\brecords?\b|\bvot(?:e|es|ed|ing)\b|\bbills?\b|\bsponsor/i.test(question)) {
    return "records";
  }
  if (/\brais(?:e|ed|ing)\b|\bspen[dt]\b|\bspending\b|\bmoney\b|\bcash\b|\bfund|\bdonor|\bdonat|\bfinanc/i.test(question)) {
    return "money";
  }
  return "neutral";
}

/** Race-collective phrasings: the question is about a race's field as a
 * whole without naming anyone ("compare the candidates for me"). On a page
 * with candidate/election context this counts as pointing at the page —
 * askService applies context on it, and the members branch below fires from
 * that context (docs/plans/chatbot-race-context-compare.md). Deliberately
 * NOT merged into askService's DEICTIC_RE: these words are common enough
 * that folding them into the general pronoun gate would let off-topic
 * questions ride page chunks through the answerability gate. Word list
 * stays short and literal — grow it only on demonstrated misses (same
 * policy as classifyRaceQuestion). Bare `compare`/`differences` are
 * deliberately kept broad (review round): a terse on-page "compare the
 * two" / "what are the differences?" is overwhelmingly about the race,
 * and an off-topic match costs little — the LLM refuses on its own rules,
 * and the no-LLM fallback shows the viewed race's cards, the same exposure
 * the deictic gate has always had for "is it going to rain?". */
export const RACE_COLLECTIVE_RE =
  /\bcompare\b|\bdifferences?\b|\bthe candidates\b|\bwho(?:'s| is| else is)? running\b|\b(?:the|this|that|their) race\b|\beach other\b/i;

/** Collective-with-a-name phrasings ("compare Jon Ossoff with the other
 * candidates", "how does she stack up against her opponents?"): the
 * question names a candidate but asks about the race's FIELD, so race-
 * member precedence must stay on — entity-first ranking would fill the
 * top-K with the named candidate's own chunks plus the listing, and the
 * opponents the members branch fetched would never reach the model.
 * Every alternative is a field NOUN, never a bare modifier (review round):
 * bare `other` flipped "what other bills has Jon Ossoff sponsored?" into a
 * field question and served opponents' records ahead of his. A fully-named
 * comparison ("how do X and Y compare against each other?") matches none
 * of these, and entity-first is the right ranking there. */
export const RACE_OTHERS_RE =
  /\bother candidates\b|\bothers\b|\bopponents?\b|\beveryone else\b|\bthe rest\b|\bthe candidates\b/i;

/** Member ordering per question kind: the listing chunk always leads (it
 * names the field), then the source type the question is about. Applied in
 * the SQL ORDER BY (array_position, unlisted types last) — it must run
 * BEFORE the branch LIMIT, or a big race truncates exactly the chunks the
 * question needs (7 filers = 22 member rows; a records question would lose
 * two record chunks behind finance and profiles). */
const RACE_MEMBER_TYPE_ORDER: Record<ReturnType<typeof classifyRaceQuestion>, string[]> = {
  money: ["election", "finance_summary", "candidate_profile"],
  records: ["election", "candidate_record", "candidate_profile"],
  neutral: ["election", "candidate_profile", "finance_summary"],
};

// Answerability gate thresholds on raw scores (tuned against the golden set
// via `npm run chatbot:eval` on the live local index, 2026-08-11; see
// BEHAVIOR.md release gates). A question is answerable when ANY holds:
//   - best cosine similarity >= GATE_MIN_COSINE. Measured bge-small
//     similarities: on-topic race questions 0.72-0.82, off-topic
//     (weather/celebrities/2028 races/foreign mayors) 0.58-0.70. The
//     threshold sits in the measured gap.
//   - best AND-lexical ts_rank_cd >= GATE_MIN_LEXICAL. The gate uses the
//     strict websearch AND query (every term must match), NOT the OR query
//     the ranking branch uses — under OR a single matched title word scores
//     ~1.0 and off-topic questions would sail through.
//   - a candidate-name match >= GATE_MIN_ENTITY_SIMILARITY. word_similarity
//     noise from unrelated questions reaches ~0.7 ("Tim Taylor" scores 0.7
//     against "What is Taylor Swift's net worth?"), so this sits above it.
export const GATE_MIN_COSINE = 0.71;
export const GATE_MIN_LEXICAL = 0.08;
export const GATE_MIN_ENTITY_SIMILARITY = 0.75;

// Common-name office phrasings → the office phrase the corpus actually uses.
// The title branch matches the question against chunk-title office phrases
// with word_similarity, and office naming is inconsistent across states
// ("United States Senator — Georgia" vs "US Senate — Colorado"), so "the
// Georgia Senate race" scores 0.29 against its own race while fifty "State
// Senator — State Senate District N" titles score 0.54 and swamp it. The
// negative lookbehinds keep "State Senate District 2 race" questions on the
// state races. Alias list grows only on demonstrated misses (golden set).
const OFFICE_ALIASES: readonly { pattern: RegExp; canonical: string }[] = [
  {
    pattern: /\bu\.?s\.?\s+senate\b|\bunited states senate\b|(?<!\bstate\s)\bsenate\s+(?:race|seat|election)\b/i,
    canonical: "United States Senator",
  },
];

/** Question text for the TITLE branch only: appends the canonical office
 * phrase when the question uses a common-name federal phrasing, so
 * word_similarity can find it. Never fed to the lexical/vector branches —
 * injected terms would distort ranking evidence the gate thresholds are
 * calibrated on. */
export function expandOfficeAliases(question: string): string {
  const expansions = OFFICE_ALIASES.filter((alias) => alias.pattern.test(question)).map((alias) => alias.canonical);
  return expansions.length > 0 ? `${question} ${expansions.join(" ")}` : question;
}

// The office words a district/seat number attaches to, in either order:
// "District 48", "Ward 3", "Position No. 5", "Prop 33", "HD41", "the 48th
// district". Singular on purpose — "the 3 seats on the board" is a count.
const NUMBERED_OFFICE_WORD =
  "(?:district|ward|place|position|seat|precinct|division|zone|area|post|proposition|prop|measure|question|amendment|hd|sd|ad|cd)";
const DISTRICT_NUMBER_RE = new RegExp(
  String.raw`\b${NUMBERED_OFFICE_WORD}\s*(?:no\.?\s*|#\s*)?(\d{1,3})\b|\b(\d{1,3})(?:st|nd|rd|th)?\s+${NUMBERED_OFFICE_WORD}\b`,
  "gi"
);

/** Postgres regex matching the district/seat numbers the question names
 * ("district 48", "Ward 3", "Place 2"), or null when it names none. The
 * title branch scores the office phrase with trigram word_similarity, which
 * is nearly blind to the digits: "State Assembly District 11" scored 0.889
 * against "which candidate is in state assembly district 48" and outranked
 * "Member of the State Assembly, District 48" (0.675), so the wrong
 * district's members came back as the answer (observed 2026-10-25). A
 * numbered title must carry one of the question's numbers; titles with no
 * number of their own ("Governor") are unaffected. Only numbers attached to
 * an office word count: a date ("on November 3"), a count ("the 2
 * candidates"), or a year is never a district number, and a question with
 * no attached number gets no filter at all. */
export function districtNumberPattern(question: string): string | null {
  const numbers = new Set<string>();
  for (const match of question.matchAll(DISTRICT_NUMBER_RE)) {
    numbers.add((match[1] ?? match[2]) as string);
  }
  return numbers.size > 0 ? `\\m(${[...numbers].join("|")})\\M` : null;
}

// Title text the district-number rule inspects: the trailing election-date
// parenthetical dropped, then every 4-digit year.
const TITLE_WITHOUT_DATES_SQL =
  String.raw`regexp_replace(regexp_replace(chunk.title, '\s\([^()]*\)$', ''), '\m\d{4}\M', '', 'g')`;

// Entity matches at/above this are candidates for scope/boost resolution.
const ENTITY_MATCH_MIN_SIMILARITY = 0.45;
// Same-name variants ("Michael Smith" / "Michael L. Smith") score lower than
// the exact match; anything above this still counts as the same person-name
// for ambiguity detection.
const ENTITY_SAME_NAME_MIN_SIMILARITY = 0.6;

export type ActiveGeneration = {
  id: string;
  activatedAt: string;
};

export type CandidateEntityMatch = {
  candidateId: string;
  displayName: string;
  party: string;
  state: string;
  currentOffice: string | null;
  similarity: number;
};

export type RetrievedChunk = {
  id: string;
  sourceType: string;
  sourceId: string | null;
  electionId: string | null;
  state: string | null;
  title: string;
  content: string;
  evidenceUrls: string[];
  lexicalScore: number;
  cosineSimilarity: number;
  rrfScore: number;
};

export type ElectionTitleMatch = {
  state: string | null;
  title: string;
  similarity: number;
  /** How strongly the chunk's place name ("Los Angeles city") appears in the
   * question — the signal that the question is already place-scoped. */
  placeSimilarity: number;
};

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  /** Election chunks whose titles fuzzy-match the question, best first —
   * the scope-ambiguity signal ("the sheriff race" ties across states). */
  electionTitleMatches: ElectionTitleMatch[];
  entityMatches: CandidateEntityMatch[];
  /** Same-name candidates the question cannot distinguish; non-empty →
   * caller must return a clarification, never silently pick (rule 7). */
  ambiguousEntities: CandidateEntityMatch[];
  bestLexicalScore: number;
  bestCosineSimilarity: number;
  bestEntitySimilarity: number;
  /** True when page context (candidate/election) contributed chunks — a
   * deictic question about the viewed page is answerable on that evidence
   * even when its own text matches nothing. */
  contextMatched: boolean;
  /** True when the question's office phrase matched 2+ races the question
   * cannot tell apart even within a known scope state (Georgia has 178
   * "State Representative" races). The members branch never fires on a tied
   * set; the caller should ask which district/place is meant. */
  raceTitleAmbiguous: boolean;
  /** Non-empty when a race-collective question's page context resolved to
   * MORE than one covered race (candidate on two November ballots): the tied
   * races' listing-chunk titles, for the caller's clarification. No members
   * were pulled — never compare across an arbitrary pick (rule 7). */
  contextRaceAmbiguousTitles: string[];
  degradedToKeywordOnly: boolean;
};

export async function getActiveGeneration(db: Pool): Promise<ActiveGeneration | null> {
  const result = await db.query<{ id: string; activated_at: string }>(
    `
      SELECT id::text AS id, activated_at::text AS activated_at
      FROM chatbot.index_generations
      WHERE status = 'active'
      LIMIT 1
    `
  );
  const row = result.rows[0];
  return row ? { id: row.id, activatedAt: row.activated_at } : null;
}

type EntityRow = {
  candidate_id: string;
  display_name: string;
  party: string;
  state: string;
  current_office: string | null;
  similarity: number;
};

/** Fuzzy candidate-name resolution: word_similarity finds the best-matching
 * span of the question for each name, so "how much has jon ossoff raised"
 * scores Jon Ossoff highly. Restricted to candidates the ACTIVE GENERATION
 * actually indexed: a name that exists only outside the corpus (old race,
 * out-of-cohort) must not pass the entity gate — the gate would then serve
 * nearest-neighbor chunks about someone else. Hash join over ~30k chunk
 * rows + ~9k candidates, a few ms. */
export async function resolveCandidateEntities(
  db: Pool,
  generationId: string,
  question: string
): Promise<CandidateEntityMatch[]> {
  const result = await db.query<EntityRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          trim(concat_ws(' ', candidate.first_name, candidate.last_name))
        ) AS display_name,
        candidate.party,
        candidate.state,
        candidate.current_office,
        word_similarity(
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            trim(concat_ws(' ', candidate.first_name, candidate.last_name))
          ),
          $1
        )::float8 AS similarity
      FROM public.candidates AS candidate
      JOIN (
        SELECT DISTINCT source_id
        FROM chatbot.chunks
        WHERE generation_id = $3::uuid
          AND source_type = 'candidate_profile'
      ) AS indexed
        ON indexed.source_id = candidate.id
      WHERE candidate.deleted_at IS NULL
        AND candidate.merged_into_candidate_id IS NULL
        AND word_similarity(
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            trim(concat_ws(' ', candidate.first_name, candidate.last_name))
          ),
          $1
        ) >= $2
      ORDER BY similarity DESC, display_name ASC
      LIMIT 10
    `,
    [question, ENTITY_MATCH_MIN_SIMILARITY, generationId]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    displayName: row.display_name,
    party: row.party ?? "",
    state: row.state ?? "",
    currentOffice: row.current_office,
    similarity: row.similarity,
  }));
}

/** Normalized "first last" (middle names/initials dropped): the identity key
 * a question like "Michael Smith" actually names. */
export function firstLastKey(displayName: string): string {
  const tokens = displayName
    .toLowerCase()
    .replace(/["'.()]/g, "")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length <= 1) {
    return tokens.join(" ");
  }
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

/** Same-name detection anchored on the BEST match: a strong best match with
 * 2+ candidates sharing its first+last name ("Michael Smith" in GA,
 * "Michael L. Smith" in OH, "Michael A. Smith" in IL) is ambiguous. A unique
 * strong match ("Mike Collins" = 1.0) is not, even when unrelated "Mike
 * Conway"s tie each other lower down. A known scope state disambiguates
 * first: "Michael Smith in Georgia" names exactly one of them. */
export function findAmbiguousEntities(
  matches: readonly CandidateEntityMatch[],
  scopeState: string | null = null
): CandidateEntityMatch[] {
  const best = matches[0];
  if (!best || best.similarity < GATE_MIN_ENTITY_SIMILARITY) {
    return [];
  }
  const bestKey = firstLastKey(best.displayName);
  let sameName = matches.filter(
    (match) => match.similarity >= ENTITY_SAME_NAME_MIN_SIMILARITY && firstLastKey(match.displayName) === bestKey
  );
  if (scopeState && sameName.some((match) => match.state === scopeState)) {
    sameName = sameName.filter((match) => match.state === scopeState);
  }
  return sameName.length >= 2 ? sameName : [];
}

type ChunkRow = {
  id: string;
  source_type: string;
  source_id: string | null;
  election_id: string | null;
  state: string | null;
  title: string;
  content: string;
  evidence_urls: unknown;
  score: number;
  /** Title branch only: place-name-in-question similarity. */
  place_score?: number;
};

function parseEvidenceUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function toBaseChunk(row: ChunkRow): Omit<RetrievedChunk, "lexicalScore" | "cosineSimilarity" | "rrfScore"> {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    electionId: row.election_id,
    state: row.state,
    title: row.title,
    content: row.content,
    evidenceUrls: parseEvidenceUrls(row.evidence_urls),
  };
}

export type RetrieveOptions = {
  db: Pool;
  embeddings: EmbeddingsClient | null;
  generationId: string;
  question: string;
  /** Restrict the vector branch when the scope is known (e.g. a resolved
   * candidate's state, or a state named in the question). */
  scopeState?: string | null;
  /** Page context, already deictic-gated by the caller: the candidate or
   * election the user is looking at. Its chunks join the merge at top rank
   * and count as answerability evidence. */
  contextCandidateId?: string | null;
  contextElectionId?: string | null;
};

export async function retrieveChunks(options: RetrieveOptions): Promise<RetrievalResult> {
  const { db, embeddings, generationId, question } = options;
  const scopeState = options.scopeState ?? null;
  const contextCandidateId = options.contextCandidateId ?? null;
  const contextElectionId = options.contextElectionId ?? null;

  let entityMatches = await resolveCandidateEntities(db, generationId, question);
  // A named scope state narrows the ENTIRE match list, not just ambiguity:
  // "Michael Smith in Georgia" must not put Ohio's Michael L. Smith into the
  // entity branch or the gate score. Only when some match is in that state —
  // a mistaken state must not silently zero a strong name match.
  if (scopeState && entityMatches.some((match) => match.state === scopeState)) {
    entityMatches = entityMatches.filter((match) => match.state === scopeState);
  }
  const ambiguousEntities = findAmbiguousEntities(entityMatches, scopeState);
  const bestEntitySimilarity = entityMatches[0]?.similarity ?? 0;

  // Context branch: the viewed page's chunks. Candidate context pulls the
  // candidate's own chunks PLUS the election listing chunks of their races —
  // the listing is the only chunk that names opponents, so "who is she
  // running against" is unanswerable without it (listing only: the
  // opponents' own profiles would drown out the viewed candidate under
  // BRANCH_LIMIT). Election context pulls everything belonging to that
  // election (its listing, measure, candidates, finance).
  let contextRows: ChunkRow[] = [];
  if (contextCandidateId || contextElectionId) {
    const contextResult = await db.query<ChunkRow>(
      `
        SELECT
          chunk.id::text AS id,
          chunk.source_type,
          chunk.source_id::text AS source_id,
          chunk.election_id::text AS election_id,
          chunk.state,
          chunk.title,
          chunk.content,
          chunk.evidence_urls,
          0::float8 AS score
        FROM chatbot.chunks AS chunk
        WHERE chunk.generation_id = $1::uuid
          AND (
            ($2::uuid IS NOT NULL AND chunk.source_id = $2::uuid)
            OR ($2::uuid IS NOT NULL AND chunk.source_type = 'election' AND chunk.election_id IN (
              SELECT own.election_id
              FROM chatbot.chunks AS own
              WHERE own.generation_id = $1::uuid
                AND own.source_id = $2::uuid
                AND own.election_id IS NOT NULL
            ))
            OR ($3::uuid IS NOT NULL AND chunk.election_id = $3::uuid)
          )
        ORDER BY
          CASE chunk.source_type
            WHEN 'election' THEN 0
            WHEN 'ballot_measure' THEN 1
            WHEN 'candidate_profile' THEN 2
            WHEN 'finance_summary' THEN 3
            ELSE 4
          END ASC,
          chunk.id ASC
        LIMIT $4
      `,
      [generationId, contextCandidateId, contextElectionId, BRANCH_LIMIT]
    );
    contextRows = contextResult.rows;
  }

  // Branch A: lexical. plainto_tsquery sanitizes arbitrary user text; its
  // AND semantics are then relaxed to OR because natural questions carry
  // words no chunk contains ("money", "race", "US" vs "United States") and a
  // single missing term would zero the whole branch. ts_rank_cd still ranks
  // more-terms-matched far above single-term noise, and the gate thresholds
  // are calibrated for OR-ranks.
  const lexicalResult = await db.query<ChunkRow>(
    `
      SELECT
        chunk.id::text AS id,
        chunk.source_type,
        chunk.source_id::text AS source_id,
        chunk.election_id::text AS election_id,
        chunk.state,
        chunk.title,
        chunk.content,
        chunk.evidence_urls,
        ts_rank_cd(chunk.content_tsv, query.tsquery)::float8 AS score
      FROM chatbot.chunks AS chunk,
        (SELECT replace(plainto_tsquery('english', $2)::text, ' & ', ' | ')::tsquery AS tsquery) AS query
      WHERE chunk.generation_id = $1::uuid
        AND chunk.content_tsv @@ query.tsquery
      ORDER BY score DESC, chunk.id ASC
      LIMIT $3
    `,
    [generationId, question, BRANCH_LIMIT]
  );

  // Gate signal: strict AND rank. Separate tiny query because the ranking
  // branch's OR rank cannot gate (see threshold comment above); this is also
  // what keeps keyword-exact questions answerable in degraded (no-embeddings)
  // mode.
  const gateLexicalResult = await db.query<{ score: number }>(
    `
      SELECT ts_rank_cd(chunk.content_tsv, query.tsquery)::float8 AS score
      FROM chatbot.chunks AS chunk,
        (SELECT websearch_to_tsquery('english', $2) AS tsquery) AS query
      WHERE chunk.generation_id = $1::uuid
        AND chunk.content_tsv @@ query.tsquery
      ORDER BY score DESC
      LIMIT 1
    `,
    [generationId, question]
  );
  const bestLexicalScore = gateLexicalResult.rows[0]?.score ?? 0;

  // Branch B: vector (exact scan). Down/unset service → keyword-only.
  let vectorRows: ChunkRow[] = [];
  let degradedToKeywordOnly = false;
  if (embeddings) {
    try {
      const queryEmbedding = await embeddings.embedQuery(question);
      const vectorResult = await db.query<ChunkRow>(
        `
          SELECT
            chunk.id::text AS id,
            chunk.source_type,
            chunk.source_id::text AS source_id,
            chunk.election_id::text AS election_id,
            chunk.state,
            chunk.title,
            chunk.content,
            chunk.evidence_urls,
            (1 - (chunk.embedding <=> $2::halfvec))::float8 AS score
          FROM chatbot.chunks AS chunk
          WHERE chunk.generation_id = $1::uuid
            AND chunk.embedding IS NOT NULL
            AND ($4::text IS NULL OR chunk.state = $4)
          ORDER BY chunk.embedding <=> $2::halfvec ASC, chunk.id ASC
          LIMIT $3
        `,
        [generationId, toVectorLiteral(queryEmbedding), BRANCH_LIMIT, scopeState]
      );
      vectorRows = vectorResult.rows;
    } catch (error) {
      if (!(error instanceof EmbeddingsError)) {
        throw error;
      }
      degradedToKeywordOnly = true;
      console.warn("chatbot retrieval degraded to keyword-only: embeddings unavailable:", error.message);
    }
  } else {
    degradedToKeywordOnly = true;
  }

  // Branch C: entity — the matched candidates' own chunks, best entity first.
  // Gives named-person questions their chunks even when phrasing defeats both
  // search branches.
  let entityRows: ChunkRow[] = [];
  const entityIds = entityMatches
    .filter((match) => match.similarity >= GATE_MIN_ENTITY_SIMILARITY)
    .map((match) => match.candidateId);
  if (entityIds.length > 0) {
    const entityResult = await db.query<ChunkRow>(
      `
        SELECT
          chunk.id::text AS id,
          chunk.source_type,
          chunk.source_id::text AS source_id,
          chunk.election_id::text AS election_id,
          chunk.state,
          chunk.title,
          chunk.content,
          chunk.evidence_urls,
          0::float8 AS score
        FROM chatbot.chunks AS chunk
        JOIN unnest($2::uuid[]) WITH ORDINALITY AS matched(candidate_id, rank)
          ON matched.candidate_id = chunk.source_id
        WHERE chunk.generation_id = $1::uuid
          AND chunk.source_type IN ('candidate_profile', 'candidate_record', 'finance_summary')
        -- Profile then finance then records: a named-candidate question must
        -- surface the finance summary inside the top-5 even when the
        -- candidate has many record chunks.
        ORDER BY
          matched.rank ASC,
          CASE chunk.source_type
            WHEN 'candidate_profile' THEN 0
            WHEN 'finance_summary' THEN 1
            ELSE 2
          END ASC,
          chunk.id ASC
        LIMIT $3
      `,
      [generationId, entityIds, BRANCH_LIMIT]
    );
    entityRows = entityResult.rows;
  }

  // Branch D: race listings — election chunks whose office phrase (the part
  // of the title before " — ") fuzzy-matches the question ("who's running
  // for <office> in <place>"). Profile chunks otherwise crowd the election
  // chunk out of the top-5 for offices with many candidates. Direction
  // matters for word_similarity: office (short) against the question (long)
  // finds the question extent naming the office; the place-part similarity
  // breaks ties WITHIN an office-score band in favor of the title whose
  // place tokens the question also names. Office score ranks FIRST, place
  // second (review round): summing them let fifty 0.8-band district titles
  // whose place part echoes the question's own words ("State Senate District
  // 2" contains "Senate") crowd the 1.0 real race out of the 10-row window.
  // State-filtered when the scope is known, like the
  // vector branch: a context/previous-turn scope often isn't named in the
  // question text, and without the filter other states' identically-scored
  // office matches fill the window and veto the scoped race (review catch).
  // Scope clarification is unaffected — it only runs with NO scope state.
  // Seq scan over the generation's election chunks (~6k), a few ms.
  const titleQuestion = expandOfficeAliases(question);
  // District-number rule (districtNumberPattern): a numbered title must
  // share a number with the question. In SQL, not after the fact — the
  // 10-row window would otherwise fill with lookalike districts before the
  // right one is reached.
  const numberPattern = districtNumberPattern(question);
  const titleResult = await db.query<ChunkRow>(
    `
      SELECT
        chunk.id::text AS id,
        chunk.source_type,
        chunk.source_id::text AS source_id,
        chunk.election_id::text AS election_id,
        chunk.state,
        chunk.title,
        chunk.content,
        chunk.evidence_urls,
        GREATEST(
          word_similarity(split_part(chunk.title, ' — ', 1), $2),
          similarity(chunk.title, $2)
        )::float8 AS score,
        word_similarity(split_part(split_part(chunk.title, ' — ', 2), ',', 1), $2)::float8 AS place_score
      FROM chatbot.chunks AS chunk
      WHERE chunk.generation_id = $1::uuid
        AND chunk.source_type = 'election'
        AND ($3::text IS NULL OR chunk.state = $3)
        AND (
          $4::text IS NULL
          OR ${TITLE_WITHOUT_DATES_SQL} !~ '\\m\\d{1,3}\\M'
          OR ${TITLE_WITHOUT_DATES_SQL} ~ $4
        )
        AND GREATEST(
          word_similarity(split_part(chunk.title, ' — ', 1), $2),
          similarity(chunk.title, $2)
        ) >= 0.35
      ORDER BY GREATEST(
          word_similarity(split_part(chunk.title, ' — ', 1), $2),
          similarity(chunk.title, $2)
        ) DESC,
        word_similarity(split_part(split_part(chunk.title, ' — ', 2), ',', 1), $2) DESC,
        chunk.id ASC
      LIMIT 10
    `,
    [generationId, titleQuestion, scopeState, numberPattern]
  );

  // Branch E: race members — when the title branch resolves the question to
  // one race with high confidence, pull that election's member chunks. A
  // race-level money question ("who has raised more in the Georgia Senate
  // race?") needs the candidates' finance summaries, which no other branch
  // surfaces: lexical/vector rank fifty near-identical district chunks above
  // them and the entity branch has no name to work with. Finance ahead of
  // profiles because listing questions are already answered by the listing
  // chunk at rank 1 — the race-level questions that NEED members are money
  // questions. Contributes RRF rank only, never gate evidence (score 0):
  // pulled members must not make an otherwise-unanswerable question pass.
  let raceMemberRows: ChunkRow[] = [];
  // Fetch ceiling for the members branch, NOT the generic BRANCH_LIMIT: the
  // money widening below promises EVERY filer's summary fits, and a 20-row
  // fetch silently broke that promise past 19 filers. Sized to double the
  // corpus's biggest field (Glasgow City Council, 23 filers — the largest
  // races carry no finance summaries today, max summaries per race is 7,
  // but the ceiling must not be the thing that re-creates the incomplete
  // comparison when a big money race appears). Rank-only rows: fetching
  // more never changes gate evidence, only ordering candidates.
  const raceMembersLimit = 48;
  const raceQuestionKind = classifyRaceQuestion(question);
  // The title branch is already scope-filtered; the first row clearing the
  // office-similarity bar is the race the question names (see the
  // RACE_MEMBERS_MIN_SIMILARITY comment for why row 0 alone can't decide).
  // A runner-up within both tie margins means the question does NOT name one
  // race — never pull members from an arbitrary pick.
  const qualifyingTitleRows = titleResult.rows.filter((row) => row.score >= RACE_MEMBERS_MIN_SIMILARITY);
  const topTitleMatch = qualifyingTitleRows[0];
  const raceTitleAmbiguous =
    topTitleMatch !== undefined &&
    qualifyingTitleRows.some(
      (row) =>
        row !== topTitleMatch &&
        row.election_id !== topTitleMatch.election_id &&
        row.score >= topTitleMatch.score - RACE_TIE_SCORE_EPSILON &&
        (row.place_score ?? 0) >= (topTitleMatch.place_score ?? 0) - RACE_TIE_PLACE_MARGIN
    );
  // Context-driven activation (docs/plans/chatbot-race-context-compare.md):
  // a race-collective question with page context resolves the race from the
  // page itself — the election context directly, a candidate context via the
  // election listing chunks the context branch already fetched (they are the
  // candidate's own races; type-ordered first, so BRANCH_LIMIT never drops
  // them). Two distinct races (candidate on two covered ballots) → surface
  // their listing titles for a clarification instead of picking one (rule 7).
  const contextRaceListings = RACE_COLLECTIVE_RE.test(question)
    ? contextElectionId
      ? contextRows.filter((row) => row.source_type === "election" && row.election_id === contextElectionId)
      : contextRows.filter((row) => row.source_type === "election" && row.election_id !== null)
    : [];
  const contextRaceElectionIds = [...new Set(contextRaceListings.map((row) => row.election_id as string))];
  const contextRaceAmbiguousTitles =
    contextRaceElectionIds.length > 1 ? contextRaceListings.map((row) => row.title) : [];
  // Context wins over a title match when both resolve (the viewed page is
  // the stronger signal); an ambiguous context pulls no members at all —
  // the caller clarifies before ranking matters.
  const contextRaceElectionId = contextRaceElectionIds.length === 1 ? (contextRaceElectionIds[0] as string) : null;
  const titleRaceElectionId =
    contextRaceElectionIds.length === 0 &&
    topTitleMatch &&
    !raceTitleAmbiguous &&
    topTitleMatch.election_id &&
    (scopeState || (topTitleMatch.place_score ?? 0) >= RACE_MEMBERS_MIN_PLACE_SIMILARITY)
      ? topTitleMatch.election_id
      : null;
  const memberElectionId = contextRaceElectionId ?? titleRaceElectionId;
  if (memberElectionId) {
    const raceMembersResult = await db.query<ChunkRow>(
      `
        SELECT
          chunk.id::text AS id,
          chunk.source_type,
          chunk.source_id::text AS source_id,
          chunk.election_id::text AS election_id,
          chunk.state,
          chunk.title,
          chunk.content,
          chunk.evidence_urls,
          0::float8 AS score
        FROM chatbot.chunks AS chunk
        WHERE chunk.generation_id = $1::uuid
          AND chunk.election_id = $2::uuid
        -- Round-robin within a source type by candidate (review catch: NC's
        -- Senate race has 40 record chunks and title order fed 19 of one
        -- candidate's before any of the other's — a race-wide records
        -- question saw exactly one candidate). Profiles/finance are 1 per
        -- candidate, so only records interleave.
        ORDER BY
          array_position($4::text[], chunk.source_type) ASC NULLS LAST,
          row_number() OVER (
            PARTITION BY chunk.source_type, chunk.source_id
            ORDER BY chunk.title ASC, chunk.id ASC
          ) ASC,
          chunk.title ASC,
          chunk.id ASC
        LIMIT $3
      `,
      [generationId, memberElectionId, raceMembersLimit, RACE_MEMBER_TYPE_ORDER[raceQuestionKind]]
    );
    raceMemberRows = raceMembersResult.rows;
  }

  // RRF merge; raw scores ride along per chunk for the gate.
  type Merged = {
    base: Omit<RetrievedChunk, "lexicalScore" | "cosineSimilarity" | "rrfScore">;
    lexicalScore: number;
    cosineSimilarity: number;
    rrfScore: number;
    /** Position in the context branch, Infinity otherwise: a deictic
     * question is ABOUT the viewed page, so its chunks outrank everything
     * the generic phrasing ("tell me more about this candidate") happens to
     * co-match elsewhere. */
    contextRank: number;
    /** Position in the race-members branch, Infinity otherwise. Same idea
     * one notch weaker: a candidate-less question confidently resolved to
     * one race is ABOUT that race, so its members outrank the fifty
     * lookalike-district chunks lexical+vector agree on. Applied only when
     * NO candidate entity matched — a named candidate ("Allen Buckley, the
     * Libertarian running for Senate") is the stronger signal and keeps
     * normal ranking — except when the question asks about the named
     * candidate's opponents (RACE_OTHERS_RE), a field question. */
    raceRank: number;
  };
  const merged = new Map<string, Merged>();
  const fold = (
    rows: readonly ChunkRow[],
    kind: "lexical" | "vector" | "entity" | "title" | "race" | "context"
  ): void => {
    rows.forEach((row, index) => {
      const existing = merged.get(row.id) ?? {
        base: toBaseChunk(row),
        lexicalScore: 0,
        cosineSimilarity: 0,
        rrfScore: 0,
        contextRank: Number.POSITIVE_INFINITY,
        raceRank: Number.POSITIVE_INFINITY,
      };
      existing.rrfScore += 1 / (RRF_K + index + 1);
      if (kind === "lexical") {
        existing.lexicalScore = Math.max(existing.lexicalScore, row.score);
      }
      if (kind === "vector") {
        existing.cosineSimilarity = Math.max(existing.cosineSimilarity, row.score);
      }
      if (kind === "race") {
        existing.raceRank = Math.min(existing.raceRank, index);
      }
      if (kind === "context") {
        existing.contextRank = Math.min(existing.contextRank, index);
      }
      merged.set(row.id, existing);
    });
  };
  fold(lexicalResult.rows, "lexical");
  fold(vectorRows, "vector");
  fold(entityRows, "entity");
  fold(titleResult.rows, "title");
  fold(raceMemberRows, "race");
  fold(contextRows, "context");

  // With page context in play, filler must EARN its slot: a generic deictic
  // phrase ("tell me more about this candidate") weakly co-matches random
  // profiles, and those read as non-sequiturs next to the page's own chunks.
  // Non-context chunks survive only on real evidence — a matched entity's
  // chunk or a gate-strength cosine hit.
  const entityIdSet = new Set(entityIds);
  // Context-driven members are deliberate evidence, not co-match filler:
  // without this exemption the opponents' chunks (contextRank Infinity, no
  // entity match, low cosine) would be filtered out and a compare question
  // would only ever see the viewed candidate.
  const contenders = [...merged.values()].filter(
    (entry) =>
      contextRows.length === 0 ||
      entry.contextRank !== Number.POSITIVE_INFINITY ||
      (contextRaceElectionId !== null && entry.raceRank !== Number.POSITIVE_INFINITY) ||
      (entry.base.sourceId !== null && entityIdSet.has(entry.base.sourceId)) ||
      entry.cosineSimilarity >= GATE_MIN_COSINE
  );
  // Candidate context: the race listing chunks ride OUTSIDE the top-K cap
  // (they sort first, so widening the cap by their count keeps the same K
  // slots of the candidate's own evidence a record/finance question had
  // before rosters joined the branch). Bounded at 2 — nobody is on more than
  // a couple of November ballots, and a runaway count must not grow the
  // prompt unboundedly.
  const rosterSlots = contextCandidateId
    ? Math.min(contextRows.filter((row) => row.source_type === "election").length, 2)
    : 0;
  // Race precedence only without a matched entity (see raceRank above); with
  // one, members still fold into RRF but never jump the queue — UNLESS the
  // question names a candidate while asking about the others
  // (RACE_OTHERS_RE): that is a field question, so members keep precedence
  // and a money question still widens for every filer's summary.
  const raceRankApplies = entityIds.length === 0 || RACE_OTHERS_RE.test(question);
  // Race-wide money question: EVERY filer's summary must fit, or "who raised
  // more?" silently compares an incomplete field (review catch: Florida's
  // Senate race has 7 summaries; the cap kept 4, alphabetically). Widen by
  // exactly the overflow — the listing takes one slot, so top-K holds K-1
  // summaries. raceMembersLimit is the ceiling (corpus maximum today: 7
  // summaries in one race) — an arbitrary smaller cap would silently
  // re-create the incomplete comparison for a bigger race.
  // Money ONLY, deliberately (review round): a superlative over amounts is
  // WRONG on a partial field, but a neutral/records "compare the
  // candidates" on a 23-filer field (Glasgow City Council) is not made
  // better by 23 profiles the ~90-word answer cannot use — the listing
  // chunk leads the members ordering and names every filer, so the model
  // always sees the whole field and can scope its comparison honestly.
  // Widening neutral would also fire on plain listing questions ("who's
  // running?"), tripling prompt spend for answers the listing already
  // covers.
  const raceFinanceSlots =
    raceRankApplies && raceQuestionKind === "money"
      ? Math.max(
          raceMemberRows.filter((row) => row.source_type === "finance_summary").length - (RETRIEVAL_TOP_K - 1),
          0
        )
      : 0;
  // Context-driven members INVERT the context-first precedence: a collective
  // question is about the race's field, so the members ordering (listing,
  // then the per-kind source type round-robined across candidates) is the
  // right priority — under context-first, the viewed candidate's own chunk
  // pile would fill the cap before any opponent appeared. The members set
  // contains the viewed candidate's chunks too (same election_id), so
  // nothing about the page is lost, and contextRank still breaks ties for
  // page chunks the members LIMIT truncated away.
  const raceContextPrecedence = contextRaceElectionId !== null && raceRankApplies;
  const chunks = contenders
    .sort(
      (a, b) =>
        (raceContextPrecedence
          ? a.raceRank - b.raceRank || a.contextRank - b.contextRank
          : a.contextRank - b.contextRank || (raceRankApplies ? a.raceRank - b.raceRank : 0)) ||
        b.rrfScore - a.rrfScore ||
        a.base.id.localeCompare(b.base.id)
    )
    .slice(0, RETRIEVAL_TOP_K + rosterSlots + raceFinanceSlots)
    .map((entry) => ({
      ...entry.base,
      lexicalScore: entry.lexicalScore,
      cosineSimilarity: entry.cosineSimilarity,
      rrfScore: entry.rrfScore,
    }));

  const bestCosineSimilarity = vectorRows[0]?.score ?? 0;

  return {
    chunks,
    electionTitleMatches: titleResult.rows.map((row) => ({
      state: row.state,
      title: row.title,
      similarity: row.score,
      placeSimilarity: row.place_score ?? 0,
    })),
    entityMatches,
    ambiguousEntities,
    bestLexicalScore,
    bestCosineSimilarity,
    bestEntitySimilarity,
    contextMatched: contextRows.length > 0,
    raceTitleAmbiguous,
    contextRaceAmbiguousTitles,
    degradedToKeywordOnly,
  };
}

/** Answerability gate on RAW scores (never RRF rank). */
export function isAnswerable(result: RetrievalResult): boolean {
  if (result.chunks.length === 0) {
    return false;
  }
  return (
    result.bestCosineSimilarity >= GATE_MIN_COSINE ||
    result.bestLexicalScore >= GATE_MIN_LEXICAL ||
    result.bestEntitySimilarity >= GATE_MIN_ENTITY_SIMILARITY
  );
}

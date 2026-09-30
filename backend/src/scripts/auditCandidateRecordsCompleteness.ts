import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";

import { assertKnownCliFlags } from "./manualCliFlags.js";
import {
  listMissingSweepRouteQuestionIds,
  type SweepRoute,
} from "./candidateRecordSweepEvidence.js";
import {
  buildDomainFirstSeenMap,
  buildSourceTierSweep,
  type CorpusFirstSeenRow,
  CROSS_CANDIDATE_DOMAIN_MIN_CANDIDATES,
  listCrossCandidateDomainBursts,
  listNewlySeenDomainConcentrations,
  listPreElectionDamagingBursts,
  NEWLY_SEEN_DOMAIN_MIN_RECORDS,
  PRE_ELECTION_DAMAGING_MIN_RECORDS,
  PRE_ELECTION_WINDOW_DAYS,
  SOURCE_AUDIT_RECENT_WINDOW_DAYS,
  type SourceAuditCandidateElectionRow,
  type SourceAuditRecordRow,
} from "./candidateRecordSourceAudit.js";
/**
 * Red-flag audit for false records-sweep completeness.
 *
 * A candidate whose profile shows real service (a current office or an
 * incumbent election link) but who has ZERO non-retired candidate_records rows despite a
 * `last_records_searched_at` completion stamp is the signature of a skipped
 * discovery sweep written as `no_records_found`. This read-only script lists
 * those candidates so a session can re-run their record sweeps properly.
 *
 * Candidates whose zero-record state is backed by a persisted sweep
 * confirmation (candidate_record_sweep_confirmations, written by the
 * evidence-file guard) are reported separately as confirmed nulls, not
 * suspects — their sweep was finished and evidenced, so they need no re-run.
 *
 * The confirmation only counts while it covers the latest completion stamp:
 * writer and confirmation share one transaction (both timestamps are that
 * transaction's now()), so a fresh confirmation compares equal — but any
 * LATER search that re-stamps last_records_searched_at without refreshing
 * the evidence row (AI worker pass, pre-guard manual write) makes the old
 * evidence a historical claim, and the candidate goes back to suspects.
 *
 * Usage: npm run manual:records:audit [-- --candidate-id uuid] [--election-id uuid] [--district-id uuid]
 *
 * Targeting flags narrow the audit to one candidate, the candidates linked to
 * one election, or the candidates linked to any election in one district —
 * useful right after a per-district or per-election research pass instead of
 * scanning the whole table. Flags combine with AND.
 */

type AuditRow = {
  candidate_id: string;
  display_name: string;
  current_office: string | null;
  is_incumbent: boolean;
  last_records_searched_at: string;
  election_titles: string[];
  confirmed_gap_ids: string[] | null;
  confirmed_at: string | null;
  evidence_entry_count: number | null;
  confirmation_covers_latest_search: boolean | null;
  retired_record_count: number;
};

const NO_RECORDS_FOUND_GAP_ID = "candidate_records.no_records_found";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuditTargetFilters = {
  candidateId: string | null;
  electionId: string | null;
  districtId: string | null;
};

export function buildAuditTargetConditions(filters: AuditTargetFilters): {
  conditions: string[];
  values: string[];
} {
  const conditions: string[] = [];
  const values: string[] = [];
  const push = (value: string, condition: (placeholder: string) => string): void => {
    values.push(value);
    conditions.push(condition(`$${values.length}`));
  };
  if (filters.candidateId) {
    push(filters.candidateId, (p) => `c.id = ${p}::uuid`);
  }
  // Joint-ticket running mates have no candidate_elections row of their own
  // (they live in running_mate_candidate_id on the ticket lead's row), so the
  // election/district predicates must accept either side of the link.
  if (filters.electionId) {
    push(
      filters.electionId,
      (p) =>
        `EXISTS (SELECT 1 FROM public.candidate_elections cef WHERE (cef.candidate_id = c.id OR cef.running_mate_candidate_id = c.id) AND cef.election_id = ${p}::uuid)`
    );
  }
  if (filters.districtId) {
    push(
      filters.districtId,
      (p) =>
        `EXISTS (SELECT 1 FROM public.candidate_elections cef JOIN public.elections ef ON ef.id = cef.election_id WHERE (cef.candidate_id = c.id OR cef.running_mate_candidate_id = c.id) AND ef.district_id = ${p}::uuid)`
    );
  }
  return { conditions, values };
}

function readUuidFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a UUID, got "${value}"`);
  }
  return value;
}

export function isConfirmedNull(
  row: Pick<AuditRow, "confirmed_gap_ids" | "confirmation_covers_latest_search">
): boolean {
  return (
    row.confirmation_covers_latest_search === true &&
    (row.confirmed_gap_ids ?? []).includes(NO_RECORDS_FOUND_GAP_ID)
  );
}

// --- Sweep-confirmation red-flag detectors (PR 2 of the routing-enforcement
// plan). Both read the persisted evidence ledgers and retro-flag the
// 2026-07-15 collapsed-template cohort: identical multi-candidate finding
// text is the copy-paste signature, and a ledger whose question_id tags
// cover no complete route was never a per-question sweep.

/**
 * Identical finding text across at least this many DISTINCT candidates flags
 * the group. Real research phrases findings per candidate; verbatim reuse
 * across several people is the template signature.
 */
export const SHARED_FINDING_MIN_CANDIDATES = 3;

/**
 * Findings shorter than this never flag: short negative findings ("nothing
 * found" is the sanctioned phrasing for an empty answer) legitimately repeat
 * across candidates, while identical long prose does not.
 */
export const SHARED_FINDING_MIN_LENGTH = 40;

export type SweepConfirmationDetectorRow = {
  candidate_id: string;
  display_name: string;
  has_held_public_office: boolean | null;
  confirmed_at: string;
  evidence: unknown;
  context_type: "election" | "presidential_cycle";
  context_id: string;
  /** elections.discovery_contest_family of the confirmation's own contest (election contexts only). */
  discovery_contest_family: string | null;
  /** False when an election-context confirmation's election row no longer exists. */
  context_election_found: boolean;
};

type EvidenceEntryForAudit = {
  finding: string;
  questionId: string | null;
};

/**
 * Defensive read of the stored evidence jsonb ({"entries": [{"question",
 * "finding", "question_id"?}]}); malformed rows yield no entries rather than
 * crashing the audit — the route-coverage detector then flags them anyway
 * (no tags = no covered route).
 */
export function extractAuditEvidenceEntries(evidence: unknown): EvidenceEntryForAudit[] {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    return [];
  }
  const entries = (evidence as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) {
    return [];
  }
  const parsed: EvidenceEntryForAudit[] = [];
  for (const row of entries) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      continue;
    }
    const entry = row as Record<string, unknown>;
    if (typeof entry.finding !== "string" || entry.finding.trim().length === 0) {
      continue;
    }
    parsed.push({
      finding: entry.finding.trim(),
      questionId: typeof entry.question_id === "string" ? entry.question_id : null,
    });
  }
  return parsed;
}

export type SharedFindingTextGroup = {
  findingText: string;
  candidateCount: number;
  sampleCandidates: { candidateId: string; displayName: string }[];
};

/**
 * Groups confirmations by normalized finding text and returns the groups
 * shared verbatim across >= SHARED_FINDING_MIN_CANDIDATES distinct
 * candidates, most-shared first.
 */
export function listSharedFindingTexts(
  rows: readonly SweepConfirmationDetectorRow[]
): SharedFindingTextGroup[] {
  const groups = new Map<
    string,
    { findingText: string; candidates: Map<string, string> }
  >();
  for (const row of rows) {
    for (const entry of extractAuditEvidenceEntries(row.evidence)) {
      if (entry.finding.length < SHARED_FINDING_MIN_LENGTH) {
        continue;
      }
      const normalized = entry.finding.toLowerCase().replace(/\s+/g, " ");
      let group = groups.get(normalized);
      if (!group) {
        group = { findingText: entry.finding, candidates: new Map() };
        groups.set(normalized, group);
      }
      if (!group.candidates.has(row.candidate_id)) {
        group.candidates.set(row.candidate_id, row.display_name);
      }
    }
  }
  return [...groups.values()]
    .filter((group) => group.candidates.size >= SHARED_FINDING_MIN_CANDIDATES)
    .sort((left, right) => right.candidates.size - left.candidates.size)
    .map((group) => ({
      findingText: group.findingText,
      candidateCount: group.candidates.size,
      sampleCandidates: [...group.candidates.entries()]
        .slice(0, 5)
        .map(([candidateId, displayName]) => ({ candidateId, displayName })),
    }));
}

export type RouteCoverageGap = {
  candidateId: string;
  displayName: string;
  contextType: "election" | "presidential_cycle";
  contextId: string;
  confirmedAt: string;
  taggedQuestionIds: string[];
  reason: string;
};

/**
 * The routes a confirmation may legitimately cover, derived from its OWN
 * stored contest context first (the same routing the writers enforce):
 * a judicial election context requires the judicial route, any other found
 * election context and every presidential context excludes it (presidential
 * contests are never judicial), and only a vanished election row falls back
 * to permitting judicial. Within the non-judicial routes, the stored
 * has_held_public_office picks officeholder vs never_held_office; NULL
 * allows either.
 */
export function allowedSweepRoutesForConfirmation(
  row: Pick<
    SweepConfirmationDetectorRow,
    "context_type" | "discovery_contest_family" | "context_election_found" | "has_held_public_office"
  >
): SweepRoute[] {
  if (row.context_type === "election" && row.discovery_contest_family === "judicial_office") {
    return ["judicial"];
  }
  const contextKnown =
    row.context_type === "presidential_cycle" ||
    (row.context_type === "election" && row.context_election_found);
  const nonJudicial: SweepRoute[] =
    row.has_held_public_office === true
      ? ["officeholder"]
      : row.has_held_public_office === false
        ? ["never_held_office"]
        : ["officeholder", "never_held_office"];
  return contextKnown ? nonJudicial : [...nonJudicial, "judicial"];
}

/**
 * A confirmation must carry question_id tags covering at least one COMPLETE
 * route question list consistent with its stored contest context and the
 * candidate's stored routing fact (allowedSweepRoutesForConfirmation).
 * Pre-PR-#350 confirmations carry no tags and flag here — that is the
 * retro-flagging of the 2026-07-15 cohort, not a false positive.
 */
export function listRouteCoverageGaps(
  rows: readonly SweepConfirmationDetectorRow[]
): RouteCoverageGap[] {
  const gaps: RouteCoverageGap[] = [];
  for (const row of rows) {
    const entries = extractAuditEvidenceEntries(row.evidence);
    const allowedRoutes = allowedSweepRoutesForConfirmation(row);
    const covered = allowedRoutes.some(
      (route) => listMissingSweepRouteQuestionIds(entries, route).length === 0
    );
    if (covered) {
      continue;
    }
    const taggedQuestionIds = [
      ...new Set(entries.map((entry) => entry.questionId).filter((id): id is string => id !== null)),
    ].sort();
    gaps.push({
      candidateId: row.candidate_id,
      displayName: row.display_name,
      contextType: row.context_type,
      contextId: row.context_id,
      confirmedAt: row.confirmed_at,
      taggedQuestionIds,
      reason:
        taggedQuestionIds.length === 0
          ? "no question_id tags (pre-#350 ledger or untagged template)"
          : `tags cover no complete route question list (allowed: ${allowedRoutes.join(", ")})`,
    });
  }
  return gaps;
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:records:audit", process.argv.slice(2), [
    { name: "--candidate-id", value: "space" },
    { name: "--election-id", value: "space" },
    { name: "--district-id", value: "space" },
  ]);
  loadProjectEnv();

  const filters: AuditTargetFilters = {
    candidateId: readUuidFlag("--candidate-id"),
    electionId: readUuidFlag("--election-id"),
    districtId: readUuidFlag("--district-id"),
  };
  const target = buildAuditTargetConditions(filters);
  const targetSql = target.conditions.map((condition) => `          AND ${condition}`).join("\n");

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for manual records audit");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<AuditRow>(
      `
        SELECT
          c.id::text AS candidate_id,
          c.display_name,
          c.current_office,
          coalesce(bool_or(ce.is_incumbent), false) AS is_incumbent,
          c.last_records_searched_at::text AS last_records_searched_at,
          array_remove(array_agg(DISTINCT e.official_ballot_title), NULL) AS election_titles,
          sc.confirmed_gap_ids,
          sc.confirmed_at::text AS confirmed_at,
          jsonb_array_length(sc.evidence -> 'entries')::int AS evidence_entry_count,
          (sc.confirmed_at >= c.last_records_searched_at) AS confirmation_covers_latest_search,
          (SELECT count(*) FROM public.candidate_records rr
            WHERE rr.candidate_id = c.id AND rr.retired_at IS NOT NULL)::int AS retired_record_count
        FROM public.candidates c
        LEFT JOIN public.candidate_elections ce
          ON ce.candidate_id = c.id OR ce.running_mate_candidate_id = c.id
        LEFT JOIN public.elections e ON e.id = ce.election_id
        -- Newest no-records confirmation across ALL of the candidate's contexts,
        -- deliberately not scoped to --election-id / --district-id: records and
        -- the search stamp are candidate-wide, so an evidenced zero-record sweep
        -- from any context is evidence for the candidate. The filters below pick
        -- WHICH candidates are listed, not which context's ledger counts. A stale
        -- ledger cannot mask a later gap: a newer write either advances the stamp
        -- past confirmed_at (suspect) or finds records (completeness rows deleted).
        LEFT JOIN LATERAL (
          SELECT sc_latest.confirmed_gap_ids, sc_latest.confirmed_at, sc_latest.evidence
          FROM public.candidate_record_sweep_confirmations sc_latest
          WHERE sc_latest.candidate_id = c.id
            AND sc_latest.confirmed_gap_ids @> ARRAY['candidate_records.no_records_found']::text[]
          ORDER BY sc_latest.confirmed_at DESC, sc_latest.context_type, sc_latest.context_id
          LIMIT 1
        ) sc ON true
        WHERE c.deleted_at IS NULL
          AND c.merged_into_candidate_id IS NULL
          AND c.last_records_searched_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.candidate_records r
            WHERE r.candidate_id = c.id AND r.retired_at IS NULL
          )
${targetSql}
        GROUP BY c.id, c.display_name, c.current_office, c.last_records_searched_at,
          sc.confirmed_gap_ids, sc.confirmed_at, sc.evidence
        -- Third service signal: rows RETIRED out from under a completed sweep.
        -- A November repair pass retired every stored row for 24 candidates
        -- (candidacy/self-promotion violations); only 1 of the 24 carried a
        -- current office or incumbent link, so the other 23 were invisible
        -- here despite needing a proper re-sweep exactly like the others.
        HAVING (
          c.current_office IS NOT NULL
          OR coalesce(bool_or(ce.is_incumbent), false)
          OR EXISTS (
            SELECT 1 FROM public.candidate_records rr
            WHERE rr.candidate_id = c.id AND rr.retired_at IS NOT NULL
          )
        )
        ORDER BY c.display_name ASC
      `,
      target.values
    );

    const suspects = result.rows.filter((row) => !isConfirmedNull(row));
    const confirmedNulls = result.rows.filter((row) => isConfirmedNull(row));

    // Detector pass over ALL persisted sweep confirmations in scope (not just
    // zero-record candidates): a collapsed-template ledger is a red flag even
    // when the candidate has records. "In scope" means every ledger of every
    // candidate the filters select — including ledgers from a different
    // election context than --election-id. Route coverage is judged against
    // each ledger's OWN stored context below, so those rows are valid
    // findings, not noise; scoping by context would only hide red flags.
    const confirmationsResult = await pool.query<SweepConfirmationDetectorRow>(
      `
        SELECT
          c.id::text AS candidate_id,
          c.display_name,
          c.has_held_public_office,
          sc.confirmed_at::text AS confirmed_at,
          sc.evidence,
          sc.context_type,
          sc.context_id::text AS context_id,
          ctx.discovery_contest_family,
          (sc.context_type <> 'election' OR ctx.id IS NOT NULL) AS context_election_found
        FROM public.candidate_record_sweep_confirmations sc
        JOIN public.candidates c ON c.id = sc.candidate_id
        LEFT JOIN public.elections ctx
          ON sc.context_type = 'election' AND ctx.id = sc.context_id
        WHERE c.deleted_at IS NULL
          AND c.merged_into_candidate_id IS NULL
${targetSql}
        ORDER BY c.display_name ASC
      `,
      target.values
    );
    const sharedFindingTexts = listSharedFindingTexts(confirmationsResult.rows);
    const routeCoverageGaps = listRouteCoverageGaps(confirmationsResult.rows);
    const ROUTE_COVERAGE_GAP_LIST_LIMIT = 100;
    const SHARED_FINDING_LIST_LIMIT = 50;

    // Source-domain detector feed (PR 3 of the source-trust plan): every
    // non-retired stored record in scope plus each candidate's election
    // dates. Tier is a pure function of the stored URL, so this retro-covers
    // all active rows; retired rows are withdrawn and repairing them is moot.
    const recordsResult = await pool.query<SourceAuditRecordRow>(
      `
        SELECT
          r.id::text AS record_id,
          r.candidate_id::text AS candidate_id,
          c.display_name,
          r.description,
          r.source_url,
          r.created_at::text AS created_at,
          r.origin,
          r.origin_run_id
        FROM public.candidate_records r
        JOIN public.candidates c ON c.id = r.candidate_id
        WHERE c.deleted_at IS NULL
          AND c.merged_into_candidate_id IS NULL
          AND r.retired_at IS NULL
${targetSql}
        ORDER BY r.created_at ASC
      `,
      target.values
    );
    const candidateElectionsResult = await pool.query<SourceAuditCandidateElectionRow>(
      `
        SELECT DISTINCT
          c.id::text AS candidate_id,
          e.id::text AS election_id,
          e.election_date::text AS election_date,
          e.official_ballot_title
        FROM public.candidates c
        JOIN public.candidate_elections ce
          ON ce.candidate_id = c.id OR ce.running_mate_candidate_id = c.id
        JOIN public.elections e ON e.id = ce.election_id
        WHERE c.deleted_at IS NULL
          AND c.merged_into_candidate_id IS NULL
          AND e.race_type = 'office'
${targetSql}
      `,
      target.values
    );
    // Unfiltered on purpose (and without the candidates join): "first seen"
    // must mean first ever across the whole corpus, or a filtered audit run
    // would misreport a long-used domain as brand new inside its slice.
    const corpusFirstSeenResult = await pool.query<CorpusFirstSeenRow>(
      `
        SELECT r.source_url, r.created_at::text AS created_at
        FROM public.candidate_records r
      `
    );
    const auditNow = new Date();
    const crossCandidateDomainBursts = listCrossCandidateDomainBursts(
      recordsResult.rows,
      auditNow
    );
    const preElectionDamagingBursts = listPreElectionDamagingBursts(
      recordsResult.rows,
      candidateElectionsResult.rows
    );
    const newlySeenDomainConcentrations = listNewlySeenDomainConcentrations(
      recordsResult.rows,
      buildDomainFirstSeenMap(corpusFirstSeenResult.rows),
      auditNow
    );
    const sourceTierSweep = buildSourceTierSweep(recordsResult.rows);
    const UNLISTED_DOMAIN_LIST_LIMIT = 100;
    const BLOCKED_RECORD_LIST_LIMIT = 100;

    const appliedFilters = Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== null)
    );

    console.log(
      JSON.stringify(
        {
          ...(Object.keys(appliedFilters).length > 0 ? { filters: appliedFilters } : {}),
          suspectCount: suspects.length,
          confirmedNullCount: confirmedNulls.length,
          explanation:
            "Suspects: candidates with a records-search completion stamp, ZERO non-retired candidate_records rows, no sweep confirmation covering the latest search (a confirmation older than last_records_searched_at is historical — a later search re-opened the question), and a service signal: a current office, an incumbent election link, or previously stored records that were later retired. Each needs a proper per-question record sweep re-run. Confirmed nulls carry an evidence-backed candidate_record_sweep_confirmations row at least as new as the latest completion stamp and need no re-run.",
          suspects: suspects.map((row) => ({
            candidateId: row.candidate_id,
            displayName: row.display_name,
            currentOffice: row.current_office,
            isIncumbent: row.is_incumbent,
            lastRecordsSearchedAt: row.last_records_searched_at,
            electionTitles: row.election_titles,
            retiredRecordCount: row.retired_record_count,
            ...(row.confirmed_at
              ? {
                  staleConfirmation: {
                    confirmedGapIds: row.confirmed_gap_ids,
                    confirmedAt: row.confirmed_at,
                    evidenceEntryCount: row.evidence_entry_count,
                  },
                }
              : {}),
          })),
          confirmedNulls: confirmedNulls.map((row) => ({
            candidateId: row.candidate_id,
            displayName: row.display_name,
            currentOffice: row.current_office,
            isIncumbent: row.is_incumbent,
            lastRecordsSearchedAt: row.last_records_searched_at,
            electionTitles: row.election_titles,
            retiredRecordCount: row.retired_record_count,
            confirmedGapIds: row.confirmed_gap_ids,
            confirmedAt: row.confirmed_at,
            evidenceEntryCount: row.evidence_entry_count,
          })),
          sweepConfirmationDetectors: {
            confirmationCount: confirmationsResult.rows.length,
            explanation:
              `Red-flag detectors over persisted sweep-confirmation ledgers. sharedFindingTexts: finding text (>= ${SHARED_FINDING_MIN_LENGTH} chars) repeated verbatim across >= ${SHARED_FINDING_MIN_CANDIDATES} distinct candidates — the copy-paste template signature; short negative findings like "nothing found" legitimately repeat and are exempt. routeCoverageGaps: confirmations whose question_id tags cover no complete route question list consistent with the confirmation's own contest context (judicial election contexts require the judicial route; other found election contexts and presidential contexts exclude it) and candidates.has_held_public_office — untagged pre-#350 ledgers (including the 2026-07-15 cohort) flag here by design. Flagged candidates need a proper per-question re-sweep (or the PR-3 confirmation-reset repair).`,
            sharedFindingTextCount: sharedFindingTexts.length,
            sharedFindingTexts: sharedFindingTexts.slice(0, SHARED_FINDING_LIST_LIMIT).map((group) => ({
              candidateCount: group.candidateCount,
              findingText:
                group.findingText.length > 200
                  ? `${group.findingText.slice(0, 197)}...`
                  : group.findingText,
              sampleCandidates: group.sampleCandidates,
            })),
            ...(sharedFindingTexts.length > SHARED_FINDING_LIST_LIMIT
              ? { sharedFindingTextsTruncatedTo: SHARED_FINDING_LIST_LIMIT }
              : {}),
            routeCoverageGapCount: routeCoverageGaps.length,
            routeCoverageGaps: routeCoverageGaps.slice(0, ROUTE_COVERAGE_GAP_LIST_LIMIT),
            ...(routeCoverageGaps.length > ROUTE_COVERAGE_GAP_LIST_LIMIT
              ? { routeCoverageGapsTruncatedTo: ROUTE_COVERAGE_GAP_LIST_LIMIT }
              : {}),
          },
          sourceDomainDetectors: {
            recordCount: recordsResult.rows.length,
            explanation:
              `Advisory source-domain detectors over stored candidate_records (nothing here blocks a write; the import-time source policy already rejects blocked domains and unlisted-damaging records). crossCandidateDomainBursts: one unlisted domain cited by >= ${CROSS_CANDIDATE_DOMAIN_MIN_CANDIDATES} distinct candidates in the last ${SOURCE_AUDIT_RECENT_WINDOW_DAYS} days — the one-outlet-feeding-many-candidates signature of a coordinated placement campaign. preElectionDamagingBursts: a candidate gaining >= ${PRE_ELECTION_DAMAGING_MIN_RECORDS} damaging-pattern records IMPORTED within ${PRE_ELECTION_WINDOW_DAYS} days before one of their elections. newlySeenDomainConcentrations: a non-listed domain whose first record ever is inside the window and already feeds >= ${NEWLY_SEEN_DOMAIN_MIN_RECORDS} records (fresh domains should not arrive with volume). sourceTierSweep: the periodic unlisted-source review feed, count-sorted per domain — legit domains graduate to the allowlist via a trivial PR; blockedDomainRecords are stored rows citing a domain the policy now rejects (pre-policy leftovers to clean up), each carrying blockedKind + repair because the three blocked classes need three different fixes — ugc_social needs accountable secondary coverage, generated_candidate_directory needs the underlying primary source, and bot_check_interstitial needs the real URL URL-decoded out of the stored link's own query string (treating an interstitial as bad CONTENT would throw away a good .gov citation). blockedKindCounts breaks the total down by class.`,
            crossCandidateDomainBurstCount: crossCandidateDomainBursts.length,
            crossCandidateDomainBursts,
            preElectionDamagingBurstCount: preElectionDamagingBursts.length,
            preElectionDamagingBursts,
            newlySeenDomainConcentrationCount: newlySeenDomainConcentrations.length,
            newlySeenDomainConcentrations,
            sourceTierSweep: {
              tierCounts: sourceTierSweep.tierCounts,
              unlistedDomainCount: sourceTierSweep.unlistedDomains.length,
              unlistedDomains: sourceTierSweep.unlistedDomains.slice(0, UNLISTED_DOMAIN_LIST_LIMIT),
              ...(sourceTierSweep.unlistedDomains.length > UNLISTED_DOMAIN_LIST_LIMIT
                ? { unlistedDomainsTruncatedTo: UNLISTED_DOMAIN_LIST_LIMIT }
                : {}),
              blockedDomainRecordCount: sourceTierSweep.blockedDomainRecords.length,
              blockedKindCounts: sourceTierSweep.blockedKindCounts,
              trackerCitedActionRecordCount: sourceTierSweep.trackerCitedActionRecords.length,
              trackerCitedActionRecords: sourceTierSweep.trackerCitedActionRecords.slice(0, BLOCKED_RECORD_LIST_LIMIT),
              blockedDomainRecords: sourceTierSweep.blockedDomainRecords.slice(
                0,
                BLOCKED_RECORD_LIST_LIMIT
              ),
              ...(sourceTierSweep.blockedDomainRecords.length > BLOCKED_RECORD_LIST_LIMIT
                ? { blockedDomainRecordsTruncatedTo: BLOCKED_RECORD_LIST_LIMIT }
                : {}),
            },
          },
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("manual records audit failed:", message);
    process.exitCode = 1;
  });
}

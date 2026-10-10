// Phase 2 auto-link: establishes candidate → controlled-committee links from
// the parsed cycle export via the San Diego resolver (clerk-log, stored-id,
// and name tiers), copy-adapted from sanJoseCandidateFinanceAutoLink.
//
// listSanDiegoCityCandidateElectionsMissingFinanceLinks selects work the SF
// way (roster candidates without an active link, inside the eligibility
// window). Resolution runs PER ELECTION — the resolver's committee-shared-by-
// two-candidates check must fire within one contest, while the same committee
// legitimately links across a primary and its runoff (one committee funds
// the whole cycle).
//
// There is no per-election transaction: San Diego link rows are independent
// (no outside-relations table to keep consistent), and the writer itself
// protects manual links — a matching automatic upsert reuses the operator's
// row, a conflicting one errors into this module's per-candidate result
// instead of blocking the rest of the election.

import type { Pool, PoolClient } from "pg";
import {
  isSanDiegoCityFinanceEligibleElection,
  parseSanDiegoCityCouncilSeatNumber,
  SAN_DIEGO_CITY_GEOID,
} from "./sanDiegoCityFinanceEligibleOffices.js";
import {
  collectSanDiegoCityExportCommittees,
  normalizeSanDiegoCityTextKey,
  resolveSanDiegoCityCandidateCommittees,
  type SanDiegoCityAppCandidate,
  type SanDiegoCityExportCommittee,
} from "./sanDiegoCityCandidateCommitteeResolver.js";
import type { EfileCalWorkbook } from "../efileCalFinance/efileCalWorkbookParser.js";
import { upsertSanDiegoCityFinanceLink } from "./sanDiegoCityFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

/** The public filing portal (the City Clerk is the filing officer). The
 * Phase 3 sync module reuses this as its source URL and builds its
 * EfileCalAgencyConfig around it, mirroring SAN_JOSE_FINANCE_SOURCE_URL. */
export const SAN_DIEGO_CITY_FINANCE_SOURCE_URL = "https://efile.sandiego.gov";

export type SanDiegoCityFinanceAutoLinkCandidate = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: SanDiegoCityAppCandidate["officeName"];
  /** Council district seat (1–9); null for Mayor. */
  seatNumber: number | null;
  stateFilingIds: readonly string[];
};

const SAN_DIEGO_ELECTION_PREDICATE = `district.state='CA' AND district.district_type='place' AND district.geoid_compact='${SAN_DIEGO_CITY_GEOID}' AND office.scope='place'`;

export async function listSanDiegoCityCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  },
): Promise<SanDiegoCityFinanceAutoLinkCandidate[]> {
  // The name COALESCE below can be NULL when every name column is blank —
  // a defective roster row. The resolver would throw on a null display name,
  // and one bad row must not poison the whole auto-link leg, so such rows
  // are excluded in SQL (they cannot be name-matched anyway).
  const result = await db.query<{
    candidate_id: string;
    election_id: string;
    candidate_name: string;
    election_date: string;
    state: string;
    district_type: string;
    geoid_compact: string;
    office_scope: string;
    office_name: string;
    official_ballot_title: string | null;
    state_filing_ids: unknown;
  }>(
    `SELECT candidate.id::text candidate_id,election.id::text election_id,COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) candidate_name,election.election_date::text election_date,district.state,district.district_type,district.geoid_compact,office.scope office_scope,office.canonical_name office_name,election.official_ballot_title,candidate.state_filing_ids FROM public.candidate_elections candidate_election JOIN public.candidates candidate ON candidate.id=candidate_election.candidate_id JOIN public.elections election ON election.id=candidate_election.election_id JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id WHERE candidate.deleted_at IS NULL AND ${SAN_DIEGO_ELECTION_PREDICATE} AND election.race_type='office' AND election.election_date>=(($1::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int)) AND election.election_date<=(($1::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int)) AND candidate_election.status NOT IN ('withdrawn','lost') AND COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sdcity_candidate_finance_links link WHERE link.candidate_id=candidate.id AND link.election_id=election.id AND link.link_status='active') ORDER BY (election.election_date < CURRENT_DATE) ASC, random() LIMIT $2::int`,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
    ],
  );
  const rows: SanDiegoCityFinanceAutoLinkCandidate[] = [];
  for (const row of result.rows) {
    // Exact eligibility in TS: the SQL predicate is district-level, this is
    // the office-level gate (incl. the parseable-district rule).
    if (
      !isSanDiegoCityFinanceEligibleElection({
        state: row.state,
        districtType: row.district_type,
        geoidCompact: row.geoid_compact,
        officeScope: row.office_scope,
        officeCanonicalName: row.office_name,
        officialBallotTitle: row.official_ballot_title,
      })
    )
      continue;
    const officeName = row.office_name.trim() as SanDiegoCityAppCandidate["officeName"];
    rows.push({
      candidateId: row.candidate_id,
      electionId: row.election_id,
      candidateName: row.candidate_name,
      electionYear: Number(row.election_date.slice(0, 4)),
      officeName,
      seatNumber:
        officeName === "Mayor"
          ? null
          : parseSanDiegoCityCouncilSeatNumber(row.official_ballot_title),
      stateFilingIds: Array.isArray(row.state_filing_ids)
        ? row.state_filing_ids.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    });
  }
  return rows;
}

export type SanDiegoCityFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "needs_review" | "no_committee" | "error";
  reason?: string;
};

// The resolver's one-committee-two-candidates check only protects the group
// it resolves, so resolution must always see the election's FULL roster —
// resolving just the unlinked slice would let a committee link to candidate B
// today when it already linked to candidate A yesterday (the selector never
// returns linked candidates, and maxCandidates can split even one run).
// Same status filter as the selector; the name COALESCE can be null for a
// defective roster row, excluded here for the same reason as in the selector.
async function listElectionRosterCandidates(
  db: Queryable,
  electionId: string,
): Promise<
  { candidateId: string; candidateName: string; stateFilingIds: string[] }[]
> {
  const result = await db.query<{
    candidate_id: string;
    candidate_name: string;
    state_filing_ids: unknown;
  }>(
    `SELECT candidate.id::text candidate_id,COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) candidate_name,candidate.state_filing_ids FROM public.candidate_elections candidate_election JOIN public.candidates candidate ON candidate.id=candidate_election.candidate_id WHERE candidate_election.election_id=$1::uuid AND candidate.deleted_at IS NULL AND candidate_election.status NOT IN ('withdrawn','lost') AND COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) IS NOT NULL ORDER BY candidate.id`,
    [electionId],
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    candidateName: row.candidate_name,
    stateFilingIds: Array.isArray(row.state_filing_ids)
      ? row.state_filing_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  }));
}

/**
 * Resolves and links every input candidate against the export's committees.
 * Matched candidates get an active efile_export link; ambiguity surfaces as
 * needs_review and no-match as no_committee — neither writes anything, so
 * the committee stays in the manual-review queue.
 */
export async function autoLinkMissingSanDiegoCityCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  candidates: readonly SanDiegoCityFinanceAutoLinkCandidate[];
  /** Concatenated cycle workbooks (2025+2026). */
  workbook: EfileCalWorkbook;
  committees?: readonly SanDiegoCityExportCommittee[];
}): Promise<SanDiegoCityFinanceAutoLinkResult[]> {
  // Committee identity can surface on ANY sheet — a committee whose only
  // activity is a 497 or an S496 still exists and still gates its
  // person-name siblings.
  const committees =
    input.committees ??
    collectSanDiegoCityExportCommittees([
      ...input.workbook.summary,
      ...input.workbook.scheduleA,
      ...input.workbook.scheduleC,
      ...input.workbook.scheduleB1,
      ...input.workbook.scheduleD,
      ...input.workbook.s496,
      ...input.workbook.s497,
    ]);
  const byElection = new Map<string, SanDiegoCityFinanceAutoLinkCandidate[]>();
  for (const candidate of input.candidates) {
    const group = byElection.get(candidate.electionId) ?? [];
    group.push(candidate);
    byElection.set(candidate.electionId, group);
  }
  const results: SanDiegoCityFinanceAutoLinkResult[] = [];
  for (const [electionId, group] of byElection) {
    // Resolve against the FULL election roster (see listElectionRosterCandidates)
    // so already-linked and beyond-the-limit candidates still participate in
    // the duplicate-committee check; links are only written for the input
    // slice. Office, seat, and year are election-level facts, shared by every
    // roster candidate.
    const first = group[0]!;
    const roster = await listElectionRosterCandidates(input.db, electionId);
    const rosterIds = new Set(roster.map((row) => row.candidateId));
    // Every selector condition on the candidate row (deleted_at, status,
    // name) is re-checked by the roster query, so under unchanged data every
    // input candidate is in the roster read. Absence means the row changed
    // between the two queries (withdrawn, deleted, merged) — never link from
    // the stale selector row; report it and let the next run's selector
    // decide fresh.
    for (const candidate of group) {
      if (rosterIds.has(candidate.candidateId)) continue;
      results.push({
        candidateId: candidate.candidateId,
        electionId,
        status: "error",
        reason:
          "candidate left the election roster between selection and resolution; skipped",
      });
    }
    const resolutionCandidates = roster.map((row) => ({
      candidateId: row.candidateId,
      displayName: row.candidateName,
      officeName: first.officeName,
      seatNumber: first.seatNumber,
      electionYear: first.electionYear,
      stateFilingIds: row.stateFilingIds,
    }));
    const inputCandidateIds = new Set(
      group.map((candidate) => candidate.candidateId),
    );
    const resolutions = resolveSanDiegoCityCandidateCommittees({
      candidates: resolutionCandidates,
      committees,
    });
    for (const resolution of resolutions) {
      const candidateId = resolution.candidate.candidateId;
      // Roster-only participants shape the duplicate check but get no link
      // write and no result row — they were not selected for linking.
      if (!inputCandidateIds.has(candidateId)) continue;
      if (resolution.status === "ambiguous") {
        results.push({
          candidateId,
          electionId,
          status: "needs_review",
          reason: resolution.reason,
        });
        continue;
      }
      if (resolution.status === "unmatched") {
        results.push({
          candidateId,
          electionId,
          status: "no_committee",
          reason: resolution.reason,
        });
        continue;
      }
      try {
        await upsertSanDiegoCityFinanceLink({
          db: input.db,
          link: {
            candidateId,
            electionId,
            electionYear: resolution.candidate.electionYear,
            candidateNameNormalized: normalizeSanDiegoCityTextKey(
              resolution.candidate.displayName,
            ),
            fppcId: resolution.filerId,
            committeeName: resolution.committeeName,
            linkStatus: "active",
            linkSource: "efile_export",
            sourceUrl: SAN_DIEGO_CITY_FINANCE_SOURCE_URL,
            lastVerifiedAt: input.now,
          },
        });
        results.push({ candidateId, electionId, status: "linked" });
      } catch (error) {
        results.push({
          candidateId,
          electionId,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return results;
}

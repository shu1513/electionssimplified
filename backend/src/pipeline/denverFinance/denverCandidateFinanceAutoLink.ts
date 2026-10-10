// Phase 2 auto-link: establishes candidate → controlled-committee links from
// SearchLight's cycle registration list via the Denver resolver, copy-adapted
// from sanDiegoCityCandidateFinanceAutoLink.
//
// listDenverCandidateElectionsMissingFinanceLinks selects work the SF way
// (roster candidates without an active link, inside the eligibility window).
// Resolution runs PER ELECTION against the FULL election roster — the
// resolver's one-registrant-two-candidates check must see candidates that are
// already linked or fell past maxCandidates, or a registrant could link to
// candidate B today after linking to candidate A yesterday.
//
// There is no per-election transaction: Denver link rows are independent and
// the writer itself protects manual links (matching automatic upserts reuse
// the operator's row and refresh its entity ids; conflicting or operator-
// disabled ones error into this module's per-candidate result instead of
// blocking the rest of the election).

import type { Pool, PoolClient } from "pg";
import {
  isDenverFinanceEligibleElection,
  parseDenverAtLargeSeatLetter,
  DENVER_CITY_GEOID,
  DENVER_FINANCE_ELIGIBLE_OFFICE_NAMES,
} from "./denverFinanceEligibleOffices.js";
import {
  normalizeDenverTextKey,
  resolveDenverCandidateCommittees,
  type DenverRegistrantRecord,
} from "./denverCandidateCommitteeResolver.js";
import {
  getDenverCandidatesByElectionCycle,
  getDenverCommitteeDetailsByFiler,
  getDenverElectionCyclesByFiler,
  getDenverFiler,
  type DenverSearchlightClientOptions,
} from "./denverSearchlightClient.js";
import { upsertDenverFinanceLink } from "./denverFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

/** The public dashboard (the Clerk & Recorder is the filing officer). The
 * Phase 3 sync reuses this as its source URL. */
export const DENVER_FINANCE_SOURCE_URL = "https://denver.maplight.com";

export type DenverFinanceAutoLinkCandidate = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  /** ISO election date ("2026-11-03") — auto-link binds it to the cycle. */
  electionDate: string;
  electionYear: number;
  officeName: string;
  /** At-large seat letter from the ballot title; null fails closed. */
  atLargeSeatLetter: string | null;
};

// The office-name narrowing lives in SQL so ineligible Denver place races
// (Mayor, Clerk & Recorder, district council seats…) cannot consume the
// LIMIT before the exact TS gate runs; the seat-letter rule stays in TS.
const DENVER_ELECTION_PREDICATE = `district.state='CO' AND district.district_type='place' AND district.geoid_compact='${DENVER_CITY_GEOID}' AND office.scope='place' AND office.canonical_name IN (${DENVER_FINANCE_ELIGIBLE_OFFICE_NAMES.map((name) => `'${name}'`).join(",")})`;

export async function listDenverCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  },
): Promise<DenverFinanceAutoLinkCandidate[]> {
  // The name COALESCE below can be NULL when every name column is blank — a
  // defective roster row. The resolver would have nothing to match, and one
  // bad row must not poison the whole auto-link leg, so such rows are
  // excluded in SQL (they cannot be name-matched anyway).
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
  }>(
    `SELECT candidate.id::text candidate_id,election.id::text election_id,COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) candidate_name,election.election_date::text election_date,district.state,district.district_type,district.geoid_compact,office.scope office_scope,office.canonical_name office_name,election.official_ballot_title FROM public.candidate_elections candidate_election JOIN public.candidates candidate ON candidate.id=candidate_election.candidate_id JOIN public.elections election ON election.id=candidate_election.election_id JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id WHERE candidate.deleted_at IS NULL AND ${DENVER_ELECTION_PREDICATE} AND election.race_type='office' AND election.election_date>=(($1::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int)) AND election.election_date<=(($1::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int)) AND candidate_election.status NOT IN ('withdrawn','lost') AND COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.denver_candidate_finance_links link WHERE link.candidate_id=candidate.id AND link.election_id=election.id AND link.link_status='active') ORDER BY (election.election_date < CURRENT_DATE) ASC, random() LIMIT $2::int`,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
    ],
  );
  const rows: DenverFinanceAutoLinkCandidate[] = [];
  for (const row of result.rows) {
    // Exact eligibility in TS: the SQL predicate is district-level, this is
    // the office-level gate (incl. the at-large seat-letter rule).
    if (
      !isDenverFinanceEligibleElection({
        state: row.state,
        districtType: row.district_type,
        geoidCompact: row.geoid_compact,
        officeScope: row.office_scope,
        officeCanonicalName: row.office_name,
        officialBallotTitle: row.official_ballot_title,
      })
    )
      continue;
    rows.push({
      candidateId: row.candidate_id,
      electionId: row.election_id,
      candidateName: row.candidate_name,
      electionDate: row.election_date.slice(0, 10),
      electionYear: Number(row.election_date.slice(0, 4)),
      officeName: row.office_name.trim(),
      atLargeSeatLetter: parseDenverAtLargeSeatLetter(row.official_ballot_title),
    });
  }
  return rows;
}

/**
 * Fetches the cycle's registration list plus each registrant's identity
 * records (filer, cycle list, committee details) — the resolver's complete
 * picture, prefetched once per run (cycle 36 has 12 registrants; three GETs
 * each). A registrant whose identity fetch fails is surfaced by the resolver
 * as blocked via the thrown error instead — callers should let a fetch error
 * abort the run: partial identity data must never silently narrow the
 * duplicate-name check.
 */
export async function loadDenverRegistrantRecords(
  electionCycleId: number,
  options: DenverSearchlightClientOptions = {},
): Promise<DenverRegistrantRecord[]> {
  const registrants = await getDenverCandidatesByElectionCycle(
    electionCycleId,
    options,
  );
  const records: DenverRegistrantRecord[] = [];
  for (const registrant of registrants) {
    records.push({
      registrant,
      filer: await getDenverFiler(registrant.filerId, options),
      cycles: await getDenverElectionCyclesByFiler(registrant.filerId, options),
      details: await getDenverCommitteeDetailsByFiler(
        registrant.filerId,
        electionCycleId,
        options,
      ),
    });
  }
  return records;
}

export type DenverFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "needs_review" | "no_committee" | "error";
  reason?: string;
};

// Same status filter as the selector; the name COALESCE can be null for a
// defective roster row, excluded here for the same reason as in the selector.
async function listElectionRosterCandidates(
  db: Queryable,
  electionId: string,
): Promise<{ candidateId: string; candidateName: string }[]> {
  const result = await db.query<{
    candidate_id: string;
    candidate_name: string;
  }>(
    `SELECT candidate.id::text candidate_id,COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) candidate_name FROM public.candidate_elections candidate_election JOIN public.candidates candidate ON candidate.id=candidate_election.candidate_id WHERE candidate_election.election_id=$1::uuid AND candidate.deleted_at IS NULL AND candidate_election.status NOT IN ('withdrawn','lost') AND COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) IS NOT NULL ORDER BY candidate.id`,
    [electionId],
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    candidateName: row.candidate_name,
  }));
}

/**
 * Resolves and links every input candidate against the cycle's registrant
 * records. Matched candidates get an active searchlight link (with the
 * filer's committee entity ids); ambiguity surfaces as needs_review and
 * no-match as no_committee — neither writes anything, so the candidate stays
 * in the manual-review queue.
 *
 * electionDate binds the SearchLight cycle to its election: eligibility is
 * structural (any Denver at-large council contest), so without the date a
 * repeat candidate on a future at-large election would resolve against this
 * cycle's registrants and inherit the wrong cycle's committee. Candidates on
 * a different date are skipped (no result row — they are another cycle's
 * work), and a registrant record whose committee details date the cycle
 * differently fails the whole run: that is a wrong cycle-id/date pairing,
 * not a per-candidate condition.
 */
export async function autoLinkMissingDenverCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  electionCycleId: number;
  /** ISO date of the cycle's election, e.g. DENVER_2026_VACANCY_ELECTION_DATE. */
  electionDate: string;
  candidates: readonly DenverFinanceAutoLinkCandidate[];
  registrants: readonly DenverRegistrantRecord[];
}): Promise<DenverFinanceAutoLinkResult[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.electionDate))
    throw new Error(
      `Denver auto-link election date must be an ISO date, got "${input.electionDate}"`,
    );
  for (const record of input.registrants) {
    // A registrant with no details record (204) carries no election date to
    // check; the resolver blocks it individually.
    const detailsDate = record.details?.electionDate;
    if (detailsDate && !detailsDate.startsWith(input.electionDate))
      throw new Error(
        `Denver cycle ${input.electionCycleId} registrant filer ${record.registrant.filerId} dates the election ${detailsDate}, not ${input.electionDate} — wrong cycle/date pairing`,
      );
  }
  const byElection = new Map<string, DenverFinanceAutoLinkCandidate[]>();
  for (const candidate of input.candidates) {
    if (candidate.electionDate !== input.electionDate) continue;
    const group = byElection.get(candidate.electionId) ?? [];
    group.push(candidate);
    byElection.set(candidate.electionId, group);
  }
  const results: DenverFinanceAutoLinkResult[] = [];
  for (const [electionId, group] of byElection) {
    // Resolve against the FULL election roster (see the header comment) so
    // already-linked and beyond-the-limit candidates still participate in the
    // one-registrant-two-candidates check; links are only written for the
    // input slice. Seat letter and year are election-level facts, shared by
    // every roster candidate.
    const first = group[0]!;
    const roster = await listElectionRosterCandidates(input.db, electionId);
    const rosterIds = new Set(roster.map((row) => row.candidateId));
    // Every selector condition on the candidate row (deleted_at, status,
    // name) is re-checked by the roster query, so under unchanged data every
    // input candidate is in the roster read. Absence means the row changed
    // between the two queries (withdrawn, deleted, merged) — never link from
    // the stale selector row; report it and let the next run's selector
    // decide fresh (the SJ/SD/Phoenix #697 rule).
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
      electionYear: first.electionYear,
      atLargeSeatLetter: first.atLargeSeatLetter,
    }));
    const inputCandidatesById = new Map(
      group.map((candidate) => [candidate.candidateId, candidate]),
    );
    const resolutions = resolveDenverCandidateCommittees({
      electionCycleId: input.electionCycleId,
      candidates: resolutionCandidates,
      registrants: input.registrants,
    });
    for (const resolution of resolutions) {
      const candidateId = resolution.candidate.candidateId;
      // Roster-only participants shape the duplicate check but get no link
      // write and no result row — they were not selected for linking.
      const inputCandidate = inputCandidatesById.get(candidateId);
      if (!inputCandidate) continue;
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
        await upsertDenverFinanceLink({
          db: input.db,
          link: {
            candidateId,
            electionId,
            electionYear: resolution.candidate.electionYear,
            candidateNameNormalized: normalizeDenverTextKey(
              resolution.candidate.displayName,
            ),
            officeName: inputCandidate.officeName,
            district: null,
            filerId: resolution.filerId,
            committeeEntityIds: resolution.committeeEntityIds,
            committeeName: resolution.committeeName,
            linkStatus: "active",
            linkSource: "searchlight",
            sourceUrl: DENVER_FINANCE_SOURCE_URL,
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

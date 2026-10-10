// Phase 2 auto-link: establishes candidate → filer links from Report Detail
// via the Austin resolver, copy-adapted from denverCandidateFinanceAutoLink.
//
// listAustinCandidateElectionsMissingFinanceLinks selects work the SF way
// (roster candidates without an active link) inside the v1 scope guard:
// the Austin place row + the election-date allowlist, both in SQL. There is
// no lookback/lookahead window — Report Detail is keyed by `election_date`,
// so the allowlist IS the selection window.
//
// Resolution runs PER ELECTION against the FULL election roster — the
// resolver's one-filer-two-candidates check must see candidates that are
// already linked or fell past maxCandidates, or a filer could link to
// candidate B today after linking to candidate A yesterday.
//
// There is no per-election transaction: link rows are independent and the
// writer itself protects manual links (a matching automatic upsert reuses
// the operator's row and refreshes its filer_name spelling; conflicting or
// operator-disabled ones error into this module's per-candidate result
// instead of blocking the rest of the election).

import type { Pool, PoolClient } from "pg";
import {
  collectAustinReportFilers,
  resolveAustinCandidateFilers,
  type AustinReportFiler,
} from "./austinCandidateFilerResolver.js";
import {
  AUSTIN_CITY_GEOID,
  AUSTIN_FINANCE_ELIGIBLE_OFFICE_NAMES,
  austinOfficeCodeDistrictLabel,
  austinOfficeCodeForElection,
  isAustinFinanceEligibleElection,
  isAustinFinanceSupportedElectionDate,
  type AustinOfficeCode,
} from "./austinFinanceEligibleOffices.js";
import { normalizeAustinFinanceTextKey } from "./austinFinanceKeys.js";
import { upsertAustinFinanceLink } from "./austinFinanceWriter.js";
import {
  AUSTIN_SOCRATA_DATASET_PAGE_BASE_URL,
  AUSTIN_SOCRATA_REPORT_DETAIL_DATASET,
  defaultAustinSocrataClientOptions,
  getAustinReportDetailRowsByElection,
  requireIsoDate,
  type AustinSocrataClientOptions,
} from "./austinSocrataClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;

/** The Report Detail dataset page — where the filer name was read from. */
export const AUSTIN_FINANCE_LINK_SOURCE_URL = `${AUSTIN_SOCRATA_DATASET_PAGE_BASE_URL}/${AUSTIN_SOCRATA_REPORT_DETAIL_DATASET}`;

export type AustinFinanceAutoLinkCandidate = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  /** ISO election date ("2026-11-03") — the Report Detail scope. */
  electionDate: string;
  electionYear: number;
  officeName: string;
  /** Office code from canonical office + ballot title; null fails closed. */
  officeCode: AustinOfficeCode | null;
};

// Place row + office-name narrowing in SQL so ineligible Austin place races
// cannot consume the LIMIT before the exact TS gate runs; the district-
// number rule stays in TS.
const AUSTIN_ELECTION_PREDICATE = `district.state='TX' AND district.district_type='place' AND district.geoid_compact='${AUSTIN_CITY_GEOID}' AND office.scope='place' AND office.canonical_name IN (${AUSTIN_FINANCE_ELIGIBLE_OFFICE_NAMES.map((name) => `'${name}'`).join(",")})`;

export async function listAustinCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    /** Allowlisted ISO election dates (AUSTIN_FINANCE_ELECTION_DATES). */
    electionDates: readonly string[];
    maxCandidates: number;
  },
): Promise<AustinFinanceAutoLinkCandidate[]> {
  const electionDates = input.electionDates.map((date) => {
    const iso = requireIsoDate(date, "election date");
    if (!isAustinFinanceSupportedElectionDate(iso))
      throw new Error(
        `Austin finance election date ${iso} is not in the v1 allowlist`,
      );
    return iso;
  });
  if (electionDates.length === 0) return [];
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
    `SELECT candidate.id::text candidate_id,election.id::text election_id,COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) candidate_name,election.election_date::text election_date,district.state,district.district_type,district.geoid_compact,office.scope office_scope,office.canonical_name office_name,election.official_ballot_title FROM public.candidate_elections candidate_election JOIN public.candidates candidate ON candidate.id=candidate_election.candidate_id JOIN public.elections election ON election.id=candidate_election.election_id JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id WHERE candidate.deleted_at IS NULL AND ${AUSTIN_ELECTION_PREDICATE} AND election.race_type='office' AND election.election_date=ANY($1::date[]) AND candidate_election.status NOT IN ('withdrawn','lost') AND COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.atx_candidate_finance_links link WHERE link.candidate_id=candidate.id AND link.election_id=election.id AND link.link_status='active') ORDER BY (election.election_date < CURRENT_DATE) ASC, random() LIMIT $2::int`,
    [electionDates, input.maxCandidates],
  );
  const rows: AustinFinanceAutoLinkCandidate[] = [];
  for (const row of result.rows) {
    // Exact eligibility in TS: the SQL predicate is district-level, this is
    // the office-level gate (incl. the district-number rule).
    if (
      !isAustinFinanceEligibleElection({
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
      officeCode: austinOfficeCodeForElection({
        officeCanonicalName: row.office_name,
        officialBallotTitle: row.official_ballot_title,
      }),
    });
  }
  return rows;
}

/**
 * Fetches every Report Detail row tagged with the election date and groups
 * the candidate-form rows into filers — the resolver's complete picture,
 * fetched once per run (53 rows for 2026-11-03 as of 2026-08-18). A fetch
 * error must abort the run: a partial filer list would silently narrow the
 * duplicate-filer check.
 */
export async function loadAustinReportFilers(
  electionDate: string,
  options: AustinSocrataClientOptions = defaultAustinSocrataClientOptions(),
): Promise<AustinReportFiler[]> {
  const rows = await getAustinReportDetailRowsByElection(
    { electionDate },
    options,
  );
  return collectAustinReportFilers(rows);
}

export type AustinFinanceAutoLinkResult = {
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
 * Resolves and links every input candidate against the election date's
 * filers. Matched candidates get an active austin_clerk link; ambiguity
 * surfaces as needs_review and no-match as no_committee — neither writes
 * anything, so the candidate stays in the manual-review queue.
 *
 * electionDate binds the filer list to its election: filers are read for
 * one Report Detail election date, so candidates on any other date are
 * skipped (no result row — they are another date's work), and a date
 * outside the allowlist is a caller bug, not a per-candidate condition.
 */
export async function autoLinkMissingAustinCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  /** ISO date the filers were loaded for, e.g. "2026-11-03". */
  electionDate: string;
  candidates: readonly AustinFinanceAutoLinkCandidate[];
  filers: readonly AustinReportFiler[];
}): Promise<AustinFinanceAutoLinkResult[]> {
  const electionDate = requireIsoDate(input.electionDate, "election date");
  if (!isAustinFinanceSupportedElectionDate(electionDate))
    throw new Error(
      `Austin finance election date ${electionDate} is not in the v1 allowlist`,
    );
  const byElection = new Map<string, AustinFinanceAutoLinkCandidate[]>();
  for (const candidate of input.candidates) {
    if (candidate.electionDate !== electionDate) continue;
    const group = byElection.get(candidate.electionId) ?? [];
    group.push(candidate);
    byElection.set(candidate.electionId, group);
  }
  const results: AustinFinanceAutoLinkResult[] = [];
  for (const [electionId, group] of byElection) {
    // Resolve against the FULL election roster (see the header comment) so
    // already-linked and beyond-the-limit candidates still participate in the
    // one-filer-two-candidates check; links are only written for the input
    // slice. Office code and year are election-level facts, shared by every
    // roster candidate.
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
    const inputCandidatesById = new Map(
      group.map((candidate) => [candidate.candidateId, candidate]),
    );
    const resolutions = resolveAustinCandidateFilers({
      candidates: roster.map((row) => ({
        candidateId: row.candidateId,
        displayName: row.candidateName,
        officeCode: first.officeCode,
      })),
      filers: input.filers,
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
        await upsertAustinFinanceLink({
          db: input.db,
          link: {
            candidateId,
            electionId,
            electionYear: inputCandidate.electionYear,
            candidateNameNormalized: normalizeAustinFinanceTextKey(
              resolution.candidate.displayName,
            ),
            officeName: inputCandidate.officeName,
            // Non-null past the resolver: a null office code is unmatched.
            district: austinOfficeCodeDistrictLabel(inputCandidate.officeCode!),
            filerName: resolution.filerName,
            linkStatus: "active",
            linkSource: "austin_clerk",
            sourceUrl: AUSTIN_FINANCE_LINK_SOURCE_URL,
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

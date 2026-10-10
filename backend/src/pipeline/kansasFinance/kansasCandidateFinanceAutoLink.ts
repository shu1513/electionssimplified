// Kansas finance auto-link: creates missing candidate -> viewer-filer links
// (links only, never summaries). Montana/Alabama shape: list candidate
// elections in eligible offices with no active link, enumerate each office's
// filers ONCE per run from the SOS CFR viewer, resolve locally, and write only
// full-name + office + district matches with linkSource "cfr_viewer". The
// writer's manual-link protection guarantees operator links always win;
// ambiguity, blank-district filings, and misses are reported, never linked.
//
// Enumeration facts pinned live 2026-09-01: the Candidate search requires a
// filing type (blank -> "Filing Type Required" re-render), and each type
// answers in its own grid: "Receipts and Expenditures Report" ->
// grdviewCfrResults, "Appointment of Treasurer" -> grdviewApptOfTreas,
// "Affidavit of Exemption Candidate" -> grdviewAffidavitResults. All three
// render the filed name as one "LAST FIRST [MIDDLE]" string.

import type { Pool, PoolClient } from "pg";

import { buildKansasCfrUrl, KANSAS_CFR_VIEWER_PAGES, type KansasCfrSessionOptions } from "./kansasCfrViewerClient.js";
import { resolveKansasCandidateFiler, type KansasFilerMatch, type KansasFilerRow } from "./kansasCandidateFilerResolver.js";
import {
  KANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS,
  kansasCfrCycleStart,
  kansasCfrFiledDateWindow,
  kansasCfrOfficeForRace,
  type KansasCfrOffice,
} from "./kansasFinanceEligibleOffices.js";
import { buildKansasFilerKey, normalizeKansasNameForStorage, upsertKansasFinanceLink } from "./kansasFinanceWriter.js";
import { KANSAS_CFR_FILER_SEARCHES, kansasGridOfficeMatches, searchKansasFilings } from "./kansasFilingSearch.js";

export { KANSAS_CFR_FILER_SEARCHES } from "./kansasFilingSearch.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export const KANSAS_CFR_LINK_SOURCE_URL = buildKansasCfrUrl(KANSAS_CFR_VIEWER_PAGES.entry);

export type KansasFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  /** Legislative district number from the district geoid; null for statewide. */
  legislativeDistrict: string | null;
};

export type KansasFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "ambiguous" | "manual_confirm_required" | "unmatched" | "error";
  reason?: string;
  committeeId?: string;
  committeeName?: string;
  filedNames?: string[];
  confidence?: KansasFilerMatch["confidence"];
  error?: string;
};

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district_name: string | null;
  legislative_district: string | null;
};

export async function listKansasCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<KansasFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<CandidateElectionQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        office.canonical_name AS office_name,
        district.name AS district_name,
        CASE
          WHEN district.district_type IN ('state_upper', 'state_lower') THEN
            NULLIF(
              regexp_replace(
                substring(district.geoid_compact from char_length(district.state_fips) + 1),
                '^0+',
                ''
              ),
              ''
            )
          ELSE NULL
        END AS legislative_district
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.offices AS office
        ON office.id = election.office_id
      WHERE candidate.deleted_at IS NULL
        AND district.state = 'KS'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.ks_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
      LIMIT $2::int
    `,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...KANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district_name,
    legislativeDistrict: row.legislative_district,
  }));
}

export type KansasFilerSearch = (input: {
  office: KansasCfrOffice;
  filingType: string;
  gridId: string;
  startDate: string;
  endDate: string;
  sessionOptions?: KansasCfrSessionOptions;
}) => Promise<{ name: string; district: string; officeSought: string; fileDate: string }[]>;

/** The shared search (kansasFilingSearch.ts) reduced to the resolver's row fields. */
export const searchKansasFilerRows: KansasFilerSearch = async (input) =>
  (await searchKansasFilings(input)).map(({ row }) => ({
    name: row.name,
    district: row.district,
    officeSought: row.officeSought,
    fileDate: row.fileDate,
  }));

export type KansasFilerPoolLoader = (office: KansasCfrOffice, electionYear: number) => Promise<KansasFilerRow[]>;

/**
 * Per-run cache: one enumeration (three filing-type searches) per office +
 * election year. Rows whose office text disagrees with the searched office
 * are dropped (fail closed against a search that ignored its office filter)
 * and counted in the returned diagnostics via `onSkippedRows`.
 */
export function createKansasFilerPoolLoader(input: {
  now: Date;
  sessionOptions?: KansasCfrSessionOptions;
  search?: KansasFilerSearch;
  onSkippedRows?: (office: KansasCfrOffice, skipped: number) => void;
}): KansasFilerPoolLoader {
  const search = input.search ?? searchKansasFilerRows;
  const pools = new Map<string, Promise<KansasFilerRow[]>>();
  return (office, electionYear) => {
    const key = `${office.code}|${electionYear}`;
    let pool = pools.get(key);
    if (pool === undefined) {
      pool = (async () => {
        const window = kansasCfrFiledDateWindow({ office, electionYear, now: input.now });
        const rows: KansasFilerRow[] = [];
        let skipped = 0;
        // Sequential on purpose: one request in flight per viewer session.
        for (const filerSearch of KANSAS_CFR_FILER_SEARCHES) {
          const found = await search({
            office,
            filingType: filerSearch.filingType,
            gridId: filerSearch.gridId,
            startDate: window.startDate,
            endDate: window.endDate,
            sessionOptions: input.sessionOptions,
          });
          for (const row of found) {
            if (!kansasGridOfficeMatches(office, row.officeSought)) {
              skipped += 1;
              continue;
            }
            rows.push({
              filedName: row.name,
              district: row.district,
              officeSought: row.officeSought,
              filingKind: filerSearch.filingKind,
              fileDate: row.fileDate,
            });
          }
        }
        if (skipped > 0) input.onSkippedRows?.(office, skipped);
        return rows;
      })();
      pools.set(key, pool);
    }
    return pool;
  };
}

function parseLegislativeDistrict(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*(\d+)\s*$/.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return parsed > 0 ? parsed : null;
}

export async function autoLinkKansasCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: KansasFinanceAutoLinkCandidateElection;
  now: Date;
  loadFilerPool: KansasFilerPoolLoader;
  /** Resolve and report without writing links. */
  dryRun?: boolean;
}): Promise<KansasFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const base = { candidateId: candidate.candidateId, electionId: candidate.electionId };
  const office = kansasCfrOfficeForRace({ officeScope: candidate.officeScope, officeCanonicalName: candidate.officeName });
  if (office === null) {
    return { ...base, status: "unmatched", reason: "office_unmapped" };
  }
  let districtNumber: number | null = null;
  if (office.districted) {
    districtNumber = parseLegislativeDistrict(candidate.legislativeDistrict);
    if (districtNumber === null) {
      return { ...base, status: "unmatched", reason: "district_unparseable" };
    }
  }

  // A race whose cycle window has not opened (a 2028 House race inside the
  // 730-day lookahead during late 2026) has nothing to enumerate yet; report
  // it instead of running an inverted-date search.
  if (input.now < kansasCfrCycleStart(office, candidate.electionYear)) {
    return { ...base, status: "unmatched", reason: "cycle_not_started" };
  }

  const rows = await input.loadFilerPool(office, candidate.electionYear);
  const resolution = resolveKansasCandidateFiler({ candidateName: candidate.candidateName, districtNumber, rows });
  if (resolution.status === "unmatched") {
    return { ...base, status: "unmatched", reason: resolution.reason };
  }
  if (resolution.status === "ambiguous" || resolution.status === "manual_confirm_required") {
    return { ...base, status: resolution.status, reason: resolution.reason, filedNames: resolution.filedNames };
  }

  const committeeId = buildKansasFilerKey({
    officeCode: office.code,
    districtNumber,
    surname: resolution.match.surname,
    firstName: resolution.match.firstName,
  });
  if (!input.dryRun) {
    await upsertKansasFinanceLink({
      db: input.db,
      link: {
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        electionYear: candidate.electionYear,
        candidateNameNormalized: normalizeKansasNameForStorage(candidate.candidateName),
        officeName: candidate.officeName,
        district: districtNumber === null ? null : String(districtNumber),
        committeeId,
        committeeName: resolution.match.committeeName,
        linkStatus: "active",
        linkSource: "cfr_viewer",
        sourceUrl: KANSAS_CFR_LINK_SOURCE_URL,
        lastVerifiedAt: input.now,
      },
    });
  }
  return {
    ...base,
    status: "linked",
    committeeId,
    committeeName: resolution.match.committeeName,
    filedNames: resolution.match.filedNames,
    confidence: resolution.match.confidence,
  };
}

export async function autoLinkMissingKansasCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  dryRun?: boolean;
  candidateElections?: readonly KansasFinanceAutoLinkCandidateElection[];
  loadFilerPool?: KansasFilerPoolLoader;
  sessionOptions?: KansasCfrSessionOptions;
}): Promise<KansasFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listKansasCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  const loadFilerPool =
    input.loadFilerPool ??
    createKansasFilerPoolLoader({
      now: input.now,
      sessionOptions: input.sessionOptions,
      onSkippedRows: (office, skipped) =>
        console.warn(`Kansas finance auto-link: ${skipped} ${office.label} rows carried another office and were skipped`),
    });
  const results: KansasFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      results.push(
        await autoLinkKansasCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection: candidate,
          now: input.now,
          loadFilerPool,
          dryRun: input.dryRun,
        })
      );
    } catch (error) {
      results.push({
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        status: "error",
        reason: "auto_link_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

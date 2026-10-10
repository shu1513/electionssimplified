// Phase 3 auto-link: establishes candidate → controlled-committee links and
// outside-spending relation rows from the SFEC dashboard manifest.
//
// listSanFranciscoCandidateElectionsMissingFinanceLinks selects work the LA
// way (candidates without an active link, inside the eligibility window).
// The auto-link then refreshes each affected election WHOLESALE: it re-reads
// the election's full candidate list so manifest names and outside-spending
// targets resolve against everyone in the contest, not only the unlinked
// slice — link upserts are idempotent for already-linked candidates, and a
// candidate whose manifest relations vanished gets their relation rows
// cleared rather than left stale.
//
// Ordering rule: every remote read (manifest fetch, filer-registry
// cross-checks) happens BEFORE the election's database writes, and the
// writes apply in one transaction per election — a mid-refresh failure rolls
// the election back instead of leaving deactivated links or deleted
// relation rows behind.

import type { Pool, PoolClient } from "pg";
import {
  getSanFranciscoContestManifest,
  type SanFranciscoContestManifest,
  type SanFranciscoDashboardManifestClientOptions,
} from "./sanFranciscoDashboardManifestClient.js";
import {
  getSanFranciscoFilers,
  type SanFranciscoOpenDataClientOptions,
} from "./sanFranciscoOpenDataClient.js";
import {
  isSanFranciscoFinanceEligibleElection,
  parseSanFranciscoSupervisorDistrictNumber,
  toSanFranciscoContestCode,
} from "./sanFranciscoFinanceEligibleOffices.js";
import {
  normalizeSanFranciscoCandidateNameForStorage,
  resolveSanFranciscoContestCandidates,
  sanFranciscoCandidateNameMatches,
  sanFranciscoSyntheticSpenderId,
  type SanFranciscoAppCandidate,
} from "./sanFranciscoCandidateCommitteeResolver.js";
import {
  flagSanFranciscoFinanceLinksMissingFromManifest,
  replaceSanFranciscoOutsideCommitteeLinks,
  upsertSanFranciscoFinanceLink,
  type SanFranciscoFinanceLinkInput,
  type SanFranciscoOutsideCommitteeLinkInput,
} from "./sanFranciscoFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

export type SanFranciscoFinanceAutoLinkCandidate = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionDate: string;
  electionYear: number;
  contestCode: string;
};

const SF_ELECTION_PREDICATE = `district.state='CA' AND ((district.district_type='county' AND district.geoid_compact='06075' AND office.scope='county') OR (district.district_type='place' AND district.geoid_compact='0667000' AND office.scope='place') OR (district.district_type='school_unified' AND district.geoid_compact='0634410' AND office.scope='school_unified'))`;

export async function listSanFranciscoCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  },
): Promise<SanFranciscoFinanceAutoLinkCandidate[]> {
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
    `SELECT candidate.id::text candidate_id,election.id::text election_id,COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) candidate_name,election.election_date::text election_date,district.state,district.district_type,district.geoid_compact,office.scope office_scope,office.canonical_name office_name,election.official_ballot_title FROM public.candidate_elections candidate_election JOIN public.candidates candidate ON candidate.id=candidate_election.candidate_id JOIN public.elections election ON election.id=candidate_election.election_id JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id WHERE candidate.deleted_at IS NULL AND ${SF_ELECTION_PREDICATE} AND election.race_type='office' AND election.election_date>=($1::date-make_interval(days=>$3::int)) AND election.election_date<=($1::date+make_interval(days=>$4::int)) AND candidate_election.status NOT IN ('withdrawn','lost') AND NOT EXISTS (SELECT 1 FROM public.sfc_candidate_finance_links link WHERE link.candidate_id=candidate.id AND link.election_id=election.id AND link.link_status='active') ORDER BY (election.election_date < CURRENT_DATE) ASC, random() LIMIT $2::int`,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
    ],
  );
  const rows: SanFranciscoFinanceAutoLinkCandidate[] = [];
  for (const row of result.rows) {
    // Exact eligibility in TS: the SQL predicate is district-level, this is
    // the Phase 2 office-level gate (contest code doubles as the locator).
    if (
      !isSanFranciscoFinanceEligibleElection({
        state: row.state,
        districtType: row.district_type,
        geoidCompact: row.geoid_compact,
        officeScope: row.office_scope,
        officeCanonicalName: row.office_name,
        officialBallotTitle: row.official_ballot_title,
      })
    )
      continue;
    const contestCode = toSanFranciscoContestCode({
      officeScope: row.office_scope,
      officeCanonicalName: row.office_name,
      supervisorDistrictNumber: parseSanFranciscoSupervisorDistrictNumber(
        row.official_ballot_title,
      ),
    });
    if (!contestCode) continue;
    const electionDate = row.election_date.slice(0, 10);
    rows.push({
      candidateId: row.candidate_id,
      electionId: row.election_id,
      candidateName: row.candidate_name,
      electionDate,
      electionYear: Number(electionDate.slice(0, 4)),
      contestCode,
    });
  }
  return rows;
}

export type SanFranciscoFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "needs_review" | "no_committee" | "error";
  reason?: string;
};

export type SanFranciscoFinanceAutoLinkDiagnostics = {
  /** Manifest committees that matched no ballot candidate (expected: SFEC lists committee-formers). */
  unmatchedManifestCandidates: Array<{
    contestCode: string;
    candidateName: string;
    fppcId: string;
    reason: string;
  }>;
  /** Outside-spending money whose target could not be resolved to a ballot candidate. */
  unresolvedOutsideTargets: Array<{
    contestCode: string;
    candidateName: string;
    spenderName: string;
  }>;
  /** Active automatic links flagged because their committee left the manifest. */
  flaggedLinkIds: string[];
  /** Non-fatal per-election failures (e.g. disappearance flagging). */
  electionErrors: Array<{ electionId: string; contestCode: string; message: string }>;
};

async function listElectionAppCandidates(
  db: Queryable,
  electionId: string,
): Promise<SanFranciscoAppCandidate[]> {
  const result = await db.query<{
    candidate_id: string;
    candidate_name: string;
    state_filing_ids: unknown;
  }>(
    `SELECT candidate.id::text candidate_id,COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) candidate_name,candidate.state_filing_ids FROM public.candidate_elections candidate_election JOIN public.candidates candidate ON candidate.id=candidate_election.candidate_id WHERE candidate_election.election_id=$1::uuid AND candidate.deleted_at IS NULL AND candidate_election.status NOT IN ('withdrawn','lost') ORDER BY candidate.id`,
    [electionId],
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    displayName: row.candidate_name,
    stateFilingIds: Array.isArray(row.state_filing_ids)
      ? row.state_filing_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  }));
}

// Manual rows of ANY status, not only active: an operator-disabled
// (inactive/needs_review) manual link must veto a same-committee plan —
// otherwise the planned upsert would either resurrect it (pre-writer-guard)
// or throw inside the transaction and roll back the whole election.
async function listElectionManualLinks(
  db: Queryable,
  electionId: string,
): Promise<Map<string, Array<{ fppcId: string; linkStatus: string }>>> {
  const result = await db.query<{
    candidate_id: string;
    fppc_id: string;
    link_status: string;
  }>(
    `SELECT candidate_id::text,fppc_id,link_status FROM public.sfc_candidate_finance_links WHERE election_id=$1::uuid AND link_source='manual'`,
    [electionId],
  );
  const links = new Map<string, Array<{ fppcId: string; linkStatus: string }>>();
  for (const row of result.rows) {
    const rows = links.get(row.candidate_id) ?? [];
    rows.push({ fppcId: row.fppc_id, linkStatus: row.link_status });
    links.set(row.candidate_id, rows);
  }
  return links;
}

// The manifest is the identity source; the filer registry is the cross-check
// that the committee really is candidate-controlled. A registry row that is
// missing (nightly lag) or typed as anything else fails closed to
// needs_review — Phase 4+ syncs only follow active links.
async function crossCheckFilerType(
  fppcId: string,
  openDataClientOptions: SanFranciscoOpenDataClientOptions | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const filers = await getSanFranciscoFilers({ fppcId }, openDataClientOptions);
  if (filers.length === 0)
    return {
      ok: false,
      reason: `FPPC id ${fppcId} not found in the SF filer registry`,
    };
  if (filers.some((filer) => filer.filerType === "Candidate or Officeholder"))
    return { ok: true };
  return {
    ok: false,
    reason: `FPPC id ${fppcId} is registered as "${filers[0]!.filerType}", not a candidate-controlled committee`,
  };
}

export async function autoLinkMissingSanFranciscoCandidateFinanceLinks(input: {
  db: PoolLike;
  now: Date;
  candidates: readonly SanFranciscoFinanceAutoLinkCandidate[];
  manifestClientOptions?: SanFranciscoDashboardManifestClientOptions;
  openDataClientOptions?: SanFranciscoOpenDataClientOptions;
}): Promise<{
  results: SanFranciscoFinanceAutoLinkResult[];
  diagnostics: SanFranciscoFinanceAutoLinkDiagnostics;
}> {
  const results: SanFranciscoFinanceAutoLinkResult[] = [];
  const diagnostics: SanFranciscoFinanceAutoLinkDiagnostics = {
    unmatchedManifestCandidates: [],
    unresolvedOutsideTargets: [],
    flaggedLinkIds: [],
    electionErrors: [],
  };
  // One manifest fetch and one wholesale refresh per election.
  const elections = new Map<string, SanFranciscoFinanceAutoLinkCandidate>();
  for (const candidate of input.candidates)
    if (!elections.has(candidate.electionId))
      elections.set(candidate.electionId, candidate);

  for (const [electionId, election] of elections) {
    const inputCandidateIds = new Set(
      input.candidates
        .filter((candidate) => candidate.electionId === electionId)
        .map((candidate) => candidate.candidateId),
    );
    const reportError = (reason: string): void => {
      for (const candidateId of inputCandidateIds)
        results.push({ candidateId, electionId, status: "error", reason });
    };

    // --- Remote reads and planning: no database writes yet. ---
    let manifest: SanFranciscoContestManifest;
    try {
      manifest = await getSanFranciscoContestManifest(
        {
          electionDate: election.electionDate,
          contestCode: election.contestCode,
        },
        input.manifestClientOptions,
      );
    } catch (error) {
      reportError(
        `Manifest fetch failed for ${election.contestCode}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    let appCandidates: SanFranciscoAppCandidate[];
    let manualLinksByCandidateId: Map<
      string,
      Array<{ fppcId: string; linkStatus: string }>
    >;
    try {
      appCandidates = await listElectionAppCandidates(input.db, electionId);
      manualLinksByCandidateId = await listElectionManualLinks(
        input.db,
        electionId,
      );
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
      continue;
    }
    const resolutions = resolveSanFranciscoContestCandidates({
      manifestCandidates: manifest.candidates,
      appCandidates,
    });
    const candidateIdByFppcId = new Map<string, string>();
    const statusByCandidateId = new Map<
      string,
      { status: "linked" | "needs_review" | "error"; reason?: string }
    >();
    const linkPlans: SanFranciscoFinanceLinkInput[] = [];
    for (const resolution of resolutions) {
      if (resolution.status !== "matched") {
        diagnostics.unmatchedManifestCandidates.push({
          contestCode: election.contestCode,
          candidateName: resolution.manifestCandidate.candidateName,
          fppcId: resolution.manifestCandidate.fppcId,
          reason: resolution.reason,
        });
        continue;
      }
      const manifestCandidate = resolution.manifestCandidate;
      candidateIdByFppcId.set(manifestCandidate.fppcId, resolution.candidateId);
      // Manual links are decided before the transaction so a conflict skips
      // this candidate's plan instead of aborting the whole election. Same
      // decision table as the writer guard: a same-committee manual row is
      // reused when active and vetoes when operator-disabled; a manual row
      // with a different committee blocks only while active.
      const manualRows =
        manualLinksByCandidateId.get(resolution.candidateId) ?? [];
      const sameFppc = manualRows.find(
        (row) => row.fppcId === manifestCandidate.fppcId,
      );
      const activeManual = manualRows.find(
        (row) => row.linkStatus === "active",
      );
      if (sameFppc) {
        if (sameFppc.linkStatus === "active")
          statusByCandidateId.set(resolution.candidateId, { status: "linked" });
        else
          statusByCandidateId.set(resolution.candidateId, {
            status: "error",
            reason: `Manifest committee ${manifestCandidate.fppcId} matches an operator-disabled manual link`,
          });
        continue;
      }
      if (activeManual) {
        statusByCandidateId.set(resolution.candidateId, {
          status: "error",
          reason: `Manifest committee ${manifestCandidate.fppcId} conflicts with protected manual link ${activeManual.fppcId}`,
        });
        continue;
      }
      try {
        const crossCheck = await crossCheckFilerType(
          manifestCandidate.fppcId,
          input.openDataClientOptions,
        );
        linkPlans.push({
          candidateId: resolution.candidateId,
          electionId,
          electionYear: election.electionYear,
          candidateNameNormalized: normalizeSanFranciscoCandidateNameForStorage(
            manifestCandidate.candidateName,
          ),
          contestCode: election.contestCode,
          fppcId: manifestCandidate.fppcId,
          filerNid: manifestCandidate.filerNid,
          committeeName: manifestCandidate.committeeName,
          linkStatus: crossCheck.ok ? "active" : "needs_review",
          linkSource: "sfec_dashboard",
          sourceUrl: manifest.sourceUrl,
          lastVerifiedAt: input.now,
        });
        statusByCandidateId.set(
          resolution.candidateId,
          crossCheck.ok
            ? { status: "linked" }
            : { status: "needs_review", reason: crossCheck.reason },
        );
      } catch (error) {
        statusByCandidateId.set(resolution.candidateId, {
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Outside relations: resolve each manifest relation's target — by the
    // target committee's FPPC id first, then by name — and replace every
    // ballot candidate's relation set (empty sets clear stale rows).
    const relationsByCandidateId = new Map<
      string,
      SanFranciscoOutsideCommitteeLinkInput[]
    >();
    for (const appCandidate of appCandidates)
      relationsByCandidateId.set(appCandidate.candidateId, []);
    for (const relation of manifest.outsideRelations) {
      let targetCandidateId: string | null = null;
      let targetAmbiguous = false;
      if (relation.candidateFppcId) {
        targetCandidateId =
          candidateIdByFppcId.get(relation.candidateFppcId) ?? null;
        if (!targetCandidateId) {
          const idMatches = appCandidates.filter((candidate) =>
            candidate.stateFilingIds.includes(relation.candidateFppcId!),
          );
          // Same fail-closed rule as the committee resolver: an id shared by
          // two candidates is a data error, never a coin flip.
          if (idMatches.length === 1)
            targetCandidateId = idMatches[0]!.candidateId;
          else if (idMatches.length > 1) targetAmbiguous = true;
        }
      }
      if (!targetCandidateId && !targetAmbiguous) {
        const nameMatches = appCandidates.filter((candidate) =>
          sanFranciscoCandidateNameMatches(
            candidate.displayName,
            relation.candidateName,
          ),
        );
        targetCandidateId =
          nameMatches.length === 1 ? nameMatches[0]!.candidateId : null;
      }
      if (!targetCandidateId) {
        diagnostics.unresolvedOutsideTargets.push({
          contestCode: election.contestCode,
          candidateName: relation.candidateName,
          spenderName: relation.spenderName,
        });
        continue;
      }
      relationsByCandidateId.get(targetCandidateId)?.push({
        spenderFppcId:
          relation.spenderFppcId ??
          sanFranciscoSyntheticSpenderId(relation.spenderName),
        spenderName: relation.spenderName,
        supportOppose: relation.position,
        sourceUrl: manifest.sourceUrl,
      });
    }

    // --- Transactional apply: links, relations, disappearance flags. ---
    const client = await input.db.connect();
    let flaggedLinkIds: string[] = [];
    try {
      await client.query("BEGIN");
      for (const plan of linkPlans)
        await upsertSanFranciscoFinanceLink({ db: client, link: plan });
      for (const [candidateId, relations] of relationsByCandidateId)
        await replaceSanFranciscoOutsideCommitteeLinks({
          db: client,
          candidateId,
          electionId,
          electionYear: election.electionYear,
          relations,
          lastVerifiedAt: input.now,
        });
      flaggedLinkIds = await flagSanFranciscoFinanceLinksMissingFromManifest({
        db: client,
        electionId,
        presentFppcIds: manifest.candidates.map(
          (candidate) => candidate.fppcId,
        ),
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.electionErrors.push({
        electionId,
        contestCode: election.contestCode,
        message: `Election refresh rolled back: ${message}`,
      });
      reportError(`Election refresh rolled back: ${message}`);
      continue;
    } finally {
      client.release();
    }
    diagnostics.flaggedLinkIds.push(...flaggedLinkIds);
    for (const candidateId of inputCandidateIds) {
      const status = statusByCandidateId.get(candidateId);
      results.push(
        status
          ? { candidateId, electionId, ...status }
          : {
              candidateId,
              electionId,
              status: "no_committee",
              reason:
                "No manifest committee resolves to this candidate (no SF Ethics committee with activity yet)",
            },
      );
    }
  }
  return { results, diagnostics };
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMaineCfisRawDataRefreshEnabled } from "../../config/featureFlags.js";
import type {
  MaineCandidateFinanceBatchSyncInput,
  MaineCandidateFinanceBatchSyncItemResult,
  MaineCandidateFinanceBatchSyncResult,
} from "./maineCandidateFinanceBatchSync.js";
import { DEFAULT_MAINE_CFIS_CACHE_DIR } from "./maineCfisArtifactCache.js";
import { captureMaineMapLightDatasets } from "./maineMapLightDatasetClient.js";
import { MAINE_MAPLIGHT_DATASET_GUIDE_MD_URL } from "./maineMapLightDatasetCatalog.js";
import {
  parseMaineMapLightAllFilerCsv,
  type MaineMapLightAllFilerTransaction,
} from "./maineMapLightAllFilerCsv.js";
import { parseMaineMapLightIndependentExpenditureCsv } from "./maineMapLightIndependentExpenditureCsv.js";
import { produceMaineMapLightFinancialFacts } from "./maineMapLightFinancialFacts.js";
import {
  captureMaineMapLightReport,
  validateMaineMapLightReportUrl,
} from "./maineMapLightReportClient.js";
import {
  acquireMaineMapLightBallot,
  qualifyMaineMapLightBallotContext,
} from "./maineMapLightBallotContext.js";
import { replaceMaineCandidateFinanceSnapshot } from "./maineFinanceWriter.js";

type Due = {
  id: string;
  candidate_id: string;
  election_id: string;
  election_year: number;
  candidate_name_normalized: string;
  office_name: string;
  district: string | null;
  committee_id: string;
  committee_name: string;
  link_source: "manual" | "cfis_bulk";
  source_url: string | null;
  last_verified_at: Date | null;
  first_name: string;
  last_name: string;
  display_name: string;
  party: string | null;
  office_scope: string;
  canonical_office_name: string;
  election_date: string;
  total_due: string;
};
const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
const positive = (value: number | undefined, fallback: number) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error("Invalid Maine MapLight batch limit");
  return n;
};

/** Whole-snapshot uniqueness establishes a source candidate context, never a numeric/f_ID crosswalk. */
export function resolveMaineMapLightCandidateSource(input: {
  rows: readonly MaineMapLightAllFilerTransaction[];
  firstName: string;
  lastName: string;
  officeScope: string;
  district: string | null;
}): MaineMapLightAllFilerTransaction | undefined {
  const sourceOffice =
    input.officeScope === "state_upper"
      ? "Senator"
      : input.officeScope === "state_lower"
        ? "Representative"
        : undefined;
  if (!sourceOffice || !input.district) return undefined;
  const matching = input.rows.filter(
    (row) =>
      normalize(row.filerFirstName) === normalize(input.firstName) &&
      normalize(row.filerLastName) === normalize(input.lastName) &&
      row.filerOffice === sourceOffice &&
      row.filerDistrict === input.district,
  );
  const ids = new Set(matching.map((row) => row.filerId));
  if (ids.size !== 1) return undefined;
  const exemplar = matching[0];
  if (!exemplar) return undefined;
  const own = input.rows.filter((row) => row.filerId === exemplar.filerId);
  if (
    !own.every(
      (row) =>
        row.filerName === exemplar.filerName &&
        row.filerFirstName === exemplar.filerFirstName &&
        row.filerLastName === exemplar.filerLastName &&
        row.filerOffice === exemplar.filerOffice &&
        row.filerDistrict === exemplar.filerDistrict,
    )
  )
    return undefined;
  return exemplar;
}

// Structured local names retain a known middle token; uncertain display-name shapes are refused.
function localMiddle(row: Due): { middleName?: string } | undefined {
  const name = normalize(row.display_name);
  const first = normalize(row.first_name);
  const last = normalize(row.last_name);
  if (name === `${first} ${last}`) return {};
  if (!name.startsWith(`${first} `) || !name.endsWith(` ${last}`))
    return undefined;
  return { middleName: name.slice(first.length + 1, -(last.length + 1)) };
}

export async function syncDueMaineMapLightFinance(
  supplied: MaineCandidateFinanceBatchSyncInput,
): Promise<MaineCandidateFinanceBatchSyncResult> {
  const input = {
    ...supplied,
    mapLightReportUrls: supplied.mapLightReportUrls
      ? [...supplied.mapLightReportUrls]
      : undefined,
  };
  const now = new Date(supplied.now?.getTime() ?? Date.now());
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid Maine MapLight batch timestamp");
  const maxCandidates = positive(input.maxCandidates, 25);
  const staleAfterDays = positive(input.staleAfterDays, 7);
  const lookback = positive(input.electionLookbackDays, 1);
  const lookahead = positive(input.electionLookaheadDays, 730);
  if (
    input.candidateId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.candidateId,
    )
  )
    throw new Error("Invalid Maine MapLight candidate ID");
  if (
    input.electionYear !== undefined &&
    (!Number.isSafeInteger(input.electionYear) ||
      input.electionYear < 2000 ||
      input.electionYear > 2100)
  )
    throw new Error("Invalid Maine MapLight election year");
  const allowNetwork = isMaineCfisRawDataRefreshEnabled();
  if (input.refresh && !allowNetwork)
    throw new Error(
      "Maine refresh requires MAINE_CFIS_RAW_DATA_REFRESH_ENABLED inline",
    );
  const cacheDir =
    input.rawDataCacheDir ??
    (process.env.MAINE_CFIS_RAW_DATA_CACHE_DIR?.trim() ||
      DEFAULT_MAINE_CFIS_CACHE_DIR);
  const reportUrls = [
    ...new Set(
      (
        input.mapLightReportUrls ??
        process.env.MAINE_MAPLIGHT_RETURN_REPORT_URLS?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) ??
        []
      ).map(validateMaineMapLightReportUrl),
    ),
  ];
  // Candidate/year and every canonical eligibility predicate precede LIMIT.
  const due = await input.db.query<Due>(
    `
    SELECT link.id, link.candidate_id, link.election_id, link.election_year,
           link.candidate_name_normalized, link.office_name, link.district,
           link.committee_id, link.committee_name, link.link_source, link.source_url, link.last_verified_at,
           candidate.first_name, candidate.last_name, candidate.display_name, candidate.party,
           office.scope AS office_scope, office.canonical_name AS canonical_office_name,
           election.election_date::text, COUNT(*) OVER()::text AS total_due
      FROM public.me_candidate_finance_links AS link
      JOIN public.candidates AS candidate ON candidate.id=link.candidate_id
      JOIN public.candidate_elections AS ce ON ce.candidate_id=link.candidate_id AND ce.election_id=link.election_id
      JOIN public.elections AS election ON election.id=link.election_id
      JOIN public.offices AS office ON office.id=election.office_id
      JOIN public.districts AS district ON district.id=election.district_id
      LEFT JOIN LATERAL (SELECT MAX(observed_at) AS observed_at FROM public.me_candidate_finance_source_markers
        WHERE link_id=link.id AND election_year=link.election_year
          AND source_calendar_year=link.election_year) AS marker ON TRUE
     WHERE link.link_status='active' AND candidate.deleted_at IS NULL AND candidate.merged_into_candidate_id IS NULL
       AND ce.status='declared' AND election.election_stage='general' AND district.state='ME'
       AND EXTRACT(YEAR FROM election.election_date)::int=link.election_year
       AND ((office.scope='state_upper' AND office.canonical_name='State Senator' AND district.district_type='state_upper')
         OR (office.scope='state_lower' AND office.canonical_name='State Lower Chamber Legislator' AND district.district_type='state_lower'))
       AND link.office_name=office.canonical_name
       AND CASE WHEN link.district ~ '^[0-9]{1,3}$' AND district.geoid_compact ~ '^23[0-9]{1,3}$'
           THEN SUBSTRING(district.geoid_compact FROM 3)::int=link.district::int ELSE FALSE END
       AND election.election_date BETWEEN ($1::timestamptz::date-make_interval(days=>$4::int)) AND ($1::timestamptz::date+make_interval(days=>$5::int))
       AND ($6::uuid IS NULL OR link.candidate_id=$6::uuid)
       AND ($7::int IS NULL OR link.election_year=$7::int)
       AND ($8::boolean OR marker.observed_at IS NULL OR marker.observed_at<($1::timestamptz-make_interval(days=>$2::int)))
     ORDER BY marker.observed_at ASC NULLS FIRST, election.election_date, link.id
     LIMIT $3::int`,
    [
      now.toISOString(),
      staleAfterDays,
      maxCandidates,
      lookback,
      lookahead,
      input.candidateId ?? null,
      input.electionYear ?? null,
      input.refresh === true || input.resync === true,
    ],
  );
  const results: MaineCandidateFinanceBatchSyncItemResult[] = [];
  for (const year of new Set(due.rows.map((row) => row.election_year))) {
    const selected = due.rows.filter((row) => row.election_year === year);
    let failure = "Maine modern source unavailable; stored finance preserved";
    try {
      const capture = await captureMaineMapLightDatasets({
        cacheDir,
        year,
        refresh: input.refresh,
        cacheOnly: !allowNetwork,
      });
      if (capture.status !== "captured") throw new Error(failure);
      const ballot = await acquireMaineMapLightBallot({
        cacheDir: join(cacheDir, "ballot"),
        year,
        refresh: input.refresh,
        cacheOnly: !allowNetwork,
      });
      if (ballot.status !== "available")
        throw new Error(
          "Maine official ballot context unavailable; stored finance preserved",
        );
      const verifiedCsv = async (artifact: {
        path: string;
        bytes: number;
        sha256: string;
      }) => {
        const bytes = await readFile(artifact.path);
        if (
          bytes.length !== artifact.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
        )
          throw new Error(
            "Maine captured financial body changed; stored finance preserved",
          );
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      };
      const all = parseMaineMapLightAllFilerCsv(
        await verifiedCsv(capture.capture.datasets.all_filers),
      );
      const allocations = parseMaineMapLightIndependentExpenditureCsv(
        await verifiedCsv(capture.capture.datasets.independent_expenditures),
      );
      const reports = [];
      for (const sourceUrl of reportUrls) {
        const report = await captureMaineMapLightReport({
          cacheDir: join(cacheDir, "reports"),
          sourceUrl,
          allowNetwork,
          refresh: input.refresh,
        });
        if (report.status === "captured") reports.push(report.report);
      }
      const through = [
        capture.capture.selections.all_filers.descriptor.lastUpdatedDate,
        capture.capture.selections.independent_expenditures.descriptor
          .lastUpdatedDate,
      ].sort()[0];
      // Reports qualify returns within these datasets; they cannot refresh the
      // dataset/ballot observation or invalidate an unchanged donor replay.
      // Their original bodies, hashes and observation times stay in the report cache.
      const observedAt = new Date(
        Math.max(
          Date.parse(capture.capture.capturedAt),
          Date.parse(ballot.observedAt),
        ),
      );
      const captureDigest = createHash("sha256")
        .update(
          JSON.stringify([
            capture.capture.captureDigest,
            ballot.captureDigest,
            // Preserve the identity of captures first written without reports.
            [],
          ]),
        )
        .digest("hex");
      for (const row of selected) {
        const item = {
          candidateId: row.candidate_id,
          electionId: row.election_id,
          electionYear: year,
          committeeId: row.committee_id,
        };
        try {
          const source = resolveMaineMapLightCandidateSource({
            rows: all,
            firstName: row.first_name,
            lastName: row.last_name,
            officeScope: row.office_scope,
            district: row.district,
          });
          const middle = localMiddle(row);
          if (!source || !middle)
            throw new Error(
              "Maine unique candidate source context unavailable; stored finance preserved",
            );
          const qualification = qualifyMaineMapLightBallotContext({
            rows: ballot.rows,
            candidate: {
              firstName: row.first_name,
              lastName: row.last_name,
              ...middle,
              party: row.party ?? undefined,
              officeScope: row.office_scope,
              officeName: row.canonical_office_name,
              district: row.district ?? "",
              electionYear: year,
              electionDate: row.election_date,
            },
            source: {
              filerId: source.filerId,
              filerName: source.filerName,
              firstName: source.filerFirstName,
              lastName: source.filerLastName,
              office: source.filerOffice,
              district: source.filerDistrict,
            },
          });
          if (!qualification.context)
            throw new Error(
              "Maine official candidate context did not qualify; stored finance preserved",
            );
          const facts = produceMaineMapLightFinancialFacts({
            sourceContext: {
              filerId: source.filerId,
              filerName: source.filerName,
              office: source.filerOffice,
              district: source.filerDistrict,
              electionYear: year,
              publishedAsOfDate: through,
            },
            allFilerTransactions: all,
            ieAllocations: allocations,
            ordinaryReturnReports: reports,
          });
          // A newly ambiguous payer must not erase that payer's previously accepted facts.
          const outside = facts.outsideOmittedPayers.length
            ? undefined
            : facts.outsideAllocations;
          if (
            facts.committeeDonorPositions === undefined &&
            outside === undefined
          )
            throw new Error(
              "Maine financial source components unresolved; stored finance preserved",
            );
          if (!input.dryRun) {
            await replaceMaineCandidateFinanceSnapshot({
              db: input.db,
              syncedAt: now,
              link: {
                candidateId: row.candidate_id,
                electionId: row.election_id,
                electionYear: year,
                candidateNameNormalized: row.candidate_name_normalized,
                officeName: row.office_name,
                district: row.district,
                committeeId: row.committee_id,
                committeeName: row.committee_name,
                linkSource: row.link_source,
                linkStatus: "active",
                sourceUrl: row.source_url,
                lastVerifiedAt: row.last_verified_at,
              },
              mapLightSource: {
                linkId: row.id,
                electionDate: row.election_date,
                sourceCalendarYear: year,
                periodStart: `${year}-01-01`,
                periodEnd:
                  through < `${year}-12-31` ? through : `${year}-12-31`,
                qualifiedBallotContext: qualification.context,
                observedAt,
                captureDigest,
                sourceUrl: MAINE_MAPLIGHT_DATASET_GUIDE_MD_URL,
                sourceFilerId: source.filerId,
                sourceFilerName: source.filerName,
                sourceOffice:
                  row.office_scope === "state_upper"
                    ? "Senator"
                    : "Representative",
                sourceDistrict: source.filerDistrict,
                publishedSourceTimes: {
                  allFiler: `${capture.capture.selections.all_filers.descriptor.lastUpdatedDate} ${capture.capture.selections.all_filers.descriptor.lastUpdatedTime} ET`,
                  independentExpenditures: `${capture.capture.selections.independent_expenditures.descriptor.lastUpdatedDate} ${capture.capture.selections.independent_expenditures.descriptor.lastUpdatedTime} ET`,
                },
              },
              mapLightCommitteeDonors: facts.committeeDonorPositions,
              mapLightOutsideAllocations: outside,
            });
          }
          results.push({
            ...item,
            ok: true,
            mapLight: {
              sourceFilerId: source.filerId,
              committeeDonorCount: facts.committeeDonorPositions?.length ?? 0,
              committeeDonorAmount:
                facts.committeeDonorPositions === undefined
                  ? null
                  : facts.committeeDonorPositions.reduce(
                      (sum, donor) => sum + donor.amountCents,
                      0,
                    ) / 100,
              outsideAllocationCount: outside?.length ?? 0,
              knownSupportAmount:
                outside === undefined
                  ? null
                  : outside
                      .filter((a) => a.supportOppose === "support")
                      .reduce(
                        (sum, a) => sum + a.amountSpentOnCandidateCents,
                        0,
                      ) / 100,
              knownOpposeAmount:
                outside === undefined
                  ? null
                  : outside
                      .filter((a) => a.supportOppose === "oppose")
                      .reduce(
                        (sum, a) => sum + a.amountSpentOnCandidateCents,
                        0,
                      ) / 100,
              sourceThrough: through,
              omittedPayerCount: facts.outsideOmittedPayers.length,
              written: !input.dryRun,
            },
          });
        } catch (error) {
          results.push({
            ...item,
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Maine modern finance sync failed",
          });
        }
      }
      continue;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Maine "))
        failure = error.message;
    }
    for (const row of selected)
      results.push({
        candidateId: row.candidate_id,
        electionId: row.election_id,
        electionYear: year,
        committeeId: row.committee_id,
        ok: false,
        error: failure,
      });
  }
  return {
    dryRun: input.dryRun === true,
    now: now.toISOString(),
    staleAfterDays,
    maxCandidates,
    dueCandidateCount: Number(due.rows[0]?.total_due ?? 0),
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount: results.filter((result) => result.ok).length,
    failedCandidateCount: results.filter((result) => !result.ok).length,
    results,
  };
}

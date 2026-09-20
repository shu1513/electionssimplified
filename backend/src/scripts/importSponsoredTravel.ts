import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import {
  loadAllResearchAreas,
  upsertCandidateRecordAreaTags,
} from "../pipeline/candidates/candidateRecordAreaTagging.js";
import { buildCandidateRecordIdentityKey, recordIdentityTransition } from "../pipeline/candidates/candidateRecordStore.js";
import { loadCongressLegislators } from "../pipeline/rollcall/congressLegislators.js";
import { loadCandidateFecIndex, resolveFederalMember } from "../pipeline/rollcall/federalMemberResolver.js";
import {
  buildSponsoredTripDescription,
  groupHouseSponsoredTrips,
  houseGiftTravelPdfUrl,
  matchHouseTripLegislator,
  parseHouseGiftTravelIndex,
  planSponsoredTripRecord,
  SPONSORED_TRAVEL_DESTINATIONS,
  type HouseGiftTravelRow,
} from "../pipeline/travel/houseGiftTravel.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import { DEFAULT_SCOPE_FROM } from "./resolveRollCallMembers.js";

// Imports privately sponsored trips by House members as candidate records:
// one record per member per trip, written for members who are on a
// Nov-2026-or-later election. The source is the House Clerk's yearly
// gift-travel index; put each `<year>Travel.xml` in the evidence dir first:
//
//   curl -sLO https://disclosures-clerk.house.gov/public_disc/gift-pdfs/2025Travel.zip && unzip 2025Travel.zip
//   npm run travel:import -- --evidence-dir evidence/travel/<run> --destination israel --dry-run
//   npm run travel:import -- --evidence-dir evidence/travel/<run> --destination israel
//
// Re-runs are safe: a trip whose record already exists is `unchanged` (its
// tag is still synced). A trip whose stored record no longer matches the
// generated sentence or source is reported as `changed` and left alone,
// unless `--rewrite-changed` is passed: that flag is the deliberate path for a
// reworded sponsor sentence. It rewrites this importer's own live record in
// place (same row id and source, new sentence and identity key) and logs the
// identity transition so research:promote follows the re-key.

export const SPONSORED_TRAVEL_IMPORTER_VERSION = "travel-import-v1";
const DEFAULT_LEGISLATORS_DIR = "evidence/rollcall/congress-legislators";
const URL_CHECK_DELAY_MS = 150;
const URL_CHECK_TIMEOUT_MS = 30_000;

type TripAction =
  | "insert"
  | "unchanged"
  | "changed"
  | "rewrite"
  | "dry_run_rewrite"
  | "retired_blocks"
  | "unknown_sponsor"
  | "unresolved_member"
  | "no_candidate"
  | "out_of_scope"
  | "source_unreachable"
  | "dry_run_insert";

type TripReportRow = {
  memberName: string;
  state: string;
  district: string;
  departureDate: string;
  returnDate: string | null;
  sponsorAsFiled: string;
  sponsorKey: string | null;
  docId: string;
  docIds: string[];
  sourceUrl: string;
  bioguide: string | null;
  candidateId: string | null;
  candidateName: string | null;
  action: TripAction;
  detail: string;
  recordId: string | null;
};

function readValueFlag(argv: readonly string[], flagName: string): string | null {
  const index = argv.indexOf(flagName);
  if (index >= 0) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flagName} requires a value`);
    }
    return value;
  }
  const inline = argv.find((token) => token.startsWith(`${flagName}=`));
  return inline ? inline.slice(flagName.length + 1) : null;
}

async function sourceIsReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { range: "bytes=0-0", "user-agent": "voteapp-travel-import (+https://electionssimplified.com)" },
      signal: controller.signal,
    });
    await response.body?.cancel();
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("travel:import", argv, [
    { name: "--evidence-dir", value: "both" },
    { name: "--destination", value: "both" },
    { name: "--legislators-sha", value: "both" },
    { name: "--legislators-dir", value: "both" },
    { name: "--scope-from", value: "both" },
    { name: "--dry-run", value: "none" },
    { name: "--rewrite-changed", value: "none" },
  ]);
  const evidenceDirRaw = readValueFlag(argv, "--evidence-dir");
  if (!evidenceDirRaw) {
    throw new Error("--evidence-dir is required");
  }
  const evidenceDir = resolve(evidenceDirRaw);
  const destinationKey = readValueFlag(argv, "--destination");
  const destination = destinationKey ? SPONSORED_TRAVEL_DESTINATIONS[destinationKey] : undefined;
  if (!destination) {
    throw new Error(`--destination must be one of: ${Object.keys(SPONSORED_TRAVEL_DESTINATIONS).join(", ")}`);
  }
  const legislatorsSha = readValueFlag(argv, "--legislators-sha") ?? undefined;
  const legislatorsDir = resolve(readValueFlag(argv, "--legislators-dir") ?? DEFAULT_LEGISLATORS_DIR);
  const scopeFrom = readValueFlag(argv, "--scope-from") ?? DEFAULT_SCOPE_FROM;
  const dryRun = argv.includes("--dry-run");
  const rewriteChanged = argv.includes("--rewrite-changed");

  const indexFiles = readdirSync(evidenceDir)
    .filter((name) => /^\d{4}Travel\.xml$/.test(name))
    .sort();
  if (indexFiles.length === 0) {
    throw new Error(`${evidenceDir} holds no <year>Travel.xml files`);
  }
  const indexRows: HouseGiftTravelRow[] = indexFiles.flatMap((name) =>
    parseHouseGiftTravelIndex(readFileSync(join(evidenceDir, name), "utf8"))
  );

  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  requireLocalDatabaseTarget(databaseUrl);

  const startedAt = new Date();
  const legislators = await loadCongressLegislators({ sha: legislatorsSha, cacheDir: legislatorsDir });
  const { trips, undated } = groupHouseSponsoredTrips(indexRows, destination, legislators.index);
  const pool = new Pool({ connectionString: databaseUrl });
  const rows: TripReportRow[] = [];
  try {
    const candidatesByFec = await loadCandidateFecIndex(pool, scopeFrom);
    const researchAreas = await loadAllResearchAreas(pool);
    const researchAreaIdBySlug = new Map(researchAreas.map((area) => [area.slug, area.id]));
    if (!researchAreaIdBySlug.has(destination.researchAreaSlug)) {
      throw new Error(`research area ${destination.researchAreaSlug} does not exist; run db:migrate first`);
    }
    // Additive on purpose: a re-run adds or corrects this importer's own tag
    // and never removes a tag someone else put on the record.
    const tagsFor = (candidateRecordId: string) => [
      { candidateRecordId, researchAreaSlug: destination.researchAreaSlug, stance: destination.stance },
    ];

    for (const trip of trips) {
      let sourceUrl = houseGiftTravelPdfUrl(trip.filingYear, trip.docId);
      const row: TripReportRow = {
        memberName: trip.memberName,
        state: trip.state,
        district: trip.district,
        departureDate: trip.departureDate,
        returnDate: trip.returnDate,
        sponsorAsFiled: trip.sponsorAsFiled,
        sponsorKey: trip.sponsor?.key ?? null,
        docId: trip.docId,
        docIds: trip.docIds,
        sourceUrl,
        bioguide: null,
        candidateId: null,
        candidateName: null,
        action: "unknown_sponsor",
        detail: "",
        recordId: null,
      };
      rows.push(row);
      if (!trip.sponsor) {
        row.detail = "sponsor has no clause in SPONSORED_TRAVEL_DESTINATIONS";
        continue;
      }
      const match = matchHouseTripLegislator(trip, legislators.index);
      if (match.outcome !== "matched") {
        row.action = "unresolved_member";
        row.detail = `${match.outcome}: ${match.detail}`;
        continue;
      }
      row.bioguide = match.legislator.bioguide;
      const resolution = resolveFederalMember(
        { chamber: "house", memberId: match.legislator.bioguide, name: trip.memberName, state: trip.state, party: null, vote: "" },
        trip.departureDate,
        legislators.index,
        candidatesByFec
      );
      if (resolution.outcome !== "matched" || !resolution.candidate) {
        row.action = resolution.outcome === "out_of_scope" ? "out_of_scope" : "no_candidate";
        row.detail = `${resolution.outcome}: ${resolution.detail}`;
        continue;
      }
      row.candidateId = resolution.candidate.candidateId;
      row.candidateName = resolution.candidate.name;

      const description = buildSponsoredTripDescription(destination, trip, trip.sponsor);
      const tripRunPrefix = `travel:US:house:${match.legislator.bioguide}:${destination.key}:${trip.departureDate}:`;
      const candidateUrls = trip.filings.map((filing) => houseGiftTravelPdfUrl(filing.filingYear, filing.docId));
      const candidateKeys = candidateUrls.map((url) =>
        buildCandidateRecordIdentityKey({ description, sourceUrl: url, eventDate: trip.departureDate })
      );
      const existing = await pool.query<{
        id: string;
        record_identity_key: string;
        retired_at: string | null;
        origin_run_id: string | null;
        source_url: string;
      }>(
        `
          SELECT id, record_identity_key, retired_at::text AS retired_at, origin_run_id, source_url
          FROM public.candidate_records
          WHERE candidate_id = $1
            AND (record_identity_key = ANY($2::text[]) OR (origin = 'travel_import' AND starts_with(origin_run_id, $3)))
          ORDER BY created_at, id
        `,
        [row.candidateId, candidateKeys, tripRunPrefix]
      );
      const plan = planSponsoredTripRecord(existing.rows, candidateKeys);
      if (plan.action === "changed" && rewriteChanged) {
        // Every live non-matching row here came from the run-id prefix, so it
        // is this importer's own record of this trip. Its source stays as is.
        const stored = existing.rows.find((record) => record.id === plan.recordId)!;
        const newKey = buildCandidateRecordIdentityKey({
          description,
          sourceUrl: stored.source_url,
          eventDate: trip.departureDate,
        });
        row.recordId = stored.id;
        row.sourceUrl = stored.source_url;
        if (dryRun) {
          row.action = "dry_run_rewrite";
          continue;
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const updated = await client.query(
            `
              UPDATE public.candidate_records
              SET description = $3, record_identity_key = $4, updated_at = now()
              WHERE id = $1 AND record_identity_key = $2 AND retired_at IS NULL
            `,
            [stored.id, stored.record_identity_key, description, newKey]
          );
          if (updated.rowCount !== 1) {
            throw new Error(`record ${stored.id} changed under the rewrite`);
          }
          await recordIdentityTransition(client, {
            candidateId: row.candidateId,
            oldIdentityKey: stored.record_identity_key,
            newIdentityKey: newKey,
            reason: "plain_language_rewrite",
          });
          await upsertCandidateRecordAreaTags(client, tagsFor(stored.id), researchAreaIdBySlug);
          await client.query("COMMIT");
          row.action = "rewrite";
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        continue;
      }
      if (plan.action !== "insert") {
        row.action = plan.action;
        row.recordId = plan.recordId;
        if (plan.action === "unchanged") {
          row.sourceUrl = candidateUrls[plan.keyIndex]!;
          if (!dryRun) {
            await upsertCandidateRecordAreaTags(pool, tagsFor(plan.recordId), researchAreaIdBySlug);
          }
        } else {
          row.detail =
            plan.action === "retired_blocks"
              ? "a retired record exists for this trip; restore it explicitly to bring it back"
              : "this trip already has a record with a different sentence or source; left alone";
        }
        continue;
      }

      let reachable: string | null = null;
      for (const url of candidateUrls) {
        const ok = await sourceIsReachable(url);
        await new Promise((done) => setTimeout(done, URL_CHECK_DELAY_MS));
        if (ok) {
          reachable = url;
          break;
        }
      }
      if (!reachable) {
        row.action = "source_unreachable";
        row.detail = "no member-travel (MT) PDF loads for this trip: a staff filing, or a PDF the Clerk site has lost";
        continue;
      }
      sourceUrl = reachable;
      row.sourceUrl = reachable;
      const identityKey = candidateKeys[candidateUrls.indexOf(reachable)]!;
      if (dryRun) {
        row.action = "dry_run_insert";
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<{ id: string }>(
          `
            INSERT INTO public.candidate_records
              (candidate_id, description, source_url, event_date, record_identity_key, origin, origin_run_id)
            VALUES ($1, $2, $3, $4::date, $5, 'travel_import', $6)
            ON CONFLICT (candidate_id, record_identity_key) DO NOTHING
            RETURNING id
          `,
          [row.candidateId, description, sourceUrl, trip.departureDate, identityKey, `${tripRunPrefix}${startedAt.toISOString()}`]
        );
        const recordId = inserted.rows[0]?.id;
        if (!recordId) {
          throw new Error(`candidate ${row.candidateId} already holds record key ${identityKey}`);
        }
        await upsertCandidateRecordAreaTags(client, tagsFor(recordId), researchAreaIdBySlug);
        await client.query("COMMIT");
        row.action = "insert";
        row.recordId = recordId;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }

  const actions: Record<string, number> = {};
  for (const row of rows) {
    actions[row.action] = (actions[row.action] ?? 0) + 1;
  }
  const unknownSponsors: Record<string, number> = {};
  for (const row of rows.filter((entry) => entry.action === "unknown_sponsor")) {
    unknownSponsors[row.sponsorAsFiled] = (unknownSponsors[row.sponsorAsFiled] ?? 0) + 1;
  }
  const report = {
    importerVersion: SPONSORED_TRAVEL_IMPORTER_VERSION,
    dryRun,
    destination: destination.key,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    scopeFrom,
    legislatorsSha: legislators.sha,
    indexFiles,
    indexRows: indexRows.length,
    trips: trips.length,
    undatedRows: undated.length,
    actions,
    unknownSponsors,
    rows,
  };
  const reportFile = join(evidenceDir, dryRun ? "import-dry-run-report.json" : "import-report.json");
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, rows: undefined, reportFile }, null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(`travel:import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

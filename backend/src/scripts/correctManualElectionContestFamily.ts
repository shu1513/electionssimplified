// Guarded correction for one office election's discovery contest family.
//
// The normal election upsert intentionally preserves an existing conflicting
// family, so a verified classification error cannot be repaired by reinjecting
// the election. This wrapper changes only one exactly identified row and, in
// the same transaction, re-runs the current OfficeMatcher under the corrected
// family so a stranded office_id is backfilled without direct SQL.
import { pathToFileURL } from "node:url";

import { Pool, type PoolClient } from "pg";

import { loadProjectEnv } from "../config/env.js";
import {
  isJudicialOfficeCanonicalName,
  OfficeMatcher,
} from "../pipeline/elections/officeMatcher.js";
import type { ElectionContestFamily, ElectionDistrictType } from "../types/election.js";
import { mergeElectionSource } from "./electionSourceUtils.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

const OFFICE_CONTEST_FAMILIES = ["non_judicial_office", "judicial_office"] as const;
const COUNTY_EXECUTIVE_CANONICAL_NAME = "County Executive";
type OfficeContestFamily = (typeof OFFICE_CONTEST_FAMILIES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type QueryResultLike<T> = { rows: T[] };

export type ElectionContestFamilyCorrectionClient = Pick<PoolClient, "query"> & {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
};

export type ElectionContestFamilyCorrectionOptions = {
  electionId: string;
  expectedFamily: OfficeContestFamily;
  correctedFamily: OfficeContestFamily;
  sourceUrl: string;
  dryRun: boolean;
};

type ElectionRow = {
  id: string;
  official_ballot_title: string;
  race_type: string;
  discovery_contest_family: string | null;
  office_id: string | null;
  sources: unknown;
  district_name: string;
  state: string;
  district_type: ElectionDistrictType;
};

type ResolvedOfficeRow = {
  canonical_name: string;
};

export type ElectionContestFamilyCorrectionResult = {
  electionId: string;
  officialBallotTitle: string;
  expectedFamily: OfficeContestFamily;
  correctedFamily: OfficeContestFamily;
  alreadyCorrected: boolean;
  officeId: string;
  officeBackfilled: boolean;
  officeReplaced: boolean;
  sourceAppended: boolean;
  matchMethod: "alias_exact" | "deterministic_fallback";
  dryRun: boolean;
};

function usage(): string {
  return [
    "Correct one office election's discovery contest family and resolve its office_id.",
    "",
    "Usage:",
    "  npm run manual:election-contest-family:correct -- --election-id uuid --expected-family non_judicial_office --corrected-family judicial_office --source-url https://... --reason text [--dry-run]",
  ].join("\n");
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value.trim();
}

function requireFlag(name: string): string {
  const value = readFlag(name);
  if (!value) throw new Error(`Missing ${name}.\n${usage()}`);
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for contest-family correction`);
  return value;
}

export function parseOfficeContestFamily(name: string, value: string): OfficeContestFamily {
  if (!(OFFICE_CONTEST_FAMILIES as readonly string[]).includes(value)) {
    throw new Error(
      `${name} must be one of ${OFFICE_CONTEST_FAMILIES.join(", ")}; received ${value}`
    );
  }
  return value as OfficeContestFamily;
}

function assertHttpsSource(sourceUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("--source-url must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("--source-url must use HTTPS");
  }
}

export async function runElectionContestFamilyCorrection(
  client: ElectionContestFamilyCorrectionClient,
  options: ElectionContestFamilyCorrectionOptions
): Promise<ElectionContestFamilyCorrectionResult> {
  const { electionId, expectedFamily, correctedFamily, sourceUrl, dryRun } = options;
  if (expectedFamily === correctedFamily) {
    throw new Error("Expected and corrected contest families must differ");
  }
  assertHttpsSource(sourceUrl);

  await client.query("BEGIN");
  try {
    const locked = await client.query<ElectionRow>(
      `
        SELECT
          e.id,
          e.official_ballot_title,
          e.race_type,
          e.discovery_contest_family,
          e.office_id,
          e.sources,
          d.name AS district_name,
          d.state,
          d.district_type
        FROM public.elections e
        JOIN public.districts d ON d.id = e.district_id
        WHERE e.id = $1::uuid
        FOR UPDATE OF e
      `,
      [electionId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error(`Election not found: ${electionId}`);
    if (row.race_type !== "office") {
      throw new Error(`Election ${electionId} is race_type=${row.race_type}; only office races are supported`);
    }

    const alreadyCorrected = row.discovery_contest_family === correctedFamily;
    if (!alreadyCorrected && row.discovery_contest_family !== expectedFamily) {
      throw new Error(
        `Expected election ${electionId} contest family ${expectedFamily}, found ${row.discovery_contest_family ?? "NULL"}; refusing correction`
      );
    }

    const matcher = new OfficeMatcher(client);
    const match = await matcher.resolve({
      scope: row.district_type,
      districtName: row.district_name,
      state: row.state,
      officialBallotTitle: row.official_ballot_title,
      discoveryContestFamily: correctedFamily as ElectionContestFamily,
    });
    if (!match.officeId || (match.method !== "alias_exact" && match.method !== "deterministic_fallback")) {
      throw new Error(
        `Corrected family ${correctedFamily} did not resolve an office for election ${electionId} ` +
          `(method=${match.method}, confidence=${match.confidence.toFixed(3)}); refusing correction`
      );
    }

    // The matcher uses the family to improve resolution, but an exact alias
    // under judicial_office can still point to a non-judge office. This repair
    // changes authoritative classification data, so independently verify the
    // resolved canonical office before accepting it.
    const resolvedOffice = await client.query<ResolvedOfficeRow>(
      `
        SELECT canonical_name
        FROM public.offices
        WHERE id = $1::uuid
      `,
      [match.officeId]
    );
    const resolvedCanonicalName = resolvedOffice.rows[0]?.canonical_name;
    if (!resolvedCanonicalName) {
      throw new Error(
        `Corrected family ${correctedFamily} resolved missing office ${match.officeId}; refusing correction`
      );
    }
    const resolvedIsJudicial = isJudicialOfficeCanonicalName(resolvedCanonicalName);
    const familyIsJudicial = correctedFamily === "judicial_office";
    if (resolvedIsJudicial !== familyIsJudicial) {
      throw new Error(
        `Corrected family ${correctedFamily} resolved incompatible office ${resolvedCanonicalName} ` +
          `(${match.officeId}); refusing correction`
      );
    }
    // A judge office stored on an election being corrected to non-judicial is
    // the same classification error (309 Arkansas quorum-court seats sat on the
    // judicial Justice of the Peace office), so it is replaced. The mirror case
    // is County Executive under a judge family: the Texas/Kentucky/Arkansas
    // executive owns the "county judge" alias, so a New York County Court judge
    // ("Allegany County Judge") or a Texas district judge could land there
    // before the family was set right. Any other stored office that differs
    // from the match is a real conflict.
    let officeReplaced = false;
    if (row.office_id && row.office_id !== match.officeId) {
      const storedOffice = await client.query<ResolvedOfficeRow>(
        `
          SELECT canonical_name
          FROM public.offices
          WHERE id = $1::uuid
        `,
        [row.office_id]
      );
      const storedCanonicalName = storedOffice.rows[0]?.canonical_name;
      const judgeOnCountyExecutive =
        familyIsJudicial && storedCanonicalName === COUNTY_EXECUTIVE_CANONICAL_NAME;
      const nonJudgeOnJudgeOffice =
        !familyIsJudicial && storedCanonicalName !== undefined && isJudicialOfficeCanonicalName(storedCanonicalName);
      if (!judgeOnCountyExecutive && !nonJudgeOnJudgeOffice) {
        throw new Error(
          `Election ${electionId} already references office ${row.office_id}, but corrected family resolves ${match.officeId}; refusing correction`
        );
      }
      officeReplaced = true;
    }

    const { sources, appended: sourceAppended } = mergeElectionSource(
      row.sources,
      sourceUrl
    );
    const officeBackfilled = row.office_id === null;
    const needsUpdate = !alreadyCorrected || officeBackfilled || officeReplaced || sourceAppended;

    if (dryRun || !needsUpdate) {
      await client.query("ROLLBACK");
    } else {
      await client.query(
        `
          UPDATE public.elections
          SET discovery_contest_family = $2,
              office_id = $3::uuid,
              sources = $4::jsonb,
              updated_at = now()
          WHERE id = $1::uuid
        `,
        [electionId, correctedFamily, match.officeId, JSON.stringify(sources)]
      );
      await client.query("COMMIT");
    }

    return {
      electionId,
      officialBallotTitle: row.official_ballot_title,
      expectedFamily,
      correctedFamily,
      alreadyCorrected,
      officeId: match.officeId,
      officeBackfilled,
      officeReplaced,
      sourceAppended,
      matchMethod: match.method,
      dryRun,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:election-contest-family:correct", process.argv.slice(2), [
    { name: "--election-id", value: "space" },
    { name: "--expected-family", value: "space" },
    { name: "--corrected-family", value: "space" },
    { name: "--source-url", value: "space" },
    { name: "--reason", value: "space" },
    { name: "--dry-run", value: "none" },
  ]);
  loadProjectEnv();

  const electionId = requireFlag("--election-id");
  const expectedFamily = parseOfficeContestFamily(
    "--expected-family",
    requireFlag("--expected-family")
  );
  const correctedFamily = parseOfficeContestFamily(
    "--corrected-family",
    requireFlag("--corrected-family")
  );
  const sourceUrl = requireFlag("--source-url");
  const reason = requireFlag("--reason");
  const dryRun = process.argv.includes("--dry-run");

  if (!UUID_RE.test(electionId)) throw new Error(`Invalid --election-id: ${electionId}`);
  if (reason.length < 20) {
    throw new Error("--reason must explain the correction in at least 20 characters");
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const result = await runElectionContestFamilyCorrection(client, {
      electionId,
      expectedFamily,
      correctedFamily,
      sourceUrl,
      dryRun,
    });
    console.log(JSON.stringify({ ...result, reason }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

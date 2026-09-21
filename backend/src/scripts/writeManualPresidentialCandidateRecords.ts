import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";

import {
  validateCandidateRecordDiscoveryPayload,
  type CandidateRecordDroppedRecord,
} from "../ai/enrichCandidateRecords.js";
import { loadProjectEnv } from "../config/env.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { parseCandidateRecordAreaLabelPayload } from "../contracts/candidateRecordAreaLabelPayloadContract.js";
import {
  loadAllowedResearchAreasForOfficeId,
  upsertCandidateRecordAreaTags,
  validateCandidateRecordAreaLabels,
  type CandidateRecordAreaLabelInput,
} from "../pipeline/candidates/candidateRecordAreaTagging.js";
import {
  loadCandidatePresidentialCycleOfficeContext,
  type CandidateRecordPresidentialRole,
} from "../pipeline/candidates/candidateRecordOfficeContext.js";
import { listPlainLanguageWarnings } from "../pipeline/candidates/candidateRecordPlainLanguageLint.js";
import {
  buildCandidateRecordIdentityKey,
  findWithinPayloadRecordCollisions,
  upsertCandidateRecords,
} from "../pipeline/candidates/candidateRecordStore.js";
import {
  applyConfirmedGaps,
  buildCandidateRecordQualityGaps,
  droppedRecordToGap,
  isBlockingCandidateRecordQualityGap,
} from "./writeManualCandidateRecords.js";
import {
  SWEEP_COMPLETENESS_GAP_IDS,
  assertedSweepCompletenessGapIds,
  deleteSweepCompletenessConfirmation,
  deleteSweepConfirmation,
  enforceSweepRouteCoverage,
  parseSweepEvidencePayload,
  persistHasHeldPublicOfficeAnswer,
  sweepEvidenceMissingError,
  sweepEvidenceRequired,
  writeMergedSweepConfirmation,
  type SweepEvidenceEntry,
  type SweepRoute,
} from "./candidateRecordSweepEvidence.js";
import {
  buildManualResearchRepairReport,
  summarizeManualResearchGaps,
  writeManualResearchRepairReport,
  type ManualResearchRepairGap,
} from "./manualResearchRepairReport.js";

import { assertKnownCliFlags } from "./manualCliFlags.js";
import { WALL_CLOCK_FORCE_EXIT_GRACE_MS, withWallClockTimeout } from "./wallClockTimeout.js";
import { readPositiveIntegerEnv } from "../config/envReaders.js";
export type ManualPresidentialCandidateRecordsOptions = {
  candidateId: string;
  presidentialCycleId: string;
  presidentialRole: CandidateRecordPresidentialRole;
  recordsFile: string;
  labelsFile: string;
  repairReportFile: string | null;
  evidenceFile: string | null;
  strictQualityGate: boolean;
  confirmedGapIds: Set<string>;
  dryRun: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:presidential-records:write -- --candidate-id uuid --presidential-cycle-id uuid --presidential-role president|vice_president --records-file records.json --labels-file labels.json [--strict-quality-gate] [--confirmed-gap id] [--evidence-file evidence.json] [--repair-report-file file] [--dry-run]",
    "",
    "records.json must match CandidateRecordDiscoveryPayload. labels.json must match CandidateRecordAreaLabelPayload.",
    'A zero-record payload, an all-neutral (general/integrity_and_ethics-only) label set, --confirmed-gap candidate_records.no_records_found, or --confirmed-gap candidate_records.only_general_labels asserts a FINISHED discovery sweep — in any mode, strict or not — and requires --evidence-file with the per-question evidence table: {"entries": [{"question": "...", "finding": "...", "question_id": "..."}, ...]}.',
    "A supplied --evidence-file on a stance-bearing write is persisted too (candidate_record_sweep_confirmations with an empty claim set), so keep supplying the ledger — the output reports sweepEvidence.persisted (dry-run: wouldPersist).",
    "",
    "Every ledger here is a full-history claim and must COVER its route's question list via question_id tags (presidential contests are never judicial): officeholders (has EVER held public office) need rollcalls, sponsorship, executive, proceedings, leadership, outside_chamber, endorsements; never-held candidates need career, orgs_advocacy, court_legal, endorsements. Routing reads candidates.has_held_public_office; when NULL the evidence file must carry a top-level \"has_held_public_office\": true|false, which the write persists.",
  ].join("\n");
}

function readValueFlag(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index >= 0) {
    const value = args[index + 1];
    if (!value || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value;
  }

  const prefix = `${name}=`;
  const match = args.find((token) => token.startsWith(prefix));
  if (!match) {
    return null;
  }
  const value = match.slice(prefix.length);
  if (value.trim().length === 0) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value;
}

function readBooleanFlag(args: readonly string[], name: string): boolean {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    throw new Error(`Boolean flag must not include a value: ${name}`);
  }
  const index = args.indexOf(name);
  if (index < 0) {
    return false;
  }
  const next = args[index + 1];
  if (next && !next.startsWith("--")) {
    throw new Error(`Boolean flag must not include a value: ${name}`);
  }
  return true;
}

function readRepeatedFlag(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || value.trim().length === 0) {
        throw new Error(`Missing value for ${name}.\n${usage()}`);
      }
      values.push(value.trim());
      index += 1;
      continue;
    }
    if (token?.startsWith(prefix)) {
      const value = token.slice(prefix.length).trim();
      if (value.length === 0) {
        throw new Error(`Missing value for ${name}.\n${usage()}`);
      }
      values.push(value);
    }
  }
  return values;
}

function normalizeRequiredFlag(raw: string | null, name: string): string {
  const value = raw?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`Missing ${name}.\n${usage()}`);
  }
  return value;
}

function parsePresidentialRole(raw: string | null): CandidateRecordPresidentialRole {
  const value = normalizeRequiredFlag(raw, "--presidential-role");
  if (value === "president" || value === "vice_president") {
    return value;
  }
  throw new Error(`Invalid --presidential-role value: ${value}.\n${usage()}`);
}

function normalizeConfirmedGaps(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

export function parseManualPresidentialCandidateRecordsArgs(
  args: readonly string[]
): ManualPresidentialCandidateRecordsOptions {
  return {
    candidateId: normalizeRequiredFlag(readValueFlag(args, "--candidate-id"), "--candidate-id"),
    presidentialCycleId: normalizeRequiredFlag(
      readValueFlag(args, "--presidential-cycle-id"),
      "--presidential-cycle-id"
    ),
    presidentialRole: parsePresidentialRole(readValueFlag(args, "--presidential-role")),
    recordsFile: normalizeRequiredFlag(readValueFlag(args, "--records-file"), "--records-file"),
    labelsFile: normalizeRequiredFlag(readValueFlag(args, "--labels-file"), "--labels-file"),
    repairReportFile: readValueFlag(args, "--repair-report-file"),
    evidenceFile: readValueFlag(args, "--evidence-file"),
    strictQualityGate: readBooleanFlag(args, "--strict-quality-gate"),
    confirmedGapIds: normalizeConfirmedGaps(readRepeatedFlag(args, "--confirmed-gap")),
    dryRun: readBooleanFlag(args, "--dry-run"),
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual presidential candidate records write`);
  }
  return value;
}

function manualKey(options: ManualPresidentialCandidateRecordsOptions): string {
  return `manual:presidential-records:${options.presidentialCycleId}:${options.presidentialRole}:${options.candidateId}`;
}

function normalizeResearchAreaSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function buildNormalizedResearchAreaLookup(
  allowedAreas: readonly { id: string; slug: string }[]
): {
  allowedSlugs: Set<string>;
  researchAreaIdBySlug: Map<string, string>;
} {
  const allowedSlugs = new Set<string>();
  const researchAreaIdBySlug = new Map<string, string>();
  for (const area of allowedAreas) {
    const slug = normalizeResearchAreaSlug(area.slug);
    allowedSlugs.add(slug);
    researchAreaIdBySlug.set(slug, area.id);
  }
  return { allowedSlugs, researchAreaIdBySlug };
}

function summarizeDroppedRecords(droppedRecords: readonly CandidateRecordDroppedRecord[]): string {
  const preview = droppedRecords
    .slice(0, 5)
    .map((dropped, index) => {
      const label = dropped.record.description || dropped.record.source_url || `row ${index + 1}`;
      return `${dropped.failureKind}/${dropped.failureType}: ${label} (${dropped.reason})`;
    })
    .join("; ");
  const extra = droppedRecords.length > 5 ? `; +${droppedRecords.length - 5} more` : "";
  return `${preview}${extra}`;
}

function buildRecordLabelParseGap(reason: string): ManualResearchRepairGap {
  return {
    id: "candidate_record_labels.payload",
    stage: "candidate_record_labels",
    objectType: "candidate_record_label",
    outcome: "needs_repair",
    failureKind: "label_validation",
    reason,
    promptFile: "src/ai/providers/candidateRecordAreaLabelPrompt.ts",
    focusedResearchPass:
      "Run a focused presidential candidate-record area-label pass for the verified records. Ensure every record has at least one allowed label, non-stance areas omit stance, and stance-bearing areas include for/against.",
  };
}

function buildRecordLabelValidationGaps(reasons: readonly string[]): ManualResearchRepairGap[] {
  return reasons.map((reason, index) => ({
    id: `candidate_record_labels.validation.${index}`,
    stage: "candidate_record_labels",
    objectType: "candidate_record_label",
    outcome: "needs_repair",
    labelIndex: index,
    failureKind: "label_validation",
    reason,
    promptFile: "src/ai/providers/candidateRecordAreaLabelPrompt.ts",
    focusedResearchPass:
      "Run a focused presidential area/stance repair pass for this label. Use only allowed research areas and assign stance only when the evidence supports it.",
  }));
}

async function writeRecordsRepairReport(input: {
  reportFile: string | null;
  key: string;
  options: ManualPresidentialCandidateRecordsOptions;
  candidateDisplayName?: string | null;
  gaps: ManualResearchRepairGap[];
}): Promise<void> {
  await writeManualResearchRepairReport(
    input.reportFile,
    buildManualResearchRepairReport({
      command: "manual:presidential-records:write",
      manualKey: input.key,
      target: {
        candidateId: input.options.candidateId,
        contextType: "presidential_cycle",
        presidentialCycleId: input.options.presidentialCycleId,
        presidentialRole: input.options.presidentialRole,
        recordsFile: input.options.recordsFile,
        labelsFile: input.options.labelsFile,
        candidateDisplayName: input.candidateDisplayName ?? null,
      },
      gaps: input.gaps,
    })
  );
}

async function deleteStaleCandidateRecordAreaTags(
  client: Pick<PoolClient, "query">,
  labels: readonly CandidateRecordAreaLabelInput[],
  researchAreaIdBySlug: ReadonlyMap<string, string>
): Promise<{ deleted: number }> {
  const researchAreaIdsByRecordId = new Map<string, Set<string>>();
  for (const label of labels) {
    const researchAreaId = researchAreaIdBySlug.get(label.researchAreaSlug);
    if (!researchAreaId) {
      throw new Error(
        `Cannot delete stale candidate_record_area_tags: missing research area id for slug '${label.researchAreaSlug}'`
      );
    }
    const ids = researchAreaIdsByRecordId.get(label.candidateRecordId) ?? new Set<string>();
    ids.add(researchAreaId);
    researchAreaIdsByRecordId.set(label.candidateRecordId, ids);
  }

  let deleted = 0;
  for (const [candidateRecordId, researchAreaIds] of researchAreaIdsByRecordId.entries()) {
    const result = await client.query(
      `
        DELETE FROM public.candidate_record_area_tags
        WHERE candidate_record_id = $1
          AND NOT (research_area_id = ANY($2::uuid[]))
      `,
      [candidateRecordId, [...researchAreaIds]]
    );
    deleted += result.rowCount ?? 0;
  }

  return { deleted };
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:presidential-records:write", process.argv.slice(2), [{ name: "--candidate-id", value: "both" }, { name: "--presidential-cycle-id", value: "both" }, { name: "--presidential-role", value: "both" }, { name: "--records-file", value: "both" }, { name: "--labels-file", value: "both" }, { name: "--repair-report-file", value: "both" }, { name: "--confirmed-gap", value: "both" }, { name: "--evidence-file", value: "both" }, { name: "--strict-quality-gate", value: "none" }, { name: "--dry-run", value: "none" }]);
  loadProjectEnv();
  const options = parseManualPresidentialCandidateRecordsArgs(process.argv.slice(2));
  const key = manualKey(options);

  // Short-lived lookup on purpose, mirroring writeManualCandidateRecords:
  // validation runs before the main pool and office-context load, and the
  // candidate-owned-site policy check needs the display name at validation
  // time — presidential campaign sites are exactly as self-promotional as
  // any other candidate's.
  const earlyDatabaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(earlyDatabaseUrl);
  const namePool = new Pool({ connectionString: earlyDatabaseUrl });
  let candidateDisplayNameForPolicy: string | null = null;
  try {
    const nameResult = await namePool.query<{ display_name: string | null }>(
      `SELECT COALESCE(NULLIF(trim(display_name), ''), trim(first_name || ' ' || last_name)) AS display_name
         FROM public.candidates
        WHERE id = $1`,
      [options.candidateId]
    );
    candidateDisplayNameForPolicy = nameResult.rows[0]?.display_name ?? null;
  } finally {
    await namePool.end();
  }

  const rawRecords = await readJsonFile(options.recordsFile);
  const validatedRecords = await withWallClockTimeout(
    validateCandidateRecordDiscoveryPayload(
      rawRecords,
      readPositiveIntegerEnv("AI_TIMEOUT_MS", 90_000),
      { candidateDisplayName: candidateDisplayNameForPolicy }
    ),
    "presidential candidate record citation validation",
    { forceExitAfterMs: WALL_CLOCK_FORCE_EXIT_GRACE_MS }
  );
  if (!validatedRecords.ok) {
    const gaps: ManualResearchRepairGap[] = [
      {
        id: "candidate_records.payload",
        stage: "candidate_records",
        objectType: "candidate_record_set",
        outcome: "needs_repair",
        failureKind: "schema",
        reason: validatedRecords.reason,
        promptFile: "src/ai/providers/candidateRecordDiscoveryPrompt.ts",
        focusedResearchPass:
          "Run a focused presidential candidate-record payload repair pass. Fix only the schema issue, then rerun the manual presidential records writer.",
      },
    ];
    await writeRecordsRepairReport({
      reportFile: options.repairReportFile,
      key,
      options,
      candidateDisplayName: null,
      gaps,
    });
    throw new Error(`Presidential candidate records payload failed validation: ${validatedRecords.reason}`);
  }

  // Same index-integrity rule as writeManualCandidateRecords: labels address
  // records by index into the operator's records file, so ANY dropped record
  // (source, schema, or quality gate) blocks the import.
  if (validatedRecords.droppedRecords.length > 0) {
    const gaps = validatedRecords.droppedRecords.map(droppedRecordToGap);
    await writeRecordsRepairReport({
      reportFile: options.repairReportFile,
      key,
      options,
      candidateDisplayName: null,
      gaps,
    });
    const qualityDropped = validatedRecords.droppedRecords.filter(
      (record) => record.failureKind === "quality_gap"
    );
    const hint =
      qualityDropped.length > 0
        ? " Quality-gate drops must be repaired or removed from the records file so label record_index values stay aligned with the records actually imported."
        : "";
    throw new Error(
      `Presidential candidate records payload needs focused repair before import; dropped=${validatedRecords.droppedRecords.length}; ${summarizeDroppedRecords(validatedRecords.droppedRecords)}.${hint}`
    );
  }

  // Same within-payload merge guard as writeManualCandidateRecords: rows
  // sharing an event date and source URL with near-identical descriptions
  // would be collapsed into one stored record by the upsert's similarity
  // dedupe, so the payload is refused until they are differentiated.
  const withinPayloadCollisions = findWithinPayloadRecordCollisions(
    validatedRecords.records.map((record) => ({
      description: record.description,
      sourceUrl: record.source_url,
      eventDate: record.event_date,
    }))
  );
  if (withinPayloadCollisions.length > 0) {
    const gaps: ManualResearchRepairGap[] = withinPayloadCollisions.map((collision) => ({
      id: `candidate_records.within_payload_collision.${collision.firstIndex}.${collision.secondIndex}`,
      stage: "candidate_records",
      objectType: "candidate_record_set",
      outcome: "needs_repair",
      failureKind: "schema",
      reason: `records[${collision.firstIndex}] and records[${collision.secondIndex}] share event_date=${collision.eventDate} and source_url=${collision.sourceUrl} with description similarity ${collision.similarity.toFixed(2)} (>= 0.86): the writer would merge them into one stored record.`,
      recordIndex: collision.secondIndex,
      sourceUrl: collision.sourceUrl,
      eventDate: collision.eventDate,
      focusedResearchPass:
        "If the rows describe the SAME action, keep one. If they are distinct actions, rewrite each description with its distinguishing substance or cite each action's own specific URL, then rerun.",
    }));
    await writeRecordsRepairReport({
      reportFile: options.repairReportFile,
      key,
      options,
      candidateDisplayName: null,
      gaps,
    });
    const preview = withinPayloadCollisions
      .slice(0, 5)
      .map(
        (collision) =>
          `records[${collision.firstIndex}]~records[${collision.secondIndex}] (similarity ${collision.similarity.toFixed(2)}, event_date=${collision.eventDate})`
      )
      .join("; ");
    const extra =
      withinPayloadCollisions.length > 5 ? `; +${withinPayloadCollisions.length - 5} more` : "";
    throw new Error(
      `Presidential candidate records payload contains ${withinPayloadCollisions.length} within-payload similarity collision(s) that the writer would silently merge: ${preview}${extra}. Differentiate the descriptions (or source URLs) of distinct same-day actions, or remove true duplicates, then rerun.`
    );
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const context = await loadCandidatePresidentialCycleOfficeContext(
      pool,
      options.candidateId,
      options.presidentialCycleId,
      options.presidentialRole
    );
    if (!context) {
      throw new Error(
        `Candidate/presidential-cycle link not found for candidate_id=${options.candidateId} presidential_cycle_id=${options.presidentialCycleId} role=${options.presidentialRole}`
      );
    }
    if (!context.officeId) {
      throw new Error(
        `Presidential cycle has no office_id for candidate-record labeling; presidential_cycle_id=${options.presidentialCycleId} role=${options.presidentialRole}`
      );
    }

    const allowedAreas = await loadAllowedResearchAreasForOfficeId(pool, context.officeId);
    if (allowedAreas.length === 0) {
      throw new Error(`No allowed research areas for office_id=${context.officeId}`);
    }
    const { allowedSlugs, researchAreaIdBySlug } = buildNormalizedResearchAreaLookup(allowedAreas);
    const rawLabels = await readJsonFile(options.labelsFile);
    const parsedLabels = parseCandidateRecordAreaLabelPayload(rawLabels, {
      allowedResearchAreaSlugs: allowedSlugs,
      recordCount: validatedRecords.records.length,
      requireLabelForEveryRecord: true,
    });
    if (!parsedLabels.ok) {
      const gaps = [buildRecordLabelParseGap(parsedLabels.reason)];
      await writeRecordsRepairReport({
        reportFile: options.repairReportFile,
        key,
        options,
        candidateDisplayName: context.candidateDisplayName,
        gaps,
      });
      throw new Error(`Presidential candidate record labels payload failed validation: ${parsedLabels.reason}`);
    }

    const qualityGaps = applyConfirmedGaps(
      [
        ...buildCandidateRecordQualityGaps({
          recordCount: validatedRecords.records.length,
          labels: parsedLabels.payload.labels,
        }),
      ],
      options.confirmedGapIds
    );
    const blockingQualityGaps = qualityGaps.filter(isBlockingCandidateRecordQualityGap);

    // Sweep-completeness guard: mirrors manual:candidate-records:write — a
    // zero-record payload, an all-neutral label set (any mode, strict or
    // not), or a completeness confirmed-gap flag asserts a finished
    // discovery sweep and must carry the per-question evidence table.
    // Evaluated AFTER the quality gaps are built so the neutral-only case
    // is caught even without a flag.
    const evidenceIsRequired =
      sweepEvidenceRequired({
        recordCount: validatedRecords.records.length,
        confirmedGapIds: options.confirmedGapIds,
      }) || qualityGaps.some((gap) => SWEEP_COMPLETENESS_GAP_IDS.has(gap.id));
    // A supplied --evidence-file is always parsed and validated, even when
    // the completeness gate does not require it (a stance-bearing record
    // set) — a silently ignored ledger reads as a failed handoff. This
    // writer has no delta mode, so every write is a full-history claim and
    // a validated ledger is always persisted (empty claim set for the
    // stance-bearing case), mirroring manual:candidate-records:write.
    let sweepEvidenceEntries: SweepEvidenceEntry[] | null = null;
    let sweepEvidenceEntryCount: number | null = null;
    let evidenceHasHeldPublicOffice: boolean | null = null;
    if (options.evidenceFile) {
      const parsedEvidence = parseSweepEvidencePayload(await readJsonFile(options.evidenceFile));
      if (!parsedEvidence.ok) {
        throw new Error(`Sweep evidence file failed validation: ${parsedEvidence.reason}`);
      }
      sweepEvidenceEntryCount = parsedEvidence.entries.length;
      evidenceHasHeldPublicOffice = parsedEvidence.hasHeldPublicOffice;
      sweepEvidenceEntries = parsedEvidence.entries;
    } else if (evidenceIsRequired) {
      throw sweepEvidenceMissingError("presidential-records");
    }
    const sweepEvidencePersisted = sweepEvidenceEntries !== null;

    // Route-coverage gate, mirroring manual:candidate-records:write: every
    // ledger here is a full-history claim, so it must be routed and cover
    // its route's question list. Presidential contests are never judicial —
    // the loader hardcodes discoveryContestFamily null — so routing always
    // comes down to the has-EVER-held-public-office answer.
    let sweepRoute: SweepRoute | null = null;
    let persistHasHeldPublicOffice: boolean | null = null;
    if (sweepEvidenceEntries) {
      const coverage = enforceSweepRouteCoverage({
        discoveryContestFamily: context.discoveryContestFamily,
        candidateCurrentOffice: context.currentOffice,
        candidateHasHeldPublicOffice: context.hasHeldPublicOffice,
        evidenceHasHeldPublicOffice,
        entries: sweepEvidenceEntries,
      });
      sweepRoute = coverage.route;
      persistHasHeldPublicOffice = coverage.persistHasHeldPublicOffice;
    }

    if (options.repairReportFile && qualityGaps.length > 0) {
      await writeRecordsRepairReport({
        reportFile: options.repairReportFile,
        key,
        options,
        candidateDisplayName: context.candidateDisplayName,
        gaps: qualityGaps,
      });
    }
    if (options.strictQualityGate && blockingQualityGaps.length > 0) {
      throw new Error(
        `Presidential candidate records quality gate failed; run focused gap-repair pass before import. gaps=${blockingQualityGaps.length}; ${summarizeManualResearchGaps(blockingQualityGaps)}`
      );
    }

    // Warn-only: long sentences fail the plain-language gate's readability
    // rule. Never blocks the write — operator policy is one rewrite bounce,
    // then accept as-is (see candidateRecordPlainLanguageLint.ts).
    const plainLanguageWarnings = listPlainLanguageWarnings(validatedRecords.records);

    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            manualKey: key,
            candidateId: options.candidateId,
            contextType: "presidential_cycle",
            presidentialCycleId: options.presidentialCycleId,
            presidentialRole: options.presidentialRole,
            candidateDisplayName: context.candidateDisplayName,
            recordCount: validatedRecords.records.length,
            labelCount: parsedLabels.payload.labels.length,
            sourceValidation: {
              sourceUrlsReachable: true,
              droppedRecordCount: validatedRecords.droppedRecords.length,
            },
            qualityGate: {
              strict: options.strictQualityGate,
              confirmedGaps: [...options.confirmedGapIds].sort(),
              gaps: qualityGaps,
            },
            plainLanguageWarnings,
            sweepEvidence: {
              required: evidenceIsRequired,
              entryCount: sweepEvidenceEntryCount,
              route: sweepRoute,
              // Plan language: --dry-run writes nothing, so a past-tense
              // `persisted` here would be factually wrong for JSON consumers.
              wouldPersist: sweepEvidencePersisted,
              wouldPersistHasHeldPublicOffice: persistHasHeldPublicOffice,
            },
            allowedResearchAreaSlugs: [...allowedSlugs].sort(),
          },
          null,
          2
        )
      );
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Per-import run id: the manual key alone is stable forever for this
      // cycle/candidate; the timestamp suffix makes each invocation its own
      // cohort (see writeManualCandidateRecords.ts).
      const originRunId = `${key}:${new Date().toISOString()}`;
      const upsert = await upsertCandidateRecords(
        client,
        validatedRecords.records.map((record) => ({
          candidateId: options.candidateId,
          description: record.description,
          sourceUrl: record.source_url,
          eventDate: record.event_date,
          origin: "manual" as const,
          originRunId,
        }))
      );

      const labelsForValidation: CandidateRecordAreaLabelInput[] = parsedLabels.payload.labels.map((label) => {
        const record = validatedRecords.records[label.record_index];
        if (!record) {
          throw new Error(`record_index out of range in labels: ${label.record_index}`);
        }
        const identityKey = buildCandidateRecordIdentityKey({
          description: record.description,
          sourceUrl: record.source_url,
          eventDate: record.event_date,
        });
        const candidateRecordId = upsert.recordIdsByIdentityKey.get(identityKey);
        if (!candidateRecordId) {
          throw new Error(`Missing persisted candidate_record id for record_index=${label.record_index}`);
        }
        return {
          candidateRecordId,
          researchAreaSlug: label.research_area_slug,
          stance: label.stance ?? null,
        };
      });

      const validation = validateCandidateRecordAreaLabels(labelsForValidation, allowedSlugs);
      if (!validation.ok) {
        const reason = validation.failures.map((failure) => failure.reason).join("; ");
        const gaps = buildRecordLabelValidationGaps(validation.failures.map((failure) => failure.reason));
        await writeRecordsRepairReport({
          reportFile: options.repairReportFile,
          key,
          options,
          candidateDisplayName: context.candidateDisplayName,
          gaps,
        });
        throw new Error(`Presidential candidate record label validation failed: ${reason}`);
      }

      const staleTagDelete = await deleteStaleCandidateRecordAreaTags(
        client,
        validation.normalized,
        researchAreaIdBySlug
      );
      const tagResult = await upsertCandidateRecordAreaTags(
        client,
        validation.normalized,
        researchAreaIdBySlug
      );
      // First evidence-backed routing answer for this candidate: persist it
      // inside the transaction (throws on a concurrent opposite answer,
      // rolling back the confirmation with it).
      if (persistHasHeldPublicOffice !== null) {
        await persistHasHeldPublicOfficeAnswer(client, options.candidateId, persistHasHeldPublicOffice);
      }
      // A write that establishes records falsifies any earlier completeness
      // claim (no_records_found / only_general_labels) in ANY context — those
      // claims are candidate-wide because records are. This writer advances no
      // search stamp, so a stale election-context claim could never be dated
      // historical by the audit; drop it here, before the upsert below so a
      // fresh only_general_labels claim is not swept up with the stale ones.
      // Empty-claim evidence ledgers are untouched. When this write carries a
      // ledger, its own context's row is kept: the merge below re-checks its
      // claims against all active records and keeps its prior evidence.
      if (validatedRecords.records.length > 0) {
        await deleteSweepCompletenessConfirmation(
          client,
          options.candidateId,
          sweepEvidenceEntries
            ? {
                exceptContext: {
                  contextType: "presidential_cycle",
                  contextId: options.presidentialCycleId,
                },
              }
            : {}
        );
      }
      // Persist the validated confirmation so manual:records:audit can
      // separate an evidence-backed sweep (confirmed null OR stance-bearing
      // with an empty claim set) from a skipped one.
      let mergedConfirmation: Awaited<ReturnType<typeof writeMergedSweepConfirmation>> | null = null;
      if (sweepEvidenceEntries) {
        mergedConfirmation = await writeMergedSweepConfirmation(client, {
          candidateId: options.candidateId,
          assertedGapIds: assertedSweepCompletenessGapIds({
            recordCount: validatedRecords.records.length,
            confirmedGapIds: options.confirmedGapIds,
            qualityGapIds: qualityGaps.map((gap) => gap.id),
          }),
          entries: sweepEvidenceEntries,
          contextType: "presidential_cycle",
          contextId: options.presidentialCycleId,
        });
      } else {
        // This write found real stance-labeled records without carrying a
        // ledger; the completeness claims are already gone (above), so what
        // remains is this presidential-cycle context's own empty-claim row.
        // Unlike the district writer, this writer advances no per-candidate
        // search stamp, so that row could never be dated as historical —
        // drop it unconditionally.
        await deleteSweepConfirmation(client, {
          candidateId: options.candidateId,
          contextType: "presidential_cycle",
          contextId: options.presidentialCycleId,
        });
      }
      await client.query("COMMIT");

      console.log(
        JSON.stringify(
          {
            manualKey: key,
            candidateId: options.candidateId,
            contextType: "presidential_cycle",
            presidentialCycleId: options.presidentialCycleId,
            presidentialRole: options.presidentialRole,
            inserted: upsert.inserted,
            updated: upsert.updated,
            processed: upsert.processed,
            tagsDeleted: staleTagDelete.deleted,
            tagsProcessed: tagResult.processed,
            sweepEvidence: {
              required: evidenceIsRequired,
              entryCount: sweepEvidenceEntryCount,
              route: sweepRoute,
              persisted: sweepEvidencePersisted,
              persistedHasHeldPublicOffice: persistHasHeldPublicOffice,
              confirmedGapIds: mergedConfirmation?.confirmedGapIds ?? null,
              droppedGapIds: mergedConfirmation?.droppedGapIds ?? null,
              storedEntryCount: mergedConfirmation?.entryCount ?? null,
              otherContextRowsPruned: mergedConfirmation?.otherContextRowsPruned ?? null,
            },
            plainLanguageWarnings,
          },
          null,
          2
        )
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("manual presidential candidate records write failed:", message);
    process.exitCode = 1;
  });
}

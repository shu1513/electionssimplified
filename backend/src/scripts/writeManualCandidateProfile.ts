import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { createClient } from "redis";

import {
  assertCandidatePartyWillNotBeDiscarded,
  resolveIncludePartyForCandidateContest,
} from "../ai/candidatePartisanship.js";
import { resolveCandidateResearchMode } from "../ai/candidateResearchMode.js";
import { validateCandidateProfileAiPayload } from "../ai/enrichCandidateProfile.js";
import { loadProjectEnv } from "../config/env.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { STAGING_ITEM_TYPE_CANDIDATE_ROSTER } from "../config/electionsPipeline.js";
import {
  parseCandidateRosterPayload,
  type CandidateRosterNoFecIdException,
} from "../contracts/candidateRosterPayloadContract.js";
import { assertNoFecIdExceptionProfileHasVerifiedWebsite } from "../pipeline/candidates/candidateRosterNoFecIdException.js";
import {
  isNoPublicInfoSummary,
  type CandidateProfilePayload,
} from "../contracts/candidateProfilePayloadContract.js";
import { enqueueCandidateRecordDrafts } from "../pipeline/candidates/candidateRecordDraftEmitter.js";
import {
  enqueueCandidateProfileFinanceSyncFanoutForLinkedElection,
  type CandidateProfileFinanceSyncFanoutResult,
  type CandidateProfileLinkedElectionContext,
} from "../pipeline/enrichers/candidateProfileEnricher.js";
import {
  findOrCreateCandidateFromProfile,
  hasAtLeastOneHardIdentifier,
  OVERWRITABLE_PROFILE_FIELDS,
  resolveStoredCandidateParty,
  type OverwritableProfileField,
} from "../pipeline/candidates/candidateProfileIdentity.js";
import {
  findTicketLeadCandidateIdByDisplayName,
  setCandidateElectionRunningMate,
  upsertCandidateElection,
} from "../pipeline/candidates/candidateProfileLinks.js";
import { createCandidateFutureElectionNotificationEvents } from "../pipeline/users/candidateFollowNotificationEvents.js";
import {
  buildManualResearchRepairReport,
  summarizeManualResearchGaps,
  writeManualResearchRepairReport,
  type ManualResearchRepairGap,
} from "./manualResearchRepairReport.js";
import { normalizeCandidateName, splitDisplayNameToFirstLast } from "../utils/candidateIdentity.js";

import { assertKnownCliFlags } from "./manualCliFlags.js";
import { WALL_CLOCK_FORCE_EXIT_GRACE_MS, withWallClockTimeout } from "./wallClockTimeout.js";
import { readPositiveIntegerEnv } from "../config/envReaders.js";
type ElectionContextRow = {
  election_id: string;
  district_id: string;
  state: string;
  district_name: string;
  district_type: string;
  election_date: string;
  official_ballot_title: string;
  election_stage: string | null;
  senate_class: string | null;
  term_end_year: string | null;
  is_partisan: boolean | null;
  race_type: string;
  office_scope: string | null;
  office_canonical_name: string | null;
};

type RosterIdentityHints = {
  rosterIndex: number;
  displayName: string;
  party?: string;
  isIncumbent?: boolean;
  fecIds: string[];
  stateFilingIds: string[];
  noFecIdException?: CandidateRosterNoFecIdException;
};

function toReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:candidate-profile:write -- --election-id uuid --file profile.json [--roster-index n] [--running-mate-of \"Lead Ballot Name\"] [--run-id id] [--is-incumbent true|false] [--emit-record-draft] [--emit-finance-sync] [--allow-no-hard-identifier] [--strict-quality-gate] [--confirmed-gap id] [--replace-profile-fields f1,f2] [--clear-profile-fields f1,f2] [--repair-report-file file] [--dry-run]",
    "",
    "Payload must match CandidateProfilePayload (has_held_public_office true|false|null is required: has this person EVER held elected or appointed public office? Answer true/false only from a cited source that carries office history; null means every cited source is silent on it). Stored candidates.has_held_public_office fills only when NULL; pass --replace-profile-fields has_held_public_office to correct a stale stored value — with a payload null, this retracts a false that was asserted from office-history-silent sources.",
    "On a matched existing candidate, profile_sources becomes the UNION of stored + payload sources (stored facts keep their provenance); pass --replace-profile-fields profile_sources to swap in exactly the payload's list (cleanup of dead/disallowed stored URLs).",
    "With --running-mate-of, the profile is written as the joint-ticket running mate: the candidate is created/matched normally, then linked via candidate_elections.running_mate_candidate_id on the ticket lead's row instead of getting an own candidate_elections row. Write the ticket lead's profile first.",
  ].join("\n");
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value;
  }
  const prefix = `${name}=`;
  const match = process.argv.find((token) => token.startsWith(prefix));
  if (!match) {
    return null;
  }
  const value = match.slice(prefix.length);
  if (value.trim().length === 0) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readBooleanFlag(name: string): boolean | undefined {
  const value = readFlag(name);
  if (value === null) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false.\n${usage()}`);
}

function readNonNegativeIntegerFlag(name: string): number | null {
  const value = readFlag(name);
  if (value === null) {
    return null;
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer.\n${usage()}`);
  }
  return Number(value);
}

function readRepeatedFlag(name: string): string[] {
  const values: string[] = [];
  const prefix = `${name}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === name) {
      const value = process.argv[index + 1];
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

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

// A "no public information" summary is only honest while a recheck is
// scheduled: the writer cannot record the deferral itself (the recheck date
// is a research judgment), so it prints the exact command to run next. The
// blocker key names the candidate so the demand ledger and
// manual:candidate-profile:placeholders can match the deferral to this row.
export function noPublicInfoNextStep(
  election: Pick<ElectionContextRow, "election_id" | "district_id">,
  candidateId: string
): string {
  const keySuffix = candidateId.startsWith("<") ? "<first 8 chars of candidateId>" : candidateId.slice(0, 8);
  return (
    `Summary is the no-public-information placeholder. Record the recheck: npm run manual:deferral:record -- ` +
    `--district-id ${election.district_id} --election-id ${election.election_id} --blocker-key profile-${keySuffix} ` +
    `--stage candidate_profile --reason "insufficient public profile: <what was searched>" --blocked-until <YYYY-MM-DD>. ` +
    `On recheck, replace it with --replace-profile-fields summary, then manual:deferral:resolve.`
  );
}

async function loadElectionContext(pool: Pool, electionId: string): Promise<ElectionContextRow | null> {
  const result = await pool.query<ElectionContextRow>(
    `
      SELECT
        e.id::text AS election_id,
        e.district_id::text AS district_id,
        d.state,
        d.name AS district_name,
        d.district_type,
        e.election_date::text AS election_date,
        e.official_ballot_title,
        e.election_stage::text AS election_stage,
        sm.senate_class,
        sm.term_end_year,
        e.is_partisan,
        e.race_type,
        office.scope AS office_scope,
        office.canonical_name AS office_canonical_name
      FROM public.elections AS e
      JOIN public.districts AS d
        ON d.id = e.district_id
      LEFT JOIN public.offices AS office
        ON office.id = e.office_id
      LEFT JOIN public.election_senate_metadata AS sm
        ON sm.election_id = e.id
      WHERE e.id::text = $1
      LIMIT 1
    `,
    [electionId]
  );
  return result.rows[0] ?? null;
}

async function loadExistingCandidateElectionIncumbency(
  client: Pick<PoolClient, "query">,
  input: { candidateId: string; electionId: string }
): Promise<boolean | null> {
  const result = await client.query<{ is_incumbent: boolean }>(
    `
      SELECT is_incumbent
      FROM public.candidate_elections
      WHERE candidate_id = $1
        AND election_id = $2
      LIMIT 1
    `,
    [input.candidateId, input.electionId]
  );
  return result.rows[0]?.is_incumbent ?? null;
}

function normalizeStringArray(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}

function displayNamesReferToSameCandidate(left: string, right: string): boolean {
  if (left.trim() === right.trim()) {
    return true;
  }
  const leftName = splitDisplayNameToFirstLast(left);
  const rightName = splitDisplayNameToFirstLast(right);
  return normalizeCandidateName(`${leftName.firstName} ${leftName.lastName}`) ===
    normalizeCandidateName(`${rightName.firstName} ${rightName.lastName}`);
}

async function loadRosterIdentityHints(input: {
  pool: Pool;
  electionId: string;
  displayName: string;
  rosterIndex: number | null;
  allowFecIds: boolean;
  requireFecIds: boolean;
}): Promise<RosterIdentityHints | null> {
  const result = await input.pool.query<{ payload: unknown }>(
    `
      SELECT payload
      FROM public.staging_items
      WHERE ingest_key = $1
        AND item_type = $2
        AND status IN ('validated', 'written')
      LIMIT 1
    `,
    [`candidate_roster:${input.electionId}`, STAGING_ITEM_TYPE_CANDIDATE_ROSTER]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const parsed = parseCandidateRosterPayload(row.payload, {
    allowFecIds: input.allowFecIds,
    requireFecIds: input.requireFecIds,
    // Re-parse of an already-written staging payload: rosters imported before
    // the source-domain policy can carry a now-blocked URL, and a profile
    // write must not fail over evidence the roster write already accepted.
    enforceSourcePolicy: false,
    // The staged row was already accepted by the manual inject, the only
    // import path that lets the exception in.
    allowNoFecIdException: true,
  });
  if (!parsed.ok) {
    throw new Error(`Candidate roster staging payload failed validation for this election context: ${parsed.reason}`);
  }
  const rawCandidates = (row.payload as { candidates: unknown[] }).candidates;

  const candidates = parsed.payload.candidates.map((candidate, index) => {
    // Parsed candidates may be a filtered subset of the raw rows (federal
    // no-FEC-ID policy), so raw hints must come from the original row position.
    const rawIndex = parsed.keptCandidateIndexes[index] ?? index;
    const raw = rawCandidates[rawIndex];
    const rawObject = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const rosterIndex =
      Number.isInteger(rawObject.roster_index) && Number(rawObject.roster_index) >= 0
        ? Number(rawObject.roster_index)
        : rawIndex;
    return {
      rosterIndex,
      displayName: candidate.display_name,
      fecIds: normalizeStringArray(candidate.fec_ids),
      stateFilingIds: normalizeStringArray(candidate.state_filing_ids),
      ...(candidate.party ? { party: candidate.party } : {}),
      ...(candidate.is_incumbent !== undefined ? { isIncumbent: candidate.is_incumbent } : {}),
      ...(candidate.no_fec_id_exception ? { noFecIdException: candidate.no_fec_id_exception } : {}),
    } satisfies RosterIdentityHints;
  });

  if (input.rosterIndex !== null) {
    const match = candidates.find((candidate) => candidate.rosterIndex === input.rosterIndex);
    if (!match) {
      throw new Error(`No candidate roster row found for roster_index=${input.rosterIndex}`);
    }
    if (!displayNamesReferToSameCandidate(match.displayName, input.displayName)) {
      throw new Error(
        `Profile display_name (${input.displayName}) does not match roster_index=${input.rosterIndex} display_name (${match.displayName}).`
      );
    }
    return match;
  }

  const matches = candidates.filter((candidate) => displayNamesReferToSameCandidate(candidate.displayName, input.displayName));
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple candidate roster rows match display_name=${input.displayName}; rerun with --roster-index to select the exact roster draft context.`
    );
  }
  return matches[0]!;
}

export function applyRegularElectionProfileContext(input: {
  profile: CandidateProfilePayload;
  researchMode: ReturnType<typeof resolveCandidateResearchMode>;
  rosterHints: RosterIdentityHints | null;
}): CandidateProfilePayload {
  const { party: _party, ...withoutParty } = input.profile;
  if (input.researchMode !== "state_level") {
    const fecIds = normalizeStringArray(input.rosterHints?.fecIds);
    const noFecIdException = fecIds.length === 0 ? input.rosterHints?.noFecIdException : undefined;
    if (fecIds.length === 0 && !noFecIdException) {
      throw new Error("candidate_fec_ids is required in roster context for federal profile import");
    }
    if (noFecIdException) {
      // No FEC ID to match on, so the campaign website is the identifier that
      // keeps identity matching and duplicate prevention working. It must be
      // on a cited host: cited sources are the URLs this writer verifies.
      assertNoFecIdExceptionProfileHasVerifiedWebsite(withoutParty);
    }
    // The regular federal profile path stores date_of_birth as null (the AI
    // prompt tells the model to omit it). Refuse instead of silently
    // stripping: a manual payload that carries it either followed stale
    // guidance or expects the value to persist — neither should pass quietly.
    if (withoutParty.date_of_birth !== undefined) {
      throw new Error(
        "payload.date_of_birth is not allowed for federal contests; backend policy stores it as null — remove it from the profile payload"
      );
    }
    const { state_filing_ids: _stateFilingIds, ...federalProfile } = withoutParty;
    return noFecIdException
      ? federalProfile
      : {
          ...federalProfile,
          fec_ids: fecIds,
        };
  }

  const stateFilingIds = normalizeStringArray(input.rosterHints?.stateFilingIds);
  const { state_filing_ids: _stateFilingIds, ...stateProfile } = withoutParty;
  return stateFilingIds.length > 0
    ? {
        ...stateProfile,
        state_filing_ids: stateFilingIds,
      }
    : stateProfile;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual candidate profile write`);
  }
  return value;
}

function normalizeConfirmedGaps(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function buildLinkedElectionFinanceContext(input: {
  election: ElectionContextRow;
  includeParty: boolean;
  profileParty: string | null | undefined;
  isIncumbent: boolean | undefined;
}): CandidateProfileLinkedElectionContext {
  return {
    type: "election",
    contextId: input.election.election_id,
    state: input.election.state,
    districtName: input.election.district_name,
    districtType: input.election.district_type,
    electionDate: input.election.election_date,
    officialBallotTitle: input.election.official_ballot_title,
    electionStage: input.election.election_stage,
    senateClass: input.election.senate_class,
    termEndYear: input.election.term_end_year,
    electionIsPartisan: input.election.is_partisan,
    officeScope: input.election.office_scope,
    officeCanonicalName: input.election.office_canonical_name,
    includeParty: input.includeParty,
    rosterParty: input.includeParty ? input.profileParty ?? undefined : undefined,
    rosterIncumbent: input.isIncumbent,
    seedUrls: [],
  };
}

export function applyConfirmedGaps(
  gaps: readonly ManualResearchRepairGap[],
  confirmedGapIds: ReadonlySet<string>
): ManualResearchRepairGap[] {
  return gaps.map((gap) =>
    gap.outcome === "needs_repair" && confirmedGapIds.has(gap.id)
      ? {
          ...gap,
          outcome: "confirmed_null",
          reason: `${gap.reason} Operator marked this gap confirmed_null after focused repair research.`,
        }
      : gap
  );
}

function buildProfileValidationGaps(input: {
  reason: string;
  failedCitationUrls?: readonly string[];
}): ManualResearchRepairGap[] {
  const sourceUrls = [...new Set(input.failedCitationUrls ?? [])];
  if (sourceUrls.length > 0) {
    return sourceUrls.map((sourceUrl, index) => ({
      id: `candidate_profile.sources.${index + 1}`,
      stage: "candidate_profile",
      objectType: "candidate_profile",
      outcome: "needs_repair",
      field: "sources",
      sourceUrl,
      failureKind: "source_url",
      reason: input.reason,
      promptFile: "src/ai/providers/candidateProfilePrompt.ts",
      focusedResearchPass:
        "Run a focused candidate-profile source repair pass. Replace unreachable or bad profile source URLs with reliable public URLs, then rerun the manual profile writer.",
    }));
  }
  return [{
    id: "candidate_profile.payload",
    stage: "candidate_profile",
    objectType: "candidate_profile",
    outcome: "needs_repair",
    failureKind: "schema",
    reason: input.reason,
    promptFile: "src/ai/providers/candidateProfilePrompt.ts",
    focusedResearchPass:
      "Run a focused candidate-profile payload repair pass. Fix only the schema issue, then rerun the manual profile writer.",
  }];
}

export function buildCandidateProfileQualityGaps(input: {
  profile: CandidateProfilePayload;
  includeParty: boolean;
}): ManualResearchRepairGap[] {
  const gaps: ManualResearchRepairGap[] = [];
  if (!input.profile.summary) {
    gaps.push({
      id: "candidate_profile.summary",
      stage: "candidate_profile",
      objectType: "candidate_profile",
      outcome: "needs_repair",
      field: "summary",
      failureKind: "quality_gap",
      reason: "Candidate profile summary is missing.",
      promptFile: "src/ai/providers/candidateProfilePrompt.ts",
      focusedResearchPass: "Run a focused summary-only profile pass for this candidate. Write a short neutral source-backed summary, or mark candidate_profile.summary confirmed_null if no reliable summary can be found.",
    });
  }
  if (!input.profile.official_website_url) {
    gaps.push({
      id: "candidate_profile.official_website_url",
      stage: "candidate_profile",
      objectType: "candidate_profile",
      outcome: "needs_repair",
      field: "official_website_url",
      failureKind: "quality_gap",
      reason: "Candidate official website URL is missing.",
      promptFile: "src/ai/providers/candidateProfilePrompt.ts",
      focusedResearchPass: "Run a focused official-website-only profile pass for this candidate. Add the source-backed official website, or mark candidate_profile.official_website_url confirmed_null if none exists.",
    });
  }
  if (input.includeParty && !input.profile.party) {
    gaps.push({
      id: "candidate_profile.party",
      stage: "candidate_profile",
      objectType: "candidate_profile",
      outcome: "needs_repair",
      field: "party",
      failureKind: "quality_gap",
      reason: "Partisan candidate profile is missing party.",
      promptFile: "src/ai/providers/candidateProfilePrompt.ts",
      focusedResearchPass: "Run a focused party-only profile pass using official roster/filing sources. Add party if source-backed, or mark candidate_profile.party confirmed_null if no reliable party exists.",
    });
  }
  // null is a legal contract answer ("no cited source carries office
  // history"), but it leaves the record sweep unrouted — so it is a gap
  // driving a focused pass against a source that DOES carry office history
  // (financial disclosure, voter pamphlet, official bio), not a free pass.
  if (input.profile.has_held_public_office == null) {
    gaps.push({
      id: "candidate_profile.has_held_public_office",
      stage: "candidate_profile",
      objectType: "candidate_profile",
      outcome: "needs_repair",
      field: "has_held_public_office",
      failureKind: "quality_gap",
      reason: "Candidate office-history routing answer is unresolved (no cited source carries office history).",
      promptFile: "src/ai/providers/candidateProfilePrompt.ts",
      focusedResearchPass:
        "Run a focused office-history-only profile pass using a source that carries office history (financial disclosure, voter pamphlet, official bio). Set has_held_public_office true/false from that source via --replace-profile-fields has_held_public_office, or mark candidate_profile.has_held_public_office confirmed_null if no such source exists.",
    });
  }
  if (!input.profile.current_office) {
    gaps.push({
      id: "candidate_profile.current_office",
      stage: "candidate_profile",
      objectType: "candidate_profile",
      outcome: "needs_repair",
      field: "current_office",
      failureKind: "quality_gap",
      reason: "Candidate current office is missing.",
      promptFile: "src/ai/providers/candidateProfilePrompt.ts",
      focusedResearchPass: "Run a focused current-office-only profile pass for this candidate. Use only source-backed current elected, appointed, or public office; mark candidate_profile.current_office confirmed_null if none exists.",
    });
  }
  return gaps;
}

async function writeProfileRepairReport(input: {
  reportFile: string | null;
  manualKey: string;
  electionId: string;
  file: string;
  displayName?: string | null;
  gaps: ManualResearchRepairGap[];
}): Promise<void> {
  await writeManualResearchRepairReport(
    input.reportFile,
    buildManualResearchRepairReport({
      command: "manual:candidate-profile:write",
      manualKey: input.manualKey,
      target: {
        electionId: input.electionId,
        file: input.file,
        displayName: input.displayName ?? null,
      },
      gaps: input.gaps,
    })
  );
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:candidate-profile:write", process.argv.slice(2), [{ name: "--election-id", value: "space" }, { name: "--file", value: "space" }, { name: "--roster-index", value: "space" }, { name: "--running-mate-of", value: "space" }, { name: "--run-id", value: "space" }, { name: "--is-incumbent", value: "space" }, { name: "--confirmed-gap", value: "space" }, { name: "--replace-profile-fields", value: "space" }, { name: "--clear-profile-fields", value: "space" }, { name: "--repair-report-file", value: "space" }, { name: "--emit-record-draft", value: "none" }, { name: "--emit-finance-sync", value: "none" }, { name: "--allow-no-hard-identifier", value: "none" }, { name: "--strict-quality-gate", value: "none" }, { name: "--dry-run", value: "none" }]);
  loadProjectEnv();

  const file = readFlag("--file");
  const electionId = readFlag("--election-id");
  const repairReportFile = readFlag("--repair-report-file");
  const strictQualityGate = hasFlag("--strict-quality-gate");
  const confirmedGapIds = normalizeConfirmedGaps(readRepeatedFlag("--confirmed-gap"));
  const parseProfileFieldListFlag = (flagName: string): Set<OverwritableProfileField> => {
    const rawValue = readFlag(flagName);
    const fields = new Set<OverwritableProfileField>();
    if (!rawValue) {
      return fields;
    }
    for (const raw of rawValue.split(",")) {
      const field = raw.trim();
      if (!field) {
        continue;
      }
      if (!(OVERWRITABLE_PROFILE_FIELDS as readonly string[]).includes(field)) {
        throw new Error(
          `${flagName}: unknown field "${field}". Allowed: ${OVERWRITABLE_PROFILE_FIELDS.join(", ")}`
        );
      }
      fields.add(field as OverwritableProfileField);
    }
    return fields;
  };
  const overwriteProfileFields = parseProfileFieldListFlag("--replace-profile-fields");
  const clearProfileFields = parseProfileFieldListFlag("--clear-profile-fields");
  const clearReplaceOverlap = [...clearProfileFields].filter((field) => overwriteProfileFields.has(field));
  if (clearReplaceOverlap.length > 0) {
    throw new Error(
      `--clear-profile-fields and --replace-profile-fields cannot share fields (${clearReplaceOverlap.join(", ")}): clearing sets NULL, replacing needs a payload value — pick one intent per field`
    );
  }
  if (
    clearProfileFields.has("has_held_public_office") ||
    clearProfileFields.has("party") ||
    clearProfileFields.has("profile_sources")
  ) {
    // The contract requires an answer on every payload, so a clear would
    // always conflict with the supplied value; the correction path is replace.
    throw new Error(
      "--clear-profile-fields does not support party, has_held_public_office, or profile_sources; use --replace-profile-fields to correct the stored value"
    );
  }
  if (!file || !electionId) {
    throw new Error(`Missing --file or --election-id.\n${usage()}`);
  }

  const rawPayload = await readJsonFile(file);
  const fallbackManualKey = `manual:candidate-profile:${electionId}:payload`;
  const dryRun = hasFlag("--dry-run");
  const emitRecordDraft = hasFlag("--emit-record-draft");
  const emitFinanceSync = hasFlag("--emit-finance-sync");
  const runId = readFlag("--run-id") ?? `manual_candidate_profile_${new Date().toISOString()}`;
  const runningMateOf = readFlag("--running-mate-of");
  const isIncumbent = readBooleanFlag("--is-incumbent");
  const rosterIndex = readNonNegativeIntegerFlag("--roster-index");
  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  // Running mates never emit record drafts for the ticket election, so do not
  // demand REDIS_URL for them even when --emit-record-draft is set.
  const redisUrl = emitRecordDraft && !dryRun && !runningMateOf ? requireEnv("REDIS_URL") : null;

  const pool = new Pool({ connectionString: databaseUrl });
  const redis = redisUrl ? createClient({ url: redisUrl }) : null;

  try {
    const election = await loadElectionContext(pool, electionId);
    if (!election) {
      throw new Error(`Election not found for election_id=${electionId}`);
    }
    if (election.race_type !== "office") {
      throw new Error(`Candidate profile write requires an office election; election_id=${electionId} has race_type=${election.race_type}`);
    }
    const researchMode = resolveCandidateResearchMode({
      districtType: election.district_type,
      officialBallotTitle: election.official_ballot_title,
    });
    const includeFecIds = researchMode !== "state_level";
    const includeParty = resolveIncludePartyForCandidateContest({
      districtType: election.district_type,
      state: election.state,
      officialBallotTitle: election.official_ballot_title,
      electionIsPartisan: election.is_partisan,
    });
    const validatedProfile = await withWallClockTimeout(
      validateCandidateProfileAiPayload(
        rawPayload,
        readPositiveIntegerEnv("AI_TIMEOUT_MS", 90000),
        { allowFecIds: false, requireFecIds: false }
      ),
      "candidate profile source validation",
      { forceExitAfterMs: WALL_CLOCK_FORCE_EXIT_GRACE_MS }
    );
    if (!validatedProfile.ok) {
      const gaps = buildProfileValidationGaps({
        reason: validatedProfile.reason,
        failedCitationUrls: validatedProfile.failedCitationUrls,
      });
      await writeProfileRepairReport({
        reportFile: repairReportFile,
        manualKey: fallbackManualKey,
        electionId,
        file,
        displayName: null,
        gaps,
      });
      throw new Error(`Candidate profile payload failed validation: ${validatedProfile.reason}`);
    }

    let rosterHints: RosterIdentityHints | null;
    let profile: CandidateProfilePayload;
    try {
      rosterHints = await loadRosterIdentityHints({
        pool,
        electionId,
        displayName: validatedProfile.profile.display_name,
        rosterIndex,
        allowFecIds: includeFecIds,
        requireFecIds: includeFecIds,
      });
      profile = applyRegularElectionProfileContext({
        profile: validatedProfile.profile,
        researchMode,
        rosterHints,
      });
    } catch (error) {
      const reason = toReason(error);
      await writeProfileRepairReport({
        reportFile: repairReportFile,
        manualKey: fallbackManualKey,
        electionId,
        file,
        displayName: validatedProfile.profile.display_name,
        gaps: [{
          id: "candidate_profile.roster_identity",
          stage: "candidate_profile",
          objectType: "candidate_profile",
          outcome: "needs_repair",
          failureKind: "schema",
          reason,
          promptFile: "src/ai/providers/candidateRosterPrompt.ts",
          focusedResearchPass:
            "Repair the candidate roster payload for this election so it carries the same hard identifier context the regular app profile flow requires, then rerun the manual profile writer.",
        }],
      });
      throw error;
    }
    const noPublicInfoSummary = isNoPublicInfoSummary(profile.summary);

    // A field cannot be cleared and supplied in the same write: the payload
    // value would say "store this" while the flag says "store NULL".
    // profile_sources is not a payload key (the payload calls it "sources")
    // and was already rejected from --clear-profile-fields above.
    const clearedFieldsWithPayloadValue = [...clearProfileFields].filter(
      (field) => field !== "profile_sources" && profile[field] !== undefined
    );
    if (clearedFieldsWithPayloadValue.length > 0) {
      throw new Error(
        `--clear-profile-fields lists fields the profile payload also supplies (${clearedFieldsWithPayloadValue.join(", ")}); remove them from the payload or drop them from the flag`
      );
    }

    const manualKey = `manual:candidate-profile:${electionId}:${profile.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    if (!hasFlag("--allow-no-hard-identifier") && !hasAtLeastOneHardIdentifier(profile)) {
      const gaps = buildProfileValidationGaps({
        reason: "Candidate profile has no hard identifier.",
      });
      await writeProfileRepairReport({
        reportFile: repairReportFile,
        manualKey,
        electionId,
        file,
        displayName: profile.display_name,
        gaps,
      });
      throw new Error(
        "Candidate profile has no hard identifier. Add official_website_url, roster FEC/state filing ID, DOB, Twitter, LinkedIn, or pass --allow-no-hard-identifier deliberately."
      );
    }

    const sourcedParty = rosterHints?.party ?? validatedProfile.profile.party;
    assertCandidatePartyWillNotBeDiscarded({
      includeParty,
      partyLabels: [rosterHints?.party, validatedProfile.profile.party],
    });
    const rosterParty = includeParty ? sourcedParty : undefined;
    if (overwriteProfileFields.has("party") && includeParty && !rosterParty) {
      throw new Error(
        "--replace-profile-fields party requires a source-backed party in the staged roster or profile payload"
      );
    }
    const effectiveStoredParty = resolveStoredCandidateParty({
      includeParty,
      rosterParty,
      profileParty: validatedProfile.profile.party,
    });
    const effectiveInputIncumbency = isIncumbent ?? rosterHints?.isIncumbent;
    const qualityGaps = applyConfirmedGaps(
      buildCandidateProfileQualityGaps({
        profile: rosterParty ? { ...profile, party: rosterParty } : profile,
        includeParty,
      }),
      confirmedGapIds
    );
    const blockingQualityGaps = qualityGaps.filter((gap) => gap.outcome === "needs_repair");
    if (repairReportFile && qualityGaps.length > 0) {
      await writeProfileRepairReport({
        reportFile: repairReportFile,
        manualKey,
        electionId,
        file,
        displayName: profile.display_name,
        gaps: qualityGaps,
      });
    }
    if (strictQualityGate && blockingQualityGaps.length > 0) {
      throw new Error(
        `Candidate profile quality gate failed; run focused gap-repair pass before import. gaps=${blockingQualityGaps.length}; ${summarizeManualResearchGaps(blockingQualityGaps)}`
      );
    }

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            manualKey,
            runId,
            electionId: election.election_id,
            displayName: profile.display_name,
            ...(noPublicInfoSummary
              ? { noPublicInfoSummary: true, noPublicInfoNextStep: noPublicInfoNextStep(election, "<candidateId>") }
              : {}),
            hasHardIdentifier: hasAtLeastOneHardIdentifier(profile),
            emitRecordDraft,
            emitFinanceSync,
            state: election.state,
            raceType: election.race_type,
            districtType: election.district_type,
            officialBallotTitle: election.official_ballot_title,
            electionIsPartisan: election.is_partisan,
            includeParty,
            effectiveStoredParty,
            researchMode,
            rosterIdentity: {
              matched: Boolean(rosterHints),
              rosterIndex: rosterHints?.rosterIndex ?? null,
              fecIds: rosterHints?.fecIds ?? [],
              noFecIdException: rosterHints?.noFecIdException ?? null,
              stateFilingIds: rosterHints?.stateFilingIds ?? [],
              party: rosterHints?.party ?? null,
              isIncumbent: rosterHints?.isIncumbent ?? null,
            },
            financeSync: {
              wouldEmit: emitFinanceSync,
              officeScope: election.office_scope,
              officeCanonicalName: election.office_canonical_name,
              fecIds: profile.fec_ids ?? [],
            },
            sourceValidation: {
              sourceUrlsReachable: true,
              sourceCount: validatedProfile.sourceCount,
              sources: profile.sources,
            },
            qualityGate: {
              strict: strictQualityGate,
              confirmedGaps: [...confirmedGapIds].sort(),
              gaps: qualityGaps,
            },
            replaceProfileFields: [...overwriteProfileFields].sort(),
            clearProfileFields: [...clearProfileFields].sort(),
            // Candidate identity is resolved only on the live run, so a
            // passing dry-run cannot promise the clear will apply.
            ...(clearProfileFields.size > 0
              ? {
                  clearProfileFieldsNote:
                    "clearing requires an existing candidate match; identity resolves on the live run — if no candidate matches, the live run refuses and rolls back",
                }
              : {}),
          },
          null,
          2
        )
      );
      return;
    }

    const client = await pool.connect();
    let candidateId: string;
    let matchedExisting: boolean;
    let candidateElectionCreated = false;
    let effectiveIncumbency = false;
    let runningMateLinkedToCandidateId: string | null = null;
    try {
      await client.query("BEGIN");
      const candidateResult = await findOrCreateCandidateFromProfile({
        client,
        profile,
        state: election.state,
        rosterParty,
        includeParty,
        matchByLinkedElectionId: electionId,
        overwriteProfileFields,
        clearProfileFields,
      });
      candidateId = candidateResult.candidateId;
      matchedExisting = candidateResult.matchedExisting;
      if (clearProfileFields.size > 0 && !matchedExisting) {
        // Clearing targets stale stored values; a freshly inserted candidate
        // has none. Roll back rather than silently no-op the operator's
        // stated intent — this usually means the profile matched nothing.
        throw new Error(
          `--clear-profile-fields was requested but no existing candidate matched this profile (a new row would have been inserted); verify the identity fields, or re-run without the flag`
        );
      }

      if (runningMateOf) {
        // Joint-ticket running mate: link to the ticket lead's
        // candidate_elections row instead of creating an own row.
        const lead = await findTicketLeadCandidateIdByDisplayName({
          db: client,
          electionId,
          leadDisplayName: runningMateOf,
        });
        if (!lead.ok) {
          throw new Error(
            lead.reason === "ambiguous"
              ? `Multiple ticket lead candidates match display_name "${runningMateOf}" for this election; resolve the lead identity first.`
              : `Ticket lead candidate not found for display_name "${runningMateOf}" in this election. Write the ticket lead's profile first, then re-run.`
          );
        }
        if (lead.candidateId === candidateId) {
          throw new Error(
            `Running mate profile resolved to the ticket lead candidate for "${runningMateOf}"; the two ticket members must be different people.`
          );
        }
        await setCandidateElectionRunningMate({
          db: client,
          electionId,
          candidateId: lead.candidateId,
          runningMateCandidateId: candidateId,
        });
        runningMateLinkedToCandidateId = lead.candidateId;
      } else {
        const existingIncumbency = await loadExistingCandidateElectionIncumbency(client, {
          candidateId,
          electionId,
        });
        effectiveIncumbency = effectiveInputIncumbency ?? existingIncumbency ?? false;

        const linkResult = await upsertCandidateElection({
          client,
          candidateId,
          electionId,
          isIncumbent: effectiveIncumbency,
        });
        candidateElectionCreated = linkResult.created;
        if (linkResult.created) {
          await createCandidateFutureElectionNotificationEvents(client, {
            candidateId,
            electionId,
          });
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    let recordDraft: { emittedCount: number; skippedCount: number } | null = null;
    let financeSync: CandidateProfileFinanceSyncFanoutResult | null = null;
    // Running mates are not ballot candidates for this election: no finance
    // fanout and no record drafts for the ticket election.
    if (emitFinanceSync && !runningMateOf) {
      try {
        financeSync = await enqueueCandidateProfileFinanceSyncFanoutForLinkedElection({
          context: buildLinkedElectionFinanceContext({
            election,
            includeParty,
            profileParty: rosterParty,
            isIncumbent: effectiveIncumbency,
          }),
          candidateId,
          fecIds: profile.fec_ids,
        });
      } catch (error) {
        throw new Error(
          `Candidate profile DB write committed for candidate_id=${candidateId} election_id=${electionId}, but finance-sync fanout failed: ${toReason(error)}. Recovery: re-run this command with --emit-finance-sync after Redis/scheduler dependencies are available; candidate/election writes are idempotent.`
        );
      }
    }
    if (redis && !runningMateOf) {
      try {
        await redis.connect();
        recordDraft = await enqueueCandidateRecordDrafts(redis, [{ candidateId, electionId, runId }]);
      } catch (error) {
        throw new Error(
          `Candidate profile DB write committed for candidate_id=${candidateId} election_id=${electionId}, but record-draft Redis emit failed: ${toReason(error)}. Recovery: re-run this command with --emit-record-draft after Redis is available; candidate/election writes are idempotent.`
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          manualKey,
          runId,
          electionId,
          candidateId,
          matchedExisting,
          candidateElectionCreated,
          ...(noPublicInfoSummary
            ? { noPublicInfoSummary: true, noPublicInfoNextStep: noPublicInfoNextStep(election, candidateId) }
            : {}),
          ...(clearProfileFields.size > 0 ? { clearedProfileFields: [...clearProfileFields].sort() } : {}),
          ...(runningMateLinkedToCandidateId
            ? { runningMateOf: runningMateOf, ticketLeadCandidateId: runningMateLinkedToCandidateId }
            : {}),
          financeSync,
          recordDraft,
        },
        null,
        2
      )
    );
  } finally {
    if (redis) {
      await redis.quit().catch(() => undefined);
    }
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("manual candidate profile write failed:", message);
    process.exitCode = 1;
  });
}

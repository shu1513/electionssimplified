import { Pool } from "pg";
import { createClient } from "redis";

import { getPipelineEnv } from "../../config/env.js";
import {
  STAGING_DRAFT_STREAM,
  STAGING_ELECTIONS_VALIDATOR_GROUP,
  STAGING_ITEM_TYPE_ELECTION,
  STAGING_PENDING_STREAM,
  STAGING_REJECTED_STREAM,
  STAGING_VALIDATED_STREAM,
} from "../../config/electionsPipeline.js";
import {
  ELECTION_DRAFT_SCHEMA_VERSION,
  ELECTION_ENRICHMENT_SCHEMA_VERSION,
} from "../../contracts/electionEnrichmentContract.js";
import { parseCanonicalElectionPayload } from "../../contracts/electionPayloadContract.js";
import type { ElectionDistrictType, ElectionEnrichedPayload, ElectionEntryPayload } from "../../types/election.js";
import { filterPresidentialElectionEntries } from "../../utils/presidentialOffice.js";
import { congressionalDistrictBoardOfficeName } from "../../utils/congressionalDistrictBoardOffice.js";
import { isUsSenateOfficeTitle } from "../../utils/senateOffice.js";
import { isDcWardStateBoardOfEducationTitle } from "../elections/officeMatcher.js";

type ValidatorOptions = {
  once?: boolean;
  batchSize?: number;
  blockMs?: number;
  // Targeted mode: validate ONE staging row by ingest_key directly, without
  // reading the pending stream. The row's stale stream message stays in the
  // backlog; when a later drain reaches it, the status check acks and skips
  // it. This lets a fresh manual inject proceed when the stream holds
  // thousands of stale messages that would starve a default --once batch.
  ingestKey?: string;
};

type ValidationSeverity = "pass" | "soft_fail" | "hard_fail";

type ValidationResult = {
  severity: ValidationSeverity;
  reasons: string[];
};

type PresidentialEntryFilterResult = {
  payload: ElectionEnrichedPayload;
  removedTitles: string[];
};

type StagingRow = {
  ingest_key: string;
  payload: unknown;
  status: string;
  run_id: string | null;
  reason: string | null;
  failure_debug: unknown;
  ai_raw_debug: unknown;
  schema_version: string | null;
};

// Validation + DB writes can exceed tens of seconds; reclaim entries only after generous idle time.
const RECLAIM_MIN_IDLE_MS = 240_000;
const RECLAIM_MAX_BATCHES = 20;

function toReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSoftRetryCount(failureDebug: unknown): number {
  if (!isObjectRecord(failureDebug)) {
    return 0;
  }
  const raw = failureDebug.soft_retry_count;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

function isHistoricalImportApproved(aiRawDebug: unknown): boolean {
  return isObjectRecord(aiRawDebug) &&
    aiRawDebug.manual_research === true &&
    aiRawDebug.historical_import_approved === true;
}

function isManualResearchRow(aiRawDebug: unknown): boolean {
  return isObjectRecord(aiRawDebug) && aiRawDebug.manual_research === true;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const STATE_UPPER_STRICT_MARKERS = [
  /\bstate senate\b/,
  /\bstate senator\b/,
  /\bsenate district\b/,
  /\bsenator district\b/,
  /\bsenator,\s*district\b/,
  /\bmember of the senate\b/,
  /\bmember of the state senate\b/,
  // "the" is optional: Rhode Island's official ballot title drops it
  // ("SENATOR IN GENERAL ASSEMBLY", RI Dept. of State candidate list, live) —
  // matching the general-court marker below and both general-assembly forms
  // already carried in STATE_LOWER_MARKERS.
  /\bsenator in (?:the )?general assembly\b/,
  /\bsenator in (?:the )?general court\b/,
  /\bupper chamber\b/,
];

const STATE_UPPER_MARKERS = [
  ...STATE_UPPER_STRICT_MARKERS,
  /\bmember of the legislature\b/,
  /\blegislature district\b/,
  /\blegislative district\b/,
  /\bstate legislature district\b/,
  // Illinois' official candidate list titles the contest by ordinal alone
  // ("3RD SENATE", live). US Senate races carry no ordinal-district form, so
  // this cannot mis-capture a federal contest. Soft-marker list only — not a
  // strict marker, so it never drives hard scope mismatches on other types.
  /\b\d+(?:st|nd|rd|th) senate\b/,
];

const STATE_LOWER_STRICT_MARKERS = [
  /\bstate house\b/,
  /\bstate representative\b/,
  /\bstate delegate\b/,
  /\bhouse delegate\b/,
  /\bhouse of representatives district\b/,
  // "(?<!\bcity )" — El Paso titles its council members "City Representative
  // District N", which is a municipal seat, not a state-house race.
  /(?<!\bcity )\brepresentative district\b/,
  /\bmember of the house of representatives\b/,
  /\bmember,\s*house of representatives\b/,
  /\bstate assembly\b/,
  /\bassembly district\b/,
  /\bassemblymember\b/,
  /\bassembly member\b/,
  /\bmember of the assembly\b/,
  /\bmember of the state assembly\b/,
  /\bhouse of delegates\b/,
  /\bdelegate district\b/,
  /\bmember of the house of delegates\b/,
  /\bmember,\s*house of delegates\b/,
  /\blower chamber\b/,
];

const STATE_LOWER_MARKERS = [
  ...STATE_LOWER_STRICT_MARKERS,
  /\brepresentative in the general assembly\b/,
  /\brepresentative in general assembly\b/,
  /\brepresentative in the general court\b/,
  /\brepresentative in general court\b/,
  /\bgeneral assembly district\b/,
  /\bmember of the general assembly\b/,
  /\bgeneral court district\b/,
  /\bmember of the general court\b/,
];

// Titles that clearly signal a school-board contest. "schools?" covers both
// "* School District" and "* City Schools" naming; "Governing Board" (AZ) and
// "Board of Trustees" (NV and others) are official school-board titles in
// several states. Shared by the hard- and soft-scope checks so they stay in
// sync.
const SCHOOL_TITLE_MARKERS = [
  /\bschools?\b/,
  /\bboard of education\b/,
  /\bboard of trustees\b/,
  /\bgoverning board\b/,
];

function currentUtcDateYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function utcDateYmdDaysAgo(daysAgo: number): string {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const shifted = new Date(utcMidnight - daysAgo * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function isHardScopeMismatch(
  districtType: ElectionDistrictType,
  entry: ElectionEntryPayload,
  state: string
): string | null {
  const titleText = normalize(entry.official_ballot_title);
  const scopeText = titleText;
  const stateCode = state.trim().toUpperCase();

  const usSenate = isUsSenateOfficeTitle(entry.official_ballot_title);
  const usHouse =
    /\bu\.?s\.?\s+house\b/.test(scopeText) ||
    /\bunited states house\b/.test(scopeText) ||
    /\bu\.?s\.?\s+house\s+of\s+representatives?\b/.test(scopeText) ||
    /\brepresentative in congress\b/.test(scopeText) ||
    /\brepresentative to congress\b/.test(scopeText) ||
    /\brepresentative to the (?:\d+(?:st|nd|rd|th) )?united states congress\b/.test(scopeText) ||
    /\bcongressional district\b/.test(scopeText);
  // Alaska's legislature is a House and a Senate — it has no assembly. There,
  // "Assembly Member" is always the BOROUGH (county-equivalent) or municipal
  // governing body, so the state-assembly markers must not hard-reject it off
  // an Alaska county row. An explicit "State Assembly" still fails.
  const alaskaLocalAssembly =
    stateCode === "AK" && /\bassembly\b/.test(scopeText) && !/\bstate assembly\b/.test(scopeText);
  const stateSenate = !usSenate && hasAny(scopeText, STATE_UPPER_STRICT_MARKERS);
  const stateHouse = !usHouse && !alaskaLocalAssembly && hasAny(scopeText, STATE_LOWER_STRICT_MARKERS);
  const hasFederalMarker =
    usSenate ||
    usHouse ||
    /\bunited states\b/.test(scopeText) ||
    /\bcongress\b/.test(scopeText) ||
    /\bcongressional\b/.test(scopeText);
  const statewideStateLegislativeLike =
    !hasFederalMarker &&
    (hasAny(scopeText, STATE_UPPER_MARKERS) || hasAny(scopeText, STATE_LOWER_MARKERS));

  // Only use broad office-level mismatch signals for office races to avoid over-rejecting ballot-measure text.
  const governorLike =
    entry.race_type === "office" &&
    /\bgovernor\b|\blieutenant governor\b|\battorney general\b|\bsecretary of state\b/.test(scopeText);
  const countyLike =
    entry.race_type === "office" &&
    /\bcounty\b|\bsheriff\b|\bcounty commissioner\b|\bcounty clerk\b|\bdistrict attorney\b/.test(scopeText);
  // "(?<!\bcounty )" — several county charters title the elected county
  // executive "County Mayor" (Orange County FL, Miami-Dade, Nashville); that
  // is a county office, not a city one. Every other scope branch that uses
  // cityLike to reject a mis-scoped "County Mayor" also checks countyLike
  // (the "county" token), so no protection is lost.
  // "(?! and borough\b)" — Alaska's consolidated county-equivalents are titled
  // "City and Borough of Juneau/Sitka/Wrangell/Yakutat". That phrase names a
  // borough (a county-equivalent), not a city race, so it must not hard-reject
  // an Alaska county row.
  //
  // The mayor exclusion parallels the "County Mayor" lookbehind above: an
  // Alaska mayor title that names a borough or census area ("Mayor, City and
  // Borough of Juneau", "Borough Mayor") is the county-equivalent executive.
  // A city mayor inside a borough still says "City of <X>" without "and
  // borough", so the bare "city" token keeps rejecting it.
  const alaskaBoroughMayor =
    stateCode === "AK" && /\bborough\b|\bcensus area\b/.test(scopeText);
  const cityLike =
    entry.race_type === "office" &&
    (/\bcity\b(?! and borough\b)|\bcity council\b|\balderman\b/.test(scopeText) ||
      (!alaskaBoroughMayor && /(?<!\bcounty )\bmayor\b/.test(scopeText)));
  // DC's ward rows are typed state_upper (the ward's Council seat stands in
  // for a state senate seat), and the same ward ballot elects the ward's
  // member of the DC State Board of Education. That is the one board-of-
  // education title that belongs on a state_upper row; the matcher routes it
  // to its own office. Any other state's row keeps the school rejection.
  const dcWardStateBoard =
    districtType === "state_upper" && isDcWardStateBoardOfEducationTitle(stateCode, scopeText);
  // Colorado elects its State Board of Education (and CU regents) by
  // congressional district, so that title belongs on a Colorado us_house
  // row; the matcher routes it to its own office. Other states keep the
  // school rejection.
  const coloradoCongressionalBoard =
    districtType === "us_house" && congressionalDistrictBoardOfficeName(stateCode, scopeText) !== null;
  const schoolLike =
    entry.race_type === "office" &&
    !dcWardStateBoard &&
    !coloradoCongressionalBoard &&
    /\bschool board\b|\bschool district\b|\bboard of education\b/.test(scopeText);
  // Most large US school districts are named "* County School District" or
  // "* City Schools", so county/city tokens inside a clearly-school title are
  // part of the district's name, not a sign of a mis-scoped county/city race.
  const schoolTitleMarker = entry.race_type === "office" && hasAny(scopeText, SCHOOL_TITLE_MARKERS);

  if (districtType === "place" && (usSenate || usHouse || stateSenate || stateHouse || governorLike || countyLike || schoolLike)) {
    return "place scope contains clearly non-place race";
  }

  if (districtType === "county" && (usSenate || usHouse || stateSenate || stateHouse || governorLike || cityLike || schoolLike)) {
    return "county scope contains clearly non-county race";
  }

  if (districtType === "us_house" && (usSenate || stateSenate || stateHouse || governorLike || countyLike || cityLike || schoolLike)) {
    return "us_house scope contains clearly non-us_house race";
  }

  if (districtType === "state_upper" && (usSenate || usHouse || stateHouse || countyLike || cityLike || schoolLike)) {
    return "state_upper scope contains clearly non-state_upper race";
  }

  if (districtType === "state_lower" && (usSenate || usHouse || stateSenate || countyLike || cityLike || schoolLike)) {
    return "state_lower scope contains clearly non-state_lower race";
  }

  if (
    districtType.startsWith("school_") &&
    (usSenate ||
      usHouse ||
      stateSenate ||
      stateHouse ||
      governorLike ||
      ((countyLike || cityLike) && !schoolTitleMarker))
  ) {
    return "school scope contains clearly non-school race";
  }

  if (
    districtType === "statewide" &&
    (countyLike ||
      cityLike ||
      schoolLike ||
      (entry.race_type === "office" && (usHouse || statewideStateLegislativeLike)))
  ) {
    return "statewide scope contains clearly non-statewide race";
  }

  return null;
}

function isSoftScopeAmbiguous(
  districtType: ElectionDistrictType,
  entry: ElectionEntryPayload,
  state: string
): string | null {
  const text = normalize(entry.official_ballot_title);

  if (
    districtType === "us_house" &&
    !hasAny(text, [
      /\bu\.?s\.?\s+house\b/,
      /\bu\.?s\.?\s+house\s+of\s+representatives?\b/,
      /\bu\.?s\.?\s+representative\b/,
      /\bunited states representative\b/,
      /\bunited states house\b/,
      /\brepresentative in congress\b/,
      /\brepresentative to congress\b/,
      // Official election-authority wording, e.g. Colorado's
      // "Representative to the 120th United States Congress - District 2".
      /\brepresentative to the (?:\d+(?:st|nd|rd|th) )?united states congress\b/,
      /\bcongressional district\b/,
    ])
  ) {
    return "us_house entry lacks clear us_house markers";
  }

  if (
    districtType === "state_upper" &&
    !hasAny(text, STATE_UPPER_MARKERS) &&
    // The DC ward's State Board of Education seat is an official state_upper
    // title (see isHardScopeMismatch); it never carries a senate marker.
    !isDcWardStateBoardOfEducationTitle(state, text)
  ) {
    return "state_upper entry lacks clear state_upper markers";
  }

  if (districtType === "state_lower" && !hasAny(text, STATE_LOWER_MARKERS)) {
    return "state_lower entry lacks clear state_lower markers";
  }

  if (districtType === "county") {
    const countyMarkers = [
      /\bcounty\b/,
      /\bsheriff\b/,
      /\bcounty commissioner\b/,
      /\bcounty clerk\b/,
      // The independent City of St. Louis elects county-equivalent offices
      // titled simply "Collector of Revenue" and "License Collector".
      // Their county discovery scope supplies the jurisdiction, while the
      // official ballot titles themselves contain neither "county" nor
      // another generic county-office marker.
      /\bcollector of revenue\b/,
      /\blicense collector\b/,
      /\bdistrict attorney\b/,
      // Official Indiana county ballots omit the jurisdiction from these
      // countywide offices (for example, "Clerk of the Circuit Court"),
      // while the district payload itself supplies the county scope.
      /\bclerk of (?:the )?circuit court\b/,
      /\bcircuit court clerk\b/,
      // Judicial circuits may span several counties, but the election model
      // intentionally consolidates judges by geographic discovery scope and
      // has no judicial-circuit district type. A circuit-judge contest found
      // on a county ballot therefore belongs to that county discovery pass.
      /\bcircuit judge\b/,
      /\brecorder\b/,
      /\bcoroner\b/,
      /\bregister of deeds\b/,
      /\bcommissioner\s*-\s*district\b/,
    ];
    // "Assessor" is a county office, but town/village/township assessors are municipal
    // contests that the city-oriented hard markers do not catch.
    if (!/\b(town|village|township|borough|municipal)\b/.test(text)) {
      countyMarkers.push(/\bassessor\b/);
    }
    const stateCode = state.trim().toUpperCase();
    // Superior courts are county trial courts in the states that elect their judges,
    // except Pennsylvania, where the Superior Court is a statewide appellate court.
    if (stateCode !== "PA") {
      countyMarkers.push(/\bsuperior court\b/);
    }
    // Louisiana has no counties: the county-equivalent is the PARISH, and no
    // Louisiana ballot title ever contains the word "county". Appending the
    // jurisdiction cannot rescue these titles either — the office matcher folds
    // the verbatim SOS form ("Justice of the Peace 1st Justice Court") at 1.000
    // and drops to 0.52 once the parish is spliced in — so the parish-scope
    // offices carry their own markers instead.
    //
    // Any title naming a CITY is excluded from these markers: a New Orleans
    // city-court contest ("Constable 1st City Court") and a City of New Orleans
    // Home Rule Charter amendment belong on the "New Orleans city" place row
    // even when the voting geography is parishwide, and a ballot measure never
    // reaches the office-only hard city check above.
    if (stateCode === "LA" && !/\bcity\b/.test(text)) {
      countyMarkers.push(
        /\bparish\b/,
        // The Police Jury is the governing body of most Louisiana parishes;
        // its member titles ("Police Juror District 3") carry no "parish"
        // token of their own.
        /\bpolice jur(?:y|or)\b/,
        /\bjustice of the peace\b/,
        /\bjustice court\b/,
        /\bconstable\b/,
        // Orleans' Civil/Criminal District Courts and the numbered judicial
        // district courts elsewhere are parish trial courts, consolidated by
        // geographic discovery scope for the same reason as circuit judges
        // above. The multi-parish Courts of Appeal are deliberately absent.
        /\bdistrict court\b/,
        /\bclerk of court\b/
      );
    }
    // Alaska has no counties either: its county-equivalents are boroughs and,
    // in the unorganized borough, census areas. "borough" counts only in
    // Alaska — in New Jersey, Pennsylvania and Connecticut a borough is a
    // municipality, which must keep soft-failing on a county row.
    if (stateCode === "AK") {
      countyMarkers.push(/\bborough\b/, /\bcensus area\b/);
    }
    if (!hasAny(text, countyMarkers)) {
      return "county entry lacks clear county markers";
    }
  }

  // "council ?member" covers both the two-word form and one-word official
  // titles ("Councilmember"); bare "Council Member for District N" (Fort
  // Worth) and "Councilmember" (Flagstaff) are municipal offices that
  // previously soft-failed ten-at-a-time despite verified official titles.
  if (
    districtType === "place" &&
    !hasAny(text, [/\bcity\b/, /\bmayor\b/, /\bcity council\b/, /\bcouncil ?member\b/, /\btown\b/, /\bvillage\b/])
  ) {
    return "place entry lacks clear place markers";
  }

  if (districtType.startsWith("school_") && !hasAny(text, SCHOOL_TITLE_MARKERS)) {
    return "school entry lacks clear school markers";
  }

  return null;
}

function ballotMeasureTitleQualityIssue(entry: ElectionEntryPayload): string | null {
  if (entry.race_type !== "ballot_measure") {
    return null;
  }

  const title = entry.official_ballot_title.trim();
  const isQuestionLike =
    title.includes("?") ||
    /\bbe adopted\b/i.test(title) ||
    /\bdo you\b/i.test(title);
  const isTooLong = title.length > 140;

  if (isQuestionLike || isTooLong) {
    return "ballot_measure title looks like question/description text instead of official measure label/title";
  }
  return null;
}

function filterPresidentialEntries(payload: ElectionEnrichedPayload): PresidentialEntryFilterResult {
  const result = filterPresidentialElectionEntries(payload.entries);

  return {
    payload:
      result.removedTitles.length === 0
        ? payload
        : {
            ...payload,
            entries: result.entries,
          },
    removedTitles: result.removedTitles,
  };
}

function validateScope(payload: ElectionEnrichedPayload, allowHistoricalDate: boolean): ValidationResult {
  const reasons: string[] = [];
  let severity: ValidationSeverity = "pass";
  const todayUtc = currentUtcDateYmd();
  const oldestAllowedDate = utcDateYmdDaysAgo(1);

  for (const entry of payload.entries) {
    if (!allowHistoricalDate && entry.election_date < oldestAllowedDate) {
      return {
        severity: "hard_fail",
        reasons: [
          `election_date is too far in the past (${entry.election_date} < ${oldestAllowedDate}, UTC 1-day grace): ${entry.official_ballot_title}`,
        ],
      };
    }

    const hardReason = isHardScopeMismatch(payload.district_type, entry, payload.state);
    if (hardReason) {
      return {
        severity: "hard_fail",
        reasons: [`${hardReason}: ${entry.official_ballot_title}`],
      };
    }

    const softReason = isSoftScopeAmbiguous(payload.district_type, entry, payload.state);
    if (softReason) {
      severity = "soft_fail";
      reasons.push(`${softReason}: ${entry.official_ballot_title}`);
    }

    const titleQualityReason = ballotMeasureTitleQualityIssue(entry);
    if (titleQualityReason) {
      severity = "soft_fail";
      reasons.push(`${titleQualityReason}: ${entry.official_ballot_title}`);
    }
  }

  return { severity, reasons };
}

async function ensureConsumerGroup(redis: ReturnType<typeof createClient>): Promise<void> {
  try {
    await redis.xGroupCreate(STAGING_PENDING_STREAM, STAGING_ELECTIONS_VALIDATOR_GROUP, "0", { MKSTREAM: true });
  } catch (error) {
    const message = toReason(error);
    if (!message.includes("BUSYGROUP")) {
      throw error;
    }
  }
}

async function getStagingRow(pool: Pool, ingestKey: string): Promise<StagingRow | null> {
  const result = await pool.query<StagingRow>(
    `
      SELECT ingest_key, payload, status, run_id, reason, failure_debug, schema_version, ai_raw_debug
      FROM staging_items
      WHERE ingest_key = $1
        AND item_type = $2
    `,
    [ingestKey, STAGING_ITEM_TYPE_ELECTION]
  );
  return result.rows[0] ?? null;
}

// Every terminal or parked transition prints one line: a soft-failed row
// parks as status='pending' with the reason only in the DB, which looked
// identical to a starved worker from the terminal — operators had to query
// staging_items to learn the validator had actually run and why it parked.
function logStagingTransition(ingestKey: string, outcome: string, reason: string): void {
  console.warn(`elections validator ${outcome} ingest_key=${ingestKey}: ${reason}`);
}

async function getStagingStatus(pool: Pool, ingestKey: string): Promise<string | null> {
  const result = await pool.query<{ status: string }>(
    `
      SELECT status
      FROM staging_items
      WHERE ingest_key = $1
        AND item_type = $2
    `,
    [ingestKey, STAGING_ITEM_TYPE_ELECTION]
  );
  return result.rows[0]?.status ?? null;
}

async function reclaimPendingEntries(
  redis: ReturnType<typeof createClient>,
  consumerName: string,
  batchSize: number
): Promise<Array<{ id: string; message: Record<string, string> }>> {
  const reclaimed: Array<{ id: string; message: Record<string, string> }> = [];
  let cursor = "0-0";

  for (let i = 0; i < RECLAIM_MAX_BATCHES; i += 1) {
    const claim = await redis.xAutoClaim(
      STAGING_PENDING_STREAM,
      STAGING_ELECTIONS_VALIDATOR_GROUP,
      consumerName,
      RECLAIM_MIN_IDLE_MS,
      cursor,
      { COUNT: batchSize }
    );
    cursor = claim.nextId;
    if (!claim.messages || claim.messages.length === 0) {
      break;
    }

    reclaimed.push(
      ...claim.messages
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .map((entry) => ({ id: entry.id, message: entry.message as Record<string, string> }))
    );
  }

  return reclaimed;
}

export async function runElectionsValidator(options: ValidatorOptions = {}): Promise<void> {
  const { once = false, batchSize = 25, blockMs = 5000, ingestKey: targetIngestKey } = options;
  const env = getPipelineEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const redis = createClient({ url: env.REDIS_URL });
  const consumerName = `elections_validator_${process.pid}_${Date.now()}`;

  try {
    await redis.connect();
    await ensureConsumerGroup(redis);

    // Targeted-mode entries carry no stream id; skip the ack for them.
    const ack = async (entryId: string): Promise<void> => {
      if (entryId) {
        await redis.xAck(STAGING_PENDING_STREAM, STAGING_ELECTIONS_VALIDATOR_GROUP, entryId);
      }
    };

    const handleEntries = async (entries: Array<{ id: string; message: Record<string, string> }>): Promise<void> => {
      for (const entry of entries) {
        const ingestKey = entry.message.ingest_key;
        const itemType = entry.message.item_type;

        try {
          if (!ingestKey || itemType !== STAGING_ITEM_TYPE_ELECTION) {
            await ack(entry.id);
            continue;
          }

          const row = await getStagingRow(pool, ingestKey);
          if (!row || row.status !== "pending" || row.schema_version !== ELECTION_ENRICHMENT_SCHEMA_VERSION) {
            // The DB update and the follow-up XADD are not atomic: a run that
            // died (or lost Redis) between them leaves the row transitioned
            // with no stream message. Acking such a redelivery without
            // republishing strands the row forever, so rebuild the missing
            // message from persisted state first. Duplicates are safe: the
            // writer only acts on status='validated' rows and the enricher
            // only on pending drafts.
            if (row?.status === "validated") {
              await redis.xAdd(STAGING_VALIDATED_STREAM, "*", {
                ingest_key: ingestKey,
                item_type: STAGING_ITEM_TYPE_ELECTION,
                run_id: row.run_id ?? "",
                payload: JSON.stringify(row.payload),
              });
            } else if (
              row &&
              row.status === "pending" &&
              row.schema_version === ELECTION_DRAFT_SCHEMA_VERSION &&
              !isManualResearchRow(row.ai_raw_debug)
            ) {
              // Soft-fail requeue whose draft-stream publish never landed.
              // Manual rows are never enqueued for AI enrichment (see the
              // soft-fail branch below), so they are not republished either.
              await redis.xAdd(STAGING_DRAFT_STREAM, "*", {
                ingest_key: ingestKey,
                item_type: STAGING_ITEM_TYPE_ELECTION,
                run_id: row.run_id ?? "",
              });
            } else if (row?.status === "rejected") {
              // Rejection event whose rejected-stream publish never landed.
              // Nothing consumes this stream today (it is an audit trail; the
              // durable rejection is the row itself), but a future consumer
              // must not inherit a silent gap.
              await redis.xAdd(STAGING_REJECTED_STREAM, "*", {
                ingest_key: ingestKey,
                item_type: STAGING_ITEM_TYPE_ELECTION,
                run_id: row.run_id ?? "",
                reason: row.reason ?? "",
              });
            }
            await ack(entry.id);
            continue;
          }

          const parsed = parseCanonicalElectionPayload(row.payload);
          if (!parsed.ok) {
            await pool.query(
              `
                UPDATE staging_items
                SET status = 'rejected',
                    reason = $2,
                    updated_at = now()
                WHERE ingest_key = $1
                  AND item_type = $3
              `,
              [ingestKey, `hard_fail: ${parsed.reason}`, STAGING_ITEM_TYPE_ELECTION]
            );
            await redis.xAdd(STAGING_REJECTED_STREAM, "*", {
              ingest_key: ingestKey,
              item_type: STAGING_ITEM_TYPE_ELECTION,
              run_id: row.run_id ?? "",
              reason: `hard_fail: ${parsed.reason}`,
            });
            logStagingTransition(ingestKey, "rejected", `hard_fail: ${parsed.reason}`);
            await ack(entry.id);
            continue;
          }

          const softRetryCount = parseSoftRetryCount(row.failure_debug);
          const presidentialFilter = filterPresidentialEntries(parsed.payload);
          const payloadForValidation = presidentialFilter.payload;
          if (presidentialFilter.removedTitles.length > 0 && payloadForValidation.entries.length === 0) {
            const reason = `presidential entries excluded from standard election discovery: ${presidentialFilter.removedTitles.join(", ")}`;
            if (softRetryCount === 0) {
              const failureDebug = {
                soft_retry_count: 1,
                validation_feedback: [reason],
                soft_retry_at: new Date().toISOString(),
              };

              await pool.query(
                `
                  UPDATE staging_items
                  SET status = 'pending',
                      reason = $2,
                      failure_debug = $3::jsonb,
                      schema_version = $4,
                      updated_at = now()
                  WHERE ingest_key = $1
                    AND item_type = $5
                `,
                [
                  ingestKey,
                  `soft_fail: ${reason}`,
                  JSON.stringify(failureDebug),
                  ELECTION_DRAFT_SCHEMA_VERSION,
                  STAGING_ITEM_TYPE_ELECTION,
                ]
              );

              await redis.xAdd(STAGING_DRAFT_STREAM, "*", {
                ingest_key: ingestKey,
                item_type: STAGING_ITEM_TYPE_ELECTION,
                run_id: row.run_id ?? "",
              });

              logStagingTransition(ingestKey, "parked pending (soft_fail)", reason);
              await ack(entry.id);
              continue;
            }

            const rejectReason = `soft_fail_final: ${reason}`;
            await pool.query(
              `
                UPDATE staging_items
                SET status = 'rejected',
                    reason = $2,
                    updated_at = now()
                WHERE ingest_key = $1
                  AND item_type = $3
              `,
              [ingestKey, rejectReason, STAGING_ITEM_TYPE_ELECTION]
            );
            await redis.xAdd(STAGING_REJECTED_STREAM, "*", {
              ingest_key: ingestKey,
              item_type: STAGING_ITEM_TYPE_ELECTION,
              run_id: row.run_id ?? "",
              reason: rejectReason,
            });
            logStagingTransition(ingestKey, "rejected", rejectReason);
            await ack(entry.id);
            continue;
          }

          const validation = validateScope(payloadForValidation, isHistoricalImportApproved(row.ai_raw_debug));

          if (validation.severity === "hard_fail") {
            const reason = `hard_fail: ${validation.reasons.join("; ")}`;
            await pool.query(
              `
                UPDATE staging_items
                SET status = 'rejected',
                    reason = $2,
                    updated_at = now()
                WHERE ingest_key = $1
                  AND item_type = $3
              `,
              [ingestKey, reason, STAGING_ITEM_TYPE_ELECTION]
            );
            await redis.xAdd(STAGING_REJECTED_STREAM, "*", {
              ingest_key: ingestKey,
              item_type: STAGING_ITEM_TYPE_ELECTION,
              run_id: row.run_id ?? "",
              reason,
            });
            logStagingTransition(ingestKey, "rejected", reason);
            await ack(entry.id);
            continue;
          }

          if (validation.severity === "soft_fail") {
            if (softRetryCount === 0) {
              const nextSoftRetryCount = softRetryCount + 1;
              const failureDebug = {
                soft_retry_count: nextSoftRetryCount,
                validation_feedback: validation.reasons,
                soft_retry_at: new Date().toISOString(),
              };

              await pool.query(
                `
                  UPDATE staging_items
                  SET status = 'pending',
                      reason = $2,
                      failure_debug = $3::jsonb,
                      schema_version = $4,
                      updated_at = now()
                  WHERE ingest_key = $1
                    AND item_type = $5
                `,
                [
                  ingestKey,
                  `soft_fail: ${validation.reasons.join("; ")}`,
                  JSON.stringify(failureDebug),
                  ELECTION_DRAFT_SCHEMA_VERSION,
                  STAGING_ITEM_TYPE_ELECTION,
                ]
              );

              // A manually researched row is never handed to the AI enricher:
              // the enricher regenerates the payload and replaces ai_raw_debug
              // wholesale, which would clobber the manual payload and strip
              // manual_research / historical_import_approved. The manual repair
              // path is a re-validate (the review-approve branch below) or a
              // corrected re-inject.
              if (!isManualResearchRow(row.ai_raw_debug)) {
                await redis.xAdd(STAGING_DRAFT_STREAM, "*", {
                  ingest_key: ingestKey,
                  item_type: STAGING_ITEM_TYPE_ELECTION,
                  run_id: row.run_id ?? "",
                });
              }

              logStagingTransition(
                ingestKey,
                "parked pending (soft_fail)",
                validation.reasons.join("; ")
              );
              await ack(entry.id);
              continue;
            }

            if (parsed.payload.review_decision === "approve") {
              await pool.query(
                `
                  UPDATE staging_items
                  SET status = 'validated',
                      payload = $3::jsonb,
                      reason = NULL,
                      validated_at = now(),
                      updated_at = now()
                  WHERE ingest_key = $1
                    AND item_type = $2
                `,
                [ingestKey, STAGING_ITEM_TYPE_ELECTION, JSON.stringify(payloadForValidation)]
              );
              await redis.xAdd(STAGING_VALIDATED_STREAM, "*", {
                ingest_key: ingestKey,
                item_type: STAGING_ITEM_TYPE_ELECTION,
                run_id: row.run_id ?? "",
                payload: JSON.stringify(payloadForValidation),
              });
              await ack(entry.id);
              continue;
            }

            const rejectReason = `soft_fail_final: ${validation.reasons.join("; ")}`;
            await pool.query(
              `
                UPDATE staging_items
                SET status = 'rejected',
                    reason = $2,
                    updated_at = now()
                WHERE ingest_key = $1
                  AND item_type = $3
              `,
              [ingestKey, rejectReason, STAGING_ITEM_TYPE_ELECTION]
            );
            await redis.xAdd(STAGING_REJECTED_STREAM, "*", {
              ingest_key: ingestKey,
              item_type: STAGING_ITEM_TYPE_ELECTION,
              run_id: row.run_id ?? "",
              reason: rejectReason,
            });
            logStagingTransition(ingestKey, "rejected", rejectReason);
            await ack(entry.id);
            continue;
          }

          await pool.query(
            `
              UPDATE staging_items
              SET status = 'validated',
                  payload = $3::jsonb,
                  reason = NULL,
                  validated_at = now(),
                  updated_at = now()
              WHERE ingest_key = $1
                AND item_type = $2
            `,
            [ingestKey, STAGING_ITEM_TYPE_ELECTION, JSON.stringify(payloadForValidation)]
          );

          await redis.xAdd(STAGING_VALIDATED_STREAM, "*", {
            ingest_key: ingestKey,
            item_type: STAGING_ITEM_TYPE_ELECTION,
            run_id: row.run_id ?? "",
            payload: JSON.stringify(payloadForValidation),
          });
          await ack(entry.id);
        } catch (error) {
          const reason = toReason(error);
          if (!ingestKey) {
            try {
              await ack(entry.id);
            } catch {
              // keep unacked when ack fails; reclaim pass will retry later
            }
            console.error(`elections validator message error (missing ingest key): ${reason}`);
            continue;
          }

          const status = await getStagingStatus(pool, ingestKey);
          if (status === "pending" || status === "validated" || status === "rejected") {
            // leave unacked so reclaim pass can retry; 'validated' and
            // 'rejected' mean the row transitioned but the follow-up stream
            // publish may have failed — the redelivery gate republishes it
            // from the row.
            console.warn(`elections validator retrying ingest_key=${ingestKey}: ${reason}`);
            continue;
          }

          try {
            await ack(entry.id);
          } catch {
            // keep unacked when ack fails; reclaim pass will retry later
          }
          console.error(`elections validator message error ingest_key=${ingestKey}: ${reason}`);
        }
      }
    };

    if (targetIngestKey) {
      await handleEntries([
        { id: "", message: { ingest_key: targetIngestKey, item_type: STAGING_ITEM_TYPE_ELECTION } },
      ]);
      const finalRow = await getStagingRow(pool, targetIngestKey);
      console.log(
        JSON.stringify({
          targeted: true,
          ingest_key: targetIngestKey,
          status: finalRow?.status ?? null,
          // A parked soft-fail keeps status='pending'; without the reason the
          // summary is indistinguishable from a row the validator never saw.
          reason: finalRow?.reason ?? null,
        })
      );
      return;
    }

    do {
      const reclaimed = await reclaimPendingEntries(redis, consumerName, batchSize);
      if (reclaimed.length > 0) {
        await handleEntries(reclaimed);
      }

      const batches = await redis.xReadGroup(
        STAGING_ELECTIONS_VALIDATOR_GROUP,
        consumerName,
        [{ key: STAGING_PENDING_STREAM, id: ">" }],
        { COUNT: batchSize, BLOCK: blockMs }
      );

      if (!batches || batches.length === 0) {
        if (once) {
          break;
        }
        continue;
      }

      for (const batch of batches) {
        await handleEntries(
          batch.messages.map((message) => ({
            id: message.id,
            message: message.message as Record<string, string>,
          }))
        );
      }

      if (once) {
        break;
      }
    } while (true);
  } finally {
    try {
      await redis.quit();
    } catch (error) {
      console.error("elections validator cleanup warning (redis.quit):", toReason(error));
    }
    try {
      await pool.end();
    } catch (error) {
      console.error("elections validator cleanup warning (pool.end):", toReason(error));
    }
  }
}

import { findBlockedSourceReason } from "../pipeline/candidates/candidateRecordSourcePolicy.js";
import { stripNameFootnoteMarkers } from "../utils/candidateIdentity.js";
import { normalizeHttpUrl } from "../utils/normalizeHttpUrl.js";

export type CandidateRosterRunningMate = {
  display_name: string;
  party?: string;
  sources: string[];
};

// Manual-only exception to the federal FEC-ID rule: a candidate an election
// authority lists on the ballot while the FEC has issued no candidate ID.
// reason says why the ID is missing; official_roster_url is the election
// authority page that lists the candidate and must also be one of the row's
// sources.
export type CandidateRosterNoFecIdException = {
  reason: string;
  official_roster_url: string;
};

export type CandidateRosterEntry = {
  display_name: string;
  party?: string;
  is_incumbent?: boolean;
  fec_ids?: string[];
  no_fec_id_exception?: CandidateRosterNoFecIdException;
  state_filing_ids?: string[];
  running_mate?: CandidateRosterRunningMate;
  sources: string[];
};

export type CandidateRosterPayload = {
  candidates: CandidateRosterEntry[];
};

type CandidateRosterParseOptions = {
  requireFecIds?: boolean;
  allowFecIds?: boolean;
  // OFF by default. Only manual:candidate-roster:inject and the re-parses of
  // a roster it staged (fanout, profile write) pass true. Everywhere else —
  // the AI enricher included — row.no_fec_id_exception is ignored like any
  // unknown field, so the row is skipped under requireFecIds as before.
  allowNoFecIdException?: boolean;
  // Domain policy over row/running-mate sources (blocked classes: UGC/social,
  // generated directories, bot-check interstitials). ON by default so every
  // fresh import — manual inject and AI validation alike — rejects the same
  // URLs. Re-parses of ALREADY-WRITTEN staging payloads (profile write,
  // fanout) must pass false: rosters imported before the policy existed can
  // carry a now-blocked URL, and downstream work must not fail over evidence
  // the roster write already accepted.
  enforceSourcePolicy?: boolean;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSources(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    const url = normalizeHttpUrl(item);
    if (!url) {
      return null;
    }
    if (!seen.has(url)) {
      seen.add(url);
      normalized.push(url);
    }
  }

  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isNonEmptyString(item)) {
      return null;
    }
    const text = item.trim();
    if (!seen.has(text)) {
      seen.add(text);
      normalized.push(text);
    }
  }
  return normalized;
}

function parseEntry(
  value: unknown,
  options: CandidateRosterParseOptions
): { ok: true; entry: CandidateRosterEntry } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "row must be an object" };
  }

  const input = value as Record<string, unknown>;
  if (!isNonEmptyString(input.display_name)) {
    return { ok: false, reason: "row.display_name must be a non-empty string" };
  }
  // Stripped ONCE, here, and reused for the duplicate check and for storage.
  // An earlier version stripped at each use site and missed one — the running
  // mate below — which let a marker-only name through as "". Deriving each
  // name a single time is what stops that from recurring.
  //
  // Re-checked after stripping: a value of "*" alone passes the non-empty
  // check above and would otherwise be stored as an empty name.
  const displayName = stripNameFootnoteMarkers(input.display_name);
  if (displayName.length === 0) {
    return { ok: false, reason: "row.display_name must contain a name, not only footnote markers" };
  }

  const sources = normalizeSources(input.sources);
  if (!sources) {
    return { ok: false, reason: "row.sources must contain at least one valid URL" };
  }
  // Same domain policy as candidate records: UGC/social platforms, generated
  // candidate directories, and bot-check interstitials are never roster
  // evidence. Enforced here so the AI enricher and the manual inject path
  // reject identical URLs, and the reason doubles as AI retry feedback.
  const enforceSourcePolicy = options.enforceSourcePolicy !== false;
  if (enforceSourcePolicy) {
    const blockedSourceReason = findBlockedSourceReason(sources);
    if (blockedSourceReason) {
      return { ok: false, reason: `row.sources: ${blockedSourceReason}` };
    }
  }

  let party: string | undefined;
  if (input.party !== undefined && input.party !== null) {
    if (!isNonEmptyString(input.party)) {
      return { ok: false, reason: "row.party must be a non-empty string when provided" };
    }
    party = input.party.trim();
  }

  let isIncumbent: boolean | undefined;
  if (input.is_incumbent !== undefined && input.is_incumbent !== null) {
    if (typeof input.is_incumbent !== "boolean") {
      return { ok: false, reason: "row.is_incumbent must be a boolean when provided" };
    }
    isIncumbent = input.is_incumbent;
  }

  const allowFecIds = options.allowFecIds !== false;
  if (!allowFecIds && input.fec_ids !== undefined && input.fec_ids !== null) {
    return { ok: false, reason: "row.fec_ids is not allowed for this election context" };
  }
  const fecIds = allowFecIds ? normalizeOptionalStringArray(input.fec_ids) : undefined;
  if (allowFecIds && fecIds === null) {
    return { ok: false, reason: "row.fec_ids must be an array of non-empty strings when provided" };
  }
  const normalizedFecIds = fecIds ?? undefined;

  let noFecIdException: CandidateRosterNoFecIdException | undefined;
  if (
    options.allowNoFecIdException === true &&
    input.no_fec_id_exception !== undefined &&
    input.no_fec_id_exception !== null
  ) {
    if (options.requireFecIds !== true) {
      return { ok: false, reason: "row.no_fec_id_exception is only allowed for federal contests that require FEC IDs" };
    }
    if (normalizedFecIds && normalizedFecIds.length > 0) {
      return {
        ok: false,
        reason: "row.no_fec_id_exception cannot be combined with row.fec_ids; remove the exception once the FEC ID exists",
      };
    }
    if (typeof input.no_fec_id_exception !== "object" || Array.isArray(input.no_fec_id_exception)) {
      return { ok: false, reason: "row.no_fec_id_exception must be an object when provided" };
    }
    const exception = input.no_fec_id_exception as Record<string, unknown>;
    if (!isNonEmptyString(exception.reason)) {
      return { ok: false, reason: "row.no_fec_id_exception.reason must be a non-empty string" };
    }
    const officialRosterUrl =
      typeof exception.official_roster_url === "string" ? normalizeHttpUrl(exception.official_roster_url) : null;
    if (!officialRosterUrl) {
      return { ok: false, reason: "row.no_fec_id_exception.official_roster_url must be a valid http(s) URL" };
    }
    // Tied to the row's evidence so the URL passes the same source policy and
    // stays visible wherever the row's sources are shown.
    if (!sources.includes(officialRosterUrl)) {
      return {
        ok: false,
        reason: "row.no_fec_id_exception.official_roster_url must also be listed in row.sources",
      };
    }
    noFecIdException = { reason: exception.reason.trim(), official_roster_url: officialRosterUrl };
  }

  const stateFilingIds = normalizeOptionalStringArray(input.state_filing_ids);
  if (stateFilingIds === null) {
    return { ok: false, reason: "row.state_filing_ids must be an array of non-empty strings when provided" };
  }
  const normalizedStateFilingIds = stateFilingIds ?? undefined;

  let runningMate: CandidateRosterRunningMate | undefined;
  if (input.running_mate !== undefined && input.running_mate !== null) {
    if (typeof input.running_mate !== "object" || Array.isArray(input.running_mate)) {
      return { ok: false, reason: "row.running_mate must be an object when provided" };
    }
    const mate = input.running_mate as Record<string, unknown>;
    if (!isNonEmptyString(mate.display_name)) {
      return { ok: false, reason: "row.running_mate.display_name must be a non-empty string" };
    }
    const mateDisplayName = stripNameFootnoteMarkers(mate.display_name);
    if (mateDisplayName.length === 0) {
      return {
        ok: false,
        reason: "row.running_mate.display_name must contain a name, not only footnote markers",
      };
    }
    const mateSources = normalizeSources(mate.sources);
    if (!mateSources) {
      return { ok: false, reason: "row.running_mate.sources must contain at least one valid URL" };
    }
    if (enforceSourcePolicy) {
      const mateBlockedSourceReason = findBlockedSourceReason(mateSources);
      if (mateBlockedSourceReason) {
        return { ok: false, reason: `row.running_mate.sources: ${mateBlockedSourceReason}` };
      }
    }
    let mateParty: string | undefined;
    if (mate.party !== undefined && mate.party !== null) {
      if (!isNonEmptyString(mate.party)) {
        return { ok: false, reason: "row.running_mate.party must be a non-empty string when provided" };
      }
      mateParty = mate.party.trim();
    }
    // Compared AFTER stripping, so "Jane Doe *" and "Jane Doe" are recognised
    // as the same person rather than passing as a distinct running mate.
    if (mateDisplayName.toLowerCase() === displayName.toLowerCase()) {
      return { ok: false, reason: "row.running_mate.display_name must differ from the ticket lead's display_name" };
    }
    runningMate = {
      display_name: mateDisplayName,
      ...(mateParty ? { party: mateParty } : {}),
      sources: mateSources,
    };
  }

  return {
    ok: true,
    entry: {
      display_name: displayName,
      ...(party ? { party } : {}),
      ...(isIncumbent !== undefined ? { is_incumbent: isIncumbent } : {}),
      ...(normalizedFecIds !== undefined ? { fec_ids: normalizedFecIds } : {}),
      ...(noFecIdException ? { no_fec_id_exception: noFecIdException } : {}),
      ...(normalizedStateFilingIds !== undefined ? { state_filing_ids: normalizedStateFilingIds } : {}),
      ...(runningMate ? { running_mate: runningMate } : {}),
      sources,
    },
  };
}

export function parseCandidateRosterPayload(
  payload: unknown,
  options: CandidateRosterParseOptions = {}
):
  | {
      ok: true;
      payload: CandidateRosterPayload;
      skippedCandidatesWithoutFecIds: string[];
      keptCandidateIndexes: number[];
    }
  | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be an object" };
  }

  const input = payload as Record<string, unknown>;
  if (!Array.isArray(input.candidates)) {
    return { ok: false, reason: "payload.candidates must be array" };
  }

  // Federal contests require FEC registration per candidate. Candidates without a
  // current FEC candidate ID are excluded from the roster by policy rather than
  // failing the whole payload, so official rosters that mix registered and
  // unregistered filers can still import their serious contenders.
  const requireFecIds = options.requireFecIds === true;
  const candidates: CandidateRosterEntry[] = [];
  const skippedCandidatesWithoutFecIds: string[] = [];
  const keptCandidateIndexes: number[] = [];
  for (const [index, row] of input.candidates.entries()) {
    const parsed = parseEntry(row, options);
    if (!parsed.ok) {
      return { ok: false, reason: `payload.candidates[${index}]: ${parsed.reason}` };
    }
    if (
      requireFecIds &&
      (!parsed.entry.fec_ids || parsed.entry.fec_ids.length === 0) &&
      !parsed.entry.no_fec_id_exception
    ) {
      skippedCandidatesWithoutFecIds.push(parsed.entry.display_name);
      continue;
    }
    candidates.push(parsed.entry);
    keptCandidateIndexes.push(index);
  }

  if (requireFecIds && input.candidates.length > 0 && candidates.length === 0) {
    // Cap the embedded name list: this reason is reused verbatim as AI retry
    // feedback, so an all-skipped mega-roster must not inflate the prompt.
    const skippedPreview = skippedCandidatesWithoutFecIds.slice(0, 10);
    const overflow = skippedCandidatesWithoutFecIds.length - skippedPreview.length;
    return {
      ok: false,
      reason: `payload.candidates: no candidate has a FEC ID for this federal contest (skipped: ${skippedPreview.join(
        "; "
      )}${overflow > 0 ? `; +${overflow} more` : ""})`,
    };
  }

  return { ok: true, payload: { candidates }, skippedCandidatesWithoutFecIds, keptCandidateIndexes };
}

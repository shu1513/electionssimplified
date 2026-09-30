import {
  BLOCKED_SOURCE_KIND_REPAIR,
  classifyCandidateRecordSourceDomain,
  matchesDamagingClaimPattern,
  findLegislativeTrackerSourceReason,
  type BlockedSourceKind,
} from "../pipeline/candidates/candidateRecordSourcePolicy.js";

/**
 * Source-domain audit detectors (PR 3 of the source-trust plan). Advisory
 * only: nothing here blocks a write. The source policy (PR 1) rejects
 * blocked domains and unlisted-damaging records at import time; these
 * detectors are the backstop for campaign-shaped patterns the per-record
 * policy cannot see — one domain feeding many candidates, a damaging burst
 * right before an election, a fresh domain suddenly concentrating records —
 * plus the periodic unlisted-source review feed that grows the allowlist.
 *
 * All detectors are pure functions over plain rows so they are testable
 * without a database; manual:records:audit supplies the rows.
 */

export type SourceAuditRecordRow = {
  record_id: string;
  candidate_id: string;
  display_name: string;
  description: string;
  source_url: string;
  /** ISO timestamp (candidate_records.created_at). */
  created_at: string;
  origin: string | null;
  origin_run_id: string | null;
};

export type SourceAuditCandidateElectionRow = {
  candidate_id: string;
  election_id: string;
  /** ISO date (elections.election_date). */
  election_date: string;
  official_ballot_title: string;
};

/**
 * Recency window for the cross-candidate and newly-seen-domain detectors.
 * The audit is an operator-run periodic sweep; a 30-day window covers a
 * monthly cadence with margin.
 */
export const SOURCE_AUDIT_RECENT_WINDOW_DAYS = 30;

/**
 * An unlisted domain cited by at least this many DISTINCT candidates inside
 * the recent window flags as a cross-candidate burst. Listed domains
 * (wires, .gov, civic data) legitimately feed hundreds of candidates and
 * are exempt.
 */
export const CROSS_CANDIDATE_DOMAIN_MIN_CANDIDATES = 3;

/**
 * Days before an election in which new damaging-pattern records count
 * toward a pre-election burst (interference concentrates pre-election).
 */
export const PRE_ELECTION_WINDOW_DAYS = 30;

/** Damaging-pattern records within the pre-election window that flag a candidate. */
export const PRE_ELECTION_DAMAGING_MIN_RECORDS = 2;

/**
 * A domain whose FIRST record ever is inside the recent window and that
 * already feeds at least this many records flags as a newly-seen
 * concentration (a fresh domain should not arrive with volume).
 */
export const NEWLY_SEEN_DOMAIN_MIN_RECORDS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Grouping key for a record's source domain. Strips the "www." prefix so a
 * campaign splitting citations across www/apex forms cannot dilute the
 * per-domain thresholds. Returns null for unparseable URLs (classification
 * yields an empty hostname) — those rows are simply not groupable.
 */
function toDomainKey(hostname: string): string | null {
  const trimmed = hostname.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
}

type ClassifiedRecord = {
  row: SourceAuditRecordRow;
  tier: "blocked" | "listed" | "unlisted";
  blockedKind: BlockedSourceKind | null;
  domainKey: string | null;
  createdAtMs: number;
};

function classifyRows(records: readonly SourceAuditRecordRow[]): ClassifiedRecord[] {
  return records.map((row) => {
    const classification = classifyCandidateRecordSourceDomain(row.source_url);
    return {
      row,
      tier: classification.tier,
      blockedKind: classification.tier === "blocked" ? classification.blockedKind : null,
      domainKey: toDomainKey(classification.hostname),
      createdAtMs: Date.parse(row.created_at),
    };
  });
}

export type SourceAuditSampleRecord = {
  recordId: string;
  candidateId: string;
  displayName: string;
  sourceUrl: string;
  createdAt: string;
  origin: string | null;
  originRunId: string | null;
};

function toSampleRecord(row: SourceAuditRecordRow): SourceAuditSampleRecord {
  return {
    recordId: row.record_id,
    candidateId: row.candidate_id,
    displayName: row.display_name,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
    origin: row.origin,
    originRunId: row.origin_run_id,
  };
}

/**
 * A stored row citing a blocked domain, carrying WHY it is blocked and what
 * the repair is. The write-time policy explains itself in its rejection
 * message, but these rows never take that path again — they are discovered
 * here, so the instruction has to travel with them.
 */
export type BlockedSourceAuditRecord = SourceAuditSampleRecord & {
  blockedKind: BlockedSourceKind;
  repair: string;
};

function toBlockedRecord(
  row: SourceAuditRecordRow,
  blockedKind: BlockedSourceKind
): BlockedSourceAuditRecord {
  return {
    ...toSampleRecord(row),
    blockedKind,
    repair: BLOCKED_SOURCE_KIND_REPAIR[blockedKind],
  };
}

export type CrossCandidateDomainBurst = {
  domain: string;
  candidateCount: number;
  recordCount: number;
  sampleRecords: SourceAuditSampleRecord[];
};

/**
 * Unlisted domains cited by >= CROSS_CANDIDATE_DOMAIN_MIN_CANDIDATES
 * distinct candidates within the recent window — the one-outlet-feeding-
 * many-candidates signature of a coordinated placement campaign.
 */
export function listCrossCandidateDomainBursts(
  records: readonly SourceAuditRecordRow[],
  now: Date
): CrossCandidateDomainBurst[] {
  const windowStartMs = now.getTime() - SOURCE_AUDIT_RECENT_WINDOW_DAYS * DAY_MS;
  const groups = new Map<
    string,
    { candidateIds: Set<string>; records: ClassifiedRecord[] }
  >();
  for (const record of classifyRows(records)) {
    if (record.tier !== "unlisted" || record.domainKey === null) {
      continue;
    }
    if (Number.isNaN(record.createdAtMs) || record.createdAtMs < windowStartMs) {
      continue;
    }
    let group = groups.get(record.domainKey);
    if (!group) {
      group = { candidateIds: new Set(), records: [] };
      groups.set(record.domainKey, group);
    }
    group.candidateIds.add(record.row.candidate_id);
    group.records.push(record);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.candidateIds.size >= CROSS_CANDIDATE_DOMAIN_MIN_CANDIDATES)
    .sort((left, right) => right[1].candidateIds.size - left[1].candidateIds.size)
    .map(([domain, group]) => ({
      domain,
      candidateCount: group.candidateIds.size,
      recordCount: group.records.length,
      sampleRecords: group.records.slice(0, 5).map((record) => toSampleRecord(record.row)),
    }));
}

export type PreElectionDamagingBurst = {
  candidateId: string;
  displayName: string;
  electionId: string;
  electionDate: string;
  officialBallotTitle: string;
  damagingRecordCount: number;
  records: SourceAuditSampleRecord[];
};

/** Internal shape carrying the full record-id set for the dedupe key. */
type PreElectionDamagingBurstInternal = PreElectionDamagingBurst & { recordIds: string[] };

/**
 * Candidates who gained >= PRE_ELECTION_DAMAGING_MIN_RECORDS damaging-
 * pattern records CREATED inside the PRE_ELECTION_WINDOW_DAYS before one of
 * their elections. created_at is import time, so records imported long
 * after an old election never match its window — this naturally targets
 * live pre-election drops without an explicit "upcoming election" filter.
 * Replaces the rejected human review gate: it alerts, blocks nothing.
 *
 * When two of a candidate's elections have overlapping windows and capture
 * the IDENTICAL record set, only the earliest election's entry is kept —
 * duplicate entries would read as two separate threats. Partially
 * overlapping or disjoint record sets still emit one entry per election:
 * those are genuinely distinct bursts.
 */
export function listPreElectionDamagingBursts(
  records: readonly SourceAuditRecordRow[],
  candidateElections: readonly SourceAuditCandidateElectionRow[]
): PreElectionDamagingBurst[] {
  const damagingByCandidate = new Map<string, SourceAuditRecordRow[]>();
  for (const row of records) {
    if (!matchesDamagingClaimPattern(row.description)) {
      continue;
    }
    const list = damagingByCandidate.get(row.candidate_id);
    if (list) {
      list.push(row);
    } else {
      damagingByCandidate.set(row.candidate_id, [row]);
    }
  }

  const bursts: PreElectionDamagingBurstInternal[] = [];
  for (const election of candidateElections) {
    const damaging = damagingByCandidate.get(election.candidate_id);
    if (!damaging) {
      continue;
    }
    const electionDateMs = Date.parse(election.election_date);
    if (Number.isNaN(electionDateMs)) {
      continue;
    }
    const windowStartMs = electionDateMs - PRE_ELECTION_WINDOW_DAYS * DAY_MS;
    // The window closes at end-of-day on the election date itself.
    const windowEndMs = electionDateMs + DAY_MS;
    const inWindow = damaging.filter((row) => {
      const createdMs = Date.parse(row.created_at);
      return !Number.isNaN(createdMs) && createdMs >= windowStartMs && createdMs < windowEndMs;
    });
    if (inWindow.length < PRE_ELECTION_DAMAGING_MIN_RECORDS) {
      continue;
    }
    bursts.push({
      candidateId: election.candidate_id,
      displayName: inWindow[0]!.display_name,
      electionId: election.election_id,
      electionDate: election.election_date,
      officialBallotTitle: election.official_ballot_title,
      damagingRecordCount: inWindow.length,
      records: inWindow.slice(0, 10).map(toSampleRecord),
      recordIds: inWindow.map((row) => row.record_id),
    });
  }

  // Identical-record-set dedupe across a candidate's overlapping election
  // windows: keep the earliest election's entry.
  const byRecordSet = new Map<string, PreElectionDamagingBurstInternal>();
  for (const burst of bursts) {
    const key = `${burst.candidateId}|${[...burst.recordIds].sort().join(",")}`;
    const existing = byRecordSet.get(key);
    if (!existing || burst.electionDate < existing.electionDate) {
      byRecordSet.set(key, burst);
    }
  }
  return [...byRecordSet.values()]
    .sort((left, right) => right.damagingRecordCount - left.damagingRecordCount)
    .map(({ recordIds: _recordIds, ...burst }) => burst);
}

export type NewlySeenDomainConcentration = {
  domain: string;
  tier: "blocked" | "unlisted";
  firstSeenAt: string;
  recordCount: number;
  candidateCount: number;
  sampleRecords: SourceAuditSampleRecord[];
};

export type CorpusFirstSeenRow = {
  source_url: string;
  /** ISO timestamp (candidate_records.created_at). */
  created_at: string;
};

/**
 * Domain -> earliest created_at over the FULL corpus (no audit filters).
 * "First seen" must mean first ever: a filtered audit run only sees the
 * scoped slice, and a domain used elsewhere for years would look brand new
 * inside it.
 */
export function buildDomainFirstSeenMap(
  corpusRecords: readonly CorpusFirstSeenRow[]
): Map<string, number> {
  const firstSeenMs = new Map<string, number>();
  for (const row of corpusRecords) {
    const domainKey = toDomainKey(classifyCandidateRecordSourceDomain(row.source_url).hostname);
    if (domainKey === null) {
      continue;
    }
    const createdMs = Date.parse(row.created_at);
    if (Number.isNaN(createdMs)) {
      continue;
    }
    const existing = firstSeenMs.get(domainKey);
    if (existing === undefined || createdMs < existing) {
      firstSeenMs.set(domainKey, createdMs);
    }
  }
  return firstSeenMs;
}

/**
 * Non-listed domains whose first-ever record is inside the recent window
 * and that already feed >= NEWLY_SEEN_DOMAIN_MIN_RECORDS records (counts
 * and samples come from the scoped rows). A newly registered "local news"
 * site arriving with volume is the fake-outlet signature; a legit new
 * outlet trickles in. corpusFirstSeen must be built from ALL records
 * (buildDomainFirstSeenMap), not the scoped slice, so "first seen" means
 * first ever even in a filtered audit run.
 */
export function listNewlySeenDomainConcentrations(
  records: readonly SourceAuditRecordRow[],
  corpusFirstSeen: ReadonlyMap<string, number>,
  now: Date
): NewlySeenDomainConcentration[] {
  const windowStartMs = now.getTime() - SOURCE_AUDIT_RECENT_WINDOW_DAYS * DAY_MS;
  const groups = new Map<
    string,
    {
      tier: "blocked" | "unlisted";
      candidateIds: Set<string>;
      records: ClassifiedRecord[];
    }
  >();
  for (const record of classifyRows(records)) {
    if (record.tier === "listed" || record.domainKey === null || Number.isNaN(record.createdAtMs)) {
      continue;
    }
    let group = groups.get(record.domainKey);
    if (!group) {
      group = {
        tier: record.tier,
        candidateIds: new Set(),
        records: [],
      };
      groups.set(record.domainKey, group);
    }
    group.candidateIds.add(record.row.candidate_id);
    group.records.push(record);
  }
  return [...groups.entries()]
    .filter(([domain, group]) => {
      // First-seen comes from the corpus map, never the scoped slice; a
      // domain absent from the map cannot be judged and is skipped.
      const firstSeenMs = corpusFirstSeen.get(domain);
      return (
        firstSeenMs !== undefined &&
        firstSeenMs >= windowStartMs &&
        group.records.length >= NEWLY_SEEN_DOMAIN_MIN_RECORDS
      );
    })
    .sort((left, right) => right[1].records.length - left[1].records.length)
    .map(([domain, group]) => ({
      domain,
      tier: group.tier,
      firstSeenAt: new Date(corpusFirstSeen.get(domain)!).toISOString(),
      recordCount: group.records.length,
      candidateCount: group.candidateIds.size,
      sampleRecords: group.records.slice(0, 5).map((record) => toSampleRecord(record.row)),
    }));
}

export type UnlistedDomainSummary = {
  domain: string;
  recordCount: number;
  candidateCount: number;
  damagingRecordCount: number;
  sampleRecords: SourceAuditSampleRecord[];
};

export type SourceTierSweep = {
  tierCounts: { listed: number; unlisted: number; blocked: number };
  unlistedDomains: UnlistedDomainSummary[];
  /**
   * Stored records citing a BLOCKED domain of any class — UGC/social,
   * auto-generated candidate directory, or bot-check interstitial. The import
   * policy rejects these now, so any hit predates the policy (or arrived
   * through a path it missed) and is a direct cleanup candidate. Each row
   * carries its `blockedKind` and `repair` because the three classes need
   * three different fixes: secondary coverage for UGC, the underlying primary
   * for a directory, and the URL embedded in the query string for an
   * interstitial. Treating an interstitial as untrustworthy CONTENT would
   * discard a perfectly good .gov citation.
   */
  blockedDomainRecords: BlockedSourceAuditRecord[];
  /** Blocked-row counts per class, so the headline is not one opaque total. */
  blockedKindCounts: Record<BlockedSourceKind, number>;
  /**
   * Stored vote/sponsorship/introduction records cited to an advocacy
   * scorecard or secondary vote tracker (`findLegislativeTrackerSourceReason`).
   * The write path rejects these now; every hit predates the rule and wants
   * re-citation to the official roll call plus a description re-check,
   * because tracker summaries carry the group's framing.
   */
  trackerCitedActionRecords: SourceAuditSampleRecord[];
};

/**
 * The operator's periodic review feed: every record whose domain is
 * unlisted, grouped by domain and count-sorted. Legit domains graduate to
 * the allowlist (a trivial PR); the rest get scrutiny. Tier is a pure
 * function of the stored URL, so this retro-covers every row with no
 * schema change.
 */
export function buildSourceTierSweep(records: readonly SourceAuditRecordRow[]): SourceTierSweep {
  const tierCounts = { listed: 0, unlisted: 0, blocked: 0 };
  const unlistedGroups = new Map<
    string,
    { candidateIds: Set<string>; damagingCount: number; records: ClassifiedRecord[] }
  >();
  const blockedRecords: BlockedSourceAuditRecord[] = [];
  const blockedKindCounts: Record<BlockedSourceKind, number> = {
    ugc_social: 0,
    generated_candidate_directory: 0,
    bot_check_interstitial: 0,
  };
  const trackerCitedActionRecords: SourceAuditSampleRecord[] = [];
  for (const record of classifyRows(records)) {
    tierCounts[record.tier] += 1;
    if (findLegislativeTrackerSourceReason(record.row.description, record.row.source_url)) {
      trackerCitedActionRecords.push(toSampleRecord(record.row));
    }
    if (record.tier === "blocked" && record.blockedKind) {
      blockedRecords.push(toBlockedRecord(record.row, record.blockedKind));
      blockedKindCounts[record.blockedKind] += 1;
      continue;
    }
    if (record.tier !== "unlisted") {
      continue;
    }
    const domain = record.domainKey ?? "(unparseable-url)";
    let group = unlistedGroups.get(domain);
    if (!group) {
      group = { candidateIds: new Set(), damagingCount: 0, records: [] };
      unlistedGroups.set(domain, group);
    }
    group.candidateIds.add(record.row.candidate_id);
    if (matchesDamagingClaimPattern(record.row.description)) {
      group.damagingCount += 1;
    }
    group.records.push(record);
  }
  return {
    tierCounts,
    unlistedDomains: [...unlistedGroups.entries()]
      .sort((left, right) => right[1].records.length - left[1].records.length)
      .map(([domain, group]) => ({
        domain,
        recordCount: group.records.length,
        candidateCount: group.candidateIds.size,
        damagingRecordCount: group.damagingCount,
        sampleRecords: group.records.slice(0, 3).map((record) => toSampleRecord(record.row)),
      })),
    blockedDomainRecords: blockedRecords,
    blockedKindCounts,
    trackerCitedActionRecords,
  };
}

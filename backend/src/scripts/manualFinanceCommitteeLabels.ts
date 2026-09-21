import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import {
  classifyCitationVerificationFailure,
  verifyHttpUrlReachability,
  type UrlReachabilityResult,
} from "../ai/urlReachability.js";
import { loadProjectEnv } from "../config/env.js";
import { loadCandidateFinanceSummariesByCandidateElection } from "../pipeline/address/ballotLookup.js";
import { committeeLabelKey } from "../pipeline/address/financeCommitteeLabels.js";
import {
  CANDIDATE_ELECTION_KEY_SEPARATOR,
  FINANCE_SUMMARY_SOURCES,
} from "../pipeline/address/ballotLookupFinanceShared.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { usLatestLocalDateIso } from "../utils/usLocalDate.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import {
  buildManualResearchRepairReport,
  writeManualResearchRepairReport,
  type ManualResearchRepairGap,
} from "./manualResearchRepairReport.js";

// Manual (no AI provider) research workflow for outside-spending committee
// labels: one-line neutral descriptions of who is behind a committee, shown
// under the group's name in the finance card (finance_committee_labels,
// applied at read time by applyFinanceCommitteeLabels).
//
// Subcommands:
//   due    List committees that appear in the finance summaries of upcoming
//          elections and have no researched label yet — the work queue.
//          Enumerates through the same merged read path the ballot lookup
//          uses, so it exactly matches what voters currently see.
//   write  Validate a researched payload and upsert the labels.

type Subcommand = "due" | "write";

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:finance-committee-labels:due -- [--state XX] [--limit 500]",
    "  npm run manual:finance-committee-labels:write -- --file labels.json [--repair-report-file file] [--dry-run]",
    "",
    "The write payload shape:",
    '  { "labels": [ { "source", "committee_id", "cycle", "committee_name", "label", "source_urls": ["https://..."] } ] }',
    "",
    "Labels must be neutral, source-backed descriptions of the committee's",
    "interest (who funds it / what it advocates), never voting advice.",
  ].join("\n");
}

function readFlag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value.trim();
  }
  const inlinePrefix = `${name}=`;
  const inline = argv.find((token) => token.startsWith(inlinePrefix));
  if (inline) {
    const value = inline.slice(inlinePrefix.length).trim();
    if (value.length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value;
  }
  return null;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual finance committee labels`);
  }
  return value;
}

type DueCommittee = {
  source: string;
  committee_id: string;
  /** Labels are cycle-scoped: funder claims can change between cycles. */
  cycle: number;
  committee_name: string;
  directions: string[];
  total_amount: number;
  elections: {
    election_id: string;
    official_ballot_title: string;
    district_name: string;
    election_date: string;
    state: string;
  }[];
};

/**
 * Enumerates every outside-spending committee that appears in the finance
 * summaries of upcoming elections, through the same merged read path the
 * ballot lookup uses — so the result exactly matches what voters currently
 * see. Shared by `due` (the work queue) and `write` (existence/name checks:
 * a mistyped committee_id or cycle would otherwise write a label no voter
 * ever sees, with no error anywhere).
 */
async function collectUpcomingCommittees(
  pool: Pool,
  stateFilter: string | null,
  today: string
): Promise<Map<string, DueCommittee>> {
  // Same row shapes the ballot lookup passes to the merged finance loader.
  // Only upcoming elections: labels serve the races voters see now, and the
  // finance cards only render for ongoing elections.
  const electionResult = await pool.query(
    `
      SELECT
        e.id AS election_id,
        d.id AS district_id,
        d.district_type,
        d.geoid_compact,
        d.name AS district_name,
        d.state,
        d.state_fips,
        d.representation_power_score,
        e.race_type,
        e.official_ballot_title,
        e.election_date::text AS election_date,
        e.election_stage,
        e.is_partisan,
        e.seats_to_fill,
        e.discovery_contest_family,
        e.sources,
        office.id AS office_id,
        office.scope AS office_scope,
        office.canonical_name AS office_canonical_name
      FROM public.elections AS e
      JOIN public.districts AS d
        ON d.id = e.district_id
      LEFT JOIN public.offices AS office
        ON office.id = e.office_id
      WHERE e.election_date >= $1
        AND ($2::text IS NULL OR d.state = $2)
        AND EXISTS (
          SELECT 1 FROM public.candidate_elections AS ce WHERE ce.election_id = e.id
        )
      ORDER BY e.election_date, e.id
    `,
    [today, stateFilter]
  );
  const electionRows = electionResult.rows as Parameters<
    typeof loadCandidateFinanceSummariesByCandidateElection
  >[2];

  const electionIds = electionResult.rows.map((row: { election_id: string }) => row.election_id);
  const candidateResult = await pool.query(
    `
      SELECT ce.election_id, c.id AS candidate_id, c.fec_ids
      FROM public.candidate_elections AS ce
      JOIN public.candidates AS c
        ON c.id = ce.candidate_id
      WHERE ce.election_id = ANY($1::uuid[])
        AND c.deleted_at IS NULL
        AND c.merged_into_candidate_id IS NULL
    `,
    [electionIds]
  );
  const candidateRows = candidateResult.rows as Parameters<
    typeof loadCandidateFinanceSummariesByCandidateElection
  >[1];

  const summaries = await loadCandidateFinanceSummariesByCandidateElection(pool, candidateRows, electionRows);

  const electionById = new Map(
    electionResult.rows.map((row: { election_id: string }) => [row.election_id, row])
  );
  const committees = new Map<string, DueCommittee>();
  for (const [key, summary] of summaries) {
    // The map key is candidateElectionKey's join; recover the election id
    // with the shared separator instead of re-encoding it.
    const electionId = key.split(CANDIDATE_ELECTION_KEY_SEPARATOR)[1];
    const election = electionById.get(electionId) as
      | {
          election_id: string;
          official_ballot_title: string;
          district_name: string;
          election_date: string;
          state: string;
        }
      | undefined;
    for (const group of [
      ...summary.outside_spending.top_supporting_groups,
      ...summary.outside_spending.top_opposing_groups,
    ]) {
      // Cycle-scoped, matching the table key: the same committee reappears
      // as due in a new cycle instead of inheriting stale funder claims.
      const committeeKey = committeeLabelKey(summary.source, group.committee_id, summary.cycle);
      const entry = committees.get(committeeKey) ?? {
        source: summary.source,
        committee_id: group.committee_id,
        cycle: summary.cycle,
        committee_name: group.committee_name,
        directions: [],
        total_amount: 0,
        elections: [],
      };
      if (!entry.directions.includes(group.support_oppose)) {
        entry.directions.push(group.support_oppose);
      }
      entry.total_amount += group.amount;
      // Dedupe by election id: ballot titles repeat freely (ten same-day
      // "State Representative" races, possibly across states).
      if (election && !entry.elections.some((seen) => seen.election_id === election.election_id)) {
        entry.elections.push({
          election_id: election.election_id,
          official_ballot_title: election.official_ballot_title,
          district_name: election.district_name,
          election_date: election.election_date,
          state: election.state,
        });
      }
      committees.set(committeeKey, entry);
    }
    // Conduit groups (individual donations sent through a group) are shown
    // with the same researched label, so they queue the same way.
    for (const conduit of summary.direct_campaign.conduit_donations ?? []) {
      const committeeKey = committeeLabelKey(summary.source, conduit.committee_id, summary.cycle);
      const entry = committees.get(committeeKey) ?? {
        source: summary.source,
        committee_id: conduit.committee_id,
        cycle: summary.cycle,
        committee_name: conduit.committee_name,
        directions: [],
        total_amount: 0,
        elections: [],
      };
      if (!entry.directions.includes("conduit")) {
        entry.directions.push("conduit");
      }
      entry.total_amount += conduit.amount;
      if (election && !entry.elections.some((seen) => seen.election_id === election.election_id)) {
        entry.elections.push({
          election_id: election.election_id,
          official_ballot_title: election.official_ballot_title,
          district_name: election.district_name,
          election_date: election.election_date,
          state: election.state,
        });
      }
      committees.set(committeeKey, entry);
    }
  }
  return committees;
}

async function runDue(pool: Pool, argv: readonly string[]): Promise<void> {
  const stateFilter = readFlag(argv, "--state")?.toUpperCase() ?? null;
  const limit = readPositiveIntegerFlag(argv, "--limit", 500);
  const today = usLatestLocalDateIso();
  const committees = await collectUpcomingCommittees(pool, stateFilter, today);

  // Drop committees that already have a researched label for their cycle.
  let unlabeled = [...committees.values()];
  if (unlabeled.length > 0) {
    const labeled = await pool.query<{ source: string; committee_id: string; cycle: number }>(
      `
        SELECT l.source, l.committee_id, l.cycle
        FROM public.finance_committee_labels AS l
        JOIN unnest($1::text[], $2::text[], $3::int[]) AS wanted(source, committee_id, cycle)
          ON wanted.source = l.source
         AND wanted.committee_id = l.committee_id
         AND wanted.cycle = l.cycle
      `,
      [
        unlabeled.map((entry) => entry.source),
        unlabeled.map((entry) => entry.committee_id),
        unlabeled.map((entry) => entry.cycle),
      ]
    );
    const labeledKeys = new Set(
      labeled.rows.map((row) => committeeLabelKey(row.source, row.committee_id, row.cycle))
    );
    unlabeled = unlabeled.filter(
      (entry) => !labeledKeys.has(committeeLabelKey(entry.source, entry.committee_id, entry.cycle))
    );
  }

  unlabeled.sort((a, b) => b.total_amount - a.total_amount);
  console.log(
    JSON.stringify(
      {
        as_of_date: today,
        state: stateFilter,
        unlabeled_committee_count: unlabeled.length,
        committees: unlabeled.slice(0, limit),
      },
      null,
      2
    )
  );
}

export type CommitteeLabelPayloadRow = {
  source: string;
  committee_id: string;
  cycle: number;
  committee_name: string;
  label: string;
  source_urls: string[];
};

// A label renders as prose under the committee's name in a narrow column, so
// length is a readability limit, not a storage one: at 200 the first pass
// averaged 142 characters and wrapped to three lines of disclosure jargon.
// 130 forces one plain sentence — the whole point of the label is that a
// voter reads it without effort.
const MAX_LABEL_LENGTH = 130;
// Sanity bounds only — cycles come from the due list verbatim.
const MIN_CYCLE = 1990;
const MAX_CYCLE = 2100;

// Endpoints that answer 200 with a content-free page, so the reachability
// check cannot catch them: it verifies a URL ANSWERS, not that it says
// anything. A citation like this passes validation, ships to voters as a
// clickable "evidence" link, and shows them an error — silently, forever.
//
// Scoped to the exact endpoints observed to be broken, never a whole host:
// cfis.state.nm.us also serves CFIS_Data_Download.aspx, which works and is a
// legitimate citation. Refusing a host wholesale trades a silent bad
// citation for a fail-closed block on good ones, which is not a trade worth
// making. The message names the replacement, because an operator who hits
// this needs the source that works rather than a refusal.
const CONTENT_FREE_SOURCE_ENDPOINTS: readonly {
  host: string;
  pathEndsWith: readonly string[];
  reason: string;
}[] = [
  {
    host: "cfis.state.nm.us",
    pathEndsWith: ["/pacexpenditures.aspx", "/pacreport.aspx"],
    reason:
      "New Mexico's CFIS serves contribution data only inside a search session — these " +
      'deep links answer 200 with "There has been an unexpected error" and "No results ' +
      'found", for every id. Cite moneytrailnm.com instead (New Mexico In Depth\'s ' +
      "republication of the same Secretary of State data, with stable per-committee " +
      "URLs). CFIS_Data_Download.aspx on the same host works and stays citable.",
  },
];

export function contentFreeSourceUrlReason(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase();
  for (const entry of CONTENT_FREE_SOURCE_ENDPOINTS) {
    if (entry.host === host && entry.pathEndsWith.some((suffix) => path.endsWith(suffix))) {
      return entry.reason;
    }
  }
  return null;
}

/**
 * Validates the write payload. Throws with every problem listed at once so a
 * multi-row payload is fixed in one pass, mirroring the other manual writers.
 */
export function parseCommitteeLabelPayload(raw: unknown): CommitteeLabelPayloadRow[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { labels?: unknown }).labels)) {
    throw new Error(`Payload must be an object with a "labels" array.\n${usage()}`);
  }
  const labels = (raw as { labels: unknown[] }).labels;
  if (labels.length === 0) {
    throw new Error("Payload has an empty labels array — nothing to write.");
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const rows: CommitteeLabelPayloadRow[] = [];
  const knownSources = new Set<string>(FINANCE_SUMMARY_SOURCES);
  labels.forEach((entry, index) => {
    const at = `labels[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const row = entry as Record<string, unknown>;
    const source = typeof row.source === "string" ? row.source.trim() : "";
    const committeeId = typeof row.committee_id === "string" ? row.committee_id.trim() : "";
    const cycle = typeof row.cycle === "number" && Number.isInteger(row.cycle) ? row.cycle : null;
    const committeeName = typeof row.committee_name === "string" ? row.committee_name.trim() : "";
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const rawSourceUrls = Array.isArray(row.source_urls) ? row.source_urls : [];
    // A non-string entry is a malformed payload, not an ignorable extra:
    // silently filtering it out would pass a row whose evidence list lost
    // an entry the researcher thought they provided.
    if (rawSourceUrls.some((url) => typeof url !== "string")) {
      errors.push(`${at}: source_urls entries must all be strings`);
    }
    const sourceUrls = rawSourceUrls
      .filter((url): url is string => typeof url === "string")
      .map((url) => url.trim());

    if (!knownSources.has(source)) {
      errors.push(`${at}: unknown source "${source}" — must be one of the finance summary sources`);
    }
    if (committeeId.length === 0) {
      errors.push(`${at}: committee_id is required`);
    }
    if (cycle === null || cycle < MIN_CYCLE || cycle > MAX_CYCLE) {
      errors.push(`${at}: cycle must be an integer between ${MIN_CYCLE} and ${MAX_CYCLE} (copy it from the due list)`);
    }
    if (committeeName.length === 0) {
      errors.push(`${at}: committee_name is required`);
    }
    if (label.length === 0) {
      errors.push(`${at}: label is required`);
    } else if (label.length > MAX_LABEL_LENGTH) {
      errors.push(`${at}: label exceeds ${MAX_LABEL_LENGTH} characters (${label.length})`);
    } else if (/[\r\n]/.test(label)) {
      errors.push(`${at}: label must be a single line`);
    }
    if (sourceUrls.length === 0) {
      errors.push(`${at}: source_urls must contain at least one URL`);
    } else {
      for (const url of sourceUrls) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
        } catch {
          parsed = null;
        }
        if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
          errors.push(`${at}: source_urls entry is not a valid http(s) URL: ${url}`);
        }
      }
    }
    const key = committeeLabelKey(source, committeeId, cycle ?? 0);
    if (seen.has(key)) {
      errors.push(
        `${at}: duplicate (source, committee_id, cycle) in payload: ${source} ${committeeId} ${cycle}`
      );
    }
    seen.add(key);
    rows.push({
      source,
      committee_id: committeeId,
      cycle: cycle ?? 0,
      committee_name: committeeName,
      label,
      source_urls: sourceUrls,
    });
  });
  if (errors.length > 0) {
    throw new Error(`Invalid committee-label payload:\n- ${errors.join("\n- ")}`);
  }
  return rows;
}

// Names arrive by copy-paste from the due list, so an exact match is the
// expectation — the normalization only forgives whitespace/case drift, not
// a different committee.
function normalizeCommitteeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * One deep-validation problem, structured so the CLI can both print it and
 * emit a machine repair report a later session resumes from.
 */
export type CommitteeLabelValidationIssue = {
  index: number;
  kind: "missing_committee" | "name_mismatch" | "source_url";
  reason: string;
  sourceUrl?: string;
  failureType?: "transient" | "permanent";
  // A source_url issue where the URL ANSWERED but served nothing usable.
  // Kept apart from an ordinary unreachable URL because the repair differs:
  // not "the host is down, try again", but "this endpoint never carries the
  // data — cite a different one". The report is read by a later session, so
  // calling this unreachable sends it hunting for a connectivity fault.
  contentFree?: true;
};

/**
 * Checks every payload row against the committees currently present in
 * upcoming elections' finance summaries. A triple absent from live data or
 * a committee_name that names a different committee is a research/transcribe
 * error: the label would either never display or assert claims about the
 * wrong committee.
 *
 * A triple that already has a stored label row stays writable after its
 * elections pass (storedCommittees, name checked against the stored
 * snapshot): correcting an existing label is the same command, and the live
 * summaries no longer carry a finished race's committees. Only NEW labels
 * must appear in upcoming elections' summaries.
 */
export function checkRowsAgainstLiveCommittees(
  rows: readonly CommitteeLabelPayloadRow[],
  liveCommittees: ReadonlyMap<string, Pick<DueCommittee, "committee_name">>,
  storedCommittees: ReadonlyMap<string, Pick<DueCommittee, "committee_name">> = new Map()
): CommitteeLabelValidationIssue[] {
  const issues: CommitteeLabelValidationIssue[] = [];
  rows.forEach((row, index) => {
    const key = committeeLabelKey(row.source, row.committee_id, row.cycle);
    const known = liveCommittees.get(key) ?? storedCommittees.get(key);
    if (!known) {
      issues.push({
        index,
        kind: "missing_committee",
        reason: `(${row.source}, ${row.committee_id}, ${row.cycle}) is not in any upcoming election's finance summaries and has no existing label row — copy the triple from the due list`,
      });
      return;
    }
    if (normalizeCommitteeName(known.committee_name) !== normalizeCommitteeName(row.committee_name)) {
      issues.push({
        index,
        kind: "name_mismatch",
        reason: `committee_name "${row.committee_name}" does not match the known committee name "${known.committee_name}" for (${row.source}, ${row.committee_id}, ${row.cycle})`,
      });
    }
  });
  return issues;
}

/**
 * Verifies every source URL actually answers, mirroring the citation checks
 * the other manual writers run before writing. 403 is allowed (official
 * hosts routinely reject HEAD/bot requests they would serve to a browser),
 * and transient failures get one plain retry — slow official hosts routinely
 * pass on it, while permanent failures (404, DNS, TLS) never do. Endpoints
 * known to answer with a content-free page fail here too: they would sail
 * through a reachability check, so they are settled without a request.
 */
export async function checkLabelSourceUrls(
  rows: readonly CommitteeLabelPayloadRow[],
  verify: typeof verifyHttpUrlReachability = verifyHttpUrlReachability
): Promise<CommitteeLabelValidationIssue[]> {
  // Endpoints known to answer with nothing are settled before any request:
  // they would pass the reachability check (they DO answer), and asking is
  // wasted work. Seeding the result map as a permanent failure routes them
  // through the same reporting path as a 404, so `--repair-report-file`
  // carries them — the report is what a later session resumes from, and a
  // dead citation is exactly the evidence gap it exists to describe.
  const uniqueUrls = [...new Set(rows.flatMap((row) => row.source_urls))];
  const resultByUrl = new Map<string, UrlReachabilityResult>();
  const contentFreeUrls = new Set<string>();
  for (const url of uniqueUrls) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    const reason = parsed === null ? null : contentFreeSourceUrlReason(parsed);
    if (reason !== null) {
      contentFreeUrls.add(url);
      resultByUrl.set(url, { ok: false, reason });
    }
  }

  const verifyBatch = async (batch: readonly string[]): Promise<void> => {
    const workerCount = Math.min(4, batch.length);
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          if (currentIndex >= batch.length) {
            return;
          }
          const url = batch[currentIndex];
          if (!url) {
            continue;
          }
          resultByUrl.set(url, await verify(url, { timeoutMs: 8_000, allowStatusCodes: [403] }));
        }
      })
    );
  };

  await verifyBatch(uniqueUrls.filter((url) => !contentFreeUrls.has(url)));
  const transientUrls = uniqueUrls.filter((url) => {
    const result = resultByUrl.get(url);
    return (
      result !== undefined &&
      !result.ok &&
      classifyCitationVerificationFailure(result.reason) === "transient"
    );
  });
  if (transientUrls.length > 0) {
    await verifyBatch(transientUrls);
  }

  const issues: CommitteeLabelValidationIssue[] = [];
  rows.forEach((row, index) => {
    for (const url of row.source_urls) {
      const result = resultByUrl.get(url);
      if (result !== undefined && !result.ok) {
        const contentFree = contentFreeUrls.has(url);
        issues.push({
          index,
          kind: "source_url",
          reason: `${
            contentFree ? "source URL answered with no usable content" : "source URL unreachable"
          } (${result.reason}): ${url}`,
          sourceUrl: url,
          // Stated outright rather than inferred from the reason text: a
          // known-dead endpoint is permanent by construction, and must not
          // depend on that prose happening to miss the transient markers.
          failureType: contentFree ? "permanent" : classifyCitationVerificationFailure(result.reason),
          ...(contentFree ? { contentFree: true as const } : {}),
        });
      }
    }
  });
  return issues;
}

// One repair gap per issue: the report is what a later session resumes
// from, so each gap carries a focused instruction matching the issue kind.
function committeeLabelIssueToRepairGap(
  issue: CommitteeLabelValidationIssue,
  row: CommitteeLabelPayloadRow | undefined
): ManualResearchRepairGap {
  const triple = row ? `${row.source}.${row.committee_id}.${row.cycle}` : `labels_${issue.index}`;
  const focusedResearchPass =
    issue.kind !== "source_url"
      ? "Regenerate this row from a fresh manual:finance-committee-labels:due run — copy source, committee_id, cycle, and committee_name verbatim — then rerun the committee-label writer."
      : issue.contentFree
        ? "Replace this source URL: the endpoint answers, so retrying or waiting will not help — it simply never carries the committee's data. Cite a source that actually shows the evidence (the reason names the working replacement), or drop the row and report the committee as an unresolved gap, then rerun the committee-label writer."
        : "Re-research this committee's label evidence: replace the unreachable source URL with a reachable source that still supports the label, or drop the row and report the committee as an unresolved gap, then rerun the committee-label writer.";
  return {
    id: `finance_committee_label.${triple}.${issue.kind}`,
    stage: "finance_committee_labels",
    objectType: "finance_committee_label",
    outcome: "needs_repair",
    reason: issue.reason,
    focusedResearchPass,
    labelIndex: issue.index,
    ...(issue.sourceUrl ? { sourceUrl: issue.sourceUrl } : {}),
    failureKind: issue.kind === "source_url" ? "source_url" : "label_validation",
    ...(issue.failureType ? { failureType: issue.failureType } : {}),
  };
}

async function runWrite(pool: Pool, argv: readonly string[]): Promise<void> {
  const file = readFlag(argv, "--file");
  if (!file) {
    throw new Error(`--file is required.\n${usage()}`);
  }
  const dryRun = argv.includes("--dry-run");
  const repairReportFile = readFlag(argv, "--repair-report-file");
  const rows = parseCommitteeLabelPayload(JSON.parse(await readFile(file, "utf8")) as unknown);

  // Deep validation beyond the shape checks, mirroring the other manual
  // writers: the triple must exist in live finance data, the name must match
  // it, and every source URL must answer. Both checks run before reporting
  // so a multi-row payload is fixed in one pass. Dry runs validate too —
  // that is what a rehearsal is for.
  const liveCommittees = await collectUpcomingCommittees(pool, null, usLatestLocalDateIso());
  // Triples that already have a label row stay correctable after their
  // elections pass — validated against the stored name snapshot.
  const storedResult = await pool.query<{ source: string; committee_id: string; cycle: number; committee_name: string }>(
    `
      SELECT l.source, l.committee_id, l.cycle, l.committee_name
      FROM public.finance_committee_labels AS l
      JOIN unnest($1::text[], $2::text[], $3::int[]) AS wanted(source, committee_id, cycle)
        ON wanted.source = l.source
       AND wanted.committee_id = l.committee_id
       AND wanted.cycle = l.cycle
    `,
    [rows.map((row) => row.source), rows.map((row) => row.committee_id), rows.map((row) => row.cycle)]
  );
  const storedCommittees = new Map(
    storedResult.rows.map((row) => [
      committeeLabelKey(row.source, row.committee_id, row.cycle),
      { committee_name: row.committee_name },
    ])
  );
  const issues = [
    ...checkRowsAgainstLiveCommittees(rows, liveCommittees, storedCommittees),
    ...(await checkLabelSourceUrls(rows)),
  ];
  if (issues.length > 0) {
    // Same machine repair report the profile/records writers emit, so a
    // later session can resume the fix without this run's terminal output.
    await writeManualResearchRepairReport(
      repairReportFile,
      buildManualResearchRepairReport({
        command: "manual:finance-committee-labels:write",
        manualKey: "manual:finance-committee-labels:payload",
        target: { file },
        gaps: issues.map((issue) => committeeLabelIssueToRepairGap(issue, rows[issue.index])),
      })
    );
    throw new Error(
      `Committee-label validation failed:\n- ${issues
        .map((issue) => `labels[${issue.index}]: ${issue.reason}`)
        .join("\n- ")}`
    );
  }

  if (dryRun) {
    console.log(JSON.stringify({ dry_run: true, valid_rows: rows.length, rows }, null, 2));
    return;
  }

  let inserted = 0;
  let updated = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const result = await client.query<{ inserted: boolean }>(
        `
          INSERT INTO public.finance_committee_labels
            (source, committee_id, cycle, committee_name, label, source_urls, researched_at)
          VALUES ($1, $2, $3, $4, $5, $6, now())
          ON CONFLICT (source, committee_id, cycle) DO UPDATE SET
            committee_name = EXCLUDED.committee_name,
            label = EXCLUDED.label,
            source_urls = EXCLUDED.source_urls,
            researched_at = now()
          RETURNING (xmax = 0) AS inserted
        `,
        [row.source, row.committee_id, row.cycle, row.committee_name, row.label, row.source_urls]
      );
      if (result.rows[0]?.inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ inserted, updated }, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "due" && command !== "write") {
    throw new Error(`Unknown subcommand: ${command ?? "(none)"}.\n${usage()}`);
  }
  const subcommand: Subcommand = command;

  const flagSpecs = {
    due: [
      { name: "--state", value: "both" as const },
      { name: "--limit", value: "both" as const },
    ],
    write: [
      { name: "--file", value: "both" as const },
      { name: "--repair-report-file", value: "both" as const },
      { name: "--dry-run", value: "none" as const },
    ],
  }[subcommand];
  assertKnownCliFlags(`manual:finance-committee-labels:${subcommand}`, rest, flagSpecs);

  loadProjectEnv();
  const databaseUrl = requireEnv("DATABASE_URL");
  if (subcommand === "write") {
    requireLocalDatabaseTarget(databaseUrl);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (subcommand === "due") {
      await runDue(pool, rest);
    } else {
      await runWrite(pool, rest);
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("manual finance committee labels failed:", message);
    process.exitCode = 1;
  });
}

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { congressGovBillUrl, parseFederalMeasure } from "../pipeline/rollcall/federalMeasures.js";
import {
  federalRollCallUrls,
  fetchFederalRollCallXml,
  parseFederalRollCallXml,
} from "../pipeline/rollcall/federalRollCallXml.js";
import {
  upsertLegislativeVoteSource,
  type LegislativeVoteUpsertOutcome,
} from "../pipeline/rollcall/legislativeVoteStore.js";
import { LEGISLATIVE_VOTE_CHAMBERS, type LegislativeVoteChamber } from "../pipeline/rollcall/legislativeVotes.js";
import { classifyFederalRollCall, type RollCallQuestionClass } from "../pipeline/rollcall/rollCallQuestionClass.js";
import { reportPath } from "../pipeline/rollcall/rollCallReportPaths.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Phase-1 fetcher for the roll-call import (docs/plans/roll-call-vote-import.md
// §1, steps 1-2): pulls the named federal roll calls, keeps the raw XML as
// evidence, classifies each question, and stores the roll call on
// legislative_votes as a pending review-queue row. Read-only on the web, no
// candidate writes, no AI. Example:
//
//   npm run rollcall:fetch -- --chamber house --congress 119 --session 1 --rolls 14,145,190
//   npm run rollcall:fetch -- --chamber senate --congress 119 --session 1 --rolls 600-659 --dry-run

export const ROLLCALL_FETCH_IMPORTER_VERSION = "rollcall-fetch-v1";
const DEFAULT_DELAY_MS = 300;
// A chamber records well under 1,000 roll calls per session, so one run can
// always cover a whole session; the cap only stops a typo such as
// `--rolls 1-1000000` from expanding before the first request.
export const MAX_ROLLS_PER_RUN = 1000;

export type RollCallFetchReportRow = {
  chamber: LegislativeVoteChamber;
  congress: number;
  session: number;
  roll: number;
  machineUrl: string;
  outcome: LegislativeVoteUpsertOutcome | "dry_run" | "missing" | "fetch_error" | "parse_error" | "session_mismatch";
  evidenceFile: string | null;
  voteDate: string | null;
  measureId: string | null;
  question: string | null;
  result: string | null;
  yeas: number | null;
  nays: number | null;
  memberVoteCount: number | null;
  isFloorVote: boolean | null;
  questionClass: RollCallQuestionClass | null;
  classificationReason: string | null;
  // Set on an `updated` row whose question or measure changed: its stored
  // judgment was cleared and it is pending again.
  judgmentCleared: boolean;
  error: string | null;
};

// Outcomes that mean the run itself did not do what was asked (as opposed
// to a roll call that does not exist, a vote shape the parser declines, or
// an approved row that needs a human). The report is still written; the
// exit code just stops automation from reading such a run as clean.
const FAILURE_OUTCOMES: ReadonlySet<RollCallFetchReportRow["outcome"]> = new Set(["fetch_error", "session_mismatch"]);

/**
 * `14,18,190-192` → [14, 18, 190, 191, 192]; ascending, de-duplicated.
 */
export function parseRollList(raw: string): number[] {
  const rolls = new Set<number>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token.length === 0) {
      continue;
    }
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) {
      throw new Error(`--rolls entry is not a number or range: ${token}`);
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new Error(`--rolls entry is out of range: ${token}`);
    }
    if (start < 1 || end < start) {
      throw new Error(`--rolls range is empty or starts below 1: ${token}`);
    }
    if (rolls.size + (end - start + 1) > MAX_ROLLS_PER_RUN) {
      throw new Error(`--rolls names more than ${MAX_ROLLS_PER_RUN} roll calls; split the run`);
    }
    for (let roll = start; roll <= end; roll += 1) {
      rolls.add(roll);
    }
  }
  if (rolls.size === 0) {
    throw new Error("--rolls names no roll calls");
  }
  return [...rolls].sort((a, b) => a - b);
}

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

function requireValueFlag(argv: readonly string[], flagName: string): string {
  const value = readValueFlag(argv, flagName);
  if (value === null) {
    throw new Error(`${flagName} is required`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("rollcall:fetch", argv, [
    { name: "--chamber", value: "both" },
    { name: "--congress", value: "both" },
    { name: "--session", value: "both" },
    { name: "--rolls", value: "both" },
    { name: "--delay-ms", value: "both" },
    { name: "--evidence-dir", value: "both" },
    { name: "--dry-run", value: "none" },
  ]);

  const chamberRaw = requireValueFlag(argv, "--chamber");
  if (!(LEGISLATIVE_VOTE_CHAMBERS as readonly string[]).includes(chamberRaw)) {
    throw new Error(`--chamber must be one of ${LEGISLATIVE_VOTE_CHAMBERS.join(", ")}, got: ${chamberRaw}`);
  }
  const chamber = chamberRaw as LegislativeVoteChamber;
  const congress = readPositiveIntegerFlag(argv, "--congress", 0);
  const session = readPositiveIntegerFlag(argv, "--session", 0);
  if (congress === 0 || session === 0) {
    throw new Error("--congress and --session are required");
  }
  if (session !== 1 && session !== 2) {
    throw new Error(`--session must be 1 or 2, got: ${session}`);
  }
  const rolls = parseRollList(requireValueFlag(argv, "--rolls"));
  const delayMs = readPositiveIntegerFlag(argv, "--delay-ms", DEFAULT_DELAY_MS);
  const dryRun = argv.includes("--dry-run");

  const startedAt = new Date();
  const runId = `rollcall-fetch-${chamber}-${congress}-${session}-${startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;
  const evidenceDir = resolve(readValueFlag(argv, "--evidence-dir") ?? resolve(process.cwd(), "evidence", "rollcall", runId));
  mkdirSync(evidenceDir, { recursive: true });

  loadProjectEnv();
  let pool: Pool | null = null;
  if (!dryRun) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to store roll calls (or pass --dry-run)");
    }
    pool = new Pool({ connectionString: databaseUrl });
  }

  const sessionKey = `${congress}-${session}`;
  const rows: RollCallFetchReportRow[] = [];
  try {
    for (const [index, roll] of rolls.entries()) {
      if (index > 0) {
        await sleep(delayMs);
      }
      const urls = federalRollCallUrls(chamber, congress, session, roll);
      const row: RollCallFetchReportRow = {
        chamber,
        congress,
        session,
        roll,
        machineUrl: urls.machineUrl,
        outcome: "fetch_error",
        evidenceFile: null,
        voteDate: null,
        measureId: null,
        question: null,
        result: null,
        yeas: null,
        nays: null,
        memberVoteCount: null,
        isFloorVote: null,
        questionClass: null,
        classificationReason: null,
        judgmentCleared: false,
        error: null,
      };
      rows.push(row);

      let body: string;
      try {
        const fetched = await fetchFederalRollCallXml(urls.machineUrl).catch(async (error: unknown) => {
          // One retry covers a transient 5xx or a dropped connection.
          console.error(`retrying ${urls.machineUrl}: ${errorMessage(error)}`);
          await sleep(delayMs);
          return fetchFederalRollCallXml(urls.machineUrl);
        });
        if (fetched.status === "missing") {
          row.outcome = "missing";
          continue;
        }
        body = fetched.body;
      } catch (error) {
        row.error = errorMessage(error);
        continue;
      }

      const fetchedAt = new Date();
      const sourceSha256 = createHash("sha256").update(body).digest("hex");
      const evidenceFile = `${chamber}-${congress}-${session}-roll${String(roll).padStart(5, "0")}.xml`;
      writeFileSync(resolve(evidenceDir, evidenceFile), body);
      row.evidenceFile = evidenceFile;

      let parsed;
      try {
        parsed = parseFederalRollCallXml(chamber, body);
      } catch (error) {
        row.outcome = "parse_error";
        row.error = errorMessage(error);
        continue;
      }
      row.voteDate = parsed.voteDate;
      row.measureId = parsed.measureId;
      row.question = parsed.question;
      row.result = parsed.result;
      row.yeas = parsed.yeas;
      row.nays = parsed.nays;
      row.memberVoteCount = parsed.memberVoteCount;

      // The House files by calendar year and a session's last days can
      // spill into the next January; trust the XML's own stamp over the URL.
      if (parsed.congress !== congress || parsed.session !== session || parsed.rollNumber !== roll) {
        row.outcome = "session_mismatch";
        row.error = `XML says congress ${parsed.congress} session ${parsed.session} roll ${parsed.rollNumber}`;
        continue;
      }

      const measure = parseFederalMeasure(parsed.measureId);
      const classification = classifyFederalRollCall({
        chamber,
        question: parsed.question,
        measure,
        roll: { congress, session, rollNumber: roll },
      });
      row.isFloorVote = classification.isFloorVote;
      row.questionClass = classification.questionClass;
      row.classificationReason = classification.reason;

      if (!pool) {
        row.outcome = "dry_run";
        continue;
      }
      try {
        const result = await upsertLegislativeVoteSource(pool, {
          jurisdiction: "US",
          chamber,
          session: sessionKey,
          rollNumber: roll,
          voteDate: parsed.voteDate,
          measureId: parsed.measureId,
          exactQuestion: parsed.question,
          isFloorVote: classification.isFloorVote,
          result: parsed.result,
          yeas: parsed.yeas,
          nays: parsed.nays,
          displayUrl: urls.displayUrl,
          machineUrl: urls.machineUrl,
          billUrl: congressGovBillUrl(congress, measure),
          sourceSha256,
          fetchedAt,
          importerVersion: ROLLCALL_FETCH_IMPORTER_VERSION,
        });
        row.outcome = result.outcome;
        row.judgmentCleared = result.judgmentCleared;
      } catch (error) {
        row.outcome = "fetch_error";
        row.error = `store: ${errorMessage(error)}`;
      }
    }
  } finally {
    await pool?.end();
  }

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  }
  const floorVotes = rows.filter((row) => row.isFloorVote === true).length;
  const report = {
    runId,
    importerVersion: ROLLCALL_FETCH_IMPORTER_VERSION,
    chamber,
    congress,
    session,
    dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    evidenceDir: reportPath(evidenceDir),
    requestedRolls: rolls.length,
    floorVotes,
    counts,
    rows,
  };
  // Named by run id: fetches land per chamber (and top-ups later) in ONE
  // campaign evidence dir, and a fixed name made each fetch eat the
  // previous fetch's ledger entry (the pilot's House report was lost this
  // way).
  writeFileSync(resolve(evidenceDir, `${runId}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
  if (rows.some((row) => FAILURE_OUTCOMES.has(row.outcome))) {
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("rollcall:fetch failed:", errorMessage(error));
    process.exitCode = 1;
  });
}

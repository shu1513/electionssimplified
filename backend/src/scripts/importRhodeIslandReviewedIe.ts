import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { isRhodeIslandCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import { loadRhodeIslandReviewedIePacket } from "../pipeline/rhodeIslandFinance/rhodeIslandReviewedCf8Source.js";
import { writeRhodeIslandReviewedIePacket } from "../pipeline/rhodeIslandFinance/rhodeIslandReviewedIeWriter.js";
import type { RhodeIslandReviewedCf8Report } from "../pipeline/rhodeIslandFinance/rhodeIslandReviewedCf8.js";
import { readStrictFlagValues } from "../utils/cliFlags.js";

function check(v: unknown, reason: string): asserts v { if (!v) throw new Error(reason); }
export function parseRhodeIslandReviewedIeArgs(args: readonly string[]) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--cache-dir") { i++; continue; }
    check(arg.startsWith("--cache-dir=") || arg === "--reviewed-mapping" || arg === "--dry-run", "unknown_cli_argument");
  }
  const dirs = readStrictFlagValues(args, "--cache-dir");
  check(dirs.length === 1 && dirs[0]?.trim(), "one_cache_directory_required");
  check(args.filter(a => a === "--reviewed-mapping").length === 1, "manual_mapping_review_required");
  return { cacheDir: resolve(dirs[0]), reviewedMapping: true as const, dryRun: args.includes("--dry-run") };
}
export type RhodeIslandReviewedIeInput = {
  candidateId: string; electionId: string; electionYear: number; spenderName: string;
  reviewedSpenderNames: readonly string[]; reports: readonly RhodeIslandReviewedCf8Report[];
};
/** Curated scanned-paper input stays on stdin. Cache originals, current
 * canonical ownership and all report/cent controls are rechecked before write.
 * This deliberately has no receiving-link dependency or live network fallback.
 */
export async function runRhodeIslandReviewedIeImport(input: {
  options: ReturnType<typeof parseRhodeIslandReviewedIeArgs>; payload: RhodeIslandReviewedIeInput; db?: Pool;
}) {
  check(isRhodeIslandCampaignFinanceSyncEnabled(false), "finance_sync_disabled");
  check(input.payload && typeof input.payload === "object" && Object.keys(input.payload).sort().join(",") ===
    "candidateId,electionId,electionYear,reports,reviewedSpenderNames,spenderName", "reviewed_payload_shape");
  check(input.db || process.env.DATABASE_URL?.trim(), "database_url_required");
  const owned = input.db ? undefined : new Pool({ connectionString: process.env.DATABASE_URL });
  const db = input.db ?? owned!;
  try {
    const packet = await loadRhodeIslandReviewedIePacket({ ...input.payload, cacheDir: input.options.cacheDir,
      db, reviewedMapping: input.options.reviewedMapping });
    const result = input.options.dryRun ? null : await writeRhodeIslandReviewedIePacket({ db, packet, reviewedMapping: true });
    return { type: "rhode_island_reviewed_ie_import", dry_run: input.options.dryRun, accepted: 1,
      written: result?.status === "written" ? 1 : 0, unchanged: result?.status === "unchanged" ? 1 : 0,
      source_reports: packet.sourceReportCount, ie_reports: packet.reports.length,
      excluded_non_ie_reports: packet.excludedNonIeReportCount, occurrences: packet.occurrenceCount,
      source_observed_at: packet.observedAt, source_completed_at: packet.completedAt };
  } finally { await owned?.end(); }
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: rhode-island-candidates:finance:ie:import --cache-dir <directory> --reviewed-mapping [--dry-run]\nProvide reviewed JSON on stdin after reading every complete original and verifying the ballot and payer mapping. Requires explicit DATABASE_URL and inline state master/sync flags. Cache only; no provider calls.");
    return;
  }
  const options = parseRhodeIslandReviewedIeArgs(process.argv.slice(2));
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of process.stdin) {
    const buffer = Buffer.from(part); bytes += buffer.length; check(bytes <= 8 * 1024 * 1024, "reviewed_input_too_large"); parts.push(buffer);
  }
  const payload = JSON.parse(Buffer.concat(parts).toString("utf8")) as RhodeIslandReviewedIeInput;
  console.log(JSON.stringify(await runRhodeIslandReviewedIeImport({ options, payload })));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ type: "rhode_island_reviewed_ie_import", held: true, code: "source_or_import_failed",
      reason: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}

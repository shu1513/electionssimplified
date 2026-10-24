import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadProjectEnv } from "../config/env.js";
import { isRhodeIslandCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import { DEFAULT_RHODE_ISLAND_ERTS_CACHE_DIR } from "../pipeline/rhodeIslandFinance/rhodeIslandErtsArtifactCache.js";
import { riCommitteeCashCheck as check, RhodeIslandCommitteeCashHold } from "../pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashAggregator.js";
import { loadRhodeIslandCanonicalCashContext } from "../pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashContext.js";
import { loadRhodeIslandCashPacket } from "../pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashSource.js";
import { writeRhodeIslandCashPacket } from "../pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashWriter.js";
import { readStrictFlagValues } from "../utils/cliFlags.js";

// RI is deliberately import-style. Acquire one reviewed account with the
// existing raw-refresh command first; this scoped command never uses network,
// never auto-links by name alone and never imports an injected money payload.
export type ImportRhodeIslandCashOptions = {
  candidateId: string; electionId: string; committeeId: string; committeeName: string;
  cacheDir: string; reviewedMapping: true; dryRun: boolean;
};
const values = ["--candidate-id", "--election-id", "--org-id", "--organization-name", "--cache-dir"];
export function parseImportRhodeIslandCashArgs(args: readonly string[]): ImportRhodeIslandCashOptions {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!, name = token.split("=", 1)[0]!;
    if (values.includes(name)) { if (name === token) i++; continue; }
    check(token === "--reviewed-mapping" || token === "--dry-run", "unknown_cli_argument");
  }
  function value(flag: string, fallback?: string): string {
    const found = readStrictFlagValues(args, flag); check(found.length <= 1, "duplicate_cli_value");
    const result = found[0] ?? fallback; check(typeof result === "string" && result.trim(), "missing_cli_value"); return result.trim();
  }
  const candidateId = value("--candidate-id"), electionId = value("--election-id"), committeeId = value("--org-id");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  check(uuid.test(candidateId) && uuid.test(electionId) && /^\d+$/.test(committeeId), "invalid_cli_identity");
  check(args.includes("--reviewed-mapping"), "manual_mapping_review_required");
  return { candidateId, electionId, committeeId, committeeName: value("--organization-name"),
    cacheDir: resolve(value("--cache-dir", DEFAULT_RHODE_ISLAND_ERTS_CACHE_DIR)), reviewedMapping: true, dryRun: args.includes("--dry-run") };
}
export async function runImportRhodeIslandCash(input: { options: ImportRhodeIslandCashOptions; db?: Pool }) {
  check(isRhodeIslandCampaignFinanceSyncEnabled(false), "finance_sync_disabled");
  check(input.options.reviewedMapping === true, "manual_mapping_review_required");
  check(input.db || process.env.DATABASE_URL?.trim(), "database_url_required");
  const owned = input.db ? undefined : new Pool({ connectionString: process.env.DATABASE_URL });
  const db = input.db ?? owned!, o = input.options;
  try {
    const context = await loadRhodeIslandCanonicalCashContext(db, o.candidateId, o.electionId);
    check(context, "canonical_context_unavailable");
    const packet = await loadRhodeIslandCashPacket({ candidateId: o.candidateId, electionId: o.electionId, electionYear: context.election_year,
      candidateName: context.candidate_name, officeScope: context.office_scope, officeName: context.office_name, district: context.district,
      committeeId: o.committeeId, committeeName: o.committeeName, searchLastName: context.last_name }, o.cacheDir);
    const result = o.dryRun ? null : await writeRhodeIslandCashPacket({ db, packet, reviewedMapping: true });
    // Source identities, selectors and financial line items never enter logs.
    return { type: "rhode_island_committee_cash_import", dry_run: o.dryRun, accepted: 1,
      written: result?.status === "written" ? 1 : 0, unchanged: result?.status === "unchanged" ? 1 : 0,
      direct_finance_reconciled: packet.summary !== null,
      reports: packet.reportCount, receiving_rows: packet.receivingRows, committee_groups: packet.donors.length,
      committee_cash_occurrences: packet.selectedOccurrences, committee_cash_cents: packet.totalCents,
      coverage_through: packet.coverageThrough, source_observed_at: packet.observedAt };
  } finally { await owned?.end(); }
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: rhode-island-candidates:finance:import --candidate-id <uuid> --election-id <uuid> --org-id <numeric> --organization-name <exact native name> --reviewed-mapping [--cache-dir <directory>] [--dry-run]\nReview the current ballot, office and registration before supplying --reviewed-mapping. Acquire artifacts with the existing raw-refresh command first. This command uses the verified cache only.");
    return;
  }
  const options = parseImportRhodeIslandCashArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) loadProjectEnv();
  console.log(JSON.stringify(await runImportRhodeIslandCash({ options }), null, 2));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(JSON.stringify({ type: "rhode_island_committee_cash_import", held: true,
      code: error instanceof RhodeIslandCommitteeCashHold ? error.code : "source_or_import_failed" }));
    process.exitCode = 1;
  });
}

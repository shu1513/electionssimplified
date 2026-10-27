import { Pool } from "pg";
import { syncPhoenixReviewedEfd } from "../pipeline/phoenixFinance/phoenixReviewedEfdSync.js";
import { PhoenixEfdHold, efdCheck } from "../pipeline/phoenixFinance/phoenixReviewedEfd.js";

/** Stdin only: a reviewed financial transcription must not become an input
 * file or a log. Explicit connection/inline gates avoid reading .env files. */
async function main() {
  const args = process.argv.slice(2);
  efdCheck(args.length === 1 && args[0]!.startsWith("--cache-dir=") && args[0]!.length > 12, "cache_dir_argument_required");
  efdCheck(!process.stdin.isTTY && process.env.DATABASE_URL?.trim(), "review_stdin_and_explicit_database_required");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk); efdCheck(size <= 1024 * 1024, "review_input_bound"); chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  efdCheck(input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).sort().join("|") === "candidateId|electionId|reports|reviewedMapping|spenderName", "review_input_contract");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await syncPhoenixReviewedEfd({ ...input, db, cacheDir: args[0]!.slice("--cache-dir=".length) });
    console.log(JSON.stringify({ ok: true, ...result }));
  } finally { await db.end(); }
}
main().catch(error => {
  console.error(JSON.stringify({ ok: false, reason: error instanceof PhoenixEfdHold ? error.reason : "reviewed_efd_sync_failed" }));
  process.exitCode = 1;
});

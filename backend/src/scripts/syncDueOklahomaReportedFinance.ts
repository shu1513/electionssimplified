import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { syncDueOklahomaReportedFinance } from "../pipeline/oklahomaFinance/oklahomaReportedBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export function parseOklahomaReportedArgs(args: readonly string[]) {
  assertKnownCliFlags(args, "Oklahoma reported finance", new Set(["--dry-run", "--refresh"]), new Set(["--cache-dir", "--max-candidates"]));
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const match = /^(--cache-dir|--max-candidates)(?:=(.*))?$/.exec(args[i]!);
    if (!match) continue;
    if (values.has(match[1]!)) throw Error("Duplicate Oklahoma reported argument");
    const value = match[2] ?? args[++i]; if (!value?.trim()) throw Error("Missing Oklahoma reported argument");
    values.set(match[1]!, value);
  }
  const raw = values.get("--max-candidates"), maxCandidates = raw === undefined ? undefined : Number(raw);
  if (raw !== undefined && (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(maxCandidates) || maxCandidates! > 1000)) throw Error("Invalid Oklahoma reported batch size");
  return { dryRun: args.includes("--dry-run"), refresh: args.includes("--refresh"), cacheDir: values.get("--cache-dir"), maxCandidates };
}
async function main() {
  const options = parseOklahomaReportedArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.trim()) throw Error("DATABASE_URL required");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await syncDueOklahomaReportedFinance({ db, ...options });
    console.log(JSON.stringify({ type: "oklahoma_reported_finance_sync", result }));
    if (result.heldCount || result.sourceUnavailableCount || result.refreshFailedCount) process.exitCode = 1;
  } finally { await db.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch((error: unknown) => {
  console.error(`Oklahoma reported finance sync failed; prior component rows retained: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
});


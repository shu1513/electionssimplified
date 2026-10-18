import pg from "pg";
import { syncDueIdahoReportedPacReceipts } from "../pipeline/idahoFinance/idahoReportedPacBatchSync.js";

// Runtime configuration only: no environment-file loader or financial selector.
const args = process.argv.slice(2), allowed = new Set(["--dry-run","--refresh","--max-candidates","--stale-after-days","--election-lookback-days","--election-lookahead-days"]);
const numbers: Record<string,number> = {};
for (let i=0;i<args.length;i++) {
  const key=args[i]!; if (!allowed.has(key)) throw new Error("Unknown Idaho PAC sync option");
  if (key==="--dry-run"||key==="--refresh") continue;
  const value=args[++i]; if (!value||!/^\d+$/.test(value)) throw new Error("Invalid Idaho PAC sync option"); numbers[key]=Number(value);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL runtime configuration required");
const db = new pg.Pool({connectionString:process.env.DATABASE_URL});
try {
  console.log(JSON.stringify(await syncDueIdahoReportedPacReceipts({db,dryRun:args.includes("--dry-run"),refresh:args.includes("--refresh"),
    maxCandidates:numbers["--max-candidates"],staleAfterDays:numbers["--stale-after-days"],
    electionLookbackDays:numbers["--election-lookback-days"],electionLookaheadDays:numbers["--election-lookahead-days"]})));
} finally { await db.end(); }

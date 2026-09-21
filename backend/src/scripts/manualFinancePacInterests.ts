import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { PAC_INTEREST_SLUGS, isPacInterestSlug } from "../pipeline/finance/pacInterestClassifier.js";

// Manual work queue and writer for finance_pac_interests, the table behind
// the finance card's "PAC money by interest" list. No AI provider calls.
//
//   npm run manual:finance-pac-interests:due -- [--limit 200]
//   npm run manual:finance-pac-interests:write -- --file interests.json [--dry-run]
//
// Payload: { "interests": [ { "committee_id": "C00000000", "committee_name":
// "...", "interest_slug": "oil_gas_energy" | null, "confidence": "high" } ] }
// committee_id and committee_name come from the due list verbatim; the name
// must match the stored one, so a mistyped id cannot label the wrong
// committee. interest_slug null is a researched "fits no interest" verdict.

type Queryable = Pick<Pool, "query">;

const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

export type ManualPacInterest = {
  committee_id: string;
  committee_name: string;
  interest_slug: string | null;
  confidence: string;
};

function readFlag(argv: readonly string[], name: string): string | null {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = argv.indexOf(name);
  const next = index >= 0 ? argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : null;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

export function parseManualPacInterests(raw: unknown): ManualPacInterest[] {
  const list = (raw as { interests?: unknown })?.interests;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Payload must be { "interests": [ ... ] } with at least one row');
  }
  return list.map((item, index) => {
    const row = item as Record<string, unknown>;
    const committeeId = typeof row.committee_id === "string" ? row.committee_id.trim().toUpperCase() : "";
    const committeeName = typeof row.committee_name === "string" ? row.committee_name.trim() : "";
    const confidence = typeof row.confidence === "string" ? row.confidence : "";
    if (!/^C\d{8}$/.test(committeeId)) {
      throw new Error(`interests[${index}]: invalid committee_id`);
    }
    if (!committeeName) {
      throw new Error(`interests[${index}]: committee_name is required`);
    }
    if (!("interest_slug" in row)) {
      throw new Error(`interests[${index}]: interest_slug key is required (use null for "fits no interest")`);
    }
    const slug = row.interest_slug;
    if (slug !== null && (typeof slug !== "string" || !isPacInterestSlug(slug))) {
      throw new Error(`interests[${index}]: interest_slug must be null or one of the due list's interest_slugs`);
    }
    if (!CONFIDENCE_VALUES.has(confidence)) {
      throw new Error(`interests[${index}]: confidence must be high, medium or low`);
    }
    return { committee_id: committeeId, committee_name: committeeName, interest_slug: slug as string | null, confidence };
  });
}

export async function listDuePacInterests(db: Queryable, limit: number) {
  const result = await db.query(
    `
      SELECT i.committee_id, i.committee_name, i.connected_organization, i.organization_type,
        count(d.*)::int AS candidate_count, COALESCE(sum(d.amount), 0)::float AS total_amount
      FROM public.finance_pac_interests AS i
      LEFT JOIN public.candidate_finance_pac_donors AS d ON d.committee_id = i.committee_id
      WHERE i.classification_source = 'unknown'
      GROUP BY i.committee_id
      ORDER BY total_amount DESC, i.committee_id
      LIMIT $1::int
    `,
    [limit]
  );
  const counts = await db.query(
    `
      SELECT count(*) FILTER (WHERE classification_source = 'unknown')::int AS due_count, count(*)::int AS total_count
      FROM public.finance_pac_interests
    `
  );
  return { ...counts.rows[0], interest_slugs: PAC_INTEREST_SLUGS, committees: result.rows };
}

export async function writeManualPacInterests(db: Queryable, rows: readonly ManualPacInterest[], dryRun: boolean) {
  const known = await db.query<{ committee_id: string; committee_name: string }>(
    `SELECT committee_id, committee_name FROM public.finance_pac_interests WHERE committee_id = ANY($1::text[])`,
    [rows.map((row) => row.committee_id)]
  );
  const nameById = new Map(known.rows.map((row) => [row.committee_id, row.committee_name]));
  const problems: string[] = [];
  for (const row of rows) {
    const stored = nameById.get(row.committee_id);
    if (!stored) {
      problems.push(`${row.committee_id}: not in finance_pac_interests (run the contributor sync first)`);
    } else if (normalizeName(stored) !== normalizeName(row.committee_name)) {
      problems.push(`${row.committee_id}: committee_name does not match the stored name "${stored}"`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Rejected ${problems.length} row(s):\n${problems.join("\n")}`);
  }
  if (!dryRun) {
    await db.query(
      `
        UPDATE public.finance_pac_interests AS i
        SET interest_slug = x.interest_slug, confidence = x.confidence, classification_source = 'manual'
        FROM jsonb_to_recordset($1::jsonb) AS x(committee_id text, interest_slug text, confidence text)
        WHERE i.committee_id = x.committee_id
      `,
      [JSON.stringify(rows)]
    );
  }
  return { dry_run: dryRun, valid_rows: rows.length, written: dryRun ? 0 : rows.length };
}

async function main(): Promise<void> {
  loadProjectEnv();
  const [mode, ...argv] = process.argv.slice(2);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL?.trim() || "postgresql://localhost:5432/voteapp" });
  try {
    if (mode === "due") {
      const limit = Number(readFlag(argv, "--limit") ?? "200");
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("Invalid --limit");
      }
      console.log(JSON.stringify(await listDuePacInterests(pool, limit), null, 2));
    } else if (mode === "write") {
      const file = readFlag(argv, "--file");
      if (!file) {
        throw new Error("--file is required");
      }
      const rows = parseManualPacInterests(JSON.parse(readFileSync(file, "utf8")));
      console.log(JSON.stringify(await writeManualPacInterests(pool, rows, argv.includes("--dry-run")), null, 2));
    } else {
      throw new Error("Usage: manualFinancePacInterests.ts due|write [flags]");
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("manual finance pac interests failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

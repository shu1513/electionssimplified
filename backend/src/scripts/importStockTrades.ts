import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { loadCongressLegislators, type Legislator } from "../pipeline/rollcall/congressLegislators.js";
import { loadCandidateFecIndex, resolveFederalMember } from "../pipeline/rollcall/federalMemberResolver.js";
import {
  HOUSE_PTR_PARSER_VERSION,
  housePtrMemberName,
  housePtrPdfUrl,
  parseHouseFdIndex,
  parseHousePtrItems,
  planAmendmentSupersedes,
  planStockTradeFiling,
  selectHousePtrFilings,
  type ExistingStockTradeFiling,
  type HouseFdIndexRow,
  type HousePtrParseResult,
} from "../pipeline/stockTrades/housePtr.js";
import { extractHousePtrTextItems } from "../pipeline/stockTrades/housePtrPdfText.js";
import { matchHouseTripLegislator } from "../pipeline/travel/houseGiftTravel.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import { DEFAULT_SCOPE_FROM } from "./resolveRollCallMembers.js";

// Imports the securities trades House members report in Periodic Transaction
// Reports (PTRs) into candidate_stock_trade_filings / candidate_stock_trades,
// for members who are on a Nov-2026-or-later election. The source is the
// House Clerk's yearly financial-disclosure index; put each `<year>FD.xml` in
// the evidence dir first:
//
//   curl -sLO https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2025FD.zip && unzip 2025FD.zip
//   npm run stocks:import -- --evidence-dir evidence/stock-trades/<run> --dry-run
//   npm run stocks:import -- --evidence-dir evidence/stock-trades/<run>
//
// PTR PDFs are downloaded once into --pdf-cache-dir (not committed).
//
// Re-runs are safe and additive. A filing is keyed by chamber + DocID and a
// trade by filing + row number, so a second run inserts nothing. A parsed
// filing is never rewritten; a filing stored as scanned or parse_failed is
// re-read, and replaced only if it now parses. Nothing is ever deleted for a
// filing that has left the index.

export const STOCK_TRADES_IMPORTER_VERSION = "stock-trades-import-v1";
const DEFAULT_LEGISLATORS_DIR = "evidence/rollcall/congress-legislators";
const DEFAULT_PDF_CACHE_DIR = "scratch/house-financial-disclosures";
const DOWNLOAD_DELAY_MS = 200;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const CHAMBER = "house";

type FilingAction =
  | "insert"
  | "reparse"
  | "unchanged"
  | "dry_run_insert"
  | "dry_run_reparse"
  | "unresolved_member"
  | "no_candidate"
  | "out_of_scope"
  | "no_filing_date"
  | "source_unreachable";

type FilingReportRow = {
  docId: string;
  filingYear: string;
  filingDate: string | null;
  filerName: string;
  state: string;
  district: string;
  sourceUrl: string;
  bioguide: string | null;
  candidateId: string | null;
  candidateName: string | null;
  action: FilingAction;
  parseStatus: HousePtrParseResult["status"] | null;
  trades: number;
  detail: string;
};

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

async function loadPdf(url: string, cacheFile: string): Promise<Uint8Array | null> {
  if (existsSync(cacheFile)) {
    return new Uint8Array(readFileSync(cacheFile));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "voteapp-stock-trades-import (+https://electionssimplified.com)" },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      return null;
    }
    const data = new Uint8Array(await response.arrayBuffer());
    // The Clerk site answers a missing DocID with an HTML page and a 200.
    if (String.fromCharCode(...data.subarray(0, 4)) !== "%PDF") {
      return null;
    }
    writeFileSync(cacheFile, data);
    await new Promise((done) => setTimeout(done, DOWNLOAD_DELAY_MS));
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function parsePdf(data: Uint8Array): Promise<HousePtrParseResult> {
  try {
    return parseHousePtrItems(await extractHousePtrTextItems(data));
  } catch (error) {
    return { status: "parse_failed", detail: `pdf could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function writeFiling(
  client: PoolClient,
  filing: HouseFdIndexRow,
  candidateId: string,
  sourceUrl: string,
  parsed: HousePtrParseResult
): Promise<void> {
  const trades = parsed.status === "parsed" ? parsed.trades : [];
  const stored = await client.query<{ id: string }>(
    `
      INSERT INTO public.candidate_stock_trade_filings
        (candidate_id, chamber, doc_id, filing_year, filing_date, source_url, filer_name, is_amendment, parse_status, parser_version)
      VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10)
      ON CONFLICT (chamber, doc_id) DO UPDATE
        SET is_amendment = EXCLUDED.is_amendment,
            parse_status = EXCLUDED.parse_status,
            parser_version = EXCLUDED.parser_version
      RETURNING id
    `,
    [
      candidateId,
      CHAMBER,
      filing.docId,
      Number(filing.year),
      filing.filingDate,
      sourceUrl,
      `${filing.first} ${filing.last}`.trim(),
      trades.some((trade) => trade.filingStatus === "amended"),
      parsed.status,
      HOUSE_PTR_PARSER_VERSION,
    ]
  );
  const filingId = stored.rows[0]!.id;
  // Only reached for a new filing or a reparse, where the stored rows (none,
  // or an older parser's) are replaced as a set.
  await client.query(`DELETE FROM public.candidate_stock_trades WHERE filing_id = $1`, [filingId]);
  for (const trade of trades) {
    await client.query(
      `
        INSERT INTO public.candidate_stock_trades
          (filing_id, row_index, owner, asset_name, ticker, asset_type, transaction_type, transaction_date,
           notification_date, amount_low, amount_high, filing_status, raw_text)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11, $12, $13)
      `,
      [
        filingId,
        trade.rowIndex,
        trade.owner,
        trade.assetName,
        trade.ticker,
        trade.assetType,
        trade.transactionType,
        trade.transactionDate,
        trade.notificationDate,
        trade.amountLow,
        trade.amountHigh,
        trade.filingStatus,
        trade.rawText,
      ]
    );
  }
}

/** Marks rows restated by a later amended row. Returns how many were marked. */
async function applyAmendments(pool: Pool, candidateId: string): Promise<number> {
  const result = await pool.query<{
    id: string;
    owner: "self" | "spouse" | "child" | "joint";
    asset_name: string;
    ticker: string | null;
    transaction_type: "purchase" | "sale" | "partial_sale" | "exchange";
    transaction_date: string;
    filing_status: "new" | "amended";
    filing_order: string;
    superseded_by_trade_id: string | null;
  }>(
    `
      SELECT t.id, t.owner, t.asset_name, t.ticker, t.transaction_type, t.transaction_date::text AS transaction_date,
             t.filing_status, t.superseded_by_trade_id,
             coalesce(f.filing_date::text, '') || '|' || lpad(f.doc_id, 12, '0') AS filing_order
      FROM public.candidate_stock_trades AS t
      JOIN public.candidate_stock_trade_filings AS f ON f.id = t.filing_id
      WHERE f.candidate_id = $1 AND f.chamber = $2
    `,
    [candidateId, CHAMBER]
  );
  const pairs = planAmendmentSupersedes(
    result.rows.map((row) => ({
      id: row.id,
      owner: row.owner,
      assetName: row.asset_name,
      ticker: row.ticker,
      transactionType: row.transaction_type,
      transactionDate: row.transaction_date,
      filingStatus: row.filing_status,
      filingOrder: row.filing_order,
      supersededById: row.superseded_by_trade_id,
    }))
  );
  for (const [supersededId, byId] of pairs) {
    await pool.query(
      `UPDATE public.candidate_stock_trades SET superseded_by_trade_id = $2 WHERE id = $1 AND superseded_by_trade_id IS NULL`,
      [supersededId, byId]
    );
  }
  return pairs.length;
}

function heldHouseSeatOn(legislator: Legislator, date: string): string | null {
  const term = legislator.terms.find((entry) => entry.type === "rep" && entry.start <= date && date <= entry.end);
  return term ? term.state : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("stocks:import", argv, [
    { name: "--evidence-dir", value: "both" },
    { name: "--pdf-cache-dir", value: "both" },
    { name: "--legislators-sha", value: "both" },
    { name: "--legislators-dir", value: "both" },
    { name: "--scope-from", value: "both" },
    { name: "--dry-run", value: "none" },
  ]);
  const evidenceDirRaw = readValueFlag(argv, "--evidence-dir");
  if (!evidenceDirRaw) {
    throw new Error("--evidence-dir is required");
  }
  const evidenceDir = resolve(evidenceDirRaw);
  const pdfCacheDir = resolve(readValueFlag(argv, "--pdf-cache-dir") ?? DEFAULT_PDF_CACHE_DIR);
  const legislatorsSha = readValueFlag(argv, "--legislators-sha") ?? undefined;
  const legislatorsDir = resolve(readValueFlag(argv, "--legislators-dir") ?? DEFAULT_LEGISLATORS_DIR);
  const scopeFrom = readValueFlag(argv, "--scope-from") ?? DEFAULT_SCOPE_FROM;
  const dryRun = argv.includes("--dry-run");

  const indexFiles = readdirSync(evidenceDir)
    .filter((name) => /^\d{4}FD\.xml$/.test(name))
    .sort();
  if (indexFiles.length === 0) {
    throw new Error(`${evidenceDir} holds no <year>FD.xml files`);
  }
  const indexYears = indexFiles.map((name) => Number(name.slice(0, 4)));
  const indexRows = indexFiles.flatMap((name) => parseHouseFdIndex(readFileSync(join(evidenceDir, name), "utf8")));
  const filings = selectHousePtrFilings(indexRows).sort((a, b) => Number(a.docId) - Number(b.docId));

  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  requireLocalDatabaseTarget(databaseUrl);
  mkdirSync(pdfCacheDir, { recursive: true });

  const startedAt = new Date();
  // Local calendar date: the day the index was read, as the operator saw it.
  const today = `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, "0")}-${String(startedAt.getDate()).padStart(2, "0")}`;
  const legislators = await loadCongressLegislators({ sha: legislatorsSha, cacheDir: legislatorsDir });
  const pool = new Pool({ connectionString: databaseUrl });
  const rows: FilingReportRow[] = [];
  // candidate id → bioguide, for every filer the panel may show.
  const filers = new Map<string, string>();
  let supersededRows = 0;
  try {
    const candidatesByFec = await loadCandidateFecIndex(pool, scopeFrom);
    const existingResult = await pool.query<{ doc_id: string; parse_status: string; parser_version: string; trade_count: string }>(
      `
        SELECT f.doc_id, f.parse_status, f.parser_version,
               (SELECT count(*) FROM public.candidate_stock_trades AS t WHERE t.filing_id = f.id) AS trade_count
        FROM public.candidate_stock_trade_filings AS f
        WHERE f.chamber = $1
      `,
      [CHAMBER]
    );
    const existingByDocId = new Map<string, ExistingStockTradeFiling>(
      existingResult.rows.map((row) => [
        row.doc_id,
        { docId: row.doc_id, parseStatus: row.parse_status, parserVersion: row.parser_version, tradeCount: Number(row.trade_count) },
      ])
    );

    // Coverage: every sitting House member who resolves to an in-scope
    // candidate is a filer, with or without a PTR in the index.
    for (const legislator of legislators.index.byBioguide.values()) {
      const state = heldHouseSeatOn(legislator, today);
      if (!state) {
        continue;
      }
      const resolution = resolveFederalMember(
        { chamber: CHAMBER, memberId: legislator.bioguide, name: legislator.name, state, party: null, vote: "" },
        today,
        legislators.index,
        candidatesByFec
      );
      if (resolution.outcome === "matched" && resolution.candidate) {
        filers.set(resolution.candidate.candidateId, legislator.bioguide);
      }
    }

    const candidatesWithAmendments = new Set<string>();
    for (const filing of filings) {
      const sourceUrl = housePtrPdfUrl(filing.year, filing.docId);
      const row: FilingReportRow = {
        docId: filing.docId,
        filingYear: filing.year,
        filingDate: filing.filingDate,
        filerName: `${filing.first} ${filing.last}`.trim(),
        state: filing.state,
        district: filing.district,
        sourceUrl,
        bioguide: null,
        candidateId: null,
        candidateName: null,
        action: "unresolved_member",
        parseStatus: null,
        trades: 0,
        detail: "",
      };
      rows.push(row);
      if (!filing.filingDate) {
        row.action = "no_filing_date";
        row.detail = "the index row has no readable filing date";
        continue;
      }
      // The seat held on the filing date picks the member; the printed last
      // name only confirms it. First names are never compared.
      const match = matchHouseTripLegislator(
        { memberName: housePtrMemberName(filing), state: filing.state, district: filing.district, departureDate: filing.filingDate },
        legislators.index
      );
      if (match.outcome !== "matched") {
        row.detail = `${match.outcome}: ${match.detail}`;
        continue;
      }
      row.bioguide = match.legislator.bioguide;
      const resolution = resolveFederalMember(
        { chamber: CHAMBER, memberId: match.legislator.bioguide, name: row.filerName, state: filing.state, party: null, vote: "" },
        filing.filingDate,
        legislators.index,
        candidatesByFec
      );
      if (resolution.outcome !== "matched" || !resolution.candidate) {
        row.action = resolution.outcome === "out_of_scope" ? "out_of_scope" : "no_candidate";
        row.detail = `${resolution.outcome}: ${resolution.detail}`;
        continue;
      }
      row.candidateId = resolution.candidate.candidateId;
      row.candidateName = resolution.candidate.name;
      filers.set(row.candidateId, match.legislator.bioguide);

      const existing = existingByDocId.get(filing.docId);
      if (existing?.parseStatus === "parsed" && existing.parserVersion === HOUSE_PTR_PARSER_VERSION) {
        row.action = "unchanged";
        row.parseStatus = "parsed";
        row.trades = existing.tradeCount;
        continue;
      }
      const data = await loadPdf(sourceUrl, join(pdfCacheDir, `${filing.year}-${filing.docId}.pdf`));
      if (!data) {
        row.action = "source_unreachable";
        row.detail = "the filing PDF did not load";
        continue;
      }
      const parsed = await parsePdf(data);
      row.parseStatus = parsed.status;
      row.trades = parsed.status === "parsed" ? parsed.trades.length : 0;
      row.detail = parsed.status === "parse_failed" ? parsed.detail : "";
      const plan = planStockTradeFiling(existing, parsed, HOUSE_PTR_PARSER_VERSION);
      if (plan.action === "unchanged") {
        row.action = "unchanged";
        continue;
      }
      if (parsed.status === "parsed" && parsed.trades.some((trade) => trade.filingStatus === "amended")) {
        candidatesWithAmendments.add(row.candidateId);
      }
      if (dryRun) {
        row.action = plan.action === "insert" ? "dry_run_insert" : "dry_run_reparse";
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await writeFiling(client, filing, row.candidateId, sourceUrl, parsed);
        await client.query("COMMIT");
        row.action = plan.action;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (!dryRun) {
      for (const candidateId of candidatesWithAmendments) {
        supersededRows += await applyAmendments(pool, candidateId);
      }
      for (const [candidateId, bioguide] of filers) {
        await pool.query(
          `
            INSERT INTO public.candidate_stock_trade_filers (candidate_id, chamber, source_member_id, index_years, checked_through)
            VALUES ($1, $2, $3, $4::integer[], $5::date)
            ON CONFLICT (candidate_id, chamber) DO UPDATE
              SET source_member_id = EXCLUDED.source_member_id,
                  index_years = (
                    SELECT array_agg(DISTINCT year ORDER BY year)
                    FROM unnest(public.candidate_stock_trade_filers.index_years || EXCLUDED.index_years) AS year
                  ),
                  checked_through = GREATEST(public.candidate_stock_trade_filers.checked_through, EXCLUDED.checked_through)
          `,
          [candidateId, CHAMBER, bioguide, indexYears, today]
        );
      }
    }
  } finally {
    await pool.end();
  }

  const actions: Record<string, number> = {};
  const parseStatuses: Record<string, number> = {};
  for (const row of rows) {
    actions[row.action] = (actions[row.action] ?? 0) + 1;
    if (row.candidateId && row.parseStatus) {
      parseStatuses[row.parseStatus] = (parseStatuses[row.parseStatus] ?? 0) + 1;
    }
  }
  const inScope = rows.filter((row) => row.candidateId);
  const report = {
    importerVersion: STOCK_TRADES_IMPORTER_VERSION,
    parserVersion: HOUSE_PTR_PARSER_VERSION,
    dryRun,
    chamber: CHAMBER,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    scopeFrom,
    legislatorsSha: legislators.sha,
    indexFiles,
    indexRows: indexRows.length,
    ptrFilings: filings.length,
    actions,
    inScopeFilings: inScope.length,
    inScopeParseStatuses: parseStatuses,
    inScopeTrades: inScope.reduce((sum, row) => sum + row.trades, 0),
    candidatesWithFilings: new Set(inScope.map((row) => row.candidateId)).size,
    filersCovered: filers.size,
    supersededRows,
    rows,
  };
  const reportFile = join(evidenceDir, dryRun ? "import-dry-run-report.json" : "import-report.json");
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, rows: undefined, reportFile }, null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(`stocks:import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

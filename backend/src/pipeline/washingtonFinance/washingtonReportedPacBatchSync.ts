import type { Pool } from "pg";
import { isWashingtonPdcRawDataRefreshEnabled, isWashingtonReportedPacReceiptsEnabled } from "../../config/featureFlags.js";
import { createWashingtonPacSourceProducer, readWashingtonPacSource, readWashingtonPacSourceHint } from "./washingtonReportedPacCache.js";
import { WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./washingtonFinanceEligibleOffices.js";
import { loadWashingtonPacReceiver, WA_PAC_CONTEXT_FROM, WA_PAC_CONTEXT_SELECT, WA_PAC_CONTEXT_WHERE,
  washingtonPacScope, type WashingtonPacReceiver } from "./washingtonReportedPacReceiver.js";
import { WashingtonPacSourceError, waPacHold } from "./washingtonReportedPacSource.js";
import { waPacCanonical, writeWashingtonReportedPacReceipts } from "./washingtonReportedPacWriter.js";

type Options = { db: Pool; now?: Date; maxCandidates?: number; staleAfterDays?: number; electionLookbackDays?: number;
  electionLookaheadDays?: number; refresh?: boolean; dryRun?: boolean; cacheDir?: string };
type Metadata = { source_clock: string | null; source_manifest: string | null; source_filer: string | null; source_committee: string | null;
  source_candidate: string | null; source_election: string | null; last_attempted_at: string | null; attempt_filer: string | null;
  attempt_committee: string | null; attempt_candidate: string | null; attempt_election: string | null; attempt_manifest: string | null };
const DAY = 86400000, clock = (v: string | null) => v ? Date.parse(v) : NaN;
const integer = (n: number, min: number, max = 100000) => { if (!Number.isSafeInteger(n) || n < min || n > max) waPacHold("invalid_batch_option"); return n; };
async function hint(r: WashingtonPacReceiver, cacheDir?: string) {
  try { return await readWashingtonPacSourceHint({ ...washingtonPacScope(r), cacheDir }); }
  catch (e) { if (e instanceof WashingtonPacSourceError) return null; throw e; }
}
export async function listDueWashingtonReportedPacReceipts(options: Options) {
  const now = options.now ?? new Date(); if (!Number.isFinite(now.getTime())) waPacHold("invalid_batch_clock");
  const max = integer(options.maxCandidates ?? 25, 1), stale = integer(options.staleAfterDays ?? 7, 1),
    lookback = integer(options.electionLookbackDays ?? 30, 0), lookahead = integer(options.electionLookaheadDays ?? 730, 0);
  const result = await options.db.query<WashingtonPacReceiver & Metadata>(`SELECT ${WA_PAC_CONTEXT_SELECT},
    s.source_retrieved_at::text source_clock,s.source_manifest_sha256 source_manifest,s.receiving_filer_id source_filer,
    s.receiving_committee_id source_committee,s.candidate_id::text source_candidate,s.election_id::text source_election,
    a.last_attempted_at::text,a.receiving_filer_id attempt_filer,a.receiving_committee_id attempt_committee,
    a.candidate_id::text attempt_candidate,a.election_id::text attempt_election,a.source_manifest_sha256 attempt_manifest
    ${WA_PAC_CONTEXT_FROM}
    LEFT JOIN public.wa_candidate_finance_summaries legacy ON legacy.link_id=l.id AND legacy.election_year=l.election_year
    LEFT JOIN public.wa_reported_pac_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    LEFT JOIN public.wa_reported_pac_attempts a ON a.link_id=l.id AND a.election_year=l.election_year
    WHERE ${WA_PAC_CONTEXT_WHERE}
      AND e.election_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int))
      AND e.election_date <= (($2::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int))
    ORDER BY a.last_attempted_at ASC NULLS FIRST,legacy.last_synced_at ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id
    LIMIT 100001`, [[...WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS], now.toISOString(), lookback, lookahead]);
  if (result.rows.length > 100000 || new Set(result.rows.map(r => r.link_id)).size !== result.rows.length) waPacHold("incomplete_eligible_scope");
  const rows: WashingtonPacReceiver[] = [];
  for (const row of result.rows) {
    const h = await hint(row, options.cacheDir), at = clock(row.source_clock), attempted = clock(row.last_attempted_at), time = now.getTime();
    const changed = row.source_filer !== row.filer_id || row.source_committee !== row.committee_id ||
      row.source_candidate !== row.candidate_id || row.source_election !== row.election_id;
    const needs = options.refresh === true || changed || !Number.isFinite(at) || at > time || at < time - stale * DAY ||
      !!h && row.source_manifest !== h.manifestSha256;
    const retry = options.refresh === true || !Number.isFinite(attempted) || attempted > time || attempted <= time - DAY ||
      row.attempt_filer !== row.filer_id || row.attempt_committee !== row.committee_id ||
      row.attempt_candidate !== row.candidate_id || row.attempt_election !== row.election_id ||
      !!h && row.attempt_manifest !== h.manifestSha256;
    if (needs && retry) {
      const { source_clock: _sc, source_manifest: _sm, source_filer: _sf, source_committee: _sco, source_candidate: _sca,
        source_election: _se, last_attempted_at: _la, attempt_filer: _af, attempt_committee: _aco, attempt_candidate: _aca,
        attempt_election: _ae, attempt_manifest: _am, ...receiver } = row;
      rows.push(receiver);
    }
  }
  return { eligibleCount: result.rows.length, totalDueRows: rows.length, rows: rows.slice(0, max) };
}
async function attempt(db: Pool, expected: WashingtonPacReceiver, manifest: string | null) {
  const client = await db.connect();
  try {
    await client.query("BEGIN"); const current = await loadWashingtonPacReceiver(client, expected.link_id, true);
    if (!current || waPacCanonical(current) !== waPacCanonical(expected)) waPacHold("receiving_context_changed");
    await client.query(`INSERT INTO public.wa_reported_pac_attempts
      (link_id,election_year,receiving_filer_id,receiving_committee_id,candidate_id,election_id,source_manifest_sha256,last_attempted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (link_id,election_year) DO UPDATE SET
      receiving_filer_id=EXCLUDED.receiving_filer_id,receiving_committee_id=EXCLUDED.receiving_committee_id,
      candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,source_manifest_sha256=EXCLUDED.source_manifest_sha256,
      last_attempted_at=EXCLUDED.last_attempted_at`, [current.link_id,current.election_year,current.filer_id,current.committee_id,
      current.candidate_id,current.election_id,manifest,new Date().toISOString()]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

/** Independent component schedule. Legacy summary age affects stable ordering
 * only; it never makes missing PAC receipts ineligible or claims new freshness. */
export async function syncDueWashingtonReportedPacReceipts(options: Options) {
  const result = { enabled: isWashingtonReportedPacReceiptsEnabled(), dryRun: options.dryRun === true,
    eligibleCount: 0, totalDueRows: 0, attemptedCount: 0, writtenCount: 0, heldCount: 0,
    savedSourceCount: 0, refreshedSourceCount: 0, acquisitionStopped: false, holds: {} as Record<string, number> };
  if (!result.enabled) return result;
  const due = await listDueWashingtonReportedPacReceipts(options);
  result.eligibleCount = due.eligibleCount; result.totalDueRows = due.totalDueRows;
  if (result.dryRun) return result;
  const raw = isWashingtonPdcRawDataRefreshEnabled(), producer = raw ? createWashingtonPacSourceProducer({ cacheDir: options.cacheDir }) : null;
  for (const receiver of due.rows) {
    result.attemptedCount++; let manifest: string | null = null;
    try {
      const revision = await hint(receiver, options.cacheDir); manifest = revision?.manifestSha256 ?? null;
      await attempt(options.db, receiver, manifest);
      let source = await readWashingtonPacSource({ ...washingtonPacScope(receiver), cacheDir: options.cacheDir });
      if (producer && (!source || options.refresh || Date.parse(source.sourceRetrievedAt) < Date.now() - DAY)) {
        if (result.acquisitionStopped) waPacHold("acquisition_stopped");
        try { source = await producer.refresh(washingtonPacScope(receiver)); result.refreshedSourceCount++; }
        catch (e) {
          if (!(e instanceof WashingtonPacSourceError) || ["source_transport_unavailable","native_transport_unavailable","source_request_budget","source_byte_budget"].includes(e.code)) result.acquisitionStopped = true;
          throw e;
        }
      } else if (source) result.savedSourceCount++;
      if (!source) waPacHold("source_unavailable");
      manifest = source.sourceManifestSha256;
      await writeWashingtonReportedPacReceipts({ db: options.db, receiver, source }); result.writtenCount++;
    } catch (e) {
      result.heldCount++; const code = e instanceof WashingtonPacSourceError ? e.code : "storage_unavailable";
      result.holds[code] = (result.holds[code] ?? 0) + 1;
    } finally {
      // Financial/source clocks remain unchanged on a held attempt.
      try { await attempt(options.db, receiver, manifest); } catch { /* Context changed: the canonical guard forbids this attempt too. */ }
    }
  }
  return result;
}

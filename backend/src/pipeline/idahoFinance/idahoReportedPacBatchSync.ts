import type { Pool } from "pg";
import { isIdahoCampaignFinanceRawDataRefreshEnabled, isIdahoReportedPacReceiptsEnabled } from "../../config/featureFlags.js";
import { createIdahoPacSourceProducer, readIdahoPacSource, readIdahoPacSourceHint } from "./idahoReportedPacCache.js";
import { IDAHO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./idahoFinanceEligibleOffices.js";
import { ID_PAC_CONTEXT_FROM, ID_PAC_CONTEXT_SELECT, ID_PAC_CONTEXT_WHERE, idahoPacScope, loadIdahoPacReceiver, type IdahoPacReceiver } from "./idahoReportedPacReceiver.js";
import { idPacCanonical, idPacHold, IdahoPacSourceError } from "./idahoReportedPacSource.js";
import { writeIdahoReportedPacReceipts } from "./idahoReportedPacWriter.js";

type Options = { db: Pool; now?: Date; maxCandidates?: number; staleAfterDays?: number; electionLookbackDays?: number;
  electionLookaheadDays?: number; refresh?: boolean; dryRun?: boolean; cacheDir?: string };
type Metadata = { source_clock: string | null; source_manifest: string | null; source_registration: string | null;
  source_candidate: string | null; source_election: string | null; last_attempted_at: string | null;
  attempt_registration: string | null; attempt_candidate: string | null; attempt_election: string | null; attempt_manifest: string | null };
const DAY = 86400000, clock = (s: string | null) => s ? Date.parse(s) : NaN;
const integer = (n: number, min: number, max = 100000) => { if (!Number.isSafeInteger(n) || n < min || n > max) idPacHold("invalid_batch_option"); return n; };
async function hint(r: IdahoPacReceiver, cacheDir?: string) {
  try { return await readIdahoPacSourceHint({ ...idahoPacScope(r), cacheDir }); }
  catch (e) { if (e instanceof IdahoPacSourceError) return null; throw e; }
}
export async function listDueIdahoReportedPacReceipts(options: Options) {
  const now = options.now ?? new Date(); if (!Number.isFinite(now.getTime())) idPacHold("invalid_batch_clock");
  const max = integer(options.maxCandidates ?? 25, 1), stale = integer(options.staleAfterDays ?? 7, 1),
    lookback = integer(options.electionLookbackDays ?? 98, 0), lookahead = integer(options.electionLookaheadDays ?? 730, 0);
  const result = await options.db.query<IdahoPacReceiver & Metadata>(`SELECT ${ID_PAC_CONTEXT_SELECT},
    s.source_retrieved_at::text source_clock,s.source_manifest_sha256 source_manifest,s.receiving_registration_guid source_registration,
    s.candidate_id::text source_candidate,s.election_id::text source_election,a.last_attempted_at::text,
    a.receiving_registration_guid attempt_registration,a.candidate_id::text attempt_candidate,a.election_id::text attempt_election,a.source_manifest_sha256 attempt_manifest
    ${ID_PAC_CONTEXT_FROM}
    LEFT JOIN public.id_candidate_finance_summaries legacy ON legacy.link_id=l.id AND legacy.election_year=l.election_year
    LEFT JOIN public.id_reported_pac_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    LEFT JOIN public.id_reported_pac_attempts a ON a.link_id=l.id AND a.election_year=l.election_year
    WHERE ${ID_PAC_CONTEXT_WHERE}
      AND e.election_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int))
      AND e.election_date <= (($2::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int))
    ORDER BY a.last_attempted_at ASC NULLS FIRST,legacy.last_synced_at ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id
    LIMIT 100001`, [[...IDAHO_FINANCE_ELIGIBLE_OFFICE_KEYS], now.toISOString(), lookback, lookahead]);
  if (result.rows.length > 100000 || new Set(result.rows.map(r => r.link_id)).size !== result.rows.length) idPacHold("incomplete_eligible_scope");
  const rows: IdahoPacReceiver[] = [];
  for (const row of result.rows) {
    const h = await hint(row, options.cacheDir), at = clock(row.source_clock), attempted = clock(row.last_attempted_at), time = now.getTime();
    const needs = options.refresh === true || row.source_registration !== row.registration_guid || row.source_candidate !== row.candidate_id ||
      row.source_election !== row.election_id || !Number.isFinite(at) || at > time || at < time - stale * DAY || !!h && row.source_manifest !== h.manifestSha256;
    const retry = options.refresh === true || !Number.isFinite(attempted) || attempted > time || attempted <= time - DAY ||
      row.attempt_registration !== row.registration_guid || row.attempt_candidate !== row.candidate_id || row.attempt_election !== row.election_id ||
      !!h && row.attempt_manifest !== h.manifestSha256;
    if (needs && retry) {
      const { source_clock: _sc, source_manifest: _sm, source_registration: _sr, source_candidate: _sca, source_election: _se,
        last_attempted_at: _la, attempt_registration: _ar, attempt_candidate: _aca, attempt_election: _ae, attempt_manifest: _am, ...receiver } = row;
      rows.push(receiver);
    }
  }
  return { eligibleCount: result.rows.length, totalDueRows: rows.length, rows: rows.slice(0, max) };
}
async function attempt(db: Pool, expected: IdahoPacReceiver, manifest: string | null) {
  const c = await db.connect();
  try {
    await c.query("BEGIN"); const current = await loadIdahoPacReceiver(c, expected.link_id, true);
    if (!current || idPacCanonical(current) !== idPacCanonical(expected)) idPacHold("receiving_context_changed");
    await c.query(`INSERT INTO public.id_reported_pac_attempts
      (link_id,election_year,receiving_registration_guid,candidate_id,election_id,source_manifest_sha256,last_attempted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(link_id,election_year) DO UPDATE SET
      receiving_registration_guid=EXCLUDED.receiving_registration_guid,candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
      source_manifest_sha256=EXCLUDED.source_manifest_sha256,last_attempted_at=EXCLUDED.last_attempted_at`,
    [current.link_id,current.election_year,current.registration_guid,current.candidate_id,current.election_id,manifest,new Date().toISOString()]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

/** Independent missing/source-clock schedule; legacy age affects order only. */
export async function syncDueIdahoReportedPacReceipts(options: Options) {
  const result = { enabled: isIdahoReportedPacReceiptsEnabled(), dryRun: options.dryRun === true,
    eligibleCount: 0, totalDueRows: 0, attemptedCount: 0, writtenCount: 0, heldCount: 0, savedSourceCount: 0,
    refreshedSourceCount: 0, acquisitionStopped: false, holds: {} as Record<string, number> };
  if (!result.enabled) return result;
  const due = await listDueIdahoReportedPacReceipts(options); result.eligibleCount = due.eligibleCount; result.totalDueRows = due.totalDueRows;
  if (result.dryRun) return result;
  const raw = isIdahoCampaignFinanceRawDataRefreshEnabled(), producer = raw ? createIdahoPacSourceProducer({ cacheDir: options.cacheDir }) : null;
  for (const receiver of due.rows) {
    result.attemptedCount++; let manifest: string | null = null;
    try {
      const revision = await hint(receiver, options.cacheDir); manifest = revision?.manifestSha256 ?? null;
      await attempt(options.db, receiver, manifest);
      let source = await readIdahoPacSource({ ...idahoPacScope(receiver), cacheDir: options.cacheDir });
      if (producer && (!source || options.refresh || Date.parse(source.sourceRetrievedAt) < Date.now() - DAY)) {
        if (result.acquisitionStopped) idPacHold("acquisition_stopped");
        try { source = await producer.refresh(idahoPacScope(receiver)); result.refreshedSourceCount++; }
        catch (e) {
          if (!(e instanceof IdahoPacSourceError) || ["source_transport_unavailable","native_transport_unavailable","source_request_budget","source_byte_budget"].includes(e.code)) result.acquisitionStopped = true;
          throw e;
        }
      } else if (source) result.savedSourceCount++;
      if (!source) idPacHold("source_unavailable"); manifest = source.sourceManifestSha256;
      await writeIdahoReportedPacReceipts({ db: options.db, receiver, source }); result.writtenCount++;
    } catch (e) {
      result.heldCount++; const code = e instanceof IdahoPacSourceError ? e.code : "storage_unavailable";
      result.holds[code] = (result.holds[code] ?? 0) + 1;
    } finally {
      try { await attempt(options.db, receiver, manifest); } catch { /* Current canonical context also guards nonfinancial attempts. */ }
    }
  }
  return result;
}

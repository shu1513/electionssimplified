import { describe, expect, it, vi } from 'vitest';
import { replaceOregonCandidateFinanceSnapshot } from '../../../src/pipeline/oregonFinance/oregonFinanceWriter.js';
import type { OregonVerifiedFinanceComponents } from '../../../src/pipeline/oregonFinance/oregonVerifiedFinancePersistence.js';
import type { OregonVerifiedLocalCandidateRow } from '../../../src/pipeline/oregonFinance/oregonVerifiedLocalCandidateContext.js';
import type { OregonPacCandidateContext, OregonVerifiedPacProvenance } from '../../../src/pipeline/oregonFinance/oregonVerifiedPacSource.js';
import type { OregonVerifiedOutsideEvidence } from '../../../src/pipeline/oregonFinance/oregonVerifiedOutsideSource.js';

// Synthetic authority exercises real production validators; no acquisition or real source money is claimed.
const LINK = '33333333-3333-4333-8333-333333333333';
const context: OregonPacCandidateContext = { candidateId: '11111111-1111-4111-8111-111111111111', electionId: '22222222-2222-4222-8222-222222222222', committeeId: '21892', candidateName: 'Adam Baker', electionYear: 2026, electionType: 'General', officeName: 'State Lower Chamber Legislator', district: '40' };
const districtName = 'State House District 40 (2024); Oregon';
const hash = 'a'.repeat(64);
const url = (id: string) => 'https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=' + id;
function pac() {
  const provenance: OregonVerifiedPacProvenance = { version: 1, candidateContext: { ...context }, scope: 'current_named_registered_pac_cash', windowStart: '2025-01-01', windowEnd: '2026-12-31', unclassifiedMiscCashAmountCents: 0, unclassifiedMiscCashCount: 0, fullCurrentCashFingerprint: hash, sourceHashes: [hash], gifts: [{ transactionId: '100', originalId: '100', donorCommitteeId: '23238', date: '2026-09-22', amountCents: 10025, identityFingerprint: hash }] };
  return { provenance, donors: [{ committeeId: '23238', committeeName: 'Synthetic PAC', committeeType: 'Political Action Committee' as const, amount: 100.25, contributionCount: 1, sourceUrl: 'https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=23238' }] };
}
function outside(): OregonVerifiedOutsideEvidence {
  return { version: 1, candidateContext: { ...context }, scope: 'current_original_cash_ie_allocations', payer: { committeeId: '169', committeeName: 'Synthetic IE PAC' }, windowStart: '2025-01-01', windowEnd: '2026-12-31', allocationPolicy: '2026_general_rolling_window_2026-09-22_2026-11-03', contextFingerprint: hash, payerSooFingerprint: hash, transactions: [{ transactionId: '200', originalId: '200', date: '2026-09-22', amountCents: 20000, identityFingerprint: hash }], allocations: [{ transactionId: '200', occurrence: 0, targetName: 'Adam Baker', targetCommitteeId: '21892', supportOppose: 'support', amountCents: 12025, mechanism: 'independent', sourceUrl: url('200') }], supportCents: 12025, opposeCents: 0, sourceHashes: [hash] };
}
function local(): OregonVerifiedLocalCandidateRow { return { ...context, electionDate: '2026-11-03', electionStage: 'general', districtName, districtState: 'OR', districtType: 'state_lower', geoidCompact: '41040' }; }
function owner(overrides: Record<string, unknown> = {}) { return { id: LINK, candidate_id: context.candidateId, election_id: context.electionId, committee_id: context.committeeId, election_year: 2026, link_status: 'active', link_source: 'orestar', ...overrides }; }
function link() { return { candidateId: context.candidateId, electionId: context.electionId, electionYear: 2026, candidateNameNormalized: 'ADAM BAKER', officeName: context.officeName, district: districtName, committeeId: context.committeeId, committeeName: 'Synthetic Baker Committee', linkSource: 'orestar' as const }; }
type Options = { local?: OregonVerifiedLocalCandidateRow | null; owners?: ReturnType<typeof owner>[]; priorPac?: unknown; pacRows?: Record<string, unknown>[]; priorOutside?: unknown; groupRows?: Record<string, unknown>[]; breakdownRows?: unknown[]; onQuery?: (sql: string) => void; onConnect?: () => void; failOn?: string };
function pool(options: Options = {}) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    options.onQuery?.(sql);
    if (options.failOn && sql.includes(options.failOn)) throw new Error('injected financial write failure');
    let rows: unknown[] = [];
    if (sql.includes('AS "candidateId"')) rows = options.local === null ? [] : [options.local ?? local()];
    else if (sql.includes('SELECT id::text') && sql.includes('FOR UPDATE')) rows = options.owners ?? [owner()];
    else if (sql.includes("link_source='manual'")) rows = [];
    else if (sql.includes('INSERT INTO public.or_candidate_finance_links')) rows = [{ id: LINK, link_status: 'active', link_source: 'orestar', election_year: 2026 }];
    else if (sql.includes('SELECT pac_source_provenance')) rows = [{ pac_source_provenance: options.priorPac ?? null }];
    else if (sql.includes('FROM public.or_candidate_finance_pac_donors')) rows = options.pacRows ?? [];
    else if (sql.includes('SELECT source_provenance')) rows = options.priorOutside === undefined ? [] : [{ source_provenance: options.priorOutside }];
    else if (sql.includes('FROM public.or_candidate_finance_outside_groups')) rows = (options.groupRows ?? []).filter(row => row.sponsor_id === values[2]);
    else if (sql.includes('FROM public.or_candidate_finance_outside_group_breakdowns')) rows = options.breakdownRows ?? [];
    return { rows, rowCount: rows.length };
  });
  const client = { query, release: vi.fn() };
  return { query, client, connect: vi.fn(async () => { options.onConnect?.(); return client; }) };
}
function components(): OregonVerifiedFinanceComponents { return { candidateContext: { ...context }, pac: pac(), positiveOutsideEvidence: [outside()] }; }
async function write(db: ReturnType<typeof pool>, verifiedFinance = components()) { return replaceOregonCandidateFinanceSnapshot({ db: db as unknown as Parameters<typeof replaceOregonCandidateFinanceSnapshot>[0]['db'], link: link(), verifiedFinance, summary: { directContributionTotal: 999.99 } }); }
const sqls = (db: ReturnType<typeof pool>) => db.query.mock.calls.map(call => call[0]);
const inserts = (db: ReturnType<typeof pool>, table: string) => db.query.mock.calls.filter(call => call[0].includes('INSERT INTO public.' + table));
function storedPac(amount: unknown = '100.25') { const d = pac().donors[0]; return [{ committee_id: d.committeeId, committee_name: d.committeeName, committee_type: d.committeeType, amount, contribution_count: d.contributionCount, source_url: d.sourceUrl }]; }
function storedOutside() { return [{ sponsor_id: '169', sponsor_name: 'Synthetic IE PAC', support_oppose: 'support', amount: '120.25', source_url: url('200') }]; }

describe('production Oregon verified persistence hooks', () => {
  it('writes first PAC/outside materialization and provenance inside one transaction', async () => {
    const db = pool(); expect(await write(db)).toMatchObject({ pacDonorsWritten: 1, verifiedOutsideGroupsWritten: 1, verifiedFinanceDiagnostics: [] });
    expect(sqls(db)[0]).toBe('BEGIN'); expect(sqls(db).at(-1)).toBe('COMMIT');
    const lock = sqls(db).findIndex(sql => sql.startsWith('LOCK TABLE'));
    const actual = sqls(db).findIndex(sql => sql.includes('AS "candidateId"'));
    const insert = sqls(db).findIndex(sql => sql.includes('INSERT INTO public.or_candidate_finance_links'));
    expect(lock).toBeLessThan(actual); expect(actual).toBeLessThan(insert);
    expect(sqls(db)[actual]).toContain('FOR SHARE OF candidate, ce, election, office, district');
    expect(inserts(db, 'or_candidate_finance_pac_donors')[0][1].slice(2, 7)).toEqual(['23238', 'Synthetic PAC', 'Political Action Committee', 100.25, 1]);
    expect(inserts(db, 'or_candidate_finance_outside_groups')[0][1].slice(2, 7)).toEqual(['169', 'Synthetic IE PAC', 'support', 120.25, url('200')]);
    expect(inserts(db, 'or_candidate_finance_outside_source_proofs')).toHaveLength(1);
    expect(inserts(db, 'or_candidate_finance_summaries').some(call => call[0].includes('pac_source_provenance'))).toBe(true);
    expect(db.client.release).toHaveBeenCalledOnce();
  });
  it('never deletes rows or addresses another payer', async () => {
    const db = pool({ groupRows: [{ sponsor_id: '888', sponsor_name: 'Other retained payer', support_oppose: 'oppose', amount: '500.00', source_url: url('999') }] });
    expect((await write(db)).verifiedOutsideGroupsWritten).toBe(1);
    expect(inserts(db, 'or_candidate_finance_outside_groups').every(call => call[1][2] === '169')).toBe(true);
    expect(sqls(db).some(sql => /DELETE FROM public\.or_candidate_finance_(outside|pac)/.test(sql))).toBe(false);
    const scoped = db.query.mock.calls.filter(call => call[0].includes('sponsor_id=$3') || call[0].includes('payer_committee_id=$3'));
    expect(scoped.length).toBeGreaterThan(0); expect(scoped.every(call => call[1][2] === '169')).toBe(true);
  });
  it('preserves malformed PAC independently while accepting outside', async () => {
    const db = pool({ priorPac: {}, pacRows: storedPac() }); const result = await write(db);
    expect(result).toMatchObject({ pacDonorsWritten: 0, verifiedOutsideGroupsWritten: 1 });
    expect(inserts(db, 'or_candidate_finance_pac_donors')).toHaveLength(0);
    expect(result.verifiedFinanceDiagnostics?.join(' ')).toContain('Stored Oregon PAC');
  });
  it('preserves changed prior outside independently while accepting PAC', async () => {
    const prior = outside(); prior.transactions[0].identityFingerprint = 'b'.repeat(64);
    const db = pool({ priorOutside: prior, groupRows: storedOutside() }); const result = await write(db);
    expect(result).toMatchObject({ pacDonorsWritten: 1, verifiedOutsideGroupsWritten: 0 });
    expect(inserts(db, 'or_candidate_finance_outside_groups')).toHaveLength(0);
    expect(result.verifiedFinanceDiagnostics?.join(' ')).toContain('transaction disappeared or changed');
  });
  it('preserves duplicate payer inputs', async () => {
    const db = pool(); const evidence = components(); evidence.positiveOutsideEvidence = [outside(), outside()];
    expect(await write(db, evidence)).toMatchObject({ pacDonorsWritten: 1, verifiedOutsideGroupsWritten: 0 });
    expect(inserts(db, 'or_candidate_finance_outside_source_proofs')).toHaveLength(0);
  });
  it.each([{ geoidCompact: '41020' }, { candidateName: 'Someone Else' }, { electionDate: '2024-11-05' }, { electionStage: 'primary' }, { districtState: 'WA' }, { districtType: 'state_upper' }])('rolls back changed actual context before link writes %j', async changes => {
    const db = pool({ local: { ...local(), ...changes } });
    await expect(write(db)).rejects.toThrow('local candidate/election/office/seat changed');
    expect(inserts(db, 'or_candidate_finance_links')).toHaveLength(0); expect(sqls(db).at(-1)).toBe('ROLLBACK');
  });
  it.each(['other candidate', 'sibling committee', 'manual disabled'])('rolls back %s ownership before link writes', async kind => {
    const owners = kind === 'other candidate' ? [owner(), owner({ candidate_id: '44444444-4444-4444-8444-444444444444' })] : kind === 'sibling committee' ? [owner(), owner({ committee_id: '999' })] : [owner({ link_status: 'disabled', link_source: 'manual' })];
    const db = pool({ owners }); await expect(write(db)).rejects.toThrow('ownership changed');
    expect(inserts(db, 'or_candidate_finance_links')).toHaveLength(0); expect(sqls(db).at(-1)).toBe('ROLLBACK');
  });
  it('reads actual context after locking instead of trusting earlier source context', async () => {
    const actual = local(); const db = pool({ local: actual, onQuery: sql => { if (sql.startsWith('LOCK TABLE')) actual.geoidCompact = '41020'; } });
    await expect(write(db)).rejects.toThrow('local candidate/election/office/seat changed');
    expect(inserts(db, 'or_candidate_finance_links')).toHaveLength(0);
  });
  it('clones the entire caller data bag before connect can mutate link, summary, context or evidence', async () => {
    const evidence = components(); const incomingLink = link(); const summary = { directContributionTotal: 999.99 };
    const db = pool({ onConnect: () => { incomingLink.committeeId = '999'; summary.directContributionTotal = 1; evidence.candidateContext.district = '20'; evidence.pac!.donors[0].amount = 1; evidence.pac!.provenance.gifts = []; evidence.positiveOutsideEvidence![0].allocations = []; } });
    const result = await replaceOregonCandidateFinanceSnapshot({ db: db as unknown as Parameters<typeof replaceOregonCandidateFinanceSnapshot>[0]['db'], link: incomingLink, summary, verifiedFinance: evidence });
    expect(result).toMatchObject({ pacDonorsWritten: 1, verifiedOutsideGroupsWritten: 1 });
    expect(inserts(db, 'or_candidate_finance_links')[0][1][6]).toBe('21892');
    expect(inserts(db, 'or_candidate_finance_summaries')[0][1]).toContain(999.99);
    expect(inserts(db, 'or_candidate_finance_pac_donors')[0][1][5]).toBe(100.25);
    expect(JSON.parse(inserts(db, 'or_candidate_finance_outside_source_proofs')[0][1][3] as string).allocations).toHaveLength(1);
  });
  it('rolls back preceding finance inserts if later proof insertion fails', async () => {
    const db = pool({ failOn: 'INSERT INTO public.or_candidate_finance_outside_source_proofs' });
    await expect(write(db)).rejects.toThrow('injected financial write failure');
    expect(inserts(db, 'or_candidate_finance_pac_donors')).toHaveLength(1); expect(inserts(db, 'or_candidate_finance_outside_groups')).toHaveLength(1);
    expect(sqls(db).at(-1)).toBe('ROLLBACK'); expect(sqls(db)).not.toContain('COMMIT'); expect(db.client.release).toHaveBeenCalledOnce();
  });
  it('accepts safe exact pg decimal strings against stored authority', async () => {
    const db = pool({ priorPac: pac().provenance, pacRows: storedPac(), priorOutside: outside(), groupRows: storedOutside() });
    expect(await write(db)).toMatchObject({ pacDonorsWritten: 1, verifiedOutsideGroupsWritten: 1 });
  });
  it.each(['100.251', '900719925474099.99', '1e2', 100.25])('preserves unsafe or unprojected pg decimal %j', async amount => {
    const db = pool({ priorPac: pac().provenance, pacRows: storedPac(amount) });
    expect((await write(db)).pacDonorsWritten).toBe(0); expect(inserts(db, 'or_candidate_finance_pac_donors')).toHaveLength(0);
  });
  it('only clears a proved-zero same-stance headline, preserving positive and unrelated stance values', async () => {
    const db = pool(); await write(db);
    const call = db.query.mock.calls.find(call => call[0].startsWith('UPDATE public.or_candidate_finance_summaries SET'))!;
    expect(call[0]).toContain('CASE WHEN outside_support_total=0 AND $3::bigint>0 THEN NULL ELSE outside_support_total END');
    expect(call[0]).toContain('CASE WHEN outside_oppose_total=0 AND $4::bigint>0 THEN NULL ELSE outside_oppose_total END');
    expect(call[1]).toEqual([LINK, 2026, 12025, 0]);
    expect(call[0]).not.toContain('outside_support_total=NULL');
  });
});

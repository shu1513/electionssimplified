import { describe, expect, it } from 'vitest';
import { prepareOregonVerifiedOutsideUpdate, prepareOregonVerifiedPacUpdate } from '../../../src/pipeline/oregonFinance/oregonVerifiedFinanceUpdates.js';
import type { OregonPacCandidateContext, OregonVerifiedPacDonor, OregonVerifiedPacProvenance } from '../../../src/pipeline/oregonFinance/oregonVerifiedPacSource.js';
import type { OregonVerifiedOutsideEvidence } from '../../../src/pipeline/oregonFinance/oregonVerifiedOutsideSource.js';

// Synthetic persistence-policy fixtures: no actual acquisition or source money is claimed.
const context: OregonPacCandidateContext = {
  candidateId: '11111111-1111-4111-8111-111111111111', electionId: '22222222-2222-4222-8222-222222222222',
  committeeId: '21892', candidateName: 'Adam Baker', electionYear: 2026, electionType: 'General',
  officeName: 'State Lower Chamber Legislator', district: '40',
};
const hash = 'a'.repeat(64);
const url = (id: string) => 'https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=' + id;
function pac(ids = ['100']): { provenance: OregonVerifiedPacProvenance; donors: OregonVerifiedPacDonor[] } {
  return {
    provenance: { version: 1, scope: 'current_named_registered_pac_cash', candidateContext: { ...context },
      windowStart: '2025-01-01', windowEnd: '2026-12-31', unclassifiedMiscCashAmountCents: 0,
      unclassifiedMiscCashCount: 0, fullCurrentCashFingerprint: hash, sourceHashes: [hash],
      gifts: ids.map(transactionId => ({ transactionId, originalId: transactionId, donorCommitteeId: '23238',
        date: '2026-09-22', amountCents: 10000, identityFingerprint: hash })) },
    donors: ids.length ? [{ committeeId: '23238', committeeName: 'Synthetic PAC', committeeType: 'Political Action Committee',
      amount: ids.length * 100, contributionCount: ids.length, sourceUrl: 'https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=23238' }] : [],
  };
}
function outside(ids = ['200']): OregonVerifiedOutsideEvidence {
  return { version: 1, scope: 'current_original_cash_ie_allocations', candidateContext: { ...context },
    payer: { committeeId: '23238', committeeName: 'Synthetic PAC' }, windowStart: '2025-01-01', windowEnd: '2026-12-31',
    allocationPolicy: '2026_general_rolling_window_2026-09-22_2026-11-03', contextFingerprint: hash,
    payerSooFingerprint: hash, sourceHashes: [hash],
    transactions: ids.map(transactionId => ({ transactionId, originalId: transactionId, date: '2026-09-22', amountCents: 20000, identityFingerprint: hash })),
    allocations: ids.map(transactionId => ({ transactionId, occurrence: 0, targetName: 'Adam Baker', targetCommitteeId: '21892',
      supportOppose: 'support', amountCents: 10000, mechanism: 'independent', sourceUrl: url(transactionId) })),
    supportCents: ids.length * 10000, opposeCents: 0 };
}
const noPac = { provenance: null, donors: [] };
const noOutside = { provenance: null, groups: [] };
function outsideUpdate(incoming: unknown, previous: { provenance: unknown; groups: unknown } = noOutside) {
  return prepareOregonVerifiedOutsideUpdate({ expectedContext: context, payerCommitteeId: '23238', previous, incoming });
}
function outsidePrior(evidence = outside()) {
  const update = outsideUpdate(evidence).update!;
  return { provenance: update.provenance, groups: [...update.groups] };
}
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)])) as T;
  return value;
}

describe('Oregon verified PAC update policy', () => {
  it('omission preserves malformed legacy materialization without a write intent', () => {
    expect(prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: { provenance: {}, donors: [{ amount: 900 }] } })).toEqual({ diagnostics: [] });
  });
  it('accepts a first verified positive and append-only distinct Original gifts', () => {
    const first = prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: noPac, incoming: pac() });
    expect(first.update?.donors[0]).toMatchObject({ amount: 100, contributionCount: 1 });
    const append = prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: first.update!, incoming: pac(['100', '101']) });
    expect(append.update?.donors[0]).toMatchObject({ amount: 200, contributionCount: 2 });
  });
  it('accepts JSONB key order changes while validating exact stored money', () => {
    expect(prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: reversedKeys(pac()), incoming: pac() }).update).toBeDefined();
  });
  it.each(['amount', 'count', 'source', 'duplicate'])('preserves mismatched stored PAC %s', kind => {
    const previous = pac();
    if (kind === 'amount') previous.donors[0].amount = 99;
    if (kind === 'count') previous.donors[0].contributionCount = 2;
    if (kind === 'source') previous.donors[0].sourceUrl = url('100');
    if (kind === 'duplicate') previous.donors.push({ ...previous.donors[0] });
    expect(prepareOregonVerifiedPacUpdate({ expectedContext: context, previous, incoming: pac() }).update).toBeUndefined();
  });
  it.each(['disappeared', 'changed-identity', 'changed-name', 'changed-window', 'changed-context'])('preserves prior PAC %s', kind => {
    const incoming = pac();
    if (kind === 'disappeared') { incoming.provenance.gifts = []; incoming.donors = []; }
    if (kind === 'changed-identity') incoming.provenance.gifts[0].identityFingerprint = 'b'.repeat(64);
    if (kind === 'changed-name') incoming.donors[0].committeeName = 'Different PAC';
    if (kind === 'changed-window') incoming.provenance.windowStart = '2025-02-01';
    if (kind === 'changed-context') incoming.provenance.candidateContext.district = '41';
    expect(prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: pac(), incoming }).update).toBeUndefined();
  });
  it('preserves unproved legacy money and malformed authority even with empty rows', () => {
    expect(prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: { provenance: null, donors: pac().donors }, incoming: pac() }).update).toBeUndefined();
    expect(prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: { provenance: {}, donors: [] }, incoming: pac() }).update).toBeUndefined();
  });
  it('allows proved empty PAC only without prior gifts or positive anonymous uncertainty', () => {
    expect(prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: noPac, incoming: pac([]) }).update?.donors).toEqual([]);
    const anonymous = pac([]);
    anonymous.provenance.unclassifiedMiscCashCount = 1;
    anonymous.provenance.unclassifiedMiscCashAmountCents = 100;
    expect(prepareOregonVerifiedPacUpdate({ expectedContext: context, previous: noPac, incoming: anonymous }).update).toBeUndefined();
  });
});

describe('Oregon verified per-payer outside update policy', () => {
  it('omission preserves malformed legacy groups without a write intent', () => {
    expect(prepareOregonVerifiedOutsideUpdate({ expectedContext: context, payerCommitteeId: '23238', previous: { provenance: {}, groups: [900] } })).toEqual({ diagnostics: [] });
  });
  it('accepts appended positive evidence for only one payer and picks the smallest actual transaction URL', () => {
    const update = outsideUpdate(outside(['200', '100']), outsidePrior()).update!;
    expect(update.groups).toEqual([{ sponsorId: '23238', sponsorName: 'Synthetic PAC', supportOppose: 'support', amount: 200, sourceUrl: url('100') }]);
    expect(update.supportCents).toBe(20000); expect(update.opposeCents).toBe(0);
  });
  it('retains tuple multiplicity while ignoring display ordinal and JSONB key order', () => {
    const evidence = outside();
    evidence.allocations = [evidence.allocations[0], { ...evidence.allocations[0], occurrence: 1 }]; evidence.supportCents = 20000;
    const previous = reversedKeys(outsidePrior(evidence));
    const incoming = structuredClone(evidence);
    incoming.allocations = [{ ...incoming.allocations[1], occurrence: 9 }, { ...incoming.allocations[0], occurrence: 8 }];
    expect(outsideUpdate(incoming, previous).update?.supportCents).toBe(20000);
    incoming.allocations = [incoming.allocations[0]]; incoming.supportCents = 10000;
    expect(outsideUpdate(incoming, previous).update).toBeUndefined();
  });
  it('accepts stored row order changes without ignoring group contents', () => {
    const evidence = outside(['200', '201']);
    evidence.allocations[1].supportOppose = 'oppose'; evidence.supportCents = 10000; evidence.opposeCents = 10000;
    const previous = outsidePrior(evidence);
    expect(outsideUpdate(evidence, { ...previous, groups: [...previous.groups].reverse() }).update).toBeDefined();
  });
  it.each(['amount', 'name', 'source', 'stance', 'payer', 'duplicate'])('preserves mismatched stored outside %s', kind => {
    const previous = structuredClone(outsidePrior()); const row = previous.groups[0];
    if (kind === 'amount') row.amount = 99;
    if (kind === 'name') row.sponsorName = 'Other PAC';
    if (kind === 'source') row.sourceUrl = url('201');
    if (kind === 'stance') row.supportOppose = 'oppose';
    if (kind === 'payer') row.sponsorId = '169';
    if (kind === 'duplicate') previous.groups.push({ ...row });
    expect(outsideUpdate(outside(), previous).update).toBeUndefined();
  });
  it.each(['transaction', 'payer', 'window', 'context-hash', 'soo-hash', 'allocation'])('preserves incompatible new outside %s', kind => {
    const incoming = outside();
    if (kind === 'transaction') incoming.transactions[0].identityFingerprint = 'b'.repeat(64);
    if (kind === 'payer') incoming.payer.committeeId = '169';
    if (kind === 'window') incoming.windowStart = '2025-02-01';
    if (kind === 'context-hash') incoming.contextFingerprint = 'b'.repeat(64);
    if (kind === 'soo-hash') incoming.payerSooFingerprint = 'b'.repeat(64);
    if (kind === 'allocation') { incoming.allocations[0].amountCents = 9000; incoming.supportCents = 9000; }
    expect(outsideUpdate(incoming, outsidePrior()).update).toBeUndefined();
  });
  it('preserves malformed or legacy-positive groups and never accepts empty outside zero', () => {
    expect(outsideUpdate(outside(), { provenance: null, groups: outsidePrior().groups }).update).toBeUndefined();
    expect(outsideUpdate(outside(), { provenance: {}, groups: [] }).update).toBeUndefined();
    expect(outsideUpdate(outside([])).update).toBeUndefined();
  });
});

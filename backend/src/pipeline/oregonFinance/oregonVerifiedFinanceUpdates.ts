import {
  validateOregonVerifiedPacProvenance,
  type OregonPacCandidateContext,
  type OregonVerifiedPacDonor,
  type OregonVerifiedPacProvenance,
} from './oregonVerifiedPacSource.js';
import {
  validateOregonVerifiedOutsideEvidence,
  type OregonVerifiedOutsideEvidence,
  type OregonOutsideSourceAllocation,
} from './oregonVerifiedOutsideSource.js';
import { fingerprintOregonVerifiedRows } from './oregonVerifiedSourceDecoders.js';

export type OregonVerifiedOutsideGroup = {
  sponsorId: string;
  sponsorName: string;
  supportOppose: 'support' | 'oppose';
  amount: number;
  sourceUrl: string;
};

type Preparation<T> = { update?: T; diagnostics: readonly string[] };
type PacUpdate = {
  provenance: OregonVerifiedPacProvenance;
  donors: readonly OregonVerifiedPacDonor[];
};
type OutsideUpdate = {
  provenance: OregonVerifiedOutsideEvidence;
  groups: readonly OregonVerifiedOutsideGroup[];
  supportCents: number;
  opposeCents: number;
};
const fingerprint = (value: unknown): string => fingerprintOregonVerifiedRows([value]);
const absent = (value: unknown): boolean => value === undefined || value === null;
const emptyRows = (rows: unknown): boolean => Array.isArray(rows) && rows.length === 0;
const preserve = <T>(reason: string): Preparation<T> => ({ diagnostics: [reason] });

function cents(amount: unknown): number | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return undefined;
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!parts) return undefined;
  const value = Number(parts[1]) * 100 + Number((parts[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(value) && value / 100 === amount ? value : undefined;
}

/** Recheck materialization and prior gift identity under the future writer's lock. */
export function prepareOregonVerifiedPacUpdate(input: {
  expectedContext: OregonPacCandidateContext;
  previous: { provenance: unknown; donors: unknown };
  incoming?: { provenance: unknown; donors: unknown };
}): Preparation<PacUpdate> {
  if (input.incoming === undefined) return { diagnostics: [] };
  try {
    const next = input.incoming;
    if (!validateOregonVerifiedPacProvenance({ ...next, expectedContext: input.expectedContext })) {
      return preserve('Invalid incoming Oregon PAC authority or materialization');
    }
    const provenance = next.provenance as OregonVerifiedPacProvenance;
    const donors = next.donors as readonly OregonVerifiedPacDonor[];
    if (absent(input.previous.provenance)) {
      if (!emptyRows(input.previous.donors)) return preserve('Legacy Oregon PAC materialization has no accepted authority');
    } else {
      if (!validateOregonVerifiedPacProvenance({ ...input.previous, expectedContext: input.expectedContext })) {
        return preserve('Stored Oregon PAC authority and materialization disagree');
      }
      const old = input.previous.provenance as OregonVerifiedPacProvenance;
      if (old.windowStart !== provenance.windowStart || old.windowEnd !== provenance.windowEnd) {
        return preserve('Incompatible Oregon PAC source window');
      }
      const gifts = new Map(provenance.gifts.map(gift => [gift.transactionId, gift]));
      for (const gift of old.gifts) {
        if (fingerprint(gifts.get(gift.transactionId)) !== fingerprint(gift)) {
          return preserve('Prior accepted Oregon PAC gift disappeared or changed');
        }
      }
      const donorById = new Map(donors.map(donor => [donor.committeeId, donor]));
      for (const oldDonor of input.previous.donors as readonly OregonVerifiedPacDonor[]) {
        const current = donorById.get(oldDonor.committeeId);
        if (!current || current.committeeName !== oldDonor.committeeName ||
            current.committeeType !== oldDonor.committeeType || current.sourceUrl !== oldDonor.sourceUrl) {
          return preserve('Prior Oregon PAC donor name, class or source changed');
        }
      }
    }
    return { update: { provenance, donors }, diagnostics: [] };
  } catch {
    return preserve('Malformed Oregon PAC update input');
  }
}

function allocationIdentity(allocation: OregonOutsideSourceAllocation): unknown {
  const { occurrence: _displayOrdinal, ...identity } = allocation;
  return identity;
}

function materializeOutside(evidence: OregonVerifiedOutsideEvidence): readonly OregonVerifiedOutsideGroup[] {
  const groups: OregonVerifiedOutsideGroup[] = [];
  for (const stance of ['support', 'oppose'] as const) {
    const allocations = evidence.allocations.filter(row => row.supportOppose === stance);
    if (!allocations.length) continue;
    const total = allocations.reduce((sum, row) => sum + row.amountCents, 0);
    const amount = total / 100;
    if (!Number.isSafeInteger(total) || cents(amount) !== total) throw new Error('Unsafe outside group money');
    // An actual detail URL, deterministically selected from the smallest allocated public transaction ID.
    const source = allocations.reduce((first, row) => Number(row.transactionId) < Number(first.transactionId) ? row : first);
    groups.push({ sponsorId: evidence.payer.committeeId, sponsorName: evidence.payer.committeeName,
      supportOppose: stance, amount, sourceUrl: source.sourceUrl });
  }
  return groups;
}

function groupsAgree(rows: unknown, expected: readonly OregonVerifiedOutsideGroup[]): boolean {
  if (!Array.isArray(rows) || rows.length !== expected.length) return false;
  const seen = new Set<string>();
  const materialized: unknown[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.sponsorId !== 'string' ||
        typeof row.sponsorName !== 'string' || !['support', 'oppose'].includes(row.supportOppose) ||
        typeof row.sourceUrl !== 'string' || cents(row.amount) === undefined) return false;
    const key = row.sponsorId + ':' + row.supportOppose;
    if (seen.has(key)) return false;
    seen.add(key);
    materialized.push({ sponsorId: row.sponsorId, sponsorName: row.sponsorName,
      supportOppose: row.supportOppose, amount: row.amount, sourceUrl: row.sourceUrl });
  }
  return fingerprintOregonVerifiedRows(materialized) === fingerprintOregonVerifiedRows(expected);
}

/** One payer's positive update only; omitted payers and candidate-wide legacy totals remain the writer's responsibility. */
export function prepareOregonVerifiedOutsideUpdate(input: {
  expectedContext: OregonPacCandidateContext;
  payerCommitteeId: string;
  previous: { provenance: unknown; groups: unknown };
  incoming?: unknown;
}): Preparation<OutsideUpdate> {
  if (input.incoming === undefined) return { diagnostics: [] };
  try {
    const next = input.incoming;
    if (!validateOregonVerifiedOutsideEvidence(next, input.expectedContext) ||
        next.payer.committeeId !== input.payerCommitteeId || next.payer.committeeId === input.expectedContext.committeeId) {
      return preserve('Invalid incoming Oregon outside authority or payer');
    }
    const groups = materializeOutside(next);
    if (!groups.length) return preserve('Empty Oregon outside evidence is not zero authority');
    if (absent(input.previous.provenance)) {
      if (!emptyRows(input.previous.groups)) return preserve('Legacy Oregon outside materialization has no accepted authority');
    } else {
      const old = input.previous.provenance;
      if (!validateOregonVerifiedOutsideEvidence(old, input.expectedContext) || old.payer.committeeId !== input.payerCommitteeId ||
          !groupsAgree(input.previous.groups, materializeOutside(old))) {
        return preserve('Stored Oregon outside authority and materialization disagree');
      }
      if (fingerprint(old.payer) !== fingerprint(next.payer) || old.windowStart !== next.windowStart ||
          old.windowEnd !== next.windowEnd || old.allocationPolicy !== next.allocationPolicy ||
          old.contextFingerprint !== next.contextFingerprint || old.payerSooFingerprint !== next.payerSooFingerprint) {
        return preserve('Incompatible Oregon outside payer, window or source context');
      }
      const transactions = new Map(next.transactions.map(row => [row.transactionId, row]));
      for (const transaction of old.transactions) {
        if (fingerprint(transactions.get(transaction.transactionId)) !== fingerprint(transaction)) {
          return preserve('Prior accepted Oregon outside transaction disappeared or changed');
        }
      }
      const allocations = next.allocations.map(row => fingerprint(allocationIdentity(row)));
      for (const allocation of old.allocations) {
        const index = allocations.indexOf(fingerprint(allocationIdentity(allocation)));
        if (index < 0) return preserve('Prior accepted Oregon outside allocation disappeared or changed');
        allocations.splice(index, 1);
      }
    }
    return { update: { provenance: next, groups, supportCents: next.supportCents, opposeCents: next.opposeCents }, diagnostics: [] };
  } catch {
    return preserve('Malformed Oregon outside update input');
  }
}

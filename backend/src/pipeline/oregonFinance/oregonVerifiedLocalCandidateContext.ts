import { oregonVerifiedCandidateOfficeLine } from './oregonVerifiedCandidateContext.js';
import type { OregonPacCandidateContext } from './oregonVerifiedPacSource.js';

export type OregonVerifiedLocalCandidateRow = {
  candidateId: string;
  electionId: string;
  committeeId: string;
  candidateName: string;
  electionDate: string | Date;
  electionStage: string;
  officeName: string;
  districtName: string;
  districtState: string;
  districtType: string;
  geoidCompact: string;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OFFICE_TYPES: Readonly<Record<string, string>> = {
  Governor: 'statewide',
  'Secretary of State': 'statewide',
  'Attorney General': 'statewide',
  'State Treasurer': 'statewide',
  'State Senator': 'state_upper',
  'State Lower Chamber Legislator': 'state_lower',
  'State Representative': 'state_lower',
};

function electionYear(value: string | Date): number | undefined {
  const date = value instanceof Date
    ? Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : undefined
    : value;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return undefined;
  return parsed.getUTCFullYear();
}

/** Project authoritative local district geometry, keeping display names intact. */
export function projectOregonVerifiedLocalCandidateContext(input: {
  row: OregonVerifiedLocalCandidateRow;
  expectedYear: number;
}): { candidateContext?: OregonPacCandidateContext; diagnostics: readonly string[] } {
  const preserve = (reason: string) => ({ diagnostics: ['Oregon local candidate context: ' + reason] });
  try {
    const row = input.row;
    if (!row || typeof row.candidateId !== 'string' || typeof row.electionId !== 'string' ||
        !UUID.test(row.candidateId) || !UUID.test(row.electionId) ||
        typeof row.committeeId !== 'string' || !/^[1-9]\d*$/.test(row.committeeId) || !Number.isSafeInteger(Number(row.committeeId))) {
      return preserve('invalid candidate, election or public committee ID');
    }
    if (typeof row.candidateName !== 'string' || !row.candidateName.trim() ||
        typeof row.districtName !== 'string' || !row.districtName.trim()) return preserve('missing actual display identity');
    if (row.districtState !== 'OR' || row.electionStage !== 'general') return preserve('wrong state or election stage');
    const year = electionYear(row.electionDate);
    if (!Number.isInteger(input.expectedYear) || input.expectedYear < 1900 || input.expectedYear > 2100 || year !== input.expectedYear) {
      return preserve('invalid election date or mismatched election year');
    }
    const type = typeof row.officeName === 'string' && Object.hasOwn(OFFICE_TYPES, row.officeName) ? OFFICE_TYPES[row.officeName] : undefined;
    if (!type || row.districtType !== type) return preserve('unsupported or mismatched office and district type');
    let district: string | null;
    if (type === 'statewide') {
      if (row.geoidCompact !== '41') return preserve('invalid Oregon statewide GEOID');
      district = null;
    } else {
      if (typeof row.geoidCompact !== 'string' || !/^41\d{3}$/.test(row.geoidCompact)) return preserve('invalid Oregon legislative GEOID');
      const seat = Number(row.geoidCompact.slice(2));
      if (!Number.isSafeInteger(seat) || seat < 1 || seat > 999) return preserve('invalid legislative seat');
      district = String(seat);
    }
    const candidateContext: OregonPacCandidateContext = {
      candidateId: row.candidateId, electionId: row.electionId, committeeId: row.committeeId,
      candidateName: row.candidateName, electionYear: year!, electionType: 'General', officeName: row.officeName, district,
    };
    if (oregonVerifiedCandidateOfficeLine(candidateContext) === null) return preserve('unsupported source office mapping');
    return { candidateContext, diagnostics: [] };
  } catch {
    return preserve('malformed actual local row');
  }
}

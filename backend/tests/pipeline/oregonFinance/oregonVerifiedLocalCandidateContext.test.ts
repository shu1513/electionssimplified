import { describe, expect, it } from 'vitest';
import { projectOregonVerifiedLocalCandidateContext, type OregonVerifiedLocalCandidateRow } from '../../../src/pipeline/oregonFinance/oregonVerifiedLocalCandidateContext.js';
import { oregonVerifiedCandidateOfficeLine } from '../../../src/pipeline/oregonFinance/oregonVerifiedCandidateContext.js';

function row(overrides: Partial<OregonVerifiedLocalCandidateRow> = {}): OregonVerifiedLocalCandidateRow {
  return { candidateId: '11111111-1111-4111-8111-111111111111', electionId: '22222222-2222-4222-8222-222222222222',
    committeeId: '21892', candidateName: 'Adam Baker', electionDate: '2026-11-03', electionStage: 'general',
    officeName: 'State Lower Chamber Legislator', districtName: 'State House District 40 (2024); Oregon',
    districtState: 'OR', districtType: 'state_lower', geoidCompact: '41040', ...overrides };
}
const project = (overrides: Partial<OregonVerifiedLocalCandidateRow> = {}) => projectOregonVerifiedLocalCandidateContext({ row: row(overrides), expectedYear: 2026 });

describe('authoritative Oregon local candidate projection', () => {
  it.each([['20', '41020'], ['40', '41040']])('projects actual House%s GEOID without treating district display as numeric', (seat, geoidCompact) => {
    const result = project({ districtName: `State House District ${seat} (2024); Oregon`, geoidCompact });
    expect(result.candidateContext).toMatchObject({ district: seat, officeName: 'State Lower Chamber Legislator', electionYear: 2026, electionType: 'General' });
    expect(oregonVerifiedCandidateOfficeLine(result.candidateContext!)).toBe(`State Representative, ${seat}th District`);
  });
  it('keeps full candidate display and exact office while projecting upper chamber', () => {
    const result = project({ candidateName: 'A. Full "Display" Name, Jr.', officeName: 'State Senator', districtType: 'state_upper', geoidCompact: '41003' });
    expect(result.candidateContext?.candidateName).toBe('A. Full "Display" Name, Jr.');
    expect(result.candidateContext?.district).toBe('3');
    expect(oregonVerifiedCandidateOfficeLine(result.candidateContext!)).toBe('State Senator, 3rd District');
  });
  it.each(['Governor', 'Secretary of State', 'Attorney General', 'State Treasurer'])('projects exact statewide %s with null source seat', officeName => {
    expect(project({ officeName, districtType: 'statewide', districtName: 'Oregon', geoidCompact: '41' }).candidateContext).toMatchObject({ officeName, district: null });
  });
  it('accepts the actual database Date representation using its calendar year', () => {
    expect(project({ electionDate: new Date('2026-11-03T00:00:00Z') }).candidateContext?.electionYear).toBe(2026);
  });
  it.each([
    { districtState: 'WA' }, { districtState: 'or' }, { electionStage: 'primary' }, { electionStage: 'General' },
    { electionDate: '2025-11-03' }, { electionDate: '2026-02-30' }, { electionDate: '2026-11-03T00:00:00Z' },
    { electionDate: new Date('invalid') }, { officeName: 'State House Representative' }, { officeName: 'Governor', districtType: 'state_lower' },
    { officeName: 'State Senator', districtType: 'state_lower' }, { geoidCompact: '53040' }, { geoidCompact: '41000' },
    { geoidCompact: '4140' }, { geoidCompact: '410040' }, { geoidCompact: '41A40' }, { candidateId: 'not-uuid' },
    { electionId: '' }, { committeeId: '021892' }, { committeeId: '9007199254740992' }, { candidateName: ' ' }, { districtName: '' },
  ])('preserves invalid or mismatched actual row %j', overrides => {
    expect(project(overrides).candidateContext).toBeUndefined();
    expect(project(overrides).diagnostics).toHaveLength(1);
  });
  it('rejects legislative GEOID for a statewide office and expected year mismatch', () => {
    expect(project({ officeName: 'Governor', districtType: 'statewide', geoidCompact: '41040' }).candidateContext).toBeUndefined();
    expect(projectOregonVerifiedLocalCandidateContext({ row: row(), expectedYear: 2024 }).candidateContext).toBeUndefined();
  });
  it('rejects an unknown office despite prototype-key spelling', () => {
    expect(project({ officeName: 'toString' }).candidateContext).toBeUndefined();
  });
});

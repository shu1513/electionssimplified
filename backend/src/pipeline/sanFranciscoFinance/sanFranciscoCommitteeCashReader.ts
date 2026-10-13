import {
  candidateElectionKey,
  parseFinanceAmount,
  type BallotLookupFinancePacInterest,
} from "../address/ballotLookupFinanceShared.js";
import {
  classifyPacInterest,
  PAC_INTERESTS_NOT_LISTED,
  pacInterestDisplayName,
  UNCLASSIFIED_PAC_INTEREST,
} from "../finance/pacInterestClassifier.js";

export type SanFranciscoCommitteeCashReaderRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  amount: string | number;
  source_url: string | null;
  reported_through: string;
  last_synced_at: string;
};

// Display exclusion only, not a legal role or identity inference. These
// explicit campaign names are present in the official current SF cash rows.
function isCandidateCampaignName(name: string): boolean {
  return (
    /\bFOR (?:SAN FRANCISCO |SF |STATE )?(?:SUPERVISOR|MAYOR|ASSESSOR|PUBLIC DEFENDER|DISTRICT ATTORNEY|SCHOOL BOARD|BOARD OF EDUCATION|CITY ATTORNEY|TREASURER|SHERIFF|ASSEMBLY|SENATE|GOVERNOR|CONGRESS)\b/i.test(
      name,
    ) ||
    /\b(?:COMMITTEE TO ELECT|RE[ -]?ELECT|OFFICEHOLDER COMMITTEE)\b/i.test(name)
  );
}

/** Input has already netted every signed position per candidate-election. */
export function groupSanFranciscoCommitteeCashByInterest(
  rows: readonly SanFranciscoCommitteeCashReaderRow[],
): Map<string, BallotLookupFinancePacInterest[]> {
  const groups = new Map<string, Map<string, BallotLookupFinancePacInterest>>();
  for (const row of rows) {
    const amount = parseFinanceAmount(row.amount);
    if (
      amount === null ||
      amount <= 0 ||
      isCandidateCampaignName(row.committee_name)
    )
      continue;
    const interest =
      classifyPacInterest({
        committeeName: row.committee_name,
        committeeType: null,
        designation: null,
        organizationType: null,
        connectedOrganization: null,
      }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
    if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest))
      continue;
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const interests =
      groups.get(key) ?? new Map<string, BallotLookupFinancePacInterest>();
    const group = interests.get(interest) ?? {
      interest,
      interest_name: pacInterestDisplayName(interest),
      amount: 0,
      pac_count: 0,
      pacs: [],
    };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    group.pac_count += 1;
    group.pacs.push({
      committee_id: row.committee_id,
      committee_name: row.committee_name,
      amount,
      source_url: row.source_url,
    });
    interests.set(interest, group);
    groups.set(key, interests);
  }
  return new Map(
    [...groups].map(([key, interests]) => [
      key,
      [...interests.values()]
        .map((group) => ({
          ...group,
          pacs: group.pacs
            .sort(
              (a, b) =>
                b.amount - a.amount ||
                a.committee_id.localeCompare(b.committee_id),
            )
            .slice(0, 5),
        }))
        .sort(
          (a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest),
        )
        .slice(0, 5),
    ]),
  );
}

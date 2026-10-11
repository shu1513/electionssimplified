import {
  buildKentuckyKrefContributionExportUrl,
  downloadKentuckyKrefCandidateContributions,
  type KentuckyKrefClientOptions,
  type KentuckyKrefContributionRecord,
} from "./kentuckyKrefClient.js";
import { filterKentuckyContributionRecordsForCandidateCycle } from "./kentuckyDirectContributionAggregator.js";
import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { kentuckyKrefCandidateSearchName, type KentuckyKrefDataClient } from "./kentuckyCandidateFinanceSync.js";
import type {
  KentuckyCandidateFinanceAutoLinkResolver,
  KentuckyCandidateFinanceLinkResolution,
  KentuckyFinanceAutoLinkCandidateElection,
} from "./kentuckyCandidateFinanceAutoLink.js";

function normalizeKeyComponent(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function recordCommitteeName(record: KentuckyKrefContributionRecord): string {
  return record.recipientName?.trim() || record.toOrganizationName?.trim() || "";
}

// KREF's public search has no stable numeric identifiers, so links are keyed
// by deterministic derived keys (matching the conventions the sync and tests
// already use): candidateKey identifies the campaign
// ("<name>|<office>|<scope>|<election date>") and committeeKey is the
// normalized committee name.
function buildCandidateKey(candidateElection: KentuckyFinanceAutoLinkCandidateElection): string {
  return [
    normalizeKeyComponent(candidateElection.candidateName),
    normalizeKeyComponent(candidateElection.officeName),
    normalizeKeyComponent(candidateElection.officeScope),
    candidateElection.electionDate,
  ].join("|");
}

// Resolves a Kentucky candidate to their KREF committee identity by
// downloading the candidate's contribution export (KREF's only public query
// path — there is no committee-registry endpoint) and filtering it to rows
// that match the candidate's name, office, and district within the election
// YEAR. KREF tags rows to specific elections (primary vs general), so the
// cycle filter deliberately accepts any election date in the year; the due
// sync's aggregation applies its own stricter per-election rules afterwards.
export function createKentuckyKrefCandidateFinanceLinkResolver(
  options: {
    krefClient?: Partial<Pick<KentuckyKrefDataClient, "downloadCandidateContributions">>;
    krefClientOptions?: KentuckyKrefClientOptions;
  } = {}
): KentuckyCandidateFinanceAutoLinkResolver {
  const downloadCandidateContributions =
    options.krefClient?.downloadCandidateContributions ?? downloadKentuckyKrefCandidateContributions;

  return async (
    candidateElection: KentuckyFinanceAutoLinkCandidateElection
  ): Promise<KentuckyCandidateFinanceLinkResolution> => {
    // Literal names first. Only when they find nothing: the same rows with
    // widened VoteApp-side names, then one search per formal variant of the
    // first name ("Mike" -> MICHAEL) that the first search could not contain.
    const nameParts = kentuckyKrefCandidateSearchName(candidateElection.candidateName);
    const searchFirstNames: Array<string | undefined> = [nameParts.firstName];
    for (const variant of firstNameVariants((nameParts.firstName ?? "").toUpperCase())) {
      if (!variant.includes((nameParts.firstName ?? "").toUpperCase())) {
        searchFirstNames.push(variant);
      }
    }
    let exportInput: { candidateFirstName?: string; candidateLastName: string } = {
      candidateLastName: nameParts.lastName,
    };
    let matched: KentuckyKrefContributionRecord[] = [];
    for (const [index, firstName] of searchFirstNames.entries()) {
      exportInput = { ...(firstName ? { candidateFirstName: firstName } : {}), candidateLastName: nameParts.lastName };
      const records = await downloadCandidateContributions(exportInput, options.krefClientOptions);
      for (const expandNames of index === 0 ? [false, true] : [true]) {
        matched = filterKentuckyContributionRecordsForCandidateCycle({
          contributionRecords: records,
          candidateName: candidateElection.candidateName,
          electionDate: candidateElection.electionDate,
          officeName: candidateElection.officeName,
          location: candidateElection.location,
          expandNames,
        });
        if (matched.length > 0) {
          break;
        }
      }
      if (matched.length > 0) {
        break;
      }
    }

    if (matched.length === 0) {
      return {
        status: "unmatched",
        reason: "no_kref_contribution_match",
      };
    }

    // KREF candidate committees have no registry ids; the recipient name on
    // the candidate's own contribution rows IS the committee identity
    // (usually the candidate's name — Kentucky candidates mostly file as
    // themselves). Blank recipients fall back to the candidate's name.
    const committeeNamesByKey = new Map<string, { name: string; rowCount: number }>();
    for (const record of matched) {
      const rawName = recordCommitteeName(record) || candidateElection.candidateName.trim();
      const key = normalizeKeyComponent(rawName);
      if (!key) {
        continue;
      }
      const existing = committeeNamesByKey.get(key);
      if (existing) {
        existing.rowCount += 1;
      } else {
        committeeNamesByKey.set(key, { name: rawName, rowCount: 1 });
      }
    }

    if (committeeNamesByKey.size === 0) {
      return {
        status: "unmatched",
        reason: "no_kref_committee_identity",
      };
    }
    if (committeeNamesByKey.size > 1) {
      return {
        status: "ambiguous",
        reason: "multiple_kref_committee_identities",
        matchCount: committeeNamesByKey.size,
      };
    }

    const [committeeKey, committee] = [...committeeNamesByKey.entries()][0]!;
    return {
      status: "matched",
      candidateKey: buildCandidateKey(candidateElection),
      committeeKey,
      committeeName: committee.name,
      sourceUrl: buildKentuckyKrefContributionExportUrl({
        ...exportInput,
        contributionSearchType: "Candidate",
      }),
    };
  };
}

// Delaware candidate -> committee resolver (docs/plans/plan-delaware-finance.md).
//
// Evidence model (probe gate 11 pinned the sources): bulk registry rows
// carry NO OfficeSought/DistrictName, so office evidence comes from the
// portal's own office-filtered committee search — the search is scoped to
// CommitteeType 01 + the exact office code (+ district for legislative
// seats), so every returned committee registered for the target office.
// Name evidence is a conservative whole-word surname match against the
// committee name ("Meyer for Delaware", "Friends of Jane Doe"); a first-name
// refinement breaks surname collisions, and any remaining ambiguity SKIPS
// (plan: ambiguous committee match fails closed — manual links always win
// via the writer's manual-link protection). District dropdown values are
// opaque numbers, so they are resolved live by their "District NN" labels,
// never hardcoded.

import {
  DELAWARE_CFRS_PAGES,
  DELAWARE_CFRS_THEME_QUERY,
  buildDelawareCfrsUrl,
  buildDelawareCommitteeSearchFields,
  createDelawareCfrsSession,
  type DelawareCfrsSession,
  type DelawareCfrsSessionOptions,
} from "./delawareCfrsClient.js";
import {
  committeeNameMiddleEvidenceRowNames,
  hasMiddleNameConflict,
} from "../finance/personNameMiddleEvidence.js";
import { parseDelawareCommitteeGridJson, type DelawareCommitteeGridRow } from "./delawareCfrsParsers.js";
import { toDelawareCfrsOfficeSearch, type DelawareCfrsOfficeSearch } from "./delawareFinanceEligibleOffices.js";

export function normalizeDelawareCandidateNameForStorage(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Person-name form for the shared middle-evidence module: storage
 * normalization plus generational-suffix stripping (the module reads
 * suffixes from the RAW string itself and expects the normalizer to have
 * removed them — the Missouri pattern).
 */
function normalizeDelawarePersonName(value: string): string {
  return normalizeDelawareCandidateNameForStorage(value)
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NAME_SUFFIX_TOKENS = new Set(["JR", "SR", "II", "III", "IV", "V"]);

/** First and last name tokens, suffixes stripped; null when unusable. */
export function delawareCandidateNameTokens(name: string): { first: string; last: string } | null {
  const tokens = normalizeDelawareCandidateNameForStorage(name)
    .split(" ")
    .filter((token) => token !== "" && !NAME_SUFFIX_TOKENS.has(token));
  if (tokens.length < 2) {
    return null;
  }
  return { first: tokens[0]!, last: tokens[tokens.length - 1]! };
}

export type DelawareCommitteeResolution =
  | {
      status: "matched";
      cfId: string;
      memberId: number;
      committeeName: string;
      confidence: "office_filtered_name_match";
      sourceUrl: string;
      matchedCommitteeCount: number;
    }
  | {
      status: "unmatched";
      reason:
        | "missing_candidate_name"
        | "unsupported_office"
        | "no_committee_for_office"
        | "no_candidate_committee_match"
        | "matched_committee_missing_cf_id"
        | "district_option_not_found";
    }
  | { status: "ambiguous"; reason: "multiple_matching_committees"; matches: { cfId: string; committeeName: string }[] };

export type DelawareCandidateCommitteeSearchInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  district?: string | null;
};

function committeeNameMatches(committeeName: string, token: string): boolean {
  return (
    ` ${normalizeDelawareCandidateNameForStorage(committeeName)} `.includes(` ${token} `) ||
    gluedCommitteeNameMatches(committeeName, token)
  );
}

/**
 * Some committees glue the name together ("Friends of KamelaSmith",
 * "HarryGold4Delaware", "LisaMcInnis4RepDist1", "Lindner4Delaware"). Split
 * each word at digits, then accept the token at the start or end of a
 * piece only where the raw text has a capital letter boundary, so "Smith"
 * matches "KamelaSmith" but "Gold" does not match "Goldberg".
 */
function gluedCommitteeNameMatches(committeeName: string, token: string): boolean {
  for (const piece of committeeName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^A-Za-z]+/)) {
    if (piece.length <= token.length) {
      if (piece.toUpperCase() === token) return true;
      continue;
    }
    const upper = piece.toUpperCase();
    if (upper.startsWith(token) && /[a-z][A-Z]/.test(piece.slice(token.length - 1, token.length + 1))) {
      return true;
    }
    const start = piece.length - token.length;
    if (upper.endsWith(token) && /[a-z][A-Z]/.test(piece.slice(start - 1, start + 1))) {
      return true;
    }
  }
  return false;
}

/**
 * Row-name expansion for the middle-evidence veto. The shared helper splits
 * on "for" ("Meyer for Delaware"); Delaware committees also bury the person
 * name behind an "of" designator ("Friends of John B Smith"), so those
 * segments are added too. Extra segments can only ADD aligned evidence,
 * never block alignment that already existed (the module invariant).
 */
function delawareCommitteeEvidenceRowNames(committeeName: string): string[] {
  const names = new Set(committeeNameMiddleEvidenceRowNames(committeeName));
  for (const name of [...names]) {
    for (const segment of name.split(/\bof\b/i)) {
      const trimmed = segment.trim();
      if (trimmed) {
        names.add(trimmed);
      }
    }
  }
  return [...names];
}

async function resolveDistrictOptionValue(
  session: DelawareCfrsSession,
  officeSearch: DelawareCfrsOfficeSearch
): Promise<string | null> {
  const response = await session.postForm(
    buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.getDistricts),
    { OfficeType: officeSearch.officeType, CountyCode: "", Office: officeSearch.officeCode },
    { xhr: true }
  );
  for (const option of response.text().matchAll(/<option[^>]*value=(?:"([^"]*)"|'([^']*)')[^>]*>([^<]*)</g)) {
    const value = (option[1] ?? option[2] ?? "").trim();
    const label = (option[3] ?? "").trim();
    const number = /District\s+0*(\d+)/i.exec(label);
    if (value !== "" && number !== null && Number.parseInt(number[1]!, 10) === officeSearch.districtNumber) {
      return value;
    }
  }
  return null;
}

/**
 * Runs the office-filtered type-01 committee search live and resolves the
 * candidate's committee. Exactly one active, name-matching committee with a
 * CF_ID wins; everything else returns a typed non-match.
 */
export async function searchAndResolveDelawareCandidateCommittee(
  input: DelawareCandidateCommitteeSearchInput,
  options?: DelawareCfrsSessionOptions
): Promise<DelawareCommitteeResolution> {
  const nameTokens = delawareCandidateNameTokens(input.candidateName);
  if (nameTokens === null) {
    return { status: "unmatched", reason: "missing_candidate_name" };
  }
  const officeSearch = toDelawareCfrsOfficeSearch({
    officeScope: input.officeScope,
    officeName: input.officeName,
    district: input.district,
  });
  if (officeSearch === null) {
    return { status: "unmatched", reason: "unsupported_office" };
  }

  const session = createDelawareCfrsSession(options ?? {});
  await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch));

  let districtValue = "";
  if (officeSearch.districtNumber !== null) {
    const resolved = await resolveDistrictOptionValue(session, officeSearch);
    if (resolved === null) {
      return { status: "unmatched", reason: "district_option_not_found" };
    }
    districtValue = resolved;
  }

  const searchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearchPost, { ...DELAWARE_CFRS_THEME_QUERY });
  await session.postForm(
    searchUrl,
    buildDelawareCommitteeSearchFields({
      CommitteeType: "01",
      ddlOffice: officeSearch.officeType,
      hdnddlOffice: officeSearch.officeType,
      ddlOfficeSought: officeSearch.officeCode,
      hdnddlOfficeSought: officeSearch.officeCode,
      ddljurisdiction: districtValue,
      hdnddljurisdiction: districtValue,
    })
  );

  const rows: DelawareCommitteeGridRow[] = [];
  const pageSize = 500;
  for (let page = 1; page <= 10; page += 1) {
    const gridResponse = await session.postForm(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeGridJson, { ...DELAWARE_CFRS_THEME_QUERY }),
      { page: String(page), size: String(pageSize), orderBy: "", groupBy: "", filter: "" },
      { xhr: true }
    );
    const parsed = parseDelawareCommitteeGridJson(gridResponse.text());
    rows.push(...parsed.rows);
    if (parsed.rows.length < pageSize) {
      break;
    }
  }
  // The registry emits one row per statement version — dedupe by MemberID,
  // keeping active committees only.
  const byMember = new Map<number, DelawareCommitteeGridRow>();
  for (const row of rows) {
    if (row.committeeTypeCode === "01" && /^active$/i.test(row.committeeStatus)) {
      byMember.set(row.memberId, row);
    }
  }
  const committees = [...byMember.values()];
  if (committees.length === 0) {
    return { status: "unmatched", reason: "no_committee_for_office" };
  }

  // Shared middle-evidence veto (finance/personNameMiddleEvidence): a
  // committee whose embedded person name carries a CONTRADICTING middle
  // name/initial or a different generational suffix ("John B. Smith" /
  // "John Smith Sr." for candidate "John A. Smith Jr.") is another person's
  // committee, not a weaker match — drop it before any counting so it can
  // neither win nor force ambiguity.
  let matches = committees.filter(
    (row) =>
      committeeNameMatches(row.committeeName, nameTokens.last) &&
      !hasMiddleNameConflict({
        candidateName: input.candidateName,
        rowNames: delawareCommitteeEvidenceRowNames(row.committeeName),
        normalizePersonName: normalizeDelawarePersonName,
      })
  );
  if (matches.length > 1) {
    const refined = matches.filter((row) => committeeNameMatches(row.committeeName, nameTokens.first));
    if (refined.length >= 1) {
      matches = refined;
    }
  }
  if (matches.length === 0) {
    return { status: "unmatched", reason: "no_candidate_committee_match" };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_matching_committees",
      matches: matches.map((row) => ({ cfId: row.cfId, committeeName: row.committeeName })),
    };
  }
  const winner = matches[0]!;
  if (winner.cfId === "") {
    return { status: "unmatched", reason: "matched_committee_missing_cf_id" };
  }
  return {
    status: "matched",
    cfId: winner.cfId,
    memberId: winner.memberId,
    committeeName: winner.committeeName,
    confidence: "office_filtered_name_match",
    sourceUrl: buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch),
    matchedCommitteeCount: 1,
  };
}

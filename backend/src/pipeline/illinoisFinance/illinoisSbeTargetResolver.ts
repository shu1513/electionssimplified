/** Identity evidence only: a match does not establish current filing or spending coverage. */
export type IllinoisSbeTargetCandidate = {
  candidateId: string;
  candidateName: string;
  office: string;
  district: string;
  districtType: string;
};
export type IllinoisSbeTargetElection = { candidateId: string; electionYear: number; electionType: string };
export type IllinoisSbeTargetCommittee = { committeeId: string; committeeName: string; committeeType: string; committeeStatus?: string };
export type IllinoisSbeTargetCommitteeCandidateLink = { candidateId: string; committeeId: string };
export type IllinoisSbeResolvedTargetOffice = {
  officeScope: "statewide" | "state_lower" | "state_upper";
  officeName: string;
  district: string | null;
};
export type IllinoisSbeTargetResolverInput = {
  targetName: string;
  targetOffice: string;
  target: {
    candidateId: string;
    candidateName: string;
    electionYear: number;
    electionType: "GE";
    officeScope: string;
    officeName: string;
    district: string | null;
  };
  sourceCandidates: readonly IllinoisSbeTargetCandidate[];
  sourceElections: readonly IllinoisSbeTargetElection[];
  /** Complete registry across all committee types/statuses, without a donor-year filter. */
  sourceCommittees: readonly IllinoisSbeTargetCommittee[];
  sourceCommitteeCandidateLinks: readonly IllinoisSbeTargetCommitteeCandidateLink[];
};
export type IllinoisSbeTargetResolution =
  | { status: "matched"; candidateId: string; sourceCandidateName: string; committeeId?: string;
      matchType: "person" | "committee"; office: IllinoisSbeResolvedTargetOffice }
  | { status: "unmatched" | "ambiguous"; reason: string };

function key(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim() : "";
}
function personKey(value: string): string {
  if (typeof value !== "string") return "";
  const parts = value.split(",").map((part) => part.trim());
  // Preserve every given name, middle initial and suffix. No nickname or first/last-only keys.
  const suffixOnly = parts.length === 2 && /^(JR|SR|II|III|IV|V)$/.test(key(parts[1]));
  return key(suffixOnly ? value : parts.length === 2 ? `${parts[1]} ${parts[0]}`
    : parts.length === 3 ? `${parts[1]} ${parts[0]} ${parts[2]}` : value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}
function district(value: unknown, maximum: number): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? String(number) : null;
}
const LOWER = new Set(["STATE REPRESENTATIVE", "STATE HOUSE", "HOUSE OF REPRESENTATIVES", "STATE LOWER CHAMBER LEGISLATOR"]);
const UPPER = new Set(["STATE SENATE", "STATE SENATOR"]);
const STATEWIDE: Readonly<Record<string, string>> = {
  GOVERNOR: "Governor", "LIEUTENANT GOVERNOR": "Lieutenant Governor", "LT GOVERNOR": "Lieutenant Governor",
  "SECRETARY OF STATE": "Secretary of State", "ATTORNEY GENERAL": "Attorney General",
  TREASURER: "State Treasurer", "STATE TREASURER": "State Treasurer",
  COMPTROLLER: "Comptroller", "STATE COMPTROLLER": "Comptroller",
};
function officeWithSeparateDistrict(label: string, rawDistrict: string | null): IllinoisSbeResolvedTargetOffice | null {
  const office = key(label);
  const stateName = STATEWIDE[office.replace(/^ILLINOIS /, "")];
  if (stateName) {
    if (rawDistrict !== null && key(rawDistrict) !== "" && key(rawDistrict) !== "ILLINOIS") return null;
    return { officeScope: "statewide", officeName: stateName, district: null };
  }
  if (LOWER.has(office)) {
    const number = district(rawDistrict, 118);
    return number ? { officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: number } : null;
  }
  if (UPPER.has(office)) {
    const number = district(rawDistrict, 59);
    return number ? { officeScope: "state_upper", officeName: "State Senator", district: number } : null;
  }
  return null;
}
/** Observed whole-field IL House/Senate aliases; legislative district cannot be borrowed from the local target. */
export function resolveIllinoisSbeExpenditureTargetOffice(value: string): IllinoisSbeResolvedTargetOffice | null {
  const office = key(value);
  const lower = /^(IL HOUSE|ILLINOIS HOUSE|STATE REPRESENTATIVE|STATE HOUSE|HOUSE OF REPRESENTATIVES) (?:DIST|DISTRICT) (\d+)$/.exec(office);
  if (lower) return officeWithSeparateDistrict("State Representative", lower[2]!);
  const upper = /^(IL SENATE|ILLINOIS SENATE|STATE SENATE|STATE SENATOR) (?:DIST|DISTRICT) (\d+)$/.exec(office);
  if (upper) return officeWithSeparateDistrict("State Senator", upper[2]!);
  return officeWithSeparateDistrict(office, null);
}
function candidateOffice(row: IllinoisSbeTargetCandidate): IllinoisSbeResolvedTargetOffice | null {
  const office = officeWithSeparateDistrict(row.office, row.district);
  const type = key(row.districtType);
  if (!office || (office.officeScope === "state_lower" && type !== "REPRESENTATIVE") ||
      (office.officeScope === "state_upper" && type !== "SENATE") ||
      (office.officeScope === "statewide" && type !== "STATEWIDE")) return null;
  return office;
}
function sameOffice(left: IllinoisSbeResolvedTargetOffice, right: IllinoisSbeResolvedTargetOffice): boolean {
  return left.officeScope === right.officeScope && left.officeName === right.officeName && left.district === right.district;
}
function candidateIdentity(row: IllinoisSbeTargetCandidate): string {
  return JSON.stringify([personKey(row.candidateName), key(row.office), key(row.districtType), typeof row.district === "string" ? row.district.trim() : ""]);
}

export function resolveIllinoisSbeExpenditureTarget(input: IllinoisSbeTargetResolverInput): IllinoisSbeTargetResolution {
  const reject = (reason: string, ambiguous = false): IllinoisSbeTargetResolution => ({
    status: ambiguous ? "ambiguous" : "unmatched", reason,
  });
  const target = input.target;
  if (!id(target.candidateId) || !personKey(target.candidateName) || !key(input.targetName) ||
      !Number.isInteger(target.electionYear) || target.electionYear < 2000 || target.electionYear > 2100 || target.electionType !== "GE") {
    return reject("invalid_persisted_target_identity");
  }
  const expectedOffice = officeWithSeparateDistrict(target.officeName, target.district);
  const rawOffice = resolveIllinoisSbeExpenditureTargetOffice(input.targetOffice);
  if (!expectedOffice || expectedOffice.officeScope !== target.officeScope) return reject("invalid_persisted_target_office");
  if (!rawOffice) return reject("unsupported_source_target_office");
  if (!sameOffice(rawOffice, expectedOffice)) return reject("source_target_office_or_district_mismatch");
  const currentCandidateIds = new Set(input.sourceElections.filter((row) => row.electionYear === target.electionYear &&
    row.electionType === target.electionType).map((row) => row.candidateId));
  const persistedRows = input.sourceCandidates.filter((row) => row.candidateId === target.candidateId);
  if (persistedRows.length === 0) return reject("persisted_candidate_missing_from_source");
  if (new Set(persistedRows.map(candidateIdentity)).size !== 1) return reject("persisted_candidate_source_identity_conflict", true);
  const persisted = persistedRows[0]!;
  const persistedOffice = candidateOffice(persisted);
  if (!currentCandidateIds.has(persisted.candidateId)) return reject("persisted_candidate_election_missing");
  if (!persistedOffice || !sameOffice(persistedOffice, expectedOffice) ||
      personKey(persisted.candidateName) !== personKey(target.candidateName)) return reject("persisted_candidate_name_or_seat_mismatch");

  const eligibleCandidates = input.sourceCandidates.filter((row) => {
    const office = candidateOffice(row);
    return id(row.candidateId) && currentCandidateIds.has(row.candidateId) && office !== null && sameOffice(office, rawOffice);
  });
  const personMatches = eligibleCandidates.filter((row) => personKey(row.candidateName) === personKey(input.targetName));
  const matchingCommittees = input.sourceCommittees.filter((row) => key(row.committeeName) === key(input.targetName));
  const committeeIds = new Set(matchingCommittees.map((row) => row.committeeId));
  if (committeeIds.size > 1) return reject("registry_committee_name_ambiguous_across_all_types", true);
  let committeeId: string | undefined;
  let committeeMatches: IllinoisSbeTargetCandidate[] = [];
  if (matchingCommittees.length > 0) {
    const committee = matchingCommittees[0]!;
    if (!id(committee.committeeId)) return reject("invalid_source_committee_identity");
    const identityRows = input.sourceCommittees.filter((row) => row.committeeId === committee.committeeId);
    if (new Set(identityRows.map((row) => JSON.stringify([key(row.committeeName), key(row.committeeType)]))).size !== 1) {
      return reject("source_committee_identity_conflict", true);
    }
    if (key(committee.committeeType) !== "CANDIDATE") return reject("target_label_matches_non_candidate_committee");
    committeeId = committee.committeeId;
    const associated = new Set(input.sourceCommitteeCandidateLinks.filter((row) => row.committeeId === committeeId)
      .map((row) => row.candidateId));
    committeeMatches = eligibleCandidates.filter((row) => associated.has(row.candidateId));
    if (committeeMatches.length === 0) return reject("target_committee_has_no_current_candidate_for_seat");
  }
  const matches = [...personMatches, ...committeeMatches];
  const candidateIds = new Set(matches.map((row) => row.candidateId));
  if (candidateIds.size === 0) return reject("source_target_name_unresolved");
  if (candidateIds.size > 1) return reject("source_target_candidate_identity_ambiguous", true);
  const resolvedId = matches[0]!.candidateId;
  if (new Set(input.sourceCandidates.filter((row) => row.candidateId === resolvedId).map(candidateIdentity)).size !== 1) {
    return reject("resolved_candidate_source_identity_conflict", true);
  }
  if (resolvedId !== target.candidateId) return reject("source_target_disagrees_with_persisted_candidate");
  return {
    status: "matched", candidateId: resolvedId, sourceCandidateName: persisted.candidateName,
    ...(committeeId === undefined ? {} : { committeeId }),
    matchType: committeeId === undefined ? "person" : "committee", office: rawOffice,
  };
}

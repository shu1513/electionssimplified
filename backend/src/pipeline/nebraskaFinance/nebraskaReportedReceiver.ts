import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import {
  hasMiddleNameConflict,
  personNamesMatchWithMiddleEvidence,
} from "../finance/personNameMiddleEvidence.js";
import {
  neCheck,
  neKey,
  type NebraskaNativeRegistration,
} from "./nebraskaReportedNative.js";

export type NebraskaReportedReceiver = {
  linkId: string;
  candidateId: string;
  electionId: string;
  electionYear: number;
  electionDate: string;
  candidateAliases: string[];
  receivingId: string;
  legacyCommitteeName: string;
  officeScope: string;
  officeName: string;
  linkOfficeName: string;
  district: string | null;
  canonicalDistrictName: string;
  canonicalDistrictType: string;
  activeCandidateOwnerCount: number;
};
export type NebraskaReportedReceivingContext = {
  receivingId: string;
  candidateName: string;
  committeeName: string;
  officeName: string;
  district: string | null;
  electionYear: number;
};
const OFFICES = new Map<string, string>([
  ["GOVERNOR", "Governor"],
  ["SECRETARY OF STATE", "Secretary of State"],
  ["ATTORNEY GENERAL", "Attorney General"],
  ["STATE TREASURER", "State Treasurer"],
  ["AUDITOR OF PUBLIC ACCOUNTS", "State Auditor"],
  ["STATE AUDITOR", "State Auditor"],
  ["STATE LEGISLATURE", "State Senator"],
]);
export const neOfficeName = (value: string): string | null =>
  OFFICES.get(neKey(value)) ?? null;
function normalizePerson(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(?:JR|SR|II|III|IV)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const equivalentFirst = (candidate: string, source: string): boolean =>
  candidate === source || firstNameVariants(candidate).includes(source);
/** Preserve contradictory evidence from every full/display alias. A short
 * display name must not erase a structured middle name or generation. */
export function nePersonMatches(
  aliases: readonly string[],
  sourceName: string,
): boolean {
  const names = aliases.filter((name) => name.trim());
  return (
    names.length > 0 &&
    !!sourceName.trim() &&
    names.every(
      (candidateName) =>
        !hasMiddleNameConflict({
          candidateName,
          rowNames: [sourceName],
          normalizePersonName: normalizePerson,
          firstNamesEquivalent: equivalentFirst,
        }),
    ) &&
    names.some((candidateName) =>
      personNamesMatchWithMiddleEvidence({
        candidateName,
        rowNames: [sourceName],
        normalizePersonName: normalizePerson,
        firstNamesEquivalent: equivalentFirst,
      }),
    )
  );
}
export function neCanonicalDistrict(
  receiver: NebraskaReportedReceiver,
): string | null {
  if (receiver.officeScope === "statewide") {
    neCheck(
      receiver.canonicalDistrictType === "statewide" &&
        receiver.canonicalDistrictName === "Nebraska" &&
        !receiver.district,
      "canonical_statewide_scope",
    );
    return null;
  }
  neCheck(
    receiver.officeScope === "state_upper" &&
      receiver.officeName === "State Senator" &&
      receiver.canonicalDistrictType === "state_upper",
    "canonical_office_scope",
  );
  // Parentheses carry the boundary vintage, not the candidate's election year.
  const match =
    /^State Senate District ([1-9]\d?)(?: \((?:19|20)\d{2}\))?; Nebraska$/.exec(
      receiver.canonicalDistrictName,
    );
  neCheck(
    match &&
      Number(match[1]) <= 49 &&
      /^[1-9]\d?$/.test(receiver.district ?? "") &&
      Number(match[1]) === Number(receiver.district),
    "canonical_district_scope",
  );
  return String(Number(match[1]));
}
function nativeScope(
  row: NebraskaNativeRegistration,
  receiver: NebraskaReportedReceiver,
  district: string | null,
): boolean {
  return (
    row.jurisdiction === "NEBRASKA" &&
    row.election === `${receiver.electionYear} STATEWIDE ELECTIONS` &&
    neOfficeName(row.office) === receiver.officeName &&
    (district === null
      ? !row.district
      : /^\d+$/.test(row.district) && String(Number(row.district)) === district)
  );
}
export function qualifyNebraskaReportedReceiver(
  receiver: NebraskaReportedReceiver,
  registrations: readonly NebraskaNativeRegistration[],
): NebraskaReportedReceivingContext {
  neCheck(
    /^[1-9]\d*$/.test(receiver.receivingId) &&
      receiver.activeCandidateOwnerCount === 1,
    "exclusive_receiving_identity",
  );
  neCheck(
    receiver.linkOfficeName === receiver.officeName &&
      receiver.electionDate.slice(0, 4) === String(receiver.electionYear),
    "canonical_election_scope",
  );
  const district = neCanonicalDistrict(receiver),
    matches = registrations.filter(
      (row) => row.receivingId === receiver.receivingId,
    );
  neCheck(matches.length === 1, "native_receiving_identity");
  const native = matches[0]!;
  // Termination does not erase a committee's filed transactions or its late
  // closeout reports. The election-window and candidate gates live in SQL.
  neCheck(
    ["Active", "Terminated"].includes(native.status) &&
      nativeScope(native, receiver, district) &&
      nePersonMatches(receiver.candidateAliases, native.candidateName),
    "native_receiving_person_scope",
  );
  const possible = registrations.filter(
    (row) =>
      ["Active", "Terminated"].includes(row.status) &&
      nativeScope(row, receiver, district) &&
      nePersonMatches(receiver.candidateAliases, row.candidateName),
  );
  neCheck(
    possible.length === 1 && possible[0]!.receivingId === receiver.receivingId,
    "ambiguous_native_receiving_registration",
  );
  // The native ID/person/scope is authoritative. Do not rewrite a legacy link
  // merely because its older committee name differs from today's native name.
  return {
    receivingId: native.receivingId,
    candidateName: native.candidateName,
    committeeName: native.committeeName,
    officeName: receiver.officeName,
    district,
    electionYear: receiver.electionYear,
  };
}

export function neAllocationOffice(
  value: string,
): { officeName: string; district: string | null } | null {
  const parts = neKey(value).split(/\s+-\s+/);
  if (parts[0] !== "NEBRASKA" || parts.length < 2) return null;
  const officeName = neOfficeName(parts[1]!);
  if (!officeName) return null;
  if (officeName !== "State Senator")
    return parts.length === 2 ? { officeName, district: null } : null;
  const match = /^(?:DISTRICT )?([1-9]\d?)$/.exec(parts[2] ?? "");
  return parts.length === 3 && match && Number(match[1]) <= 49
    ? { officeName, district: String(Number(match[1])) }
    : null;
}

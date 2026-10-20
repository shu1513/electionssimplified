import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import {
  hasMiddleNameConflict,
  personNamesMatchWithMiddleEvidence,
  personNameParseVariants,
} from "../finance/personNameMiddleEvidence.js";
import {
  nmCheck,
  nmEmptyDistrictId,
  nmId,
  nmKey,
  nmObject,
  nmString,
  type NmNativeObject,
} from "./newMexicoReportedNative.js";

export type NewMexicoReportedReceiver = {
  linkId: string;
  candidateId: string;
  electionId: string;
  electionYear: number;
  electionDate: string;
  receivingId: string;
  legacyCommitteeName: string;
  candidateAliases: string[];
  officeScope: string;
  officeName: string;
  linkOfficeName: string;
  district: string | null;
  canonicalDistrictName: string;
  canonicalDistrictType: string;
  activeCandidateOwnerCount: number;
};
export type NewMexicoNativeCandidate = {
  locator: string;
  registrationLocator: string;
  candidateName: string;
  officeName: string;
  districtText: string | null;
  officeId: number;
  districtId: number | null;
  electionId: number;
  electionYear: number;
};
const OFFICES = new Map([
  ["GOVERNOR", "Governor"],
  ["LIEUTENANT GOVERNOR", "Lieutenant Governor"],
  ["SECRETARY OF STATE", "Secretary of State"],
  ["STATE AUDITOR", "State Auditor"],
  ["STATE TREASURER", "State Treasurer"],
  ["ATTORNEY GENERAL", "Attorney General"],
  ["COMMISSIONER OF PUBLIC LANDS", "Land Commissioner"],
  ["STATE SENATOR", "State Senator"],
  ["STATE REPRESENTATIVE", "State Lower Chamber Legislator"],
]);
export const nmOfficeName = (value: string): string | null =>
  OFFICES.get(nmKey(value)) ?? null;
const normalizePerson = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(?:JR|SR|II|III|IV)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const firstEquivalent = (candidate: string, source: string): boolean =>
  candidate === source || firstNameVariants(candidate).includes(source);
export function nmPersonMatches(
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
          firstNamesEquivalent: firstEquivalent,
        }),
    ) &&
    names.some((candidateName) =>
      personNamesMatchWithMiddleEvidence({
        candidateName,
        rowNames: [sourceName],
        normalizePersonName: normalizePerson,
        firstNamesEquivalent: firstEquivalent,
      }),
    )
  );
}
/** An ambiguity veto, never an admission rule. A conflicting middle/suffix or
 * partial name must not be silently reinterpreted as zero spending. */
export function nmPotentialPerson(
  aliases: readonly string[],
  sourceName: string,
): boolean {
  const source = personNameParseVariants(sourceName, normalizePerson),
    one = normalizePerson(sourceName).split(" ").filter(Boolean);
  return aliases.some((alias) => {
    const names = personNameParseVariants(alias, normalizePerson);
    return (
      names.some((a) =>
        source.some(
          (b) => firstEquivalent(a.first, b.first) && a.last === b.last,
        ),
      ) ||
      (one.length === 1 &&
        names.some(
          (a) => firstEquivalent(a.first, one[0]!) || a.last === one[0],
        ))
    );
  });
}
export function parseNewMexicoNativeCandidate(
  value: unknown,
  year: number,
): NewMexicoNativeCandidate {
  const row = nmObject(value),
    officeName = nmString(row.OfficeName),
    districtId = nmEmptyDistrictId(row.DistrictId);
  nmCheck(row.ElectionYear === year, "registry_election_year");
  nmCheck(
    row.District === null || typeof row.District === "string",
    "native_district_text",
  );
  return {
    locator: nmString(row.IDNumber, "native_candidate_locator"),
    registrationLocator: nmString(
      row.RegistrationId,
      "native_registration_locator",
    ),
    candidateName: nmString(row.CandidateName),
    officeName,
    districtText: row.District as string | null,
    officeId: nmId(row.OfficeId),
    districtId,
    electionId: nmId(row.ElectionId),
    electionYear: year,
  };
}
export function nmNativeDistrict(
  candidate: NewMexicoNativeCandidate,
): string | null {
  const office = nmOfficeName(candidate.officeName),
    text = candidate.districtText?.trim() ?? "";
  nmCheck(office, "unsupported_native_office");
  if (!["State Senator", "State Lower Chamber Legislator"].includes(office)) {
    nmCheck(
      candidate.districtId === null &&
        (!text || /^(?:0|N\/A|STATEWIDE)$/i.test(text)),
      "native_statewide_district",
    );
    return null;
  }
  const match = /^(?:DISTRICT\s+)?([1-9]\d{0,2})$/i.exec(text);
  nmCheck(
    match &&
      Number(match[1]) <= (office === "State Senator" ? 42 : 70) &&
      candidate.districtId !== null,
    "native_legislative_district",
  );
  return String(Number(match[1]));
}
export function nmCanonicalDistrict(
  receiver: NewMexicoReportedReceiver,
): string | null {
  if (receiver.officeScope === "statewide") {
    nmCheck(
      receiver.canonicalDistrictType === "statewide" &&
        receiver.canonicalDistrictName === "New Mexico" &&
        !receiver.district &&
        !["State Senator", "State Lower Chamber Legislator"].includes(
          receiver.officeName,
        ),
      "canonical_statewide_scope",
    );
    return null;
  }
  const upper = receiver.officeScope === "state_upper";
  nmCheck(
    (upper || receiver.officeScope === "state_lower") &&
      receiver.canonicalDistrictType === receiver.officeScope &&
      receiver.officeName ===
        (upper ? "State Senator" : "State Lower Chamber Legislator"),
    "canonical_legislative_scope",
  );
  const match = (
    upper
      ? /^State Senate District ([1-9]\d?)(?: \((?:19|20)\d{2}\))?; New Mexico$/
      : /^State House District ([1-9]\d?)(?: \((?:19|20)\d{2}\))?; New Mexico$/
  ).exec(receiver.canonicalDistrictName);
  nmCheck(
    match &&
      /^[1-9]\d?$/.test(receiver.district ?? "") &&
      Number(receiver.district) === Number(match[1]) &&
      Number(match[1]) <= (upper ? 42 : 70),
    "canonical_district_scope",
  );
  return String(Number(match[1]));
}
export function qualifyNewMexicoReportedReceiver(
  receiver: NewMexicoReportedReceiver,
  registrations: readonly NewMexicoNativeCandidate[],
): NewMexicoNativeCandidate {
  nmCheck(
    receiver.activeCandidateOwnerCount === 1 &&
      /^[1-9]\d*$/.test(receiver.receivingId),
    "exclusive_legacy_receiving_context",
  );
  nmCheck(
    receiver.linkOfficeName === receiver.officeName &&
      receiver.electionDate.slice(0, 4) === String(receiver.electionYear),
    "canonical_election_scope",
  );
  const district = nmCanonicalDistrict(receiver),
    matches = registrations.filter(
      (row) =>
        row.electionYear === receiver.electionYear &&
        nmOfficeName(row.officeName) === receiver.officeName &&
        nmPersonMatches(receiver.candidateAliases, row.candidateName) &&
        nmNativeDistrict(row) === district,
    );
  nmCheck(matches.length === 1, "ambiguous_native_receiving_person_scope");
  return matches[0]!;
}
/** Opaque native locators and legacy OrgIDs have different namespaces. This
 * confirms the actual public person/office/year without rewriting either. */
export function qualifyNewMexicoReceiverDetail(
  receiver: NewMexicoReportedReceiver,
  registration: NewMexicoNativeCandidate,
  value: NmNativeObject,
): void {
  nmCheck(
    value.ElectionYear === receiver.electionYear &&
      nmOfficeName(nmString(value.OfficeName)) === receiver.officeName &&
      nmPersonMatches(
        [...receiver.candidateAliases, registration.candidateName],
        nmString(value.CandidateName),
      ),
    "native_receiving_detail_conflict",
  );
  if (value.OfficeId !== null && value.OfficeId !== 0)
    nmCheck(
      value.OfficeId === registration.officeId,
      "native_detail_office_id_conflict",
    );
  if (value.DistrictId !== null && value.DistrictId !== 0)
    nmCheck(
      value.DistrictId === registration.districtId,
      "native_detail_district_id_conflict",
    );
  if (typeof value.District === "string" && value.District.trim()) {
    const expected = nmCanonicalDistrict(receiver),
      text = value.District.trim();
    nmCheck(
      expected === null
        ? /^(?:0|N\/A|STATEWIDE)$/i.test(text)
        : /^(?:DISTRICT\s+)?([1-9]\d{0,2})$/i.exec(text)?.[1] === expected,
      "native_detail_district_text_conflict",
    );
  }
  nmString(value.MemberID, "native_receiving_member_locator");
}

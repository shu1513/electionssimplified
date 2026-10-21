import { akCheck, akPersonMatches } from "./alaskaReportedNative.js";

export type AlaskaReportedReceiver = {
  linkId: string;
  candidateId: string;
  electionId: string;
  electionYear: number;
  electionDate: string;
  firstName: string;
  lastName: string;
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
export type AlaskaHouseNominee = {
  name: string;
  district: string;
  year: number;
};
export type AlaskaCandidateRegistration = {
  href: string;
  name: string;
  firstName: string;
  lastName: string;
  year: number;
  office: string;
};
export type AlaskaReportedReceivingContext = {
  receivingId: string;
  candidateName: string;
  committeeName: string;
  officeName: string;
  district: string;
  electionYear: number;
  registrationHref: string | null;
};
export function akCanonicalHouseDistrict(
  receiver: AlaskaReportedReceiver,
): string {
  akCheck(
    receiver.officeScope === "state_lower" &&
      receiver.officeName === "State Lower Chamber Legislator" &&
      receiver.canonicalDistrictType === "state_lower",
    "unsupported_native_office_scope",
  );
  const match =
    /^State House District ([1-9]\d?)(?: \((?:19|20)\d{2}\))?; Alaska$/.exec(
      receiver.canonicalDistrictName,
    );
  akCheck(match && Number(match[1]) <= 40, "canonical_house_district");
  const district = String(Number(match[1]));
  if (receiver.district) {
    const legacy = /^\d+$/.test(receiver.district)
      ? String(Number(receiver.district))
      : /^State House District ([1-9]\d?)(?: \((?:19|20)\d{2}\))?; Alaska$/.exec(
          receiver.district,
        )?.[1];
    akCheck(
      legacy && String(Number(legacy)) === district,
      "legacy_district_conflict",
    );
  }
  return district;
}
export function qualifyAlaskaReportedReceiver(
  receiver: AlaskaReportedReceiver,
  nominees: readonly AlaskaHouseNominee[],
  registrations: readonly AlaskaCandidateRegistration[] | null,
): AlaskaReportedReceivingContext {
  akCheck(
    receiver.receivingId.trim() &&
      receiver.activeCandidateOwnerCount === 1 &&
      receiver.firstName.trim() &&
      receiver.lastName.trim(),
    "exclusive_receiving_identity",
  );
  akCheck(
    receiver.linkOfficeName === receiver.officeName &&
      receiver.electionDate.slice(0, 4) === String(receiver.electionYear),
    "canonical_election_scope",
  );
  const district = akCanonicalHouseDistrict(receiver),
    matches = nominees.filter(
      (row) =>
        row.year === receiver.electionYear &&
        akPersonMatches(receiver.candidateAliases, row.name, [
          receiver.firstName,
        ]),
    );
  akCheck(
    matches.length === 1 && matches[0]!.district === district,
    "official_nominee_person_and_seat",
  );
  akCheck(
    akPersonMatches(receiver.candidateAliases, receiver.legacyCommitteeName, [
      receiver.firstName,
    ]),
    "legacy_receiving_name_conflict",
  );
  let registration: AlaskaCandidateRegistration | null = null;
  if (registrations) {
    const candidates = registrations.filter(
      (row) =>
        row.year === receiver.electionYear &&
        akPersonMatches(
          receiver.candidateAliases,
          `${row.firstName} ${row.lastName}`,
          [receiver.firstName],
        ),
    );
    akCheck(
      candidates.length === 1 && candidates[0]!.office === "House",
      "native_receiving_registration",
    );
    registration = candidates[0]!;
  }
  return {
    receivingId: receiver.receivingId,
    candidateName: registration
      ? `${registration.firstName} ${registration.lastName}`
      : matches[0]!.name,
    committeeName: registration?.name ?? receiver.legacyCommitteeName,
    officeName: receiver.officeName,
    district,
    electionYear: receiver.electionYear,
    registrationHref: registration?.href ?? null,
  };
}

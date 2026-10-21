import { vaCheck, vaPersonMatches } from "./virginiaReportedNative.js";

export type VirginiaReportedReceiver = {
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
export type VirginiaReportedReceivingContext = {
  receivingId: string;
  candidateName: string;
  committeeName: string;
  officeName: string;
  district: string;
  electionYear: number;
};
export function vaCanonicalHouseDistrict(r: VirginiaReportedReceiver): string {
  vaCheck(
    r.officeScope === "state_lower" &&
      r.officeName === "State Lower Chamber Legislator" &&
      r.linkOfficeName === r.officeName &&
      r.canonicalDistrictType === "state_lower",
    "unsupported_native_office_scope",
  );
  const m =
    /^State House District ((?:[1-9]\d?|100))(?: \((?:19|20)\d{2}\))?; Virginia$/.exec(
      r.canonicalDistrictName,
    );
  vaCheck(m && Number(m[1]) <= 100, "canonical_house_district");
  const district = String(Number(m[1]));
  if (r.district)
    vaCheck(
      String(Number(r.district)) === district ||
        r.district === r.canonicalDistrictName,
      "legacy_district_conflict",
    );
  vaCheck(
    r.activeCandidateOwnerCount === 1 &&
      r.electionDate.slice(0, 4) === String(r.electionYear),
    "canonical_election_scope",
  );
  return district;
}

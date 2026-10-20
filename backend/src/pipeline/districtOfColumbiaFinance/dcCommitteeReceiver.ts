import type { Pool, PoolClient } from "pg";
import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import {
  hasMiddleNameConflict,
  personNamesMatchWithMiddleEvidence,
} from "../finance/personNameMiddleEvidence.js";
import { DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./districtOfColumbiaFinanceEligibleOffices.js";
import {
  dcCheck,
  dcKey,
  type DcCommitteeRegistration,
} from "./dcCommitteeNative.js";

export type DcCommitteeReceiver = {
  linkId: string;
  candidateId: string;
  electionId: string;
  electionYear: number;
  electionDate: string;
  receivingKey: string;
  legacyCommitteeName: string;
  candidateAliases: string[];
  officeScope: string;
  officeName: string;
  linkOfficeName: string;
  district: string | null;
  ballotTitle: string;
  canonicalDistrictName: string;
  canonicalDistrictType: string;
  activeCandidateOwnerCount: number;
};
export type DcCommitteeReceiving = {
  committeeId: string;
  committeeKey: string;
  candidateKey: string;
  committeeName: string;
  candidateName: string;
  electionYear: number;
  office: string;
  seat: string | null;
};
function normalizePerson(v: string): string {
  return v
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(?:JR|SR|II|III|IV)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function dcPersonMatches(
  aliases: readonly string[],
  source: string,
): boolean {
  const names = aliases.filter((n) => n.trim()),
    firstNamesEquivalent = (a: string, b: string) =>
      a === b || firstNameVariants(a).includes(b);
  return (
    names.length > 0 &&
    !!source.trim() &&
    names.every(
      (candidateName) =>
        !hasMiddleNameConflict({
          candidateName,
          rowNames: [source],
          normalizePersonName: normalizePerson,
          firstNamesEquivalent,
        }),
    ) &&
    names.some((candidateName) =>
      personNamesMatchWithMiddleEvidence({
        candidateName,
        rowNames: [source],
        normalizePersonName: normalizePerson,
        firstNamesEquivalent,
      }),
    )
  );
}
export function dcNativeOffice(
  label: string,
): { office: string; seat: string | null } | null {
  const s = dcKey(label);
  if (s === "MAYOR") return { office: "Mayor", seat: null };
  if (s === "ATTORNEY GENERAL")
    return { office: "Attorney General", seat: null };
  if (/^COUNCIL (?:CHAIRPERSON|CHAIRMAN)$/.test(s))
    return { office: "City Council Member", seat: "CHAIR" };
  if (s === "COUNCIL AT-LARGE")
    return { office: "City Council Member", seat: "AT-LARGE" };
  const ward = /^COUNCIL WARD ([1-8])$/.exec(s);
  return ward
    ? { office: "City Council Member", seat: `WARD ${ward[1]}` }
    : null;
}
export function dcCanonicalSeat(r: DcCommitteeReceiver): string | null {
  dcCheck(
    r.linkOfficeName === r.officeName &&
      r.electionDate.slice(0, 4) === String(r.electionYear),
    "canonical_election_context",
  );
  if (r.officeScope === "statewide") {
    dcCheck(
      r.officeName === "Attorney General" &&
        r.canonicalDistrictType === "statewide" &&
        r.canonicalDistrictName === "District of Columbia" &&
        r.district === null &&
        /attorney general/i.test(r.ballotTitle),
      "canonical_statewide_scope",
    );
    return null;
  }
  if (r.officeScope === "state_upper") {
    const ward =
      /^Ward ([1-8])(?: \((?:19|20)\d{2}\))?; District of Columbia$/.exec(
        r.canonicalDistrictName,
      );
    dcCheck(
      r.officeName === "City Council Member" &&
        r.canonicalDistrictType === "state_upper" &&
        ward &&
        dcKey(r.district ?? "") === `WARD ${ward[1]}` &&
        new RegExp(`\\bWard\\s+${ward[1]}\\b`, "i").test(r.ballotTitle),
      "canonical_ward_scope",
    );
    return `WARD ${ward[1]}`;
  }
  dcCheck(
    r.officeScope === "place" &&
      r.canonicalDistrictType === "place" &&
      r.canonicalDistrictName === "Washington city, District of Columbia",
    "canonical_city_scope",
  );
  if (r.officeName === "Mayor") {
    dcCheck(
      r.district === null && /\bmayor\b/i.test(r.ballotTitle),
      "canonical_mayor_scope",
    );
    return null;
  }
  dcCheck(r.officeName === "City Council Member", "canonical_council_scope");
  if (/\b(?:chair|chairman|chairperson)\b/i.test(r.ballotTitle)) {
    dcCheck(
      /^(?:(?:council )?(?:chair|chairman|chairperson)(?: of the council)?)$/i.test(
        r.district ?? "",
      ),
      "canonical_chair_scope",
    );
    return "CHAIR";
  }
  dcCheck(
    /\bat[- ]large\b/i.test(r.ballotTitle) &&
      dcKey(r.district ?? "") === "AT-LARGE",
    "canonical_at_large_scope",
  );
  return "AT-LARGE";
}
export function qualifyDcCommitteeReceiver(
  r: DcCommitteeReceiver,
  registrations: readonly DcCommitteeRegistration[],
): DcCommitteeReceiving {
  dcCheck(
    r.activeCandidateOwnerCount === 1 &&
      dcKey(r.receivingKey) === dcKey(r.legacyCommitteeName) &&
      !/^DC FAIR ELECTIONS \d+$/.test(r.receivingKey),
    "exclusive_traditional_receiving_identity",
  );
  const seat = dcCanonicalSeat(r),
    scope = (n: DcCommitteeRegistration) => {
      const o = dcNativeOffice(n.office);
      return (
        n.electionYear === r.electionYear &&
        ["Primary Election", "General Election"].includes(n.electionLabel) &&
        n.candidateApproved &&
        n.committeeApproved &&
        o?.office === r.officeName &&
        o.seat === seat
      );
    };
  const matches = registrations.filter(
    (n) =>
      n.electionYear === r.electionYear &&
      dcKey(n.committeeName) === dcKey(r.legacyCommitteeName),
  );
  dcCheck(matches.length === 1, "native_receiving_registration");
  const n = matches[0]!;
  dcCheck(
    scope(n) &&
      n.committeeKey &&
      n.candidateKey &&
      dcPersonMatches(r.candidateAliases, n.candidateName),
    "native_receiving_person_scope",
  );
  const possible = registrations.filter(
    (n) => scope(n) && dcPersonMatches(r.candidateAliases, n.candidateName),
  );
  dcCheck(
    possible.length === 1 && possible[0]!.committeeId === n.committeeId,
    "ambiguous_native_receiver",
  );
  return {
    committeeId: n.committeeId,
    committeeKey: n.committeeKey,
    candidateKey: n.candidateKey,
    committeeName: n.committeeName,
    candidateName: n.candidateName,
    electionYear: r.electionYear,
    office: r.officeName,
    seat,
  };
}
export const DC_COMMITTEE_SELECT = `l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
 l.election_year "electionYear",e.election_date::text "electionDate",l.committee_key "receivingKey",l.committee_name "legacyCommitteeName",
 array_remove(ARRAY[trim(c.first_name||' '||c.last_name),c.display_name,l.candidate_name_normalized],NULL) "candidateAliases",
 o.scope "officeScope",o.canonical_name "officeName",l.office_name "linkOfficeName",l.district,e.official_ballot_title "ballotTitle",
 d.name "canonicalDistrictName",d.district_type "canonicalDistrictType",
 (SELECT count(DISTINCT owner.candidate_id)::int FROM public.dc_candidate_finance_links owner WHERE owner.link_status='active'
 AND (owner.committee_key=l.committee_key OR upper(regexp_replace(trim(owner.committee_name),'\\s+',' ','g'))=upper(regexp_replace(trim(l.committee_name),'\\s+',' ','g')))) "activeCandidateOwnerCount"`;
export const DC_COMMITTEE_FROM = `FROM public.dc_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
 JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
 JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id`;
export const DC_COMMITTEE_WHERE = `l.link_status='active' AND c.deleted_at IS NULL AND ce.status<>'withdrawn'
 AND d.state='DC' AND e.race_type='office' AND e.election_stage='general' AND l.committee_key NOT LIKE 'DC FAIR ELECTIONS %'
 AND l.election_year=extract(year from e.election_date)::int AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])
 AND NOT EXISTS(SELECT 1 FROM public.dc_candidate_finance_links sibling WHERE sibling.link_status='active' AND sibling.id<>l.id AND sibling.candidate_id=l.candidate_id AND sibling.election_id=l.election_id)`;
export const DC_COMMITTEE_OFFICES = [
  ...DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS,
];
export async function loadDcCommitteeReceiver(
  db: Pick<Pool | PoolClient, "query">,
  linkId: string,
  lock = false,
): Promise<DcCommitteeReceiver | null> {
  const result = await db.query<DcCommitteeReceiver>(
    `SELECT ${DC_COMMITTEE_SELECT} ${DC_COMMITTEE_FROM} WHERE ${DC_COMMITTEE_WHERE} AND l.id=$2::uuid ${lock ? "FOR UPDATE OF l,c,ce,e,d,o" : ""}`,
    [DC_COMMITTEE_OFFICES, linkId],
  );
  if (result.rows.length !== 1) return null;
  const r = result.rows[0]!;
  if (lock) {
    const owners = await db.query<{
      candidate_id: string;
      link_status: string;
    }>(
      `SELECT candidate_id::text,link_status FROM public.dc_candidate_finance_links WHERE committee_key=$1 OR upper(regexp_replace(trim(committee_name),'\\s+',' ','g'))=$2 OR(candidate_id=$3::uuid AND election_id=$4::uuid) ORDER BY id FOR UPDATE`,
      [
        r.receivingKey,
        dcKey(r.legacyCommitteeName),
        r.candidateId,
        r.electionId,
      ],
    );
    if (
      new Set(
        owners.rows
          .filter((x) => x.link_status === "active")
          .map((x) => x.candidate_id),
      ).size !== 1
    )
      return null;
  }
  return r;
}

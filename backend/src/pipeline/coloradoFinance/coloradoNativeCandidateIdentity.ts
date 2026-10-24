import { createRequire } from "node:module";
import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import {
  ColoradoReportError,
  coloradoReportDate,
  coloradoReportedNameKey,
} from "./coloradoTracerReports.js";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    source: string,
    options: { virtualConsole: unknown },
  ) => { window: { document: Document } };
  VirtualConsole: new () => unknown;
};
export const COLORADO_IE_STATEWIDE_OFFICES = [
  "Governor",
  "Attorney General",
  "Secretary of State",
  "State Treasurer",
] as const;
export const COLORADO_IE_LEGISLATIVE_OFFICES = [
  "State Lower Chamber Legislator",
  "State Senator",
] as const;
export function coloradoIeNativeOffice(officeName: string): string {
  if (officeName === "State Lower Chamber Legislator") return "COLORADO HOUSE";
  if (officeName === "State Senator") return "COLORADO SENATE";
  return officeName;
}
/** Canonical seat and native district are independently named authorities. */
export function coloradoIeNativeDistrict(expected: {
  officeName: string;
  districtName?: string;
}): string | null {
  if (
    !(COLORADO_IE_LEGISLATIVE_OFFICES as readonly string[]).includes(
      expected.officeName,
    )
  )
    return null;
  const match =
    /^State (House|Senate) District ([1-9][0-9]*)(?: \((?:19|20)[0-9]{2}\))?; Colorado$/u.exec(
      expected.districtName ?? "",
    );
  const chamber = expected.officeName === "State Senator" ? "Senate" : "House";
  if (!match || match[1] !== chamber)
    throw new ColoradoReportError("unqualified_ie_legislative_district");
  return `${chamber} District ${Number(match[2])}`;
}
export type ColoradoIeCandidateIdentity = {
  candidateName: string;
  party: string;
  officeName: string;
  electionYear: number;
  electionDate: string;
  receivingId: string;
  receivingName: string;
  tracerCandidateId: string | null;
  districtName?: string;
};
export type ColoradoNativeCandidateProof = {
  candidateName: string;
  party: string;
  officeName: string;
  candidateId: string;
  receivingId: string;
  cycleYear: number;
  cycleStart: string;
  cycleEnd: string;
  nativeOfficeName?: string;
  districtName?: string;
  peerCandidateCount?: number;
  peerCampaignCount?: number;
};
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ColoradoReportError(code);
}
export function coloradoPartyKey(value: string): string | null {
  const key = coloradoReportedNameKey(value);
  if (["", "UNKNOWN", "UNSPECIFIED", "N/A", "NOT PROVIDED"].includes(key))
    return null;
  if (["DEMOCRATIC", "DEMOCRAT", "DEMOCRATIC PARTY", "DEM"].includes(key))
    return "DEM";
  if (["REPUBLICAN", "REPUBLICAN PARTY", "REP"].includes(key)) return "REP";
  if (["UNAFFILIATED", "INDEPENDENT"].includes(key)) return "UNA";
  return key;
}
function person(value: string): string {
  const parts = value.split(",");
  const full =
    parts.length > 1 ? `${parts.slice(1).join(" ")} ${parts[0]}` : value;
  return coloradoReportedNameKey(full)
    .replace(/[^A-Z0-9]+/gu, " ")
    .replace(/\b(?:JR|SR|II|III|IV)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
export function coloradoIePersonMatches(
  canonicalName: string,
  reportedName: string,
): boolean {
  return personNamesMatchWithMiddleEvidence({
    candidateName: canonicalName,
    rowNames: [reportedName],
    normalizePersonName: person,
    firstNamesEquivalent: (a, b) => a === b || firstNameVariants(a).includes(b),
  });
}
/** A current native campaign row supplies the financial cycle. Calendar-year
 * labels and the existing contribution loader's two-year window are not bounds. */
export function qualifyColoradoNativeCandidateProfile(
  bytes: Uint8Array,
  expected: ColoradoIeCandidateIdentity,
): ColoradoNativeCandidateProof {
  check(
    bytes.length > 0 && bytes.length <= 32 * 1024 * 1024,
    "native_profile_byte_limit",
  );
  check(
    (
      [
        ...COLORADO_IE_STATEWIDE_OFFICES,
        ...COLORADO_IE_LEGISLATIVE_OFFICES,
      ] as readonly string[]
    ).includes(expected.officeName),
    "unqualified_ie_office_scope",
  );
  const nativeOffice = coloradoIeNativeOffice(expected.officeName),
    nativeDistrict = coloradoIeNativeDistrict(expected);
  check(
    /^[1-9]\d{0,19}$/u.test(expected.receivingId) &&
      Number.isSafeInteger(expected.electionYear) &&
      expected.electionYear >= 2022 &&
      expected.electionYear <= 2100,
    "native_profile_expected_scope",
  );
  const electionDate = coloradoReportDate(expected.electionDate);
  check(
    Number(electionDate.slice(0, 4)) === expected.electionYear,
    "native_profile_expected_scope",
  );
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ColoradoReportError("invalid_native_profile_utf8");
  }
  check(!/[\u0000\uFFFD]/u.test(html), "invalid_native_profile_characters");
  const doc = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window
    .document;
  const field = (suffix: string) => {
    const element = doc.getElementById(`_ctl0_Content_${suffix}`);
    check(element, "missing_native_candidate_control");
    return (element.textContent ?? "").replace(/\s+/gu, " ").trim();
  };
  const name = field("lblCandName"),
    candidateId = field("lblCandidateID"),
    receivingId = field("lblCommitteeID");
  check(
    /^[1-9]\d{0,19}$/u.test(candidateId) &&
      receivingId === expected.receivingId &&
      (!expected.tracerCandidateId ||
        candidateId === expected.tracerCandidateId),
    "native_candidate_identifier_conflict",
  );
  check(
    coloradoReportedNameKey(field("lblCommName")) ===
      coloradoReportedNameKey(expected.receivingName) &&
      field("lblCommitteeType") === "Candidate Committee",
    "native_receiving_identity_conflict",
  );
  check(
    coloradoIePersonMatches(expected.candidateName, name),
    "native_candidate_person_conflict",
  );
  const party = coloradoPartyKey(field("lblCandParty")),
    expectedParty = coloradoPartyKey(expected.party);
  check(party && party === expectedParty, "native_candidate_party_conflict");
  check(
    coloradoReportedNameKey(field("lblCandOffice")) ===
      coloradoReportedNameKey(nativeOffice) &&
      coloradoReportedNameKey(field("lblCandJurisdiction")) === "STATEWIDE",
    "native_candidate_office_conflict",
  );
  check(
    coloradoReportedNameKey(field("lblCandStatus")) === "ACTIVE" &&
      coloradoReportedNameKey(field("lblCommStatus")) === "ACTIVE",
    "inactive_native_candidate",
  );
  const table = doc.getElementById("_ctl0_Content_dgdCampaigns");
  check(table?.tagName === "TABLE", "missing_native_campaign_inventory");
  const rows = [...table.querySelectorAll("tr")]
    .filter((r) => !r.querySelector("th"))
    .map((r) =>
      [...r.children].map((c) =>
        (c.textContent ?? "").replace(/\s+/gu, " ").trim(),
      ),
    );
  check(
    rows.length > 0 && rows.every((r) => r.length === 7),
    "native_campaign_inventory_shape",
  );
  const matches = rows.filter(
    (r) =>
      /^\d{4}\b/u.test(r[1]!) &&
      Number(r[1]!.slice(0, 4)) === expected.electionYear,
  );
  check(matches.length === 1, "ambiguous_native_campaign_cycle");
  const row = matches[0]!;
  check(
    coloradoIePersonMatches(expected.candidateName, row[0]!) &&
      coloradoIePersonMatches(name, row[0]!) &&
      coloradoPartyKey(row[2]!) === party &&
      coloradoReportedNameKey(row[3]!) === "STATEWIDE" &&
      coloradoReportedNameKey(row[4]!) ===
        coloradoReportedNameKey(nativeOffice) &&
      (!nativeDistrict ||
        coloradoReportedNameKey(row[5]!) ===
          coloradoReportedNameKey(nativeDistrict)) &&
      coloradoReportedNameKey(row[6]!) === "ACTIVE",
    "native_campaign_identity_conflict",
  );
  const dates = row[1]!.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/gu);
  check(dates?.length === 2, "native_financial_cycle_bounds");
  const cycleStart = coloradoReportDate(dates[0]!),
    cycleEnd = coloradoReportDate(dates[1]!);
  check(
    cycleStart >= `${expected.electionYear - 4}-01-01` &&
      cycleStart <= electionDate &&
      cycleEnd >= electionDate &&
      Number(cycleEnd.slice(0, 4)) === expected.electionYear,
    "native_financial_cycle_bounds",
  );
  return {
    candidateName: name,
    party,
    officeName: expected.officeName,
    candidateId,
    receivingId,
    cycleYear: expected.electionYear,
    cycleStart,
    cycleEnd,
    ...(nativeDistrict
      ? { nativeOfficeName: nativeOffice, districtName: nativeDistrict }
      : {}),
  };
}

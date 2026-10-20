import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import { hiHold, hiLiteral, hiRequired } from "./hawaiiReportedCore.js";
import { normalizeHawaiiCscDistrict, toHawaiiCscOfficeSearchInput } from "./hawaiiFinanceEligibleOffices.js";

export type HawaiiOfficialCandidate = { contest: string; legalName: string; ballotName: string; status: string };
export type HawaiiReportedSeat = { officeScope: string; canonicalOffice: string; canonicalDistrict: string | null };
export function hiDirectLinkSeatMatches(seat: HawaiiReportedSeat & { linkOffice: string | null; linkDistrict: string | null }): boolean {
  const native = toHawaiiCscOfficeSearchInput({ officeScope: seat.officeScope, officeCanonicalName: seat.canonicalOffice, district: seat.canonicalDistrict });
  return !!native && [seat.canonicalOffice, native.cscOffice].includes(seat.linkOffice ?? "")
    && (seat.officeScope === "statewide" ? !seat.linkDistrict : normalizeHawaiiCscDistrict(seat.linkDistrict) === seat.canonicalDistrict);
}

/** Generation-preserving key: "Doe, John Jr." and "Doe, John Sr." stay two people. */
export const hiPersonIdentityKey = (value: string): string => value.normalize("NFKD").replace(/\p{M}/gu, "")
  .toUpperCase().replace(/['\u2018\u2019\u02bb`]/g, "").replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
export const hiPersonKey = (value: string): string =>
  hiPersonIdentityKey(value).replace(/\b(JR|SR|II|III|IV)\b/g, " ").replace(/\s+/g, " ").trim();
export function hiPersonMatches(name: string, aliases: readonly string[]): boolean {
  const suffixes = (s: string) => [...s.toUpperCase().matchAll(/\b(?:JR|SR|II|III|IV)\b/g)].map(m => m[0]);
  const named = suffixes(name), official = new Set(aliases.flatMap(suffixes));
  // An explicit source generation must be corroborated; a shortened ballot
  // alias cannot invent a generation missing from every legal/ballot name.
  if (named.length && named.some(s => !official.has(s))) return false;
  return personNamesMatchWithMiddleEvidence({ candidateName: name, rowNames: [...aliases], normalizePersonName: hiPersonKey });
}

export function hiOfficialContest(seat: HawaiiReportedSeat): string {
  if (seat.officeScope === "statewide" && seat.canonicalDistrict === null) {
    if (seat.canonicalOffice === "Governor") return "GOVERNOR";
    if (seat.canonicalOffice === "Lieutenant Governor") return "LIEUTENANT GOVERNOR";
  }
  if (!/^[1-9]\d?$/.test(seat.canonicalDistrict ?? "")) hiHold("canonical_seat");
  if (seat.officeScope === "state_upper" && seat.canonicalOffice === "State Senator") return `STATE SENATOR, DIST ${seat.canonicalDistrict}`;
  if (seat.officeScope === "state_lower" && seat.canonicalOffice === "State Lower Chamber Legislator") return `STATE REPRESENTATIVE, DIST ${seat.canonicalDistrict}`;
  return hiHold("canonical_seat");
}

export function qualifyHawaiiOfficialReceiver(input: {
  candidateName: string; fullName: string; seat: HawaiiReportedSeat; roster: readonly HawaiiOfficialCandidate[];
}): HawaiiOfficialCandidate {
  const contest = hiOfficialContest(input.seat);
  const matches = input.roster.filter(r => r.status === "In General" && r.contest === contest
    && [input.candidateName, input.fullName].every(n => hiPersonMatches(n, [r.legalName, r.ballotName])));
  if (matches.length !== 1) hiHold("official_receiving_seat");
  return matches[0]!;
}

/** Strict RFC-style CSV; incomplete quotes, mixed widths and duplicate headers
 * are not a partially useful official roster. No identity is persisted here. */
export function hiCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === '"') { if (cell || closed) hiHold("roster_csv_quote"); quoted = true; }
    else if (c === ",") { row.push(cell); cell = ""; closed = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r") { if (text[i + 1] !== "\n") hiHold("roster_csv_newline"); i++; }
      row.push(cell); rows.push(row); row = []; cell = ""; closed = false;
    } else { if (closed) hiHold("roster_csv_trailing_text"); cell += c; }
  }
  if (quoted) hiHold("roster_csv_truncated");
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  if (!rows.length || !rows[0]!.length || new Set(rows[0]).size !== rows[0]!.length
    || rows.some(r => r.length !== rows[0]!.length)) hiHold("roster_csv_width");
  return rows;
}

export function parseHawaiiOfficialRoster(text: string): HawaiiOfficialCandidate[] {
  const [headers, ...rows] = hiCsv(text);
  const expected = ["Contests", "Party", "BallotName", "LegalName", "MailingAddress", "CityStateZip", "Phone", "Email", "Website", "IssueDate", "FilingDate", "Status"];
  if (JSON.stringify(headers) !== JSON.stringify(expected) || !rows.length) hiHold("roster_schema");
  return rows.map(r => ({ contest: hiRequired(r[0]), ballotName: hiRequired(r[2]), legalName: hiRequired(r[3]), status: hiLiteral(r[11]!) }));
}

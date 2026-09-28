// A county/parish (or city) district row carries every seat attached to it, so
// the ballot lookup returns ward- and district-level races to every resident of
// the jurisdiction — including seats they cannot vote in. The official ballot
// title is stored and rendered verbatim, so the ward IS visible; what is missing
// is any signal that the seat has its own, smaller electorate.
//
// This module extracts that seat designator so the ballot card can SAY SO. It
// deliberately does not filter: the app has no ward/precinct membership for an
// address (the Census geocoder returns voting districts, but no source maps a
// voting district to a justice-of-the-peace ward or a commission district), and
// a badge that claimed to filter would be lying.
//
// It is read-path only. The office matcher's stripSeatSuffixes still collapses
// every seat onto one catalog office — that is by design and is untouched here.

import { isAtLargeBoardSeat } from "./atLargeBoardSeats.js";

// Offices whose numbered seat denotes a DISTINCT ELECTORATE inside the
// jurisdiction. The allowlist is positive on purpose: a denylist would badge
// each newly seeded office by default, and over-badging invents a warning where
// the voter really does vote, which is a worse error than staying silent.
//
// Excluded, all live and all deliberate:
//   - County/Place Level Judge ("Division 2", "Seat 20", "Position No. 3",
//     "Part II") — numbering that distinguishes seats on ONE countywide court.
//     Every county voter votes in them. 176 live rows.
//   - District Attorney / Public Defender / Clerk of Court — "district" belongs
//     to the OFFICE NAME ("Clerk of the District Court", "District Attorney 1st
//     Judicial District Court"), not to a seat. 40 live rows.
//   - Soil and Water Conservation District Supervisor — same, elected
//     countywide.
const SUB_JURISDICTION_SEAT_OFFICES: ReadonlySet<string> = new Set([
  "County Commissioner",
  "County Supervisor",
  "County Coroner",
  "Constable",
  "Justice of the Peace",
  "City Council Member",
  "Town Council Member",
  // Special-district boards stored on the county row. Arizona elects these by
  // district ("Maricopa County Community College District Governing Board
  // Member, District 3"); boards elected at large carry no district number,
  // so they are never badged.
  "Community College Trustee",
  "County Hospital Trustee",
  "Career and Technical Education District Board Member",
]);

// Only GEOGRAPHIC designators. "Seat"/"Position"/"Office"/"Division"/"Part" are
// the at-large numbering convention — Utah county commissions elect seats A/B/C
// countywide and Florida city commissions elect numbered seats at large — so
// badging those would be the very over-warning the allowlist guards against.
// "Zone" is left out for the same reason: Florida's commission zones are
// residency zones that commonly still vote at large.
const GEOGRAPHIC_SEAT_PATTERNS: readonly RegExp[] = [
  // "District 4", "DISTRICT 06", "District No. 5", "Dist II", "District 3A",
  // and the lettered form ("County Commissioner District E", Clark County NV;
  // "County Council District A", MD; "FORSYTH COUNTY ... DISTRICT B", NC). The
  // single-letter alternative sits last so Roman numerals stay Roman, and its
  // \b...\b bounds keep it off "District Attorney" and "District At-Large".
  /\b(?:district|dist)\.?\s+(?:no\.?\s*)?(?:\d+[a-z]?|[ivxl]+|[a-z])\b/gi,
  // "1st District", "22nd District".
  /\b\d+(?:st|nd|rd|th)\s+district\b/gi,
  // Louisiana justice-of-the-peace and constable wards; Carson City NV wards.
  /\bward\s+(?:no\.?\s*)?(?:\d+[a-z]?|[ivxl]+)\b/gi,
  // Arizona constable and Texas commissioner precincts ("Prec. 2").
  /\b(?:precinct|prec)\.?\s+(?:no\.?\s*)?(?:\d+[a-z]?|[ivxl]+)\b/gi,
];

// Known gap, deliberate: NAMED districts stay unbadged (~10 live rows —
// "GATES COUNTY BOARD OF COMMISSIONERS EURE DISTRICT", "SURRY COUNTY ... MOUNT
// AIRY DISTRICT", "Glendale City Council Member, Barrel District"), as do the
// handful of NC titles truncated to a bare trailing "DISTRICT". Capturing a
// name before "District" needs a stopword list to avoid reading the governing
// body as the seat ("COMMISSIONERS DISTRICT"), and mislabeling a seat is worse
// than staying quiet about it. Revisit if the named forms spread.

// An explicit at-large title settles the question against a seat electorate no
// matter what else the title says ("Jackson County Legislator 1st District At
// Large", live — districted residency, countywide vote).
const AT_LARGE_PATTERN = /\bat[-\s]?large\b/i;

function toDisplaySeat(rawMatch: string): string {
  return rawMatch
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .split(" ")
    .map((token) => {
      // Ordinals keep their lowercase suffix ("1st"), other digit-led tokens
      // uppercase a trailing letter ("3a" -> "3A") and leave "06" alone.
      if (/^\d+(?:st|nd|rd|th)$/i.test(token)) {
        return token.toLowerCase();
      }
      if (/^\d/.test(token)) {
        return token.toUpperCase();
      }
      if (/^no\.?$/i.test(token)) {
        return "No.";
      }
      if (/^[ivxl]+$/i.test(token)) {
        return token.toUpperCase();
      }
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * The seat designator to show as "you may not vote in this one", or null when
 * the title carries none, the office is not seat-districted, the title says the
 * seat is at large, or the jurisdiction elects its numbered seats countywide.
 *
 * East Baton Rouge titles a justice-of-the-peace seat by ward AND district
 * ("Justice of the Peace Ward 2, District 3"), so every geographic designator
 * in the title is kept, in title order, rather than only the first.
 *
 * `jurisdiction` is what separates a real sub-electorate from a residency
 * district — pass it wherever the caller knows the state and district row, or
 * the flag will fire on the ~82 NC/FL county-board rows (plus every ID and IN
 * commissioner row) whose district is residency-only. Include electionStage
 * where it is known: one county in the corpus elects the same seat by district
 * in the primary and county-wide in the general. See atLargeBoardSeats.
 */
export function extractSubDistrictSeat(
  officialBallotTitle: string,
  officeCanonicalName: string | null | undefined,
  jurisdiction?: { state?: string | null; districtName?: string | null; electionStage?: string | null }
): string | null {
  if (typeof officeCanonicalName !== "string" || !SUB_JURISDICTION_SEAT_OFFICES.has(officeCanonicalName)) {
    return null;
  }
  if (typeof officialBallotTitle !== "string" || officialBallotTitle.trim().length === 0) {
    return null;
  }
  if (AT_LARGE_PATTERN.test(officialBallotTitle)) {
    return null;
  }

  const seen = new Set<string>();
  const found: { index: number; label: string }[] = [];
  for (const pattern of GEOGRAPHIC_SEAT_PATTERNS) {
    // The patterns are module-level and global, so lastIndex must be reset per
    // call or alternating titles would skip matches.
    pattern.lastIndex = 0;
    let match = pattern.exec(officialBallotTitle);
    while (match !== null) {
      const label = toDisplaySeat(match[0]);
      const dedupeKey = label.toLowerCase();
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        found.push({ index: match.index, label });
      }
      match = pattern.exec(officialBallotTitle);
    }
  }
  if (found.length === 0) {
    return null;
  }
  const ordered = found.sort((left, right) => left.index - right.index);

  if (
    jurisdiction &&
    isAtLargeBoardSeat({
      officeCanonicalName,
      state: jurisdiction.state,
      districtName: jurisdiction.districtName,
      // The first designator is the seat's own number; a split board keys its
      // at-large seats off exactly that.
      seatNumber: /(\d+)/.exec(ordered[0]?.label ?? "")?.[1] ?? null,
      electionStage: jurisdiction.electionStage,
    })
  ) {
    return null;
  }

  return ordered.map((entry) => entry.label).join(", ");
}

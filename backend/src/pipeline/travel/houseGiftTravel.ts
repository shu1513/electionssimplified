import type { Legislator, LegislatorIndex } from "../rollcall/congressLegislators.js";

// Privately sponsored travel by House members, from the Clerk's yearly
// gift-travel index (`<year>Travel.xml` inside
// https://disclosures-clerk.house.gov/public_disc/gift-pdfs/<year>Travel.zip).
// One index row is one destination line of one filing, so a single trip
// repeats across rows (Tel Aviv, Jerusalem, ...) and across amendments.
// This module turns rows into one record per member per trip. It never
// decides who a member is from the printed name alone: the seat (state +
// district on the departure date) picks the legislator and the name only
// confirms it.

export type HouseGiftTravelRow = {
  docId: string;
  filerName: string;
  memberName: string;
  state: string;
  district: string;
  // The filing year, which is also the PDF's directory on the Clerk site.
  year: string;
  destination: string;
  filingType: string;
  // ISO dates, or null when the index left the field blank or unreadable.
  departureDate: string | null;
  returnDate: string | null;
  sponsor: string;
};

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function field(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? decodeXmlText(match[1]!).replace(/\s+/g, " ").trim() : "";
}

/** `8/4/2019` → `2019-08-04`; anything else → null. */
export function parseIndexDate(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseHouseGiftTravelIndex(xml: string): HouseGiftTravelRow[] {
  const rows: HouseGiftTravelRow[] = [];
  for (const match of xml.matchAll(/<Travel>([\s\S]*?)<\/Travel>/g)) {
    const block = match[1]!;
    rows.push({
      docId: field(block, "DocID"),
      filerName: field(block, "FilerName"),
      memberName: field(block, "MemberName"),
      state: field(block, "State").toUpperCase(),
      district: field(block, "District"),
      year: field(block, "Year"),
      destination: field(block, "Destination"),
      filingType: field(block, "FilingType"),
      departureDate: parseIndexDate(field(block, "DepartureDate")),
      returnDate: parseIndexDate(field(block, "ReturnDate")),
      sponsor: field(block, "TravelSponsor"),
    });
  }
  return rows;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** `Weber, Randy` → `weber`. */
export function memberLastName(memberName: string): string {
  return normalizeName(memberName.split(",")[0] ?? "");
}

/**
 * A staff trip lists the staffer as filer and the employing member as member.
 * The member's own trip names the member in both fields.
 */
export function isMemberOwnFiling(row: Pick<HouseGiftTravelRow, "filerName" | "memberName">): boolean {
  const last = memberLastName(row.memberName);
  const first = normalizeName((row.memberName.split(",")[1] ?? "").trim().split(/\s+/)[0] ?? "");
  const filer = normalizeName(row.filerName);
  return last.length > 0 && first.length > 0 && filer.includes(last) && filer.includes(first.slice(0, 3));
}

export type SponsoredTravelSponsor = {
  key: string;
  pattern: RegExp;
  // Completes "paid for by ...". States who the sponsor is in plain words.
  clause: string;
  // Optional second sentence, for a sponsor whose background (who runs it,
  // what it campaigns for) would make the first sentence too long to read.
  followUp?: string;
  // Where the sponsor facts come from. The record itself cites the filing.
  sources: readonly string[];
};

export type SponsoredTravelDestination = {
  key: string;
  label: string;
  pattern: RegExp;
  researchAreaSlug: string;
  stance: "for" | "against";
  // Only sponsors listed here are imported. An unlisted sponsor is reported
  // as `unknown_sponsor` so an operator can add a sourced one-line clause.
  // Two Israel sponsors are left out on purpose: the Atlantic Council / Talpins
  // Foundation delegation of June 2025 (its own press release says the group
  // visited Saudi Arabia, Bahrain and the UAE, not Israel) and Torah Umesorah
  // (the one traveler paid his own flights, so "all-expenses-paid" is false).
  sponsors: readonly SponsoredTravelSponsor[];
};

export const SPONSORED_TRAVEL_DESTINATIONS: Readonly<Record<string, SponsoredTravelDestination>> = {
  israel: {
    key: "israel",
    label: "Israel",
    pattern: /\b(israel|tel aviv|jerusalem)\b/i,
    researchAreaSlug: "us_israel_ties",
    stance: "for",
    sponsors: [
      {
        key: "aief",
        pattern: /american israel edu/i,
        clause:
          "the American Israel Education Foundation, an organization tied to AIPAC, a group that lobbies Congress for U.S. military aid and support for Israel",
        sources: ["https://www.aiefdn.org/", "https://www.legistorm.com/pro_news/4341/august-sets-spending-record-for-congressional-travel.html"],
      },
      {
        key: "jstreet",
        pattern: /j\s*street/i,
        clause:
          "the J Street Education Fund, an organization tied to J Street, a group that lobbies Congress for U.S. support of Israel and a negotiated two-state peace deal",
        sources: ["https://jstreet.org/about-us/"],
      },
      {
        key: "usiea",
        pattern: /u\.?\s*s\.?\s*israel education/i,
        clause: "the U.S. Israel Education Association",
        followUp:
          "The charity was founded by evangelical Christian activist Heather Johnston and takes members of Congress on tours of Israel and Israeli settlements in the West Bank.",
        sources: ["https://www.usieducation.org/tours", "https://www.usieducation.org/leadership"],
      },
      {
        key: "12tribe",
        pattern: /12\s*tribe/i,
        clause: "the 12Tribe Films Foundation",
        followUp:
          "The charity is run by Avi Abelow, a right-wing Israeli media activist who lives in a West Bank settlement and campaigns for Israeli rule over the West Bank.",
        sources: [
          "https://www.thedailybeast.com/who-paid-for-mike-johnsons-trip-to-israel/",
          "https://www.jns.org/author/avi-abelow",
        ],
      },
      {
        key: "israel_allies",
        pattern: /israel allies/i,
        clause: "the Israel Allies Foundation and partner groups, including Christian Zionist organizations",
        followUp:
          "The foundation organizes pro-Israel lawmakers in about 50 parliaments to build political support for Israel.",
        sources: ["https://israelallies.org/", "https://www.jpost.com/opinion/article-874864"],
      },
      {
        key: "jewish_policy_center",
        pattern: /jewish policy center/i,
        clause:
          "the Jewish Policy Center, a think tank tied to the Republican Jewish Coalition that promotes U.S.-Israel security cooperation",
        sources: ["https://en.wikipedia.org/wiki/Jewish_Policy_Center", "https://www.rjchq.org/jpc_is_hiring_director"],
      },
      {
        key: "jcrc_ny",
        pattern: /jewish community relations council of new york/i,
        clause:
          "the Jewish Community Relations Council of New York, a Jewish community group that promotes support for Israel and runs Israel study tours for civic leaders",
        sources: [
          "https://www.jcrcny.org/what-we-do/israel-international-affairs/missions-to-israel/",
          "https://jewishinsider.com/2022/10/ritchie-torres-israel-bronx-jcrc-ny-delegation/",
        ],
      },
      {
        key: "uja_ny",
        pattern: /united jewish appeal/i,
        clause:
          "UJA-Federation of New York, a Jewish charity that funds Jewish causes in New York and Israel and ran solidarity visits to Israel after the October 7 attack",
        sources: [
          "https://www.jta.org/2024/04/09/ny/ritchie-torres-pro-israel-activism-sparks-controversy-in-dc-and-within-his-own-family-in-israel-hes-a-star",
        ],
      },
    ],
  },
};

export type HouseSponsoredTrip = {
  memberName: string;
  state: string;
  district: string;
  departureDate: string;
  returnDate: string | null;
  sponsorAsFiled: string;
  sponsor: SponsoredTravelSponsor | null;
  // The earliest filing for the trip. It is the cited source, and it stays
  // the same when an amendment is filed later, so the record keeps its key.
  docId: string;
  filingYear: string;
  docIds: string[];
  // Every filing for the trip, earliest first. The Clerk site has lost a few
  // PDFs, so the importer cites the first one that still loads.
  filings: { docId: string; filingYear: string }[];
};

/**
 * Member-own rows for the destination, folded to one trip per member +
 * departure date. Rows with no readable departure date are returned apart.
 */
export function groupHouseSponsoredTrips(
  rows: readonly HouseGiftTravelRow[],
  destination: SponsoredTravelDestination
): { trips: HouseSponsoredTrip[]; undated: HouseGiftTravelRow[] } {
  const trips = new Map<string, HouseSponsoredTrip>();
  const undated: HouseGiftTravelRow[] = [];
  for (const row of rows) {
    if (!destination.pattern.test(row.destination) || !isMemberOwnFiling(row)) {
      continue;
    }
    if (!row.departureDate) {
      undated.push(row);
      continue;
    }
    const key = `${row.state}|${memberLastName(row.memberName)}|${row.departureDate}`;
    const existing = trips.get(key);
    if (!existing) {
      trips.set(key, {
        memberName: row.memberName,
        state: row.state,
        district: row.district,
        departureDate: row.departureDate,
        returnDate: row.returnDate,
        sponsorAsFiled: row.sponsor,
        sponsor: destination.sponsors.find((sponsor) => sponsor.pattern.test(row.sponsor)) ?? null,
        docId: row.docId,
        filingYear: row.year,
        docIds: [row.docId],
        filings: [{ docId: row.docId, filingYear: row.year }],
      });
      continue;
    }
    if (!existing.docIds.includes(row.docId)) {
      existing.docIds.push(row.docId);
      existing.filings.push({ docId: row.docId, filingYear: row.year });
      existing.filings.sort((a, b) => Number(a.docId) - Number(b.docId));
    }
    if (Number(row.docId) < Number(existing.docId)) {
      existing.docId = row.docId;
      existing.filingYear = row.year;
      existing.returnDate = row.returnDate ?? existing.returnDate;
    }
  }
  return {
    trips: [...trips.values()].sort(
      (a, b) => a.departureDate.localeCompare(b.departureDate) || a.memberName.localeCompare(b.memberName)
    ),
    undated,
  };
}

export function houseGiftTravelPdfUrl(filingYear: string, docId: string): string {
  return `https://disclosures-clerk.house.gov/gtimages/MT/${filingYear}/${docId}.pdf`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function buildSponsoredTripDescription(
  destination: SponsoredTravelDestination,
  trip: Pick<HouseSponsoredTrip, "departureDate">,
  sponsor: SponsoredTravelSponsor
): string {
  const [year, month] = trip.departureDate.split("-");
  const first = `Took an all-expenses-paid trip to ${destination.label} in ${MONTHS[Number(month) - 1]} ${year}, paid for by ${sponsor.clause}.`;
  return sponsor.followUp ? `${first} ${sponsor.followUp}` : first;
}

export type HouseTripLegislatorMatch =
  | { outcome: "matched"; legislator: Legislator; by: "seat" | "state_and_name" }
  | { outcome: "no_legislator" | "name_mismatch" | "ambiguous"; detail: string };

function parseDistrict(value: string): number | null {
  const digits = /^\d+$/.exec(value.trim());
  return digits ? Number(digits[0]) : null;
}

/**
 * The legislator who held the trip's House seat on the departure date. The
 * index prints the district at filing time, which can differ from the seat at
 * travel time after redistricting, so a state + last-name match on the same
 * date is the fallback. Either way the printed last name must agree.
 */
export function matchHouseTripLegislator(
  trip: Pick<HouseSponsoredTrip, "memberName" | "state" | "district" | "departureDate">,
  legislators: LegislatorIndex
): HouseTripLegislatorMatch {
  const last = memberLastName(trip.memberName);
  const district = parseDistrict(trip.district);
  const inState: Legislator[] = [];
  for (const legislator of legislators.byBioguide.values()) {
    const held = legislator.terms.some(
      (term) =>
        term.type === "rep" &&
        term.state === trip.state &&
        term.start <= trip.departureDate &&
        trip.departureDate <= term.end
    );
    if (held) {
      inState.push(legislator);
    }
  }
  const nameAgrees = (legislator: Legislator): boolean => normalizeName(legislator.name).includes(last);

  if (district !== null) {
    const seat = inState.filter((legislator) =>
      legislator.terms.some(
        (term) =>
          term.type === "rep" &&
          term.state === trip.state &&
          term.district === district &&
          term.start <= trip.departureDate &&
          trip.departureDate <= term.end
      )
    );
    const agreeing = seat.filter(nameAgrees);
    if (agreeing.length === 1) {
      return { outcome: "matched", legislator: agreeing[0]!, by: "seat" };
    }
  }
  const byName = inState.filter(nameAgrees);
  if (byName.length === 1) {
    return { outcome: "matched", legislator: byName[0]!, by: "state_and_name" };
  }
  if (byName.length > 1) {
    return { outcome: "ambiguous", detail: `${byName.length} ${trip.state} members match "${last}" on ${trip.departureDate}` };
  }
  return inState.length === 0
    ? { outcome: "no_legislator", detail: `no House term in ${trip.state} covers ${trip.departureDate}` }
    : { outcome: "name_mismatch", detail: `no ${trip.state} member on ${trip.departureDate} is named "${last}"` };
}

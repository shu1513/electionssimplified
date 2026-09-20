import { describe, expect, it } from "vitest";

import { indexLegislators, type Legislator } from "../../../src/pipeline/rollcall/congressLegislators.js";
import {
  buildSponsoredTripDescription,
  groupHouseSponsoredTrips,
  houseGiftTravelPdfUrl,
  isMemberOwnFiling,
  matchHouseTripLegislator,
  parseHouseGiftTravelIndex,
  parseIndexDate,
  planSponsoredTripRecord,
  SPONSORED_TRAVEL_DESTINATIONS,
} from "../../../src/pipeline/travel/houseGiftTravel.js";

const ISRAEL = SPONSORED_TRAVEL_DESTINATIONS.israel!;

function travel(fields: Record<string, string>): string {
  const tags = ["DocID", "FilerName", "MemberName", "State", "District", "Year", "Destination", "FilingType", "DepartureDate", "ReturnDate", "TravelSponsor"];
  return `<Travel>${tags.map((tag) => (fields[tag] ? `<${tag}>${fields[tag]}</${tag}>` : `<${tag} />`)).join("")}</Travel>`;
}

const WEBER = {
  FilerName: "Randy Weber",
  MemberName: "Weber, Randy",
  State: "TX",
  District: "14",
  DepartureDate: "2/13/2025",
  ReturnDate: "2/21/2025",
  TravelSponsor: "American Israel Education Foundation, Inc. (AIEF)",
};

const INDEX = `<?xml version="1.0" encoding="utf-8"?><GiftTravel>
${travel({ ...WEBER, DocID: "500029683", Year: "2025", Destination: "Tel Aviv, Israel", FilingType: "Original" })}
${travel({ ...WEBER, DocID: "500029683", Year: "2025", Destination: "Jerusalem, Israel", FilingType: "Original" })}
${travel({ ...WEBER, DocID: "500031000", Year: "2026", Destination: "Tel Aviv, Israel", FilingType: "Amendment" })}
${travel({ ...WEBER, DocID: "500029700", Year: "2025", FilerName: "Sam Staffer", Destination: "Tel Aviv, Israel", FilingType: "Original" })}
${travel({ ...WEBER, DocID: "500029701", Year: "2025", Destination: "Panama", FilingType: "Original" })}
${travel({ ...WEBER, DocID: "500029702", Year: "2025", Destination: "Jerusalem", FilingType: "Original", DepartureDate: "", TravelSponsor: "J Street Education Fund &amp; Friends" })}
${travel({ DocID: "500024886", MemberName: "Calvert, Ken", State: "CA", District: "41", Year: "2025", FilingType: "Original" })}
</GiftTravel>`;

describe("House gift-travel index", () => {
  it("parses rows, dates and XML entities", () => {
    const rows = parseHouseGiftTravelIndex(INDEX);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({ docId: "500029683", state: "TX", departureDate: "2025-02-13", returnDate: "2025-02-21" });
    expect(rows[5]!.sponsor).toBe("J Street Education Fund & Friends");
    expect(rows[6]!.departureDate).toBeNull();
    expect(parseIndexDate("13/1/2025")).toBeNull();
    expect(parseIndexDate("Aug 5")).toBeNull();
    // Real calendar dates only: Postgres would reject the rest mid-run.
    expect(parseIndexDate("2/31/2025")).toBeNull();
    expect(parseIndexDate("4/31/2025")).toBeNull();
    expect(parseIndexDate("2/29/2025")).toBeNull();
    expect(parseIndexDate("2/29/2024")).toBe("2024-02-29");
  });

  it("keeps a member who files under a nickname and drops a filer with another last name", () => {
    expect(isMemberOwnFiling({ filerName: "Daniel S. Goldman", memberName: "Goldman, Daniel" })).toBe(true);
    expect(isMemberOwnFiling({ filerName: "Tom Emmer, Jr.", memberName: "Emmer, Thomas" })).toBe(true);
    expect(isMemberOwnFiling({ filerName: "Mike Thompson", memberName: "Thompson, Michael" })).toBe(true);
    expect(isMemberOwnFiling({ filerName: "Naomi Lake", memberName: "Garcia, Jesus" })).toBe(false);
    expect(isMemberOwnFiling({ filerName: "", memberName: "Calvert, Ken" })).toBe(false);
    // A staffer who shares the last name passes here; the MT-path check stops that filing.
    expect(isMemberOwnFiling({ filerName: "William Johnson", memberName: "Johnson, Mike" })).toBe(true);
  });

  it("folds destination lines and amendments into one trip that cites the earliest filing", () => {
    const { trips, undated } = groupHouseSponsoredTrips(parseHouseGiftTravelIndex(INDEX), ISRAEL);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      memberName: "Weber, Randy",
      departureDate: "2025-02-13",
      docId: "500029683",
      filingYear: "2025",
      docIds: ["500029683", "500031000"],
    });
    expect(trips[0]!.sponsor?.key).toBe("aief");
    expect(undated.map((row) => row.docId)).toEqual(["500029702"]);
    expect(houseGiftTravelPdfUrl("2025", "500029683")).toBe(
      "https://disclosures-clerk.house.gov/gtimages/MT/2025/500029683.pdf"
    );
  });

  it("leaves an unlisted sponsor without a clause", () => {
    const xml = `<GiftTravel>${travel({ ...WEBER, DocID: "1", Year: "2025", Destination: "Israel", TravelSponsor: "Some Other Fund" })}</GiftTravel>`;
    expect(groupHouseSponsoredTrips(parseHouseGiftTravelIndex(xml), ISRAEL).trips[0]!.sponsor).toBeNull();
  });

  it("writes the agreed sentence", () => {
    const description = buildSponsoredTripDescription(ISRAEL, { departureDate: "2025-08-03" }, ISRAEL.sponsors[0]!);
    expect(description).toBe(
      "Took an all-expenses-paid trip to Israel in August 2025, paid for by the American Israel Education Foundation, an organization tied to AIPAC, a group that lobbies Congress for U.S. military aid and support for Israel."
    );
    expect(buildSponsoredTripDescription(ISRAEL, { departureDate: "2026-02-16" }, ISRAEL.sponsors.find((s) => s.key === "12tribe")!)).toBe(
      "Took an all-expenses-paid trip to Israel in February 2026, paid for by the 12Tribe Films Foundation. The charity is run by Avi Abelow, a right-wing Israeli media activist who lives in a West Bank settlement and campaigns for Israeli rule over the West Bank."
    );
    for (const sponsor of ISRAEL.sponsors) {
      expect(sponsor.sources.length).toBeGreaterThan(0);
      expect(buildSponsoredTripDescription(ISRAEL, { departureDate: "2025-09-03" }, sponsor).length).toBeLessThanOrEqual(320);
    }
  });
});

function rep(bioguide: string, name: string, state: string, district: number, start: string, end: string): Legislator {
  return { bioguide, lis: null, fecIds: [`H0${bioguide}`], name, terms: [{ type: "rep", start, end, state, district }] };
}

describe("matchHouseTripLegislator", () => {
  const legislators = indexLegislators([
    rep("W000814", "Randy K. Weber, Sr.", "TX", 14, "2025-01-03", "2027-01-03"),
    rep("G000581", "Vicente Gonzalez", "TX", 34, "2025-01-03", "2027-01-03"),
    rep("G000594", "Tony Gonzales", "TX", 23, "2025-01-03", "2027-01-03"),
    rep("G000999", "Ana Gonzalez", "TX", 15, "2025-01-03", "2027-01-03"),
  ]);
  const trip = { memberName: "Weber, Randy", state: "TX", district: "14", departureDate: "2025-02-13" };

  it("matches on the seat and confirms the name", () => {
    const match = matchHouseTripLegislator(trip, legislators);
    expect(match).toMatchObject({ outcome: "matched", by: "seat" });
  });

  it("falls back to state and name when the printed district is a different seat", () => {
    const match = matchHouseTripLegislator({ ...trip, district: "36" }, legislators);
    expect(match).toMatchObject({ outcome: "matched", by: "state_and_name" });
  });

  it("uses the seat to separate members who share a last name", () => {
    const gonzalez = { memberName: "Gonzalez, Vicente", state: "TX", district: "34", departureDate: "2025-02-13" };
    const match = matchHouseTripLegislator(gonzalez, legislators);
    expect(match.outcome === "matched" && match.legislator.bioguide).toBe("G000581");
    expect(matchHouseTripLegislator({ ...gonzalez, district: "" }, legislators).outcome).toBe("ambiguous");
  });

  it("refuses a name nobody in the state held, and a date outside every term", () => {
    expect(matchHouseTripLegislator({ ...trip, memberName: "Smith, Pat" }, legislators).outcome).toBe("name_mismatch");
    expect(matchHouseTripLegislator({ ...trip, departureDate: "2019-02-13" }, legislators).outcome).toBe("no_legislator");
  });
});

describe("planSponsoredTripRecord", () => {
  const keys = ["key-earliest-filing", "key-amendment"];
  const row = (id: string, key: string, retired = false) => ({
    id,
    record_identity_key: key,
    retired_at: retired ? "2026-09-01" : null,
  });

  it("inserts a new trip and leaves an identical one unchanged", () => {
    expect(planSponsoredTripRecord([], keys)).toEqual({ action: "insert" });
    expect(planSponsoredTripRecord([row("a", "key-amendment")], keys)).toEqual({
      action: "unchanged",
      recordId: "a",
      keyIndex: 1,
    });
  });

  it("leaves a live record with older wording alone", () => {
    expect(planSponsoredTripRecord([row("a", "key-old-wording")], keys)).toEqual({ action: "changed", recordId: "a" });
  });

  it("never re-inserts a retired trip, even after the wording changed", () => {
    expect(planSponsoredTripRecord([row("a", "key-earliest-filing", true)], keys).action).toBe("retired_blocks");
    expect(planSponsoredTripRecord([row("a", "key-old-wording", true)], keys)).toEqual({
      action: "retired_blocks",
      recordId: "a",
    });
  });
});

describe("groupHouseSponsoredTrips with a legislator index", () => {
  const legislators = indexLegislators([
    rep("S001157", "David Scott", "GA", 13, "2025-01-03", "2027-01-03"),
    rep("S001189", "Austin Scott", "GA", 8, "2025-01-03", "2027-01-03"),
    rep("D000610", "Theodore E. Deutch", "FL", 22, "2019-01-03", "2021-01-03"),
  ]);
  const base = { Destination: "Tel Aviv, Israel", FilingType: "Original", TravelSponsor: "American Israel Education Foundation" };

  it("keeps two members apart when they share a state, a surname and a departure date", () => {
    const xml = `<GiftTravel>${travel({ ...base, DocID: "1", Year: "2025", FilerName: "David Scott", MemberName: "Scott, David", State: "GA", District: "13", DepartureDate: "8/3/2025" })}${travel({ ...base, DocID: "2", Year: "2025", FilerName: "Austin Scott", MemberName: "Scott, Austin", State: "GA", District: "08", DepartureDate: "8/3/2025" })}</GiftTravel>`;
    const rows = parseHouseGiftTravelIndex(xml);
    expect(groupHouseSponsoredTrips(rows, ISRAEL, legislators).trips.map((trip) => trip.memberName).sort()).toEqual([
      "Scott, Austin",
      "Scott, David",
    ]);
    // Without the index the surname key folds them together, which is the defect.
    expect(groupHouseSponsoredTrips(rows, ISRAEL).trips).toHaveLength(1);
  });

  it("keeps one member together when two filings print the name differently", () => {
    const xml = `<GiftTravel>${travel({ ...base, DocID: "1", Year: "2019", FilerName: "Ted Deutch", MemberName: "Deutch, Theodore", State: "FL", District: "22", DepartureDate: "12/4/2019" })}${travel({ ...base, DocID: "2", Year: "2020", FilerName: "Theodore Deutch", MemberName: "Deutch, Theodore E.", State: "FL", District: "22", DepartureDate: "12/4/2019" })}</GiftTravel>`;
    const { trips } = groupHouseSponsoredTrips(parseHouseGiftTravelIndex(xml), ISRAEL, legislators);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.docIds).toEqual(["1", "2"]);
  });
});

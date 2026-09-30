import { describe, expect, it } from "vitest";

import { recordBillKey, relatedRecordsByBill } from "./recordBillKey";

const record = (description: string, source_url: string, event_date = "2024-03-05") => ({ description, source_url, event_date });

describe("recordBillKey", () => {
  it("reads the bill from official bill-page URLs first", () => {
    expect(recordBillKey(record("Voted for the crime law.", "https://lims.dccouncil.gov/Legislation/B25-0345"))).toBe("dc:B25-0345");
    expect(recordBillKey(record("Voted yes.", "https://legiscan.com/WA/bill/HB1234/2023", "2024-02-10"))).toBe("HB1234:2024");
    expect(recordBillKey(record("Voted yes.", "https://malegislature.gov/Bills/193/H4000", "2023-04-26"))).toBe("H4000:2023");
    expect(recordBillKey(record("Voted yes.", "https://www.congress.gov/bill/118th-congress/house-bill/1470", "2023-03-01"))).toBe("HR1470:2023");
    expect(recordBillKey(record("Voted yes.", "https://www.congress.gov/bill/118th-congress/house-resolution/5", "2023-03-01"))).toBe("HRES5:2023");
  });

  it("gives the same bill one key whether cited by official page or named in the description", () => {
    expect(recordBillKey(record("Voted yes.", "https://www.congress.gov/bill/118th-congress/house-bill/1470", "2023-03-01"))).toBe(
      recordBillKey(record("Introduced H.R.1470, the Ending Qualified Immunity Act.", "https://clerk.house.gov/evs/2023/roll100.xml", "2023-03-01"))
    );
    expect(recordBillKey(record("Voted yes.", "https://legiscan.com/MA/bill/H4000/2023", "2023-04-26"))).toBe(
      recordBillKey(record("Voted for H.4000, the budget.", "https://malegislature.gov/Journal/House/193/2023/RollCalls", "2023-04-26"))
    );
    // A House resolution is not the House bill with the same number.
    expect(recordBillKey(record("Voted for House Resolution 1470 honoring veterans.", "https://example.gov/x", "2023-03-01"))).toBe("HRES1470:2023");
    expect(recordBillKey(record("Voted for H.Res. 1470 honoring veterans.", "https://example.gov/x", "2023-03-01"))).toBe("HRES1470:2023");
    expect(recordBillKey(record("Voted for H.R. 1470.", "https://example.gov/x", "2023-03-01"))).toBe("HR1470:2023");
  });

  it("reads bill numbers from the description, keyed with the record's own year", () => {
    expect(recordBillKey(record("Introduced H.R.1470, the Ending Qualified Immunity Act.", "https://example.gov/x", "2023-03-01"))).toBe("HR1470:2023");
    expect(recordBillKey(record("Voted for House Bill 4432 at second reading.", "https://example.gov/x", "2024-01-10"))).toBe("HB4432:2024");
    expect(recordBillKey(record("Filed H.866, a bill enabling noncitizen voting.", "https://example.gov/x", "2025-01-16"))).toBe("H866:2025");
    expect(recordBillKey(record("Voted for the Secure DC law, B25-0345.", "https://example.gov/x"))).toBe("dc:B25-0345");
  });

  it("keys named measures so amendment votes and final passage share a key", () => {
    const amendment = record("Voted against the Secure DC amendment allowing DNA collection before conviction.", "https://2024.dccouncil.org/mems/x");
    const passage = record("Voted for D.C.'s Secure DC crime law. It made strangulation a crime.", "https://example.org/y");
    const other = record("Voted for the Street Vendor Advancement Amendment Act, which expanded vending permits.", "https://example.org/z");
    expect(recordBillKey(amendment)).toBe("name:secure dc");
    expect(recordBillKey(passage)).toBe("name:secure dc");
    expect(recordBillKey(other)).toBe("name:street vendor advancement amendment");
  });

  it("returns null when there is no bill to key on", () => {
    expect(recordBillKey(record("Was endorsed for Mayor by the Working Families Party.", "https://example.org/a"))).toBeNull();
    expect(recordBillKey(record("Voted against the District's emergency measure restructuring the housing authority board.", "https://example.org/b"))).toBeNull();
    expect(recordBillKey(record("Was ordered to pay a $16,000 fine.", "https://example.org/c"))).toBeNull();
    expect(recordBillKey(record("Served on the Plan A 5 committee.", "https://example.org/d"))).toBeNull();
    expect(recordBillKey(record("Voted in Section S 12 of the hearing.", "https://example.org/e"))).toBeNull();
    expect(recordBillKey(record("Voted for S. 1383, the shield bill.", "https://example.org/f", "2023-05-01"))).toBe("S1383:2023");
  });

  it("links only records that share a key", () => {
    const records = [
      { id: "1", ...record("Voted against the Secure DC amendment allowing DNA collection.", "https://example.org/a") },
      { id: "2", ...record("Voted for D.C.'s Secure DC crime law.", "https://example.org/b") },
      { id: "3", ...record("Voted for the Street Vendor Advancement Amendment Act.", "https://example.org/c") },
      { id: "4", ...record("Was endorsed by a union.", "https://example.org/d") },
    ];
    const related = relatedRecordsByBill(records);
    expect(related.get("1")?.map((r) => r.id)).toEqual(["2"]);
    expect(related.get("2")?.map((r) => r.id)).toEqual(["1"]);
    expect(related.has("3")).toBe(false);
    expect(related.has("4")).toBe(false);
  });
});

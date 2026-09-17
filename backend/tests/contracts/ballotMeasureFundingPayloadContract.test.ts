import { describe, expect, it } from "vitest";

import { parseBallotMeasureFundingPayload } from "../../src/contracts/ballotMeasureFundingPayloadContract.js";

const TODAY = new Date("2026-09-17T12:00:00.000Z");

function committee(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "No on 645",
    committee_id: "645-N--960",
    source_url: "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data/committees/co-2026-42211",
    ...overrides,
  };
}

function donor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Washington Education Association",
    amount: 3014260.91,
    type: "organization",
    state: "WA",
    about: "Washington's teachers union",
    ...overrides,
  };
}

function emptySide(): Record<string, unknown> {
  return { committees: [], top_donors: [] };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    as_of: "2026-09-17",
    support: emptySide(),
    oppose: { committees: [committee()], top_donors: [donor()] },
    ...overrides,
  };
}

function parse(value: unknown) {
  return parseBallotMeasureFundingPayload(value, { today: TODAY });
}

function reasonOf(value: unknown): string {
  const result = parse(value);
  if (result.ok) {
    throw new Error("expected the payload to be rejected");
  }
  return result.reason;
}

describe("parseBallotMeasureFundingPayload", () => {
  it("accepts a payload and normalizes it", () => {
    expect(parse(payload())).toEqual({
      ok: true,
      payload: {
        as_of: "2026-09-17",
        sides: {
          support: { committees: [], top_donors: [] },
          oppose: {
            committees: [
              {
                name: "No on 645",
                committee_id: "645-N--960",
                also_covers_other_measures: false,
                source_url:
                  "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data/committees/co-2026-42211",
              },
            ],
            top_donors: [
              {
                name: "Washington Education Association",
                amount: 3014260.91,
                type: "organization",
                state: "WA",
                about: "Washington's teachers union",
              },
            ],
          },
        },
      },
    });
  });

  it("sorts donors largest first and keeps payload order on ties", () => {
    const result = parse(
      payload({
        oppose: {
          committees: [committee()],
          top_donors: [
            donor({ name: "B", amount: 100 }),
            donor({ name: "A", amount: 500 }),
            donor({ name: "C", amount: 100 }),
          ],
        },
      })
    );
    expect(result.ok && result.payload.sides.oppose.top_donors.map((entry) => entry.name)).toEqual(["A", "B", "C"]);
  });

  it("keeps the multi-measure flag and drops absent optional fields", () => {
    const result = parse(
      payload({
        oppose: {
          committees: [committee({ committee_id: undefined, also_covers_other_measures: true })],
          top_donors: [donor({ state: undefined })],
        },
      })
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.payload.sides.oppose.committees[0]).not.toHaveProperty("committee_id");
    expect(result.payload.sides.oppose.committees[0]?.also_covers_other_measures).toBe(true);
    expect(result.payload.sides.oppose.top_donors[0]).not.toHaveProperty("state");
  });

  it("keeps who is behind a pass-through donor", () => {
    const result = parse(
      payload({
        oppose: {
          committees: [committee()],
          top_donors: [
            donor({ name: "Building a Better California", funded_by: [" Sergey Brin ", "L. John  Doerr, III"] }),
          ],
        },
      })
    );
    expect(result.ok && result.payload.sides.oppose.top_donors[0]?.funded_by).toEqual([
      "Sergey Brin",
      "L. John Doerr, III",
    ]);
    const withFundedBy = (fundedBy: unknown) =>
      payload({ oppose: { committees: [committee()], top_donors: [donor({ funded_by: fundedBy })] } });
    expect(reasonOf(withFundedBy([]))).toContain("funded_by must list 1 to 3 names");
    expect(reasonOf(withFundedBy(["A", "B", "C", "D"]))).toContain("funded_by must list 1 to 3 names");
    expect(reasonOf(withFundedBy("Sergey Brin"))).toContain("funded_by must list 1 to 3 names");
  });

  it("keeps a short description of who a donor is", () => {
    const withAbout = (about: unknown) =>
      payload({ oppose: { committees: [committee()], top_donors: [donor({ about })] } });
    const result = parse(withAbout(" Washington's  teachers union "));
    expect(result.ok && result.payload.sides.oppose.top_donors[0]?.about).toBe("Washington's teachers union");
    expect(reasonOf(withAbout(""))).toContain("about is required");
    expect(reasonOf(withAbout(undefined))).toContain('say what "Washington Education Association" is');
    expect(reasonOf(withAbout("x".repeat(61)))).toContain("at most 60 characters");
  });

  it("rejects a payload that is not an object or has a bad as_of", () => {
    expect(reasonOf([])).toBe("payload must be an object");
    expect(reasonOf(payload({ as_of: "2026-02-30" }))).toContain("as_of must be a valid YYYY-MM-DD date");
    expect(reasonOf(payload({ as_of: "2026-09-18" }))).toContain("as_of must not be in the future");
  });

  it("requires both sides to be stated, even when empty", () => {
    expect(reasonOf(payload({ support: undefined }))).toContain("support must be an object");
    expect(reasonOf(payload({ oppose: { committees: [] } }))).toContain("oppose top_donors must be an array");
  });

  it("rejects totals, which are no longer stored or shown", () => {
    expect(reasonOf(payload({ support: { ...emptySide(), total_raised: 5 } }))).toContain(
      "support total_raised is no longer part of this payload"
    );
    expect(reasonOf(payload({ oppose: { committees: [committee({ total_raised: 7805687.57 })], top_donors: [] } }))).toContain(
      "oppose committees[0] total_raised is no longer part of this payload"
    );
    expect(
      reasonOf(payload({ oppose: { committees: [committee({ from_same_side_committees: 1 })], top_donors: [] } }))
    ).toContain("from_same_side_committees is no longer part of this payload");
  });

  it("rejects bad committee fields", () => {
    const withCommittee = (overrides: Record<string, unknown>) =>
      payload({ oppose: { committees: [committee(overrides)], top_donors: [] } });
    expect(reasonOf(withCommittee({ name: " " }))).toContain("name must be non-empty string");
    expect(reasonOf(withCommittee({ also_covers_other_measures: "yes" }))).toContain("must be true or false");
    expect(reasonOf(withCommittee({ source_url: "pdc.wa.gov" }))).toContain("source_url must be valid http(s) URL");
    expect(reasonOf(withCommittee({ source_url: "https://ballotpedia.org/Washington_IL26-645" }))).toContain(
      "must be the official campaign finance filing system"
    );
    expect(reasonOf(withCommittee({ source_url: "https://www.facebook.com/noon645" }))).toContain("oppose committees[0]");
  });

  it("rejects bad donor fields", () => {
    const withDonor = (overrides: Record<string, unknown>) =>
      payload({ oppose: { committees: [committee()], top_donors: [donor(overrides)] } });
    expect(reasonOf(withDonor({ amount: 0 }))).toContain("amount must be greater than zero");
    expect(reasonOf(withDonor({ amount: "3014260.91" }))).toContain("amount must be a number");
    expect(reasonOf(withDonor({ type: "union" }))).toContain("type must be organization or individual");
    expect(reasonOf(withDonor({ state: "Wa" }))).toContain("state must be a two-letter uppercase code");
    expect(reasonOf(withDonor({ name: "SMALL CONTRIBUTIONS" }))).toContain("roll-up line");
  });

  it("rejects duplicates and committees posing as donors", () => {
    expect(
      reasonOf(payload({ oppose: { committees: [committee(), committee({ name: "no on  645" })], top_donors: [] } }))
    ).toContain("more than once");
    expect(
      reasonOf(payload({ oppose: { committees: [committee()], top_donors: [donor(), donor({ amount: 5 })] } }))
    ).toContain("add the amounts into one entry");
    expect(
      reasonOf(payload({ oppose: { committees: [committee()], top_donors: [donor({ name: "No on 645", amount: 5 })] } }))
    ).toContain("is itself a oppose committee");
    expect(reasonOf(payload({ support: { committees: [committee()], top_donors: [] } }))).toContain(
      "listed under both support and oppose"
    );
  });

  it("rejects one committee id entered under two names, on one side or across sides", () => {
    const renamed = committee({ name: "Vote No 645 Committee", committee_id: "645-n--960" });
    expect(reasonOf(payload({ oppose: { committees: [committee(), renamed], top_donors: [] } }))).toContain(
      "lists committee_id 645-n--960 more than once"
    );
    expect(reasonOf(payload({ support: { committees: [renamed], top_donors: [] } }))).toContain(
      "listed under both support and oppose"
    );
  });

  it("lets two committees cite one agency page", () => {
    const page = "https://fppc.ca.gov/search-filings/top-10-contributors-list/november-2026-general-election";
    const result = parse(
      payload({
        oppose: {
          committees: [
            committee({ name: "No on 39", committee_id: "1493991", source_url: page }),
            committee({ name: "Nurses Against 39", committee_id: "1493992", source_url: page }),
          ],
          top_donors: [],
        },
      })
    );
    expect(result.ok && result.payload.sides.oppose.committees).toHaveLength(2);
  });

  it("rejects donors without a committee and more than five donors", () => {
    expect(reasonOf(payload({ support: { committees: [], top_donors: [donor()] } }))).toContain(
      "needs at least one committee"
    );
    const six = Array.from({ length: 6 }, (_, index) => donor({ name: `Donor ${index}`, amount: 10 + index }));
    expect(reasonOf(payload({ oppose: { committees: [committee()], top_donors: six } }))).toContain(
      "more than 5 entries"
    );
  });
});

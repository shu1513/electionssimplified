import { describe, expect, it } from "vitest";

import {
  parseAiElectionEntriesPayload,
  parseCanonicalElectionPayload,
  parseFamilySourceUrls,
} from "../../src/contracts/electionPayloadContract.js";

describe("parseFamilySourceUrls", () => {
  it("accepts a missing map", () => {
    expect(parseFamilySourceUrls(undefined)).toEqual({ ok: true, familySourceUrls: null });
    expect(parseFamilySourceUrls(null)).toEqual({ ok: true, familySourceUrls: null });
  });

  it("normalizes, dedupes, and keeps every known family", () => {
    const result = parseFamilySourceUrls({
      all: ["https://example.gov/a", "https://example.gov/a"],
      judicial_office: ["https://example.gov/courts"],
    });

    expect(result).toEqual({
      ok: true,
      familySourceUrls: {
        all: ["https://example.gov/a"],
        judicial_office: ["https://example.gov/courts"],
      },
    });
  });

  it("rejects a bare string value", () => {
    const result = parseFamilySourceUrls({ judicial_office: "https://example.gov/courts" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        "payload.family_source_urls.judicial_office must be an array of URL strings"
      );
    }
  });

  it("rejects non-string array members", () => {
    const result = parseFamilySourceUrls({ all: ["https://example.gov/a", 42] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("payload.family_source_urls.all must be an array of URL strings");
    }
  });

  it("rejects an empty array", () => {
    const result = parseFamilySourceUrls({ all: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("must contain at least one URL string");
    }
  });

  it("rejects a URL that is not http(s)", () => {
    const result = parseFamilySourceUrls({ all: ["not-a-url"] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("is not a valid http(s) URL");
    }
  });

  it("rejects an unknown contest family", () => {
    const result = parseFamilySourceUrls({ school_board: ["https://example.gov/board"] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("is not a known contest family");
    }
  });

  it("rejects a non-object map", () => {
    expect(parseFamilySourceUrls("https://example.gov/a").ok).toBe(false);
    expect(parseFamilySourceUrls(["https://example.gov/a"]).ok).toBe(false);
  });
});

describe("parseCanonicalElectionPayload", () => {
  it("parses valid payload", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
      review_decision: "approve",
      review_reason: "Looks in scope",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries).toHaveLength(1);
      expect(result.payload.entries[0].race_type).toBe("office");
      expect(result.payload.entries[0].discovery_contest_family).toBe("non_judicial_office");
    }
  });

  it("rejects a non-array family_source_urls value instead of dropping it", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      family_source_urls: { judicial_office: "https://example.gov/courts" },
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        "payload.family_source_urls.judicial_office must be an array of URL strings"
      );
    }
  });

  it("rejects invalid discovery_contest_family", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "bad_family",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects ballot measure rows with office discovery family", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Measure A",
          election_date: "2026-11-03",
          race_type: "ballot_measure",
          discovery_contest_family: "judicial_office",
          sources: ["https://example.gov/elections/measure-a"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects office rows with ballot_measure discovery family", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "ballot_measure",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects all as persisted discovery family", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "all",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects senate metadata with non-senate discovery family", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "United States Senator",
          election_date: "2026-11-03",
          race_type: "office",
          senate_class: "class_i",
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.gov/elections/us-senate"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects invalid race_type", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Measure A",
          election_date: "2026-11-03",
          race_type: "measure",
          sources: ["https://example.gov/elections/measure-a"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects non-http sources", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Measure A",
          election_date: "2026-11-03",
          race_type: "ballot_measure",
          sources: ["ftp://example.gov/elections/measure-a"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-02-30",
          race_type: "office",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("accepts valid leap-day dates", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2028-02-29",
          race_type: "office",
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects split-pass district entries missing discovery_contest_family", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "California",
      district_type: "statewide",
      state: "CA",
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "payload.entries[0] is missing discovery_contest_family; statewide districts research per-family passes (non_judicial_office|judicial_office|ballot_measure|us_senate)",
    });
  });

  it("accepts combined-pass district entries without discovery_contest_family", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "House District 3",
      district_type: "us_house",
      state: "CA",
      entries: [
        {
          official_ballot_title: "United States Representative, District 3",
          election_date: "2026-11-03",
          race_type: "office",
          sources: ["https://example.gov/elections/us-house-3"],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects combined-pass district entries carrying a discovery_contest_family", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d1",
      district_name: "House District 3",
      district_type: "us_house",
      state: "CA",
      entries: [
        {
          official_ballot_title: "United States Representative, District 3",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "judicial_office",
          sources: ["https://example.gov/elections/us-house-3"],
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "payload.entries[0] must omit discovery_contest_family; us_house districts research one combined pass with no per-entry family",
    });
  });

  it("accepts an Arizona county ballot as Arizona classifies it", () => {
    // Yuma County, 2026-08-08: the whole payload was rejected because "Clerk of
    // Superior Court" was read as a judgeship. Arizona splits the rest of this
    // ballot three ways — the clerk is a partisan county office, the Justice of
    // the Peace is a partisan precinct office, and the elected Superior Court
    // judge is printed without party (Ariz. Const. art. 6 § 12(A)).
    const result = parseCanonicalElectionPayload({
      district_id: "d-az",
      district_name: "Yuma County, Arizona",
      district_type: "county",
      state: "AZ",
      entries: [
        {
          official_ballot_title: "Clerk of Superior Court",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "non_judicial_office",
          is_partisan: true,
          sources: ["https://www.yumacountyaz.gov/government/election-services/candidate-listing"],
        },
        {
          official_ballot_title: "Justice of the Peace, Precinct 1",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "judicial_office",
          is_partisan: true,
          sources: ["https://www.yumacountyaz.gov/government/election-services/candidate-listing"],
        },
        {
          official_ballot_title: "Judge of Superior Court, Division 2",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "judicial_office",
          is_partisan: false,
          sources: ["https://www.yumacountyaz.gov/government/election-services/candidate-listing"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries.map((entry) => entry.is_partisan)).toEqual([true, true, false]);
    }
  });

  it("rejects a partisan Arizona Superior Court contest", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d-az",
      district_name: "Yuma County, Arizona",
      district_type: "county",
      state: "AZ",
      entries: [
        {
          official_ballot_title: "Judge of Superior Court, Division 3",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "judicial_office",
          is_partisan: true,
          sources: ["https://www.yumacountyaz.gov/government/election-services/candidate-listing"],
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "payload.entries[0].is_partisan=true contradicts fixed partisanship policy for AZ county (expected false)",
    });
  });

  it("rejects a nonpartisan Arizona Justice of the Peace contest", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "d-az",
      district_name: "Yuma County, Arizona",
      district_type: "county",
      state: "AZ",
      entries: [
        {
          official_ballot_title: "Justice of the Peace, Precinct 2",
          election_date: "2026-11-03",
          race_type: "office",
          discovery_contest_family: "judicial_office",
          is_partisan: false,
          sources: ["https://www.yumacountyaz.gov/government/election-services/candidate-listing"],
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "payload.entries[0].is_partisan=false contradicts fixed partisanship policy for AZ county (expected true)",
    });
  });
});

describe("parseAiElectionEntriesPayload", () => {
  it("parses valid AI entries without requiring impact", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "County Sheriff",
          election_date: "2026-11-03",
          race_type: "office",
          sources: ["https://example.gov/elections/sheriff"],
        },
      ],
      review_decision: "approve",
      review_reason: "In scope",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries).toHaveLength(1);
      expect(result.payload.entries[0]).not.toHaveProperty("description");
    }
  });

  it("parses valid entries-only AI payload", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
      review_decision: "approve",
      review_reason: "In scope",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries).toHaveLength(1);
      expect(result.payload.review_decision).toBe("approve");
    }
  });

  it("parses optional election_stage when valid", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          election_stage: "general",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries[0].election_stage).toBe("general");
    }
  });

  it("parses optional is_partisan for office entries", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          is_partisan: true,
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries[0].is_partisan).toBe(true);
    }
  });

  it("rejects explicit partisanship that contradicts fixed Washington legislative policy", () => {
    const result = parseCanonicalElectionPayload({
      district_id: "district-wa",
      district_name: "Legislative District 35, Washington",
      district_type: "state_lower",
      state: "WA",
      entries: [
        {
          official_ballot_title: "State Representative Position 1",
          election_date: "2026-11-03",
          race_type: "office",
          is_partisan: false,
          sources: ["https://www.sos.wa.gov/elections"],
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/contradicts fixed partisanship policy/i),
    });
  });

  it("parses optional seats_to_fill for office entries", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "City Council At-Large",
          election_date: "2026-11-03",
          race_type: "office",
          seats_to_fill: 3,
          sources: ["https://example.gov/elections/council"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries[0].seats_to_fill).toBe(3);
    }
  });

  it("omits seats_to_fill from the parsed entry when absent", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("seats_to_fill" in result.payload.entries[0]).toBe(false);
    }
  });

  it("rejects non-integer, zero, and negative seats_to_fill", () => {
    for (const bad of ["3", 2.5, 0, -1]) {
      const result = parseAiElectionEntriesPayload({
        entries: [
          {
            official_ballot_title: "City Council At-Large",
            election_date: "2026-11-03",
            race_type: "office",
            seats_to_fill: bad,
            sources: ["https://example.gov/elections/council"],
          },
        ],
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects seats_to_fill on ballot_measure entries", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Measure A",
          election_date: "2026-11-03",
          race_type: "ballot_measure",
          seats_to_fill: 2,
          sources: ["https://example.gov/elections/measure-a"],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid entries row in AI payload", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "bad_value",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid election_stage", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          election_stage: "invalid",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-boolean is_partisan", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          race_type: "office",
          is_partisan: "yes",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("coerces ballot_measure is_partisan=true to false", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Measure A",
          election_date: "2026-11-03",
          race_type: "ballot_measure",
          is_partisan: true,
          sources: ["https://example.gov/elections/measure-a"],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries[0].is_partisan).toBe(false);
    }
  });

  it("accepts AI payloads that include legacy description field", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "Governor",
          election_date: "2026-11-03",
          description: "General election for governor.",
          race_type: "office",
          sources: ["https://example.gov/elections/governor"],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("parses optional senate_class and term_end_year for office entries", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "United States Senator",
          election_date: "2026-11-03",
          race_type: "office",
          senate_class: "class_i",
          term_end_year: "2031",
          sources: ["https://example.gov/elections/us-senate"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries[0].senate_class).toBe("class_i");
      expect(result.payload.entries[0].term_end_year).toBe("2031");
    }
  });

  it("rejects invalid senate_class", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "United States Senator",
          election_date: "2026-11-03",
          race_type: "office",
          senate_class: "class_iv",
          sources: ["https://example.gov/elections/us-senate"],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    ["2", "class_ii"],
    ["II", "class_ii"],
    ["ii", "class_ii"],
    ["Class II", "class_ii"],
    ["class 2", "class_ii"],
    ["class-iii", "class_iii"],
    ["1", "class_i"],
    ["I", "class_i"],
    ["3", "class_iii"],
  ])("normalizes unambiguous senate_class spelling %s to %s", (input, expected) => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "United States Senator",
          election_date: "2026-11-03",
          race_type: "office",
          senate_class: input,
          sources: ["https://example.gov/elections/us-senate"],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.entries[0].senate_class).toBe(expected);
    }
  });

  it.each(["4", "IV", "class", "class_", "iiii", "senate class", ""])(
    "still rejects ambiguous or unknown senate_class %s",
    (input) => {
      const result = parseAiElectionEntriesPayload({
        entries: [
          {
            official_ballot_title: "United States Senator",
            election_date: "2026-11-03",
            race_type: "office",
            senate_class: input,
            sources: ["https://example.gov/elections/us-senate"],
          },
        ],
      });
      expect(result.ok).toBe(false);
    }
  );

  it("rejects non-string term_end_year", () => {
    const result = parseAiElectionEntriesPayload({
      entries: [
        {
          official_ballot_title: "United States Senator",
          election_date: "2026-11-03",
          race_type: "office",
          term_end_year: 2031,
          sources: ["https://example.gov/elections/us-senate"],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
});

describe("parseCanonicalElectionPayload reinstate_retired", () => {
  const base = {
    district_id: "d-1",
    district_name: "Vermont",
    district_type: "statewide",
    state: "VT",
    entries: [
      {
        official_ballot_title: "Governor",
        election_date: "2026-11-03",
        race_type: "office",
        discovery_contest_family: "non_judicial_office",
        sources: ["https://example.org/election"],
      },
    ],
  };

  it("accepts the flag with a review_reason and keeps it on the payload", () => {
    const result = parseCanonicalElectionPayload({
      ...base,
      reinstate_retired: true,
      review_reason: "Certified ballot lists the race.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.reinstate_retired).toBe(true);
      expect(result.payload.review_reason).toBe("Certified ballot lists the race.");
    }
  });

  it("drops a false flag and rejects a non-boolean one", () => {
    const off = parseCanonicalElectionPayload({ ...base, reinstate_retired: false });
    expect(off.ok).toBe(true);
    if (off.ok) expect("reinstate_retired" in off.payload).toBe(false);

    const bad = parseCanonicalElectionPayload({ ...base, reinstate_retired: "yes" });
    expect(bad).toEqual({ ok: false, reason: "payload.reinstate_retired must be boolean when present" });
  });

  it("rejects the flag without a review_reason", () => {
    const result = parseCanonicalElectionPayload({ ...base, reinstate_retired: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("reinstate_retired requires a non-empty review_reason");
  });
});

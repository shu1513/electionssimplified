import { describe, expect, it } from "vitest";
import { candidateSameAsUrls, candidateSurname } from "./profileLinks";

describe("candidateSurname", () => {
  it("drops nicknames and generational suffixes, keeps hyphenated names as words", () => {
    expect(candidateSurname('Michael "Dr. Mike" Katz')).toBe("katz");
    expect(candidateSurname("Robert Farnsworth Jr.")).toBe("farnsworth");
    expect(candidateSurname("Mary Smith-Jones")).toBe("smith jones");
    expect(candidateSurname("Sandra Scott III")).toBe("scott");
    expect(candidateSurname("")).toBeNull();
  });
});

describe("candidateSameAsUrls", () => {
  it("keeps profile links and reference-site pages about the person, drops the rest, and dedupes", () => {
    expect(
      candidateSameAsUrls({
        display_name: "Jordan Voter",
        official_website_url: "https://jordan.example",
        twitter_handle: "jordanvoter",
        linkedin_url: "https://www.linkedin.com/in/jordan",
        profile_sources: [
          "https://ballotpedia.org/Jordan_Voter",
          "https://en.wikipedia.org/wiki/Jordan_Voter_(politician)",
          "https://www.votesmart.org/candidate/1/jordan-voter",
          // Evidence pages on the same hosts, not the person: out.
          "https://ballotpedia.org/Kentucky_House_of_Representatives_elections,_2026",
          "https://en.wikipedia.org/wiki/2026_Arizona_elections",
          "https://ballotpedia.org/Cuyahoga_County,_Ohio",
          "https://sos.example.gov/filing/1",
          "https://jordan.example",
          "not a url",
          "https://ballotpedia.org.evil.example/Jordan_Voter",
        ],
      })
    ).toEqual([
      "https://jordan.example",
      "https://x.com/jordanvoter",
      "https://www.linkedin.com/in/jordan",
      "https://ballotpedia.org/Jordan_Voter",
      "https://en.wikipedia.org/wiki/Jordan_Voter_(politician)",
      "https://www.votesmart.org/candidate/1/jordan-voter",
    ]);
  });

  it("matches the surname as a whole word, so 'Rose' does not claim 'Rosemont'", () => {
    const base = { official_website_url: null, twitter_handle: null, linkedin_url: null };
    expect(candidateSameAsUrls({ ...base, display_name: "Mary Rose", profile_sources: ["https://ballotpedia.org/Rosemont,_Illinois"] })).toEqual([]);
    expect(candidateSameAsUrls({ ...base, display_name: "Mary Rose", profile_sources: ["https://ballotpedia.org/Mary_Rose_(Arizona)"] })).toEqual([
      "https://ballotpedia.org/Mary_Rose_(Arizona)",
    ]);
    expect(candidateSameAsUrls({ ...base, display_name: 'Michael "Dr. Mike" Katz', profile_sources: ["https://ballotpedia.org/Michael_Katz_(Delaware)"] })).toEqual([
      "https://ballotpedia.org/Michael_Katz_(Delaware)",
    ]);
  });

  it("is empty when nothing identifies the candidate elsewhere", () => {
    expect(
      candidateSameAsUrls({ display_name: "Jordan Voter", official_website_url: null, twitter_handle: null, linkedin_url: null, profile_sources: ["https://example.gov/x"] })
    ).toEqual([]);
  });
});

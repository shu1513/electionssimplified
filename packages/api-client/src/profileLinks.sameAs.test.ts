import { describe, expect, it } from "vitest";
import { candidateSameAsUrls } from "./profileLinks";

describe("candidateSameAsUrls", () => {
  it("keeps profile links and reference-site sources, drops the rest, and dedupes", () => {
    expect(
      candidateSameAsUrls({
        official_website_url: "https://jordan.example",
        twitter_handle: "jordanvoter",
        linkedin_url: "https://www.linkedin.com/in/jordan",
        profile_sources: [
          "https://ballotpedia.org/Jordan_Voter",
          "https://en.wikipedia.org/wiki/Jordan_Voter",
          "https://www.votesmart.org/candidate/1",
          "https://sos.example.gov/filing/1",
          "https://jordan.example",
          "not a url",
          "https://ballotpedia.org.evil.example/x",
        ],
      })
    ).toEqual([
      "https://jordan.example",
      "https://x.com/jordanvoter",
      "https://www.linkedin.com/in/jordan",
      "https://ballotpedia.org/Jordan_Voter",
      "https://en.wikipedia.org/wiki/Jordan_Voter",
      "https://www.votesmart.org/candidate/1",
    ]);
  });

  it("is empty when nothing identifies the candidate elsewhere", () => {
    expect(
      candidateSameAsUrls({ official_website_url: null, twitter_handle: null, linkedin_url: null, profile_sources: ["https://example.gov/x"] })
    ).toEqual([]);
  });
});

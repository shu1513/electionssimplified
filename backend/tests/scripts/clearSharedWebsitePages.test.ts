import { describe, expect, it } from "vitest";

import { planSharedWebsiteClears } from "../../src/scripts/clearSharedWebsitePages.js";

const countyPage = "https://www.tarrantcountytx.gov/en/county/about-tarrant/elected-county-officials.html";
const opaquePage = "https://msa.maryland.gov/msa/mdmanual/36loc/bcity/html/bcityj.html";
const ticketSite = "https://actonforgovernor.com";

function row(id: string, name: string, website: string | null, former: string[] | null = null) {
  return { id, display_name: name, state: "TX", official_website_url: website, former_website_urls: former };
}

describe("planSharedWebsiteClears", () => {
  it("strips shared-page URLs held by enough rows and listed URLs, keeps shared personal sites", () => {
    const plan = planSharedWebsiteClears(
      [
        row("a", "Alex Kim", countyPage),
        row("b", "Andy Porter", countyPage + "/"),
        row("c", "Catherine Chen", opaquePage),
        row("d", "Hope Tipton", opaquePage),
        row("e", "Amy Acton", ticketSite),
        row("f", "David Pepper", ticketSite),
        row("g", "Jane Own", "https://jane.example", [countyPage]),
        row("h", "Solo Page", "https://www.popecountyar.gov/justices-of-peace"),
      ],
      { minRows: 2, listedUrls: [opaquePage] }
    );

    expect(plan.rowsScanned).toBe(8);
    expect(plan.strippedUrls).toEqual([
      { url: countyPage, reason: "shared_page_pattern", rows: 3 },
      { url: opaquePage, reason: "listed", rows: 2 },
    ]);
    expect(plan.rowChanges.map((change) => change.candidateId)).toEqual(["a", "b", "c", "d", "g"]);
    expect(plan.rowChanges.find((change) => change.candidateId === "g")).toEqual({
      candidateId: "g",
      displayName: "Jane Own",
      state: "TX",
      storedWebsite: "https://jane.example",
      storedFormerWebsites: [countyPage],
      website: "https://jane.example",
      formerWebsites: [],
      strippedUrls: [countyPage],
    });
    expect(plan.sharedButKept).toEqual([{ url: ticketSite, rows: 2, candidates: ["Amy Acton", "David Pepper"] }]);
  });

  it("--min-rows 1 also strips a shared-page URL held by a single row", () => {
    const plan = planSharedWebsiteClears([row("h", "Solo Page", "https://www.popecountyar.gov/justices-of-peace")], {
      minRows: 1,
      listedUrls: [],
    });
    expect(plan.rowChanges).toHaveLength(1);
    expect(plan.rowChanges[0]?.website).toBeNull();
  });
});

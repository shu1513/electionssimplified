import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ORGANIZATION_ID, SiteJsonLd, WEBSITE_ID } from "./SiteJsonLd";

describe("SiteJsonLd", () => {
  it("names the publisher and the site once, with contact, method, and corrections links", () => {
    const { container } = render(<SiteJsonLd />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const graph = JSON.parse(script!.textContent ?? "{}");
    expect(graph["@context"]).toBe("https://schema.org");
    const [organization, website] = graph["@graph"];
    expect(organization).toMatchObject({
      "@type": "Organization",
      "@id": ORGANIZATION_ID,
      name: "Elections Simplified",
      legalName: "Elections Simplified Inc.",
      url: "https://electionssimplified.com/",
      logo: "https://electionssimplified.com/ballot-logo.png",
      email: "contact@electionssimplified.com",
      sameAs: ["https://github.com/shu1513/electionssimplified"],
      publishingPrinciples: "https://electionssimplified.com/methodology",
      correctionsPolicy: "https://electionssimplified.com/methodology#corrections",
    });
    expect(website).toMatchObject({
      "@type": "WebSite",
      "@id": WEBSITE_ID,
      publisher: { "@id": ORGANIZATION_ID },
    });
  });
});

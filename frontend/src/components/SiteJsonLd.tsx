import { APP_NAME } from "@voteapp/api-client";
import { CONTACT_EMAIL } from "../lib/embedPublisher";
import { DEFAULT_DESCRIPTION, SITE_ORIGIN } from "../lib/pageMeta";
import { JsonLdScript } from "./JsonLdScript";

// The legal operator, as the disclaimer names it. Kept here (not only in
// docs/legal) because the Organization block below is what search and AI
// engines read to learn who stands behind every page on the site.
export const ORGANIZATION_LEGAL_NAME = "Elections Simplified Inc.";
export const SOURCE_REPOSITORY_URL = "https://github.com/shu1513/electionssimplified";
// Wikidata item for the site (created 2026-09-26). Listed in sameAs so search
// and answer engines can tie the Organization here to that entity.
export const WIKIDATA_URL = "https://www.wikidata.org/wiki/Q141564135";

// Stable @id anchors so the per-page Person/Event blocks can point at the
// publisher without repeating it, and so an engine merging many pages
// resolves them all to one organization entity.
export const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
export const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

/**
 * Site-wide Organization + WebSite JSON-LD, rendered once from the root
 * layout. Every page previously described its subject (a Person, an Event)
 * but nothing described the publisher, so an engine deciding whether to
 * cite a page had no machine-readable answer to "who runs this site, and
 * how do I reach them?". The @graph form keeps both entities in one script.
 */
export function SiteJsonLd() {
  return (
    <JsonLdScript
      data={{
        "@graph": [
          {
            "@type": "Organization",
            "@id": ORGANIZATION_ID,
            name: APP_NAME,
            legalName: ORGANIZATION_LEGAL_NAME,
            url: `${SITE_ORIGIN}/`,
            logo: `${SITE_ORIGIN}/ballot-logo.png`,
            description: DEFAULT_DESCRIPTION,
            email: CONTACT_EMAIL,
            contactPoint: {
              "@type": "ContactPoint",
              contactType: "customer support",
              email: CONTACT_EMAIL,
              url: `${SITE_ORIGIN}/mission`,
            },
            // The open-source repository is the site's one public profile
            // today; add social profile URLs here as they exist.
            sameAs: [SOURCE_REPOSITORY_URL, WIKIDATA_URL],
            // Where the method and the correction path are spelled out.
            publishingPrinciples: `${SITE_ORIGIN}/methodology`,
            correctionsPolicy: `${SITE_ORIGIN}/methodology#corrections`,
          },
          {
            "@type": "WebSite",
            "@id": WEBSITE_ID,
            name: APP_NAME,
            url: `${SITE_ORIGIN}/`,
            description: DEFAULT_DESCRIPTION,
            inLanguage: "en-US",
            publisher: { "@id": ORGANIZATION_ID },
          },
        ],
      }}
    />
  );
}

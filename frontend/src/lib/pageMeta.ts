import type { MetaDescriptor } from "react-router";
import { APP_NAME } from "@voteapp/api-client";

// Every page's head tags come from here, for one reason: React Router replaces
// the parent's meta array with the leaf route's, it does not merge them
// ("the entire meta descriptor array is replaced, not merged"). So a route that
// exports meta to set its own title silently drops the description and the
// share-card tags unless it builds the whole set. Routes call pageMeta and get
// all of it.
//
// The share-card tags matter more than they look. The way this app spreads is
// one person sending a link to another before an election, and what that person
// sees is whatever iMessage, WhatsApp, Slack, or Facebook can scrape from the
// server-rendered head. Without og:* they fall back to guesswork and render a
// bare URL — which, for an unfamiliar link about voting, reads as something to
// distrust rather than open.

/** Absolute, because scrapers do not resolve relative URLs. Matches
 * SITE_ORIGIN in render.yaml and the Sitemap line in robots.txt. */
export const SITE_ORIGIN = "https://electionssimplified.com";

// Bump the version query whenever og-card.png changes: scrapers (iMessage,
// Facebook, Slack) cache the image by URL, so a same-URL replacement keeps
// showing the old picture for weeks.
const SHARE_IMAGE = `${SITE_ORIGIN}/og-card.png?v=5`;
const SHARE_IMAGE_ALT = `${APP_NAME} — See who your candidates really are by their track records`;

export const DEFAULT_DESCRIPTION =
  "See who your candidates really are by their track records.";

type PageMetaInput = {
  title: string;
  description?: string;
  /**
   * What the link preview says, when that should differ from the tab title
   * and the search snippet. A search result answers an intent ("what's on my
   * ballot"); a card in a friend's chat has to earn a tap on its own. The
   * home page uses this: its card image already carries the whole pitch, so
   * repeating the pitch as the card text wastes the one line under it.
   * Defaults to title / description.
   */
  shareTitle?: string;
  shareDescription?: string;
  /**
   * Path with a leading slash, for routes that know their own URL. Omit it and
   * no og:url is emitted, which is deliberate: the root meta is the fallback
   * for every page without its own (the ballot, a candidate, an election), so
   * a hardcoded "/" here would tell scrapers the canonical address of a
   * candidate page is the home page. With the tag absent they use the URL they
   * fetched, which is always right.
   */
  path?: string;
  /**
   * Per-page share image, absolute URL. Defaults to the static site-wide
   * card; pages with a generated image (a shared pick card) override it so
   * the picture, not just the title, is theirs. Dimensions must stay
   * 1200×630 — the og:image:width/height tags below promise it.
   */
  image?: { url: string; alt: string };
};

export function pageMeta({
  title,
  description = DEFAULT_DESCRIPTION,
  shareTitle = title,
  shareDescription = description,
  path,
  image,
}: PageMetaInput): MetaDescriptor[] {
  const imageUrl = image?.url ?? SHARE_IMAGE;
  const imageAlt = image?.alt ?? SHARE_IMAGE_ALT;
  return [
    { title },
    { name: "description", content: description },

    // Open Graph: read by iMessage, WhatsApp, Slack, Facebook, LinkedIn.
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: APP_NAME },
    { property: "og:title", content: shareTitle },
    { property: "og:description", content: shareDescription },
    ...(path
      ? [
          { property: "og:url", content: `${SITE_ORIGIN}${path}` },
          // Canonical for the same routes that know their own URL: crawlers
          // otherwise index each query-string variant separately. Routes
          // without a path (the ballot, a draft) get none on purpose —
          // whether personalised pages should be indexed at all is a
          // separate decision.
          { tagName: "link" as const, rel: "canonical", href: `${SITE_ORIGIN}${path}` },
        ]
      : []),
    { property: "og:image", content: imageUrl },
    // Declared so the card reserves the right space before the image loads,
    // and so scrapers that refuse unsized images still render it large.
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: imageAlt },

    // X/Twitter reads its own namespace and ignores og:* for the card size.
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: shareTitle },
    { name: "twitter:description", content: shareDescription },
    { name: "twitter:image", content: imageUrl },
    { name: "twitter:image:alt", content: imageAlt },
  ];
}

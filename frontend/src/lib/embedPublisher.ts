// Publisher attribution for the newsroom embed: the code a newsroom adds to
// its snippet (data-publisher) rides in the frame URL's fragment, and
// outbound links from the box carry it as ?src= so a sign-up can be credited
// to the page it came from (lib/usage.ts records it on session_start).

import { EMBED_PUBLISHERS } from "../data/embedPublishers";

/** The one public address (docs/contact). */
export const CONTACT_EMAIL = "contact@electionssimplified.com";

export function isEmbedPublisherCode(value: string | null | undefined): value is string {
  return typeof value === "string" && EMBED_PUBLISHERS.includes(value);
}

/** Reads `#pub=<code>` and returns it only when it is an allowlisted code. */
export function publisherCodeFromHash(hash: string): string | null {
  const match = /^#pub=([a-z0-9-]{1,48})$/.exec(hash);
  return match && isEmbedPublisherCode(match[1]) ? match[1] : null;
}

export function withSource(path: string, source: string | null): string {
  if (!source) {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}src=${encodeURIComponent(source)}`;
}

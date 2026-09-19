// Lookups over the generated newsroom-embed pilot manifest
// (src/data/embedPilotCities.ts, written by `npm run embed:pilot-manifest`
// in backend/). Only cities reviewed by hand and marked enabled are served;
// everything else is a 404, which is also how a city is withdrawn.

import { isJudicialRetentionTitle } from "@voteapp/api-client";
import { EMBED_PILOT_CITIES, EMBED_PILOT_PUBLISHERS, type EmbedPilotCity } from "../data/embedPilotCities";

export type { EmbedPilotCity };

/** The one public address (docs/contact); shown in the embed footer. */
export const CONTACT_EMAIL = "contact@electionssimplified.com";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The box's race scope: the reviewed election day only, and no judicial
 * retention questions (a city can carry dozens, and they would bury the
 * contested races). Shared by the city list and the in-box draft page so the
 * two always show the same races. */
export function isEmbedListedRace(
  election: { election_date: string; race_type: string; official_ballot_title: string },
  electionDate: string
): boolean {
  return (
    election.election_date === electionDate &&
    !(election.race_type !== "ballot_measure" && isJudicialRetentionTitle(election.official_ballot_title))
  );
}

export function getEmbedPilotCity(slug: string | undefined): EmbedPilotCity | null {
  if (!slug || !SLUG.test(slug)) {
    return null;
  }
  const city = EMBED_PILOT_CITIES[slug];
  return city && city.enabled ? city : null;
}

/** Codes that render today: enabled manifest entries, cities before states.
 * Public pages list these so nobody copies a code that returns a 404. */
export function listEnabledEmbedCodes(): string[] {
  const enabled = Object.values(EMBED_PILOT_CITIES).filter((city) => city.enabled);
  return [...enabled.filter((c) => c.kind === "city"), ...enabled.filter((c) => c.kind === "state")].map((c) => c.slug);
}

/** A publisher code is honoured only when it is on the allowlist we set —
 * never free text from the URL. */
export function isEmbedPublisherCode(value: string | null | undefined): value is string {
  return typeof value === "string" && EMBED_PILOT_PUBLISHERS.includes(value);
}

/** Reads `#pub=<code>` from a location hash. The code travels in the fragment
 * so the server never sees it: one cached copy of the page serves every
 * publisher and no publisher's code can end up in another's links. */
export function publisherCodeFromHash(hash: string): string | null {
  const match = /^#pub=([a-z0-9-]{1,48})$/.exec(hash);
  return match && isEmbedPublisherCode(match[1]) ? match[1] : null;
}

/** Appends the attribution query parameter our site reads on arrival. */
export function withSource(path: string, source: string | null): string {
  if (!source) {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}src=${encodeURIComponent(source)}`;
}

// The newsroom box's front page: the site's own landing page (same masthead, same address search), framed by
// third-party pages via public/embed.js. A reader's search opens their
// ballot inside the box; from there it is the ordinary app in the box's
// chrome (lib/embedSession.ts).
//
// This route sits outside the App layout and is the only page that may be
// LOADED in a frame (the router worker allows /embed and nothing else). It has no loader: nothing here
// depends on the reader or the publisher, so one cached copy serves everyone.

import { useEffect, useRef, useState } from "react";
import type { MetaFunction } from "react-router";
import { APP_NAME } from "@voteapp/api-client";
import { LandingHero } from "../components/LandingHero";
import { publisherCodeFromHash, withSource } from "../lib/embedPublisher";
import { rememberEmbedSource, setEmbedHome, useReportEmbedHeight } from "../lib/embedSession";
import { pageMeta } from "../lib/pageMeta";

export const meta: MetaFunction = () => [
  ...pageMeta({ title: `Find what's on your ballot · ${APP_NAME}` }),
  // The site's own landing page is the canonical copy.
  { name: "robots", content: "noindex" },
];

const HOME = { path: "/embed", label: "Search" };

export function EmbedHomePage() {
  const contentRef = useRef<HTMLDivElement | null>(null);
  useReportEmbedHeight(true, contentRef);
  // Read after mount: the server HTML must be the same for every publisher.
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    setEmbedHome(HOME);
    setSource(rememberEmbedSource(publisherCodeFromHash(window.location.hash)));
  }, []);

  return (
    <div ref={contentRef} className="bg-page text-ink">
      <LandingHero framed />
      {/* The box's one credit, and the front page's one way to the site. */}
      <p className="-mt-2 pb-4 text-center text-xs text-ink-soft">
        Powered by{" "}
        <a
          href={withSource("/", source)}
          target="_blank"
          rel="nofollow noopener"
          className="font-semibold text-rausch-deep hover:underline"
        >
          {APP_NAME}
        </a>
      </p>
    </div>
  );
}

export default EmbedHomePage;

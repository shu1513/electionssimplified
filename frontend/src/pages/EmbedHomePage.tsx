// The newsroom box's front page: the site's own landing page (same masthead, same address search), framed by
// third-party pages via public/embed.js. A reader's search opens their
// ballot inside the box; from there it is the ordinary app in the box's
// chrome (lib/embedSession.ts).
//
// This route sits outside the App layout and is the only page that may be
// LOADED in a frame (the router worker allows /embed and nothing else). It has no loader: nothing here
// depends on the reader or the publisher, so one cached copy serves everyone.

import { useEffect, useRef } from "react";
import type { MetaFunction } from "react-router";
import { APP_NAME } from "@voteapp/api-client";
import { LandingHero } from "../components/LandingHero";
import { publisherCodeFromHash } from "../lib/embedPublisher";
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
  useEffect(() => {
    setEmbedHome(HOME);
    rememberEmbedSource(publisherCodeFromHash(window.location.hash));
  }, []);

  return (
    <div ref={contentRef} className="bg-page text-ink">
      <LandingHero framed />
    </div>
  );
}

export default EmbedHomePage;

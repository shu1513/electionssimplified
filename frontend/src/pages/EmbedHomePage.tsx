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
import {
  rememberEmbedSource,
  setEmbedHome,
  useReportEmbedHeight,
} from "../lib/embedSession";
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
    // The outer div fills the frame and centres the content, so when the box
    // is taller than the page (its minimum height, or a publisher's
    // data-height) the spare room is split evenly above and below. The INNER
    // div is what gets measured: the outer one is always as tall as the frame.
    <div className="flex min-h-screen flex-col justify-center bg-page text-ink">
      <div ref={contentRef}>
        <LandingHero framed />
        {/* The box's one credit, and the front page's one way to the site. Its
          bottom padding matches the headline's top padding (LandingHero), so
          the page sits evenly in the box. */}
        <p className="-mt-2 pb-7 text-center text-xs text-ink-soft sm:pb-8">
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
    </div>
  );
}

export default EmbedHomePage;

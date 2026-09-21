import { useEffect, useState } from "react";
import { Link } from "react-router";
import { APP_NAME } from "@voteapp/api-client";
import { draftPickCount, useBallotDraft } from "../lib/ballotDraft";
import { withSource } from "../lib/embedPublisher";
import { rememberEmbedSource } from "../lib/embedSession";
import { useGuestDraftNav } from "../lib/usePickProgress";

/**
 * The box's one-line header on its inner pages: the wordmark (opens the site
 * in a new tab) and, once the reader has picked someone, the same "My Draft"
 * counter the site header shows, linking to the draft page inside the box.
 */
export function EmbedHeader() {
  const nav = useGuestDraftNav();
  // On the site a loaded ballot shows a plain "My Draft" link at zero picks.
  // Here the link is earned by the first pick.
  const draftNav = draftPickCount(useBallotDraft()) > 0 ? nav : null;
  // The new tab is a separate document: it cannot see the code this box was
  // loaded with, so the link has to carry it. After mount, like every other
  // use of the code, so nothing publisher-specific is ever server-rendered.
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    setSource(rememberEmbedSource(null));
  }, []);
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <a
        href={withSource("/", source)}
        target="_blank"
        rel="nofollow noopener"
        className="text-base font-extrabold tracking-tight text-rausch"
      >
        {APP_NAME}
      </a>
      {draftNav ? (
        <Link
          to={draftNav.to}
          className={
            draftNav.complete
              ? "whitespace-nowrap text-sm font-semibold text-green-800 hover:text-green-900"
              : "whitespace-nowrap text-sm font-medium text-ink-soft hover:text-ink"
          }
        >
          {draftNav.label}
        </Link>
      ) : null}
    </header>
  );
}

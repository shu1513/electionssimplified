import { Link } from "react-router";
import { APP_NAME } from "@voteapp/api-client";
import { draftPickCount, useBallotDraft } from "../lib/ballotDraft";
import { useGuestDraftNav } from "../lib/usePickProgress";

/**
 * The box's one-line header: the wordmark (opens the site in a new tab) and,
 * once the reader has picked someone, the same "My Draft" counter the site
 * header shows, linking to the draft page inside the box. Nothing on the
 * right before the first pick, and nothing on the server pass, so the cached
 * page is identical for every reader.
 */
export function EmbedHeader({ homeHref = "/" }: { homeHref?: string }) {
  const nav = useGuestDraftNav();
  // The box's draft always has a race list behind it (the city's), which on
  // the site would show a plain "My Draft" link at zero picks. Here the link
  // is earned by the first pick.
  const draftNav = draftPickCount(useBallotDraft()) > 0 ? nav : null;
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <a href={homeHref} target="_blank" rel="nofollow noopener" className="text-base font-extrabold tracking-tight text-rausch">
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

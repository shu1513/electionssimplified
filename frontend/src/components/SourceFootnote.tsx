import { Fragment } from "react";
import { groupSourcesByHost } from "@voteapp/api-client";
import { sourceLinkProps, track } from "../lib/usage";

const onSourceClick = (url: string) => () =>
  track("official_source_click", { kind: "election_source", ...sourceLinkProps(url) });

// One-line provenance footnote for a list of source URLs: each site named
// once, linked to its first page; further pages from the same site hang off
// it as small numbered links, so nothing is hidden but "elections.ny.gov"
// never prints twice. Records and results keep SourceLine (their legal
// per-record line carries a researched date); this is for the free-form
// election / measure source lists, which are not legally required and so
// should cost the reader as little as possible.

type SourceFootnoteProps = {
  urls: string[];
  className?: string;
  /** Short text put before "Source:" on the same line ("Filings as of …"),
   * so a date and its source do not stack as two separate lines. */
  lead?: string;
};

export function SourceFootnote({ urls, className, lead }: SourceFootnoteProps) {
  const groups = groupSourcesByHost(urls);
  if (groups.length === 0) return null;
  const single = groups.length === 1 && groups[0].urls.length === 1;
  return (
    <p className={`text-xs text-ink-soft${className ? ` ${className}` : ""}`}>
      {lead ? `${lead} · ` : null}
      {single ? "Source:" : "Sources:"}{" "}
      {groups.map((group, index) => (
        <Fragment key={group.host}>
          {index > 0 ? " · " : null}
          <a
            href={group.urls[0]}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onSourceClick(group.urls[0])}
            className="underline hover:text-ink"
          >
            {group.host}
          </a>
          {group.urls.slice(1).map((url, extra) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${group.host}, page ${extra + 2}`}
              onClick={onSourceClick(url)}
              className="ml-0.5 align-super text-[10px] underline hover:text-ink"
            >
              {extra + 2}
            </a>
          ))}
        </Fragment>
      ))}
    </p>
  );
}

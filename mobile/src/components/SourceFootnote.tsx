import { Fragment } from "react";
import { Text } from "react-native";
import { groupSourcesByHost } from "@voteapp/api-client";
import { openExternalUrl } from "../lib/openExternalUrl";

// One-line provenance footnote for a list of source URLs (web twin in
// frontend/src/components/SourceFootnote.tsx): each site named once,
// linked to its first page; further pages from the same site hang off it as
// small numbered links. Records and results keep SourceLine.

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
    <Text className={`text-xs text-ink-soft${className ? ` ${className}` : ""}`}>
      {lead ? `${lead} · ` : null}
      {single ? "Source:" : "Sources:"}{" "}
      {groups.map((group, index) => (
        <Fragment key={group.host}>
          {index > 0 ? " · " : null}
          <Text className="underline" accessibilityRole="link" onPress={() => openExternalUrl(group.urls[0])}>
            {group.host}
          </Text>
          {group.urls.slice(1).map((url, extra) => (
            <Text
              key={url}
              className="text-[10px] underline"
              accessibilityRole="link"
              accessibilityLabel={`${group.host}, page ${extra + 2}`}
              onPress={() => openExternalUrl(url)}
            >
              {" "}
              {extra + 2}
            </Text>
          ))}
        </Fragment>
      ))}
    </Text>
  );
}

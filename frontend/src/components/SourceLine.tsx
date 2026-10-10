import { formatSourceHost } from "@voteapp/api-client";
import { sourceLinkProps, track } from "../lib/usage";

// Per-record provenance line required by the legal copy:
// "Source: [link]".

type SourceLineProps = {
  url: string;
  /** What the line documents, for the official_source_click usage event. */
  kind?: "record_source" | "result_source";
};

export function SourceLine({ url, kind = "record_source" }: SourceLineProps) {
  return (
    <p className="mt-1 text-sm text-ink-soft">
      <span className="font-semibold">Source:</span>{" "}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => track("official_source_click", { kind, ...sourceLinkProps(url) })}
        className="underline hover:text-ink"
      >
        {formatSourceHost(url)}
      </a>
    </p>
  );
}

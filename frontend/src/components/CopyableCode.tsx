import { useEffect, useRef, useState } from "react";

const COPIED_MS = 2000;

/**
 * A line of code with a copy button at its right edge, for instructions a
 * non-technical reader follows by pasting. The button reports what happened
 * in its own label ("Copied" / "Copy failed"), and the code stays selectable
 * for browsers that refuse clipboard access.
 */
export function CopyableCode({ code, label }: { code: string; label: string }) {
  const [status, setStatus] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), COPIED_MS);
  }

  return (
    <div className="flex items-stretch overflow-hidden rounded-lg border border-line bg-surface text-sm">
      <pre className="min-w-0 flex-1 overflow-x-auto p-3">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label}
        title={label}
        className="flex shrink-0 items-center gap-1.5 border-l border-line px-3 font-medium text-ink-soft transition hover:bg-page hover:text-ink"
      >
        {status === "copied" ? (
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 text-green-800" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="7" y="7" width="10" height="10" rx="2" />
            <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
          </svg>
        )}
        <span aria-live="polite" className="text-xs">
          {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}
        </span>
      </button>
    </div>
  );
}

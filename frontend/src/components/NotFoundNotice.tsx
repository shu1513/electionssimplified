import { useEffect } from "react";
import { Link } from "react-router";
import { track } from "../lib/usage";

/** Not-found body for detail-route ErrorBoundaries (loader threw 404). */
export function NotFoundNotice({ subject }: { subject: "Election" | "Candidate" | "Pick card" | "State" | "District" }) {
  useEffect(() => {
    track("error_shown", { category: "not_found" });
  }, []);
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 text-center">
      <h1 className="text-title font-bold">{subject} not found</h1>
      <p className="mt-2 text-ink-soft">It may have been removed, or the link may be wrong.</p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
      >
        Find your ballot
      </Link>
    </div>
  );
}

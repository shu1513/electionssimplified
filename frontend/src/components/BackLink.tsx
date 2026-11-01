import { Link, useLocation, useNavigate } from "react-router";
import { useHydrated } from "../lib/useHydrated";

/** The state a link into a BackLink page may carry. */
export type BackLinkState = {
  /** Where the labeled back control points: "← {label}". */
  backTo?: { path: string; label: string };
  /** The path the link was followed FROM. When it is backTo.path itself, the
   * labeled control pops history instead of pushing a second copy of that
   * page — otherwise Mission → How it works → "← Mission" → "← Back" would
   * bounce between the two pages forever. */
  from?: string;
};

/**
 * Back control for the secondary pages (Methodology, Mission, Settings, My
 * Candidates). A link that arrives with `state.backTo` gets a labeled
 * "← {label}"; any other in-app arrival gets a plain "← Back" that pops
 * history. A cold load shows nothing — there is nowhere to go.
 *
 * Both reads are client-only, so they wait for hydration (location.state
 * survives a reload via history.state while SSR rendered without it).
 * "In-app arrival" is the router's own location key: the first entry of a
 * session keeps the key "default" (a reload of a later entry keeps its own
 * key, with the entry before it still there to pop to), and history.length
 * would not do — it counts forward entries too, so after cold load →
 * elsewhere → browser Back it would offer a Back with nowhere to go.
 */
export function BackLink() {
  const hydrated = useHydrated();
  const { state, key } = useLocation() as { state?: BackLinkState; key: string };
  const navigate = useNavigate();
  if (!hydrated) return null;
  const backTo = state?.backTo;
  const inAppArrival = key !== "default";
  if (!backTo && !inAppArrival) return null;
  // Pop only when the previous entry is known to be the labeled page (the
  // link said it came from there, and there is an entry to pop to). A
  // labeled link from anywhere else keeps the push: a pop could land
  // somewhere other than the label says.
  const pops = backTo !== undefined && state?.from === backTo.path && inAppArrival;
  const className = "inline-block text-sm font-semibold text-ink-soft transition hover:text-ink";
  return (
    <nav aria-label="Back" className="mb-2">
      {backTo && pops ? (
        <button type="button" aria-label={`Back to ${backTo.label}`} onClick={() => navigate(-1)} className={className}>
          <span aria-hidden="true">← </span>
          {backTo.label}
        </button>
      ) : backTo ? (
        <Link to={backTo.path} aria-label={`Back to ${backTo.label}`} className={className}>
          <span aria-hidden="true">← </span>
          {backTo.label}
        </Link>
      ) : (
        <button type="button" onClick={() => navigate(-1)} className={className}>
          <span aria-hidden="true">← </span>
          Back
        </button>
      )}
    </nav>
  );
}

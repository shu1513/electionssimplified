import { Link, useLocation, useNavigate } from "react-router";
import { useHydrated } from "../lib/useHydrated";

/**
 * Back control for the secondary pages (Methodology, Mission, Settings, My
 * Candidates). A link that arrives with `state.backTo` gets a labeled
 * "← {label}"; any other in-app arrival gets a plain "← Back" that pops
 * history. A cold load shows nothing — there is nowhere to go.
 *
 * Both reads are client-only, so they wait for hydration (location.state
 * survives a reload via history.state while SSR rendered without it).
 * "In-app arrival" is the router's own history index, not history.length:
 * length counts forward entries too, so after cold load → elsewhere →
 * browser Back it would offer a Back with nowhere to go.
 */
export function BackLink() {
  const hydrated = useHydrated();
  const { state } = useLocation() as { state?: { backTo?: { path: string; label: string } } };
  const navigate = useNavigate();
  if (!hydrated) return null;
  const backTo = state?.backTo;
  const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  if (!backTo && historyIndex === 0) return null;
  const className = "inline-block text-sm font-semibold text-ink-soft transition hover:text-ink";
  return (
    <nav aria-label="Back" className="mb-2">
      {backTo ? (
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

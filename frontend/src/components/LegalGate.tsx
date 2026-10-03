import { Link } from "react-router";
import { useAdoptPreHydrationChecked } from "../lib/preHydrationInput";

// Clickwrap checkbox (Meyer v. Uber / Nguyen / Berman requirements):
// unchecked by default, sits directly above the action it gates, visible
// links adjacent to the checkbox, and the caller disables its action button
// until `checked` is true. This component is controlled so pages decide what
// acceptance feeds — today the register payload and the re-acceptance
// interstitial, both of which gate an explicit account action and so keep the
// checkbox inline on the page.
//
// The anonymous pre-search gate does NOT use this: a search is a low-intent
// action taken by first-time visitors, so its clickwrap is deferred to the
// moment Search is pressed. See PreSearchTermsDialog.

type LegalGateProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  inputId: string;
  /** Open the document links in a new tab — for a gate inside a dialog, where
   * following a link in place would discard the dialog and what it holds. */
  linksInNewTab?: boolean;
};

export function LegalGate({ label, checked, onChange, inputId, linksInNewTab = false }: LegalGateProps) {
  // A click that lands before hydration checks the DOM box without reaching
  // state; adopt it so the gated action unlocks. Still a user action — the
  // clickwrap record is unaffected.
  useAdoptPreHydrationChecked(inputId, onChange);
  const linkTarget = linksInNewTab ? { target: "_blank", rel: "noreferrer" } : {};
  return (
    <div className="rounded-xl border border-line bg-surface p-4 text-sm text-ink">
      <label htmlFor={inputId} className="flex cursor-pointer items-start gap-3">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-rausch"
        />
        <span>{label}</span>
      </label>
      <p className="mt-2 flex flex-wrap gap-x-4 pl-7 font-medium">
        <Link to="/terms" {...linkTarget} className="text-ink underline hover:text-rausch">
          Terms of Use
        </Link>
        <Link to="/privacy" {...linkTarget} className="text-ink underline hover:text-rausch">
          Privacy Policy
        </Link>
        <Link to="/disclaimer" {...linkTarget} className="text-ink underline hover:text-rausch">
          {/* Full title, matching the checkbox labels word-for-word. */}
          AI Research and Election Information Disclaimer
        </Link>
      </p>
    </div>
  );
}

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useId } from "react";
import { ADDRESS_FIELD_PRIVACY_NOTE, PRE_SEARCH_CHECKBOX_LABEL } from "@voteapp/api-client";
import { track } from "../lib/usage";

// The anonymous clickwrap, deferred to the moment it gates something: the
// ballot page opens it over a first search's results (BallotPage,
// termsPending), and the results are read only after agreement. The landing
// page carries no checkbox and no legal box — assent is asked for when the
// visitor is about to get the service, which is where the clickwrap cases put
// it (Meyer v. Uber). The weak pattern is notice sitting apart from the action
// — Nicosia v. Amazon turned on exactly that.
//
// Requirements this encodes:
// - checkbox starts empty, every single time the dialog opens
// - the action stays disabled until it is ticked
// - all three documents are named in the label and linked next to it. With
//   arbitration no longer called out on this screen (see
//   PRE_SEARCH_CHECKBOX_LABEL), those links carry the whole of the notice:
//   named, adjacent, and reachable before agreeing. Nothing here may move to
//   the footer or turn into a bare "Terms" label.
// - the button names what it does ("Agree and show results"), not "Continue"
// - documents open in a new tab, so reading one does not discard the dialog
//   or the results behind it
// - Cancel, Escape, and the backdrop close without agreeing to anything (the
//   ballot page then leaves the results)
//
// The body carries the one privacy line and nothing else. The two disclaimer
// paragraphs (PRE_SEARCH_AGREEMENT_PARAGRAPHS) came out on 2026-09-28: they
// restated the linked Disclaimer as scare copy at the moment of assent, and
// the same warning still reaches every reader on the results page
// (VERIFY_WITH_OFFICIALS_NOTE) — the audience that never saw a dialog at
// all. Presentation-only, no version bump; see docs/legal/checkbox-copy.md.
//
// Built on Headless UI's Dialog like ReportContentButton: focus trapping,
// Escape, and scroll locking come from the library.

const DOCUMENT_LINKS = [
  { label: "Terms of Use", href: "/terms", doc: "terms" },
  { label: "Privacy Policy", href: "/privacy", doc: "privacy" },
  // Full document title, matching the checkbox label word-for-word: the label
  // says "AI Research and Election Information Disclaimer", so a bare
  // "Disclaimer" link would leave the reader unsure it is the same document.
  { label: "AI Research and Election Information Disclaimer", href: "/disclaimer", doc: "disclaimer" },
] as const;

type PreSearchTermsDialogProps = {
  open: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onAgree: () => void;
  onCancel: () => void;
};

export function PreSearchTermsDialog({ open, checked, onCheckedChange, onAgree, onCancel }: PreSearchTermsDialogProps) {
  const checkboxId = useId();
  return (
    <Dialog open={open} onClose={onCancel} className="relative z-40">
      <DialogBackdrop className="fixed inset-0 bg-ink/40" />
      <div className="fixed inset-0 overflow-y-auto p-4">
        <div className="flex min-h-full items-center justify-center">
          <DialogPanel className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <DialogTitle className="text-lg font-bold text-ink">Your elections are ready</DialogTitle>
            {/* One short, true privacy line, not a restatement of Privacy
                Policy Section 1 — the policy itself is linked below. */}
            <p className="mt-3 text-sm text-ink-soft">{ADDRESS_FIELD_PRIVACY_NOTE}</p>

            <div className="mt-4 rounded-xl border border-line bg-surface p-4 text-sm text-ink">
              <label htmlFor={checkboxId} className="flex cursor-pointer items-start gap-3">
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => onCheckedChange(event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 accent-rausch"
                />
                <span>{PRE_SEARCH_CHECKBOX_LABEL}</span>
              </label>
              <p className="mt-2 flex flex-wrap gap-x-4 pl-7 font-medium">
                {DOCUMENT_LINKS.map((document) => (
                  <a
                    key={document.href}
                    href={document.href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => track("terms_doc_open", { doc: document.doc })}
                    className="text-ink underline hover:text-rausch"
                  >
                    {document.label}
                  </a>
                ))}
              </p>
            </div>

            <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-line px-4 py-2.5 font-semibold text-ink transition hover:bg-surface"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onAgree}
                disabled={!checked}
                className="rounded-lg bg-rausch px-5 py-2.5 font-semibold text-white transition hover:bg-rausch-dark disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-rausch"
              >
                Agree and show results
              </button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

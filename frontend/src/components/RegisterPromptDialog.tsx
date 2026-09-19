import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { draftHandoffFragment, useBallotDraft } from "../lib/ballotDraft";
import { withSource } from "../lib/embedPilot";
import { rememberEmbedSource, useEmbedSession } from "../lib/embedSession";
import { track } from "../lib/usage";

// Shared login/register prompt for logged-out visitors who click a
// members-only control (follow, pick). The trigger button lives in the
// caller — this is only the dialog. Both links carry the current page as
// the post-auth return path so the visitor lands back here to complete the
// action (login honors ?next=; the register flow forwards it as far as the
// email hop allows).

type RegisterPromptDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Names the action the visitor just tried, e.g. "Follow Jane Doe". */
  title: string;
  /** One-sentence pitch for signing up; rendered in the dialog's body row. */
  description: React.ReactNode;
  /** Which members-only control opened it, for the signup_prompt usage event. */
  source: "follow" | "pick" | "autopick" | "draft";
};

export function RegisterPromptDialog({ open, onClose, title, description, source }: RegisterPromptDialogProps) {
  const next = encodeURIComponent(useLocation().pathname);
  // Inside the newsroom box these links open the site in a new tab, where the
  // box's draft is out of reach (the frame has its own storage) — so the
  // picks ride along in the URL fragment (lib/ballotDraft.ts, draft handoff).
  const draft = useBallotDraft();
  const embedSession = useEmbedSession();
  const handoff = embedSession ? draftHandoffFragment(draft) : "";
  // The publisher code keeps the sign-up attributed to the box it came from.
  const publisher = embedSession ? rememberEmbedSource(null) : null;
  useEffect(() => {
    if (open) {
      track("signup_prompt", { source, action: "shown" });
    }
  }, [open, source]);

  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-ink/30" />
      <div className="fixed inset-0 flex items-center justify-center px-4 py-6">
        <DialogPanel className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <DialogTitle className="text-lg font-semibold text-ink">{title}</DialogTitle>
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-ink-soft hover:text-ink"
            >
              Close
            </button>
          </div>
          <p className="mt-2 text-sm text-ink">{description}</p>
          <div className="mt-4 flex items-center justify-end gap-3">
            <Link
              to={`${withSource(`/login?next=${next}`, publisher)}${handoff}`}
              onClick={() => track("signup_prompt", { source, action: "click" })}
              className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              Log in
            </Link>
            <Link
              to={`${withSource(`/register?next=${next}`, publisher)}${handoff}`}
              onClick={() => track("signup_prompt", { source, action: "click" })}
              className="rounded-lg bg-rausch px-4 py-2 text-sm font-semibold text-white hover:bg-rausch-dark"
            >
              Sign up
            </Link>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

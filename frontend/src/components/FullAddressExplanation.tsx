import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { ADDRESS_FIELD_PRIVACY_NOTE } from "@voteapp/api-client";
import { useState } from "react";

/**
 * Explains why an exact street address is necessary without adding another
 * block of text to the landing page. This is informational, not consent, so
 * it deliberately has no checkbox or "Agree" action.
 */
export function FullAddressExplanation({
  onOpen,
  // The anonymous search puts the trigger inside its field label's
  // parenthesis ("(why full address)"); other surfaces keep the question.
  triggerLabel = "Why full address?",
}: { onOpen?: () => void; triggerLabel?: string } = {}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
        className="rounded-sm text-left underline hover:text-rausch focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rausch"
      >
        {triggerLabel}
      </button>

      <Dialog open={open} onClose={setOpen} className="relative z-40">
        <DialogBackdrop className="fixed inset-0 bg-ink/40" />
        <div className="fixed inset-0 overflow-y-auto p-4">
          <div className="flex min-h-full items-center justify-center">
            <DialogPanel className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
              <DialogTitle className="text-lg font-bold text-ink">
                Why do you need the full address?
              </DialogTitle>
              <div className="mt-3 space-y-3 text-sm text-ink-soft">
                {/* Wording approved 2026-10-10: two sentences, no ZIP-fallback
                    paragraph (the field label already says "address or ZIP"). */}
                <p>
                  Your voting districts don’t follow ZIP codes. Two homes in the same ZIP can vote in different races.
                </p>
                <p>
                  {ADDRESS_FIELD_PRIVACY_NOTE} Our source code is open and public{" "}
                  <a
                    href="https://github.com/shu1513/electionssimplified"
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink underline hover:text-rausch"
                  >
                    here
                  </a>
                  .
                </p>
                <p>
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink underline hover:text-rausch"
                  >
                    Read our Privacy Policy
                  </a>
                </p>
              </div>

              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg bg-rausch px-5 py-2.5 font-semibold text-white transition hover:bg-rausch-dark"
                >
                  Got it
                </button>
              </div>
            </DialogPanel>
          </div>
        </div>
      </Dialog>
    </>
  );
}

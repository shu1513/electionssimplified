import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { isDecidedChoice, useElectionChoices, useMe } from "@voteapp/api-client";
import {
  flushBallotDraftToAccount,
  isDraftHandoffHash,
  mergeDraftHandoff,
  parseDraftHandoff,
  type DraftHandoff,
} from "../lib/ballotDraft";
import { savePendingDistrictIds } from "../lib/pendingDistricts";

/**
 * Receives the picks a reader carried over from the newsroom box ("Save" in
 * the box opens the site with them in the URL fragment; lib/ballotDraft.ts).
 *
 * - Guest, or an account that is not verified yet: the picks join this
 *   browser's draft, and an exact ballot's districts arm the usual
 *   guest-to-account handoff. The normal flush saves them after sign-up.
 * - Signed in and verified: a link must never write into an account by
 *   itself, so the reader is asked first. Saying yes adds only the races the
 *   account has not decided; saying no drops them.
 *
 * Either way the fragment is cleared at once, so it never lingers in the
 * address bar or the history.
 */
export function DraftHandoffGate() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const { choiceByElectionId } = useElectionChoices();
  const [pending, setPending] = useState<DraftHandoff | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (me === undefined || !isDraftHandoffHash(location.hash)) {
      return;
    }
    const handoff = parseDraftHandoff(location.hash);
    if (handoff) {
      if (me?.email_verified) {
        setPending(handoff);
      } else {
        mergeDraftHandoff(handoff);
        if (handoff.districtIds.length > 0) {
          savePendingDistrictIds(handoff.districtIds);
        }
      }
    }
    void navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true, state: location.state });
  }, [me, location.hash, location.pathname, location.search, location.state, navigate]);

  // The account's own picks decide what is new; wait for them before asking.
  const decided = new Set(
    [...(choiceByElectionId ?? new Map())].filter(([, choice]) => isDecidedChoice(choice)).map(([id]) => id)
  );
  const fresh = pending ? pending.rows.filter((row) => !decided.has(row.election_id)) : [];
  const ready = pending !== null && choiceByElectionId !== undefined;

  // Nothing new to add: no question to ask.
  useEffect(() => {
    if (ready && fresh.length === 0) {
      setPending(null);
    }
  }, [ready, fresh.length]);

  function close() {
    if (!saving) {
      setPending(null);
      setFailed(false);
    }
  }

  async function add() {
    if (!pending) {
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      mergeDraftHandoff(pending, decided);
      await flushBallotDraftToAccount();
      await queryClient.invalidateQueries({ queryKey: ["me", "election-choices"] });
      setPending(null);
    } catch {
      // The picks are in this browser's draft now; the usual flush retries them.
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={ready && fresh.length > 0} onClose={close} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-ink/30" />
      <div className="fixed inset-0 flex items-center justify-center px-4 py-6">
        <DialogPanel className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-xl">
          <DialogTitle className="text-lg font-semibold text-ink">Add your picks?</DialogTitle>
          <p className="mt-2 text-sm text-ink">
            You made {fresh.length} {fresh.length === 1 ? "pick" : "picks"} on another website. Add{" "}
            {fresh.length === 1 ? "it" : "them"} to your account?
          </p>
          {failed ? (
            <p role="alert" className="mt-2 text-sm text-rausch-deep">
              That did not work. Please try again.
            </p>
          ) : null}
          <div className="mt-4 flex items-center justify-end gap-3">
            <button type="button" onClick={close} disabled={saving} className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink">
              Not now
            </button>
            <button
              type="button"
              onClick={add}
              disabled={saving}
              className="rounded-lg bg-rausch px-4 py-2 text-sm font-semibold text-white hover:bg-rausch-dark disabled:opacity-50"
            >
              {saving ? "Adding…" : "Add picks"}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

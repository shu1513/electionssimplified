import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useRef, useState } from "react";
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

// A signed-in reader's handoff waits for their answer, and the question can
// only be asked once their account's picks have loaded. Until then it is kept
// here as well as in memory, so a failed request followed by a reload does
// not silently lose their picks. Session storage: this tab only, gone with it.
const STASH_KEY = "voteapp_pending_handoff";

function stash(hash: string | null): void {
  try {
    if (hash === null) {
      sessionStorage.removeItem(STASH_KEY);
    } else {
      sessionStorage.setItem(STASH_KEY, hash);
    }
  } catch {
    // Storage unavailable: the in-memory copy still serves this page view.
  }
}

function readStash(): DraftHandoff | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    return raw ? parseDraftHandoff(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Receives the picks a reader carried over from the newsroom box ("Save" in
 * the box opens the site with them in the URL fragment; lib/ballotDraft.ts).
 *
 * - Guest: the picks join this browser's draft, and if the draft took the
 *   handoff's ballot, its districts arm the usual guest-to-account handoff.
 *   The normal flush saves everything after sign-up.
 * - Signed in (verified or not: any signed-in account can save picks): a link
 *   must never write into an account by itself, so the reader is asked first.
 *   Yes adds only the races the account has not decided; no drops them.
 *
 * Either way the fragment is cleared at once, so it never lingers in the
 * address bar or the history.
 */
export function DraftHandoffGate() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const { choiceByElectionId, isError: choicesFailed } = useElectionChoices();
  const [pending, setPending] = useState<DraftHandoff | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Clearing the fragment is a navigation, which lands a moment later; until
  // then this effect can run again with the same hash. Handle each hash once.
  const handledHash = useRef<string | null>(null);

  useEffect(() => {
    if (me === undefined) {
      return;
    }
    if (!isDraftHandoffHash(location.hash)) {
      // No arrival on this page view: pick up one an earlier view left behind.
      if (me !== null) {
        const stashed = readStash();
        if (stashed) {
          setPending((current) => current ?? stashed);
        }
      } else {
        stash(null);
      }
      return;
    }
    if (handledHash.current === location.hash) {
      return;
    }
    handledHash.current = location.hash;
    try {
      const handoff = parseDraftHandoff(location.hash);
      if (handoff && me !== null) {
        stash(location.hash);
        setPending(handoff);
      } else if (handoff) {
        const { adoptedDistricts } = mergeDraftHandoff(handoff);
        // Only the ballot the draft actually took: a guest who already has
        // their own keeps it, and the account must start from the same one.
        if (adoptedDistricts) {
          savePendingDistrictIds(handoff.districtIds);
        }
      }
    } finally {
      // Whatever happened above, the fragment goes: a bad one must not be
      // retried on every reload.
      void navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true, state: location.state });
    }
  }, [me, location.hash, location.pathname, location.search, location.state, navigate]);

  // The account's own picks decide what is new; wait for them before asking.
  const decided = new Set(
    [...(choiceByElectionId ?? new Map())].filter(([, choice]) => isDecidedChoice(choice)).map(([id]) => id)
  );
  const fresh = pending ? pending.rows.filter((row) => !decided.has(row.election_id)) : [];
  const ready = pending !== null && choiceByElectionId !== undefined;
  // The account's picks could not be loaded: say so and offer a retry, rather
  // than showing nothing while the picks sit unseen.
  const blocked = pending !== null && !ready && choicesFailed;

  function drop() {
    stash(null);
    setPending(null);
    setFailed(false);
  }

  // Nothing new to add: no question to ask.
  useEffect(() => {
    if (ready && fresh.length === 0) {
      drop();
    }
  }, [ready, fresh.length]);

  function close() {
    if (!saving) {
      drop();
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
      drop();
    } catch {
      // The picks are in this browser's draft now; the usual flush retries them.
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={(ready && fresh.length > 0) || blocked} onClose={close} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-ink/30" />
      <div className="fixed inset-0 flex items-center justify-center px-4 py-6">
        <DialogPanel className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-xl">
          <DialogTitle className="text-lg font-semibold text-ink">Add your picks?</DialogTitle>
          {blocked ? (
            <p role="alert" className="mt-2 text-sm text-ink">
              You made picks on another website, but we could not check your account&apos;s picks.
            </p>
          ) : (
            <p className="mt-2 text-sm text-ink">
              You made {fresh.length} {fresh.length === 1 ? "pick" : "picks"} on another website. Add{" "}
              {fresh.length === 1 ? "it" : "them"} to your account?
            </p>
          )}
          {failed ? (
            <p role="alert" className="mt-2 text-sm text-rausch-deep">
              That did not work. Please try again.
            </p>
          ) : null}
          <div className="mt-4 flex items-center justify-end gap-3">
            <button type="button" onClick={close} disabled={saving} className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink">
              Not now
            </button>
            {blocked ? (
              <button
                type="button"
                onClick={() => void queryClient.refetchQueries({ queryKey: ["me", "election-choices"] })}
                className="rounded-lg bg-rausch px-4 py-2 text-sm font-semibold text-white hover:bg-rausch-dark"
              >
                Try again
              </button>
            ) : (
              <button
                type="button"
                onClick={add}
                disabled={saving}
                className="rounded-lg bg-rausch px-4 py-2 text-sm font-semibold text-white hover:bg-rausch-dark disabled:opacity-50"
              >
                {saving ? "Adding…" : "Add picks"}
              </button>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

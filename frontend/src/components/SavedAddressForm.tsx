import { useState } from "react";
import { useNavigate } from "react-router";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { ADDRESS_FIELD_PRIVACY_NOTE, apiRequest } from "@voteapp/api-client";
import type { AddressLocation, BallotSummary } from "@voteapp/api-client";
import { AddressAutocomplete } from "./AddressAutocomplete";
import { ErrorNotice } from "./Status";

type AddressSaveResult = BallotSummary & { matched_address?: string; address_match_count?: number };

// Only what the confirmation renders. Router state is copied into
// window.history.state and can outlive the navigation (refresh, session
// restore), so the home address's exposure is kept minimal and the ballot
// payload — which GET /api/me/ballot re-derives anyway — stays out entirely.
export type AddressSavedNoticeData = {
  matched_address?: string;
  address_match_count?: number;
};

// Router state carried to /me/ballot after a successful save; the saved
// ballot page renders <AddressSavedNotice> from it, then wipes the history
// entry so the notice shows once instead of replaying on refresh/back.
export type AddressSavedLocationState = { addressSaved: AddressSavedNoticeData };

// Saves the account's home address and replaces the saved districts. Used by
// the settings "Your address" section and the saved-ballot empty state. A
// successful save navigates to the saved ballot so the user lands on the
// election list for their new districts; the confirmation (including the
// ambiguous-match warning) travels along as router state.

export function SavedAddressForm({ inputId, label }: { inputId: string; label: string }) {
  const [address, setAddress] = useState("");
  // Coordinates for the CURRENT address value, present only right after a
  // completed autocomplete selection. Any manual edit passes no location and
  // clears them, so stale coordinates never ride along with a different
  // address string. Sent with the PUT so an address the Census geocoder has
  // no street range for (a new subdivision) still resolves — the same
  // coordinate-first path the landing page search takes.
  const [addressLocation, setAddressLocation] = useState<AddressLocation | null>(null);
  // True while a picked suggestion's retrieve is in flight: the input already
  // shows the description, but its coordinates have not landed, so a quick
  // Enter would save the bare string and lose the coordinate path.
  const [retrievePending, setRetrievePending] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const update = useMutation({
    mutationKey: ["put-address"],
    mutationFn: (submitted: { address: string; coordinates: AddressLocation | null }) =>
      apiRequest<AddressSaveResult>("/api/me/address", {
        method: "PUT",
        body: {
          address: submitted.address,
          ...(submitted.coordinates ? { coordinates: submitted.coordinates } : {}),
        },
      }),
    onSuccess: (saved) => {
      // The PUT returns a plain district ballot, but GET /api/me/ballot
      // applies saved sort preferences and followed-candidate ordering —
      // refetch the canonical version instead of caching the PUT body.
      void queryClient.invalidateQueries({ queryKey: ["me", "ballot"] });
      // The pick gate's district set (useMyDistricts) just changed with the
      // saved districts — refetch it or stale ids keep gating pick buttons.
      void queryClient.invalidateQueries({ queryKey: ["me", "districts"] });
      void navigate("/me/ballot", {
        state: {
          addressSaved: {
            matched_address: saved.matched_address,
            address_match_count: saved.address_match_count,
          },
        } satisfies AddressSavedLocationState,
      });
    },
  });
  // Cross-mount in-flight guard, same as the other full-replace preference
  // writes: the PUT replaces ALL saved districts, so a submit from a
  // remounted form (or the sibling form on another screen) must wait for the
  // older request to settle or the earlier address could win.
  const saving = useIsMutating({ mutationKey: ["put-address"] }) > 0;

  function onAddressChange(next: string, location?: AddressLocation | null) {
    // Editing starts a new attempt: drop the previous save's error so it
    // cannot read as status for the address being typed.
    if (!update.isIdle && !update.isPending) {
      update.reset();
    }
    setAddress(next);
    setAddressLocation(location ?? null);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // `saving` is from the last render; re-check the mutation cache so a
        // submit landing before the disabling re-render cannot start a
        // second overlapping PUT.
        if (!address.trim() || retrievePending || queryClient.isMutating({ mutationKey: ["put-address"] }) > 0) {
          return;
        }
        update.mutate({ address: address.trim(), coordinates: addressLocation });
      }}
      className="mt-3 space-y-3"
    >
      <div>
        <label htmlFor={inputId} className="block text-sm font-medium text-ink">
          {label}
        </label>
        <AddressAutocomplete
          inputId={inputId}
          value={address}
          onChange={onAddressChange}
          onRetrievePendingChange={setRetrievePending}
          placeholder="1600 Pennsylvania Avenue NW, Washington, DC 20500"
        />
        <p className="mt-1 text-xs text-ink-soft">{ADDRESS_FIELD_PRIVACY_NOTE}</p>
      </div>
      <button
        type="submit"
        disabled={!address.trim() || saving || retrievePending}
        className="w-full rounded-md bg-rausch px-4 py-3 font-semibold text-white transition hover:bg-rausch-dark disabled:cursor-not-allowed disabled:bg-line"
      >
        {saving ? "Saving…" : "Save address"}
      </button>
      {update.isError ? <ErrorNotice error={update.error} /> : null}
    </form>
  );
}

// Post-save confirmation rendered on the saved ballot page from the router
// state the form navigates with. The PUT succeeds silently server-side, so
// this line is the user's only textual feedback on what was matched. The
// copy leads with election districts, not "address saved", because that is
// what the account keeps: user_districts has no address column. The
// "not your address" clause is scoped to the profile ("saved in your
// profile") on purpose — the backend keeps a 14-day geocoder cache (see
// addressResolutionCache.ts) which the privacy policy discloses, so an
// absolute "we never save your address" would be false.
export function AddressSavedNotice({ saved }: { saved: AddressSavedNoticeData }) {
  return (
    <p role="status" className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink">
      Your election districts are updated
      {saved.matched_address ? <> from <strong>{saved.matched_address}</strong></> : null}. Only the new
      election districts were saved in your profile — not your address.
      {typeof saved.address_match_count === "number" && saved.address_match_count > 1 ? (
        // The geocoder returned multiple candidates and saved the first —
        // a silently wrong match here replaces the user's whole ballot.
        <>
          {" "}Your address matched {saved.address_match_count} possible locations and the first one was
          used — if the matched address is not yours, save again with your full street address, city, and ZIP
          code.
        </>
      ) : null}
    </p>
  );
}

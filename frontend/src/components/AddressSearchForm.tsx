import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, TERMS_VERSION, useMe } from "@voteapp/api-client";
import type { AddressLocation, AddressResolution } from "@voteapp/api-client";
import { AddressAutocomplete } from "./AddressAutocomplete";
import { FullAddressExplanation } from "./FullAddressExplanation";
import { PreSearchTermsDialog } from "./PreSearchTermsDialog";
import { ErrorNotice } from "./Status";
import { clearPendingDistrictIds, savePendingDistrictIds } from "../lib/pendingDistricts";
import { hasCurrentTermsAcceptance, rememberTermsAcceptance } from "../lib/termsAcceptance";
import { errorCategoryOf, track } from "../lib/usage";

// Below Tailwind's sm breakpoint the landing swaps the autofocused cursor
// for the in-box search glyph. matchMedia is absent in SSR and jsdom, where
// the answer must be "not a phone": the prerendered HTML keeps the autofocus
// attr and tests keep the desktop default.
function isPhoneWidth(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(max-width: 639px)").matches;
}

/**
 * The address search: field with suggestions, Search button, the terms
 * dialog on a browser's first search, and the hop to the ballot page. One
 * component so the landing page and the newsroom box run the SAME search
 * (same clickwrap, same partial-ballot paths, same usage events).
 *
 * "landing" is the home page's centred, Google-style form with its focus
 * helpers; "compact" is a tighter form for the box, with no focus grabbing
 * (it sits inside someone else's article).
 */
export function AddressSearchForm({
  variant,
  label,
  grabFocus = true,
}: {
  variant: "landing" | "compact";
  label: string;
  /** Landing only: focus the field on load and catch stray typing. Off inside
   * the newsroom box, where it would pull the host page to the box. */
  grabFocus?: boolean;
}) {
  const landing = variant === "landing";
  const focusHelpers = landing && grabFocus;
  const navigate = useNavigate();
  const { me } = useMe();
  const [address, setAddress] = useState("");
  // Coordinates for the CURRENT address value, present only right after a
  // completed autocomplete selection. Any manual edit passes no location and
  // clears them, so stale coordinates can never ride along with a different
  // address string.
  const [addressLocation, setAddressLocation] = useState<AddressLocation | null>(null);
  // Set right after the autocomplete selection was an area with a known
  // state (city, neighborhood, county): the search runs the region
  // partial-ballot path. Any edit clears it, like coordinates.
  const [regionSelection, setRegionSelection] = useState<{ state: string; locality: string | null } | null>(null);
  // True right after an area selection the server could not place in a state
  // (a country pick, a territory) — nothing to search, so the form shows
  // guidance instead of letting the submit die in the geocoder. Any edit
  // clears it.
  const [regionUnsupported, setRegionUnsupported] = useState(false);
  // True while a picked suggestion's retrieve is in flight: the input
  // already shows the description, but its classification (coordinates /
  // ZIP / region) has not landed, so a quick Enter would send a bare area
  // string to the geocoder and 422.
  const [retrievePending, setRetrievePending] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  // The dialog's checkbox. Reset to false every time the dialog opens, never
  // seeded from storage: remembering may decide whether the dialog opens, and
  // nothing more. A box that arrives pre-ticked shows assent nobody gave.
  const [accepted, setAccepted] = useState(false);
  // Usage analytics bookkeeping (docs/plans/usage-analytics.md): first real
  // input once per visit, whether the current value came from a suggestion,
  // and how long the terms dialog stayed open. Refs — none of it renders.
  const inputTracked = useRef(false);
  const lastGranularity = useRef<"address" | "zip" | "region" | "unsupported" | null>(null);
  const termsOpenedAt = useRef<number | null>(null);
  const termsOpenMs = () => (termsOpenedAt.current === null ? 0 : Math.round(performance.now() - termsOpenedAt.current));

  // Google-style stray-typing catch: a click on empty page space moves focus
  // off the address box, and the next keystrokes would silently go nowhere.
  // A printable key pressed outside any editable field refocuses the box and
  // the browser then inserts the character there natively (no preventDefault,
  // no manual value writing). Deliberately narrow:
  //  - single printable characters only; space is excluded (it scrolls the
  //    page or activates a focused button, and hijacking it breaks both),
  //  - no Cmd/Ctrl/Alt chords, no IME composition, nothing already handled,
  //  - never while typing in an input/textarea/select/contenteditable (the
  //    address box itself, the chat widget),
  //  - never from inside any role="dialog" overlay — this page does not own
  //    them all (TermsRenewalGate for stale signed-in terms, the chat panel
  //    for signed-in visitors), and a letter pressed on a modal's button must
  //    not drop focus behind the overlay,
  //  - never while the terms dialog is open (belt for the case above while
  //    its focus trap is still settling).
  // Registered per-render but removed on cleanup, so the listener exists
  // only while the landing page is mounted.
  useEffect(() => {
    if (!focusHelpers) {
      return;
    }
    function redirectStrayTyping(e: KeyboardEvent) {
      if (termsOpen || e.defaultPrevented || e.isComposing) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (e.key.length !== 1 || e.key === " ") {
        return;
      }
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          target.closest('[role="dialog"]') !== null)
      ) {
        return;
      }
      document.getElementById("address")?.focus();
    }
    document.addEventListener("keydown", redirectStrayTyping);
    return () => document.removeEventListener("keydown", redirectStrayTyping);
  }, [focusHelpers, termsOpen]);

  // Desktop keeps the Google-style cursor-in-box on load, but via an effect
  // rather than the autoFocus prop: React SSRs autoFocus as a real autofocus
  // attribute, which browsers honor before hydration — on phones that meant
  // a focused box underneath the search glyph (the pre-hydration focus never
  // reaches React's focused state) plus a server/client markup mismatch. The
  // markup is now identical everywhere and focus is applied only where it is
  // wanted: at phone widths the box stays idle so the glyph shows —
  // Google's mobile pattern (no keyboard over the page).
  useEffect(() => {
    if (focusHelpers && !isPhoneWidth()) {
      document.getElementById("address")?.focus();
    }
  }, [focusHelpers]);

  const resolve = useMutation({
    mutationFn: async (input: {
      address: string;
      coordinates: AddressLocation | null;
      region: { state: string; locality: string | null } | null;
    }) => {
      // The address_result usage event is recorded here, inside the mutation
      // function, so it lands even if this page unmounts before the reply.
      // It carries outcome and latency only — never the address.
      const started = performance.now();
      try {
        // The accepted version rides along because the endpoint enforces the
        // clickwrap too, refusing a search that carries no current acceptance.
        // Nothing is stored server-side; the disabled button is a courtesy, and
        // the endpoint is the actual gate. Coordinates (from the autocomplete
        // selection, when present) let the backend resolve venue addresses the
        // Census street data lacks.
        const resolution = await apiRequest<AddressResolution>("/api/address/resolve", {
          method: "POST",
          body: {
            address: input.address,
            accepted_terms_version: TERMS_VERSION,
            // Opt in to the ZIP/region partial-ballot paths: this page renders
            // the partial banner and scope-aware errors, so a bare ZIP or a
            // picked city gets a partial ballot here instead of a dead-end 422.
            allow_partial: true,
            ...(input.coordinates ? { coordinates: input.coordinates } : {}),
            ...(input.region
              ? {
                  region_state: input.region.state,
                  ...(input.region.locality ? { region_locality: input.region.locality } : {}),
                }
              : {}),
          },
        });
        track("address_result", {
          outcome: resolution.scope === "zip" || resolution.scope === "region" ? resolution.scope : "exact",
          latency_ms: Math.round(performance.now() - started),
        });
        return resolution;
      } catch (error) {
        track("address_result", {
          outcome: "error",
          latency_ms: Math.round(performance.now() - started),
          error_category: errorCategoryOf(error),
        });
        throw error;
      }
    },
    onSuccess: (resolution) => {
      // Stash for the anonymous-to-account handoff: if this visitor signs up,
      // these districts become their saved ballot once they verify. Save only
      // when identity is KNOWN to be logged out or unverified — while /api/me
      // is still loading (me === undefined) a verified user's one-off search
      // must not re-arm the handoff.
      if (resolution.scope === "exact") {
        if (me === null || me?.email_verified === false) {
          savePendingDistrictIds(resolution.districts.map((district) => district.id));
        }
      } else {
        // A partial (ZIP) result must not become a signed-up account's
        // saved ballot — the account would be permanently incomplete with
        // nothing recording why. Clearing instead of skipping keeps "last
        // search wins": a stale exact set from an earlier search must not
        // initialize an account the visitor thinks reflects this one.
        // Unconditional, unlike the save: the identity guard exists so a
        // verified user's one-off search cannot ARM the handoff — clearing
        // is harmless in every identity state, including still-loading.
        clearPendingDistrictIds();
      }
      // Straight to the elections — the districts list is a detour nobody asked for.
      // The matched address rides along in router state (never the URL — it is
      // personal data) so the ballot page can show which address was geocoded.
      // partial=1 IS in the URL (it carries no location) so a refresh or a
      // shared link still labels the ballot as partial.
      const query = `d=${resolution.districts.map((district) => district.id).join(",")}`;
      navigate(`/ballot?${query}${resolution.scope !== "exact" ? "&partial=1" : ""}`, {
        state: {
          matchedAddress: resolution.matched_address,
          addressMatchCount: resolution.address_match_count,
          // Lets the partial banner name the search ("ZIP code 91706" vs
          // "Los Angeles, CA, USA"); a bare link renders generic wording.
          scope: resolution.scope,
        },
      });
    },
    onError: () => {
      // Surface the failure on the page rather than inside the dialog. The
      // acceptance is already recorded, so the retry goes straight through
      // instead of asking the visitor to agree a second time.
      setTermsOpen(false);
    },
  });

  // A stateless region selection can only fail (no coordinates, no state,
  // and the string is an area the geocoder can't match), so Search disables
  // while the guidance below the field explains what to do; any edit
  // re-enables.
  const canSearch = address.trim().length > 0 && !resolve.isPending && !regionUnsupported && !retrievePending;

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSearch) {
      return;
    }
    // Form submit, not the button: Enter and the click are the same intent.
    track("address_submit", { via_suggestion: lastGranularity.current !== null });
    // Storage is read here, in the handler, and never during render: reading
    // it while rendering would diverge from the server-rendered HTML.
    if (hasCurrentTermsAcceptance()) {
      resolve.mutate({ address: address.trim(), coordinates: addressLocation, region: regionSelection });
      return;
    }
    setAccepted(false);
    termsOpenedAt.current = performance.now();
    track("terms_shown");
    setTermsOpen(true);
  }

  function agreeAndSearch() {
    if (!accepted || resolve.isPending) {
      return;
    }
    track("terms_decision", { decision: "agree", open_ms: termsOpenMs() });
    // Recorded before the request, so a failed search does not re-ask for an
    // agreement the visitor already gave.
    rememberTermsAcceptance();
    resolve.mutate({ address: address.trim(), coordinates: addressLocation, region: regionSelection });
  }

  function cancelTerms() {
    if (resolve.isPending) {
      return;
    }
    track("terms_decision", { decision: "cancel", open_ms: termsOpenMs() });
    setTermsOpen(false);
    setAccepted(false);
    // The typed address is deliberately left alone — cancelling the terms is
    // not a request to retype an address.
  }

  return (
    <>
        <form onSubmit={onSubmit} className={landing ? "space-y-4" : undefined}>
          <div>
            {/* The anonymous label is an instruction, not a field name: it
                tells a first-time visitor what typing here gets them. Signed
                -in surfaces (settings, saved ballot) keep the plain "Your
                address" — those users already know. "Home address" was
                rejected as a demand for where you sleep, "Voting address"
                read as the place you go to vote. */}
            {/* The label promises the outcome; the parenthetical below the
                field carries both reassurances — privacy, and that a ZIP or
                city is enough — so the visitor who won't type where they
                live learns the escape hatch BEFORE giving up. */}
            <label
              htmlFor="address"
              className={landing ? "block pb-px pl-[18px] text-sm font-semibold text-ink-soft" : "block pb-1 text-sm font-semibold text-ink"}
            >
              {label}
            </label>
            <AddressAutocomplete
              inputId="address"
              value={address}
              onChange={(value, location, granularity, region) => {
                setAddress(value);
                setAddressLocation(location ?? null);
                setRegionSelection(granularity === "region" && region ? region : null);
                setRegionUnsupported(granularity === "region" && !region);
                if (granularity) {
                  const picked = granularity === "region" && !region ? "unsupported" : granularity;
                  lastGranularity.current = picked;
                  track("address_suggestion", { granularity: picked });
                } else {
                  // Any edit is freehand again; the first 3+ characters mark
                  // real input (the autocomplete threshold), once per visit.
                  lastGranularity.current = null;
                  if (!inputTracked.current && value.trim().length >= 3) {
                    inputTracked.current = true;
                    track("address_input");
                  }
                }
              }}
              onRetrievePendingChange={setRetrievePending}
              searchIconWhenIdle={landing}
              pill={landing}
            />
            {/* text-sm + the deep brand step: the 12px/rausch-dark pairing
                failed APCA for an error the visitor must act on. */}
            {regionUnsupported ? (
              <p role="alert" className="mt-1 text-sm text-rausch-deep">
                We can’t place that selection in a state. Pick a street address, city, or ZIP
                code from the suggestions.
              </p>
            ) : null}
            {/* Google-sized: a small centered button right under the pill box,
                not a full-width bar competing with the field. The privacy note
                sits below it so the box-and-button pair reads as one unit. */}
            <div className={landing ? "mt-4 flex justify-center box:mt-[11px]" : "mt-2"}>
              <button
                type="submit"
                disabled={!canSearch}
                // Disabled keeps the brand color at reduced opacity: the old
                // gray-out read as broken rather than "accept the terms first".
                className={`rounded-md bg-rausch text-sm font-semibold text-white transition hover:bg-rausch-dark disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-rausch ${landing ? "px-8 py-2" : "px-4 py-1.5"}`}
              >
                {resolve.isPending ? "Searching…" : "Search"}
              </button>
            </div>
            {/* Notice belongs here, not only in the dialog: the autocomplete
                forwards what is typed after three characters, so collection
                starts while the visitor types and long before Search. */}
            {/* One link, not two. The Privacy Policy is still reachable at the
                point of collection — the footer carries it on every page, and
                the explainer below links it directly — so the inline copy of
                it was noise beside the question people actually ask. */}
            {/* Compressed variant of ADDRESS_FIELD_PRIVACY_NOTE plus the
                coarse-input hint: same two promises (district lookup only,
                never saved), short enough to be read. Other surfaces keep
                the full constant. */}
            <p className={landing ? "mt-4 text-center text-xs text-ink-soft" : "mt-2 text-xs text-ink-soft"}>
              The address is only used to find voting districts. You can also search by ZIP or
              city, with fewer local races.{" "}
              <FullAddressExplanation
                onOpen={() => track("why_address_open", { after_input: address.trim().length > 0 })}
              />
            </p>
          </div>
        </form>

        {resolve.isError ? (
          <div className="mt-4">
            <ErrorNotice error={resolve.error} />
          </div>
        ) : null}

      <PreSearchTermsDialog
        open={termsOpen}
        checked={accepted}
        onCheckedChange={setAccepted}
        onAgree={agreeAndSearch}
        onCancel={cancelTerms}
        pending={resolve.isPending}
      />
    </>
  );
}

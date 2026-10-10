import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, TERMS_VERSION, useMe } from "@voteapp/api-client";
import type { AddressLocation, AddressResolution } from "@voteapp/api-client";
import { AddressAutocomplete } from "./AddressAutocomplete";
import { FullAddressExplanation } from "./FullAddressExplanation";
import { ErrorNotice } from "./Status";
import { clearPendingDistrictIds, savePendingDistrictIds } from "../lib/pendingDistricts";
import { errorCategoryOf, track } from "../lib/usage";

// The three documents the search notice names, each name linking to its
// document. The disclaimer keeps its full title so the reader knows the link
// and the sentence mean the same document.
const DOCUMENT_LINKS = {
  terms: { href: "/terms", label: "Terms of Use" },
  privacy: { href: "/privacy", label: "Privacy Policy" },
  disclaimer: { href: "/disclaimer", label: "AI Research and Election Information Disclaimer" },
} as const;

function NoticeLink({ doc }: { doc: keyof typeof DOCUMENT_LINKS }) {
  const document = DOCUMENT_LINKS[doc];
  return (
    // A new tab, so reading a document does not discard the typed address.
    <Link
      to={document.href}
      target="_blank"
      rel="noreferrer"
      onClick={() => track("terms_doc_open", { doc })}
      className="text-ink underline hover:text-rausch"
    >
      {document.label}
    </Link>
  );
}

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
 * The address search: field with suggestions, Search button, the agreement
 * notice under it, and the hop to the ballot page. Pressing Search is the
 * visitor's assent to the three documents the notice names (a sign-in wrap:
 * see PRE_SEARCH_NOTICE in legalCopy.ts), so every search carries the
 * current terms version and nothing asks again. One component so the landing
 * page and the newsroom box run the SAME search (same partial-ballot paths,
 * same usage events, same notice).
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
  const [regionSelection, setRegionSelection] = useState<{
    state: string;
    locality: string | null;
    postalCode: string | null;
  } | null>(null);
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
  // Usage analytics bookkeeping (docs/plans/usage-analytics.md): first real
  // input once per visit, and whether the current value came from a
  // suggestion. Refs — none of it renders.
  const inputTracked = useRef(false);
  const lastGranularity = useRef<"address" | "zip" | "region" | "unsupported" | null>(null);

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
  //    not drop focus behind the overlay.
  // Registered per-render but removed on cleanup, so the listener exists
  // only while the landing page is mounted.
  useEffect(() => {
    if (!focusHelpers) {
      return;
    }
    function redirectStrayTyping(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) {
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
  }, [focusHelpers]);

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
      region: { state: string; locality: string | null; postalCode: string | null } | null;
    }) => {
      // The address_result usage event is recorded here, inside the mutation
      // function, so it lands even if this page unmounts before the reply.
      // It carries outcome and latency only — never the address.
      const started = performance.now();
      try {
        // The accepted version rides along only when this browser holds one:
        // a first search runs before agreement, and the ballot page asks for
        // it over the results. The endpoint serves a search without the
        // field and refuses a stale version. Coordinates (from the
        // autocomplete selection, when present) let the backend resolve
        // venue addresses the Census street data lacks.
        const resolution = await apiRequest<AddressResolution>("/api/address/resolve", {
          method: "POST",
          body: {
            address: input.address,
            // Pressing Search, with the notice under the button, is the
            // assent this records. Nothing is stored server-side.
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
                  ...(input.region.postalCode ? { region_postal_code: input.region.postalCode } : {}),
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
    resolve.mutate({
      address: address.trim(),
      coordinates: addressLocation,
      region: regionSelection,
    });
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
            {/* The label names ZIP as an alternative and carries the
                "why full address" explainer in a parenthesis, so the visitor
                who won't type where they live learns the escape hatch before
                giving up. The explainer button sits beside the <label>, not
                inside it: a button inside a label would join the field's
                accessible name and is a labelable element in its own right. */}
            <div className={landing ? "pb-px pl-[18px] text-sm font-semibold text-ink-soft" : "pb-1 text-sm font-semibold text-ink"}>
              <label htmlFor="address">{label}</label>{" "}
              <span className="whitespace-nowrap font-normal">
                (
                <FullAddressExplanation
                  triggerLabel="why full address"
                  onOpen={() => track("why_address_open", { after_input: address.trim().length > 0 })}
                />
                ):
              </span>
            </div>
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
                not a full-width bar competing with the field. The agreement
                line sits under it. The address-handling promise lives in the
                explainer (label) and the Privacy Policy link in the agreement
                line, both at the point of collection. */}
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
            {/* The agreement, in the same block as the button it names
                (sign-in wrap, Meyer v. Uber): pressing Search is the assent.
                Never a bare "Terms" link, never moved to the footer — notice
                apart from the action is the pattern that fails (Nicosia v.
                Amazon). Wording is PRE_SEARCH_NOTICE from legalCopy.ts word
                for word, with each document name as its link;
                HomePage.test.tsx checks the rendered text against it. */}
            <p
              data-testid="pre-search-notice"
              className={landing ? "mt-2 text-center text-xs text-ink-soft" : "mt-2 text-xs text-ink-soft"}
            >
              By clicking Search you agree to the <NoticeLink doc="terms" />, <NoticeLink doc="privacy" />, and{" "}
              <NoticeLink doc="disclaimer" />.
            </p>
          </div>
        </form>

        {resolve.isError ? (
          <div className="mt-4">
            <ErrorNotice error={resolve.error} />
          </div>
        ) : null}
    </>
  );
}

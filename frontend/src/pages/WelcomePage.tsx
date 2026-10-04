import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { MetaFunction } from "react-router";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APP_NAME, apiRequest, useMe } from "@voteapp/api-client";
import type { ResearchAreaCatalog, ResearchAreaPreferencesResult } from "@voteapp/api-client";
import { ResearchAreaPicker } from "../components/ResearchAreaPicker";
import { toPreferenceInputs, type RankedResearchArea } from "../lib/rankedResearchAreas";
import { ErrorNotice, LoadingNotice } from "../components/Status";
import { markWelcomeSeen } from "../lib/welcomeSeen";
import { safeInternalPath } from "../lib/safeInternalPath";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { countBucket, track } from "../lib/usage";

export const meta: MetaFunction = () => [{ title: `Welcome · ${APP_NAME}` }];

// Post-signup onboarding: pick the issues that drive ballot ordering, then
// rank them. Two steps on purpose — with pick and rank on one screen (the
// settings layout) new users tapped issues and saved without noticing the
// ranking half. Login routes verified users here once, when they have no
// saved areas and have not skipped. Unlike settings, edits stay local and
// save as one PUT on "Save and continue" — a brand-new user exploring the
// list shouldn't fire a network write per tap.

type Step = "pick" | "rank";

export function WelcomePage() {
  useDocumentTitle("Welcome");
  const { me, isLoading, isError: meError, refetch: refetchMe } = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Where the step hands off when saved or skipped: the page a visitor
  // signed in from mid-task (login forwards its ?next= here), else the
  // ballot. Internal paths only, same as login.
  const [searchParams] = useSearchParams();
  const destination = safeInternalPath(searchParams.get("next")) ?? "/me/ballot";
  const [ranked, setRanked] = useState<RankedResearchArea[]>([]);
  const [step, setStep] = useState<Step>("pick");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef<Step>(step);

  // Both steps render their primary button at the same position, so React
  // reuses the DOM node: without this, Enter on "Next" leaves a keyboard
  // user focused on "Save and continue" with the ranking rows already behind
  // them — Tab reaches Back/Skip, never the rows. Focusing the new heading
  // restarts the tab order at the top of the step and announces it.
  useEffect(() => {
    if (previousStep.current !== step) {
      previousStep.current = step;
      headingRef.current?.focus();
    }
  }, [step]);

  const catalog = useQuery({
    queryKey: ["research-areas"],
    queryFn: () => apiRequest<ResearchAreaCatalog>("/api/research-areas"),
    staleTime: 5 * 60_000,
  });

  const save = useMutation({
    // Same mutation key as the settings editor: both are full-list replaces
    // of the same resource, so their in-flight guards must see each other.
    mutationKey: ["put-research-area-preferences"],
    mutationFn: (next: RankedResearchArea[]) =>
      apiRequest<ResearchAreaPreferencesResult>("/api/me/research-area-preferences", {
        method: "PUT",
        body: { preferences: toPreferenceInputs(next) },
      }),
    onSuccess: (saved, next) => {
      track("welcome_result", { action: "save", step: "rank", ranked_count_bucket: countBucket(next.length) });
      queryClient.setQueryData(["me", "research-area-preferences"], saved);
      // Saving completes the step just as firmly as skipping does: without
      // the flag, clearing every preference in settings later would make
      // the next login mistake this user for a brand-new one.
      if (me) {
        markWelcomeSeen(me.email);
      }
      // The saved ballot is server-sorted by these preferences, and the
      // ballot-preferences default can flip to my_areas on first save.
      void queryClient.invalidateQueries({ queryKey: ["me", "ballot"] });
      void queryClient.invalidateQueries({ queryKey: ["me", "ballot-preferences"] });
      // replace, not push: the step is transient — Back from the ballot
      // must not reopen a blank welcome screen.
      navigate(destination, { replace: true });
    },
  });
  // Cross-mount in-flight guard, same as the settings editor: these PUTs are
  // full-list replaces sharing one mutation key, so controls stay locked
  // until any older write settles. (Render value — saveAndContinue re-checks
  // the mutation cache imperatively to close the gap before this re-renders.)
  const saving = useIsMutating({ mutationKey: ["put-research-area-preferences"] }) > 0;

  function saveAndContinue() {
    // Checked against the mutation cache, not the rendered `saving` value: a
    // second click in the same tick as the first — or an in-flight settings
    // PUT from another mount — would otherwise race this full-list replace.
    if (queryClient.isMutating({ mutationKey: ["put-research-area-preferences"] }) > 0) {
      return;
    }
    save.mutate(ranked);
  }

  // The step needs a verified session (the preferences endpoint is
  // verified-only). Anyone else lands somewhere sensible instead of a wall:
  // logged-out visitors at login, unverified users at their ballot, where
  // the existing verification interstitial takes over.
  useEffect(() => {
    if (me === null) {
      navigate("/login", { replace: true });
    } else if (me && !me.email_verified) {
      navigate("/me/ballot", { replace: true });
    }
  }, [me, navigate]);

  if (meError) {
    // /api/me failed for a non-auth reason (network, 5xx): without this the
    // !me guard below would spin forever. Same recovery as the saved ballot.
    return (
      <div className="mx-auto max-w-md px-4 py-10 space-y-4 text-center">
        <p className="text-ink-soft">We couldn't check your session. Please try again.</p>
        <button
          type="button"
          onClick={() => void refetchMe()}
          className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
        >
          Retry
        </button>
      </div>
    );
  }
  if (isLoading || !me || !me.email_verified) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <LoadingNotice text="Loading…" />
      </div>
    );
  }

  function skip() {
    track("welcome_result", { action: "skip", step, ranked_count_bucket: countBucket(ranked.length) });
    if (me) {
      markWelcomeSeen(me.email);
    }
    navigate(destination, { replace: true });
  }

  function goTo(next: Step) {
    setStep(next);
    // The pool grid can run well below the fold; the next step starts at
    // its own heading, not wherever the last tap left the page.
    window.scrollTo(0, 0);
  }

  const primaryButton =
    "rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark disabled:cursor-not-allowed disabled:bg-line";
  const linkButton = "text-sm text-ink-soft underline hover:text-ink";

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
        Step {step === "pick" ? 1 : 2} of 2
      </p>
      {step === "pick" ? (
        <>
          <h1 ref={headingRef} tabIndex={-1} className="mt-1 text-title font-bold">
            {me.first_name ? `Welcome, ${me.first_name}!` : "Welcome!"}
          </h1>
          <p className="mt-2 text-base font-medium text-ink">
            First, choose the issues you care about. You can change this any time in Settings.
          </p>
        </>
      ) : (
        <>
          <h1 ref={headingRef} tabIndex={-1} className="mt-1 text-title font-bold">
            Put my issues in order
          </h1>
          <p className="mt-2 text-base font-medium text-ink">
            Drag to arrange them, most important first. Choose &ldquo;Must&rdquo; if you will not
            accept a candidate or ballot measure that takes the opposite stance.
          </p>
        </>
      )}

      {catalog.isPending ? <LoadingNotice text="Loading issues…" /> : null}
      {catalog.isError ? (
        <div className="mt-4">
          <ErrorNotice error={catalog.error} />
        </div>
      ) : null}
      {catalog.isSuccess ? (
        <ResearchAreaPicker
          areas={catalog.data.research_areas}
          ranked={ranked}
          disabled={saving}
          onChange={setRanked}
          layout={step === "pick" ? "pool" : "ranked"}
        />
      ) : null}

      <div className="mt-8 flex items-center gap-4">
        {step === "pick" ? (
          <>
            <button type="button" disabled={ranked.length === 0} onClick={() => goTo("rank")} className={primaryButton}>
              Next
            </button>
            <button type="button" onClick={skip} className={linkButton}>
              Skip for now
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={ranked.length === 0 || saving} onClick={saveAndContinue} className={primaryButton}>
              {save.isPending ? "Saving…" : "Save and continue"}
            </button>
            <button type="button" disabled={saving} onClick={() => goTo("pick")} className={linkButton}>
              Back
            </button>
            <button type="button" disabled={saving} onClick={skip} className={linkButton}>
              Skip for now
            </button>
          </>
        )}
      </div>
      {save.isError ? (
        <div className="mt-4">
          <ErrorNotice error={save.error} />
        </div>
      ) : null}
    </div>
  );
}

export default WelcomePage;

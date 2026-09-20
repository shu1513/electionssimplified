import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { MetaFunction } from "react-router";
import { APP_NAME, useMe } from "@voteapp/api-client";
import { AddressSearchForm } from "../components/AddressSearchForm";
import { pageMeta } from "../lib/pageMeta";

/** The one-line claim under the hero; also the share card's second line. */
const TAGLINE = "Factual, nonpartisan, AI-assisted research with linked sources";

// Server-rendered head for the home page: the same title useDocumentTitle
// sets after hydration, so crawlers see it in the HTML rather than the root's
// bare brand. The share card says something else on purpose: its image is
// the hero sentence, so the text under it asks the question that sentence
// answers, and the second line is the page's own claim of what this is,
// not the pitch a third time.
export const meta: MetaFunction = () =>
  pageMeta({
    title: `Find what's on your ballot · ${APP_NAME}`,
    shareTitle: `What did these candidates actually do? · ${APP_NAME}`,
    shareDescription: TAGLINE,
    path: "/",
  });
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function HomePage() {
  useDocumentTitle("Find what's on your ballot");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { me } = useMe();

  // Returning verified users land on their saved ballot; ?new=1 is the
  // escape hatch for a one-off anonymous search.
  const oneOffSearch = searchParams.get("new") !== null;
  useEffect(() => {
    if (me?.email_verified && !oneOffSearch) {
      navigate("/me/ballot", { replace: true });
    }
  }, [me, oneOffSearch, navigate]);


  return (
    <>
      {/* Google-style masthead: the wordmark moved out of the shared header
          (App.tsx hides it on "/" only) and sits centred above the pitch, so
          the landing reads as one white canvas — the grey band and its border
          are gone, and there is one brand mark, not a big one plus a small
          duplicate in the corner. */}
      <div className="mx-auto max-w-2xl px-4 pt-6 text-center sm:pt-8">
        {/* Not a link (it would link to this page) and not a heading (the h1
            is the pitch, and two h1-ish marks would fight). text-wordmark
            interpolates 32 -> 52px — a text wordmark this long can't carry
            Google's ~90px image-logo scale without wrapping on phones. */}
        <p className="text-wordmark font-extrabold tracking-tight text-rausch">{APP_NAME}</p>
        {/* One sentence, still the whole pitch. 23 -> 35px: one notch above
            the shared text-title (22 -> 32px) because this is a masthead, not
            a page heading, while keeping a clear step below the wordmark;
            text-balance stops the centred wrap from ragging into a one-word
            last line. */}
        <h1 className="mt-6 text-balance text-[clamp(1.4375rem,1.1875rem+1.25vw,2.1875rem)] font-bold leading-[1.2]">
          See who the candidates in your elections really are by their track records
        </h1>
        {/* What the service is, where a first-time visitor actually looks.
            Centred with the rest of the masthead — one alignment axis for
            mark, pitch, and claim; the form below keeps its own left-aligned
            label/input convention. Size and ink-mid set it apart as a
            standalone claim (ink-soft failed APCA for a must-read line). */}
        {/* 16.5 -> 18.5px: a hair under text-body (17 -> 19px). */}
        <p className="mt-3 text-[clamp(1.03125rem,0.9896rem+0.2083vw,1.15625rem)] font-medium leading-relaxed text-ink-mid">
          {TAGLINE}
        </p>
      </div>
      <div className="mx-auto max-w-2xl px-4 pt-[13px] pb-8">
        <AddressSearchForm variant="landing" label="Enter address to see which elections you can vote in:" />
      </div>
    </>
  );
}

export default HomePage;

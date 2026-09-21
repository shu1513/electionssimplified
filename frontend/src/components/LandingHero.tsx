import { APP_NAME } from "@voteapp/api-client";
import { AddressSearchForm } from "./AddressSearchForm";

/** The one-line claim under the hero; also the share card's second line. */
export const TAGLINE = "Factual, nonpartisan, AI-assisted research with linked sources";

/**
 * The landing page's masthead and address search. Shared by the site's home
 * page and the newsroom box's front page (pages/EmbedHomePage.tsx), so the
 * box opens on the same page the site does. `framed`: the box sits inside
 * someone else's article, so it drops the big wordmark and the search never
 * grabs focus (autofocus there would scroll the host page).
 */
export function LandingHero({ framed = false }: { framed?: boolean }) {
  return (
    <>
      {/* Google-style masthead: the wordmark moved out of the shared header
          (App.tsx hides it on "/" only) and sits centred above the pitch, so
          the landing reads as one white canvas — the grey band and its border
          are gone, and there is one brand mark, not a big one plus a small
          duplicate in the corner. */}
      {/* Framed, the headline is the first thing in the box (no wordmark above
          it), so it gets a little more air from the box's top edge. Inside the
          box every gap is a step of one golden-ratio ladder, each about 1.618x
          the one below: 7px (label to field), 11px (headline to tagline,
          field to button), 18px (between blocks), 29px (the box's edges). The
          `box:` values are margins tuned so the MEASURED text-to-text gaps
          land on those steps; line-height adds the rest. */}
      <div className={`mx-auto max-w-2xl px-4 text-center ${framed ? "pt-7" : "pt-6 sm:pt-8"}`}>
        {/* Not a link (it would link to this page) and not a heading (the h1
            is the pitch, and two h1-ish marks would fight). text-wordmark
            interpolates 32 -> 52px — a text wordmark this long can't carry
            Google's ~90px image-logo scale without wrapping on phones. */}
        {/* Not inside the newsroom box: that space is the publisher's, and
            the box credits the site in a small line at the bottom instead
            (pages/EmbedHomePage.tsx). */}
        {framed ? null : <p className="text-wordmark font-extrabold tracking-tight text-rausch">{APP_NAME}</p>}
        {/* One sentence, still the whole pitch. 23 -> 35px: one notch above
            the shared text-title (22 -> 32px) because this is a masthead, not
            a page heading, while keeping a clear step below the wordmark;
            text-balance stops the centred wrap from ragging into a one-word
            last line. */}
        <h1 className={`${framed ? "" : "mt-6 "}text-balance text-[clamp(1.4375rem,1.1875rem+1.25vw,2.1875rem)] font-bold leading-[1.2]`}>
          See who the candidates in your elections really are by their track records
        </h1>
        {/* What the service is, where a first-time visitor actually looks.
            Centred with the rest of the masthead — one alignment axis for
            mark, pitch, and claim; the form below keeps its own left-aligned
            label/input convention. Size and ink-mid set it apart as a
            standalone claim (ink-soft failed APCA for a must-read line). */}
        {/* 16.5 -> 18.5px: a hair under text-body (17 -> 19px). */}
        <p className="mt-3 box:mt-[7px] text-[clamp(1.03125rem,0.9896rem+0.2083vw,1.15625rem)] font-medium leading-relaxed text-ink-mid">
          {TAGLINE}
        </p>
      </div>
      <div className="mx-auto max-w-2xl px-4 pt-[13px] pb-8 box:pt-3">
        <AddressSearchForm
          variant="landing"
          label="Enter address to see which elections you can vote in:"
          grabFocus={!framed}
        />
      </div>
    </>
  );
}

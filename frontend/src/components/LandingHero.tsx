import { AddressSearchForm } from "./AddressSearchForm";

/** The one-line claim under the hero; also the share card's second line. */
export const TAGLINE = "Factual, nonpartisan, AI-assisted research with linked sources";

/**
 * The landing page's pitch and address search. Shared by the site's home
 * page and the newsroom box's front page (pages/EmbedHomePage.tsx), so the
 * box opens on the same page the site does. `framed`: the box sits inside
 * someone else's article, so the search never grabs focus (autofocus there
 * would scroll the host page).
 */
export function LandingHero({ framed = false }: { framed?: boolean }) {
  return (
    <>
      {/* The brand mark is the shared header's small corner logo (App.tsx),
          the same as every other page, so the pitch is the first thing on the
          landing. The header drops its border on "/" so the page still reads
          as one white canvas. */}
      {/* Framed, the box has no header above the headline, so it gets a
          little more air from the box's top edge. Inside the
          box every gap is a step of one golden-ratio ladder, each about 1.618x
          the one below: 7px (label to field), 11px (headline to tagline,
          field to button), 18px (between blocks), 29px (the box's edges). The
          `box:` values are margins tuned so the MEASURED text-to-text gaps
          land on those steps; line-height adds the rest. */}
      {/* On the site the same ladder continues two steps up and frames the
          whole block: 47px from the header's logo down to the headline, 76px
          from the privacy note down to the footer's rule. From `sm` up both
          move one step higher (76px and 123px), since a wide screen has the
          height to spare and a phone does not. The paddings are
          what is left after the header's own padding (top) and the footer's
          mt-16 (bottom); the logo is a size larger from `sm` up, hence two
          top values. */}
      <div className={`mx-auto max-w-2xl px-4 text-center ${framed ? "pt-7" : "pt-[26px] sm:pt-[57px]"}`}>
        {/* One sentence, still the whole pitch. 23 -> 35px: one notch above
            the shared text-title (22 -> 32px) because this is a masthead, not
            a page heading; text-balance stops the centred wrap from ragging
            into a one-word last line. */}
        <h1 className="text-balance text-[clamp(1.4375rem,1.1875rem+1.25vw,2.1875rem)] font-bold leading-[1.2]">
          Uncover who your candidates really are by their track records
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
      <div className={`mx-auto max-w-2xl px-4 pt-[13px] box:pt-3 ${framed ? "pb-8" : "pb-3 sm:pb-[59px]"}`}>
        <AddressSearchForm
          variant="landing"
          label="Enter address to see which elections you can vote in:"
          grabFocus={!framed}
        />
      </div>
    </>
  );
}

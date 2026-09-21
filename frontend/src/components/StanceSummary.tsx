import type { CandidateRecord, RecordAreaStance, ResearchAreaPreference } from "@voteapp/api-client";
import { classifyStanceSummary } from "@voteapp/api-client";
import { CappedInlineList } from "./CappedInlineList";
import { SAVED_AREA_TEXT_CLASS } from "./ElectionCard";

// The candidate-page counterpart of the measure page's "A YES vote means" /
// "A NO vote means" boxes: green what the record supports, red what it
// opposes, amber where it splits (full width below the pair — a third
// column would squeeze all three on desktop and mixed is the box that
// needs its counts read). Only the border, fill, and heading carry the
// color; the area list itself is plain ink. Unlike a measure's one-line
// "what yes means", these bodies run to several comma-separated areas with
// counts, and a paragraph of green-on-green (or red-on-red) reads as one
// tinted block the text sinks into. Renders nothing when no area
// classifies, so a record-less or judicial-only profile gets no empty
// shell.
export function StanceSummary({
  candidateName,
  records,
  preferences,
  exposureRef,
  headingLevel = "h2",
}: {
  candidateName: string;
  records: CandidateRecord[];
  preferences: readonly ResearchAreaPreference[];
  /** section_exposed marker (the lead-in line). */
  exposureRef?: (node: Element | null) => void;
  /** h2 on the profile; h3 when nested under a judge's h2 on the election page. */
  headingLevel?: "h2" | "h3";
}) {
  const Heading = headingLevel;
  // Box titles sit one level below the section heading (h3 under the
  // profile's h2, h4 under a judge section's h3), same as TrackRecordSection.
  const BoxHeading = headingLevel === "h2" ? "h3" : "h4";
  const { supports, opposes, mixed } = classifyStanceSummary(records, preferences);
  if (supports.length === 0 && opposes.length === 0 && mixed.length === 0) {
    return null;
  }
  // The viewer's saved areas render in the shared saved-issue purple so they
  // stand out from the rest of the list, mirroring the front-of-list ordering.
  const savedAreaIds = new Set(preferences.map((preference) => preference.research_area_id));
  // Comma-separated text, not boxed chips (boxes read as buttons — same
  // rule as the roster rows). Name and count stay one text node so an
  // exact-match query for the bare area name still resolves to the record
  // group heading, not this summary.
  const areaWithCount = (area: RecordAreaStance) => {
    const count = area.for_count + area.against_count;
    const text = `${area.name} (${count} record${count === 1 ? "" : "s"})`;
    return savedAreaIds.has(area.research_area_id) ? <span className={SAVED_AREA_TEXT_CLASS}>{text}</span> : text;
  };
  const sideBox = (side: "supports" | "opposes", areas: RecordAreaStance[]) =>
    areas.length === 0 ? null : (
      <div
        className={
          side === "supports"
            ? "rounded border border-green-200 bg-green-50 p-3"
            : "rounded border border-red-200 bg-red-50 p-3"
        }
      >
        <BoxHeading
          className={
            side === "supports"
              ? "text-sm font-semibold text-green-900"
              : "text-sm font-semibold text-red-900"
          }
        >
          {side === "supports" ? "Supports" : "Opposes"}
        </BoxHeading>
        <CappedInlineList
          noun="issues"
          className="mt-1 text-sm text-ink"
          items={areas.map((area) => ({ key: area.research_area_id, node: areaWithCount(area) }))}
        />
      </div>
    );
  return (
    <section ref={exposureRef} className="mt-[18px]">
      {/* sr-only heading so the section lands in heading navigation. No
          visible lead-in: the Supports / Opposes boxes explain themselves. */}
      <Heading className="sr-only">{`Where ${candidateName} stands, based on their records`}</Heading>
      {supports.length > 0 || opposes.length > 0 ? (
        // Two columns only when both sides exist — one box alone spans the
        // full row instead of leaving an empty half.
        <div className={`grid gap-3${supports.length > 0 && opposes.length > 0 ? " sm:grid-cols-2" : ""}`}>
          {sideBox("supports", supports)}
          {sideBox("opposes", opposes)}
        </div>
      ) : null}
      {mixed.length > 0 ? (
        <div className={`${supports.length > 0 || opposes.length > 0 ? "mt-3 " : ""}rounded border border-amber-200 bg-amber-50 p-3`}>
          <BoxHeading className="text-subheading font-semibold text-amber-900">Mixed record</BoxHeading>
          {/* Same "N support · N oppose" phrasing as the record group
              headers, so the two surfaces can't drift apart. */}
          <CappedInlineList
            noun="issues"
            className="mt-1 text-sm text-ink"
            items={mixed.map((area) => {
              const text = `${area.name} (${area.for_count} support · ${area.against_count} oppose)`;
              return {
                key: area.research_area_id,
                node: savedAreaIds.has(area.research_area_id) ? <span className={SAVED_AREA_TEXT_CLASS}>{text}</span> : text,
              };
            })}
          />
        </div>
      ) : null}
    </section>
  );
}

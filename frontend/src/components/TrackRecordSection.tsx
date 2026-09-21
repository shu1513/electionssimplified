import { useState, type ReactNode } from "react";
import type { CandidateRecord, ResearchAreaPreference } from "@voteapp/api-client";
import { compareByResearchAreaPriority, EVALUATIVE_AREA_SLUGS, UNRANKED_RESEARCH_AREA_RANK } from "@voteapp/api-client";
import { RecordItem, recordStanceTag } from "./RecordItem";
import { track } from "../lib/usage";

export type RecordView = "my_issues" | "newest";

// A researched incumbent can carry 50+ records; rendering everything open
// made the profile a 10,000px wall. Grouped views start with EVERY issue
// group collapsed behind its per-group count, so the profile opens as a
// readable index of which issues the candidate has a record on and the
// reader picks what to expand; the flat newest view cuts off with an
// explicit "show all".
const INITIAL_NEWEST_RECORDS = 20;

type RecordGroup = {
  /** null only for the synthetic General group (untagged records on a
   * candidate with no real General-tagged record to join). */
  areaId: string | null;
  /** null for that synthetic group; drives the public-salience ordering. */
  areaSlug: string | null;
  areaName: string;
  records: CandidateRecord[];
};

// Records grouped by research area (a record with several tags appears under
// each). Untagged records belong to General: the real General group when the
// candidate has one (so the page never shows two general-purpose groups), or
// a synthetic "General" group otherwise — never a separate "Other records"
// bucket, which read as a category the catalog does not have. Groups key on
// the stable research_area_id — display names are presentation, not identity.
// Groups order by public salience (same ranking as election-card chips), not
// alphabetically, so the issues voters care about most lead; the synthetic
// General group stays last.
const GENERAL_AREA_SLUG = "general";

function groupRecords(records: CandidateRecord[]): RecordGroup[] {
  const groups = new Map<string | null, RecordGroup>();
  for (const record of records) {
    const areas = record.research_area_tags.length
      ? record.research_area_tags.map((tag) => ({
          areaId: tag.research_area_id,
          areaSlug: tag.slug,
          areaName: tag.name,
        }))
      : [{ areaId: null, areaSlug: null, areaName: "General" }];
    for (const area of areas) {
      const group = groups.get(area.areaId) ?? { ...area, records: [] };
      group.records.push(record);
      groups.set(area.areaId, group);
    }
  }
  const untagged = groups.get(null);
  const general = [...groups.values()].find((group) => group.areaSlug === GENERAL_AREA_SLUG);
  if (untagged && general) {
    // Rebuild from the source array so the merged group keeps the payload's
    // newest-first order — appending the untagged block would put a 2025
    // record after a 2024 one.
    const merged = new Set([...general.records, ...untagged.records].map((record) => record.id));
    general.records = records.filter((record) => merged.has(record.id));
    groups.delete(null);
  }
  return [...groups.values()].sort((a, b) =>
    a.areaId === null || a.areaSlug === null
      ? 1
      : b.areaId === null || b.areaSlug === null
        ? -1
        : compareByResearchAreaPriority(
            { slug: a.areaSlug, name: a.areaName },
            { slug: b.areaSlug, name: b.areaName }
          )
  );
}

// "My issues first": saved-area groups move to the front ordered by the
// user's rank (unranked saved areas after ranked ones), everything else
// keeps the public-salience order groupRecords produced.
function orderGroupsByPreference(
  groups: RecordGroup[],
  preferences: readonly ResearchAreaPreference[]
): RecordGroup[] {
  const rankByAreaId = new Map(
    preferences.map((preference) => [preference.research_area_id, preference.rank ?? UNRANKED_RESEARCH_AREA_RANK])
  );
  return groups
    .map((group, index) => ({
      group,
      index,
      rank: (group.areaId !== null ? rankByAreaId.get(group.areaId) : undefined) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ group }) => group);
}

// Collapsed-group stance tally: how many of the group's records are for /
// against THIS group's area (a record can lean differently per area, so the
// count must come from the group's own tag, same rule as recordStanceTag).
// Neutral-tagged records count toward neither, so the two numbers need not
// sum to the record count. The synthetic General group has no area and gets
// zeros.
function groupStanceCounts(group: RecordGroup): { forCount: number; againstCount: number } {
  let forCount = 0;
  let againstCount = 0;
  if (group.areaId != null) {
    for (const record of group.records) {
      const stance = recordStanceTag(record, group.areaId)?.stance;
      if (stance === "for") forCount += 1;
      else if (stance === "against") againstCount += 1;
    }
  }
  return { forCount, againstCount };
}

type TrackRecordSectionProps = {
  records: CandidateRecord[];
  preferences: readonly ResearchAreaPreference[];
  /** Controlled by the page: the view pick is a preference that should
   * survive moving between candidates, while this component's own
   * "show all" expansion is per-entity (key it by candidate). */
  view: RecordView;
  onViewChange: (view: RecordView) => void;
  reporterEmail?: string | null;
  /** section_exposed marker for the heading. */
  headingRef?: (node: Element | null) => void;
  /** h2 on the profile; h3 when nested under a judge's h2 on the election page. */
  headingLevel?: "h2" | "h3";
  /** Rendered instead of the section when there are no records — the two
   * pages word the gap differently (the profile knows the research date). */
  emptyState: ReactNode;
};

// The record list shared by the candidate profile and the election page's
// retention-judge section: grouped by issue (every group collapsed behind
// its stance tally) in the "My issues first" view, a flat capped list in
// "Newest first".
export function TrackRecordSection({
  records,
  preferences,
  view,
  onViewChange,
  reporterEmail,
  headingRef,
  headingLevel = "h2",
  emptyState,
}: TrackRecordSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const Heading = headingLevel;
  const GroupHeading = headingLevel === "h2" ? "h3" : "h4";
  const recordGroups = orderGroupsByPreference(groupRecords(records), preferences);
  if (recordGroups.length === 0) {
    return <>{emptyState}</>;
  }
  return (
          <section className="mt-[29px] box:mt-[18px]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* "Track record", not "Record"/"Records": bare "Record" read as
                  a typo next to a list of many items, and "Records" reads as
                  documents. This is the home-page promise ("who these
                  candidates really are by their records") paid off. */}
              <Heading ref={headingRef} className="text-heading font-semibold">Track record</Heading>
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                View
                <select
                  value={view}
                  onChange={(event) => {
                    track("detail_control", { control: "record_view", value: event.target.value });
                    onViewChange(event.target.value as RecordView);
                  }}
                  className="rounded-md border border-line bg-white px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
                >
                  <option value="my_issues">My issues first</option>
                  <option value="newest">Newest first</option>
                </select>
              </label>
            </div>
            {view === "newest" ? (
              // Flat chronological view; the payload already arrives newest-first.
              <>
                <ul className="mt-2 space-y-3">
                  {(showAll ? records : records.slice(0, INITIAL_NEWEST_RECORDS)).map(
                    (record) => (
                      <RecordItem key={record.id} record={record} showTags reporterEmail={reporterEmail} />
                    )
                  )}
                </ul>
                {!showAll && records.length > INITIAL_NEWEST_RECORDS ? (
                  <button
                    type="button"
                    onClick={() => {
                      track("detail_control", { control: "records_show_all", value: "none" });
                      setShowAll(true);
                    }}
                    className="mt-3 rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink transition hover:border-ink"
                  >
                    Show all {records.length} records
                  </button>
                ) : null}
              </>
            ) : (
              <div className="mt-2 space-y-4">{recordGroups.map((group) => {
                // Stance tally shown while collapsed, so the split is readable
                // without opening the group. Evaluative areas keep their
                // evidence wording (favorable/unfavorable), matching the cards
                // inside; zero-count sides stay hidden to avoid "0 oppose"
                // noise. Same colored-text-only treatment as StanceChip.
                const { forCount, againstCount } = groupStanceCounts(group);
                const evaluative = group.areaSlug != null && EVALUATIVE_AREA_SLUGS.has(group.areaSlug);
                return (
                  <div key={group.areaId ?? "other"}>
                    {/* The heading lives OUTSIDE the summary, sr-only — same
                        rule as the finance disclosure above: <summary> maps to
                        a button, and a heading inside it can drop out of
                        screen-reader heading navigation. "Track record — "
                        prefixes the area so the heading reads meaningfully
                        when jumped to on its own, and keeps its text distinct
                        from the visible summary line (which repeats the bare
                        area name). */}
                    <GroupHeading className="sr-only">{`Track record — ${group.areaName}`}</GroupHeading>
                    {/* Every group starts collapsed; with no `open` prop React
                        never re-applies a default, so a reader's toggles
                        survive a view switch that reorders the groups. */}
                    <details
                      className="group"
                      onToggle={(event) =>
                        track("detail_control", {
                          control: "record_group_toggle",
                          value: event.currentTarget.open ? "open" : "close",
                        })
                      }
                    >
                      {/* The app's own chevron right after the text (flips
                          open), not the native left triangle: one disclosure
                          mark everywhere, and the native one renders tiny on
                          Safari. Hugs the label rather than the row's far
                          edge, which on a wide screen put it a screen-width
                          away. list-none + the webkit marker rule hide the
                          triangle; the hover tint says "button" at rest. */}
                      <summary className="-mx-2 flex cursor-pointer select-none list-none items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface [&::-webkit-details-marker]:hidden">
                        <span>
                        {/* Title-case ink subheading, one role step below the
                            finance/Track-record h2 tier. Not the eyebrow idiom
                            (small caps, soft gray): that marks static captions,
                            and these rows are the page's main navigation. */}
                        <span className="text-subheading font-semibold text-ink">
                          {group.areaName}
                        </span>{" "}
                        {/* The total is redundant when every record in the
                            group has a stance — "2 records · 2 support" said
                            the same thing twice. It stays for stance-less
                            groups (General, Other) and when neutral records
                            make the tallies fall short of the total. */}
                        {forCount + againstCount !== group.records.length ? (
                          <span className="text-xs text-ink-soft">
                            · {group.records.length} record{group.records.length === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {forCount > 0 ? (
                          <span className="text-xs font-medium text-green-900">
                            {" "}
                            · {forCount} {evaluative ? "favorable" : "support"}
                          </span>
                        ) : null}
                        {againstCount > 0 ? (
                          <span className="text-xs font-medium text-red-900">
                            {" "}
                            · {againstCount} {evaluative ? "unfavorable" : "oppose"}
                          </span>
                        ) : null}
                        </span>
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 12 12"
                          className="h-3.5 w-3.5 shrink-0 text-ink-soft transition-transform group-open:rotate-180"
                        >
                          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </summary>
                      <ul className="mt-2 space-y-3">
                        {group.records.map((record) => (
                          <RecordItem
                            key={`${group.areaId ?? "other"}-${record.id}`}
                            record={record}
                            showTags={false}
                            reporterEmail={reporterEmail}
                            stanceAreaId={group.areaId}
                          />
                        ))}
                      </ul>
                    </details>
                  </div>
                );
              })}</div>
            )}
          </section>
  );
}

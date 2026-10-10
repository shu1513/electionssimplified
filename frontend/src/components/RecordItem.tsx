import { Fragment } from "react";
import type { CandidateRecord } from "@voteapp/api-client";
import { EVALUATIVE_AREA_SLUGS, formatElectionDate } from "@voteapp/api-client";
import { ReportContentButton } from "./ReportContentButton";
import { SourceLine } from "./SourceLine";

// The stance-bearing tag this record card should claim in a group view: the
// group's area decides — the same record can be for one area and against
// another, so the other areas' stances must not leak into this group. The
// flat view has no single chip; it spells out per-tag stances in the meta
// line instead.
export function recordStanceTag(record: CandidateRecord, areaId: string) {
  const tag = record.research_area_tags.find((t) => t.research_area_id === areaId);
  return tag?.stance === "for" || tag?.stance === "against" ? { ...tag, stance: tag.stance } : null;
}

// The stance phrase names its topic ("Supports Gun Control", never a bare
// "For") because cards get read without their group heading — quoted,
// screenshotted, or far down an open group — and next to a "Voted no ..."
// description a bare "For" reads as the vote direction, the opposite of
// what it means.
function stanceLabel(stance: "for" | "against", slug: string, name: string): string {
  if (EVALUATIVE_AREA_SLUGS.has(slug)) {
    return stance === "for" ? `Favorable on ${name}` : `Unfavorable on ${name}`;
  }
  return stance === "for" ? `Supports ${name}` : `Opposes ${name}`;
}

// Small colored stance marker — direction as a quiet cue, not a whole-card
// color wash. Colored text only, no box: a bordered chip read as a button.
// Same palette as the stance text on the election page.
function StanceChip({ stance, label }: { stance: "for" | "against"; label: string }) {
  return (
    <span className={stance === "for" ? "font-medium text-green-900" : "font-medium text-red-900"}>
      {label}
    </span>
  );
}

// One record card, shared by the grouped and flat views (the flat view adds
// the area tags to the meta line since there is no group heading to carry
// them). `stanceAreaId` is the group's area in grouped views (null for the
// synthetic General group of untagged records); undefined in the flat view, which
// has no single chip.
export function RecordItem({
  record,
  showTags,
  reporterEmail,
  stanceAreaId,
  relatedRecords,
}: {
  record: CandidateRecord;
  showTags: boolean;
  reporterEmail?: string | null;
  stanceAreaId?: string | null;
  /** The candidate's other records on the same bill (amendment votes next
   * to final passage), so a bill's story is not scattered across issue
   * groups. Rendered as one line per record under the source line. */
  relatedRecords?: readonly CandidateRecord[];
}) {
  const stanceTag = stanceAreaId != null ? recordStanceTag(record, stanceAreaId) : null;
  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <p className="text-body text-ink">{record.description}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-soft">
        <span>{formatElectionDate(record.event_date)}</span>
        {stanceTag ? (
          <StanceChip
            stance={stanceTag.stance}
            label={stanceLabel(stanceTag.stance, stanceTag.slug, stanceTag.name)}
          />
        ) : null}
        {showTags && record.research_area_tags.length > 0 ? (
          // Per-tag stance in the flat view, in the same colored verb
          // phrasing as the grouped chip: a record can be for one area and
          // against another, so each tag carries its own direction.
          <span>
            ·{" "}
            {record.research_area_tags.map((tag, index) => (
              <Fragment key={tag.research_area_id}>
                {index > 0 ? ", " : null}
                <span
                  className={
                    tag.stance === "for"
                      ? "font-medium text-green-900"
                      : tag.stance === "against"
                        ? "font-medium text-red-900"
                        : undefined
                  }
                >
                  {tag.stance === "for" || tag.stance === "against"
                    ? stanceLabel(tag.stance, tag.slug, tag.name)
                    : tag.name}
                </span>
              </Fragment>
            ))}
          </span>
        ) : null}
      </p>
      <SourceLine url={record.source_url} />
      {relatedRecords && relatedRecords.length > 0 ? (
        <div className="mt-2 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft">
          <p className="font-medium text-ink">Also on this bill</p>
          <ul className="mt-1 space-y-1">
            {relatedRecords.map((related) => (
              <li key={related.id}>
                <span>{formatElectionDate(related.event_date)}</span>
                {" · "}
                <span className="text-ink">{related.description}</span>
                {related.research_area_tags.length > 0 ? (
                  <span>
                    {" "}
                    ({related.research_area_tags.map((tag) => (tag.stance === "for" || tag.stance === "against" ? stanceLabel(tag.stance, tag.slug, tag.name) : tag.name)).join(", ")})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-2">
        <ReportContentButton
          entityType="candidate_record"
          entityId={record.id}
          contextLabel="candidate record"
          reporterEmail={reporterEmail}
        />
      </div>
    </li>
  );
}

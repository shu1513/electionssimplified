import { nhSourceHold, nhSourceInteger } from "./newHampshireReportedSourceGraph.js";
import { NEW_HAMPSHIRE_REPORTED_SOURCE_URL, type NewHampshireSourceControl } from "./newHampshireReportedSourceCache.js";

export type NewHampshireReportedSourceFacts = {
  sourceUrl: string; sourceRetrievedAt: string; sourceCompletedAt: string; sourceBaseRetrievedAt: string;
  sourceManifestSha256: string; sourceByteSize: number; sourceControls: NewHampshireSourceControl[];
};
const HASH = /^[a-f0-9]{64}$/;
export function nhReportedIso(value: unknown): string {
  if (!(typeof value === "string" || value instanceof Date) || !Number.isFinite(new Date(value).getTime())) nhSourceHold("invalid_observation_clock");
  return new Date(value).toISOString();
}
/** Original byte/request qualification belongs to the cache. This independently
 * validates the complete persisted provenance shape on writes and API reads. */
export function validateNewHampshireReportedSourceFacts(source: NewHampshireReportedSourceFacts, latestAllowed: number): void {
  if (source.sourceUrl !== NEW_HAMPSHIRE_REPORTED_SOURCE_URL || !HASH.test(source.sourceManifestSha256) ||
    !Number.isSafeInteger(source.sourceByteSize) || source.sourceByteSize < 1 || source.sourceByteSize > 256 * 1024 * 1024 ||
    !Array.isArray(source.sourceControls) || source.sourceControls.length < 8 || source.sourceControls.length > 800) nhSourceHold("invalid_source_facts");
  for (const clock of [source.sourceBaseRetrievedAt, source.sourceRetrievedAt, source.sourceCompletedAt]) {
    if (typeof clock !== "string" || nhReportedIso(clock) !== clock || Date.parse(clock) > latestAllowed) nhSourceHold("invalid_source_facts");
  }
  const fields = ["byteSize", "completedAt", "contentType", "eof", "file", "sha256", "startedAt", "status"];
  let generation: string | undefined, ordinal = 0, previousEnd = -Infinity, size = 0, generations = 0;
  for (const [i, control] of source.sourceControls.entries()) {
    if (!control || JSON.stringify(Object.keys(control).sort()) !== JSON.stringify(fields)) nhSourceHold("invalid_source_control");
    const match = /^(generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/(\d{4})\.raw$/.exec(control.file);
    if (!match) nhSourceHold("invalid_source_control");
    if (match[1] !== generation) {
      if (++generations > 2 || i !== 0 && generations !== 2) nhSourceHold("invalid_source_control");
      if (generations === 2 && (control.startedAt !== source.sourceRetrievedAt ||
        Date.parse(control.startedAt) - previousEnd > 86_400_000)) nhSourceHold("invalid_source_control");
      generation = match[1]; ordinal = 0;
    }
    if (match[2] !== String(++ordinal).padStart(4, "0") || !HASH.test(control.sha256) || control.status !== 200 || control.eof !== true ||
      typeof control.contentType !== "string" || control.contentType.length > 256 || !/^application\/json(?:;|$)/i.test(control.contentType) ||
      !Number.isSafeInteger(control.byteSize) || control.byteSize < 1 || control.byteSize > 32 * 1024 * 1024 ||
      nhReportedIso(control.startedAt) !== control.startedAt || nhReportedIso(control.completedAt) !== control.completedAt ||
      Date.parse(control.startedAt) < previousEnd || Date.parse(control.completedAt) < Date.parse(control.startedAt) ||
      Date.parse(control.completedAt) > latestAllowed) nhSourceHold("invalid_source_control");
    previousEnd = Date.parse(control.completedAt); size += control.byteSize;
    if (i === 0 && control.startedAt !== source.sourceBaseRetrievedAt) nhSourceHold("invalid_source_control");
  }
  if (generations !== 2 || source.sourceControls.at(-1)!.completedAt !== source.sourceCompletedAt || size !== source.sourceByteSize ||
    Date.parse(source.sourceBaseRetrievedAt) > Date.parse(source.sourceRetrievedAt) ||
    Date.parse(source.sourceRetrievedAt) > Date.parse(source.sourceCompletedAt)) nhSourceHold("invalid_source_facts");
}
export function validateNewHampshireReportedCounts(input: {
  component: "committee" | "ie"; sourceRows: number; currentRows: number; historicalRows: number;
  occurrenceCount: number; groupCount: number; excludedCurrentRows: number; nonpositiveRows: number;
  totalCents: number; supportCents: number; opposeCents: number;
}): void {
  const counts = [input.sourceRows, input.currentRows, input.historicalRows, input.occurrenceCount,
    input.groupCount, input.excludedCurrentRows, input.nonpositiveRows];
  if (counts.some(n => nhSourceInteger(n, 0) > 2147483647) || input.sourceRows !== input.currentRows + input.historicalRows ||
    input.currentRows !== input.occurrenceCount + input.excludedCurrentRows + input.nonpositiveRows || input.groupCount > input.occurrenceCount ||
    [input.totalCents, input.supportCents, input.opposeCents].some(n => !Number.isSafeInteger(n) || n < 0) ||
    (input.groupCount === 0) !== (input.occurrenceCount === 0) || (input.occurrenceCount === 0) !== (input.totalCents === 0) ||
    (input.component === "committee" ? input.supportCents !== 0 || input.opposeCents !== 0 || input.nonpositiveRows !== 0 :
      input.sourceRows === 0 || input.totalCents !== input.supportCents + input.opposeCents)) nhSourceHold("invalid_component_counts");
}

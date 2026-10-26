import {
  NEVADA_PUBLIC_FINANCE_SEARCH_URL,
  nevadaReportedCommitteeNameKey,
  type NevadaObservedGroupNameQuery,
} from "./nevadaPacDonorAggregator.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Nevada registry observation object is missing");
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("Nevada registry observation array is missing");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Nevada registry observation text is missing");
  return value.trim();
}
function timestamp(value: unknown): number {
  const raw = text(value);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw)
    throw new Error("Nevada registry observation timestamp is invalid");
  return parsed;
}
const NATIVE_GROUP_TYPES = new Set([
  "Indep", "Nonprofit", "PACAD", "PAC", "Political", "Recall",
]);

function queryObservation(value: unknown) {
  const observation = object(value);
  if (
    observation.sourceSearchPath !== NEVADA_PUBLIC_FINANCE_SEARCH_URL ||
    observation.groupTypeBlank !== true ||
    observation.otherFiltersBlank !== true
  )
    throw new Error("Nevada registry query is restrictive or has an unsupported source");
  const nameQuery = text(observation.nameQuery);
  const pages = array(observation.pages).map(object);
  if (pages.length === 0 || pages.length > 200)
    throw new Error("Nevada registry page scope is invalid");
  const rows: string[][] = [];
  const times: number[] = [];
  let total: number | undefined;
  for (const [index, page] of pages.entries()) {
    const observedAt = timestamp(page.observedAt);
    if (index > 0 && observedAt < times[index - 1]!)
      throw new Error("Nevada registry page time order is invalid");
    times.push(observedAt);
    const pagers = array(page.pager).map(text);
    if (!pagers.length)
      throw new Error("Nevada registry has no published count");
    let expectedRows: number | undefined;
    for (const pager of pagers) {
      const match = pager.replace(/\s+/g, " ").match(
        /^Page (\d+) of (\d+), items (\d+) to (\d+) of (\d+)\.$/,
      );
      if (!match)
        throw new Error("Nevada registry pager is unrecognized");
      const [, number, count, start, end, size] = match.map(Number);
      if (
        number !== index + 1 || count !== pages.length ||
        start !== index * 25 + 1 ||
        end !== Math.min(size!, (index + 1) * 25) ||
        size! <= 0 || Math.ceil(size! / 25) !== pages.length ||
        (total !== undefined && total !== size)
      )
        throw new Error("Nevada registry count/page closure failed");
      total = size;
      expectedRows = end! - start! + 1;
    }
    const sourceRows = array(page.rows);
    if (sourceRows.length !== expectedRows)
      throw new Error("Nevada registry is missing physical rows");
    for (const sourceRow of sourceRows) {
      const fields = array(sourceRow);
      if (
        fields.length !== 4 ||
        fields.some((field) => typeof field !== "string")
      )
        throw new Error("Nevada registry row schema is unrecognized");
      const cells = fields as string[];
      const name = text(cells[0]);
      const type = text(cells[1]);
      if (
        !NATIVE_GROUP_TYPES.has(type) ||
        !nevadaReportedCommitteeNameKey(name).includes(
          nevadaReportedCommitteeNameKey(nameQuery),
        )
      )
        throw new Error("Nevada registry row is outside the observed query");
      rows.push([...cells]);
    }
  }
  if (
    rows.length !== total ||
    new Set(rows.map((row) => JSON.stringify(row))).size !== rows.length
  )
    throw new Error("Nevada registry has missing or repeated physical rows");
  return { nameQuery, rows, times };
}

/** Complete all-class name evidence; never a legal committee identifier. */
export function validateNevadaGroupRegistryObservations(
  value: unknown,
  context: { firstManifestAt: number; lastManifestAt: number; now: number },
): { queries: NevadaObservedGroupNameQuery[]; observedAt: number } {
  if (
    !Object.values(context).every(Number.isFinite) ||
    context.firstManifestAt > context.lastManifestAt ||
    context.lastManifestAt > context.now
  )
    throw new Error("Nevada registry context time order is invalid");
  if (value === undefined)
    return { queries: [], observedAt: context.lastManifestAt };
  const entries = array(value);
  if (entries.length > 50)
    throw new Error("Nevada registry query scope is invalid");
  const queries: NevadaObservedGroupNameQuery[] = [];
  let observedAt = context.lastManifestAt;
  let firstObservedAt = context.firstManifestAt;
  for (const entry of entries) {
    const source = object(entry);
    const opening = queryObservation(source.opening);
    const closing = queryObservation(source.closing);
    if (
      opening.nameQuery !== closing.nameQuery ||
      JSON.stringify(opening.rows) !== JSON.stringify(closing.rows)
    )
      throw new Error("Nevada registry query changed during observation");
    const first = opening.times[0]!;
    const last = closing.times.at(-1)!;
    if (
      opening.times.at(-1)! > context.firstManifestAt ||
      closing.times[0]! < context.lastManifestAt ||
      first > last || last > context.now ||
      context.now - first > 36 * 60 * 60 * 1000 ||
      last - first > 2 * 60 * 60 * 1000
    )
      throw new Error("Nevada registry observations do not bracket current source");
    observedAt = Math.max(observedAt, last);
    firstObservedAt = Math.min(firstObservedAt, first);
    queries.push({
      nameQuery: opening.nameQuery,
      groupTypeBlank: true,
      resultCount: opening.rows.length,
      rows: opening.rows.map(([name, type]) => ({ name: name!, type: type! })),
    });
  }
  if (observedAt - firstObservedAt > 2 * 60 * 60 * 1000)
    throw new Error("Nevada registry whole capture exceeds the time limit");
  return { queries, observedAt };
}

import { describe, expect, it } from "vitest";
import { validateNevadaGroupRegistryObservations } from "../../../src/pipeline/nevadaFinance/nevadaGroupRegistryObservation.js";

const SEARCH = "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx";
const context = {
  firstManifestAt: Date.parse("2026-10-25T10:00:00.000Z"),
  lastManifestAt: Date.parse("2026-10-25T10:10:00.000Z"),
  now: Date.parse("2026-10-25T11:00:00.000Z"),
};
function fixture() {
  const rows = Array.from({ length: 26 }, (_, i) => [
    "Example Corporation " + i, i === 0 ? "PAC" : "Nonprofit", "", "",
  ]);
  function observation(closing: boolean) {
    return {
      sourceSearchPath: SEARCH,
      nameQuery: "Corp",
      groupTypeBlank: true,
      otherFiltersBlank: true,
      pages: [0, 1].map((i) => ({
        observedAt: "2026-10-25T" + (closing ? "10:20:" : "09:50:") + String(i).padStart(2, "0") + ".000Z",
        pager: ["Page " + (i + 1) + " of 2, items " + (i * 25 + 1) + " to 26 of 26."],
        rows: structuredClone(rows.slice(i * 25, (i + 1) * 25)),
      })),
    };
  }
  const opening = observation(false);
  const closing = observation(true);
  opening.pages[0]!.pager = ["Page 1 of 2, items 1 to 25 of 26."];
  closing.pages[0]!.pager = [...opening.pages[0]!.pager];
  return [{ opening, closing }];
}
function validate(value: unknown) {
  return validateNevadaGroupRegistryObservations(value, context);
}
describe("Nevada complete all-class registry observations", () => {
  it("accepts every native page including the tail", () => {
    const result = validate(fixture());
    expect(result.queries[0]).toMatchObject({ nameQuery: "Corp", groupTypeBlank: true, resultCount: 26 });
    expect(result.queries[0]!.rows).toHaveLength(26);
  });
  it("keeps old literal-only packets compatible without asserting registry authority", () => {
    expect(validate(undefined)).toEqual({ queries: [] });
  });
  it("bounds the whole graph even when each individual query brackets the manifest within two hours", () => {
    const early = fixture()[0]!;
    const late = fixture()[0]!;
    early.opening.pages.forEach((p, i) => { p.observedAt = "2026-10-25T08:20:0" + i + ".000Z"; });
    early.closing.pages.forEach((p, i) => { p.observedAt = "2026-10-25T10:10:0" + i + ".000Z"; });
    late.closing.pages.forEach((p, i) => { p.observedAt = "2026-10-25T11:40:0" + i + ".000Z"; });
    expect(() => validateNevadaGroupRegistryObservations([early, late], {
      ...context, now: Date.parse("2026-10-25T12:00:00.000Z"),
    })).toThrow(/whole capture/);
  });
  it("rejects an invalid verification clock", () => {
    expect(() => validateNevadaGroupRegistryObservations(fixture(), {
      ...context, now: NaN,
    })).toThrow(/context time/);
  });
  it.each([
    "missing tail", "truncated tail", "wrong page", "wrong total", "conflicting pager",
    "no published count", "repeated page", "restrictive class", "restrictive other filter",
    "wrong source", "different query", "unrelated returned name", "unknown class",
    "row schema", "name drift", "class drift", "contact drift",
    "opening after manifest", "closing before manifest", "future", "stale",
    "long capture", "time order", "invalid timestamp",
  ])("holds %s rather than recognizing a partial query", (reason) => {
    const value = fixture();
    const opening = value[0]!.opening;
    const closing = value[0]!.closing;
    if (reason === "missing tail") opening.pages.pop();
    if (reason === "truncated tail") opening.pages[1]!.rows.pop();
    if (reason === "wrong page") opening.pages[1]!.pager = ["Page 1 of 2, items 1 to 25 of 26."];
    if (reason === "wrong total") opening.pages[1]!.pager = ["Page 2 of 2, items 26 to 27 of 27."];
    if (reason === "conflicting pager") opening.pages[0]!.pager.push("Page 1 of 2, items 1 to 25 of 27.");
    if (reason === "no published count") opening.pages[0]!.pager = [];
    if (reason === "repeated page") opening.pages[1]!.rows = [structuredClone(opening.pages[0]!.rows[0]!)];
    if (reason === "restrictive class") opening.groupTypeBlank = false;
    if (reason === "restrictive other filter") opening.otherFiltersBlank = false;
    if (reason === "wrong source") opening.sourceSearchPath = "https://example.invalid";
    if (reason === "different query") closing.nameQuery = "Corporation";
    if (reason === "unrelated returned name") opening.pages[0]!.rows[0]![0] = "Unrelated Group";
    if (reason === "unknown class") opening.pages[0]!.rows[0]![1] = "Unknown";
    if (reason === "row schema") opening.pages[0]!.rows[0]!.pop();
    if (reason === "name drift") closing.pages[0]!.rows[0]![0] += " Changed";
    if (reason === "class drift") closing.pages[0]!.rows[0]![1] = "Nonprofit";
    if (reason === "contact drift") closing.pages[0]!.rows[0]![2] = "Changed";
    if (reason === "opening after manifest") opening.pages[1]!.observedAt = "2026-10-25T10:01:00.000Z";
    if (reason === "closing before manifest") closing.pages[0]!.observedAt = "2026-10-25T10:09:00.000Z";
    if (reason === "future") closing.pages[1]!.observedAt = "2026-10-25T11:01:00.000Z";
    if (reason === "stale") opening.pages[0]!.observedAt = "2026-10-23T09:50:00.000Z";
    if (reason === "long capture") opening.pages[0]!.observedAt = "2026-10-25T08:00:00.000Z";
    if (reason === "time order") opening.pages[1]!.observedAt = "2026-10-25T09:49:00.000Z";
    if (reason === "invalid timestamp") opening.pages[0]!.observedAt = "2026-10-25";
    expect(() => validate(value)).toThrow(/registry/);
  });
});

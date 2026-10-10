import { describe, expect, it } from "vitest";

import {
  BALLOT_MEASURE_PROPOSED_BY_MAX_ABOUT_LENGTH,
  BALLOT_MEASURE_PROPOSED_BY_MAX_NAME_LENGTH,
  parseBallotMeasureProposedBy,
  parseOptionalBallotMeasureProposedBy,
} from "../../src/contracts/ballotMeasureProposedByPayloadContract.js";

function proposedBy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Louisiana Legislature (HB 300, Rep. Jane Smith)",
    about: "Rep. Smith is a Republican from Baton Rouge. The bill passed both chambers with bipartisan support.",
    source_url: "https://legis.la.gov/legis/BillInfo.aspx?s=26RS&b=HB300",
    ...overrides,
  };
}

function reasonOf(value: unknown): string {
  const parsed = parseBallotMeasureProposedBy(value);
  if (parsed.ok) {
    throw new Error("expected a validation failure");
  }
  return parsed.reason;
}

describe("parseBallotMeasureProposedBy", () => {
  it("accepts a complete proposer and normalizes whitespace", () => {
    const parsed = parseBallotMeasureProposedBy(
      proposedBy({ name: "  Citizen initiative   filed by Protect Our Parks ", about: " A group  funded mainly by the state hospital association. " })
    );
    expect(parsed).toEqual({
      ok: true,
      proposedBy: {
        name: "Citizen initiative filed by Protect Our Parks",
        about: "A group funded mainly by the state hospital association.",
        source_url: "https://legis.la.gov/legis/BillInfo.aspx?s=26RS&b=HB300",
      },
    });
  });

  it("requires an object", () => {
    expect(reasonOf("Legislature")).toContain("must be an object");
  });

  it("rejects placeholder names and points at null", () => {
    expect(reasonOf(proposedBy({ name: "Unknown" }))).toContain("use proposed_by: null");
  });

  it("caps the name length", () => {
    expect(reasonOf(proposedBy({ name: "x".repeat(BALLOT_MEASURE_PROPOSED_BY_MAX_NAME_LENGTH + 1) }))).toContain("max 120");
  });

  it("requires the plain-language explainer", () => {
    expect(reasonOf(proposedBy({ about: "" }))).toContain("about is required");
    expect(reasonOf(proposedBy({ about: undefined }))).toContain("about is required");
  });

  it("caps the explainer length", () => {
    expect(reasonOf(proposedBy({ about: "y".repeat(BALLOT_MEASURE_PROPOSED_BY_MAX_ABOUT_LENGTH + 1) }))).toContain("max 200");
  });

  it("rejects an explainer that only repeats the name", () => {
    const name = "Protect Our Parks";
    expect(reasonOf(proposedBy({ name, about: name.toUpperCase() }))).toContain("repeats the name");
  });

  it("requires a valid http(s) source URL", () => {
    expect(reasonOf(proposedBy({ source_url: "" }))).toContain("source_url must be non-empty");
    expect(reasonOf(proposedBy({ source_url: "not a url" }))).toContain("must be valid http(s) URL");
  });
});

describe("parseOptionalBallotMeasureProposedBy", () => {
  it("treats an absent key as leave-alone and null as researched-empty", () => {
    expect(parseOptionalBallotMeasureProposedBy(undefined)).toEqual({ ok: true, proposedBy: undefined });
    expect(parseOptionalBallotMeasureProposedBy(null)).toEqual({ ok: true, proposedBy: null });
  });

  it("passes a present object through the strict parser", () => {
    const parsed = parseOptionalBallotMeasureProposedBy(proposedBy());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.proposedBy?.name).toBe("Louisiana Legislature (HB 300, Rep. Jane Smith)");
    }
    expect(parseOptionalBallotMeasureProposedBy({ name: "x" })).toMatchObject({ ok: false });
  });
});

import { describe, expect, it } from "vitest";

import {
  buildNoPublicInfoSummary,
  isNoPublicInfoSummary,
  NO_PUBLIC_INFO_SUMMARY_PATTERN,
  NO_PUBLIC_INFO_SUMMARY_SQL_PATTERN,
  parseCandidateProfilePayload,
  parseNoPublicInfoSummary,
} from "../../src/contracts/candidateProfilePayloadContract.js";

const PLACEHOLDER = "As of September 2026, we found no public information about Jane Doe's job, background, or goals.";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    display_name: "Jane Doe",
    first_name: "Jane",
    last_name: "Doe",
    has_held_public_office: null,
    summary: PLACEHOLDER,
    sources: ["https://example.org/ballot-list"],
    ...overrides,
  };
}

describe("no-public-information summary helpers", () => {
  it("builds the fixed sentence from the display name and the search month", () => {
    expect(buildNoPublicInfoSummary("Jane Doe", new Date(Date.UTC(2026, 8, 13)))).toBe(PLACEHOLDER);
    expect(buildNoPublicInfoSummary("  Mohammed H. Faisal ", new Date(Date.UTC(2026, 11, 1)))).toBe(
      "As of December 2026, we found no public information about Mohammed H. Faisal's job, background, or goals."
    );
  });

  it("recognizes the template and nothing else", () => {
    expect(parseNoPublicInfoSummary(PLACEHOLDER)).toEqual({ month: "September", year: 2026, displayName: "Jane Doe" });
    expect(isNoPublicInfoSummary(`  ${PLACEHOLDER}  `)).toBe(true);
    expect(isNoPublicInfoSummary(null)).toBe(false);
    expect(isNoPublicInfoSummary("")).toBe(false);
    expect(isNoPublicInfoSummary("Jane Doe is a candidate for Mayor. Research found no public information about her.")).toBe(false);
    expect(isNoPublicInfoSummary("As of Sept 2026, we found no public information about Jane Doe's job, background, or goals.")).toBe(false);
    expect(isNoPublicInfoSummary("As of September 2026, we found no public information about Jane Doe's job or goals.")).toBe(false);
  });

  it("keeps the SQL pattern in step with the JS pattern", () => {
    // The SQL string is a POSIX regex; rebuilt as a JS RegExp it must accept
    // and reject the same sentences the JS pattern does.
    const sqlAsRegExp = new RegExp(NO_PUBLIC_INFO_SUMMARY_SQL_PATTERN);
    for (const sample of [
      PLACEHOLDER,
      "As of March 2027, we found no public information about Ed Marshman's job, background, or goals.",
      "As of Sept 2026, we found no public information about Jane Doe's job, background, or goals.",
      "Jane Doe is a teacher. Priorities: safer streets.",
    ]) {
      expect(sqlAsRegExp.test(sample), sample).toBe(NO_PUBLIC_INFO_SUMMARY_PATTERN.test(sample));
    }
  });
});

describe("parseCandidateProfilePayload with a no-public-information summary", () => {
  it("accepts the template with a null office-history answer", () => {
    const parsed = parseCandidateProfilePayload(payload());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.summary).toBe(PLACEHOLDER);
      expect(parsed.payload.has_held_public_office).toBeNull();
    }
  });

  it("rejects a reworded no-information summary and prints the exact template", () => {
    const parsed = parseCandidateProfilePayload(
      payload({ summary: "No public information was found about Jane Doe's background as of September 2026." })
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("does not match the fixed template");
      expect(parsed.reason).toContain("we found no public information about Jane Doe's job, background, or goals.");
    }
  });

  it("rejects the template when it names someone other than display_name", () => {
    const parsed = parseCandidateProfilePayload(
      payload({ summary: "As of September 2026, we found no public information about J. Doe's job, background, or goals." })
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("must carry display_name verbatim");
    }
  });

  it("rejects the template beside a true or false office-history answer", () => {
    for (const answer of [true, false]) {
      const parsed = parseCandidateProfilePayload(payload({ has_held_public_office: answer }));
      expect(parsed.ok, String(answer)).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain("has_held_public_office must be null");
      }
    }
  });
});

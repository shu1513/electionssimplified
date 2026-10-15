import { describe, expect, it } from "vitest";

import { financeClassificationKey } from "../../src/pipeline/finance/financeIndustryClassificationService.js";
import {
  checkRowsAgainstKnownLabels,
  parseIndustryLabelPayload,
} from "../../src/scripts/manualFinanceIndustryLabels.js";

function validRow() {
  return {
    label_type: "employer",
    raw_label: "Disney",
    industry_slug: "technology",
    confidence: "high",
  };
}

describe("parseIndustryLabelPayload", () => {
  it("accepts a valid payload, trims, and derives the normalized label", () => {
    const rows = parseIndustryLabelPayload({
      labels: [{ ...validRow(), raw_label: "  Belkin International Inc  " }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_label).toBe("Belkin International Inc");
    expect(rows[0].normalized_label).toBe("BELKIN INTERNATIONAL");
    expect(rows[0].industry_slug).toBe("technology");
  });

  it("accepts an explicit null industry_slug as a no-industry verdict", () => {
    const rows = parseIndustryLabelPayload({
      labels: [{ ...validRow(), raw_label: "City of Los Angeles", industry_slug: null }],
    });
    expect(rows[0].industry_slug).toBeNull();
  });

  it("rejects a payload without a labels array", () => {
    expect(() => parseIndustryLabelPayload({})).toThrow(/labels/);
    expect(() => parseIndustryLabelPayload({ labels: [] })).toThrow(/empty/);
  });

  it("collects every problem across rows in one error", () => {
    const bad = () =>
      parseIndustryLabelPayload({
        labels: [
          { ...validRow(), label_type: "occupation" },
          { ...validRow(), raw_label: "" },
          { ...validRow(), industry_slug: "entertainment" },
          { ...validRow(), confidence: "unknown" },
        ],
      });
    expect(bad).toThrow(/labels\[0\]: label_type must be "employer", "donor", or "committee"/);
    expect(bad).toThrow(/labels\[1\]: raw_label is required/);
    expect(bad).toThrow(/labels\[2\]: industry_slug must be null or one of/);
    expect(bad).toThrow(/labels\[3\]: confidence must be "high", "medium", or "low"/);
  });

  it("accepts committee rows with a PAC interest slug and a source URL", () => {
    const rows = parseIndustryLabelPayload({
      labels: [
        {
          label_type: "committee",
          raw_label: "Greater PA Carpenters PAC",
          industry_slug: "labor_unions",
          confidence: "high",
          source_url: "https://example.org/carpenters",
        },
        { label_type: "committee", raw_label: "Democratic Governors Association", industry_slug: "democratic_party_groups",
          confidence: "medium", source_url: "https://example.org/dga" },
      ],
    });
    expect(rows.map((row) => [row.normalized_label, row.industry_slug, row.source_url])).toEqual([
      ["GREATER PA CARPENTERS PAC", "labor_unions", "https://example.org/carpenters"],
      ["DEMOCRATIC GOVERNORS ASSOCIATION", "democratic_party_groups", "https://example.org/dga"],
    ]);
  });

  it("rejects committee rows with a non-PAC slug, a null slug, or no source URL", () => {
    const bad = () =>
      parseIndustryLabelPayload({
        labels: [
          { label_type: "committee", raw_label: "A PAC", industry_slug: "entertainment", confidence: "high", source_url: "https://example.org" },
          { label_type: "committee", raw_label: "B PAC", industry_slug: "labor_unions", confidence: "high" },
          { label_type: "employer", raw_label: "C Corp", industry_slug: "democratic_party_groups", confidence: "high" },
          // The state loaders never read a null committee verdict, so the writer refuses one.
          { label_type: "committee", raw_label: "Committee For A Better Tomorrow", industry_slug: null, confidence: "low" },
        ],
      });
    expect(bad).toThrow(/labels\[0\]: industry_slug must be one of/);
    expect(bad).toThrow(/labels\[1\]: source_url \(http\/https\) is required/);
    expect(bad).toThrow(/labels\[2\]: industry_slug must be null or one of/);
    expect(bad).toThrow(/labels\[3\]: industry_slug must be one of/);
  });

  it("rejects a missing industry_slug key instead of treating it as null", () => {
    const { industry_slug: _slug, ...withoutSlug } = validRow();
    expect(() => parseIndustryLabelPayload({ labels: [withoutSlug] })).toThrow(
      /industry_slug is required \(use null/
    );
  });

  it("rejects raw labels that normalize to nothing", () => {
    expect(() =>
      parseIndustryLabelPayload({ labels: [{ ...validRow(), raw_label: "()" }] })
    ).toThrow(/normalizes to an empty label/);
  });

  it("rejects two raw labels that collide on the same normalized label", () => {
    expect(() =>
      parseIndustryLabelPayload({
        labels: [validRow(), { ...validRow(), raw_label: "DISNEY  Inc" }],
      })
    ).toThrow(/duplicate \(label_type, normalized label\)/);
  });

  it("allows the same raw label under both label types", () => {
    expect(
      parseIndustryLabelPayload({ labels: [validRow(), { ...validRow(), label_type: "donor" }] })
    ).toHaveLength(2);
  });
});

describe("checkRowsAgainstKnownLabels", () => {
  const rows = parseIndustryLabelPayload({ labels: [validRow()] });

  it("passes when the normalized label already has a classification row", () => {
    const known = new Set([financeClassificationKey("employer", "DISNEY")]);
    expect(checkRowsAgainstKnownLabels(rows, known)).toEqual([]);
  });

  it("rejects a label no finance sync has persisted, including a label_type mismatch", () => {
    const known = new Set([financeClassificationKey("donor", "DISNEY")]);
    const issues = checkRowsAgainstKnownLabels(rows, known);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("missing_label");
    expect(issues[0].reason).toMatch(/has no classification row — copy label_type and raw_label from the due list/);
  });
});

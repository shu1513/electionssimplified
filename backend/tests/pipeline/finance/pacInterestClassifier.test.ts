import { describe, expect, it, vi } from "vitest";

import {
  PAC_INTEREST_DISPLAY_NAMES,
  PAC_INTEREST_SLUGS,
  classifyPacInterest,
  pacInterestDisplayName,
} from "../../../src/pipeline/finance/pacInterestClassifier.js";
import {
  listDuePacInterests,
  parseManualPacInterests,
  writeManualPacInterests,
} from "../../../src/scripts/manualFinancePacInterests.js";

const base = { committeeName: "EXAMPLE PAC", committeeType: "Q", designation: "B", organizationType: null, connectedOrganization: null };

describe("classifyPacInterest", () => {
  it("places committees from FEC registration facts before anything else", () => {
    expect(classifyPacInterest({ ...base, designation: "D" })).toEqual({ interestSlug: "leadership_pacs", confidence: "high", source: "fec" });
    expect(classifyPacInterest({ ...base, committeeType: "H", designation: "P" })).toEqual({ interestSlug: "candidate_committees", confidence: "high", source: "fec" });
    expect(classifyPacInterest({ ...base, organizationType: "L", committeeName: "UNITED WORKERS UNION PAC" })).toEqual({ interestSlug: "labor_unions", confidence: "high", source: "fec" });
  });

  it("leaves a committee unclassified rather than trust a loose keyword match", () => {
    // "UNION" in a railroad's name and "COLLEGE" in a medical society's name
    // match medium-confidence keyword rules; neither is a union or a school.
    for (const committeeName of ["UNION PACIFIC CORP. FUND FOR EFFECTIVE GOVERNMENT", "AMERICAN COLLEGE OF RADIOLOGY ASSOCIATION PAC"]) {
      expect(classifyPacInterest({ ...base, organizationType: "C", committeeName })).toEqual({ interestSlug: null, confidence: "unknown", source: "unknown" });
    }
  });

  it("treats every issue group by the same steps, whichever side it is on", () => {
    for (const committeeName of ["GUN RIGHTS EXAMPLE PAC", "GUN SAFETY EXAMPLE PAC", "PRO-CHOICE EXAMPLE PAC", "PRO-LIFE EXAMPLE PAC"]) {
      expect(classifyPacInterest({ ...base, organizationType: "M", committeeName }).source).toBe("unknown");
    }
  });

  it("names every slug, and keeps opposing sides of an issue in separate rows", () => {
    for (const slug of PAC_INTEREST_SLUGS) {
      expect(PAC_INTEREST_DISPLAY_NAMES[slug]).toBeTruthy();
    }
    expect(new Set(PAC_INTEREST_SLUGS).size).toBe(PAC_INTEREST_SLUGS.length);
    expect(PAC_INTEREST_SLUGS).toEqual(expect.arrayContaining(["gun_rights", "gun_control", "abortion_rights", "anti_abortion"]));
    expect(pacInterestDisplayName(null)).toBe("Not yet sorted");
    expect(pacInterestDisplayName("oil_gas_energy")).toBe("Oil, gas, and energy");
  });
});

describe("manual PAC interests", () => {
  const row = { committee_id: "C00000012", committee_name: "ACME CORP PAC", interest_slug: "manufacturing", confidence: "high" };

  it("validates the payload strictly", () => {
    expect(parseManualPacInterests({ interests: [row, { ...row, committee_id: "c00000013", interest_slug: null }] })).toEqual([
      row,
      { ...row, committee_id: "C00000013", interest_slug: null },
    ]);
    expect(() => parseManualPacInterests({ interests: [] })).toThrow("at least one row");
    expect(() => parseManualPacInterests({ interests: [{ ...row, interest_slug: "made_up" }] })).toThrow("interest_slug");
    expect(() => parseManualPacInterests({ interests: [{ committee_id: row.committee_id, committee_name: row.committee_name, confidence: "high" }] })).toThrow("interest_slug key is required");
    expect(() => parseManualPacInterests({ interests: [{ ...row, confidence: "certain" }] })).toThrow("confidence");
  });

  it("refuses a row whose name does not match the stored committee, and writes nothing", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ committee_id: "C00000012", committee_name: "SOME OTHER PAC" }] });
    await expect(writeManualPacInterests({ query }, [row], false)).rejects.toThrow("does not match the stored name");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("marks written rows as manual, and skips the write on a dry run", async () => {
    const known = { rows: [{ committee_id: "C00000012", committee_name: "Acme  Corp PAC" }] };
    const dryQuery = vi.fn().mockResolvedValueOnce(known);
    expect(await writeManualPacInterests({ query: dryQuery }, [row], true)).toEqual({ dry_run: true, valid_rows: 1, written: 0 });
    expect(dryQuery).toHaveBeenCalledTimes(1);

    const query = vi.fn().mockResolvedValueOnce(known).mockResolvedValueOnce({ rows: [] });
    expect(await writeManualPacInterests({ query }, [row], false)).toEqual({ dry_run: false, valid_rows: 1, written: 1 });
    expect(String(query.mock.calls[1]?.[0])).toContain("classification_source = 'manual'");
  });

  it("lists unclassified committees largest first with the taxonomy", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ committee_id: "C00000012", committee_name: "ACME CORP PAC", total_amount: 5000 }] })
      .mockResolvedValueOnce({ rows: [{ due_count: 1, total_count: 3 }] });
    const due = await listDuePacInterests({ query }, 50);
    expect(String(query.mock.calls[0]?.[0])).toContain("classification_source = 'unknown'");
    expect(due).toMatchObject({ due_count: 1, total_count: 3, interest_slugs: PAC_INTEREST_SLUGS });
    expect(due.committees).toHaveLength(1);
  });
});

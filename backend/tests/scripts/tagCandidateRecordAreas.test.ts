import { describe, expect, it, vi } from "vitest";

import {
  parseTagsFile,
  tagOneRecordArea,
  type TagDeps,
  type TagRecordRow,
} from "../../src/scripts/tagCandidateRecordAreas.js";

const RECORD: TagRecordRow = {
  candidate_id: "cand-1",
  description: "Sponsored a law requiring political ads made with artificial intelligence to say so.",
  office_id: "office-1",
  office_name: "state_lower/State Lower Chamber Legislator",
};

const INPUT = {
  recordId: "rec-1",
  researchAreaSlug: "ai_regulation",
  stance: "for" as const,
  expectedDescription: RECORD.description,
  reason: "A disclosure rule for AI-made political ads is an AI transparency rule.",
};

const ALLOWED = [
  { id: "area-ai", slug: "ai_regulation" },
  { id: "area-ei", slug: "election_integrity" },
];

function makeDeps(overrides: Partial<TagDeps> = {}): TagDeps {
  return {
    loadRecord: async () => ({ ...RECORD }),
    loadAllowedAreas: async () => ALLOWED,
    applyTag: async () => 1,
    ...overrides,
  };
}

describe("parseTagsFile", () => {
  it("parses valid entries, trims fields, and lowercases the slug so lookup and write agree", () => {
    const parsed = parseTagsFile(JSON.stringify([{ ...INPUT, recordId: " rec-1 ", researchAreaSlug: " AI_Regulation " }]));
    expect(parsed).toEqual([{ ...INPUT, recordId: "rec-1", researchAreaSlug: "ai_regulation" }]);
  });

  it("rejects a null stance on a policy area, a missing description, and a placeholder reason", () => {
    expect(() => parseTagsFile(JSON.stringify([{ ...INPUT, stance: null }]))).toThrow(/stance/);
    expect(() => parseTagsFile(JSON.stringify([{ ...INPUT, expectedDescription: "" }]))).toThrow(/expectedDescription/);
    expect(() => parseTagsFile(JSON.stringify([{ ...INPUT, reason: "AI" }]))).toThrow(/reason/);
  });

  it("accepts general with the stance omitted or null, and normalizes it to null", () => {
    const { stance: _stance, ...withoutStance } = INPUT;
    const parsed = parseTagsFile(
      JSON.stringify([
        { ...withoutStance, researchAreaSlug: "General" },
        { ...INPUT, recordId: "rec-2", researchAreaSlug: "general", stance: null },
      ])
    );
    expect(parsed.map((tag) => [tag.researchAreaSlug, tag.stance])).toEqual([
      ["general", null],
      ["general", null],
    ]);
  });

  it("rejects a stance on general", () => {
    expect(() => parseTagsFile(JSON.stringify([{ ...INPUT, researchAreaSlug: "general", stance: "for" }]))).toThrow(
      /omitted or null for general/
    );
  });

  it("refuses integrity_and_ethics with or without a stance", () => {
    expect(() =>
      parseTagsFile(JSON.stringify([{ ...INPUT, researchAreaSlug: "integrity_and_ethics", stance: null }]))
    ).toThrow(/not taggable here/);
    expect(() =>
      parseTagsFile(JSON.stringify([{ ...INPUT, researchAreaSlug: "Integrity_And_Ethics", stance: "against" }]))
    ).toThrow(/not taggable here/);
  });

  it("rejects a non-array file", () => {
    expect(() => parseTagsFile(JSON.stringify({}))).toThrow(/JSON array/);
  });

  it("rejects a repeated record/area pair before anything is written, case and whitespace aside", () => {
    expect(() =>
      parseTagsFile(JSON.stringify([INPUT, { ...INPUT, recordId: " rec-1 ", researchAreaSlug: "AI_REGULATION" }]))
    ).toThrow(/tags\[1\] repeats rec-1:ai_regulation/);
  });
});

describe("tagOneRecordArea", () => {
  it("dry-runs by default: reports would_tag with the office, writes nothing", async () => {
    const applyTag = vi.fn(async () => 1);
    const outcome = await tagOneRecordArea(INPUT, makeDeps({ applyTag }), { apply: false });
    expect(outcome).toMatchObject({ status: "would_tag", stance: "for", office: RECORD.office_name });
    expect(applyTag).not.toHaveBeenCalled();
  });

  it("applies with the validated area id and the reviewed description as the write guard", async () => {
    const applyTag = vi.fn(async () => 1);
    const outcome = await tagOneRecordArea(INPUT, makeDeps({ applyTag }), { apply: true });
    expect(outcome.status).toBe("tagged");
    expect(applyTag).toHaveBeenCalledWith({
      recordId: "rec-1",
      researchAreaId: "area-ai",
      stance: "for",
      expectedDescription: RECORD.description,
    });
  });

  it("reports a concurrent change when the guarded insert lands nothing", async () => {
    const outcome = await tagOneRecordArea(INPUT, makeDeps({ applyTag: async () => 0 }), { apply: true });
    expect(outcome).toMatchObject({ status: "skipped", reason: expect.stringMatching(/concurrent write/) });
  });

  it("skips when the description moved since review, even on apply", async () => {
    const applyTag = vi.fn(async () => 1);
    const outcome = await tagOneRecordArea(
      INPUT,
      makeDeps({ loadRecord: async () => ({ ...RECORD, description: "rewritten" }), applyTag }),
      { apply: true }
    );
    expect(outcome).toMatchObject({ status: "skipped", reason: expect.stringMatching(/changed since review/) });
    expect(applyTag).not.toHaveBeenCalled();
  });

  it("skips a slug the candidate's office does not allow", async () => {
    const outcome = await tagOneRecordArea(
      INPUT,
      makeDeps({ loadAllowedAreas: async () => [{ id: "area-ei", slug: "election_integrity" }] }),
      { apply: true }
    );
    expect(outcome).toMatchObject({ status: "skipped", reason: expect.stringMatching(/State Lower Chamber Legislator/) });
  });

  it("never rewrites an existing tag: same stance is a no-op, another stance is a conflict", async () => {
    const same = await tagOneRecordArea(
      INPUT,
      makeDeps({ loadRecord: async () => ({ ...RECORD, existing_stance: "for" }) }),
      { apply: true }
    );
    expect(same).toMatchObject({ status: "skipped", reason: "already tagged ai_regulation:for" });
    const conflict = await tagOneRecordArea(
      INPUT,
      makeDeps({ loadRecord: async () => ({ ...RECORD, existing_stance: "against" }) }),
      { apply: true }
    );
    expect(conflict).toMatchObject({ status: "skipped", reason: expect.stringMatching(/untag it first/) });
  });

  describe("general (no stance)", () => {
    const GENERAL = { ...INPUT, researchAreaSlug: "general", stance: null };
    const WITH_GENERAL = [...ALLOWED, { id: "area-general", slug: "general" }];

    it("applies with a null stance and the same description guard", async () => {
      const applyTag = vi.fn(async () => 1);
      const outcome = await tagOneRecordArea(
        GENERAL,
        makeDeps({ loadAllowedAreas: async () => WITH_GENERAL, applyTag }),
        { apply: true }
      );
      expect(outcome).toMatchObject({ status: "tagged", stance: null });
      expect(applyTag).toHaveBeenCalledWith({
        recordId: "rec-1",
        researchAreaId: "area-general",
        stance: null,
        expectedDescription: RECORD.description,
      });
    });

    it("skips when the record already carries general", async () => {
      const applyTag = vi.fn(async () => 1);
      const outcome = await tagOneRecordArea(
        GENERAL,
        makeDeps({
          loadRecord: async () => ({ ...RECORD, existing_stance: null }),
          loadAllowedAreas: async () => WITH_GENERAL,
          applyTag,
        }),
        { apply: true }
      );
      expect(outcome).toMatchObject({ status: "skipped", reason: "already tagged general:null" });
      expect(applyTag).not.toHaveBeenCalled();
    });

    it("still requires general in the office's allowed set", async () => {
      const outcome = await tagOneRecordArea(GENERAL, makeDeps(), { apply: true });
      expect(outcome).toMatchObject({ status: "skipped", reason: expect.stringMatching(/'general' is not allowed/) });
    });
  });

  it("skips a retired record and a candidate with no office race", async () => {
    expect(await tagOneRecordArea(INPUT, makeDeps({ loadRecord: async () => null }), { apply: true })).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/no live record/),
    });
    expect(
      await tagOneRecordArea(INPUT, makeDeps({ loadRecord: async () => ({ ...RECORD, office_id: null }) }), {
        apply: true,
      })
    ).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no office race/) });
  });
});

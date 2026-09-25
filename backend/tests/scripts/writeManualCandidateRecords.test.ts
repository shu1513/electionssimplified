import { describe, expect, it } from "vitest";

import type { CandidateRecordDroppedRecord } from "../../src/ai/enrichCandidateRecords.js";
import { buildCandidateRecordIdentityKey } from "../../src/pipeline/candidates/candidateRecordStore.js";
import {
  annotateDroppedRecordsWithStoredRows,
  applyConfirmedGaps,
  buildCandidateRecordQualityGaps,
  decideDeltaZeroRecordConfirmation,
  droppedRecordToGap,
  isBlockingCandidateRecordQualityGap,
  listRecordsBeforeSinceDate,
  parseSinceDate,
  validateSinceDateAgainstCheckpoint,
} from "../../src/scripts/writeManualCandidateRecords.js";
import { buildManualResearchRepairReport } from "../../src/scripts/manualResearchRepairReport.js";
import { usLatestLocalDateIso } from "../../src/utils/usLocalDate.js";

describe("writeManualCandidateRecords quality repair gaps", () => {
  it("turns quality-dropped records into deeper record-only repair instructions", () => {
    const dropped: CandidateRecordDroppedRecord = {
      record: {
        description: "The Secretary of State lists Jane Doe as a candidate for Governor.",
        source_url: "https://sos.example/candidates",
        event_date: "2026-05-01",
      },
      reason: "candidate record quality rejected row: pure_candidacy",
      failureType: "permanent",
      failureKind: "quality_gap",
    };

    const gap = droppedRecordToGap(dropped, 0);

    expect(gap).toEqual(
      expect.objectContaining({
        id: "candidate_records.dropped.0",
        stage: "candidate_records",
        objectType: "candidate_record",
        outcome: "needs_repair",
        failureKind: "quality_gap",
        promptFile: "src/ai/providers/candidateRecordDiscoveryPrompt.ts",
      })
    );
    expect(gap.focusedResearchPass).toContain("Do a deeper record-only research pass");
    expect(gap.focusedResearchPass).toContain("Do not replace this with another candidacy");
    expect(gap.focusedResearchPass).toContain("ballot-listing");
  });

  it("includes quality_gap dropped records in the repair report shape", () => {
    const dropped: CandidateRecordDroppedRecord = {
      record: {
        description: "The Secretary of State lists Jane Doe as a candidate for Governor.",
        source_url: "https://sos.example/candidates",
        event_date: "2026-05-01",
      },
      reason: "candidate record quality rejected row: pure_candidacy",
      failureType: "permanent",
      failureKind: "quality_gap",
    };
    const gap = droppedRecordToGap(dropped, 0);

    const report = buildManualResearchRepairReport({
      command: "manual:candidate-records:write",
      manualKey: "manual:candidate-records:election-1:candidate-1",
      target: {
        candidateId: "candidate-1",
        electionId: "election-1",
        recordsFile: "records.json",
        labelsFile: "labels.json",
      },
      gaps: [gap],
    });

    expect(report.status).toBe("needs_repair");
    expect(report.gaps).toContainEqual(
      expect.objectContaining({
        id: "candidate_records.dropped.0",
        failureKind: "quality_gap",
      })
    );
  });

  it("keeps source and schema drops pointed at source/schema repair", () => {
    const dropped: CandidateRecordDroppedRecord = {
      record: {
        description: "Served on the budget committee.",
        source_url: "https://bad.example/404",
        event_date: "2024-01-01",
      },
      reason: "citation fetch returned status 404",
      failureType: "permanent",
      failureKind: "source_url",
    };

    const gap = droppedRecordToGap(dropped, 1);

    expect(gap.promptFile).toBe("src/ai/providers/candidateRecordSourceRepairPrompt.ts");
    expect(gap.focusedResearchPass).toContain("source/schema repair pass");
  });

  it("blocks strict mode on no-record and only-general set gaps", () => {
    const noRecordGap = buildCandidateRecordQualityGaps({
      recordCount: 0,
      labels: [],
    })[0];
    const onlyGeneralGap = buildCandidateRecordQualityGaps({
      recordCount: 1,
      labels: [{ research_area_slug: "general" }],
    })[0];

    expect(noRecordGap?.id).toBe("candidate_records.no_records_found");
    expect(onlyGeneralGap?.id).toBe("candidate_records.only_general_labels");
    expect(noRecordGap && isBlockingCandidateRecordQualityGap(noRecordGap)).toBe(true);
    expect(onlyGeneralGap && isBlockingCandidateRecordQualityGap(onlyGeneralGap)).toBe(true);
  });

  it("does not let a dropped quality row itself block once accepted records exist", () => {
    const dropped: CandidateRecordDroppedRecord = {
      record: {
        description: "The Secretary of State lists Jane Doe as a candidate for Governor.",
        source_url: "https://sos.example/candidates",
        event_date: "2026-05-01",
      },
      reason: "candidate record quality rejected row: pure_candidacy",
      failureType: "permanent",
      failureKind: "quality_gap",
    };

    const gap = droppedRecordToGap(dropped, 0);

    expect(isBlockingCandidateRecordQualityGap(gap)).toBe(false);
  });

  it("lets confirmed no-record and only-general gaps stop blocking after focused repair", () => {
    const gaps = [
      ...buildCandidateRecordQualityGaps({ recordCount: 0, labels: [] }),
      ...buildCandidateRecordQualityGaps({
        recordCount: 1,
        labels: [{ research_area_slug: "general" }],
      }),
    ];

    const confirmed = applyConfirmedGaps(
      gaps,
      new Set(["candidate_records.no_records_found", "candidate_records.only_general_labels"])
    );

    expect(confirmed.every((gap) => isBlockingCandidateRecordQualityGap(gap) === false)).toBe(true);
    expect(confirmed).toContainEqual(
      expect.objectContaining({
        id: "candidate_records.no_records_found",
        outcome: "confirmed_null",
      })
    );
    expect(confirmed).toContainEqual(
      expect.objectContaining({
        id: "candidate_records.only_general_labels",
        outcome: "confirmed_neutral",
      })
    );
  });

  it("keeps all-general labels blocking until candidate_records.only_general_labels is confirmed", () => {
    const gaps = buildCandidateRecordQualityGaps({
      recordCount: 1,
      labels: [{ research_area_slug: "general" }],
    });

    const wrongConfirmation = applyConfirmedGaps(
      gaps,
      new Set(["candidate_records.no_records_found"])
    );
    const rightConfirmation = applyConfirmedGaps(
      gaps,
      new Set(["candidate_records.only_general_labels"])
    );

    expect(wrongConfirmation.some(isBlockingCandidateRecordQualityGap)).toBe(true);
    expect(rightConfirmation.some(isBlockingCandidateRecordQualityGap)).toBe(false);
    expect(rightConfirmation).toContainEqual(
      expect.objectContaining({
        id: "candidate_records.only_general_labels",
        outcome: "confirmed_neutral",
      })
    );
  });

  it("keeps zero records blocking until candidate_records.no_records_found is confirmed", () => {
    const gaps = buildCandidateRecordQualityGaps({
      recordCount: 0,
      labels: [],
    });

    const wrongConfirmation = applyConfirmedGaps(
      gaps,
      new Set(["candidate_records.only_general_labels"])
    );
    const rightConfirmation = applyConfirmedGaps(
      gaps,
      new Set(["candidate_records.no_records_found"])
    );

    expect(wrongConfirmation.some(isBlockingCandidateRecordQualityGap)).toBe(true);
    expect(rightConfirmation.some(isBlockingCandidateRecordQualityGap)).toBe(false);
    expect(rightConfirmation).toContainEqual(
      expect.objectContaining({
        id: "candidate_records.no_records_found",
        outcome: "confirmed_null",
      })
    );
  });
});

describe("writeManualCandidateRecords delta (--since-date) helpers", () => {
  const today = "2026-07-12";

  it("parseSinceDate accepts a real past-or-today YYYY-MM-DD date", () => {
    expect(parseSinceDate("2026-06-10", today)).toBe("2026-06-10");
    expect(parseSinceDate(" 2026-07-12 ", today)).toBe("2026-07-12");
  });

  it("parseSinceDate rejects partial, malformed, impossible, and future dates", () => {
    expect(() => parseSinceDate("2026", today)).toThrow(/full YYYY-MM-DD/);
    expect(() => parseSinceDate("2026-06", today)).toThrow(/full YYYY-MM-DD/);
    expect(() => parseSinceDate("06/10/2026", today)).toThrow(/full YYYY-MM-DD/);
    expect(() => parseSinceDate("2026-02-30", today)).toThrow(/not a real calendar date/);
    expect(() => parseSinceDate("2026-07-13", today)).toThrow(/cannot be in the future/);
  });

  it("parseSinceDate validates against the US-latest local date, not the UTC date", () => {
    // 05:00 UTC on 07-13 is still 19:00 on 07-12 in Pacific/Honolulu. A
    // since-date of 07-13 (e.g. a UTC-ahead checkpoint stamped by the old
    // bug) must be rejected as future instead of opening a window that
    // excludes every legitimate same-day record.
    const hawaiiToday = usLatestLocalDateIso(new Date("2026-07-13T05:00:00Z"));
    expect(hawaiiToday).toBe("2026-07-12");
    expect(() => parseSinceDate("2026-07-13", hawaiiToday)).toThrow(/cannot be in the future/);
    expect(parseSinceDate("2026-07-12", hawaiiToday)).toBe("2026-07-12");
  });

  it("listRecordsBeforeSinceDate reports out-of-window rows with their original indices", () => {
    const records = [
      { event_date: "2026-06-15", description: "in window" },
      { event_date: "2026-05-01", description: "before window" },
      { event_date: "2026-06-10", description: "on window start" },
      { event_date: "2024-01-01", description: "far before window" },
    ];

    const outOfWindow = listRecordsBeforeSinceDate(records, "2026-06-10");

    expect(outOfWindow.map((entry) => entry.index)).toEqual([1, 3]);
    expect(outOfWindow[0]!.record.description).toBe("before window");
  });

  const deltaContext = { contextType: "election" as const, contextId: "general-election" };
  const confirmation = (contextId: string, confirmedGapIds: string[]) => ({
    contextType: "election" as const,
    contextId,
    confirmedGapIds,
  });

  it("decideDeltaZeroRecordConfirmation leaves the confirmation alone when the candidate has records", () => {
    expect(
      decideDeltaZeroRecordConfirmation({
        existingRecordCount: 4,
        currentContext: deltaContext,
        priorConfirmations: [],
      })
    ).toEqual({ action: "leave" });
    expect(
      decideDeltaZeroRecordConfirmation({
        existingRecordCount: 4,
        currentContext: deltaContext,
        priorConfirmations: [confirmation("general-election", ["candidate_records.no_records_found"])],
      })
    ).toEqual({ action: "leave" });
  });

  it("decideDeltaZeroRecordConfirmation re-asserts (timestamp-only) a prior no_records_found confirmation for a zero-record candidate", () => {
    expect(
      decideDeltaZeroRecordConfirmation({
        existingRecordCount: 0,
        currentContext: deltaContext,
        priorConfirmations: [confirmation("general-election", ["candidate_records.no_records_found"])],
      })
    ).toEqual({ action: "refresh", contextType: "election", contextId: "general-election" });
  });

  it("decideDeltaZeroRecordConfirmation accepts a no_records_found confirmation stored under another election (primary → general)", () => {
    expect(
      decideDeltaZeroRecordConfirmation({
        existingRecordCount: 0,
        currentContext: deltaContext,
        priorConfirmations: [confirmation("primary-election", ["candidate_records.no_records_found"])],
      })
    ).toEqual({ action: "refresh", contextType: "election", contextId: "primary-election" });
  });

  it("decideDeltaZeroRecordConfirmation refreshes the current context's row first, else the newest no_records_found row", () => {
    // priorConfirmations arrive newest confirmed_at first.
    expect(
      decideDeltaZeroRecordConfirmation({
        existingRecordCount: 0,
        currentContext: deltaContext,
        priorConfirmations: [
          confirmation("other-election", ["candidate_records.no_records_found"]),
          confirmation("general-election", ["candidate_records.no_records_found"]),
        ],
      })
    ).toEqual({ action: "refresh", contextType: "election", contextId: "general-election" });

    expect(
      decideDeltaZeroRecordConfirmation({
        existingRecordCount: 0,
        currentContext: deltaContext,
        priorConfirmations: [
          confirmation("general-election", []),
          confirmation("newer-primary", ["candidate_records.no_records_found"]),
          confirmation("older-primary", ["candidate_records.no_records_found"]),
        ],
      })
    ).toEqual({ action: "refresh", contextType: "election", contextId: "newer-primary" });
  });

  it("validateSinceDateAgainstCheckpoint allows windows starting at or before the checkpoint", () => {
    expect(validateSinceDateAgainstCheckpoint("2026-06-10", "2026-06-10")).toBeNull();
    expect(validateSinceDateAgainstCheckpoint("2026-05-01", "2026-06-10")).toBeNull();
  });

  it("validateSinceDateAgainstCheckpoint rejects a window that would skip unsearched dates", () => {
    const reason = validateSinceDateAgainstCheckpoint("2026-06-11", "2026-06-10");
    expect(reason).toContain("skipped forever");
    expect(reason).toContain("2026-06-10");
  });

  it("validateSinceDateAgainstCheckpoint rejects delta mode when no checkpoint exists", () => {
    expect(validateSinceDateAgainstCheckpoint("2026-06-10", null)).toContain("FULL discovery sweep");
  });

  it("decideDeltaZeroRecordConfirmation refuses to close a never-confirmed full-history question from a windowed pass", () => {
    const noPrior = decideDeltaZeroRecordConfirmation({
      existingRecordCount: 0,
      currentContext: deltaContext,
      priorConfirmations: [],
    });
    expect(noPrior.action).toBe("error");
    if (noPrior.action === "error") {
      expect(noPrior.reason).toContain("FULL discovery sweep");
      expect(noPrior.reason).toContain("never closed");
    }

    const wrongPrior = decideDeltaZeroRecordConfirmation({
      existingRecordCount: 0,
      currentContext: deltaContext,
      priorConfirmations: [confirmation("primary-election", ["candidate_records.only_general_labels"])],
    });
    expect(wrongPrior.action).toBe("error");
  });

  it("decideDeltaZeroRecordConfirmation names removed records when a prior confirmation implies records existed", () => {
    // Empty claim set ("sweep ran, stances found") and only_general_labels
    // both imply records existed when the confirmation was written; zero
    // stored records now means they were removed externally — the error
    // must say that, not "the sweep was never closed".
    for (const priorConfirmedGapIds of [[] as string[], ["candidate_records.only_general_labels"]]) {
      const decision = decideDeltaZeroRecordConfirmation({
        existingRecordCount: 0,
        currentContext: deltaContext,
        priorConfirmations: [confirmation("primary-election", priorConfirmedGapIds)],
      });
      expect(decision.action).toBe("error");
      if (decision.action === "error") {
        expect(decision.reason).toContain("removed since");
        expect(decision.reason).toContain("FULL discovery sweep");
        expect(decision.reason).not.toContain("never closed");
      }
    }
  });
});

describe("annotateDroppedRecordsWithStoredRows", () => {
  const droppedStoredResubmission: CandidateRecordDroppedRecord = {
    record: {
      description: "Opposed spending taxpayer funds on a second police helicopter.",
      source_url: "https://www.millerformayor.example/latest-news",
      event_date: "2025-04-08",
    },
    reason:
      "source domain 'www.millerformayor.example' appears to be the candidate's own campaign or personal site; self-promotion is not acceptable record evidence — cite an independent publisher",
    failureType: "permanent",
    failureKind: "source_url",
  };
  const storedKey = buildCandidateRecordIdentityKey({
    description: droppedStoredResubmission.record.description,
    sourceUrl: droppedStoredResubmission.record.source_url,
    eventDate: droppedStoredResubmission.record.event_date,
  });

  it("tells the operator a live stored re-submission is not a repair job", () => {
    const [annotated] = annotateDroppedRecordsWithStoredRows(
      [droppedStoredResubmission],
      [{ recordIdentityKey: storedKey, id: "rec-1", retiredAt: null }]
    );

    expect(annotated!.reason).toContain("already stored (candidate_records.id rec-1, live)");
    expect(annotated!.reason).toContain("never re-validates or modifies stored rows");
    expect(annotated!.reason).toContain("manual:records:retire");
    // The original rejection stays first so the operator still sees WHY it dropped.
    expect(annotated!.reason.startsWith("source domain")).toBe(true);
  });

  it("marks a retired stored match as a stale-export row, without the retire directive", () => {
    const [annotated] = annotateDroppedRecordsWithStoredRows(
      [droppedStoredResubmission],
      [{ recordIdentityKey: storedKey, id: "rec-1", retiredAt: "2026-08-26" }]
    );

    expect(annotated!.reason).toContain("already stored AND retired (candidate_records.id rec-1, retired 2026-08-26)");
    expect(annotated!.reason).toContain("stale export");
    expect(annotated!.reason).not.toContain("manual:records:retire");
  });

  it("leaves genuinely new dropped rows untouched", () => {
    const newRow: CandidateRecordDroppedRecord = {
      ...droppedStoredResubmission,
      record: { ...droppedStoredResubmission.record, description: "A different new claim entirely." },
    };

    const [annotated] = annotateDroppedRecordsWithStoredRows(
      [newRow],
      [{ recordIdentityKey: storedKey, id: "rec-1", retiredAt: null }]
    );

    expect(annotated).toEqual(newRow);
  });

  it("overrides focusedResearchPass with a no-research instruction for a live stored match", () => {
    const [annotated] = annotateDroppedRecordsWithStoredRows(
      [droppedStoredResubmission],
      [{ recordIdentityKey: storedKey, id: "rec-1", retiredAt: null }]
    );
    const gap = droppedRecordToGap(annotated!, 0);

    expect(gap.outcome).toBe("needs_repair");
    expect(gap.focusedResearchPass).toContain("No research needed");
    expect(gap.focusedResearchPass).toContain("candidate_records.id rec-1 (live)");
    expect(gap.focusedResearchPass).toContain("realign the labels file record_index values");
    expect(gap.focusedResearchPass).toContain("manual:records:retire");
    expect(gap.focusedResearchPass).not.toContain("Replace bad URLs");
  });

  it("overrides focusedResearchPass with the stale-export instruction for a retired stored match", () => {
    const [annotated] = annotateDroppedRecordsWithStoredRows(
      [droppedStoredResubmission],
      [{ recordIdentityKey: storedKey, id: "rec-1", retiredAt: "2026-08-26" }]
    );
    const gap = droppedRecordToGap(annotated!, 0);

    expect(gap.focusedResearchPass).toContain("No research needed");
    expect(gap.focusedResearchPass).toContain("already retired 2026-08-26");
    expect(gap.focusedResearchPass).toContain("stale export");
    expect(gap.focusedResearchPass).not.toContain("manual:records:retire");
  });

  it("keeps the per-kind research instruction when no stored match exists", () => {
    const gap = droppedRecordToGap(droppedStoredResubmission, 0);

    expect(gap.focusedResearchPass).toContain("source/schema repair pass");
  });

  it("matches through identity normalization (trailing slash, case), like the upsert would", () => {
    const slashVariant: CandidateRecordDroppedRecord = {
      ...droppedStoredResubmission,
      record: {
        ...droppedStoredResubmission.record,
        source_url: "HTTPS://WWW.millerformayor.example/latest-news/",
      },
    };

    const [annotated] = annotateDroppedRecordsWithStoredRows(
      [slashVariant],
      [{ recordIdentityKey: storedKey, id: "rec-1", retiredAt: null }]
    );

    expect(annotated!.reason).toContain("candidate_records.id rec-1");
  });
});

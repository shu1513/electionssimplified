import { describe, expect, it } from "vitest";

import {
  SWEEP_COMPLETENESS_GAP_IDS,
  SWEEP_EVIDENCE_MIN_ENTRIES,
  SWEEP_ROUTE_QUESTION_IDS,
  assertedSweepCompletenessGapIds,
  claimsSupportedByRecordSet,
  deleteSweepCompletenessConfirmation,
  mergeSweepEvidenceEntries,
  parseStoredSweepEvidenceEntries,
  pruneUnsupportedSweepClaims,
  writeMergedSweepConfirmation,
  currentOfficeRoutingContradiction,
  deleteSweepConfirmation,
  deltaSweepRoutingContradiction,
  enforceSweepRouteCoverage,
  hasHeldPublicOfficeContradiction,
  listMissingSweepRouteQuestionIds,
  parseSweepEvidencePayload,
  persistHasHeldPublicOfficeAnswer,
  refreshSweepConfirmationTimestamp,
  resolveSweepRoute,
  retainSuppliedSweepEvidence,
  sweepEvidenceRequired,
  upsertSweepConfirmation,
  type SweepEvidenceEntry,
} from "../../src/scripts/candidateRecordSweepEvidence.js";
import { readValueFlag } from "../../src/scripts/clearStaleSweepCompletenessClaims.js";
import { isConfirmedNull } from "../../src/scripts/auditCandidateRecordsCompleteness.js";
import { buildCandidateRecordQualityGaps } from "../../src/scripts/writeManualCandidateRecords.js";

describe("sweepEvidenceRequired", () => {
  it("requires evidence for a zero-record payload even without any confirmed-gap flag", () => {
    expect(sweepEvidenceRequired({ recordCount: 0, confirmedGapIds: new Set() })).toBe(true);
  });

  it("requires evidence when no_records_found is asserted", () => {
    expect(
      sweepEvidenceRequired({
        recordCount: 0,
        confirmedGapIds: new Set(["candidate_records.no_records_found"]),
      })
    ).toBe(true);
  });

  it("requires evidence when only_general_labels is asserted on a non-empty record set", () => {
    expect(
      sweepEvidenceRequired({
        recordCount: 2,
        confirmedGapIds: new Set(["candidate_records.only_general_labels"]),
      })
    ).toBe(true);
  });

  it("does not require evidence for a normal record write", () => {
    expect(sweepEvidenceRequired({ recordCount: 3, confirmedGapIds: new Set() })).toBe(false);
  });

  it("does not require evidence for unrelated confirmed gaps", () => {
    expect(
      sweepEvidenceRequired({
        recordCount: 1,
        confirmedGapIds: new Set(["candidate_profile.current_office"]),
      })
    ).toBe(false);
  });
});

describe("parseSweepEvidencePayload", () => {
  const validEntries = [
    { question: "What major roll-call votes did they cast?", finding: "nothing found" },
    { question: "What legislation did they sponsor?", finding: "HB 123 signed 2024-05-02" },
    { question: "What endorsements did they make or receive?", finding: "nothing found" },
  ];

  it("accepts a well-formed evidence table", () => {
    const result = parseSweepEvidencePayload({ entries: validEntries });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(3);
      expect(result.entries[0].question).toContain("roll-call");
    }
  });

  it("rejects a bare array", () => {
    const result = parseSweepEvidencePayload(validEntries);
    expect(result).toEqual({
      ok: false,
      reason: "evidence payload must be an object with an entries array",
    });
  });

  it("rejects fewer than the minimum entries", () => {
    const result = parseSweepEvidencePayload({ entries: validEntries.slice(0, 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(`at least ${SWEEP_EVIDENCE_MIN_ENTRIES}`);
    }
  });

  it("rejects an entry with an empty finding", () => {
    const result = parseSweepEvidencePayload({
      entries: [...validEntries.slice(0, 2), { question: "Any court or ethics records?", finding: "  " }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("entries[2].finding");
    }
  });

  it("rejects an entry missing a question", () => {
    const result = parseSweepEvidencePayload({
      entries: [...validEntries.slice(0, 2), { finding: "nothing found" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("entries[2].question");
    }
  });

  it("rejects duplicate questions (same text repeated to pad the minimum)", () => {
    const result = parseSweepEvidencePayload({
      entries: [
        { question: "What endorsements did they receive?", finding: "nothing found" },
        { question: "what endorsements  did they receive?", finding: "nothing found" },
        { question: "Any court or ethics records?", finding: "nothing found" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("entries[1].question duplicates entries[0]");
    }
  });

  it("accepts the same question asked for distinct eras when the era is named", () => {
    const result = parseSweepEvidencePayload({
      entries: [
        { question: "Major roll-call votes (2021 session)?", finding: "nothing found" },
        { question: "Major roll-call votes (2023 session)?", finding: "HB 9 veto override" },
        { question: "Any court or ethics records?", finding: "nothing found" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("trims question and finding text", () => {
    const result = parseSweepEvidencePayload({
      entries: validEntries.map((entry) => ({
        question: `  ${entry.question}  `,
        finding: `  ${entry.finding}  `,
      })),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries[1].finding).toBe("HB 123 signed 2024-05-02");
    }
  });

  it("parses question_id tags and defaults untagged entries to null", () => {
    const result = parseSweepEvidencePayload({
      entries: [
        { question: "Career record?", finding: "founded a bakery 2019-03-02", question_id: "career" },
        { question: "Endorsements?", finding: "nothing found", question_id: "endorsements" },
        { question: "Official archive scan", finding: "no archive exists" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((entry) => entry.questionId)).toEqual([
        "career",
        "endorsements",
        null,
      ]);
    }
  });

  it("rejects an unknown question_id", () => {
    const result = parseSweepEvidencePayload({
      entries: [
        { question: "Career record?", finding: "nothing found", question_id: "resume" },
        { question: "Endorsements?", finding: "nothing found" },
        { question: "Court records?", finding: "nothing found" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("entries[0].question_id must be one of");
    }
  });

  it("parses a top-level has_held_public_office answer (absent means null)", () => {
    const withAnswer = parseSweepEvidencePayload({
      has_held_public_office: false,
      entries: validEntries,
    });
    expect(withAnswer.ok).toBe(true);
    if (withAnswer.ok) {
      expect(withAnswer.hasHeldPublicOffice).toBe(false);
    }
    const withoutAnswer = parseSweepEvidencePayload({ entries: validEntries });
    expect(withoutAnswer.ok).toBe(true);
    if (withoutAnswer.ok) {
      expect(withoutAnswer.hasHeldPublicOffice).toBeNull();
    }
  });

  it("rejects a non-boolean has_held_public_office", () => {
    const result = parseSweepEvidencePayload({
      has_held_public_office: "yes",
      entries: validEntries,
    });
    expect(result).toEqual({
      ok: false,
      reason: "evidence payload.has_held_public_office must be a boolean when present",
    });
  });
});

describe("resolveSweepRoute", () => {
  it("routes judicial contests from the contest family alone", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: "judicial_office",
      candidateCurrentOffice: null,
      candidateHasHeldPublicOffice: null,
      evidenceHasHeldPublicOffice: null,
    });
    expect(result).toEqual({ ok: true, route: "judicial", persistHasHeldPublicOffice: null });
  });

  it("routes from the stored column when set", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: "non_judicial_office",
      candidateCurrentOffice: null,
      candidateHasHeldPublicOffice: true,
      evidenceHasHeldPublicOffice: null,
    });
    expect(result).toEqual({ ok: true, route: "officeholder", persistHasHeldPublicOffice: null });
  });

  it("falls back to the evidence answer and marks it for persistence", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: null,
      candidateCurrentOffice: null,
      candidateHasHeldPublicOffice: null,
      evidenceHasHeldPublicOffice: false,
    });
    expect(result).toEqual({
      ok: true,
      route: "never_held_office",
      persistHasHeldPublicOffice: false,
    });
  });

  it("does not re-persist when the column already holds the answer", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: null,
      candidateCurrentOffice: null,
      candidateHasHeldPublicOffice: false,
      evidenceHasHeldPublicOffice: false,
    });
    expect(result).toEqual({
      ok: true,
      route: "never_held_office",
      persistHasHeldPublicOffice: null,
    });
  });

  it("refuses a contradiction between the column and the evidence file", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: "non_judicial_office",
      candidateCurrentOffice: null,
      candidateHasHeldPublicOffice: true,
      evidenceHasHeldPublicOffice: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("has_held_public_office=false");
      expect(result.reason).toContain("candidates.has_held_public_office=true");
    }
  });

  it("refuses a never-held evidence answer against a set current_office", () => {
    // Regression: a column-NULL candidate could previously claim
    // has_held_public_office=false, take the shorter never_held question
    // list, and persist the false answer — even for a sitting officeholder
    // whose current_office says so (found live: Mike Schofield, TX House).
    const result = resolveSweepRoute({
      discoveryContestFamily: "non_judicial_office",
      candidateCurrentOffice: "Texas House of Representatives District 132",
      candidateHasHeldPublicOffice: null,
      evidenceHasHeldPublicOffice: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('current_office ("Texas House of Representatives District 132")');
      expect(result.reason).toContain("--replace-profile-fields current_office");
    }
  });

  it("refuses a stored false answer against a set current_office", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: "non_judicial_office",
      candidateCurrentOffice: "Mayor of Springfield",
      candidateHasHeldPublicOffice: false,
      evidenceHasHeldPublicOffice: null,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses the false answer against a set current_office on the judicial route too", () => {
    // The judicial branch also persists a column-NULL candidate's evidence
    // answer, so the contradiction must be caught before route branching.
    const result = resolveSweepRoute({
      discoveryContestFamily: "judicial_office",
      candidateCurrentOffice: "District Court Judge",
      candidateHasHeldPublicOffice: null,
      evidenceHasHeldPublicOffice: false,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a true answer alongside a set current_office", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: "non_judicial_office",
      candidateCurrentOffice: "Mayor of Springfield",
      candidateHasHeldPublicOffice: null,
      evidenceHasHeldPublicOffice: true,
    });
    expect(result).toEqual({
      ok: true,
      route: "officeholder",
      persistHasHeldPublicOffice: true,
    });
  });

  it("refuses to route a non-judicial sweep with no officeholder answer anywhere", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: "non_judicial_office",
      candidateCurrentOffice: null,
      candidateHasHeldPublicOffice: null,
      evidenceHasHeldPublicOffice: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('"has_held_public_office": true|false');
    }
  });

  it("still persists the officeholder answer on a judicial contest when the column is NULL", () => {
    const result = resolveSweepRoute({
      discoveryContestFamily: "judicial_office",
      candidateCurrentOffice: null,
      candidateHasHeldPublicOffice: null,
      evidenceHasHeldPublicOffice: true,
    });
    expect(result).toEqual({ ok: true, route: "judicial", persistHasHeldPublicOffice: true });
  });
});

describe("currentOfficeRoutingContradiction", () => {
  it("is silent when the office is empty, blank, or the answer is not false", () => {
    expect(
      currentOfficeRoutingContradiction({ candidateCurrentOffice: null, hasHeldPublicOffice: false })
    ).toBeNull();
    expect(
      currentOfficeRoutingContradiction({ candidateCurrentOffice: "  ", hasHeldPublicOffice: false })
    ).toBeNull();
    expect(
      currentOfficeRoutingContradiction({
        candidateCurrentOffice: "Mayor of Springfield",
        hasHeldPublicOffice: true,
      })
    ).toBeNull();
    expect(
      currentOfficeRoutingContradiction({
        candidateCurrentOffice: "Mayor of Springfield",
        hasHeldPublicOffice: null,
      })
    ).toBeNull();
  });

  it("names the office and the correction paths when they contradict", () => {
    const reason = currentOfficeRoutingContradiction({
      candidateCurrentOffice: "Mayor of Springfield",
      hasHeldPublicOffice: false,
    });
    expect(reason).toContain('current_office ("Mayor of Springfield")');
    expect(reason).toContain("--clear-profile-fields current_office");
  });
});

describe("deltaSweepRoutingContradiction", () => {
  it("surfaces a stored false answer against a set office when the delta ledger omits the field", () => {
    // Regression (PR #356 review): the delta path passed only the evidence
    // answer to the office check, so this exact combination — the one the
    // full-sweep path always refuses — went silently through.
    const reason = deltaSweepRoutingContradiction({
      candidateCurrentOffice: "Mayor of Springfield",
      candidateHasHeldPublicOffice: false,
      evidenceHasHeldPublicOffice: null,
    });
    expect(reason).toContain('current_office ("Mayor of Springfield")');
  });

  it("still surfaces a stored-vs-evidence disagreement first", () => {
    const reason = deltaSweepRoutingContradiction({
      candidateCurrentOffice: null,
      candidateHasHeldPublicOffice: true,
      evidenceHasHeldPublicOffice: false,
    });
    expect(reason).toContain("candidates.has_held_public_office=true");
  });

  it("surfaces an evidence-claimed false against a set office", () => {
    const reason = deltaSweepRoutingContradiction({
      candidateCurrentOffice: "Mayor of Springfield",
      candidateHasHeldPublicOffice: null,
      evidenceHasHeldPublicOffice: false,
    });
    expect(reason).toContain('current_office ("Mayor of Springfield")');
  });

  it("is silent when the routing state is consistent", () => {
    expect(
      deltaSweepRoutingContradiction({
        candidateCurrentOffice: "Mayor of Springfield",
        candidateHasHeldPublicOffice: true,
        evidenceHasHeldPublicOffice: null,
      })
    ).toBeNull();
    expect(
      deltaSweepRoutingContradiction({
        candidateCurrentOffice: null,
        candidateHasHeldPublicOffice: false,
        evidenceHasHeldPublicOffice: null,
      })
    ).toBeNull();
    expect(
      deltaSweepRoutingContradiction({
        candidateCurrentOffice: null,
        candidateHasHeldPublicOffice: null,
        evidenceHasHeldPublicOffice: null,
      })
    ).toBeNull();
  });
});

describe("hasHeldPublicOfficeContradiction", () => {
  it("is silent when either side is unknown or they agree", () => {
    expect(
      hasHeldPublicOfficeContradiction({
        candidateHasHeldPublicOffice: null,
        evidenceHasHeldPublicOffice: false,
      })
    ).toBeNull();
    expect(
      hasHeldPublicOfficeContradiction({
        candidateHasHeldPublicOffice: true,
        evidenceHasHeldPublicOffice: null,
      })
    ).toBeNull();
    expect(
      hasHeldPublicOfficeContradiction({
        candidateHasHeldPublicOffice: true,
        evidenceHasHeldPublicOffice: true,
      })
    ).toBeNull();
  });

  it("names both values when they disagree", () => {
    const reason = hasHeldPublicOfficeContradiction({
      candidateHasHeldPublicOffice: true,
      evidenceHasHeldPublicOffice: false,
    });
    expect(reason).toContain("has_held_public_office=false");
    expect(reason).toContain("candidates.has_held_public_office=true");
  });
});

describe("enforceSweepRouteCoverage", () => {
  const neverHeldEntries = SWEEP_ROUTE_QUESTION_IDS.never_held_office.map((id, index) => ({
    question: `question ${index}?`,
    finding: "nothing found",
    questionId: id,
  }));

  it("returns the route and persistence answer for a covered sweep", () => {
    expect(
      enforceSweepRouteCoverage({
        discoveryContestFamily: "non_judicial_office",
        candidateCurrentOffice: null,
        candidateHasHeldPublicOffice: null,
        evidenceHasHeldPublicOffice: false,
        entries: neverHeldEntries,
      })
    ).toEqual({ route: "never_held_office", persistHasHeldPublicOffice: false });
  });

  it("throws the routing error when unroutable", () => {
    expect(() =>
      enforceSweepRouteCoverage({
        discoveryContestFamily: null,
        candidateCurrentOffice: null,
        candidateHasHeldPublicOffice: null,
        evidenceHasHeldPublicOffice: null,
        entries: neverHeldEntries,
      })
    ).toThrow(/Sweep evidence routing failed/);
  });

  it("throws the coverage error naming the missing question ids", () => {
    expect(() =>
      enforceSweepRouteCoverage({
        discoveryContestFamily: null,
        candidateCurrentOffice: null,
        candidateHasHeldPublicOffice: false,
        evidenceHasHeldPublicOffice: null,
        entries: neverHeldEntries.slice(1),
      })
    ).toThrow(/missing question_id career/);
  });
});

describe("persistHasHeldPublicOfficeAnswer", () => {
  function clientWith(handlers: {
    updateRowCount: number;
    storedValue?: boolean | null;
  }) {
    const calls: { text: string; values: unknown[] }[] = [];
    return {
      calls,
      client: {
        query: async (text: string, values?: unknown[]) => {
          calls.push({ text, values: values ?? [] });
          if (text.includes("UPDATE public.candidates")) {
            return { rows: [], rowCount: handlers.updateRowCount } as never;
          }
          return {
            rows: [{ has_held_public_office: handlers.storedValue ?? null }],
            rowCount: 1,
          } as never;
        },
      },
    };
  }

  it("updates the NULL column and skips the re-read", async () => {
    const { calls, client } = clientWith({ updateRowCount: 1 });
    await persistHasHeldPublicOfficeAnswer(client as never, "candidate-1", true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("has_held_public_office IS NULL");
    expect(calls[0]!.values).toEqual(["candidate-1", true]);
  });

  it("accepts a concurrent write that persisted the SAME answer", async () => {
    const { calls, client } = clientWith({ updateRowCount: 0, storedValue: true });
    await persistHasHeldPublicOfficeAnswer(client as never, "candidate-1", true);
    expect(calls).toHaveLength(2);
  });

  it("throws when a concurrent write persisted the OPPOSITE answer", async () => {
    const { client } = clientWith({ updateRowCount: 0, storedValue: false });
    await expect(
      persistHasHeldPublicOfficeAnswer(client as never, "candidate-1", true)
    ).rejects.toThrow(/concurrent write landed first/);
  });
});

describe("listMissingSweepRouteQuestionIds", () => {
  const entry = (questionId: string | null, question: string): SweepEvidenceEntry => ({
    question,
    finding: "nothing found",
    questionId,
  });

  it("passes a never-held sweep that tags every route question", () => {
    const entries = SWEEP_ROUTE_QUESTION_IDS.never_held_office.map((id, index) =>
      entry(id, `question ${index}?`)
    );
    expect(listMissingSweepRouteQuestionIds(entries, "never_held_office")).toEqual([]);
  });

  it("reports the untagged career question the 2026-07-15 templates skipped", () => {
    const entries = [
      entry("orgs_advocacy", "Organizations/committees/advocacy?"),
      entry("court_legal", "Court, ethics, or regulatory proceedings?"),
      entry("endorsements", "Endorsements made/received?"),
      entry(null, "Major official actions / roll-call votes / sponsored legislation?"),
    ];
    expect(listMissingSweepRouteQuestionIds(entries, "never_held_office")).toEqual(["career"]);
  });

  it("counts era-split entries tagged with the same id once and ignores extras", () => {
    const entries = [
      entry("cases", "Notable cases (pre-bench era)?"),
      entry("cases", "Notable cases (on the bench)?"),
      entry("discipline", "Any discipline or reversals?"),
      entry("endorsements", "Endorsements?"),
      entry(null, "Official archive scan"),
    ];
    expect(listMissingSweepRouteQuestionIds(entries, "judicial")).toEqual([]);
  });

  it("requires every officeholder question, including executive, even for legislators", () => {
    const entries = SWEEP_ROUTE_QUESTION_IDS.officeholder
      .filter((id) => id !== "executive")
      .map((id, index) => entry(id, `question ${index}?`));
    expect(listMissingSweepRouteQuestionIds(entries, "officeholder")).toEqual(["executive"]);
  });
});

describe("neutral-only writes trigger the evidence guard via quality gaps", () => {
  it("raises only_general_labels — a SWEEP_COMPLETENESS_GAP_ID — for an all-neutral label set", () => {
    const gaps = buildCandidateRecordQualityGaps({
      recordCount: 2,
      labels: [
        { research_area_slug: "general" },
        { research_area_slug: "integrity_and_ethics" },
      ],
    });
    expect(gaps.some((gap) => SWEEP_COMPLETENESS_GAP_IDS.has(gap.id))).toBe(true);
  });

  it("raises no_records_found — a SWEEP_COMPLETENESS_GAP_ID — for a zero-record payload", () => {
    const gaps = buildCandidateRecordQualityGaps({ recordCount: 0, labels: [] });
    expect(gaps.some((gap) => SWEEP_COMPLETENESS_GAP_IDS.has(gap.id))).toBe(true);
  });

  it("raises no completeness gap for a stance-bearing record set", () => {
    const gaps = buildCandidateRecordQualityGaps({
      recordCount: 1,
      labels: [{ research_area_slug: "healthcare_affordability" }],
    });
    expect(gaps.some((gap) => SWEEP_COMPLETENESS_GAP_IDS.has(gap.id))).toBe(false);
  });
});

describe("assertedSweepCompletenessGapIds", () => {
  it("implies no_records_found for a zero-record payload without any flag", () => {
    expect(
      assertedSweepCompletenessGapIds({ recordCount: 0, confirmedGapIds: new Set(), qualityGapIds: [] })
    ).toEqual(["candidate_records.no_records_found"]);
  });

  it("collects the only_general_labels claim from either the flag or the detected quality gap", () => {
    expect(
      assertedSweepCompletenessGapIds({
        recordCount: 2,
        confirmedGapIds: new Set(["candidate_records.only_general_labels"]),
        qualityGapIds: [],
      })
    ).toEqual(["candidate_records.only_general_labels"]);
    expect(
      assertedSweepCompletenessGapIds({
        recordCount: 2,
        confirmedGapIds: new Set(),
        qualityGapIds: ["candidate_records.only_general_labels"],
      })
    ).toEqual(["candidate_records.only_general_labels"]);
  });

  it("ignores non-completeness gap ids and dedupes overlapping claims", () => {
    expect(
      assertedSweepCompletenessGapIds({
        recordCount: 0,
        confirmedGapIds: new Set(["candidate_records.no_records_found", "candidate_records.payload"]),
        qualityGapIds: ["candidate_records.no_records_found", "candidate_records.dropped.0"],
      })
    ).toEqual(["candidate_records.no_records_found"]);
  });
});

describe("upsertSweepConfirmation", () => {
  it("writes one upsert row keyed by candidate and context with the evidence entries as jsonb", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 1 } as never;
      },
    };

    await upsertSweepConfirmation(client as never, {
      candidateId: "candidate-1",
      confirmedGapIds: ["candidate_records.no_records_found"],
      entries: [
        { question: "votes?", finding: "nothing found", questionId: "rollcalls" },
        { question: "litigation?", finding: "nothing found", questionId: "proceedings" },
        { question: "endorsements?", finding: "nothing found", questionId: null },
      ],
      contextType: "election",
      contextId: "election-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("INSERT INTO public.candidate_record_sweep_confirmations");
    expect(calls[0]!.text).toContain(
      "ON CONFLICT (candidate_id, context_type, context_id)"
    );
    expect(calls[0]!.values[0]).toBe("candidate-1");
    expect(calls[0]!.values[1]).toEqual(["candidate_records.no_records_found"]);
    // Stored entries mirror the evidence-file contract: snake_case
    // question_id, omitted entirely on untagged entries.
    expect(JSON.parse(calls[0]!.values[2] as string)).toEqual({
      entries: [
        { question: "votes?", finding: "nothing found", question_id: "rollcalls" },
        { question: "litigation?", finding: "nothing found", question_id: "proceedings" },
        { question: "endorsements?", finding: "nothing found" },
      ],
    });
    expect(calls[0]!.values[3]).toBe("election");
    expect(calls[0]!.values[4]).toBe("election-1");
  });

  it("accepts an empty claim set for a stance-bearing evidenced sweep", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 1 } as never;
      },
    };

    await upsertSweepConfirmation(client as never, {
      candidateId: "candidate-1",
      confirmedGapIds: [],
      entries: [
        { question: "votes?", finding: "HB 9 veto override", questionId: "rollcalls" },
        { question: "litigation?", finding: "nothing found", questionId: "proceedings" },
        { question: "endorsements?", finding: "endorsed by union local 12", questionId: "endorsements" },
      ],
      contextType: "election",
      contextId: "election-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values[1]).toEqual([]);
  });
});

describe("refreshSweepConfirmationTimestamp", () => {
  it("refreshes only the matching candidate and context", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 1 } as never;
      },
    };

    await refreshSweepConfirmationTimestamp(client as never, {
      candidateId: "candidate-1",
      contextType: "election",
      contextId: "election-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("context_type = $2");
    expect(calls[0]!.text).toContain("context_id = $3");
    expect(calls[0]!.values).toEqual(["candidate-1", "election", "election-1"]);
  });
});

describe("deleteSweepCompletenessConfirmation", () => {
  it("removes only completeness-claim rows, matched by gap-id overlap", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 1 } as never;
      },
    };

    await deleteSweepCompletenessConfirmation(client as never, "candidate-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("DELETE FROM public.candidate_record_sweep_confirmations");
    // Overlap predicate: an empty-claim-set row ('{}' && ARRAY[...] is false)
    // survives — finding records does not falsify "sweep ran, stances found".
    expect(calls[0]!.text).toContain("confirmed_gap_ids && $2::text[]");
    expect(calls[0]!.values[0]).toBe("candidate-1");
    expect([...(calls[0]!.values[1] as string[])].sort()).toEqual([
      "candidate_records.no_records_found",
      "candidate_records.only_general_labels",
    ]);
  });
});

describe("deleteSweepConfirmation", () => {
  it("removes any confirmation row unconditionally (writers that advance no search stamp)", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 1 } as never;
      },
    };

    await deleteSweepConfirmation(client as never, {
      candidateId: "candidate-1",
      contextType: "presidential_cycle",
      contextId: "cycle-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("DELETE FROM public.candidate_record_sweep_confirmations");
    // No gap-id predicate: without an advancing last_records_searched_at
    // stamp (presidential writer), a surviving empty-claim-set row could
    // never be dated as historical.
    expect(calls[0]!.text).not.toContain("confirmed_gap_ids");
    expect(calls[0]!.text).toContain("context_type = $2");
    expect(calls[0]!.text).toContain("context_id = $3");
    expect(calls[0]!.values).toEqual(["candidate-1", "presidential_cycle", "cycle-1"]);
  });
});

describe("retainSuppliedSweepEvidence", () => {
  it("keeps supplied entries on any full-history write", () => {
    expect(retainSuppliedSweepEvidence({ evidenceRequired: false, deltaMode: false })).toBe(true);
    expect(retainSuppliedSweepEvidence({ evidenceRequired: true, deltaMode: false })).toBe(true);
  });

  it("keeps delta entries only when the zero-record path required them", () => {
    expect(retainSuppliedSweepEvidence({ evidenceRequired: true, deltaMode: true })).toBe(true);
  });

  it("leaves a non-required window ledger external in delta mode", () => {
    expect(retainSuppliedSweepEvidence({ evidenceRequired: false, deltaMode: true })).toBe(false);
  });
});

describe("audit isConfirmedNull", () => {
  it("accepts a no_records_found confirmation that covers the latest search", () => {
    expect(
      isConfirmedNull({
        confirmed_gap_ids: ["candidate_records.no_records_found"],
        confirmation_covers_latest_search: true,
      })
    ).toBe(true);
  });

  it("rejects a stale confirmation — a later search re-stamped past the evidence", () => {
    expect(
      isConfirmedNull({
        confirmed_gap_ids: ["candidate_records.no_records_found"],
        confirmation_covers_latest_search: false,
      })
    ).toBe(false);
  });

  it("rejects a candidate with no confirmation at all", () => {
    expect(
      isConfirmedNull({ confirmed_gap_ids: null, confirmation_covers_latest_search: null })
    ).toBe(false);
  });

  it("rejects a current confirmation that never asserted no_records_found", () => {
    expect(
      isConfirmedNull({
        confirmed_gap_ids: ["candidate_records.only_general_labels"],
        confirmation_covers_latest_search: true,
      })
    ).toBe(false);
  });
});

describe("claimsSupportedByRecordSet", () => {
  const ONLY_GENERAL = "candidate_records.only_general_labels";
  const NO_RECORDS = "candidate_records.no_records_found";

  it("drops only_general_labels when any active record is stance-labeled", () => {
    expect(
      claimsSupportedByRecordSet([ONLY_GENERAL], { activeRecordCount: 130, stanceLabeledRecordCount: 124 })
    ).toEqual([]);
  });

  it("keeps only_general_labels when every active record is general", () => {
    expect(
      claimsSupportedByRecordSet([ONLY_GENERAL], { activeRecordCount: 3, stanceLabeledRecordCount: 0 })
    ).toEqual([ONLY_GENERAL]);
  });

  it("keeps no_records_found only for a candidate with zero active records", () => {
    expect(claimsSupportedByRecordSet([NO_RECORDS], { activeRecordCount: 0, stanceLabeledRecordCount: 0 })).toEqual([
      NO_RECORDS,
    ]);
    expect(claimsSupportedByRecordSet([NO_RECORDS], { activeRecordCount: 2, stanceLabeledRecordCount: 0 })).toEqual([]);
  });
});

describe("mergeSweepEvidenceEntries", () => {
  it("keeps prior entries, replaces a re-asked question in place, and appends new ones", () => {
    const merged = mergeSweepEvidenceEntries(
      [
        { question: "Roll-call votes?", finding: "HB 9 yes", questionId: "rollcalls" },
        { question: "Endorsements?", finding: "nothing found", questionId: "endorsements" },
      ],
      [
        { question: "  endorsements? ", finding: "union local 12", questionId: "endorsements" },
        { question: "Court cases?", finding: "nothing found", questionId: null },
      ]
    );
    expect(merged).toEqual([
      { question: "Roll-call votes?", finding: "HB 9 yes", questionId: "rollcalls" },
      { question: "  endorsements? ", finding: "union local 12", questionId: "endorsements" },
      { question: "Court cases?", finding: "nothing found", questionId: null },
    ]);
  });
});

describe("parseStoredSweepEvidenceEntries", () => {
  it("reads the stored snake_case shape and skips malformed entries", () => {
    expect(
      parseStoredSweepEvidenceEntries({
        entries: [
          { question: "votes?", finding: "HB 9", question_id: "rollcalls" },
          { question: "", finding: "x" },
          "junk",
          { question: "archive?", finding: "nothing found" },
        ],
      })
    ).toEqual([
      { question: "votes?", finding: "HB 9", questionId: "rollcalls" },
      { question: "archive?", finding: "nothing found", questionId: null },
    ]);
    expect(parseStoredSweepEvidenceEntries(null)).toEqual([]);
  });
});

describe("writeMergedSweepConfirmation", () => {
  function fakeClient(input: { priorEvidence: unknown; activeRecords: number; stanceLabeledRecords: number }) {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        if (text.includes("FOR UPDATE")) {
          return { rows: input.priorEvidence === null ? [] : [{ evidence: input.priorEvidence }], rowCount: 1 };
        }
        if (text.includes("active_record_count")) {
          return {
            rows: [
              {
                active_record_count: String(input.activeRecords),
                stance_labeled_record_count: String(input.stanceLabeledRecords),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: text.includes("UPDATE") ? 1 : 1 };
      },
    };
    return { client, calls };
  }

  it("does not claim only_general_labels when an all-general batch lands on a candidate with stanced records", async () => {
    // Nick Allen shape: a small additive write of general-only rows on a
    // candidate with 124 stance-labeled records.
    const { client, calls } = fakeClient({
      priorEvidence: {
        entries: [
          { question: "Roll-call votes?", finding: "many votes", question_id: "rollcalls" },
          { question: "Sponsorship?", finding: "SB 12", question_id: "sponsorship" },
        ],
      },
      activeRecords: 130,
      stanceLabeledRecords: 124,
    });

    const result = await writeMergedSweepConfirmation(client as never, {
      candidateId: "candidate-1",
      assertedGapIds: ["candidate_records.only_general_labels"],
      entries: [{ question: "Leadership roles?", finding: "caucus chair", questionId: "leadership" }],
      contextType: "election",
      contextId: "election-1",
    });

    // The per-candidate lock comes before the ledger read, so two first
    // writes cannot both see "no ledger".
    expect(calls[0]!.text).toContain("pg_advisory_xact_lock");
    expect(calls[0]!.values).toEqual(["candidate-1"]);
    expect(calls[1]!.text).toContain("FOR UPDATE");
    expect(result.confirmedGapIds).toEqual([]);
    expect(result.droppedGapIds).toEqual(["candidate_records.only_general_labels"]);
    expect(result.entryCount).toBe(3);

    const insert = calls.find((call) => call.text.includes("INSERT INTO public.candidate_record_sweep_confirmations"));
    expect(insert?.values[1]).toEqual([]);
    expect(JSON.parse(insert?.values[2] as string).entries.map((entry: { question: string }) => entry.question)).toEqual([
      "Roll-call votes?",
      "Sponsorship?",
      "Leadership roles?",
    ]);
    // Other contexts' now-false claims are pruned too (both completeness
    // ids are false for a candidate with stance-labeled records).
    const prune = calls.find((call) => call.text.includes("unnest(confirmed_gap_ids)"));
    expect(prune?.values).toEqual([
      "candidate-1",
      ["candidate_records.no_records_found", "candidate_records.only_general_labels"],
    ]);
    expect(result.otherContextRowsPruned).toBe(1);
  });

  it("keeps only_general_labels when every active record is general", async () => {
    const { client, calls } = fakeClient({ priorEvidence: null, activeRecords: 2, stanceLabeledRecords: 0 });

    const result = await writeMergedSweepConfirmation(client as never, {
      candidateId: "candidate-1",
      assertedGapIds: ["candidate_records.only_general_labels"],
      entries: [
        { question: "Career?", finding: "school board", questionId: "career" },
        { question: "Orgs?", finding: "nothing found", questionId: "orgs_advocacy" },
        { question: "Court?", finding: "nothing found", questionId: "court_legal" },
      ],
      contextType: "election",
      contextId: "election-1",
    });

    expect(result.confirmedGapIds).toEqual(["candidate_records.only_general_labels"]);
    expect(result.droppedGapIds).toEqual([]);
    const insert = calls.find((call) => call.text.includes("INSERT INTO"));
    expect(insert?.values[1]).toEqual(["candidate_records.only_general_labels"]);
  });
});

describe("pruneUnsupportedSweepClaims", () => {
  it("does nothing when the record set supports every claim", async () => {
    const calls: unknown[] = [];
    const client = { query: async (...args: unknown[]) => (calls.push(args), { rows: [], rowCount: 0 }) };
    const changed = await pruneUnsupportedSweepClaims(client as never, "candidate-1", {
      activeRecordCount: 0,
      stanceLabeledRecordCount: 0,
    }, ["candidate_records.no_records_found"]);
    expect(changed).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("clear-stale-claims readValueFlag", () => {
  it("rejects a flag without a value instead of dropping the filter", () => {
    expect(() => readValueFlag(["--apply", "--candidate-id"], "--candidate-id")).toThrow("needs a value");
    expect(() => readValueFlag(["--candidate-id", "--apply"], "--candidate-id")).toThrow("needs a value");
    expect(readValueFlag(["--candidate-id", "abc"], "--candidate-id")).toBe("abc");
    expect(readValueFlag(["--apply"], "--candidate-id")).toBeNull();
  });
});

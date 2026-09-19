import { describe, expect, it } from "vitest";

import { parseCandidateRosterPayload } from "../../src/contracts/candidateRosterPayloadContract.js";

describe("parseCandidateRosterPayload", () => {
  it("parses valid candidate roster payload", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          party: "Independent",
          is_incumbent: true,
          state_filing_ids: ["CA-123"],
          sources: ["https://example.org/a", "https://example.org/a"],
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.payload.candidates).toEqual([
      {
        display_name: "Jane Doe",
        party: "Independent",
        is_incumbent: true,
        state_filing_ids: ["CA-123"],
        sources: ["https://example.org/a"],
      },
    ]);
  });

  it("rejects candidate row without sources", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [{ display_name: "Jane Doe", sources: [] }],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toBe("payload.candidates[0]: row.sources must contain at least one valid URL");
  });

  it("strips trailing roster footnote markers from display names", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        { display_name: "Jill Oberlander *", sources: ["https://example.org/a"] },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.candidates[0]?.display_name).toBe("Jill Oberlander");
    }
  });

  it("rejects a display name that is only footnote markers", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [{ display_name: " * ", sources: ["https://example.org/a"] }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("not only footnote markers");
    }
  });

  it("rejects a running-mate name that is only footnote markers", () => {
    // The ticket lead was re-checked after stripping but the running mate was
    // not, so " * " cleared the non-empty check, stripped to "", and was
    // stored as an empty name — the downstream profile draft is then silently
    // skipped and the running mate disappears.
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          sources: ["https://example.org/a"],
          running_mate: { display_name: " * ", sources: ["https://example.org/b"] },
        },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("row.running_mate.display_name");
      expect(parsed.reason).toContain("not only footnote markers");
    }
  });

  it("still strips markers from a valid running-mate name", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          sources: ["https://example.org/a"],
          running_mate: { display_name: "John Smith *", sources: ["https://example.org/b"] },
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.candidates[0]?.running_mate?.display_name).toBe("John Smith");
    }
  });

  it("sees a running mate as the ticket lead once footnote markers are stripped", () => {
    // Without stripping, "Jane Doe *" and "Jane Doe" read as two people and
    // the same person would be stored twice on one ticket.
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          sources: ["https://example.org/a"],
          running_mate: { display_name: "Jane Doe *", sources: ["https://example.org/b"] },
        },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("must differ from the ticket lead");
    }
  });

  it("preserves duplicate candidate display names within one payload", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          party: "Independent",
          sources: ["https://example.org/a"],
        },
        {
          display_name: "  JANE   DOE ",
          party: "Party X",
          sources: ["https://example.org/b"],
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.payload.candidates).toEqual([
      {
        display_name: "Jane Doe",
        party: "Independent",
        sources: ["https://example.org/a"],
      },
      {
        display_name: "JANE   DOE",
        party: "Party X",
        sources: ["https://example.org/b"],
      },
    ]);
  });

  it("filters federal roster candidates without fec_ids and reports them", () => {
    const parsed = parseCandidateRosterPayload(
      {
        candidates: [
          {
            display_name: "No Fec Filer",
            sources: ["https://example.org/a"],
          },
          {
            display_name: "Jane Doe",
            fec_ids: ["S0XX00001"],
            sources: ["https://example.org/b"],
          },
          {
            display_name: "Unregistered Runner",
            sources: ["https://example.org/c"],
          },
          {
            display_name: "John Roe",
            fec_ids: ["S0XX00002"],
            sources: ["https://example.org/d"],
          },
        ],
      },
      { requireFecIds: true, allowFecIds: true }
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.payload.candidates.map((candidate) => candidate.display_name)).toEqual([
      "Jane Doe",
      "John Roe",
    ]);
    expect(parsed.skippedCandidatesWithoutFecIds).toEqual(["No Fec Filer", "Unregistered Runner"]);
    expect(parsed.keptCandidateIndexes).toEqual([1, 3]);
  });

  it("fails a federal roster when no candidate has a fec_id", () => {
    const parsed = parseCandidateRosterPayload(
      {
        candidates: [
          {
            display_name: "Jane Doe",
            sources: ["https://example.org/a"],
          },
        ],
      },
      { requireFecIds: true, allowFecIds: true }
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toBe(
      "payload.candidates: no candidate has a FEC ID for this federal contest (skipped: Jane Doe)"
    );
  });

  it("does not filter and reports no skips when fec_ids are not required", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          sources: ["https://example.org/a"],
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.payload.candidates).toHaveLength(1);
    expect(parsed.skippedCandidatesWithoutFecIds).toEqual([]);
    expect(parsed.keptCandidateIndexes).toEqual([0]);
  });

  it("accepts fec_ids for federal roster mode", () => {
    const parsed = parseCandidateRosterPayload(
      {
        candidates: [
          {
            display_name: "Jane Doe",
            fec_ids: ["H0XX00000"],
            sources: ["https://example.org/a"],
          },
        ],
      },
      { requireFecIds: true, allowFecIds: true }
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.payload.candidates[0]?.fec_ids).toEqual(["H0XX00000"]);
  });

  it("rejects fec_ids when allowFecIds is disabled (state-level mode)", () => {
    const parsed = parseCandidateRosterPayload(
      {
        candidates: [
          {
            display_name: "Jane Doe",
            fec_ids: ["H0XX00000"],
            sources: ["https://example.org/a"],
          },
        ],
      },
      { allowFecIds: false }
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toBe("payload.candidates[0]: row.fec_ids is not allowed for this election context");
  });

  it("parses joint-ticket running mates and rejects malformed ones", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Begich, Tom",
          party: "Democrat",
          running_mate: {
            display_name: "Hnilicka, Julia",
            party: "Democrat",
            sources: ["https://www.elections.alaska.gov/candidates/?election=26prim"],
          },
          sources: ["https://www.elections.alaska.gov/candidates/?election=26prim"],
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.payload.candidates[0]?.running_mate).toEqual({
      display_name: "Hnilicka, Julia",
      party: "Democrat",
      sources: ["https://www.elections.alaska.gov/candidates/?election=26prim"],
    });

    const missingSources = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Begich, Tom",
          running_mate: { display_name: "Hnilicka, Julia" },
          sources: ["https://example.org/a"],
        },
      ],
    });
    expect(missingSources.ok).toBe(false);
    if (!missingSources.ok) {
      expect(missingSources.reason).toBe(
        "payload.candidates[0]: row.running_mate.sources must contain at least one valid URL"
      );
    }

    const sameName = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Begich, Tom",
          running_mate: {
            display_name: "  begich, tom ",
            sources: ["https://example.org/a"],
          },
          sources: ["https://example.org/a"],
        },
      ],
    });
    expect(sameName.ok).toBe(false);
    if (!sameName.ok) {
      expect(sameName.reason).toBe(
        "payload.candidates[0]: row.running_mate.display_name must differ from the ticket lead's display_name"
      );
    }
  });

  it("accepts optional state_filing_ids when present", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          state_filing_ids: ["CA-777", "CA-777"],
          sources: ["https://example.org/a"],
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.payload.candidates[0]?.state_filing_ids).toEqual(["CA-777"]);
  });

  it("rejects a candidate sourced from a UGC/social platform domain", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          sources: ["https://www.facebook.com/janedoe/posts/123"],
        },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toContain("payload.candidates[0]: row.sources:");
    expect(parsed.reason).toContain("facebook.com");
    expect(parsed.reason).toContain("user-generated/social platform");
  });

  it("rejects a candidate sourced from a generated candidate directory", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          sources: ["https://civoren.com/candidates/jane-doe"],
        },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toContain("auto-generated candidate directory");
  });

  it("rejects a running mate sourced from a blocked platform domain", () => {
    const parsed = parseCandidateRosterPayload({
      candidates: [
        {
          display_name: "Jane Doe",
          sources: ["https://sos.example.gov/qualified-list"],
          running_mate: {
            display_name: "John Roe",
            sources: ["https://x.com/johnroe/status/456"],
          },
        },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toContain("row.running_mate.sources:");
    expect(parsed.reason).toContain("user-generated/social platform");
  });

  it("skips the source-domain policy when enforceSourcePolicy is false", () => {
    // Re-parses of already-written staging payloads (profile write, fanout)
    // must keep working for rosters imported before the policy existed.
    const parsed = parseCandidateRosterPayload(
      {
        candidates: [
          {
            display_name: "Jane Doe",
            sources: ["https://www.facebook.com/janedoe/posts/123"],
          },
        ],
      },
      { enforceSourcePolicy: false }
    );

    expect(parsed.ok).toBe(true);
  });
});

describe("parseCandidateRosterPayload no_fec_id_exception", () => {
  const officialUrl = "https://elections.example.gov/certified-candidates";
  function exceptionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      display_name: "Ivy Independent",
      party: "Independent",
      sources: [officialUrl],
      no_fec_id_exception: {
        reason: "  Certified for the ballot; OpenFEC shows a committee but no candidate ID.  ",
        official_roster_url: officialUrl,
      },
      ...overrides,
    };
  }
  const registeredRow = {
    display_name: "Rhea Registered",
    fec_ids: ["H6OH04082"],
    sources: ["https://www.fec.gov/data/candidate/H6OH04082/"],
  };
  const federalManual = { allowFecIds: true, requireFecIds: true, allowNoFecIdException: true };

  it("keeps a federal row without FEC IDs when the manual path allows the exception", () => {
    const parsed = parseCandidateRosterPayload({ candidates: [registeredRow, exceptionRow()] }, federalManual);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.skippedCandidatesWithoutFecIds).toEqual([]);
    expect(parsed.keptCandidateIndexes).toEqual([0, 1]);
    expect(parsed.payload.candidates[1]).toEqual({
      display_name: "Ivy Independent",
      party: "Independent",
      no_fec_id_exception: {
        reason: "Certified for the ballot; OpenFEC shows a committee but no candidate ID.",
        official_roster_url: officialUrl,
      },
      sources: [officialUrl],
    });
  });

  it("ignores the exception by default, so the AI path still skips the row", () => {
    const parsed = parseCandidateRosterPayload(
      { candidates: [registeredRow, exceptionRow()] },
      { allowFecIds: true, requireFecIds: true }
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.skippedCandidatesWithoutFecIds).toEqual(["Ivy Independent"]);
    expect(parsed.payload.candidates).toHaveLength(1);
    expect(parsed.payload.candidates[0]).not.toHaveProperty("no_fec_id_exception");
  });

  it("still skips federal rows that have neither FEC IDs nor the exception", () => {
    const parsed = parseCandidateRosterPayload(
      { candidates: [registeredRow, exceptionRow({ no_fec_id_exception: undefined })] },
      federalManual
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.skippedCandidatesWithoutFecIds).toEqual(["Ivy Independent"]);
  });

  it.each([
    ["a missing reason", { reason: " ", official_roster_url: officialUrl }, "no_fec_id_exception.reason"],
    ["an invalid URL", { reason: "Certified.", official_roster_url: "not a url" }, "official_roster_url must be a valid"],
    [
      "a URL that is not one of the row sources",
      { reason: "Certified.", official_roster_url: "https://other.example.gov/list" },
      "must also be listed in row.sources",
    ],
    ["a non-object value", "certified", "must be an object"],
  ])("rejects %s", (_label, exception, expectedReason) => {
    const parsed = parseCandidateRosterPayload(
      { candidates: [exceptionRow({ no_fec_id_exception: exception })] },
      federalManual
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toContain(expectedReason);
  });

  it("rejects the exception on a row that already has FEC IDs", () => {
    const parsed = parseCandidateRosterPayload(
      { candidates: [exceptionRow({ fec_ids: ["H6OH04999"] })] },
      federalManual
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toContain("cannot be combined with row.fec_ids");
  });

  it("rejects the exception outside federal contests", () => {
    const parsed = parseCandidateRosterPayload(
      { candidates: [exceptionRow()] },
      { allowFecIds: false, requireFecIds: false, allowNoFecIdException: true }
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toContain("only allowed for federal contests");
  });
});

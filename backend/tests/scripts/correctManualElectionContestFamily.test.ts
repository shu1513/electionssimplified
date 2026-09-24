import { describe, expect, it, vi } from "vitest";

import {
  parseOfficeContestFamily,
  runElectionContestFamilyCorrection,
  type ElectionContestFamilyCorrectionClient,
} from "../../src/scripts/correctManualElectionContestFamily.js";

const ELECTION_ID = "10000000-0000-4000-8000-000000000001";
const JUDGE_OFFICE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_OFFICE_ID = "20000000-0000-4000-8000-000000000002";
const JP_OFFICE_ID = "20000000-0000-4000-8000-000000000003";
const COMMISSIONER_OFFICE_ID = "20000000-0000-4000-8000-000000000004";
const EXECUTIVE_OFFICE_ID = "20000000-0000-4000-8000-000000000005";
const OFFICES = [
  { id: JUDGE_OFFICE_ID, canonical_name: "County Level Judge" },
  { id: OTHER_OFFICE_ID, canonical_name: "County Recorder" },
  { id: JP_OFFICE_ID, canonical_name: "Justice of the Peace" },
  { id: COMMISSIONER_OFFICE_ID, canonical_name: "County Commissioner" },
  { id: EXECUTIVE_OFFICE_ID, canonical_name: "County Executive" },
];
const SOURCE_URL = "https://nmcourts.gov/courts-by-county/";

type FakeElectionRow = {
  id: string;
  official_ballot_title: string;
  race_type: string;
  discovery_contest_family: string | null;
  office_id: string | null;
  sources: unknown;
  district_name: string;
  state: string;
  district_type: "county";
};

function electionRow(overrides: Partial<FakeElectionRow> = {}): FakeElectionRow {
  return {
    id: ELECTION_ID,
    official_ballot_title: "Bernalillo County Probate Judge",
    race_type: "office",
    discovery_contest_family: "non_judicial_office",
    office_id: null,
    sources: ["https://candidateportal.servis.sos.state.nm.us/"],
    district_name: "Bernalillo County, New Mexico",
    state: "NM",
    district_type: "county",
    ...overrides,
  };
}

function fakeClient(
  row?: FakeElectionRow,
  input: { aliasOfficeId?: string; aliasKey?: string } = {}
) {
  const statements: { text: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    statements.push({ text, values });
    if (text.includes("FOR UPDATE OF e")) return { rows: row ? [row] : [] };
    if (text.includes("FROM public.office_title_aliases")) {
      return {
        rows: input.aliasOfficeId
          ? [
              {
                office_id: input.aliasOfficeId,
                normalized_alias: input.aliasKey ?? "bernalillo county probate judge",
              },
            ]
          : [],
      };
    }
    if (text.includes("WHERE id = $1::uuid") && text.includes("FROM public.offices")) {
      const officeId = values?.[0];
      return { rows: OFFICES.filter((office) => office.id === officeId) };
    }
    if (text.includes("FROM public.offices")) {
      return { rows: OFFICES };
    }
    return { rows: [] };
  });
  return {
    client: { query } as unknown as ElectionContestFamilyCorrectionClient,
    statements,
  };
}

function options(
  overrides: Partial<Parameters<typeof runElectionContestFamilyCorrection>[1]> = {}
) {
  return {
    electionId: ELECTION_ID,
    expectedFamily: "non_judicial_office" as const,
    correctedFamily: "judicial_office" as const,
    sourceUrl: SOURCE_URL,
    dryRun: false,
    ...overrides,
  };
}

function updateStatement(statements: { text: string; values?: unknown[] }[]) {
  return statements.find((statement) =>
    statement.text.includes("SET discovery_contest_family = $2")
  );
}

describe("runElectionContestFamilyCorrection", () => {
  it("corrects the family, backfills the resolved office, appends provenance, and commits", async () => {
    const { client, statements } = fakeClient(electionRow());

    const result = await runElectionContestFamilyCorrection(client, options());

    expect(result).toEqual({
      electionId: ELECTION_ID,
      officialBallotTitle: "Bernalillo County Probate Judge",
      expectedFamily: "non_judicial_office",
      correctedFamily: "judicial_office",
      alreadyCorrected: false,
      officeId: JUDGE_OFFICE_ID,
      officeBackfilled: true,
      officeReplaced: false,
      sourceAppended: true,
      matchMethod: "deterministic_fallback",
      dryRun: false,
    });
    expect(updateStatement(statements)?.values).toEqual([
      ELECTION_ID,
      "judicial_office",
      JUDGE_OFFICE_ID,
      JSON.stringify([
        "https://candidateportal.servis.sos.state.nm.us/",
        SOURCE_URL,
      ]),
    ]);
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("rolls back without updating on dry-run", async () => {
    const { client, statements } = fakeClient(electionRow());

    const result = await runElectionContestFamilyCorrection(client, options({ dryRun: true }));

    expect(result).toMatchObject({ dryRun: true, officeBackfilled: true });
    expect(updateStatement(statements)).toBeUndefined();
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses a stale expected family", async () => {
    const { client, statements } = fakeClient(
      electionRow({ discovery_contest_family: "ballot_measure" })
    );

    await expect(runElectionContestFamilyCorrection(client, options())).rejects.toThrow(
      /Expected election .* family non_judicial_office, found ballot_measure/
    );
    expect(updateStatement(statements)).toBeUndefined();
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("allows a past election because exact-ID repair is not future-scoped", async () => {
    const { client, statements } = fakeClient(electionRow());

    await runElectionContestFamilyCorrection(client, options({ dryRun: true }));

    const lock = statements.find((statement) => statement.text.includes("FOR UPDATE OF e"));
    expect(lock?.text).not.toContain("election_date");
  });

  it("converges an already-corrected row by appending a missing source", async () => {
    const { client, statements } = fakeClient(
      electionRow({
        discovery_contest_family: "judicial_office",
        office_id: JUDGE_OFFICE_ID,
      })
    );

    const result = await runElectionContestFamilyCorrection(client, options());

    expect(result).toMatchObject({
      alreadyCorrected: true,
      officeBackfilled: false,
      sourceAppended: true,
    });
    expect(updateStatement(statements)).toBeDefined();
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("is a no-op when the corrected family, office, and source already converge", async () => {
    const { client, statements } = fakeClient(
      electionRow({
        discovery_contest_family: "judicial_office",
        office_id: JUDGE_OFFICE_ID,
        sources: [SOURCE_URL],
      })
    );

    const result = await runElectionContestFamilyCorrection(client, options());

    expect(result).toMatchObject({ alreadyCorrected: true, sourceAppended: false });
    expect(updateStatement(statements)).toBeUndefined();
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses to overwrite a conflicting non-null office", async () => {
    const { client, statements } = fakeClient(electionRow({ office_id: OTHER_OFFICE_ID }));

    await expect(runElectionContestFamilyCorrection(client, options())).rejects.toThrow(
      /already references office .* but corrected family resolves/
    );
    expect(updateStatement(statements)).toBeUndefined();
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("replaces the judicial JP office when an Arkansas quorum-court seat is corrected to non-judicial", async () => {
    const { client, statements } = fakeClient(
      electionRow({
        official_ballot_title: "Justice of the Peace District 3",
        discovery_contest_family: "judicial_office",
        office_id: JP_OFFICE_ID,
        district_name: "Columbia County, Arkansas",
        state: "AR",
      }),
      { aliasOfficeId: JP_OFFICE_ID, aliasKey: "justice of the peace" }
    );

    const result = await runElectionContestFamilyCorrection(
      client,
      options({ expectedFamily: "judicial_office", correctedFamily: "non_judicial_office" })
    );

    expect(result).toMatchObject({
      officeId: COMMISSIONER_OFFICE_ID,
      officeBackfilled: false,
      officeReplaced: true,
      matchMethod: "deterministic_fallback",
    });
    expect(updateStatement(statements)?.values?.slice(0, 3)).toEqual([
      ELECTION_ID,
      "non_judicial_office",
      COMMISSIONER_OFFICE_ID,
    ]);
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("replaces County Executive when a New York County Court judge is corrected to judicial", async () => {
    // Texas/Kentucky/Arkansas teach "county judge" -> County Executive, so a
    // New York "Allegany County Judge" filed as non-judicial landed there.
    const { client, statements } = fakeClient(
      electionRow({
        official_ballot_title: "Allegany County Judge",
        office_id: EXECUTIVE_OFFICE_ID,
        district_name: "Allegany County, New York",
        state: "NY",
      }),
      { aliasOfficeId: EXECUTIVE_OFFICE_ID, aliasKey: "county judge" }
    );

    const result = await runElectionContestFamilyCorrection(client, options());

    expect(result).toMatchObject({
      officeId: JUDGE_OFFICE_ID,
      officeBackfilled: false,
      officeReplaced: true,
    });
    expect(updateStatement(statements)?.values?.slice(0, 3)).toEqual([
      ELECTION_ID,
      "judicial_office",
      JUDGE_OFFICE_ID,
    ]);
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("replaces County Executive on an already-judicial row whose office was never re-resolved", async () => {
    const { client, statements } = fakeClient(
      electionRow({
        official_ballot_title: "Bosque County 220th District Judge",
        discovery_contest_family: "judicial_office",
        office_id: EXECUTIVE_OFFICE_ID,
        district_name: "Bosque County, Texas",
        state: "TX",
      })
    );

    const result = await runElectionContestFamilyCorrection(client, options());

    expect(result).toMatchObject({
      alreadyCorrected: true,
      officeId: JUDGE_OFFICE_ID,
      officeReplaced: true,
    });
    expect(updateStatement(statements)?.values?.[2]).toBe(JUDGE_OFFICE_ID);
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("lets the matcher discard a mis-learned non-judge alias for a judge title", async () => {
    // The matcher itself now ignores a learned alias that points at a
    // non-judge office when the judicial family carries a judge title, so the
    // correction resolves the judge office instead of refusing.
    const { client, statements } = fakeClient(electionRow(), {
      aliasOfficeId: OTHER_OFFICE_ID,
    });

    const result = await runElectionContestFamilyCorrection(client, options());

    expect(result).toMatchObject({
      officeId: JUDGE_OFFICE_ID,
      officeBackfilled: true,
      matchMethod: "deterministic_fallback",
    });
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("refuses a non-judge office resolved under the judicial family", async () => {
    // A title with no judge word gives the matcher nothing to redirect, so
    // the alias stands and the script's own canonical-name check must catch it.
    const { client, statements } = fakeClient(
      electionRow({ official_ballot_title: "Bernalillo County Recorder" }),
      { aliasOfficeId: OTHER_OFFICE_ID, aliasKey: "bernalillo county recorder" }
    );

    await expect(runElectionContestFamilyCorrection(client, options())).rejects.toThrow(
      /judicial_office resolved incompatible office County Recorder/
    );
    expect(updateStatement(statements)).toBeUndefined();
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("validates HTTPS provenance before opening a transaction", async () => {
    const { client, statements } = fakeClient(electionRow());

    await expect(
      runElectionContestFamilyCorrection(
        client,
        options({ sourceUrl: "http://example.org/not-https" })
      )
    ).rejects.toThrow(/must use HTTPS/);
    expect(statements).toEqual([]);
  });
});

describe("parseOfficeContestFamily", () => {
  it("accepts only office contest families", () => {
    expect(parseOfficeContestFamily("--expected-family", "judicial_office")).toBe(
      "judicial_office"
    );
    expect(() => parseOfficeContestFamily("--expected-family", "ballot_measure")).toThrow(
      /must be one of non_judicial_office, judicial_office/
    );
  });
});

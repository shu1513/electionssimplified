import { describe, expect, it } from "vitest";

import {
  parseCorrectedElectionTitle,
  runElectionTitleCorrection,
  type ElectionTitleCorrectionClient,
} from "../../src/scripts/correctManualElectionTitle.js";

const ELECTION_ID = "2f27ea68-ee15-42ed-9f84-86aab7e7ad7f";
const DISTRICT_ID = "71f79a03-ed83-4e67-8e8a-7da3b32bb5bd";
const MEASURE_ID = "4dd26189-9f16-4904-ae3c-3d0bd66f2bd3";
const SOURCE_URL = "https://toledo.legistar.com/LegislationDetail.aspx?ID=44306";
const REASON = "Ordinance O-304-26 amends charter Sections 14, 17, 83 and 92; there is no Section 13.";

const OLD_TITLE = "City of Toledo Proposed Charter Amendments - Various Election Matters (Section 13 and Related)";
const OLD_KEY = "city of toledo proposed charter amendments various election matters section 13 and related";
const NEW_TITLE = "City of Toledo Proposed Charter Amendments - Various Election Matters (Sections 14, 17, 83 and 92)";
const NEW_KEY = "city of toledo proposed charter amendments various election matters sections 14 17 83 and 92";

type FakeRow = {
  id: string;
  district_id: string;
  election_date: string;
  official_ballot_title: string;
  official_ballot_title_key: string;
  race_type: string | null;
  printed_ballot_label: string | null;
  sources: unknown;
  district_name: string;
  district_state: string;
};

function electionRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: ELECTION_ID,
    district_id: DISTRICT_ID,
    election_date: "2026-11-03",
    official_ballot_title: OLD_TITLE,
    official_ballot_title_key: OLD_KEY,
    race_type: "ballot_measure",
    printed_ballot_label: "Issue 18",
    sources: ["https://webapi.legistar.com/v1/toledo/matters/44306"],
    district_name: "Toledo city, Ohio",
    district_state: "OH",
    ...overrides,
  };
}

type Statement = { text: string; values?: unknown[] };

// Answers each statement by its shape and records every one so the tests can
// pin the exact transaction. The two retired_election_identities lookups are
// told apart by the title key they ask about.
function fakeClient(input: {
  row?: FakeRow;
  collision?: { id: string; official_ballot_title: string };
  openOnNewKey?: string[];
  openOnOldKey?: string[];
  stagingKeys?: string[];
  measure?: { id: string; official_ballot_title: string };
}): { client: ElectionTitleCorrectionClient; statements: Statement[] } {
  const statements: Statement[] = [];
  const client: ElectionTitleCorrectionClient = {
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      statements.push({ text, values });
      if (text.includes("FOR UPDATE OF e")) {
        return { rows: (input.row ? [input.row] : []) as T[] };
      }
      if (text.includes("id <> $4::uuid")) {
        return { rows: (input.collision ? [input.collision] : []) as T[] };
      }
      if (text.includes("FROM public.retired_election_identities")) {
        const key = values?.[2];
        const ids = key === input.row?.official_ballot_title_key ? input.openOnOldKey : input.openOnNewKey;
        return { rows: (ids ?? []).map((id) => ({ id })) as T[] };
      }
      if (text.includes("FROM public.staging_items")) {
        return {
          rows: (input.stagingKeys ?? []).map((ingest_key) => ({
            ingest_key,
            entries: [{ official_ballot_title: input.row?.official_ballot_title, election_date: "2026-11-03" }],
          })) as T[],
        };
      }
      if (text.includes("FROM public.ballot_measures")) {
        return { rows: (input.measure ? [input.measure] : []) as T[] };
      }
      if (text.includes("INSERT INTO public.retired_election_identities")) {
        return { rows: [{ id: "ledger-1" }] as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  return { client, statements };
}

function options(overrides: Partial<Parameters<typeof runElectionTitleCorrection>[1]> = {}) {
  return {
    electionId: ELECTION_ID,
    title: NEW_TITLE,
    sourceUrl: SOURCE_URL,
    reason: REASON,
    dryRun: false,
    ...overrides,
  };
}

const firstWord = (statements: Statement[]) => statements.map((s) => s.text.trim().split(/\s/)[0]);
const titleUpdate = (statements: Statement[]) =>
  statements.find((s) => s.text.includes("UPDATE public.elections") && s.text.includes("official_ballot_title_key = $3"));
const ledgerInsert = (statements: Statement[]) =>
  statements.find((s) => s.text.includes("INSERT INTO public.retired_election_identities"));

describe("runElectionTitleCorrection", () => {
  it("retitles in place, recomputes the key, tombstones the old identity, and mirrors the measure title in one transaction", async () => {
    const { client, statements } = fakeClient({
      row: electionRow(),
      stagingKeys: ["manual:elections:oh:toledo"],
      measure: { id: MEASURE_ID, official_ballot_title: OLD_TITLE },
    });

    const result = await runElectionTitleCorrection(client, options());

    expect(result).toEqual({
      alreadyCorrected: false,
      dryRun: false,
      electionId: ELECTION_ID,
      districtId: DISTRICT_ID,
      districtName: "Toledo city, Ohio",
      districtState: "OH",
      electionDate: "2026-11-03",
      previousTitle: OLD_TITLE,
      title: NEW_TITLE,
      previousTitleKey: OLD_KEY,
      titleKey: NEW_KEY,
      identityChanged: true,
      printedBallotLabel: "Issue 18",
      sources: ["https://webapi.legistar.com/v1/toledo/matters/44306", SOURCE_URL],
      measureDetail: { id: MEASURE_ID, previousTitle: OLD_TITLE },
      retiredIdentity: {
        ledgerId: "ledger-1",
        existingLedgerId: null,
        stagingIngestKeys: ["manual:elections:oh:toledo"],
      },
      reinstatedLedgerIds: [],
    });

    expect(titleUpdate(statements)?.values).toEqual([
      ELECTION_ID,
      NEW_TITLE,
      NEW_KEY,
      JSON.stringify(["https://webapi.legistar.com/v1/toledo/matters/44306", SOURCE_URL]),
    ]);
    const measureUpdate = statements.find((s) => s.text.includes("UPDATE public.ballot_measures"));
    expect(measureUpdate?.values).toEqual([MEASURE_ID, NEW_TITLE]);

    // The tombstone points at the surviving election itself, so the writer
    // reports "superseded by <this id>" when the old title is injected again.
    expect(ledgerInsert(statements)?.values).toEqual([
      DISTRICT_ID,
      "2026-11-03",
      OLD_KEY,
      OLD_TITLE,
      "ballot_measure",
      ELECTION_ID,
      "superseded",
      REASON,
      SOURCE_URL,
      [ELECTION_ID],
      "manual:elections:oh:toledo",
      null,
    ]);

    // Tombstone before the retitle, everything inside one committed transaction.
    const ledgerIndex = statements.findIndex((s) => s.text.includes("INSERT INTO public.retired_election_identities"));
    const updateIndex = statements.findIndex((s) => s.text.includes("UPDATE public.elections"));
    expect(ledgerIndex).toBeGreaterThan(0);
    expect(ledgerIndex).toBeLessThan(updateIndex);
    expect(firstWord(statements)).toEqual([
      "BEGIN",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "INSERT",
      "UPDATE",
      "UPDATE",
      "COMMIT",
    ]);
  });

  it("rolls back on --dry-run and reports the plan without a ledger id", async () => {
    const { client, statements } = fakeClient({
      row: electionRow(),
      measure: { id: MEASURE_ID, official_ballot_title: OLD_TITLE },
    });

    const result = await runElectionTitleCorrection(client, options({ dryRun: true }));

    expect(result).toMatchObject({
      alreadyCorrected: false,
      dryRun: true,
      identityChanged: true,
      measureDetail: { id: MEASURE_ID, previousTitle: OLD_TITLE },
      retiredIdentity: { ledgerId: null, existingLedgerId: null, stagingIngestKeys: [] },
    });
    expect(statements.some((s) => s.text.trim().startsWith("UPDATE"))).toBe(false);
    expect(ledgerInsert(statements)).toBeUndefined();
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("skips the collision check and the tombstone when only spelling changes and the key stays the same", async () => {
    const { client, statements } = fakeClient({
      row: electionRow({ printed_ballot_label: null }),
    });

    const result = await runElectionTitleCorrection(
      client,
      options({ title: "City of Toledo Proposed Charter Amendments: Various Election Matters (Section 13 and Related)" })
    );

    expect(result).toMatchObject({
      alreadyCorrected: false,
      identityChanged: false,
      previousTitleKey: OLD_KEY,
      titleKey: OLD_KEY,
      retiredIdentity: null,
      reinstatedLedgerIds: [],
      measureDetail: null,
    });
    expect(statements.some((s) => s.text.includes("id <> $4::uuid"))).toBe(false);
    expect(statements.some((s) => s.text.includes("retired_election_identities"))).toBe(false);
    expect(titleUpdate(statements)?.values?.[2]).toBe(OLD_KEY);
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("is idempotent: an already-correct title only converges the source", async () => {
    const withSource = fakeClient({ row: electionRow({ official_ballot_title: NEW_TITLE, sources: [SOURCE_URL] }) });
    const same = await runElectionTitleCorrection(withSource.client, options());
    expect(same).toEqual({
      alreadyCorrected: true,
      dryRun: false,
      electionId: ELECTION_ID,
      title: NEW_TITLE,
      sourceAppended: false,
    });
    expect(withSource.statements.some((s) => s.text.trim().startsWith("UPDATE"))).toBe(false);
    expect(withSource.statements.at(-1)?.text).toBe("ROLLBACK");

    const missingSource = fakeClient({ row: electionRow({ official_ballot_title: NEW_TITLE, sources: [] }) });
    const appended = await runElectionTitleCorrection(missingSource.client, options());
    expect(appended).toMatchObject({ alreadyCorrected: true, sourceAppended: true });
    const update = missingSource.statements.find((s) => s.text.includes("SET sources = $2::jsonb"));
    expect(update?.values).toEqual([ELECTION_ID, JSON.stringify([SOURCE_URL])]);
    expect(update?.text).not.toContain("official_ballot_title");
    expect(missingSource.statements.at(-1)?.text).toBe("COMMIT");
  });

  it("refuses a new title that repeats the stored printed label", async () => {
    const { client, statements } = fakeClient({ row: electionRow() });

    // No colon, so readers would show "Issue 18: Issue 18 Charter Amendments ...".
    await expect(
      runElectionTitleCorrection(client, options({ title: "Issue 18 Charter Amendments on Election Matters" }))
    ).rejects.toThrow(/already starts with "Issue 18"/);
    expect(statements.some((s) => s.text.trim().startsWith("UPDATE"))).toBe(false);
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses when another election in the district and date already has the new key", async () => {
    const { client, statements } = fakeClient({
      row: electionRow(),
      collision: { id: "11111111-1111-4111-8111-111111111111", official_ballot_title: NEW_TITLE },
    });

    await expect(runElectionTitleCorrection(client, options())).rejects.toThrow(
      /would collide with election 11111111-1111-4111-8111-111111111111 .* supersede one side instead of retitling/
    );
    expect(titleUpdate(statements)).toBeUndefined();
    expect(ledgerInsert(statements)).toBeUndefined();
    expect(statements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("closes an open tombstone on the new identity as reinstated by this election", async () => {
    const { client, statements } = fakeClient({ row: electionRow(), openOnNewKey: ["ledger-old-9"] });

    const result = await runElectionTitleCorrection(client, options());

    expect(result).toMatchObject({ reinstatedLedgerIds: ["ledger-old-9"] });
    const reinstate = statements.find((s) => s.text.includes("SET reinstated_at = now()"));
    expect(reinstate?.values).toEqual(["ledger-old-9", ELECTION_ID, REASON]);
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("reuses an open tombstone that already covers the old identity instead of inserting a second one", async () => {
    const { client, statements } = fakeClient({ row: electionRow(), openOnOldKey: ["ledger-existing"] });

    const result = await runElectionTitleCorrection(client, options());

    expect(result).toMatchObject({
      retiredIdentity: { ledgerId: null, existingLedgerId: "ledger-existing", stagingIngestKeys: [] },
    });
    expect(ledgerInsert(statements)).toBeUndefined();
    expect(titleUpdate(statements)).toBeDefined();
    expect(statements.at(-1)?.text).toBe("COMMIT");
  });

  it("refuses a non-HTTPS source before opening a transaction", async () => {
    const { client, statements } = fakeClient({ row: electionRow() });

    await expect(
      runElectionTitleCorrection(client, options({ sourceUrl: "http://toledo.legistar.com/x" }))
    ).rejects.toThrow(/--source-url must use HTTPS/);
    expect(statements).toEqual([]);
  });

  it("refuses when the election does not exist", async () => {
    const { client } = fakeClient({});

    await expect(runElectionTitleCorrection(client, options())).rejects.toThrow(
      `Election not found: ${ELECTION_ID}`
    );
  });
});

describe("parseCorrectedElectionTitle", () => {
  it("trims and collapses whitespace", () => {
    expect(parseCorrectedElectionTitle("  City  Council,\tDistrict 2 ")).toBe("City Council, District 2");
  });

  it("refuses empty, multi-line, overlong, and punctuation-only titles", () => {
    expect(() => parseCorrectedElectionTitle("   ")).toThrow(/must not be empty/);
    expect(() => parseCorrectedElectionTitle("Mayor\nof Toledo")).toThrow(/single line/);
    expect(() => parseCorrectedElectionTitle("x".repeat(301))).toThrow(/at most 300/);
    expect(() => parseCorrectedElectionTitle("---")).toThrow(/identity key would be empty/);
  });
});

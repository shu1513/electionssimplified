import { describe, expect, it, vi } from "vitest";

import {
  parsePrintedBallotLabel,
  runElectionPrintedLabelSet,
  type ElectionPrintedLabelClient,
} from "../../src/scripts/setManualElectionPrintedLabel.js";

const ELECTION_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_URL = "https://www.sos.alabama.gov/alabama-votes/2026-general-election-sample-ballots";

type FakeElectionRow = {
  id: string;
  official_ballot_title: string;
  race_type: string;
  printed_ballot_label: string | null;
  sources: unknown;
};

function electionRow(overrides: Partial<FakeElectionRow> = {}): FakeElectionRow {
  return {
    id: ELECTION_ID,
    official_ballot_title: "Act 2026-341: Lieutenant Governor vacancy and legislative expenses",
    race_type: "ballot_measure",
    printed_ballot_label: null,
    sources: ["https://example.gov/acts"],
    ...overrides,
  };
}

function fakeClient(row?: FakeElectionRow) {
  const statements: { text: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    statements.push({ text, values });
    if (text.includes("FOR UPDATE OF e")) return { rows: row ? [row] : [] };
    return { rows: [] };
  });
  return {
    client: { query } as unknown as ElectionPrintedLabelClient,
    statements,
  };
}

function options(overrides: Partial<Parameters<typeof runElectionPrintedLabelSet>[1]> = {}) {
  return {
    electionId: ELECTION_ID,
    label: "Statewide Amendment 1",
    sourceUrl: SOURCE_URL,
    dryRun: false,
    ...overrides,
  };
}

function updateStatement(statements: { text: string; values?: unknown[] }[]) {
  return statements.find((statement) => statement.text.includes("SET printed_ballot_label = $2"));
}

function lastStatement(statements: { text: string }[]) {
  return statements[statements.length - 1]?.text;
}

describe("runElectionPrintedLabelSet", () => {
  it("stores the label, appends the source, and leaves the title alone", async () => {
    const { client, statements } = fakeClient(electionRow());

    const result = await runElectionPrintedLabelSet(client, options());

    expect(result).toEqual({
      electionId: ELECTION_ID,
      officialBallotTitle: "Act 2026-341: Lieutenant Governor vacancy and legislative expenses",
      previousLabel: null,
      label: "Statewide Amendment 1",
      displayedTitle: "Statewide Amendment 1: Lieutenant Governor vacancy and legislative expenses",
      alreadySet: false,
      sourceAppended: true,
      dryRun: false,
    });
    const update = updateStatement(statements);
    expect(update?.values).toEqual([
      ELECTION_ID,
      "Statewide Amendment 1",
      JSON.stringify(["https://example.gov/acts", SOURCE_URL]),
    ]);
    expect(update?.text).not.toContain("official_ballot_title");
    expect(lastStatement(statements)).toBe("COMMIT");
  });

  it("rolls back on a dry run", async () => {
    const { client, statements } = fakeClient(electionRow());

    const result = await runElectionPrintedLabelSet(client, options({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(updateStatement(statements)).toBeUndefined();
    expect(lastStatement(statements)).toBe("ROLLBACK");
  });

  it("writes nothing when the label and source are already stored", async () => {
    const { client, statements } = fakeClient(
      electionRow({ printed_ballot_label: "Statewide Amendment 1", sources: [SOURCE_URL] })
    );

    const result = await runElectionPrintedLabelSet(client, options());

    expect(result.alreadySet).toBe(true);
    expect(result.sourceAppended).toBe(false);
    expect(updateStatement(statements)).toBeUndefined();
    expect(lastStatement(statements)).toBe("ROLLBACK");
  });

  it("replaces an earlier label and reports it", async () => {
    const { client, statements } = fakeClient(electionRow({ printed_ballot_label: "Amendment 1" }));

    const result = await runElectionPrintedLabelSet(client, options());

    expect(result.previousLabel).toBe("Amendment 1");
    expect(updateStatement(statements)?.values?.[1]).toBe("Statewide Amendment 1");
  });

  it("refuses office races, missing elections, and non-HTTPS sources", async () => {
    await expect(
      runElectionPrintedLabelSet(fakeClient(electionRow({ race_type: "office" })).client, options())
    ).rejects.toThrow("only ballot measures are supported");
    await expect(runElectionPrintedLabelSet(fakeClient().client, options())).rejects.toThrow(
      "Election not found"
    );
    await expect(
      runElectionPrintedLabelSet(
        fakeClient(electionRow()).client,
        options({ sourceUrl: "http://example.gov/ballot" })
      )
    ).rejects.toThrow("--source-url must use HTTPS");
  });
});

describe("parsePrintedBallotLabel", () => {
  it("trims and collapses whitespace", () => {
    expect(parsePrintedBallotLabel("  Proposed  Amendment No. 1 ")).toBe("Proposed Amendment No. 1");
  });

  it("rejects empty, over-long, and colon-bearing labels", () => {
    expect(() => parsePrintedBallotLabel("   ")).toThrow("must not be empty");
    expect(() => parsePrintedBallotLabel("A".repeat(81))).toThrow("at most 80 characters");
    expect(() => parsePrintedBallotLabel("Amendment 1: Pardons")).toThrow("must not contain a colon");
  });
});

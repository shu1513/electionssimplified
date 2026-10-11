import { describe, expect, it } from "vitest";

import {
  parseSyncDueIllinoisCandidateFinanceScriptArgs,
  toSyncDueIllinoisCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueIllinoisCandidateFinance.js";

describe("syncDueIllinoisCandidateFinance script", () => {
  it("parses optional flags", () => {
    expect(
      parseSyncDueIllinoisCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=12",
        "--stale-after-days",
        "3",
        "--lookback-days=10",
        "--lookahead-days=365",
        "--timeout-ms=45000",
        "--contributions-csv=exports/il-contrib-a.csv",
        "--contributions-csv",
        "exports/il-contrib-b.csv",
        "--expenditures-csv=exports/il-exp.csv",
        "--contributions-url=https://example.test/contributions.csv",
        "--expenditures-url=https://example.test/expenditures.csv",
        "--normalized-artifact=exports/illinois-normalized.json",
        "--receipts-tsv=exports/Receipts.txt",
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      maxCandidates: 12,
      staleAfterDays: 3,
      electionLookbackDays: 10,
      electionLookaheadDays: 365,
      timeoutMs: 45000,
      contributionCsvPaths: ["exports/il-contrib-a.csv", "exports/il-contrib-b.csv"],
      expenditureCsvPaths: ["exports/il-exp.csv"],
      contributionSourceUrl: "https://example.test/contributions.csv",
      expenditureSourceUrl: "https://example.test/expenditures.csv",
      normalizedArtifactPath: "exports/illinois-normalized.json",
      receiptsTsvPath: "exports/Receipts.txt",
      verifiedQuarterlyConfigPath: undefined,
    });
  });

  it("defaults to AI industry classification enabled", () => {
    expect(parseSyncDueIllinoisCandidateFinanceScriptArgs([])).toMatchObject({
      dryRun: false,
      force: false,
      contributionCsvPaths: [],
      expenditureCsvPaths: [],
      normalizedArtifactPath: undefined,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() => parseSyncDueIllinoisCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDueIllinoisCandidateFinanceScriptArgs(["--timeout-ms=0"])).toThrow(
      "Invalid --timeout-ms value"
    );
  });

  it("accepts verified Quarterly source config and rejects mixed source modes", () => {
    expect(parseSyncDueIllinoisCandidateFinanceScriptArgs(["--verified-quarterly-config", "exports/verified.json"]))
      .toMatchObject({ verifiedQuarterlyConfigPath: "exports/verified.json" });
    for (const legacy of ["--normalized-artifact=old.json", "--contributions-csv=old.csv", "--expenditures-csv=old.csv",
      "--contributions-url=https://example.test/cash", "--expenditures-url=https://example.test/ie", "--receipts-tsv=old.txt"]) {
      expect(() => parseSyncDueIllinoisCandidateFinanceScriptArgs(["--verified-quarterly-config=verified.json", legacy]))
        .toThrow("cannot be combined");
    }
    expect(() => parseSyncDueIllinoisCandidateFinanceScriptArgs(["--verified-quarterly-config"]))
      .toThrow("Missing --verified-quarterly-config value");
  });

  it("rejects missing and duplicate option values", () => {
    expect(() => parseSyncDueIllinoisCandidateFinanceScriptArgs(["--stale-after-days"])).toThrow(
      "Missing --stale-after-days value"
    );
    expect(() =>
      parseSyncDueIllinoisCandidateFinanceScriptArgs(["--max-candidates=10", "--max-candidates", "20"])
    ).toThrow("Provide --max-candidates at most once");
    expect(() =>
      parseSyncDueIllinoisCandidateFinanceScriptArgs([
        "--contributions-csv=exports/il.csv",
        "--contributions-url=https://one.test/contributions.csv",
        "--contributions-url=https://two.test/contributions.csv",
      ])
    ).toThrow("Provide --contributions-url at most once");
  });

  it("rejects unknown flags", () => {
    expect(() => parseSyncDueIllinoisCandidateFinanceScriptArgs(["--dryrun"])).toThrow("Unknown Illinois candidate finance due sync flag: --dryrun");
  });

  it("requires a contribution artifact when artifact source flags are provided", () => {
    expect(() => parseSyncDueIllinoisCandidateFinanceScriptArgs(["--expenditures-csv=exports/il-exp.csv"])).toThrow(
      "Provide --contributions-csv or --normalized-artifact when using Illinois SBE artifact flags"
    );
    expect(() =>
      parseSyncDueIllinoisCandidateFinanceScriptArgs(["--contributions-url=https://example.test/contributions.csv"])
    ).toThrow("Provide --contributions-csv or --normalized-artifact when using Illinois SBE artifact flags");
    // --receipts-tsv alone must parse: its required normalized artifact can
    // arrive via ILLINOIS_SBE_NORMALIZED_ARTIFACT_PATH, which parsing cannot
    // see. The data-set loader raises the receipts-specific error instead.
    expect(
      parseSyncDueIllinoisCandidateFinanceScriptArgs(["--receipts-tsv=exports/Receipts.txt"]).receiptsTsvPath
    ).toBe("exports/Receipts.txt");
    expect(
      parseSyncDueIllinoisCandidateFinanceScriptArgs([
        "--normalized-artifact=exports/illinois-normalized.json",
        "--expenditures-csv=exports/il-exp.csv",
      ])
    ).toMatchObject({
      contributionCsvPaths: [],
      expenditureCsvPaths: ["exports/il-exp.csv"],
      normalizedArtifactPath: "exports/illinois-normalized.json",
    });
  });

  it("formats script output", () => {
    const output = toSyncDueIllinoisCandidateFinanceScriptOutput({
      startedAt: new Date("2026-01-02T03:04:05.000Z"),
      options: {
        dryRun: true,
        force: false,
        maxCandidates: 2,
        contributionCsvPaths: [],
        expenditureCsvPaths: [],
        normalizedArtifactPath: undefined,
      },
      normalizedArtifactPath: "exports/from-env-normalized.json",
      receiptsTsvPath: "exports/from-env-Receipts.txt",
      result: {
        dryRun: true,
        now: "2026-01-02T03:04:05.000Z",
        staleAfterDays: 7,
        maxCandidates: 2,
        dueCandidateCount: 3,
        selectedCandidateCount: 2,
        syncedCandidateCount: 1,
        failedCandidateCount: 1,
        autoLinkAttemptedCount: 2,
        autoLinkLinkedCount: 1,
        results: [
          {
            candidateId: "candidate-1",
            electionId: "election-1",
            electionYear: 2026,
            committeeKey: "FRIENDS OF JANE DOE",
            ok: true,
            result: {
              candidateId: "candidate-1",
              electionId: "election-1",
              electionYear: 2026,
              dryRun: true,
              linkWritten: false,
              summaryWritten: false,
              directBreakdownsWritten: 0,
              outsideGroupsWritten: 0,
              outsideGroupBreakdownsWritten: 0,
              totalReceipts: 1000,
              directContributionTotal: 1000,
              outsideExpenditureDataAvailable: false,
              outsideGroupContributionDataAvailable: false,
              outsideSupportTotal: null,
              outsideOpposeTotal: null,
              matchedContributionRowCount: 1,
              includedContributionRowCount: 1,
              skippedContributionRowCount: 0,
              matchedOutsideExpenditureRowCount: 0,
              includedOutsideExpenditureRowCount: 0,
              skippedOutsideExpenditureRowCount: 0,
              matchedOutsideContributionRowCount: 0,
              includedOutsideContributionRowCount: 0,
              skippedOutsideContributionRowCount: 0,
            },
          },
        ],
      },
    });

    expect(output).toMatchObject({
      type: "illinois_candidate_finance_due_sync",
      started_at: "2026-01-02T03:04:05.000Z",
      dry_run: true,
      data_source: "artifact",
      artifact_contribution_csv_count: 0,
      artifact_expenditure_csv_count: 0,
      normalized_artifact: true,
      receipts_tsv: true,
      outside_expenditure_data_available_count: 0,
      outside_group_contribution_data_available_count: 0,
      result: {
        dueCandidateCount: 3,
        selectedCandidateCount: 2,
        autoLinkAttemptedCount: 2,
        autoLinkLinkedCount: 1,
      },
    });
    expect(typeof output.ts).toBe("string");
  });
});

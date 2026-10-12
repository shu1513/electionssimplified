import { describe, expect, it } from "vitest";

import {
  parseSyncDueFloridaCandidateFinanceScriptArgs,
  prepareFloridaCandidateFinanceSourceOptions,
} from "../../src/scripts/syncDueFloridaCandidateFinance.js";
import { assertKnownCliFlags } from "../../src/scripts/financeCliFlagGuard.js";
import { parseSyncDueCandidateFinanceScriptArgs } from "../../src/scripts/syncDueCandidateFinance.js";
import { parseTexasCandidateFinanceSyncTriggerArgs } from "../../src/scripts/triggerTexasCandidateFinanceSync.js";
import { parseRefreshTexasTecRawDataScriptArgs } from "../../src/scripts/refreshTexasTecRawData.js";

describe("assertKnownCliFlags", () => {
  const BOOL = new Set(["--dry-run", "--force"]);
  const VALUE = new Set(["--max-candidates", "--cache-dir"]);
  const check = (args: string[]) => assertKnownCliFlags(args, "test finance", BOOL, VALUE);

  it("accepts known flags in boolean, space, and inline forms", () => {
    expect(() =>
      check(["--dry-run", "--force", "--max-candidates", "5", "--cache-dir=/tmp/x"])
    ).not.toThrow();
    expect(() => check([])).not.toThrow();
  });

  it("rejects an unknown flag such as the --dryrun typo", () => {
    expect(() => check(["--dryrun"])).toThrow(/Unknown test finance flag: --dryrun/);
    expect(() => check(["--max-candidate=5"])).toThrow(/Unknown test finance flag: --max-candidate/);
  });

  it("rejects positional tokens that are not value-flag values", () => {
    // npm eats the first "--" separator, so a dash-less typo arrives as a
    // bare positional — it must fail loudly, never silently run a real
    // sync.
    expect(() => check(["dry-run"])).toThrow(/Unexpected positional argument: dry-run/);
    expect(() => check(["--dry-run", "force"])).toThrow(/Unexpected positional argument: force/);
    // An extra token after a consumed value is a stray positional too.
    expect(() => check(["--max-candidates", "5", "7"])).toThrow(/Unexpected positional argument: 7/);
    // The inline "=" form consumes no following token.
    expect(() => check(["--cache-dir=/tmp/x", "7"])).toThrow(/Unexpected positional argument: 7/);
  });

  it("rejects a boolean flag with an inline value", () => {
    expect(() => check(["--dry-run=true"])).toThrow(/Boolean flag does not accept a value/);
  });

  it("rejects a value flag without a value", () => {
    // A silently-missing value made parsers that return null instead of
    // throwing run an untargeted full batch (e.g. --candidate-id alone).
    expect(() => check(["--max-candidates"])).toThrow(/Missing --max-candidates value/);
    expect(() => check(["--max-candidates", "--dry-run"])).toThrow(/Missing --max-candidates value/);
    expect(() => check(["--max-candidates="])).toThrow(/Missing --max-candidates value/);
    expect(() => check(["--cache-dir", "  "])).toThrow(/Missing --cache-dir value/);
  });
});

// Representative integration through the three ported shapes: a state
// trigger, the federal sync-due, and a raw-data refresh CLI. Every other
// ported script wires the same helper the same way.
describe("ported finance CLI parsers reject silent typos", () => {
  it("Texas trigger", () => {
    expect(parseTexasCandidateFinanceSyncTriggerArgs(["--dry-run"])).toMatchObject({ dryRun: true });
    expect(() => parseTexasCandidateFinanceSyncTriggerArgs(["dry-run"])).toThrow(
      /Unexpected positional argument: dry-run/
    );
    expect(() => parseTexasCandidateFinanceSyncTriggerArgs(["--dryrun"])).toThrow(
      /Unknown Texas candidate finance sync flag: --dryrun/
    );
    expect(() => parseTexasCandidateFinanceSyncTriggerArgs(["--dry-run=true"])).toThrow(
      /Boolean flag does not accept a value/
    );
  });

  it("federal sync-due", () => {
    expect(parseSyncDueCandidateFinanceScriptArgs(["--dry-run"])).toMatchObject({ dryRun: true });
    expect(() => parseSyncDueCandidateFinanceScriptArgs(["dry-run"])).toThrow(
      /Unexpected positional argument: dry-run/
    );
  });

  it("Texas TEC raw-data refresh", () => {
    expect(() => parseRefreshTexasTecRawDataScriptArgs(["force"])).toThrow(
      /Unexpected positional argument: force/
    );
    expect(() => parseRefreshTexasTecRawDataScriptArgs(["--froce"])).toThrow(
      /Unknown Texas TEC raw data refresh flag: --froce/
    );
  });
});

// Review-round coverage: the groups the first sweep missed.
describe("second-sweep finance CLI parsers reject silent typos", () => {
  it("federal direct sync (write CLI) rejects typos and bare value flags", async () => {
    const { parseSyncCandidateFinanceScriptArgs } = await import(
      "../../src/scripts/syncCandidateFinance.js"
    );
    expect(() => parseSyncCandidateFinanceScriptArgs(["dry-run"])).toThrow(
      /Unexpected positional argument: dry-run/
    );
    expect(() => parseSyncCandidateFinanceScriptArgs(["--dry-run=true"])).toThrow(
      /Boolean flag does not accept a value/
    );
    expect(() => parseSyncCandidateFinanceScriptArgs(["--fec-id"])).toThrow(
      /Missing --fec-id value/
    );
  });

  it("Colorado TRACER raw trigger rejects typos", async () => {
    const { parseColoradoTracerRawDataRefreshTriggerArgs } = await import(
      "../../src/scripts/triggerColoradoTracerRawDataRefresh.js"
    );
    expect(() => parseColoradoTracerRawDataRefreshTriggerArgs(["force"])).toThrow(
      /Unexpected positional argument: force/
    );
    expect(() => parseColoradoTracerRawDataRefreshTriggerArgs(["--froce"])).toThrow(
      /Unknown Colorado TRACER raw data refresh flag: --froce/
    );
  });

  it("converted partial guards reject positionals and inline boolean values", async () => {
    const { parseIllinoisCandidateFinanceSyncTriggerArgs } = await import(
      "../../src/scripts/triggerIllinoisCandidateFinanceSync.js"
    );
    expect(() => parseIllinoisCandidateFinanceSyncTriggerArgs(["dry-run"])).toThrow(
      /Unexpected positional argument: dry-run/
    );
    const { parseMaineCandidateFinanceSyncTriggerArgs } = await import(
      "../../src/scripts/triggerMaineCandidateFinanceSync.js"
    );
    expect(() => parseMaineCandidateFinanceSyncTriggerArgs(["--dry-run=true"])).toThrow(
      /Boolean flag does not accept a value/
    );
  });
});


describe("Florida bounded candidate and reviewed-source CLI flags", () => {
  const candidateId = "82937afb-9562-422f-8a79-aacd09e63765";
  it("parses exact scope and source paths in both argument forms", () => {
    expect(parseSyncDueFloridaCandidateFinanceScriptArgs([
      "--candidate-id", candidateId, "--reviewed-committee-dates=/tmp/reviewed.json",
      "--refresh-export-artifacts", "--dry-run",
    ])).toMatchObject({ candidateId, reviewedCommitteeDatesPath: "/tmp/reviewed.json",
      refreshExportArtifacts: true, dryRun: true });
    expect(parseSyncDueFloridaCandidateFinanceScriptArgs([
      `--candidate-id=${candidateId}`, "--reviewed-committee-dates", "relative/reviewed.json",
    ])).toMatchObject({ candidateId, reviewedCommitteeDatesPath: "relative/reviewed.json" });
  });
  it("suppresses auto-linking for an existing candidate while unscoped runs retain defaults", async () => {
    expect(await prepareFloridaCandidateFinanceSourceOptions(
      parseSyncDueFloridaCandidateFinanceScriptArgs([`--candidate-id=${candidateId}`])
    )).toEqual({ candidateId, autoLinkMissingLinks: false, reviewedCommitteeDates: undefined });
    expect(await prepareFloridaCandidateFinanceSourceOptions(parseSyncDueFloridaCandidateFinanceScriptArgs([])))
      .toEqual({ candidateId: undefined, autoLinkMissingLinks: undefined, reviewedCommitteeDates: undefined });
  });
  it("rejects malformed/missing/duplicate new flag values rather than expanding scope", () => {
    for (const args of [["--candidate-id=invalid"], ["--candidate-id"], ["--reviewed-committee-dates="],
      [`--candidate-id=${candidateId}`, "--candidate-id", candidateId],
      ["--reviewed-committee-dates=a", "--reviewed-committee-dates=b"], ["--candidateid=" + candidateId]]) {
      expect(() => parseSyncDueFloridaCandidateFinanceScriptArgs(args)).toThrow();
    }
  });
  it("fails preparation on a missing reviewed manifest before a sync can begin", async () => {
    const options = parseSyncDueFloridaCandidateFinanceScriptArgs([
      "--reviewed-committee-dates=/nonexistent/florida-reviewed-dates.json",
    ]);
    await expect(prepareFloridaCandidateFinanceSourceOptions(options)).rejects.toThrow();
  });
});

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseNcsbeCommitteeArg,
  parseRefreshNorthCarolinaNcsbeRawDataScriptArgs,
  runRefreshNorthCarolinaNcsbeRawDataScript,
  DEFAULT_NCSBE_CACHE_DIR,
} from "../../src/scripts/refreshNorthCarolinaNcsbeCampaignFinanceRawData.js";
import { storeNcsbeArtifact } from "../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeArtifactCache.js";
import {
  ncsbeCommitteeSearchUrl,
  ncsbeIeDocTypeInventoryUrl,
} from "../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeClient.js";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/northCarolinaFinance/${name}`, import.meta.url)),
    "utf8"
  );
}

const ROSTER_ROW = {
  candidateId: "cand-1",
  electionId: "elec-1",
  candidateName: "Marcus Gadson",
  electionYear: 2026,
  officeScope: "state_upper",
  officeName: "State Senator",
  district: "28",
  linkedCommitteeId: null,
  linkedCommitteeName: null,
};

// Fake portal for roster-mode runs: the Gadson candidate search (the
// acquisition searches by surname) resolves, all other committee searches (the
// spender phase) answer empty, and everything else serves the Gadson fixtures.
function rosterTransport(overrides: Record<string, () => string> = {}) {
  return {
    fetchText: async (url: string) => {
      for (const [prefix, body] of Object.entries(overrides)) {
        if (url.startsWith(prefix)) {
          return body();
        }
      }
      if (url === ncsbeCommitteeSearchUrl("Gadson")) {
        return fixture("committee-search-gadson.html");
      }
      if (url.includes("/CommitteeGeneralResult/")) {
        return "<html><script>var data = [];</script></html>";
      }
      if (url.includes("/DocumentGeneralResult/")) {
        return fixture("document-inventory-gadson.html");
      }
      if (url.includes("/ReportDetail/")) {
        return fixture("report-cover-gadson-229931.html");
      }
      if (url.includes("GetReceipts")) {
        return fixture("receipts-gadson-229931-p0.json");
      }
      if (url.includes("GetExpenditures")) {
        return fixture("ie-expenditures-carolina-federation-p0.json");
      }
      if (url.includes("/CFDocLkup/DocumentResult/")) {
        return fixture("ie-doc-type-inventory-2026.html");
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  };
}

describe("parseNcsbeCommitteeArg", () => {
  it("parses <SBoEID>:<OrgGroupID> and upper-cases the id", () => {
    expect(parseNcsbeCommitteeArg("sta-jv516o-c-001:57190")).toEqual({
      sboeId: "STA-JV516O-C-001",
      orgGroupId: 57190,
    });
  });

  it("rejects ids outside the pinned SBoEID pattern and bad group ids", () => {
    expect(() => parseNcsbeCommitteeArg("No Id:57190")).toThrow(/pinned pattern/);
    expect(() => parseNcsbeCommitteeArg("STA-JV516O-C-001")).toThrow(/<SBoEID>:<OrgGroupID>/);
    expect(() => parseNcsbeCommitteeArg("STA-JV516O-C-001:zero")).toThrow(/positive integer/);
  });
});

describe("parseRefreshNorthCarolinaNcsbeRawDataScriptArgs", () => {
  it("parses a full invocation", () => {
    const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs([
      "--cycle-year=2026",
      "--committee",
      "STA-JV516O-C-001:57190",
      "--committee=STA-C0854N-C-001:31610",
      "--spacing-ms=1500",
      "--force",
      "--dry-run",
    ]);
    expect(options.cycleYear).toBe(2026);
    expect(options.committees).toEqual([
      { sboeId: "STA-JV516O-C-001", orgGroupId: 57190 },
      { sboeId: "STA-C0854N-C-001", orgGroupId: 31610 },
    ]);
    expect(options.includeIe).toBe(true);
    expect(options.spacingMs).toBe(1500);
    expect(options.force).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.cacheDir.endsWith(DEFAULT_NCSBE_CACHE_DIR.split("/").pop()!)).toBe(true);
  });

  it("rejects unknown options — a misspelled flag must never start a paced pull", () => {
    expect(() => parseRefreshNorthCarolinaNcsbeRawDataScriptArgs(["--dryrun"])).toThrow(/Unknown option/);
    expect(() => parseRefreshNorthCarolinaNcsbeRawDataScriptArgs(["--dry-run=true"])).toThrow(
      /does not take a value/
    );
  });

  it("rejects duplicate committees and an empty run", () => {
    expect(() =>
      parseRefreshNorthCarolinaNcsbeRawDataScriptArgs([
        "--committee=STA-JV516O-C-001:57190",
        "--committee=STA-JV516O-C-001:57190",
      ])
    ).toThrow(/Duplicate --committee/);
    expect(() => parseRefreshNorthCarolinaNcsbeRawDataScriptArgs(["--skip-ie"])).toThrow(/Nothing to fetch/);
  });

  it("accepts an IE-only run with no committees", () => {
    const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs(["--cycle-year=2026"]);
    expect(options.committees).toEqual([]);
    expect(options.includeIe).toBe(true);
    expect(options.roster).toBe(false);
  });

  it("accepts a roster run, including with --skip-ie", () => {
    expect(parseRefreshNorthCarolinaNcsbeRawDataScriptArgs(["--cycle-year=2026", "--roster"]).roster).toBe(
      true
    );
    expect(
      parseRefreshNorthCarolinaNcsbeRawDataScriptArgs(["--cycle-year=2026", "--roster", "--skip-ie"]).roster
    ).toBe(true);
  });

  it("refuses --cycle-year and --year together", () => {
    expect(() =>
      parseRefreshNorthCarolinaNcsbeRawDataScriptArgs(["--cycle-year=2026", "--year=2026"])
    ).toThrow(/not both/);
  });
});

describe("runRefreshNorthCarolinaNcsbeRawDataScript", () => {
  it("flags total_failure when no requested scope succeeds", async () => {
    const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs([
      "--cycle-year=2026",
      "--committee=STA-JV516O-C-001:57190",
    ]);
    const output = await runRefreshNorthCarolinaNcsbeRawDataScript({
      options,
      transport: {
        fetchText: async () => {
          throw new Error("portal unreachable");
        },
      },
      log: () => {},
      now: new Date("2026-08-07T17:00:00Z"),
    });
    expect(output).toMatchObject({
      dry_run: false,
      committees: [],
      ie: null,
      total_failure: true,
    });
    if ("committee_failures" in output) {
      expect(output.committee_failures).toHaveLength(1);
      expect(output.ie_failure?.message).toMatch(/portal unreachable/);
    }
  });

  it("does not flag total_failure when one scope succeeds", async () => {
    const inventoryBody = readFileSync(
      fileURLToPath(new URL("../fixtures/northCarolinaFinance/document-inventory-gadson.html", import.meta.url)),
      "utf8"
    );
    const coverBody = readFileSync(
      fileURLToPath(new URL("../fixtures/northCarolinaFinance/report-cover-gadson-229931.html", import.meta.url)),
      "utf8"
    );
    const receiptsBody = readFileSync(
      fileURLToPath(new URL("../fixtures/northCarolinaFinance/receipts-gadson-229931-p0.json", import.meta.url)),
      "utf8"
    );
    const expBody = readFileSync(
      fileURLToPath(
        new URL("../fixtures/northCarolinaFinance/ie-expenditures-carolina-federation-p0.json", import.meta.url)
      ),
      "utf8"
    );
    const cacheDir = await mkdtemp(join(tmpdir(), "ncsbe-refresh-"));
    try {
      const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs([
        "--cycle-year=2026",
        "--committee=STA-JV516O-C-001:57190",
        `--cache-dir=${cacheDir}`,
      ]);
      const output = await runRefreshNorthCarolinaNcsbeRawDataScript({
        options,
        transport: {
          fetchText: async (url: string) => {
            if (url.includes("/DocumentGeneralResult/")) return inventoryBody;
            if (url.includes("/ReportDetail/")) return coverBody;
            if (url.includes("GetReceipts")) return receiptsBody;
            if (url.includes("GetExpenditures")) return expBody;
            // The IE inventories fail; the committee scope still succeeded.
            throw new Error("IE inventory unreachable");
          },
        },
        log: () => {},
        now: new Date("2026-08-07T17:00:00Z"),
      });
      expect(output).toMatchObject({ dry_run: false, total_failure: false });
      if ("ie_failure" in output) {
        expect(output.ie_failure?.message).toMatch(/IE inventory unreachable/);
        expect(output.committees).toHaveLength(1);
        // Every exclusion counter the acquisition computes must reach the
        // CLI output — a silent drop would read as full coverage.
        expect(output.committees[0]).toMatchObject({
          excluded_no_total_report_row_count: 0,
          excluded_undated_out_of_cycle_row_count: 0,
          unusable_period_row_count: 0,
        });
      }
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("serializes the roster_discovery and spenders payload on a non-dry roster run", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ncsbe-roster-run-"));
    try {
      const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs([
        "--cycle-year=2026",
        "--roster",
        `--cache-dir=${cacheDir}`,
      ]);
      const output = await runRefreshNorthCarolinaNcsbeRawDataScript({
        options,
        rosterRows: [ROSTER_ROW],
        transport: rosterTransport(),
        log: () => {},
        now: new Date("2026-08-09T17:00:00Z"),
      });
      // The CLI payload is a consumed contract: every snake_case field must
      // survive a rename or a dropped mapping.
      expect(output).toMatchObject({
        dry_run: false,
        total_failure: false,
        roster_discovery: {
          roster_row_count: 1,
          search_query_count: 1,
          searches_fetched: 1,
          searches_from_cache: 0,
          search_failures: [],
          resolver_matched_count: 1,
          resolver_unmatched_count: 0,
          resolver_ambiguous_count: 0,
          linked_ogid_resolved_count: 0,
          ogid_failures: [],
          discovered_committee_count: 1,
        },
        spender_discovery_failure: null,
      });
      if ("spenders" in output && output.spenders !== null) {
        expect(output.spenders.committees).toEqual([]);
        // Every discovered spender fails closed on the empty search pages.
        expect(output.spenders.failures.length).toBe(output.spenders.discovered_spender_count);
      } else {
        throw new Error("expected a spenders payload on a roster run");
      }
      expect(output.committees).toHaveLength(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("does not flag total_failure when only the spender phase acquired artifacts", async () => {
    // The reviewer's scenario, adjusted for the gated spender phase: IE is
    // requested but its live inventory fetch fails, no committee resolves,
    // and spender discovery succeeds off cached inventories. The run DID
    // acquire artifacts, so automation must not see exit code 1.
    const cacheDir = await mkdtemp(join(tmpdir(), "ncsbe-spender-only-"));
    try {
      for (const year of [2025, 2026]) {
        await storeNcsbeArtifact({
          cacheDir,
          key: { type: "ie_doc_type_inventory", year },
          url: ncsbeIeDocTypeInventoryUrl(year),
          body: fixture("ie-doc-type-inventory-2026.html"),
          retrievedAt: new Date("2026-08-09T00:00:00Z"),
        });
      }
      const spenderSearch =
        "<html><script>var data = " +
        JSON.stringify([
          {
            OrgName: "CAROLINA FEDERATION FREEDOM PAC",
            SBoEID: "STA-98J33C-C-001",
            OldID: null,
            CandName: null,
            StatusDesc: "ACTIVE (NON-EXEMPT)",
            OrgGroupID: 61234,
            Link: null,
          },
        ]) +
        ";</script></html>";
      const transport = rosterTransport({
        [ncsbeIeDocTypeInventoryUrl(2025).slice(0, 60)]: () => {
          throw new Error("IE inventory unreachable");
        },
        [ncsbeCommitteeSearchUrl("CAROLINA FEDERATION FREEDOM PAC")]: () => spenderSearch,
      });
      const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs([
        "--cycle-year=2026",
        "--roster",
        `--cache-dir=${cacheDir}`,
      ]);
      const output = await runRefreshNorthCarolinaNcsbeRawDataScript({
        options,
        rosterRows: [],
        transport,
        log: () => {},
        now: new Date("2026-08-09T17:00:00Z"),
      });
      expect(output).toMatchObject({ dry_run: false, ie: null });
      if ("spenders" in output && output.spenders !== null) {
        expect(output.spenders.committees).toHaveLength(1);
        expect(output.committees).toHaveLength(0);
        expect(output.total_failure).toBe(false);
      } else {
        throw new Error("expected a spenders payload");
      }
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("refuses a roster run whose roster rows were never queried", async () => {
    const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs(["--cycle-year=2026", "--roster"]);
    await expect(
      runRefreshNorthCarolinaNcsbeRawDataScript({ options, now: new Date("2026-08-08T17:00:00Z") })
    ).rejects.toThrow(/roster rows queried before the portal run/);
  });

  it("dry run reports the roster row count without any portal request", async () => {
    const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs([
      "--cycle-year=2026",
      "--roster",
      "--dry-run",
    ]);
    const output = await runRefreshNorthCarolinaNcsbeRawDataScript({
      options,
      rosterRows: [
        {
          candidateId: "cand-1",
          electionId: "elec-1",
          candidateName: "Marcus Gadson",
          electionYear: 2026,
          officeScope: "state_upper",
          officeName: "State Senator",
          district: "28",
          linkedCommitteeId: null,
          linkedCommitteeName: null,
        },
      ],
      now: new Date("2026-08-08T17:00:00Z"),
    });
    expect(output).toMatchObject({ dry_run: true, roster: true, roster_row_count: 1 });
  });

  it("dry run reports the plan without any portal request", async () => {
    const options = parseRefreshNorthCarolinaNcsbeRawDataScriptArgs([
      "--cycle-year=2026",
      "--committee=STA-JV516O-C-001:57190",
      "--dry-run",
    ]);
    const output = await runRefreshNorthCarolinaNcsbeRawDataScript({
      options,
      now: new Date("2026-08-07T17:00:00Z"),
    });
    expect(output).toMatchObject({
      type: "north_carolina_ncsbe_raw_data_refresh",
      cycle_year: 2026,
      dry_run: true,
      include_ie: true,
      committees: [{ sboe_id: "STA-JV516O-C-001", org_group_id: 57190 }],
    });
  });
});

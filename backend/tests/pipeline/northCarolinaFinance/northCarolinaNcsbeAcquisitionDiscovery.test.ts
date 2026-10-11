import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireNcsbeRosterCycleArtifacts,
  acquireNcsbeSpenderArtifacts,
  discoverNcsbeAcquisitionCommittees,
  discoverNcsbeRegisteredSpenders,
  listNorthCarolinaAcquisitionRoster,
  type NorthCarolinaAcquisitionRosterRow,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeAcquisitionDiscovery.js";
import { storeNcsbeArtifact } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeArtifactCache.js";
import {
  ncsbeCommitteeSearchUrl,
  ncsbeIeDocTypeInventoryUrl,
  type NcsbeTransport,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeClient.js";

const NOW = new Date("2026-08-08T17:00:00Z");

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../fixtures/northCarolinaFinance/${name}`, import.meta.url)),
    "utf8"
  );
}

// The legacy cover fixture predates the anti-forgery token the transaction
// handlers now require; the acquisition reads it from the cover page.
function withAntiForgeryToken(html: string): string {
  return `${html}<input name="__RequestVerificationToken" type="hidden" value="test-token" />`;
}

// A minimal committee-search page in the portal's embedded-JSON shape.
function searchPage(rows: object[]): string {
  return `<html><script>var data = ${JSON.stringify(rows)};</script></html>`;
}

const GADSON_ROW = {
  OrgName: "GADSON FOR NORTH CAROLINA (GADSON, MARCUS)",
  SBoEID: "STA-JV516O-C-001",
  OldID: null,
  CandName: "MARCUS GADSON",
  StatusDesc: "ACTIVE (NON-EXEMPT)",
  OrgGroupID: 57190,
  Link: null,
};

function rosterRow(
  overrides: Partial<NorthCarolinaAcquisitionRosterRow>
): NorthCarolinaAcquisitionRosterRow {
  return {
    candidateId: "cand-1",
    electionId: "elec-1",
    candidateName: "Marcus Gadson",
    electionYear: 2026,
    officeScope: "state_upper",
    officeName: "State Senator",
    district: "28",
    linkedCommitteeId: null,
    linkedCommitteeName: null,
    ...overrides,
  };
}

// Serves fixture bodies by URL shape; committee searches are keyed by their
// exact query so tests can serve different pages per search.
function fakeTransport(state: { requests: string[] }, searchPages: Record<string, string>): NcsbeTransport {
  return {
    fetchText: async (url: string) => {
      state.requests.push(url);
      if (url.includes("/CommitteeGeneralResult/")) {
        for (const [query, body] of Object.entries(searchPages)) {
          if (url === ncsbeCommitteeSearchUrl(query)) {
            return body;
          }
        }
        throw new Error(`No fake search page for ${url}`);
      }
      if (url.includes("/DocumentGeneralResult/")) {
        return fixture("document-inventory-gadson.html");
      }
      if (url.includes("/ReportDetail/")) {
        return withAntiForgeryToken(fixture("report-cover-gadson-229931.html"));
      }
      if (url.includes("handler=ReadReceipts")) {
        return fixture("receipts-gadson-229931-p0.json");
      }
      if (url.includes("handler=ReadExpenditures")) {
        return fixture("ie-expenditures-carolina-federation-p0.json");
      }
      if (url.includes("/CFDocLkup/DocumentResult/")) {
        return fixture("ie-doc-type-inventory-2026.html");
      }
      throw new Error(`Unexpected URL in fake transport: ${url}`);
    },
  };
}

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ncsbe-discovery-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("listNorthCarolinaAcquisitionRoster", () => {
  it("queries the cycle window and maps linked and unlinked rows", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      query: async (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return {
          rows: [
            {
              candidate_id: "cand-1",
              election_id: "elec-1",
              candidate_name: "Marcus Gadson",
              election_year: 2026,
              office_scope: "state_upper",
              office_name: "State Senator",
              district: "28",
              linked_committee_id: "STA-JV516O-C-001",
              linked_committee_name: "GADSON FOR NORTH CAROLINA",
            },
            {
              candidate_id: "cand-2",
              election_id: "elec-2",
              candidate_name: "Rodney Pierce",
              election_year: 2026,
              office_scope: "state_lower",
              office_name: "State Lower Chamber Legislator",
              district: "27",
              linked_committee_id: null,
              linked_committee_name: null,
            },
          ],
        };
      },
    };
    const roster = await listNorthCarolinaAcquisitionRoster(db as never, { cycleYear: 2026 });
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({
      candidateName: "Marcus Gadson",
      linkedCommitteeId: "STA-JV516O-C-001",
    });
    expect(roster[1]).toMatchObject({ candidateName: "Rodney Pierce", linkedCommitteeId: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values[0]).toBe(2026);
    expect(calls[0]!.text).toContain("make_date($1::int - 1, 1, 1)");
    expect(calls[0]!.text).toContain("link_status = 'active'");
    expect(calls[0]!.text).toContain("NOT IN ('withdrawn', 'lost')");
  });
});

describe("discoverNcsbeAcquisitionCommittees", () => {
  it("re-fetches an unlinked candidate's search even when cached, and resolver-matches the committee", async () => {
    // Pre-store a cached search so the refresh rule (unlinked -> refetch) is
    // what the assertion below actually exercises.
    await storeNcsbeArtifact({
      cacheDir,
      key: { type: "committee_search", query: "Gadson" },
      url: ncsbeCommitteeSearchUrl("Gadson"),
      body: searchPage([]),
      retrievedAt: NOW,
    });
    const state = { requests: [] as string[] };
    const transport = fakeTransport(state, { "Gadson": fixture("committee-search-gadson.html") });
    const result = await discoverNcsbeAcquisitionCommittees({
      transport,
      cacheDir,
      roster: [rosterRow({})],
      retrievedAt: NOW,
    });
    expect(result.searchesFetched).toBe(1);
    expect(result.searchesFromCache).toBe(0);
    expect(result.resolverMatchedCount).toBe(1);
    expect(result.committees).toEqual([{ sboeId: "STA-JV516O-C-001", orgGroupId: 57190 }]);
    expect(state.requests).toHaveLength(1);
  });

  it("uses the cached search for a linked candidate and derives the OGID from it", async () => {
    await storeNcsbeArtifact({
      cacheDir,
      key: { type: "committee_search", query: "Gadson" },
      url: ncsbeCommitteeSearchUrl("Gadson"),
      body: fixture("committee-search-gadson.html"),
      retrievedAt: NOW,
    });
    const transport: NcsbeTransport = {
      fetchText: async (url: string) => {
        throw new Error(`Linked cached candidate must not fetch: ${url}`);
      },
    };
    const result = await discoverNcsbeAcquisitionCommittees({
      transport,
      cacheDir,
      roster: [
        rosterRow({
          linkedCommitteeId: "STA-JV516O-C-001",
          linkedCommitteeName: "GADSON FOR NORTH CAROLINA (GADSON, MARCUS)",
        }),
      ],
      retrievedAt: NOW,
    });
    expect(result.searchesFromCache).toBe(1);
    expect(result.searchesFetched).toBe(0);
    expect(result.linkedOgidResolvedCount).toBe(1);
    expect(result.committees).toEqual([{ sboeId: "STA-JV516O-C-001", orgGroupId: 57190 }]);
    expect(result.ogidFailures).toEqual([]);
  });

  it("falls back to a committee-name search when the candidate search lacks the linked SBoEID", async () => {
    const state = { requests: [] as string[] };
    // Candidate search knows nothing; the committee-name search carries the row.
    const transport = fakeTransport(state, {
      "Jane Manual": searchPage([]),
      "GADSON FOR NORTH CAROLINA (GADSON, MARCUS)": searchPage([GADSON_ROW]),
    });
    const result = await discoverNcsbeAcquisitionCommittees({
      transport,
      cacheDir,
      roster: [
        rosterRow({
          candidateName: "Jane Manual",
          linkedCommitteeId: "STA-JV516O-C-001",
          linkedCommitteeName: "GADSON FOR NORTH CAROLINA (GADSON, MARCUS)",
        }),
      ],
      retrievedAt: NOW,
    });
    expect(result.linkedOgidResolvedCount).toBe(1);
    expect(result.committees).toEqual([{ sboeId: "STA-JV516O-C-001", orgGroupId: 57190 }]);
    // Candidate-name search (linked row -> cached-or-fetch; nothing cached) +
    // committee-name fallback.
    expect(state.requests).toHaveLength(2);
  });

  it("records an OGID failure and skips the committee when no search carries the SBoEID", async () => {
    const state = { requests: [] as string[] };
    const transport = fakeTransport(state, {
      "Jane Manual": searchPage([]),
      "MYSTERY COMMITTEE": searchPage([]),
    });
    const result = await discoverNcsbeAcquisitionCommittees({
      transport,
      cacheDir,
      roster: [
        rosterRow({
          candidateName: "Jane Manual",
          linkedCommitteeId: "STA-ZZ9999-C-001",
          linkedCommitteeName: "MYSTERY COMMITTEE",
        }),
      ],
      retrievedAt: NOW,
    });
    expect(result.committees).toEqual([]);
    expect(result.ogidFailures).toEqual([
      { sboeId: "STA-ZZ9999-C-001", message: expect.stringMatching(/OrgGroupID is unknown/) },
    ]);
  });

  it("skips the committee and records the disagreement when two searches return different OGIDs", async () => {
    // The conflict can only arise across two candidate-name searches (the
    // committee-name fallback runs only when nothing resolved the OGID yet),
    // so two roster rows linked to the same SBoEID drive it.
    const state = { requests: [] as string[] };
    const transport = fakeTransport(state, {
      Doe: searchPage([GADSON_ROW]),
      Roe: searchPage([{ ...GADSON_ROW, OrgGroupID: 99999 }]),
    });
    const result = await discoverNcsbeAcquisitionCommittees({
      transport,
      cacheDir,
      roster: [
        rosterRow({
          candidateId: "cand-1",
          candidateName: "Jane Doe",
          linkedCommitteeId: "STA-JV516O-C-001",
          linkedCommitteeName: "GADSON FOR NORTH CAROLINA (GADSON, MARCUS)",
        }),
        rosterRow({
          candidateId: "cand-2",
          electionId: "elec-2",
          candidateName: "John Roe",
          linkedCommitteeId: "STA-JV516O-C-001",
          linkedCommitteeName: "GADSON FOR NORTH CAROLINA (GADSON, MARCUS)",
        }),
      ],
      retrievedAt: NOW,
    });
    expect(result.committees).toEqual([]);
    expect(result.linkedOgidResolvedCount).toBe(0);
    expect(result.ogidFailures).toEqual([
      { sboeId: "STA-JV516O-C-001", message: expect.stringMatching(/disagree/) },
    ]);
  });

  it("falls back to the cached search when the refresh fetch fails, recording the failure", async () => {
    // An unlinked candidate refreshes every run; when the portal is down the
    // cached evidence must still resolve the committee, with the fetch
    // failure surfaced instead of swallowed.
    await storeNcsbeArtifact({
      cacheDir,
      key: { type: "committee_search", query: "Gadson" },
      url: ncsbeCommitteeSearchUrl("Gadson"),
      body: fixture("committee-search-gadson.html"),
      retrievedAt: NOW,
    });
    const transport: NcsbeTransport = {
      fetchText: async () => {
        throw new Error("portal unreachable");
      },
    };
    const result = await discoverNcsbeAcquisitionCommittees({
      transport,
      cacheDir,
      roster: [rosterRow({})],
      retrievedAt: NOW,
    });
    expect(result.searchesFromCache).toBe(1);
    expect(result.searchesFetched).toBe(0);
    expect(result.searchFailures).toEqual([
      { query: "Gadson", message: expect.stringMatching(/portal unreachable/) },
    ]);
    expect(result.resolverMatchedCount).toBe(1);
    expect(result.committees).toEqual([{ sboeId: "STA-JV516O-C-001", orgGroupId: 57190 }]);
  });

  it("records a search failure and keeps going when a candidate search cannot be fetched", async () => {
    const transport: NcsbeTransport = {
      fetchText: async () => {
        throw new Error("portal unreachable");
      },
    };
    const result = await discoverNcsbeAcquisitionCommittees({
      transport,
      cacheDir,
      roster: [rosterRow({})],
      retrievedAt: NOW,
    });
    expect(result.searchFailures).toEqual([
      { query: "Gadson", message: expect.stringMatching(/portal unreachable/) },
    ]);
    expect(result.committees).toEqual([]);
    expect(result.resolverMatchedCount).toBe(0);
  });
});

describe("discoverNcsbeRegisteredSpenders", () => {
  it("collects structured registered-spender rows from both cached year inventories, deduped", async () => {
    const body = fixture("ie-doc-type-inventory-2026.html");
    for (const year of [2025, 2026]) {
      await storeNcsbeArtifact({
        cacheDir,
        key: { type: "ie_doc_type_inventory", year },
        url: ncsbeIeDocTypeInventoryUrl(year),
        body,
        retrievedAt: NOW,
      });
    }
    const { spenders, inventoryYears } = await discoverNcsbeRegisteredSpenders({ cacheDir, cycleYear: 2026 });
    expect(inventoryYears).toEqual([2025, 2026]);
    const ids = spenders.map((spender) => spender.sboeId);
    // Registered spender with a structured filing.
    expect(ids).toContain("STA-98J33C-C-001");
    // Deduped across rows and years.
    expect(new Set(ids).size).toBe(ids.length);
    // Unregistered rows (`No Id` -> null) never become spenders.
    expect(
      spenders.find((spender) => spender.committeeName === "ADVANCE NORTH CAROLINA")
    ).toBeUndefined();
    const carolinaFederation = spenders.find((spender) => spender.sboeId === "STA-98J33C-C-001");
    expect(carolinaFederation?.committeeName).toBe("CAROLINA FEDERATION FREEDOM PAC");
  });

  it("fails closed when a year inventory is missing from the cache", async () => {
    await expect(discoverNcsbeRegisteredSpenders({ cacheDir, cycleYear: 2026 })).rejects.toThrow(/missing/);
  });
});

describe("acquireNcsbeSpenderArtifacts", () => {
  it("derives the OGID from a committee-name search and pulls the spender's artifacts", async () => {
    const state = { requests: [] as string[] };
    const transport = fakeTransport(state, {
      "CAROLINA FEDERATION FREEDOM PAC": searchPage([
        {
          OrgName: "CAROLINA FEDERATION FREEDOM PAC",
          SBoEID: "STA-98J33C-C-001",
          OldID: null,
          CandName: null,
          StatusDesc: "ACTIVE (NON-EXEMPT)",
          OrgGroupID: 61234,
          Link: null,
        },
      ]),
    });
    const result = await acquireNcsbeSpenderArtifacts({
      transport,
      cacheDir,
      cycleYear: 2026,
      spenders: [{ sboeId: "STA-98J33C-C-001", committeeName: "CAROLINA FEDERATION FREEDOM PAC" }],
      retrievedAt: NOW,
    });
    expect(result.failures).toEqual([]);
    expect(result.committees).toHaveLength(1);
    expect(result.committees[0]!.sboeId).toBe("STA-98J33C-C-001");
    expect(result.committees[0]!.fetched.length).toBeGreaterThan(0);
    // The inventory fetch used the searched OGID.
    expect(state.requests.some((url) => url.includes("OGID=61234"))).toBe(true);
  });

  it("skips already-acquired spenders and isolates per-spender failures", async () => {
    const state = { requests: [] as string[] };
    const transport = fakeTransport(state, { "UNFINDABLE PAC": searchPage([]) });
    const result = await acquireNcsbeSpenderArtifacts({
      transport,
      cacheDir,
      cycleYear: 2026,
      spenders: [
        { sboeId: "STA-98J33C-C-001", committeeName: "CAROLINA FEDERATION FREEDOM PAC" },
        { sboeId: "STA-XX1111-C-001", committeeName: "UNFINDABLE PAC" },
      ],
      alreadyAcquiredSboeIds: new Set(["STA-98J33C-C-001"]),
      retrievedAt: NOW,
    });
    expect(result.skippedAlreadyAcquired).toEqual(["STA-98J33C-C-001"]);
    expect(result.committees).toEqual([]);
    expect(result.failures).toEqual([
      { sboeId: "STA-XX1111-C-001", message: expect.stringMatching(/yields 0 OrgGroupIDs/) },
    ]);
  });
});

describe("acquireNcsbeRosterCycleArtifacts", () => {
  it("runs discovery, committee + IE acquisition, then the spender phase", async () => {
    const state = { requests: [] as string[] };
    // Every spender committee-name search answers empty: the spender phase
    // must record per-spender failures without abandoning the run.
    const transport: NcsbeTransport = {
      fetchText: async (url: string) => {
        state.requests.push(url);
        if (url === ncsbeCommitteeSearchUrl("Gadson")) {
          return fixture("committee-search-gadson.html");
        }
        if (url.includes("/CommitteeGeneralResult/")) {
          return searchPage([]);
        }
        if (url.includes("/DocumentGeneralResult/")) {
          return fixture("document-inventory-gadson.html");
        }
        if (url.includes("/ReportDetail/")) {
          return withAntiForgeryToken(fixture("report-cover-gadson-229931.html"));
        }
        if (url.includes("handler=ReadReceipts")) {
          return fixture("receipts-gadson-229931-p0.json");
        }
        if (url.includes("handler=ReadExpenditures")) {
          return fixture("ie-expenditures-carolina-federation-p0.json");
        }
        if (url.includes("/CFDocLkup/DocumentResult/")) {
          return fixture("ie-doc-type-inventory-2026.html");
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };
    const result = await acquireNcsbeRosterCycleArtifacts({
      transport,
      cacheDir,
      cycleYear: 2026,
      roster: [rosterRow({})],
      retrievedAt: NOW,
    });
    expect(result.discovery.resolverMatchedCount).toBe(1);
    expect(result.acquisition.committees).toHaveLength(1);
    expect(result.acquisition.committees[0]!.sboeId).toBe("STA-JV516O-C-001");
    expect(result.acquisition.ie).not.toBeNull();
    expect(result.spenderDiscoveryFailure).toBeNull();
    expect(result.spenders).not.toBeNull();
    expect(result.spenders!.discoveredSpenderCount).toBeGreaterThan(0);
    // No OGID resolvable for any spender -> every one fails closed, none pulled.
    expect(result.spenders!.committees).toEqual([]);
    expect(result.spenders!.failures).toHaveLength(result.spenders!.discoveredSpenderCount);
  });

  it("skips the spender phase entirely when IE is skipped", () => {
    // --skip-ie must not pull spender reports off stale cached inventories,
    // and must not report a discovery "failure" for a phase the caller asked
    // not to run (with nothing cached, discovery would otherwise throw).
    const state = { requests: [] as string[] };
    const transport = fakeTransport(state, { "Gadson": fixture("committee-search-gadson.html") });
    return acquireNcsbeRosterCycleArtifacts({
      transport,
      cacheDir,
      cycleYear: 2026,
      roster: [rosterRow({})],
      includeIe: false,
      retrievedAt: NOW,
    }).then((result) => {
      expect(result.acquisition.ie).toBeNull();
      expect(result.spenders).toBeNull();
      expect(result.spenderDiscoveryFailure).toBeNull();
      expect(state.requests.some((url) => url.includes("/CFDocLkup/"))).toBe(false);
    });
  });
});

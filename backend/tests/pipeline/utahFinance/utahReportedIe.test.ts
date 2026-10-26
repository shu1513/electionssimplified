import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  loadUtahIePacket,
  utahIeOriginalPath,
  utahIeRegistryUrl,
  parseUtahIePurpose,
  utahIeCents,
  assertUtahIePacket,
  type UtahIeContext,
} from "../../../src/pipeline/utahFinance/utahReportedIeSource.js";
import {
  replaceUtahReportedIe,
  syncDueUtahReportedIe,
} from "../../../src/pipeline/utahFinance/utahReportedIeSync.js";
import { appendUtahReportedIeSummaries } from "../../../src/pipeline/utahFinance/utahReportedIeBallotSummary.js";
const context: UtahIeContext = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  electionId: "22222222-2222-4222-8222-222222222222",
  candidateName: "Alex Example",
  electionYear: 2026,
  officeScope: "state_upper",
  officeName: "State Senator",
  electionType: "general",
  district: "11",
};
const now = new Date("2026-10-26T15:00:00Z"),
  observedAt = "2026-10-26T14:00:00Z",
  origin = "https://disclosures.utah.gov";
const registry = utahIeRegistryUrl(2026),
  folder = origin + "/Search/PublicSearch/FolderDetails/123",
  report = origin + "/Search/PublicSearch/Report/456",
  registration = origin + "/Registration/EntityDetails/789",
  annual =
    origin +
    "/Search/AdvancedSearch/GenerateReport?ReportYear=2026&EntityType=INDEXP",
  ledger = origin + "/Search/AdvancedSearch/GenerateReport/123?ReportYear=2026";
const purpose =
  "Other - Independent Expenditure: Estimated Direct Mail, Phone Calls & Digital Ads Supporting Alex Example (SD-11)";
const field = (l: string, v: string) => `<div><label>${l}</label>${v}</div>`;
const cell = (v: string) => `<td>${v}</td>`;
const native = (p = purpose) =>
  field("Name", "Example IE Org") +
  field("Report Name", "2026 Year End Report") +
  field("Begin Date", "1/1/2026") +
  field("End Date", "12/31/2026") +
  field("SubmitDate", "10/25/2026") +
  `<input type="checkbox" disabled><table>${["0.00", "0.00", "0.00", "12.50", "(12.50)"].map((v, i) => `<tr>${[String(i + 1), "", v, [1, 3].includes(i) ? v : ""].map(cell).join("")}</tr>`).join("")}</table><table><tr><th>Itemized Contributions Received</th></tr><tr><th>Contribution Amount</th></tr><tr><td>Total Contributions Received</td><td>0.00</td></tr></table><table><tr><th>Itemized Expenditures Made</th></tr><tr>${["Exp. Date", "Name of Recipient", "Address", "Purpose", "I", "L", "A", "Expenditure Amount"].map((v) => `<th>${v}</th>`).join("")}</tr><tr>${["10/1/2026", "Example Vendor", "Example", p, "", "", "", "12.50"].map(cell).join("")}</tr><tr><td>Total Expenditures Made</td><td>12.50</td></tr></table>`;
const fields = [
  "INDEXP",
  "REPORT",
  "TRAN_ID",
  "TRAN_TYPE",
  "TRAN_DATE",
  "TRAN_AMT",
  "INKIND",
  "LOAN",
  "AMENDS",
  "NAME",
  "PURPOSE",
  "ADDRESS1",
  "ADDRESS2",
  "CITY",
  "STATE",
  "ZIP",
  "INKIND_COMMENTS",
];
const csv = (all: boolean) =>
  [
    all ? ["FILED", ...fields] : fields,
    ...[
      [
        "Example IE Org",
        "Year End",
        "1",
        "Expenditure",
        "10/1/2026",
        "-12.50",
        "",
        "",
        "",
        "Example Vendor",
        "Other",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
    ].map((r) => (all ? ["X", ...r] : r)),
  ]
    .map((r) => r.map((s) => `"${s.replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "utah-ie-synthetic-"));
  dirs.push(dir);
  await mkdir(join(dir, "utah-reported-ie"));
  const registryBody = `<table><tr><th>Entity</th></tr><tr><td>All</td></tr><tr><td><a href="${folder}">Example IE Org</a></td><td>Independent Expenditures</td><td><a href="${ledger}">2026</a></td></tr><tr><th>1</th></tr></table>`;
  const folderBody = `<iframe src="${registration}"></iframe><a href="javascript:openReport('/Search/PublicSearch/Report/456');">2026 - Year End</a>`;
  const registrationBody = [
    field("First", "Alex"),
    field("Middle", ""),
    field("Last", "Example"),
    field("Suffix", ""),
    field("Organization", "Example IE Org"),
  ].join("");
  for (const [phase, url, body] of [
    ["registry-open", registry, registryBody],
    ["registry-close", registry, registryBody],
    ["folder-open", folder, folderBody],
    ["folder-close", folder, folderBody],
    ["registration", registration, registrationBody],
    ["statement", report, native()],
    ["statement-close", report, native()],
    ["annual-open", annual, csv(true)],
    ["annual-close", annual, csv(true)],
    ["ledger-open", ledger, csv(false)],
    ["ledger-close", ledger, csv(false)],
  ])
    await writeFile(
      utahIeOriginalPath(dir, phase!, url!),
      JSON.stringify({
        url,
        body: url!.includes("/GenerateReport")
          ? body
          : `<html><body>${body}</body></html>`,
        observedAt,
        kind: url!.includes("/GenerateReport")
          ? "saved-http-body"
          : "browser-dom",
      }),
    );
  return dir;
}
async function alter(
  dir: string,
  phase: string,
  url: string,
  fn: (v: string) => string,
) {
  const path = utahIeOriginalPath(dir, phase, url),
    o = JSON.parse(await readFile(path, "utf8"));
  o.body = fn(o.body);
  if (o.kind === "browser-dom" && !o.body.startsWith("<html"))
    o.body = `<html><body>${o.body}</body></html>`;
  await writeFile(path, JSON.stringify(o));
}
const load = (dir: string, contexts: UtahIeContext[] = [context]) =>
  loadUtahIePacket(2026, contexts, { cacheDir: dir, now });
describe("Utah reported estimate source", () => {
  it("qualifies the whole native graph and signs without implying paid cash or broad totals", async () => {
    const p = await load(await fixture());
    expect(p).toMatchObject({
      reportCount: 1,
      occurrenceCount: 1,
      allocations: [
        {
          context,
          occurrences: [
            {
              amountCents: 1250,
              payerName: "Example IE Org",
              transactionId: "1",
            },
          ],
        },
      ],
    });
    expect(() => assertUtahIePacket({ ...p })).toThrow("unverified_packet");
    expect(Object.isFrozen(p.allocations[0]!.occurrences)).toBe(true);
  });
  it.each([
    "Other - Estimated Direct Mail Supporting Alex Example (SD-11)",
    purpose + " and Someone Else",
    purpose + " (50%)",
    purpose.replace("Alex Example", "Alex Example and Someone Else"),
    purpose.replace("SD-11", "HD-11"),
    purpose.replace("Estimated ", ""),
  ])("holds unsupported complete clause %s", async (purpose) => {
    const d = await fixture();
    for (const phase of ["statement", "statement-close"])
      await alter(d, phase, report, () => native(purpose));
    await expect(load(d)).rejects.toThrow();
  });
  it.each([
    { district: "12" },
    { officeName: "Senator" },
    { electionType: "primary" },
    { candidateName: "Other Example" },
  ])("rejects wrong canonical context %j", async (change) => {
    await expect(
      load(await fixture(), [{ ...context, ...change }]),
    ).rejects.toThrow("canonical_target");
  });
  it("rejects an ambiguous target across the complete current universe", async () => {
    await expect(
      load(await fixture(), [context, { ...context, candidateId: "other" }]),
    ).rejects.toThrow("canonical_target");
  });
  it.each([
    [
      "statement-close",
      report,
      (s: string) => s.replace("12.50", "13.50"),
      "statement_changed",
    ],
    [
      "statement",
      report,
      (s: string) => s.replace("disabled>", "disabled checked>"),
      "statement_changed",
    ],
    [
      "annual-close",
      annual,
      (s: string) => s.replace('"-12.50"', '"-12.51"'),
      "annual_changed",
    ],
    [
      "ledger-close",
      ledger,
      (s: string) => s.replace('"-12.50"', '"-12.51"'),
      "ledger_changed",
    ],
    [
      "registry-close",
      registry,
      (s: string) => s.replace("Example IE Org", "Different Org"),
      "registry_closure",
    ],
  ] as const)("holds changed scope %s", async (phase, url, change, code) => {
    const d = await fixture();
    await alter(d, phase, url, change);
    await expect(load(d)).rejects.toThrow(code);
  });
  it("preserves unknown unallocated expense scope without assigning payer as target", async () => {
    const d = await fixture();
    for (const phase of ["statement", "statement-close"])
      await alter(d, phase, report, () => native("Other"));
    expect((await load(d)).allocations).toHaveLength(0);
  });
  it("saved-page-first never fetches with a complete cache", async () => {
    const fetchImpl = vi.fn();
    await loadUtahIePacket(2026, [context], {
      cacheDir: await fixture(),
      now,
      allowNetwork: true,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("holds missing originals without network approval", async () => {
    const d = await fixture();
    await rm(utahIeOriginalPath(d, "statement-close", report));
    await expect(load(d)).rejects.toThrow("saved_original_missing_or_budget");
  });
  it("rejects invalid money and retains native parentheses polarity", () => {
    expect(utahIeCents("($12.50)")).toBe(-1250);
    expect(() => utahIeCents("(-12.50)")).toThrow();
    expect(() => utahIeCents("12.501")).toThrow();
    expect(parseUtahIePurpose(purpose)?.stance).toBe("support");
  });
});
describe("atomic estimate writer", () => {
  it.each([
    "write",
    "repeat",
    "changed-canonical",
    "vanished-prior",
    "write-failed",
  ])("preserves separate clocks: %s", async (mode) => {
    const p = await load(await fixture()),
      queries: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("SELECT ce.id")) return { rows: [{ id: "locked" }] };
        if (sql.startsWith("SELECT ce.candidate_id"))
          return { rows: mode === "changed-canonical" ? [] : [context] };
        if (sql.startsWith("SELECT observed_at"))
          return {
            rows: mode === "repeat" ? [{ observed_at: observedAt }] : [],
          };
        if (sql.startsWith("SELECT transaction_id"))
          return {
            rows: mode === "vanished-prior" ? [{ transaction_id: "gone" }] : [],
          };
        if (
          mode === "write-failed" &&
          sql.startsWith("INSERT INTO public.ut_reported_ie_occurrences")
        )
          throw Error("synthetic_failure");
        return { rows: [] };
      }),
    };
    const db = { connect: async () => client };
    if (["changed-canonical", "vanished-prior", "write-failed"].includes(mode))
      await expect(
        replaceUtahReportedIe(db as unknown as Pool, p, context),
      ).rejects.toThrow();
    else
      expect(
        await replaceUtahReportedIe(db as unknown as Pool, p, context),
      ).toBe(mode === "write");
    expect(queries.at(-1)).toBe(
      ["changed-canonical", "vanished-prior", "write-failed"].includes(mode)
        ? "ROLLBACK"
        : "COMMIT",
    );
    expect(queries.some((s) => s.includes("ut_candidate_finance"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
const readerRow = (i = 0) => ({
  candidate_id: context.candidateId,
  election_id: context.electionId,
  election_year: 2026,
  candidate_name: context.candidateName,
  district: "11",
  observed_at: observedAt,
  source_url: registry,
  attributed_count: 1,
  estimate_cents: "1250",
  transaction_id: String(i),
  folder_id: String(123 + i),
  report_url: report,
  payer_name: `Example IE ${i}`,
  amount_cents: "1250",
  stance: "support",
  purpose,
});
describe("candidate reader", () => {
  it("shows an IE-only group with both totals and all direct money unknown", async () => {
    const map = new Map();
    await appendUtahReportedIeSummaries(
      { query: vi.fn(async () => ({ rows: [readerRow()] })) },
      [{ candidate_id: context.candidateId, election_id: context.electionId }],
      map,
    );
    const s = map.values().next().value;
    expect(s.direct_campaign.total_raised).toBeNull();
    expect(s.outside_spending).toMatchObject({
      support_total: null,
      oppose_total: null,
      spending_basis: "reported_estimates",
      top_supporting_groups: [{ amount: 12.5 }],
    });
    expect(s.outside_spending.outside_coverage_note).toContain(
      "estimates, not verified cash payments",
    );
  });
  it("validates every stored group before limiting display", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      ...readerRow(i),
      attributed_count: 7,
      estimate_cents: "8750",
    }));
    const db = { query: vi.fn(async () => ({ rows })) },
      map = new Map();
    await appendUtahReportedIeSummaries(db, [], map);
    expect(
      map.values().next().value.outside_spending.top_supporting_groups,
    ).toHaveLength(5);
    rows[6]!.amount_cents = "-1";
    map.clear();
    await appendUtahReportedIeSummaries(db, [], map);
    expect(map.size).toBe(0);
  });
});
describe("independent due path", () => {
  it("selects canonical targets without a direct link and holds missing cache without advancing source", async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return {
          rows: sql.startsWith("SELECT DISTINCT")
            ? [{ year: 2026 }]
            : sql.startsWith("SELECT ce.candidate_id")
              ? [context]
              : sql.startsWith("SELECT ce.candidate_id::text,ce.election_id")
                ? [
                    {
                      candidate_id: context.candidateId,
                      election_id: context.electionId,
                    },
                  ]
                : [],
        };
      }),
    };
    // Distinguish the two canonical queries by their result field contract.
    db.query.mockImplementation(async (sql: string) => {
      queries.push(sql);
      return {
        rows: sql.startsWith("SELECT DISTINCT")
          ? [{ year: 2026 }]
          : sql.includes('AS "candidateId"')
            ? [context]
            : sql.includes("LEFT JOIN public.ut_reported_ie_sources")
              ? [
                  {
                    candidate_id: context.candidateId,
                    election_id: context.electionId,
                  },
                ]
              : [],
      };
    });
    const d = await fixture();
    await rm(utahIeOriginalPath(d, "statement", report));
    const r = await syncDueUtahReportedIe({
      db,
      now,
      maxCandidates: 1,
      staleAfterDays: 7,
      electionLookbackDays: 1,
      electionLookaheadDays: 730,
      rawDataCacheDir: d,
      dryRun: true,
    });
    expect(r).toMatchObject({ selected: 1, held: 1, written: 0 });
    expect(queries.some((s) => s.includes("finance_links"))).toBe(false);
    expect(queries.some((s) => s.startsWith("INSERT"))).toBe(false);
  });
});

it.each([false, true])(
  "retains duplicate native occurrences only with unambiguous whole purposes (mixed=%s)",
  async (mixed) => {
    const d = await fixture();
    for (const [phase, url] of [
      ["annual-open", annual],
      ["annual-close", annual],
      ["ledger-open", ledger],
      ["ledger-close", ledger],
    ])
      await alter(d, phase!, url!, (s) => {
        const lines = s.split("\r\n");
        return [...lines, lines[1]!.replace('"1"', '"2"')].join("\r\n");
      });
    for (const phase of ["statement", "statement-close"])
      await alter(d, phase, report, (s) => {
        const detail = s.match(/<tr><td>10\/1\/2026[\s\S]*?<\/tr>/)![0],
          second = mixed
            ? detail.replace("Alex Example", "Other Example")
            : detail;
        const parts = s.replace(detail, detail + second).split("</table>");
        parts[0] = parts[0]!.replaceAll("12.50", "25.00");
        parts[2] = parts[2]!.replace(
          "Total Expenditures Made</td><td>12.50",
          "Total Expenditures Made</td><td>25.00",
        );
        return parts.join("</table>");
      });
    if (mixed)
      await expect(load(d)).rejects.toThrow("ambiguous_occurrence_identity");
    else {
      const packet = await load(d);
      expect(packet.occurrenceCount).toBe(2);
      expect(
        packet.allocations[0]!.occurrences.map((o) => o.transactionId),
      ).toEqual(["1", "2"]);
    }
  },
);
it.each(["stale", "future", "truncated"])(
  "rejects invalid original provenance: %s",
  async (mode) => {
    const d = await fixture(),
      path = utahIeOriginalPath(d, "statement", report),
      o = JSON.parse(await readFile(path, "utf8"));
    if (mode === "truncated") o.body = o.body.replace("</html>", "");
    else
      o.observedAt =
        mode === "stale" ? "2026-10-01T00:00:00Z" : "2026-10-28T00:00:00Z";
    await writeFile(path, JSON.stringify(o));
    await expect(load(d)).rejects.toThrow();
  },
);
it("preserves existing direct and donor content and their clock when attaching estimates", async () => {
  const rows = [readerRow()],
    map = new Map<string, any>();
  const summary = {
    source: "UTAH_DISCLOSURES",
    cycle: 2026,
    last_synced_at: "2026-10-20T00:00:00Z",
    direct_campaign: {
      total_raised: 5000,
      pac_money_by_interest: [{ interest: "synthetic", amount: 100 }],
    },
    outside_spending: { support_total: null, oppose_total: null },
    backing_summary: { top_direct_donor_occupations: [] },
  };
  const direct = structuredClone(summary.direct_campaign);
  map.set(`${context.candidateId}\0${context.electionId}`, summary);
  await appendUtahReportedIeSummaries(
    { query: vi.fn(async () => ({ rows })) },
    [],
    map,
  );
  expect(summary.direct_campaign).toEqual(direct);
  expect(summary.last_synced_at).toBe("2026-10-20T00:00:00Z");
  expect(summary.outside_spending).toMatchObject({
    spending_basis: "reported_estimates",
    support_total: null,
    oppose_total: null,
  });
});

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireKansasCommitteeReceipts,
  assertQualifiedKansasCommitteePacket,
  kansasReceiptMatchesRegistry,
  parseKansasReportedRegistryIdentity,
  KANSAS_COMMITTEE_SOURCE_URL,
} from "../../../src/pipeline/kansasFinance/kansasCommitteeReceiptSource.js";
import {
  attachKansasCommitteeReceipts,
  listDueKansasCommitteeReceipts,
  validateKansasStoredCommitteeRows,
  writeKansasCommitteeReceipts,
} from "../../../src/pipeline/kansasFinance/kansasCommitteeReceipts.js";
import { isKansasCommitteeReceiptsEnabled } from "../../../src/config/featureFlags.js";
const now = new Date("2026-10-21T20:00:00Z"),
  url = "https://sos.ks.gov/elections/cfr_viewer/",
  roots: string[] = [];
const target = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  electionId: "22222222-2222-4222-8222-222222222222",
  electionYear: 2026,
  candidateName: "Test Person",
  officeScope: "state_lower",
  officeName: "State Lower Chamber Legislator",
  district: "123",
  committeeId: "7:123:PERSON:TEST",
  committeeName: "PERSON TEST",
  linkSource: "cfr_viewer" as const,
  sourceUrl: KANSAS_COMMITTEE_SOURCE_URL,
  lastSyncedAt: null,
};
const span = (id: string, v: string | number) => `<span id="${id}">${v}</span>`;
function cover(start: string, end: string, filed: string, pac = false) {
  return `<html><body>${pac ? '<input id="chkbxPAC" type="checkbox" checked="checked"><input id="chkbxParty" type="checkbox">' : ""}${span("lblCandOrgName", pac ? "EXAMPLE CIVIC FUND" : "Test Person")}${span("lblOfficeSoughtName", "State Representative")}${span("lblDistrictNo", "123")}${span("lblFileStartDate", start)}${span("lblFileEndDate", end)}${span("lblFileDate", filed)}${span("lblDate", filed + " 12:00:00 PM")}${span("lblAddress", "100 EXAMPLE ST STE 5")}${span("lblCity", "EXAMPLE CITY")}${span("lblZip", "66000")}${span("lblCashBeginning", "0.00")}${span("lblTotalContributions", "10.00")}${span("lblCashThisPeriod", "10.00")}${span("lblTotalExpenditures", "0.00")}${span("lblCashOnHandClose", "10.00")}${span("lblInKindContributions", "0.00")}${span("lblOtherTransactions", "0.00")}</body></html>`;
}
const a = `<html><body><table><tr><td>7/1/2026</td><td>EXAMPLE CIVIC FUND<br>${span("Repeater2_lblAddress_0", "100 EXAMPLE ST STE 5")}<br>EXAMPLE CITY KS ${span("Repeater2_lblZip_0", "66000-1234")}</td><td>Check</td><td></td><td>10.00</td><td>0.00</td><td>10.00</td></tr></table>${span("lblTotalItemized", "10.00")}${span("lblTotalUnitemized", "0.00")}${span("lblPoliticalMaterials", "0.00")}${span("lblContributorUnknown", "0.00")}${span("lblTotalReceipts", "10.00")}</body></html>`;
const b = `<html><body>${span("lblTotalItemized", "0.00")}${span("lblTotalUnitemized", "0.00")}${span("lblTotalInKind", "0.00")}</body></html>`;
function grid(
  id: string,
  dates: string[],
  name = "PERSON TEST",
  office = "State Representative",
) {
  return `<html><body>${span("lblRecordCount", dates.length)}<table id="${id}">${dates.map((d, i) => `<tr><td>${span(id + "_lblDate_" + i, d)}</td><td><a id="${id}_lnkbtnName_${i}" href="javascript:__doPostBack('${id}$ctl0${i + 2}$lnkbtnName','')">${name}</a></td><td>${span(id + "_labelOfficeSought_" + i, office)}${span(id + "_lblDistrictNumber_" + i, "123")}</td></tr>`).join("")}</table></body></html>`;
}
async function fixture(change?: (e: any[]) => void) {
  const root = await mkdtemp(join(tmpdir(), "kansas-synthetic-"));
  roots.push(root);
  let t = 0;
  const ev: any[] = [];
  const put = (path: string, html: string, controls: any[] = []) =>
    ev.push({
      url: url + path,
      html,
      observedAt: new Date(now.getTime() - 3600_000 + t++ * 1000).toISOString(),
      controls,
    });
  const form = (type: string) =>
    put(
      "cfr_examiner.aspx",
      "<html></html>",
      Object.entries({
        drpdownOffice: "7",
        drpdownFilingType: type,
        txtFirstName: "",
        txtLastName: "",
        txtDistrictNo: "",
        txtStartDate: "01/01/2025",
        txtEndDate: "10/21/2026",
      }).map(([id, value]) => ({ id, value })),
    );
  const inventory = grid("grdviewCfrResults", ["01/10/2026", "07/27/2026"]);
  form("Receipts and Expenditures Report");
  put("cfr_examiner_search_results.aspx", inventory);
  for (const [start, end, date] of [
    ["1/1/2025", "12/31/2025", "1/10/2026"],
    ["1/1/2026", "7/23/2026", "7/27/2026"],
  ]) {
    const c = cover(start!, end!, date!);
    put("reports/exp_report_main.aspx", c);
    put(
      "reports/schedule_a_report.aspx",
      a.replace("7/1/2026", start!.endsWith("2025") ? "6/1/2025" : "6/1/2026"),
    );
    put("reports/schedule_b_report.aspx", b);
    put("reports/exp_report_main.aspx", c);
  }
  form("Receipts and Expenditures Report");
  put("cfr_examiner_search_results.aspx", inventory);
  form("Appointment of Treasurer");
  put(
    "cfr_examiner_search_results.aspx",
    grid("grdviewApptOfTreas", ["01/01/2025"]),
  );
  form("Affidavit of Exemption Candidate");
  put("cfr_examiner_search_results.aspx", grid("grdviewAffidavitResults", []));
  const rf = () =>
    put(
      "cfr_examiner.aspx",
      "<html></html>",
      Object.entries({
        drpdownOffice: "12",
        drpdownFilingType: "Receipts and Expenditures Report",
        txtOrganizationName: "EXAMPLE",
        txtStartDate: "01/01/2025",
        txtEndDate: "10/21/2026",
      }).map(([id, value]) => ({ id, value })),
    );
  rf();
  put(
    "cfr_examiner_search_results.aspx",
    grid("grdviewCfrResults", ["07/27/2026"], "EXAMPLE CIVIC FUND", ""),
  );
  const pc = cover("1/1/2026", "7/23/2026", "7/27/2026", true);
  put("reports/exp_report_main.aspx", pc);
  put("reports/exp_report_main.aspx", pc);
  rf();
  put(
    "cfr_examiner_search_results.aspx",
    grid("grdviewCfrResults", ["07/27/2026"], "EXAMPLE CIVIC FUND", ""),
  );
  change?.(ev);
  const manifest = [];
  for (const v of ev) {
    const file = randomUUID() + ".json",
      raw = JSON.stringify(v);
    await writeFile(join(root, file), raw);
    manifest.push({
      file,
      bytes: Buffer.byteLength(raw),
      sha256: createHash("sha256").update(raw).digest("hex"),
      nativeHtmlLength: v.html.length,
      nativeChecksumVerified: true,
    });
  }
  await writeFile(
    join(root, "manifest.ndjson"),
    manifest.map((x) => JSON.stringify(x)).join("\n"),
  );
  return root;
}
beforeEach(() => {
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("KANSAS_COMMITTEE_RECEIPTS_ENABLED", "true");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("Kansas complete native source", () => {
  it("qualifies a complete canonical ledger, not double-counting originals or ZIP+4", async () => {
    const packet = await acquireKansasCommitteeReceipts({
      directory: await fixture(),
      target,
      now,
    });
    expect(packet.groups).toHaveLength(1);
    expect(packet.totalCents).toBe(2000);
    expect(packet.receiptCount).toBe(2);
    expect(Object.isFrozen(packet.groups[0])).toBe(true);
    expect(() =>
      assertQualifiedKansasCommitteePacket(structuredClone(packet)),
    ).toThrow();
  });
  it.each([
    "missing_schedule",
    "changed_cover",
    "changed_inventory",
    "stale",
    "unknown_tender",
  ])("holds %s without creating an empty packet", async (reason) => {
    const root = await fixture((ev) => {
      if (reason === "missing_schedule")
        ev.splice(
          ev.findIndex((e) => e.url.endsWith("/schedule_b_report.aspx")),
          1,
        );
      if (reason === "changed_cover")
        ev.find((e) => e.url.endsWith("/exp_report_main.aspx")).html = ev
          .find((e) => e.url.endsWith("/exp_report_main.aspx"))
          .html.replace('lblCashBeginning">0.00', 'lblCashBeginning">1.00');
      if (reason === "changed_inventory")
        ev.filter((e) =>
          e.url.endsWith("/cfr_examiner_search_results.aspx"),
        )[1].html = grid("grdviewCfrResults", []);
      if (reason === "stale") ev[0].observedAt = "2026-10-18T00:00:00Z";
      if (reason === "unknown_tender")
        ev.find((e) => e.url.endsWith("/schedule_a_report.aspx")).html =
          a.replace("Check", "Unverified");
    });
    await expect(
      acquireKansasCommitteeReceipts({ directory: root, target, now }),
    ).rejects.toThrow();
  });
  it("does not discard a missing suite to force identity", () => {
    const identity = parseKansasReportedRegistryIdentity(
      cover("1/1/2026", "7/23/2026", "7/27/2026", true),
    )!;
    const row = {
      contributorName: "EXAMPLE CIVIC FUND",
      addressLines: ["100 EXAMPLE ST", "EXAMPLE CITY KS 66000"],
      zip: "66000",
    } as any;
    expect(kansasReceiptMatchesRegistry(row, identity)).toBe(false);
  });
  it("holds a failed registry capture instead of classifying by donor name", async () => {
    const root = await fixture((ev) => ev.splice(-4, 4));
    await expect(
      acquireKansasCommitteeReceipts({ directory: root, target, now }),
    ).rejects.toThrow();
  });
  it("uses the component source clock independently of direct freshness", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await listDueKansasCommitteeReceipts({ query } as any, {
      now,
      staleAfterDays: 7,
      maxCandidates: 5,
      electionLookbackDays: 78,
      electionLookaheadDays: 730,
    });
    expect(query.mock.calls[0][0]).toContain(
      "public.ks_candidate_finance_committee_sources",
    );
    expect(query.mock.calls[0][0]).not.toContain(
      "public.ks_candidate_finance_summaries",
    );
  });
  it("default-off gate requires the master and dedicated flag", () => {
    vi.stubEnv("KANSAS_COMMITTEE_RECEIPTS_ENABLED", "");
    expect(isKansasCommitteeReceiptsEnabled()).toBe(false);
    vi.stubEnv("KANSAS_COMMITTEE_RECEIPTS_ENABLED", "true");
    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "false");
    expect(isKansasCommitteeReceiptsEnabled()).toBe(false);
  });
  it("rejects fabricated packets before connecting", async () => {
    const connect = vi.fn();
    await expect(
      writeKansasCommitteeReceipts({
        db: { connect } as any,
        packet: {} as any,
        now,
      }),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
function context() {
  return {
    link_id: "33333333-3333-4333-8333-333333333333",
    candidate_id: target.candidateId,
    election_id: target.electionId,
    election_year: 2026,
    committee_id: target.committeeId,
    committee_name: target.committeeName,
    link_source: target.linkSource,
    source_url: target.sourceUrl,
    district: target.district,
    candidate_name: target.candidateName,
    candidate_name_normalized: "TEST PERSON",
    office_name: target.officeName,
    office_scope: target.officeScope,
    canonical_office: target.officeName,
    geoid_compact: "20123",
    district_type: "state_lower",
  };
}
async function stored() {
  const p = await acquireKansasCommitteeReceipts({
    directory: await fixture(),
    target,
    now,
  });
  return {
    ...context(),
    groups: p.groups.map((g) => ({ ...g, amountCents: String(g.amountCents) })),
    source: {
      intent_sha256: createHash("sha256")
        .update(
          JSON.stringify([
            target.candidateId,
            target.electionId,
            target.electionYear,
            target.candidateName,
            target.officeScope,
            target.officeName,
            target.district,
            target.committeeId,
            target.committeeName,
            target.linkSource,
            target.sourceUrl,
          ]),
        )
        .digest("hex"),
      source_url: target.sourceUrl,
      last_synced_at: p.observedAt,
      written_at: now.toISOString(),
      total_cents: String(p.totalCents),
      group_count: p.groups.length,
      receipt_count: p.receiptCount,
      controls: {
        cycleStart: p.cycleStart,
        cycleEnd: p.cycleEnd,
        coveredThrough: p.coveredThrough,
        sourceCashRows: p.sourceCashRows,
        unmatchedGiftRows: p.unmatchedGiftRows,
        excludedNonGiftRows: p.excludedNonGiftRows,
        zeroGiftRows: p.zeroGiftRows,
      },
      provenance: p.provenance,
    },
  };
}
describe("Kansas protected component", () => {
  it("checks stored counts and money before display caps", async () => {
    const r = await stored();
    expect(validateKansasStoredCommitteeRows(r).groups).toHaveLength(1);
    r.groups = Array.from({ length: 6 }, (_, i) => ({
      reportedName: `EXAMPLE FUND ${i}`,
      nameKey: `EXAMPLE FUND ${i}`,
      amountCents: "100",
      receiptCount: 1,
    }));
    r.source.group_count = 6;
    r.source.receipt_count = 6;
    r.source.total_cents = "600";
    r.source.controls.sourceCashRows = 6;
    expect(validateKansasStoredCommitteeRows(r).groups).toHaveLength(6);
    r.groups[5]!.amountCents = "-100";
    expect(() => validateKansasStoredCommitteeRows(r)).toThrow();
  });
  it.each([
    "count",
    "money",
    "source_clock",
    "ownership",
    "office",
    "district",
    "missing_provenance",
  ])("rejects stored %s drift", async (reason) => {
    const r = await stored();
    if (reason === "count") r.source.receipt_count++;
    if (reason === "money") r.source.total_cents = "99999";
    if (reason === "source_clock")
      r.source.last_synced_at = "2026-10-22T00:00:00Z";
    if (reason === "ownership") r.candidate_name = "Different Person";
    if (reason === "office") r.canonical_office = "Governor";
    if (reason === "district") r.geoid_compact = "20124";
    if (reason === "missing_provenance") r.source.provenance = [];
    expect(() => validateKansasStoredCommitteeRows(r)).toThrow();
  });
  it("rolls back the entire component when a child write fails", async () => {
    const packet = await acquireKansasCommitteeReceipts({
      directory: await fixture(),
      target,
      now,
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FOR UPDATE OF link")) return { rows: [context()] };
      if (sql.includes("AS owners")) return { rows: [{ owners: "1" }] };
      if (
        sql.includes(
          "INSERT INTO public.ks_candidate_finance_committee_receipts",
        )
      )
        throw Error("simulated child failure");
      return { rows: [] };
    });
    const release = vi.fn();
    await expect(
      writeKansasCommitteeReceipts({
        db: { connect: async () => ({ query, release }) } as any,
        packet,
        now,
      }),
    ).rejects.toThrow();
    expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([s]) => s === "COMMIT")).toBe(false);
    expect(
      query.mock.calls.some(([s]) =>
        /UPDATE public.ks_candidate_finance_links|candidate_finance_summaries/.test(
          s,
        ),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalled();
  });
  it("does not query or expose names when publication is held", async () => {
    vi.stubEnv("KANSAS_COMMITTEE_RECEIPTS_ENABLED", "false");
    const query = vi.fn(),
      summaries = new Map();
    expect(
      await attachKansasCommitteeReceipts({
        db: { query } as any,
        requests: [
          { candidate_id: target.candidateId, election_id: target.electionId },
        ],
        summaries,
      }),
    ).toBe(summaries);
    expect(query).not.toHaveBeenCalled();
  });
});

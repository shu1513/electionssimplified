import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getColoradoIeDataset,
  isVerifiedColoradoIeDataset,
} from "../../../src/pipeline/coloradoFinance/coloradoReportedIeSource.js";
const roots: string[] = [];
const scope = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
const csv = (rows: string[][]) =>
  rows
    .map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(","))
    .join("\r\n") + "\r\n";
const ieColumns = [
  "Textbox12",
  "Textbox20",
  "PayeeZipCode",
  "Textbox21",
  "ExpenditureDate",
  "Textbox48",
  "Textbox49",
  "Textbox6",
  "Office",
  "Textbox99",
];
const registryColumns = [
  "JurisdictionName",
  "CommitteeType",
  "CommitteeName",
  "CandidateName",
  "RegAgentName",
  "ReportingSchedule",
  "OrganizationStatus",
];
async function root() {
  const p = await fs.mkdtemp(join(tmpdir(), "co-native-source-"));
  await fs.chmod(p, 0o700);
  roots.push(p);
  return p;
}
beforeEach(() => {
  for (const k of [
    "CANDIDATE_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_ENABLED",
    "COLORADO_REPORTED_IE_ENABLED",
    "COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED",
  ])
    vi.stubEnv(k, "true");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const p of roots.splice(0))
    await fs.rm(p, { recursive: true, force: true });
});
function transport(
  options: { wrongScope?: boolean; changedClosing?: boolean } = {},
) {
  let current: URLSearchParams,
    generated = 0;
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    let body = "";
    if (url.pathname.endsWith("/Reports/Reports.aspx"))
      body =
        '<a href="/CampaignFinance/Reports/ReportParameters.aspx?kind=ie">Independent Expenditures - Detail</a><a href="/CampaignFinance/Reports/ReportParameters.aspx?kind=registry">Committee Listing</a>';
    else if (url.pathname.endsWith("/ReportParameters.aspx")) {
      if (init?.method === "POST") {
        current = new URLSearchParams(String(init.body));
        generated++;
        body = `<script>window.open('ReportViewer.aspx')</script>`;
      } else
        body = `<form action="${url.pathname + url.search}"><input name="hidden" value="genuine-synthetic"><select id="ctl00_Content_ucJurisdiction_ucddlCounty" name="jurisdiction"><option value="county">All Counties</option><option value="state">STATEWIDE</option><option value="federal">FEDERAL</option></select><input id="ctl00_Content_dteBegin" name="begin"><input id="ctl00_Content_dteEnd" name="end"><select id="ctl00_Content_ucCommitteeType_ucddlOrganizationType" name="type"><option value="ie">Independent Expenditure Committee</option></select><input type="checkbox" checked id="ctl00_Content_chklstCheckboxes_0" name="active"><input id="ctl00_Content_btnGenerateReport" name="generate" type="submit" value="Generate"><input name="kind" value="${url.searchParams.get("kind")}"></form>`;
    } else if (url.pathname.endsWith("/ReportViewer.aspx"))
      body = `<script>var exportUrl='/CampaignFinance/Reserved.ReportViewerWebControl.axd?OpType=Export&Format=';</script>`;
    else if (url.pathname.endsWith("/Reserved.ReportViewerWebControl.axd")) {
      const date = (v: string) => {
        const [m, d, y] = v.split("/");
        return `${y}-${m}-${d}T00:00:00`;
      };
      const end = date(current!.get("end")!),
        start = date(current!.get("begin")!);
      const jurisdiction = options.wrongScope
        ? "All Counties"
        : (
            {
              county: "All Counties",
              state: "STATEWIDE",
              federal: "FEDERAL",
            } as Record<string, string>
          )[current!.get("jurisdiction")!]!;
      if (current!.get("kind") === "ie") {
        const metadata = {
          JurisdictionName: jurisdiction,
          BeginDate: start,
          EndDate: end,
        };
        const changed = options.changedClosing && generated >= 5,
          amount = changed ? "101.00" : "100.00";
        const group = {
          Textbox12: `${jurisdiction} Expenditure Total: ${amount}`,
        };
        const parent = {
          Textbox20: "Example Action,",
          PayeeZipCode: "Example Vendor,",
          Textbox21: amount,
          ExpenditureDate: "2026-01-01T00:00:00",
          Textbox48: "N/A",
          Textbox49: "N/A",
        };
        const target = {
          Textbox6: "Supporting: Ada Example",
          Office: "Party: DEMOCRATIC",
          Textbox99: "Office: GOVERNOR",
        };
        const values = { ...group, ...parent, ...target } as Record<
          string,
          string
        >;
        body =
          url.searchParams.get("Format") === "CSV"
            ? csv([
                Object.keys(metadata),
                Object.values(metadata),
                [""],
                [""],
                ieColumns,
                ieColumns.map((k) => values[k]!),
              ])
            : `<Report Name="rpt_CF_EXPN_008" ${scope(metadata)}><Group1 ${scope(group)}><Group2 ${scope(parent)}><Details ${scope(target)}/></Group2></Group1></Report>`;
      } else {
        const allDate = new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date(end));
        const metadata = {
          JurisdictionSelection: "STATEWIDE",
          OfficeSelection: "Independent Expenditure Committee",
          ActiveOnlySelection: `All Statuses on ${allDate}`,
        };
        const group = { JurisdictionName: "STATEWIDE" };
        const detail = {
          CommitteeType: "Independent Expenditure Committee",
          CommitteeName: "Example Action",
          CandidateName: "",
          RegAgentName: "Example Agent",
          ReportingSchedule: "Frequent",
          OrganizationStatus: "Active",
        };
        const values = { ...group, ...detail } as Record<string, string>;
        body =
          url.searchParams.get("Format") === "CSV"
            ? csv([
                Object.keys(metadata),
                Object.values(metadata),
                [""],
                [""],
                registryColumns,
                registryColumns.map((k) => values[k]!),
              ])
            : `<Report Name="rpt_CF_COMM_001" ${scope(metadata)}><Group1 ${scope(group)}><Detail ${scope(detail)}/></Group1></Report>`;
      }
    } else throw Error("unexpected_synthetic_request");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type":
          url.searchParams.get("Format") === "XML"
            ? "application/xml"
            : "text/html",
      },
    });
  });
}
describe("Colorado source factory authority", () => {
  it("acquires all scopes and closures, then revalidates saved originals with raw refresh off", async () => {
    const cacheDir = await root(),
      fetchFn = transport(),
      p = await getColoradoIeDataset({ electionYear: 2026, cacheDir, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(41);
    expect(isVerifiedColoradoIeDataset(p)).toBe(true);
    expect(Object.isFrozen(p.reports[0]!.expenses)).toBe(true);
    expect(p.reports.map((r) => r.jurisdiction)).toEqual([
      "All Counties",
      "STATEWIDE",
      "FEDERAL",
    ]);
    vi.stubEnv("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED", "false");
    const denied = vi.fn<typeof fetch>().mockRejectedValue(Error("no_network"));
    const saved = await getColoradoIeDataset({
      electionYear: 2026,
      cacheDir,
      fetchFn: denied,
    });
    expect(saved).toEqual(p);
    expect(denied).not.toHaveBeenCalled();
    const directory = join(cacheDir, (await fs.readdir(cacheDir))[0]!);
    const manifest = JSON.parse(
      await fs.readFile(join(directory, "manifest.json"), "utf8"),
    );
    await fs.appendFile(join(directory, manifest.records[0].file), "altered");
    await expect(
      getColoradoIeDataset({ electionYear: 2026, cacheDir, fetchFn: denied }),
    ).rejects.toThrow("native_ie_source_unavailable");
    expect(denied).not.toHaveBeenCalled();
  }, 60000);
  it("rejects a consistent export pair from the wrong requested jurisdiction", async () => {
    await expect(
      getColoradoIeDataset({
        electionYear: 2026,
        cacheDir: await root(),
        fetchFn: transport({ wrongScope: true }),
      }),
    ).rejects.toThrow("native_ie_jurisdiction_scope");
  }, 60000);
  it("rejects a complete closing population change", async () => {
    await expect(
      getColoradoIeDataset({
        electionYear: 2026,
        cacheDir: await root(),
        fetchFn: transport({ changedClosing: true }),
      }),
    ).rejects.toThrow("native_ie_closing_population_changed");
  }, 60000);
  it("cannot forge the immutable source brand", () =>
    expect(isVerifiedColoradoIeDataset({})).toBe(false));
  it("does not let refresh bypass the raw gate", async () => {
    vi.stubEnv("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED", "false");
    const fetchFn = transport();
    await expect(
      getColoradoIeDataset({
        electionYear: 2026,
        cacheDir: await root(),
        fetchFn,
        refresh: true,
      }),
    ).rejects.toThrow("native_ie_source_unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

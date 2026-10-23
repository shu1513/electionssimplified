import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getColoradoIeCandidateSource,
  isVerifiedColoradoIeCandidateSource,
} from "../../../src/pipeline/coloradoFinance/coloradoReportedIeSource.js";

const roots: string[] = [];
beforeEach(() => {
  for (const flag of [
    "CANDIDATE_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_ENABLED",
    "COLORADO_REPORTED_IE_ENABLED",
    "COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED",
  ])
    vi.stubEnv(flag, "true");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
const expected = {
  candidateName: "Ada Example",
  party: "Democratic",
  officeName: "State Lower Chamber Legislator",
  districtName: "State House District 42 (2022); Colorado",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingId: "201",
  receivingName: "Example Campaign",
  tracerCandidateId: "101",
};
const origin = "https://tracer.sos.colorado.gov",
  search = "/PublicSite/SearchPages/CandidateSearch.aspx",
  detail = "/PublicSite/SearchPages/CandidateDetail.aspx";
const field = (id: string, value = "", type = "text") =>
  `<input id="_ctl0_Content_${id}" name="${id}" type="${type}" value="${value}">`;
const select = (id: string, label: string) =>
  `<select id="_ctl0_Content_${id}" name="${id}"><option value="all">${label}</option></select>`;
function profile(id: string, changed = false) {
  const current = id === "101",
    fields = {
      lblCandidateID: id,
      lblCandName: current ? "EXAMPLE, ADA M" : "EXAMPLE, ADA B",
      lblCandParty: "Democratic",
      lblCandOffice: "Colorado House",
      lblCandJurisdiction: "STATEWIDE",
      lblCandStatus: changed ? "Active" : current ? "Active" : "Terminated",
      ...(current
        ? {
            lblCommitteeID: "201",
            lblCommName: "Example Campaign",
            lblCommitteeType: "Candidate Committee",
            lblCommStatus: "Active",
          }
        : {}),
    };
  const values = [
    fields.lblCandName,
    current
      ? "2026 (12/06/2024 - 12/03/2026)"
      : "2024 (12/04/2020 - 12/05/2024)",
    "Democratic",
    "STATEWIDE",
    "Colorado House",
    current ? "House District 42" : "House District 12",
    current ? "Active" : "Terminated",
  ];
  return `${Object.entries(fields)
    .map(([k, v]) => `<span id="_ctl0_Content_${k}">${v}</span>`)
    .join(
      "",
    )}<table id="_ctl0_Content_dgdCampaigns"><tr>${["Candidate/Committee", "Election Cycle", "Party Affiliation", "Jurisdiction", "Office", "District", "Status"].map((v) => `<th>${v}</th>`).join("")}</tr><tr>${values.map((v) => `<td>${v}</td>`).join("")}</tr></table>`;
}
function grid(page: number) {
  const current = page === 1,
    id = current ? "101" : "102",
    year = current ? "2026" : "2024",
    status = current ? "Active" : "Terminated";
  return `<form action="${search}"><input name="state" value="page${page}"><table id="_ctl0_Content_dgdSearchResults"><tr>${["Candidate Name ▲", "Party", "Election Year", "Jurisdiction", "Office", "District", "Campaign Status", "Candidate Status", "Candidate ID"].map((v) => `<th>${v}</th>`).join("")}</tr><tr><td><a href="javascript:__doPostBack('row${id}','')">EXAMPLE, ADA ${current ? "M" : "B"}</a></td>${["Democratic", year, "STATEWIDE", "Colorado House", current ? "House District 42" : "House District 12", status, status, id].map((v) => `<td>${v}</td>`).join("")}</tr><tr><td colspan="9">${current ? "<span>1</span><a href=\"javascript:__doPostBack('page2','')\">2</a>" : "<a href=\"javascript:__doPostBack('page1','')\">1</a><span>2</span>"}</td></tr></table></form>`;
}
function transport(
  options: {
    changedClosing?: boolean;
    wrongRecord?: boolean;
    repeatedPage?: boolean;
  } = {},
) {
  let phase = 0;
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input)),
      values = new URLSearchParams(String(init?.body ?? ""));
    let body: string;
    if (url.pathname.endsWith("/Reports/Reports.aspx"))
      body = `<a href="/PublicSite/SearchPages/CommitteeSearch.aspx">Committee Search</a><a href="${search}">Candidate Search</a>`;
    else if (url.pathname.endsWith("/CommitteeSearch.aspx")) {
      if (init?.method === "POST") {
        expect(values.get("txtCommitteeID")).toBe("201");
        return new Response(null, {
          status: 302,
          headers: { location: `${detail}?id=101` },
        });
      }
      body = `<form action="${url.pathname}">${field("txtCommitteeID")}${select("ddlJurisdiction", "STATEWIDE")}${field("btnSearch", "Search", "submit")}</form>`;
    } else if (url.pathname === detail)
      body = profile(
        url.searchParams.get("id")!,
        options.changedClosing === true &&
          phase === 2 &&
          url.searchParams.get("id") === "102",
      );
    else if (url.pathname === search) {
      if (init?.method !== "POST")
        body = `<form action="${search}">${field("txtLastName")}${field("txtFirstName")}${field("txtCandidateID")}${select("lstElectionYear", "Select all years...")}${select("ddlStatus", "Select all statuses...")}${select("ddlParty_ucddlParty", "Select all parties...")}${select("ddlJurisdiction", "Select all jurisdictions...")}<input type="radio" name="rblLastNameSearchType" id="contains" value="contains"><label for="contains">Name Contains</label>${field("btnSearch", "Search", "submit")}</form>`;
      else if (values.get("__EVENTTARGET") === "page2") {
        expect(values.get("state")).toBe("page1");
        body = options.repeatedPage
          ? grid(1).replace(
              /<td colspan="9">[\s\S]*?<\/td>/u,
              '<td colspan="9"><span>2</span></td>',
            )
          : grid(2);
      } else if (values.get("__EVENTTARGET")?.startsWith("row")) {
        const id = values.get("__EVENTTARGET")!.slice(3);
        expect(values.get("state")).toBe(id === "101" ? "page1" : "page2");
        return new Response(null, {
          status: 302,
          headers: {
            location: `${detail}?id=${options.wrongRecord ? "999" : id}`,
          },
        });
      } else {
        phase++;
        expect(values.get("txtLastName")).toBe("EXAMPLE");
        expect(values.get("txtFirstName")).toBe("");
        expect(values.get("txtCandidateID")).toBe("");
        for (const id of [
          "lstElectionYear",
          "ddlStatus",
          "ddlParty_ucddlParty",
          "ddlJurisdiction",
        ])
          expect(values.get(id)).toBe("all");
        expect(values.get("rblLastNameSearchType")).toBe("contains");
        body = grid(1);
      }
    } else throw Error("unexpected_synthetic_source_path");
    return new Response(body, { headers: { "content-type": "text/html" } });
  });
}
async function directory() {
  const path = await fs.mkdtemp(join(tmpdir(), "co-legislative-source-"));
  await fs.chmod(path, 0o700);
  roots.push(path);
  return path;
}
describe("Colorado legislative source authority", () => {
  it("rejects a silently repeated population even when its selected page advances", async () => {
    await expect(
      getColoradoIeCandidateSource({
        expected,
        cacheDir: await directory(),
        fetchFn: transport({ repeatedPage: true }),
      }),
    ).rejects.toThrow("native_peer_duplicate_grid_row");
  }, 30_000);
  it("acquires all-year peer pages, binds record actions to their own page, closes profiles and replays saved originals", async () => {
    const cacheDir = await directory(),
      fetchFn = transport(),
      packet = await getColoradoIeCandidateSource({
        expected,
        cacheDir,
        fetchFn,
      });
    expect(isVerifiedColoradoIeCandidateSource(packet)).toBe(true);
    expect(packet.identity).toMatchObject({
      nativeOfficeName: "COLORADO HOUSE",
      districtName: "House District 42",
      peerCandidateCount: 2,
      peerCampaignCount: 2,
    });
    expect(packet.peers?.find((p) => p.candidateId === "102")).toMatchObject({
      receivingId: null,
      candidateStatus: "Terminated",
    });
    expect(Object.isFrozen(packet.peers)).toBe(true);
    const count = fetchFn.mock.calls.length;
    vi.stubEnv("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED", "false");
    const replay = await getColoradoIeCandidateSource({
      expected,
      cacheDir,
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(count);
    expect(replay.identity).toEqual(packet.identity);
    expect(replay.peers).toEqual(packet.peers);
  }, 30_000);
  it("holds a consistently typed profile returned for the wrong grid ID", async () => {
    await expect(
      getColoradoIeCandidateSource({
        expected,
        cacheDir: await directory(),
        fetchFn: transport({ wrongRecord: true }),
      }),
    ).rejects.toThrow("native_peer_record_identifier");
  });
  it("holds a source peer change between full opening and closing walks", async () => {
    await expect(
      getColoradoIeCandidateSource({
        expected,
        cacheDir: await directory(),
        fetchFn: transport({ changedClosing: true }),
      }),
    ).rejects.toThrow("native_peer_closing_population_changed");
  }, 30_000);
});

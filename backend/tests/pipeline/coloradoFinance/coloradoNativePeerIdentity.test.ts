import { describe, expect, it } from "vitest";
import {
  coloradoTargetHasUniqueNativeCycle,
  parseColoradoNativePeerGrid,
  parseColoradoNativePeerProfile,
  parseColoradoNativePostback,
  type ColoradoNativePeerProfile,
} from "../../../src/pipeline/coloradoFinance/coloradoNativePeerIdentity.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const postback = (target: string) => `javascript:__doPostBack('${target}','')`;
const options = (target: string) =>
  `javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("${target}", "", false, "", "", false, true))`;
const headers = [
  "Candidate Name ▲",
  "Party",
  "Election Year",
  "Jurisdiction",
  "Office",
  "District",
  "Campaign Status",
  "Candidate Status",
  "Candidate ID",
];
function grid(pager = "", id = "101") {
  return bytes(
    `<table id="_ctl0_Content_dgdSearchResults"><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr><tr><td><a href="${postback("record")}">EXAMPLE, ADA M</a></td>${["Democratic", "2026", "STATEWIDE", "Colorado House", "House District 42", "Active", "Active", id].map((v) => `<td>${v}</td>`).join("")}</tr>${pager ? `<tr><td colspan="9">${pager}</td></tr>` : ""}</table>`,
  );
}
const link = (label: string, target: string) =>
  `<a href="${escape(options(target))}">${label}</a>`;
function profileHtml() {
  const fields = {
    lblCandidateID: "101",
    lblCandName: "EXAMPLE, ADA M",
    lblCommitteeID: "201",
    lblCommName: "EXAMPLE COMMITTEE",
    lblCommitteeType: "Candidate Committee",
    lblCandParty: "Democratic",
    lblCandOffice: "Colorado House",
    lblCandJurisdiction: "STATEWIDE",
    lblCandStatus: "Active",
    lblCommStatus: "Active",
  };
  return `${Object.entries(fields)
    .map(([k, v]) => `<span id="_ctl0_Content_${k}">${v}</span>`)
    .join(
      "",
    )}<table id="_ctl0_Content_dgdCampaigns"><tr>${["Candidate/Committee", "Election Cycle", "Party Affiliation", "Jurisdiction", "Office", "District", "Status"].map((v) => `<th>${v}</th>`).join("")}</tr><tr>${["EXAMPLE, ADA M", "2026 (12/06/2024 - 12/03/2026)", "Democratic", "STATEWIDE", "Colorado House", "House District 42", "Active"].map((v) => `<td>${v}</td>`).join("")}</tr></table>`;
}
describe("native ASP.NET action grammar", () => {
  it("parses literal record and pager actions without execution", () => {
    expect(parseColoradoNativePostback(postback("record"))).toEqual({
      target: "record",
      argument: "",
      action: null,
    });
    expect(parseColoradoNativePostback(options("pager"))).toEqual({
      target: "pager",
      argument: "",
      action: null,
    });
  });
  it.each([
    "javascript:alert('record')",
    options("pager") + ";evil()",
    options("pager").replace("false", "getValue()"),
    options("pager").replace(", true))", ", false))"),
    options("pager").replace('"pager"', '"pa\\ger"'),
    options("pager").replace(", false, true))", ", false, true,))"),
  ])("rejects unqualified JavaScript %s", (raw) =>
    expect(() => parseColoradoNativePostback(raw)).toThrow(),
  );
});
describe("native candidate search paging", () => {
  it("parses rows and binds the literal profile action", () => {
    expect(parseColoradoNativePeerGrid(grid(), 1)).toMatchObject({
      next: null,
      rows: [
        {
          candidateId: "101",
          electionYear: 2026,
          candidateName: "EXAMPLE, ADA M",
          districtName: "House District 42",
          action: { target: "record" },
        },
      ],
    });
  });
  it("follows the explicit next number", () => {
    expect(
      parseColoradoNativePeerGrid(
        grid(`<span>1</span>${link("2", "page2")}${link("...", "page11")}`),
        1,
      ).next?.target,
    ).toBe("page2");
  });
  it("crosses page 10 through the forward ellipsis", () => {
    expect(
      parseColoradoNativePeerGrid(
        grid(`${link("9", "page9")}<span>10</span>${link("...", "page11")}`),
        10,
      ).next?.target,
    ).toBe("page11");
  });
  it("never treats a preceding ellipsis as the next block", () => {
    expect(
      parseColoradoNativePeerGrid(
        grid(`${link("...", "page10")}<span>11</span>`),
        11,
      ).next,
    ).toBeNull();
  });
  it("rejects a repeated/wrong page, numeric gap, or ambiguous forward block", () => {
    expect(() =>
      parseColoradoNativePeerGrid(grid("<span>1</span>"), 2),
    ).toThrow("native_peer_page_order");
    expect(() =>
      parseColoradoNativePeerGrid(
        grid(`<span>1</span>${link("3", "page3")}`),
        1,
      ),
    ).toThrow("native_peer_page_gap");
    expect(() =>
      parseColoradoNativePeerGrid(
        grid(`<span>1</span>${link("...", "page11")}${link("...", "page21")}`),
        1,
      ),
    ).toThrow("native_peer_next_block_ambiguous");
  });
  it("requires the pager after the first page", () =>
    expect(() => parseColoradoNativePeerGrid(grid(), 2)).toThrow(
      "native_peer_missing_pager",
    ));
  it("rejects changed column meanings and malformed hard IDs", () => {
    expect(() =>
      parseColoradoNativePeerGrid(
        bytes(
          new TextDecoder()
            .decode(grid())
            .replace("Candidate ID</th>", "Other ID</th>"),
        ),
        1,
      ),
    ).toThrow("native_peer_grid_headers");
    expect(() => parseColoradoNativePeerGrid(grid("", "bad"), 1)).toThrow(
      "native_peer_grid_row",
    );
  });
});
describe("complete native peer campaign inventory", () => {
  it("keeps a historical candidate with no receiving panel in the peer population", () => {
    let html = profileHtml();
    for (const field of [
      "lblCommitteeID",
      "lblCommName",
      "lblCommitteeType",
      "lblCommStatus",
    ])
      html = html.replace(
        new RegExp(`<span id="_ctl0_Content_${field}">[^<]*</span>`),
        "",
      );
    expect(parseColoradoNativePeerProfile(bytes(html))).toMatchObject({
      candidateId: "101",
      receivingId: null,
      receivingName: null,
      committeeType: null,
      receivingStatus: null,
      campaigns: [{ cycleYear: 2026 }],
    });
  });
  it("retains actual financial bounds and terminated historical campaigns", () => {
    const p = parseColoradoNativePeerProfile(
      bytes(profileHtml().replace(/>Active</g, ">Terminated<")),
    );
    expect(p.candidateId).toBe("101");
    expect(p.campaigns).toEqual([
      {
        candidateName: "EXAMPLE, ADA M",
        cycleYear: 2026,
        cycleStart: "2024-12-06",
        cycleEnd: "2026-12-03",
        party: "Democratic",
        jurisdiction: "STATEWIDE",
        officeName: "Colorado House",
        districtName: "House District 42",
        status: "Terminated",
      },
    ]);
  });
  it.each([
    ["12/06/2024", "02/30/2024"],
    ["12/06/2024", "12/06/2027"],
    ["12/03/2026", "12/03/2028"],
  ])("rejects invalid or contradictory financial bounds %s", (from, to) =>
    expect(() =>
      parseColoradoNativePeerProfile(bytes(profileHtml().replace(from, to))),
    ).toThrow(),
  );
  it("rejects reordered campaign columns and missing source identifiers", () => {
    expect(() =>
      parseColoradoNativePeerProfile(
        bytes(
          profileHtml().replace("Party Affiliation</th>", "Different</th>"),
        ),
      ),
    ).toThrow("native_peer_campaign_headers");
    expect(() =>
      parseColoradoNativePeerProfile(
        bytes(
          profileHtml().replace(
            'id="_ctl0_Content_lblCandidateID"',
            'id="other"',
          ),
        ),
      ),
    ).toThrow("missing_native_peer_field");
  });
  it("validates full UTF8 before any identity fields", () =>
    expect(() =>
      parseColoradoNativePeerProfile(new Uint8Array([0xff])),
    ).toThrow("invalid_native_peer_utf8"));
});
describe("as-filed target identity at the expense date", () => {
  const current = (): ColoradoNativePeerProfile =>
    parseColoradoNativePeerProfile(bytes(profileHtml()));
  const request = (profiles: ColoradoNativePeerProfile[]) => ({
    profiles,
    candidateId: "101",
    cycleYear: 2026,
    party: "DEM",
    officeName: "Colorado House",
    districtName: "House District 42",
    date: "2026-10-11",
    target: {
      asFiled: "Supporting: Ada Example",
      name: "Ada Example",
      stance: "support" as const,
      party: "Democratic",
      office: "Colorado House",
    },
  });
  it("accepts one exact current financial context", () =>
    expect(coloradoTargetHasUniqueNativeCycle(request([current()]))).toBe(
      true,
    ));
  it("uses the as-filed name to detect conflicting middle-name peers", () => {
    const a = current(),
      b = current();
    a.candidateName = a.campaigns[0]!.candidateName = "Ada A Example";
    b.candidateId = "102";
    b.candidateName = b.campaigns[0]!.candidateName = "Ada B Example";
    expect(coloradoTargetHasUniqueNativeCycle(request([a, b]))).toBe(false);
    const explicit = request([a, b]);
    explicit.target.name = "Ada A Example";
    expect(coloradoTargetHasUniqueNativeCycle(explicit)).toBe(true);
  });
  it("excludes a historical peer only by its real financial dates", () => {
    const old = current();
    old.candidateId = "102";
    old.campaigns[0]!.status = "Terminated";
    old.campaigns[0]!.cycleYear = 2024;
    old.campaigns[0]!.cycleStart = "2020-12-04";
    old.campaigns[0]!.cycleEnd = "2024-12-05";
    old.campaigns[0]!.districtName = "House District 12";
    expect(coloradoTargetHasUniqueNativeCycle(request([current(), old]))).toBe(
      true,
    );
    old.campaigns[0]!.cycleEnd = "2026-12-03";
    expect(coloradoTargetHasUniqueNativeCycle(request([current(), old]))).toBe(
      false,
    );
  });
  it("holds overlapping district/cycle records even for the same native person", () => {
    const p = current();
    p.campaigns.push({ ...p.campaigns[0]!, districtName: "House District 12" });
    expect(coloradoTargetHasUniqueNativeCycle(request([p]))).toBe(false);
  });
  it("keeps unknown-party peers as possible matches", () => {
    const p = current();
    p.candidateId = "102";
    p.campaigns[0]!.party = "Unknown";
    expect(coloradoTargetHasUniqueNativeCycle(request([current(), p]))).toBe(
      false,
    );
  });
  it("does not let opposite-party or different-office campaigns manufacture ambiguity", () => {
    const p = current();
    p.candidateId = "102";
    p.campaigns[0]!.party = "Republican";
    expect(coloradoTargetHasUniqueNativeCycle(request([current(), p]))).toBe(
      true,
    );
    p.campaigns[0]!.party = "Democratic";
    p.campaigns[0]!.officeName = "Colorado Senate";
    expect(coloradoTargetHasUniqueNativeCycle(request([current(), p]))).toBe(
      true,
    );
  });
  it("holds missing party, wrong district, missing primary ID, or missing current cycle", () => {
    const p = current(),
      r = request([p]);
    r.target.party = "Unknown";
    expect(coloradoTargetHasUniqueNativeCycle(r)).toBe(false);
    const wrongDistrict = request([p]);
    wrongDistrict.districtName = "House District 12";
    expect(coloradoTargetHasUniqueNativeCycle(wrongDistrict)).toBe(false);
    expect(coloradoTargetHasUniqueNativeCycle(request([]))).toBe(false);
    const old = request([p]);
    old.cycleYear = 2024;
    expect(coloradoTargetHasUniqueNativeCycle(old)).toBe(false);
  });
});

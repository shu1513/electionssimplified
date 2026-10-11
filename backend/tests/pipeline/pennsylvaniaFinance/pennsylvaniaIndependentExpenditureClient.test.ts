import { describe, expect, it, vi } from "vitest";

import {
  PENNSYLVANIA_INDEPENDENT_EXPENDITURE_DEFAULT_URL,
  buildPennsylvaniaIndependentExpenditureElectionPostbackBody,
  fetchPennsylvaniaIndependentExpenditures,
  findPennsylvaniaIndependentExpenditureElectionOptionForYear,
  parsePennsylvaniaIndependentExpenditureDataJson,
  parsePennsylvaniaIndependentExpenditureElectionOptions,
  parsePennsylvaniaIndependentExpenditureHiddenFields,
} from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaIndependentExpenditureClient.js";

const LANDING_HTML = `
  <html>
    <body>
      <form method="post">
        <input type="hidden" name="__VIEWSTATE" value="view-state-1" />
        <input type="hidden" name="__EVENTVALIDATION" value="event-validation-1" />
        <select name="ctl00$MainContent$ddlElection" id="ddlElection">
          <option value="">Select</option>
          <option value="2024G">2024 General</option>
          <option value="2026G" selected>2026 General</option>
        </select>
        <script>
          var dataJson = [
            {
              "CandidateQuestion": "Jane Doe",
              "Organization": "Pennsylvanians for Action",
              "Amount": "$10,000.00",
              "IsSupported": true,
              "IsOpposed": false,
              "ElectionID": "2026G"
            }
          ];
        </script>
      </form>
    </body>
  </html>
`;

describe("pennsylvaniaIndependentExpenditureClient", () => {
  it("parses direct dataJson rows from the ASP.NET page", () => {
    expect(parsePennsylvaniaIndependentExpenditureDataJson(LANDING_HTML)).toEqual([
      {
        CandidateQuestion: "Jane Doe",
        Organization: "Pennsylvanians for Action",
        Amount: "$10,000.00",
        IsSupported: true,
        IsOpposed: false,
        ElectionID: "2026G",
      },
    ]);
  });

  it("parses JSON.parse encoded dataJson rows", () => {
    const encodedHtml = `
      <script>
        var dataJson = JSON.parse('[{\\u0022CandidateQuestion\\u0022:\\u0022Jane Doe\\u0022,\\u0022Organization\\u0022:\\u0022PA &amp; Action\\u0022,\\u0022Amount\\u0022:\\u0022250\\u0022}]');
      </script>
    `;

    expect(parsePennsylvaniaIndependentExpenditureDataJson(encodedHtml)).toEqual([
      {
        CandidateQuestion: "Jane Doe",
        Organization: "PA & Action",
        Amount: "250",
      },
    ]);
  });

  it("parses raw dataJson arrays without HTML-decoding the JSON source", () => {
    const rawArrayHtml = `
      <script>
        var dataJson = [{"CandidateQuestion":"Jane Doe","Organization":"PA &quot;Action&quot;","Amount":"250"}];
      </script>
    `;

    expect(parsePennsylvaniaIndependentExpenditureDataJson(rawArrayHtml)).toEqual([
      {
        CandidateQuestion: "Jane Doe",
        Organization: "PA &quot;Action&quot;",
        Amount: "250",
      },
    ]);
  });

  it("parses hidden fields and election options", () => {
    expect(parsePennsylvaniaIndependentExpenditureHiddenFields(LANDING_HTML)).toEqual(
      new Map([
        ["__VIEWSTATE", "view-state-1"],
        ["__EVENTVALIDATION", "event-validation-1"],
      ])
    );
    expect(parsePennsylvaniaIndependentExpenditureElectionOptions(LANDING_HTML)).toEqual([
      { id: "2024G", label: "2024 General", selected: false },
      { id: "2026G", label: "2026 General", selected: true },
    ]);
  });

  // Shape of the live page (2026-10-11): the rows sit in a hidden input whose
  // single-quoted value HTML-encodes apostrophes, flags are "YES"/"NO", and
  // the dropdown names each election with its year first.
  const HIDDEN_INPUT_HTML = `
    <html><body><form method="post" action="./IndependentExpenditure.aspx">
      <input type="hidden" name="__VIEWSTATE" value="view-state-2" />
      <select name="ctl00$ContentPlaceHolder1$ddlElection" id="ctl00_ContentPlaceHolder1_ddlElection">
        <option selected="selected" value="116">2026 General Election (11/03/2026)</option>
        <option value="111">2025 Municipal Election (11/04/2025)</option>
        <option value="106">2024 Presidential Election (11/05/2024)</option>
        <option value="118">2026 Special Election 12th Legislative District (08/18/2026)</option>
      </select>
      <input id='dataJson' type='hidden' value='[{"IndependentExpenseID":11326,"FilerName":"JAMES FOY","Organization":"CITIZEN&#39;S ALLIANCE PAC","ElectionDate":"05/15/2026","CandidateQuestion":"JOSH SHAPIRO FOR GOVERNOR OF PENNSYLVANIA","IsSupported":"YES","IsOpposed":"NO","Description":"MAILER -> VOTERS","Amount":444.96}]' />
      <script>var dataJson = document.getElementById("dataJson").value;</script>
    </form></body></html>
  `;

  it("parses rows from the hidden dataJson input and decodes HTML entities", () => {
    expect(parsePennsylvaniaIndependentExpenditureDataJson(HIDDEN_INPUT_HTML)).toEqual([
      {
        IndependentExpenseID: 11326,
        FilerName: "JAMES FOY",
        Organization: "CITIZEN'S ALLIANCE PAC",
        ElectionDate: "05/15/2026",
        CandidateQuestion: "JOSH SHAPIRO FOR GOVERNOR OF PENNSYLVANIA",
        IsSupported: "YES",
        IsOpposed: "NO",
        Description: "MAILER -> VOTERS",
        Amount: 444.96,
      },
    ]);
  });

  it("finds the live election select and the bucket for an election year", () => {
    const options = parsePennsylvaniaIndependentExpenditureElectionOptions(HIDDEN_INPUT_HTML);
    expect(options.map((option) => option.id)).toEqual(["116", "111", "106", "118"]);
    expect(options[0]?.selected).toBe(true);
    expect(findPennsylvaniaIndependentExpenditureElectionOptionForYear(options, 2026)?.id).toBe("116");
    expect(findPennsylvaniaIndependentExpenditureElectionOptionForYear(options, 2025)?.id).toBe("111");
    expect(findPennsylvaniaIndependentExpenditureElectionOptionForYear(options, 2023)).toBeNull();
    expect(
      buildPennsylvaniaIndependentExpenditureElectionPostbackBody({ html: HIDDEN_INPUT_HTML, electionId: "111" }).get(
        "ctl00$ContentPlaceHolder1$ddlElection"
      )
    ).toBe("111");
  });

  it("defaults to the singular list page address", () => {
    expect(PENNSYLVANIA_INDEPENDENT_EXPENDITURE_DEFAULT_URL).toBe(
      "https://www.campaignfinanceonline.pa.gov/Pages/IndependentExpenditure.aspx"
    );
  });

  it("builds an ASP.NET postback body for an election selection", () => {
    const body = buildPennsylvaniaIndependentExpenditureElectionPostbackBody({
      html: LANDING_HTML,
      electionId: "2024G",
    });

    expect(body.get("__VIEWSTATE")).toBe("view-state-1");
    expect(body.get("__EVENTVALIDATION")).toBe("event-validation-1");
    expect(body.get("__EVENTTARGET")).toBe("ctl00$MainContent$ddlElection");
    expect(body.get("__EVENTARGUMENT")).toBe("");
    expect(body.get("ctl00$MainContent$ddlElection")).toBe("2024G");
  });

  it("fetches the landing page and posts back when an election is requested", async () => {
    const postbackHtml = LANDING_HTML.replace("Pennsylvanians for Action", "Future PA PAC");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(LANDING_HTML, { status: 200 }))
      .mockResolvedValueOnce(new Response(postbackHtml, { status: 200 }));

    const result = await fetchPennsylvaniaIndependentExpenditures(
      {
        url: "https://www.campaignfinanceonline.pa.gov/pages/IndependentExpenditures.aspx",
        electionId: "2024G",
      },
      { fetchImpl: fetchMock as unknown as typeof fetch }
    );

    expect(result).toMatchObject({
      sourceUrl: "https://www.campaignfinanceonline.pa.gov/pages/IndependentExpenditures.aspx",
      electionId: "2024G",
      rows: [
        expect.objectContaining({
          Organization: "Future PA PAC",
        }),
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, postInit] = fetchMock.mock.calls[1] ?? [];
    expect(postInit?.method).toBe("POST");
    expect(String(postInit?.body)).toContain("ctl00%24MainContent%24ddlElection=2024G");
  });
});

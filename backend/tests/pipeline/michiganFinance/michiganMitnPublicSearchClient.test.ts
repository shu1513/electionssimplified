import { describe, expect, it, vi } from "vitest";

import {
  dedupeMichiganMitnExportRows,
  fetchMichiganMitnCommitteeSearch,
  fetchMichiganMitnContributionExportXlsx,
  michiganMitnExportRowsToLegacyContributionRows,
  parseMichiganMitnCommitteeSearchHtml,
  parseMichiganMitnExportXlsxRows,
  resolveMichiganMitnCommitteeViaSearch,
  splitMichiganCandidateNameForSearch,
  validateMichiganMitnContributionExportHeader,
  MICHIGAN_MITN_REQUIRED_CONTRIBUTION_HEADERS,
} from "../../../src/pipeline/michiganFinance/michiganMitnPublicSearchClient.js";

import { MITN_EXPORT_HEADER, buildZip, sheetXml } from "./mitnXlsxTestFixture.js";

const EXPORT_HEADER = MITN_EXPORT_HEADER;

const COMMITTEE_RESULT_HTML = `
<table>
  <tr><th>Committee ID</th><th>Committee Type</th><th>Committee Name</th><th>Status</th></tr>
  <tr><td><a href="#">521877</a></td><td>Candidate</td><td>ARIC NESBITT FOR GOVERNOR</td><td>Active</td></tr>
  <tr><td><a href="#">518698</a></td><td>Candidate</td><td>ARIC NESBITT FOR STATE SENATE</td><td>Active</td></tr>
  <tr><td><a href="#">514761</a></td><td>Candidate</td><td>ARIC NESBITT FOR STATE REPRESENTATIVE</td><td>Dissolved</td></tr>
</table>`;

// --- tests -----------------------------------------------------------------

describe("michiganMitnPublicSearchClient", () => {

  it("retains public filing lookup IDs and supports an exact all-type registry search", async () => {
    const html = '<table><tr x-bind:hx-vals="JSON.stringify({ parameters: { id: 20991 } })"><td>508347</td><td>Independent</td><td>UAW MICHIGAN VOLUNTARY POLITICAL ACTION COMMITTEE</td><td>Active</td></tr></table>';
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => html, arrayBuffer: async () => new ArrayBuffer(0),
    });
    const rows = await fetchMichiganMitnCommitteeSearch({
      committeeId: "508347", committeeName: "UAW MICHIGAN VOLUNTARY POLITICAL ACTION COMMITTEE",
      committeeType: "", fetchFn,
    });
    expect(rows[0]).toMatchObject({ committeeId: "508347", registryInternalId: "20991" });
    const body = new URLSearchParams(fetchFn.mock.calls[0]![1].body);
    expect(body.get("form.committeeId")).toBe("508347");
    expect(body.get("form.committeeType")).toBe("");
    expect(body.get("form.candidateLastName")).toBe("");
  });

  it("parses committee search result rows", () => {
    expect(parseMichiganMitnCommitteeSearchHtml(COMMITTEE_RESULT_HTML)).toEqual([
      { committeeId: "521877", committeeType: "Candidate", committeeName: "ARIC NESBITT FOR GOVERNOR", status: "Active" },
      {
        committeeId: "518698",
        committeeType: "Candidate",
        committeeName: "ARIC NESBITT FOR STATE SENATE",
        status: "Active",
      },
      {
        committeeId: "514761",
        committeeType: "Candidate",
        committeeName: "ARIC NESBITT FOR STATE REPRESENTATIVE",
        status: "Dissolved",
      },
    ]);
  });

  it("throws on the not-allowed and row-cap error fragments", () => {
    expect(() => parseMichiganMitnCommitteeSearchHtml("<div>The attempted search is not allowed.</div>")).toThrow(
      "rejected the request shape"
    );
    expect(() =>
      parseMichiganMitnCommitteeSearchHtml("<div>narrow the search criteria to return fewer than 25,000 records</div>")
    ).toThrow("row cap");
  });

  it("sends the full committee-search field set with the office filter applied", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => COMMITTEE_RESULT_HTML,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await fetchMichiganMitnCommitteeSearch({
      candidateLastName: "Nesbitt",
      candidateFirstName: "Aric",
      officeSought: "Governor",
      fetchFn,
    });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toContain("page=page.miboeCommitteePublicSearch&action=search");
    expect(init.headers["hx-request"]).toBe("true");
    const body = new URLSearchParams(init.body);
    expect(body.get("option")).toBe("committee");
    expect(body.get("form.committeeType")).toBe("13");
    expect(body.get("form.candidateLastName")).toBe("Nesbitt");
    expect(body.get("form.candidateFirstName")).toBe("Aric");
    expect(body.get("form.officeSought")).toBe("121");
    // the server rejects partial bodies — every field must be present
    expect(body.has("form.sponsoringOrganization")).toBe(true);
    expect(body.has("form.officeHeldDistrict")).toBe(true);
  });

  it("downloads and validates a contribution export", async () => {
    const zip = buildZip([{ name: "xl/worksheets/sheet1.xml", content: sheetXml([["a"]]) }]);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    });

    const buffer = await fetchMichiganMitnContributionExportXlsx({
      committeeId: "521877",
      statementYear: 2026,
      fetchFn,
    });
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toContain("page=page.miboeContributionPublicSearch&action=export");
    const body = new URLSearchParams(init.body);
    expect(body.get("form.committeeId")).toBe("521877");
    expect(body.get("form.campaignStatementYear")).toBe("76");
    expect(body.get("form.contributionType")).toBe("individual");
  });

  it.each([["0521495", "521495"], ["0608867", "608867"]])(
    "uses numeric receipt export ID %s while preserving the registry spelling",
    async (sourceId, exportId) => {
      const zip = buildZip([{ name: "xl/worksheets/sheet1.xml", content: sheetXml([EXPORT_HEADER]) }]);
      const fetchFn = vi.fn().mockImplementation(async () => new Response(zip));
      await fetchMichiganMitnContributionExportXlsx({ committeeId: sourceId, statementYear: 2026, fetchFn });
      expect(new URLSearchParams(fetchFn.mock.calls[0]![1].body).get("form.committeeId")).toBe(exportId);
      fetchFn.mockImplementation(async () => new Response("<table></table>"));
      await fetchMichiganMitnCommitteeSearch({ committeeId: sourceId, committeeType: "", fetchFn });
      expect(new URLSearchParams(fetchFn.mock.calls[1]![1].body).get("form.committeeId")).toBe(sourceId);
    }
  );

  it("rejects non-xlsx export responses and unknown statement years", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => {
        const html = Buffer.from("<html>error</html>");
        return html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength);
      },
    });
    await expect(
      fetchMichiganMitnContributionExportXlsx({ committeeId: "521877", statementYear: 2026, fetchFn })
    ).rejects.toThrow("did not return an xlsx attachment");
    await expect(
      fetchMichiganMitnContributionExportXlsx({ committeeId: "521877", statementYear: 2031, fetchFn })
    ).rejects.toThrow("statement-year id");
  });

  it("reads inline-string xlsx rows, keeping empty cells positional", () => {
    const zip = buildZip([
      {
        name: "xl/worksheets/sheet1.xml",
        content: sheetXml([
          ["Receipt ID", "Amount of Contribution", "Contributor Employer"],
          ["26-1", "500.00", ""],
          ["26-2", "", "KELLOGG & CO"],
        ]),
      },
    ]);
    expect(parseMichiganMitnExportXlsxRows(zip)).toEqual([
      ["Receipt ID", "Amount of Contribution", "Contributor Employer"],
      ["26-1", "500.00", ""],
      ["26-2", "", "KELLOGG & CO"],
    ]);
  });

  it("maps export rows onto the legacy contribution-row shape", () => {
    const rows = michiganMitnExportRowsToLegacyContributionRows([
      EXPORT_HEADER,
      [
        "1",
        "26-889077",
        "I",
        "Campaign Statements",
        "2026",
        "July CS",
        "ARIC NESBITT FOR GOVERNOR",
        "521877",
        "Candidate",
        "ARIC",
        "NESBITT",
        "Direct Contributions",
        "RAYMOND",
        "KOUZA",
        "RETIRED",
        "",
        "06/24/2026",
        "1000.00",
        "1000.00",
      ],
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contribution_id: "26-889077",
      doc_stmnt_year: "2026",
      doc_type_desc: "July CS",
      com_legal_name: "ARIC NESBITT FOR GOVERNOR",
      cfr_com_id: "521877",
      com_type: "CAN",
      can_first_name: "ARIC",
      can_last_name: "NESBITT",
      contribtype: "Direct Contributions",
      f_name: "RAYMOND",
      l_name_or_org: "KOUZA",
      occupation: "RETIRED",
      received_date: "06/24/2026",
      amount: "1000.00",
      aggregate: "1000.00",
    });
  });

  it("dedupes repeated receipts, preferring the amended filing", () => {
    const header = ["Record Type (1=Parent, 2=Child)", "Receipt ID", "Document Type", "Amount of Contribution"];
    const deduped = dedupeMichiganMitnExportRows([
      header,
      ["1", "25-1", "Campaign Statements", "1041.02"],
      ["1", "25-1", "Amended Campaign Statements", "900.00"],
      ["1", "25-2", "Campaign Statements", "50.00"],
      // child rows are itemizations of a parent receipt — never summed
      ["2", "25-3", "Campaign Statements", "25.00"],
    ]);
    expect(deduped).toEqual([
      header,
      ["1", "25-1", "Amended Campaign Statements", "900.00"],
      ["1", "25-2", "Campaign Statements", "50.00"],
    ]);
  });

  it("never lets an original filing replace an amendment, regardless of order", () => {
    const header = ["Receipt ID", "Document Type", "Amount of Contribution"];
    const deduped = dedupeMichiganMitnExportRows([
      header,
      ["25-1", "Amended Campaign Statements", "900.00"],
      ["25-1", "Campaign Statements", "1041.02"],
    ]);
    expect(deduped).toEqual([header, ["25-1", "Amended Campaign Statements", "900.00"]]);
  });

  it("splits display names into search tokens", () => {
    expect(splitMichiganCandidateNameForSearch("Angela M. Jones")).toEqual({ firstName: "Angela", lastName: "Jones" });
    expect(splitMichiganCandidateNameForSearch("Joseph Bellino Jr.")).toEqual({
      firstName: "Joseph",
      lastName: "Bellino",
    });
    expect(splitMichiganCandidateNameForSearch("Chris Gilmer-Hill")).toEqual({
      firstName: "Chris",
      lastName: "Gilmer-Hill",
    });
    expect(splitMichiganCandidateNameForSearch('Glenn "Mike" Prax (Mike)')).toEqual({
      firstName: "Glenn",
      lastName: "Prax",
    });
    expect(splitMichiganCandidateNameForSearch("Cher")).toEqual({ firstName: "Cher", lastName: "" });
  });

  it("resolves exactly one active candidate committee via the public search", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `
        <table>
          <tr><td>521877</td><td>Candidate</td><td>ARIC NESBITT FOR GOVERNOR</td><td>Active</td></tr>
          <tr><td>514761</td><td>Candidate</td><td>ARIC NESBITT FOR STATE REPRESENTATIVE</td><td>Dissolved</td></tr>
        </table>`,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    expect(
      await resolveMichiganMitnCommitteeViaSearch({ candidateName: "Aric Nesbitt", mitnOffice: "Governor", fetchFn })
    ).toEqual({ status: "matched", committeeId: "521877", committeeName: "ARIC NESBITT FOR GOVERNOR" });
  });

  it("refuses zero or multiple active committees and unsupported offices", async () => {
    const twoActive = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `
        <table>
          <tr><td>1</td><td>Candidate</td><td>JANE DOE FOR MICHIGAN</td><td>Active</td></tr>
          <tr><td>2</td><td>Candidate</td><td>COMMITTEE TO ELECT JANE DOE</td><td>Active</td></tr>
        </table>`,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(
      (await resolveMichiganMitnCommitteeViaSearch({ candidateName: "Jane Doe", mitnOffice: "State House", fetchFn: twoActive }))
        .status
    ).toBe("ambiguous");

    const noneActive = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<table><tr><td>1</td><td>Candidate</td><td>JANE DOE FOR MICHIGAN</td><td>Dissolved</td></tr></table>`,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(
      await resolveMichiganMitnCommitteeViaSearch({ candidateName: "Jane Doe", mitnOffice: "State House", fetchFn: noneActive })
    ).toEqual({ status: "unmatched", reason: "no_active_candidate_committee" });

    expect(
      await resolveMichiganMitnCommitteeViaSearch({ candidateName: "Jane Doe", mitnOffice: "County Drain Commissioner", fetchFn: noneActive })
    ).toEqual({ status: "unmatched", reason: "unsupported_office" });
    expect(noneActive).toHaveBeenCalledTimes(1);
  });

  it("skips blank export rows and requires recognized headers", () => {
    expect(michiganMitnExportRowsToLegacyContributionRows([EXPORT_HEADER, ["", "", ""]])).toEqual([]);
    expect(() => michiganMitnExportRowsToLegacyContributionRows([["Nothing", "Recognized"], ["a", "b"]])).toThrow(
      "missing or duplicate required headers"
    );
  });
});


describe("Michigan receipt export schema", () => {
  it("accepts the existing 19-column and official extended headers, including header-only empties", () => {
    expect(() => validateMichiganMitnContributionExportHeader([EXPORT_HEADER])).not.toThrow();
    expect(michiganMitnExportRowsToLegacyContributionRows([EXPORT_HEADER])).toEqual([]);
    expect(() => validateMichiganMitnContributionExportHeader([[...EXPORT_HEADER, "Contributor Address", "Contributor City"]])).not.toThrow();
  });
  it.each(MICHIGAN_MITN_REQUIRED_CONTRIBUTION_HEADERS)("rejects a missing %s even in a header-only export", (name) => {
    const partial = EXPORT_HEADER.filter((column) => column !== name);
    expect(() => michiganMitnExportRowsToLegacyContributionRows([partial])).toThrow("required headers");
  });
  it("rejects missing and duplicate schemas rather than mapping a zero snapshot", () => {
    expect(() => michiganMitnExportRowsToLegacyContributionRows([])).toThrow("required headers");
    expect(() => michiganMitnExportRowsToLegacyContributionRows([[...EXPORT_HEADER, "Receiving Committee ID#"]])).toThrow("required headers");
  });
});

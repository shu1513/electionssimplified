import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  fetchIllinoisSbeCandidateContributionsCsv,
  fetchIllinoisSbeCommitteeContributionsCsv,
  fetchIllinoisSbeIndependentExpendituresCsv,
  decodeIllinoisSbeText,
  getIllinoisSbeExportCapStatus,
  hasIllinoisSbeExportCapWarning,
  illinoisSbeContributionRecordFromRow,
  illinoisSbeExpenditureRecordFromRow,
  parseIllinoisSbeCsvRows,
  planIllinoisSbeExportPartitions,
  splitIllinoisSbeSetCookieHeader,
  splitIllinoisSbeAmountWindow,
  splitIllinoisSbeDateWindow,
} from "../../../src/pipeline/illinoisFinance/illinoisSbeClient.js";

describe("illinoisSbeClient", () => {
  it("supports explicit bounded all-target IE discovery without posting Reset", async () => {
    const controls = `<input type="hidden" name="__VIEWSTATE" value="state" />
      <input type="submit" name="ctl00$ContentPlaceHolder1$btnSubmit" value="Search" />
      <input type="submit" name="ctl00$ContentPlaceHolder1$btnReset" value="Reset" />`;
    const csv = readFileSync(new URL("../../fixtures/illinoisFinance/expenditures-modern.csv", import.meta.url), "utf8");
    const url = "https://www.elections.il.gov/CampaignDisclosure/ExpenditureSearchByAllExpenditures.aspx";
    const response = (text: string) => {
      const result = new Response(text);
      Object.defineProperty(result, "url", { value: url });
      return result;
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(controls))
      .mockResolvedValueOnce(response(`${controls}<a id="ContentPlaceHolder1_lnkDownloadList">Download</a>`))
      .mockResolvedValueOnce(response(`${controls}<input id="ContentPlaceHolder1_btnCSV" />`))
      .mockResolvedValueOnce(response(csv));
    expect(await fetchIllinoisSbeIndependentExpendituresCsv({
      allCandidates: true, fromDate: "1/1/2025", toDate: "12/31/2026",
    }, { fetchImpl })).toBe(csv);
    const body = new URLSearchParams(fetchImpl.mock.calls[1]![1].body);
    expect(body.get("ctl00$ContentPlaceHolder1$txtCandidateName")).toBe("");
    expect(body.get("ctl00$ContentPlaceHolder1$txtOffice")).toBe("");
    expect(body.get("ctl00$ContentPlaceHolder1$radSupportingOpposing")).toBe("");
    expect(body.get("ctl00$ContentPlaceHolder1$txtExpendedDate")).toBe("1/1/2025");
    expect(body.get("ctl00$ContentPlaceHolder1$txtExpendedDateThru")).toBe("12/31/2026");
    expect(body.has("ctl00$ContentPlaceHolder1$btnReset")).toBe(false);
  });

  it.each([
    {},
    { candidateName: "" },
    { allCandidates: true },
    { allCandidates: true, fromDate: "1/1/2025" },
    { allCandidates: true, toDate: "12/31/2026" },
    { allCandidates: true, candidateName: "Bailey", fromDate: "1/1/2025", toDate: "12/31/2026" },
    { allCandidates: true, fromDate: "2025-01-01", toDate: "12/31/2026" },
    { allCandidates: true, fromDate: "2/30/2025", toDate: "12/31/2026" },
    { allCandidates: true, fromDate: "12/31/2026", toDate: "1/1/2025" },
  ])("rejects missing identity, unbounded or invalid broad search before fetch: %j", async (input) => {
    const fetchImpl = vi.fn();
    await expect(fetchIllinoisSbeIndependentExpendituresCsv(input, { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("submits only the explicit Search button and excludes it from download postbacks", async () => {
    // Native committee form exposes both Search and Reset submit inputs.
    const controls = `<input type="hidden" name="__VIEWSTATE" value="state" />
      <input type="submit" name="ctl00$ContentPlaceHolder1$btnSubmit" value="Search" />
      <input type="submit" name="ctl00$ContentPlaceHolder1$btnReset" value="Reset" />
      <input type="reset" name="resetOnly" value="Reset" />
      <input type="button" name="buttonOnly" value="Other" />
      <input type="image" name="imageOnly" value="Other" />
      <input type="file" name="upload" value="Other" />
      <input disabled name="disabledText" value="Other" />`;
    const csv = readFileSync(new URL("../../fixtures/illinoisFinance/contributions-modern.csv", import.meta.url), "utf8");
    const response = (text: string, url: string) => {
      const result = new Response(text);
      Object.defineProperty(result, "url", { value: url });
      return result;
    };
    const searchUrl = "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCommittees.aspx";
    const downloadUrl = "https://www.elections.il.gov/CampaignDisclosure/DownloadList.aspx";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(controls, searchUrl))
      .mockResolvedValueOnce(response(`${controls}<a id="ContentPlaceHolder1_lnkDownloadList">Download</a>`, searchUrl))
      .mockResolvedValueOnce(response(`${controls}<input type="submit" id="ContentPlaceHolder1_btnCSV" name="ctl00$ContentPlaceHolder1$btnCSV" value="CSV" />`, downloadUrl))
      .mockResolvedValueOnce(response(csv, downloadUrl));
    expect(await fetchIllinoisSbeCommitteeContributionsCsv({ committeeId: "39503" }, { fetchImpl })).toBe(csv);
    const bodies = fetchImpl.mock.calls.slice(1).map((call) => new URLSearchParams(call[1].body));
    expect(bodies[0].get("ctl00$ContentPlaceHolder1$btnSubmit")).toBe("Search");
    expect(bodies[0].get("ctl00$ContentPlaceHolder1$txtCmteID")).toBe("39503");
    expect(bodies[1].get("__EVENTTARGET")).toBe("ctl00$ContentPlaceHolder1$lnkDownloadList");
    expect(bodies[2].get("__EVENTTARGET")).toBe("ctl00$ContentPlaceHolder1$btnCSV");
    for (const [index, body] of bodies.entries()) {
      expect(body.get("__VIEWSTATE")).toBe("state");
      for (const name of ["ctl00$ContentPlaceHolder1$btnReset", "resetOnly", "buttonOnly", "imageOnly", "upload", "disabledText", "ctl00$ContentPlaceHolder1$btnCSV"]) {
        expect(body.has(name)).toBe(false);
      }
      if (index > 0) expect(body.has("ctl00$ContentPlaceHolder1$btnSubmit")).toBe(false);
    }
    for (const call of fetchImpl.mock.calls) {
      expect(new Headers(call[1].headers).get("user-agent")).toContain("Mozilla/5.0");
    }
  });

  it("rejects an explicit result-page cap before attempting a download", async () => {
    const response = (text: string) => {
      const result = new Response(text);
      Object.defineProperty(result, "url", { value: "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCommittees.aspx" });
      return result;
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response("<input name='__VIEWSTATE' value='state' />"))
      .mockResolvedValueOnce(response("<a id='ContentPlaceHolder1_lnkDownloadList'>Download</a>The maximum number of records available for download is 25,000."));
    await expect(fetchIllinoisSbeCommitteeContributionsCsv({ committeeId: "39503" }, { fetchImpl })).rejects.toThrow("capped");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("decodes source Windows-1252 without corrupting valid UTF8 or UTF16", () => {
    expect(decodeIllinoisSbeText(Uint8Array.from([0x50, 0x65, 0xf1, 0x61]).buffer)).toBe("Peña");
    expect(decodeIllinoisSbeText(Uint8Array.from([0x91, 0x50, 0x65, 0xf1, 0x61, 0x92]).buffer)).toBe("‘Peña’");
    expect(decodeIllinoisSbeText(new TextEncoder().encode("Peña — Illinois").buffer)).toBe("Peña — Illinois");
    const le = Uint8Array.from([0xff, 0xfe, 0x50, 0, 0x65, 0, 0xf1, 0, 0x61, 0]);
    const be = Uint8Array.from([0xfe, 0xff, 0, 0x50, 0, 0x65, 0, 0xf1, 0, 0x61]);
    expect(decodeIllinoisSbeText(le.buffer)).toBe("Peña");
    expect(decodeIllinoisSbeText(be.buffer)).toBe("Peña");
    const bomless = Uint8Array.from(Buffer.from("Contributed By,Amount\nPeña,1000\n", "utf16le"));
    expect(decodeIllinoisSbeText(bomless.buffer)).toBe("Contributed By,Amount\nPeña,1000\n");
  });

  it("splits combined Set-Cookie headers without breaking Expires dates", () => {
    expect(
      splitIllinoisSbeSetCookieHeader(
        "ASP.NET_SessionId=abc; path=/; secure; HttpOnly; SameSite=Lax, " +
          "53739654b1671269f9d68b7188f1ee11418a3d0b97c07c45e41b2c2b092866e0=def;" +
          "expires=Tue, 30-Jun-2026 05:27:26 GMT;path=/;secure;httponly, " +
          "__cf_bm=ghi; HttpOnly; SameSite=None; Secure; Path=/; Domain=elections.il.gov; " +
          "Expires=Tue, 30 Jun 2026 05:47:26 GMT"
      )
    ).toEqual([
      "ASP.NET_SessionId=abc; path=/; secure; HttpOnly; SameSite=Lax",
      "53739654b1671269f9d68b7188f1ee11418a3d0b97c07c45e41b2c2b092866e0=def;expires=Tue, 30-Jun-2026 05:27:26 GMT;path=/;secure;httponly",
      "__cf_bm=ghi; HttpOnly; SameSite=None; Secure; Path=/; Domain=elections.il.gov; Expires=Tue, 30 Jun 2026 05:47:26 GMT",
    ]);
  });

  it("does not split combined Set-Cookie headers inside quoted cookie values", () => {
    expect(
      splitIllinoisSbeSetCookieHeader(
        'token="abc,key=val"; Path=/; HttpOnly, ASP.NET_SessionId=abc; path=/; secure; HttpOnly'
      )
    ).toEqual([
      'token="abc,key=val"; Path=/; HttpOnly',
      "ASP.NET_SessionId=abc; path=/; secure; HttpOnly",
    ]);
  });

  it("fails clearly when the live SBE form POST returns an empty response", async () => {
    const searchHtml = `
      <html><body>
        <form action="./ContributionSearchByCandidates.aspx">
          <input type="hidden" name="__VIEWSTATE" value="state" />
          <input type="hidden" name="__EVENTVALIDATION" value="event" />
          <input name="ctl00$ContentPlaceHolder1$txtCanElectYear" value="" />
          <input name="ctl00$ContentPlaceHolder1$txtCanLastName" value="" />
          <input name="ctl00$ContentPlaceHolder1$txtCanFirstName" value="" />
          <input type="submit" name="ctl00$ContentPlaceHolder1$btnCanSubmit" value="Search" />
          <select name="ctl00$ContentPlaceHolder1$ddlCanElectType"><option selected value="All Types">All Types</option></select>
          <select name="ctl00$ContentPlaceHolder1$ddlCanLastNameSearchType"><option selected value="Contains">Contains</option></select>
          <select name="ctl00$ContentPlaceHolder1$ddlCanFirstNameSearchType"><option selected value="Contains">Contains</option></select>
        </form>
      </body></html>
    `;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(searchHtml, {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "ASP.NET_SessionId=abc; path=/; HttpOnly",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );

    await expect(
      fetchIllinoisSbeCandidateContributionsCsv(
        {
          candidateLastName: "Pritzker",
          candidateFirstName: "JB",
          electionYear: 2022,
        },
        { fetchImpl }
      )
    ).rejects.toThrow("Illinois SBE returned an empty response for search request");
  });

  it("parses quoted Illinois SBE CSV rows and normalizes headers", () => {
    expect(
      parseIllinoisSbeCsvRows(
        'Contributed By,Received By,Amount\r\n"Doe, Jane\nOccupation: Attorney\nEmployer: Acme","Individual Contributions\nFriends of Jane","$1,250.50"\r\n'
      )
    ).toEqual([
      {
        contributed_by: "Doe, Jane\nOccupation: Attorney\nEmployer: Acme",
        received_by: "Individual Contributions\nFriends of Jane",
        amount: "$1,250.50",
      },
    ]);
  });

  it("maps Illinois contribution rows with contributor occupation and recipient committee", () => {
    expect(
      illinoisSbeContributionRecordFromRow({
        contributed_by: "Doe, Jane\n123 Main St\nOccupation: Attorney\nEmployer: Acme",
        received_by: "Individual Contributions\nFriends of Jane",
        amount: "$1,250.50",
        amount_received_date: "3/1/2022",
      })
    ).toMatchObject({
      contributorName: "Doe, Jane",
      contributorAddress: "123 Main St",
      occupation: "Attorney",
      employer: "Acme",
      contributionType: "Individual Contributions",
      recipientCommitteeName: "Friends of Jane",
      amount: 1250.5,
      receivedDate: "3/1/2022",
    });
  });

  it("maps Illinois independent expenditure rows conservatively", () => {
    expect(
      illinoisSbeExpenditureRecordFromRow({
        received_by: "Vendor LLC\n1 Market St",
        expended_by: "Independent Expenditures\nPeople for Schools",
        amount: "($500.00)",
        expended_by_date: "10/1/2022",
        candidate_name: "Jane Doe",
        office_district: "Governor",
        supporting_opposing: "Supporting",
      })
    ).toMatchObject({
      payeeName: "Vendor LLC",
      payeeAddress: "1 Market St",
      expenditureType: "Independent Expenditures",
      expendingCommitteeName: "People for Schools",
      amount: -500,
      expendedDate: "10/1/2022",
      candidateName: "Jane Doe",
      officeDistrict: "Governor",
      supportOppose: "support",
    });
  });

  it("detects capped export risk and proposes date or amount partitions", () => {
    expect(hasIllinoisSbeExportCapWarning("The maximum number of records available for download is 25,000.")).toBe(
      true
    );
    expect(
      getIllinoisSbeExportCapStatus({
        csvRowCount: 25_000,
        resultText: "The maximum number of records available for download is 25,000.",
      })
    ).toEqual({
      rowCount: 25000,
      cap: 25000,
      capped: true,
      warningTextPresent: true,
      reason: "row_count_reached_cap",
    });
    expect(
      getIllinoisSbeExportCapStatus({
        csvRowCount: 10,
        resultText: "The maximum number of records available for download is 25,000.",
      })
    ).toEqual({
      rowCount: 10,
      cap: 25000,
      capped: true,
      warningTextPresent: true,
      reason: "warning_text_present",
    });
    expect(splitIllinoisSbeDateWindow({ fromDate: "1/1/2021", toDate: "12/31/2022" })).toEqual([
      { fromDate: "1/1/2021", toDate: "12/31/2021" },
      { fromDate: "1/1/2022", toDate: "12/31/2022" },
    ]);
    expect(splitIllinoisSbeAmountWindow({ minAmount: 0, maxAmount: 1000 })).toEqual([
      { minAmount: 0, maxAmount: 500 },
      { minAmount: 500.01, maxAmount: 1000 },
    ]);
  });

  it("plans capped export partitions by date first and amount as a fallback", () => {
    expect(
      planIllinoisSbeExportPartitions({
        csvRowCount: 25_000,
        fromDate: "1/1/2021",
        toDate: "12/31/2022",
        minAmount: 0,
        maxAmount: 1000,
      })
    ).toMatchObject({
      strategy: "date",
      partitions: [
        { fromDate: "1/1/2021", toDate: "12/31/2021", minAmount: 0, maxAmount: 1000 },
        { fromDate: "1/1/2022", toDate: "12/31/2022", minAmount: 0, maxAmount: 1000 },
      ],
    });

    expect(
      planIllinoisSbeExportPartitions({
        csvRowCount: 100,
        resultText: "The maximum number of records available for download is 25,000.",
        minAmount: 0,
        maxAmount: 1000,
      })
    ).toMatchObject({
      strategy: "amount",
      partitions: [
        { minAmount: 0, maxAmount: 500 },
        { minAmount: 500.01, maxAmount: 1000 },
      ],
    });

    expect(
      planIllinoisSbeExportPartitions({
        csvRowCount: 1,
        fromDate: "1/1/2022",
        toDate: "12/31/2022",
      })
    ).toMatchObject({
      strategy: null,
      partitions: null,
      status: { capped: false },
    });
  });
});

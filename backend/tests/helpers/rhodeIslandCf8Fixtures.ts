import { createErtsTransport, type ErtsHttpResponse } from "../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsClient.js";
import { makeMinimalPdf } from "./minimalPdf.js";

export const GUID = "00000000-0000-0000-0000-000000000001", TRANSFER = "00000000-0000-0000-0000-000000000002";
export const NAME = "Synthetic Independent Spender";
export const pdf = makeMinimalPdf([]); // No text layer: CF2 must reject; CF8 may cache the original.
export const url = (guid = GUID, type = "INDEPENDENT EXPENDITURE") =>
  `https://www.ricampaignfinance.com/ReportsScanned/Public-${encodeURIComponent(type)}-${guid}.pdf`;
const row = (day: string, type: string, guid: string, name = NAME) =>
  `<tr><td>${day}</td><td></td><td>${type}</td><td><a href="${url(guid, type)}">${name}</a></td></tr>`;
const page = (rows: string, current: number, next: boolean) => `<input type="hidden" name="__VIEWSTATE" value="test" />
  <table id="dgdCF8FilingList"><tr><td>Filed Date</td><td></td><td>Type</td><td>Org</td></tr>${rows}
  <tr><td colspan="4"><span>${current}</span> ${next ? "<a href=\"javascript:__doPostBack('dgdCF8FilingList$ctl14$ctl01','')\">2</a>" : "<a href=\"javascript:__doPostBack('dgdCF8FilingList$ctl14$ctl00','')\">1</a>"}</td></tr></table>`;
export function portal(options: { closingChanged?: boolean; failScan?: boolean; missingScan?: boolean; redirectWrong?: boolean; nativeDate?: string } = {}) {
  let openings = 0; const calls: string[] = [];
  return { calls, transport: createErtsTransport({ sleep: async () => {}, spacingMs: 0, maxAttempts: 1,
    fetch: async (u, body): Promise<ErtsHttpResponse> => {
      calls.push(u); let data: Uint8Array;
      if (u.includes("/ReportsScanned/")) {
        if (options.failScan) return { status: 500, finalUrl: u, contentType: "text/html", body: new TextEncoder().encode("unavailable") };
        return { status: 200, finalUrl: options.redirectWrong ? url(TRANSFER) : u, contentType: "application/pdf", body: pdf.slice() };
      }
      if (!body) openings++;
      if (body) data = new TextEncoder().encode(page(row("Dec 31 2024", "COVERED TRANSFER", "00000000-0000-0000-0000-000000000003", "Old Other Filer"), 2, false));
      else {
        let first = row(options.nativeDate ?? (options.closingChanged && openings > 1 ? "Oct 11 2026" : "Oct 10 2026"), "INDEPENDENT EXPENDITURE", GUID);
        if (options.missingScan) first = first.replace(/<a href="[^"]+">([^<]+)<\/a>/u, "$1");
        data = new TextEncoder().encode(page(first + row("Aug 10 2026", "COVERED TRANSFER", TRANSFER), 1, true));
      }
      return { status: 200, finalUrl: u, contentType: "text/html", body: data };
    } }) };
}

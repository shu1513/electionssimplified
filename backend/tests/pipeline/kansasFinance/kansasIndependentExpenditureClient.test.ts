import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  buildKansasCfrUrl,
  type KansasCfrSessionOptions,
} from "../../../src/pipeline/kansasFinance/kansasCfrViewerClient.js";
import {
  parseKansasIEPaperUrl,
  searchKansasIndependentExpenditures,
} from "../../../src/pipeline/kansasFinance/kansasIndependentExpenditureClient.js";

const url =
  "https://sos.ks.gov/srvimages/campaignfinance/filings/cy2026/cm10/65598.pdf";
const hidden =
  '<input type="hidden" name="__VIEWSTATE" value="synthetic-state" />';
const row = (
  index: number,
  name: string,
) => `<span id="gvIndividualEntity_lblPaperDate_${index}">10/08/2026</span>
<span id="gvIndividualEntity_labelOfficeSought_${index}">INDIVIDUAL ENTITY</span>
<a id="gvIndividualEntity_lnkbtnName_${index}" href="javascript:__doPostBack(&#39;gvIndividualEntity$ctl0${index + 2}$lnkbtnName&#39;,&#39;&#39;)">${name}</a>
<img id="gvIndividualEntity_paper_${index}" title="Paper Filing" />`;
function setup(
  overrides: {
    entryStatus?: number;
    opener?: string;
    pdf?: Response;
    secondCount?: number;
  } = {},
) {
  const calls: { url: string; fields: URLSearchParams }[] = [];
  const fetchImpl = vi.fn<KansasCfrSessionOptions["fetchImpl"]>(
    async (requestUrl, init) => {
      const fields = new URLSearchParams(init.body ?? "");
      calls.push({ url: requestUrl, fields });
      if (requestUrl === url)
        return (
          overrides.pdf ??
          new Response("%PDF-synthetic", {
            headers: { "Content-Type": "application/pdf" },
          })
        );
      if (
        requestUrl.endsWith("cfr_examiner_entry.aspx") &&
        init.method === "GET"
      )
        return new Response(hidden, { status: overrides.entryStatus ?? 200 });
      if (fields.has("ddlViewerOptions"))
        return new Response(null, {
          status: 302,
          headers: { Location: "cfr_examiner.aspx" },
        });
      if (fields.has("btnSearch"))
        return new Response(null, {
          status: 302,
          headers: { Location: "cfr_examiner_search_results.aspx" },
        });
      if (requestUrl.endsWith("cfr_examiner.aspx")) return new Response(hidden);
      if (fields.get("__EVENTARGUMENT") === "Page$2")
        return new Response(
          `${hidden}<span id="lblRecordCount">${overrides.secondCount ?? 2}</span>${row(0, "SECOND FUND")}<tr><td><a href="javascript:__doPostBack(&#39;gvIndividualEntity&#39;,&#39;Page$1&#39;)">1</a></td><td><span>2</span></td></tr>`,
        );
      if (fields.has("__EVENTTARGET"))
        return new Response(
          overrides.opener ??
            `<script>window.open('${url}', '_blank');</script>`,
        );
      return new Response(
        `${hidden}<span id="lblRecordCount">2</span>${row(0, "FIRST FUND")}<tr><td><span>1</span></td><td><a href="javascript:__doPostBack(&#39;gvIndividualEntity&#39;,&#39;Page$2&#39;)">2</a></td></tr>`,
      );
    },
  );
  return {
    calls,
    fetchImpl,
    input: {
      startDate: "01/01/2026",
      endDate: "10/12/2026",
      filerName: "TEST FUND",
      sessionOptions: { fetchImpl, spacingMs: 0 },
    },
  };
}

describe("Kansas IndividualEntity source acquisition", () => {
  it("uses the observed search, walks all pages and opens the row from its own page state", async () => {
    const { input, calls } = setup();
    const result = await searchKansasIndependentExpenditures(input);
    expect(result.recordCount).toBe(2);
    expect(result.filings.map(({ row }) => [row.name, row.fileDate])).toEqual([
      ["FIRST FUND", "10/08/2026"],
      ["SECOND FUND", "10/08/2026"],
    ]);
    expect(
      calls
        .find(({ fields }) => fields.has("ddlViewerOptions"))
        ?.fields.get("ddlViewerOptions"),
    ).toBe("IndividualEntity");
    const search = calls.find(({ fields }) => fields.has("btnSearch"))!.fields;
    expect(Object.fromEntries(search)).toMatchObject({
      txtCommitteeName: "TEST FUND",
      drpdownFilingType: "Individual Expenditures",
      txtStartDate: "01/01/2026",
      txtEndDate: "10/12/2026",
    });
    const document = await result.filings[1]!.openPaperDocument();
    expect(document.sourceUrl).toBe(url);
    expect(document.observation).toMatchObject({
      status: 200,
      byteSize: 14,
      sha256: createHash("sha256").update(document.body).digest("hex"),
    });
    expect(Date.parse(document.observation.endedAt)).toBeGreaterThanOrEqual(
      Date.parse(document.observation.startedAt),
    );
  });
  it("rejects a blocked native entry rather than returning empty filings", async () => {
    const { input, calls } = setup({ entryStatus: 202 });
    await expect(
      searchKansasIndependentExpenditures(input),
    ).rejects.toMatchObject({ status: 202 });
    expect(calls).toHaveLength(1);
  });
  it("preserves count-drift failure from the existing grid walker", async () => {
    const { input } = setup({ secondCount: 3 });
    await expect(
      searchKansasIndependentExpenditures(input),
    ).rejects.toMatchObject({ code: "grid_count_changed" });
  });
  it.each([
    new Response("blocked", {
      status: 202,
      headers: { "Content-Type": "application/pdf" },
    }),
    new Response("%PDF-html", { headers: { "Content-Type": "text/html" } }),
    new Response("not a PDF", {
      headers: { "Content-Type": "application/pdf" },
    }),
  ])("rejects an unavailable or disguised PDF", async (pdf) => {
    const { input } = setup({ pdf });
    const result = await searchKansasIndependentExpenditures(input);
    await expect(result.filings[0]!.openPaperDocument()).rejects.toThrow(
      "did not return a PDF",
    );
  });
  it.each(["02/30/2026", "2026-01-01", "01/01/0099"])(
    "rejects invalid dates before source access: %s",
    async (startDate) => {
      const { input, calls } = setup();
      await expect(
        searchKansasIndependentExpenditures({ ...input, startDate }),
      ).rejects.toThrow("filed-date window");
      expect(calls).toHaveLength(0);
    },
  );
  it("rejects a reversed window before source access", async () => {
    const { input, calls } = setup();
    await expect(
      searchKansasIndependentExpenditures({
        ...input,
        startDate: "10/13/2026",
      }),
    ).rejects.toThrow("Reversed");
    expect(calls).toHaveLength(0);
  });
  it("caps repeated paper opens instead of making unbounded requests", async () => {
    const { input, calls } = setup();
    const result = await searchKansasIndependentExpenditures(input);
    await expect(
      (async () => {
        for (let n = 0; n < 450; n++)
          await result.filings[0]!.openPaperDocument();
      })(),
    ).rejects.toThrow("request limit");
    expect(calls).toHaveLength(450);
  });
});

describe("Kansas observed paper opener", () => {
  it("accepts only the explicitly rendered official URL", () => {
    expect(
      parseKansasIEPaperUrl(
        `<script>window.open("${url}", "_blank");</script>`,
      ),
    ).toBe(url);
  });
  it.each([
    "",
    `<script>window.open('https://example.com/65598.pdf')</script>`,
    `<script>window.open('${url}?token=x')</script>`,
    `<script>window.open('${url}');window.open('https://sos.ks.gov/srvimages/campaignfinance/filings/cy2026/cm10/65597.pdf')</script>`,
  ])("rejects missing, unsafe or ambiguous openers", (html) => {
    expect(() => parseKansasIEPaperUrl(html)).toThrow(
      "one official paper PDF opener",
    );
  });
});

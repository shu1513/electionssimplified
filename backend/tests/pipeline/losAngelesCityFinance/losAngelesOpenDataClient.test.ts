import { describe, expect, it, vi } from "vitest";
import { getLosAngelesCommitteeContributions } from "../../../src/pipeline/losAngelesCityFinance/losAngelesOpenDataClient.js";

describe("Los Angeles Open Data client", () => {
  it("uses bounded stable paging and retries 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              source_row_id: "row-1",
              cmt_id: "1471359",
              cmt_nm: "Bass",
              schedule: "A",
              con_amount: "10.00",
              con_amount_pd_forgiven: "0.00",
              election_date: "2026-06-02T00:00:00.000",
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response("[]"));
    const rows = await getLosAngelesCommitteeContributions(
      { committeeId: "1471359", electionYear: 2026 },
      { fetchImpl, pageLimit: 1, maxPages: 3 },
    );
    expect(rows).toHaveLength(1);
    const url = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    expect(url.searchParams.get("$order")).toContain(":id");
    expect(url.searchParams.get("$where")).toContain(
      "election_date>='2026-01-01T00:00:00.000'",
    );
    expect(url.searchParams.get("$where")).toContain(
      "election_date<'2027-01-01T00:00:00.000'",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects committees with multiple source election dates in one year", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            source_row_id: "row-2",
              cmt_id: "1471359",
            cmt_nm: "Committee",
            schedule: "A",
            con_amount: "10.00",
            election_date: "2026-06-02T00:00:00.000",
          },
          {
            source_row_id: "row-3",
              cmt_id: "1471359",
            cmt_nm: "Committee",
            schedule: "A",
            con_amount: "20.00",
            election_date: "2026-11-03T00:00:00.000",
          },
        ]),
      ),
    );
    await expect(
      getLosAngelesCommitteeContributions(
        { committeeId: "1471359", electionYear: 2026 },
        { fetchImpl },
      ),
    ).rejects.toThrow(
      "multiple source election dates in 2026: 2026-06-02T00:00:00.000, 2026-11-03T00:00:00.000",
    );
  });

  it("rejects contribution rows missing their source election date", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            source_row_id: "row-4",
              cmt_id: "1471359",
            cmt_nm: "Committee",
            schedule: "A",
            con_amount: "10.00",
          },
        ]),
      ),
    );
    await expect(
      getLosAngelesCommitteeContributions(
        { committeeId: "1471359", electionYear: 2026 },
        { fetchImpl },
      ),
    ).rejects.toThrow(
      "returned contributions without a source election date in 2026",
    );
  });
});

it.each(["duplicate","foreign","missing id","malformed","invalid object"])("holds %s published ledger rows", async kind => {
 const row={source_row_id:"row-one",cmt_id:"1471359",cmt_nm:"Example Committee",schedule:"A",con_amount:"10",election_date:"2026-06-02T00:00:00.000"};
 let rows: unknown[]=[row];
 if(kind==="duplicate")rows=[row,{...row}]; if(kind==="foreign")row.cmt_id="1480000"; if(kind==="missing id")row.source_row_id=""; if(kind==="malformed")row.con_amount=""; if(kind==="invalid object")rows=[null];
 await expect(getLosAngelesCommitteeContributions({committeeId:"1471359",electionYear:2026},{fetchImpl:vi.fn().mockResolvedValue(new Response(JSON.stringify(rows)))})).rejects.toThrow();
});

it("does not turn a malformed disclosed repayment into zero", async () => {
 const rows=[{source_row_id:"row-one",cmt_id:"1471359",cmt_nm:"Example Committee",schedule:"B",con_amount:"100",con_amount_pd_forgiven:"invalid",election_date:"2026-06-02T00:00:00.000"}];
 await expect(getLosAngelesCommitteeContributions({committeeId:"1471359",electionYear:2026},{fetchImpl:vi.fn().mockResolvedValue(new Response(JSON.stringify(rows)))})).rejects.toThrow(/invalid/);
});

import { describe, expect, it } from "vitest";
import {
  vaAllocatedCents,
  vaInventory,
  vaIeDetail,
  vaIeIndex,
  vaPacIdentity,
  vaPartitionReports,
  vaRegistrations,
  vaReport,
  type VirginiaNativeReport,
  type VirginiaReceipt,
} from "../../../src/pipeline/virginiaFinance/virginiaReportedProtocol.js";
import {
  vaCents,
  vaDate,
  vaPersonMatches,
  vaPublicUrl,
} from "../../../src/pipeline/virginiaFinance/virginiaReportedNative.js";
const bytes = (s: string) => new TextEncoder().encode(s);
const source = "https://cfreports.elections.virginia.gov";
const address =
  "<Address><Line1>1 Synthetic Road</Line1><City>Example</City><State>VA</State><ZipCode>00000</ZipCode></Address>";
const receipt: VirginiaReceipt = {
  name: "Synthetic PAC",
  individual: false,
  address: ["1 Synthetic Road", "Example", "VA", "00000"],
  day: "2026-01-02",
  cents: 10000,
  signature: "synthetic-one",
  kind: "A",
};
const report = (
  overrides: Partial<VirginiaNativeReport> = {},
): VirginiaNativeReport => ({
  code: "synthetic",
  name: "Synthetic Receiving",
  address: receipt.address,
  filed: "2026-01-03",
  year: 2026,
  office: "Member, House Of Delegates",
  district: "20",
  start: "2026-01-01",
  end: "2026-01-03",
  rapid: false,
  rows: [receipt],
  ...overrides,
});
function xml() {
  return `<Report><ReportHeader><CommitteeCode>synthetic</CommitteeCode><CommitteeName>Synthetic Receiving</CommitteeName>${address}<FilingDate>1/3/2026</FilingDate><ElectionCycle>11/2026</ElectionCycle><OfficeSought>Member, House Of Delegates</OfficeSought><District>20</District><StartDate>1/1/2026</StartDate><EndDate>1/3/2026</EndDate><IsAmendment>false</IsAmendment><AmendedReportNumber>0</AmendedReportNumber></ReportHeader><ScheduleA><LiA><Contributor IsIndividual="false"><LastName>Synthetic PAC</LastName>${address}</Contributor><TransactionDate>1/2/2026</TransactionDate><Amount>-1.25</Amount></LiA></ScheduleA><ScheduleB/><ScheduleG><ScheduleACount>1</ScheduleACount><ScheduleATotal>-1.25</ScheduleATotal><ScheduleBCount>0</ScheduleBCount><ScheduleBTotal>0.00</ScheduleBTotal></ScheduleG></Report>`;
}
const field = (label: string, value: string) =>
  `<p><strong>${label}</strong> ${value}</p>`;
const target = (percent: string, stance = "Support") =>
  `<div>${field("Candidate Committee Name:", "Synthetic Receiving")}${field("Office Sought:", "Member, House Of Delegates")}${field("Support or Oppose:", stance)}${field("Percent of Expenditure:", percent)}</div>`;
const ie = (percent = "100", amount = "1.00", targets = target(percent)) =>
  bytes(
    `<main>${field("Date Funds Expended:", "1/2/2026")}${field("Total Amount Paid:", amount)}${field("Amount Paid:", amount)}${targets}</main>`,
  );
const parent = {
  url: source + "/IE/Details/synthetic",
  spender: "Synthetic Economic Spender",
  cents: 100,
  cells: [],
};
describe("Virginia native sources", () => {
  it("keeps rapid contribution IDs inside their native section", () => {
    const parsed = vaInventory(
      bytes(
        '<h2>Reports for Synthetic (SYN)</h2><div id="ScheduledReports"><a href="/Report/Index/1">Scheduled</a></div><div id="LargeContributionReports"><a href="/Report/Index/2">Rapid contribution</a></div><div id="LargeExpenditureReports"><a href="/Report/Index/3">Rapid expenditure</a></div>',
      ),
      "synthetic",
      source,
    );
    expect(parsed.scheduledReportIds).toEqual([1]);
    expect(parsed.largeContributionReportIds).toEqual([2]);
  });
  it("treats honorifics and quoted nicknames as presentation, retaining real middle evidence", () => {
    expect(
      vaPersonMatches(
        ['Jane "Jay" A Example', "Jane A Example"],
        "Ms Jane A Example",
        ["Jane"],
      ),
    ).toBe(true);
    expect(
      vaPersonMatches(['Jane "Jay" B Example'], "Ms Jane A Example", ["Jane"]),
    ).toBe(false);
  });
  it.each([
    ["1.25", 125],
    ["-1.25", -125],
    ["($1,000.00)", -100000],
    ["0.0000", 0],
  ])("keeps exact signed cents %s", (v, n) =>
    expect(vaCents(v as string)).toBe(n),
  );
  it.each(["1.001", "1,00", "NaN", "90071992547409.92"])(
    "rejects invalid money %s",
    (v) => expect(() => vaCents(v)).toThrow(),
  );
  it("rejects invalid calendar dates", () =>
    expect(() => vaDate("2/30/2026")).toThrow());
  it("rejects lookalike source origins", () =>
    expect(() => vaPublicUrl(source + ".example/", source)).toThrow());
  it("retains contradictory middle and given names", () => {
    expect(
      vaPersonMatches(["Jane A Example", "Jane B Example"], "Jane A Example"),
    ).toBe(false);
    expect(vaPersonMatches(["Jane Example"], "John Example", ["Jane"])).toBe(
      false,
    );
  });
  it("reads the native Reports-for heading after a login heading", () => {
    const r = vaInventory(
      bytes(
        `<h2>Sign in</h2><h2 title="Reports for Synthetic Receiving (SYN-1)">Reports for Synthetic Receiving (SYN-1)</h2><div id="ScheduledReports"><a href="/Report/Index/1">Synthetic report</a></div><div id="LargeContributionReports"></div>`,
      ),
      "synthetic",
      source + "/Committee/Index/synthetic",
    );
    expect(r).toMatchObject({
      committeeName: "Synthetic Receiving",
      committeeCode: "SYN-1",
      scheduledReportIds: [1],
    });
  });
  it("rejects duplicate inventory report links", () =>
    expect(() =>
      vaInventory(
        bytes(
          `<h2>Reports for Synthetic (SYN)</h2><div id="ScheduledReports"><a href="/Report/Index/1">One</a><a href="/Report/Index/1">Again</a></div><div id="LargeContributionReports"></div>`,
        ),
        "synthetic",
        source,
      ),
    ).toThrow(/inventory_complete_reports/));
  it("recognizes padded no-result rows only through declared native count", () => {
    const url = source + "/?CommitteeName=Synthetic&CommitteeType=";
    const page = `<input id="CommitteeName" value="Synthetic"><select id="CommitteeType"><option value="" selected>Any</option></select><p>0 Records</p> <table id="CommitteeResults"><tbody><tr><td>No result for Synthetic</td></tr><tr><td></td></tr></tbody></table>`;
    expect(vaRegistrations(bytes(page), url)).toEqual([]);
    expect(() =>
      vaRegistrations(bytes(page.replace("0 Records", "1 Records")), url),
    ).toThrow(/registry_incomplete_page/);
    expect(() =>
      vaRegistrations(
        bytes(page.replace('value="Synthetic"', 'value="Different"')),
        url,
      ),
    ).toThrow(/registry_query_echo/);
  });
  it("validates complete A/B counts and signed amounts", () => {
    expect(vaReport(bytes(xml())).rows[0]?.cents).toBe(-125);
    expect(() =>
      vaReport(bytes(xml().replace("<ScheduleACount>1", "<ScheduleACount>2"))),
    ).toThrow(/native_itemized_controls/);
  });
  it("holds unknown amendments and malformed items", () => {
    expect(() =>
      vaReport(bytes(xml().replace("<IsAmendment>false", "<IsAmendment>true"))),
    ).toThrow(/unqualified_amendment_family/);
    expect(() =>
      vaReport(
        bytes(xml().replace('IsIndividual="false"', 'IsIndividual="unknown"')),
      ),
    ).toThrow(/explicit_contributor_type/);
    expect(() =>
      vaReport(
        bytes(
          xml().replace("<ScheduleB/>", "<ScheduleB><Unknown/></ScheduleB>"),
        ),
      ),
    ).toThrow(/unrecognized_schedule_item/);
  });
  it("partitions covered rapid occurrences and excludes future cycles", () => {
    const next = { ...receipt, signature: "synthetic-two", day: "2026-01-04" };
    const rows = vaPartitionReports(
      [
        report(),
        report({ rapid: true }),
        report({ rapid: true, rows: [next] }),
        report({ year: 2027 }),
      ],
      2026,
    );
    expect(rows).toEqual([receipt, next]);
  });
  it("does not reuse a scheduled occurrence for two rapid reports", () =>
    expect(() =>
      vaPartitionReports(
        [report(), report({ rapid: true }), report({ rapid: true })],
        2026,
      ),
    ).toThrow(/covered_rapid_occurrence_mismatch/));
  it("holds overlapping periods and uncovered gaps", () => {
    expect(() => vaPartitionReports([report(), report()], 2026)).toThrow(
      /overlapping_scheduled_periods/,
    );
    expect(() =>
      vaPartitionReports(
        [report({ start: "2026-01-03", rows: [] }), report({ rapid: true })],
        2026,
      ),
    ).toThrow(/rapid_in_uncovered_gap/);
  });
  it("holds ambiguous post-close duplicates", () => {
    const r = report({
      rapid: true,
      rows: [{ ...receipt, day: "2026-01-04" }],
    });
    expect(() => vaPartitionReports([report(), r, r], 2026)).toThrow(
      /ambiguous_uncovered_rapid_duplicate/,
    );
  });
  it("requires unique PAC class plus dated full postal corroboration", () => {
    const reg = {
      id: "synthetic",
      name: "Synthetic PAC",
      type: "Political Action Committee",
      candidate: "",
      url: source,
    };
    const h = {
      name: receipt.name,
      address: receipt.address,
      filed: "2026-01-01",
    };
    expect(vaPacIdentity(receipt, [reg], [h])).toBe(true);
    for (const type of [
      "Candidate Campaign Committee",
      "Political Party Committee",
      "Out of State Political Committee",
    ])
      expect(vaPacIdentity(receipt, [{ ...reg, type }], [h])).toBe(false);
    expect(vaPacIdentity(receipt, [reg, reg], [h])).toBe(false);
    expect(vaPacIdentity(receipt, [reg], [{ ...h, filed: "2026-01-03" }])).toBe(
      false,
    );
    expect(
      vaPacIdentity(
        receipt,
        [reg],
        [{ ...h, address: ["Different", ...h.address.slice(1)] }],
      ),
    ).toBe(false);
    expect(vaPacIdentity({ ...receipt, individual: true }, [reg], [h])).toBe(
      false,
    );
  });
  it("uses the published economic spender column", () => {
    const headers = [
      "Expenditure Date",
      "Status Date",
      "Funds Expended By",
      "Description of Expenditure",
      "Expenditure Amount",
      "",
    ];
    const p = vaIeIndex(
      bytes(
        `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody><tr><td>1/2/2026</td><td>1/3/2026</td><td>Synthetic Economic Spender</td><td>Example</td><td>$1.00</td><td><a href="/IE/Details/synthetic">View</a></td></tr></tbody></table>`,
      ),
      source + "/IE",
    );
    expect(p[0]?.spender).toBe(parent.spender);
  });
  it("closes parent money and exact rational percentages", () => {
    const p = vaIeDetail(ie(), parent);
    expect(vaAllocatedCents(100, p.targets[0]!)).toBe(100);
    expect(() => vaIeDetail(ie("99"), parent)).toThrow(/ie_percentage_closure/);
    expect(() => vaIeDetail(ie("100", "2.00"), parent)).toThrow(
      /ie_parent_money_closure/,
    );
    expect(() =>
      vaIeDetail(ie("100", "1.00", target("100", "Unstated")), parent),
    ).toThrow(/ie_explicit_stance_percent/);
  });
  it("does not round fractional-cent target allocations", () => {
    const p = vaIeDetail(
      ie("50", "1.00", target("50") + target("50", "Oppose")),
      parent,
    );
    expect(vaAllocatedCents(100, p.targets[0]!)).toBe(50);
    expect(() => vaAllocatedCents(101, p.targets[0]!)).toThrow(
      /fractional_cent_allocation/,
    );
  });
});

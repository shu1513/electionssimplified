import { describe, expect, it } from "vitest";
import {
  parseLosAngelesEthicsCandidateTotals,
  parseLosAngelesEthicsElectionIndex,
  parseLosAngelesIndependentSpendingRows,
} from "../../../src/pipeline/losAngelesCityFinance/losAngelesCityEthicsClient.js";

const metric = (amount: string): string =>
  `<td align="right"><table><tr><td></td><td align="right" style="border-top: 1px solid #666 !important;">$${amount}</td></tr></table></td>`;
const fixture = `<a name="S276"></a><h4><strong>Mayor:</strong></h4><table><tbody><tr><td><a name="C172"></a><a class="candidatelink"><strong>Karen Bass</strong></a></td><td align="right">05/27/26</td>${metric("3,214,043.01")}${metric("4,114,009.00")}${metric("278,667.52")}${metric("1,257,000.00")}${metric("2,553,259.88")}${metric("14,871.54")}${metric("145,512.00")}${metric("0.00")}</tr><tr class="C172_detail"><td><a href="?elec_seat_cand_id=1509&cmt_per_id=24713">contact</a></td></tr><tr class="C172_detail"><td>1471359 - Re-Elect Karen Bass for Mayor 2026</td></tr></tbody></table><a name="S277"></a>`;
const legacyFixture = `<a name="S241"></a><h4><strong>City Attorney:</strong></h4><table><tbody><tr><td><a name="C19897"></a><a class="candidatelink"><strong>Sherri Onica Cole</strong></a></td><td align="right">12/31/23</td><td align="right">$208,888.09</td><td align="right">$210,888.09</td><td align="right">$0.00</td><td align="right"><font>ACCEPTED</font></td><td align="right">$1,000.00</td><td align="right">$2,000.00</td><td align="right">$3,000.00</td><td align="right">$4,000.00</td></tr><tr class="C19897_detail"><td><a href="?elec_seat_cand_id=1297&cmt_per_id=19898">contact</a></td></tr><tr class="C19897_detail"><td>1437848 - SHERRI ONICA VALLE COLE FOR CITY ATTORNEY 2022</td></tr></tbody></table><a name="S242"></a>`;
const completedElectionFixture = `<a name="S260"></a><h4><strong>Council District 2:</strong></h4><table><tbody><tr><td><a name="C22889"></a><a class="candidatelink"><strong>Jon Paul Bird</strong></a></td><td align="right">12/31/25</td>${metric("100.00")}${metric("80.00")}${metric("20.00")}${metric("12,345")}${metric("N/A")}${metric("50.00")}${metric("40.00")}${metric("30.00")}${metric("20.00")}${metric("10.00")}</tr><tr class="C22889_detail"><td><a href="?elec_seat_cand_id=1441&cmt_per_id=22890">contact</a></td></tr><tr class="C22889_detail"><td>1459431 - BIRD FOR CITY COUNCIL 2024</td></tr></tbody></table><a name="S261"></a>`;
const completedLegacyFixture = `<a name="S260"></a><h4><strong>Council District 2:</strong></h4><table><tbody><tr><td><a name="C22889"></a><a class="candidatelink"><strong>Jon Paul Bird</strong></a></td><td align="right">12/31/25</td><td align="right">$100.00</td><td align="right">$80.00</td><td align="right">$20.00</td><td align="right">12,345</td><td align="right">N/A</td><td align="right">$50.00</td><td align="right">$40.00</td><td align="right">$30.00</td><td align="right">$20.00</td><td align="right">$10.00</td></tr><tr class="C22889_detail"><td><a href="?elec_seat_cand_id=1441&cmt_per_id=22890">contact</a></td></tr><tr class="C22889_detail"><td>1459431 - BIRD FOR CITY COUNCIL 2024</td></tr></tbody></table><a name="S261"></a>`;
const lausdFixture = `<a name="S289"></a><h4><strong>LAUSD District 6:</strong></h4><table><tbody><tr><td><a name="C13549"></a><a class="candidatelink"><strong>Kelly Gonez</strong></a></td><td align="right">05/27/26</td>${metric("133,539.00")}${metric("106,177.85")}${metric("23,311.15")}${metric("41,774.84")}${metric("0.00")}${metric("0.00")}${metric("0.00")}</tr><tr class="C13549_detail"><td><a href="?elec_seat_cand_id=1541&cmt_per_id=25917">contact</a></td></tr><tr class="C13549_detail"><td>1482173 - Kelly Gonez for School Board 2026</td></tr></tbody></table><a name="S290"></a>`;
const completedLausdFixture = `<a name="S267"></a><h4><strong>LAUSD District 1:</strong></h4><table><tbody><tr><td><a name="C10001"></a><a class="candidatelink"><strong>Jordan Lee</strong></a></td><td align="right">12/31/25</td>${metric("100.00")}${metric("80.00")}${metric("20.00")}${metric("12,345")}${metric("N/A")}${metric("50.00")}${metric("40.00")}${metric("30.00")}${metric("10.00")}</tr><tr class="C10001_detail"><td><a href="?elec_seat_cand_id=1601&cmt_per_id=10002">contact</a></td></tr><tr class="C10001_detail"><td>1480001 - JORDAN LEE FOR SCHOOL BOARD 2024</td></tr></tbody></table><a name="S268"></a>`;

describe("Los Angeles Ethics parsers", () => {
  it("parses election index", () =>
    expect(
      parseLosAngelesEthicsElectionIndex(
        '<select name="election_id"><option value="76">2026 City and LAUSD Elections</option></select>',
      ),
    ).toEqual([
      {
        electionId: "76",
        description: "2026 City and LAUSD Elections",
        electionYear: 2026,
      },
    ]));
  it("keeps independent and membership totals separate", () => {
    const [candidate] = parseLosAngelesEthicsCandidateTotals({
      html: fixture,
      electionId: "76",
      officeName: "Mayor",
    });
    expect(candidate).toMatchObject({
      candidatePersonId: "172",
      electionSeatCandidateId: "1509",
      fppcCommitteeId: "1471359",
      internalCommitteePersonId: "24713",
      totalContributions: 3214043.01,
      outsideSupportTotal: 2553259.88,
      membershipSupportTotal: 145512,
    });
  });
  it("parses and validates independent-spending JSON", () => {
    expect(
      parseLosAngelesIndependentSpendingRows(
        {
          data: [
            {
              ie_id: 9,
              filer_name: "People PAC",
              ind_spender: "People PAC [1491022] <br>Los Angeles",
              cand_fname: "Karen",
              cand_lname: "Bass",
              ofc_desc: "Mayor",
              support_oppose: "Supporting ",
              ie_amt_xl: 125.5,
              form496_document_id: 44,
            },
          ],
        },
        "support",
      )[0],
    ).toMatchObject({
      spenderId: "1491022",
      amount: 125.5,
      supportOppose: "support",
    });
  });
  it("skips a malformed candidate without fabricating totals", () =>
    expect(
      parseLosAngelesEthicsCandidateTotals({
        html: fixture.replace(metric("0.00"), ""),
        electionId: "76",
        officeName: "Mayor",
      }),
    ).toEqual([]));
  it("does not treat an empty metric cell as a reported zero", () =>
    expect(
      parseLosAngelesEthicsCandidateTotals({
        html: fixture.replace(metric("0.00"), metric("")),
        electionId: "76",
        officeName: "Mayor",
      }),
    ).toEqual([]));
  it("parses legacy direct metric cells without fabricating matching funds", () => {
    const [candidate] = parseLosAngelesEthicsCandidateTotals({
      html: legacyFixture,
      electionId: "64",
      officeName: "City Attorney",
    });
    expect(candidate).toMatchObject({
      candidateName: "Sherri Onica Cole",
      candidatePersonId: "19897",
      electionSeatCandidateId: "1297",
      fppcCommitteeId: "1437848",
      totalContributions: 208888.09,
      matchingFunds: null,
      outsideSupportTotal: 1000,
      membershipOpposeTotal: 4000,
    });
  });
  it("ignores votes and cost-per-vote columns on completed elections", () => {
    for (const html of [completedElectionFixture, completedLegacyFixture]) {
      const [candidate] = parseLosAngelesEthicsCandidateTotals({
        html,
        electionId: "70",
        officeName: "Council District 2",
      });
      expect(candidate).toMatchObject({
        candidateName: "Jon Paul Bird",
        totalContributions: 100,
        totalExpenditures: 80,
        cashOnHand: 20,
        matchingFunds: 50,
        outsideSupportTotal: 40,
        outsideOpposeTotal: 30,
        membershipSupportTotal: 20,
        membershipOpposeTotal: 10,
      });
    }
  });
  it("parses LAUSD rows that omit the matching-funds column", () => {
    const [candidate] = parseLosAngelesEthicsCandidateTotals({
      html: lausdFixture,
      electionId: "76",
      officeName: "LAUSD District 6",
    });
    expect(candidate).toMatchObject({
      candidateName: "Kelly Gonez",
      electionSeatCandidateId: "1541",
      fppcCommitteeId: "1482173",
      totalContributions: 133539,
      matchingFunds: null,
      outsideSupportTotal: 41774.84,
      membershipOpposeTotal: 0,
    });
  });
  it("ignores vote columns on completed LAUSD rows", () => {
    const [candidate] = parseLosAngelesEthicsCandidateTotals({
      html: completedLausdFixture,
      electionId: "70",
      officeName: "LAUSD District 1",
    });
    expect(candidate).toMatchObject({
      totalContributions: 100,
      totalExpenditures: 80,
      cashOnHand: 20,
      matchingFunds: null,
      outsideSupportTotal: 50,
      outsideOpposeTotal: 40,
      membershipSupportTotal: 30,
      membershipOpposeTotal: 10,
    });
  });
});

const sourceCalendar = '<table><tr><td><strong>Primary Election:</strong></td><td>June 02, 2026</td></tr><tr><td><strong>General Election:</strong></td><td>November 03, 2026</td></tr></table>';
const pairedFixture = sourceCalendar + fixture.replace("1471359 - Re-Elect", "<span>Primary</span>1471359 - Re-Elect").replace("</tbody>", '<tr class="C172_detail"><td><span>General</span>1480000 - Example General Committee</td></tr></tbody>');
it("retains an explicitly paired receiving scope under one source candidate and target", () => {
 const [row] = parseLosAngelesEthicsCandidateTotals({html:pairedFixture,electionId:"76",officeName:"Mayor"});
 expect(row?.fppcCommitteeIds).toEqual(["1471359","1480000"]); expect(row?.fppcCommitteeId).toBe("1471359");
});
it.each(["phase","target","ownership","third"])("holds an unqualified multiple-committee %s shape", kind => {
 let html=pairedFixture;
 if(kind==="phase")html=html.replace("General Election:","Other Election:");
 if(kind==="target")html=html.replace("<span>General",'<a href="?elec_seat_cand_id=1510">other</a><span>General');
 if(kind==="ownership")html=html.replace('<tr class="C172_detail"><td><span>General','<tr class="C999_detail"><td><span>General');
 if(kind==="third")html=html.replace("</tbody>",'<tr class="C172_detail"><td>1490000 - Third Committee</td></tr></tbody>');
 expect(parseLosAngelesEthicsCandidateTotals({html,electionId:"76",officeName:"Mayor"})).toEqual([]);
});

it("keeps a stable sorted anchor without attributing another account's internal contact id", () => {
 const html=pairedFixture.replace("1471359 - Re-Elect","1490000 - Re-Elect");
 const [row]=parseLosAngelesEthicsCandidateTotals({html,electionId:"76",officeName:"Mayor"});
 expect(row?.fppcCommitteeIds).toEqual(["1480000","1490000"]);expect(row?.committeeName).toBe("Example General Committee");expect(row?.internalCommitteePersonId).toBeNull();
});

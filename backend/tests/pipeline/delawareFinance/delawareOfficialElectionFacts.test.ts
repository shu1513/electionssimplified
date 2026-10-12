import { describe, expect, it } from "vitest";
import { parseDelawareOfficialGeneralBallot as ballot, parseDelawareOfficialStatewideGeneralResult as result }
  from "../../../src/pipeline/delawareFinance/delawareOfficialElectionFacts.js";

const columns = ["Candidate Name", "Party Name", "Machine Votes", "Absentee Votes", "Early Voting Votes", "Total Votes", "Percentage"];
function row(name: string, party: string, values: string[]) {
  return `<tr>${[name, party, ...values].map((value, index) => `<td data-label="${columns[index]}">${value}</td>`).join("")}</tr>`;
}
const table = `<table><thead><tr>${columns.map(value => `<th>${value}</th>`).join("")}</tr></thead><tbody>` +
  row("KATHY JENNINGS", "Democratic Party", ["122,087", "16,162", "33,588", "171,837", "53.83"]) +
  row("OTHER CANDIDATE", "Republican Party", ["119,946", "6,256", "21,167", "147,369", "46.17"]) + "</tbody></table>";
const election = `<h1>2022 General Election Report</h1><h2 class="electionDate">November 8th 2022</h2>` +
  `<span class="resultsType"><span>OFFICIAL RESULTS</span></span>` +
  `<div id="statewide"><h3>Attorney General</h3>${table}</div>` +
  `<div id="district"><h3>Attorney General</h3>${table.replace(/KATHY JENNINGS/g, "DISTRICT CANDIDATE")}</div>`;
const ballotTable = `<table><thead><tr><th>Race</th><th>Instruction</th><th>Democratic Party</th><th>Republican Party</th><th>Write-in</th></tr></thead>` +
  `<tbody><tr><td data-label="Race">Attorney General</td><td data-label="Instruction">Vote for 1</td>` +
  `<td data-label="Democratic Party">KATHY JENNINGS</td><td data-label="Republican Party">OTHER CANDIDATE</td>` +
  `<td data-label="Write-in">Write-in</td></tr></tbody></table>`;
const sample = `<h1>Sample Ballot</h1><ul><li>November 3, 2026 General Election</li></ul>${ballotTable}`;
const parseResult = (html = election) => result({ bytes: Buffer.from(html), electionYear: 2022, officeName: "Attorney General" });
const parseBallot = (html = sample) => ballot({ bytes: Buffer.from(html), electionYear: 2026, officeName: "Attorney General" });

describe("Delaware official election facts", () => {
  it("extracts the complete statewide single-seat outcome instead of district tables", () => {
    const facts = parseResult();
    expect(facts.candidates).toHaveLength(2);
    expect(facts.winner).toMatchObject({ candidateName: "KATHY JENNINGS", party: "Democratic Party", totalVotes: 171837 });
    expect(facts.electionDate).toBe("2022-11-08");
    expect(facts.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect("campaignWindow" in facts).toBe(false);
  });
  it.each([
    ["unofficial", election.replace("OFFICIAL RESULTS", "UNOFFICIAL RESULTS")],
    ["missing statewide", election.replace('id="statewide"', 'id="county"')],
    ["duplicate contest", election.replace('</div><div id="district">', `<h3>Attorney General</h3>${table}</div><div id="district">`)],
    ["false total", election.replaceAll("171,837", "171,836")],
    ["shifted column", election.replace('data-label="Machine Votes"', 'data-label="Total Votes"')],
    ["wrong year", election.replace("November 8th 2022", "November 8th 2024")],
    ["tied plurality", election.replaceAll("119,946", "122,087").replaceAll("6,256", "16,162").replaceAll("21,167", "33,588").replaceAll("147,369", "171,837")],
  ])("rejects %s result authority", (_label, html) => {
    expect(() => parseResult(html)).toThrow();
  });
  it("reads the displayed official label without commented icon fallback text", () => {
    expect(parseResult(election.replace("OFFICIAL RESULTS", '<svg><path d="M1 2"></path></svg><!-- <i>fallback</i> Font Awesome -->OFFICIAL RESULTS')).winner.totalVotes).toBe(171837);
  });
  it("extracts exact ballot party cells and the actual general-election date", () => {
    const facts = parseBallot();
    expect(facts.candidates[0]).toEqual({ party: "Democratic Party", candidateName: "KATHY JENNINGS" });
    expect(facts.electionDate).toBe("2026-11-03");
    expect("incumbent" in facts).toBe(false);
  });
  it("does not declare a plurality winner for an unsupported multi-seat office", () => {
    expect(() => result({ bytes: Buffer.from(election.replaceAll("Attorney General", "Council At Large")),
      electionYear: 2022, officeName: "Council At Large" })).toThrow(/unsupported statewide single-seat office/);
  });
  it.each([
    ["wrong date year", sample.replace("2026 General", "2024 General")],
    ["duplicate contest", sample + ballotTable],
    ["party column shifted", sample.replace('data-label="Democratic Party"', 'data-label="Republican Party"')],
    ["multiple seats", sample.replace("Vote for 1", "Vote for 2")],
  ])("rejects %s ballot authority", (_label, html) => {
    expect(() => parseBallot(html)).toThrow();
  });
});

import { WASHINGTON_REPORTED_PAC_CODE, type WashingtonPacScope } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacSource.js";
export const scope: WashingtonPacScope = { electionYear: 2026, filerId: "SYNTHETIC01", committeeId: "1000" };
export const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function receipt(id = "1", name = "Synthetic PAC", amount = "100.00", origin = "C3") {
  return { id, origin, report_number: "9000", committee_id: scope.committeeId, filer_id: scope.filerId,
    election_year: String(scope.electionYear), code: WASHINGTON_REPORTED_PAC_CODE, contributor_category: "Organization",
    contributor_name: name, amount, cash_or_in_kind: origin === "B.1" ? "In-kind" : "Cash", receipt_date: "2026-10-01T00:00:00.000" };
}
export function fixture() {
  const state = { rows: [receipt(), receipt("2", "Synthetic PAC", "50.00"), receipt("3", "Synthetic PAC", "-20.00", "C.1")],
    status: 200, summaryChanged: false, countChanged: false, mini: false, catalogChanged: false, summaryReads: 0, countReads: 0 };
  const requests: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); requests.push(url); const select = url.searchParams.get("$select")!;
    let rows: unknown[];
    if (url.pathname.includes("3h9x-7bvm")) {
      state.summaryReads++;
      rows = [{ id: "77", filer_id: scope.filerId, filer_type: "CA", committee_id: scope.committeeId, candidacy_id: "2000",
        filer_name: state.summaryChanged && state.summaryReads % 2 === 0 ? "Changed Synthetic" : "Synthetic Candidate",
        election_year: "2026", office: "STATE REPRESENTATIVE", legislative_district: "1", jurisdiction: "LEG DISTRICT 1",
        reporting_option: state.mini ? "mini" : "full", has_reports: true, active_candidate: true }];
    } else if (url.searchParams.has("$group")) {
      rows = [{ code: state.catalogChanged ? "Unknown new code" : WASHINGTON_REPORTED_PAC_CODE, contributor_category: "Organization", row_count: "10" }];
    } else if (select === "count(*) as row_count") {
      state.countReads++; rows = [{ row_count: String(state.rows.length + (state.countChanged && state.countReads % 2 === 0 ? 1 : 0)) }];
    } else {
      const offset = Number(url.searchParams.get("$offset")), limit = Number(url.searchParams.get("$limit"));
      rows = state.rows.slice(offset, offset + limit);
    }
    const response = new Response(state.status === 200 ? JSON.stringify(rows) : "native maintenance", {
      status: state.status, headers: { "content-type": state.status === 200 ? "application/json" : "text/plain" } });
    Object.defineProperty(response, "url", { value: url.href }); return response;
  }) as typeof fetch;
  return { state, requests, fetchImpl };
}

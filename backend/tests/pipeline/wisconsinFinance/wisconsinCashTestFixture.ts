import { vi } from "vitest";
import type { WisconsinCashContext } from "../../../src/pipeline/wisconsinFinance/wisconsinCommitteeCashSource.js";
type Row = Record<string, any>;
export const context: WisconsinCashContext = {
  candidateId: "00000000-0000-4000-8000-000000000001", electionId: "00000000-0000-4000-8000-000000000002",
  candidateName: "Alex Example", candidateLastName: "Example", electionYear: 2026, electionDate: "2026-11-03",
  officeScope: "statewide", officeName: "State Treasurer", district: null,
};
export function receiver(): Row {
  return { id: 10, committeeType: { name: "State Candidate" }, committeeStatus: { name: "Approved" },
    entity: { id: 11, name: "Example for Treasurer" },
    entityConnections: [{ connectionType: { isCandidate: false }, entity: { name: "Treasurer Person" } }, { connectionType: { isCandidate: true }, entity: { name: "Example, Alex" } }],
    eventConnections: [{ event: { date: "2026-11-03T00:00:00.000Z" }, office: { name: "State Treasurer" }, branch: null, district: null }],
  };
}
export const entity = (id: number, name: string, type = "COMMITTEE") => ({ id, name, entityType: { entityTypeOf: type } });
function category(id: number, code: string, type: number, flags: Row = {}): Row {
  return { id, code, transactionTypeId: type, isCashAdd: false, isCashRemove: false, isInKind: false, isDebtAdd: false, isDebtRemove: false,
    isOtherIncome: false, isTransactionReturn: false, isRedirection: false, ...flags };
}
export function source() {
  const r = receiver(), owner = entity(11, r.entity.name), pac = entity(77, "Example Labor PAC"), person = entity(88, "Example Individual", "PERSON");
  const dates = [["2025-01-01", "2025-06-30"], ["2025-07-01", "2025-12-31"], ["2026-01-01", "2026-06-30"], ["2026-07-01", "2026-07-27"], ["2026-07-28", "2026-09-23"]];
  const templates = dates.map(([start, end], i) => ({ id: i + 1, templateType: "PERIODIC", transactionsStartDate: `${start}T00:00:00.000Z`, transactionsEndDate: `${end}T23:59:59.999Z` }));
  const reports = templates.map(t => ({ id: 100 + t.id, latestSubmissionAt: "2026-10-01T00:00:00.000Z", reportTemplate: { id: t.id },
    committee: { entity: { id: 11 } }, reportSubmissions: [{ id: 200 + t.id }] }));
  const cats = [category(1, "MOC", 1, { isCashAdd: true }), category(2, "IK", 1, { isInKind: true }), category(3, "PL", 1, { isCashAdd: true, isDebtAdd: true }),
    category(4, "ER", 1, { isCashAdd: true, isOtherIncome: true }), category(5, "RTDC", 2, { isCashRemove: true, isTransactionReturn: true })];
  const transaction = (id: number, cat: number, amount: number, from: Row, to = owner): Row => ({
    id, date: "2026-09-01T00:00:00.000Z", amount, createdByEntityId: 11, createdByEntity: { id: 11 }, relatedPayer: null,
    from_entity: from, to_entity: to, fromOccupationTitle: null, transactionCategory: { id: cat }, transactionType: { id: cat === 5 ? 2 : 1 }, reports: [{ id: 105 }],
  });
  const ledger = [transaction(1, 1, 1000, pac), transaction(2, 1, 500, person), transaction(3, 2, 100, pac), transaction(4, 3, 200, person),
    transaction(5, 4, 30, person), transaction(6, 5, 50, owner, pac)];
  const fixture = { r, templates, reports, cats, ledger, donorClass: "PAC", registered: true, countDelta: 0, profileType: "Unregistered", parentCounts: {} as Record<number, number>, onRequest: undefined as undefined | (() => void) };
  const response = (payload: unknown) => new Response(JSON.stringify([{ result: { data: { json: payload } } }]), { headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (raw: any) => {
    fixture.onRequest?.();
    const url = new URL(String(raw));
    if (url.pathname === "/browse-data/registrant/77") return new Response(`<h1>Example Labor PAC</h1><div><p>Registrant Type</p><p>${fixture.profileType}</p></div>`, { headers: { "content-type": "text/html" } });
    const proc = url.pathname.split("/").at(-1), input = JSON.parse(url.searchParams.get("input")!)["0"].json;
    if (proc === "transactionMeta.getTransactionCategories") return response(fixture.cats);
    if (proc === "reportMeta.getReportTemplates") return response(fixture.templates.filter(t => input.specificIds.includes(t.id)));
    if (proc === "publicFrontendApi.getReportSubmissionsData") return response([{ id: input.reportId + 100, reportId: input.reportId, certified: true,
      _count: { transactions: (fixture.parentCounts[input.reportId] ?? (input.reportId === 105 ? fixture.ledger.length : 0)) + (input.reportId === 105 ? fixture.countDelta : 0) } }]);
    let data: Row[];
    if (proc?.startsWith("publicFrontendApi.getCommittees")) data = input.searchTerm === "Example" ? [fixture.r]
      : input.searchTerm === "Refund Only Party" ? [{ id: 90, entity: { id: 99, name: "Refund Only Party" }, committeeType: { name: "Political Party" } }]
      : fixture.registered ? [{ id: 70, entity: { id: 77, name: "Example Labor PAC" }, committeeType: { name: fixture.donorClass } }] : [];
    else if (proc?.startsWith("publicFrontendApi.getReports")) data = fixture.reports;
    else if (proc?.startsWith("publicFrontendApi.getTransactions")) data = fixture.ledger;
    else throw new Error("unexpected public request");
    if (proc?.endsWith("Count")) return response(data.length);
    const result = input.cursor ? [] : data, last = result.at(-1);
    return response({ results: result, nextCursor: last ? { id: last.id, ...(proc === "publicFrontendApi.getTransactions" ? { date: last.date } : {}) } : null });
  }) as unknown as typeof fetch;
  return { fixture, fetchImpl };
}

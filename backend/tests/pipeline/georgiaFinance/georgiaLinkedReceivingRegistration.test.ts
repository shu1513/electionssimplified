import { describe, expect, it } from "vitest";
import { createGeorgiaEthicsTransport, GeorgiaEthicsClientError,
  type GeorgiaCandidateIndexRow } from "../../../src/pipeline/georgiaFinance/georgiaEthicsClient.js";
import { fetchGeorgiaLinkedReceivingRegistration, selectGeorgiaLinkedReceivingRegistration }
  from "../../../src/pipeline/georgiaFinance/georgiaLinkedReceivingRegistration.js";

function index(overrides: Partial<GeorgiaCandidateIndexRow> = {}): GeorgiaCandidateIndexRow {
  return { filerEntityId: 10, filerRegistrationId: 1, guid: "11111111-1111-4111-8111-111111111111",
    filerName: "Example Candidate", committeeName: "Example Campaign", candidateFirstName: "Example",
    candidateMiddleName: null, candidateLastName: "Candidate", ballotFullName: "Example Candidate", office: "Senate",
    districtName: "1", filerStatusCode: "ACT", filingCycleName: "2026 Candidate/Committee Filing Cycle",
    electionCycleName: null, totalContributions: null, totalExpenditures: null, cashOnHand: null, ...overrides };
}
describe("Georgia linked receiving registration independent of direct money", () => {
  it("selects only exact receiving entity and native cycle without direct totals", () => {
    expect(selectGeorgiaLinkedReceivingRegistration({ committeeId: "10", electionYear: 2026,
      rows: [index({ filingCycleName: "2022 Candidate/Committee Filing Cycle" }), index()] }))
      .toMatchObject({ status: "qualified", context: { receivingCommitteeId: "10",
        registrationGuid: "11111111-1111-4111-8111-111111111111" } });
  });
  it("accepts the existing election-cycle label alternative", () => {
    expect(selectGeorgiaLinkedReceivingRegistration({ committeeId: "10", electionYear: 2026,
      rows: [index({ filingCycleName: null, electionCycleName: "2026 Georgia State Election" })] }))
      .toMatchObject({ status: "qualified" });
  });
  it("holds ambiguous current registrations, missing identity and invalid native registration", () => {
    for (const rows of [[], [index(), index()], [index({ guid: "" })], [index({ filerEntityId: 11 })]]) {
      expect(selectGeorgiaLinkedReceivingRegistration({ committeeId: "10", electionYear: 2026, rows }))
        .toMatchObject({ status: "held" });
    }
    expect(selectGeorgiaLinkedReceivingRegistration({ committeeId: "bad", electionYear: 2026, rows: [index()] }))
      .toMatchObject({ status: "held", reason: "invalid_receiving_identity" });
  });
  it("fetches only the receiving index, with no direct reports/transactions or funders", async () => {
    const urls: string[] = [];
    const transport = createGeorgiaEthicsTransport({ sleep: async () => {}, fetch: async url => {
      urls.push(url); return { status: 200, body: JSON.stringify({ succeeded: true, error: null, data: { items: [index()] } }) };
    } });
    expect(await fetchGeorgiaLinkedReceivingRegistration({ transport, candidateName: "Example Candidate",
      committeeId: "10", electionYear: 2026 })).toMatchObject({ status: "qualified" });
    expect(urls).toEqual(["https://api-peachfile.ethics.ga.gov/api/PublicFilerDetails/GetCandidateDetails"]);
  });
  it("separates expected unavailable sources from programming failures", async () => {
    const input = { candidateName: "Example Candidate", committeeId: "10", electionYear: 2026 };
    expect(await fetchGeorgiaLinkedReceivingRegistration({ ...input, transport: { postJson: async () => {
      throw new GeorgiaEthicsClientError("http_error", "unavailable");
    } } })).toMatchObject({ status: "unavailable", reason: "receiving_index_unavailable" });
    await expect(fetchGeorgiaLinkedReceivingRegistration({ ...input, transport: { postJson: async () => {
      throw new TypeError("programming failure");
    } } })).rejects.toThrow("programming failure");
  });
});

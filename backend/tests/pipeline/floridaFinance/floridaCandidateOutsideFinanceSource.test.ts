import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFloridaCandidateOutsideFinanceSource } from "../../../src/pipeline/floridaFinance/floridaCandidateOutsideFinanceSource.js";
import { FLORIDA_EXPENDITURE_DISCOVERY_HEADERS } from "../../../src/pipeline/floridaFinance/floridaIndependentExpenditureDiscovery.js";
const row = { candidate_id: "candidate", candidate_election_id: "candidate-election", election_id: "election", candidate_name: "Adam Botana",
  candidate_status: "qualified", election_date: "2026-11-03", election_stage: "general", race_type: "office", state: "FL",
  office_scope: "state_lower", office_canonical_name: "State Lower Chamber Legislator", district_type: "state_lower", geoid_compact: "12080",
  committee_id: "BOTANA_ADAM_REP_STR", committee_name: "Botana, Adam (REP)(STR)", election_year: 2026 };
const input = { candidateId: row.candidate_id, electionId: row.election_id, committeeId: row.committee_id };
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function source(query: ReturnType<typeof vi.fn>) {
  const cacheDir = await mkdtemp(join(tmpdir(), "fl-outside-test-")); roots.push(cacheDir);
  return createFloridaCandidateOutsideFinanceSource({ db: { query }, cacheDir, minIntervalMs: 0 });
}
describe("Florida normal candidate outside source", () => {
  it("does not interpret empty discovery as a verified component or candidate zero", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.join("\t") + "\n", { headers: { "content-type": "text/tab-separated-values" } }));
    vi.stubGlobal("fetch", fetch);
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    const result = await (await source(query)).load(input);
    expect(result).toMatchObject({ status: "loaded", components: [] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][1].body)).toContain("cpurpose=TEXT+MESSAGES%3B+PRO-Adam+Botana");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([row.candidate_election_id, 2026]);
  });
  it("refreshes a previously accepted payer even when current discovery fails", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, req: RequestInit) => {
      requests.push(url);
      if (url.endsWith("expend.exe")) return new Response("Source failed", { status: 503 });
      const prefix = new URLSearchParams(String(req.body)).get("comName");
      return new Response(`<html><body>Search for Committee by Name<input name=ComName value="${prefix}"><font>** No records found for criteria</font></body></html>`, { headers: { "content-type": "text/html" } });
    });
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ payer_name: "Example Committee", payer_type: "PAC" }] });
    const result = await (await source(query)).load(input);
    expect(result).toMatchObject({ status: "loaded", components: [] });
    expect(requests.filter(url => url.endsWith("ComLkupByName.asp"))).toHaveLength(4);
    expect(result).not.toHaveProperty("supportCents");
  });
  it.each([{ election_stage: "primary" }, { candidate_status: "withdrawn" }])("does not acquire source for an ineligible actual local race %#", async change => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row, ...change }] });
    expect(await (await source(query)).load(input)).toMatchObject({ status: "preserve" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves an unavailable local database without contacting source", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await (await source(vi.fn().mockRejectedValue(new Error("local unavailable")))).load(input))
      .toMatchObject({ status: "preserve", diagnostics: ["local unavailable"] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

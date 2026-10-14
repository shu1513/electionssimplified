import { describe, expect, it, vi } from "vitest";
import { loadVermontCommitteeCashContext } from "../../../src/pipeline/vermontFinance/vermontCommitteeCashContext.js";

const local = {
  link_id: "link", candidate_name: "Phil Scott", election_year: 2026,
  filer_registration_guid: "receiver", entity_id: 33545, filer_name: "SCOTT, PHIL",
  link_office_name: "Governor", office_scope: "statewide", office_name: "Governor",
  election_date: "2026-11-03", election_stage: "general",
  district_type: "statewide", geoid_compact: "50",
};
const publicFetch = () => vi.fn().mockImplementation(async (url: unknown) => new Response(JSON.stringify({ succeeded: true, data: String(url).includes("GetElectionLookup") ? [
  { value: "45", name: "2026  Nov 03 - General Election" },
  { value: "54", name: "2026 Mixed Local & General" },
] : [{ value: "19", name: "Governor", code: "GOV" }] }))) as unknown as typeof fetch;

describe("Vermont canonical recipient context", () => {
  it("binds the actual local date/stage/account to live source election and office", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [local] }).mockResolvedValue({ rows: [] });
    const context = await loadVermontCommitteeCashContext({ db: { query } as never, candidateId: "candidate", electionId: "election", clientOptions: { fetchImpl: publicFetch() } });
    expect(context).toMatchObject({ sourceElectionId: 45, officeId: 19, entityId: 33545, electionDate: "2026-11-03", electionType: "general" });
    expect(query.mock.calls[0]?.[1]).toEqual(["candidate", "election"]);
  });

  it.each([{ rows: [] }, { rows: [local, local] }])("rejects absent or ambiguous active accounts", async ({ rows }) => {
    const fetchImpl = publicFetch();
    await expect(loadVermontCommitteeCashContext({ db: { query: vi.fn().mockResolvedValue({ rows }) } as never, candidateId: "candidate", electionId: "election", clientOptions: { fetchImpl } })).rejects.toThrow("one active canonical receiving account");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { office_scope: "state_upper", office_name: "State Senator", link_office_name: "State Senator" },
    { link_office_name: "Attorney General" },
    { election_year: 2025 },
    { election_stage: "special" },
    { entity_id: null },
    { filer_registration_guid: "" },
    { geoid_compact: "51" },
    { district_type: "state_lower" },
  ])("preserves unsupported/conflicting receiving context", async (patch) => {
    const fetchImpl = publicFetch();
    await expect(loadVermontCommitteeCashContext({ db: { query: vi.fn().mockResolvedValue({ rows: [{ ...local, ...patch }] }) } as never, candidateId: "candidate", electionId: "election", clientOptions: { fetchImpl } })).rejects.toThrow("unsupported or conflicting");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not borrow the General source cycle for a Primary link", async () => {
    await expect(loadVermontCommitteeCashContext({ db: { query: vi.fn().mockResolvedValue({ rows: [{ ...local, election_date: "2026-08-11", election_stage: "primary" }] }) } as never, candidateId: "candidate", electionId: "election", clientOptions: { fetchImpl: publicFetch() } })).rejects.toThrow("0 exact date/type matches");
  });

  it("preserves failed native office/election lookup instead of assuming mappings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("blocked", { status: 403 })) as unknown as typeof fetch;
    await expect(loadVermontCommitteeCashContext({ db: { query: vi.fn().mockResolvedValueOnce({ rows: [local] }).mockResolvedValue({ rows: [] }) } as never, candidateId: "candidate", electionId: "election", clientOptions: { fetchImpl } })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a competing General owner before source calls", async () => {
    const fetchImpl = publicFetch();
    const query = vi.fn().mockResolvedValueOnce({ rows: [local] }).mockResolvedValueOnce({ rows: [{ id: "other" }] });
    await expect(loadVermontCommitteeCashContext({ db: { query } as never, candidateId: "candidate", electionId: "election", clientOptions: { fetchImpl } })).rejects.toThrow("competing General owners");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredHawaiiReportedComponent, attachHawaiiReportedFinance, hawaiiReportedInterests } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedReader.js";
import { HI_REPORTED_REVISION } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedCore.js";
import { isHawaiiIndependentIeEnabled, isHawaiiReportedCommitteeEnabled, isHawaiiReportedRawRefreshEnabled } from "../../../src/config/featureFlags.js";
import type { HawaiiReportedReceiver } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedReceiver.js";
const receiver = { candidateId: "synthetic-candidate", electionId: "synthetic-election", electionYear: 2026, linkId: "synthetic-link", entityId: "synthetic-receiver" } as HawaiiReportedReceiver;
const clock = "2026-10-18T00:00:00.000Z";
const fixture = () => ({ candidate_id: receiver.candidateId, election_id: receiver.electionId, election_year: 2026, component: "committee", receiver_context: { ...receiver },
  source_observed_at: clock, last_synced_at: clock, source_facts: { revision: HI_REPORTED_REVISION, kind: "committee", electionYear: 2026, sourceAt: clock,
    acquisitionStartedAt: clock, capturedAt: clock, publisherUpdatedAt: clock, profileAt: clock, sourceHash: "a".repeat(64), profileHash: "b".repeat(64),
    sourceRows: 60, parentCount: 0, nativeVersions: 0, supersededVersions: 0, windowStart: null, windowEnd: "2026-11-03", nativeLedgerCents: 6000 },
  aggregation_controls: { totalCents: 6000, supportCents: 0, opposeCents: 0, sourceRows: 60, includedRows: 60 } });
const groups = () => Array.from({ length: 60 }, (_, i) => ({ candidate_id: receiver.candidateId, election_id: receiver.electionId, election_year: 2026, component: "committee",
  group_key: JSON.stringify(["Noncandidate Committee", "declared_noncandidate", `SYNTHETIC PAC ${i}`]), reported_name: `Synthetic PAC ${i}`,
  source_class: "Noncandidate Committee", evidence: "declared_noncandidate", stance: "direct", amount_cents: "100", occurrence_count: 1 }));
afterEach(() => vi.unstubAllEnvs());
describe("Hawaii complete stored observations", () => {
  it("retains qualified IE when a direct link is later added, but still vetoes a changed canonical seat", () => {
    const old = { ...receiver, linkId: null, entityId: null }, current = { ...receiver, linkId: "new-link", entityId: "new-direct-receiver" };
    const row: any = { ...fixture(), component: "ie", receiver_context: old,
      source_facts: { ...fixture().source_facts, kind: "ie", parentCount: 1, nativeVersions: 1, windowStart: "2024-11-06", nativeLedgerCents: null },
      aggregation_controls: { ...fixture().aggregation_controls, supportCents: 6000 } };
    const g = groups().map((g, i) => ({ ...g, component: "ie", group_key: JSON.stringify([`SYNTHETIC SPENDER ${i}`, "support"]),
      reported_name: `Synthetic Spender ${i}`, source_class: "reported independent spender", evidence: "native_closed_b2", stance: "support" }));
    expect(readStoredHawaiiReportedComponent(row, g, current).supportCents).toBe(6000);
    expect(() => readStoredHawaiiReportedComponent(row, g, { ...current, canonicalDistrict: "98" })).toThrow("stored_receiver_context");
  });
  it("validates all 60 groups, then uses full sums before display caps", () => {
    const a = readStoredHawaiiReportedComponent(fixture(), groups(), receiver); expect(a.groups).toHaveLength(60);
    const display = hawaiiReportedInterests(a.groups); expect(display).toHaveLength(1); expect(display[0]?.amount).toBe(60); expect(display[0]?.pac_count).toBe(60); expect(display[0]?.pacs).toHaveLength(5);
  });
  it.each(["missing final group", "late corrupted cents", "duplicate key", "wrong context", "source clock mismatch", "future sync", "bad source hash", "wrong receipt count", "unclosed native ledger", "contradictory class evidence"])("holds %s", kind => {
    const row = fixture(), g = groups();
    if (kind === "missing final group") g.pop();
    if (kind === "late corrupted cents") g[59]!.amount_cents = "101";
    if (kind === "duplicate key") g[59]!.group_key = g[0]!.group_key;
    if (kind === "wrong context") row.receiver_context.candidateId = "other";
    if (kind === "source clock mismatch") row.source_observed_at = "2026-10-17T00:00:00.000Z";
    if (kind === "future sync") row.last_synced_at = "2099-01-01T00:00:00.000Z";
    if (kind === "bad source hash") row.source_facts.sourceHash = "";
    if (kind === "wrong receipt count") row.source_facts.sourceRows = 59;
    if (kind === "unclosed native ledger") row.source_facts.nativeLedgerCents = 5999;
    if (kind === "contradictory class evidence") { g[59]!.evidence = "declared_party"; g[59]!.group_key = JSON.stringify([g[59]!.source_class, g[59]!.evidence, g[59]!.reported_name.toUpperCase()]); }
    expect(() => readStoredHawaiiReportedComponent(row, g, receiver)).toThrow();
  });
  it("disabled reader preserves the map without DB access", async () => {
    vi.stubEnv("HAWAII_CAMPAIGN_FINANCE_ENABLED", "false"); const query = vi.fn(), summaries = new Map();
    expect(await attachHawaiiReportedFinance({ db: { query }, requests: [{ candidate_id: "synthetic", election_id: "synthetic" } as any], summaries })).toBe(summaries); expect(query).not.toHaveBeenCalled();
  });
  it.each([isHawaiiIndependentIeEnabled, isHawaiiReportedCommitteeEnabled, isHawaiiReportedRawRefreshEnabled])("force never grants publication/acquisition", fn => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true"); vi.stubEnv("HAWAII_CAMPAIGN_FINANCE_ENABLED", "true");
    for (const k of ["HAWAII_INDEPENDENT_IE_ENABLED", "HAWAII_REPORTED_COMMITTEE_ENABLED", "HAWAII_REPORTED_RAW_REFRESH_ENABLED"]) vi.stubEnv(k, "false");
    expect((fn as any)(true)).toBe(false);
  });
});

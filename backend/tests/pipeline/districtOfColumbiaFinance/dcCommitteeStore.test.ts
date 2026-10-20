import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDcCommitteeComponent,
  validateDcCommitteeClosure,
  validateDcCommitteeStored,
  writeDcCommitteeComponent,
  type DcCommitteeGroup,
} from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeStore.js";
import { overlayDcCommitteeComponent } from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeReader.js";
import { loadDistrictOfColumbiaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaBallotLookupFinanceLoader.js";
import { getDcCommitteeSource } from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeSource.js";
import {
  receiver,
  syntheticNative,
  syntheticTransport,
} from "./dcCommitteeSynthetic.js";
const roots: string[] = [];
async function source() {
  const cacheDir = await fs.mkdtemp(join(tmpdir(), "dc-synthetic-"));
  await fs.chmod(cacheDir, 0o700);
  roots.push(cacheDir);
  return getDcCommitteeSource({
    year: 2026,
    cacheDir,
    transport: syntheticTransport().transport,
  });
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0))
    await fs.rm(r, { recursive: true, force: true });
});
describe("DC independent committee storage and uncapped reader", () => {
  it("rejects health DTOs and unverified monetary packets", () =>
    expect(() => buildDcCommitteeComponent(receiver, {} as never)).toThrow(
      /unverified_source/,
    ));
  it("includes party, PAC and authorized-committee gifts; excludes individuals", async () => {
    const v = buildDcCommitteeComponent(receiver, await source());
    expect(v.controls).toEqual({
      totalAmountCents: 2434,
      contributionCount: 3,
      sourceReceivingRows: 4,
      excludedRows: 1,
    });
    expect(v.groups).toHaveLength(3);
    expect(v.groups.map((g) => g.reportedName)).toContain("Synthetic Party");
  });
  it("does not publish negative current gifts or mismatched receiving keys", async () => {
    const data = syntheticNative();
    data.receipts[0]!.Amount = -12.34;
    const cacheDir = await fs.mkdtemp(join(tmpdir(), "dc-synthetic-"));
    await fs.chmod(cacheDir, 0o700);
    roots.push(cacheDir);
    const s = await getDcCommitteeSource({
      year: 2026,
      cacheDir,
      transport: syntheticTransport(data).transport,
    });
    expect(() => buildDcCommitteeComponent(receiver, s)).toThrow(/negative/);
  });
  it("reconciles every group below the displayed cap before reading", () => {
    const groups: DcCommitteeGroup[] = Array.from({ length: 8 }, (_, i) => ({
        key: `SYNTHETIC ${i}`,
        reportedName: `Synthetic ${i}`,
        amountCents: 100,
        occurrenceCount: 1,
      })),
      controls = {
        totalAmountCents: 800,
        contributionCount: 8,
        sourceReceivingRows: 9,
        excludedRows: 1,
      };
    expect(() => validateDcCommitteeClosure(controls, groups)).not.toThrow();
    expect(() =>
      validateDcCommitteeClosure(controls, groups.slice(0, 5)),
    ).toThrow(/closure/);
    expect(() =>
      validateDcCommitteeClosure(
        controls,
        groups.map((g, i) => (i === 7 ? { ...g, amountCents: 101 } : g)),
      ),
    ).toThrow(/closure/);
    expect(() =>
      validateDcCommitteeClosure(controls, [...groups, groups[0]!]),
    ).toThrow(/stored_group/);
  });
  it("rejects changed context, retimed originals and future success clocks", async () => {
    const v = buildDcCommitteeComponent(receiver, await source());
    expect(() =>
      validateDcCommitteeStored(v, {
        ...receiver,
        activeCandidateOwnerCount: 2,
      }),
    ).toThrow(/canonical_receiver/);
    expect(() =>
      validateDcCommitteeStored(
        { ...v, observedAt: new Date().toISOString() },
        receiver,
      ),
    ).toThrow(/source_clock/);
    expect(() =>
      validateDcCommitteeStored(
        { ...v, syncedAt: "2099-01-01T00:00:00.000Z" },
        receiver,
      ),
    ).toThrow(/source_clock/);
  });
  it("preserves legacy headlines, outside spending and clocks while exposing reported committee basis", async () => {
    const v = buildDcCommitteeComponent(receiver, await source()),
      base = overlayDcCommitteeComponent(undefined, v);
    base.last_synced_at = "2026-01-01T00:00:00.000Z";
    base.direct_campaign.total_raised = 9876;
    base.outside_spending.support_total = 123;
    const result = overlayDcCommitteeComponent(base, v);
    expect(result.last_synced_at).toBe(base.last_synced_at);
    expect(result.direct_campaign.total_raised).toBe(9876);
    expect(result.outside_spending).toEqual(base.outside_spending);
    expect(result.direct_campaign.pac_money_by_interest![0]!.amount).toBe(
      24.34,
    );
    expect(result.direct_campaign.pac_money_basis).toBe(
      "reported_committee_itemized_contributions",
    );
    expect(result.direct_campaign.pac_money_coverage_note).toContain(
      "before separately reported",
    );
  });
  it("rolls back both component and names when a group write fails", async () => {
    const s = await source(),
      sql: string[] = [],
      query = vi.fn(async (text: string) => {
        sql.push(text);
        if (text.startsWith("SELECT l.id")) return { rows: [receiver] };
        if (text.startsWith("SELECT candidate_id"))
          return {
            rows: [
              { candidate_id: receiver.candidateId, link_status: "active" },
            ],
          };
        if (text.includes("INSERT INTO public.dc_committee_finance_groups"))
          throw Error("synthetic database failure");
        return { rows: [] };
      }),
      release = vi.fn();
    await expect(
      writeDcCommitteeComponent({
        db: { connect: vi.fn(async () => ({ query, release })) } as never,
        receiver,
        source: s,
      }),
    ).rejects.toThrow(/database failure/);
    expect(sql.at(-1)).toBe("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
    expect(
      sql
        .filter((s) => /^(?:INSERT|DELETE|UPDATE)/.test(s))
        .every((s) => s.includes("dc_committee_finance_")),
    ).toBe(true);
  });
  it("loads independently when the legacy summary query fails", async () => {
    vi.stubEnv("DISTRICT_OF_COLUMBIA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("DISTRICT_OF_COLUMBIA_REPORTED_COMMITTEE_ENABLED", "true");
    const v = buildDcCommitteeComponent(receiver, await source()),
      stored = {
        link_id: receiver.linkId,
        candidate_id: receiver.candidateId,
        election_id: receiver.electionId,
        election_year: 2026,
        receiver_context: receiver,
        receiving_context: v.receiving,
        source_revision: v.revision,
        source_facts: v.source,
        aggregation_controls: v.controls,
        source_observed_at: v.observedAt,
        source_completed_at: v.completedAt,
        last_synced_at: v.syncedAt,
      },
      groups = v.groups.map((g) => ({
        link_id: receiver.linkId,
        election_year: 2026,
        group_key: g.key,
        reported_name: g.reportedName,
        amount_cents: g.amountCents,
        occurrence_count: g.occurrenceCount,
      }));
    const query = vi
      .fn()
      .mockRejectedValueOnce(Error("synthetic legacy query unavailable"))
      .mockResolvedValueOnce({ rows: [{ ...receiver, stored, groups }] });
    const result =
      await loadDistrictOfColumbiaCandidateFinanceSummariesByCandidateElection(
        { query },
        [
          {
            candidate_id: receiver.candidateId,
            election_id: receiver.electionId,
          },
        ],
        [
          {
            election_id: receiver.electionId,
            state: "DC",
            office_scope: "place",
            office_canonical_name: "Mayor",
          },
        ],
      );
    expect(result.size).toBe(1);
    const actual = [...result.values()][0]!;
    expect(actual.direct_campaign.total_raised).toBeNull();
    expect(actual.outside_spending.support_total).toBeNull();
    expect(actual.direct_campaign.pac_money_by_interest![0]!.amount).toBe(
      24.34,
    );
  });
});

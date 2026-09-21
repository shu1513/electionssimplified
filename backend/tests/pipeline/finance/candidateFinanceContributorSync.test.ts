import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  buildConduitSourceUrl,
  buildPacDonorSourceUrl,
  syncCandidateFinanceContributors,
  type LoadCandidateFinanceContributorsFn,
} from "../../../src/pipeline/finance/candidateFinanceContributorSync.js";
import type { CandidateFinanceContributors } from "../../../src/pipeline/finance/fecBulkContributorAggregator.js";
import {
  fecBulkFileUrl,
  fecCycleForElectionYear,
  readFecBulkFileLines,
} from "../../../src/pipeline/finance/fecBulkDataClient.js";

type StoredRow = Record<string, unknown> & { fec_candidate_id: string; election_year: number };

// A small stand-in for Postgres that understands the writer's statements, so
// the tests can check the rows a sync leaves behind rather than the SQL text.
function createFakeDb() {
  const tables: Record<string, StoredRow[]> = {
    candidate_finance_pac_donors: [],
    candidate_finance_conduit_totals: [],
  };
  const statements: string[] = [];
  let failOnInsertInto: string | null = null;
  let snapshot: string | null = null;

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, " ").trim();
      statements.push(text.split(" ").slice(0, 4).join(" "));
      if (text === "BEGIN") {
        snapshot = JSON.stringify(tables);
      } else if (text === "ROLLBACK" && snapshot) {
        Object.assign(tables, JSON.parse(snapshot));
      } else if (text.startsWith("DELETE FROM public.")) {
        const table = text.split(" ")[2]?.replace("public.", "") ?? "";
        tables[table] = (tables[table] ?? []).filter(
          (row) => !(row.fec_candidate_id === params[0] && row.election_year === params[1])
        );
      } else if (text.startsWith("INSERT INTO public.")) {
        const table = text.split(" ")[2]?.replace("public.", "") ?? "";
        if (table === failOnInsertInto) {
          throw new Error("insert failed");
        }
        if (!(table in tables)) {
          return { rows: [] };
        }
        for (const row of JSON.parse(String(params[2])) as Record<string, unknown>[]) {
          tables[table]?.push({ fec_candidate_id: String(params[0]), election_year: Number(params[1]), ...row });
        }
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };

  return {
    tables,
    statements,
    failOnInsertInto(table: string | null) {
      failOnInsertInto = table;
    },
    query: client.query,
    connect: vi.fn(async () => client),
  };
}

const UNION_DONOR = {
  committeeId: "C00000011",
  committeeName: "UNITED WORKERS UNION PAC",
  connectedOrganization: "UNITED WORKERS UNION",
  amount: 10000,
  contributionCount: 2,
  recipientCommitteeId: "C00000001",
};
const CORPORATE_DONOR = {
  committeeId: "C00000012",
  committeeName: "ACME CORP PAC",
  connectedOrganization: "ACME CORPORATION",
  amount: 2500,
  contributionCount: 1,
  recipientCommitteeId: "C00000001",
};
const CONDUIT = {
  committeeId: "C00000021",
  committeeName: "CONDUIT GROUP A PAC",
  isPaymentPlatform: false,
  amount: 750,
  contributionCount: 3,
  recipientCommitteeId: "C00000001",
};

function loaderReturning(byCandidate: Record<string, Partial<CandidateFinanceContributors>>) {
  return vi.fn<LoadCandidateFinanceContributorsFn>(async () => (fecCandidateId) => ({
    fecCandidateId,
    pacDonors: byCandidate[fecCandidateId]?.pacDonors ?? [],
    conduits: byCandidate[fecCandidateId]?.conduits ?? [],
  }));
}

describe("syncCandidateFinanceContributors", () => {
  const now = new Date("2026-09-20T00:00:00.000Z");
  const targets = [{ fecCandidateId: "H0XX01234", electionYear: 2026 }];

  it("loads each cycle once and replaces a candidate's rows inside one transaction", async () => {
    const db = createFakeDb();
    const loadContributorsFn = loaderReturning({ H0XX01234: { pacDonors: [UNION_DONOR, CORPORATE_DONOR], conduits: [CONDUIT] } });

    const result = await syncCandidateFinanceContributors({
      db,
      now,
      loadContributorsFn,
      targets: [...targets, { fecCandidateId: "S0YY00567", electionYear: 2026 }, { fecCandidateId: "P00000001", electionYear: 2028 }],
    });

    expect(loadContributorsFn).toHaveBeenCalledTimes(1);
    expect(loadContributorsFn.mock.calls[0]?.[0]).toMatchObject({ cycle: 2026, fecCandidateIds: ["H0XX01234", "S0YY00567"] });
    expect(result).toMatchObject({ candidateCount: 2, candidatesWithPacDonors: 1, candidatesWithConduits: 1 });
    expect(result.results[0]).toEqual({
      fecCandidateId: "H0XX01234",
      electionYear: 2026,
      pacDonorCount: 2,
      pacDonorTotal: 12500,
      conduitCount: 1,
      conduitTotal: 750,
    });
    expect(db.statements.slice(0, 7)).toEqual([
      "BEGIN",
      "DELETE FROM public.candidate_finance_pac_donors WHERE",
      "DELETE FROM public.candidate_finance_conduit_totals WHERE",
      "INSERT INTO public.candidate_finance_pac_donors (",
      "INSERT INTO public.candidate_finance_conduit_totals (",
      "INSERT INTO public.candidate_finance_contributor_syncs (fec_candidate_id,",
      "COMMIT",
    ]);
    expect(db.tables.candidate_finance_pac_donors).toHaveLength(2);
    expect(db.tables.candidate_finance_pac_donors?.[0]).toMatchObject({
      fec_candidate_id: "H0XX01234",
      election_year: 2026,
      committee_id: "C00000011",
      connected_organization: "UNITED WORKERS UNION",
      amount: 10000,
      contribution_count: 2,
    });
  });

  it("is idempotent, and a later sync replaces rows that are gone from the source", async () => {
    const db = createFakeDb();
    const first = loaderReturning({ H0XX01234: { pacDonors: [UNION_DONOR, CORPORATE_DONOR], conduits: [CONDUIT] } });
    await syncCandidateFinanceContributors({ db, now, targets, loadContributorsFn: first });
    const afterFirst = JSON.stringify(db.tables);
    await syncCandidateFinanceContributors({ db, now, targets, loadContributorsFn: first });
    expect(JSON.stringify(db.tables)).toBe(afterFirst);

    // The corporate PAC's contribution was refunded and the conduit rows were amended away.
    const second = loaderReturning({ H0XX01234: { pacDonors: [UNION_DONOR] } });
    await syncCandidateFinanceContributors({ db, now, targets, loadContributorsFn: second });
    expect(db.tables.candidate_finance_pac_donors?.map((row) => row.committee_id)).toEqual(["C00000011"]);
    expect(db.tables.candidate_finance_conduit_totals).toEqual([]);
  });

  it("keeps the previous rows when a write fails part-way", async () => {
    const db = createFakeDb();
    await syncCandidateFinanceContributors({
      db,
      now,
      targets,
      loadContributorsFn: loaderReturning({ H0XX01234: { pacDonors: [UNION_DONOR], conduits: [CONDUIT] } }),
    });
    const before = JSON.stringify(db.tables);

    db.failOnInsertInto("candidate_finance_conduit_totals");
    await expect(
      syncCandidateFinanceContributors({
        db,
        now,
        targets,
        loadContributorsFn: loaderReturning({ H0XX01234: { pacDonors: [CORPORATE_DONOR], conduits: [CONDUIT] } }),
      })
    ).rejects.toThrow("insert failed");
    expect(JSON.stringify(db.tables)).toBe(before);
    expect(db.statements.at(-1)).toBe("ROLLBACK");
  });

  it("writes nothing on a dry run", async () => {
    const db = createFakeDb();
    const result = await syncCandidateFinanceContributors({
      db,
      now,
      targets,
      dryRun: true,
      loadContributorsFn: loaderReturning({ H0XX01234: { pacDonors: [UNION_DONOR] } }),
    });
    expect(result).toMatchObject({ dryRun: true, candidatesWithPacDonors: 1 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("links every row to an FEC page", () => {
    expect(buildPacDonorSourceUrl(UNION_DONOR, 2026)).toBe(
      "https://www.fec.gov/data/disbursements/?data_type=processed&committee_id=C00000011&recipient_name=C00000001&two_year_transaction_period=2026"
    );
    expect(buildPacDonorSourceUrl({ ...UNION_DONOR, recipientCommitteeId: null }, 2026)).toBe(
      "https://www.fec.gov/data/committee/C00000011/?cycle=2026"
    );
    expect(buildConduitSourceUrl(CONDUIT, 2026)).toBe(
      "https://www.fec.gov/data/receipts/?data_type=processed&committee_id=C00000001&contributor_name=C00000021&two_year_transaction_period=2026"
    );
  });
});

describe("fecBulkDataClient", () => {
  it("names bulk files by the even year that ends the cycle", () => {
    expect(fecCycleForElectionYear(2026)).toBe(2026);
    expect(fecCycleForElectionYear(2025)).toBe(2026);
    expect(fecBulkFileUrl("committee_contributions", 2026)).toBe("https://www.fec.gov/files/bulk-downloads/2026/pas226.zip");
    expect(fecBulkFileUrl("individual_contributions", 2026)).toBe("https://www.fec.gov/files/bulk-downloads/2026/indiv26.zip");
  });

  it("reads only the first entry, so the by-date copies of the same rows are not read twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fec-bulk-test-"));
    try {
      const zipPath = join(directory, "indiv26.zip");
      await writeFile(
        zipPath,
        zipSync({
          "itcont.txt": strToU8("row one\nrow two\n"),
          "by_date/itcont_2026_a.txt": strToU8("row one\n"),
          "by_date/itcont_2026_b.txt": strToU8("row two\n"),
        })
      );
      const lines: string[] = [];
      const count = await readFecBulkFileLines({ kind: "individual_contributions", zipPath, onLine: (line) => lines.push(line) });
      expect(count).toBe(2);
      expect(lines).toEqual(["row one", "row two"]);

      await expect(
        readFecBulkFileLines({ kind: "committee_contributions", zipPath, onLine: () => undefined })
      ).rejects.toThrow("Expected itpas2.txt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool, PoolClient } from "pg";

import {
  FecBulkContributorAggregator,
  parseFecCandidateCommitteeLinkLine,
  parseFecCommitteeContributionLine,
  parseFecCommitteeMasterLine,
  parseFecEarmarkedReceiptLine,
  type CandidateFinanceConduitTotal,
  type CandidateFinanceContributors,
  type CandidateFinancePacDonor,
} from "./fecBulkContributorAggregator.js";
import {
  downloadFecBulkFile,
  fecCycleForElectionYear,
  readFecBulkFileLines,
  type FecBulkFileKind,
} from "./fecBulkDataClient.js";

// Named committee donors and conduit totals for federal candidates, loaded
// from the FEC bulk files. One pass over the files answers every candidate in
// a cycle, so this step makes no OpenFEC API calls and does not touch the
// hourly API quota.

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect?: () => Promise<PoolClient>;
};

export type CandidateFinanceContributorTarget = {
  fecCandidateId: string;
  electionYear: number;
};

export type CandidateFinanceContributorLookup = (fecCandidateId: string) => CandidateFinanceContributors;

export type LoadCandidateFinanceContributorsFn = (input: {
  cycle: number;
  fecCandidateIds: readonly string[];
  bulkDataDirectory?: string;
  downloadTimeoutMs?: number;
}) => Promise<CandidateFinanceContributorLookup>;

export type CandidateFinanceContributorSyncInput = {
  db: Queryable;
  targets: readonly CandidateFinanceContributorTarget[];
  now?: Date;
  dryRun?: boolean;
  /** Keep downloaded ZIPs here and reuse them; a temporary directory is used and removed otherwise. */
  bulkDataDirectory?: string;
  downloadTimeoutMs?: number;
  loadContributorsFn?: LoadCandidateFinanceContributorsFn;
};

export type CandidateFinanceContributorSyncItemResult = {
  fecCandidateId: string;
  electionYear: number;
  pacDonorCount: number;
  pacDonorTotal: number;
  conduitCount: number;
  conduitTotal: number;
};

export type CandidateFinanceContributorSyncResult = {
  dryRun: boolean;
  candidateCount: number;
  candidatesWithPacDonors: number;
  candidatesWithConduits: number;
  results: CandidateFinanceContributorSyncItemResult[];
};

const BULK_FILE_READ_ORDER: readonly FecBulkFileKind[] = [
  "committee_master",
  "candidate_committee_linkage",
  "committee_contributions",
  "individual_contributions",
];

export const loadCandidateFinanceContributorsFromFecBulk: LoadCandidateFinanceContributorsFn = async (input) => {
  const temporaryDirectory = input.bulkDataDirectory ? null : await mkdtemp(join(tmpdir(), "fec-bulk-"));
  const directory = input.bulkDataDirectory ?? temporaryDirectory ?? tmpdir();
  const aggregator = new FecBulkContributorAggregator({ cycle: input.cycle, fecCandidateIds: input.fecCandidateIds });

  try {
    for (const kind of BULK_FILE_READ_ORDER) {
      const zipPath = await downloadFecBulkFile({
        kind,
        cycle: input.cycle,
        directory,
        timeoutMs: input.downloadTimeoutMs,
      });
      await readFecBulkFileLines({
        kind,
        zipPath,
        onLine: (line) => {
          if (kind === "committee_master") {
            const committee = parseFecCommitteeMasterLine(line);
            if (committee) {
              aggregator.addCommittee(committee);
            }
          } else if (kind === "candidate_committee_linkage") {
            const link = parseFecCandidateCommitteeLinkLine(line);
            if (link) {
              aggregator.addCandidateCommitteeLink(link);
            }
          } else if (kind === "committee_contributions") {
            const contribution = parseFecCommitteeContributionLine(line);
            if (contribution) {
              aggregator.addCommitteeContribution(contribution);
            }
          } else {
            const receipt = parseFecEarmarkedReceiptLine(line);
            if (receipt) {
              aggregator.addEarmarkedReceipt(receipt);
            }
          }
        },
      });
    }
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  return (fecCandidateId) => aggregator.getContributors(fecCandidateId);
};

function fecUrl(path: string, params: Record<string, string | number>): string {
  const url = new URL(`https://www.fec.gov${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** The giving committee's reported disbursements to the candidate's committee. */
export function buildPacDonorSourceUrl(donor: CandidateFinancePacDonor, cycle: number): string {
  if (!donor.recipientCommitteeId) {
    return fecUrl(`/data/committee/${donor.committeeId}/`, { cycle });
  }
  return fecUrl("/data/disbursements/", {
    data_type: "processed",
    committee_id: donor.committeeId,
    recipient_name: donor.recipientCommitteeId,
    two_year_transaction_period: cycle,
  });
}

/**
 * The candidate committee's receipts tied to the conduit's committee id. The
 * fec.gov "contributor name or ID" filter matches the earmarked individual
 * rows as well as the conduit's own lines.
 */
export function buildConduitSourceUrl(conduit: CandidateFinanceConduitTotal, cycle: number): string {
  return fecUrl("/data/receipts/", {
    data_type: "processed",
    committee_id: conduit.recipientCommitteeId,
    contributor_name: conduit.committeeId,
    two_year_transaction_period: cycle,
  });
}

function canOpenTransaction(db: Queryable): db is ConnectableQueryable & { connect: () => Promise<PoolClient> } {
  return typeof (db as ConnectableQueryable).connect === "function";
}

async function withTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!canOpenTransaction(db)) {
    return await work(db);
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Replaces one candidate-cycle's donor and conduit rows. Delete and insert run
 * in one transaction, so readers see the old lists or the new ones, never a
 * mix, and running it again with the same input leaves the same rows.
 */
export async function replaceCandidateFinanceContributors(input: {
  db: Queryable;
  fecCandidateId: string;
  electionYear: number;
  contributors: CandidateFinanceContributors;
  syncedAt: Date;
}): Promise<void> {
  const cycle = fecCycleForElectionYear(input.electionYear);
  const syncedAt = input.syncedAt.toISOString();
  const pacDonorRows = input.contributors.pacDonors.map((donor) => ({
    committee_id: donor.committeeId,
    committee_name: donor.committeeName,
    connected_organization: donor.connectedOrganization,
    amount: donor.amount,
    contribution_count: donor.contributionCount,
    source_url: buildPacDonorSourceUrl(donor, cycle),
  }));
  const conduitRows = input.contributors.conduits.map((conduit) => ({
    committee_id: conduit.committeeId,
    committee_name: conduit.committeeName,
    is_payment_platform: conduit.isPaymentPlatform,
    amount: conduit.amount,
    contribution_count: conduit.contributionCount,
    source_url: buildConduitSourceUrl(conduit, cycle),
  }));

  await withTransaction(input.db, async (db) => {
    await db.query(
      `DELETE FROM public.candidate_finance_pac_donors WHERE fec_candidate_id = $1 AND election_year = $2`,
      [input.fecCandidateId, input.electionYear]
    );
    await db.query(
      `DELETE FROM public.candidate_finance_conduit_totals WHERE fec_candidate_id = $1 AND election_year = $2`,
      [input.fecCandidateId, input.electionYear]
    );
    if (pacDonorRows.length > 0) {
      await db.query(
        `
          INSERT INTO public.candidate_finance_pac_donors (
            fec_candidate_id, election_year, committee_id, committee_name,
            connected_organization, amount, contribution_count, source_url, last_synced_at
          )
          SELECT $1, $2, x.committee_id, x.committee_name,
            x.connected_organization, x.amount, x.contribution_count, x.source_url, $4::timestamptz
          FROM jsonb_to_recordset($3::jsonb) AS x(
            committee_id text, committee_name text, connected_organization text,
            amount numeric, contribution_count int, source_url text
          )
        `,
        [input.fecCandidateId, input.electionYear, JSON.stringify(pacDonorRows), syncedAt]
      );
    }
    if (conduitRows.length > 0) {
      await db.query(
        `
          INSERT INTO public.candidate_finance_conduit_totals (
            fec_candidate_id, election_year, committee_id, committee_name,
            is_payment_platform, amount, contribution_count, source_url, last_synced_at
          )
          SELECT $1, $2, x.committee_id, x.committee_name,
            x.is_payment_platform, x.amount, x.contribution_count, x.source_url, $4::timestamptz
          FROM jsonb_to_recordset($3::jsonb) AS x(
            committee_id text, committee_name text, is_payment_platform boolean,
            amount numeric, contribution_count int, source_url text
          )
        `,
        [input.fecCandidateId, input.electionYear, JSON.stringify(conduitRows), syncedAt]
      );
    }
    // Marks the lists as loaded for the read side. A candidate with no
    // summary row yet gets the mark when the totals sync creates one and the
    // next contributor sync runs.
    await db.query(
      `
        UPDATE public.candidate_finance_summaries
        SET contributors_synced_at = $3::timestamptz
        WHERE fec_candidate_id = $1 AND election_year = $2
      `,
      [input.fecCandidateId, input.electionYear, syncedAt]
    );
  });
}

function sumAmounts(rows: readonly { amount: number }[]): number {
  return Math.round(rows.reduce((total, row) => total + row.amount, 0) * 100) / 100;
}

export async function syncCandidateFinanceContributors(
  input: CandidateFinanceContributorSyncInput
): Promise<CandidateFinanceContributorSyncResult> {
  const dryRun = input.dryRun === true;
  const syncedAt = input.now ?? new Date();
  const loadContributors = input.loadContributorsFn ?? loadCandidateFinanceContributorsFromFecBulk;

  const targetsByCycle = new Map<number, Map<string, CandidateFinanceContributorTarget>>();
  for (const target of input.targets) {
    const fecCandidateId = target.fecCandidateId.trim().toUpperCase();
    // Presidential committees file on a different form and calendar; this
    // step covers House and Senate candidates.
    if (!/^[HS][0-9A-Z]{8}$/.test(fecCandidateId)) {
      continue;
    }
    const cycle = fecCycleForElectionYear(target.electionYear);
    const targets = targetsByCycle.get(cycle) ?? new Map<string, CandidateFinanceContributorTarget>();
    targets.set(`${fecCandidateId} ${target.electionYear}`, { fecCandidateId, electionYear: target.electionYear });
    targetsByCycle.set(cycle, targets);
  }

  const results: CandidateFinanceContributorSyncItemResult[] = [];
  for (const [cycle, targets] of targetsByCycle) {
    const lookup = await loadContributors({
      cycle,
      fecCandidateIds: [...new Set([...targets.values()].map((target) => target.fecCandidateId))],
      bulkDataDirectory: input.bulkDataDirectory,
      downloadTimeoutMs: input.downloadTimeoutMs,
    });
    for (const target of targets.values()) {
      const contributors = lookup(target.fecCandidateId);
      if (!dryRun) {
        await replaceCandidateFinanceContributors({
          db: input.db,
          fecCandidateId: target.fecCandidateId,
          electionYear: target.electionYear,
          contributors,
          syncedAt,
        });
      }
      results.push({
        fecCandidateId: target.fecCandidateId,
        electionYear: target.electionYear,
        pacDonorCount: contributors.pacDonors.length,
        pacDonorTotal: sumAmounts(contributors.pacDonors),
        conduitCount: contributors.conduits.length,
        conduitTotal: sumAmounts(contributors.conduits),
      });
    }
  }

  return {
    dryRun,
    candidateCount: results.length,
    candidatesWithPacDonors: results.filter((result) => result.pacDonorCount > 0).length,
    candidatesWithConduits: results.filter((result) => result.conduitCount > 0).length,
    results,
  };
}

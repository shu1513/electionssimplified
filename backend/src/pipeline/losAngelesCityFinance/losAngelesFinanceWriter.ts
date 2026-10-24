import { losAngelesReceivingCommitteeIds, normalizeLosAngelesCommitteeKey, type LosAngelesReportedCommitteeCash } from "./losAngelesReportedCommitteeCash.js";
import type { Pool, PoolClient } from "pg";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
import type { LosAngelesDirectBreakdown } from "./losAngelesDirectContributionAggregator.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };
export type LosAngelesFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  seatNumber?: number | null;
  ethicsElectionId: string;
  ethicsCandidatePersonId: string;
  ethicsSeatCandidateId: string;
  fppcCommitteeId: string;
  fppcCommitteeIds?: readonly string[];
  committeeName: string;
  internalCommitteePersonId?: string | null;
  linkStatus?: "active" | "needs_review" | "inactive";
  linkSource?: "manual" | "lacity_ethics";
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};
export type LosAngelesFinanceSummaryInput = {
  totalReceipts: number | null;
  totalDisbursements: number | null;
  cashOnHand: number | null;
  matchingFunds: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  membershipSupportTotal: number | null;
  membershipOpposeTotal: number | null;
  sourceUrl: string | null;
  reportedThrough: string | null;
};
export type LosAngelesOutsideGroupInput = {
  spenderId: string;
  spenderName: string;
  supportOppose: "support" | "oppose";
  amount: number;
  expenditureCount: number | null;
  sourceUrl: string | null;
};

const text = (value: string, label: string): string => {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
};
const optional = (value: string | null | undefined): string | null =>
  value?.trim() || null;
const amount = (value: number | null, label: string): number | null => {
  if (value !== null && (!Number.isFinite(value) || value < 0))
    throw new Error(`${label} must be nonnegative`);
  return value;
};
const seatNumber = (
  value: number | null | undefined,
  officeName: string,
): number | null => {
  if (officeName === "City Council Member") {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 15
    )
      throw new Error(
        "Los Angeles City Council seat number must be 1 through 15",
      );
    return value;
  }
  if (officeName === "School Board Member") {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 7
    )
      throw new Error(
        "Los Angeles school board seat number must be 1 through 7",
      );
    return value;
  }
  if (value !== null && value !== undefined)
    throw new Error(
      "Los Angeles citywide finance link cannot have a seat number",
    );
  return null;
};

async function upsertLink(
  db: Queryable,
  link: LosAngelesFinanceLinkInput,
): Promise<string> {
  const officeName = text(link.officeName, "office name");
  const normalizedSeatNumber = seatNumber(link.seatNumber, officeName);
  // Every text field is validated and normalized BEFORE any statement below:
  // this function also runs standalone on a bare Pool (auto-link), where a
  // mid-flight validation throw after the deactivate UPDATE would leave the
  // candidate with no active link. The trimmed committee id is the single
  // value used for the manual-link comparison, the deactivation predicate,
  // and the INSERT — a padded input must match a stored id, never slip past
  // the probe and reach the stored row through ON CONFLICT.
  const candidateId = text(link.candidateId, "candidate id");
  const electionId = text(link.electionId, "election id");
  const candidateNameNormalized = text(
    link.candidateNameNormalized,
    "candidate name",
  );
  const ethicsElectionId = text(link.ethicsElectionId, "Ethics election id");
  const ethicsCandidatePersonId = text(
    link.ethicsCandidatePersonId,
    "Ethics candidate person id",
  );
  const ethicsSeatCandidateId = text(
    link.ethicsSeatCandidateId,
    "Ethics seat candidate id",
  );
  const fppcCommitteeId = text(link.fppcCommitteeId, "FPPC committee id");
  const committeeName = text(link.committeeName, "committee name");
  const receivingIds = losAngelesReceivingCommitteeIds(fppcCommitteeId, link.fppcCommitteeIds);
  // Manual protection applies to EVERY automatic write, not only active
  // upserts, and probes manual rows of ANY status: an operator-disabled
  // (inactive/needs_review) manual link with this committee id is the
  // ON CONFLICT target row, and the upsert would otherwise silently
  // rewrite it to lacity_ethics.
  if ((link.linkSource ?? "manual") === "lacity_ethics") {
    const manual = await db.query<{
      id: string;
      fppc_committee_id: string;
      link_status: string;
    }>(
      `SELECT id::text,fppc_committee_id,link_status FROM public.lacity_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_source='manual'`,
      [candidateId, electionId],
    );
    const sameCommittee = manual.rows.find(
      (row) => row.fppc_committee_id === fppcCommitteeId,
    );
    if (sameCommittee) {
      if (sameCommittee.link_status !== "active")
        throw new Error(
          "Los Angeles automatic finance link matches an operator-disabled manual link",
        );
      if (link.fppcCommitteeIds) await db.query(
        `UPDATE public.lacity_candidate_finance_links SET fppc_committee_ids=$2::text[] WHERE id=$1::uuid`, [sameCommittee.id, receivingIds]);
      return sameCommittee.id;
    }
    // A disabled manual link with a DIFFERENT committee id does not block a
    // new automatic identity — the operator disabled that association, not
    // the candidate. Only an active manual link conflicts.
    if (manual.rows.some((row) => row.link_status === "active"))
      throw new Error(
        "Los Angeles automatic finance link conflicts with protected manual link",
      );
  }
  if ((link.linkStatus ?? "active") === "active")
    await db.query(
      `UPDATE public.lacity_candidate_finance_links SET link_status='inactive' WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND fppc_committee_id<>$3 AND link_status='active' AND link_source<>'manual'`,
      [candidateId, electionId, fppcCommitteeId],
    );
  // The conflict guard is the race backstop: a row an operator flips to
  // manual between the probe and this statement blocks the update (no id
  // returned, the throw below aborts) instead of being rewritten.
  const result = await db.query<{ id: string }>(
    `INSERT INTO public.lacity_candidate_finance_links (candidate_id,election_id,election_year,candidate_name_normalized,office_name,seat_number,ethics_election_id,ethics_candidate_person_id,ethics_seat_candidate_id,fppc_committee_id,committee_name,internal_committee_person_id,link_status,link_source,source_url,last_verified_at,fppc_committee_ids) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::text[]) ON CONFLICT (candidate_id,election_id,fppc_committee_id) DO UPDATE SET election_year=EXCLUDED.election_year,candidate_name_normalized=EXCLUDED.candidate_name_normalized,office_name=EXCLUDED.office_name,seat_number=EXCLUDED.seat_number,ethics_election_id=EXCLUDED.ethics_election_id,ethics_candidate_person_id=EXCLUDED.ethics_candidate_person_id,ethics_seat_candidate_id=EXCLUDED.ethics_seat_candidate_id,committee_name=EXCLUDED.committee_name,fppc_committee_ids=EXCLUDED.fppc_committee_ids,internal_committee_person_id=EXCLUDED.internal_committee_person_id,link_status=EXCLUDED.link_status,link_source=EXCLUDED.link_source,source_url=EXCLUDED.source_url,last_verified_at=EXCLUDED.last_verified_at WHERE lacity_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual' RETURNING id::text`,
    [
      candidateId,
      electionId,
      link.electionYear,
      candidateNameNormalized,
      officeName,
      normalizedSeatNumber,
      ethicsElectionId,
      ethicsCandidatePersonId,
      ethicsSeatCandidateId,
      fppcCommitteeId,
      committeeName,
      optional(link.internalCommitteePersonId),
      link.linkStatus ?? "active",
      link.linkSource ?? "manual",
      optional(link.sourceUrl),
      link.lastVerifiedAt?.toISOString() ?? null,
      receivingIds,
    ],
  );
  if (!result.rows[0]?.id)
    throw new Error(
      "Los Angeles finance link upsert wrote no row — blocked by a concurrent protected manual link",
    );
  return result.rows[0].id;
}

export async function upsertLosAngelesFinanceLink(input: {
  db: Queryable;
  link: LosAngelesFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return { linkId: await upsertLink(input.db, input.link) };
}

export async function replaceLosAngelesCandidateFinanceSnapshot(input: {
  db: PoolLike;
  link: LosAngelesFinanceLinkInput;
  summary: LosAngelesFinanceSummaryInput;
  directBreakdowns: readonly LosAngelesDirectBreakdown[];
  outsideGroups: readonly LosAngelesOutsideGroupInput[];
  classifications?: readonly FinanceLabelClassification[];
  reportedCommitteeCash?: LosAngelesReportedCommitteeCash;
  syncedAt?: Date;
}): Promise<{ linkId: string }> {
  if (typeof input.db.connect !== "function")
    throw new Error("Los Angeles finance snapshot writes require a Pool");
  const syncedAt = input.syncedAt ?? new Date();
  const cash = input.reportedCommitteeCash;
  if (cash) {
    const scope = losAngelesReceivingCommitteeIds(input.link.fppcCommitteeId, input.link.fppcCommitteeIds);
    if (JSON.stringify(cash.receivingCommitteeIds) !== JSON.stringify(scope)) throw new Error("Los Angeles cash receiving scope does not match the link");
    if (cash.donors.length && cash.reportedThrough === null) throw new Error("Los Angeles cash requires report date evidence");
    if (cash.reportedThrough !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(cash.reportedThrough) || !Number.isFinite(Date.parse(cash.reportedThrough)) ||
      new Date(cash.reportedThrough).toISOString().slice(0,10) !== cash.reportedThrough)) throw new Error("Los Angeles cash report date is invalid");
    const keys = new Set<string>(); let total = 0, gifts = 0;
    for (const donor of cash.donors) {
      if (!donor.committeeKey || donor.committeeKey !== normalizeLosAngelesCommitteeKey(donor.committeeName) || keys.has(donor.committeeKey) ||
        !Number.isSafeInteger(donor.amountCents) || donor.amountCents <= 0 || !Number.isSafeInteger(donor.contributionCount) || donor.contributionCount <= 0)
        throw new Error("Los Angeles cash has invalid reported groups");
      keys.add(donor.committeeKey); total += donor.amountCents; gifts += donor.contributionCount;
    }
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(gifts) || total !== cash.amountCents || gifts !== cash.contributionCount)
      throw new Error("Los Angeles cash source counts and cents do not close");
  }
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    const linkId = await upsertLink(client, input.link);
    const year = input.link.electionYear;
    if (cash) {
      // Also serializes matching manual links whose standalone upsert reused
      // an existing row. Compare clocks in PG at full source precision.
      await client.query(`SELECT id FROM public.lacity_candidate_finance_links WHERE id=$1::uuid FOR UPDATE`, [linkId]);
      const prior = await client.query<{ newer: boolean }>(`SELECT observed_at > $3::timestamptz newer FROM public.lacity_candidate_finance_pac_sources
        WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE`, [linkId, year, syncedAt.toISOString()]);
      if (prior.rows.some(row => row.newer)) throw new Error("Los Angeles older cash observation cannot replace a newer snapshot");
    }
    await client.query(
      `INSERT INTO public.lacity_candidate_finance_summaries (link_id,election_year,total_receipts,total_disbursements,cash_on_hand,matching_funds,outside_support_total,outside_oppose_total,membership_support_total,membership_oppose_total,source_url,reported_through,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13::timestamptz) ON CONFLICT (link_id,election_year) DO UPDATE SET total_receipts=EXCLUDED.total_receipts,total_disbursements=EXCLUDED.total_disbursements,cash_on_hand=EXCLUDED.cash_on_hand,matching_funds=EXCLUDED.matching_funds,outside_support_total=EXCLUDED.outside_support_total,outside_oppose_total=EXCLUDED.outside_oppose_total,membership_support_total=EXCLUDED.membership_support_total,membership_oppose_total=EXCLUDED.membership_oppose_total,source_url=EXCLUDED.source_url,reported_through=EXCLUDED.reported_through,last_synced_at=EXCLUDED.last_synced_at`,
      [
        linkId,
        year,
        amount(input.summary.totalReceipts, "receipts"),
        amount(input.summary.totalDisbursements, "disbursements"),
        amount(input.summary.cashOnHand, "cash"),
        amount(input.summary.matchingFunds, "matching funds"),
        amount(input.summary.outsideSupportTotal, "outside support"),
        amount(input.summary.outsideOpposeTotal, "outside oppose"),
        amount(input.summary.membershipSupportTotal, "membership support"),
        amount(input.summary.membershipOpposeTotal, "membership oppose"),
        optional(input.summary.sourceUrl),
        input.summary.reportedThrough,
        syncedAt.toISOString(),
      ],
    );
    await client.query(
      `DELETE FROM public.lacity_candidate_finance_direct_breakdowns WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    for (const row of input.directBreakdowns)
      await client.query(
        `INSERT INTO public.lacity_candidate_finance_direct_breakdowns (link_id,election_year,category_type,category_name,amount,contributor_count,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [
          linkId,
          year,
          row.categoryType,
          text(row.categoryName, "category"),
          amount(row.amount, "breakdown amount"),
          row.contributorCount,
          row.sourceUrl,
          syncedAt.toISOString(),
        ],
      );
    await client.query(
      `DELETE FROM public.lacity_candidate_finance_outside_groups WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    for (const row of input.outsideGroups)
      await client.query(
        `INSERT INTO public.lacity_candidate_finance_outside_groups (link_id,election_year,spender_id,spender_name,support_oppose,amount,expenditure_count,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
        [
          linkId,
          year,
          text(row.spenderId, "spender id"),
          text(row.spenderName, "spender name"),
          row.supportOppose,
          amount(row.amount, "outside amount"),
          row.expenditureCount,
          optional(row.sourceUrl),
          syncedAt.toISOString(),
        ],
      );
    if (cash) {
      await client.query(`INSERT INTO public.lacity_candidate_finance_pac_sources
        (link_id,election_year,amount_cents,contribution_count,group_count,reported_through,observed_at,receiving_committee_ids)
        VALUES ($1::uuid,$2,$3::bigint,$4,$5,$6::date,$7::timestamptz,$8::text[])
        ON CONFLICT (link_id,election_year) DO UPDATE SET amount_cents=EXCLUDED.amount_cents,contribution_count=EXCLUDED.contribution_count,
          group_count=EXCLUDED.group_count,reported_through=EXCLUDED.reported_through,observed_at=EXCLUDED.observed_at,receiving_committee_ids=EXCLUDED.receiving_committee_ids`,
      [linkId,year,String(cash.amountCents),cash.contributionCount,cash.donors.length,cash.reportedThrough,syncedAt.toISOString(),cash.receivingCommitteeIds]);
      await client.query(`DELETE FROM public.lacity_candidate_finance_pac_donors WHERE link_id=$1::uuid AND election_year=$2`, [linkId,year]);
      for (const donor of cash.donors) await client.query(`INSERT INTO public.lacity_candidate_finance_pac_donors
        (link_id,election_year,committee_key,committee_name,amount_cents,contribution_count) VALUES ($1::uuid,$2,$3,$4,$5::bigint,$6)`,
      [linkId,year,donor.committeeKey,donor.committeeName,String(donor.amountCents),donor.contributionCount]);
    }
    for (const classification of input.classifications ?? [])
      await upsertFinanceLabelClassification({ db: client, classification });
    await client.query("COMMIT");
    return { linkId };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

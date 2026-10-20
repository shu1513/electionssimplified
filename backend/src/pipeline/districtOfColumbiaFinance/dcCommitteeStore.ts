import type { Pool } from "pg";
import { isDeepStrictEqual as eq } from "node:util";
import {
  DC_COMMITTEE_REVISION,
  dcAdd,
  dcCheck,
  dcKey,
  dcPoliticalReceipt,
} from "./dcCommitteeNative.js";
import {
  dcIso,
  dcObservationValid,
  type DcCommitteeOriginal,
} from "./dcCommitteeOriginals.js";
import {
  isVerifiedDcCommitteeSource,
  type DcCommitteeSource,
  type DcCommitteeSourceFacts,
} from "./dcCommitteeSource.js";
import {
  dcCanonicalSeat,
  dcPersonMatches,
  loadDcCommitteeReceiver,
  qualifyDcCommitteeReceiver,
  type DcCommitteeReceiver,
  type DcCommitteeReceiving,
} from "./dcCommitteeReceiver.js";

export type DcCommitteeGroup = {
  key: string;
  reportedName: string;
  amountCents: number;
  occurrenceCount: number;
};
export type DcCommitteeControls = {
  totalAmountCents: number;
  contributionCount: number;
  sourceReceivingRows: number;
  excludedRows: number;
};
export type DcCommitteeStored = {
  receiver: DcCommitteeReceiver;
  receiving: DcCommitteeReceiving;
  revision: string;
  source: DcCommitteeSourceFacts;
  controls: DcCommitteeControls;
  groups: DcCommitteeGroup[];
  observedAt: string;
  completedAt: string;
  syncedAt: string;
};
const integer = (v: unknown, min = 0): v is number =>
  Number.isSafeInteger(v) && Number(v) >= min;
export function validateDcCommitteeClosure(
  controls: DcCommitteeControls,
  groups: readonly DcCommitteeGroup[],
): void {
  dcCheck(
    controls &&
      eq(
        Object.keys(controls).sort(),
        [
          "totalAmountCents",
          "contributionCount",
          "sourceReceivingRows",
          "excludedRows",
        ].sort(),
      ) &&
      Object.values(controls).every((v) => integer(v)),
    "stored_controls",
  );
  let total = 0,
    count = 0;
  const seen = new Set<string>();
  for (const g of groups) {
    dcCheck(
      g &&
        typeof g.reportedName === "string" &&
        g.reportedName.length > 0 &&
        g.reportedName.length <= 4000 &&
        g.key === dcKey(g.reportedName) &&
        !seen.has(g.key) &&
        integer(g.amountCents, 1) &&
        integer(g.occurrenceCount, 1),
      "stored_group",
    );
    seen.add(g.key);
    total = dcAdd(total, g.amountCents);
    count = dcAdd(count, g.occurrenceCount);
  }
  dcCheck(
    total === controls.totalAmountCents &&
      count === controls.contributionCount &&
      controls.sourceReceivingRows === dcAdd(count, controls.excludedRows) &&
      controls.sourceReceivingRows > 0,
    "stored_group_closure",
  );
}
export function validateDcCommitteeStored(
  v: DcCommitteeStored,
  receiver: DcCommitteeReceiver,
): void {
  dcCheck(
    eq(v.receiver, receiver) && receiver.activeCandidateOwnerCount === 1,
    "stored_canonical_receiver",
  );
  const c = v.receiving,
    seat = dcCanonicalSeat(receiver);
  dcCheck(
    c &&
      /^[1-9]\d*$/.test(c.committeeId) &&
      typeof c.committeeKey === "string" &&
      c.committeeKey.length > 0 &&
      typeof c.candidateKey === "string" &&
      c.candidateKey.length > 0 &&
      c.electionYear === receiver.electionYear &&
      c.office === receiver.officeName &&
      c.seat === seat &&
      dcKey(c.committeeName) === dcKey(receiver.legacyCommitteeName) &&
      dcPersonMatches(receiver.candidateAliases, c.candidateName),
    "stored_native_receiver",
  );
  dcCheck(v.revision === DC_COMMITTEE_REVISION, "stored_revision");
  const f = v.source;
  dcCheck(
    f &&
      /^[a-f0-9]{64}$/.test(f.manifestSha256) &&
      dcIso(f.observedAt) &&
      dcIso(f.completedAt) &&
      integer(f.registryRows, 1) &&
      integer(f.receiptRows, v.controls.sourceReceivingRows) &&
      integer(f.parentRows, 1) &&
      Array.isArray(f.observations) &&
      f.observations.length > 0 &&
      f.observations.length <= 5000,
    "stored_source_facts",
  );
  let previous = f.observedAt;
  for (const o of f.observations) {
    dcCheck(
      dcObservationValid(o as DcCommitteeOriginal, previous),
      "stored_source_observation",
    );
    previous = o.completedAt;
  }
  dcCheck(
    f.observations[0]!.startedAt === f.observedAt &&
      previous === f.completedAt &&
      v.observedAt === f.observedAt &&
      v.completedAt === f.completedAt &&
      dcIso(v.syncedAt) &&
      v.syncedAt >= v.completedAt &&
      Date.parse(v.syncedAt) <= Date.now(),
    "stored_source_clock",
  );
  validateDcCommitteeClosure(v.controls, v.groups);
}
export function buildDcCommitteeComponent(
  receiver: DcCommitteeReceiver,
  source: DcCommitteeSource,
): DcCommitteeStored {
  dcCheck(
    isVerifiedDcCommitteeSource(source) &&
      source.year === receiver.electionYear,
    "unverified_source",
  );
  const receiving = qualifyDcCommitteeReceiver(receiver, source.registrations),
    groups = new Map<string, DcCommitteeGroup>();
  const controls: DcCommitteeControls = {
    totalAmountCents: 0,
    contributionCount: 0,
    sourceReceivingRows: 0,
    excludedRows: 0,
  };
  for (const row of source.receipts) {
    const same =
      row.committeeKey === receiving.committeeKey &&
      row.candidateKey === receiving.candidateKey;
    if (!same) {
      dcCheck(
        !(
          row.electionYear === receiver.electionYear &&
          dcKey(row.committeeName) === dcKey(receiving.committeeName)
        ),
        "ambiguous_receipt_receiver",
      );
      continue;
    }
    controls.sourceReceivingRows++;
    dcCheck(
      row.electionYear === receiver.electionYear &&
        dcKey(row.committeeName) === dcKey(receiving.committeeName) &&
        dcPersonMatches(
          [...receiver.candidateAliases, receiving.candidateName],
          row.candidateName,
        ),
      "receipt_receiving_context",
    );
    if (!dcPoliticalReceipt(row) || row.amountCents === 0) {
      controls.excludedRows++;
      continue;
    }
    dcCheck(
      [
        "InKind",
        "Credit Card",
        "Other",
        "Cash",
        "Check",
        "Cashier Check",
        "Money Order",
      ].includes(row.transactionType),
      "unknown_committee_gift_method",
    );
    dcCheck(
      row.amountCents > 0 &&
        row.reportedName &&
        row.reportedName.length <= 4000 &&
        !/^(?:UNKNOWN|ANONYMOUS|UNITEMIZED|LUMP SUM)$/i.test(row.reportedName),
      "unresolved_or_negative_committee_gift",
    );
    const key = dcKey(row.reportedName),
      group = groups.get(key) ?? {
        key,
        reportedName: row.reportedName,
        amountCents: 0,
        occurrenceCount: 0,
      };
    group.amountCents = dcAdd(group.amountCents, row.amountCents);
    group.occurrenceCount++;
    if (row.reportedName.localeCompare(group.reportedName) < 0)
      group.reportedName = row.reportedName;
    groups.set(key, group);
    controls.totalAmountCents = dcAdd(
      controls.totalAmountCents,
      row.amountCents,
    );
    controls.contributionCount++;
  }
  const v = {
    receiver,
    receiving,
    revision: DC_COMMITTEE_REVISION,
    source: source.source,
    controls,
    groups: [...groups.values()].sort(
      (a, b) => b.amountCents - a.amountCents || a.key.localeCompare(b.key),
    ),
    observedAt: source.source.observedAt,
    completedAt: source.source.completedAt,
    syncedAt: new Date().toISOString(),
  };
  validateDcCommitteeStored(v, receiver);
  return v;
}
export function readDcCommitteeComponent(
  row: Record<string, unknown>,
  groups: Record<string, unknown>[],
  receiver: DcCommitteeReceiver,
): DcCommitteeStored {
  dcCheck(
    row.link_id === receiver.linkId &&
      row.candidate_id === receiver.candidateId &&
      row.election_id === receiver.electionId &&
      row.election_year === receiver.electionYear &&
      groups.every(
        (g) =>
          g.link_id === receiver.linkId &&
          g.election_year === receiver.electionYear,
      ),
    "stored_row_binding",
  );
  const v: DcCommitteeStored = {
    receiver: row.receiver_context as DcCommitteeReceiver,
    receiving: row.receiving_context as DcCommitteeReceiving,
    revision: row.source_revision as string,
    source: row.source_facts as DcCommitteeSourceFacts,
    controls: row.aggregation_controls as DcCommitteeControls,
    groups: groups.map((g) => ({
      key: g.group_key as string,
      reportedName: g.reported_name as string,
      amountCents: Number(g.amount_cents),
      occurrenceCount: Number(g.occurrence_count),
    })),
    observedAt: new Date(row.source_observed_at as string).toISOString(),
    completedAt: new Date(row.source_completed_at as string).toISOString(),
    syncedAt: new Date(row.last_synced_at as string).toISOString(),
  };
  validateDcCommitteeStored(v, receiver);
  return v;
}
export async function writeDcCommitteeComponent(input: {
  db: Pick<Pool, "connect">;
  receiver: DcCommitteeReceiver;
  source: DcCommitteeSource;
}) {
  const v = buildDcCommitteeComponent(input.receiver, input.source),
    client = await input.db.connect(),
    key = [v.receiver.linkId, v.receiver.electionYear];
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const current = await loadDcCommitteeReceiver(
      client,
      v.receiver.linkId,
      true,
    );
    dcCheck(
      current && eq(current, v.receiver),
      "canonical_receiving_context_changed",
    );
    const old = (
      await client.query(
        "SELECT * FROM public.dc_committee_finance_components WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE",
        key,
      )
    ).rows[0];
    if (old) {
      dcCheck(
        new Date(old.source_observed_at).toISOString() <= v.observedAt,
        "older_source",
      );
      if (
        new Date(old.source_observed_at).toISOString() === v.observedAt &&
        eq(old.receiver_context, v.receiver)
      ) {
        const rows = (
            await client.query(
              "SELECT * FROM public.dc_committee_finance_groups WHERE link_id=$1::uuid AND election_year=$2",
              key,
            )
          ).rows,
          prior = readDcCommitteeComponent(old, rows, v.receiver),
          sorted = (gs: DcCommitteeGroup[]) =>
            [...gs].sort((a, b) => a.key.localeCompare(b.key));
        dcCheck(
          eq(prior.source, v.source) &&
            eq(prior.controls, v.controls) &&
            eq(prior.receiving, v.receiving) &&
            eq(sorted(prior.groups), sorted(v.groups)),
          "equal_source_conflict",
        );
        await client.query("COMMIT");
        begun = false;
        return { groups: v.groups.length, idempotent: true };
      }
    }
    await client.query(
      `INSERT INTO public.dc_committee_finance_components(link_id,election_year,candidate_id,election_id,receiver_context,receiving_context,source_revision,source_facts,aggregation_controls,source_observed_at,source_completed_at,last_synced_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
      ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiver_context=EXCLUDED.receiver_context,receiving_context=EXCLUDED.receiving_context,source_revision=EXCLUDED.source_revision,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,source_completed_at=EXCLUDED.source_completed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [
        ...key,
        v.receiver.candidateId,
        v.receiver.electionId,
        JSON.stringify(v.receiver),
        JSON.stringify(v.receiving),
        v.revision,
        JSON.stringify(v.source),
        JSON.stringify(v.controls),
        v.observedAt,
        v.completedAt,
        v.syncedAt,
      ],
    );
    await client.query(
      "DELETE FROM public.dc_committee_finance_groups WHERE link_id=$1::uuid AND election_year=$2",
      key,
    );
    if (v.groups.length)
      await client.query(
        `INSERT INTO public.dc_committee_finance_groups(link_id,election_year,group_key,reported_name,amount_cents,occurrence_count)
      SELECT $1::uuid,$2,x.key,x."reportedName",x."amountCents",x."occurrenceCount" FROM jsonb_to_recordset($3::jsonb) AS x(key text,"reportedName" text,"amountCents" bigint,"occurrenceCount" integer)`,
        [...key, JSON.stringify(v.groups)],
      );
    await client.query("COMMIT");
    begun = false;
    return { groups: v.groups.length, idempotent: false };
  } catch (e) {
    if (begun) await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

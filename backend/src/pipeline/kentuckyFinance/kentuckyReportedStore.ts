import type { Pool, PoolClient } from "pg";
import { KENTUCKY_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./kentuckyFinanceEligibleOffices.js";
import {
  aggregateKentuckyReported,
  isKentuckyReportedCommitteeClass,
  kyText,
  kyPerson,
  kyOffice,
  kyLocation,
  type KentuckyReportedReceiver,
  type KentuckyReportedAggregation,
  type KentuckyReportedGroup,
} from "./kentuckyReportedAggregation.js";
import {
  isKentuckyReportedPacket,
  kentuckyReportedUrls,
  KY_REPORTED_DATES,
  kyAdd,
  kyHold,
  type KentuckyReportedKind,
  type KentuckyReportedPacket,
} from "./kentuckyReportedSource.js";

type Row = Record<string, any>;
export const KY_REPORTED_RECEIVER_SELECT = `SELECT l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
  l.election_year "electionYear",e.election_date::text "electionDate",
  COALESCE(NULLIF(trim(c.display_name),''),NULLIF(trim(c.first_name||' '||c.last_name),'')) "candidateName",
  o.scope "officeScope",o.canonical_name "canonicalOffice",l.office_name "officeName",l.district "location",
  CASE WHEN o.scope='statewide' THEN 'Statewide' WHEN d.district_type IN ('state_lower','state_upper') THEN
    NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') END "canonicalDistrict",
  l.candidate_key "candidateKey",l.committee_key "committeeKey",l.committee_name "committeeName"
  FROM public.ky_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
  JOIN public.candidate_elections ce ON ce.candidate_id=c.id AND ce.election_id=l.election_id
  JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
  WHERE l.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost')
    AND (SELECT count(*) FROM public.ky_candidate_finance_links active WHERE active.candidate_id=l.candidate_id AND active.election_id=l.election_id AND active.link_status='active')=1
    AND d.state='KY' AND e.race_type='office' AND e.election_stage='general'
    AND l.election_year=2026 AND e.election_date='2026-11-03'::date
    AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
export const kyReportedOfficeKeys = [...KENTUCKY_FINANCE_ELIGIBLE_OFFICE_KEYS];
const receivingKey = (r: KentuckyReportedReceiver) =>
  JSON.stringify([
    kyPerson(r.committeeName),
    kyOffice(r.officeName),
    kyLocation(r.location ?? ""),
    r.electionDate,
  ]);
export function kyCanonical(value: unknown): string {
  return JSON.stringify(value, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
}
export async function listKentuckyReportedReceivers(
  db: Pick<Pool, "query">,
): Promise<KentuckyReportedReceiver[]> {
  const rows = (
    await db.query<KentuckyReportedReceiver>(
      KY_REPORTED_RECEIVER_SELECT + " ORDER BY l.id",
      [kyReportedOfficeKeys],
    )
  ).rows;
  const counts = new Map<string, number>();
  for (const r of rows)
    for (const k of [
      `candidate:${r.candidateId}:${r.electionId}`,
      `source:${receivingKey(r)}`,
    ])
      counts.set(k, (counts.get(k) ?? 0) + 1);
  return rows.filter(
    (r) =>
      counts.get(`candidate:${r.candidateId}:${r.electionId}`) === 1 &&
      counts.get(`source:${receivingKey(r)}`) === 1,
  );
}
export async function lockKentuckyReportedReceiver(
  db: PoolClient,
  receiver: KentuckyReportedReceiver,
): Promise<void> {
  // Lock all active links, including a newly inserted incompatible year/link.
  const links = await db.query(
    `SELECT id::text FROM public.ky_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_status='active' ORDER BY id FOR UPDATE`,
    [receiver.candidateId, receiver.electionId],
  );
  const rows = (
    await db.query<KentuckyReportedReceiver>(
      KY_REPORTED_RECEIVER_SELECT +
        " AND l.candidate_id=$2::uuid AND l.election_id=$3::uuid FOR UPDATE OF l,c,ce,e,d,o",
      [kyReportedOfficeKeys, receiver.candidateId, receiver.electionId],
    )
  ).rows;
  if (
    links.rows.length !== 1 ||
    links.rows[0]!.id !== receiver.linkId ||
    rows.length !== 1 ||
    kyCanonical(rows[0]) !== kyCanonical(receiver)
  )
    kyHold("canonical_receiver_changed");
  const eligible = await listKentuckyReportedReceivers(db);
  if (
    !eligible.some(
      (r) =>
        r.linkId === receiver.linkId &&
        kyCanonical(r) === kyCanonical(receiver),
    )
  )
    kyHold("canonical_receiving_identity_ambiguous");
}
export function kentuckyReportedSourceFacts(s: KentuckyReportedPacket) {
  return {
    kind: s.kind,
    year: s.year,
    retrievedAt: s.retrievedAt,
    completedAt: s.completedAt,
    manifestHash: s.manifestHash,
    byteSize: s.byteSize,
    controls: s.controls,
    sourceRows: s.rows.length,
    censusRows: s.census.length,
  };
}
export function validateKentuckyReportedStoredFacts(
  value: unknown,
  kind: KentuckyReportedKind,
  syncedAt: string,
): void {
  const s = value as ReturnType<typeof kentuckyReportedSourceFacts>;
  const iso = (v: unknown): v is string =>
    typeof v === "string" &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v;
  if (
    !s ||
    s.kind !== kind ||
    s.year !== 2026 ||
    !iso(s.retrievedAt) ||
    !iso(s.completedAt) ||
    s.completedAt < s.retrievedAt ||
    !iso(syncedAt) ||
    syncedAt < s.completedAt ||
    Date.parse(syncedAt) > Date.now() + 300_000 ||
    !/^[a-f0-9]{64}$/.test(s.manifestHash) ||
    !Number.isSafeInteger(s.sourceRows) ||
    s.sourceRows < 0 ||
    s.sourceRows > 2_000_000 ||
    !Number.isSafeInteger(s.censusRows) ||
    s.censusRows < 2 ||
    s.censusRows > 2_000_000 ||
    !Array.isArray(s.controls) ||
    s.controls.length !== 16
  )
    kyHold("stored_source_facts");
  const urls = KY_REPORTED_DATES.flatMap((d) => kentuckyReportedUrls(kind, d));
  let size = 0,
    previous = -Infinity,
    generation = "";
  for (const [i, c] of s.controls.entries()) {
    const m =
      /^(generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/(\d{4})\.raw$/.exec(
        c?.file ?? "",
      );
    if (
      !m ||
      (i && m[1] !== generation) ||
      m[2] !== String(i + 1).padStart(4, "0") ||
      c.url !== urls[i] ||
      c.status !== 200 ||
      !/^[a-f0-9]{64}$/.test(c.sha256) ||
      !Number.isSafeInteger(c.bytes) ||
      c.bytes < 1 ||
      c.bytes > 32 * 1024 * 1024 ||
      !iso(c.startedAt) ||
      !iso(c.completedAt) ||
      Date.parse(c.startedAt) < previous ||
      c.completedAt < c.startedAt
    )
      kyHold("stored_source_controls");
    size = kyAdd(size, c.bytes);
    generation = m[1]!;
    previous = Date.parse(c.completedAt);
  }
  if (
    size !== s.byteSize ||
    size > 160 * 1024 * 1024 ||
    s.controls[0]!.startedAt !== s.retrievedAt ||
    s.controls.at(-1)!.completedAt !== s.completedAt
  )
    kyHold("stored_source_clocks_or_bytes");
}
export function validateKentuckyReportedClosure(
  a: KentuckyReportedAggregation,
  kind: KentuckyReportedKind,
): void {
  const nonnegative = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (
    !a ||
    ![
      a.totalCents,
      a.supportCents,
      a.opposeCents,
      a.sourceRows,
      a.censusRows,
      a.matchedRows,
      a.includedRows,
      a.excludedRows,
      a.zeroNetRows,
    ].every(nonnegative) ||
    a.censusRows < 2 ||
    a.includedRows > a.matchedRows ||
    a.matchedRows > a.sourceRows ||
    a.includedRows + a.excludedRows !== a.sourceRows ||
    a.zeroNetRows > a.includedRows ||
    !Array.isArray(a.groups)
  )
    kyHold("stored_aggregation_counts");
  let total = 0,
    support = 0,
    oppose = 0,
    occurrences = a.zeroNetRows;
  const seen = new Set<string>();
  for (const g of a.groups) {
    if (
      !g ||
      ![g.key, g.name, g.sourceClass].every(
        (x) =>
          typeof x === "string" &&
          x.trim() === x &&
          x !== "" &&
          !/[\u0000-\u001f\u007f]/.test(x),
      ) ||
      seen.has(g.key) ||
      !nonnegative(g.cents) ||
      g.cents === 0 ||
      !nonnegative(g.occurrences) ||
      g.occurrences === 0 ||
      !(kind === "committee"
        ? g.stance === "direct"
        : ["support", "oppose"].includes(g.stance))
    )
      kyHold("stored_group");
    let tuple: unknown;
    try {
      tuple = JSON.parse(g.key);
    } catch {
      kyHold("stored_group_key");
    }
    if (
      !Array.isArray(tuple) ||
      g.name !== kyText(g.name) ||
      (kind === "committee"
        ? tuple.length !== 7 ||
          tuple[0] !== g.sourceClass ||
          !isKentuckyReportedCommitteeClass(g.sourceClass) ||
          tuple[1] !== g.name.toUpperCase() ||
          tuple
            .slice(2)
            .some((x) => typeof x !== "string" || x !== kyText(x).toUpperCase())
        : tuple.length !== 2 ||
          tuple[0] !== g.name.toUpperCase() ||
          tuple[1] !== g.stance ||
          g.sourceClass !== "reported independent spender")
    )
      kyHold("stored_group_identity");
    seen.add(g.key);
    total = kyAdd(total, g.cents);
    occurrences = kyAdd(occurrences, g.occurrences);
    if (g.stance === "support") support = kyAdd(support, g.cents);
    if (g.stance === "oppose") oppose = kyAdd(oppose, g.cents);
  }
  if (
    total !== a.totalCents ||
    support !== a.supportCents ||
    oppose !== a.opposeCents ||
    occurrences !== a.includedRows ||
    (kind === "ie" && kyAdd(support, oppose) !== total)
  )
    kyHold("stored_group_closure");
}
const where = "link_id=$1::uuid AND election_year=2026 AND component=$2";
export async function writeKentuckyReportedComponent(input: {
  db: Pick<Pool, "connect">;
  receiver: KentuckyReportedReceiver;
  source: KentuckyReportedPacket;
  now?: Date;
}): Promise<{ groups: number; idempotent: boolean }> {
  const { receiver, source } = input,
    now = input.now ?? new Date();
  if (!isKentuckyReportedPacket(source) || !Number.isFinite(now.getTime()))
    kyHold("unverified_source");
  const a = aggregateKentuckyReported(receiver, source),
    facts = kentuckyReportedSourceFacts(source);
  validateKentuckyReportedStoredFacts(facts, source.kind, now.toISOString());
  validateKentuckyReportedClosure(a, source.kind);
  const { groups, ...controls } = a,
    client = await input.db.connect(),
    key = [receiver.linkId, source.kind];
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await lockKentuckyReportedReceiver(client, receiver);
    const prior = (
      await client.query<Row>(
        `SELECT * FROM public.ky_reported_finance_components WHERE ${where} FOR UPDATE`,
        key,
      )
    ).rows;
    if (prior.length) {
      const old = prior[0]!,
        clock = new Date(old.source_retrieved_at).toISOString();
      if (clock > source.retrievedAt) kyHold("older_source");
      if (clock === source.retrievedAt) {
        const stored = (
          await client.query<KentuckyReportedGroup>(
            `SELECT group_key key,reported_name name,source_class "sourceClass",stance,amount_cents::float8 cents,occurrence_count occurrences FROM public.ky_reported_finance_groups WHERE ${where} ORDER BY group_key`,
            key,
          )
        ).rows;
        if (
          kyCanonical(old.receiver_context) !== kyCanonical(receiver) ||
          kyCanonical(old.source_facts) !== kyCanonical(facts) ||
          kyCanonical(old.aggregation_controls) !== kyCanonical(controls) ||
          kyCanonical(
            [...stored].sort((x, y) => x.key.localeCompare(y.key)),
          ) !== kyCanonical(groups)
        )
          kyHold("equal_source_conflict");
        // Replays preserve the original observation and publication clocks.
        await client.query("COMMIT");
        begun = false;
        return { groups: groups.length, idempotent: true };
      }
    }
    await client.query(
      `INSERT INTO public.ky_reported_finance_components
      (link_id,election_year,component,candidate_id,election_id,receiver_context,source_facts,aggregation_controls,source_retrieved_at,last_synced_at)
      VALUES ($1,2026,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
      ON CONFLICT(link_id,election_year,component) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
        receiver_context=EXCLUDED.receiver_context,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,
        source_retrieved_at=EXCLUDED.source_retrieved_at,last_synced_at=EXCLUDED.last_synced_at`,
      [
        ...key,
        receiver.candidateId,
        receiver.electionId,
        JSON.stringify(receiver),
        JSON.stringify(facts),
        JSON.stringify(controls),
        source.retrievedAt,
        now.toISOString(),
      ],
    );
    await client.query(
      `DELETE FROM public.ky_reported_finance_groups WHERE ${where}`,
      key,
    );
    if (groups.length)
      await client.query(
        `INSERT INTO public.ky_reported_finance_groups(link_id,election_year,component,group_key,reported_name,source_class,stance,amount_cents,occurrence_count)
      SELECT $1::uuid,2026,$2,x.key,x.name,x."sourceClass",x.stance,x.cents,x.occurrences
      FROM jsonb_to_recordset($3::jsonb) AS x(key text,name text,"sourceClass" text,stance text,cents bigint,occurrences integer)`,
        [...key, JSON.stringify(groups)],
      );
    await client.query("COMMIT");
    begun = false;
    return { groups: groups.length, idempotent: false };
  } catch (e) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

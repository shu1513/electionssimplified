import type { Pool, PoolClient } from "pg";
import { resolveNorthDakotaCandidateCommittee } from "./northDakotaCandidateCommitteeResolver.js";
import { NORTH_DAKOTA_FINANCE_ELIGIBLE_OFFICE_KEYS, northDakotaEligibleOfficeForRace } from "./northDakotaFinanceEligibleOffices.js";
import { aggregateNorthDakotaOutsideSpending, normalizeNorthDakotaIeTargetName, resolveNorthDakotaIeTargetName } from "./northDakotaOutsideSpendingAggregator.js";
import { aggregateNorthDakotaReportedCommittees, ndAdd, ndCommitteeClass, ndHold, ndLiteral } from "./northDakotaReportedAggregation.js";
import { isNorthDakotaReportedPacket, ND_REPORTED_REVISION, ndCanonical, type NorthDakotaReportedKind, type NorthDakotaReportedPacket } from "./northDakotaReportedSource.js";

export type NorthDakotaReportedReceiver = {
  linkId: string; candidateId: string; electionId: string; electionYear: number; electionDate: string;
  candidateName: string; officeScope: string; canonicalOffice: string; canonicalDistrict: string | null;
  entityId: string; committeeName: string; linkSource: string; linkOffice: string; linkDistrict: string | null;
};
export const ND_REPORTED_RECEIVER_SELECT = `SELECT l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
  l.election_year "electionYear",e.election_date::text "electionDate",
  COALESCE(NULLIF(trim(c.display_name),''),NULLIF(trim(c.first_name||' '||c.last_name),'')) "candidateName",
  o.scope "officeScope",o.canonical_name "canonicalOffice",
  CASE WHEN o.scope='statewide' THEN NULL WHEN d.district_type IN ('state_lower','state_upper') THEN
    NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') END "canonicalDistrict",
  l.committee_id "entityId",l.committee_name "committeeName",l.link_source "linkSource",l.office_name "linkOffice",l.district "linkDistrict"
  FROM public.nd_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
  JOIN public.candidate_elections ce ON ce.candidate_id=c.id AND ce.election_id=l.election_id
  JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
  WHERE l.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost')
    AND (SELECT count(*) FROM public.nd_candidate_finance_links a WHERE a.candidate_id=l.candidate_id AND a.election_id=l.election_id AND a.link_status='active')=1
    AND d.state='ND' AND e.race_type='office' AND e.election_stage='general' AND l.election_year=2026 AND e.election_date='2026-11-03'::date
    AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
export const ndReportedOfficeKeys = [...NORTH_DAKOTA_FINANCE_ELIGIBLE_OFFICE_KEYS];
export async function listNorthDakotaReportedReceivers(db: Pick<Pool, "query">): Promise<NorthDakotaReportedReceiver[]> {
  const rows = (await db.query<NorthDakotaReportedReceiver>(ND_REPORTED_RECEIVER_SELECT + " ORDER BY l.id", [ndReportedOfficeKeys])).rows;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.entityId, (counts.get(r.entityId) ?? 0) + 1);
  return rows.filter(r => counts.get(r.entityId) === 1);
}
export async function lockNorthDakotaReportedReceiver(db: PoolClient, receiver: NorthDakotaReportedReceiver): Promise<void> {
  const links = (await db.query(`SELECT id::text FROM public.nd_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_status='active' ORDER BY id FOR UPDATE`, [receiver.candidateId, receiver.electionId])).rows;
  const rows = (await db.query<NorthDakotaReportedReceiver>(ND_REPORTED_RECEIVER_SELECT + " AND l.candidate_id=$2::uuid AND l.election_id=$3::uuid FOR UPDATE OF l,c,ce,e,d,o", [ndReportedOfficeKeys, receiver.candidateId, receiver.electionId])).rows;
  if (links.length !== 1 || links[0]!.id !== receiver.linkId || rows.length !== 1 || ndCanonical(rows[0]) !== ndCanonical(receiver)) ndHold("canonical_receiver_changed");
  if (!(await listNorthDakotaReportedReceivers(db)).some(r => ndCanonical(r) === ndCanonical(receiver))) ndHold("canonical_receiving_identity_ambiguous");
}
export type NorthDakotaReportedGroup = { key: string; name: string; sourceClass: string; stance: "direct" | "support" | "oppose"; cents: number; occurrences: number };
export type NorthDakotaReportedAggregation = {
  totalCents: number; supportCents: number; opposeCents: number; sourceRows: number; includedRows: number; groups: NorthDakotaReportedGroup[];
};
export function aggregateNorthDakotaReported(receiver: NorthDakotaReportedReceiver, source: NorthDakotaReportedPacket): NorthDakotaReportedAggregation {
  if (!isNorthDakotaReportedPacket(source) || receiver.electionYear !== 2026 || receiver.electionDate !== "2026-11-03") ndHold("unverified_source_or_election");
  const office = northDakotaEligibleOfficeForRace({ officeScope: receiver.officeScope, officeCanonicalName: receiver.canonicalOffice });
  if (!office || (office.districted && !/^[1-9]\d*$/.test(receiver.canonicalDistrict ?? ""))) ndHold("canonical_office");
  const match = resolveNorthDakotaCandidateCommittee({ candidateName: receiver.candidateName, electionYear: 2026, office,
    districtNumber: office.districted ? Number(receiver.canonicalDistrict) : null, committees: source.registry });
  if (match.status !== "matched" || match.entityId !== receiver.entityId || ndLiteral(match.committeeName) !== ndLiteral(receiver.committeeName)) ndHold("source_receiving_identity");
  if (source.kind === "committee") {
    const a = aggregateNorthDakotaReportedCommittees({ entityId: receiver.entityId, windowStart: source.windowStart, windowEnd: source.windowEnd, rows: source.contributions });
    return { totalCents: a.cents, supportCents: 0, opposeCents: 0, sourceRows: source.sourceRows, includedRows: a.occurrences, groups: a.groups.map(g => ({ ...g, stance: "direct" })) };
  }
  const target = resolveNorthDakotaIeTargetName({ entityId: receiver.entityId, electionYear: 2026, committees: source.registry });
  if (target.status !== "resolved") ndHold("ambiguous_ie_target");
  let a: ReturnType<typeof aggregateNorthDakotaOutsideSpending>;
  try { a = aggregateNorthDakotaOutsideSpending({ targetName: target.targetName, electionYear: 2026, rows: source.ie }); }
  catch { ndHold("ie_candidate_control"); }
  const groups: NorthDakotaReportedGroup[] = a.groups.map(g => ({
    key: JSON.stringify([g.entityId, g.supportOppose]), name: g.committeeName, sourceClass: "reported independent spender", stance: g.supportOppose,
    cents: Math.round(g.amount * 100), occurrences: source.ie.filter(r => r.entityID === g.entityId && r.electionYear === 2026 && r.candidateNameAssocation !== null && normalizeNorthDakotaIeTargetName(r.candidateNameAssocation) === target.targetName && r.stanceDescription?.toLowerCase() === g.supportOppose).length,
  }));
  const supportCents = Math.round(a.supportTotal * 100), opposeCents = Math.round(a.opposeTotal * 100);
  return { totalCents: ndAdd(supportCents, opposeCents), supportCents, opposeCents, sourceRows: source.sourceRows, includedRows: a.includedRowCount, groups };
}
export function validateNorthDakotaReportedClosure(a: NorthDakotaReportedAggregation, kind: NorthDakotaReportedKind): void {
  const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!a || !Number.isSafeInteger(a.totalCents) || ![a.supportCents, a.opposeCents, a.sourceRows, a.includedRows].every(nonnegative) || a.includedRows > a.sourceRows || !Array.isArray(a.groups)) ndHold("stored_aggregation_counts");
  let total = 0, support = 0, oppose = 0, occurrences = 0; const seen = new Set<string>();
  for (const g of a.groups) {
    if (!g || ![g.key, g.name, g.sourceClass].every(v => typeof v === "string" && v.trim() === v && v !== "" && !/[\u0000-\u001f\u007f]/.test(v)) || seen.has(g.key) || !Number.isSafeInteger(g.cents) || !nonnegative(g.occurrences) || !g.occurrences) ndHold("stored_group");
    let key: unknown; try { key = JSON.parse(g.key); } catch { ndHold("stored_group_key"); }
    if (!Array.isArray(key) || key.length !== 2 || (kind === "committee"
      ? g.stance !== "direct" || !ndCommitteeClass(g.sourceClass) || key[0] !== g.sourceClass || key[1] !== ndLiteral(g.name)
      : !["support", "oppose"].includes(g.stance) || g.cents <= 0 || g.sourceClass !== "reported independent spender" || !/^\d{10}$/.test(key[0]) || key[1] !== g.stance)) ndHold("stored_group_identity");
    seen.add(g.key); total = ndAdd(total, g.cents); occurrences = ndAdd(occurrences, g.occurrences);
    if (g.stance === "support") support = ndAdd(support, g.cents); if (g.stance === "oppose") oppose = ndAdd(oppose, g.cents);
  }
  if (total !== a.totalCents || occurrences !== a.includedRows || support !== a.supportCents || oppose !== a.opposeCents || (kind === "ie" && ndAdd(support, oppose) !== total)) ndHold("stored_group_closure");
}
export function northDakotaReportedSourceFacts(s: NorthDakotaReportedPacket) {
  return { revision: ND_REPORTED_REVISION, kind: s.kind, electionYear: s.electionYear, sourceAt: s.sourceAt, acquisitionStartedAt: s.acquisitionStartedAt,
    sourceHash: s.sourceHash, sourceRows: s.sourceRows, sourceCents: s.sourceCents, excludedIeRows: s.excludedIeRows, excludedIeCents: s.excludedIeCents,
    registryRows: s.registry.length, windowStart: s.windowStart, windowEnd: s.windowEnd };
}
export function validateNorthDakotaReportedFacts(value: unknown, kind: NorthDakotaReportedKind, syncedAt: string): void {
  const s = value as ReturnType<typeof northDakotaReportedSourceFacts>;
  const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  if (!s || s.revision !== ND_REPORTED_REVISION || s.kind !== kind || s.electionYear !== 2026 || !iso(s.sourceAt) || !iso(s.acquisitionStartedAt) || !iso(syncedAt) || s.sourceAt < s.acquisitionStartedAt || syncedAt < s.sourceAt || Date.parse(syncedAt) > Date.now() + 300000 || !/^[a-f0-9]{64}$/.test(s.sourceHash) || s.windowStart !== "2025-01-01" || s.windowEnd !== "2026-12-31" || ![s.sourceRows, s.excludedIeRows, s.registryRows].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 2000000) || s.registryRows < 1 || s.excludedIeRows > s.sourceRows || !Number.isSafeInteger(s.sourceCents) || !Number.isSafeInteger(s.excludedIeCents) || (kind === "committee" && (s.excludedIeRows !== 0 || s.excludedIeCents !== 0))) ndHold("stored_source_facts");
}
const where = "link_id=$1::uuid AND election_year=2026 AND component=$2";
export async function writeNorthDakotaReportedComponent(input: {
  db: Pick<Pool, "connect">; receiver: NorthDakotaReportedReceiver; source: NorthDakotaReportedPacket; now?: Date;
}): Promise<{ groups: number; idempotent: boolean }> {
  const { receiver, source } = input, now = input.now ?? new Date();
  if (!isNorthDakotaReportedPacket(source) || !Number.isFinite(now.getTime())) ndHold("unverified_source");
  const a = aggregateNorthDakotaReported(receiver, source), facts = northDakotaReportedSourceFacts(source);
  validateNorthDakotaReportedFacts(facts, source.kind, now.toISOString()); validateNorthDakotaReportedClosure(a, source.kind);
  const { groups, ...controls } = a, client = await input.db.connect(), key = [receiver.linkId, source.kind];
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true; await lockNorthDakotaReportedReceiver(client, receiver);
    const prior = (await client.query(`SELECT * FROM public.nd_reported_finance_components WHERE ${where} FOR UPDATE`, key)).rows;
    if (prior.length) {
      const old = prior[0]!, clock = new Date(old.source_observed_at).toISOString();
      if (clock > source.sourceAt) ndHold("older_source");
      if (clock === source.sourceAt) {
        const stored = (await client.query<NorthDakotaReportedGroup>(`SELECT group_key key,reported_name name,source_class "sourceClass",stance,amount_cents::float8 cents,occurrence_count occurrences FROM public.nd_reported_finance_groups WHERE ${where} ORDER BY group_key`, key)).rows;
        if (ndCanonical(old.receiver_context) !== ndCanonical(receiver) || ndCanonical(old.source_facts) !== ndCanonical(facts) || ndCanonical(old.aggregation_controls) !== ndCanonical(controls) || ndCanonical([...stored].sort((a, b) => a.key.localeCompare(b.key))) !== ndCanonical([...groups].sort((a, b) => a.key.localeCompare(b.key)))) ndHold("equal_source_conflict");
        await client.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: true };
      }
    }
    await client.query(`INSERT INTO public.nd_reported_finance_components (link_id,election_year,component,candidate_id,election_id,receiver_context,source_facts,aggregation_controls,source_observed_at,last_synced_at)
      VALUES ($1,2026,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
      ON CONFLICT(link_id,election_year,component) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
      receiver_context=EXCLUDED.receiver_context,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,last_synced_at=EXCLUDED.last_synced_at`,
    [...key, receiver.candidateId, receiver.electionId, JSON.stringify(receiver), JSON.stringify(facts), JSON.stringify(controls), source.sourceAt, now.toISOString()]);
    await client.query(`DELETE FROM public.nd_reported_finance_groups WHERE ${where}`, key);
    if (groups.length) await client.query(`INSERT INTO public.nd_reported_finance_groups(link_id,election_year,component,group_key,reported_name,source_class,stance,amount_cents,occurrence_count)
      SELECT $1::uuid,2026,$2,x.key,x.name,x."sourceClass",x.stance,x.cents,x.occurrences FROM jsonb_to_recordset($3::jsonb) AS x(key text,name text,"sourceClass" text,stance text,cents bigint,occurrences integer)`, [...key, JSON.stringify(groups)]);
    await client.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: false };
  } catch (e) { if (begun) await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

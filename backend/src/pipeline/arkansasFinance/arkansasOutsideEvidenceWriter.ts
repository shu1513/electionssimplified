import type { Pool, PoolClient } from "pg";
import type { ArkansasFinanceLinkInput } from "./arkansasFinanceWriter.js";
import {
  mergeArkansasVerifiedOutsideEvidence, validateArkansasVerifiedOutsideEvidence,
  type ArkansasVerifiedOutsideEvidence,
} from "./arkansasVerifiedOutsideEvidence.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type Group = { filing_entity_id: string; filer_name: string; support_oppose: "support" | "oppose";
  amount: number; source_url: string };
function groups(evidence: readonly unknown[], link: ArkansasFinanceLinkInput): Group[] {
  const result = new Map<string, Group>(), expenses = new Set<string>();
  for (const value of evidence) {
    const e = validateArkansasVerifiedOutsideEvidence(value, link);
    for (const allocation of e.allocations) {
      const expenseKey = `${e.payer.entityId}:${allocation.expenseGuid}`;
      if (expenses.has(expenseKey)) throw new Error("Repeated Arkansas outside expense across payer registrations");
      expenses.add(expenseKey);
      const key = `${e.payer.entityId}:${allocation.stance}`;
      const previous = result.get(key);
      if (previous && previous.filer_name !== e.payer.sourceName) throw new Error("Arkansas outside payer name changed across registrations");
      const cents = Math.round((previous?.amount ?? 0) * 100) + allocation.amountCents;
      if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("Unsafe Arkansas outside group amount");
      result.set(key, { filing_entity_id: e.payer.entityId, filer_name: e.payer.sourceName,
        support_oppose: allocation.stance, amount: cents / 100, source_url: e.sourceUrl });
    }
  }
  return [...result.values()].sort((a, b) => a.filing_entity_id.localeCompare(b.filing_entity_id)
    || a.support_oppose.localeCompare(b.support_oppose));
}
function retained(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unknown Arkansas outside provenance");
  const p = value as Record<string, unknown>;
  if (p.version !== 1 || p.scope !== "positive_current_original_report_allocations" || !Array.isArray(p.evidence)) {
    throw new Error("Unsupported Arkansas outside provenance");
  }
  return p.evidence;
}

/** Caller holds the enclosing snapshot transaction, summary row and filer/year lock. */
export async function writeArkansasOutsideEvidence(input: {
  db: Queryable; linkId: string; link: ArkansasFinanceLinkInput; syncedAt: Date;
  prior: unknown; incoming: readonly ArkansasVerifiedOutsideEvidence[];
}): Promise<{ groupsWritten: number; diagnostics: readonly string[] }> {
  if (!input.incoming.length) return { groupsWritten: 0, diagnostics: [] };
  const diagnostics: string[] = [];
  let combined: readonly unknown[], next: Group[], previousGroups: Group[];
  try {
    const prior = retained(input.prior);
    previousGroups = groups(prior, input.link);
    const merged = mergeArkansasVerifiedOutsideEvidence({ link: input.link, retained: prior, incoming: input.incoming });
    diagnostics.push(...merged.diagnostics);
    if (!merged.acceptedRegistrationGuids.length) return { groupsWritten: 0, diagnostics };
    combined = merged.evidence;
    const accepted = new Set(merged.acceptedRegistrationGuids);
    const acceptedPayers = new Set(combined.map(value => validateArkansasVerifiedOutsideEvidence(value, input.link))
      .filter(value => accepted.has(value.payer.registrationGuid)).map(value => value.payer.entityId));
    next = groups(combined, input.link).filter(group => acceptedPayers.has(group.filing_entity_id));
  } catch (error) {
    return { groupsWritten: 0, diagnostics: [...diagnostics,
      "Outside snapshot preserved: " + (error instanceof Error ? error.message : String(error))] };
  }
  // Database failures must escape and roll back the enclosing transaction.
  const existing = await input.db.query<{ filing_entity_id: string; filer_name: string;
    support_oppose: string; amount: string | number }>(`
    SELECT filing_entity_id, filer_name, support_oppose, amount
    FROM public.ar_candidate_finance_outside_groups
    WHERE link_id = $1::uuid AND election_year = $2::integer FOR UPDATE`, [input.linkId, input.link.electionYear]);
  const matches = existing.rows.length === previousGroups.length && existing.rows.every(row =>
    previousGroups.some(group => group.filing_entity_id === row.filing_entity_id
      && group.filer_name === row.filer_name && group.support_oppose === row.support_oppose
      && Math.abs(Number(row.amount) * 100 - Math.round(group.amount * 100)) < 1e-7));
  if (!matches) return { groupsWritten: 0, diagnostics: [...diagnostics,
    "Outside snapshot preserved: stored groups lack matching scoped authority"] };
  // Original-only accepted evidence is append-only. Retained groups and other
  // outside breakdowns remain; a partial acquisition never clears a direction.
  await input.db.query(`INSERT INTO public.ar_candidate_finance_outside_groups
    (link_id, election_year, filing_entity_id, filer_name, support_oppose, amount, source_url, last_synced_at, updated_at)
    SELECT $1::uuid, $2::integer, g.filing_entity_id, g.filer_name, g.support_oppose,
      g.amount, g.source_url, $4::timestamptz, $4::timestamptz
    FROM jsonb_to_recordset($3::jsonb) AS g(filing_entity_id text, filer_name text, support_oppose text, amount numeric, source_url text)
    ON CONFLICT (link_id, election_year, filing_entity_id, support_oppose) DO UPDATE SET
      filer_name = EXCLUDED.filer_name, amount = EXCLUDED.amount, source_url = EXCLUDED.source_url,
      last_synced_at = EXCLUDED.last_synced_at, updated_at = EXCLUDED.updated_at`,
  [input.linkId, input.link.electionYear, JSON.stringify(next), input.syncedAt]);
  await input.db.query(`UPDATE public.ar_candidate_finance_summaries SET outside_report_provenance = $3::jsonb
    WHERE link_id = $1::uuid AND election_year = $2::integer`, [input.linkId, input.link.electionYear,
    JSON.stringify({ version: 1, scope: "positive_current_original_report_allocations", evidence: combined })]);
  return { groupsWritten: next.length, diagnostics };
}

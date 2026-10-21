import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isKansasCommitteeReceiptsEnabled } from "../../config/featureFlags.js";
import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import { KANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./kansasFinanceEligibleOffices.js";
import {
  parseKansasFilerKey,
  normalizeKansasNameForStorage,
} from "./kansasFinanceWriter.js";
import {
  acquireKansasCommitteeReceipts,
  assertQualifiedKansasCommitteePacket,
  kansasReportedNameKey,
  KANSAS_COMMITTEE_SOURCE_URL,
  type KansasCommitteePacket,
  type KansasCommitteeGroup,
} from "./kansasCommitteeReceiptSource.js";
import type { KansasCandidateFinanceDueRow } from "./kansasCandidateFinanceDueList.js";
import {
  candidateElectionKey,
  type BallotLookupFinanceSummary,
  type StateFinanceSummaryRequest,
} from "../address/ballotLookupFinanceShared.js";
import {
  classifyPacInterest,
  PAC_INTERESTS_NOT_LISTED,
  pacInterestDisplayName,
  UNCLASSIFIED_PAC_INTEREST,
} from "../finance/pacInterestClassifier.js";
type DB = Pick<Pool | PoolClient, "query">;
const fail = (): never => {
  throw new Error("kansas_committee_component_held");
};
const check = (v: unknown): void => {
  if (!v) fail();
};
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const add = (a: number, b: number): number => {
  const n = a + b;
  check(Number.isSafeInteger(n));
  return n;
};
const count = (v: unknown): v is number =>
  Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647;
const cents = (v: unknown): number => {
  check(typeof v === "string" && /^\d+$/.test(v));
  const n = Number(v);
  check(Number.isSafeInteger(n));
  return n;
};
const date = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
const intent = (r: KansasCandidateFinanceDueRow) =>
  hash([
    r.candidateId,
    r.electionId,
    r.electionYear,
    r.candidateName,
    r.officeScope,
    r.officeName,
    r.district,
    r.committeeId,
    r.committeeName,
    r.linkSource,
    r.sourceUrl,
  ]);
export const listDueKansasCommitteeReceipts =
  createStandardStateFinanceDueListQuery<KansasCandidateFinanceDueRow>({
    state: "KS",
    tables: {
      links: "ks_candidate_finance_links",
      summaries: "ks_candidate_finance_committee_sources",
    },
    eligibleOfficeKeys: [...KANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS],
    linkColumns: ["committee_id", "committee_name", "link_source"],
    mapRow: (r) => ({
      candidateId: r.candidate_id,
      electionId: r.election_id,
      electionYear: r.election_year,
      candidateName: r.candidate_name,
      officeScope: r.office_scope,
      officeName: r.office_name,
      district: r.district,
      committeeId: r.committee_id as string,
      committeeName: r.committee_name as string,
      linkSource: r.link_source as KansasCandidateFinanceDueRow["linkSource"],
      sourceUrl: r.source_url,
      lastSyncedAt: r.last_synced_at,
    }),
  });
// Shared current-intent projection. Canonical rows are rechecked at write/read;
// old links and changed rosters must not lend ownership to stored donor names.
const CONTEXT = `SELECT link.id::text AS link_id,link.candidate_id::text AS candidate_id,link.election_id::text AS election_id,
 link.election_year,link.committee_id,link.committee_name,link.link_source,link.source_url,link.district,
 COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),''),link.candidate_name_normalized) AS candidate_name,
 link.candidate_name_normalized,link.office_name,office.scope AS office_scope,office.canonical_name AS canonical_office,
 district.geoid_compact,district.district_type
 FROM public.ks_candidate_finance_links link JOIN public.candidates candidate ON candidate.id=link.candidate_id
 JOIN public.candidate_elections roster ON roster.candidate_id=link.candidate_id AND roster.election_id=link.election_id
 JOIN public.elections election ON election.id=link.election_id JOIN public.offices office ON office.id=election.office_id
 JOIN public.districts district ON district.id=election.district_id
 WHERE link.link_status='active' AND candidate.deleted_at IS NULL AND roster.status NOT IN ('withdrawn','lost')
 AND district.state='KS' AND election.race_type='office' AND EXTRACT(YEAR FROM election.election_date)::integer=link.election_year
 AND (office.scope||'::'||office.canonical_name)=ANY($1::text[])`;
type Context = {
  link_id: string;
  candidate_id: string;
  election_id: string;
  election_year: number;
  committee_id: string;
  committee_name: string;
  link_source: KansasCandidateFinanceDueRow["linkSource"];
  source_url: string | null;
  district: string | null;
  candidate_name: string;
  candidate_name_normalized: string;
  office_name: string;
  office_scope: string;
  canonical_office: string;
  geoid_compact: string;
  district_type: string;
};
function targetFromContext(r: Context): KansasCandidateFinanceDueRow {
  check(
    r.office_name === r.canonical_office &&
      normalizeKansasNameForStorage(r.candidate_name) ===
        r.candidate_name_normalized,
  );
  const recipe = parseKansasFilerKey(r.committee_id);
  if (recipe.districtNumber !== null)
    check(
      ["state_lower", "state_upper"].includes(r.office_scope) &&
        r.district_type === r.office_scope &&
        /^20\d{3}$/.test(r.geoid_compact) &&
        Number(r.geoid_compact.slice(2)) === recipe.districtNumber,
    );
  return {
    candidateId: r.candidate_id,
    electionId: r.election_id,
    electionYear: r.election_year,
    candidateName: r.candidate_name,
    officeScope: r.office_scope,
    officeName: r.office_name,
    district: r.district,
    committeeId: r.committee_id,
    committeeName: r.committee_name,
    linkSource: r.link_source,
    sourceUrl: r.source_url,
    lastSyncedAt: null,
  };
}
type Controls = Pick<
  KansasCommitteePacket,
  | "cycleStart"
  | "cycleEnd"
  | "coveredThrough"
  | "sourceCashRows"
  | "unmatchedGiftRows"
  | "excludedNonGiftRows"
  | "zeroGiftRows"
>;
function controls(packet: KansasCommitteePacket): Controls {
  const {
    cycleStart,
    cycleEnd,
    coveredThrough,
    sourceCashRows,
    unmatchedGiftRows,
    excludedNonGiftRows,
    zeroGiftRows,
  } = packet;
  return {
    cycleStart,
    cycleEnd,
    coveredThrough,
    sourceCashRows,
    unmatchedGiftRows,
    excludedNonGiftRows,
    zeroGiftRows,
  };
}
export async function writeKansasCommitteeReceipts(input: {
  db: Pick<Pool, "connect">;
  packet: KansasCommitteePacket;
  now: Date;
}): Promise<void> {
  check(isKansasCommitteeReceiptsEnabled());
  assertQualifiedKansasCommitteePacket(input.packet);
  const p = input.packet;
  check(
    Number.isFinite(input.now.getTime()) &&
      Date.parse(p.observedAt) <= input.now.getTime() &&
      input.now.getTime() - Date.parse(p.observedAt) <= 36 * 3600_000,
  );
  const db = await input.db.connect();
  try {
    await db.query("BEGIN");
    const live = await db.query<Context>(
      CONTEXT +
        ` AND link.candidate_id=$2::uuid AND link.election_id=$3::uuid AND link.committee_id=$4
      FOR UPDATE OF link,candidate,roster,election,office,district`,
      [
        [...KANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS],
        p.target.candidateId,
        p.target.electionId,
        p.target.committeeId,
      ],
    );
    check(live.rows.length === 1);
    const row = live.rows[0]!;
    check(intent(targetFromContext(row)) === intent(p.target));
    const ownership = await db.query<{ owners: string }>(
      `SELECT count(DISTINCT candidate_id)::text AS owners FROM public.ks_candidate_finance_links
      WHERE committee_id=$1 AND election_year=$2 AND link_status='active'`,
      [p.target.committeeId, p.target.electionYear],
    );
    check(ownership.rows[0]?.owners === "1");
    const prior = await db.query<{ last_synced_at: Date }>(
      `SELECT last_synced_at FROM public.ks_candidate_finance_committee_sources WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE`,
      [row.link_id, p.target.electionYear],
    );
    check(
      prior.rows.every(
        (r) => new Date(r.last_synced_at).getTime() <= Date.parse(p.observedAt),
      ),
    );
    await db.query(
      `INSERT INTO public.ks_candidate_finance_committee_sources
      (link_id,election_year,intent_sha256,source_url,last_synced_at,written_at,total_cents,group_count,receipt_count,controls,provenance)
      VALUES($1::uuid,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::bigint,$8,$9,$10::jsonb,$11::jsonb)
      ON CONFLICT(link_id,election_year) DO UPDATE SET intent_sha256=EXCLUDED.intent_sha256,source_url=EXCLUDED.source_url,
      last_synced_at=EXCLUDED.last_synced_at,written_at=EXCLUDED.written_at,total_cents=EXCLUDED.total_cents,
      group_count=EXCLUDED.group_count,receipt_count=EXCLUDED.receipt_count,controls=EXCLUDED.controls,provenance=EXCLUDED.provenance`,
      [
        row.link_id,
        p.target.electionYear,
        intent(p.target),
        KANSAS_COMMITTEE_SOURCE_URL,
        p.observedAt,
        input.now.toISOString(),
        String(p.totalCents),
        p.groups.length,
        p.receiptCount,
        JSON.stringify(controls(p)),
        JSON.stringify(p.provenance),
      ],
    );
    await db.query(
      `DELETE FROM public.ks_candidate_finance_committee_receipts WHERE link_id=$1::uuid AND election_year=$2`,
      [row.link_id, p.target.electionYear],
    );
    for (const g of p.groups)
      await db.query(
        `INSERT INTO public.ks_candidate_finance_committee_receipts
      (link_id,election_year,reported_name,name_key,amount_cents,receipt_count) VALUES($1::uuid,$2,$3,$4,$5::bigint,$6)`,
        [
          row.link_id,
          p.target.electionYear,
          g.reportedName,
          g.nameKey,
          String(g.amountCents),
          g.receiptCount,
        ],
      );
    await db.query("COMMIT");
  } catch {
    await db.query("ROLLBACK");
    fail();
  } finally {
    db.release();
  }
}
export type KansasCommitteeSyncResult = {
  attempted: number;
  succeeded: number;
  held: number;
  groups: number;
  receipts: number;
};
export async function syncDueKansasCommitteeReceipts(input: {
  db: Pick<Pool, "query" | "connect">;
  now: Date;
  directory?: string;
  candidateId?: string;
  electionYear?: number;
  maxCandidates: number;
  staleAfterDays: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  refresh?: boolean;
  dryRun?: boolean;
}): Promise<KansasCommitteeSyncResult> {
  const out = { attempted: 0, succeeded: 0, held: 0, groups: 0, receipts: 0 };
  if (!isKansasCommitteeReceiptsEnabled()) return out;
  const due = await listDueKansasCommitteeReceipts(input.db, input);
  for (const target of due.rows) {
    out.attempted++;
    try {
      // Missing browser originals hold this component independently. No live
      // challenge response, direct freshness or force switch can invent a zero.
      if (!input.directory) fail();
      const packet = await acquireKansasCommitteeReceipts({
        directory: input.directory!,
        target,
        now: input.now,
      });
      if (!input.dryRun)
        await writeKansasCommitteeReceipts({
          db: input.db,
          packet,
          now: input.now,
        });
      out.succeeded++;
      out.groups += packet.groups.length;
      out.receipts += packet.receiptCount;
    } catch {
      out.held++;
    }
  }
  return out;
}
type Stored = Context & {
  source: {
    intent_sha256: string;
    source_url: string;
    last_synced_at: string;
    written_at: string;
    total_cents: string;
    group_count: number;
    receipt_count: number;
    controls: Controls;
    provenance: KansasCommitteePacket["provenance"];
  } | null;
  groups: {
    reportedName: string;
    nameKey: string;
    amountCents: string;
    receiptCount: number;
  }[];
};
export function validateKansasStoredCommitteeRows(r: Stored): {
  groups: KansasCommitteeGroup[];
  observedAt: string;
  controls: Controls;
} {
  const s = r.source;
  check(s && intent(targetFromContext(r)) === s.intent_sha256);
  if (!s) return fail();
  check(
    s.source_url === KANSAS_COMMITTEE_SOURCE_URL &&
      Number.isFinite(Date.parse(s.last_synced_at)) &&
      Number.isFinite(Date.parse(s.written_at)) &&
      Date.parse(s.last_synced_at) <= Date.parse(s.written_at),
  );
  const c = s.controls;
  check(
    c &&
      date(c.cycleStart) &&
      date(c.cycleEnd) &&
      date(c.coveredThrough) &&
      c.cycleStart <= c.coveredThrough &&
      c.coveredThrough <= c.cycleEnd &&
      Number(c.cycleEnd.slice(0, 4)) === r.election_year,
  );
  check(
    [
      c.sourceCashRows,
      c.unmatchedGiftRows,
      c.excludedNonGiftRows,
      c.zeroGiftRows,
      s.group_count,
      s.receipt_count,
    ].every(count),
  );
  check(
    c.sourceCashRows ===
      c.unmatchedGiftRows +
        c.excludedNonGiftRows +
        c.zeroGiftRows +
        s.receipt_count,
  );
  check(
    Array.isArray(s.provenance) &&
      s.provenance.length > 0 &&
      s.provenance.every(
        (v) =>
          /^[a-f0-9-]+\.json$/.test(v.file) &&
          /^[a-f0-9]{64}$/.test(v.sha256) &&
          Number.isSafeInteger(v.bytes) &&
          v.bytes > 0 &&
          v.url.startsWith("https://sos.ks.gov/elections/cfr_viewer/") &&
          Number.isFinite(Date.parse(v.observedAt)) &&
          Date.parse(v.observedAt) >= Date.parse(s.last_synced_at) &&
          Date.parse(v.observedAt) <= Date.parse(s.written_at),
      ),
  );
  check(Array.isArray(r.groups));
  let amount = 0,
    receipts = 0;
  const seen = new Set<string>();
  const groups = r.groups.map((g) => {
    check(
      typeof g.reportedName === "string" &&
        g.reportedName.trim() === g.reportedName &&
        g.reportedName.length > 0 &&
        !/[\u0000-\u001f\u007f]/.test(g.reportedName) &&
        g.nameKey === kansasReportedNameKey(g.reportedName) &&
        !seen.has(g.nameKey) &&
        count(g.receiptCount) &&
        g.receiptCount > 0,
    );
    seen.add(g.nameKey);
    const n = cents(g.amountCents);
    check(n > 0);
    amount = add(amount, n);
    receipts = add(receipts, g.receiptCount);
    return { ...g, amountCents: n };
  });
  check(
    groups.length === s.group_count &&
      amount === cents(s.total_cents) &&
      receipts === s.receipt_count &&
      (groups.length === 0) === (amount === 0),
  );
  return { groups, observedAt: s.last_synced_at, controls: c };
}
export async function attachKansasCommitteeReceipts(input: {
  db: DB;
  requests: readonly StateFinanceSummaryRequest[];
  summaries: Map<string, BallotLookupFinanceSummary>;
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isKansasCommitteeReceiptsEnabled() || !input.requests.length)
    return input.summaries;
  const contexts = await input.db.query<Context>(
    CONTEXT +
      ` AND (link.candidate_id,link.election_id) IN (SELECT candidate_id,election_id FROM jsonb_to_recordset($2::jsonb) AS x(candidate_id uuid,election_id uuid))`,
    [[...KANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS], JSON.stringify(input.requests)],
  );
  const result = await input.db.query<{
    link_id: string;
    election_year: number;
    source: Stored["source"];
    groups: Stored["groups"];
  }>(
    `SELECT src.link_id::text,src.election_year,
    jsonb_build_object('intent_sha256',src.intent_sha256,'source_url',src.source_url,'last_synced_at',src.last_synced_at::text,'written_at',src.written_at::text,
      'total_cents',src.total_cents::text,'group_count',src.group_count,'receipt_count',src.receipt_count,'controls',src.controls,'provenance',src.provenance) AS source,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('reportedName',g.reported_name,'nameKey',g.name_key,'amountCents',g.amount_cents::text,'receiptCount',g.receipt_count))
      FROM public.ks_candidate_finance_committee_receipts g WHERE g.link_id=src.link_id AND g.election_year=src.election_year),'[]'::jsonb) AS groups
    FROM public.ks_candidate_finance_committee_sources src WHERE src.link_id=ANY($1::uuid[])`,
    [contexts.rows.map((r) => r.link_id)],
  );
  const byCandidate = new Map<string, Context[]>();
  for (const row of contexts.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    byCandidate.set(key, [...(byCandidate.get(key) ?? []), row]);
  }
  const output = new Map(input.summaries);
  for (const [key, rows] of byCandidate) {
    try {
      const all = rows.map((r) => {
        const found = result.rows.filter(
          (s) => s.link_id === r.link_id && s.election_year === r.election_year,
        );
        check(found.length === 1);
        return validateKansasStoredCommitteeRows({ ...r, ...found[0]! });
      });
      check(
        new Set(rows.map((r) => r.committee_id)).size === rows.length &&
          new Set(rows.map((r) => r.election_year)).size === 1,
      );
      check(
        new Set(
          all.map((r) =>
            JSON.stringify([
              r.controls.cycleStart,
              r.controls.cycleEnd,
              r.controls.coveredThrough,
            ]),
          ),
        ).size === 1,
      ); // independent receiving coverage must agree
      const grouped = new Map<string, KansasCommitteeGroup>();
      for (const value of all)
        for (const g of value.groups) {
          const prev = grouped.get(g.nameKey);
          grouped.set(g.nameKey, {
            ...g,
            amountCents: add(prev?.amountCents ?? 0, g.amountCents),
            receiptCount: add(prev?.receiptCount ?? 0, g.receiptCount),
          });
        }
      if (!grouped.size) continue; // No verified match is not evidence of zero PAC money.
      const interests = new Map<
        string,
        {
          cents: number;
          pacs: {
            committee_id: string;
            committee_name: string;
            amount: number;
            source_url: string;
          }[];
        }
      >();
      for (const g of grouped.values()) {
        const proposed = classifyPacInterest({
          committeeName: g.reportedName,
          committeeType: null,
          designation: null,
          organizationType: null,
          connectedOrganization: null,
        }).interestSlug;
        const slug =
          proposed &&
          !(PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(proposed)
            ? proposed
            : UNCLASSIFIED_PAC_INTEREST;
        const bucket = interests.get(slug) ?? { cents: 0, pacs: [] };
        bucket.cents = add(bucket.cents, g.amountCents);
        bucket.pacs.push({
          committee_id: `ks-reported:${g.nameKey}`,
          committee_name: g.reportedName,
          amount: g.amountCents / 100,
          source_url: KANSAS_COMMITTEE_SOURCE_URL,
        });
        interests.set(slug, bucket);
      }
      // Validate candidate totals before any display cap, including cross-interest overflow.
      [...interests.values()].reduce((n, b) => add(n, b.cents), 0);
      const first = rows[0]!,
        oldest = new Date(
          Math.min(...all.map((r) => Date.parse(r.observedAt))),
        ).toISOString(),
        previous = output.get(key);
      check(!previous || previous.cycle === first.election_year);
      const summary: BallotLookupFinanceSummary = previous ?? {
        source: "KANSAS_SOS",
        cycle: first.election_year,
        fec_candidate_id: null,
        controlled_committee_id: rows.length === 1 ? first.committee_id : null,
        last_synced_at: oldest,
        direct_campaign: {
          total_raised: null,
          total_spent: null,
          cash_on_hand: null,
          debts_owed: null,
          top_occupations: [],
          top_employers: [],
          top_industries: [],
          contribution_size_buckets: [],
        },
        outside_spending: {
          support_total: null,
          oppose_total: null,
          top_supporting_groups: [],
          top_opposing_groups: [],
          top_supporting_industries: [],
          top_opposing_industries: [],
        },
        backing_summary: {
          top_direct_donor_occupations: [],
          top_outside_supporting_industries: [],
        },
      };
      const groups = [...interests]
        .map(([interest, b]) => ({
          interest,
          interest_name: pacInterestDisplayName(interest),
          amount: b.cents / 100,
          pac_count: b.pacs.length,
          pacs: b.pacs
            .sort(
              (a, b) =>
                b.amount - a.amount ||
                a.committee_id.localeCompare(b.committee_id),
            )
            .slice(0, 5),
        }))
        .sort(
          (a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest),
        )
        .slice(0, 5);
      output.set(key, {
        ...summary,
        direct_campaign: {
          ...summary.direct_campaign,
          pac_money_by_interest: groups,
          pac_money_basis: "reported_committee_monetary_receipts",
          pac_money_coverage_note: `Itemized cash gifts through ${all[0]!.controls.coveredThrough}; source observed ${oldest.slice(0, 10)}. Includes only names with a native PAC/party filing and matching reported street/unit, city and ZIP5. Portal omits state and ZIP+4; other donors remain unclassified. Excludes loans, refund receipts and in-kind; separate outgoing returns are not netted. Partial coverage, not all money raised; reported identities, not legal PAC identity.`,
        },
      });
    } catch {
      /* Missing/invalid components preserve all prior headline and outside data. */
    }
  }
  return output;
}

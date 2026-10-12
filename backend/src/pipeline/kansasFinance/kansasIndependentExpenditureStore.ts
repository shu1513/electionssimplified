import type { Pool, PoolClient } from "pg";

export type KansasIEDocumentRow = {
  rowIndex: number;
  rowDate: string;
  candidateName: string | null;
  /** Printed target text, including unresolved/shared names; never an alias. */
  targetAsFiled?: string;
  houseDistrict: number | null;
  supportOppose: "support" | "oppose" | null;
  amountCents: number;
};

export type KansasIEDocumentInput = {
  db: Pick<Pool, "connect">;
  electionYear: number;
  sourceUrl: string;
  sha256: string;
  observedAt: string;
  payerName: string;
  filingDate: string;
  periodDueKey: string;
  statementTotalCents: number;
  rows: readonly KansasIEDocumentRow[];
};

export function normalizeKansasIEReportedName(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
}

function civilDate(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Invalid Kansas IE civil date");
  }
}

function validate(input: Omit<KansasIEDocumentInput, "db">): void {
  if (
    !Number.isSafeInteger(input.electionYear) ||
    input.electionYear < 2024 ||
    input.electionYear > 2100 ||
    !/^https:\/\/sos\.ks\.gov\/srvimages\/campaignfinance\/filings\/cy\d{4}\/cm(?:0[1-9]|1[0-2])\/\d+\.pdf$/.test(
      input.sourceUrl,
    ) ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    !input.payerName.trim() ||
    !/^\d{4}(?:0[1-9]|1[0-2])$/.test(input.periodDueKey) ||
    !Number.isSafeInteger(input.statementTotalCents) ||
    input.statementTotalCents < 0 ||
    input.rows.length === 0 ||
    input.rows.length > 10000
  ) {
    throw new Error("Invalid Kansas IE document evidence");
  }
  civilDate(input.filingDate);
  const indices = new Set<number>();
  for (const row of input.rows) {
    civilDate(row.rowDate);
    if (
      !Number.isSafeInteger(row.rowIndex) ||
      row.rowIndex < 1 ||
      indices.has(row.rowIndex) ||
      !Number.isSafeInteger(row.amountCents) ||
      (row.candidateName !== null && !row.candidateName.trim()) ||
      (row.targetAsFiled !== undefined &&
        typeof row.targetAsFiled !== "string") ||
      (row.houseDistrict !== null &&
        (!Number.isInteger(row.houseDistrict) ||
          row.houseDistrict < 1 ||
          row.houseDistrict > 125)) ||
      ![null, "support", "oppose"].includes(row.supportOppose)
    ) {
      throw new Error("Invalid Kansas IE literal financial row");
    }
    indices.add(row.rowIndex);
  }
}

type StoredRow = {
  sha256: string;
  observed_at: string;
  election_year: number;
  payer_name: string;
  filing_date: string;
  period_due_key: string;
  statement_total_cents: string;
  row_index: number;
  row_date: string;
  candidate_name: string | null;
  target_as_filed: string;
  house_district: number | null;
  support_oppose: "support" | "oppose" | null;
  amount_cents: string;
};

type LocalTarget = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  geoid_compact: string;
};

/**
 * The caller must verify the complete document/multipart financial controls
 * and current source bytes before invoking this store. This function does not
 * infer currentness, completeness, totals, or a candidate's receiving filer.
 */
export async function replaceKansasIEDocument(
  input: KansasIEDocumentInput,
): Promise<{
  rowCount: number;
  mappedRowCount: number;
  unmappedRowCount: number;
}> {
  const { db } = input;
  const document = {
    ...input,
    rows: input.rows.map((row) => ({
      ...row,
      targetAsFiled: row.targetAsFiled ?? row.candidateName ?? "",
    })),
  };
  validate(document);
  if (typeof db.connect !== "function")
    throw new Error("Kansas IE requires a transaction-capable Pool");
  let client: PoolClient | undefined;
  try {
    client = await db.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [document.sourceUrl],
    );
    const prior = await client.query<StoredRow>(
      `
      SELECT sha256, observed_at::text, election_year, payer_name, filing_date::text,
        period_due_key, statement_total_cents::text, row_index, row_date::text,
        candidate_name, target_as_filed, house_district, support_oppose, amount_cents::text
      FROM public.ks_independent_expenditure_evidence WHERE source_url = $1::text
      ORDER BY row_index FOR UPDATE`,
      [document.sourceUrl],
    );
    if (
      prior.rows.some(
        (row) => Date.parse(row.observed_at) > Date.parse(document.observedAt),
      )
    ) {
      throw new Error("Kansas IE source capture is older than stored evidence");
    }
    const expected = [...document.rows]
      .sort((a, b) => a.rowIndex - b.rowIndex)
      .map((row) => ({
        electionYear: document.electionYear,
        payerName: document.payerName,
        filingDate: document.filingDate,
        periodDueKey: document.periodDueKey,
        statementTotalCents: document.statementTotalCents,
        rowIndex: row.rowIndex,
        rowDate: row.rowDate,
        candidateName: row.candidateName,
        targetAsFiled: row.targetAsFiled,
        houseDistrict: row.houseDistrict,
        supportOppose: row.supportOppose,
        amountCents: row.amountCents,
      }));
    const existing = prior.rows.map((row) => ({
      electionYear: row.election_year,
      payerName: row.payer_name,
      filingDate: row.filing_date,
      periodDueKey: row.period_due_key,
      statementTotalCents: Number(row.statement_total_cents),
      rowIndex: row.row_index,
      rowDate: row.row_date,
      candidateName: row.candidate_name,
      targetAsFiled: row.target_as_filed,
      houseDistrict: row.house_district,
      supportOppose: row.support_oppose,
      amountCents: Number(row.amount_cents),
    }));
    if (
      prior.rows.length &&
      ((prior.rows.some((row) => row.sha256 === document.sha256) &&
        JSON.stringify(existing) !== JSON.stringify(expected)) ||
        prior.rows.some(
          (row) =>
            Date.parse(row.observed_at) === Date.parse(document.observedAt) &&
            row.sha256 !== document.sha256,
        ))
    )
      throw new Error(
        "Kansas IE capture/hash conflicts with stored literal evidence",
      );

    const targets = await client.query<LocalTarget>(
      `
      SELECT roster.candidate_id::text, roster.election_id::text,
        COALESCE(NULLIF(trim(candidate.display_name), ''),
          trim(candidate.first_name || ' ' || candidate.last_name)) AS candidate_name,
        district.geoid_compact
      FROM public.candidate_elections roster
      JOIN public.candidates candidate ON candidate.id = roster.candidate_id
      JOIN public.elections election ON election.id = roster.election_id
      JOIN public.offices office ON office.id = election.office_id
      JOIN public.districts district ON district.id = election.district_id
      WHERE candidate.deleted_at IS NULL AND roster.status NOT IN ('withdrawn', 'lost')
        AND district.state = 'KS' AND district.district_type = 'state_lower'
        AND office.scope = 'state_lower' AND office.canonical_name = 'State Lower Chamber Legislator'
        AND election.race_type = 'office' AND election.election_stage = 'general'
        AND EXTRACT(YEAR FROM election.election_date)::integer = $1::integer`,
      [document.electionYear],
    );
    await client.query(
      "DELETE FROM public.ks_independent_expenditure_evidence WHERE source_url = $1::text",
      [document.sourceUrl],
    );
    let mappedRowCount = 0;
    for (const row of document.rows) {
      const matches =
        row.candidateName !== null &&
        row.houseDistrict !== null &&
        row.supportOppose !== null &&
        row.rowDate >= `${document.electionYear - 1}-01-01` &&
        row.rowDate <= `${document.electionYear}-12-31`
          ? targets.rows.filter(
              (target) =>
                /^20\d{3}$/.test(target.geoid_compact) &&
                Number(target.geoid_compact.slice(2)) === row.houseDistrict &&
                normalizeKansasIEReportedName(target.candidate_name) ===
                  normalizeKansasIEReportedName(row.candidateName!),
            )
          : [];
      const target = matches.length === 1 ? matches[0] : undefined;
      if (target) mappedRowCount += 1;
      await client.query(
        `INSERT INTO public.ks_independent_expenditure_evidence (
        source_url, row_index, sha256, observed_at, election_year, payer_name,
        filing_date, period_due_key, statement_total_cents, row_date, candidate_name,
        house_district, support_oppose, amount_cents, candidate_id, election_id, target_as_filed
      ) VALUES ($1, $2, $3, $4::timestamptz, $5::integer, $6, $7::date, $8, $9::bigint,
        $10::date, $11, $12::integer, $13, $14::bigint, $15::uuid, $16::uuid, $17)`,
        [
          document.sourceUrl,
          row.rowIndex,
          document.sha256,
          document.observedAt,
          document.electionYear,
          document.payerName,
          document.filingDate,
          document.periodDueKey,
          document.statementTotalCents,
          row.rowDate,
          row.candidateName,
          row.houseDistrict,
          row.supportOppose,
          row.amountCents,
          target?.candidate_id ?? null,
          target?.election_id ?? null,
          row.targetAsFiled,
        ],
      );
    }
    await client.query("COMMIT");
    return {
      rowCount: document.rows.length,
      mappedRowCount,
      unmappedRowCount: document.rows.length - mappedRowCount,
    };
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    client?.release();
  }
}

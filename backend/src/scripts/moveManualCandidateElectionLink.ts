// Guarded single-link move between sibling election shells.
//
// Title-variant duplicate shells (a generic "Governing Board" shell next to
// its per-seat contests, or two spellings of the same contest) leave
// candidate_elections rows pointing at the wrong shell. The election
// injector can never repair that: its upsert identity is
// (district_id, official_ballot_title_key, election_date), so reinjecting
// under the right title creates the right shell but strands the links on
// the wrong one. This wrapper moves EXACTLY ONE explicitly identified link
// to an explicitly identified sibling shell — no heuristics, no bulk mode —
// so an operator can empty a duplicate shell link by link before retiring
// it with manual:elections:supersede.
//
// Guard rails, all of which must pass before a single row changes:
// - the link (candidate, from-election) exists and is row-locked;
// - both elections exist, are row-locked, and share district_id AND
//   election_date (crossing either means this is not a duplicate-shell
//   repair — wrong tool). --allow-cross-district relaxes ONLY the district
//   equality, and only for verified SIBLING districts (same state, related
//   body names, compatible types — assertSiblingDistricts); race_type must
//   always match, and so must election_stage when both rows state one (a
//   NULL stage is "not stated", not a different contest);
// - the target roster must not already list a different candidate id with
//   the same first and last name (a presumed duplicate PERSON — merge the
//   candidate rows first, or assert two distinct people with
//   --allow-same-name-target); conflicting generational suffixes (Jr./Sr.)
//   are treated as two people and proceed with a warning;
// - the from-election has no persisted election_results rows: their
//   winners JSON references candidate_elections ids, which a move or
//   merge-delete would corrupt;
// - no state campaign-finance link rows exist for (candidate, from-election):
//   finance tables denormalize election_id + election_year and their
//   summaries join on the election, so a bare link move would strand them
//   (checked dynamically against every FK table so new finance states are
//   covered automatically) — repoint them first with
//   manual:candidate-finance-links:move;
// - if the candidate is already linked to the target shell, the move
//   converges only when both rows agree on status/is_incumbent/running mate
//   (the from-link is then deleted as a duplicate); disagreeing rows are a
//   research question, not a merge;
// - manual candidate-finance filing targets are counted for the exact
//   candidacy before either path: their candidate/election IDs also live in
//   an immutable hashed payload, so they must be resolved explicitly rather
//   than cascaded to a different canonical identity;
// - before that duplicate-merge delete, no rows may reference the from-link
//   id itself: tables that FK onto candidate_elections(id) (e.g.
//   fl_candidate_finance_outside_group_links) carry no candidate_id or
//   election_id of their own, so the election-scoped finance scan above
//   cannot see them, and ON DELETE CASCADE would silently take their rows
//   with the link (checked dynamically against the catalog; FK shapes the
//   check cannot count — composite, or not referencing id — are refused
//   outright);
// - running-mate uniqueness on the target shell is pre-checked so the move
//   cannot trip uq_candidate_elections_election_running_mate_candidate_id;
// - local-database guard, single transaction, --dry-run.
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";

type QueryResultLike<T> = { rows: T[] };

export type MoveCandidateElectionLinkClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
};

export type CandidateElectionLinkFkReference = {
  constraintName: string;
  table: string;
  column: string;
  referencedColumn: string;
  columnCount: number;
};

const MANUAL_CANDIDATE_FINANCE_TARGET_FK =
  "manual_candidate_finance_filing_targets_candidate_election_fk";

export function isManualCandidateFinanceTargetFkReference(
  reference: CandidateElectionLinkFkReference
): boolean {
  const table = reference.table.replace(/^public\./, "");
  return (
    reference.constraintName === MANUAL_CANDIDATE_FINANCE_TARGET_FK &&
    table === "manual_candidate_finance_filing_targets" &&
    reference.columnCount === 2 &&
    (reference.column === "candidate_id" || reference.column === "election_id") &&
    reference.column === reference.referencedColumn
  );
}

export type MoveCandidateElectionLinkOptions = {
  candidateId: string;
  fromElectionId: string;
  toElectionId: string;
  dryRun: boolean;
  /**
   * Relaxes ONLY the same-district guard, for the sibling-district duplicate:
   * one real contest discovered twice because two district rows legitimately
   * cover the same body (live case: Jefferson County KY school-board contests
   * minted on both "Jefferson County School District, Kentucky" and the
   * Census overlay "Jefferson County School District in Anchorage ISD,
   * Kentucky" — same date, same candidates, one from the county clerk's
   * filing PDF and one from a news roster a day later). The election-date
   * guard, both districts sharing a state, and every other guard still hold.
   */
  allowCrossDistrict?: boolean;
  /**
   * Overrides the target-roster identity guard for ONE verified case: the
   * operator has confirmed the same-named target-roster candidate is a
   * DIFFERENT person (two real name-twins in one contest, or conflicting
   * middle names checked against sources). Without it, any first+last name
   * match on the target roster fails closed as a presumed duplicate person.
   */
  allowSameNameTarget?: boolean;
};

export type MoveCandidateElectionLinkResult = {
  action: "moved" | "merged_duplicate";
  dryRun: boolean;
  candidateId: string;
  fromElectionId: string;
  fromElectionTitle: string;
  toElectionId: string;
  toElectionTitle: string;
  /** Present only when --allow-cross-district actually crossed districts. */
  crossDistrict?: { fromDistrict: string; toDistrict: string };
  /**
   * Name matches on the target roster that PROCEEDED: conflicting-suffix
   * pairs (Jr. vs Sr. — evidence of two people) and matches overridden with
   * --allow-same-name-target. Any other first+last match fails closed as a
   * presumed duplicate person ("Matthew McPeak" vs "Matthew James McPeak"
   * was one person in the live repair).
   */
  targetRosterNameWarnings?: string[];
};

type LinkRow = {
  id: string;
  is_incumbent: boolean;
  status: string;
  running_mate_candidate_id: string | null;
};

type ElectionRow = {
  id: string;
  district_id: string;
  election_date: string;
  official_ballot_title: string;
  race_type: string | null;
  election_stage: string | null;
};

type DistrictRow = {
  id: string;
  name: string;
  state: string | null;
  district_type: string | null;
};

/**
 * Drops the trailing ", <state>" clause every districts.name carries, so the
 * body names can be compared: "Jefferson County School District in Anchorage
 * ISD, Kentucky" → "jefferson county school district in anchorage isd".
 */
function districtBodyName(name: string): string {
  return name.replace(/,[^,]*$/, "").trim().toLowerCase();
}

/**
 * Verifies two district rows are SIBLINGS — two rows for the same real-world
 * body — before a cross-district repair is allowed to touch them. Same-state
 * alone is not evidence (on a general-election date thousands of unrelated
 * contests share state and date; a mistyped UUID must not survive this
 * guard — review finding on this PR). Sibling evidence is:
 * - same state, AND
 * - a name relationship: the stripped body names are equal, or one is the
 *   other's Census place overlay ("X" vs "X in <place>") — the signature of
 *   every live case (Jefferson County KY, and the Rutherford/Williamson/
 *   Wilson TN pairs), AND
 * - compatible district types: equal, or both school types (the base row is
 *   school_unified where its place overlays are school_secondary/elementary).
 * A sibling shape this cannot verify is refused rather than guessed at; the
 * tool grows a new evidence rule when a real case shows up.
 */
export async function assertSiblingDistricts(
  client: MoveCandidateElectionLinkClient,
  fromDistrictId: string,
  toDistrictId: string,
  // The two shells' printed titles. A whole-district school/county/place row
  // and the reviewed local_special AREA row that replaces it (a trustee area
  // split out of its school district: Santa Clara, Orange, Los Angeles 2026)
  // share no name relationship, but the seat IS the same contest: identical
  // printed title on the same date, moving onto a local_special polygon.
  titles?: { from: string; to: string }
): Promise<{ fromDistrict: DistrictRow; toDistrict: DistrictRow }> {
  const districtsResult = await client.query<DistrictRow>(
    `SELECT id, name, state, district_type FROM public.districts WHERE id = ANY($1::uuid[])`,
    [[fromDistrictId, toDistrictId]]
  );
  const fromDistrict = districtsResult.rows.find((row) => row.id === fromDistrictId);
  const toDistrict = districtsResult.rows.find((row) => row.id === toDistrictId);
  if (!fromDistrict || !toDistrict) {
    throw new Error("District row missing for one of the elections; cannot verify siblings");
  }
  if (fromDistrict.state !== toDistrict.state) {
    throw new Error(
      `--allow-cross-district refused: districts are in different states ` +
        `(${fromDistrict.name} vs ${toDistrict.name}); not siblings`
    );
  }
  const areaSplit =
    toDistrict.district_type === "local_special" &&
    fromDistrict.district_type !== "local_special" &&
    titles !== undefined &&
    titles.from.trim().toLowerCase() === titles.to.trim().toLowerCase();
  if (areaSplit) {
    return { fromDistrict, toDistrict };
  }
  const fromBody = districtBodyName(fromDistrict.name);
  const toBody = districtBodyName(toDistrict.name);
  const namesRelated =
    fromBody === toBody ||
    fromBody.startsWith(`${toBody} in `) ||
    toBody.startsWith(`${fromBody} in `);
  if (!namesRelated) {
    throw new Error(
      `--allow-cross-district refused: district names do not describe the same body ` +
        `("${fromDistrict.name}" vs "${toDistrict.name}"). Siblings share a body name, ` +
        `or one is the other's place overlay ("X" vs "X in <place>").`
    );
  }
  const bothSchool =
    (fromDistrict.district_type ?? "").startsWith("school_") &&
    (toDistrict.district_type ?? "").startsWith("school_");
  if (fromDistrict.district_type !== toDistrict.district_type && !bothSchool) {
    throw new Error(
      `--allow-cross-district refused: incompatible district types ` +
        `(${fromDistrict.district_type ?? "unknown"} vs ${toDistrict.district_type ?? "unknown"}); not siblings`
    );
  }
  return { fromDistrict, toDistrict };
}

/**
 * Two shells describe a different KIND of contest only when both STATE a
 * stage and the stages differ. The elections writer stores NULL when a
 * payload omits election_stage (and keeps the stored value on re-upsert),
 * so NULL means "not stated", not a different contest; a mistyped UUID is
 * still caught by the district, date and race_type guards.
 */
export function electionStagesConflict(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b;
}

/**
 * Normalization for the target-roster name guard: lowercase, curly→straight
 * apostrophes (the live Gaines duplicate differed ONLY by that character),
 * punctuation to spaces, collapsed whitespace.
 */
export function normalizeRosterName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.,()"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERATIONAL_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function firstAndLastNameTokens(
  normalized: string
): { first: string; last: string; suffix: string | null } | null {
  const tokens = normalized.replace(/'/g, "").split(" ").filter((token) => token.length > 0);
  let suffix: string | null = null;
  while (tokens.length > 1 && GENERATIONAL_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    // The OUTERMOST suffix is the generational one ("Kane, Jr." → jr);
    // stacked suffixes are not a thing in ballot names, but popping them all
    // keeps first/last comparable either way.
    suffix = tokens.pop()!;
  }
  if (tokens.length < 2) return null;
  return { first: tokens[0]!, last: tokens[tokens.length - 1]!, suffix };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "Move one candidate_elections link from a duplicate election shell to its sibling.",
    "",
    "Usage:",
    "  npm run manual:candidate-elections:move -- --candidate-id uuid --from-election-id uuid --to-election-id uuid --reason text [--dry-run]",
  ].join("\n");
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value.trim();
}

function requireFlag(name: string): string {
  const value = readFlag(name);
  if (!value) throw new Error(`Missing ${name}.\n${usage()}`);
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for manual candidate-election link move`);
  return value;
}

/**
 * Every table that (a) has a foreign key to public.elections and (b) also
 * carries a candidate_id column is treated as a per-candidate finance/link
 * table whose rows would be stranded by a bare link move. Discovered from
 * the catalog at run time so a newly added state finance table is covered
 * without touching this wrapper.
 */
export async function listCandidateScopedElectionFkTables(
  client: MoveCandidateElectionLinkClient
): Promise<{ table: string; electionColumn: string }[]> {
  const result = await client.query<{ table_name: string; election_column: string }>(
    `
      SELECT DISTINCT c.conrelid::regclass::text AS table_name,
             quote_ident(a.attname) AS election_column
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f'
        AND c.confrelid = 'public.elections'::regclass
        AND c.conrelid <> 'public.candidate_elections'::regclass
        AND EXISTS (
          SELECT 1 FROM pg_attribute ca
          WHERE ca.attrelid = c.conrelid AND ca.attname = 'candidate_id' AND NOT ca.attisdropped
        )
      ORDER BY 1
    `
  );
  return result.rows.map((row) => ({ table: row.table_name, electionColumn: row.election_column }));
}

/**
 * Every foreign key onto public.candidate_elections references link rows the
 * duplicate-merge delete would cascade (or orphan), and none of them is
 * visible to the election-scoped scan above. conkey and confkey are unnested
 * together (positional pairing) so each child column is reported with the
 * link column it actually references: the guard can only count single-column
 * FKs onto id, and must refuse any other shape rather than compare the wrong
 * column against the link id and under-count. Discovered from the catalog at
 * run time so a newly added link-scoped table is covered without touching
 * this wrapper.
 */
export async function listCandidateElectionLinkFkReferences(
  client: MoveCandidateElectionLinkClient
): Promise<CandidateElectionLinkFkReference[]> {
  const result = await client.query<{
    constraint_name: string;
    table_name: string;
    column_name: string;
    referenced_column: string;
    column_count: number;
  }>(
    `
      SELECT c.conname AS constraint_name,
             c.conrelid::regclass::text AS table_name,
             quote_ident(a.attname) AS column_name,
             fa.attname AS referenced_column,
             cardinality(c.conkey) AS column_count
      FROM pg_constraint c
      JOIN unnest(c.conkey, c.confkey) WITH ORDINALITY AS u(attnum, fattnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
      JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = u.fattnum
      WHERE c.contype = 'f'
        AND c.confrelid = 'public.candidate_elections'::regclass
      ORDER BY 1, 2, 3
    `
  );
  return result.rows.map((row) => ({
    constraintName: row.constraint_name,
    table: row.table_name,
    column: row.column_name,
    referencedColumn: row.referenced_column,
    columnCount: Number(row.column_count),
  }));
}

export async function runMoveCandidateElectionLink(
  client: MoveCandidateElectionLinkClient,
  options: MoveCandidateElectionLinkOptions
): Promise<MoveCandidateElectionLinkResult> {
  // PostgreSQL returns uuid columns lowercased; a valid uppercase input
  // would otherwise fail the row-matching below with a false "not found".
  const candidateId = options.candidateId.toLowerCase();
  const fromElectionId = options.fromElectionId.toLowerCase();
  const toElectionId = options.toElectionId.toLowerCase();
  const { dryRun } = options;
  if (fromElectionId === toElectionId) {
    throw new Error("--from-election-id and --to-election-id must differ");
  }

  await client.query("BEGIN");
  try {
    const linkResult = await client.query<LinkRow>(
      `
        SELECT id, is_incumbent, status, running_mate_candidate_id
        FROM public.candidate_elections
        WHERE candidate_id = $1::uuid AND election_id = $2::uuid
        FOR UPDATE
      `,
      [candidateId, fromElectionId]
    );
    const link = linkResult.rows[0];
    if (!link) {
      throw new Error(
        `No candidate_elections link found for candidate ${candidateId} on election ${fromElectionId}`
      );
    }

    // Locked so the district/date sibling guard cannot pass on stale rows
    // while a concurrent edit (e.g. manual:election-date:correct) changes
    // one of them mid-transaction. Deterministic order avoids deadlocks
    // between two concurrent movers.
    const electionsResult = await client.query<ElectionRow>(
      `
        SELECT id, district_id, election_date::text, official_ballot_title, race_type, election_stage
        FROM public.elections
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE
      `,
      [[fromElectionId, toElectionId]]
    );
    const fromElection = electionsResult.rows.find((row) => row.id === fromElectionId);
    const toElection = electionsResult.rows.find((row) => row.id === toElectionId);
    if (!fromElection) throw new Error(`Election not found: ${fromElectionId}`);
    if (!toElection) throw new Error(`Election not found: ${toElectionId}`);
    let crossDistrict: MoveCandidateElectionLinkResult["crossDistrict"];
    if (fromElection.district_id !== toElection.district_id) {
      if (!options.allowCrossDistrict) {
        throw new Error(
          "Elections belong to different districts; a cross-district move is not a duplicate-shell repair. " +
            "If the two districts are siblings covering the same real body (e.g. a school system and its " +
            "Census place overlay) and this is the same contest duplicated, re-run with --allow-cross-district."
        );
      }
      const { fromDistrict, toDistrict } = await assertSiblingDistricts(
        client,
        fromElection.district_id,
        toElection.district_id,
        { from: fromElection.official_ballot_title, to: toElection.official_ballot_title }
      );
      crossDistrict = { fromDistrict: fromDistrict.name, toDistrict: toDistrict.name };
    }
    if (fromElection.election_date !== toElection.election_date) {
      throw new Error(
        `Elections have different dates (${fromElection.election_date} vs ${toElection.election_date}); ` +
          "a cross-date move is not a duplicate-shell repair (see manual:election-date:correct for date fixes)"
      );
    }
    // Two shells for one contest agree on what KIND of contest it is. A
    // mismatch means the target is not this contest's sibling — most likely
    // a mistyped UUID, whose blast radius --allow-cross-district widens from
    // one district to a whole state's election day (review finding).
    if (fromElection.race_type !== toElection.race_type) {
      throw new Error(
        `Elections have different race types (${fromElection.race_type ?? "unknown"} vs ` +
          `${toElection.race_type ?? "unknown"}); not the same contest`
      );
    }
    if (electionStagesConflict(fromElection.election_stage, toElection.election_stage)) {
      throw new Error(
        `Elections are at different stages (${fromElection.election_stage ?? "unknown"} vs ` +
          `${toElection.election_stage ?? "unknown"}); not the same contest`
      );
    }

    // Persisted-results guard: election_results.winners stores
    // candidate_election_id inside JSON (the matcher resolves winners by
    // exact link id against the election's roster), and the FK/finance scan
    // below cannot see into JSON. Moving a link out from under a persisted
    // result — or deleting it on the merge path — would leave the winner
    // JSON pointing at another election's link, or dangling. Same rule as
    // manual:election-date:correct: resolve the result rows first.
    const persistedResults = await client.query<{ id: string }>(
      `SELECT id FROM public.election_results WHERE election_id = $1::uuid LIMIT 1`,
      [fromElectionId]
    );
    if (persistedResults.rows[0]) {
      throw new Error(
        `Election ${fromElectionId} has persisted election_results rows whose winners reference ` +
          "candidate_elections ids; refusing link move — resolve the result rows first (user decision), then re-run."
      );
    }

    // Finance-link stranding guard. Identifiers come from the catalog
    // (regclass / pg_attribute), not from user input.
    const financeTables = await listCandidateScopedElectionFkTables(client);
    const stranded: string[] = [];
    for (const { table, electionColumn } of financeTables) {
      const countResult = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE candidate_id = $1::uuid AND ${electionColumn} = $2::uuid`,
        [candidateId, fromElectionId]
      );
      const n = Number(countResult.rows[0]?.n ?? "0");
      if (n > 0) stranded.push(`${table} (${n})`);
    }
    if (stranded.length > 0) {
      throw new Error(
        `Candidate has election-scoped rows on the from-election that a link move would strand: ${stranded.join(", ")}. ` +
          "Resolve those rows first (user decision), then re-run."
      );
    }

    // This composite FK is intentionally ON UPDATE/DELETE RESTRICT. Its
    // target columns are derived from an immutable hashed source payload;
    // cascading only the columns would make them disagree with the payload.
    // Count the exact candidacy up front so the FK's mere existence does not
    // block unrelated maintenance, while affected filings fail with an
    // operator-actionable error before PostgreSQL's generic FK error.
    const manualFinanceTargets = await client.query<{ n: string }>(
      `
        SELECT count(*)::text AS n
        FROM public.manual_candidate_finance_filing_targets
        WHERE candidate_id = $1::uuid AND election_id = $2::uuid
      `,
      [candidateId, fromElectionId]
    );
    const manualFinanceTargetCount = Number(manualFinanceTargets.rows[0]?.n ?? "0");
    if (manualFinanceTargetCount > 0) {
      throw new Error(
        `${manualFinanceTargetCount} manual candidate-finance filing target row(s) reference ` +
          `${candidateId}/${fromElectionId}; moving or deleting this candidacy would make their immutable ` +
          "payload identity disagree with the derived target. Resolve those filings explicitly " +
          "(user decision), then re-run."
      );
    }

    // User-choice guard, covering both the plain move and the duplicate
    // merge. A pick is the user's decision about THIS race: the plain move's
    // UPDATE would drag it to a different election through the choice FK's
    // ON UPDATE CASCADE (possibly exceeding that race's seat cap), and the
    // duplicate merge's DELETE would cascade it away entirely. Neither is a
    // call this script should make for the user, so both refuse.
    const choiceCount = await client.query<{ n: string }>(
      `
        SELECT count(*)::text AS n
        FROM public.user_election_choices
        WHERE candidate_id = $1::uuid AND election_id = $2::uuid
      `,
      [candidateId, fromElectionId]
    );
    const choices = Number(choiceCount.rows[0]?.n ?? "0");
    if (choices > 0) {
      throw new Error(
        `${choices} user_election_choices row(s) name this candidacy on the from-election; a move would ` +
          "silently rewrite or delete users' planned votes. Resolve those rows first (user decision), then re-run."
      );
    }

    const targetLinkResult = await client.query<LinkRow>(
      `
        SELECT id, is_incumbent, status, running_mate_candidate_id
        FROM public.candidate_elections
        WHERE candidate_id = $1::uuid AND election_id = $2::uuid
        FOR UPDATE
      `,
      [candidateId, toElectionId]
    );
    const targetLink = targetLinkResult.rows[0];

    let action: MoveCandidateElectionLinkResult["action"];
    const targetRosterNameWarnings: string[] = [];
    if (targetLink) {
      const identical =
        targetLink.is_incumbent === link.is_incumbent &&
        targetLink.status === link.status &&
        targetLink.running_mate_candidate_id === link.running_mate_candidate_id;
      if (!identical) {
        throw new Error(
          "Candidate is already linked to the target election and the two links disagree " +
            `(from: status=${link.status}, is_incumbent=${link.is_incumbent}, running_mate=${link.running_mate_candidate_id ?? "null"}; ` +
            `to: status=${targetLink.status}, is_incumbent=${targetLink.is_incumbent}, running_mate=${targetLink.running_mate_candidate_id ?? "null"}). ` +
            "Which row is right is a research question; resolve it, then re-run."
        );
      }
      // Link-scoped cascade guard: rows that FK onto the from-link's id
      // (invisible to the election-scoped scan above) would be silently
      // cascaded away by the duplicate-merge delete. Identifiers come from
      // the catalog, not from user input.
      // The choices FK is composite onto (candidate_id, election_id), which
      // this guard's id-keyed count cannot check — but its rows were already
      // counted (and refused when present) by the user-choice guard above,
      // so it is exempt from the unknown-shape refusal.
      const linkFkReferences = (await listCandidateElectionLinkFkReferences(client)).filter(
        (ref) =>
          ref.constraintName !== "fk_user_election_choices_candidacy" &&
          !isManualCandidateFinanceTargetFkReference(ref)
      );
      // The count below keys each child column on the from-link id, which is
      // only meaningful for a single-column FK onto id. Any other shape
      // (composite, or referencing another unique column) would compare the
      // wrong value, count zero, and let the delete cascade — so it is
      // refused outright instead of guessed at.
      const unsupported = [
        ...new Set(
          linkFkReferences
            .filter((ref) => ref.columnCount !== 1 || ref.referencedColumn !== "id")
            .map((ref) => `${ref.table}.${ref.constraintName}`)
        ),
      ];
      if (unsupported.length > 0) {
        throw new Error(
          `Foreign keys onto candidate_elections whose shape this guard cannot check ` +
            `(composite, or not referencing id): ${unsupported.join(", ")}. ` +
            "Refusing the duplicate-merge delete; extend the guard before merging under such constraints."
        );
      }
      const cascading: string[] = [];
      const counted = new Set<string>();
      for (const { table, column } of linkFkReferences) {
        const key = `${table}.${column}`;
        if (counted.has(key)) continue;
        counted.add(key);
        const countResult = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1::uuid`,
          [link.id]
        );
        const n = Number(countResult.rows[0]?.n ?? "0");
        if (n > 0) cascading.push(`${key} (${n})`);
      }
      if (cascading.length > 0) {
        throw new Error(
          `From-link ${link.id} is referenced by rows the duplicate-merge delete would cascade away: ${cascading.join(", ")}. ` +
            "Resolve those rows first (user decision), then re-run."
        );
      }
      if (!dryRun) {
        await client.query(`DELETE FROM public.candidate_elections WHERE id = $1::uuid`, [link.id]);
      }
      action = "merged_duplicate";
    } else {
      // Target-roster identity guard. The convergence path above only fires
      // for the SAME candidate uuid; when the duplicate shell also minted a
      // duplicate CANDIDATE row (the live Jefferson County repair carried
      // seven), moving the un-merged twin would put the same person on the
      // surviving roster twice (review finding). FAIL-CLOSED (review round
      // 2): a first+last match is presumed the same person — the live
      // "Matthew McPeak" / "Matthew James McPeak" pair IS one person — and
      // refuses, exact or variant, unless --allow-same-name-target asserts
      // the operator verified two distinct people. The one detectable
      // two-person shape proceeds on its own: BOTH names carrying explicit,
      // CONFLICTING generational suffixes ("Kane, Jr." vs "Kane, Sr."),
      // which is evidence of two people, not two spellings — a bare name
      // next to a suffixed one stays presumed-same, since a source omitting
      // "Jr." is far likelier than father and son in one contest. Every
      // proceed-path match is still reported in targetRosterNameWarnings.
      const movingCandidate = await client.query<{ display_name: string }>(
        `SELECT display_name FROM public.candidates WHERE id = $1::uuid`,
        [candidateId]
      );
      const movingName = movingCandidate.rows[0]?.display_name;
      if (!movingName) throw new Error(`Candidate not found: ${candidateId}`);
      const rosterResult = await client.query<{ id: string; display_name: string }>(
        `
          SELECT c.id, c.display_name
          FROM public.candidate_elections ce
          JOIN public.candidates c ON c.id = ce.candidate_id
          WHERE ce.election_id = $1::uuid AND c.id <> $2::uuid AND c.deleted_at IS NULL
        `,
        [toElectionId, candidateId]
      );
      const movingNormalized = normalizeRosterName(movingName);
      const movingTokens = firstAndLastNameTokens(movingNormalized);
      for (const rosterRow of rosterResult.rows) {
        const rosterNormalized = normalizeRosterName(rosterRow.display_name);
        const rosterTokens = firstAndLastNameTokens(rosterNormalized);
        const exactMatch = rosterNormalized === movingNormalized;
        const firstLastMatch =
          movingTokens !== null &&
          rosterTokens !== null &&
          movingTokens.first === rosterTokens.first &&
          movingTokens.last === rosterTokens.last;
        if (!exactMatch && !firstLastMatch) continue;

        const conflictingSuffixes =
          !exactMatch &&
          firstLastMatch &&
          movingTokens!.suffix !== null &&
          rosterTokens!.suffix !== null &&
          movingTokens!.suffix !== rosterTokens!.suffix;
        if (conflictingSuffixes) {
          targetRosterNameWarnings.push(
            `Target roster candidate "${rosterRow.display_name}" (${rosterRow.id}) shares first and last ` +
              `name with the moving candidate "${movingName}" but carries a conflicting generational ` +
              `suffix — treated as a different person.`
          );
          continue;
        }
        if (options.allowSameNameTarget) {
          targetRosterNameWarnings.push(
            `OVERRIDDEN (--allow-same-name-target): target roster candidate "${rosterRow.display_name}" ` +
              `(${rosterRow.id}) ${exactMatch ? "has the same normalized name as" : "shares first and last name with"} ` +
              `the moving candidate "${movingName}" — moved on the operator's assertion they are different people.`
          );
          continue;
        }
        throw new Error(
          `Target election already lists "${rosterRow.display_name}" (${rosterRow.id}) — ` +
            `${exactMatch ? "the same name as" : "the same first and last name as"} the moving candidate ` +
            `"${movingName}" under a different id. Moving would put the same person on the roster twice; ` +
            `merge the candidates first (manual:candidates:merge), then re-run — or, if you have verified ` +
            `these are two different people, re-run with --allow-same-name-target.`
        );
      }
      if (link.running_mate_candidate_id) {
        // FOR UPDATE pins a found collision row for the friendly error; a
        // concurrent INSERT of a colliding row after a not-found result is
        // still possible (no predicate locks at read committed) and falls
        // through to the unique-constraint error, which keeps data correct.
        const mateCollision = await client.query<{ id: string }>(
          `
            SELECT id FROM public.candidate_elections
            WHERE election_id = $1::uuid AND running_mate_candidate_id = $2::uuid
            LIMIT 1
            FOR UPDATE
          `,
          [toElectionId, link.running_mate_candidate_id]
        );
        if (mateCollision.rows[0]) {
          throw new Error(
            `Target election already has a link carrying running mate ${link.running_mate_candidate_id} ` +
              `(link ${mateCollision.rows[0].id}); resolve the duplicate ticket first, then re-run.`
          );
        }
      }
      if (!dryRun) {
        await client.query(
          `
            UPDATE public.candidate_elections
            SET election_id = $2::uuid, updated_at = now()
            WHERE id = $1::uuid
          `,
          [link.id, toElectionId]
        );
      }
      action = "moved";
    }

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
    return {
      action,
      dryRun,
      candidateId,
      fromElectionId,
      fromElectionTitle: fromElection.official_ballot_title,
      toElectionId,
      toElectionTitle: toElection.official_ballot_title,
      ...(crossDistrict ? { crossDistrict } : {}),
      ...(targetRosterNameWarnings.length > 0 ? { targetRosterNameWarnings } : {}),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:candidate-elections:move", process.argv.slice(2), [
    { name: "--candidate-id", value: "space" },
    { name: "--from-election-id", value: "space" },
    { name: "--to-election-id", value: "space" },
    { name: "--reason", value: "space" },
    { name: "--dry-run", value: "none" },
    { name: "--allow-same-name-target", value: "none" },
    { name: "--allow-cross-district", value: "none" },
  ]);
  loadProjectEnv();

  const candidateId = requireFlag("--candidate-id");
  const fromElectionId = requireFlag("--from-election-id");
  const toElectionId = requireFlag("--to-election-id");
  const reason = requireFlag("--reason");
  const dryRun = process.argv.includes("--dry-run");
  const allowCrossDistrict = process.argv.includes("--allow-cross-district");
  const allowSameNameTarget = process.argv.includes("--allow-same-name-target");

  for (const [name, value] of [
    ["--candidate-id", candidateId],
    ["--from-election-id", fromElectionId],
    ["--to-election-id", toElectionId],
  ] as const) {
    if (!UUID_RE.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  }
  if (reason.length < 20) {
    throw new Error("--reason must explain the move in at least 20 characters");
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const result = await runMoveCandidateElectionLink(client, {
      candidateId,
      fromElectionId,
      toElectionId,
      dryRun,
      allowCrossDistrict,
      allowSameNameTarget,
    });
    console.log(JSON.stringify({ ...result, reason }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";

import { assertKnownCliFlags, type CliFlagSpec } from "./manualCliFlags.js";
const DEFERRAL_STAGES = [
  "elections",
  "candidate_roster",
  "candidate_profile",
  "candidate_records",
  "ballot_measure",
] as const;

type DeferralStage = (typeof DEFERRAL_STAGES)[number];

function usage(): string {
  return [
    "Manual research deferral ledger CLI (agent-facing).",
    "",
    "Usage: npm run manual:deferral:<command> -- [flags]",
    "",
    "Commands:",
    "  record   Record a deferral. Refuses to overwrite an existing open row unless --replace.",
    "           --district-id <id> --stage <stage> --reason <text> --blocked-until <YYYY-MM-DD>",
    "           [--election-id <id>] [--blocker-key <slug>] [--source-url <url>] [--replace]",
    `           Stages: ${DEFERRAL_STAGES.join(", ")}`,
    "           One open row per (election|district) + stage + blocker-key. Use --election-id",
    "           for a per-election blocker, --blocker-key for a second district-wide blocker",
    "           on the same stage. --replace rewrites the row for this key AND closes every",
    "           other open deferral for the same election|district + stage (per-candidate",
    "           profile-<id> rows are their own unit and are only replaced by their own key).",
    "  due      List deferred rows whose blocked_until has passed. [--limit <n>] [--all] [--district-id <id>]",
    "           (--all lists every open deferral regardless of date, uncapped unless --limit is given)",
    "  resolve  Close a deferral after the deferred unit was completed. --deferral-id <id> [--note <text>]",
    "  cancel   Close a deferral recorded in error or made moot. --deferral-id <id> --note <text>",
    "  status   Print counts by status, due-now count, and the next due date. [--district-id <id>]",
  ].join("\n");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, "true");
    } else {
      flags.set(key, next);
      i += 1;
    }
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim().length === 0 || value === "true") {
    throw new Error(`Missing required flag: --${name}`);
  }
  return value;
}

// parseFlags stores a bare `--foo` as "true". For flags that carry a value,
// that must be an error rather than the literal string "true" reaching SQL.
function optionalValueFlag(flags: Map<string, string>, name: string): string | null {
  const value = flags.get(name);
  if (value === undefined) {
    return null;
  }
  if (value.trim().length === 0 || value === "true") {
    throw new Error(`Missing value for flag: --${name}`);
  }
  return value;
}

function print(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

// The discriminator must be a STABLE machine key: it is part of the open-row
// unique key, so free text ("waiting on the county clerk") would mint a fresh
// row on every retry instead of updating the one already recorded. Mirrors
// chk_manual_research_deferrals_blocker_key so the failure is a clear CLI
// message rather than a raw constraint violation.
const BLOCKER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function parseBlockerKey(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  if (!BLOCKER_KEY_PATTERN.test(raw)) {
    throw new Error(
      `Invalid --blocker-key: ${raw}. Expected a short lowercase slug ` +
        `(letters, digits, _ or -, max 40 chars), e.g. ballot_measure_family.`
    );
  }
  return raw;
}

// Postgres unique_violation. The open-row indexes are the real guarantee that
// two concurrent writers cannot both land a row on one key; this lets the CLI
// recognise that outcome and explain it instead of leaking the driver error.
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

type OpenDeferralRow = { id: string; reason: string; blocked_until: string };

// One message for both ways a collision is discovered — the pre-write probe and
// the concurrent-insert catch — so the two paths cannot drift apart.
function collisionError(
  row: OpenDeferralRow,
  stage: string,
  scope: string,
  keySuffix: string,
  options: { concurrent?: boolean; replace?: boolean } = {}
): Error {
  // "Nothing was written" leads every variant: under `npm run` this message
  // sits below a wall of npm error lines, and agents have read a silent
  // no-op as success (2026-09-21, Crittenden County AR).
  const lead = options.concurrent
    ? `Nothing was written: another session recorded an open ${stage} deferral for ${scope}${keySuffix} while this command was running.`
    : `Nothing was written: an open ${stage} deferral already exists for ${scope}${keySuffix}.`;
  // Re-offering --replace to someone who already passed it is noise; what they
  // need is to re-run now that a row exists to replace.
  const guidance =
    options.concurrent && options.replace
      ? ["Nothing was written. Re-run the same command to apply your --replace to the row above."]
      : [
          "Refusing to overwrite it. Pick the one that matches your intent:",
          "  --election-id <id>    this blocker belongs to one specific election",
          "  --blocker-key <slug>  this is a SEPARATE district-wide blocker on the same",
          "                        stage (e.g. ballot_measure_family, office_matcher)",
          "  --replace             you mean to rewrite the row above with a new reason/date",
          "                        (also closes every other open deferral for this stage",
          "                        and election/district, and lists the closed ids)",
        ];
  return new Error(
    [
      lead,
      `  id:            ${row.id}`,
      `  blocked_until: ${row.blocked_until}`,
      `  reason:        ${row.reason.slice(0, 200)}${row.reason.length > 200 ? "…" : ""}`,
      "",
      ...guidance,
    ].join("\n")
  );
}

// Narrow surface so tests can drive `record` against a fake instead of a live
// pool (same pattern as the other manual script CLIs).
export type DeferralClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }>;
};

// Date.parse accepts overflow dates and silently normalizes them
// ("2026-02-30" -> Mar 2). Round-trip the parsed parts so only real calendar
// days are accepted.
function parseBlockedUntil(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid --blocked-until: ${raw}. Expected YYYY-MM-DD.`);
  }
  const [, year, month, day] = match.map(Number) as [never, number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid --blocked-until: ${raw}. Not a real calendar date.`);
  }
  return raw;
}

export async function runCommand(
  pool: DeferralClient,
  command: string,
  flags: Map<string, string>
): Promise<void> {
  switch (command) {
    case "record": {
      const districtId = requireFlag(flags, "district-id");
      const stage = requireFlag(flags, "stage");
      if (!DEFERRAL_STAGES.includes(stage as DeferralStage)) {
        throw new Error(`Invalid --stage: ${stage}. Expected one of ${DEFERRAL_STAGES.join(", ")}.`);
      }
      const reason = requireFlag(flags, "reason");
      const blockedUntil = parseBlockedUntil(requireFlag(flags, "blocked-until"));
      const electionId = optionalValueFlag(flags, "election-id");
      const sourceUrl = optionalValueFlag(flags, "source-url");
      const blockerKey = parseBlockerKey(optionalValueFlag(flags, "blocker-key"));
      const replace = flags.get("replace") === "true";

      const districtRow = await pool.query(`SELECT name FROM public.districts WHERE id = $1`, [
        districtId,
      ]);
      if (districtRow.rows.length === 0) {
        throw new Error(`District ${districtId} not found.`);
      }
      const districtName = (districtRow.rows[0] as { name: string }).name;

      if (electionId) {
        const electionRow = await pool.query(
          `SELECT id FROM public.elections WHERE id = $1 AND district_id = $2`,
          [electionId, districtId]
        );
        if (electionRow.rows.length === 0) {
          throw new Error(`Election ${electionId} not found in district ${districtId}.`);
        }
      }

      // Look before writing. The previous version went straight to an UPDATE
      // and treated a hit as success, so a second blocker recorded on the same
      // key silently replaced the first one's reason and date and the lost work
      // never came back on the due list (2026-07-10: a judicial-retention
      // deferral clobbered a runoff-generals one). A collision is now an error
      // that names the row and the three ways out.
      //
      // Two partial unique indexes (election-scoped and district-wide) cannot
      // share one ON CONFLICT target, so the match is spelled out here.
      const existing = await pool.query<{
        id: string;
        reason: string;
        blocked_until: string;
      }>(
        `
          SELECT id, reason, blocked_until::text AS blocked_until
          FROM public.manual_research_deferrals
          WHERE status = 'deferred'
            AND district_id = $1
            AND stage = $2
            AND election_id IS NOT DISTINCT FROM $3
            AND blocker_key IS NOT DISTINCT FROM $4
        `,
        [districtId, stage, electionId, blockerKey]
      );

      const scope = electionId ? `election ${electionId}` : `district ${districtId} (district-wide)`;
      const keySuffix = blockerKey ? ` with blocker-key ${blockerKey}` : "";

      // --replace means "this is now THE deferral for this election|district +
      // stage". Before 2026-09-21 it only touched the row with the exact same
      // blocker key, so a re-record under a different (or blank) key left two
      // open rows for one unit and every later session had to close the
      // stale one by hand. This runs AFTER the new row is written, so a
      // failure here leaves the new row standing and the old ones still open
      // (the pre-fix state) rather than losing the deferral.
      //
      // Per-candidate profile rows (`profile-<id>`) share one election + stage
      // but are separate units: a profile-keyed call replaces only its own
      // row, and no other call closes profile rows.
      const supersedeOthers = async (
        keptId: string
      ): Promise<{ id: string; blocker_key: string | null }[]> => {
        if (blockerKey !== null && blockerKey.startsWith("profile-")) {
          return [];
        }
        const closed = await pool.query<{ id: string; blocker_key: string | null }>(
          `
            UPDATE public.manual_research_deferrals
            SET status = 'cancelled', resolved_at = now(), updated_at = now(),
                resolution_note = $5
            WHERE status = 'deferred'
              AND district_id = $1
              AND stage = $2
              AND election_id IS NOT DISTINCT FROM $3
              AND id <> $4
              AND (blocker_key IS NULL OR blocker_key NOT LIKE 'profile-%')
            RETURNING id, blocker_key
          `,
          [
            districtId,
            stage,
            electionId,
            keptId,
            `superseded by deferral ${keptId} (manual:deferral:record --replace)`,
          ]
        );
        return closed.rows;
      };

      if (existing.rows.length > 0 && !replace) {
        throw collisionError(existing.rows[0], stage, scope, keySuffix);
      }

      if (existing.rows.length > 0) {
        const updated = await pool.query<{ id: string }>(
          `
            UPDATE public.manual_research_deferrals
            SET reason = $1, blocked_until = $2, source_url = $3, updated_at = now()
            WHERE id = $4
              AND status = 'deferred'
            RETURNING id
          `,
          [reason, blockedUntil, sourceUrl, existing.rows[0].id]
        );
        // The status guard matters: without it a row that another session
        // resolved between the probe and this write would have its reason and
        // date rewritten while staying closed, and we would report success.
        if (updated.rows.length === 0) {
          throw new Error(
            `Deferral ${existing.rows[0].id} was resolved or cancelled by another session ` +
              `after this command read it. Nothing was written — re-run to record a fresh deferral.`
          );
        }
        const superseded = await supersedeOthers(updated.rows[0].id);
        print({
          deferral_id: updated.rows[0].id,
          district_name: districtName,
          blocker_key: blockerKey,
          replaced: true,
          superseded,
        });
        return;
      }

      // The probe above is a read, so two sessions recording the same key at
      // once can both find nothing and both try to insert. The unique index
      // still holds — the loser writes nothing and no work is lost — but it
      // would surface as a raw 23505 dump instead of the actionable message
      // this command promises. Translate it back.
      let inserted: { rows: { id: string }[] };
      try {
        inserted = await pool.query<{ id: string }>(
          `
            INSERT INTO public.manual_research_deferrals
              (district_id, election_id, stage, reason, blocked_until, source_url,
               district_name_snapshot, blocker_key)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
          `,
          [districtId, electionId, stage, reason, blockedUntil, sourceUrl, districtName, blockerKey]
        );
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        const raced = await pool.query<{
          id: string;
          reason: string;
          blocked_until: string;
        }>(
          `
            SELECT id, reason, blocked_until::text AS blocked_until
            FROM public.manual_research_deferrals
            WHERE status = 'deferred'
              AND district_id = $1
              AND stage = $2
              AND election_id IS NOT DISTINCT FROM $3
              AND blocker_key IS NOT DISTINCT FROM $4
          `,
          [districtId, stage, electionId, blockerKey]
        );
        // Nothing to point at (the winner closed its row again in the gap):
        // the raw error is more honest than a fabricated explanation.
        if (raced.rows.length === 0) {
          throw error;
        }
        throw collisionError(raced.rows[0], stage, scope, keySuffix, { concurrent: true, replace });
      }
      const superseded = replace ? await supersedeOthers(inserted.rows[0].id) : [];
      print({
        deferral_id: inserted.rows[0].id,
        district_name: districtName,
        blocker_key: blockerKey,
        recorded: true,
        ...(replace ? { superseded } : {}),
      });
      return;
    }

    case "due": {
      const limitRaw = optionalValueFlag(flags, "limit");
      // Number.parseInt would accept "20abc"; require a clean positive integer.
      if (limitRaw !== null && !/^\d+$/.test(limitRaw)) {
        throw new Error(`Invalid --limit: ${limitRaw}. Expected a positive integer.`);
      }
      const limit = limitRaw !== null ? Number(limitRaw) : 20;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error(`Invalid --limit: ${limitRaw}. Expected a positive integer.`);
      }
      const all = flags.get("all") === "true";
      // Resuming one district should not require reading every district's
      // ledger (a statewide audit had to eyeball 66 global rows).
      const districtId = optionalValueFlag(flags, "district-id");
      // `--all` promises every open deferral, so it is unbounded unless the
      // caller explicitly asked for a cap.
      const applyLimit = !all || limitRaw !== null;
      const params: unknown[] = [];
      if (districtId !== null) {
        params.push(districtId);
      }
      const districtClause = districtId !== null ? `AND district_id = $${params.length}` : "";
      if (applyLimit) {
        params.push(limit);
      }
      const rows = await pool.query(
        `
          SELECT id, district_id, election_id, stage, blocker_key, reason, blocked_until::text,
                 source_url, district_name_snapshot, created_at
          FROM public.manual_research_deferrals
          WHERE status = 'deferred'
            ${all ? "" : "AND blocked_until <= CURRENT_DATE"}
            ${districtClause}
          ORDER BY blocked_until ASC, created_at ASC
          ${applyLimit ? `LIMIT $${params.length}` : ""}
        `,
        params
      );
      print({ due_count: rows.rows.length, deferrals: rows.rows });
      return;
    }

    case "resolve":
    case "cancel": {
      const deferralId = requireFlag(flags, "deferral-id");
      const note = command === "cancel" ? requireFlag(flags, "note") : optionalValueFlag(flags, "note");
      const status = command === "resolve" ? "resolved" : "cancelled";
      const result = await pool.query(
        `
          UPDATE public.manual_research_deferrals
          SET status = $1, resolved_at = now(), resolution_note = $2, updated_at = now()
          WHERE id = $3 AND status = 'deferred'
          RETURNING id
        `,
        [status, note, deferralId]
      );
      if (result.rows.length === 0) {
        throw new Error(`Cannot ${command} deferral ${deferralId}: not found or not in 'deferred' status.`);
      }
      print({ deferral_id: deferralId, status });
      return;
    }

    case "status": {
      const districtId = optionalValueFlag(flags, "district-id");
      const districtClause = districtId !== null ? "district_id = $1" : "TRUE";
      const params = districtId !== null ? [districtId] : [];
      const stats = await pool.query(
        `
          SELECT status, count(*)::int AS count
          FROM public.manual_research_deferrals
          WHERE ${districtClause}
          GROUP BY status
        `,
        params
      );
      const due = await pool.query(
        `
          SELECT count(*)::int AS due_now, min(blocked_until)::text AS next_due
          FROM public.manual_research_deferrals
          WHERE status = 'deferred' AND blocked_until <= CURRENT_DATE AND ${districtClause}
        `,
        params
      );
      const upcoming = await pool.query(
        `
          SELECT min(blocked_until)::text AS next_upcoming
          FROM public.manual_research_deferrals
          WHERE status = 'deferred' AND blocked_until > CURRENT_DATE AND ${districtClause}
        `,
        params
      );
      print({
        ...(districtId !== null ? { district_id: districtId } : {}),
        by_status: stats.rows,
        due_now: due.rows[0]?.due_now ?? 0,
        // Oldest already-due date: what an operator acts on first.
        next_due: due.rows[0]?.next_due ?? null,
        next_upcoming: upcoming.rows[0]?.next_upcoming ?? null,
      });
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

// Per-command flag sets: a union across commands would let a flag that is
// valid only for ANOTHER command pass validation and be silently ignored
// ("status --note ..." doing nothing) — the exact failure class this guard
// exists to remove. All values are space-form: parseFlags reads the next
// token and does not understand "--name=value".
const COMMAND_FLAG_SPECS: Record<string, readonly CliFlagSpec[]> = {
  record: [
    { name: "--district-id", value: "space" },
    { name: "--election-id", value: "space" },
    { name: "--blocker-key", value: "space" },
    { name: "--stage", value: "space" },
    { name: "--reason", value: "space" },
    { name: "--blocked-until", value: "space" },
    { name: "--source-url", value: "space" },
    { name: "--replace", value: "none" },
  ],
  due: [
    { name: "--limit", value: "space" },
    { name: "--all", value: "none" },
    { name: "--district-id", value: "space" },
  ],
  resolve: [
    { name: "--deferral-id", value: "space" },
    { name: "--note", value: "space" },
  ],
  cancel: [
    { name: "--deferral-id", value: "space" },
    { name: "--note", value: "space" },
  ],
  status: [{ name: "--district-id", value: "space" }],
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  const specs = COMMAND_FLAG_SPECS[command];
  if (specs) {
    // Before loadProjectEnv so `--help` (handled inside the assert) stays
    // environment-independent, matching every other manual wrapper.
    assertKnownCliFlags(`manual:deferral ${command}`, rest, specs);
  }
  loadProjectEnv();

  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  try {
    await runCommand(pool, command, parseFlags(rest));
  } finally {
    await pool.end();
  }
}

// Guarded so tests can import runCommand without the CLI firing on load
// (same entrypoint check as the other testable manual scripts).
const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

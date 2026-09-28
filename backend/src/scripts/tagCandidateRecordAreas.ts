import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import {
  loadAllowedResearchAreasForOfficeId,
  validateCandidateRecordAreaLabels,
  type AllowedResearchArea,
  type CandidateRecordAreaStance,
} from "../pipeline/candidates/candidateRecordAreaTagging.js";
import {
  GENERAL_RESEARCH_AREA_SLUG,
  INTEGRITY_AND_ETHICS_RESEARCH_AREA_SLUG,
} from "../pipeline/candidates/candidateRecordResearchAreaPolicy.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";

/**
 * Adds a research-area tag to EXISTING candidate_records rows from a
 * reviewed manifest — the manual counterpart of `ai:candidate-records:relabel`
 * and the add side of `manual:records:untag`. Built for a new research area
 * (ai_regulation, migration 276): records written before the area existed
 * can only carry it once an operator reads each one and decides the stance.
 *
 * Every tag goes through the same gate as a fresh write: the slug must be in
 * the allowed set of the office the candidate is running for (their latest
 * office race), and the stance is validated by
 * validateCandidateRecordAreaLabels. Never touches an existing tag on the
 * same area — a different stance is reported as a conflict to untag first —
 * and the write itself is guarded: the insert only lands while the record
 * still holds the reviewed description and no tag on the area exists.
 *
 * Usage:
 *   npm run manual:records:tag -- --tags-file <path>
 *   npm run manual:records:tag -- --tags-file <path> --apply
 *
 * Also the path for label-only fixes on stored records, such as adding a
 * missing `general` tag. Unlike re-submitting through
 * `manual:candidate-records:write`, it never runs the whole-record-set
 * quality gate and never moves the candidate's records-research stamps
 * (`last_records_searched_at`, `last_records_researched_through`).
 *
 * Stance rules: `general` takes no stance (omit it or pass null); every
 * other area needs "for" or "against". `integrity_and_ethics` is refused:
 * it counts as a negative strike app-wide (auto-pick, skip-if-negative), so
 * adding one is a content judgment for the records writer, not a label fix.
 *
 * File format: JSON array of
 *   { recordId, researchAreaSlug, stance?, expectedDescription, reason, note? }.
 * expectedDescription pins what the operator reviewed (same staleness
 * discipline as the untag manifest): a row whose description moved since
 * review skips instead of tagging today's content. Dry run is the default;
 * --apply performs the upserts.
 *
 * Production: research:promote copies local tags to prod, so an applied tags
 * file needs no separate prod step — promote the candidates as usual.
 */

type TagInput = {
  recordId: string;
  researchAreaSlug: string;
  stance: CandidateRecordAreaStance | null;
  /** The record description the stance was judged against. */
  expectedDescription: string;
  reason: string;
  note?: string;
};

export type TagRecordRow = {
  candidate_id: string;
  description: string;
  /** Office of the candidate's latest office race; null when they have none. */
  office_id: string | null;
  office_name: string | null;
  /** Stance of the record's existing tag on this area; undefined when untagged. */
  existing_stance?: string | null;
};

type TagOutcome =
  | {
      recordId: string;
      researchAreaSlug: string;
      status: "tagged" | "would_tag";
      stance: CandidateRecordAreaStance | null;
      office: string;
      description: string;
      reason: string;
      note?: string;
    }
  | { recordId: string; researchAreaSlug: string; status: "skipped"; reason: string };

function parseArgs(argv: readonly string[]): { tagsFile: string; apply: boolean } {
  let tagsFile = "";
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tags-file") {
      tagsFile = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    throw new Error(`unknown flag(s): ${arg}`);
  }
  if (!tagsFile) {
    throw new Error("--tags-file <path> is required");
  }
  return { tagsFile, apply };
}

export function parseTagsFile(raw: string): TagInput[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("tags file must contain a JSON array");
  }
  // One entry per record/area: a repeated pair would insert once and then
  // report the second as "already tagged", failing the run after writing.
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`tags[${index}] must be an object`);
    }
    const { recordId, researchAreaSlug, stance, expectedDescription, reason, note } = entry as Record<string, unknown>;
    if (typeof recordId !== "string" || recordId.trim().length === 0) {
      throw new Error(`tags[${index}].recordId must be a non-empty string`);
    }
    if (typeof researchAreaSlug !== "string" || researchAreaSlug.trim().length === 0) {
      throw new Error(`tags[${index}].researchAreaSlug must be a non-empty string`);
    }
    // Lowercased here, once: the lookup, the validator, and the write must
    // all see the same slug, or a mixed-case manifest could miss an existing
    // tag in the lookup and then overwrite it in the write.
    const normalizedSlug = researchAreaSlug.trim().toLowerCase();
    // integrity_and_ethics counts as a strike app-wide, so adding one to a
    // stored record is a content judgment, not a label fix: it goes through
    // the records writer and its quality gate.
    if (normalizedSlug === INTEGRITY_AND_ETHICS_RESEARCH_AREA_SLUG) {
      throw new Error(
        `tags[${index}]: ${INTEGRITY_AND_ETHICS_RESEARCH_AREA_SLUG} is not taggable here; write it through manual:candidate-records:write`
      );
    }
    let normalizedStance: CandidateRecordAreaStance | null;
    if (normalizedSlug === GENERAL_RESEARCH_AREA_SLUG) {
      if (stance !== undefined && stance !== null) {
        throw new Error(`tags[${index}].stance must be omitted or null for ${GENERAL_RESEARCH_AREA_SLUG}`);
      }
      normalizedStance = null;
    } else if (stance === "for" || stance === "against") {
      normalizedStance = stance;
    } else {
      throw new Error(`tags[${index}].stance must be "for" or "against"`);
    }
    if (typeof expectedDescription !== "string" || expectedDescription.trim().length === 0) {
      throw new Error(`tags[${index}].expectedDescription must be the reviewed record description`);
    }
    const trimmedReason = typeof reason === "string" ? reason.trim() : "";
    if (trimmedReason.length < 10) {
      throw new Error(`tags[${index}].reason must state why the record takes this tag (at least 10 characters)`);
    }
    const key = `${recordId.trim()}:${normalizedSlug}`;
    if (seen.has(key)) {
      throw new Error(`tags[${index}] repeats ${key}; each record/area pair may appear once`);
    }
    seen.add(key);
    return {
      recordId: recordId.trim(),
      researchAreaSlug: normalizedSlug,
      stance: normalizedStance,
      expectedDescription,
      reason: trimmedReason,
      ...(typeof note === "string" ? { note } : {}),
    };
  });
}

export type TagDeps = {
  loadRecord: (recordId: string, researchAreaSlug: string) => Promise<TagRecordRow | null>;
  loadAllowedAreas: (officeId: string) => Promise<AllowedResearchArea[]>;
  /**
   * Compare-and-swap: inserts only if the record still holds the reviewed
   * description and carries no tag on the area. Returns the number of rows
   * inserted (0 = the row moved since it was read).
   */
  applyTag: (input: {
    recordId: string;
    researchAreaId: string;
    stance: CandidateRecordAreaStance | null;
    expectedDescription: string;
  }) => Promise<number>;
};

export async function tagOneRecordArea(
  tag: TagInput,
  deps: TagDeps,
  options: { apply: boolean }
): Promise<TagOutcome> {
  const skipped = (reason: string): TagOutcome => ({
    recordId: tag.recordId,
    researchAreaSlug: tag.researchAreaSlug,
    status: "skipped",
    reason,
  });
  const row = await deps.loadRecord(tag.recordId, tag.researchAreaSlug);
  if (!row) {
    return skipped("no live record with this id (mistyped id or retired record)");
  }
  // Reviewed-data drift guard, checked in dry-run too: the stance was decided
  // about the description in the manifest, so a row rewritten since review
  // must be re-read, not tagged on today's content.
  if (row.description !== tag.expectedDescription) {
    return skipped("record description no longer matches expectedDescription; the row changed since review — re-review before tagging");
  }
  if (row.existing_stance !== undefined) {
    return row.existing_stance === tag.stance
      ? skipped(`already tagged ${tag.researchAreaSlug}:${tag.stance}`)
      : skipped(`already tagged ${tag.researchAreaSlug}:${row.existing_stance ?? "null"}; untag it first`);
  }
  if (!row.office_id) {
    return skipped("candidate has no office race, so no allowed research-area set");
  }
  const allowed = await deps.loadAllowedAreas(row.office_id);
  const validation = validateCandidateRecordAreaLabels(
    [{ candidateRecordId: tag.recordId, researchAreaSlug: tag.researchAreaSlug, stance: tag.stance }],
    new Set(allowed.map((area) => area.slug))
  );
  if (!validation.ok) {
    return skipped(`${validation.failures.map((failure) => failure.reason).join("; ")} (office: ${row.office_name ?? row.office_id})`);
  }
  const office = row.office_name ?? row.office_id;
  if (!options.apply) {
    return {
      recordId: tag.recordId,
      researchAreaSlug: tag.researchAreaSlug,
      status: "would_tag",
      stance: tag.stance,
      office,
      description: row.description,
      reason: tag.reason,
      ...(tag.note ? { note: tag.note } : {}),
    };
  }
  const researchAreaId = allowed.find((area) => area.slug === tag.researchAreaSlug)?.id;
  if (!researchAreaId) {
    return skipped(`no research area id for ${tag.researchAreaSlug}`);
  }
  // The INSERT predicate uses the MANIFEST description, not the fresh read:
  // after the equality check above they are identical, so a mid-run rewrite
  // or a concurrently added tag can only make the insert a no-op.
  const inserted = await deps.applyTag({
    recordId: tag.recordId,
    researchAreaId,
    stance: tag.stance,
    expectedDescription: tag.expectedDescription,
  });
  if (inserted !== 1) {
    return skipped("record or its tags changed after they were read (concurrent write); nothing was written — review the current content and re-run");
  }
  return {
    recordId: tag.recordId,
    researchAreaSlug: tag.researchAreaSlug,
    status: "tagged",
    stance: tag.stance,
    office,
    description: row.description,
    reason: tag.reason,
    ...(tag.note ? { note: tag.note } : {}),
  };
}

function buildPoolDeps(pool: Pool): TagDeps {
  return {
    loadRecord: async (recordId, researchAreaSlug) => {
      const result = await pool.query<TagRecordRow & { tag_present: boolean }>(
        `SELECT cr.candidate_id,
                cr.description,
                latest.office_id::text AS office_id,
                latest.office_name,
                (t.id IS NOT NULL) AS tag_present,
                t.stance AS existing_stance
           FROM public.candidate_records cr
           LEFT JOIN LATERAL (
             SELECT e.office_id, o.scope || '/' || o.canonical_name AS office_name
               FROM public.candidate_elections ce
               JOIN public.elections e ON e.id = ce.election_id
               JOIN public.offices o ON o.id = e.office_id
              WHERE (ce.candidate_id = cr.candidate_id OR ce.running_mate_candidate_id = cr.candidate_id)
                AND e.race_type = 'office'
              ORDER BY e.election_date DESC
              LIMIT 1
           ) latest ON true
           LEFT JOIN public.research_areas ra ON ra.slug = $2
           LEFT JOIN public.candidate_record_area_tags t
             ON t.candidate_record_id = cr.id AND t.research_area_id = ra.id
          WHERE cr.id = $1
            AND cr.retired_at IS NULL`,
        [recordId, researchAreaSlug]
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const { tag_present, existing_stance, ...rest } = row;
      return tag_present ? { ...rest, existing_stance: existing_stance ?? null } : rest;
    },
    loadAllowedAreas: (officeId) => loadAllowedResearchAreasForOfficeId(pool, officeId),
    applyTag: async ({ recordId, researchAreaId, stance, expectedDescription }) => {
      const result = await pool.query(
        `INSERT INTO public.candidate_record_area_tags (candidate_record_id, research_area_id, stance)
         SELECT cr.id, $2, $3
           FROM public.candidate_records cr
          WHERE cr.id = $1
            AND cr.retired_at IS NULL
            AND cr.description = $4
         ON CONFLICT (candidate_record_id, research_area_id) DO NOTHING`,
        [recordId, researchAreaId, stance, expectedDescription]
      );
      return result.rowCount ?? 0;
    },
  };
}

async function main(): Promise<void> {
  const { tagsFile, apply } = parseArgs(process.argv.slice(2));
  const tags = parseTagsFile(await readFile(tagsFile, "utf8"));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for candidate record tagging");
  }
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const deps = buildPoolDeps(pool);
  const outcomes: TagOutcome[] = [];

  try {
    for (const tag of tags) {
      try {
        outcomes.push(await tagOneRecordArea(tag, deps, { apply }));
      } catch (error) {
        // One bad row must not abandon the batch: in --apply mode some tags
        // are already written by this point, and the report is the only
        // account of which.
        outcomes.push({
          recordId: tag.recordId,
          researchAreaSlug: tag.researchAreaSlug,
          status: "skipped",
          reason: `tag failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    const counts = outcomes.reduce<Record<string, number>>((acc, outcome) => {
      acc[outcome.status] = (acc[outcome.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", counts, outcomes }, null, 2));
    await pool.end();
  }

  for (const outcome of outcomes) {
    if (outcome.status === "skipped") {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("tagCandidateRecordAreas.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

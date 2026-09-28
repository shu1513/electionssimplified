import type { Pool, PoolClient } from "pg";

import { MAX_INITIALIZE_DISTRICT_IDS } from "../../constants/userDistricts.js";
import { isUuid } from "../../utils/uuid.js";

export { MAX_INITIALIZE_DISTRICT_IDS } from "../../constants/userDistricts.js";

type TransactionalDb = Pick<Pool, "connect">;
type TransactionClient = Pick<PoolClient, "query" | "release">;

export type ReplaceUserDistrictsResult = {
  districtCount: number;
};

export type ReplaceUserDistrictsErrorCode =
  | "invalid_user_id"
  | "invalid_district_ids"
  | "user_not_found"
  | "unknown_district_ids";

export class ReplaceUserDistrictsError extends Error {
  constructor(
    readonly code: ReplaceUserDistrictsErrorCode,
    message: string,
    readonly details: { unknownDistrictIds?: string[] } = {}
  ) {
    super(message);
    this.name = "ReplaceUserDistrictsError";
  }
}

type DistrictRow = {
  id: string;
  district_type: string;
};

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!isUuid(normalized)) {
    throw new ReplaceUserDistrictsError("invalid_user_id", "User ID must be a valid UUID");
  }
  return normalized;
}

function normalizeDistrictIds(districtIds: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const districtId of districtIds) {
    const trimmed = districtId.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!isUuid(trimmed)) {
      throw new ReplaceUserDistrictsError("invalid_district_ids", `District ID must be a valid UUID: ${trimmed}`);
    }
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }

  if (normalized.length === 0) {
    throw new ReplaceUserDistrictsError("invalid_district_ids", "At least one district ID is required");
  }
  if (normalized.length > MAX_INITIALIZE_DISTRICT_IDS) {
    throw new ReplaceUserDistrictsError(
      "invalid_district_ids",
      `At most ${MAX_INITIALIZE_DISTRICT_IDS} district IDs can be saved`
    );
  }

  return normalized;
}

async function rollbackQuietly(client: TransactionClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

export async function replaceUserDistricts(
  db: TransactionalDb,
  userId: string,
  districtIds: readonly string[]
): Promise<ReplaceUserDistrictsResult> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedDistrictIds = normalizeDistrictIds(districtIds);
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const user = await client.query<{ id: string }>(
      `
        SELECT id
        FROM public.users
        WHERE id = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [normalizedUserId]
    );
    if (user.rows.length === 0) {
      throw new ReplaceUserDistrictsError("user_not_found", "User not found");
    }

    const found = await client.query<DistrictRow>(
      `
        WITH requested AS (
          SELECT district_id, ord
          FROM unnest($1::uuid[]) WITH ORDINALITY AS requested(district_id, ord)
        )
        SELECT d.id::text AS id, d.district_type
        FROM requested
        JOIN public.districts AS d
          ON d.id = requested.district_id
        ORDER BY requested.ord ASC
      `,
      [normalizedDistrictIds]
    );

    if (found.rows.length !== normalizedDistrictIds.length) {
      const foundIds = new Set(found.rows.map((row) => row.id.toLowerCase()));
      const unknownDistrictIds = normalizedDistrictIds.filter((districtId) => !foundIds.has(districtId.toLowerCase()));
      throw new ReplaceUserDistrictsError(
        "unknown_district_ids",
        `Unknown district IDs: ${unknownDistrictIds.join(", ")}`,
        { unknownDistrictIds }
      );
    }

    await client.query(
      `
        DELETE FROM public.user_districts
        WHERE user_id = $1
      `,
      [normalizedUserId]
    );

    await client.query(
      `
        INSERT INTO public.user_districts (user_id, district_id, district_type)
        SELECT $1::uuid, district_id, district_type
        FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS replacement(district_id, district_type, ord)
        ORDER BY ord ASC
      `,
      [normalizedUserId, found.rows.map((row) => row.id), found.rows.map((row) => row.district_type)]
    );

    await client.query("COMMIT");
    return {
      districtCount: found.rows.length,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

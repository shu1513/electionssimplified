import type { Pool, PoolClient } from "pg";

import { MAX_INITIALIZE_DISTRICT_IDS } from "../../constants/userDistricts.js";
import { isUuid } from "../../utils/uuid.js";

export { MAX_INITIALIZE_DISTRICT_IDS } from "../../constants/userDistricts.js";

type TransactionalDb = Pick<Pool, "connect">;
type TransactionClient = Pick<PoolClient, "query" | "release">;

export type InitializeUserDistrictsStatus = "initialized" | "already_initialized";

export type InitializeUserDistrictsResult = {
  status: InitializeUserDistrictsStatus;
  districtCount: number;
};

export type InitializeUserDistrictsErrorCode =
  | "invalid_user_id"
  | "invalid_district_ids"
  | "user_not_found"
  | "unknown_district_ids";

export class InitializeUserDistrictsError extends Error {
  constructor(
    readonly code: InitializeUserDistrictsErrorCode,
    message: string,
    readonly details: { unknownDistrictIds?: string[] } = {}
  ) {
    super(message);
    this.name = "InitializeUserDistrictsError";
  }
}

type ExistingDistrictCountRow = {
  district_count: string | number;
};

type InsertDistrictsRow = {
  found_count: string | number;
  inserted_count: string | number;
};

function parseCount(value: string | number | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!isUuid(normalized)) {
    throw new InitializeUserDistrictsError("invalid_user_id", "User ID must be a valid UUID");
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
      throw new InitializeUserDistrictsError(
        "invalid_district_ids",
        `District ID must be a valid UUID: ${trimmed}`
      );
    }
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }

  if (normalized.length === 0) {
    throw new InitializeUserDistrictsError("invalid_district_ids", "At least one district ID is required");
  }
  if (normalized.length > MAX_INITIALIZE_DISTRICT_IDS) {
    throw new InitializeUserDistrictsError(
      "invalid_district_ids",
      `At most ${MAX_INITIALIZE_DISTRICT_IDS} district IDs can be initialized`
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

export async function initializeUserDistricts(
  db: TransactionalDb,
  userId: string,
  districtIds: readonly string[]
): Promise<InitializeUserDistrictsResult> {
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
      throw new InitializeUserDistrictsError("user_not_found", "User not found");
    }

    const existing = await client.query<ExistingDistrictCountRow>(
      `
        SELECT COUNT(*) AS district_count
        FROM public.user_districts
        WHERE user_id = $1
      `,
      [normalizedUserId]
    );
    const existingCount = parseCount(existing.rows[0]?.district_count);
    if (existingCount > 0) {
      await client.query("COMMIT");
      return {
        status: "already_initialized",
        districtCount: existingCount,
      };
    }

    const inserted = await client.query<InsertDistrictsRow>(
      `
        WITH requested AS (
          SELECT district_id
          FROM unnest($2::uuid[]) AS requested(district_id)
        ),
        found AS (
          SELECT d.id, d.district_type
          FROM requested
          JOIN public.districts AS d
            ON d.id = requested.district_id
        ),
        inserted AS (
          INSERT INTO public.user_districts (user_id, district_id, district_type)
          SELECT $1::uuid, found.id, found.district_type
          FROM found
          ON CONFLICT (user_id, district_id) DO NOTHING
          RETURNING district_id
        )
        SELECT
          (SELECT COUNT(*) FROM found) AS found_count,
          (SELECT COUNT(*) FROM inserted) AS inserted_count
      `,
      [normalizedUserId, normalizedDistrictIds]
    );

    const foundCount = parseCount(inserted.rows[0]?.found_count);
    if (foundCount !== normalizedDistrictIds.length) {
      const found = await client.query<{ id: string }>(
        `
          SELECT id
          FROM public.districts
          WHERE id = ANY($1::uuid[])
        `,
        [normalizedDistrictIds]
      );
      const foundIds = new Set(found.rows.map((row) => row.id.toLowerCase()));
      const unknownDistrictIds = normalizedDistrictIds.filter((districtId) => !foundIds.has(districtId.toLowerCase()));
      throw new InitializeUserDistrictsError(
        "unknown_district_ids",
        `Unknown district IDs: ${unknownDistrictIds.join(", ")}`,
        { unknownDistrictIds }
      );
    }

    await client.query("COMMIT");
    return {
      status: "initialized",
      districtCount: foundCount,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

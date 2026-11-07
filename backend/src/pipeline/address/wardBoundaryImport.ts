import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { STATE_FIPS_BY_ABBREVIATION } from "../../constants/usStates.js";
import { insertRetiredElectionIdentity } from "../elections/retiredElectionIdentities.js";
import {
  type BoundarySourceSpec,
  combineFeatureGeometries,
  fetchSourceFeatures,
  parseBoundarySourceSpec,
  stableJson,
} from "./localSpecialBoundaryImport.js";
import { LOCAL_BOUNDARY_MARGIN_METERS } from "./localSpecialDistrictEligibility.js";

type Queryable = Pick<PoolClient, "query">;
type FetchLike = Parameters<typeof fetchSourceFeatures>[1];

// A city council ward (or a school board's trustee area) is a seat with its
// own electorate inside a jurisdiction we already have a row for. Until its
// polygon is reviewed, the seat's election sits on the whole-city (or
// whole-school-district) row and every resident sees every ward. This module
// loads one official map of a body's wards as reviewed local_special rows,
// then moves the ward seats' elections from the jurisdiction row onto their
// ward rows, so address matching selects the one seat a voter can vote in.
//
// The office on each moved election is left alone: the ballot's government
// level keys off office.scope, so a council ward stays under "City" and a
// trustee area under "School"; only the district row changes.

const BODY_KEY_RE = /^[A-Z]{2}:[A-Z0-9][A-Z0-9_-]*:[A-Z0-9][A-Z0-9_-]*$/;
const SEAT_RE = /^[0-9]{1,2}[A-Z]?$/;
const JURISDICTION_TYPES = new Set(["place", "county", "school_unified", "school_secondary", "school_elementary"]);
const DEFAULT_FROM_ELECTION_DATE = "2026-11-01";
const AT_LARGE_RE = /\bat[-\s]?large\b/i;

/** A seat is usually one feature value; a board district made of two or
 * more council districts (Duval County FL's charter) lists each. */
export type WardSeat = { seat: string; source_values: string[] };

export type WardBoundaryImport = {
  state: string;
  jurisdiction: { district_type: string; geoid_compact: string };
  body_key: string;
  seat_name_template: string;
  boundary_vintage: string;
  eligibility_source_url: string;
  review_note: string;
  edge_margin_meters: number;
  source: BoundarySourceSpec;
  seats: WardSeat[];
  from_election_date: string;
  expected_source_sha256: string | null;
};

export type WardBoundary = { seat: string; district_key: string; district_name: string; geometry: unknown; sha256: string };

export type WardLayer = { sourceUrl: string; sourceSha256: string; boundaries: WardBoundary[] };

type ElectionRow = {
  id: string;
  official_ballot_title: string;
  official_ballot_title_key: string;
  election_date: string;
  race_type: string;
};

export type WardSeatElections = {
  seat: string;
  district_key: string;
  elections: { id: string; official_ballot_title: string; election_date: string }[];
};

export type WardElectionPlan = {
  jurisdiction_district_id: string;
  jurisdiction_name: string;
  seats: WardSeatElections[];
  /** Titles that name a ward or district but match no seat in the payload. */
  unmatched: { id: string; official_ballot_title: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function httpsGovUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /\.(gov|us)$/.test(url.hostname);
  } catch {
    return false;
  }
}

export function parseWardBoundaryImport(value: unknown): WardBoundaryImport {
  if (!isRecord(value)) throw new Error("payload must be a JSON object");
  const state = typeof value.state === "string" ? value.state.trim().toUpperCase() : "";
  if (!STATE_FIPS_BY_ABBREVIATION[state]) throw new Error("state must be a two-letter state code");
  const jurisdiction = value.jurisdiction;
  if (!isRecord(jurisdiction) || typeof jurisdiction.district_type !== "string" ||
    !JURISDICTION_TYPES.has(jurisdiction.district_type) ||
    typeof jurisdiction.geoid_compact !== "string" || !/^[0-9]{5,12}$/.test(jurisdiction.geoid_compact)) {
    throw new Error("jurisdiction needs a place/county/school district_type and a numeric geoid_compact");
  }
  if (typeof value.body_key !== "string" || !BODY_KEY_RE.test(value.body_key) || !value.body_key.startsWith(`${state}:`)) {
    throw new Error(`body_key must look like ${state}:BODY:CC and start with the state code`);
  }
  if (typeof value.seat_name_template !== "string" || !value.seat_name_template.includes("{seat}") ||
    value.seat_name_template.trim().length < 10) {
    throw new Error("seat_name_template must contain {seat}");
  }
  // Who votes is an election-office fact, so the source is a government
  // host. A city whose official site is not .gov/.us (cityoftulsa.org) says
  // so explicitly, and the review note must name the page.
  if (!httpsGovUrl(value.eligibility_source_url) &&
    !(value.eligibility_source_is_official_site === true && httpsUrl(value.eligibility_source_url))) {
    throw new Error("eligibility_source_url must be an HTTPS URL on a .gov or .us host (or set eligibility_source_is_official_site)");
  }
  if (typeof value.boundary_vintage !== "string" || !value.boundary_vintage.trim() ||
    typeof value.review_note !== "string" || value.review_note.trim().length < 40) {
    throw new Error("boundary_vintage and a substantive review_note are required");
  }
  const margin = value.edge_margin_meters ?? LOCAL_BOUNDARY_MARGIN_METERS;
  if (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0 || margin > LOCAL_BOUNDARY_MARGIN_METERS) {
    throw new Error(`edge_margin_meters must be a number from 0 to ${LOCAL_BOUNDARY_MARGIN_METERS}`);
  }
  if (!Array.isArray(value.seats) || value.seats.length === 0) throw new Error("seats must list every seat on the map");
  const seats: WardSeat[] = value.seats.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.seat !== "string") throw new Error(`seats[${index}] needs a seat string`);
    const seat = entry.seat.trim().toUpperCase();
    if (!SEAT_RE.test(seat)) throw new Error(`seats[${index}].seat must be a number with an optional letter (1, 10, 1A)`);
    const raw = entry.source_values ?? (entry.source_value === undefined ? undefined : [entry.source_value]);
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== "string" || !item.trim() || item.includes("'"))) {
      throw new Error(`seats[${index}] needs source_value (or source_values) as non-empty unquoted strings`);
    }
    return { seat, source_values: (raw as string[]).map((item) => item.trim()) };
  });
  const allValues = seats.flatMap((entry) => entry.source_values);
  if (new Set(seats.map((entry) => entry.seat)).size !== seats.length) throw new Error("seats repeat a seat label");
  if (new Set(allValues).size !== allValues.length) throw new Error("seats repeat a source value");
  const source = value.source;
  if (!isRecord(source) || typeof source.seat_field !== "string") throw new Error("source.seat_field is required");
  const spec = parseBoundarySourceSpec({
    kind: source.kind,
    url: source.url,
    match: { field: source.seat_field, values: allValues },
    // Two values for one seat combine like a dissolved layer's pieces.
    ...(source.dissolve === true || seats.some((entry) => entry.source_values.length > 1) ? { dissolve: true } : {}),
  }, "source");
  const fromDate = value.from_election_date ?? DEFAULT_FROM_ELECTION_DATE;
  if (typeof fromDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    throw new Error("from_election_date must be YYYY-MM-DD");
  }
  const hash = value.expected_source_sha256 ?? null;
  if (hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("expected_source_sha256 must be a lowercase SHA-256 hex digest");
  }
  return {
    state,
    jurisdiction: { district_type: jurisdiction.district_type, geoid_compact: jurisdiction.geoid_compact },
    body_key: value.body_key,
    seat_name_template: value.seat_name_template.trim(),
    boundary_vintage: value.boundary_vintage.trim(),
    eligibility_source_url: value.eligibility_source_url as string,
    review_note: value.review_note.trim(),
    edge_margin_meters: margin,
    source: spec,
    seats,
    from_election_date: fromDate,
    expected_source_sha256: hash,
  };
}

export function wardDistrictKey(bodyKey: string, seat: string): string {
  return `${bodyKey}:${seat}`;
}

export function wardDistrictName(template: string, seat: string): string {
  return template.replace("{seat}", seat);
}

/** One reviewed polygon per seat: the layer's features for a seat's value,
 * combined when the layer is a dissolved precinct layer. Every seat must
 * come back; fetchSourceFeatures already refuses a missing or duplicated
 * value and unusable geometry. */
export async function fetchWardLayer(payload: WardBoundaryImport, fetchImpl?: FetchLike): Promise<WardLayer> {
  const { url, features } = await fetchSourceFeatures(payload.source, fetchImpl ?? fetch);
  const field = payload.source.match.field;
  const boundaries = payload.seats.map((entry) => {
    const pieces = features.filter((feature) =>
      entry.source_values.includes(String((feature.properties as Record<string, unknown>)[field] ?? "").trim()));
    if (pieces.length === 0) throw new Error(`Official map has no feature for seat ${entry.seat} (${field}=${entry.source_values.join("|")})`);
    const geometry = combineFeatureGeometries(pieces);
    return {
      seat: entry.seat,
      district_key: wardDistrictKey(payload.body_key, entry.seat),
      district_name: wardDistrictName(payload.seat_name_template, entry.seat),
      geometry,
      sha256: createHash("sha256").update(stableJson({ seat: entry.seat, geometry })).digest("hex"),
    };
  });
  const sourceSha256 = createHash("sha256")
    .update(stableJson(boundaries.map((entry) => ({ seat: entry.seat, geometry: entry.geometry }))))
    .digest("hex");
  return { sourceUrl: url, sourceSha256, boundaries };
}

/** The seat a ballot title names, or null. "District 1" is not "District 10"
 * or "District 1A"; a leading zero ("District 01") is the same seat. The
 * lookbehind keeps a school district's own number ("Independent School
 * District No. 11 Board Member") from reading as a seat, as subDistrictSeat
 * does. */
export function seatPattern(seat: string): RegExp {
  const escaped = seat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    String.raw`(?<!school\s+(?:administrative\s+)?)\b(?:district|dist\.?|ward|trustee\s+area|subdistrict|sub-district|precinct|area|zone)\s*(?:no\.?\s*)?#?\s*0*${escaped}\b`,
    "i"
  );
}

// Any geographic designator at all, used to flag titles the payload's seats
// do not cover. Mirrors the shape of GEOGRAPHIC_SEAT_PATTERNS.
const ANY_SEAT_RE = /(?<!school\s+(?:administrative\s+)?)\b(?:district|dist\.?|ward|trustee\s+area|subdistrict|sub-district|precinct)\s*(?:no\.?\s*)?#?\s*(?:\d+[a-z]?|[ivxl]+)\b/i;

export function matchSeat(title: string, seats: readonly WardSeat[]): WardSeat | null {
  if (AT_LARGE_RE.test(title)) return null;
  const hits = seats.filter((entry) => seatPattern(entry.seat).test(title));
  if (hits.length > 1) throw new Error(`Title names more than one seat (${hits.map((entry) => entry.seat).join(", ")}): ${title}`);
  return hits[0] ?? null;
}

/** Which elections on the jurisdiction row move to which ward row. Only
 * office contests dated on or after from_election_date are considered; a
 * title that names a ward the payload does not list is reported, since a
 * half-moved body would show one ward correctly and another to everyone. */
export async function planWardElections(db: Queryable, payload: WardBoundaryImport): Promise<WardElectionPlan> {
  const district = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM public.districts WHERE district_type = $1 AND geoid_compact = $2`,
    [payload.jurisdiction.district_type, payload.jurisdiction.geoid_compact]
  );
  const row = district.rows[0];
  if (!row) throw new Error(`Jurisdiction ${payload.jurisdiction.district_type} ${payload.jurisdiction.geoid_compact} is not in districts`);
  const elections = await db.query<ElectionRow>(
    `SELECT id, official_ballot_title, official_ballot_title_key, election_date::text AS election_date, race_type
     FROM public.elections
     WHERE district_id = $1 AND race_type = 'office' AND election_date >= $2::date
     ORDER BY election_date, official_ballot_title`,
    [row.id, payload.from_election_date]
  );
  const bySeat = new Map<string, WardSeatElections>(payload.seats.map((entry) => [entry.seat, {
    seat: entry.seat,
    district_key: wardDistrictKey(payload.body_key, entry.seat),
    elections: [],
  }]));
  const unmatched: WardElectionPlan["unmatched"] = [];
  for (const election of elections.rows) {
    const seat = matchSeat(election.official_ballot_title, payload.seats);
    if (seat) {
      bySeat.get(seat.seat)?.elections.push({
        id: election.id,
        official_ballot_title: election.official_ballot_title,
        election_date: election.election_date,
      });
    } else if (!AT_LARGE_RE.test(election.official_ballot_title) && ANY_SEAT_RE.test(election.official_ballot_title)) {
      unmatched.push({ id: election.id, official_ballot_title: election.official_ballot_title });
    }
  }
  return { jurisdiction_district_id: row.id, jurisdiction_name: row.name, seats: [...bySeat.values()], unmatched };
}

export type WardImportResult = {
  districts_inserted: number;
  boundaries_attached: number;
  boundaries_skipped: number;
  elections_moved: number;
};

/** Writes every seat's district and verified boundary, then moves the
 * planned elections onto their ward rows, all in one transaction. A seat
 * whose row already carries a boundary keeps it (re-runs are safe); its
 * elections still move. The jurisdiction-row identity of each moved election
 * goes into the retired ledger so a later discovery pass on the city or
 * school row cannot write the ward seat back onto it. */
export async function importWardBoundaries(
  db: Queryable,
  payload: WardBoundaryImport,
  layer: WardLayer,
  plan: WardElectionPlan
): Promise<WardImportResult> {
  if (!payload.expected_source_sha256 || payload.expected_source_sha256 !== layer.sourceSha256) {
    throw new Error("Official map changed since review; repeat the dry run and source comparison");
  }
  if (plan.unmatched.length > 0) {
    throw new Error(`Titles name a seat the payload does not list: ${plan.unmatched.map((entry) => entry.official_ballot_title).join(" | ")}`);
  }
  const stateFips = STATE_FIPS_BY_ABBREVIATION[payload.state];
  const result: WardImportResult = { districts_inserted: 0, boundaries_attached: 0, boundaries_skipped: 0, elections_moved: 0 };
  const reviewNote = `${payload.review_note} Map hash ${layer.sourceSha256}; moved from ${plan.jurisdiction_name}.`;
  await db.query("BEGIN");
  try {
    for (const boundary of layer.boundaries) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO public.districts (district_type, geoid_compact, name, state, state_fips, population)
         VALUES ('local_special', $1, $2, $3, $4, NULL)
         ON CONFLICT (district_type, geoid_compact) DO NOTHING
         RETURNING id`,
        [boundary.district_key, boundary.district_name, payload.state, stateFips]
      );
      let districtId = inserted.rows[0]?.id;
      if (districtId) {
        result.districts_inserted += 1;
      } else {
        const existing = await db.query<{ id: string; has_boundary: boolean }>(
          `SELECT d.id, EXISTS (SELECT 1 FROM public.local_special_boundaries b WHERE b.district_id = d.id) AS has_boundary
           FROM public.districts d WHERE d.district_type = 'local_special' AND d.geoid_compact = $1`,
          [boundary.district_key]
        );
        const row = existing.rows[0];
        if (!row) throw new Error(`District ${boundary.district_key} could not be inserted or found`);
        districtId = row.id;
        if (row.has_boundary) result.boundaries_skipped += 1;
        else result.boundaries_attached += 1;
        if (row.has_boundary) {
          await moveElections(db, payload, plan, boundary.seat, districtId, result);
          continue;
        }
      }
      await db.query(
        `INSERT INTO public.local_special_boundaries
           (district_id, geometry, exclusion_geometry, boundary_source_url, boundary_source_sha256,
            boundary_vintage, eligibility_source_url, review_status, reviewed_at, review_note, edge_margin_meters)
         VALUES ($1, $2::jsonb, NULL, $3, $4, $5, $6, 'verified', now(), $7, $8)`,
        [districtId, JSON.stringify(boundary.geometry), layer.sourceUrl, boundary.sha256,
          payload.boundary_vintage, payload.eligibility_source_url, reviewNote, payload.edge_margin_meters]
      );
      await moveElections(db, payload, plan, boundary.seat, districtId, result);
    }
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function moveElections(
  db: Queryable,
  payload: WardBoundaryImport,
  plan: WardElectionPlan,
  seat: string,
  wardDistrictId: string,
  result: WardImportResult
): Promise<void> {
  const seatPlan = plan.seats.find((entry) => entry.seat === seat);
  for (const election of seatPlan?.elections ?? []) {
    const current = await db.query<ElectionRow>(
      `SELECT id, official_ballot_title, official_ballot_title_key, election_date::text AS election_date, race_type
       FROM public.elections WHERE id = $1 AND district_id = $2`,
      [election.id, plan.jurisdiction_district_id]
    );
    const row = current.rows[0];
    if (!row) throw new Error(`Election ${election.id} is no longer on ${plan.jurisdiction_name}; repeat the dry run`);
    const clash = await db.query<{ id: string }>(
      `SELECT id FROM public.elections
       WHERE district_id = $1 AND official_ballot_title_key = $2 AND election_date = $3::date`,
      [wardDistrictId, row.official_ballot_title_key, row.election_date]
    );
    if (clash.rows[0]) {
      throw new Error(`Ward row ${wardDistrictKey(payload.body_key, seat)} already carries "${row.official_ballot_title}" (${clash.rows[0].id}); supersede one of them first`);
    }
    // A deferral row keys on (election_id, district_id); move it with the
    // election. The pair FK is not deferrable, so the rows go out and back.
    const deferrals = await db.query<Record<string, unknown>>(
      `DELETE FROM public.manual_research_deferrals WHERE election_id = $1 RETURNING *`,
      [row.id]
    );
    await db.query(`UPDATE public.elections SET district_id = $1, updated_at = now() WHERE id = $2`, [wardDistrictId, row.id]);
    for (const deferral of deferrals.rows) {
      const columns = Object.keys(deferral).filter((column) => column !== "district_id");
      await db.query(
        `INSERT INTO public.manual_research_deferrals (${[...columns, "district_id"].map((column) => `"${column}"`).join(", ")})
         VALUES (${[...columns, "district_id"].map((_, index) => `$${index + 1}`).join(", ")})`,
        [...columns.map((column) => deferral[column]), wardDistrictId]
      );
    }
    await insertRetiredElectionIdentity(db, {
      districtId: plan.jurisdiction_district_id,
      electionDate: row.election_date,
      officialBallotTitle: row.official_ballot_title,
      officialBallotTitleKey: row.official_ballot_title_key,
      raceType: row.race_type,
      electionId: row.id,
      action: "superseded",
      reason: `Moved onto reviewed ward row ${wardDistrictKey(payload.body_key, seat)}; the seat's voters are that ward's residents`,
      sourceUrl: payload.eligibility_source_url,
      supersededByElectionIds: [row.id],
    });
    result.elections_moved += 1;
  }
}

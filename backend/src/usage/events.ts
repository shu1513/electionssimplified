// First-party usage analytics — docs/plans/usage-analytics.md.
//
// The event catalog and its validation live here, on the write path: every
// name, route and prop the table can hold is enumerated below, so the
// database can only ever contain what this file allows. Privacy is enforced
// by omission — there is no place in the schema for an address, a district
// id, a candidate id, an election id, a user id or free text.
//
// Validation is per event, not per batch: one bad event is dropped and
// counted, its siblings are stored. A single client bug must never erase a
// whole session's trail.

import type { Pool } from "pg";
import { RequestValidationError } from "../utils/requestValidationError.js";

export const USAGE_PAYLOAD_VERSION = 1;
export const MAX_USAGE_EVENTS_PER_REQUEST = 40;
// Sessions rotate after 30 idle minutes, but a tab left open can keep one
// alive for days; a week bounds the offset without truncating real use.
const MAX_CLIENT_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROPS_BYTES = 300;

// Route ids the frontend maps React Router matches onto (frontend/src/lib/
// usage.ts ROUTE_NAMES). Kept in sync by hand — the two lists are short and
// a drift shows up as dropped events in the report, never as bad data.
export const USAGE_ROUTES = [
  "home",
  "ballot",
  "draft",
  "election",
  "candidate",
  "mission",
  "support",
  "support_member",
  "support_once",
  "disclaimer",
  "terms",
  "privacy",
  "register",
  "login",
  "forgot_password",
  "reset_password",
  "verify_email",
  "verify_email_change",
  "welcome",
  "saved_ballot",
  "picks",
  "follows",
  "settings",
  "pick_card",
  "city",
  "not_found",
  "other",
] as const;

// Lower-case slug we issue ourselves (newsroom-embed publisher codes). The
// client only sends codes from its allowlist; this keeps free text out even
// if a client is wrong.
const CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CODE_LENGTH = 48;

type PropRule =
  | { kind: "bool" }
  | { kind: "int"; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "state_codes" }
  | { kind: "code" };

const bool: PropRule = { kind: "bool" };
const int = (min: number, max: number): PropRule => ({ kind: "int", min, max });
const oneOf = (...values: string[]): PropRule => ({ kind: "enum", values });

const COUNT_BUCKETS = ["0", "1-3", "4-10", "11-25", "26+"] as const;
const AUTH_STATES = ["unknown", "guest", "signed_in"] as const;

// name → { prop: rule, ... }; `optional` props may be absent, everything else
// must be present. Unknown keys are dropped silently (a newer client than the
// server is not an error), invalid values drop the event.
const CATALOG: Record<string, { required: Record<string, PropRule>; optional?: Record<string, PropRule> }> = {
  session_start: {
    required: {
      referrer_bucket: oneOf("search", "social", "direct", "internal", "other"),
      device: oneOf("phone", "tablet", "desktop"),
      landing_route: oneOf(...USAGE_ROUTES),
      had_saved_draft: bool,
      auth: oneOf(...AUTH_STATES),
    },
    // Where a session arrived from when a partner link tagged it: the
    // newsroom-embed publisher code (docs/plans/usage-analytics.md §3 —
    // an allowlist we set, never a UTM value). The allowlist itself lives in
    // the frontend manifest, so the server checks shape only; anyone can
    // post a well-formed unknown code here. Reporting must therefore join
    // this value against the manifest's publisher list and ignore the rest.
    optional: { source: { kind: "code" } },
  },
  auth_resolved: { required: { auth: oneOf("guest", "signed_in") } },
  // Detail pages (election, candidate) describe their content shape and how
  // the reader arrived; every prop is optional because most routes send
  // none. Never an id.
  page_view: {
    required: {},
    optional: {
      // Where the reader came from: a ballot list, an election's roster (to a
      // candidate), a candidate page (back to an election), the draft/picks
      // pages, a shared pick card, or nowhere in-app (deep link, chatbot card).
      arrival: oneOf("list", "roster", "candidate", "draft", "picks", "share", "deep"),
      race_type: oneOf("office", "ballot_measure"),
      office_level: oneOf("federal", "state", "county", "city", "school", "other"),
      upcoming: bool,
      has_summary: bool,
      has_stance_tags: bool,
      has_official_url: bool,
      measure_tbd: bool,
      has_finance: bool,
      candidate_count_bucket: oneOf(...COUNT_BUCKETS),
      record_count_bucket: oneOf(...COUNT_BUCKETS),
    },
  },
  page_time: { required: { visible_ms: int(0, 86_400_000) } },
  error_shown: {
    required: { category: oneOf("not_found", "rate_limited", "server", "network", "address", "render", "other") },
  },
  address_input: { required: {} },
  address_suggestion: { required: { granularity: oneOf("address", "zip", "region", "unsupported") } },
  why_address_open: { required: { after_input: bool } },
  address_submit: { required: { via_suggestion: bool } },
  terms_shown: { required: {} },
  terms_decision: { required: { decision: oneOf("agree", "cancel"), open_ms: int(0, 3_600_000) } },
  terms_doc_open: { required: { doc: oneOf("terms", "privacy", "disclaimer") } },
  address_result: {
    required: { outcome: oneOf("exact", "zip", "region", "error"), latency_ms: int(0, 120_000) },
    optional: { error_category: oneOf("address", "not_found", "rate_limited", "server", "network", "other") },
  },
  ballot_result: {
    required: {
      outcome: oneOf("ready", "empty", "error"),
      scope: oneOf("exact", "zip", "region", "unknown"),
      states: { kind: "state_codes" },
      election_count_bucket: oneOf(...COUNT_BUCKETS),
      district_count_bucket: oneOf(...COUNT_BUCKETS),
      partial_banner: bool,
      ambiguous_banner: bool,
    },
  },
  list_control: {
    required: {
      control: oneOf(
        "sort",
        "filter_issues",
        "filter_impact",
        "show_all",
        "race_tab",
        "how_to_vote",
        "how_to_vote_link",
        "followed_first",
        "view_toggle",
        "retention_group"
      ),
      value: oneOf(
        // sort values (BALLOT_SORTS) and rail-equivalent words
        "vote_power",
        "soonest",
        "district_size",
        "district_size_smallest",
        "my_areas",
        "state_baseline",
        // booleans and thresholds
        "on",
        "off",
        "high",
        "medium",
        "any",
        // race tabs / views / links
        "all",
        "office",
        "ballot_measure",
        "list",
        "ballot",
        "open",
        "close",
        "mail",
        "polling",
        "registration",
        "other"
      ),
    },
  },
  election_open: {
    required: {
      race_type: oneOf("office", "ballot_measure"),
      vote_power: oneOf("very_low", "low", "medium", "above_average", "high", "very_high", "unknown", "retention"),
      position_bucket: oneOf("1-3", "4-10", "11+"),
      awaiting: bool,
    },
  },
  partial_upgrade_click: { required: { banner: oneOf("partial", "ambiguous") } },

  // --- PR 2: research and pick flows (docs/plans/usage-analytics.md) ----
  // A detail page's content shape, so decision rates can be read against
  // what the page had to offer — never which election or candidate it was.
  section_exposed: {
    required: {
      section: oneOf(
        "vote_power",
        "office",
        "measure_summary",
        "measure_yes_no",
        "candidates",
        "results",
        "summary",
        "stance",
        "finance",
        "track_record"
      ),
    },
  },
  candidate_open: {
    required: { position_bucket: oneOf("1-3", "4-10", "11+"), has_summary: bool, has_stances: bool, incumbent: bool },
  },
  detail_control: {
    required: {
      control: oneOf(
        "party_filter",
        "roster_sort",
        "rail_tab",
        "rail_sort",
        "rail_item",
        "pager_prev",
        "pager_next",
        "pager_back",
        "record_view",
        "records_show_all",
        "finance_toggle",
        "record_group_toggle",
        "vote_power_how"
      ),
      value: oneOf(
        "all",
        "democratic",
        "republican",
        "other",
        "my_issues",
        "my_areas",
        "alphabetical",
        "vote_power",
        "soonest",
        "office",
        "ballot_measure",
        "newest",
        "open",
        "close",
        "none"
      ),
    },
  },
  official_source_click: {
    required: {
      kind: oneOf("measure_official", "record_source", "election_source", "result_source", "profile_link"),
      gov: bool,
      pdf: bool,
    },
  },
  pick_attempt: {
    required: {
      kind: oneOf("candidate", "measure"),
      surface: oneOf("election_inline", "candidate_card", "candidate_row", "measure_card", "stranded"),
      store: oneOf("account", "draft"),
      change: oneOf("added", "changed", "removed"),
      ms_since_view: int(0, 86_400_000),
    },
  },
  pick_result: {
    required: {
      kind: oneOf("candidate", "measure"),
      surface: oneOf("election_inline", "candidate_card", "candidate_row", "measure_card", "stranded"),
      store: oneOf("account", "draft"),
      change: oneOf("added", "changed", "removed"),
      outcome: oneOf("saved", "draft_memory", "error"),
    },
    optional: { error_category: oneOf("address", "not_found", "rate_limited", "server", "network", "other") },
  },
  autopick_attempt: {
    required: { scope: oneOf("election", "date"), prompted_rank_issues: bool, races_bucket: oneOf(...COUNT_BUCKETS) },
  },
  autopick_result: {
    required: {
      scope: oneOf("election", "date"),
      outcome: oneOf("picked", "no_pick", "mixed", "error"),
      races_bucket: oneOf(...COUNT_BUCKETS),
    },
    optional: {
      // AutoPickReason (packages/api-client/src/types.ts) — the single-race
      // control's no-pick reason; a date fill has many and reports none.
      reason: oneOf(
        "by_elimination",
        "insufficient_evidence",
        "only_negative_evidence",
        "tie",
        "all_vetoed",
        "veto",
        "too_few_issues",
        "election_closed"
      ),
      error_category: oneOf("address", "not_found", "rate_limited", "server", "network", "other"),
    },
  },
  address_nudge_click: { required: {} },
  post_pick_click: { required: { target: oneOf("back", "draft") } },
  share_open: { required: { subject: oneOf("election", "candidate", "picks") } },
  draft_review: {
    required: { pick_count_bucket: oneOf(...COUNT_BUCKETS), view: oneOf("list", "ballot"), store: oneOf("account", "draft") },
  },
  signup_prompt: {
    required: { source: oneOf("follow", "pick", "draft", "milestone", "picks_wall", "chat", "autopick"), action: oneOf("shown", "click") },
  },
  auth_result: {
    required: {
      action: oneOf("login", "register", "google_login", "google_signup", "logout"),
      outcome: oneOf("ok", "error"),
      has_next: bool,
    },
    optional: { error_category: oneOf("address", "not_found", "rate_limited", "server", "network", "other") },
  },
  welcome_result: {
    required: { action: oneOf("save", "skip"), ranked_count_bucket: oneOf(...COUNT_BUCKETS) },
    // Which of the two welcome screens the user was on (pick issues / rank them).
    optional: { step: oneOf("pick", "rank") },
  },
  handoff_result: { required: { outcome: oneOf("done", "rejected", "failed") } },
  draft_complete_notice: { required: { action: oneOf("shown", "review", "dismiss") } },
  follow_result: {
    required: { change: oneOf("follow", "unfollow"), outcome: oneOf("ok", "error") },
    optional: { error_category: oneOf("address", "not_found", "rate_limited", "server", "network", "other") },
  },
  // Chat (PR 3): the widget's question text stays in chatbot.questions with
  // no join key — these carry only how the chat was entered and what kind
  // of answer came back.
  chat_open: {
    required: { context_kind: oneOf("candidate", "election", "none"), wall: oneOf("none", "register", "verify") },
  },
  chat_ask: {
    required: {
      entry: oneOf("typed", "starter", "followup"),
      context_kind: oneOf("candidate", "election", "none"),
      first_turn: bool,
      outcome: oneOf("ok", "error"),
    },
    optional: {
      answer: oneOf("template", "retrieval", "clarify", "refuse_no_data", "refuse_policy", "other"),
      result_count_bucket: oneOf(...COUNT_BUCKETS),
      ai_generated: bool,
      error_category: oneOf("address", "not_found", "rate_limited", "server", "network", "other"),
    },
  },
  chat_result_click: {
    required: {
      source: oneOf("candidate", "record", "finance", "election", "measure", "official", "source", "page", "other"),
      position_bucket: oneOf("1-3", "4-10", "11+"),
    },
  },
  chat_feedback: {
    required: { verdict: oneOf("up", "down"), outcome: oneOf("ok", "error") },
    optional: { error_category: oneOf("address", "not_found", "rate_limited", "server", "network", "other") },
  },
  // Support (PR 3): the Checkout session request settled — not proof of
  // payment, and never an amount.
  checkout_start: {
    required: { kind: oneOf("monthly", "one_time"), outcome: oneOf("ok", "error") },
    optional: { error_category: oneOf("address", "not_found", "rate_limited", "server", "network", "other") },
  },
};

export const USAGE_EVENT_NAMES: readonly string[] = Object.keys(CATALOG);

export type UsageEventRow = {
  eventId: string;
  sessionId: string;
  pageViewId: string | null;
  name: string;
  route: string;
  clientOffsetMs: number;
  props: Record<string, unknown>;
};

export type ParsedUsageEvents = {
  accepted: UsageEventRow[];
  dropped: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_CODE_RE = /^[A-Z]{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function checkProp(rule: PropRule, value: unknown): boolean {
  switch (rule.kind) {
    case "bool":
      return typeof value === "boolean";
    case "int":
      return typeof value === "number" && Number.isInteger(value) && value >= rule.min && value <= rule.max;
    case "enum":
      return typeof value === "string" && rule.values.includes(value);
    case "state_codes":
      return (
        Array.isArray(value) &&
        value.length <= 3 &&
        value.every((entry) => typeof entry === "string" && STATE_CODE_RE.test(entry))
      );
    case "code":
      return typeof value === "string" && value.length <= MAX_CODE_LENGTH && CODE_RE.test(value);
  }
}

/** One event → a row, or null when anything about it is outside the catalog. */
export function parseUsageEvent(value: unknown): UsageEventRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const { event_id, session_id, page_view_id, name, route, client_offset_ms, props } = value;
  if (!isUuid(event_id) || !isUuid(session_id)) {
    return null;
  }
  if (page_view_id !== null && page_view_id !== undefined && !isUuid(page_view_id)) {
    return null;
  }
  if (typeof name !== "string" || !Object.hasOwn(CATALOG, name)) {
    return null;
  }
  if (typeof route !== "string" || !(USAGE_ROUTES as readonly string[]).includes(route)) {
    return null;
  }
  if (
    typeof client_offset_ms !== "number" ||
    !Number.isInteger(client_offset_ms) ||
    client_offset_ms < 0 ||
    client_offset_ms > MAX_CLIENT_OFFSET_MS
  ) {
    return null;
  }
  const rawProps = props === undefined || props === null ? {} : props;
  if (!isRecord(rawProps)) {
    return null;
  }
  const schema = CATALOG[name]!;
  const kept: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(schema.required)) {
    if (!checkProp(rule, rawProps[key])) {
      return null;
    }
    kept[key] = rawProps[key];
  }
  for (const [key, rule] of Object.entries(schema.optional ?? {})) {
    const entry = rawProps[key];
    if (entry === undefined || entry === null) {
      continue;
    }
    if (!checkProp(rule, entry)) {
      return null;
    }
    kept[key] = entry;
  }
  if (JSON.stringify(kept).length > MAX_PROPS_BYTES) {
    return null;
  }
  return {
    eventId: event_id.toLowerCase(),
    sessionId: session_id.toLowerCase(),
    pageViewId: typeof page_view_id === "string" ? page_view_id.toLowerCase() : null,
    name,
    route,
    clientOffsetMs: client_offset_ms,
    props: kept,
  };
}

/**
 * Request body → accepted rows + dropped count. Throws (→ 400 via the
 * TypeError mapping) only when the envelope itself is unusable; individual
 * bad events never fail the request.
 */
export function parseUsageEventsBodyValue(parsed: unknown): ParsedUsageEvents {
  if (!isRecord(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  if (parsed.v !== USAGE_PAYLOAD_VERSION) {
    throw new RequestValidationError(`v must be ${USAGE_PAYLOAD_VERSION}`);
  }
  const events = parsed.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new RequestValidationError("events must be a non-empty array");
  }
  if (events.length > MAX_USAGE_EVENTS_PER_REQUEST) {
    throw new RequestValidationError(`events must contain at most ${MAX_USAGE_EVENTS_PER_REQUEST} items`);
  }
  const accepted: UsageEventRow[] = [];
  let dropped = 0;
  for (const entry of events) {
    const row = parseUsageEvent(entry);
    if (row) {
      accepted.push(row);
    } else {
      dropped += 1;
    }
  }
  return { accepted, dropped };
}

/** One bounded multi-row insert; duplicates (client retries) are no-ops.
 * Untargeted ON CONFLICT on purpose: naming the arbiter column (`ON CONFLICT
 * (event_id)`) makes Postgres require SELECT on it, which the INSERT-only API
 * role does not have (42501 verified). The primary key is the table's only
 * unique constraint, so the two forms mean the same thing. */
export async function insertUsageEvents(db: Pool, rows: readonly UsageEventRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db.query(
    `
      INSERT INTO usage.events (event_id, session_id, page_view_id, name, route, client_offset_ms, v, props)
      SELECT * FROM unnest(
        $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::integer[], $7::smallint[], $8::jsonb[]
      )
      ON CONFLICT DO NOTHING
    `,
    [
      rows.map((row) => row.eventId),
      rows.map((row) => row.sessionId),
      rows.map((row) => row.pageViewId),
      rows.map((row) => row.name),
      rows.map((row) => row.route),
      rows.map((row) => row.clientOffsetMs),
      rows.map(() => USAGE_PAYLOAD_VERSION),
      rows.map((row) => JSON.stringify(row.props)),
    ]
  );
}

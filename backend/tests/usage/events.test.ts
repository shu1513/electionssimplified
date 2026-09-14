import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  insertUsageEvents,
  MAX_USAGE_EVENTS_PER_REQUEST,
  parseUsageEvent,
  parseUsageEventsBodyValue,
} from "../../src/usage/events.js";
import { RequestValidationError } from "../../src/utils/requestValidationError.js";

const EVENT_ID = "0b1d2f3a-4c5e-4f60-8a71-829394a5b6c7";
const SESSION_ID = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
const PAGE_VIEW_ID = "2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6";

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: EVENT_ID,
    session_id: SESSION_ID,
    page_view_id: PAGE_VIEW_ID,
    name: "page_view",
    route: "home",
    client_offset_ms: 1234,
    props: {},
    ...overrides,
  };
}

describe("parseUsageEvent", () => {
  it("accepts a catalog event and lower-cases its ids", () => {
    expect(parseUsageEvent(event({ event_id: EVENT_ID.toUpperCase() }))).toEqual({
      eventId: EVENT_ID,
      sessionId: SESSION_ID,
      pageViewId: PAGE_VIEW_ID,
      name: "page_view",
      route: "home",
      clientOffsetMs: 1234,
      props: {},
    });
  });

  it("keeps only the catalog's props for the event name", () => {
    const row = parseUsageEvent(
      event({
        name: "ballot_result",
        route: "ballot",
        props: {
          outcome: "ready",
          scope: "zip",
          states: ["CA"],
          election_count_bucket: "4-10",
          district_count_bucket: "1-3",
          partial_banner: true,
          ambiguous_banner: false,
          // Not in the catalog: dropped, never stored.
          district_ids: ["d-1"],
          matched_address: "123 Main St",
        },
      })
    );
    expect(row?.props).toEqual({
      outcome: "ready",
      scope: "zip",
      states: ["CA"],
      election_count_bucket: "4-10",
      district_count_bucket: "1-3",
      partial_banner: true,
      ambiguous_banner: false,
    });
  });

  it("drops the event when a required prop is missing or off-enum", () => {
    expect(parseUsageEvent(event({ name: "address_result", props: { outcome: "exact" } }))).toBeNull();
    expect(
      parseUsageEvent(event({ name: "address_result", props: { outcome: "found", latency_ms: 10 } }))
    ).toBeNull();
    expect(parseUsageEvent(event({ name: "page_time", props: { visible_ms: -1 } }))).toBeNull();
    expect(parseUsageEvent(event({ name: "page_time", props: { visible_ms: 12.5 } }))).toBeNull();
  });

  it("accepts every how-to-vote link kind the panel can emit", () => {
    for (const value of ["mail", "polling", "registration"]) {
      expect(
        parseUsageEvent(event({ name: "list_control", route: "ballot", props: { control: "how_to_vote_link", value } }))
          ?.props
      ).toEqual({ control: "how_to_vote_link", value });
    }
    expect(
      parseUsageEvent(
        event({ name: "list_control", route: "ballot", props: { control: "how_to_vote_link", value: "donate" } })
      )
    ).toBeNull();
  });

  it("accepts optional props only when valid", () => {
    const base = { outcome: "error", latency_ms: 500 };
    expect(parseUsageEvent(event({ name: "address_result", props: base }))?.props).toEqual(base);
    expect(
      parseUsageEvent(event({ name: "address_result", props: { ...base, error_category: "server" } }))?.props
    ).toEqual({ ...base, error_category: "server" });
    expect(
      parseUsageEvent(event({ name: "address_result", props: { ...base, error_category: "weird" } }))
    ).toBeNull();
  });

  it("rejects states that are not two-letter codes or exceed three entries", () => {
    const props = {
      outcome: "ready",
      scope: "exact",
      election_count_bucket: "1-3",
      district_count_bucket: "1-3",
      partial_banner: false,
      ambiguous_banner: false,
    };
    expect(parseUsageEvent(event({ name: "ballot_result", props: { ...props, states: ["ca"] } }))).toBeNull();
    expect(
      parseUsageEvent(event({ name: "ballot_result", props: { ...props, states: ["CA", "NV", "OR", "WA"] } }))
    ).toBeNull();
    expect(parseUsageEvent(event({ name: "ballot_result", props: { ...props, states: [] } }))).not.toBeNull();
  });

  it("accepts detail-page content props on page_view and drops ids", () => {
    const row = parseUsageEvent(
      event({
        route: "election",
        props: {
          arrival: "list",
          race_type: "ballot_measure",
          office_level: "county",
          upcoming: true,
          has_summary: true,
          has_stance_tags: false,
          has_official_url: true,
          measure_tbd: false,
          candidate_count_bucket: "0",
          election_id: "e-1",
        },
      })
    );
    expect(row?.props).toEqual({
      arrival: "list",
      race_type: "ballot_measure",
      office_level: "county",
      upcoming: true,
      has_summary: true,
      has_stance_tags: false,
      has_official_url: true,
      measure_tbd: false,
      candidate_count_bucket: "0",
    });
    expect(parseUsageEvent(event({ route: "election", props: { arrival: "rail" } }))).toBeNull();
  });

  it("validates the pick and follow outcome events", () => {
    const pick = {
      kind: "measure",
      surface: "measure_card",
      store: "draft",
      change: "added",
      outcome: "draft_memory",
    };
    expect(parseUsageEvent(event({ name: "pick_result", route: "election", props: pick }))?.props).toEqual(pick);
    expect(parseUsageEvent(event({ name: "pick_result", route: "election", props: { ...pick, outcome: "yes" } }))).toBeNull();
    expect(
      parseUsageEvent(event({ name: "pick_result", route: "election", props: { ...pick, position: "yes" } }))?.props
    ).toEqual(pick);
    expect(
      parseUsageEvent(
        event({ name: "follow_result", route: "candidate", props: { change: "follow", outcome: "error", error_category: "server" } })
      )?.props
    ).toEqual({ change: "follow", outcome: "error", error_category: "server" });
    expect(
      parseUsageEvent(
        event({ name: "autopick_result", route: "election", props: { scope: "election", outcome: "no_pick", races_bucket: "1-3", reason: "tie" } })
      )?.props
    ).toEqual({ scope: "election", outcome: "no_pick", races_bucket: "1-3", reason: "tie" });
  });

  it("validates the chat and checkout events", () => {
    const ask = { entry: "typed", context_kind: "candidate", first_turn: true, outcome: "ok" };
    expect(
      parseUsageEvent(
        event({ name: "chat_ask", route: "candidate", props: { ...ask, answer: "retrieval", result_count_bucket: "1-3", ai_generated: false } })
      )?.props
    ).toEqual({ ...ask, answer: "retrieval", result_count_bucket: "1-3", ai_generated: false });
    // Question text has no slot; an unknown answer kind drops the event.
    expect(
      parseUsageEvent(event({ name: "chat_ask", route: "candidate", props: { ...ask, question: "who is running?" } }))?.props
    ).toEqual(ask);
    expect(parseUsageEvent(event({ name: "chat_ask", route: "candidate", props: { ...ask, answer: "prose" } }))).toBeNull();
    expect(parseUsageEvent(event({ name: "chat_ask", route: "candidate", props: { ...ask, entry: "voice" } }))).toBeNull();
    expect(
      parseUsageEvent(event({ name: "chat_open", route: "ballot", props: { context_kind: "none", wall: "register" } }))?.props
    ).toEqual({ context_kind: "none", wall: "register" });
    expect(
      parseUsageEvent(event({ name: "chat_result_click", route: "ballot", props: { source: "official", position_bucket: "1-3" } }))?.props
    ).toEqual({ source: "official", position_bucket: "1-3" });
    expect(
      parseUsageEvent(event({ name: "chat_feedback", route: "ballot", props: { verdict: "down", outcome: "ok" } }))?.props
    ).toEqual({ verdict: "down", outcome: "ok" });
    expect(
      parseUsageEvent(
        event({ name: "checkout_start", route: "support_once", props: { kind: "one_time", outcome: "error", error_category: "server", amount_cents: 1200 } })
      )?.props
    ).toEqual({ kind: "one_time", outcome: "error", error_category: "server" });
    expect(parseUsageEvent(event({ name: "checkout_start", route: "support_once", props: { kind: "yearly", outcome: "ok" } }))).toBeNull();
  });

  it("rejects unknown names, unknown routes, and raw paths in the route field", () => {
    expect(parseUsageEvent(event({ name: "click" }))).toBeNull();
    expect(parseUsageEvent(event({ route: "/picks/abc123" }))).toBeNull();
    expect(parseUsageEvent(event({ route: "not_found" }))).not.toBeNull();
  });

  it("rejects malformed ids and offsets", () => {
    expect(parseUsageEvent(event({ event_id: "not-a-uuid" }))).toBeNull();
    expect(parseUsageEvent(event({ session_id: 42 }))).toBeNull();
    expect(parseUsageEvent(event({ page_view_id: "nope" }))).toBeNull();
    expect(parseUsageEvent(event({ page_view_id: null }))?.pageViewId).toBeNull();
    expect(parseUsageEvent(event({ client_offset_ms: -5 }))).toBeNull();
    expect(parseUsageEvent(event({ client_offset_ms: 8 * 24 * 3600 * 1000 }))).toBeNull();
    expect(parseUsageEvent(event({ client_offset_ms: "12" }))).toBeNull();
  });
});

describe("parseUsageEventsBodyValue", () => {
  it("keeps valid siblings of an invalid event and counts the drop", () => {
    const parsed = parseUsageEventsBodyValue({
      v: 1,
      events: [event(), event({ name: "nope" }), event({ event_id: PAGE_VIEW_ID, name: "address_input" })],
    });
    expect(parsed.accepted.map((row) => row.name)).toEqual(["page_view", "address_input"]);
    expect(parsed.dropped).toBe(1);
  });

  it("rejects an unusable envelope with a RequestValidationError (→ 400)", () => {
    expect(() => parseUsageEventsBodyValue(null)).toThrow(RequestValidationError);
    expect(() => parseUsageEventsBodyValue({ v: 2, events: [event()] })).toThrow(/v must be 1/);
    expect(() => parseUsageEventsBodyValue({ v: 1, events: [] })).toThrow(/non-empty/);
    expect(() =>
      parseUsageEventsBodyValue({ v: 1, events: Array.from({ length: MAX_USAGE_EVENTS_PER_REQUEST + 1 }, () => event()) })
    ).toThrow(/at most/);
  });
});

describe("insertUsageEvents", () => {
  it("issues one multi-row insert that ignores duplicate event ids", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return { rows: [], rowCount: 2 };
      },
    } as unknown as Pool;
    const rows = parseUsageEventsBodyValue({
      v: 1,
      events: [event(), event({ event_id: PAGE_VIEW_ID, name: "address_input", page_view_id: null })],
    }).accepted;
    await insertUsageEvents(pool, rows);
    expect(calls).toHaveLength(1);
    // Untargeted: a named arbiter column would need SELECT, which the
    // INSERT-only API role lacks (see insertUsageEvents).
    expect(calls[0]!.text).toContain("ON CONFLICT DO NOTHING");
    expect(calls[0]!.text).not.toContain("ON CONFLICT (");
    expect(calls[0]!.values).toEqual([
      [EVENT_ID, PAGE_VIEW_ID],
      [SESSION_ID, SESSION_ID],
      [PAGE_VIEW_ID, null],
      ["page_view", "address_input"],
      ["home", "home"],
      [1234, 1234],
      [1, 1],
      ["{}", "{}"],
    ]);
  });

  it("does nothing for an empty row set", async () => {
    let queries = 0;
    const pool = {
      query: async () => {
        queries += 1;
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    await insertUsageEvents(pool, []);
    expect(queries).toBe(0);
  });
});

it.each(["open", "close"])("accepts retention group %s usage", (value) => {
  expect(parseUsageEvent(event({ name: "list_control", route: "ballot", props: { control: "retention_group", value } }))?.props)
    .toEqual({ control: "retention_group", value });
});

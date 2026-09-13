import { describe, expect, it, vi } from "vitest";

import {
  classifyNoInfoProfileSummary,
  listNoInfoProfileSummaries,
  NO_INFO_PROFILE_SUMMARIES_SQL,
} from "../../src/scripts/listNoInfoProfileSummaries.js";

const DISTRICT_ID = "11111111-1111-4111-8111-111111111111";

function row(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: "33333333-3333-4333-8333-333333333333",
    display_name: "Jane Doe",
    summary: "As of September 2026, we found no public information about Jane Doe's job, background, or goals.",
    election_id: "22222222-2222-4222-8222-222222222222",
    district_id: DISTRICT_ID,
    state: "TX",
    official_ballot_title: "School Board District 3",
    election_date: "2026-11-03",
    election_stage: "general",
    deferral_id: "44444444-4444-4444-8444-444444444444",
    deferral_blocker_key: "profile-33333333",
    deferral_blocked_until: "2026-10-01",
    deferral_reason: "insufficient public profile: only ballot lists name the candidate",
    ...overrides,
  };
}

describe("classifyNoInfoProfileSummary", () => {
  it("is due once the covering deferral's date has passed, waiting before, missing without one", () => {
    expect(classifyNoInfoProfileSummary(row(), "2026-10-01")).toBe("due");
    expect(classifyNoInfoProfileSummary(row(), "2026-09-30")).toBe("waiting");
    expect(classifyNoInfoProfileSummary(row({ deferral_id: null, deferral_blocked_until: null }), "2026-09-30")).toBe(
      "missing_deferral"
    );
  });
});

describe("listNoInfoProfileSummaries", () => {
  it("selects placeholders on upcoming office ballots with the deferral that covers each candidate", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    await listNoInfoProfileSummaries({ query }, { asOfDate: "2026-09-13", districtId: DISTRICT_ID });
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toBe(NO_INFO_PROFILE_SUMMARIES_SQL);
    expect(params).toEqual(["2026-09-13", DISTRICT_ID]);
    expect(sql).toContain("btrim(c.summary) ~ '^As of (January|");
    expect(sql).toContain("we found no public information about .+''s job, background, or goals\\.$'");
    expect(sql).toContain("ce.status <> 'withdrawn'");
    expect(sql).toContain("e.race_type = 'office'");
    expect(sql).toContain("e.election_date >= $1::date");
    expect(sql).toContain("m.stage = 'candidate_profile'");
    expect(sql).toContain("OR m.blocker_key = 'profile-' || left(c.id::text, 8)");
    expect(sql).toContain("($2::uuid IS NULL OR e.district_id = $2::uuid)");
  });

  it("classifies every row and, with dueOnly, keeps the actionable ones", async () => {
    const due = row();
    const waiting = row({ candidate_id: "55555555-5555-4555-8555-555555555555", deferral_blocked_until: "2026-12-01" });
    const missing = row({
      candidate_id: "66666666-6666-4666-8666-666666666666",
      deferral_id: null,
      deferral_blocker_key: null,
      deferral_blocked_until: null,
      deferral_reason: null,
    });
    const query = vi.fn().mockResolvedValue({ rows: [missing, due, waiting] });

    const all = await listNoInfoProfileSummaries({ query }, { asOfDate: "2026-10-05" });
    expect(all.map((entry) => entry.status)).toEqual(["missing_deferral", "due", "waiting"]);
    expect(query.mock.calls[0]![1]).toEqual(["2026-10-05", null]);

    const actionable = await listNoInfoProfileSummaries({ query }, { asOfDate: "2026-10-05", dueOnly: true });
    expect(actionable.map((entry) => entry.candidate_id)).toEqual([missing.candidate_id, due.candidate_id]);

    const capped = await listNoInfoProfileSummaries({ query }, { asOfDate: "2026-10-05", dueOnly: true, limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0]!.status).toBe("missing_deferral");
  });
});

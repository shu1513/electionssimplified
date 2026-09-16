import { describe, expect, it, vi } from "vitest";

import { runUnlinkCandidateElection } from "../../src/scripts/unlinkManualCandidateElection.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "44444444-4444-4444-8444-444444444444";

function linkRow(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: LINK_ID, status: "declared", ...overrides };
}

// Query order: BEGIN, lock link, load election, persisted-results guard,
// FK-table catalog scan, (per-table counts), stale event delete, link delete,
// COMMIT/ROLLBACK.
function buildClient(responses: Record<string, { rows: unknown[]; rowCount?: number }[]>) {
  const calls: { text: string; values: unknown[] }[] = [];
  const queue = { ...responses };
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values: values ?? [] });
    for (const key of Object.keys(queue)) {
      if (text.includes(key)) {
        const result = queue[key]!.shift();
        if (result !== undefined) return { rowCount: result.rows.length, ...result };
      }
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, calls };
}

function happyResponses(overrides: Partial<Record<string, { rows: unknown[]; rowCount?: number }[]>> = {}) {
  return {
    "FROM public.candidate_elections\n        WHERE candidate_id": [{ rows: [linkRow()] }],
    "FROM public.elections": [{ rows: [{ id: ELECTION_ID, official_ballot_title: "Governor" }] }],
    "pg_constraint": [
      { rows: [{ table_name: "public.az_candidate_finance_links", election_column: "election_id" }] },
    ],
    "count(*)::text AS n FROM public.az_candidate_finance_links": [{ rows: [{ n: "0" }] }],
    "DELETE FROM public.user_candidate_follow_notification_events": [{ rows: [], rowCount: 1 }],
    ...overrides,
  };
}

describe("runUnlinkCandidateElection", () => {
  it("deletes the link and its unsent notification events without creating any", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runUnlinkCandidateElection(
      { query },
      { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, dryRun: false }
    );

    expect(result).toMatchObject({
      action: "unlinked",
      dryRun: false,
      electionTitle: "Governor",
      linkStatus: "declared",
      staleNotificationEventsDeleted: 1,
    });
    const linkDelete = calls.find((call) => call.text.includes("DELETE FROM public.candidate_elections"));
    expect(linkDelete?.values).toEqual([LINK_ID]);
    // The guards must not evaluate an election row a concurrent election
    // edit (date correction, supersede) is changing mid-transaction.
    const electionLoad = calls.find((call) => call.text.includes("FROM public.elections"));
    expect(electionLoad?.text).toContain("FOR UPDATE");
    // A research error is silent cleanup: every unsent event for the pair
    // dies (any event_type), and no withdrawal event is created.
    const eventDelete = calls.find((call) =>
      call.text.includes("DELETE FROM public.user_candidate_follow_notification_events")
    );
    expect(eventDelete?.text).toContain("notified_at IS NULL");
    expect(eventDelete?.text).not.toContain("event_type");
    expect(calls.some((call) => call.text.includes("INSERT INTO public.user_candidate_follow_notification_events"))).toBe(
      false
    );
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it("dry run executes the full transaction and rolls back", async () => {
    const { query, calls } = buildClient(happyResponses());

    const result = await runUnlinkCandidateElection(
      { query },
      { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, dryRun: true }
    );

    expect(result).toMatchObject({ dryRun: true, staleNotificationEventsDeleted: 1 });
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses when the link does not exist", async () => {
    const { query } = buildClient(
      happyResponses({ "FROM public.candidate_elections\n        WHERE candidate_id": [{ rows: [] }] })
    );

    await expect(
      runUnlinkCandidateElection({ query }, { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, dryRun: false })
    ).rejects.toThrow(/No candidate_elections link found/);
  });

  it("refuses when a persisted result names this candidate as a winner", async () => {
    const { query, calls } = buildClient(
      happyResponses({
        "FROM public.election_results": [{ rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] }],
      })
    );

    await expect(
      runUnlinkCandidateElection({ query }, { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, dryRun: false })
    ).rejects.toThrow(/persisted election_results rows whose winners reference this candidate/);
    // The guard is scoped to THIS link and candidate, not the whole election.
    const guard = calls.find((call) => call.text.includes("FROM public.election_results"));
    expect(guard?.text).toContain("jsonb_array_elements(r.winners)");
    expect(guard?.values).toEqual([ELECTION_ID, LINK_ID, CANDIDATE_ID]);
    expect(calls.some((call) => call.text.includes("DELETE FROM public.candidate_elections"))).toBe(false);
  });

  it("unlinks when the election's persisted results name only other winners", async () => {
    // The scoped guard query returns no row for a results entry that names a
    // different candidate; the wrongly linked candidate is then removable.
    const { query, calls } = buildClient(
      happyResponses({
        "FROM public.election_results": [{ rows: [] }],
      })
    );

    const result = await runUnlinkCandidateElection(
      { query },
      { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, dryRun: false }
    );

    expect(result.action).toBe("unlinked");
    expect(calls.some((call) => call.text.includes("DELETE FROM public.candidate_elections"))).toBe(true);
  });

  it("refuses when election-scoped candidate rows contradict a research-error unlink", async () => {
    const { query, calls } = buildClient(
      happyResponses({
        "count(*)::text AS n FROM public.az_candidate_finance_links": [{ rows: [{ n: "2" }] }],
      })
    );

    await expect(
      runUnlinkCandidateElection({ query }, { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, dryRun: false })
    ).rejects.toThrow(/contradict a research-error unlink: public.az_candidate_finance_links \(2\)/);
    expect(calls.some((call) => call.text.includes("DELETE FROM public.candidate_elections"))).toBe(false);
  });

  it("refuses to unlink a link whose status asserts recorded history", async () => {
    const { query, calls } = buildClient(
      happyResponses({
        "FROM public.candidate_elections\n        WHERE candidate_id": [{ rows: [linkRow({ status: "withdrawn" })] }],
      })
    );

    await expect(
      runUnlinkCandidateElection({ query }, { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, dryRun: false })
    ).rejects.toThrow(/status 'withdrawn', which asserts recorded history/);
    expect(calls.some((call) => call.text.includes("DELETE FROM public.candidate_elections"))).toBe(false);
  });

  it("does not let the follow-notification events table trip the conflict scan", async () => {
    // The events table matches the scan's shape (FK to elections +
    // candidate_id column), but the wrapper handles it explicitly: unsent
    // events are deleted, sent ones tolerated. Without the exclusion, any
    // follower event for the pair would block the unlink it precedes.
    const { query, calls } = buildClient(
      happyResponses({
        "pg_constraint": [
          {
            rows: [
              {
                table_name: "public.user_candidate_follow_notification_events",
                election_column: "election_id",
              },
              { table_name: "public.az_candidate_finance_links", election_column: "election_id" },
            ],
          },
        ],
        // A sent event exists for the pair; it must not be counted as a
        // conflict (and must never be probed at all).
        "count(*)::text AS n FROM public.user_candidate_follow_notification_events": [{ rows: [{ n: "5" }] }],
      })
    );

    const result = await runUnlinkCandidateElection(
      { query },
      { candidateId: CANDIDATE_ID, electionId: ELECTION_ID, dryRun: false }
    );

    expect(result.action).toBe("unlinked");
    expect(
      calls.some((call) =>
        call.text.includes("count(*)::text AS n FROM public.user_candidate_follow_notification_events")
      )
    ).toBe(false);
  });

  it("accepts uppercase UUID input by normalizing before row matching", async () => {
    const { query, calls } = buildClient(happyResponses());

    await runUnlinkCandidateElection(
      { query },
      { candidateId: CANDIDATE_ID.toUpperCase(), electionId: ELECTION_ID.toUpperCase(), dryRun: false }
    );

    const lock = calls.find((call) => call.text.includes("WHERE candidate_id"));
    expect(lock?.values).toEqual([CANDIDATE_ID, ELECTION_ID]);
  });
});

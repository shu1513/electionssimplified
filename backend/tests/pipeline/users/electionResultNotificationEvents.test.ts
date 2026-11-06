import { describe, expect, it, vi } from "vitest";

import {
  createElectionResultNotificationEvents,
  ElectionResultNotificationEventsError,
} from "../../../src/pipeline/users/electionResultNotificationEvents.js";

const ELECTION_A = "11111111-1111-4111-8111-111111111111";
const ELECTION_B = "22222222-2222-4222-8222-222222222222";

describe("createElectionResultNotificationEvents", () => {
  it("returns zero without querying for an empty batch", async () => {
    const query = vi.fn();

    await expect(createElectionResultNotificationEvents({ query } as never, [])).resolves.toEqual({
      createdCount: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects non-UUID election ids without querying", async () => {
    const query = vi.fn();

    await expect(
      createElectionResultNotificationEvents({ query } as never, [ELECTION_A, "nope"])
    ).rejects.toBeInstanceOf(ElectionResultNotificationEventsError);
    expect(query).not.toHaveBeenCalled();
  });

  it("fans out via user_districts to digest-enabled live users and dedupes", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { id: ELECTION_A, official_ballot_title: "County Assessor" },
          { id: ELECTION_B, official_ballot_title: "Measure A" },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "e1" }, { id: "e2" }], rowCount: 2 });

    await expect(
      createElectionResultNotificationEvents({ query } as never, [ELECTION_A, ` ${ELECTION_B} `])
    ).resolves.toEqual({ createdCount: 2 });

    expect(query.mock.calls[0][1]).toEqual([[ELECTION_A, ELECTION_B]]);
    const sql = String(query.mock.calls[1][0]);
    expect(sql).toContain("JOIN public.user_districts");
    // Result alerts ride the digest opt-in, not the new-election alerts one.
    expect(sql).toContain("email_digest = true");
    expect(sql).toContain("deleted_at IS NULL");
    // Re-writes (certified after election night, corrections) rely on the
    // unique (user, election) pair + DO NOTHING to notify at most once.
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(query.mock.calls[1][1]).toEqual([[ELECTION_A, ELECTION_B]]);
  });

  it("leaves judicial retention questions out of result alerts", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { id: ELECTION_A, official_ballot_title: "Retention of Judge Dan Friedman, Appellate Court of Maryland At Large" },
          { id: ELECTION_B, official_ballot_title: "County Assessor" },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "e1" }], rowCount: 1 });

    await expect(
      createElectionResultNotificationEvents({ query } as never, [ELECTION_A, ELECTION_B])
    ).resolves.toEqual({ createdCount: 1 });
    expect(query.mock.calls[1][1]).toEqual([[ELECTION_B]]);

    // Nothing but retention questions: no insert at all.
    const onlyRetention = vi.fn().mockResolvedValueOnce({
      rows: [{ id: ELECTION_A, official_ballot_title: "Shall Justice Jane Roe be retained in office?" }],
    });
    await expect(
      createElectionResultNotificationEvents({ query: onlyRetention } as never, [ELECTION_A])
    ).resolves.toEqual({ createdCount: 0 });
    expect(onlyRetention).toHaveBeenCalledTimes(1);
  });
});

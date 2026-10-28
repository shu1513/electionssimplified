import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BALLOT_PREFERENCES,
  getUserBallotPreferences,
  setUserBallotPreferences,
  UserBallotPreferencesError,
} from "../../../src/pipeline/users/userBallotPreferences.js";

const userId = "99999999-9999-4999-8999-999999999999";

describe("getUserBallotPreferences", () => {
  it("returns application defaults (ballot order) when the user has no saved row", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ user_exists: true, sort: null, followed_first: null }],
    });

    const result = await getUserBallotPreferences({ query }, userId);

    expect(result).toEqual(DEFAULT_BALLOT_PREFERENCES);
    expect(result).toEqual({ sort: "state_baseline", followed_first: true });
    // No personalized default any more: saved research areas are not even
    // consulted — "My issues" is a choice the user saves.
    expect(String(query.mock.calls[0]?.[0])).not.toContain("user_research_area_preferences");
  });

  it("returns the saved preferences", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ user_exists: true, sort: "district_size", followed_first: false }],
    });

    await expect(getUserBallotPreferences({ query }, userId)).resolves.toEqual({
      sort: "district_size",
      followed_first: false,
    });
  });

  it("returns a saved vote_power sort as-is", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ user_exists: true, sort: "vote_power", followed_first: true }],
    });

    await expect(getUserBallotPreferences({ query }, userId)).resolves.toEqual({
      sort: "vote_power",
      followed_first: true,
    });
  });

  it("throws user_not_found for unknown users", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(getUserBallotPreferences({ query }, userId)).rejects.toMatchObject({
      name: "UserBallotPreferencesError",
      code: "user_not_found",
    });
  });

  it("throws invalid_user_id for non-UUID user ids without querying", async () => {
    const query = vi.fn();

    await expect(getUserBallotPreferences({ query }, "not-a-uuid")).rejects.toMatchObject({
      code: "invalid_user_id",
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("setUserBallotPreferences", () => {
  it("upserts and returns the stored preferences", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ sort: "district_size_smallest", followed_first: true }] });

    const result = await setUserBallotPreferences({ query }, userId, { sort: "district_size_smallest", followed_first: true });

    expect(result).toEqual({ sort: "district_size_smallest", followed_first: true });
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("ON CONFLICT (user_id) DO UPDATE");
    expect(params).toEqual([userId, "district_size_smallest", true]);
  });

  it("rejects an invalid sort before touching the database", async () => {
    const query = vi.fn();

    await expect(
      setUserBallotPreferences({ query }, userId, {
        sort: "alphabetical" as never,
        followed_first: true,
      })
    ).rejects.toBeInstanceOf(UserBallotPreferencesError);
    expect(query).not.toHaveBeenCalled();
  });

  it("saves the state_baseline (ballot order) sort", async () => {
    // Saveable since migration 393 widened the CHECK constraint.
    const query = vi.fn().mockResolvedValue({ rows: [{ sort: "state_baseline", followed_first: true }] });

    await expect(
      setUserBallotPreferences({ query }, userId, { sort: "state_baseline", followed_first: true })
    ).resolves.toEqual({ sort: "state_baseline", followed_first: true });
    expect(query.mock.calls[0]?.[1]).toEqual([userId, "state_baseline", true]);
  });

  it("throws user_not_found when the insert selects no user row", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      setUserBallotPreferences({ query }, userId, { sort: "vote_power", followed_first: false })
    ).rejects.toMatchObject({ code: "user_not_found" });
  });
});

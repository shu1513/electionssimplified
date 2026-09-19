import { describe, expect, it } from "vitest";
import { isEmbedListedRace } from "./embedPilot";

const DAY = "2026-11-03";

describe("isEmbedListedRace", () => {
  it("keeps contested races and measures on the reviewed day", () => {
    expect(isEmbedListedRace({ election_date: DAY, race_type: "office", official_ballot_title: "Governor" }, DAY)).toBe(true);
    expect(isEmbedListedRace({ election_date: DAY, race_type: "ballot_measure", official_ballot_title: "Proposition 1" }, DAY)).toBe(true);
  });

  it("drops other election days and judicial retention questions", () => {
    expect(isEmbedListedRace({ election_date: "2026-10-06", race_type: "office", official_ballot_title: "Governor" }, DAY)).toBe(false);
    expect(
      isEmbedListedRace(
        { election_date: DAY, race_type: "office", official_ballot_title: "Retention of Justice Jane Doe, Supreme Court" },
        DAY
      )
    ).toBe(false);
  });
});

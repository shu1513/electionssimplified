import { describe, expect, it } from "vitest";
import type { ElectionChoice } from "@voteapp/api-client";
import { choicePickedLabel } from "./choicePickedLabel";

function choice(overrides: Partial<ElectionChoice>): ElectionChoice {
  return {
    election_id: "e-1",
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    seats_to_fill: null,
    picks: [],
    measure_position: null,
    ...overrides,
  } as ElectionChoice;
}

describe("choicePickedLabel", () => {
  it("names the picks, flags a withdrawn one, and answers a measure", () => {
    expect(choicePickedLabel(undefined)).toBeNull();
    expect(choicePickedLabel(choice({}))).toBeNull();
    expect(
      choicePickedLabel(
        choice({
          picks: [
            {
              candidate_id: "c-1",
              display_name: "Jordan Voter",
              candidacy_status: "active",
            },
            {
              candidate_id: "c-2",
              display_name: "Riley Runner",
              candidacy_status: "withdrawn",
            },
          ],
        }),
      ),
    ).toBe("Jordan Voter, Riley Runner (withdrew)");
    expect(choicePickedLabel(choice({ measure_position: "no" }))).toBe("No");
  });

  it("reads a legacy judge pick on a retention race as Yes, like the draft ballot", () => {
    const judgePick = choice({
      picks: [
        {
          candidate_id: "j-1",
          display_name: "Judge Kim",
          candidacy_status: "active",
        },
      ],
    });
    expect(choicePickedLabel(judgePick, true)).toBe("Yes");
    expect(choicePickedLabel(choice({ measure_position: "no" }), true)).toBe(
      "No",
    );
    expect(choicePickedLabel(judgePick)).toBe("Judge Kim");
  });
});

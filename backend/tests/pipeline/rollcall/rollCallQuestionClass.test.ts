import { describe, expect, it } from "vitest";

import { parseFederalMeasure } from "../../../src/pipeline/rollcall/federalMeasures.js";
import { classifyFederalRollCall } from "../../../src/pipeline/rollcall/rollCallQuestionClass.js";

function classify(chamber: "house" | "senate", question: string, measure: string | null) {
  return classifyFederalRollCall({ chamber, question, measure: parseFederalMeasure(measure) });
}

describe("classifyFederalRollCall — House", () => {
  it("keeps the final-action question classes on bills and joint resolutions", () => {
    expect(classify("house", "On Passage", "H R 1")).toEqual({
      isFloorVote: true,
      questionClass: "passage",
      reason: "kept:passage",
    });
    expect(classify("house", "On Motion to Suspend the Rules and Pass", "H R 144").isFloorVote).toBe(true);
    expect(classify("house", "On Motion to Suspend the Rules and Pass, as Amended", "S 5").questionClass).toBe(
      "suspension"
    );
    expect(classify("house", "On Motion to Concur in the Senate Amendment", "H R 1").questionClass).toBe(
      "concur_senate_amendment"
    );
    expect(classify("house", "On Agreeing to the Conference Report", "H R 2").questionClass).toBe(
      "conference_report"
    );
    expect(
      classify("house", "On Passage, the Objections of the President to the Contrary Notwithstanding", "H J RES 7")
        .questionClass
    ).toBe("veto_override");
    expect(classify("house", "On  Passage", "H J RES 20").isFloorVote).toBe(true);
  });

  it("excludes procedural questions", () => {
    for (const question of [
      "On Ordering the Previous Question",
      "On Agreeing to the Resolution",
      "On Agreeing to the Amendment",
      "On Motion to Recommit",
      "On Motion to Table",
      "On Motion to Adjourn",
      "Call by States",
      "Election of the Speaker",
      "On Motion to Concur in the Senate Amendment with an Amendment",
    ]) {
      expect(classify("house", question, "H R 1"), question).toEqual({
        isFloorVote: false,
        questionClass: null,
        reason: "excluded_question",
      });
    }
  });

  it("excludes simple and concurrent resolutions and measure-less votes", () => {
    expect(classify("house", "On Motion to Concur in the Senate Amendment", "H CON RES 14")).toEqual({
      isFloorVote: false,
      questionClass: "concur_senate_amendment",
      reason: "excluded_measure:hconres",
    });
    expect(classify("house", "On Passage", "H RES 5").reason).toBe("excluded_measure:hres");
    expect(classify("house", "On Passage", null)).toEqual({
      isFloorVote: false,
      questionClass: "passage",
      reason: "no_measure",
    });
    expect(classify("house", "On Passage", "QUORUM").reason).toBe("no_measure");
  });
});

describe("classifyFederalRollCall — Senate", () => {
  it("keeps passage, joint resolutions, conference reports, and veto overrides", () => {
    expect(classify("senate", "On Passage of the Bill", "H.R. 5371")).toEqual({
      isFloorVote: true,
      questionClass: "passage",
      reason: "kept:passage",
    });
    expect(classify("senate", "On the Joint Resolution", "S.J.Res. 3").isFloorVote).toBe(true);
    expect(classify("senate", "On the Conference Report", "H.R. 2").questionClass).toBe("conference_report");
    expect(classify("senate", "On Overriding the Veto", "H.R. 2").questionClass).toBe("veto_override");
    // The menu XML keeps trailing whitespace inside <question>.
    expect(classify("senate", "On the Joint Resolution\n         ", "H.J.Res. 104").isFloorVote).toBe(true);
  });

  it("excludes cloture, motions, nominations, and simple/concurrent resolutions", () => {
    for (const question of [
      "On the Cloture Motion",
      "On Cloture on the Motion to Proceed",
      "On the Motion to Proceed",
      "On the Motion",
      "On the Motion to Table",
      "On the Motion to Discharge",
      "On the Nomination",
      "On the Resolution",
      "On the Concurrent Resolution",
      "On the Decision of the Chair",
    ]) {
      expect(classify("senate", question, "S. 5").isFloorVote, question).toBe(false);
    }
    expect(classify("senate", "On Passage of the Bill", "PN12-31").reason).toBe("excluded_measure:pn");
    expect(classify("senate", "On the Joint Resolution", "S.Res. 12").reason).toBe("excluded_measure:sres");
    expect(classify("senate", "On the Joint Resolution", "S.Con.Res. 7").reason).toBe("excluded_measure:sconres");
  });

  it("keeps an excluded question only for a roll call on the hand-add list", () => {
    const measure = parseFederalMeasure("S.J.Res. 41");
    const question = "On the Motion to Discharge";
    const handAdded = classifyFederalRollCall({
      chamber: "senate",
      question,
      measure,
      roll: { congress: 119, session: 1, rollNumber: 454 },
    });
    expect(handAdded).toEqual({ isFloorVote: true, questionClass: "hand_add", reason: "kept:hand_add" });
    const sameQuestionOtherRoll = classifyFederalRollCall({
      chamber: "senate",
      question,
      measure,
      roll: { congress: 119, session: 1, rollNumber: 455 },
    });
    expect(sameQuestionOtherRoll.isFloorVote).toBe(false);
    // The key carries the chamber: House roll 454 of the same session is not added.
    expect(
      classifyFederalRollCall({ chamber: "house", question, measure, roll: { congress: 119, session: 1, rollNumber: 454 } })
        .isFloorVote
    ).toBe(false);
  });
});

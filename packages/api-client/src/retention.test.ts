import { describe, expect, it } from "vitest";
import { isJudicialRetentionTitle, isRetentionRace, splitRetentionRaces } from "./retention";

describe("isJudicialRetentionTitle", () => {
  it("matches the retention phrasings states print", () => {
    expect(isJudicialRetentionTitle("Shall Judge Pat Example be retained in office?")).toBe(true);
    expect(isJudicialRetentionTitle("Retention of 4th Judicial District Court Judge Denise M. Porter")).toBe(true);
    expect(isJudicialRetentionTitle("Supreme Court Justice - Retain Jane Doe?")).toBe(true);
  });

  it("matches California's retention phrasing, which never says retain", () => {
    expect(
      isJudicialRetentionTitle(
        "Shall Administrative Presiding Justice LAURIE EARL be elected to the office for the term provided by law?"
      )
    ).toBe(true);
    expect(
      isJudicialRetentionTitle("Shall Associate Justice of the Supreme Court KELLI M. EVANS be elected to the office for the term provided by law?")
    ).toBe(true);
    // The ballot sometimes drops the office word; the prescribed phrase is
    // judicial on its own.
    expect(isJudicialRetentionTitle("Shall DAVID B. SAPP be elected to the office for the term provided by law?")).toBe(true);
  });

  it("leaves ordinary races alone", () => {
    expect(isJudicialRetentionTitle("District Court Judge, Division 3")).toBe(false);
    expect(isJudicialRetentionTitle("State Senator, District 4")).toBe(false);
    expect(isJudicialRetentionTitle("Proposition 1: Road and Bridge Bond")).toBe(false);
  });

  it("needs a judicial noun, not just the retention verb", () => {
    expect(isJudicialRetentionTitle("Water Retention District Director")).toBe(false);
    expect(isJudicialRetentionTitle("Shall Pat Example be retained as Fire Chief?")).toBe(false);
  });
});

describe("isRetentionRace", () => {
  it("needs an office race and a retention title", () => {
    expect(isRetentionRace({ race_type: "office", official_ballot_title: "Shall Judge X be retained?" })).toBe(true);
    expect(isRetentionRace({ race_type: "ballot_measure", official_ballot_title: "Shall Judge X be retained?" })).toBe(
      false
    );
    expect(isRetentionRace({ race_type: "office", official_ballot_title: "Mayor" })).toBe(false);
  });
});

describe("splitRetentionRaces", () => {
  const race = (id: string, retention = false, date = "2026-11-03") => ({
    id, election_date: date, race_type: "office",
    official_ballot_title: retention ? `Shall Judge ${id} be retained?` : id,
  });

  it("keeps zero or one retention race among contested races", () => {
    expect(splitRetentionRaces([])).toEqual({ contested: [], retention: [] });
    for (const elections of [[race("Mayor")], [race("a", true), race("Mayor")]]) {
      expect(splitRetentionRaces(elections)).toEqual({ contested: elections, retention: [] });
    }
  });

  it("groups two or more per date, preserving both partitions and the input", () => {
    const a = race("a", true);
    const b = race("b", true);
    const lone = race("lone", true, "2026-09-15");
    const mayor = race("Mayor");
    const elections = Object.freeze([a, lone, mayor, b]);
    expect(splitRetentionRaces(elections)).toEqual({ contested: [lone, mayor], retention: [a, b] });
    expect(elections).toEqual([a, lone, mayor, b]);
  });
});

import { describe, expect, it } from "vitest";

import { isOutsideAppellateElectorate } from "../../../src/pipeline/address/appellateRetentionElectorate.js";

const county = (geoid_compact: string) => ({ district_type: "county", geoid_compact });
const statewide = (official_ballot_title: string, state_fips = "06") => ({
  state_fips,
  district_type: "statewide",
  official_ballot_title,
});

const SECOND =
  "Presiding Justice, Court of Appeal, Second District, Division Three: Shall Presiding Justice A be elected to the office for the term provided by law?";
const FOURTH =
  "Associate Justice, Court of Appeal, Fourth District, Division One: Shall Associate Justice B be elected to the office for the term provided by law?";
const THIRD =
  "Associate Justice, Court of Appeal, Third District: Shall Associate Justice C be elected to the office for the term provided by law?";

describe("isOutsideAppellateElectorate", () => {
  it("keeps a Court of Appeal question for a county inside its appellate district", () => {
    expect(isOutsideAppellateElectorate(statewide(SECOND), [county("06037")])).toBe(false);
    expect(isOutsideAppellateElectorate(statewide(FOURTH), [county("06073")])).toBe(false);
    expect(isOutsideAppellateElectorate(statewide(THIRD), [county("06067")])).toBe(false);
  });

  it("drops a Court of Appeal question for a county outside its appellate district", () => {
    expect(isOutsideAppellateElectorate(statewide(FOURTH), [county("06037")])).toBe(true);
    expect(isOutsideAppellateElectorate(statewide(SECOND), [county("06075")])).toBe(true);
    expect(isOutsideAppellateElectorate(statewide(THIRD), [county("06037")])).toBe(true);
  });

  it("keeps Supreme Court questions and every other statewide contest", () => {
    expect(
      isOutsideAppellateElectorate(
        statewide("Shall Associate Justice of the Supreme Court D be elected to the office for the term provided by law?"),
        [county("06037")]
      )
    ).toBe(false);
    expect(isOutsideAppellateElectorate(statewide("Governor"), [county("06037")])).toBe(false);
  });

  it("keeps everything when the lookup carries no California county", () => {
    expect(isOutsideAppellateElectorate(statewide(FOURTH), [])).toBe(false);
    expect(isOutsideAppellateElectorate(statewide(FOURTH), [{ district_type: "place", geoid_compact: "0644000" }])).toBe(
      false
    );
  });

  it("only applies to California statewide rows", () => {
    expect(isOutsideAppellateElectorate(statewide(FOURTH, "04"), [county("04013")])).toBe(false);
    expect(
      isOutsideAppellateElectorate(
        { state_fips: "06", district_type: "county", official_ballot_title: FOURTH },
        [county("06037")]
      )
    ).toBe(false);
  });
});

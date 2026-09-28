import { namesCongressionalDistrictBoardSeat } from "../utils/congressionalDistrictBoardOffice.js";
import { isUsSenateOfficeTitle } from "../utils/senateOffice.js";
import { isPresidentialOfficeTitle } from "../utils/presidentialOffice.js";

export type CandidateResearchMode = "federal_president" | "federal_us_senate" | "federal_us_house" | "state_level";

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isUsHouseOfficeTitle(title: string): boolean {
  const text = normalize(title);
  return (
    /\bu\.?\s*s\.?\s+house\b/.test(text) ||
    /\bunited states house\b/.test(text) ||
    /\bu\.?\s*s\.?\s+representative\b/.test(text) ||
    /\bunited states representative\b/.test(text) ||
    /\bmember of congress\b/.test(text) ||
    /\bcongressional district\b/.test(text)
  );
}

export function resolveCandidateResearchMode(input: {
  districtType: string;
  officialBallotTitle: string;
}): CandidateResearchMode {
  if (input.districtType === "presidential" || isPresidentialOfficeTitle(input.officialBallotTitle)) {
    return "federal_president";
  }

  if (isUsSenateOfficeTitle(input.officialBallotTitle)) {
    return "federal_us_senate";
  }

  // Colorado's regent and State Board of Education seats sit on the us_house
  // row and say "Congressional District", but they are state offices with
  // no FEC filings. Deliberately not limited to Colorado: a regent or state
  // board title is never a House race in any state, so state-level research
  // is right for it wherever its row is scoped.
  if (namesCongressionalDistrictBoardSeat(input.officialBallotTitle)) {
    return "state_level";
  }

  if (input.districtType === "us_house" || isUsHouseOfficeTitle(input.officialBallotTitle)) {
    return "federal_us_house";
  }

  return "state_level";
}

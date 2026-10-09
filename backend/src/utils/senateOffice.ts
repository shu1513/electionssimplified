import type { ElectionEntryPayload } from "../types/election.js";

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// The District of Columbia elects two "United States Senators" and one
// "United States Representative" under D.C. Code § 1-123 (the statehood, or
// "shadow", delegation). They are DC officials who lobby for statehood; they
// hold no seat in Congress and file no FEC reports. Titles that say "shadow"
// or "statehood" name these offices, never a seat in Congress.
export function isShadowDelegationTitle(title: string): boolean {
  const text = normalize(title);
  return /\b(?:shadow|statehood)\b/.test(text) && /\b(?:senator|representative)\b/.test(text);
}

export function isUsSenateOfficeTitle(title: string): boolean {
  const text = normalize(title);
  if (isShadowDelegationTitle(text)) {
    return false;
  }
  return (
    /\bunited states senator\b/.test(text) ||
    /\bu\.?\s*s\.?\s+senator\b/.test(text) ||
    /\bunited states senate\b/.test(text) ||
    /\bu\.?\s*s\.?\s+senate\b/.test(text)
  );
}

export function hasSpecialSeatMarker(entry: Pick<ElectionEntryPayload, "official_ballot_title" | "election_stage">): boolean {
  const combined = normalize(entry.official_ballot_title);
  return (
    entry.election_stage === "special" ||
    /\bunexpired term\b/.test(combined) ||
    /\bspecial election\b/.test(combined) ||
    /\bvacancy\b/.test(combined) ||
    /\bremainder of (the )?term\b/.test(combined)
  );
}

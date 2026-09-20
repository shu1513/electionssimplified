// Display priority for research-area chips, ranked by real-world public
// salience (2026 Gallup/Pew issue polling), not alphabetically — the chips a
// card has room for should be the ones voters care about most. Keyed by slug
// so renames in the DB don't silently break the ordering. AI Regulation is
// pinned first (product call, 2026-09-09).
const RESEARCH_AREA_PRIORITY: readonly string[] = [
  "ai_regulation",
  "healthcare_affordability",
  "environment_and_public_health",
  "reduce_wealth_gap",
  "labor_rights",
  "anti_corruption",
  "government_efficiency",
  "cost_of_living_reduction",
  "immigration",
  "government_spending_reduction",
  "public_safety_and_crime_control",
  "housing_affordability",
  "social_programs_and_welfare",
  "public_education_quality",
  "gun_control",
  "womens_reproductive_rights",
  "election_integrity",
  "national_defense",
  "personal_income_tax_reduction",
  "foreign_trade",
  "data_privacy",
  "civil_rights",
  "corporate_accountability",
  "public_infrastructure",
  "peaceful_foreign_policy",
  "us_israel_ties",
];

// Slugs pinned to the very end of every list, after even the unranked ones.
// Candidate Ethics is a per-candidate trait rather than a policy issue, so it
// always closes the picker (product call, 2026-09-01).
const RESEARCH_AREA_TRAILING: readonly string[] = ["integrity_and_ethics"];

const UNRANKED_RANK = RESEARCH_AREA_PRIORITY.length;
const TRAILING_BASE_RANK = UNRANKED_RANK + 1;

const rankBySlug = new Map<string, number>([
  ...RESEARCH_AREA_PRIORITY.map((slug, index): [string, number] => [slug, index]),
  ...RESEARCH_AREA_TRAILING.map((slug, index): [string, number] => [
    slug,
    TRAILING_BASE_RANK + index,
  ]),
]);

/**
 * Compares two research areas by public-salience priority (highest first).
 * Slugs outside the ranking — the judicial criteria (impartiality, legal
 * competence), the "general" catch-all, and any area added later — sink
 * below every ranked one, alphabetically so their order is still
 * deterministic. Trailing slugs (Candidate Ethics) sink below even those.
 * Exported on its own so personalized sorts can use it as their tiebreak.
 */
export function compareByResearchAreaPriority(
  a: { slug: string; name: string },
  b: { slug: string; name: string }
): number {
  const rankA = rankBySlug.get(a.slug) ?? UNRANKED_RANK;
  const rankB = rankBySlug.get(b.slug) ?? UNRANKED_RANK;
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return a.name.localeCompare(b.name);
}

/** compareByResearchAreaPriority over a copy; the input is not mutated. */
export function sortByResearchAreaPriority<T extends { slug: string; name: string }>(
  areas: readonly T[]
): T[] {
  return [...areas].sort(compareByResearchAreaPriority);
}

/**
 * Splits an election's research areas into the viewer's saved matches and
 * the rest, each ordered for display: saved matches by the user's own 1–7
 * ranking (their explicit priority outranks any global one; unranked saves
 * and rank ties fall back to public salience), the rest in pure
 * public-salience order. Shared by ElectionCard (which caps the unsaved
 * list) and the election detail page (which shows everything), so the two
 * can't drift.
 */
export function splitResearchAreasBySaved<T extends { id: string; slug: string; name: string }>(
  areas: readonly T[],
  savedAreaWeights?: Map<string, { rank: number }>
): { saved: T[]; others: T[] } {
  const saved = areas
    .filter((area) => savedAreaWeights?.has(area.id) ?? false)
    .sort(
      (a, b) =>
        // The fallback is unreachable — the filter above guarantees
        // membership, and every stored weight carries a numeric rank
        // (unranked saves get UNRANKED_RESEARCH_AREA_RANK, which already
        // sinks them below ranked ones) — but Infinity keeps the same
        // "unranked sinks" semantics if a caller ever passes a sparser map.
        (savedAreaWeights?.get(a.id)?.rank ?? Number.POSITIVE_INFINITY) -
          (savedAreaWeights?.get(b.id)?.rank ?? Number.POSITIVE_INFINITY) ||
        compareByResearchAreaPriority(a, b)
    );
  const others = sortByResearchAreaPriority(
    areas.filter((area) => !(savedAreaWeights?.has(area.id) ?? false))
  );
  return { saved, others };
}

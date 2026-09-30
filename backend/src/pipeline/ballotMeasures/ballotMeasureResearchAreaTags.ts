import type { PoolClient } from "pg";

export const BALLOT_MEASURE_RESEARCH_AREA_SLUGS = [
  "environment_and_public_health",
  "cost_of_living_reduction",
  "reduce_wealth_gap",
  "healthcare_affordability",
  "public_safety_and_crime_control",
  "government_spending_reduction",
  "personal_income_tax_reduction",
  "womens_reproductive_rights",
  "immigration",
  "election_integrity",
  "social_programs_and_welfare",
  "data_privacy",
  "corporate_accountability",
  "anti_corruption",
  "government_efficiency",
  "public_infrastructure",
  "housing_affordability",
  "civil_rights",
  "criminal_justice_and_civil_liberties",
  "public_education_quality",
  "gun_control",
  "ai_regulation",
  "labor_rights",
] as const;

export type BallotMeasureResearchAreaSlug = (typeof BALLOT_MEASURE_RESEARCH_AREA_SLUGS)[number];
export type BallotMeasureResearchAreaStance = "for" | "against";

export type BallotMeasureResearchAreaTagInput = {
  researchAreaSlug: string;
  stance: BallotMeasureResearchAreaStance;
};

export type BallotMeasureResearchArea = {
  id: string;
  slug: string;
};

type Queryable = Pick<PoolClient, "query">;

export async function loadAllowedBallotMeasureResearchAreas(
  client: Queryable
): Promise<BallotMeasureResearchArea[]> {
  const result = await client.query<BallotMeasureResearchArea>(
    `
      SELECT id, slug
      FROM public.research_areas
      WHERE slug = ANY($1::text[])
      ORDER BY slug ASC
    `,
    [BALLOT_MEASURE_RESEARCH_AREA_SLUGS]
  );

  const loadedSlugs = new Set(result.rows.map((row) => row.slug));
  const missingSlugs = BALLOT_MEASURE_RESEARCH_AREA_SLUGS.filter((slug) => !loadedSlugs.has(slug));
  if (missingSlugs.length > 0) {
    throw new Error(
      `Missing research_areas rows for ballot-measure slugs: ${missingSlugs.join(", ")}`
    );
  }

  return result.rows;
}

export async function upsertBallotMeasureResearchAreaTags(
  client: Queryable,
  ballotMeasureId: string,
  tags: readonly BallotMeasureResearchAreaTagInput[],
  researchAreaIdBySlug: ReadonlyMap<string, string>
): Promise<{ processed: number }> {
  const desiredResearchAreaIds: string[] = [];
  for (const tag of tags) {
    const slug = tag.researchAreaSlug.trim().toLowerCase();
    const researchAreaId = researchAreaIdBySlug.get(slug);
    if (!researchAreaId) {
      throw new Error(`Cannot upsert ballot_measure_research_area_tag: missing research area id for slug '${slug}'`);
    }
    desiredResearchAreaIds.push(researchAreaId);

    await client.query(
      `
        INSERT INTO public.ballot_measure_research_area_tags (
          ballot_measure_id,
          research_area_id,
          stance
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (ballot_measure_id, research_area_id)
        DO UPDATE SET
          stance = EXCLUDED.stance,
          updated_at = now()
      `,
      [ballotMeasureId, researchAreaId, tag.stance]
    );
  }

  await client.query(
    `
      DELETE FROM public.ballot_measure_research_area_tags
      WHERE ballot_measure_id = $1
        AND NOT (research_area_id = ANY($2::uuid[]))
    `,
    [ballotMeasureId, desiredResearchAreaIds]
  );

  return { processed: tags.length };
}

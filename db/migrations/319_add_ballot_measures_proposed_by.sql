BEGIN;

-- Who put the measure on the ballot, and who that is in plain words.
--
-- proposed_by            short, factual: "Louisiana Legislature (HB 300, Rep. Jane Smith)",
--                        "Citizen initiative filed by Protect Our Parks".
-- proposed_by_about      plain-language identity of that proposer, the way
--                        donor rows carry "about": "Rep. Smith is a Republican
--                        from Baton Rouge; the bill passed 70-30." or "A group
--                        funded mainly by the state hospital association."
-- proposed_by_source_url the enabling bill page or the election authority's
--                        initiative filing that supports the two lines above.
-- proposed_by_researched_at
--                        when the proposer was last researched. NULL = never
--                        looked. A researched measure whose proposer could not
--                        be found keeps proposed_by NULL with this stamp set,
--                        so the due list does not re-queue it forever.
ALTER TABLE public.ballot_measures
    ADD COLUMN IF NOT EXISTS proposed_by text,
    ADD COLUMN IF NOT EXISTS proposed_by_about text,
    ADD COLUMN IF NOT EXISTS proposed_by_source_url text,
    ADD COLUMN IF NOT EXISTS proposed_by_researched_at timestamptz;

-- The three text columns travel together: a name without its explainer or
-- its source is exactly the half-evidence the feature exists to avoid.
ALTER TABLE public.ballot_measures
    DROP CONSTRAINT IF EXISTS chk_ballot_measures_proposed_by_complete;
ALTER TABLE public.ballot_measures
    ADD CONSTRAINT chk_ballot_measures_proposed_by_complete
    CHECK (
        (proposed_by IS NULL AND proposed_by_about IS NULL AND proposed_by_source_url IS NULL)
        OR (
            proposed_by IS NOT NULL AND proposed_by_about IS NOT NULL AND proposed_by_source_url IS NOT NULL
            AND proposed_by_researched_at IS NOT NULL
        )
    );

COMMIT;

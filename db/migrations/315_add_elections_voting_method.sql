-- How the contest is counted. Null means the method was never recorded, which
-- is true for most rows; readers show a ranked-choice notice only when the
-- value is 'ranked_choice'. The other values exist so a later research pass can
-- record them without another migration; the UI does not yet read them.
--   ranked_choice: voters rank candidates; rounds eliminate the last-place
--                  candidate until one has a majority (Maine, Alaska, DC, and
--                  a few dozen cities).
--   plurality:     most votes wins in one round.
--   top_two:       the top two from an all-party primary meet in the general.
--   runoff:        a separate second election when no one clears a threshold.
ALTER TABLE public.elections
  ADD COLUMN IF NOT EXISTS voting_method text;

-- Most rankings a voter may mark on a ranked-choice ballot, when capped (New
-- York City allows five). Null = no cap recorded.
ALTER TABLE public.elections
  ADD COLUMN IF NOT EXISTS ranked_choice_max_rankings integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'elections_voting_method_allowed'
  ) THEN
    ALTER TABLE public.elections
      ADD CONSTRAINT elections_voting_method_allowed
      CHECK (voting_method IS NULL OR voting_method IN ('ranked_choice', 'plurality', 'top_two', 'runoff'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'elections_ranked_choice_max_rankings_positive'
  ) THEN
    ALTER TABLE public.elections
      ADD CONSTRAINT elections_ranked_choice_max_rankings_positive
      CHECK (ranked_choice_max_rankings IS NULL OR ranked_choice_max_rankings > 0);
  END IF;
END $$;

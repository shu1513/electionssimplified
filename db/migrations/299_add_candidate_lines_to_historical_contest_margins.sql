-- Every candidate line of a past contest, sorted by votes descending, as
-- [{"votes": 123, "party": "REPUBLICAN"}, ...]. The stored winner/runner-up
-- pair only describes a single-seat race: in a "vote for two" district the
-- top two lines are both winners, so the margin that decided the last seat
-- is 2nd place vs 3rd. The lookup re-ranks from these lines using the
-- current election's seats_to_fill. NULL on rows written before this column
-- existed; the next competitiveness:refresh fills them.
ALTER TABLE public.historical_contest_margins
  ADD COLUMN IF NOT EXISTS candidate_lines jsonb;

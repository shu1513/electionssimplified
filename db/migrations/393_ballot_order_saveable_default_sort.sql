-- "Ballot order" (sort value state_baseline — contests in the order they
-- print on the paper ballot) becomes a sort a user can save, and the default
-- for everyone. The CHECK constraint mirrors SAVEABLE_BALLOT_PREFERENCE_SORTS
-- in backend/src/pipeline/address/ballotElectionOrdering.ts.
ALTER TABLE public.user_ballot_preferences
  DROP CONSTRAINT user_ballot_preferences_sort_check;

ALTER TABLE public.user_ballot_preferences
  ADD CONSTRAINT user_ballot_preferences_sort_check
  CHECK (sort IN ('state_baseline', 'vote_power', 'district_size', 'district_size_smallest', 'my_areas'));

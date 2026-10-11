-- D.C. Fair Elections Program committees receive public base and matching
-- payments from OCF (Fair Elections schedule A3). The finance card already
-- shows a "Public funds" stat when the summary carries public_funds_received
-- (Denver migration 240, San Francisco migration 229).
--
-- direct_contribution_total ("Raised") stays donor money only. Public funds
-- are counted in total_receipts and published here on their own.
--
-- Nullable: null means the committee is not in the program; 0.00 means a
-- program committee that has not been paid yet.

ALTER TABLE public.dc_candidate_finance_summaries
  ADD COLUMN public_funds_received numeric(16,2),
  ADD CONSTRAINT dc_candidate_finance_summaries_public_funds_check
    CHECK (public_funds_received IS NULL OR public_funds_received >= 0);

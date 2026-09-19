-- Let candidate_records carry origin = 'travel_import': rows written by the
-- sponsored-travel importer (`npm run travel:import`), which turns House Clerk
-- gift-travel filings into one record per member per trip. Same shape as
-- migration 252. The list must stay aligned with CANDIDATE_RECORD_ORIGINS in
-- backend/src/pipeline/candidates/candidateRecordStore.ts.

BEGIN;

ALTER TABLE public.candidate_records
    DROP CONSTRAINT candidate_records_origin_check;

ALTER TABLE public.candidate_records
    ADD CONSTRAINT candidate_records_origin_check
    CHECK (origin IS NULL OR origin IN ('ai_enricher', 'repair', 'manual', 'rollcall_import', 'travel_import'));

COMMIT;

-- The label a voter's paper ballot prints for a contest when it differs from
-- the stored title's own label, e.g. "Statewide Amendment 1" for a measure
-- stored as "Act 2026-341: ...". The stored title stays the contest's
-- identity; readers apply this label for display only.
ALTER TABLE public.elections
  ADD COLUMN IF NOT EXISTS printed_ballot_label text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'elections_printed_ballot_label_not_blank'
  ) THEN
    ALTER TABLE public.elections
      ADD CONSTRAINT elections_printed_ballot_label_not_blank
      CHECK (printed_ballot_label IS NULL OR btrim(printed_ballot_label) <> '');
  END IF;
END $$;

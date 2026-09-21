-- One row per FEC committee that gave to a candidate: the FEC's own facts
-- about the committee, and the interest it is grouped under on the finance
-- card ("PAC money by interest").
--
-- classification_source says where interest_slug came from:
--   fec     - read straight from the FEC registration (leadership PAC,
--             candidate committee, labor organization)
--   rule    - the shared rule classifier matched the connected organization
--             or committee name
--   manual  - researched by hand; never overwritten by a sync
--   unknown - not classified yet (interest_slug is NULL); this is the manual
--             work queue
-- A NULL interest_slug under manual is a researched "fits no interest" verdict.

BEGIN;

CREATE TABLE IF NOT EXISTS public.finance_pac_interests (
  committee_id text PRIMARY KEY,
  committee_name text NOT NULL,
  committee_type text,
  designation text,
  organization_type text,
  connected_organization text,
  interest_slug text,
  confidence text NOT NULL DEFAULT 'unknown',
  classification_source text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_finance_pac_interests_committee_id
    CHECK (committee_id ~ '^C[0-9]{8}$'),
  CONSTRAINT chk_finance_pac_interests_committee_name
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT chk_finance_pac_interests_interest_slug
    CHECK (interest_slug IS NULL OR interest_slug ~ '^[a-z0-9_]+$'),
  CONSTRAINT chk_finance_pac_interests_confidence
    CHECK (confidence IN ('high', 'medium', 'low', 'unknown')),
  CONSTRAINT chk_finance_pac_interests_source
    CHECK (classification_source IN ('fec', 'rule', 'manual', 'unknown')),
  CONSTRAINT chk_finance_pac_interests_unknown
    CHECK (classification_source <> 'unknown' OR interest_slug IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_finance_pac_interests_due
  ON public.finance_pac_interests (classification_source)
  WHERE classification_source = 'unknown';

DROP TRIGGER IF EXISTS trg_finance_pac_interests_set_updated_at
  ON public.finance_pac_interests;
CREATE TRIGGER trg_finance_pac_interests_set_updated_at
BEFORE UPDATE ON public.finance_pac_interests
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;

BEGIN;

-- Who funds each side of a ballot measure, from official campaign finance
-- filings. One row per measure and side. A missing row means "not researched";
-- a row with total_raised = 0 and empty arrays means "researched, no committee
-- reported money on this side".
--
-- committees and top_donors are small display lists (a few entries each), so
-- they live as jsonb next to the side's total rather than in child tables.
-- Their shape is enforced by the payload contract
-- (backend/src/contracts/ballotMeasureFundingPayloadContract.ts); the database
-- only guards what it can check cheaply.
CREATE TABLE public.ballot_measure_funding (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ballot_measure_id uuid NOT NULL,
    side text NOT NULL,
    -- Sum of the side's committee totals, net of money one listed committee
    -- gave another on the same side. Computed by the writer, never supplied.
    total_raised numeric(14, 2) NOT NULL,
    -- [{ name, committee_id?, total_raised, from_same_side_committees,
    --    also_covers_other_measures, source_url }]
    committees jsonb NOT NULL,
    -- [{ name, amount, type: organization|individual, state? }], largest first.
    top_donors jsonb NOT NULL,
    -- Date the filings were read. Money arrives late in a campaign, so the
    -- page must show how old the numbers are.
    as_of date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_ballot_measure_funding_measure
        FOREIGN KEY (ballot_measure_id) REFERENCES public.ballot_measures(id) ON DELETE CASCADE,
    CONSTRAINT uq_ballot_measure_funding_measure_side
        UNIQUE (ballot_measure_id, side),
    CONSTRAINT chk_ballot_measure_funding_side
        CHECK (side IN ('support', 'oppose')),
    CONSTRAINT chk_ballot_measure_funding_total_raised
        CHECK (total_raised >= 0),
    CONSTRAINT chk_ballot_measure_funding_committees_array
        CHECK (jsonb_typeof(committees) = 'array'),
    CONSTRAINT chk_ballot_measure_funding_top_donors_array
        CHECK (jsonb_typeof(top_donors) = 'array')
);

CREATE TRIGGER trg_ballot_measure_funding_set_updated_at
BEFORE UPDATE ON public.ballot_measure_funding
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Read-only for the API role: the default privileges in
-- docs/postgres-api-role.md already cover SELECT on new tables.

COMMIT;

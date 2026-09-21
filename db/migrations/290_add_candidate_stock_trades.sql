BEGIN;

-- Securities transactions that members of Congress and federal candidates
-- report under the STOCK Act (Periodic Transaction Reports). These are not
-- candidate_records: a trade carries no issue stance, and a filer can report
-- hundreds a year. They get their own tables and their own panel.
--
-- Three tables:
--   candidate_stock_trade_filers   who the importer covers. The panel shows
--                                  only for a candidate with a row here, so
--                                  "No stock trades reported." is only ever
--                                  said about someone whose filings were read.
--   candidate_stock_trade_filings  one row per filed report, parsed or not.
--   candidate_stock_trades         one row per transaction line of a parsed
--                                  report.

CREATE TABLE public.candidate_stock_trade_filers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id uuid NOT NULL,
    chamber text NOT NULL,
    -- The filer's id in the source's own terms: a bioguide id for a House
    -- member. Null when the source has none.
    source_member_id text,
    -- Filing years whose index was read for this filer, e.g. {2023,2024}.
    index_years integer[] NOT NULL,
    -- Date the newest index was published or downloaded.
    checked_through date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_candidate_stock_trade_filers_candidate
        FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE,
    CONSTRAINT uq_candidate_stock_trade_filers_candidate_chamber
        UNIQUE (candidate_id, chamber),
    CONSTRAINT chk_candidate_stock_trade_filers_chamber
        CHECK (chamber IN ('house', 'senate'))
);

CREATE TRIGGER trg_candidate_stock_trade_filers_set_updated_at
BEFORE UPDATE ON public.candidate_stock_trade_filers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE public.candidate_stock_trade_filings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id uuid NOT NULL,
    chamber text NOT NULL,
    -- The source's own filing id (House Clerk DocID). Unique per chamber.
    doc_id text NOT NULL,
    filing_year integer NOT NULL,
    filing_date date,
    -- The official filing. Every trade in the panel links here.
    source_url text NOT NULL,
    filer_name text NOT NULL,
    -- True when any row of the filing is marked "Amended" by the filer.
    is_amendment boolean NOT NULL DEFAULT false,
    -- parsed        text PDF, rows read
    -- scanned       paper filing (image PDF); stored so the panel can link it,
    --               trades are not read from images
    -- parse_failed  text PDF whose rows could not be read with confidence
    parse_status text NOT NULL,
    parser_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_candidate_stock_trade_filings_candidate
        FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE,
    CONSTRAINT uq_candidate_stock_trade_filings_chamber_doc
        UNIQUE (chamber, doc_id),
    CONSTRAINT chk_candidate_stock_trade_filings_chamber
        CHECK (chamber IN ('house', 'senate')),
    CONSTRAINT chk_candidate_stock_trade_filings_parse_status
        CHECK (parse_status IN ('parsed', 'scanned', 'parse_failed'))
);

CREATE INDEX idx_candidate_stock_trade_filings_candidate
    ON public.candidate_stock_trade_filings (candidate_id);

CREATE TRIGGER trg_candidate_stock_trade_filings_set_updated_at
BEFORE UPDATE ON public.candidate_stock_trade_filings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE public.candidate_stock_trades (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    filing_id uuid NOT NULL,
    -- Position of the row in the filing, from 1. (filing, row) is the
    -- idempotency key: a re-run never adds a second copy of a row.
    row_index integer NOT NULL,
    owner text NOT NULL,
    asset_name text NOT NULL,
    ticker text,
    -- The source's asset type code as filed (House: ST stock, GS government
    -- security, OP option, CT cryptocurrency, ...). Null when not printed.
    asset_type text,
    transaction_type text NOT NULL,
    transaction_date date NOT NULL,
    notification_date date,
    -- Filings give a dollar range, never an exact amount. amount_high is null
    -- for an open-ended top range ("Over $50,000,000").
    amount_low bigint NOT NULL,
    amount_high bigint,
    -- "new" or "amended", as the filer marked the row.
    filing_status text NOT NULL DEFAULT 'new',
    -- Set on a row that a later amended row restates. A superseded row stays
    -- stored but is left out of the panel and its totals.
    superseded_by_trade_id uuid,
    raw_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_candidate_stock_trades_filing
        FOREIGN KEY (filing_id) REFERENCES public.candidate_stock_trade_filings(id) ON DELETE CASCADE,
    CONSTRAINT fk_candidate_stock_trades_superseded_by
        FOREIGN KEY (superseded_by_trade_id) REFERENCES public.candidate_stock_trades(id) ON DELETE SET NULL,
    CONSTRAINT uq_candidate_stock_trades_filing_row
        UNIQUE (filing_id, row_index),
    CONSTRAINT chk_candidate_stock_trades_owner
        CHECK (owner IN ('self', 'spouse', 'child', 'joint')),
    CONSTRAINT chk_candidate_stock_trades_transaction_type
        CHECK (transaction_type IN ('purchase', 'sale', 'partial_sale', 'exchange')),
    CONSTRAINT chk_candidate_stock_trades_filing_status
        CHECK (filing_status IN ('new', 'amended')),
    CONSTRAINT chk_candidate_stock_trades_amounts
        CHECK (amount_low >= 0 AND (amount_high IS NULL OR amount_high >= amount_low))
);

CREATE INDEX idx_candidate_stock_trades_superseded_by
    ON public.candidate_stock_trades (superseded_by_trade_id)
    WHERE superseded_by_trade_id IS NOT NULL;

CREATE TRIGGER trg_candidate_stock_trades_set_updated_at
BEFORE UPDATE ON public.candidate_stock_trades
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Read-only for the API role: the default privileges in
-- docs/postgres-api-role.md already cover SELECT on new tables.

COMMIT;

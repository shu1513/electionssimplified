BEGIN;

-- ZIP partial-ballot legislative upgrade (docs/plans/partial-address-scope.md):
-- one row per 2020 ZCTA whose residents ALL live in a single 2026 state
-- legislative district (lower and/or upper chamber). Decided block by block
-- at import time from the Census ZCTA/block relationship file, the 2026
-- state legislative block equivalency files (the plans the November 2026
-- ballots use) and 2020 block populations, so a ZIP whose uninhabited land
-- crosses a district line still qualifies while a ZIP with even one resident
-- in another district never does. Loaded by
-- `npm run import:zcta-legislative-crosswalk`; re-run after any legislative
-- redistricting. Read-only for the API (SELECT arrives through the role's
-- default privileges; docs/postgres-api-role.md).
CREATE TABLE IF NOT EXISTS public.address_zcta_legislative (
  zcta5 text PRIMARY KEY,
  state_lower_geoid text,
  state_upper_geoid text,
  CONSTRAINT chk_address_zcta_legislative_zcta5_shape CHECK (zcta5 ~ '^[0-9]{5}$'),
  CONSTRAINT chk_address_zcta_legislative_lower_shape CHECK (state_lower_geoid ~ '^[0-9]{2}[0-9A-Z-]{3}$'),
  CONSTRAINT chk_address_zcta_legislative_upper_shape CHECK (state_upper_geoid ~ '^[0-9]{2}[0-9A-Z-]{3}$'),
  CONSTRAINT chk_address_zcta_legislative_some_district CHECK (state_lower_geoid IS NOT NULL OR state_upper_geoid IS NOT NULL)
);

COMMIT;

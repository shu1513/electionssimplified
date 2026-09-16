-- Relabel U.S. House district rows in the states that vote on redrawn lines
-- on November 3, 2026.
--
-- districts.name comes from the ACS 2024 congressional-district endpoint,
-- which labels every seat "(119th Congress)" (the 2024 lines). The label is
-- user-visible ("Elections in Congressional District 5 (119th Congress),
-- Tennessee"). Nine states adopted new maps after that and use them for the
-- November 2026 House election; the address resolver now places addresses in
-- those states with TIGERweb's 120th Congressional Districts layer
-- (backend/src/pipeline/address/usHouse2026Redistricting.ts), so their rows
-- stand for the 120th-map seat and should say so. District NUMBERS survived
-- in every one of these states (each kept its seat count), which is why the
-- rows are relabeled rather than replaced.
--
-- The state list mirrors US_HOUSE_2026_REDRAWN_STATE_FIPS exactly: Alabama,
-- California, Florida, Louisiana, North Carolina, Ohio, Tennessee, Texas,
-- Utah. Missouri is deliberately absent — its 2025 map was blocked by the
-- Missouri Supreme Court on 2026-09-03 and it votes on the 2022 lines.
--
-- The districts loader applies the same relabel when it re-runs
-- (parseUsHouseDistrictRows), so a reload does not undo this. Idempotent: rows
-- already reading "(120th Congress)" no longer match the predicate.

BEGIN;

UPDATE public.districts
SET name = replace(name, '(119th Congress)', '(120th Congress)')
WHERE district_type = 'us_house'
  AND state_fips IN ('01', '06', '12', '22', '37', '39', '47', '48', '49')
  AND name LIKE '%(119th Congress)%';

COMMIT;

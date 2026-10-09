# Partial-address scope (ZIP ballot)

Status: PR 1 (backend + data, #858) and PR 2 (web + mobile, #859) MERGED
2026-08-25; ZIP-place retrieve fix (#860) and region/city selections (see
"Region selections") followed the same day. Crosswalk stats verified against
the actual Census file; the retrieve centroid bug was confirmed in code and
fixed in PR 1.

## Problem

The home page's only entry point is a full street address
([HomePage.tsx](../../frontend/src/pages/HomePage.tsx)). Some visitors distrust
the field and won't type where they live, even with
`ADDRESS_FIELD_PRIVACY_NOTE` and `FullAddressExplanation` doing their best.
A typed ZIP dies in the Census one-line geocoder with `not_found` → a 422 the
UI renders as "check the street, city, and state".

We can honestly serve a **partial ballot** for a ZIP: statewide races, plus
county races when the ZIP maps to exactly one county — with a banner saying
what's missing and inviting the street address. A conversion teaser instead of
a dead end.

## Correctness rules

1. **Never present a district guessed from a point as the visitor's
   district.** A ZIP/city centroid falls in *some* House / state-leg / school
   district, but the visitor may live in a different one.
2. **Don't claim more certainty than the data has.** ZCTAs are the Census's
   generalized, block-based approximation of ZIP delivery patterns (each
   block gets the ZIP with the most addresses) — not USPS boundaries
   ([methodology](https://www.census.gov/programs-surveys/geography/guidance/geo-areas/zctas.html)).
   So ZIP→county is only offered in the unambiguous case, and the UI always
   labels ZIP results partial.

Scope tiers:

| Input | Districts returned | How resolved |
|---|---|---|
| street address (today) | all 9 types | Census geocode — unchanged |
| ZIP | `statewide`; + `county` only when the ZCTA has **exactly one** county relationship; + `place` only when the ZCTA lies **wholly inside one** legally incorporated place (migration 256 / `import:zcta-place-crosswalk`: exactly one place-overlap record, zero land outside it, CLASSFP C\* — CDPs never; 3,087 of 33,791 ZCTAs, incl. NYC/SF/DC/consolidated balances; the containment decision is baked at import); + `state_lower` / `state_upper` (each on its own) only when **every resident** of the ZCTA lives in one district of that chamber (migration 317 / `import:zcta-legislative-crosswalk`, see below) | local ZCTA↔county + ZCTA↔place + ZCTA↔legislative crosswalks, **no geocoder call** |
| region selection (city, neighborhood, county…) | `statewide`; + `place` only for a **locality** pick whose name + state matches **exactly one** incorporated place in `districts` | Google `addressComponents` state/locality relayed via `region_state`/`region_locality`; identity by exact Census name ("Los Angeles city, California"), CDPs excluded, **no geocoder call** |

Conservative county rule (verified against the file, 2026-08-25):

- Counties span >1 state → **error** ("that ZIP crosses state lines — enter
  your city and state or street address"). 137 ZCTAs nationally; 29 of them
  have a ≥97% dominant county, e.g. `02861` is 99.5% Providence County RI but
  intersects Bristol County MA — a land-share threshold would have quietly
  assigned some Massachusetts residents a Rhode Island ballot. No threshold.
- One state, exactly one county row → statewide + county. **23,605 of 33,791
  ZCTAs (70%)** — the common case gets county races.
- One state, multiple county rows → statewide only. 10,049 ZCTAs; the banner
  explains why county races need the address.
- County FIPS in a territory (72/78/66/69/60; 149 ZCTAs) → the existing
  "unsupported coverage" style error — the districts table covers 50 states
  + DC, so returning the key would just produce an empty ballot.
- ZIP with no ZCTA row (~7k ZIPs, largely unique/PO-box ones without their
  own ZCTA — though 2020 ZCTAs *can* represent PO-box-only ZIPs) → friendly
  error suggesting the street address.

State legislative rule (`address_zcta_legislative`, decided at import by
`importZctaLegislativeCrosswalk.ts`):

- Containment is measured in **residents, not land**. ZCTAs are built from
  census blocks, and rural ZCTAs routinely include uninhabited blocks that
  fall in a neighbouring district: 99826 (Gustavus, AK) has 19% of its land
  in House District 2 but every resident in House District 3. The
  Census ZCTA↔SLDL relationship file only carries land/water shares, so the
  import joins the ZCTA↔block relationship file to the **2026** state
  legislative **block equivalency files** (the plans the November 2026
  ballots are drawn on) and 2020 block populations (P1_001N via the Census
  Data API, `CENSUS_API_KEY_*`). A block the population source lacks counts
  as unknown, not zero: its ZCTA is left undecided.
- A chamber is decided for a ZCTA only when the ZCTA has residents, every
  block with residents maps to the same district, no block with residents is
  unassigned (`ZZZ`, or a state without that chamber — Nebraska's House, DC),
  and no block with residents is one the state's plan **splits** between
  districts (the Bureau tabulates a split block whole; the real line runs
  through it). One resident on the other side of a line → no district: a ZIP
  ballot never carries someone else's legislative race.
- Lower and upper chambers are decided independently, so a row can carry one
  and not the other. A `state_lower` key also feeds the `district_components`
  lookup, so New Hampshire floterials come along with their base district.
- Yield (2026-10-08 build, 33,791 ZCTAs): 18,227 get a lower-chamber district
  and 22,967 an upper-chamber one (24,147 rows; the 149 territory ZCTAs stay
  undecided because no population is fetched for them). On the 2024 plans,
  land-share containment would have given 17,495 / 22,336 against 18,228 /
  22,949 for the residents rule, and a 99.5%-of-residents threshold 19,167 /
  23,934 — the threshold was rejected for the same reason as the county rule:
  it would knowingly hand the remaining residents a neighbouring district's
  race. 99826 itself has 2 of 657 residents in House District 2, so it stays
  statewide + county until a street address is entered.
- Re-run the import (with the matching equivalency files) whenever a state
  redraws legislative lines. Michigan (Senate), Minnesota and Mississippi
  adopted new plans for 2026; the 2026 files carry them, so e.g. 48186
  (Westland, MI) is undecided for the Senate because 3,541 of its residents
  moved to District 4. Known gap: the exact-address path geocodes with
  vintage `ACS2024_Current`, whose legislative layers are still the 2024
  lines, so a street address in those areas can land in the old district
  until that vintage is moved to the 2026 layers.

## Why this stays small

The ballot page already takes plain district ids (`/ballot?d=<ids>`), and
`lookupAddressDistricts` ([addressDistrictLookup.ts](../../backend/src/pipeline/address/addressDistrictLookup.ts))
resolves `(district_type, geoid_compact)` keys against `public.districts`. A
ZIP resolution is just a *shorter key list* flowing through the existing pipe.
No ballot-query, ordering, or election-data changes.

## Pre-existing bug PR 1 must fix first

Google autocomplete has **no type restriction**
([googlePlacesAutocomplete.ts](../../backend/src/pipeline/address/googlePlacesAutocomplete.ts)
sends only `includedRegionCodes: ["us"]`), so it already suggests cities and
ZIPs. Selecting one returns a centroid `location`, and the resolver's
coordinate-first path
([addressResolverService.ts](../../backend/src/pipeline/address/addressResolverService.ts))
treats it as an exact point — today a visitor who picks "Austin, TX" gets a
full ballot, including House/state-leg/school races, for whatever district the
centroid happens to sit in. That violates rule 1 *now*, and makes it unsafe to
advertise coarse input before fixing classification.

Fix in the retrieve step (server-side — never trust the client to classify):

- Add `types,addressComponents` to `RETRIEVE_FIELD_MASK` (pass-through only;
  Google ToS forbids persisting). Not `postalAddress`: Google returns an empty
  `postalAddress` for postal_code places (verified live 2026-08-25), so the
  ZIP must come from the `postal_code` address component.
- Classify server-side: if `types` intersects a region set (`route`,
  `postal_code`, `postal_code_prefix`, `locality`, `sublocality*`,
  `neighborhood`, `administrative_area_level_*`, `postal_town`, `country`),
  the selection is coarse — return `location: null` plus
  `granularity: "zip" | "region"` and, for `postal_code`, the 5-digit
  `postal_code` from the `postal_code` address component. Everything else keeps today's behavior
  (`granularity: "address"`) — except that a response with missing/empty
  `types` fails closed: address granularity, but no location, since the type
  list is the proof the coordinates are a real point.
- Old clients (shipped mobile builds) ignore the new fields, get a null
  location, submit the text string, and land on today's 422 — strictly safer
  than the current wrong-ballot behavior, with no forced upgrade.

## PR 1 — backend + data

**`allow_partial`.** `POST /api/address/resolve` body gains optional
`allow_partial: boolean` (default false). The ZIP branch runs **only when
true**. Updated web/mobile clients send it; old clients and the authenticated
saved-address path never do, so:

- [userAddressDistrictUpdater.ts](../../backend/src/pipeline/users/userAddressDistrictUpdater.ts)
  (which feeds saved ballots and notifications through the same resolver)
  can never silently replace a complete saved district set with a coarse one.
  A ZIP typed into the settings address form gets a clear
  "full address required" error instead.
- Shipped mobile builds see no behavior change until they update.

**ZIP detection.** In `resolveAddressToDistricts`, before the geocoder paths
and only under `allow_partial`: input matching `^\s*\d{5}(-\d{4})?\s*$` takes
the ZIP branch (ZIP+4 → first five digits). Zero external calls; skip the
redis cache (the crosswalk lookup is one indexed local query).

**Crosswalk table** (migration 255):

```sql
CREATE TABLE address_zcta_county (
  zcta5        text NOT NULL,
  county_geoid text NOT NULL,   -- 5-digit state+county FIPS
  PRIMARY KEY (zcta5, county_geoid)
);
```

No land-share column — the conservative rule doesn't use one.

**Importer** `npm run import:zcta-county-crosswalk` (new script), source
`https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt`
(pipe-delimited; verified 2026-08-25: 47,863 data rows = 46,960 populated
ZCTA↔county relationships + 903 blank-ZCTA rows for county territory with no
ZCTA; UTF-8 BOM before the first header). The importer must:

- strip the BOM and validate the exact header row;
- skip blank-`GEOID_ZCTA5_20` records;
- validate 5-digit ZCTA and county GEOIDs;
- load into a staging table and swap inside one transaction;
- refuse to replace existing data if the parsed row count is implausible
  (guard band around ~47k).

One-time per decade; no scheduler. (If ZIP fidelity ever matters more, HUD's
quarterly USPS crosswalk uses address ratios and is the better source — a
deliberate later upgrade, not v1.)

**Contract.** `PublicAddressResolutionResult`
([addressApiResponses.ts](../../backend/src/api/addressApiResponses.ts)) gains
one field: `scope: "exact" | "zip"`. No `scope_label` — `matched_address`
already carries the display string (the ZIP itself). Internal
`AddressResolutionResult.coordinates` becomes nullable (or the ZIP branch uses
a separate constructor) — the public response never exposed coordinates, so
only internal types move. New failure modes get **distinct error codes** (ZIP
unknown / multi-state / territory) so clients can show accurate copy.

**Tests.** ZIP and ZIP+4 in/out of the regex; single-county, multi-county
same-state, multi-state (incl. a ≥97%-dominant one — must still error),
territory, unknown ZIP; `allow_partial` absent → full-address error;
authenticated updater rejects ZIP input; terms gate enforced on the ZIP
branch; retrieve classification (postal_code, locality, street address,
establishment); exact-address regression.

## PR 2 — web + mobile

Both clients share the endpoint and the matched-address handoff
(`mobile/src/app/(tabs)/index.tsx`, `mobile/src/app/ballot.tsx`), so this PR
covers **web, mobile, and the shared api-client types** together.

- Send `allow_partial: true` from the anonymous home flows; clear any stored
  coarse/granularity state on every keystroke (same rule as coordinates
  today).
- Selected ZIP suggestion (retrieve `granularity: "zip"`) → use the returned
  `postal_code` as the input; selected region (`"region"`) → inline guidance:
  "pick a street address, or enter just a ZIP code for partial results".
- Home copy: "Enter your full address for complete results — or just a ZIP
  code for partial results." Privacy note stays. Update
  [FullAddressExplanation.tsx](../../frontend/src/components/FullAddressExplanation.tsx)
  (and the mobile equivalent) to explain complete vs. partial rather than
  implying only full addresses work.
- Ballot banner when `scope === "zip"`: shown races + CTA, without promising
  specific missing races ("Enter your street address to check for additional
  congressional, legislative, local, and school races."). Scope rides router
  state like `matchedAddress`; additionally append `partial=1` to the ballot
  URL — no location data, but a shared or direct link still renders a generic
  partial notice when router state is absent.
- Error copy: `ErrorNotice`
  ([Status.tsx](../../frontend/src/components/Status.tsx)) currently replaces
  every 422 with street-address copy — branch on the new error codes (or
  render the API message for them).
- **Signup handoff: coarse results are never saved.** Skip
  `savePendingDistrictIds` for `scope !== "exact"` and clear any previously
  stored pending ids (last search wins — a stale exact set must not
  initialize an account the visitor thinks reflects their ZIP search).
  Persisting a partial account correctly would need a completeness flag plus
  banners across saved-ballot/settings/notifications — out of scope for v1;
  registered users get districts via the settings address form.

**Tests.** Banner per scope and via bare `partial=1` link; ZIP submit
navigates with returned ids; handoff skipped and cleared on coarse; mobile
banner; regression: exact flow unchanged.

## Rollout

1. PR 1 merge → migration 255 + importer locally; spot-check `78701` →
   Travis (single-county), `02861` → error, a 10049-class ZIP → statewide
   only.
2. PR 2 merge. No feature flag: invisible until someone types a ZIP with an
   updated client, and the exact path is regression-covered.
3. Prod: apply migration, run importer against prod DB, deploy api + ssr;
   mobile release through the normal Expo channel (old builds stay safe via
   `allow_partial`).

## Region selections (added 2026-08-25)

City picks work: the retrieve step returns `state` +`locality` for `region`
selections (locality only when the selection's own types include `locality` —
a neighborhood pick also carries its containing city's component, but
neighborhoods can straddle city lines). The client relays them as
`region_state`/`region_locality`; the resolver serves `statewide` always
(scope `"region"`), plus `place` races when
`"{locality} {city|town|village|borough|municipality}, {StateName}"` matches
exactly one `districts` row — the exact-name identity check stands in for the
deferred geometry work: no match (CDPs, decorated consolidated-government
names, unincorporated communities) or several matches fall back to statewide
only. Unknown/territory states → `region_unsupported` (422). Stateless region
picks (a country) still get inline guidance.

## Later research (explicitly not v1)

- County races for cities (needs a place↔county containment source; the
  ZCTA↔place crosswalk shipped 2026-08-25); labeled multi-county display;
  HUD address-ratio crosswalk; any per-user coarse location storage;
  fuzzy/alias locality matching (consolidated governments like
  Nashville-Davidson, Louisville/Jefferson).

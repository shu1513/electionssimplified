# Special-district geography

Status: proposal for review. No district rows are created by this document.

## Problem

Some November 3, 2026 contests have no district to attach to, so they cannot
be written without showing them to the wrong voters. Examples from San
Francisco and Oakland:

| Body | Seats on the Nov 2026 ballot (examples) | Electorate |
| --- | --- | --- |
| BART Board of Directors | District 4, District 8 | 9 districts across 4 counties |
| AC Transit Board | Wards 3, 4, 5 | 5 wards + at-large, parts of 2 counties |
| EBMUD Board | Wards 3, 7 | 7 wards, parts of 2 counties |
| East Bay Regional Park District Board | Wards 3, 5 | 7 wards, 2 counties |
| Peralta Community College District | Trustee Area 5 | 7 trustee areas inside Alameda County |
| City College of San Francisco | 3 at-large seats + 1 partial term | All of San Francisco |
| State Board of Equalization | District 2 | 4 districts covering California |

Two facts drive the design:

1. The Census geocoder (our only address-to-district source today) returns
   states, counties, places, school districts, and legislative districts. It
   returns none of these bodies.
2. Attaching a ward seat to a larger district (the county, or the statewide
   row) shows it to every resident of that larger area. The
   sub-jurisdiction seat badge (`subDistrictSeat.ts`) softens this for county
   supervisor seats, but a statewide BOE seat or a four-county BART seat is
   too far off to badge.

## Proposal

### 1. District types

Add two kinds of rows, not one type per agency:

- **`local_special`** for any local special district or sub-area of one: a
  transit, utility, or park ward, or a community college trustee area. A
  new text column `districts.special_kind` records the kind (`transit`,
  `water_utility`, `park`, `community_college`, and more later). The same
  district type is already being explored for reviewed local boundaries
  (migrations 300–301 on a separate branch); this plan should land on the
  same type and table rather than a second one.
- **A state-body district type for BOE**, following the precedent of the
  New Hampshire Executive Council (`state_executive_council`): a statewide
  board elected from a few large districts. Either reuse a generic name such
  as `state_board_district` or add `state_board_of_equalization`. Four rows.

Key format for `geoid_compact`: `<STATE>:<AGENCY>:<SEAT>`, for example
`CA:BART:4`, `CA:EBMUD:W7`, `CA:PERALTA:TA5`, `CA:BOE:2`. These are our own
keys; no federal GEOID exists for these areas.

Each body that has both ward seats and at-large seats (AC Transit) gets one
row per ward plus one row for the whole agency area. The at-large seat
attaches to the agency-wide row.

### 2. Offices

`offices.scope` gains the new district types. New catalog offices, each with
three plain summary bullets:

- `Transit District Director` (`local_special`)
- `Utility District Director` (`local_special`)
- `Park District Director` (`local_special`)
- `Community College Trustee` gets a `local_special` twin. The existing
  county-scope row stays for trustee seats that really are elected
  countywide.
- `State Board of Equalization Member` moves to the new BOE scope. It has no
  elections today, so no election rows need rewriting.

City College of San Francisco needs no new geography: the district is
coextensive with the city and county, so its seats attach to the existing
San Francisco County row through the county-scope Community College Trustee
office. This can be written today.

### 3. Geometry

Store each polygon with where it came from, as the reviewed-boundary table
on the separate branch does (`geometry`, `boundary_source_url`,
`boundary_source_sha256`, `boundary_vintage`, `review_status`). Only rows
marked `verified` take part in address lookup.

Sources, in order of preference (each to be confirmed during review):

1. The agency's own adopted redistricting map (shapefile or GeoJSON). BART,
   AC Transit, EBMUD, EBRPD, and Peralta all redrew in 2021–2022 and
   published the adopted maps.
2. The county registrar's district layers, which assign every precinct to
   each district on the ballot.
3. For BOE, the 2021 California Citizens Redistricting Commission final
   maps.

Geometry is loaded by an import script from a reviewed file, never typed in
by hand. The script refuses a file whose SHA-256 differs from the one
recorded at review.

The database has no PostGIS, so point-in-polygon runs in the backend, like
the separate branch's `localSpecialDistrictEligibility.ts`. Polygon counts
are small (dozens per state), so this is cheap.

### 4. Address resolution

After the geocoder returns coordinates and its district keys:

1. Load verified polygons for the address's state (cached in memory).
2. Test the point against each polygon.
3. If the point lies within a set margin of an edge (25 m on the separate
   branch), do not guess. Return no key for that body and add a warning, so
   the ballot can say "we could not tell which ward you are in" instead of
   showing the wrong seat.
4. Add the matching keys to `district_keys` and `user_districts` like any
   other type.

Stored user district sets need a refresh when new geometry lands, since
existing users were resolved before it existed. The existing
address-update path can re-run for affected states.

### 5. Research pipeline

Election discovery and roster research work per district row, so each new
row becomes a normal research target once it exists. The manual-research
skill needs a short section on special-district seat titles (for example
"Director, BART District 4" to `CA:BART:4`).

## Rollout order

1. Schema: district types, `special_kind`, office scopes, catalog offices.
2. BOE: four districts, one statewide source, largest audience.
3. Bay Area bodies above, one agency per PR, each with its source file and
   review note.
4. Other states' special districts, driven by user demand data.

## Open questions

- One generic state-board type, or one type per body (BOE, NH Executive
  Council)?
- Should geometry files live in the repo (small, reviewable diffs) or in
  object storage with only the checksum in the repo?
- Population is unknown for most special districts. Vote-power scoring
  needs a rule for NULL population (skip the score, or use registered
  voters from the registrar).

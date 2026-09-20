# Privately paid trips to Israel by House members

Source: the House Clerk's yearly gift-travel indexes (`<year>Travel.xml`,
2019-2026, kept in this folder), from
`https://disclosures-clerk.house.gov/public_disc/gift-pdfs/<year>Travel.zip`.
Each record cites the filing PDF at
`https://disclosures-clerk.house.gov/gtimages/MT/<year>/<DocID>.pdf`.

Imported with `npm run travel:import -- --evidence-dir <this folder>
--destination israel --legislators-sha 750c0608efb6ef1fc3257ba72c99af3771d35088`
(needs migrations 288 and 289). LOCAL database only.

## Result: 274 trips in the index, 177 records written

| outcome | trips |
| --- | --- |
| written | 177 |
| no_candidate (the member is not a candidate in the app, mostly former members) | 79 |
| source_unreachable (no member-travel PDF loads: a staff filing, or a PDF the Clerk site has lost) | 7 |
| unknown_sponsor (left out on purpose, see below) | 6 |
| out_of_scope (not on a November 2026 or later election) | 4 |
| unresolved_member (index row has no state) | 1 |

Records by sponsor: American Israel Education Foundation 116, J Street
Education Fund 36, U.S. Israel Education Association 16, 12Tribe Films
Foundation 6, Israel Allies Foundation 1, Jewish Community Relations Council of
New York 1, UJA-Federation of New York 1. Every record is tagged
`us_israel_ties: for`. `import-report.json` is the latest run.

## Record wording

"Took an all-expenses-paid trip to Israel in <month year>, paid for by
<sponsor>", followed by one plain description of who the sponsor is and what it
works for. The cost is not shown. Every sponsor gets the same format and the
same level of detail. The sponsor facts and their sources sit next to each
sentence in `SPONSORED_TRAVEL_DESTINATIONS` (`houseGiftTravel.ts`); the record
itself cites the filing.

Only sponsors with a sourced description are imported. Two are left out on
purpose: the Atlantic Council / Talpins Foundation delegation of June 2025 (the
sponsor's own press release says the group visited Saudi Arabia, Bahrain and
the UAE and only spoke with Israeli officials) and the Torah Umesorah trip of
May 2022 (the traveler's filing says he did not accept flights from the
sponsor, so "all-expenses-paid" would be false). The U.S. Israel Education
Association sentence says the group "says its trips helped triple U.S. funding
for Israel's Iron Dome": that is the group's own account, so the record says
"says". Its tax filings report no lobbying spending and it has no parent
lobbying group, so the record does not call it a lobbying group.

## How the importer decides

- Member or staff: the filer must share the member's last name (members file
  under nicknames, so first names are not compared). The real test is the
  Clerk's path: member filings load under `/gtimages/MT/`, staff filings under
  `/gtimages/ST/`, and the importer requires the MT PDF to load before it
  writes.
- Who the member is: the House seat held on the departure date, confirmed by
  last name, then the FEC-id crosswalk the roll-call importer uses. Trips are
  grouped by the matched legislator, so two same-surname members of one state
  stay apart and one member printed two ways stays together (the index prints
  27 such groups in these files).
- Source: the earliest filing for the trip, so a later amendment does not
  change the record's identity; if that PDF is gone, the next filing.
- Re-runs: an existing record is `unchanged`. A retired record blocks the trip
  until it is restored on purpose. A reworded sponsor sentence is applied only
  with `--rewrite-changed`, which rewrites the importer's own record in place
  and logs the identity transition. Tagging is additive: a re-run never removes
  a tag it does not own.
- Index dates must be real calendar dates.

## Not covered

Senate trips (Senate Office of Public Records, a separate source), staff trips
(dropped on purpose), and members who are not yet candidates in the local
database; re-running the command adds their trips once they are.

Migration 289 adds the record origin `travel_import` with the same shape as
migrations 197 and 252 (no `NOT VALID`): the new list is a superset of the old
one, so validation cannot fail.

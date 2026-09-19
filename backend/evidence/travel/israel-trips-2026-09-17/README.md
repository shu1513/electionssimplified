# Privately paid trips to Israel by House members (2026-09-18)

Source: House Clerk yearly gift-travel indexes (`<year>Travel.xml`, 2019-2026,
kept in this folder), from
`https://disclosures-clerk.house.gov/public_disc/gift-pdfs/<year>Travel.zip`.
Each record cites the filing PDF at
`https://disclosures-clerk.house.gov/gtimages/MT/<year>/<DocID>.pdf`.

Imported with `npm run travel:import -- --evidence-dir <this folder>
--destination israel --legislators-sha 750c0608efb6ef1fc3257ba72c99af3771d35088`
(new importer, needs migrations 288 and 289). LOCAL database only.

## Result: 263 trips in the index, 127 records written

| outcome | trips |
| --- | --- |
| insert | 127 (99 American Israel Education Foundation, 28 J Street Education Fund; 108 candidates) |
| no_candidate | 92 (the member is not a candidate in the app, mostly former members) |
| unknown_sponsor | 35 (sponsor has no sourced one-line description yet, see below) |
| out_of_scope | 4 (candidate is not on a November 2026 or later election) |
| source_unreachable | 4 (the Clerk site no longer serves any PDF for the trip) |
| unresolved_member | 1 (index row has no state) |

Every record is tagged `us_israel_ties: for`. `import-report.json` is from the
re-run, which shows all 127 as `unchanged`; `import-dry-run-report.json` is the
plan the first real run followed.

Sponsors left out until someone adds a sourced clause to
`SPONSORED_TRAVEL_DESTINATIONS`: U.S. Israel Education Association (19 trips),
12Tribe Films Foundation (7), Atlantic Council with the Talpins Foundation (3),
Israel Allies Foundation group (2), and four single-trip sponsors.

Record wording (agreed with the user, no cost shown):
"Took an all-expenses-paid trip to Israel in <month year>, paid for by the
American Israel Education Foundation, an organization tied to AIPAC, a group
that lobbies Congress for U.S. military aid and support for Israel."

Not covered: Senate trips (Senate Office of Public Records, a separate source)
and staff trips (dropped on purpose).

## Second pass, 2026-09-18: six more sponsors (18 more records, 145 total)

The user approved sponsor sentences that name who runs each group and what it
campaigns for. Sources for every sponsor fact are in the `sources` field of
`SPONSORED_TRAVEL_DESTINATIONS`. Added: U.S. Israel Education Association
(13 records), 12Tribe Films Foundation (2), Israel Allies Foundation (1),
Jewish Community Relations Council of New York (1), UJA-Federation of New York
(1). Jewish Policy Center matched no candidate (Stefanik).

Of the 31 approved trips, 18 were written, 12 found no candidate and 1 has no
reachable PDF (Vargas, February 2023). The 12 are members the local database
does not hold at all yet, among them Mike Johnson (two trips), Jim Jordan,
Andrew Clyde, Clay Higgins and Andy Ogles. Re-run the importer after their
House rosters and FEC ids exist and it will add them.

Left out on purpose: the three Atlantic Council / Talpins Foundation trips of
June 2025 (the sponsor's press release says the group visited Saudi Arabia,
Bahrain and the UAE and only spoke with Israeli officials) and Kelly
Armstrong's Torah Umesorah trip of May 2022 (his filing says he did not accept
flights from the sponsor, so "all-expenses-paid" would be false).

## Third pass, 2026-09-19: re-run after seven House rosters were filled (15 more, 160 total)

The local database had no candidates for several sitting members' November
2026 races. After those rosters and profiles were written, the same command
added 15 trips: Mike Johnson (3), Jim Jordan (2), Scott Franklin (2), Andrew
Clyde, Clay Higgins, Rick W. Allen, Jason Crow, Brittany Pettersen, Michelle
Fischbach, Jeff Hurd and Tony Wied. `import-report.json` is this run;
`import-report-2026-09-18.json` is the second-pass run.

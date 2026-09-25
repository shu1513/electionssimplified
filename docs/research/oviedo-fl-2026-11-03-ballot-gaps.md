# Oviedo, FL — November 3, 2026 ballot gaps

Run date: 2026-09-24. Local database only. All writes went through the `manual:*` wrappers. No AI provider calls.

## What was written

| Unit | District | Rows |
| --- | --- | --- |
| County Commissioner District 4 roster | Seminole County, Florida | 2 candidates linked (Amy Lockhart, R, incumbent; Charline Santos, D). `seats_to_fill` set to 1. |
| Fifth District Court of Appeal merit retention | Seminole County, Florida | 3 election rows, 3 candidates linked (John M. Harris, Scott Makar, F. Rand Wallis) |
| City charter amendments | Oviedo city, Florida | 5 ballot-measure election rows, 5 measure detail rows, 0 tags |

## Sources

- Commissioner roster: Seminole County Supervisor of Elections current-candidates list, https://voteseminole.gov/candidates/current-candidates/
- Retention judges: The Florida Bar merit retention page, https://www.floridabar.org/public/faircts/votes010/merit-retention-biographies/ , and each judge's Fifth DCA biography page.
- Charter amendments: each ordinance's Exhibit A ("Ballot Proposal") on the city's PrimeGov portal. Ordinances 1768–1771 were adopted June 15, 2026. Ordinance 1774 (annexation) was adopted July 20, 2026. The June 15 minutes show no changes to the ballot wording at adoption. Each staff report says there is no budget impact.

## Ballot titles

All five titles are the official ballot titles from the ordinances, in title case. None are provisional.

| Ordinance | Title |
| --- | --- |
| 1768 | City Charter Amendment Changing Length of Council Terms from Two Years to Four Years |
| 1769 | City Charter Amendment Revising Council Voting Procedures for Ordinances and Resolutions |
| 1770 | City Charter Amendment Revising Timeframe for Holding Special Elections |
| 1771 | City Charter Amendment Moving City Council Qualifying Period |
| 1774 | City Charter Amendment Requiring Supermajority City Council Vote to Approve Certain Annexations |

Ordinance 1770 changes two windows from 60–90 days to 90–120 days: special elections the council calls, and special elections to fill a council vacancy.

## Model choice for the appeals-court retention rows

The first plan was one row per judge under each of the 14 counties in the Fifth District (Fourth, Fifth, Seventh and Eighteenth circuits). It was not used, for two reasons:

- The candidate page lists every election link (`frontend/src/pages/CandidatePage.tsx`, `lookupCandidateElections` in `backend/src/pipeline/candidates/candidateDetailReader.ts`). Each judge would show the same contest 14 times.
- The candidate page makes one finance request per upcoming election link, so each judge page would make 14.

The rows sit under Seminole County only. Voters in the other 13 counties do not see these questions yet. A proper fix needs either an appellate-district type or grouping of same-title links on the candidate page.

Other notes:

- The titles follow the existing Supreme Court row: `Judge, Fifth District Court of Appeal (Merit Retention) - <Name>`. The app's retention title check recognizes them.
- The county office matcher maps them to the generic `County Level Judge` office. There is no appellate office in the catalog.
- The county validator soft-failed the titles because they lack a county word. They went in with `--review-approve`.

## Not written, on purpose

These were not written: Oviedo Council Groups 2, 3 and 4 (unopposed), County Commissioner District 2 (unopposed), 18th Circuit judge groups and school board (decided August 18), Soil and Water Conservation District and Dovera CDD seats (no qualified candidates on the Supervisor of Elections list).

# House votes of September 14-16, 2026 (rolls 296-314)

Sweep of the House roll calls taken after the last import (roll 295) through
the Ratepayer Protection Act vote, run 2026-09-23 on the LOCAL database.
Production holds none of this.

## Rolls imported (14)

| measure | roll | tally | label |
| --- | --- | --- | --- |
| H.R. 4219, wildlife refuge invasive species strike teams | 296 | 371-33 | environment_and_public_health: yea for |
| H.R. 3276, Urban Bird Treaty Program | 297 | 345-60 | environment_and_public_health: yea for |
| H.Res. 1486, impeachment of President Trump (motion to table) | 298 | 232-147 | general |
| H.R. 2978, GUARD Act (elder fraud, pig butchering) | 301 | 414-7 | public_safety_and_crime_control: yea for |
| H.R. 2140, Diesel Emissions Reduction Act | 304 | 343-79 | environment_and_public_health: yea for |
| H.R. 9500, Tax Relief for Fraud Victims Act | 305 | 408-17 | personal_income_tax_reduction: yea for |
| H.J.Res. 210, revoke EPA approval of California at-berth ship rule | 306 | 216-211 | environment_and_public_health: yea against, nay for |
| H.Con.Res. 93, Iran war powers | 307 | 220-204 | peaceful_foreign_policy: yea for, nay against |
| H.R. 5334, Sanctioning Russia and Iran Act (concur in Senate amendment) | 308 | 262-159 | general |
| H.R. 9576, National Fraud Enforcement Division Act | 309 | 352-72 | anti_corruption: yea for |
| H.R. 10326, PROOF Act | 310 | 217-207 | anti_corruption: yea for |
| H.J.Res. 213, revoke EPA approval of California harbor craft rule | 311 | 214-208 | environment_and_public_health: yea against, nay for |
| H.R. 9340, Ratepayer Protection Act | 312 | 417-3 | cost_of_living_reduction: yea for; corporate_accountability: yea for |
| H.R. 9497, Water Resources Development Act of 2026 | 313 | 415-9 | public_infrastructure: yea for |

Rolls 298 and 307 are excluded by the question classifier (a motion to table,
a concurrent resolution) and enter through `FEDERAL_HAND_ADDED_ROLLS` in
`rollCallQuestionClass.ts`.

## Left out

- H.R. 8278 (417-7, agency technology reports), H.R. 4646 (424-0, HUD
  whistleblower dates), S. 2403 (401-14, ESOP appraisals): narrow, no voter
  decision value.
- Rolls 299, 300 (rule votes), Senate rolls 232-241 (cloture, nominations,
  motions to proceed): procedural, excluded by the classifier.

## Rules used

- Sentences come from the CRS summaries on api.congress.gov (saved in the
  session scratchpad, not here) plus the vote XML.
- A bill that passed the House only is written with "would"; H.R. 5334
  became law on September 18, 2026 and uses past tense.
- No vote gets a stance only where the objection is clearly about the
  labelled area (the two California waiver repeals, the Iran war powers
  resolution). H.R. 5334 stays `general`: many no votes objected to the
  tariff authority it gives the President, not to the sanctions.
- Every sentence passes the roll-call length gate enforced by `rollcall:judge`.

## Commands

`rollcall:fetch --chamber house --congress 119 --session 2 --rolls 296-340`,
the same for the Senate (232-320), `rollcall:judge`, `rollcall:resolve`,
`rollcall:import --dry-run`, `rollcall:import`, all with `--evidence-dir
evidence/rollcall/house-119-2-recent-2026-09-23`. Resolve and import were run
with `--legislators-sha 8a3c7e6987f890b32e56058f7ddbdf380860b4a3` (the
earlier pin, 750c0608, lacked Wahab CA-15 and Blair GA; Blair has no
candidate row yet).

Result: 4,984 records (4,902 inserts, 82 rewrites of hand-written records on
the same votes) across 365 candidates, 97 out-of-scope members skipped.

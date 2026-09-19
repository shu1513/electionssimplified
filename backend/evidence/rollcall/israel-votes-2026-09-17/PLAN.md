# Israel-related federal votes (2026-09-17)

Requested by the user: import the federal floor votes on Israel aid, arms
sales, boycotts and antisemitism definitions that the app did not have yet.

## Imported first (6 rolls, 998 inserts + 15 rewrites, LOCAL only)

| measure | roll | tally |
| --- | --- | --- |
| H.R. 5323, $1 billion for Iron Dome | House 117-1 roll 275 | 420-9 |
| H.R. 6126, $14.3 billion Israel aid offset by IRS cut | House 118-1 roll 577 | 226-196 |
| H.R. 8034, $26 billion Israel security supplemental | House 118-2 roll 152 | 366-58 |
| H.R. 6090, Antisemitism Awareness Act | House 118-2 roll 172 | 320-91 |
| H.R. 8369, Israel Security Assistance Support Act | House 118-2 roll 217 | 224-187 |
| S. 1, Middle East security bill with anti-boycott title | Senate 116-1 roll 16 | 77-23 |

Every label is `general` (no stance). These votes are contested, so no
for/against tag was forced. Sentences were written from the bill text on
govinfo.gov (engrossed text; H.R. 8034 from the introduced text, which the
House passed unamended). Three lopsided votes (420-9, 366-58) are hand adds at
the user's request and fall outside the usual divided-vote convention.

## Hand adds: `held-procedural-judgments.json` (5 rolls, 209 inserts, LOCAL only)

`rollcall:judge` first refused these because `is_floor_vote = false`. At the
user's request they were added to `FEDERAL_HAND_ADDED_ROLLS` in
`rollCallQuestionClass.ts` (the plan's "explicit hand add"), re-fetched, judged
and imported on 2026-09-18 (stamp `2026-09-18T10:42:47.066Z`,
`import-rerun-report.json`; the first six rolls came back `unchanged`).

| measure | roll | tally | inserts |
| --- | --- | --- | --- |
| H.Res. 894, anti-Zionism is antisemitism | House 118-1 roll 697 | 311-14, 92 present | 151 |
| H.R. 815, $95 billion foreign aid package (motion to concur) | Senate 118-2 roll 154 | 79-18 | 14 |
| S.J.Res. 113, block mortar shell sale (motion to discharge) | Senate 118-2 roll 293 | 19-78 | 14 |
| S.J.Res. 26, block bomb and guidance kit sale (motion to discharge) | Senate 119-1 roll 166 | 15-83 | 15 |
| S.J.Res. 41, block rifle sale (motion to discharge) | Senate 119-1 roll 454 | 27-70 | 15 |

Members who voted "present" on H.Res. 894 get no record (63 of the matched
members): the importer writes yea and nay sides only. One arms-sale vote per
date was kept out of seven, so a senator does not carry near-identical records.

## Commands

`rollcall:fetch`, `rollcall:judge`, `rollcall:resolve`, `rollcall:import
--dry-run`, `rollcall:import`, all with `--legislators-sha
750c0608efb6ef1fc3257ba72c99af3771d35088` and the local `DATABASE_URL` inline.
Import stamp `2026-09-18T06:20:01.960Z`.

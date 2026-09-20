# Federal votes on Israel aid, arms sales and related bills

Eleven federal roll calls the app did not hold yet, imported into the LOCAL
database through the federal roll-call pipeline. A twelfth roll (H.R. 4795) was
already in the app and only gained a label. Production holds none of this.

## The rolls

| measure | roll | tally | label |
| --- | --- | --- | --- |
| S. 1 (2019), Israel aid authorization with an anti-boycott title | Senate 116-1 roll 16 | 77-23 | us_israel_ties: yea for |
| H.R. 5323, $1 billion for Iron Dome | House 117-1 roll 275 | 420-9 | us_israel_ties: yea for, nay against |
| H.R. 6126, $14.3 billion Israel aid offset by an IRS rescission | House 118-1 roll 577 | 226-196 | us_israel_ties: yea for |
| H.Res. 894, antisemitism and anti-Zionism resolution | House 118-1 roll 697 | 311-14, 92 present | general |
| H.R. 8034, $26 billion Israel security supplemental | House 118-2 roll 152 | 366-58 | us_israel_ties: yea for, nay against |
| H.R. 815, $95 billion foreign aid package (motion to concur) | Senate 118-2 roll 154 | 79-18 | us_israel_ties: yea for |
| H.R. 6090, Antisemitism Awareness Act | House 118-2 roll 172 | 320-91 | general |
| H.R. 8369, Israel Security Assistance Support Act | House 118-2 roll 217 | 224-187 | us_israel_ties: yea for, nay against |
| S.J.Res. 113, block a mortar shell sale (motion to discharge) | Senate 118-2 roll 293 | 19-78 | us_israel_ties: yea against, nay for |
| S.J.Res. 26, block a bomb and guidance kit sale (motion to discharge) | Senate 119-1 roll 166 | 15-83 | us_israel_ties: yea against, nay for |
| S.J.Res. 41, block a rifle sale (motion to discharge) | Senate 119-1 roll 454 | 27-70 | us_israel_ties: yea against, nay for |

`judgments.json` holds the six passage votes. `held-procedural-judgments.json`
holds the five rolls the question classifier excludes by default (a simple
resolution, a motion to concur, three motions to discharge). They are listed in
`FEDERAL_HAND_ADDED_ROLLS` in `rollCallQuestionClass.ts`, the plan's "explicit
hand add", each with a reason. Three lopsided votes (420-9, 366-58, 311-14) sit
outside the usual divided-vote convention and are included because they are
the main floor votes on the topic.

## Rules used for this set

- Sentences were written from the bill text on govinfo.gov (H.R. 8034 from the
  introduced text, which the House passed unamended).
- A no vote gets no stance where many objections were about another part of
  the bill: the IRS rescission in H.R. 6126, the Ukraine money in H.R. 815, the
  anti-boycott title in S. 1, and free-speech objections to H.R. 4795.
- The two antisemitism-definition votes (H.R. 6090, H.Res. 894) are about
  speech and discrimination rules in the U.S., not about aid or the
  relationship between the two countries, so they stay `general`.
- A record shows the candidate's vote and that chamber's tally. What the other
  chamber did is left out. A measure that passed one chamber only is written
  with "would have" (H.R. 6126, H.R. 8369, H.R. 6090, S. 1; H.R. 4795 says
  "would cut off"), so it does not read as if it took effect. Enacted measures
  use plain past tense.
- Aid sentences say the money is U.S. taxpayer money, on every aid vote in the
  set, so the phrase is a fact about who pays and not a comment on one bill.
- The $9.15 billion of humanitarian money in H.R. 8034 names no country in the
  bill text ("vulnerable populations and communities"). H.R. 815 describes it
  as humanitarian aid in Gaza and elsewhere.
- The three arms-sale sentences say what the senator voted to do ("Voted to
  stop the U.S. from selling ...", "Voted to allow the U.S. sale of ...")
  instead of naming the procedure. They end "so the sale was allowed": each
  sale was approved and moved forward, but no source confirmed delivery.
- One arms-sale vote per date was kept out of seven, so a senator does not
  carry near-identical records.
- Members who voted "present" on H.Res. 894 get no record: the importer writes
  yea and nay sides only.
- Every sentence passes the roll-call length gate (3 sentences, 320
  characters, 25 words per sentence), which `rollcall:judge` enforces.

## Commands

`rollcall:fetch`, `rollcall:judge`, `rollcall:resolve`, `rollcall:import
--dry-run`, `rollcall:import`, all with `--legislators-sha
750c0608efb6ef1fc3257ba72c99af3771d35088` and the local `DATABASE_URL` inline.

Labels and final sentences live in
`../us-israel-ties-retag-2026-09-18/judgments.json` (ten rolls). The two
judgment files in this folder carry the same sentences and labels, so judging
from either folder gives the same result. Changed sentences are applied with
`rollcall:judge` and then `rollcall:import`, which rewrites the records in
place.

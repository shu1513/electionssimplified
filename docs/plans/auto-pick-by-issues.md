# Plan: auto-pick by issue alignment ("Pick for me")

Status: PR 1 (Preferences) merged 2026-08-19 (#764). PR 2 (engine +
`POST /api/me/auto-picks` + election-page button/panel) merged 2026-08-20
(#771). PR 3 (My Picks fill/clear + auto chip) implemented 2026-08-20 on
branch `claude/auto-pick-fill-empty`; PR 4 (data coverage — relabelling
records and roster research, not code) not started.
Numbers below come from the local DB on 2026-08-18 (Nov-2026 elections);
prod will differ in size, not in shape.

## Goal

A signed-in user who has ranked their issues can press one button and get the
candidate (or the Yes/No answer on a measure) whose records best match those
issues and their priorities — without reading 40 races themselves.

Two entry points, one engine:

- **Election page** — "Pick by my issues" (labeled "Pick for me" until the
  2026-08-20 rework) on an office race picks the best-aligned
  candidate(s) for that race; on a measure race it answers Yes/No. Result lands
  in the user's picks exactly like a manual pick, and a "Why this pick" panel
  shows the evidence.
- **My Picks page** (`/me/picks`, the signed-in "My Draft") — each election
  date's card (and ballot-view sheet) carries its own "Auto-pick my empty
  picks by my issues" button that runs the engine over THAT date's undecided
  races only; once engine rows exist for that date the fill button gives way
  to a date-scoped "Clear auto picks" (never both at once — a rerun over the
  races the engine already left open repeats the same "not enough evidence",
  so Clear → fill again is the useful path, and it also recomputes the
  earlier auto picks after the user re-ranks issues; 2026-09-06).
  Filling never changes an existing pick (manual or auto); "Clear auto
  picks" removes only that date's auto-origin rows. No separate result list: each still-open
  race row gets the one-line reason ("auto pick: not enough evidence")
  inline. (Reworked from a single page-level fill button, 2026-08-20.)

The engine must be honest: a race with no usable evidence gets **no pick** and
a reason, never a guess. "No pick" is the normal outcome for many local races
today (see data below), and telling the user that is part of the feature.

## User controls (all on the existing issue editor)

The issue editor is `frontend/src/components/ResearchAreasSection.tsx` (web
Settings), `WelcomePage.tsx` (onboarding), and
`mobile/src/app/settings/research-areas.tsx`. Before PR 1 it let a user pick
up to 7 issues and drag-rank them. Changes (shipped in PR 1):

1. **No cap.** Any number of the 25 selectable issues, all ranked. Rank 1 is
   the most important. (Data check: more ranked issues → more races decidable,
   roughly linearly — see below — so the cap works against this feature.)
2. **Direction per issue** — *support* / *oppose* the issue's goal. Default
   *support*. Needed because the catalog rows are goals ("Regulate firearm
   access", "Lower personal income tax") and "I care about gun policy" does
   not say which way. Hidden for `integrity_and_ethics` (always support: an
   ethics record is always a strike).
3. **Line in the sand** per issue (`hard_veto`) — "must not oppose". A
   candidate with any record against my direction on that issue is excluded
   outright; a measure that crosses it is answered **No**. For
   `integrity_and_ethics` the same toggle reads "Skip candidate if negative
   record" — that is the "no discipline records" control, with no extra
   schema.
4. **Minimum to run auto-pick: 3 ranked issues.** Below that, ranking has no
   meaning and the button explains what to do. The number is a UX floor, not
   a data threshold — the DB says the candidate side, not the user side, is
   what limits coverage.

Guests cannot use auto-pick: issue preferences are account-only and the guest
draft lives in localStorage. The button renders a sign-in prompt for guests.

## Verified facts (code and data)

The first two bullets describe the pre-PR-1 baseline the design started from;
PR 1 replaced the cap and the formula as specified in "Data model changes" and
"Scoring spec" below.

- Preferences (before PR 1): `public.user_research_area_preferences (user_id,
  research_area_id, rank)` with `CHECK (rank IS NULL OR rank BETWEEN 1 AND
  7)` and a unique `(user_id, rank)` index (migration 125). Server cap in
  `backend/src/constants/userResearchAreaPreferences.ts`
  (`MAX_USER_RESEARCH_AREA_PREFERENCES = 7`), enforced in
  `backend/src/pipeline/users/userResearchAreaPreferences.ts` (count and rank
  range). Client mirror `MAX_RESEARCH_AREA_RANK = 7` in
  `packages/api-client/src/researchAreaScoring.ts`, used by web and mobile
  editors for the "at capacity" state. Local DB: 0 rows with a null rank; the
  editors always send ranks 1..n.
- Weight formula before PR 1: `weight = 8 − rank`, shared by ballot sort
  (`ballotElectionOrdering.ts`), the chatbot ranker (`askService.ts`), and the
  client sorts (`researchAreaScoring.ts`, `railSort.ts`). It breaks (goes
  negative) for rank > 7, so uncapping forces a formula change anyway.
- Record stances: `candidate_record_area_tags.stance ∈ {'for','against',NULL}`.
  Stance is required on every area except `general` and
  `integrity_and_ethics`, where it is forbidden
  (`candidateRecordResearchAreaPolicy.ts`). So an `integrity_and_ethics` tag
  marks "there is a NEGATIVE ethics/discipline record" — an adverse action
  against the candidate by an official body — never a position. Tightened
  2026-09-06: cleared complaints, unofficial allegations, and the candidate's
  own reform work are excluded from the tag (see
  `candidateRecordAreaLabelPrompt.ts` and the manual-research
  `records-import.md` rule) and a retag pass removed the ones that had
  slipped in.
- Measures: `ballot_measure_research_area_tags.stance ∈ {'for','against'}`
  (NOT NULL). 117 of 143 Nov-2026 measures are tagged.
- Picks: `public.user_election_choices` (migration 203) — one row per
  candidate pick, or one `measure_position` row; write path
  `setUserElectionChoice` (`userElectionChoices.ts`) already enforces upcoming
  election, live candidacy (`status NOT IN ('withdrawn','lost')`), live
  candidate, and the `seats_to_fill` cap. Auto-pick must go through the same
  gate.
- 25 research areas are `is_user_selectable`; `general` and `impartiality`
  are not.

## Data reality (why the engine must be allowed to say "no pick")

Nov-2026, declared candidacies, local DB:

| Measure | Value |
|---|---|
| Elections / candidates | 5,734 / 10,188 |
| Contested races (≥2 candidates) | 3,424 |
| Candidates with zero stanced issue records | 8,185 (80%) |
| Live records tagged only `general` (no issue signal) | 5,787 of 14,283 |
| Contested races where ≥1 candidate has stanced issue records | **~1,700 (50%)** — with all 25 issues ranked; ~257 have ≥2 evidenced candidates, ~1,443 exactly one |
| Same (≥2 evidenced), user ranks 7 random issues / 3 issues | ~82 / ~34 — the ≥1 count scales the same way |
| Best scopes (≥2 evidenced / total) | statewide 49/162, us_house 11/43, place 25/238, county 50/1,857, state_lower 77/2,223 |
| Measures tagged with stances | 117 / 143 (82%) |
| Candidates with an `integrity_and_ethics` record | 239 |

Consequences baked into the design:

- Measures and top-of-ballot races are where the button works today; most
  local races will return "not enough evidence". Coverage work (relabelling
  `general`-only records, researching never-researched rosters) raises the hit
  rate later without touching the engine.
- A race where only one candidate has records **is** decided when that
  candidate is positively aligned: missing records are our coverage gap, not
  the documented candidate's fault, and the user's goal is the best pick given
  what is known. The bias risk (incumbents are researched more) is handled by
  transparency, not silence: the "Why" panel names every unresearched
  candidate and says whether they were never researched
  (`candidates.last_records_searched_at IS NULL`) or researched with no stance
  found on the user's issues.
- `integrity_and_ethics` records range from a bar admonishment to a felony
  conviction (a closed complaint with no violation no longer qualifies —
  2026-09-06 rule), so exclusion on that tag is opt-in and every exclusion
  shows the record it was based on.

## Scoring spec

All inputs are the user's ranked issues (with direction and veto), the race's
live candidacies, and each candidate's live (`retired_at IS NULL`) records
with their area tags. Records tagged `general` are ignored.

**Weights.** `w(rank) = 0.75^(rank − 1)` (rank 1 → 1.00, 3 → 0.56, 5 → 0.32,
7 → 0.18, 10 → 0.075, 15 → 0.018, 20 → 0.004). One shared function, used by
auto-pick and by every existing sort (replaces `8 − rank`; the sorts only need
"higher rank ⇒ larger weight, any match beats no match", which still holds
because every weight is > 0). Null rank (legacy rows only) counts as one rank
below the user's highest explicit rank.

**Direction.** `dir_i = +1` for support, `−1` for oppose. Effective stance of a
record on issue *i*: `+1` if its stance agrees with `dir_i`, `−1` if it
disagrees. `integrity_and_ethics` tags always count `−1`.

**Veto (candidates).** If issue *i* has `hard_veto` and the candidate has ≥1
record with effective stance `−1` on *i*, the candidate is excluded. Excluded
candidates are reported with the offending record(s); they never win.

**Alignment per issue.** `net_i = clamp(Σ effective stances of the candidate's
records on i, −3, +3) / 3`. The ±3 cap means three consistent records already
express full conviction; a 40-record incumbent gets no volume bonus over a
3-record challenger.

**Candidate score.** `score = Σ_i w(rank_i) · net_i` over the user's ranked
issues. A candidate "has evidence" if at least one of their records carries a
stanced tag on one of the user's ranked issues (or an `integrity_and_ethics`
tag when that issue is ranked).

**Decision (office race, `seats = COALESCE(seats_to_fill, 1)`).**

1. Remove vetoed candidates and candidates with `score < 0` — both are known
   to work against the user's issues.
2. If no candidate has evidence at all: no pick, reason
   `insufficient_evidence`.
3. Sort candidates with `score > 0` desc. Fill the open seats (seats minus
   existing picks) in order, taking a candidate only if
   `score > score of the next positive candidate` (a tie for the last seat
   stops the fill). Reason `tie` if a tie blocked a seat.
4. **Elimination pick.** If seats are still open, the remaining eligible
   candidates (no evidence, or `score = 0`) fill them **only if their count
   equals the open seats** — e.g. a 2-candidate race where A opposes the
   user's issue and B has only `general` records picks B. Reason label
   `by_elimination` on the result. If there are more such candidates than
   seats, they cannot be ranked → no pick, reason `only_negative_evidence`
   (nothing positive found, several unknowns) — those unknowns are returned as
   the shortlist. Tied leaders are likewise returned as the shortlist.
5. Unresearched candidates are always reported (`unresearched: [...]`, each
   flagged never-researched vs researched-no-stance) so the user knows the
   comparison was partial.

**Decision (measure).** `score = Σ_i w(rank_i) · dir_i · stance_i` over the
measure's tags on ranked issues (`stance_i` = +1 for, −1 against). If any
vetoed issue has effective stance −1 → **No** (reason `veto`). Else Yes if
`score > 0`, No if `score < 0`, no answer if `score = 0` or the measure has no
tags on ranked issues (`insufficient_evidence`).

No thresholds beyond "strictly greater": every unit of score is a real record
on the user's own issue, and the discrete cap makes ties genuine ties.

## Data model changes (one migration, `244_…`)

Migration 243 is taken by the open Austin PR (#756); do not renumber.

```sql
ALTER TABLE public.user_research_area_preferences
  DROP CONSTRAINT chk_user_research_area_preferences_rank,
  ADD CONSTRAINT chk_user_research_area_preferences_rank
    CHECK (rank IS NULL OR rank >= 1),
  ADD COLUMN direction text NOT NULL DEFAULT 'support'
    CHECK (direction IN ('support', 'oppose')),
  ADD COLUMN hard_veto boolean NOT NULL DEFAULT false;

ALTER TABLE public.user_election_choices
  ADD COLUMN origin text NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual', 'auto'));
```

`origin` lets the UI badge auto picks and offer "clear my auto picks", and
keeps "fill empties" honest across reruns. A manual pick on an election
overwrites `origin` to `manual`.

Nothing else: no new tables, no stored explanations (they are recomputed from
records on request), no per-issue toggles beyond the two columns.

## Backend

**Preferences** (`userResearchAreaPreferences.ts`, PUT/GET
`/api/me/research-area-preferences`):

- Drop the count cap and the `rank ≤ 7` check; keep uniqueness. Rank is a
  position in the submitted list, so the server bound is `1..n` (n = items
  sent) — no magic ceiling, ranks stay inside Postgres `integer`, weights stay
  positive.
  Delete `MAX_USER_RESEARCH_AREA_PREFERENCES` and its client mirror.
- Input rows gain optional `direction` and `hard_veto`. **When omitted, keep
  the row's existing values** (the mobile app will keep sending `{id, rank}`
  until it gets the toggles; a full-list PUT must not silently reset a veto
  set on web). New rows default support / false.
- GET returns `direction` and `hard_veto` on every row.

**Weights** (`userResearchAreaScoring.ts` + client mirror): replace
`8 − rank` with `0.75^(rank − 1)`; update the three existing callers' tests.

**Engine** — new `backend/src/pipeline/users/autoPick.ts`:

- `computeAutoPick(db, userId, electionId) → AutoPickResult` (pure read: loads
  prefs, election, candidacies, records+tags or measure tags; applies the spec
  above).
- `applyAutoPicks(db, userId, {electionIds, mode})` — for each election:
  compute; in `fill_empty` mode skip elections that already have any pick; in
  `replace` mode delete the election's existing picks first; write winners
  through `setUserElectionChoice`-equivalent SQL with the same gates, tagging
  `origin = 'auto'`. Runs in one transaction per election so a partial batch
  never leaves a half-filled multi-seat race.

**Endpoint** — `POST /api/me/auto-picks` (session required, same auth posture
as election choices — no verification gate):

```jsonc
// request
{ "election_ids": ["…"], "mode": "fill_empty" | "replace", "dry_run": false }
// ≤ 200 ids; dry_run computes without writing (used by "Why this pick")
// response
{ "results": [{
    "election_id": "…",
    "race_type": "office" | "ballot_measure",
    "outcome": "picked" | "skipped_existing" | "no_pick",
    "reason": null | "by_elimination" | "insufficient_evidence" | "only_negative_evidence" | "tie" | "all_vetoed" | "veto" | "too_few_issues" | "election_closed",
    "picked_candidate_ids": ["…"], "measure_position": "yes" | "no" | null,
    // on no_pick with reason "tie" or "only_negative_evidence": the candidates
    // still in contention (tied leaders, or the eligible unknowns) — the
    // narrowed field the user should decide among; empty otherwise
    "shortlist_candidate_ids": ["…"],
    "candidates": [{ "candidate_id", "display_name", "score", "has_evidence",
                     "vetoed_by": [{ "research_area_id", "record_id" }],
                     "per_issue": [{ "research_area_id", "net", "for_count", "against_count" }] }],
    "unresearched": [{ "candidate_id", "display_name", "never_researched": true }]
}]}
```

Errors: 400 for bad ids/mode, `too_few_issues` is per-result (not an HTTP
error) so a batch still reports cleanly. No rate limiter: `/api/me/election-
choices` writes have none today, and the 200-id cap bounds the work per call.

## Frontend (web first; mobile follows)

- **Issue editor**: remove the cap; per-row direction segmented control
  (Support / Oppose; hidden for `integrity_and_ethics`) and a "Line in the
  sand" toggle with one-line help ("Never pick a candidate who opposes this";
  for ethics: "Skip candidates with any integrity/ethics record"). Copy on
  WelcomePage/Settings changes from "up to 7" to "rank as many as you like —
  three or more lets us pick for you".
- **Election page**: one "Pick by my issues" button next to the existing pick
  control (office and measure views), visible to signed-in users on upcoming
  races. Click → `POST /api/me/auto-picks {mode: "replace"}` for that election
  → invalidate the election-choices query → open the "Why this pick" panel:
  winner, per-issue alignment chips (aligned / conflicts), vetoed candidates
  with the record, unresearched candidates, and the "no pick" reason when
  nothing qualified. A "no pick" that still narrowed the field (tie, or one
  known-bad candidate vs several unknowns) shows the shortlist prominently:
  "Couldn't pick one — narrowed to B, C, D. A excluded: opposes [issue].
  B, C, D have no records on your issues." Fewer than 3 ranked issues → the
  button opens the issue editor prompt instead.
- **My Picks page**: per-date "Auto-pick my empty picks by my issues"
  buttons (one per date card/sheet); election ids = that date's races minus
  those with a choice (both already loaded by
  `useMyPicksProgress`/PicksPage). Reasons render inline on the race rows,
  not as a list; auto picks get an "auto" chip; "Clear auto picks" removes rows
  with `origin = 'auto'` in one atomic `DELETE /api/me/auto-picks`
  (date-scoped via `?election_date=`) — never a per-row unpick loop, which
  would trip the per-IP rate limit and race stale cache from another tab.
- **Mobile**: uncapped list works once the cap constant is gone; direction /
  veto toggles and the buttons are a follow-up PR (server preserves values on
  omitted fields, so nothing breaks in between).
- **"Add these issues?" prompt** (2026-10-31): a no-pick that more ranked
  issues could decide (`insufficient_evidence`, `only_negative_evidence`,
  `tie`) carries `suggested_issues` — the unranked, user-selectable issues
  the undecided field (the shortlist when there is one, else the live
  roster; the one judge; the measure's tags) has usable records on, scoped
  to the office's allowed areas like the engine's own tag load. The web
  controls open `AddIssuesDialog` ("Filter candidates by choosing your
  stances on these issues") over the result (per race on the election page;
  merged across the open races on a date fill). Under the heading sits the
  Settings intro sentence verbatim and nothing else. The body is the
  Settings ranked editor (`ResearchAreaPicker` with `poolAreas` = the
  offered issues, `poolFirst`, `poolTitle` "Choose and rank issues related
  to this race"): the pool comes first, nothing starts chosen, and a tap
  appends the issue to the user's list below, scrolls its row into view and
  tints it briefly; rows carry drag, Support/Oppose, Must, and remove. The
  editor renders only once the ranked list has actually loaded (a failed
  fetch shows "Try again", never an empty list). Save is one full-list PUT
  and the same pick reruns, so the list grows one race at a time. Below the
  three-issue floor the web controls call the engine anyway: `too_few_issues`
  carries the same suggestions (whole live roster); the dialog shows no
  count, and its button reads "Add N issues and pick again" only once the
  list would reach the floor, else "Add N issues"; the linked "Rank your
  issues" prompt remains only when the race(s) offer
  nothing. Vetoes and closed elections never suggest; a race nobody
  researched has nothing to suggest and opens nothing. Mobile: field is
  optional in the client type; the mobile dialog is a follow-up (parked
  2026-10-31).

## Phases / PRs

1. **Preferences** — migration 244 (rank check, `direction`, `hard_veto`,
   `origin`), server cap removal, preserve-on-omit rule, weight formula swap
   with test updates, editor UI (web). Independent, shippable alone.
2. **Engine + election-page button** — `autoPick.ts` with unit tests over
   fixture races (veto, tie, one-sided evidence, cap, multi-seat, measure
   yes/no/veto/untagged, too few issues), endpoint, "Why this pick" panel.
3. **Fill my empty picks** — My Picks button, summary, auto chip, clear-auto.
   (As shipped; the page-level button and summary were reworked into per-date
   controls with inline per-race reasons in PR #796, 2026-08-20.)
4. **Coverage** (data, not code): relabel `general`-only records to issues;
   never-researched roster wave. Each raises the hit rate without changing the
   engine.

## Tests to write

- Engine unit tests (backend): every reason code reachable; incumbent with 30
  "for" records vs challenger with 3 ties on that issue; one evidenced
  candidate with positive score wins over unresearched opponents; negative vs
  one unknown → unknown picked by elimination; negative vs three unknowns →
  no pick; veto excludes even the
  highest scorer; oppose-direction flips a "for" record to a strike; measure
  with for-A/against-B where B is vetoed → No; unranked-issue records ignored;
  `general` ignored; withdrawn candidacy ignored; already-picked election
  skipped in `fill_empty`, replaced in `replace`.
- Preferences: PUT without `direction`/`hard_veto` keeps stored values; rank
  1..n accepted, 0 and n+1 rejected, duplicate rank rejected.
- Weight fn: monotone, positive, matches between backend and client mirror.
- Frontend: button hidden for guests; <3 issues shows the prompt; panel
  renders reasons.

## Explicitly not doing

- No party or endorsement fallback when records are missing (would make the
  app partisan and hide the coverage gap).
- No fuzzy thresholds, recency decay, or record-type weights — no data model
  for them, and they add tuning surface without changing decisions where the
  evidence is thin anyway.
- No stored explanations, no new tables, no ranking beyond `rank`.
- No auto-pick for guests.
- No severity grading on `integrity_and_ethics`. The veto stays all-or-nothing:
  a tag means a record exists, and the user's toggle decides whether that is
  disqualifying. Grading severity needs a migration, a relabel pass, and an
  engine change, and it asks us to rank other people's ethics findings — a
  judgment the app should leave to the voter.

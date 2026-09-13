# Continuing the rewrite (one jurisdiction per pass)

Done: every jurisdiction, as of 2026-09-13 (see ../README.md table). Use
this recipe again only when a later import approves new rolls that were
written before the gate, or when a roll's description is re-approved in
digest form.

Recipe (all paths from `backend/`; scripts here are python3, no deps):

1. `npm run rollcall:export-rewrites -- --jurisdiction CO --out /tmp/CO_rewrites.json`
   (add `--only-over-limit` when most rolls already fit, as with US).
2. `python3 tools/showstate.py /tmp/CO_rewrites.json 380 > /tmp/CO_view.txt`
   prints one entry per distinct text: export index `[i]`, measure, roll,
   tally, the auto-extracted OPEN (yea / nay opener) and CLOSE (tally
   sentence to the end), and the body. Read it in chunks.
3. Write `tools/CO_effects.py`: `EFFECTS = {"HB 1234": "which <one plain
   effect on people>", ...}` keyed by measure id (both chambers reuse it;
   the closing is per roll). Enacted bills: "which ..."; bills that did not
   pass: "a bill to ..."; never "would/will". Keep the clause under ~22
   words so opener + clause stays under 30. Overrides: `OPEN = {roll: (yea
   opener, nay opener)}` when OPEN printed None or is too long; `IDX =
   {i: {"yea": full text}}` for a one-off full rewrite (nay is derived by
   swapping the opener), `IDX = {i: {"close": "..."}}` to shorten a long
   closing. See PA/US/WA effects files for examples of each.
4. `python3 tools/mkrewrites2.py /tmp/CO_rewrites.json tools/CO_effects.py evidence/rollcall/description-rewrite-2026-09-13/CO/rewrites.json`
   It refuses to write until every row passes the same gate the importer
   enforces (3 sentences / 320 chars / 30 words per sentence, tally
   present, no modal words). Fix the listed rows and rerun.
5. `npm run rollcall:rewrite -- --rewrites-file evidence/rollcall/description-rewrite-2026-09-13/CO/rewrites.json --dry-run`
   then without `--dry-run`, saving stdout to `CO/apply-report.json`.
   `leftAlone` rows are records whose text no longer matched the roll's
   stored sentence. If they are just an older revision of the same digest
   (same opener, still over the length gate) rerun with `--stale-too`;
   a record someone shortened by hand is still left alone.
   `tools/compact.py <export.json> 300` is a shorter per-measure view than
   showstate.py: one body per measure, plus only the rolls whose OPEN or
   CLOSE needs an override.
6. Add the row to ../README.md, commit `data(rollcall): rewrite CO ...`.

Sanity check afterwards:
`select count(*), round(avg(length(description))) from candidate_records where origin='rollcall_import' and retired_at is null and origin_run_id like 'rollcall:CO:%';`

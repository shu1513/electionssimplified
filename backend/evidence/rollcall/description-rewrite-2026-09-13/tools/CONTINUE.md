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
   the closing is per roll). CAUTION: bill numbers recur across sessions
   (CO HB 1001 exists in 2025, the 2025 special session and 2026), and the
   exporter has no session filter. Prefer `tools/fixrolls.py` with
   `tools/fix/<JUR>.py`, which keys every clause by roll id. If you do use
   measure keys, first split the export by the `session` field each row
   carries, one file per session:
   `python3 -c "import json,sys;d=json.load(open('/tmp/CO_rewrites.json'));json.dump({'rewrites':[r for r in d['rewrites'] if r['session']=='2243']},open('/tmp/CO_2243.json','w'),indent=2)"`
   The 2026-09-13 correction pass had to fix 123 rolls that got a
   same-numbered bill's clause from another session. Enacted bills: "which ..."; bills that did not
   pass: "a bill to ..."; never "would/will". Keep the clause under ~22
   words so opener + clause stays under 25. Overrides: `OPEN = {roll: (yea
   opener, nay opener)}` when OPEN printed None or is too long; `IDX =
   {i: {"yea": full text}}` for a one-off full rewrite (nay is derived by
   swapping the opener), `IDX = {i: {"close": "..."}}` to shorten a long
   closing. See PA/US/WA effects files for examples of each.
4. `python3 tools/mkrewrites2.py /tmp/CO_rewrites.json tools/CO_effects.py evidence/rollcall/description-rewrite-2026-09-13/CO/rewrites.json`
   It refuses to write until every row passes the same gate the importer
   enforces (3 sentences / 320 chars / 25 words per sentence, tally
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

For a small follow-up (a few rolls, or trimming over-limit rolls after a
gate change) use the per-roll tool instead:
`python3 tools/fixrolls.py <export.json> tools/trim/<JUR>.py <out.json> --require-all`
with `ROLL = {roll: {"eff": ...}}` (or `{"yea":..., "nay":...}`, `{"close":...}`,
`{"open": (yea, nay)}`) and `TRIMP = {"<start of current clause>": "<shorter clause>"}`.
`tools/trimview.py <export.json>` prints each over-limit roll grouped by its
current clause with the word budget left after the opener.

Sanity check afterwards:
`select count(*), round(avg(length(description))) from candidate_records where origin='rollcall_import' and retired_at is null and origin_run_id like 'rollcall:CO:%';`

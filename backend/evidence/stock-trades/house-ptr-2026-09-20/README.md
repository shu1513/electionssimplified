# House Periodic Transaction Reports — local import, state as of 2026-09-20

Source: the House Clerk's yearly financial-disclosure indexes
(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>FD.zip`),
filing type `P` (Periodic Transaction Report). Each filing is a PDF at
`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/<year>/<DocID>.pdf`.

## Files

- `2023FD.xml` … `2026FD.xml` — the indexes as downloaded on 2026-09-20.
- `import-report.json` — one row per PTR in the indexes, with the matched
  member, candidate, action and parse status. It is the report of the latest
  run, a re-run over an already imported database, so every in-scope filing
  reads `unchanged`.

The PDFs are not committed. `stocks:import` downloads each one once into
`backend/scratch/house-financial-disclosures/` (git-ignored).

## What is in the local database

| | count |
| --- | --- |
| PTR filings in the four indexes | 1,821 |
| Filings stored (member matched to a candidate on a Nov-2026-or-later election) | 1,215 |
| — parsed (e-filed text PDFs) | 1,006, from 114 candidates |
| — stored as `scanned` (paper filings, image-only PDFs; no trades read) | 209, from 19 candidates |
| — `parse_failed` | 0 |
| Trades stored | 12,157 |
| Rows marked superseded by a later amended row | 3 |
| Covered filers (`candidate_stock_trade_filers`) | 321 |
| — of which have no PTR in the indexes ("No stock trades reported.") | 195 |

Filings not stored:

- `no_candidate` — 586 filings from 64 filers. The member resolved, but no
  candidate row carries any of the member's FEC ids. Some have left the House
  or are not running; others are candidates whose `fec_ids` are empty.
- `out_of_scope` — 14 filings. The candidate exists but is not on a
  Nov-2026-or-later election.
- `unresolved_member` — 6 filings. No House member with that last name held a
  seat in that state on the filing date. The report rows give the detail.

## Rules the importer follows

- A member is picked by the House seat held on the filing date and confirmed
  by last name; first names are never compared. The candidate comes from the
  FEC-id crosswalk (congress-legislators at sha
  `750c0608efb6ef1fc3257ba72c99af3771d35088`).
- A filing is keyed by chamber + DocID, a trade by filing + row number. A
  re-run inserts nothing. A parsed filing is never rewritten.
- The PDF parser is strict: if any row of a filing has an unreadable date,
  amount or owner, the whole filing is stored as `parse_failed` with no rows.
- Amounts are stored as the filed range. A few filers type one exact figure;
  it is stored as both ends. "Over $X" is stored with no high end.
- Amendments: the form marks a restated row "Amended" but does not name the
  row it restates. An amended row supersedes one earlier row of the same
  candidate with the same owner, asset, transaction date and transaction
  type. Without such a row nothing is superseded and both stay listed. Most
  amended rows here (87 of 90) restate 2022 filings that are outside the
  imported years, so they have nothing to supersede.
- Covered filers are every sitting House member who resolves to an in-scope
  candidate, plus every candidate with a stored filing. The panel shows only
  for covered filers.

## Re-running

```
npm run stocks:import -- --evidence-dir evidence/stock-trades/house-ptr-2026-09-20 --dry-run
npm run stocks:import -- --evidence-dir evidence/stock-trades/house-ptr-2026-09-20
```

Local database only (`requireLocalDatabaseTarget`).

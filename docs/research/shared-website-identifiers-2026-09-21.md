# Shared website URLs as candidate identifiers (audit, 2026-09-21)

The candidate profile writer treated `official_website_url` (current or former)
as a hard identifier. On the local database 371 distinct URLs were stored on
two or more live candidate rows (1,197 rows). Most are pages that list many
people: county officials directories, election results pages, court and board
rosters, candidate lists.

## What the audit found

- No two rows with the same first and last name share a URL, so the exact-name
  rule that website matching requires never had a second person to hit.
- Every entry in `candidate_rename_audit` for these rows is a name-order or
  surname-particle fix, not a change of person.
- Eight rows are linked to two districts; all are one judge on a multi-county
  judicial district (same office, two county ballots).
- No repair report or run log shows a `matchedExisting: true` write that
  resolved on a shared URL.
- Conclusion: no evidence of a past wrong merge caused by website matching.
  The risk was forward-looking.

## Classification of the 371 URLs

| Group | URLs | Action |
| --- | --- | --- |
| Shared page by URL shape (directory, results, roster, candidate list) | 300 | clear from current and former website fields |
| Shared page with an opaque path (listed in `shared-website-pages-2026-09-21.txt`) | 42 | clear |
| Governor / lieutenant governor ticket campaign sites (lead and running mate) | 31 | keep |
| Slate campaign sites (`ld11.vote`, `forstrongerschoolsjc.com`, `sites.google.com/view/wcp-md`) | 3 | keep |
| Same person stored twice (`juliaforarizona.com`: Julia Gusse `7b479c7a-…`, Julia Romero Gusse `1b480e3c-…`) | 1 | owner decides; `manual:candidates:merge` |

Dry run of `manual:candidates:clear-shared-websites` with the URL list:
342 URLs stripped, 1,139 rows changed (some rows lose only a former entry),
35 shared URLs kept.

Possible duplicate for the owner: Cathy White (`881ea8a6-…`, Working Class
Party governor ticket) and Cathy Permut (`15e187d0-…`, same party, same site,
no election link).

Unrelated rows noticed while checking for wrong merges (each is one person
linked to two different November 2026 offices, likely a stale roster link,
not a website match): Patricia Jimenez `6916f056-…`, Paul Carver
`c6646aa2-…`, Jennifer Capps Balkcom `94acf795-…`, Justin J. Pearson
`eb3aba67-…`. Two Campbell County (KY) school board elections exist twice
under different titles (districts 1 and 4).

## Code guard

- `isSharedPageWebsiteUrl` flags a URL whose last meaningful path segment or
  query carries a listing word, or a bare government host.
- `assessWebsiteIdentifier` also refuses a URL already stored (current or
  former) on a live row under a different normalized name. The identity pool
  query now loads those rows.
- `hasAtLeastOneHardIdentifier` and `matchesByHardIdentifier` skip such a
  website; `manual:candidate-profile:write` refuses the payload with the
  reason unless it carries another identifier or `--allow-no-hard-identifier`.

## Local and production steps

1. Merge the PR.
2. Local: `cd backend && npm run manual:candidates:clear-shared-websites -- --urls-file ../docs/research/shared-website-pages-2026-09-21.txt --report-file /tmp/shared-websites-local.json` (dry run), review, then add `--apply`.
3. Production, after the API deploy: run the same command with the production
   `DATABASE_URL` and `ALLOW_REMOTE_DB_WRITES=1`, dry run first, then `--apply`.
   Production rows differ, so read its `sharedButKept` list before applying.
4. Merge the Julia Gusse pair with `manual:candidates:merge` if the owner
   agrees; decide on Cathy White / Cathy Permut.

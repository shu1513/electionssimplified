-- Repair Maine Judge of Probate contests that a policy gap forced to nonpartisan.
--
-- `elections.is_partisan` is ballot-facing: it records whether the party is
-- printed next to the name in November. Maine elects its county judges of
-- probate "as is provided respecting county commissioners" (4 M.R.S. § 301):
-- party primaries, then a party label on the general ballot. The Secretary of
-- State's 2026 general candidate list shows a party for every probate
-- candidate. The governor appoints every other Maine judge, so no other Maine
-- judicial contest reaches a ballot.
--
-- Maine had no entry in electionPartisanshipPolicy.ts, so every Maine judicial
-- title fell to the unmapped-state nonpartisan default, and the roster writer
-- rejected the nominee's party (Knox County, 2026-09-22). The policy fix ships
-- with this migration but only governs contests that get rewritten, so the
-- seven November 2026 probate contests already stored need this repair.
--
-- Candidate party labels are not changed here; the roster and profile writers
-- set them from the official list.
--
-- Scoped to Maine, office races, and judge-of-probate titles. The Register of
-- Probate is a clerk office outside judicial policy and is not touched.
-- Idempotent: rows already true are skipped.

BEGIN;

UPDATE public.elections e
SET is_partisan = true,
    updated_at = now()
FROM public.districts d
WHERE d.id = e.district_id
  AND d.state = 'ME'
  AND e.race_type = 'office'
  AND e.official_ballot_title ~* '\yprobate\y'
  AND e.official_ballot_title ~* '\yjudge\y'
  AND e.official_ballot_title !~* '\yregister\y'
  AND e.is_partisan IS DISTINCT FROM true;

COMMIT;

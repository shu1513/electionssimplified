-- Repair Maryland Orphans' Court contests that a policy gap forced to nonpartisan.
--
-- `elections.is_partisan` is ballot-facing: it records whether the party is
-- printed next to the name in November. Maryland elects its Orphans' Court
-- judges on the party ballot (Md. Const. art. IV § 40): candidates are
-- nominated in the party primaries and the general ballot prints
-- "Democratic"/"Republican" under each name — live 2026 general ballots for
-- Baltimore City, Carroll, Charles and Frederick counties all do. Circuit
-- court judges are printed WITHOUT a party (same ballots), and the appellate
-- bench stands for retention, so no other Maryland judicial title changes.
--
-- Maryland had no entry in electionPartisanshipPolicy.ts, so every Maryland
-- judicial title fell to the unmapped-state nonpartisan default and the
-- contract rejected the researched true. The policy fix ships alongside this
-- migration but only governs contests that get rewritten; a district holding
-- an upcoming election classifies as `not_due`, so ordinary discovery never
-- revisits it. Without this migration the 14 November 2026 Orphans' Court
-- contests would reach election day claiming no party while the ballot
-- prints one.
--
-- Candidate party labels are NOT corrected here: the stored "Nonpartisan"
-- placeholders are replaced through the roster/profile writers from the
-- official ballots (research), mirroring migration 227's scope note.
--
-- Scoped to Maryland and to the Orphans' Court title (straight or curly
-- apostrophe, or none). Idempotent: rows already true are skipped.

BEGIN;

UPDATE public.elections e
SET is_partisan = true,
    updated_at = now()
FROM public.districts d
WHERE d.id = e.district_id
  AND d.state = 'MD'
  AND e.race_type = 'office'
  AND e.official_ballot_title ~* '\yorphans[’'']?\s+court\y'
  AND e.official_ballot_title !~* '\y(retention|retained)\y'
  AND e.is_partisan IS DISTINCT FROM true;

COMMIT;

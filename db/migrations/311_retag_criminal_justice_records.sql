-- Move criminal-justice and civil-liberties records from civil_rights to the
-- criminal_justice_and_civil_liberties area added by migration 310.
--
-- Rule: a Civil Rights tag moves when the record's description names a
-- criminal-justice or civil-liberties subject (policing, sentencing,
-- incarceration, bail, expungement, DNA collection, surveillance, free
-- expression, ...) and does NOT name a core civil-rights subject
-- (discrimination, LGBTQ rights, voting rights, religion, reproductive
-- rights, ...). The two regexes below were tuned on the local corpus on
-- 2026-09-30: 40 of 40 random matches were criminal-justice items and the
-- non-matching remainder was equal-rights material. Stance is kept: both
-- areas read "for" as protecting rights and liberties, so a "for" vote
-- against pretrial DNA collection stays "for".
--
-- Why a migration and not a local retag + promotion: the promoter never
-- deletes target rows, so a tag moved locally would leave the old Civil
-- Rights tag live in production. Running the same deterministic rule on
-- every database keeps them identical.
--
-- Records that already carry the new area keep both tags untouched (the
-- unique (record, area) constraint would reject the move).

BEGIN;

WITH areas AS (
  SELECT
    (SELECT id FROM public.research_areas WHERE slug = 'civil_rights') AS civil_rights_id,
    (SELECT id FROM public.research_areas WHERE slug = 'criminal_justice_and_civil_liberties') AS criminal_justice_id
),
moved AS (
  UPDATE public.candidate_record_area_tags tag
  SET research_area_id = areas.criminal_justice_id,
      updated_at = now()
  FROM areas, public.candidate_records record
  WHERE tag.research_area_id = areas.civil_rights_id
    AND areas.criminal_justice_id IS NOT NULL
    AND record.id = tag.candidate_record_id
    AND record.description ~* $rx$\mdna\M|qualified immunity|police (accountab|misconduct|disciplin|oversight|reform|use of force|body|chokehold|no-knock|officers?'? names)|body(-| )?cam|chokehold|no-knock|adverse[- ]action|sentenc(e|es|ing)\M|mandatory minimum|second look|\mparole|probation|clean slate|expunge|record sealing|seal(ing)? (of )?(criminal |old )?(records|convictions)|\mbail\M|pretrial|incarcerat|\mprison|\mjail|solitary|death penalty|capital punishment|death row|juvenile justice|raise the age|decriminaliz|criminal penalt|asset forfeiture|civil forfeiture|(?<!disease |health |public health )surveillance|facial recognition|wrongful(ly)? convict|public defender|drug possession|marijuana|cannabis|criminal justice|three strikes|felony murder|life without parole|re-?entry|diversion program|mental health court|drug court|gang database|stop[- ]and[- ]frisk|warrantless|search(es)? (and|or) seizure|free speech|first amendment|censorship|book ban|due process|excessive force|resisting arrest|criminal charge|\mfelon|misdemeanor|new crimes?|\mcrimes?\M|\mpolice\M|\mpolicing|law enforcement|\marrest|\mcorrections?\M|\minmates?\M|\mprisoners?\M|\moffenders?\M|\mdefendants?\M|prosecutors?\M$rx$
    AND record.description !~* $ex$discriminat|transgender|gender identity|sexual orientation|same-sex|lgbt|gender[- ]transition|gender[- ]affirming|puberty blockers|affirmative action|title ix|civil rights act|voting rights|religio|antisemit|hate crime|equal pay|segregat|marriage|abortion|reproductive|sex-specific|pronoun|\mdei\M|diversity, equity|ten commandments|sex trafficking|human trafficking|domestic violence|sexual assault|opposite sex|sex at birth|biological sex|cabaret|\mdrag\M$ex$
    AND NOT EXISTS (
      SELECT 1 FROM public.candidate_record_area_tags other
      WHERE other.candidate_record_id = tag.candidate_record_id
        AND other.research_area_id = areas.criminal_justice_id
    )
  RETURNING tag.id
)
SELECT COUNT(*) AS moved_tags FROM moved;

COMMIT;

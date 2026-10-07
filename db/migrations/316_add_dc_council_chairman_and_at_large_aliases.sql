-- The District of Columbia elects two citywide Council seats on November 3,
-- 2026 that the office matcher could not place: "Chairman of the Council of
-- the District of Columbia" matched nothing (the catalog has no council
-- president office), and "At-Large Member of the Council" scored a tie
-- between City Council Member and Town Council Member. Both contests were
-- left out of the DC place district, so voters saw the Mayor and Attorney
-- General races but not the Chairman or the at-large seats on the same
-- ballot.
--
-- Both seats are members of the Council of the District of Columbia (D.C.
-- Code § 1-204.01: the Chairman and four at-large members are elected by the
-- whole District; the Chairman presides and votes as a member). City Council
-- Member is the catalog office for a municipal legislative seat, so both
-- titles alias onto it at place scope. The ward seats are unaffected: DC's
-- ward rows are typed state_upper and keep matching State Senator.
--
-- Aliases are keyed by the matcher's normalized form (lowercase, punctuation
-- dropped), matching how OfficeMatcher.resolve looks them up. Every
-- statement is idempotent: ON CONFLICT leaves an existing alias alone.

BEGIN;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'place', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Chairman of the Council', 'chairman of the council'),
        ('Chairman of the Council of the District of Columbia', 'chairman of the council of the district of columbia'),
        ('Chairwoman of the Council', 'chairwoman of the council'),
        ('Chair of the Council', 'chair of the council'),
        ('At-Large Member of the Council', 'at large member of the council'),
        ('At-Large Member of the Council of the District of Columbia', 'at large member of the council of the district of columbia')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'place'
  AND o.canonical_name = 'City Council Member'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

COMMIT;

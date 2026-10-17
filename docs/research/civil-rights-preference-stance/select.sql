-- Preview only the exact descriptions reviewed in matches.tsv.
-- Run with psql -X -v ON_ERROR_STOP=1 -f select.sql.
\set ON_ERROR_STOP on
begin;
\ir reviewed_descriptions.sql
select t.id as tag_id, r.id as record_id, t.stance, r.retired_at is not null as retired, r.origin,
       replace(r.description, E'\n', ' ') as description
from candidate_record_area_tags t
join research_areas a on a.id = t.research_area_id
join candidate_records r on r.id = t.candidate_record_id
where a.slug = 'civil_rights'
  and exists (
    select 1 from reviewed_preference_descriptions reviewed
    where reviewed.description = replace(r.description, E'\n', ' ')
  )
order by r.description;

commit;

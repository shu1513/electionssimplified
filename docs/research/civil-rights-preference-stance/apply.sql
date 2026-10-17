-- Moves civil_rights tags on group-preference records (affirmative action, race/sex preferences, DEI) to general with no stance.
-- Owner decision 2026-10-17. Re-runnable: selects by description, so it also works on prod.
begin;
create temp table m on commit drop as
select t.id as tag_id, r.id as record_id, t.stance, r.retired_at is not null as retired, r.origin,
       replace(r.description, E'\n', ' ') as description
from candidate_record_area_tags t
join research_areas a on a.id = t.research_area_id
join candidate_records r on r.id = t.candidate_record_id
where a.slug = 'civil_rights'
  and (
    (r.description ~* '(affirmative action|preferential treatment|preferences? (based )?on (the basis of )?(race|sex)|race[- ]conscious|race[- ]based (admission|hiring|preference|contract)|racial preference|diversity,? equity|\mDEI\M|diversity statement|diversity office|equal opportunity (office|plan)|set-?aside|minority[- ]owned|disadvantaged business|colorblind|color-blind|quota)'
     and r.description !~* '(INVEST package|\mHB ?2\M|H\.R\. 5009|GR 37|bar exam|Neurodiversity|summary judgment blocking an executive order)')
    or r.description ~* '(HB 1578|HB 622, which bars|Senate Bill 289, which bars|Senate Bill 3, which bars|minority[- ] and women[- ]owned|minority business (contracting|enterprise)|supplier-diversity|minority contracting|race-based college admissions|diversity, equality, and inclusion officer|SB1694|ended diversity programs)'
  )
;
-- Record already has a general tag: drop the civil_rights tag.
delete from candidate_record_area_tags t using m
where t.id = m.tag_id
  and exists (select 1 from candidate_record_area_tags g join research_areas ga on ga.id = g.research_area_id
              where g.candidate_record_id = m.record_id and ga.slug = 'general');
-- Otherwise: turn the civil_rights tag into general with no stance.
update candidate_record_area_tags t
set research_area_id = (select id from research_areas where slug = 'general'), stance = null
from m where t.id = m.tag_id;
-- Roll calls whose only label was civil_rights: relabel general so a re-import keeps it.
-- Approved rows are edit-guarded: move to pending, relabel, then re-approve (reviewed now).
create temp table vv on commit drop as
select v.id from legislative_votes v
where v.review_status = 'approved'
  and v.labels_json = (select jsonb_agg(x) from jsonb_array_elements(v.labels_json) x where x->>'slug' = 'civil_rights')
  and exists (select 1 from m where m.description in (replace(v.yea_description, E'\n', ' '), replace(v.nay_description, E'\n', ' ')));
update legislative_votes v set review_status = 'pending', reviewed_at = null,
  labels_json = '[{"slug": "general", "yea": null, "nay": null}]'::jsonb
from vv where v.id = vv.id;
update legislative_votes v set review_status = 'approved', reviewed_at = now()
from vv where v.id = vv.id;
commit;

-- civil_rights tags on records whose subject is race/sex preferences, affirmative action, or DEI.
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
order by r.description;

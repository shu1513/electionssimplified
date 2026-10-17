-- Temporary-table regression checks; no application data is read or changed.
-- psql -X -v ON_ERROR_STOP=1 -d postgres -f test.sql
\set ON_ERROR_STOP on
set search_path = pg_temp;
create temp table research_areas (id integer primary key, slug text unique);
create temp table candidate_records (
  id integer primary key, description text not null,
  retired_at timestamptz, origin text default 'manual'
);
create temp table candidate_record_area_tags (
  id integer primary key, candidate_record_id integer references candidate_records,
  research_area_id integer references research_areas, stance text,
  unique (candidate_record_id, research_area_id)
);
create temp table legislative_votes (
  id integer primary key, review_status text, reviewed_at timestamptz,
  labels_json jsonb, yea_description text, nay_description text
);
insert into research_areas values (1, 'civil_rights'), (2, 'general');
insert into candidate_records (id, description) values
  (1, 'Introduced a bill with Rep. Anna Paulina Luna to ban race-based preferences and quotas in federal contracting.'),
  (2, 'Introduced a bill with Rep. Anna Paulina Luna to ban race-based preferences and quotas in federal contracting.'),
  (3, 'Enforced an anti-discrimination law against a minority-owned employer for refusing to hire women.'),
  (4, 'Voted to prohibit police arrest quotas that discriminate against Black residents.'),
  (5, 'Voted for HB 1578, which adds disability as a protected class under the state anti-discrimination law.'),
  (6, 'Introduced a bill with Rep. Anna Paulina Luna to ban race-based preferences and quotas in federal contracting. Amended in committee.'),
  (7, 'Voted to ban race-based preferences in public contracting.'),
  (8, E'Introduced a bill with Rep. Anna Paulina Luna to ban race-based preferences\nand quotas in federal contracting.');
insert into candidate_record_area_tags select id, id, 1, 'for' from candidate_records;
insert into candidate_record_area_tags values (9, 2, 2, null);
insert into legislative_votes
  select id, 'approved', '2026-10-01'::timestamptz,
    '[{"slug":"civil_rights","yea":"for","nay":"against"}]'::jsonb,
    description, 'Synthetic nay description'
  from candidate_records where id in (1, 3, 4, 5);

-- Includes resolve beside the scripts, independent of the working directory.
\ir select.sql
do $$
begin
  if (select count(*) from candidate_record_area_tags where research_area_id = 1) <> 8 then
    raise exception 'Preview changed tags';
  end if;
end $$;
\ir apply.sql
do $$
begin
  if (select count(*) from candidate_record_area_tags) <> 8
     or (select count(*) from candidate_record_area_tags
         where candidate_record_id in (1, 2, 8) and research_area_id = 2 and stance is null) <> 3
     or exists (select 1 from candidate_record_area_tags
                where candidate_record_id in (1, 2, 8) and research_area_id = 1) then
    raise exception 'Reviewed descriptions were not converted exactly once';
  end if;
  if (select count(*) from candidate_record_area_tags
      where candidate_record_id between 3 and 7 and research_area_id = 1 and stance = 'for') <> 5 then
    raise exception 'An unreviewed or anti-discrimination record was changed';
  end if;
  if not exists (select 1 from legislative_votes where id = 1 and review_status = 'approved'
                 and labels_json = '[{"slug":"general","yea":null,"nay":null}]'::jsonb)
     or (select count(*) from legislative_votes where id in (3, 4, 5)
         and labels_json = '[{"slug":"civil_rights","yea":"for","nay":"against"}]'::jsonb
         and reviewed_at = '2026-10-01'::timestamptz) <> 3 then
    raise exception 'Roll-call updates escaped the reviewed set';
  end if;
end $$;

create temp table first_tags as select * from candidate_record_area_tags;
create temp table first_votes as select * from legislative_votes;
\ir apply.sql
do $$
begin
  if exists (
    (select * from first_tags except select * from candidate_record_area_tags)
    union all
    (select * from candidate_record_area_tags except select * from first_tags)
  ) or exists (
    (select * from first_votes except select * from legislative_votes)
    union all
    (select * from legislative_votes except select * from first_votes)
  ) then
    raise exception 'Second apply changed tags or review timestamps';
  end if;
end $$;
select 'PASS: reviewed scope, exceptions, duplicate tags, preview, roll calls, rerun' as result;

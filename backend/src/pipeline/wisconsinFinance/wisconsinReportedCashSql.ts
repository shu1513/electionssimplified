// Shared canonical expressions keep due selection and read-side identity checks
// aligned with the snapshot writer. These fragments contain no caller input.
export const WI_CASH_CANDIDATE_NAME_SQL = "COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name))";
export const WI_CASH_DISTRICT_SQL = "CASE WHEN d.district_type IN ('state_upper','state_lower') THEN NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') ELSE NULL END";
export const WI_CASH_SOURCE_MATCH_SQL = `s.candidate_name=${WI_CASH_CANDIDATE_NAME_SQL}
  AND s.candidate_last_name=c.last_name AND s.election_date=e.election_date
  AND s.election_year=extract(year FROM e.election_date)::integer
  AND s.office_scope=o.scope AND s.office_name=o.canonical_name
  AND s.district IS NOT DISTINCT FROM (${WI_CASH_DISTRICT_SQL})`;

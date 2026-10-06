-- November 3, 2026 general-election contests counted by ranked-choice voting.
-- Source: each jurisdiction's election office, cross-checked against FairVote's
-- 2026 tracking table (fairvote.org/where-will-ranked-choice-voting-be-used-in-the-2026-elections/).
-- Matches by state, date, district name, and title so it can be re-run on any
-- database that holds the same rows. Rows not matched here keep NULL (method
-- not recorded); nothing is set to 'plurality' by this file.
BEGIN;

-- Maine: federal offices only. Governor and the legislature stay plurality
-- under the state constitution.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'ME' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type IN ('statewide', 'us_house')
  AND e.official_ballot_title ~* '^United States (Senator|Representative)';

-- Portland, Maine: all municipal offices since the 2020 charter vote.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'ME' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type IN ('place', 'school_unified') AND d.name ~* '^Portland';

-- Alaska: every state and federal office after the top-four primary. Judicial
-- retention questions and borough school boards are not ranked.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'AK' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type IN ('statewide', 'us_house', 'state_upper', 'state_lower')
  AND e.official_ballot_title !~* '^Shall ';

-- District of Columbia: Initiative 83 applies to every office on the ballot.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'DC' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office';

-- San Francisco: every city and county office; the school board is not ranked.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'CA' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type = 'county' AND d.name ~* '^San Francisco County';

-- Oakland: every city office and the school board.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'CA' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND ((d.district_type = 'place' AND d.name ~* '^Oakland city')
    OR (d.district_type = 'school_unified' AND d.name ~* '^Oakland Unified'));

-- Berkeley, San Leandro, Albany: city offices.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'CA' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type = 'place' AND d.name ~* '^(Berkeley|San Leandro|Albany) city';

-- Boulder, Colorado: the mayor only; council seats are plurality.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'CO' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type = 'place' AND d.name ~* '^Boulder city'
  AND e.official_ballot_title ~* 'Mayor';

-- Oregon: Portland and Corvallis city offices; Multnomah County's own offices
-- (chair, commissioners, auditor, sheriff, district attorney), not state judges.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'OR' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type = 'place' AND d.name ~* '^(Portland|Corvallis) city';
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'OR' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type = 'county' AND d.name ~* '^Multnomah County'
  AND e.official_ballot_title !~* 'Judge';

-- Arlington County, Virginia: the County Board only.
UPDATE elections e SET voting_method = 'ranked_choice'
FROM districts d WHERE d.id = e.district_id AND d.state = 'VA' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type = 'county' AND d.name ~* '^Arlington County'
  AND e.official_ballot_title ~* 'County Board';

COMMIT;

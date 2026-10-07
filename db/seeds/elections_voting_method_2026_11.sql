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

-- District of Columbia: D.C. Code § 1-1001.08a uses ranked choice only in a
-- contest "involving 3 or more qualified candidates"; with one or two the
-- ballot says "Vote for no more than one". Decided per contest from the Board
-- of Elections' official sample ballots for Wards 1, 3, 5 and 6 (dcboe.org,
-- 2026 General Election), not from the stored roster: the Mayor contest ranks
-- three candidates on the ballot while the roster here holds two. Caps are
-- the ballot's own "Rank up to N choices". Every other DC office on those
-- ballots (Attorney General, Ward 3 and Ward 6 Council, Ward 1, 3 and 5 State
-- Board of Education) is vote-for-one and stays NULL.
UPDATE elections e SET voting_method = 'ranked_choice', ranked_choice_max_rankings = v.cap
FROM districts d, (VALUES
    ('United States Representative, DC At-Large', 4),
    ('Mayor', 4),
    ('At-Large Member of the Council', 5),
    ('Ward 1 Member of the Council', 5),
    ('Ward 5 Member of the Council', 4),
    ('Ward 6 Member of the State Board of Education', 4)
  ) AS v(title, cap)
WHERE d.id = e.district_id AND d.state = 'DC' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND e.official_ballot_title = v.title;
UPDATE elections e SET voting_method = NULL, ranked_choice_max_rankings = NULL
FROM districts d WHERE d.id = e.district_id AND d.state = 'DC' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND e.official_ballot_title NOT IN (
    'United States Representative, DC At-Large', 'Mayor', 'At-Large Member of the Council',
    'Ward 1 Member of the Council', 'Ward 5 Member of the Council',
    'Ward 6 Member of the State Board of Education');

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
-- Portland's Districts 3 and 4 each elect three councilors in 2026 (their 2024
-- winners drew two-year terms to stagger the council), counted by multi-winner
-- ranked choice with a 25% threshold. The rows were stored without a seat
-- count, so set it here.
UPDATE elections e SET seats_to_fill = 3
FROM districts d WHERE d.id = e.district_id AND d.state = 'OR' AND e.election_date = '2026-11-03'
  AND e.race_type = 'office' AND d.district_type = 'place' AND d.name ~* '^Portland city'
  AND e.official_ballot_title ~* '^City Councilor, District [34]$' AND e.seats_to_fill IS NULL;
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

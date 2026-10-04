// ---------------------------------------------------------------------------
// Sub-state electorates for contests stored on a statewide district row.
//
// California Court of Appeal justices stand for retention only before the
// voters of their own appellate district (Cal. Const. art. VI § 16(d); the
// Secretary of State's certified list prints each district's counties). No
// district row models an appellate district, so those contests live on the
// statewide row with the district in the title ("Associate Justice, Court
// of Appeal, Second District, Division One: Shall ...") and the reader drops
// the ones a voter's county does not vote on.
// ---------------------------------------------------------------------------

// County FIPS (state + county) per appellate district, Gov. Code §§ 69100-69106.
const CA_COURT_OF_APPEAL_COUNTIES: Record<string, readonly string[]> = {
  first: ["06001", "06013", "06015", "06023", "06033", "06041", "06045", "06055", "06075", "06081", "06095", "06097"],
  second: ["06037", "06079", "06083", "06111"],
  third: [
    "06003", "06005", "06007", "06009", "06011", "06017", "06021", "06035", "06049", "06051", "06057", "06061",
    "06063", "06067", "06077", "06089", "06091", "06093", "06101", "06103", "06105", "06113", "06115",
  ],
  fourth: ["06025", "06027", "06059", "06065", "06071", "06073"],
  fifth: ["06019", "06029", "06031", "06039", "06043", "06047", "06099", "06107", "06109"],
  sixth: ["06053", "06069", "06085", "06087"],
};

const CA_COURT_OF_APPEAL_DISTRICT = /\bCourt of Appeal, (First|Second|Third|Fourth|Fifth|Sixth) (?:Appellate )?District\b/i;

type ElectorateContest = {
  state_fips: string;
  district_type: string;
  official_ballot_title: string;
};

type ElectorateDistrict = {
  district_type: string;
  geoid_compact: string;
};

// True when the contest is a California Court of Appeal retention question
// for an appellate district that none of the voter's counties belongs to. A
// lookup that carries no California county keeps every contest: there is
// nothing to decide the electorate with.
export function isOutsideAppellateElectorate(
  contest: ElectorateContest,
  districts: readonly ElectorateDistrict[]
): boolean {
  if (contest.state_fips !== "06" || contest.district_type !== "statewide") {
    return false;
  }
  const match = CA_COURT_OF_APPEAL_DISTRICT.exec(contest.official_ballot_title);
  if (!match) {
    return false;
  }
  const voterCounties = districts
    .filter((district) => district.district_type === "county" && district.geoid_compact.startsWith("06"))
    .map((district) => district.geoid_compact);
  if (voterCounties.length === 0) {
    return false;
  }
  const electorate = CA_COURT_OF_APPEAL_COUNTIES[match[1].toLowerCase()];
  return !voterCounties.some((county) => electorate.includes(county));
}

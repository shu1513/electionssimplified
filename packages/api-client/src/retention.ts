/**
 * Judicial retention races ("Shall Judge X be retained in office?") are
 * catalogued as office races with the judge as the single candidate, but the
 * ballot asks Yes/No and the app records the answer as measure_position.
 * One regex, shared by web, mobile, and (as a copy) the backend's
 * electionPartisanshipPolicy.isJudicialRetentionTitle — keep them identical.
 */
export function isJudicialRetentionTitle(title: string): boolean {
  // California's retention question is prescribed wording used only for
  // judges ("Shall [Associate Justice] X be elected to the office for the
  // term provided by law?"), and the ballot sometimes omits the office
  // word ("Shall DAVID B. SAPP be elected to the office ..."), so the
  // phrase alone is enough.
  if (/\bbe elected to the office for the term provided by law\b/i.test(title)) {
    return true;
  }
  // Otherwise both halves are required: the retention verb alone would also
  // catch a non-judicial office such as "Water Retention District Director".
  return /\b(retention|retain(?:ed|ing)?)\b/i.test(title) && /\b(judge|justice|court|judicial|magistrate)\b/i.test(title);
}

/** True when an office race is answered Yes/No instead of by picking a candidate. */
export function isRetentionRace(election: { race_type: string; official_ballot_title: string }): boolean {
  return election.race_type === "office" && isJudicialRetentionTitle(election.official_ballot_title);
}

/** Split out retention races only on dates with at least two of them.
 * Both partitions preserve input order; a lone retention stays counted. */
export function splitRetentionRaces<Election extends {
  election_date: string;
  race_type: string;
  official_ballot_title: string;
}>(elections: readonly Election[]): { contested: Election[]; retention: Election[] } {
  const counts = new Map<string, number>();
  for (const election of elections) {
    if (isRetentionRace(election)) {
      counts.set(election.election_date, (counts.get(election.election_date) ?? 0) + 1);
    }
  }
  const contested: Election[] = [];
  const retention: Election[] = [];
  for (const election of elections) {
    const grouped = isRetentionRace(election) && (counts.get(election.election_date) ?? 0) >= 2;
    (grouped ? retention : contested).push(election);
  }
  return { contested, retention };
}

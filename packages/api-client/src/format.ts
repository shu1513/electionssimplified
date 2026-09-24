// Shared display formatters. Election dates arrive as YYYY-MM-DD strings and
// must be treated as calendar dates, not instants: new Date("2026-11-03")
// parses as UTC midnight and renders the previous day in US timezones.

import type {
  CandidateRosterStatus,
  CurrentCompetitiveness,
  FinanceOutsideIndustryEvidence,
  HistoricalCompetitiveness,
} from "./types";

export function formatElectionDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  if (!match) {
    return isoDate;
  }
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function formatMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

// Keys are the backend's district_type values (see districts table).
const DISTRICT_TYPE_LABELS: Record<string, string> = {
  statewide: "Statewide",
  county: "County",
  place: "City",
  us_house: "U.S. House district",
  state_upper: "State senate district",
  state_lower: "State house district",
  school_unified: "School district",
  school_elementary: "Elementary school district",
  school_secondary: "Secondary school district",
};

export function formatDistrictType(districtType: string): string {
  return DISTRICT_TYPE_LABELS[districtType] ?? districtType.replaceAll("_", " ");
}

/**
 * Stored district names carry the boundary vintage — "Assembly District 54
 * (2024); California" — because legislative districts are versioned by
 * redistricting cycle. The year is provenance, not identity: to a voter
 * "(2024)" on a 2026 election reads as a mistake. Strip it for display
 * everywhere; the stored name keeps the vintage for research bookkeeping.
 */
export function formatDistrictName(name: string): string {
  // Two vintage spellings: "(2024)" on legislative districts and
  // "(119th Congress)" on U.S. House districts.
  return name.replace(/ \((?:(?:19|20)\d{2}|\d+(?:st|nd|rd|th) Congress)\)/g, "");
}

export function formatSourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export type SourceHostGroup = { host: string; urls: string[] };

// Source lists show the host, not the URL, so two pages from one site
// (an index page and the detail page it led to — the normal research
// trail) read as the same line twice. Group by display host, first-seen
// order, exact-URL dedupe, so a footnote can name each site once.
export function groupSourcesByHost(urls: readonly string[]): SourceHostGroup[] {
  const groups: SourceHostGroup[] = [];
  for (const url of new Set(urls)) {
    const host = formatSourceHost(url);
    const group = groups.find((entry) => entry.host === host);
    if (group) group.urls.push(url);
    else groups.push({ host, urls: [url] });
  }
  return groups;
}

// Display scale reads Very low / Below average / Average / Above average /
// High / Very high: "low" as a verdict on the voter and "medium" as a size
// word both misread, so they ship as "Below average" and "Average" (the
// statewide baseline). Wire values stay unchanged.
const VOTE_POWER_LABELS: Record<string, string> = {
  very_low: "Very low",
  low: "Below average",
  medium: "Average",
  above_average: "Above average",
  high: "High",
  very_high: "Very high",
  unknown: "Unknown",
  retention: "Retention race",
};

export function formatVotePowerLabel(label: string): string {
  return VOTE_POWER_LABELS[label] ?? label;
}

export type CompetitivenessChip = { label: string; description: string };

// The current-cycle rating replaces the historic chip when present — the
// backend only sends it when the rating drove the grade, and showing both
// would contradict on races that flipped. The "safe" tier renders no chip:
// most races carry no competitiveness text at all, so "not competitive"
// read as a verdict on those few rather than the absence of a close race.
export function competitivenessChip(election: {
  current_competitiveness?: CurrentCompetitiveness | null;
  historical_competitiveness: HistoricalCompetitiveness | null;
}): CompetitivenessChip | null {
  const rating = election.current_competitiveness ?? election.historical_competitiveness;
  if (!rating || rating.competitiveness_label === "safe") {
    return null;
  }
  return { label: rating.display_label, description: rating.display_description };
}

/** Election result outcomes arrive snake_case (e.g. "too_close"). */
export function formatOutcome(outcome: string): string {
  const spaced = outcome.replaceAll("_", " ").trim();
  return spaced.length > 0 ? spaced[0].toUpperCase() + spaced.slice(1) : outcome;
}

/**
 * "Jocelyn Benson (Democratic), John James (Republican)" from a result row's
 * winners. Nameless entries (unmatched write-ins) drop out; returns "" when
 * nothing remains so callers can append unconditionally.
 */
export function formatWinnerNames(
  winners: readonly { candidate_name?: string; party?: string }[]
): string {
  return winners
    .map(formatWinnerName)
    .filter((name): name is string => name !== null)
    .join(", ");
}

/** "Jocelyn Benson (Democratic)"; null for a nameless (unmatched) winner. */
function formatWinnerName(winner: { candidate_name?: string; party?: string }): string | null {
  const name = winner.candidate_name?.trim();
  if (!name) {
    return null;
  }
  const party = winner.party?.trim();
  return party ? `${name} (${party})` : name;
}

// Only decisive outcomes present their winner set as winners. The stored
// payload may carry winners on a too_close row (a recorded leader), but
// "Result: Too close — Jane Smith" would read as calling the race for Jane.
const NAMED_RESULT_OUTCOMES = new Set(["won", "advanced", "runoff"]);

/**
 * Ballot-card result chip: "Result: Advanced — Jocelyn Benson (Democratic),
 * John James (Republican)". The names are the answer the voter came for, so
 * the chip carries them, not just the outcome word. Falls back to
 * "Result: <outcome>" for non-decisive outcomes, nameless winner sets, and
 * ballot measures (Passed/Failed already says everything).
 */
export function formatResultChipLabel(
  outcome: string,
  winners: readonly { candidate_name?: string; party?: string }[]
): string {
  const parts = buildResultChipParts(outcome, winners);
  return parts.winners.length > 0
    ? `${parts.heading} — ${parts.winners.map((winner) => winner.label).join(", ")}`
    : parts.heading;
}

export type ResultChipParts = {
  /** "Result: Advanced" */
  heading: string;
  /** Named winners in payload order; empty exactly when formatResultChipLabel
   * would render the heading alone. */
  winners: { label: string; isMyPick: boolean }[];
  /** "My pick won ✓" / "My pick advanced ✓" when a winner is the viewer's
   * pick; null otherwise. A pick that lost gets silence, not a red marker —
   * the card announces the payoff, it doesn't rub in the loss. */
  myPickMarker: string | null;
};

/**
 * Structured form of formatResultChipLabel, for surfaces that decorate
 * individual winner names — the ballot card renders "My pick won ✓" inline
 * after the viewer's candidate. Pick matching is by candidate id only (the
 * same conservatism as deriveCandidateResultBadges): a name coincidence must
 * never claim a win. Only decisive outcomes name winners at all, so the
 * marker cannot appear on a too_close row's recorded leader.
 */
export function buildResultChipParts(
  outcome: string,
  winners: readonly { candidate_id?: string; candidate_name?: string; party?: string }[],
  myPickCandidateIds?: ReadonlySet<string>
): ResultChipParts {
  const named = NAMED_RESULT_OUTCOMES.has(outcome)
    ? winners.flatMap((winner) => {
        const label = formatWinnerName(winner);
        if (label === null) {
          return [];
        }
        return [
          {
            label,
            isMyPick:
              winner.candidate_id !== undefined && (myPickCandidateIds?.has(winner.candidate_id) ?? false),
          },
        ];
      })
    : [];
  return {
    heading: `Result: ${formatOutcome(outcome)}`,
    winners: named,
    // "won" claims the seat; "advanced" and "runoff" only move the pick to
    // the next round, so both read "advanced".
    //
    // Derived from the NAMED winners, not the raw list, deliberately: the
    // marker renders inline after the matched winner's name, so a nameless
    // winner gives it no anchor. The id-with-no-name shape is also
    // unproducible — candidate_id is only ever written by the result
    // matcher's toMatchedWinner, which backfills the roster display name in
    // the same assignment — and if it ever appeared anyway, skipping the
    // personal claim is the conservative failure mode used throughout.
    myPickMarker: named.some((winner) => winner.isMyPick)
      ? outcome === "won"
        ? "My pick won ✓"
        : "My pick advanced ✓"
      : null,
  };
}

export type ResultChipTone = "positive" | "negative" | "neutral";

/**
 * Color tone for the ballot-card result chip, matching the badge colors on
 * the election page: decided-forward outcomes (a winner, an advancer, a
 * passed measure) read green, a failed measure reads red, and everything
 * undecided (too_close, unknown, no outcome yet) stays neutral so color
 * always means "called", never just "row exists".
 */
export function resultChipTone(outcome: string | null | undefined): ResultChipTone {
  if (outcome === "won" || outcome === "advanced" || outcome === "runoff" || outcome === "passed") {
    return "positive";
  }
  if (outcome === "failed") {
    return "negative";
  }
  return "neutral";
}

// Mirrors the backend's FINANCE_INDUSTRY_DISPLAY_NAMES
// (ballotLookupFinanceShared.ts). Finance industry categories arrive as
// slugs; occupation categories arrive as free text and pass through
// unchanged (no underscores).
const FINANCE_CATEGORY_LABELS: Record<string, string> = {
  agriculture_and_food: "Agriculture and food",
  business_associations: "Business associations",
  construction: "Construction",
  defense_aerospace: "Defense and aerospace",
  education: "Education",
  environmental_group: "Environmental groups",
  finance_investment: "Finance and investment",
  healthcare: "Healthcare",
  hospitality: "Hospitality",
  insurance: "Insurance",
  labor_unions: "Labor unions",
  lawyers_and_legal_services: "Lawyers and legal services",
  manufacturing: "Manufacturing",
  media_entertainment: "Media and entertainment",
  oil_gas_energy: "Oil, gas, and energy",
  pharmaceuticals: "Pharmaceuticals",
  real_estate: "Real estate",
  retail: "Retail",
  technology: "Technology",
  transportation: "Transportation",
  waste_management: "Waste management",
};

export function formatFinanceCategory(categoryName: string): string {
  const trimmed = categoryName.trim();
  const mapped = FINANCE_CATEGORY_LABELS[trimmed];
  if (mapped) {
    return mapped;
  }
  if (!trimmed.includes("_")) {
    return trimmed.length > 0 ? trimmed : categoryName;
  }
  const spaced = trimmed.replaceAll("_", " ");
  return spaced[0].toUpperCase() + spaced.slice(1).toLowerCase();
}

// Keys are the FinanceSummary.source enum values (backend
// ballotLookupFinanceShared.ts). Raw values like MASSACHUSETTS_OCPF must
// never reach the screen.
const FINANCE_SOURCE_LABELS: Record<string, string> = {
  FEC: "FEC",
  ALABAMA_FCPA: "Alabama FCPA Reporting System",
  ARKANSAS_CFIS: "Arkansas Secretary of State",
  ARIZONA_SOS: "Arizona Secretary of State",
  CALIFORNIA_SOS: "California Secretary of State",
  COLORADO_TRACER: "Colorado TRACER",
  DENVER_CLERK_RECORDER: "Denver Office of the Clerk and Recorder",
  CONNECTICUT_ECRIS: "Connecticut eCRIS",
  DELAWARE_CFRS: "Delaware Campaign Finance Reporting System",
  INDIANA_CAMPAIGN_FINANCE: "Indiana Campaign Finance",
  NEBRASKA_NADC: "Nebraska NADC",
  NEVADA_AURORA: "Nevada Secretary of State",
  NEW_HAMPSHIRE_CFS: "New Hampshire Campaign Finance System",
  NEW_JERSEY_ELEC: "New Jersey ELEC",
  NEW_MEXICO_CFIS: "New Mexico CFIS",
  NORTH_CAROLINA_SBE: "North Carolina State Board of Elections",
  NORTH_DAKOTA_CFRS: "North Dakota Campaign Finance Reporting System",
  OHIO_SOS: "Ohio Secretary of State",
  OKLAHOMA_GUARDIAN: "Oklahoma Guardian",
  TEXAS_TEC: "Texas Ethics Commission",
  HOUSTON_CAMPAIGN_FINANCE: "City of Houston / Texas Ethics Commission",
  AUSTIN_CITY_CLERK: "Austin City Clerk",
  FLORIDA_DOS: "Florida Division of Elections",
  GEORGIA_ETHICS: "Georgia Ethics Commission",
  MISSOURI_MEC: "Missouri Ethics Commission",
  MISSISSIPPI_SOS: "Mississippi Secretary of State",
  MONTANA_COPP: "Montana Commissioner of Political Practices",
  PHOENIX_CITY_CLERK: "City of Phoenix City Clerk Department",
  SAN_DIEGO_CITY_CLERK: "City of San Diego Office of the City Clerk",
  SAN_FRANCISCO_ETHICS: "San Francisco Ethics Commission",
  SAN_JOSE_CITY_CLERK: "City of San José Office of the City Clerk",
  SOUTH_CAROLINA_CAMPAIGN_FINANCE: "South Carolina State Ethics Commission",
  UTAH_DISCLOSURES: "Utah Financial Disclosures",
  HAWAII_CSC: "Hawaii Campaign Spending Commission",
  IDAHO_SUNSHINE: "Idaho Secretary of State Sunshine Portal",
  KANSAS_SOS: "Kansas Secretary of State",
  VIRGINIA_CFREPORTS: "Virginia CFReports",
  TENNESSEE_CAMP: "Tennessee Registry of Election Finance",
  WASHINGTON_PDC: "Washington PDC",
  WEST_VIRGINIA_CFRS: "West Virginia Campaign Finance Reporting System",
  WISCONSIN_SUNSHINE: "Wisconsin Sunshine",
  MASSACHUSETTS_OCPF: "Massachusetts OCPF",
  VERMONT_CFD: "Vermont Campaign Finance",
  LOUISIANA_ETHICS: "Louisiana Ethics Administration",
  KENTUCKY_KREF: "Kentucky KREF",
  MARYLAND_CFS: "Maryland Campaign Reporting",
  MAINE_CFIS: "Maine CFIS",
  MICHIGAN_MITN: "Michigan Campaign Finance",
  ILLINOIS_SBE: "Illinois State Board of Elections",
  MINNESOTA_CFB: "Minnesota CFB",
  ALASKA_APOC: "Alaska APOC",
  ORESTAR: "Oregon ORESTAR",
  PENNSYLVANIA_DOS: "Pennsylvania Department of State",
  DISTRICT_OF_COLUMBIA_OCF: "DC Office of Campaign Finance",
  NEW_YORK_CITY_CFB: "NYC Campaign Finance Board",
  RHODE_ISLAND_ERTS: "Rhode Island Board of Elections",
};

// Copy for the "why is the candidate list empty" statuses (see
// CandidateRosterStatus in types.ts). `short` fits a ballot-card chip;
// `long` is a sentence for the election page's empty state. Unknown reasons
// (a newer backend) fall back to the generic unavailable copy so the enum
// can grow without breaking older clients.
export function formatRosterStatus(status: CandidateRosterStatus): { short: string; long: string } {
  switch (status.reason) {
    case "awaiting_official_roster":
      return {
        short: "Candidate list not final",
        long:
          "We haven't found a final candidate list from election officials for this race yet." +
          (status.check_after ? ` We'll check again after ${formatElectionDate(status.check_after)}.` : ""),
      };
    case "roster_processing":
      return {
        short: "Candidate details coming soon",
        long: "A candidate list is available — candidate profiles are being prepared.",
      };
    default:
      return {
        short: "Candidate list unavailable",
        long: "Candidate information for this race isn't available yet.",
      };
  }
}

/**
 * Joins names as "A", "A and B", or "A, B, and C" for the outside-spending
 * evidence lines. Mirrors the backend's formatShortList but returns "" when
 * empty so callers can skip the line entirely.
 */
export function formatNameList(names: readonly string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
  if (unique.length === 0) {
    return "";
  }
  if (unique.length === 1) {
    return unique[0];
  }
  if (unique.length === 2) {
    return `${unique[0]} and ${unique[1]}`;
  }
  return `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]}`;
}

/**
 * Plain-language lines for outside-spending industry evidence, one per
 * receiving committee so each organization stays paired with the group it
 * actually funded. organization_type decides the claim: "donor" rows are the
 * organization's own money; "employer" rows are individual contributions
 * aggregated by the contributor's reported employer, and must never read as
 * the company itself donating.
 */
export function formatOutsideEvidenceLines(organizations: readonly FinanceOutsideIndustryEvidence[]): string[] {
  const byCommittee = new Map<string, FinanceOutsideIndustryEvidence[]>();
  for (const organization of organizations) {
    const committee = organization.committee_name.trim();
    const rows = byCommittee.get(committee) ?? [];
    rows.push(organization);
    byCommittee.set(committee, rows);
  }
  const lines: string[] = [];
  for (const [committee, rows] of byCommittee) {
    const donorNames = formatNameList(
      rows.filter((row) => row.organization_type === "donor").map((row) => row.organization_name)
    );
    const employerNames = formatNameList(
      rows.filter((row) => row.organization_type === "employer").map((row) => row.organization_name)
    );
    const fragments: string[] = [];
    if (donorNames) {
      fragments.push(`from ${donorNames}`);
    }
    if (employerNames) {
      fragments.push(`from contributors employed by ${employerNames}`);
    }
    if (fragments.length === 0) {
      continue;
    }
    const given = committee ? `, given to ${committee}` : "";
    lines.push(`Money ${fragments.join(", and ")}${given}.`);
  }
  return lines;
}

/**
 * Orders contribution-size buckets largest-first by the leading dollar
 * amount in the label ("$5,000+" before "$1,000-$4,999" before "$1-$99").
 * Labels arrive as free text from per-source aggregators; anything without a
 * parseable amount sorts last in its original order.
 */
export function sortContributionSizeBuckets<T extends { category_name: string }>(rows: readonly T[]): T[] {
  const leadingAmount = (label: string): number => {
    const match = /([\d,]+)/.exec(label);
    if (!match) {
      return Number.NEGATIVE_INFINITY;
    }
    const value = Number(match[1].replaceAll(",", ""));
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) => leadingAmount(b.row.category_name) - leadingAmount(a.row.category_name) || a.index - b.index
    )
    .map((entry) => entry.row);
}

export function financeSourceLabel(source: string): string {
  const mapped = FINANCE_SOURCE_LABELS[source];
  if (mapped) {
    return mapped;
  }
  const spaced = source.replaceAll("_", " ").trim();
  if (spaced.length === 0) {
    return source;
  }
  return spaced
    .split(" ")
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

import {
  FINANCE_INDUSTRY_SLUGS,
  classifyFinanceLabel,
  type FinanceClassificationConfidence,
} from "./financeLabelClassifier.js";

// Groups the committees that give to candidates by the interest they speak
// for, so a long flat list of PAC checks (each capped by law at $5,000 per
// election) reads as "Oil, gas, and energy: 9 PACs, $62,000".
//
// The taxonomy is the shared industry list plus the interests that are not
// industries. Issue groups are named for the cause they state themselves, and
// opposing sides of an issue are separate rows, so no row mixes groups that
// want opposite things. Every committee is placed by the same steps:
//   1. FEC registration facts (leadership PAC, candidate committee, labor
//      organization) — no judgment involved.
//   2. The shared rule classifier, on the connected organization and then
//      the committee name.
//   3. Manual research (finance_pac_interests rows with source 'manual').
// A committee none of these place stays unclassified and is shown as such.

export const PAC_ONLY_INTEREST_SLUGS = [
  "leadership_pacs",
  "candidate_committees",
  "telecommunications",
  "automotive",
  "accounting_and_consulting",
  "tobacco",
  "beer_wine_and_spirits",
  "gambling_and_casinos",
  "gun_rights",
  "gun_control",
  "abortion_rights",
  "anti_abortion",
  "pro_israel",
  "conservative_groups",
  "progressive_groups",
  "centrist_groups",
  "womens_groups",
  "other_issue_groups",
] as const;

export const PAC_INTEREST_SLUGS = [...FINANCE_INDUSTRY_SLUGS, ...PAC_ONLY_INTEREST_SLUGS] as const;

export type PacInterestSlug = (typeof PAC_INTEREST_SLUGS)[number];

export type PacInterestSource = "fec" | "rule" | "manual" | "unknown";

export const UNCLASSIFIED_PAC_INTEREST = "unclassified";

// The card answers "which industries and causes fund this candidate", largest
// first. Money from other politicians' PACs and campaigns is not an industry
// or a cause, and unsorted PACs say nothing yet, so neither is listed. They
// stay in the table, so the split is still available to other readers.
export const PAC_INTERESTS_NOT_LISTED: readonly PacInterestSlug[] = ["leadership_pacs", "candidate_committees"];

export const PAC_INTEREST_DISPLAY_NAMES: Record<PacInterestSlug | typeof UNCLASSIFIED_PAC_INTEREST, string> = {
  technology: "Technology",
  oil_gas_energy: "Oil, gas, and energy",
  healthcare: "Healthcare",
  pharmaceuticals: "Pharmaceuticals",
  finance_investment: "Finance and investment",
  lawyers_and_legal_services: "Lawyers and legal services",
  real_estate: "Real estate",
  construction: "Construction",
  education: "Education",
  defense_aerospace: "Defense and aerospace",
  agriculture_and_food: "Agriculture and food",
  business_associations: "Business associations",
  manufacturing: "Manufacturing",
  media_entertainment: "Media and entertainment",
  retail: "Retail",
  insurance: "Insurance",
  hospitality: "Hospitality",
  transportation: "Transportation",
  waste_management: "Waste management",
  labor_unions: "Labor unions",
  environmental_group: "Environmental groups",
  leadership_pacs: "Other politicians' PACs",
  candidate_committees: "Other candidates' campaigns",
  telecommunications: "Phone, cable, and internet companies",
  automotive: "Car makers and dealers",
  accounting_and_consulting: "Accounting and consulting firms",
  tobacco: "Tobacco",
  beer_wine_and_spirits: "Beer, wine, and liquor",
  gambling_and_casinos: "Gambling and casinos",
  gun_rights: "Gun rights groups and gun makers",
  gun_control: "Gun control groups",
  abortion_rights: "Abortion rights groups",
  anti_abortion: "Anti-abortion groups",
  pro_israel: "Pro-Israel groups",
  conservative_groups: "Conservative groups",
  progressive_groups: "Progressive groups",
  centrist_groups: "Centrist groups",
  womens_groups: "Groups that back women candidates",
  other_issue_groups: "Other issue groups",
  unclassified: "Not yet sorted",
};

export function isPacInterestSlug(value: string): value is PacInterestSlug {
  return (PAC_INTEREST_SLUGS as readonly string[]).includes(value);
}

export function pacInterestDisplayName(slug: string | null): string {
  return PAC_INTEREST_DISPLAY_NAMES[(slug ?? UNCLASSIFIED_PAC_INTEREST) as PacInterestSlug] ?? PAC_INTEREST_DISPLAY_NAMES.unclassified;
}

export type PacInterestCommitteeFacts = {
  committeeName: string;
  committeeType: string | null;
  designation: string | null;
  organizationType: string | null;
  connectedOrganization: string | null;
};

export type PacInterestClassification = {
  interestSlug: PacInterestSlug | null;
  confidence: FinanceClassificationConfidence;
  source: Exclude<PacInterestSource, "manual">;
};

const CANDIDATE_COMMITTEE_TYPES = new Set(["H", "S", "P"]);

/** Steps 1 and 2 above. Returns source 'unknown' when neither places the committee. */
export function classifyPacInterest(facts: PacInterestCommitteeFacts): PacInterestClassification {
  // FEC designation D = leadership PAC; committee types H/S/P = a candidate's
  // own campaign committee; organization type L = labor organization.
  if (facts.designation === "D") {
    return { interestSlug: "leadership_pacs", confidence: "high", source: "fec" };
  }
  if (facts.committeeType && CANDIDATE_COMMITTEE_TYPES.has(facts.committeeType)) {
    return { interestSlug: "candidate_committees", confidence: "high", source: "fec" };
  }
  if (facts.organizationType === "L") {
    return { interestSlug: "labor_unions", confidence: "high", source: "fec" };
  }

  for (const label of [facts.connectedOrganization, facts.committeeName]) {
    if (!label) {
      continue;
    }
    const classification = classifyFinanceLabel({ rawLabel: label, labelType: "committee" });
    // Only exact, high-confidence rules count. The keyword patterns are too
    // loose for committee names (a run over the 2026 donors put a railroad
    // under labor unions and two medical colleges under education), and a
    // wrong interest on the card is worse than "not yet sorted".
    if (
      classification.industrySlug &&
      classification.classificationSource === "rule" &&
      classification.confidence === "high"
    ) {
      return { interestSlug: classification.industrySlug, confidence: classification.confidence, source: "rule" };
    }
  }
  return { interestSlug: null, confidence: "unknown", source: "unknown" };
}

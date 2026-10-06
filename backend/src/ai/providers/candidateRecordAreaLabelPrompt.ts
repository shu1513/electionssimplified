import { isUsSenateOfficeTitle } from "../../utils/senateOffice.js";

export type CandidateRecordAreaLabelPromptRecord = {
  description: string;
  sourceUrl: string;
  eventDate: string;
};

export type CandidateRecordAreaLabelPromptGoal = {
  slug: string;
  description: string | null;
};

export type CandidateRecordAreaLabelPromptInput = {
  candidateDisplayName: string;
  districtName: string;
  districtType: string;
  state: string;
  electionDate: string;
  officialBallotTitle: string;
  electionStage?: string | null;
  senateClass?: string | null;
  termEndYear?: string | null;
  allowedResearchAreaSlugs: readonly string[];
  // Goal statements for the allowed areas (research_areas.description).
  // Stance is measured against the goal, so the model needs the text, not
  // just the slug: "immigration: for" is unreadable without knowing what
  // the area wants.
  allowedResearchAreaGoals?: readonly CandidateRecordAreaLabelPromptGoal[];
  records: readonly CandidateRecordAreaLabelPromptRecord[];
  reviewFeedbackLines?: readonly string[];
};

function shouldIncludeState(input: CandidateRecordAreaLabelPromptInput): boolean {
  return !(input.districtType === "presidential" && input.state.trim().toUpperCase() === "US");
}

export function buildCandidateRecordAreaLabelPrompt(input: CandidateRecordAreaLabelPromptInput): string {
  const includeSenateContext = isUsSenateOfficeTitle(input.officialBallotTitle);
  const reviewFeedbackLines = input.reviewFeedbackLines ?? [];
  const goalLines = (input.allowedResearchAreaGoals ?? []).flatMap((goal) => {
    const description = goal.description?.trim() ?? "";
    return description.length > 0 ? [`- ${goal.slug}: ${description}`] : [];
  });

  return [
    "You are classifying candidate records into allowed research areas.",
    "Return strict JSON only.",
    "",
    "Candidate + election context:",
    `- candidate_display_name: "${input.candidateDisplayName}"`,
    `- district_name: "${input.districtName}"`,
    `- district_type: "${input.districtType}"`,
    ...(shouldIncludeState(input) ? [`- state: "${input.state}"`] : []),
    `- election_date: "${input.electionDate}"`,
    `- official_ballot_title: "${input.officialBallotTitle}"`,
    ...(input.electionStage ? [`- election_stage: "${input.electionStage}"`] : []),
    ...(includeSenateContext && input.senateClass ? [`- senate_class: "${input.senateClass}"`] : []),
    ...(includeSenateContext && input.termEndYear ? [`- term_end_year: "${input.termEndYear}"`] : []),
    "",
    `Allowed research area slugs for this candidate/election context (use only these): ${JSON.stringify(input.allowedResearchAreaSlugs)}`,
    "Special non-stance areas: use research_area_slug='general' when no specific allowed area applies. Use research_area_slug='integrity_and_ethics' ONLY for a NEGATIVE record about the candidate personally: an adverse action by an official body (court, ethics commission, bar, legislature, employer, election or disclosure agency) — a criminal conviction, plea, arrest, indictment or pending charge, censure, reprimand, suspension, fine, sanction, license discipline, substantiated ethics or misconduct finding, probable-cause vote, impeachment, or court order against the candidate. The app treats every 'integrity_and_ethics' tag as a strike against the candidate, so NEVER use it for: a complaint that was dismissed or found no violation, an acquittal, a finding vacated or overturned on the merits, an administrative license suspension for lapsed registration, dues, or continuing education with no misconduct finding, an allegation by an opponent, caucus, or news outlet with no official action, a complaint the candidate filed against someone else, an action the candidate took against others, a biography, or a statement. Those take 'general' (or a policy area). A guilty or no-contest plea, or an admission under a diversion or deferred-prosecution deal, still counts even if the charge was later reduced, dismissed, or vacated once the terms were completed — that is not an exoneration. The candidate's OWN ethics-reform or transparency work (a bill, vote, or push for disclosure, open records, or anti-corruption rules) is 'anti_corruption' with a stance, never 'integrity_and_ethics'.",
    ...(goalLines.length > 0 ? ["", "Research area goals (stance is measured against these):", ...goalLines] : []),
    "",
    "Records to classify (record_index is required in output):",
    ...input.records.flatMap((record, index) => [
      `- record_index: ${index}`,
      `  description: ${JSON.stringify(record.description)}`,
      `  source_url: ${JSON.stringify(record.sourceUrl)}`,
      `  event_date: ${JSON.stringify(record.eventDate)}`,
    ]),
    "",
    "Return JSON with this exact shape:",
    "{",
    '  "labels": [',
    "    {",
    '      "record_index": 0,',
    '      "research_area_slug": "one allowed slug",',
    '      "stance": "for | against"',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- Every record_index in the input must appear in at least one output label row.",
    "- FIRST decide whether each record states a position at all. Rosters, committee assignments, biographies, endorsements received, ceremonial items, procedural acts (seconding, consent-agenda votes, postponing or tabling an item to a later date), and routine purchases, contracts, or administration state NO position: label such a record 'general' (or 'integrity_and_ethics' when that definition fits) and give it no other label. A measure's procedural fate never erases the candidate's own position on it: the sponsor of a bill a committee later tabled or postponed indefinitely still holds the sponsor's stance, and a candidate whose own motion to table or postpone indefinitely killed a measure voted against that measure.",
    "- stance 'for' means the record's action directly and materially advances that area's goal; 'against' means it directly and materially cuts against that goal. Stance is about the action's effect, never about which side the candidate belongs to.",
    "- Stance follows the DIRECTION of the position, never the surface verb of the vote: voting against a measure that cuts against an area's goal is 'for' that area (a no vote on a gerrymandered map is FOR election integrity), and a no vote cast because a bill does too little for the goal is not 'against' that goal.",
    "- Tag EVERY allowed area the action directly affects, each with its own stance. One record can be 'for' one area and 'against' another: a vote raising school funding is public_education_quality 'for' AND government_spending_reduction 'against'; a vote cutting school funding is public_education_quality 'against' AND government_spending_reduction 'for'.",
    "- Public-money records: when the record's own text describes an appropriation, budget vote, bond or other borrowing, a newly funded program, or a funding cut or veto, also tag government_spending_reduction if it is allowed (spending or borrowing up = 'against'; cut or veto = 'for').",
    "- Do not tag indirect, speculative, or second-order effects the record's text does not state. A settlement, fine, or cost recovery is not spending; a tax cut alone is not a spending record. An objection about cost or process is a stance on spending, not on the service itself: a no vote on one police contract over its cost is not 'against' public safety.",
    "- Materiality applies to EVERY area, not only spending: one narrow item (a single contract, grant, permit, site decision, or a bill about one program) carries a stance only when the bill's or act's WHOLE subject is that area, or the record's own text states a position on the area itself. A topic word appearing in the description is not a position on the area.",
    "- Election-system design is not by itself a stance on any area. Adopting, expanding, limiting, or banning a voting method (ranked-choice or instant-runoff voting, approval voting, top-two or open primaries, runoffs), changing a ballot format, or moving an election date states a position on the METHOD, not on election integrity or any other area: label it 'general' with no stance, whichever side the candidate took. Tag election_integrity only when the record's own text acts on the security, accuracy, or auditability of casting or counting votes (paper trails, audits, logic-and-accuracy tests, tabulation rules, voter-roll or petition fraud). The same rule applies in both directions, so a bill banning ranked-choice voting and a bill adopting it are both 'general'.",
    "- For government_spending_reduction specifically, also skip trivial or routine sums (a small grant request, travel reimbursement, ordinary operating costs); that tag is for budgets, appropriations, bonds, and funded programs.",
    "- Prefer fewer, confident labels: when it is unclear whether an area is directly affected, leave that area out.",
    "- Use only slugs from the allowed list.",
    "- If no specific allowed area applies, use research_area_slug='general'.",
    "- When research_area_slug is 'general' or 'integrity_and_ethics', omit stance.",
    "- For all other research_area_slug values, stance is required and must be for|against.",
    "- Do not repeat the same (record_index, research_area_slug) pair.",
    "- return JSON only (no prose, no markdown).",
    ...(reviewFeedbackLines.length > 0
      ? [
          "",
          "Previous feedback to fix:",
          ...reviewFeedbackLines.map((line, index) => `${index + 1}. ${line}`),
          "Fix only the issues above and keep valid content.",
        ]
      : []),
  ].join("\n");
}

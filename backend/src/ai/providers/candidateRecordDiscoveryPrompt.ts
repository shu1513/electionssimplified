import { isUsSenateOfficeTitle } from "../../utils/senateOffice.js";
import type { ElectionContestFamily } from "../../types/election.js";
import { PLAIN_LANGUAGE_STYLE_RULES, RECORD_DESCRIPTION_SUBSTANCE_RULE } from "./promptWritingStyle.js";

export type CandidateRecordDiscoveryPromptInput = {
  candidateDisplayName: string;
  knownCurrentOffice?: string | null;
  /**
   * candidates.has_held_public_office: has this person EVER held public
   * office (research-verified, persisted by the profile stage). When set,
   * the prompt states it as fact and gives only the matching question list
   * instead of asking the model to re-derive officeholder status — the
   * 2026-07-15 incident showed self-derivation defaults everyone onto the
   * officeholder framing. NULL keeps the legacy self-decide rule.
   */
  hasHeldPublicOffice?: boolean | null;
  districtName: string;
  districtType: string;
  state: string;
  electionDate: string;
  officialBallotTitle: string;
  electionStage?: string | null;
  senateClass?: string | null;
  termEndYear?: string | null;
  discoveryContestFamily?: ElectionContestFamily | null;
  sinceDate?: string | null;
  reviewFeedbackLines?: readonly string[];
};

function shouldIncludeState(input: CandidateRecordDiscoveryPromptInput): boolean {
  return !(input.districtType === "presidential" && input.state.trim().toUpperCase() === "US");
}

export function buildCandidateRecordDiscoveryPrompt(input: CandidateRecordDiscoveryPromptInput): string {
  const includeSenateContext = isUsSenateOfficeTitle(input.officialBallotTitle);
  const useJudicialRecordObjective = input.discoveryContestFamily === "judicial_office";
  const reviewFeedbackLines = input.reviewFeedbackLines ?? [];
  // Officeholder status routes the non-judicial question list. When the
  // profile stage has answered it, state it as fact and give only the
  // matching list; only an unanswered column falls back to the self-decide
  // rule (which the 07-15 incident showed defaults toward officeholder
  // framing).
  const officeholderObjectiveRule =
    "- This candidate has held public office (verified fact — do not re-derive it). Research reliable public records covering each of: major votes and sponsored legislation; executive actions (if they ever held an executive role); court, ethics, or disciplinary proceedings, campaign finance issues, or conflicts of interest; and committees, caucuses, or organizations they led.";
  const neverHeldObjectiveRule =
    "- This candidate has NEVER held public office (verified fact — do not re-derive it, and do not use officeholder framing like votes or sponsored legislation). Research reliable public records covering each of: career record; organizations and boards they led or served on and public advocacy; and court, legal, or regulatory records.";
  const selfDecideObjectiveRule =
    "- Research reliable public records about this exact candidate. If the candidate holds or has EVER held public office, cover each of: major votes and sponsored legislation; executive actions (if they ever held an executive role); court, ethics, or disciplinary proceedings, campaign finance issues, or conflicts of interest; and committees, caucuses, or organizations they led. If they never held public office: career record; organizations and boards they led or served on and public advocacy; and court, legal, or regulatory records.";
  const objectiveRule = useJudicialRecordObjective
    ? "- Research the web for publicly available reliable records about this exact judicial candidate, covering each of: notable cases or rulings they handled (as judge, or as prosecutor/defense/counsel before taking the bench); any discipline, ethics complaints, reversals, or conduct-commission proceedings; and endorsements they made or received. Focus on evidence for evaluating legal competence, integrity and ethics, impartiality, and professional record."
    : input.hasHeldPublicOffice === true
      ? officeholderObjectiveRule
      : input.hasHeldPublicOffice === false
        ? neverHeldObjectiveRule
        : selfDecideObjectiveRule;

  return [
    "You are researching substantive public records about one election candidate.",
    "Focus on records that evaluate fitness/competence for this office and the candidate's background relevant to office duties.",
    "Return strict JSON only.",
    "",
    "Candidate + election context:",
    `- candidate_display_name: "${input.candidateDisplayName}"`,
    ...(input.knownCurrentOffice?.trim()
      ? [`- known_current_office: "${input.knownCurrentOffice.trim()}"`]
      : []),
    `- district_name: "${input.districtName}"`,
    `- district_type: "${input.districtType}"`,
    ...(shouldIncludeState(input) ? [`- state: "${input.state}"`] : []),
    `- election_date: "${input.electionDate}"`,
    `- official_ballot_title: "${input.officialBallotTitle}"`,
    ...(input.discoveryContestFamily ? [`- discovery_contest_family: "${input.discoveryContestFamily}"`] : []),
    ...(input.electionStage ? [`- election_stage: "${input.electionStage}"`] : []),
    ...(includeSenateContext && input.senateClass ? [`- senate_class: "${input.senateClass}"`] : []),
    ...(includeSenateContext && input.termEndYear ? [`- term_end_year: "${input.termEndYear}"`] : []),
    ...(input.sinceDate ? [`- since_date: "${input.sinceDate}"`] : []),
    "",
    "Return JSON with this exact shape:",
    "{",
    '  "records": [',
    "    {",
    '      "description": "neutral factual description of the record",',
    '      "source_url": "https://...",',
    '      "event_date": "YYYY-MM-DD"',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    objectiveRule,
    ...(useJudicialRecordObjective
      ? [
          "- Describe what the candidate actually did in the case and its effects/impacts.",
        ]
      : []),
    ...(input.sinceDate
      ? [
          "- Include only records with event_date >= since_date. Apply the comprehensiveness and balance rules only within that window; never add older records to balance career history.",
        ]
      : []),
    "- Return the comprehensive set of substantive records across those categories, proportionate to the candidate's actual public career — do not stop at one or two representative records for a documented public figure. There is no target number of records. Substantive means it gives a voter meaningful evidence about the candidate's fitness, competence, integrity, priorities, or governing record: skip routine administrative items (minutes approvals, small routine contracts, ceremonial resolutions) and near-identical annual repeats of the same action (one budget-adoption row stands for all years), even when the vote was split, unless the candidate's vote or role there genuinely reveals a priority or stance.",
    "- Include both favorable and unfavorable records when they exist; a long public career with only one direction represented is incomplete research.",
    "- records may be an empty array if no reliable actual action/service/accountability records are found.",
    "- Official ballot, Secretary of State, election-office, or qualified-candidate listings are roster evidence, not candidate record evidence.",
    "- Do not include filing-to-run, candidacy announcements, ballot qualification, ballot listing, campaign launch, or campaign promise rows as records.",
    "- If the only reliable sources prove the person is running but do not show an actual action, public service, leadership role, vote, official decision, litigation/enforcement record, endorsement, or other accountability record, return {\"records\": []}.",
    "- Each record must include source_url and event_date.",
    "- event_date must be YYYY-MM-DD; use the action/event date when known, otherwise use the source publication date.",
    "- If neither action/event date nor publication date is available, omit that record.",
    "- Use one row per BILL or action, not per stage: a bill re-filed in later sessions, an amendment voted at first and second reading, a yearly repeat of the same vote, and a bill's final passage after its amendments are ONE row whose description tells the whole arc (\"Voted for the amendment at first reading, against its reversal at second reading, and for the final bill\"). The importer refuses repeat rows.",
    RECORD_DESCRIPTION_SUBSTANCE_RULE,
    // Identity gate. Applies to every route (officeholder, never-held,
    // self-decide, judicial), so it lives in the shared rule list. A record
    // attached to a same-named other person is the costliest error this stage
    // can ship, and no validator checks it.
    "- Every record must be about this exact person; a name match is not proof. Tie it to this candidate with a hard identifier: office or district held, employer, license or docket number, or reporting that states the identification. On a page covering several candidates, take the fact next to this candidate's name. If only the name matches, omit the record.",
    "- source_url must not be a social/UGC platform or a personal blog/self-published page (Reddit, X/Twitter, Facebook, YouTube, Medium, Substack, and similar); the importer rejects known platform domains.",
    "- For damaging claims, require official/legal sources or reputable news (the importer rejects damaging claims cited to other domains) and do not state allegations as proven facts.",
    "- A vote, sponsorship, or bill-introduction record must cite the legislature's own roll call, journal, or bill page. Advocacy scorecards and vote trackers (Vote Smart key votes, LCV, AFL-CIO, chamber of commerce, ACLU, Planned Parenthood, fiscal-alliance scorecards and similar) are leads only: the importer rejects such records cited to them, and their one-line vote summaries carry the group's framing, so restate the vote from the official page in neutral words.",
    ...PLAIN_LANGUAGE_STYLE_RULES,
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

import { PLAIN_LANGUAGE_STYLE_RULES } from "./promptWritingStyle.js";

// Length caps enforced by parseBallotMeasureAiPayload (enrichBallotMeasure.ts).
// Defined here (not there) because that module imports this one. Voters skim
// measure text on the contest page: the summary is two short sentences (what
// the measure does, then how it affects the reader) within the same 300
// characters candidate summaries get; yes/no meanings get 1-2 sentences each.
export const BALLOT_MEASURE_SUMMARY_MAX_LENGTH = 300;
export const BALLOT_MEASURE_YES_NO_MAX_LENGTH = 250;

export type BallotMeasurePromptInput = {
  districtName: string;
  districtType: string;
  state: string;
  electionDate: string;
  officialBallotTitle: string;
  seedUrls: readonly string[];
  allowedResearchAreaSlugs: readonly string[];
  reviewFeedbackLines?: readonly string[];
};

function escapeJson(value: string): string {
  return JSON.stringify(value);
}

export function buildBallotMeasuresPrompt(input: BallotMeasurePromptInput): string {
  const retrySection =
    input.reviewFeedbackLines && input.reviewFeedbackLines.length > 0
      ? [
          "",
          "Previous feedback to address:",
          ...input.reviewFeedbackLines.map((line, index) => `${index + 1}. ${line}`),
          "Fix only the issues above and keep valid content.",
        ]
      : [];

  return [
    "You are researching one ballot measure contest.",
    "Return strict JSON only.",
    "",
    "Contest context:",
    `- district_name: ${escapeJson(input.districtName)}`,
    `- district_type: ${escapeJson(input.districtType)}`,
    `- state: ${escapeJson(input.state)}`,
    `- election_date: ${escapeJson(input.electionDate)}`,
    `- official_ballot_title: ${escapeJson(input.officialBallotTitle)}`,
    "",
    "Return JSON with this exact shape:",
    "{",
    '  "official_measure_url": "https://...",',
    '  "summary": "neutral plain-language summary of the measure’s real-world policy impact if enacted",',
    '  "what_yes_means": "plain-language voter impact if YES",',
    '  "what_no_means": "plain-language voter impact if NO",',
    '  "research_area_tags": [',
    '    { "research_area_slug": "housing_affordability", "stance": "for" }',
    "  ],",
    '  "sources": ["https://..."]',
    "}",
    "",
    "Rules:",
    "- Actively search the public web for this measure.",
    "- official_measure_url must point to the source where a reader can view the full official measure text in its entirety (for example, the election authority's official measure page or official PDF text).",
    "- summary is exactly two short sentences at the reading level the style rules above set. Sentence one says what the measure does in everyday words. Sentence two says how it affects the reader: the cost, tax, service, or right that changes for them. Round dollar amounts (\"$390 million\", not \"$391.5 million\"), at most one number per sentence, no statute names, no legal terms such as \"enrolled\" or \"amend the code\".",
    `- summary must be at most ${BALLOT_MEASURE_SUMMARY_MAX_LENGTH} characters — voters skim it; cut everything that is not the main change or its effect on the reader.`,
    "- what_yes_means and what_no_means must be concrete and neutral: state what actually changes in the real world (who pays or gets what, which rule takes effect), never a restatement like 'adopts the measure' or 'the changes described'.",
    `- what_yes_means and what_no_means must each be at most 1-2 short sentences and at most ${BALLOT_MEASURE_YES_NO_MAX_LENGTH} characters.`,
    "- If the measure has a cost, include the money in the summary: what it costs the government to do (for example, total bond amount or project cost) and what it costs taxpayers (for example, tax rate change or estimated cost per household per year). Use the official fiscal estimate when one exists, and include only figures your sources state — never derive or estimate a missing figure yourself.",
    "- summary, what_yes_means, and what_no_means must pass this reader test: an average voter can tell what the measure does and whether it costs them anything.",
    "- Replace each legal or finance word with plain words, or explain it in a few words (binding arbitration -> a neutral third party decides; bond -> borrow; millage -> property tax; ordinance -> city law).",
    "- \"Levy\" only means a tax is charged. Name the tax the source describes: property tax, sales tax, or income tax. Never change the kind of tax or who pays it.",
    "- Say who pays. Public money is taxpayer money, so say taxpayers, property owners, or shoppers pay. If the reader's taxes do not change, say so.",
    "- Describe the real effect, not the title. Titles and sponsor wording can mislead. Take the effect from the fiscal note, legislative analyst, or official text.",
    "- research_area_tags describes the likely policy effect if YES wins / the measure passes.",
    '- For research_area_tags, "for" means the YES outcome advances that research area’s goal.',
    '- For research_area_tags, "against" means the YES outcome cuts against that research area’s goal.',
    "- Do not tag an area if the effect is mixed, indirect, unclear, or not meaningfully directional.",
    "- Do not use stance to describe which campaign side supports the measure.",
    "- research_area_tags must use only allowed research_area_slug values.",
    "- Do not tag from the measure title or the sponsor's framing. Tag only an effect both sides would accept as true.",
    "- Never force a tag. An empty research_area_tags array is a valid answer when no allowed area clearly applies.",
    "- sources must include the official/full-text URL and the best supporting URLs used for this research, up to 20 unique URLs.",
    ...PLAIN_LANGUAGE_STYLE_RULES,
    "- return JSON only (no prose, no markdown).",
    "",
    "Allowed research_area_slug values:",
    ...input.allowedResearchAreaSlugs.map((slug) => `- ${escapeJson(slug)}`),
    ...retrySection,
    ...(input.seedUrls.length > 0
      ? [
          "",
          "Starting reference URLs (use these first, then expand research as needed):",
          ...input.seedUrls.map((url) => `- ${escapeJson(url)}`),
        ]
      : []),
  ].join("\n");
}

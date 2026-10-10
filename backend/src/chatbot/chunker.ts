// Pure chunk extraction: BallotLookupElection (the canonical election detail
// payload, which already excludes withdrawn candidacies and deleted/merged
// candidates) → prose chunks for the chatbot index. Pure functions so the
// unit tests need no database.
//
// Content style: spell names, offices, districts, and dates out in prose —
// that is what both retrieval branches (tsvector and embeddings) match on.
// Sizes target ~150–350 tokens; CONTENT_MAX_CHARS backstops the bge-small
// 512-token cap (TEI truncates silently past it).

import { createHash } from "node:crypto";

import type {
  BallotLookupCandidate,
  BallotLookupElection,
} from "../pipeline/address/ballotLookup.js";
import type { BallotLookupFinanceSummary } from "../pipeline/address/ballotLookupFinanceShared.js";
import { CHATBOT_EMBEDDING_MODEL } from "./chatbotConfig.js";

// Bump whenever chunk text/shape changes so content hashes (and with them the
// "did anything change" comparisons in reports) never mix chunker outputs.
export const CHUNKER_VERSION = 1;

// ~350 tokens at the usual ~4 chars/token. Truncation here is visible and
// deterministic instead of silent inside TEI.
export const CONTENT_MAX_CHARS = 1400;

export type ChunkSourceType =
  | "candidate_profile"
  | "candidate_record"
  | "finance_summary"
  | "election"
  | "ballot_measure";

export type ChunkDraft = {
  sourceType: ChunkSourceType;
  /** Candidate id for candidate-scoped chunks, election id otherwise: the id
   * the server needs to build the chunk's public page URL. */
  sourceId: string;
  chunkKey: string;
  electionId: string;
  districtId: string;
  state: string;
  title: string;
  content: string;
  evidenceUrls: string[];
  contentHash: string;
};

function clampContent(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= CONTENT_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, CONTENT_MAX_CHARS - 1).trimEnd()}…`;
}

function hashContent(parts: readonly (string | null | undefined)[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ chunkerVersion: CHUNKER_VERSION, model: CHATBOT_EMBEDDING_MODEL, parts }));
  return hash.digest("hex");
}

/** "2026-11-03" → "November 3, 2026" (prose beats ISO for both search halves). */
export function formatElectionDateProse(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) {
    return isoDate;
  }
  const [, year, month, day] = match;
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const monthName = monthNames[Number.parseInt(month as string, 10) - 1] ?? month;
  return `${monthName} ${Number.parseInt(day as string, 10)}, ${year}`;
}

function describeStage(election: BallotLookupElection): string {
  return election.election_stage ? `${election.election_stage} election` : "election";
}

function describeCandidateLine(candidate: BallotLookupCandidate): string {
  const partyPart = candidate.party ? ` (${candidate.party}${candidate.is_incumbent ? ", incumbent" : ""})` : candidate.is_incumbent ? " (incumbent)" : "";
  return `${candidate.display_name}${partyPart}`;
}

function districtPhrase(election: BallotLookupElection): string {
  const district = election.district;
  // Statewide district names already read as the state ("Georgia"); avoid
  // "Georgia, GA"-style stutter while keeping the state token searchable.
  if (district.name.trim().toLowerCase() === stateNameHint(district.state)?.toLowerCase()) {
    return district.name;
  }
  return `${district.name}, ${district.state}`;
}

// Minimal abbrev → name map only for the stutter check above; unknown states
// just keep the "<name>, <abbrev>" form, which is still correct prose.
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

function stateNameHint(abbreviation: string): string | null {
  return STATE_NAMES[abbreviation] ?? null;
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function electionChunk(election: BallotLookupElection): ChunkDraft {
  const dateProse = formatElectionDateProse(election.election_date);
  const where = districtPhrase(election);
  const parts: string[] = [
    `The ${election.official_ballot_title} ${describeStage(election)} in ${where} is on ${dateProse}.`,
  ];
  if (election.office?.summary) {
    parts.push(election.office.summary);
  }
  if (election.seats_to_fill && election.seats_to_fill > 1) {
    parts.push(`${election.seats_to_fill} seats are up for election.`);
  }
  if (election.race_type === "ballot_measure") {
    parts.push(`This is a ballot measure, not a candidate race.`);
  } else if (election.candidates.length > 0) {
    parts.push(`Candidates: ${election.candidates.map(describeCandidateLine).join("; ")}.`);
  } else {
    parts.push("No candidates are listed yet.");
  }
  const content = clampContent(parts.join(" "));
  return {
    sourceType: "election",
    sourceId: election.id,
    chunkKey: `election:${election.id}`,
    electionId: election.id,
    districtId: election.district_id,
    state: election.district.state,
    title: `${election.official_ballot_title} — ${where} (${dateProse})`,
    content,
    evidenceUrls: election.sources.slice(0, 5),
    contentHash: hashContent([content]),
  };
}

function ballotMeasureChunk(election: BallotLookupElection): ChunkDraft | null {
  const measure = election.ballot_measure;
  if (!measure) {
    return null;
  }
  const dateProse = formatElectionDateProse(election.election_date);
  const where = districtPhrase(election);
  const parts: string[] = [
    `${measure.official_ballot_title} is a ballot measure in ${where} on the ${dateProse} ballot.`,
  ];
  if (measure.summary) {
    parts.push(measure.summary);
  }
  parts.push(`A yes vote means: ${measure.what_yes_means}`);
  parts.push(`A no vote means: ${measure.what_no_means}`);
  if (measure.proposed_by) {
    parts.push(`It was put on the ballot by ${measure.proposed_by.name}: ${measure.proposed_by.about}`);
  }
  if (measure.result) {
    parts.push(`The measure ${measure.result}.`);
  }
  const content = clampContent(parts.join(" "));
  const evidence = [
    ...(measure.official_measure_url ? [measure.official_measure_url] : []),
    ...measure.source_urls,
  ].slice(0, 5);
  return {
    sourceType: "ballot_measure",
    sourceId: election.id,
    chunkKey: `measure:${measure.id}`,
    electionId: election.id,
    districtId: election.district_id,
    state: election.district.state,
    title: `${measure.official_ballot_title} — ballot measure, ${where}`,
    content,
    evidenceUrls: evidence,
    contentHash: hashContent([content]),
  };
}

function candidateProfileChunk(election: BallotLookupElection, candidate: BallotLookupCandidate): ChunkDraft {
  const dateProse = formatElectionDateProse(election.election_date);
  const where = districtPhrase(election);
  const parts: string[] = [
    `${candidate.display_name}${candidate.party ? ` (${candidate.party})` : ""} is running in the ${election.official_ballot_title} ${describeStage(election)} in ${where} on ${dateProse}.`,
  ];
  if (candidate.is_incumbent) {
    parts.push(`${candidate.display_name} is the incumbent.`);
  }
  if (candidate.current_office) {
    parts.push(`Current office: ${candidate.current_office}.`);
  }
  if (candidate.summary) {
    parts.push(candidate.summary);
  }
  const content = clampContent(parts.join(" "));
  return {
    sourceType: "candidate_profile",
    sourceId: candidate.candidate_id,
    chunkKey: `profile:${candidate.candidate_id}:${election.id}`,
    electionId: election.id,
    districtId: election.district_id,
    state: election.district.state,
    title: `${candidate.display_name} — candidate, ${election.official_ballot_title} (${where})`,
    content,
    evidenceUrls: [],
    contentHash: hashContent([content]),
  };
}

function candidateRecordChunks(election: BallotLookupElection, candidate: BallotLookupCandidate): ChunkDraft[] {
  return candidate.records.map((record) => {
    const tagPart =
      record.research_area_tags.length > 0
        ? ` Topics: ${record.research_area_tags
            .map((tag) => `${tag.name}${tag.stance ? ` (${tag.stance})` : ""}`)
            .join(", ")}.`
        : "";
    const content = clampContent(
      `${candidate.display_name} record (${formatElectionDateProse(record.event_date)}): ${record.description}${tagPart}`
    );
    return {
      sourceType: "candidate_record" as const,
      sourceId: candidate.candidate_id,
      chunkKey: `record:${record.id}`,
      electionId: election.id,
      districtId: election.district_id,
      state: election.district.state,
      title: `${candidate.display_name} — record, ${formatElectionDateProse(record.event_date)}`,
      content,
      evidenceUrls: record.source_url ? [record.source_url] : [],
      contentHash: hashContent([content]),
    };
  });
}

function financeChunk(
  election: BallotLookupElection,
  candidate: BallotLookupCandidate,
  finance: BallotLookupFinanceSummary
): ChunkDraft {
  const where = districtPhrase(election);
  const direct = finance.direct_campaign;
  const amounts: string[] = [];
  if (direct.total_raised !== null) {
    amounts.push(`raised ${formatUsd(direct.total_raised)}`);
  }
  if (direct.total_spent !== null) {
    amounts.push(`spent ${formatUsd(direct.total_spent)}`);
  }
  if (direct.cash_on_hand !== null) {
    amounts.push(`has ${formatUsd(direct.cash_on_hand)} cash on hand`);
  }
  if (direct.debts_owed !== null && direct.debts_owed !== 0) {
    amounts.push(`owes ${formatUsd(direct.debts_owed)} in debts`);
  }
  const parts: string[] = [
    `Campaign finance for ${candidate.display_name} in the ${election.official_ballot_title} race in ${where} (${finance.cycle} cycle): ${
      amounts.length > 0 ? `the campaign has ${amounts.join(", ")}.` : "no totals reported yet."
    }`,
  ];
  if (direct.direct_coverage_note) {
    parts.push(direct.direct_coverage_note);
  }
  const outside = finance.outside_spending;
  if ((outside.support_total ?? 0) > 0 || (outside.oppose_total ?? 0) > 0) {
    const outsideParts: string[] = [];
    if ((outside.support_total ?? 0) > 0) {
      outsideParts.push(`${formatUsd(outside.support_total as number)} supporting`);
    }
    if ((outside.oppose_total ?? 0) > 0) {
      outsideParts.push(`${formatUsd(outside.oppose_total as number)} opposing`);
    }
    parts.push(`Outside groups reported ${outsideParts.join(" and ")} the candidate.`);
  }
  const topOccupations = direct.top_occupations.slice(0, 3).map((entry) => entry.category_name);
  if (topOccupations.length > 0) {
    parts.push(`Top donor occupations: ${topOccupations.join(", ")}.`);
  }
  const content = clampContent(parts.join(" "));
  return {
    sourceType: "finance_summary",
    sourceId: candidate.candidate_id,
    chunkKey: `finance:${candidate.candidate_id}:${election.id}`,
    electionId: election.id,
    districtId: election.district_id,
    state: election.district.state,
    title: `${candidate.display_name} — campaign finance, ${election.official_ballot_title} (${where})`,
    content,
    evidenceUrls: [],
    contentHash: hashContent([content]),
  };
}

/** Every chunk for one election detail payload. Deterministic order. */
export function extractChunksFromElection(election: BallotLookupElection): ChunkDraft[] {
  const chunks: ChunkDraft[] = [electionChunk(election)];
  const measure = ballotMeasureChunk(election);
  if (measure) {
    chunks.push(measure);
  }
  for (const candidate of election.candidates) {
    chunks.push(candidateProfileChunk(election, candidate));
    chunks.push(...candidateRecordChunks(election, candidate));
    if (candidate.finance_summary) {
      chunks.push(financeChunk(election, candidate, candidate.finance_summary));
    }
  }
  return chunks;
}

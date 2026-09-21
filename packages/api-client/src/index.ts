// Platform-neutral VoteApp API layer shared by the web frontend and the
// mobile app: typed contracts, the fetch wrapper, TanStack Query hooks, and
// pure formatting/scoring helpers. Nothing in here may touch browser-only
// globals (window, document, *Storage) — platform seams stay in each app.
// Web-standard globals the mobile runtime must polyfill at startup:
// crypto.randomUUID (useAddressSuggestions; expo-crypto provides it).

export * from "./stockTrades";
export * from "./types";
export * from "./autoPick";
export * from "./ballotFilters";
export * from "./ballotLevel";
export * from "./brand";
export * from "./chatbot";
export * from "./client";
export * from "./finance";
export * from "./format";
export * from "./legalCopy";
export * from "./measureFunding";
export * from "./partyBucket";
export * from "./partyLabel";
export * from "./pickProgress";
export * from "./profileLinks";
export * from "./railSort";
export * from "./rankedResearchAreas";
export * from "./researchAreaPriority";
export * from "./researchAreaScoring";
export * from "./retention";
export * from "./resultBadges";
export * from "./useAddressSuggestions";
export * from "./useCandidateSearch";
export * from "./useElectionChoices";
export * from "./useFollows";
export * from "./useMe";
export * from "./useMyAccountDistricts";
export * from "./useMyResearchAreas";
export * from "./usePickCardShare";

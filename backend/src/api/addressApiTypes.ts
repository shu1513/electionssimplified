import type { BallotLookupElection, CandidateElectionFinanceResult } from "../pipeline/address/ballotLookup.js";
// [ballot-personalized-ordering] see ballotElectionOrdering.ts for removal notes
import type {
  BallotSummaryOptions,
  OrderedBallotSummaryResult,
} from "../pipeline/address/ballotElectionOrdering.js";
import type { UserBallotPreferences } from "../pipeline/users/userBallotPreferences.js";
import type { SitemapSelection } from "../pipeline/sitemap/siteSitemap.js";
import type { BrowseDistrictResult, BrowseStateResult, BrowseStatesResult } from "./browseCatalog.js";
import type { SiteStatsResult } from "./siteStats.js";
import type { UserEmailPreferences } from "../pipeline/users/userEmailPreferences.js";
import type { RegisterUserPushTokenInput } from "../pipeline/users/userPushTokens.js";
import type { CreatedContentReport, ContentReportInput } from "../pipeline/reports/contentReports.js";
import type { UsageEventRow } from "../usage/events.js";
import type { UserIdentity } from "../pipeline/users/userIdentity.js";
import type { AddressResolutionResult } from "../pipeline/address/addressResolverService.js";
import type { AddressSuggestion, RetrievedSuggestedAddress } from "../pipeline/address/googlePlacesAutocomplete.js";
import type { CandidateDetailResult } from "../pipeline/candidates/candidateDetailReader.js";
import type { CandidateSearchResult } from "../pipeline/candidates/candidateSearchReader.js";
import type { AuthSessionCookieOptions } from "../auth/authCookies.js";
import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedAddressDistrictUpdateResult } from "../pipeline/users/userAddressDistrictUpdater.js";
import type { InitializeUserDistrictsResult } from "../pipeline/users/userDistrictInitializer.js";
import type {
  UserCandidateFollowInput,
  UserCandidateFollowsResult,
  UserCandidateFollowUpdateResult,
} from "../pipeline/users/userCandidateFollows.js";
import type {
  UserElectionChoiceInput,
  UserElectionChoicesResult,
  UserElectionChoiceUpdateResult,
} from "../pipeline/users/userElectionChoices.js";
import type { ApplyAutoPicksInput, AutoPicksResult, ClearAutoPicksResult } from "../pipeline/users/autoPick.js";
import type { PublicPickCard, UserPickCardShare } from "../pipeline/users/userPickCardShares.js";
import type {
  ResearchAreaCatalogResult,
  UserResearchAreaPreferenceInput,
  UserResearchAreaPreferencesResult,
} from "../pipeline/users/userResearchAreaPreferences.js";
import type { AskResponse } from "../chatbot/askService.js";
import type { ChatbotAskContext } from "./apiValidation.js";
import type { AddressApiClientIpInput } from "./addressApiClientIp.js";
import type { EmailUnsubscribePreference } from "./apiValidation.js";
import type { AddressResolutionDiagnostics } from "./addressApiResponses.js";
import type { StateVotingResourcesResult } from "./stateVotingResources.js";
import type {
  MembershipAmountInput,
  MembershipCheckoutInput,
  MembershipPortalInput,
  MembershipStatusResult,
} from "./membership/membershipService.js";

export type { ResearchAreaCatalogItem, ResearchAreaCatalogResult } from "../pipeline/users/userResearchAreaPreferences.js";
export type { StateVotingResources, StateVotingResourcesResult } from "./stateVotingResources.js";

export type AuthenticatedAddressUpdateResult = AuthenticatedAddressDistrictUpdateResult;

export type AuthenticatedResearchAreaPreferencesResult = UserResearchAreaPreferencesResult;

export type AuthenticatedCandidateFollowsResult = UserCandidateFollowsResult;

export type AuthenticatedCandidateFollowUpdateResult = UserCandidateFollowUpdateResult;

export type AuthenticatedElectionChoicesResult = UserElectionChoicesResult;

export type AuthenticatedPickCardShareResult = { share: UserPickCardShare };

export type AuthenticatedPickCardSharesResult = { shares: UserPickCardShare[] };

export type AuthenticatedPickCardShareDeleteResult = { deleted: boolean };

export type PublicPickCardResult = PublicPickCard;

export type AuthenticatedElectionChoiceUpdateResult = UserElectionChoiceUpdateResult;

export type AddressApiRateLimitInput = {
  clientIp: string;
  method: string;
  pathname: string;
};

export type AddressApiRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds?: number;
};

export type AuthApiRateLimitInput = {
  clientIp: string;
  /** Per-identity bucket key (an email, or a userId for logged-in
   * password-verifying endpoints). null = no per-identity credential behind
   * the endpoint (Google sign-in verifies signed tokens, not guessable
   * secrets), so only the per-IP bucket applies. */
  email: string | null;
  method: string;
  pathname: string;
};

export type AuthApiRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds?: number;
};

export type AddressApiServerOptions = {
  authService?: AuthService;
  resolveAddress: (
    address: string,
    coordinates?: { lat: number; lng: number },
    allowPartial?: boolean,
    regionState?: string,
    regionLocality?: string
  ) => Promise<AddressResolutionResult>;
  suggestAddresses?: (input: { input: string; sessionToken: string }) => Promise<AddressSuggestion[]>;
  retrieveSuggestedAddress?: (input: { placeId: string; sessionToken: string }) => Promise<RetrievedSuggestedAddress>;
  // [ballot-personalized-ordering]: options + ordered result; on feature
  // removal these become (districtIds) => Promise<BallotSummaryResult>.
  lookupBallotSummaries?: (
    districtIds: readonly string[],
    options?: BallotSummaryOptions
  ) => Promise<OrderedBallotSummaryResult>;
  lookupAuthenticatedBallotSummaries?: (
    userId: string,
    options?: BallotSummaryOptions
  ) => Promise<OrderedBallotSummaryResult>;
  lookupAuthenticatedUserEmailVerified?: (userId: string) => Promise<boolean>;
  lookupCandidateDetail?: (candidateId: string, userId?: string | null) => Promise<CandidateDetailResult | null>;
  /** GET /api/candidates/search?q= — public name typeahead. */
  searchCandidates?: (query: string) => Promise<CandidateSearchResult>;
  lookupElectionDetail?: (electionId: string) => Promise<BallotLookupElection | null>;
  /** GET /api/elections/:election_id/candidates/:candidate_id/finance —
   * one candidate's finance summary without the full election payload.
   * null = election or candidate/election pairing not found (404). */
  lookupCandidateElectionFinance?: (electionId: string, candidateId: string) => Promise<CandidateElectionFinanceResult | null>;
  /** POST /api/chatbot/ask — retrieval-only "Ask" pipeline
   * (docs/plans/chatbot-rag.md). Wired only when CHATBOT_ENABLED; the
   * endpoint 404s when absent so the kill switch fully hides the feature.
   * Verified-account-gated in the handler; context carries the candidate or
   * election page the user is (or was last) looking at. */
  askChatbot?: (
    question: string,
    previousQuestion?: string | null,
    context?: ChatbotAskContext | null,
    userId?: string | null
  ) => Promise<AskResponse>;
  /** POST /api/chatbot/feedback — 👍/👎 on an answer, keyed by the opaque
   * feedback_token the ask response carried. Wired together with askChatbot
   * (404 when absent). "invalid_token" → 400. */
  submitChatbotFeedback?: (token: string, verdict: "up" | "down") => Promise<"ok" | "invalid_token">;
  /**
   * Readiness probe for /api/healthz: resolves when the database answers a
   * trivial query within the probe's own deadline, rejects otherwise. Left
   * unset, the route answers 503 so a misconfigured deployment cannot look
   * healthy.
   */
  checkDatabaseHealth?: () => Promise<void>;
  listResearchAreas?: () => Promise<ResearchAreaCatalogResult>;
  /** GET /api/state-resources?state=CA — public official how-to-vote links
   * for one state. null = state not in state_resources (404). */
  getStateVotingResources?: (stateAbbreviation: string) => Promise<StateVotingResourcesResult | null>;
  /** GET /api/browse/states, /api/browse/states/:state, /api/browse/districts/:id
   * — the public browse catalog (browseCatalog.ts). null = 404. */
  listBrowseStates?: () => Promise<BrowseStatesResult>;
  getBrowseState?: (state: string) => Promise<BrowseStateResult | null>;
  getBrowseDistrict?: (districtId: string) => Promise<BrowseDistrictResult | null>;
  /** GET /sitemap.xml — the sitemap index; ?part=…&page=… — one child
   * file. null = the child does not exist (404). */
  getSitemapXml?: (selection?: SitemapSelection | null) => Promise<string | null>;
  /** GET /api/stats — coverage statistics (siteStats.ts). */
  getSiteStats?: () => Promise<SiteStatsResult>;
  /** GET /api/indexnow-key.txt — the IndexNow key (INDEXNOW_KEY), served
   * as text/plain so search engines can verify URL submissions. Unset =
   * 404, which is IndexNow's "not participating". */
  indexNowKey?: string;
  listAuthenticatedCandidateFollows?: (userId: string) => Promise<AuthenticatedCandidateFollowsResult>;
  setAuthenticatedCandidateFollow?: (
    userId: string,
    input: UserCandidateFollowInput
  ) => Promise<AuthenticatedCandidateFollowUpdateResult>;
  /** GET|PUT /api/me/election-choices — the session holder's planned votes.
   * Auth-gated but not verification-gated. */
  listAuthenticatedElectionChoices?: (userId: string) => Promise<AuthenticatedElectionChoicesResult>;
  setAuthenticatedElectionChoice?: (
    userId: string,
    input: UserElectionChoiceInput
  ) => Promise<AuthenticatedElectionChoiceUpdateResult>;
  /** POST /api/me/auto-picks — runs the auto-pick engine ("Pick for me")
   * over the given elections. Same auth posture as election choices. */
  applyAuthenticatedAutoPicks?: (userId: string, input: ApplyAutoPicksInput) => Promise<AutoPicksResult>;
  /** DELETE /api/me/auto-picks — one-statement clear of every auto pick on
   * the user's upcoming elections. Same auth posture. */
  clearAuthenticatedAutoPicks?: (userId: string, electionDate?: string) => Promise<ClearAutoPicksResult>;
  /** POST /api/me/pick-card-shares — mint (or return) the share token for one
   * date's pick card. Auth-gated, not verification-gated. */
  createAuthenticatedPickCardShare?: (userId: string, electionDate: string) => Promise<AuthenticatedPickCardShareResult>;
  /** GET /api/me/pick-card-shares — every live share link the user holds. */
  listAuthenticatedPickCardShares?: (userId: string) => Promise<AuthenticatedPickCardSharesResult>;
  /** DELETE /api/me/pick-card-shares?election_date= — revoke one date's
   * link; the public URL stops resolving. Same auth posture as minting. */
  deleteAuthenticatedPickCardShare?: (
    userId: string,
    electionDate: string
  ) => Promise<AuthenticatedPickCardShareDeleteResult>;
  /** GET /api/pick-cards/:token — public tokenized read; null = 404. */
  lookupPublicPickCard?: (token: string) => Promise<PublicPickCardResult | null>;
  // [ballot-personalized-ordering]
  getAuthenticatedBallotPreferences?: (userId: string) => Promise<UserBallotPreferences>;
  setAuthenticatedBallotPreferences?: (
    userId: string,
    preferences: UserBallotPreferences
  ) => Promise<UserBallotPreferences>;
  /**
   * GET /api/me: identity for the session holder. Unlike the other /api/me
   * handlers this is not gated on email verification — an unverified user
   * must be able to learn that they are unverified.
   */
  getAuthenticatedUser?: (userId: string) => Promise<UserIdentity>;

  /** Records the session holder's acceptance of the current terms version
   * after a version bump; apiServer validates the version before calling. */
  acceptAuthenticatedUserTerms?: (userId: string, termsVersion: string) => Promise<UserIdentity>;
  /** PUT /api/me: profile name edit; returns the updated identity. */
  updateAuthenticatedUserFirstName?: (userId: string, firstName: string) => Promise<UserIdentity>;
  getAuthenticatedEmailPreferences?: (userId: string) => Promise<UserEmailPreferences>;
  setAuthenticatedEmailPreferences?: (
    userId: string,
    preferences: UserEmailPreferences
  ) => Promise<UserEmailPreferences>;
  /** GET /api/me/membership — the session holder's support-payment state
   * (docs/plans/membership-contributions.md). Absent when Stripe is not
   * configured; the handler then answers { enabled: false } and the frontend
   * hides the section. */
  getAuthenticatedMembership?: (userId: string) => Promise<MembershipStatusResult>;
  /** POST /api/me/membership/checkout — creates a Stripe Checkout session
   * and returns its redirect URL. Absent (404) when Stripe is unconfigured. */
  createAuthenticatedMembershipCheckout?: (userId: string, input: MembershipCheckoutInput) => Promise<{ url: string }>;
  /** POST /api/me/membership/portal — Stripe billing-portal session URL.
   * null = the user has no billing customer yet (404). */
  createAuthenticatedMembershipPortal?: (userId: string, input: MembershipPortalInput) => Promise<{ url: string } | null>;
  /** POST /api/me/membership/cancel — period-end cancel of the live
   * membership; answers the fresh status (docs/plans/membership-manage-page.md). */
  cancelAuthenticatedMembership?: (userId: string) => Promise<MembershipStatusResult>;
  /** POST /api/me/membership/resume — clears a scheduled cancel; answers
   * the fresh status. */
  resumeAuthenticatedMembership?: (userId: string) => Promise<MembershipStatusResult>;
  /** POST /api/me/membership/amount — requests a new monthly amount from a
   * future renewal (nothing charged today); answers the fresh status. */
  changeAuthenticatedMembershipAmount?: (userId: string, input: MembershipAmountInput) => Promise<MembershipStatusResult>;
  /** POST /api/stripe/webhook — signature-verified Stripe event intake.
   * "bad_signature" → 400; thrown errors → 5xx so Stripe redelivers. */
  handleStripeWebhookEvent?: (input: {
    rawBody: Buffer;
    signatureHeader: string | null;
  }) => Promise<"ok" | "bad_signature">;
  /** POST /api/me/push-tokens: registers/refreshes a mobile device token. */
  registerAuthenticatedPushToken?: (userId: string, input: RegisterUserPushTokenInput) => Promise<void>;
  /** DELETE /api/me/push-tokens: soft-revokes the caller's device token. */
  revokeAuthenticatedPushToken?: (userId: string, expoPushToken: string) => Promise<void>;
  /**
   * Signed-token email unsubscribe (no session). mode "confirm" only
   * verifies the token (GET renders a confirmation form and must not mutate:
   * mail scanners and prefetchers GET every link in email bodies); mode
   * "execute" turns the given preferences off. The preferences name which
   * opt-ins to disable ("digest" = candidate-follow digest and result
   * alerts, "new_election_alerts" = district new-election alerts,
   * "election_reminders" = day-before election reminders,
   * "issue_updates" = operator-sent issue broadcasts, "member_newsletter" =
   * member newsletters); they ride the URL and the confirmation form
   * unsigned, which is safe because the link holder is the inbox owner and
   * can only turn preferences OFF. Never called with an empty list. Returns
   * "ok" or "invalid_token"; a valid token for a since-deleted user reports
   * "ok" so the page does not leak account state.
   */
  unsubscribeFromEmailNotifications?: (
    token: string,
    mode: "confirm" | "execute",
    preferences: readonly EmailUnsubscribePreference[]
  ) => Promise<"ok" | "invalid_token">;
  /**
   * Public site origin (e.g. https://electionssimplified.com) used to link
   * the unsubscribe pages to /me/settings. Omit to render the pages without
   * a settings link.
   */
  publicSiteOrigin?: string;
  listAuthenticatedResearchAreaPreferences?: (userId: string) => Promise<AuthenticatedResearchAreaPreferencesResult>;
  replaceAuthenticatedResearchAreaPreferences?: (
    userId: string,
    preferences: readonly UserResearchAreaPreferenceInput[]
  ) => Promise<AuthenticatedResearchAreaPreferencesResult>;
  updateAuthenticatedAddressDistricts?: (userId: string, address: string) => Promise<AuthenticatedAddressUpdateResult>;
  /** GET /api/me/districts — the saved-address district ids alone, without
   * the full ballot payload (docs/plans/pick-district-gate.md). Empty means
   * no saved address. */
  listAuthenticatedDistrictIds?: (userId: string) => Promise<string[]>;
  initializeUserDistricts?: (
    input: {
      userId: string;
      districtIds: readonly string[];
    }
  ) => Promise<InitializeUserDistrictsResult>;
  allowedOrigins?: readonly string[];
  authSessionCookieOptions?: Omit<AuthSessionCookieOptions, "maxAgeSeconds">;
  logDiagnostics?: (diagnostics: AddressResolutionDiagnostics) => void;
  /** Called for unexpected (mapped-500) errors after the local log line;
   * the error-monitoring hook. Must not throw. */
  captureUnexpectedError?: (error: unknown, context: { requestId: string; method: string; path: string }) => void;
  rateLimit?: (input: AddressApiRateLimitInput) => AddressApiRateLimitResult;
  authRateLimit?: (input: AuthApiRateLimitInput) => AuthApiRateLimitResult;
  contentReportRateLimit?: (input: AddressApiRateLimitInput) => AddressApiRateLimitResult;
  createContentReport?: (input: ContentReportInput) => Promise<CreatedContentReport>;
  /** POST /api/usage/events — first-party usage analytics intake
   * (docs/plans/usage-analytics.md). Absent (404) when USAGE_ANALYTICS_ENABLED
   * is off. Receives catalog-validated rows only; `dropped` is the count of
   * rejected events for the operator log — never their contents. */
  recordUsageEvents?: (rows: readonly UsageEventRow[], dropped: number) => Promise<void>;
  resolveClientIp?: (input: AddressApiClientIpInput) => string;
  resolveAuthenticatedUserId?: (input: {
    headers: AddressApiClientIpInput["headers"];
  }) => string | null | Promise<string | null>;
};

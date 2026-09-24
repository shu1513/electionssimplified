import { MAX_INITIALIZE_DISTRICT_IDS } from "../constants/userDistricts.js";
// [ballot-personalized-ordering] see ballotElectionOrdering.ts for removal notes
import {
  BALLOT_SUMMARY_SORTS,
  SAVEABLE_BALLOT_PREFERENCE_SORTS,
  isBallotSummarySort,
  type BallotSummaryOptions,
  type BallotSummarySort,
} from "../pipeline/address/ballotElectionOrdering.js";
import { GOOGLE_PLACE_ID_PATTERN } from "../pipeline/address/googlePlacesAutocomplete.js";
import type { UserCandidateFollowInput } from "../pipeline/users/userCandidateFollows.js";
import { MAX_AUTO_PICK_ELECTION_IDS, type ApplyAutoPicksInput } from "../pipeline/users/autoPick.js";
import type { UserElectionChoiceInput } from "../pipeline/users/userElectionChoices.js";
import type { UserResearchAreaPreferenceInput } from "../pipeline/users/userResearchAreaPreferences.js";
import type { UserBallotPreferences } from "../pipeline/users/userBallotPreferences.js";
import type { UserEmailPreferences } from "../pipeline/users/userEmailPreferences.js";
import type { RegisterUserPushTokenInput } from "../pipeline/users/userPushTokens.js";
import { CONTENT_REPORT_ENTITY_TYPES, type ContentReportEntityType } from "../pipeline/reports/contentReports.js";
import { MAX_FIRST_NAME_LENGTH } from "../pipeline/users/userIdentity.js";
import { UUID_PATTERN, isUuid } from "../utils/uuid.js";
import { RequestValidationError } from "../utils/requestValidationError.js";

export { MAX_INITIALIZE_DISTRICT_IDS } from "../constants/userDistricts.js";
export { UUID_PATTERN } from "../utils/uuid.js";

export const ADDRESS_AUTOCOMPLETE_PATH = "/api/address/autocomplete";
export const ADDRESS_AUTOCOMPLETE_RETRIEVE_PATH = "/api/address/autocomplete/retrieve";
export const ADDRESS_RESOLVE_PATH = "/api/address/resolve";
export const AUTH_FORGOT_PASSWORD_PATH = "/api/auth/forgot-password";
// Sign in with Google (docs/plans/google-sign-in.md): exchanges a verified
// Google ID token for a session. Configured-if-present, like the Places
// proxy — 500 not-configured without GOOGLE_OAUTH_CLIENT_ID.
export const AUTH_GOOGLE_PATH = "/api/auth/google";
export const AUTH_LOGIN_PATH = "/api/auth/login";
export const AUTH_LOGOUT_PATH = "/api/auth/logout";
export const AUTH_REGISTER_PATH = "/api/auth/register";
export const AUTH_RESET_PASSWORD_PATH = "/api/auth/reset-password";
export const AUTH_RESEND_VERIFICATION_PATH = "/api/auth/resend-verification";
export const AUTH_VERIFY_EMAIL_PATH = "/api/auth/verify-email";
export const AUTH_VERIFY_EMAIL_CHANGE_PATH = "/api/auth/verify-email-change";
export const AUTH_LOGOUT_ALL_PATH = "/api/auth/logout-all";
export const BALLOT_LOOKUP_PATH = "/api/ballot";
// Chatbot "Ask" (docs/plans/chatbot-rag.md). The path is always known;
// whether it answers depends on CHATBOT_ENABLED wiring (404 when unwired,
// mirroring the sitemap's not-configured behavior).
export const CHATBOT_ASK_PATH = "/api/chatbot/ask";
// Same CHATBOT_ENABLED wiring: 404 when unwired.
export const CHATBOT_FEEDBACK_PATH = "/api/chatbot/feedback";
export const CONTENT_REPORTS_PATH = "/api/content-reports";
export const USAGE_EVENTS_PATH = "/api/usage/events";
export const CANDIDATE_DETAIL_PATH_PREFIX = "/api/candidates/";
// Shares the candidate-detail prefix, so the router must test this path
// before isCandidateDetailPath (whose UUID parse would reject "search").
export const CANDIDATE_SEARCH_PATH = "/api/candidates/search";
export const ELECTION_DETAIL_PATH_PREFIX = "/api/elections/";
// Session-holder identity (email, first_name, email_verified). Not gated on
// email verification: the frontend needs it to render the unverified state.
export const ME_PATH = "/api/me";
export const ME_ADDRESS_PATH = "/api/me/address";
// Authenticated re-acceptance of the current terms bundle after a version
// bump (registration handles first acceptance). Not gated on email
// verification: acceptance must be recordable before the inbox is confirmed.
export const ME_TERMS_ACCEPTANCE_PATH = "/api/me/terms-acceptance";
export const ME_PASSWORD_PATH = "/api/me/password";
export const ME_EMAIL_PATH = "/api/me/email";
export const ME_BALLOT_PATH = "/api/me/ballot";
export const ME_CANDIDATE_FOLLOWS_PATH = "/api/me/candidate-follows";
// Per-election planned vote ("my choice"). Auth-gated but not
// verification-gated: a choice is private planning, it triggers no
// notifications, so a registered session is enough.
export const ME_ELECTION_CHOICES_PATH = "/api/me/election-choices";
// POST runs the auto-pick engine ("Pick for me") over the given elections.
// Same auth posture as election choices: session required, no verification
// gate — the results are private planning.
export const ME_AUTO_PICKS_PATH = "/api/me/auto-picks";
// POST mints (or returns) the share link for one date's pick card. Same
// auth posture as election choices: session required, no verification gate.
export const ME_PICK_CARD_SHARES_PATH = "/api/me/pick-card-shares";
// Public tokenized read of a shared pick card; no session auth — the token
// IS the authorization (see user_pick_card_shares migration).
export const PICK_CARD_PATH_PREFIX = "/api/pick-cards/";
export const ME_DISTRICTS_PATH = "/api/me/districts";
export const ME_DISTRICTS_INITIALIZE_PATH = "/api/me/districts/initialize";
export const ME_RESEARCH_AREA_PREFERENCES_PATH = "/api/me/research-area-preferences";
// [ballot-personalized-ordering]
export const ME_BALLOT_PREFERENCES_PATH = "/api/me/ballot-preferences";
export const ME_EMAIL_PREFERENCES_PATH = "/api/me/email-preferences";
// Mobile device push-token registration (POST registers/refreshes, DELETE
// revokes). Bearer-authed like every other /api/me route.
export const ME_PUSH_TOKENS_PATH = "/api/me/push-tokens";
// Support payments / membership (docs/plans/membership-contributions.md,
// docs/plans/membership-manage-page.md). GET answers { enabled: false } when
// Stripe isn't configured; the POSTs 404 like the chatbot paths so the
// feature stays hidden.
export const ME_MEMBERSHIP_PATH = "/api/me/membership";
export const ME_MEMBERSHIP_CHECKOUT_PATH = "/api/me/membership/checkout";
export const ME_MEMBERSHIP_PORTAL_PATH = "/api/me/membership/portal";
export const ME_MEMBERSHIP_CANCEL_PATH = "/api/me/membership/cancel";
export const ME_MEMBERSHIP_RESUME_PATH = "/api/me/membership/resume";
export const ME_MEMBERSHIP_AMOUNT_PATH = "/api/me/membership/amount";
// Stripe webhook: signature-verified raw body, no session auth, exempt from
// the per-IP rate limiter (Stripe's shared delivery IPs would 429).
export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";
// Signed-token unsubscribe target linked from notification emails; GET for
// humans, POST for RFC 8058 one-click mailbox buttons. No session auth. The
// optional pref query param picks which opt-in the link disables.
export const EMAIL_UNSUBSCRIBE_PATH = "/api/email/unsubscribe";
export const EMAIL_UNSUBSCRIBE_PREFERENCES = ["digest", "new_election_alerts", "election_reminders", "issue_updates", "member_newsletter"] as const;
export type EmailUnsubscribePreference = (typeof EMAIL_UNSUBSCRIBE_PREFERENCES)[number];

/** Which public.users column each unsubscribe preference turns off. */
export const EMAIL_UNSUBSCRIBE_PREFERENCE_COLUMNS = {
  digest: "email_digest",
  new_election_alerts: "email_new_election_alerts",
  election_reminders: "email_election_reminders",
  issue_updates: "email_issue_updates",
  member_newsletter: "email_member_newsletter",
} as const satisfies Record<EmailUnsubscribePreference, string>;
export type EmailUnsubscribePreferenceColumn =
  (typeof EMAIL_UNSUBSCRIBE_PREFERENCE_COLUMNS)[EmailUnsubscribePreference];

/**
 * Parses pref values from the link query or the confirmation form. Blank
 * values are ignored, "all" expands to every opt-in, duplicates collapse, and
 * the result keeps canonical order. Returns [] when nothing usable was given
 * (callers decide the default) and null when any value is unrecognized: a
 * mangled link must 400 rather than flip a different opt-in than the email
 * advertised.
 */
export function parseEmailUnsubscribePreferences(
  rawValues: readonly string[]
): readonly EmailUnsubscribePreference[] | null {
  const selected = new Set<EmailUnsubscribePreference>();
  for (const rawValue of rawValues) {
    const normalized = rawValue.trim();
    if (normalized === "") {
      continue;
    }
    if (normalized === "all") {
      for (const preference of EMAIL_UNSUBSCRIBE_PREFERENCES) {
        selected.add(preference);
      }
      continue;
    }
    if (!(EMAIL_UNSUBSCRIBE_PREFERENCES as readonly string[]).includes(normalized)) {
      return null;
    }
    selected.add(normalized as EmailUnsubscribePreference);
  }
  return EMAIL_UNSUBSCRIBE_PREFERENCES.filter((preference) => selected.has(preference));
}

/**
 * Reads the confirmation form's urlencoded body. `isForm` is true only when
 * the body carries the form marker (form=1) the page renders; RFC 8058
 * one-click POSTs (body "List-Unsubscribe=One-Click") and bodiless POSTs
 * report false so they unsubscribe exactly what the link advertised.
 */
export function parseEmailUnsubscribeFormBody(body: unknown): { isForm: boolean; preferenceValues: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { isForm: false, preferenceValues: [] };
  }
  const record = body as Record<string, unknown>;
  const raw = record.pref;
  const preferenceValues = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  return { isForm: record.form === "1", preferenceValues };
}
export const API_HEALTH_PATH = "/api/healthz";
export const RESEARCH_AREAS_PATH = "/api/research-areas";
export const STATE_RESOURCES_PATH = "/api/state-resources";
// Browse catalog (state → district → race), see browseCatalog.ts.
export const BROWSE_STATES_PATH = "/api/browse/states";
export const BROWSE_STATE_PATH_PREFIX = "/api/browse/states/";
export const BROWSE_DISTRICT_PATH_PREFIX = "/api/browse/districts/";
export const SITE_SITEMAP_PATH = "/sitemap.xml";
// Coverage statistics (siteStats.ts) behind /stats.
export const SITE_STATS_PATH = "/api/stats";
// IndexNow ownership proof: the file whose body is the key, served from env
// instead of committed to frontend/public. The protocol scopes a key to the
// directory it lives in, so the PUBLIC location is the site root
// (INDEXNOW_PUBLIC_KEY_PATH); the edge Worker maps that onto this API route.
export const INDEXNOW_KEY_PATH = "/api/indexnow-key.txt";
export const INDEXNOW_PUBLIC_KEY_PATH = "/indexnow-key.txt";
export const MAX_ADDRESS_REQUEST_BODY_BYTES = 16 * 1024;
export const MAX_BALLOT_DISTRICT_IDS = 50;

export type AddressResolvePayload = {
  address: string;
};

/**
 * The anonymous search body. Unlike the saved-address payload it carries the
 * clickwrap assertion: the pre-search checkbox used to gate only the frontend
 * button, so the endpoint it guarded accepted callers who had accepted
 * nothing. apiServer checks the version against CURRENT_TERMS_VERSION and
 * refuses the search otherwise. Nothing about the acceptance is stored — the
 * visitor is anonymous, and no row naming their IP address is written.
 */
export type PublicAddressResolvePayload = AddressResolvePayload & {
  accepted_terms_version: string;
  /** Optional lat/lng from the Google Places autocomplete selection; lets the
   * resolver look districts up by point when the Census street-range data
   * lacks the address (stadiums, campuses). Absent for hand-typed input. */
  coordinates?: { lat: number; lng: number };
  /** Opt-in to the ZIP/region partial-ballot paths. Defaults false so
   * clients that predate the feature (shipped mobile builds) keep exact-only
   * behavior — they have no UI to explain a partial result. */
  allow_partial: boolean;
  /** Two-letter state from a Google region selection (retrieve response
   * `state`); routes the request to the region partial-ballot path. */
  region_state?: string;
  /** Locality name from the same region selection; only meaningful with
   * region_state — used to look for the matching incorporated place. */
  region_locality?: string;
};

export type AddressAutocompleteSuggestPayload = {
  input: string;
  session_token: string;
};

export type AddressAutocompleteRetrievePayload = {
  place_id: string;
  session_token: string;
};

// Minimum keystrokes before the proxy forwards to Google: shorter inputs give
// useless suggestions and every forwarded request has a billing cost.
export const MIN_AUTOCOMPLETE_INPUT_LENGTH = 3;
export const MAX_AUTOCOMPLETE_INPUT_LENGTH = 200;
const MIN_AUTOCOMPLETE_SESSION_TOKEN_LENGTH = 8;
const MAX_AUTOCOMPLETE_SESSION_TOKEN_LENGTH = 128;
const MAX_AUTOCOMPLETE_PLACE_ID_LENGTH = 512;
const AUTOCOMPLETE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export type AuthenticatedAddressPayload = AddressResolvePayload;

// Practical per-field ceilings so oversized junk is refused at the door
// instead of leaning on the 16 KB body limit: 254 is the longest address
// SMTP can actually deliver to (RFC 5321's 256-octet path limit minus the
// angle brackets — not the 320 the per-component limits naively sum to),
// and the address cap is far above any real street address. The first-name
// cap is not defined here: userIdentity.ts owns it (registration derives
// names under the same cap), and re-exporting keeps it one definition.
export const MAX_AUTH_EMAIL_LENGTH = 254;
export const MAX_ADDRESS_INPUT_LENGTH = 500;
export { MAX_FIRST_NAME_LENGTH };

export type AuthRegisterPayload = {
  email: string;
  password: string;
  accepted_terms_version: string;
  first_name?: string;
};

export type AuthLoginPayload = {
  email: string;
  password: string;
};

export type AuthGooglePayload = {
  /** The GIS credential response: a Google-signed ID-token JWT. */
  credential: string;
  /** Which page the button sat on; only "signup" may create an account. */
  intent: "login" | "signup";
  /** Clickwrap record, required for intent "signup". */
  accepted_terms_version?: string;
};

export type AuthForgotPasswordPayload = {
  email: string;
};

export type AuthResendVerificationPayload = AuthForgotPasswordPayload;

export type AuthVerifyEmailPayload = {
  token: string;
};

export type AuthResetPasswordPayload = {
  token: string;
  password: string;
};

export type AuthVerifyEmailChangePayload = {
  token: string;
};

export type MePasswordPayload = {
  current_password: string;
  new_password: string;
};

export type MeEmailPayload = {
  new_email: string;
  password: string;
};

export type MeDeletePayload = {
  password: string;
};

export type MeUpdatePayload = {
  first_name: string;
};

export type MeTermsAcceptancePayload = {
  accepted_terms_version: string;
};

export type InitializeUserDistrictsPayload = {
  district_ids: string[];
};

export type ContentReportPayload = {
  entityType: ContentReportEntityType;
  entityId: string;
  message: string;
  suggestedSourceUrl?: string | null;
  reporterEmail?: string | null;
};

const MAX_CONTENT_REPORT_MESSAGE_LENGTH = 2000;
const MAX_CONTENT_REPORT_SOURCE_URL_LENGTH = 2048;
const MAX_CONTENT_REPORT_EMAIL_LENGTH = 320;

export type ResearchAreaPreferencePayloadItem = {
  research_area_id: string;
  rank?: number | null;
  // Optional; omitted = keep the stored value (see UserResearchAreaPreferenceInput).
  direction?: "support" | "oppose";
  hard_veto?: boolean;
};

export type ResearchAreaPreferencesPayload = {
  preferences: UserResearchAreaPreferenceInput[];
};

export type CandidateFollowPayload = UserCandidateFollowInput;

function parseStringField(parsed: unknown, fieldName: string): string {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  const value = (parsed as Record<string, unknown>)[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RequestValidationError(`Request body must include non-empty string field: ${fieldName}`);
  }
  return value.trim();
}

function parseEmailField(parsed: unknown, fieldName: string): string {
  const email = parseStringField(parsed, fieldName);
  if (email.length > MAX_AUTH_EMAIL_LENGTH) {
    throw new RequestValidationError(`${fieldName} must be at most ${MAX_AUTH_EMAIL_LENGTH} characters`);
  }
  return email;
}

function parseAutocompleteSessionToken(parsed: unknown): string {
  const sessionToken = parseStringField(parsed, "session_token");
  if (
    sessionToken.length < MIN_AUTOCOMPLETE_SESSION_TOKEN_LENGTH ||
    sessionToken.length > MAX_AUTOCOMPLETE_SESSION_TOKEN_LENGTH ||
    !AUTOCOMPLETE_TOKEN_PATTERN.test(sessionToken)
  ) {
    throw new RequestValidationError(
      `session_token must be ${MIN_AUTOCOMPLETE_SESSION_TOKEN_LENGTH}-${MAX_AUTOCOMPLETE_SESSION_TOKEN_LENGTH} characters of letters, digits, hyphens, or underscores`
    );
  }
  return sessionToken;
}

export function parseAutocompleteSuggestBodyValue(parsed: unknown): AddressAutocompleteSuggestPayload {
  const input = parseStringField(parsed, "input");
  if (input.length < MIN_AUTOCOMPLETE_INPUT_LENGTH) {
    throw new RequestValidationError(`input must be at least ${MIN_AUTOCOMPLETE_INPUT_LENGTH} characters`);
  }
  if (input.length > MAX_AUTOCOMPLETE_INPUT_LENGTH) {
    throw new RequestValidationError(`input supports at most ${MAX_AUTOCOMPLETE_INPUT_LENGTH} characters`);
  }
  return {
    input,
    session_token: parseAutocompleteSessionToken(parsed),
  };
}

export function parseAutocompleteRetrieveBodyValue(parsed: unknown): AddressAutocompleteRetrievePayload {
  const placeId = parseStringField(parsed, "place_id");
  if (placeId.length > MAX_AUTOCOMPLETE_PLACE_ID_LENGTH) {
    throw new RequestValidationError(`place_id must be at most ${MAX_AUTOCOMPLETE_PLACE_ID_LENGTH} characters`);
  }
  // Same pattern the suggest step filters on, so any place_id we emitted is
  // accepted here.
  if (!GOOGLE_PLACE_ID_PATTERN.test(placeId)) {
    throw new RequestValidationError("place_id must contain only letters, digits, hyphens, or underscores");
  }
  return {
    place_id: placeId,
    session_token: parseAutocompleteSessionToken(parsed),
  };
}

export function parseAddressBodyValue(parsed: unknown): AddressResolvePayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const address = (parsed as { address?: unknown }).address;
  if (typeof address !== "string" || address.trim().length === 0) {
    throw new RequestValidationError("Request body must include non-empty string field: address");
  }
  const trimmed = address.trim();
  if (trimmed.length > MAX_ADDRESS_INPUT_LENGTH) {
    throw new RequestValidationError(`address must be at most ${MAX_ADDRESS_INPUT_LENGTH} characters`);
  }

  return {
    address: trimmed,
  };
}

function parseOptionalCoordinatesField(parsed: unknown): { lat: number; lng: number } | undefined {
  const coordinates = (parsed as { coordinates?: unknown }).coordinates;
  if (coordinates === undefined || coordinates === null) {
    return undefined;
  }
  if (typeof coordinates !== "object" || Array.isArray(coordinates)) {
    throw new RequestValidationError("coordinates must be an object with numeric lat and lng fields");
  }
  const { lat, lng } = coordinates as { lat?: unknown; lng?: unknown };
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    throw new RequestValidationError("coordinates must carry lat in [-90, 90] and lng in [-180, 180]");
  }
  return { lat, lng };
}

export function parsePublicAddressResolveBodyValue(parsed: unknown): PublicAddressResolvePayload {
  const { address } = parseAddressBodyValue(parsed);
  const acceptedTermsVersion = (parsed as { accepted_terms_version?: unknown }).accepted_terms_version;
  if (typeof acceptedTermsVersion !== "string" || acceptedTermsVersion.trim().length === 0) {
    throw new RequestValidationError("Request body must include non-empty string field: accepted_terms_version");
  }

  const allowPartial = (parsed as { allow_partial?: unknown }).allow_partial;
  if (allowPartial !== undefined && typeof allowPartial !== "boolean") {
    throw new RequestValidationError("allow_partial must be a boolean when present");
  }

  const regionState = (parsed as { region_state?: unknown }).region_state;
  if (regionState !== undefined && (typeof regionState !== "string" || !/^[A-Za-z]{2}$/.test(regionState))) {
    throw new RequestValidationError("region_state must be a two-letter state abbreviation when present");
  }

  const regionLocality = (parsed as { region_locality?: unknown }).region_locality;
  if (
    regionLocality !== undefined &&
    (typeof regionLocality !== "string" || regionLocality.trim().length === 0 || regionLocality.length > 120)
  ) {
    throw new RequestValidationError("region_locality must be a non-empty string of at most 120 characters when present");
  }
  if (regionLocality !== undefined && regionState === undefined) {
    throw new RequestValidationError("region_locality requires region_state");
  }

  return {
    address,
    accepted_terms_version: acceptedTermsVersion.trim(),
    coordinates: parseOptionalCoordinatesField(parsed),
    allow_partial: allowPartial ?? false,
    ...(regionState !== undefined ? { region_state: regionState.toUpperCase() } : {}),
    ...(regionLocality !== undefined ? { region_locality: regionLocality.trim() } : {}),
  };
}

export function parseAddressPayload(rawBody: string): AddressResolvePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new RequestValidationError("Request body must be valid JSON", "invalid_json");
  }

  return parseAddressBodyValue(parsed);
}

export function parseAuthenticatedAddressBodyValue(parsed: unknown): AuthenticatedAddressPayload {
  return parseAddressBodyValue(parsed);
}

function assertNoUnknownFields(record: Record<string, unknown>, allowedFields: readonly string[]): void {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(record).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new RequestValidationError(`Request body contains unknown field: ${unknown[0]}`);
  }
}

function parseOptionalStringField(record: Record<string, unknown>, fieldName: string): string | null {
  const value = record[fieldName];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new RequestValidationError(`${fieldName} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** What the user is (or was last) looking at — the chat widget sends the
 * current or most recent candidate/election page so deictic questions
 * ("tell me more about this candidate") resolve deterministically. */
export type ChatbotAskContext =
  | { kind: "candidate"; id: string }
  | { kind: "election"; id: string };

export type ChatbotAskPayload = {
  question: string;
  /** Previous user turn, for deterministic follow-up scope carry-over. */
  previousQuestion: string | null;
  context: ChatbotAskContext | null;
};

export const MAX_CHATBOT_QUESTION_LENGTH = 500;

function parseChatbotAskContext(value: unknown): ChatbotAskContext | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("context must be an object when provided");
  }
  const record = value as Record<string, unknown>;
  assertNoUnknownFields(record, ["candidate_id", "election_id"]);
  const candidateId = record.candidate_id;
  const electionId = record.election_id;
  if ((candidateId === undefined) === (electionId === undefined)) {
    throw new RequestValidationError("context must include exactly one of candidate_id or election_id");
  }
  const raw = candidateId ?? electionId;
  if (typeof raw !== "string" || !isUuid(raw.trim())) {
    throw new RequestValidationError("context id must be a valid UUID");
  }
  return candidateId !== undefined
    ? { kind: "candidate", id: raw.trim() }
    : { kind: "election", id: raw.trim() };
}

export function parseChatbotAskBodyValue(parsed: unknown): ChatbotAskPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  assertNoUnknownFields(record, ["question", "previous_question", "context"]);

  const question = parseStringField(parsed, "question");
  if (question.length > MAX_CHATBOT_QUESTION_LENGTH) {
    throw new RequestValidationError(`question must be at most ${MAX_CHATBOT_QUESTION_LENGTH} characters`);
  }

  const previousQuestion = parseOptionalStringField(record, "previous_question");
  if (previousQuestion !== null && previousQuestion.length > MAX_CHATBOT_QUESTION_LENGTH) {
    throw new RequestValidationError(`previous_question must be at most ${MAX_CHATBOT_QUESTION_LENGTH} characters`);
  }

  return { question, previousQuestion, context: parseChatbotAskContext(record.context) };
}

export type ChatbotFeedbackPayload = {
  token: string;
  verdict: "up" | "down";
};

// Mirrors MAX_FEEDBACK_TOKEN_LENGTH in chatbot/feedback.ts (not imported:
// the api layer stays decoupled from chatbot internals, matching how the
// ask body is validated here without chatbot imports).
const MAX_CHATBOT_FEEDBACK_TOKEN_LENGTH = 400;

export function parseChatbotFeedbackBodyValue(parsed: unknown): ChatbotFeedbackPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  assertNoUnknownFields(record, ["token", "verdict"]);

  const token = parseStringField(parsed, "token");
  if (token.length > MAX_CHATBOT_FEEDBACK_TOKEN_LENGTH) {
    throw new RequestValidationError(`token must be at most ${MAX_CHATBOT_FEEDBACK_TOKEN_LENGTH} characters`);
  }
  const verdict = record.verdict;
  if (verdict !== "up" && verdict !== "down") {
    throw new RequestValidationError('verdict must be "up" or "down"');
  }
  return { token, verdict };
}

export function parseContentReportBodyValue(parsed: unknown): ContentReportPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  assertNoUnknownFields(record, ["entity_type", "entity_id", "message", "suggested_source_url", "reporter_email"]);

  const rawEntityType = record.entity_type;
  if (typeof rawEntityType !== "string") {
    throw new RequestValidationError("Request body must include string field: entity_type");
  }
  const entityType = rawEntityType.trim();
  if (!(CONTENT_REPORT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw new RequestValidationError(`entity_type must be one of: ${CONTENT_REPORT_ENTITY_TYPES.join(", ")}`);
  }

  const rawEntityId = record.entity_id;
  if (typeof rawEntityId !== "string") {
    throw new RequestValidationError("Request body must include UUID string field: entity_id");
  }
  const entityId = rawEntityId.trim();
  if (!isUuid(entityId)) {
    throw new RequestValidationError(`entity_id must be a valid UUID: ${entityId}`);
  }

  const rawMessage = record.message;
  if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) {
    throw new RequestValidationError("Request body must include non-empty string field: message");
  }
  const message = rawMessage.trim();
  if (message.length > MAX_CONTENT_REPORT_MESSAGE_LENGTH) {
    throw new RequestValidationError(`message must be at most ${MAX_CONTENT_REPORT_MESSAGE_LENGTH} characters`);
  }

  const suggestedSourceUrl = parseOptionalStringField(record, "suggested_source_url");
  if (suggestedSourceUrl !== null) {
    if (suggestedSourceUrl.length > MAX_CONTENT_REPORT_SOURCE_URL_LENGTH) {
      throw new RequestValidationError(`suggested_source_url must be at most ${MAX_CONTENT_REPORT_SOURCE_URL_LENGTH} characters`);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(suggestedSourceUrl);
    } catch {
      throw new RequestValidationError("suggested_source_url must be a valid http(s) URL");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new RequestValidationError("suggested_source_url must be a valid http(s) URL");
    }
  }

  const reporterEmail = parseOptionalStringField(record, "reporter_email");
  if (reporterEmail !== null) {
    if (reporterEmail.length > MAX_CONTENT_REPORT_EMAIL_LENGTH) {
      throw new RequestValidationError(`reporter_email must be at most ${MAX_CONTENT_REPORT_EMAIL_LENGTH} characters`);
    }
    if (!/^\S+@\S+\.\S+$/.test(reporterEmail)) {
      throw new RequestValidationError("reporter_email must be a valid email address when provided");
    }
  }

  return {
    entityType: entityType as ContentReportEntityType,
    entityId,
    message,
    ...(suggestedSourceUrl === null ? {} : { suggestedSourceUrl }),
    ...(reporterEmail === null ? {} : { reporterEmail }),
  };
}

export function parseAuthRegisterBodyValue(parsed: unknown): AuthRegisterPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const email = parseEmailField(parsed, "email");
  const password = parseStringField(parsed, "password");
  // Clickwrap: registration must record which terms version was accepted.
  const acceptedTermsVersion = parseStringField(parsed, "accepted_terms_version");
  const firstName = (parsed as { first_name?: unknown }).first_name;
  if (firstName !== undefined && (typeof firstName !== "string" || firstName.trim().length === 0)) {
    throw new RequestValidationError("first_name must be a non-empty string when provided");
  }
  if (typeof firstName === "string" && firstName.trim().length > MAX_FIRST_NAME_LENGTH) {
    throw new RequestValidationError(`first_name must be at most ${MAX_FIRST_NAME_LENGTH} characters`);
  }

  return {
    email,
    password,
    accepted_terms_version: acceptedTermsVersion,
    ...(firstName === undefined ? {} : { first_name: firstName.trim() }),
  };
}

export function parseAuthLoginBodyValue(parsed: unknown): AuthLoginPayload {
  return {
    email: parseEmailField(parsed, "email"),
    password: parseStringField(parsed, "password"),
  };
}

export function parseAuthGoogleBodyValue(parsed: unknown): AuthGooglePayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const credential = parseStringField(parsed, "credential");
  const intent = (parsed as { intent?: unknown }).intent;
  if (intent !== "login" && intent !== "signup") {
    throw new RequestValidationError('intent must be "login" or "signup"');
  }
  const acceptedTermsVersion = (parsed as { accepted_terms_version?: unknown }).accepted_terms_version;
  if (
    acceptedTermsVersion !== undefined &&
    (typeof acceptedTermsVersion !== "string" || acceptedTermsVersion.trim().length === 0)
  ) {
    throw new RequestValidationError("accepted_terms_version must be a non-empty string when provided");
  }

  return {
    credential,
    intent,
    ...(acceptedTermsVersion === undefined ? {} : { accepted_terms_version: acceptedTermsVersion.trim() }),
  };
}

export function parseAuthForgotPasswordBodyValue(parsed: unknown): AuthForgotPasswordPayload {
  return {
    email: parseEmailField(parsed, "email"),
  };
}

export function parseAuthResendVerificationBodyValue(parsed: unknown): AuthResendVerificationPayload {
  return parseAuthForgotPasswordBodyValue(parsed);
}

export function parseAuthVerifyEmailBodyValue(parsed: unknown): AuthVerifyEmailPayload {
  return {
    token: parseStringField(parsed, "token"),
  };
}

export function parseAuthResetPasswordBodyValue(parsed: unknown): AuthResetPasswordPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  return {
    token: parseStringField(parsed, "token"),
    password: parseStringField(parsed, "password"),
  };
}

export function parseAuthVerifyEmailChangeBodyValue(parsed: unknown): AuthVerifyEmailChangePayload {
  return {
    token: parseStringField(parsed, "token"),
  };
}

export function parseMePasswordBodyValue(parsed: unknown): MePasswordPayload {
  return {
    current_password: parseStringField(parsed, "current_password"),
    new_password: parseStringField(parsed, "new_password"),
  };
}

export function parseMeEmailBodyValue(parsed: unknown): MeEmailPayload {
  return {
    new_email: parseEmailField(parsed, "new_email"),
    password: parseStringField(parsed, "password"),
  };
}

export function parseMeDeleteBodyValue(parsed: unknown): MeDeletePayload {
  return {
    password: parseStringField(parsed, "password"),
  };
}

export function parseMeUpdateBodyValue(parsed: unknown): MeUpdatePayload {
  const firstName = parseStringField(parsed, "first_name");
  if (firstName.length > MAX_FIRST_NAME_LENGTH) {
    throw new RequestValidationError(`first_name must be at most ${MAX_FIRST_NAME_LENGTH} characters`);
  }
  return {
    first_name: firstName,
  };
}

export function parseMeTermsAcceptanceBodyValue(parsed: unknown): MeTermsAcceptancePayload {
  return {
    accepted_terms_version: parseStringField(parsed, "accepted_terms_version"),
  };
}

// Money bounds live here AND in the membership service (defense in depth for
// a payment amount): $5 minimum (card fees eat ~33% of $1) and a $1,000
// card-testing cap the UI surfaces. Values in cents.
export const MEMBERSHIP_CHECKOUT_MIN_AMOUNT_CENTS = 500;
export const MEMBERSHIP_CHECKOUT_MAX_AMOUNT_CENTS = 100_000;

export type MembershipCheckoutPayload = {
  kind: "one_time" | "monthly";
  amount_cents: number;
};

// Portal body: `{}` opens the general customer portal (what shipped clients
// send); `flow` deep-links into one portal flow.
export type MembershipPortalPayload = {
  flow: "payment_method_update" | null;
};

export function parseMembershipPortalBodyValue(parsed: unknown): MembershipPortalPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  const flow = (parsed as Record<string, unknown>).flow;
  if (flow === undefined || flow === null) {
    return { flow: null };
  }
  if (flow !== "payment_method_update") {
    throw new RequestValidationError("Body field flow must be payment_method_update when present");
  }
  return { flow };
}

function parseMembershipAmountCents(record: Record<string, unknown>): number {
  const amountCents = record.amount_cents;
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents)) {
    throw new RequestValidationError("Body field amount_cents must be an integer number of cents");
  }
  if (amountCents < MEMBERSHIP_CHECKOUT_MIN_AMOUNT_CENTS) {
    throw new RequestValidationError(`amount_cents must be at least ${MEMBERSHIP_CHECKOUT_MIN_AMOUNT_CENTS} ($5.00)`);
  }
  if (amountCents > MEMBERSHIP_CHECKOUT_MAX_AMOUNT_CENTS) {
    throw new RequestValidationError(`amount_cents must be at most ${MEMBERSHIP_CHECKOUT_MAX_AMOUNT_CENTS} ($1,000.00)`);
  }
  return amountCents;
}

export function parseMembershipCheckoutBodyValue(parsed: unknown): MembershipCheckoutPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "one_time" && kind !== "monthly") {
    throw new RequestValidationError("Body field kind must be one_time or monthly");
  }
  return { kind, amount_cents: parseMembershipAmountCents(record) };
}

// Amount change (docs/plans/membership-manage-page.md): the same money
// bounds as checkout; the new amount bills at a future renewal, never today.
export type MembershipAmountPayload = {
  amount_cents: number;
};

export function parseMembershipAmountBodyValue(parsed: unknown): MembershipAmountPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  return { amount_cents: parseMembershipAmountCents(parsed as Record<string, unknown>) };
}

export function parseInitializeUserDistrictsBodyValue(parsed: unknown): InitializeUserDistrictsPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const districtIds = (parsed as { district_ids?: unknown }).district_ids;
  if (!Array.isArray(districtIds)) {
    throw new RequestValidationError("Request body must include array field: district_ids");
  }

  const normalizedDistrictIds: string[] = [];
  const seen = new Set<string>();
  for (const rawDistrictId of districtIds) {
    if (typeof rawDistrictId !== "string") {
      throw new RequestValidationError("district_ids must contain only UUID strings");
    }
    const districtId = rawDistrictId.trim();
    if (districtId.length === 0) {
      continue;
    }
    if (!isUuid(districtId)) {
      throw new RequestValidationError(`district_ids contains invalid UUID: ${districtId}`);
    }
    const dedupeKey = districtId.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalizedDistrictIds.push(districtId);
  }

  if (normalizedDistrictIds.length === 0) {
    throw new RequestValidationError("district_ids must include at least one district UUID");
  }
  if (normalizedDistrictIds.length > MAX_INITIALIZE_DISTRICT_IDS) {
    throw new RequestValidationError(`district_ids supports at most ${MAX_INITIALIZE_DISTRICT_IDS} UUIDs`);
  }

  return {
    district_ids: normalizedDistrictIds,
  };
}

// [ballot-personalized-ordering]
// Parses the PUT /api/me/ballot-preferences body: a full replace of both
// fields, mirroring the research-area preferences contract.
export function parseBallotPreferencesBodyValue(parsed: unknown): UserBallotPreferences {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  // SAVEABLE list, not the full request list: state_baseline is request-only
  // (the ballot preview passes it explicitly) and the user_ballot_preferences
  // sort CHECK constraint would reject it with a 500 instead of this 400.
  const sort = (parsed as { sort?: unknown }).sort;
  if (
    typeof sort !== "string" ||
    !(SAVEABLE_BALLOT_PREFERENCE_SORTS as readonly string[]).includes(sort.trim())
  ) {
    throw new RequestValidationError(`Body field sort must be one of: ${SAVEABLE_BALLOT_PREFERENCE_SORTS.join(", ")}`);
  }

  const followedFirst = (parsed as { followed_first?: unknown }).followed_first;
  if (typeof followedFirst !== "boolean") {
    throw new RequestValidationError("Body field followed_first must be a boolean");
  }

  return { sort: sort.trim() as BallotSummarySort, followed_first: followedFirst };
}

export function parseEmailPreferencesBodyValue(parsed: unknown): UserEmailPreferences {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  for (const field of ["email_digest", "email_election_reminders", "email_new_election_alerts", "email_issue_updates", "email_member_newsletter"] as const) {
    if (typeof record[field] !== "boolean") {
      throw new RequestValidationError(`Body field ${field} must be a boolean`);
    }
  }

  return {
    email_digest: record.email_digest as boolean,
    email_election_reminders: record.email_election_reminders as boolean,
    email_new_election_alerts: record.email_new_election_alerts as boolean,
    email_issue_updates: record.email_issue_updates as boolean,
    email_member_newsletter: record.email_member_newsletter as boolean,
  };
}

export function parseResearchAreaPreferencesBodyValue(parsed: unknown): ResearchAreaPreferencesPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const preferences = (parsed as { preferences?: unknown }).preferences;
  if (!Array.isArray(preferences)) {
    throw new RequestValidationError("Request body must include array field: preferences");
  }

  const normalizedPreferences: UserResearchAreaPreferenceInput[] = [];
  const seenResearchAreaIds = new Set<string>();
  const seenRanks = new Set<number>();

  for (const rawPreference of preferences) {
    if (typeof rawPreference !== "object" || rawPreference === null || Array.isArray(rawPreference)) {
      throw new RequestValidationError("preferences must contain only JSON objects");
    }

    const preference = rawPreference as ResearchAreaPreferencePayloadItem;
    if (typeof preference.research_area_id !== "string") {
      throw new RequestValidationError("preferences[].research_area_id must be a UUID string");
    }

    const researchAreaId = preference.research_area_id.trim();
    if (!isUuid(researchAreaId)) {
      throw new RequestValidationError(`preferences contains invalid research_area_id: ${researchAreaId}`);
    }
    const researchAreaDedupeKey = researchAreaId.toLowerCase();
    if (seenResearchAreaIds.has(researchAreaDedupeKey)) {
      throw new RequestValidationError(`preferences contains duplicate research_area_id: ${researchAreaId}`);
    }
    seenResearchAreaIds.add(researchAreaDedupeKey);

    // Rank is a position in the submitted list: 1..length (see the pipeline
    // normalizer for why the bound matters beyond tidiness).
    const rank = preference.rank ?? null;
    if (rank !== null && (!Number.isInteger(rank) || rank < 1 || rank > preferences.length)) {
      throw new RequestValidationError(`preferences[].rank must be an integer from 1 to ${preferences.length}`);
    }
    if (rank !== null) {
      if (seenRanks.has(rank)) {
        throw new RequestValidationError(`preferences contains duplicate rank: ${rank}`);
      }
      seenRanks.add(rank);
    }

    const direction = preference.direction;
    if (direction !== undefined && direction !== "support" && direction !== "oppose") {
      throw new RequestValidationError("preferences[].direction must be 'support' or 'oppose'");
    }
    const hardVeto = preference.hard_veto;
    if (hardVeto !== undefined && typeof hardVeto !== "boolean") {
      throw new RequestValidationError("preferences[].hard_veto must be a boolean");
    }

    normalizedPreferences.push({ researchAreaId, rank, direction, hardVeto });
  }

  return { preferences: normalizedPreferences };
}

export function parseCandidateFollowBodyValue(parsed: unknown): CandidateFollowPayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const payload = parsed as {
    candidate_id?: unknown;
    following?: unknown;
    notify_elections?: unknown;
    notify_updates?: unknown;
  };
  if (typeof payload.candidate_id !== "string") {
    throw new RequestValidationError("Request body must include UUID string field: candidate_id");
  }
  const candidateId = payload.candidate_id.trim();
  if (!isUuid(candidateId)) {
    throw new RequestValidationError(`candidate_id must be a valid UUID: ${candidateId}`);
  }
  if (typeof payload.following !== "boolean") {
    throw new RequestValidationError("Request body must include boolean field: following");
  }
  if (payload.notify_elections !== undefined && typeof payload.notify_elections !== "boolean") {
    throw new RequestValidationError("notify_elections must be a boolean");
  }
  if (payload.notify_updates !== undefined && typeof payload.notify_updates !== "boolean") {
    throw new RequestValidationError("notify_updates must be a boolean");
  }

  return {
    candidateId,
    following: payload.following,
    ...(payload.notify_elections === undefined ? {} : { notifyElections: payload.notify_elections }),
    ...(payload.notify_updates === undefined ? {} : { notifyUpdates: payload.notify_updates }),
  };
}

export type ElectionChoicePayload = UserElectionChoiceInput;

// Two mutually exclusive shapes: an office pick ({candidate_id, chosen}) or
// a ballot-measure position ({measure_position: 'yes'|'no'|null}). The
// race-type check against the actual election happens in the writer.
export function parseElectionChoiceBodyValue(parsed: unknown): ElectionChoicePayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const payload = parsed as {
    election_id?: unknown;
    candidate_id?: unknown;
    chosen?: unknown;
    measure_position?: unknown;
  };
  if (typeof payload.election_id !== "string") {
    throw new RequestValidationError("Request body must include UUID string field: election_id");
  }
  const electionId = payload.election_id.trim();
  if (!isUuid(electionId)) {
    throw new RequestValidationError(`election_id must be a valid UUID: ${electionId}`);
  }

  const hasCandidate = payload.candidate_id !== undefined;
  const hasMeasure = payload.measure_position !== undefined;
  if (hasCandidate === hasMeasure) {
    throw new RequestValidationError("Request body must include exactly one of: candidate_id, measure_position");
  }

  if (hasCandidate) {
    if (typeof payload.candidate_id !== "string") {
      throw new RequestValidationError("candidate_id must be a UUID string");
    }
    const candidateId = payload.candidate_id.trim();
    if (!isUuid(candidateId)) {
      throw new RequestValidationError(`candidate_id must be a valid UUID: ${candidateId}`);
    }
    if (typeof payload.chosen !== "boolean") {
      throw new RequestValidationError("Request body must include boolean field: chosen");
    }
    return { electionId, candidateId, chosen: payload.chosen };
  }

  if (payload.chosen !== undefined) {
    throw new RequestValidationError("chosen applies only to candidate choices");
  }
  if (payload.measure_position !== null && payload.measure_position !== "yes" && payload.measure_position !== "no") {
    throw new RequestValidationError("measure_position must be 'yes', 'no', or null");
  }
  return { electionId, measurePosition: payload.measure_position };
}

// Parses the POST /api/me/auto-picks body. Shape checks only (types, UUID
// format, batch size, duplicates); everything election-specific (existence,
// window, race type) is per-result work in the engine.
export function parseAutoPicksBodyValue(parsed: unknown): ApplyAutoPicksInput {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }

  const payload = parsed as { election_ids?: unknown; mode?: unknown; dry_run?: unknown };
  if (!Array.isArray(payload.election_ids) || payload.election_ids.length === 0) {
    throw new RequestValidationError("Request body must include non-empty array field: election_ids");
  }
  if (payload.election_ids.length > MAX_AUTO_PICK_ELECTION_IDS) {
    throw new RequestValidationError(`election_ids must contain at most ${MAX_AUTO_PICK_ELECTION_IDS} ids`);
  }
  const electionIds: string[] = [];
  const seenElectionIds = new Set<string>();
  for (const rawElectionId of payload.election_ids) {
    if (typeof rawElectionId !== "string") {
      throw new RequestValidationError("election_ids must contain only UUID strings");
    }
    const electionId = rawElectionId.trim();
    if (!isUuid(electionId)) {
      throw new RequestValidationError(`election_ids contains an invalid UUID: ${electionId}`);
    }
    const dedupeKey = electionId.toLowerCase();
    if (seenElectionIds.has(dedupeKey)) {
      throw new RequestValidationError(`election_ids contains a duplicate: ${electionId}`);
    }
    seenElectionIds.add(dedupeKey);
    electionIds.push(electionId);
  }

  if (payload.mode !== "fill_empty" && payload.mode !== "replace") {
    throw new RequestValidationError("mode must be 'fill_empty' or 'replace'");
  }
  if (payload.dry_run !== undefined && typeof payload.dry_run !== "boolean") {
    throw new RequestValidationError("dry_run must be a boolean");
  }

  return {
    electionIds,
    mode: payload.mode,
    ...(payload.dry_run === undefined ? {} : { dryRun: payload.dry_run }),
  };
}

// Expo push tokens are opaque short strings (ExponentPushToken[…]); the cap
// guards the unique index and storage against garbage, not the format — the
// Expo push API is the format authority and rejects invalid tokens itself.
const MAX_PUSH_TOKEN_LENGTH = 512;

function parsePushTokenField(record: Record<string, unknown>): string {
  const raw = record.expo_push_token;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new RequestValidationError("Request body must include string field: expo_push_token");
  }
  const token = raw.trim();
  if (token.length > MAX_PUSH_TOKEN_LENGTH) {
    throw new RequestValidationError(`expo_push_token must be at most ${MAX_PUSH_TOKEN_LENGTH} characters`);
  }
  return token;
}

// Parses the POST /api/me/push-tokens body.
export function parsePushTokenRegisterBodyValue(parsed: unknown): RegisterUserPushTokenInput {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;

  const expoPushToken = parsePushTokenField(record);

  const platform = record.platform;
  if (platform !== "ios" && platform !== "android") {
    throw new RequestValidationError('Body field platform must be "ios" or "android"');
  }

  const rawNativeToken = record.native_token;
  if (rawNativeToken !== undefined && rawNativeToken !== null && typeof rawNativeToken !== "string") {
    throw new RequestValidationError("native_token must be a string or null");
  }
  const nativeToken = typeof rawNativeToken === "string" ? rawNativeToken.trim() : "";
  if (nativeToken.length > MAX_PUSH_TOKEN_LENGTH) {
    throw new RequestValidationError(`native_token must be at most ${MAX_PUSH_TOKEN_LENGTH} characters`);
  }

  return {
    expoPushToken,
    nativeToken: nativeToken.length > 0 ? nativeToken : null,
    platform,
  };
}

// Parses the DELETE /api/me/push-tokens body.
export function parsePushTokenDeleteBodyValue(parsed: unknown): { expoPushToken: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  return { expoPushToken: parsePushTokenField(parsed as Record<string, unknown>) };
}

// [ballot-personalized-ordering]
// Parses the optional `sort`, `followed_first`, and `include` query
// parameters shared by the ballot endpoints. Throws TypeError (mapped to
// HTTP 400) on invalid values; omitted params leave the reader defaults in
// place.
export function parseBallotSummaryOptions(
  url: URL
): Pick<BallotSummaryOptions, "sort" | "followedFirst" | "includePreview" | "electionDate"> {
  const options: Pick<BallotSummaryOptions, "sort" | "followedFirst" | "includePreview" | "electionDate"> = {};

  const rawElectionDate = url.searchParams.get("election_date");
  if (rawElectionDate !== null) {
    // Same strict calendar check as the pick-card date: "2026-02-30" must
    // 400 here, not 500 on Postgres's ::date cast.
    options.electionDate = assertValidElectionDate(rawElectionDate.trim());
  }

  const rawSort = url.searchParams.get("sort");
  if (rawSort !== null) {
    const sort = rawSort.trim();
    if (!isBallotSummarySort(sort)) {
      throw new RequestValidationError(`Query parameter sort must be one of: ${BALLOT_SUMMARY_SORTS.join(", ")}`);
    }
    options.sort = sort satisfies BallotSummarySort;
  }

  const rawFollowedFirst = url.searchParams.get("followed_first");
  if (rawFollowedFirst !== null) {
    const value = rawFollowedFirst.trim().toLowerCase();
    if (value !== "true" && value !== "false") {
      throw new RequestValidationError("Query parameter followed_first must be true or false");
    }
    options.followedFirst = value === "true";
  }

  // `preview` is the only include today; reject anything else — including a
  // duplicate ?include= carrying an unsupported value — so a typo'd include
  // fails loud instead of silently returning the slim payload.
  const rawIncludes = url.searchParams.getAll("include");
  if (rawIncludes.length > 0) {
    if (rawIncludes.some((value) => value.trim() !== "preview")) {
      throw new RequestValidationError("Query parameter include must be: preview");
    }
    options.includePreview = true;
  }

  return options;
}

/** ?state=CA — case-insensitive two-letter state/DC abbreviation. */
export function parseStateResourcesState(url: URL): string {
  const raw = (url.searchParams.get("state") ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(raw)) {
    throw new RequestValidationError("Query parameter state must be a two-letter state abbreviation");
  }
  return raw;
}

export function parseDistrictIds(url: URL): string[] {
  const rawValues = url.searchParams
    .getAll("district_ids")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const districtIds = [...new Set(rawValues)];
  if (districtIds.length === 0) {
    throw new RequestValidationError("Query parameter district_ids must include at least one district UUID");
  }
  if (districtIds.length > MAX_BALLOT_DISTRICT_IDS) {
    throw new RequestValidationError(`Query parameter district_ids supports at most ${MAX_BALLOT_DISTRICT_IDS} UUIDs`);
  }
  const invalidId = districtIds.find((id) => !isUuid(id));
  if (invalidId) {
    throw new RequestValidationError(`Query parameter district_ids contains invalid UUID: ${invalidId}`);
  }
  return districtIds;
}

// Matches the client hook's CANDIDATE_SEARCH_MIN_CHARS: the endpoint is
// public and runs an unindexed scan, so single-character sweeps are refused
// server-side too.
const MIN_CANDIDATE_SEARCH_QUERY_LENGTH = 2;
const MAX_CANDIDATE_SEARCH_QUERY_LENGTH = 100;

/**
 * True when any string inside a parsed JSON value, member names included,
 * contains U+0000. Postgres
 * text columns reject NUL ("invalid byte sequence for encoding UTF8: 0x00"),
 * so a NUL that slips past field validation surfaces as a 500 at insert
 * time; callers reject it up front as a 400 instead.
 *
 * Iterative on purpose: JSON.parse accepts nesting thousands of levels deep
 * within the body-size limit, and a recursive walk overflows the call stack
 * on such a body.
 */
export function containsNulCharacter(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes("\u0000")) {
        return true;
      }
    } else if (Array.isArray(current)) {
      for (const item of current) {
        pending.push(item);
      }
    } else if (typeof current === "object" && current !== null) {
      for (const [key, item] of Object.entries(current)) {
        if (key.includes("\u0000")) {
          return true;
        }
        pending.push(item);
      }
    }
  }
  return false;
}

export function parseCandidateSearchQuery(url: URL): string {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (containsNulCharacter(query)) {
    throw new RequestValidationError("Query parameter q must not contain NUL characters");
  }
  if (query.length < MIN_CANDIDATE_SEARCH_QUERY_LENGTH) {
    throw new RequestValidationError(`Query parameter q requires at least ${MIN_CANDIDATE_SEARCH_QUERY_LENGTH} characters`);
  }
  if (query.length > MAX_CANDIDATE_SEARCH_QUERY_LENGTH) {
    throw new RequestValidationError(`Query parameter q supports at most ${MAX_CANDIDATE_SEARCH_QUERY_LENGTH} characters`);
  }
  return query;
}

export function isCandidateDetailPath(pathname: string): boolean {
  return pathname.startsWith(CANDIDATE_DETAIL_PATH_PREFIX);
}

export function parseCandidateId(url: URL): string {
  const candidateId = url.pathname.slice(CANDIDATE_DETAIL_PATH_PREFIX.length).trim();
  if (candidateId.length === 0 || candidateId.includes("/")) {
    throw new RequestValidationError("Candidate detail path must be /api/candidates/:candidate_id");
  }
  if (!isUuid(candidateId)) {
    throw new RequestValidationError(`Candidate detail path contains invalid UUID: ${candidateId}`);
  }
  return candidateId;
}

export function isElectionDetailPath(pathname: string): boolean {
  return pathname.startsWith(ELECTION_DETAIL_PATH_PREFIX);
}

// Matches /api/elections/:election_id/candidates/:candidate_id/finance.
// Shares the election-detail prefix, so the router must test this predicate
// before isElectionDetailPath.
const CANDIDATE_ELECTION_FINANCE_PATH_PATTERN = /^\/api\/elections\/([^/]+)\/candidates\/([^/]+)\/finance$/;

export function isCandidateElectionFinancePath(pathname: string): boolean {
  return CANDIDATE_ELECTION_FINANCE_PATH_PATTERN.test(pathname);
}

export function parseCandidateElectionFinancePath(url: URL): { electionId: string; candidateId: string } {
  const match = CANDIDATE_ELECTION_FINANCE_PATH_PATTERN.exec(url.pathname);
  if (!match) {
    throw new RequestValidationError(
      "Candidate election finance path must be /api/elections/:election_id/candidates/:candidate_id/finance"
    );
  }
  const electionId = match[1].trim();
  const candidateId = match[2].trim();
  if (!isUuid(electionId)) {
    throw new RequestValidationError(`Candidate election finance path contains invalid election UUID: ${electionId}`);
  }
  if (!isUuid(candidateId)) {
    throw new RequestValidationError(`Candidate election finance path contains invalid candidate UUID: ${candidateId}`);
  }
  return { electionId, candidateId };
}

export function isPickCardPath(pathname: string): boolean {
  return pathname.startsWith(PICK_CARD_PATH_PREFIX);
}

// Share tokens are 32 random bytes base64url-encoded (43 chars today); the
// bounds leave room for future length changes without admitting junk. Not a
// UUID check — the token is an opaque capability, not a row id.
const PICK_CARD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export function parsePickCardToken(url: URL): string {
  const token = url.pathname.slice(PICK_CARD_PATH_PREFIX.length).trim();
  if (token.length === 0 || token.includes("/")) {
    throw new RequestValidationError("Pick card path must be /api/pick-cards/:token");
  }
  if (!PICK_CARD_TOKEN_PATTERN.test(token)) {
    throw new RequestValidationError("Pick card path contains an invalid token");
  }
  return token;
}

// The share-card preview image: /api/pick-cards/:token/og-image.png. A fixed
// suffix rather than a query parameter because scrapers treat the og:image
// URL as opaque — the path just has to be self-describing.
export const PICK_CARD_IMAGE_SUFFIX = "/og-image.png";

export function isPickCardImagePath(pathname: string): boolean {
  return pathname.startsWith(PICK_CARD_PATH_PREFIX) && pathname.endsWith(PICK_CARD_IMAGE_SUFFIX);
}

export function parsePickCardImageToken(url: URL): string {
  const token = url.pathname.slice(PICK_CARD_PATH_PREFIX.length, -PICK_CARD_IMAGE_SUFFIX.length).trim();
  if (token.length === 0 || token.includes("/")) {
    throw new RequestValidationError("Pick card image path must be /api/pick-cards/:token/og-image.png");
  }
  if (!PICK_CARD_TOKEN_PATTERN.test(token)) {
    throw new RequestValidationError("Pick card image path contains an invalid token");
  }
  return token;
}

export type PickCardSharePayload = {
  electionDate: string;
};

const PICK_CARD_ELECTION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parsePickCardShareBodyValue(parsed: unknown): PickCardSharePayload {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("Request body must be a JSON object");
  }
  const payload = parsed as { election_date?: unknown };
  if (typeof payload.election_date !== "string") {
    throw new RequestValidationError("Request body must include string field: election_date");
  }
  return { electionDate: assertValidElectionDate(payload.election_date.trim()) };
}

/** Required ?election_date= on DELETE /api/me/pick-card-shares: a revoke
 * names exactly one date's link. Body-less, so no JSON content type is
 * demanded of the request. */
export function parsePickCardShareDeleteQuery(url: URL): string {
  const electionDate = url.searchParams.get("election_date");
  if (electionDate === null || electionDate.trim().length === 0) {
    throw new RequestValidationError("Query must include election_date");
  }
  return assertValidElectionDate(electionDate.trim());
}

function assertValidElectionDate(electionDate: string): string {
  // Round-trip through UTC instead of trusting Date.parse alone: V8 rolls
  // impossible days over ("2026-02-30" parses as March 2), which would pass
  // a NaN check and later 500 on Postgres's ::date cast instead of 400 here.
  // Year 0000 round-trips unchanged in JS (it means 1 BC there) but does
  // not exist in Postgres's calendar, so it needs its own rejection.
  const parsedDate = new Date(`${electionDate}T00:00:00Z`);
  const isRealDate =
    PICK_CARD_ELECTION_DATE_PATTERN.test(electionDate) &&
    !electionDate.startsWith("0000") &&
    !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === electionDate;
  if (!isRealDate) {
    throw new RequestValidationError(`election_date must be a valid YYYY-MM-DD date: ${electionDate}`);
  }
  return electionDate;
}

/** Optional ?election_date= scope on DELETE /api/me/auto-picks. */
export function parseAutoPicksClearQuery(url: URL): string | undefined {
  const electionDate = url.searchParams.get("election_date");
  if (electionDate === null) {
    return undefined;
  }
  return assertValidElectionDate(electionDate.trim());
}

export function isBrowseStatePath(pathname: string): boolean {
  return pathname.startsWith(BROWSE_STATE_PATH_PREFIX);
}

export function isBrowseDistrictPath(pathname: string): boolean {
  return pathname.startsWith(BROWSE_DISTRICT_PATH_PREFIX);
}

/** The two-letter code off /api/browse/states/:state, upper-cased. */
export function parseBrowseState(url: URL): string {
  const state = url.pathname.slice(BROWSE_STATE_PATH_PREFIX.length).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new RequestValidationError("Browse state path must be /api/browse/states/:state (two letters)");
  }
  return state;
}

export function parseBrowseDistrictId(url: URL): string {
  const districtId = url.pathname.slice(BROWSE_DISTRICT_PATH_PREFIX.length).trim();
  if (districtId.length === 0 || districtId.includes("/")) {
    throw new RequestValidationError("Browse district path must be /api/browse/districts/:district_id");
  }
  if (!isUuid(districtId)) {
    throw new RequestValidationError(`Browse district path contains invalid UUID: ${districtId}`);
  }
  return districtId;
}

export function parseElectionId(url: URL): string {
  const electionId = url.pathname.slice(ELECTION_DETAIL_PATH_PREFIX.length).trim();
  if (electionId.length === 0 || electionId.includes("/")) {
    throw new RequestValidationError("Election detail path must be /api/elections/:election_id");
  }
  if (!isUuid(electionId)) {
    throw new RequestValidationError(`Election detail path contains invalid UUID: ${electionId}`);
  }
  return electionId;
}

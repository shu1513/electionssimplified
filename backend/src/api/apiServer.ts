import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  AUTH_FORGOT_PASSWORD_PATH,
  AUTH_GOOGLE_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_REGISTER_PATH,
  AUTH_RESET_PASSWORD_PATH,
  AUTH_RESEND_VERIFICATION_PATH,
  AUTH_VERIFY_EMAIL_PATH,
  AUTH_VERIFY_EMAIL_CHANGE_PATH,
  AUTH_LOGOUT_ALL_PATH,
  parseAuthForgotPasswordBodyValue,
  parseAuthGoogleBodyValue,
  parseAuthLoginBodyValue,
  parseAuthRegisterBodyValue,
  parseAuthResetPasswordBodyValue,
  parseAuthResendVerificationBodyValue,
  parseAuthVerifyEmailBodyValue,
  parseAuthVerifyEmailChangeBodyValue,
  parseMeDeleteBodyValue,
  parseMeEmailBodyValue,
  parseMePasswordBodyValue,
  parseMeTermsAcceptanceBodyValue,
  parseMeUpdateBodyValue,
  parseAutoPicksClearQuery,
  containsNulCharacter,
} from "./apiValidation.js";
import type { AddressApiServerOptions } from "./addressApiTypes.js";
import { mapErrorToResponse } from "./apiErrors.js";
import { createCorsRejectionLogThrottle, readHeader, resolveCorsHeaders, truncateForLog } from "./apiCors.js";
import {
  ADDRESS_AUTOCOMPLETE_PATH,
  ADDRESS_AUTOCOMPLETE_RETRIEVE_PATH,
  ADDRESS_RESOLVE_PATH,
  BALLOT_LOOKUP_PATH,
  CHATBOT_ASK_PATH,
  CHATBOT_FEEDBACK_PATH,
  parseChatbotAskBodyValue,
  parseChatbotFeedbackBodyValue,
  CONTENT_REPORTS_PATH,
  USAGE_EVENTS_PATH,
  CANDIDATE_DETAIL_PATH_PREFIX,
  CANDIDATE_SEARCH_PATH,
  ELECTION_DETAIL_PATH_PREFIX,
  isCandidateDetailPath,
  isCandidateElectionFinancePath,
  isElectionDetailPath,
  MAX_ADDRESS_REQUEST_BODY_BYTES,
  EMAIL_UNSUBSCRIBE_PATH,
  ME_ADDRESS_PATH,
  ME_BALLOT_PATH,
  ME_EMAIL_PATH,
  ME_PASSWORD_PATH,
  ME_PATH,
  ME_BALLOT_PREFERENCES_PATH,
  ME_CANDIDATE_FOLLOWS_PATH,
  ME_ELECTION_CHOICES_PATH,
  ME_AUTO_PICKS_PATH,
  ME_PICK_CARD_SHARES_PATH,
  isPickCardPath,
  isPickCardImagePath,
  parsePickCardToken,
  parsePickCardImageToken,
  parsePickCardShareBodyValue,
  parsePickCardShareDeleteQuery,
  ME_DISTRICTS_INITIALIZE_PATH,
  ME_DISTRICTS_PATH,
  ME_EMAIL_PREFERENCES_PATH,
  ME_MEMBERSHIP_AMOUNT_PATH,
  ME_MEMBERSHIP_CANCEL_PATH,
  ME_MEMBERSHIP_CHECKOUT_PATH,
  ME_MEMBERSHIP_PATH,
  ME_MEMBERSHIP_PORTAL_PATH,
  ME_MEMBERSHIP_RESUME_PATH,
  ME_PUSH_TOKENS_PATH,
  ME_RESEARCH_AREA_PREFERENCES_PATH,
  ME_TERMS_ACCEPTANCE_PATH,
  STRIPE_WEBHOOK_PATH,
  parseMembershipAmountBodyValue,
  parseMembershipCheckoutBodyValue,
  parseMembershipPortalBodyValue,
  parseAuthenticatedAddressBodyValue,
  parsePublicAddressResolveBodyValue,
  parseAutocompleteRetrieveBodyValue,
  parseAutocompleteSuggestBodyValue,
  parseAutoPicksBodyValue,
  parseCandidateFollowBodyValue,
  parseElectionChoiceBodyValue,
  parseContentReportBodyValue,
  parseBallotPreferencesBodyValue,
  parseEmailPreferencesBodyValue,
  parseEmailUnsubscribeFormBody,
  parseEmailUnsubscribePreferences,
  parsePushTokenDeleteBodyValue,
  parsePushTokenRegisterBodyValue,
  parseBallotSummaryOptions,
  parseCandidateElectionFinancePath,
  parseCandidateId,
  parseCandidateSearchQuery,
  parseDistrictIds,
  parseElectionId,
  parseInitializeUserDistrictsBodyValue,
  parseResearchAreaPreferencesBodyValue,
  parseStateResourcesState,
  API_HEALTH_PATH,
  RESEARCH_AREAS_PATH,
  SITE_SITEMAP_PATH,
  STATE_RESOURCES_PATH,
} from "./apiValidation.js";
import { parseBearerAuthorizationValue } from "../auth/authBearer.js";
import {
  AUTH_SESSION_COOKIE_NAME,
  parseCookieHeaderValue,
  serializeAuthSessionCookie,
  serializeClearedAuthSessionCookie,
} from "../auth/authCookies.js";
import { toAddressResolutionDiagnostics, toPublicAddressResolution } from "./addressApiResponses.js";
import { randomUUID } from "node:crypto";
import { describeError } from "../observability/scrubText.js";
import {
  toEmptyResponse,
  toErrorResponse,
  toJsonResponse,
  toPngResponse,
  toXmlResponse,
  type ApiErrorBody,
  type ApiResponse,
} from "./apiResponses.js";
import { renderPickCardOgImage } from "./pickCardOgImage.js";
import { CURRENT_TERMS_VERSION, isAcceptableTermsVersion } from "../constants/legal.js";
import { parseUsageEventsBodyValue } from "../usage/events.js";
import { parseSitemapSelection } from "../pipeline/sitemap/siteSitemap.js";
import {
  buildEmailSettingsUrl,
  EMAIL_UNSUBSCRIBE_PAGE_CSP,
  renderEmailUnsubscribeConfirmPage,
  renderEmailUnsubscribeDonePage,
  renderEmailUnsubscribeInvalidPage,
} from "./emailUnsubscribePage.js";

type ApiResponseLocals = {
  clientIp?: string;
  corsHeaders?: Record<string, string>;
};

type ExpressBodyParserError = Error & {
  type?: string;
  status?: number;
  statusCode?: number;
};

const SITE_SITEMAP_CACHE_CONTROL = "public, max-age=3600";
const PICK_CARD_OG_IMAGE_CACHE_CONTROL = "public, max-age=86400";
const STATE_RESOURCES_CACHE_CONTROL = "public, max-age=3600";

function isKnownApiPath(pathname: string): boolean {
  return (
    pathname === API_HEALTH_PATH ||
    pathname === ADDRESS_AUTOCOMPLETE_PATH ||
    pathname === ADDRESS_AUTOCOMPLETE_RETRIEVE_PATH ||
    pathname === ADDRESS_RESOLVE_PATH ||
    pathname === BALLOT_LOOKUP_PATH ||
    pathname === CHATBOT_ASK_PATH ||
    pathname === CHATBOT_FEEDBACK_PATH ||
    pathname === CONTENT_REPORTS_PATH ||
    pathname === USAGE_EVENTS_PATH ||
    pathname === AUTH_FORGOT_PASSWORD_PATH ||
    pathname === AUTH_GOOGLE_PATH ||
    pathname === AUTH_LOGIN_PATH ||
    pathname === AUTH_LOGOUT_PATH ||
    pathname === AUTH_REGISTER_PATH ||
    pathname === AUTH_RESET_PASSWORD_PATH ||
    pathname === AUTH_RESEND_VERIFICATION_PATH ||
    pathname === AUTH_VERIFY_EMAIL_PATH ||
    pathname === AUTH_VERIFY_EMAIL_CHANGE_PATH ||
    pathname === AUTH_LOGOUT_ALL_PATH ||
    pathname === EMAIL_UNSUBSCRIBE_PATH ||
    pathname === ME_PATH ||
    pathname === ME_EMAIL_PATH ||
    pathname === ME_PASSWORD_PATH ||
    pathname === ME_ADDRESS_PATH ||
    pathname === ME_TERMS_ACCEPTANCE_PATH ||
    pathname === ME_BALLOT_PATH ||
    pathname === ME_BALLOT_PREFERENCES_PATH ||
    pathname === ME_CANDIDATE_FOLLOWS_PATH ||
    pathname === ME_ELECTION_CHOICES_PATH ||
    pathname === ME_AUTO_PICKS_PATH ||
    pathname === ME_PICK_CARD_SHARES_PATH ||
    isPickCardPath(pathname) ||
    pathname === ME_DISTRICTS_PATH ||
    pathname === ME_DISTRICTS_INITIALIZE_PATH ||
    pathname === ME_EMAIL_PREFERENCES_PATH ||
    pathname === ME_MEMBERSHIP_PATH ||
    pathname === ME_MEMBERSHIP_CHECKOUT_PATH ||
    pathname === ME_MEMBERSHIP_PORTAL_PATH ||
    pathname === ME_MEMBERSHIP_CANCEL_PATH ||
    pathname === ME_MEMBERSHIP_RESUME_PATH ||
    pathname === ME_MEMBERSHIP_AMOUNT_PATH ||
    pathname === STRIPE_WEBHOOK_PATH ||
    pathname === ME_PUSH_TOKENS_PATH ||
    pathname === ME_RESEARCH_AREA_PREFERENCES_PATH ||
    pathname === RESEARCH_AREAS_PATH ||
    pathname === STATE_RESOURCES_PATH ||
    pathname === SITE_SITEMAP_PATH ||
    // Listed explicitly even though the loose candidate-detail prefix also
    // matches it today: recognition of the search route must not depend on
    // a sibling predicate staying loose.
    pathname === CANDIDATE_SEARCH_PATH ||
    isCandidateDetailPath(pathname) ||
    // Listed explicitly even though the loose election-detail prefix also
    // matches it today: recognition of the finance route must not depend on
    // a sibling predicate staying loose.
    isCandidateElectionFinancePath(pathname) ||
    isElectionDetailPath(pathname)
  );
}

function getCorsHeaders(response: Response<unknown, ApiResponseLocals>): Record<string, string> {
  return response.locals.corsHeaders ?? {};
}

async function enforceAuthRateLimit(
  options: AddressApiServerOptions,
  request: Request,
  response: Response<unknown, ApiResponseLocals>,
  email: string | null
): Promise<boolean> {
  if (!options.authRateLimit) {
    return true;
  }

  const rateLimit = options.authRateLimit({
    clientIp: response.locals.clientIp ?? "unknown",
    email,
    method: request.method,
    pathname: request.path,
  });
  if (rateLimit.allowed) {
    return true;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil(rateLimit.retryAfterSeconds ?? 1));
  sendApiResponse(
    response,
    toErrorResponse(429, "rate_limited", "Too many requests. Try again later.", {
      ...getCorsHeaders(response),
      "retry-after": String(retryAfterSeconds),
    })
  );
  return false;
}

async function resolveAuthenticatedUserId(
  options: AddressApiServerOptions,
  request: Request
): Promise<string | null> {
  if (!options.resolveAuthenticatedUserId) {
    return null;
  }
  const resolved = await Promise.resolve(options.resolveAuthenticatedUserId({ headers: request.headers }));
  const trimmed = resolved?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function requireVerifiedAuthenticatedUser(
  options: AddressApiServerOptions,
  request: Request,
  response: Response<unknown, ApiResponseLocals>
): Promise<string | null> {
  const corsHeaders = getCorsHeaders(response);
  const userId = await resolveAuthenticatedUserId(options, request);
  if (!userId) {
    sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
    return null;
  }

  // Fail closed: when session auth is live (authService configured), a
  // missing verification lookup is a wiring bug, not permission to skip the
  // gate. Trusted-header-only deployments (no authService) predate email
  // verification and keep the legacy behavior.
  if (!options.lookupAuthenticatedUserEmailVerified) {
    if (options.authService) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Email verification lookup is not configured", corsHeaders)
      );
      return null;
    }
    return userId;
  }

  const emailVerified = await Promise.resolve(options.lookupAuthenticatedUserEmailVerified(userId));
  if (!emailVerified) {
    sendApiResponse(
      response,
      toErrorResponse(403, "forbidden", "Email verification is required", corsHeaders)
    );
    return null;
  }

  return userId;
}

// Only requests that declare themselves as the mobile app receive the session
// id in the response body (for Bearer use); web responses stay cookie-only so
// the id is never readable by browser JS.
const MOBILE_CLIENT_HEADER_NAME = "x-voteapp-client";
const MOBILE_CLIENT_HEADER_VALUE = "mobile";

// The mobile-client header alone is not a trust boundary: browser JS can set
// it, and an XSS wrapping the user's own login request could then read the
// session id from the response — exactly what httpOnly exists to prevent.
// Browsers, however, always attach Origin to POSTs and Sec-Fetch-* to every
// request, and scripts cannot remove these forbidden headers. Native HTTP
// stacks (React Native fetch, OkHttp, NSURLSession) send neither, so any
// browser provenance disqualifies the request from the mobile transport.
function hasBrowserProvenance(request: Request): boolean {
  if (request.headers.origin !== undefined) {
    return true;
  }
  return Object.keys(request.headers).some((name) => name.startsWith("sec-fetch-"));
}

function isMobileClientRequest(request: Request): boolean {
  const rawValue = request.headers[MOBILE_CLIENT_HEADER_NAME];
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  return value?.trim().toLowerCase() === MOBILE_CLIENT_HEADER_VALUE && !hasBrowserProvenance(request);
}

function getAuthSessionId(request: Request): string | null {
  // Bearer (explicit, attached per-request by the mobile app) wins over the
  // cookie (ambient, replayed by cookie jars): a stale jar cookie must not
  // shadow the session the client actually presented. Web clients never send
  // a Bearer header, so their behavior is unchanged.
  return (
    parseBearerAuthorizationValue(request.headers.authorization) ??
    parseCookieHeaderValue(request.headers.cookie, AUTH_SESSION_COOKIE_NAME)
  );
}

function sendApiResponse(response: Response, apiResponse: ApiResponse): void {
  response.status(apiResponse.statusCode).set(apiResponse.headers);
  if (apiResponse.body === undefined) {
    response.end();
    return;
  }
  // Binary bodies (the pick-card og image) ship as-is; express keeps the
  // content-type the response headers already set.
  if (Buffer.isBuffer(apiResponse.body)) {
    response.send(apiResponse.body);
    return;
  }
  if (
    typeof apiResponse.body === "string" &&
    !String(apiResponse.headers["content-type"] ?? "").includes("application/json")
  ) {
    response.send(apiResponse.body);
    return;
  }
  response.json(apiResponse.body);
}

function createClientIpMiddleware(options: AddressApiServerOptions) {
  return (request: Request, response: Response<unknown, ApiResponseLocals>, next: NextFunction): void => {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    response.locals.clientIp =
      options.resolveClientIp?.({ headers: request.headers, remoteAddress })?.trim() || remoteAddress;
    next();
  };
}

function createCorsAndPreflightMiddleware(options: AddressApiServerOptions) {
  const shouldLogRejection = createCorsRejectionLogThrottle();
  return (request: Request, response: Response<unknown, ApiResponseLocals>, next: NextFunction): void => {
    const cors = resolveCorsHeaders(request.headers, options.allowedOrigins);
    response.locals.corsHeaders = cors.headers;

    if (!isKnownApiPath(request.path)) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", cors.headers));
      return;
    }

    if (!cors.ok) {
      // Keep the rejected values visible in server logs: "Origin is not
      // allowed" reports from users are undiagnosable without knowing what
      // their browser actually sent. Throttled because this runs ahead of the
      // rate limiter — see createCorsRejectionLogThrottle.
      const origin = truncateForLog(readHeader(request.headers, "origin"));
      const secFetchSite = truncateForLog(readHeader(request.headers, "sec-fetch-site"));
      // NUL-separated: header values can never contain NUL, so the dedupe key
      // cannot collide across the two fields the way a space separator could.
      const verdict = shouldLogRejection(`${origin}\0${secFetchSite}`);
      if (verdict.shouldLog) {
        const suppressedNote =
          verdict.suppressed > 0 ? ` (${verdict.suppressed} further rejections suppressed since the last line)` : "";
        console.warn(
          `CORS rejected ${request.method} ${truncateForLog(request.path)}: ` +
            `origin=${JSON.stringify(origin)} sec-fetch-site=${JSON.stringify(secFetchSite)}${suppressedNote}`
        );
      }
      sendApiResponse(response, toErrorResponse(403, "invalid_request", "Origin is not allowed", cors.headers));
      return;
    }

    if (request.method === "OPTIONS") {
      sendApiResponse(response, toEmptyResponse(204, cors.headers));
      return;
    }

    next();
  };
}

function createRateLimitMiddleware(options: AddressApiServerOptions) {
  return (request: Request, response: Response<unknown, ApiResponseLocals>, next: NextFunction): void => {
    // The Stripe webhook is exempt: deliveries come from Stripe's shared IPs
    // (which would trip a per-IP bucket and silently delay payment records),
    // and the endpoint is protected by signature verification instead.
    if (request.path === STRIPE_WEBHOOK_PATH) {
      next();
      return;
    }
    // The health probe is exempt too: the platform polls it every few
    // seconds from its own addresses, and a 429 here would read as "instance
    // down" and pull traffic from a healthy process.
    if (request.path === API_HEALTH_PATH) {
      next();
      return;
    }
    if (!options.rateLimit) {
      next();
      return;
    }

    const rateLimit = options.rateLimit({
      clientIp: response.locals.clientIp ?? "unknown",
      method: request.method,
      pathname: request.path,
    });
    if (rateLimit.allowed) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil(rateLimit.retryAfterSeconds ?? 1));
    sendApiResponse(
      response,
      toErrorResponse(429, "rate_limited", "Too many requests. Try again later.", {
        ...getCorsHeaders(response),
        "retry-after": String(retryAfterSeconds),
      })
    );
  };
}

function createContentReportRateLimitMiddleware(options: AddressApiServerOptions) {
  return (request: Request, response: Response<unknown, ApiResponseLocals>, next: NextFunction): void => {
    if (!options.contentReportRateLimit || request.method !== "POST" || request.path !== CONTENT_REPORTS_PATH) {
      next();
      return;
    }

    const rateLimit = options.contentReportRateLimit({
      clientIp: response.locals.clientIp ?? "unknown",
      method: request.method,
      pathname: request.path,
    });
    if (rateLimit.allowed) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil(rateLimit.retryAfterSeconds ?? 1));
    sendApiResponse(
      response,
      toErrorResponse(429, "rate_limited", "Too many requests. Try again later.", {
        ...getCorsHeaders(response),
        "retry-after": String(retryAfterSeconds),
      })
    );
  };
}

// The unsubscribe confirmation page is a plain HTML form (no JavaScript), so
// its POST arrives urlencoded; RFC 8058 one-click POSTs from mailbox
// providers use the same content type ("List-Unsubscribe=One-Click"). Parse
// it for that one path only and keep the limit tiny: the body is a handful
// of checkbox values.
function createEmailUnsubscribeFormBodyParser() {
  const parseForm = express.urlencoded({
    extended: false,
    limit: "4kb",
    type: "application/x-www-form-urlencoded",
  });
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method === "POST" && request.path === EMAIL_UNSUBSCRIBE_PATH) {
      parseForm(request, response, next);
      return;
    }
    next();
  };
}

function createJsonBodyParser() {
  const parseJson = express.json({
    limit: MAX_ADDRESS_REQUEST_BODY_BYTES,
    strict: true,
    type: ["application/json", "application/*+json"],
  });

  function hasJsonContentType(request: Request): boolean {
    const rawContentType = request.headers["content-type"];
    const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
    const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
    return mediaType === "application/json" || (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"));
  }

  return (request: Request, response: Response, next: NextFunction): void => {
    const shouldParseJson =
      (request.method === "POST" &&
        (request.path === ADDRESS_AUTOCOMPLETE_PATH ||
          request.path === ADDRESS_AUTOCOMPLETE_RETRIEVE_PATH ||
          request.path === ADDRESS_RESOLVE_PATH ||
          request.path === CHATBOT_ASK_PATH ||
          // Requiring application/json also blocks plain cross-site form
          // POSTs from casting feedback votes (forms cannot send it without
          // a CORS preflight).
          request.path === CHATBOT_FEEDBACK_PATH ||
          request.path === CONTENT_REPORTS_PATH ||
          // Requiring application/json keeps plain cross-site form POSTs
          // from stuffing the analytics table (forms cannot send it).
          request.path === USAGE_EVENTS_PATH ||
          request.path === ME_AUTO_PICKS_PATH ||
          request.path === ME_DISTRICTS_INITIALIZE_PATH ||
          request.path === AUTH_FORGOT_PASSWORD_PATH ||
          // Half the CSRF story for the Google endpoint: requiring
          // application/json means no HTML form can produce the request.
          request.path === AUTH_GOOGLE_PATH ||
          request.path === AUTH_LOGIN_PATH ||
          // Logout has no meaningful body, but requiring the JSON content
          // type blocks plain cross-site form POSTs from logging users out
          // in SameSite=None deployments (forms cannot send application/json
          // without a CORS preflight).
          request.path === AUTH_LOGOUT_PATH ||
          request.path === AUTH_REGISTER_PATH ||
          request.path === AUTH_RESET_PASSWORD_PATH ||
          request.path === AUTH_RESEND_VERIFICATION_PATH ||
          request.path === AUTH_VERIFY_EMAIL_PATH ||
          request.path === AUTH_VERIFY_EMAIL_CHANGE_PATH ||
          // Like logout: requiring JSON blocks plain cross-site form POSTs.
          request.path === AUTH_LOGOUT_ALL_PATH ||
          request.path === ME_EMAIL_PATH ||
          request.path === ME_PASSWORD_PATH ||
          // Requiring application/json blocks plain cross-site form POSTs
          // from starting a checkout or portal session, or canceling or
          // re-pricing a membership, with ambient cookies.
          request.path === ME_MEMBERSHIP_CHECKOUT_PATH ||
          request.path === ME_MEMBERSHIP_PORTAL_PATH ||
          request.path === ME_MEMBERSHIP_CANCEL_PATH ||
          request.path === ME_MEMBERSHIP_RESUME_PATH ||
          request.path === ME_MEMBERSHIP_AMOUNT_PATH ||
          request.path === ME_PUSH_TOKENS_PATH ||
          request.path === ME_PICK_CARD_SHARES_PATH ||
          request.path === ME_TERMS_ACCEPTANCE_PATH)) ||
      (request.method === "DELETE" && (request.path === ME_PATH || request.path === ME_PUSH_TOKENS_PATH)) ||
      (request.method === "PUT" &&
        (request.path === ME_PATH ||
          request.path === ME_ADDRESS_PATH ||
          request.path === ME_BALLOT_PREFERENCES_PATH ||
          request.path === ME_CANDIDATE_FOLLOWS_PATH ||
          request.path === ME_ELECTION_CHOICES_PATH ||
          request.path === ME_EMAIL_PREFERENCES_PATH ||
          request.path === ME_RESEARCH_AREA_PREFERENCES_PATH));
    if (!shouldParseJson) {
      next();
      return;
    }
    if (!hasJsonContentType(request)) {
      sendApiResponse(
        response,
        toErrorResponse(
          415,
          "unsupported_media_type",
          "Content-Type must be application/json",
          getCorsHeaders(response)
        )
      );
      return;
    }
    parseJson(request, response, (error?: unknown) => {
      if (error !== undefined && error !== null) {
        next(error);
        return;
      }
      // Postgres rejects U+0000 in text and jsonb, so a NUL anywhere in the
      // body would otherwise surface as a 500 at insert time. Every JSON
      // route shares this parser, so reject it once here as a 400.
      //
      // body-parser invokes this callback from its stream handler, outside
      // Express's try/catch around middleware, so a throw here would take
      // the process down instead of becoming a 500. Route it to next().
      try {
        if (containsNulCharacter(request.body)) {
          sendApiResponse(
            response,
            toErrorResponse(400, "invalid_request", "Request body must not contain NUL characters", getCorsHeaders(response))
          );
          return;
        }
      } catch (checkError) {
        next(checkError);
        return;
      }
      next();
    });
  };
}

// Stripe signs the exact raw bytes it sends; JSON re-serialization would
// break verification, so the webhook path gets its own raw-body branch ahead
// of the JSON parser (whose path list never includes it). type () => true:
// the body must land as a Buffer regardless of the declared content type.
function createStripeWebhookBodyParser() {
  const parseRaw = express.raw({ type: () => true, limit: "1mb" });
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method === "POST" && request.path === STRIPE_WEBHOOK_PATH) {
      parseRaw(request, response, next);
      return;
    }
    next();
  };
}

async function dispatchApiRequest(
  request: Request,
  response: Response<unknown, ApiResponseLocals>,
  options: AddressApiServerOptions
): Promise<void> {
  const url = new URL(request.url, "http://localhost");
  const corsHeaders = getCorsHeaders(response);

  if (url.pathname === API_HEALTH_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/healthz", { ...corsHeaders, allow: "GET" })
      );
      return;
    }
    // Readiness, not liveness: the platform's health check should follow the
    // database, because an API that cannot reach Postgres serves nothing
    // useful. The probe is bounded by its own deadline (see
    // checkApiDbPoolHealth) so a slow query cannot outlast the platform's
    // 5 s probe timeout. Body stays tiny and never echoes the error detail.
    if (!options.checkDatabaseHealth) {
      sendApiResponse(response, toJsonResponse(503, { ok: false, reason: "database_check_not_configured" }, corsHeaders));
      return;
    }
    try {
      await options.checkDatabaseHealth();
    } catch (error) {
      console.warn(`healthz database check failed: ${error instanceof Error ? error.message : String(error)}`);
      sendApiResponse(response, toJsonResponse(503, { ok: false, reason: "database_unavailable" }, corsHeaders));
      return;
    }
    sendApiResponse(response, toJsonResponse(200, { ok: true }, corsHeaders));
    return;
  }

  if (url.pathname === SITE_SITEMAP_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /sitemap.xml", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.getSitemapXml) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Sitemap is not configured", corsHeaders));
      return;
    }

    // undefined = a part/page that can never exist; null = the index.
    const selection = parseSitemapSelection(url.searchParams);
    const sitemapXml = selection === undefined ? null : await options.getSitemapXml(selection);
    if (sitemapXml === null) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "No such sitemap file", corsHeaders));
      return;
    }
    sendApiResponse(
      response,
      toXmlResponse(200, sitemapXml, { ...corsHeaders, "cache-control": SITE_SITEMAP_CACHE_CONTROL })
    );
    return;
  }

  if (url.pathname === RESEARCH_AREAS_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/research-areas", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.listResearchAreas) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Research area catalog lookup is not configured", corsHeaders)
      );
      return;
    }

    const result = await options.listResearchAreas();
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === STATE_RESOURCES_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/state-resources?state=CA", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.getStateVotingResources) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "State voting resources lookup is not configured", corsHeaders)
      );
      return;
    }

    const stateAbbreviation = parseStateResourcesState(url);
    const result = await options.getStateVotingResources(stateAbbreviation);
    if (!result) {
      sendApiResponse(
        response,
        toErrorResponse(404, "not_found", `No voting resources found for state ${stateAbbreviation}`, corsHeaders)
      );
      return;
    }

    // Official state links change on a research cadence (roughly annual), so
    // shared caches may hold them briefly, unlike the personalized defaults.
    sendApiResponse(
      response,
      toJsonResponse(200, result, { ...corsHeaders, "cache-control": STATE_RESOURCES_CACHE_CONTROL })
    );
    return;
  }

  if (url.pathname === CHATBOT_ASK_PATH) {
    // 404 (not 500, and BEFORE the method check so no 405 leaks either) when
    // unwired: CHATBOT_ENABLED=false must hide the feature exactly like an
    // unknown path, per the isolation contract.
    if (!options.askChatbot) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", corsHeaders));
      return;
    }
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/chatbot/ask", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }

    // Registered + verified accounts only: the widget maps 401 to a
    // register/login prompt and 403 to a verify-your-email prompt.
    // Fail closed on missing verification wiring: the shared helper lets
    // legacy trusted-header deployments (no authService) through unverified,
    // but this endpoint's contract is strict — no lookup, no answers.
    if (!options.lookupAuthenticatedUserEmailVerified) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Email verification lookup is not configured", corsHeaders)
      );
      return;
    }
    const chatbotUserId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!chatbotUserId) {
      return;
    }

    const payload = parseChatbotAskBodyValue(request.body);
    // The user id rides along for the Phase 2 LLM guards only (per-user cap
    // + hashed provider abuse identifier); it is never logged with the
    // question (chatbot.questions stays anonymous).
    const askResult = await options.askChatbot(payload.question, payload.previousQuestion, payload.context, chatbotUserId);
    sendApiResponse(response, toJsonResponse(200, askResult, corsHeaders));
    return;
  }

  if (url.pathname === CHATBOT_FEEDBACK_PATH) {
    // Same isolation contract as the ask path: unwired → 404 before the
    // method check, so CHATBOT_ENABLED=false hides the feature entirely.
    if (!options.submitChatbotFeedback) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", corsHeaders));
      return;
    }
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/chatbot/feedback", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }

    // Same verified-accounts gate as the ask path: tokens are only ever
    // issued to verified users, so only they can spend one. The stored row
    // stays anonymous — the userId is used for the gate alone.
    if (!options.lookupAuthenticatedUserEmailVerified) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Email verification lookup is not configured", corsHeaders)
      );
      return;
    }
    if (!(await requireVerifiedAuthenticatedUser(options, request, response))) {
      return;
    }

    const payload = parseChatbotFeedbackBodyValue(request.body);
    const result = await options.submitChatbotFeedback(payload.token, payload.verdict);
    if (result === "invalid_token") {
      sendApiResponse(response, toErrorResponse(400, "invalid_request", "Invalid feedback token", corsHeaders));
      return;
    }
    sendApiResponse(response, toJsonResponse(200, { status: "ok" }, corsHeaders));
    return;
  }

  if (url.pathname === CONTENT_REPORTS_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/content-reports", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.createContentReport) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Content report storage is not configured", corsHeaders));
      return;
    }

    const payload = parseContentReportBodyValue(request.body);
    const userId = await resolveAuthenticatedUserId(options, request);
    const report = await options.createContentReport({ ...payload, userId });
    sendApiResponse(response, toJsonResponse(201, { report }, corsHeaders));
    return;
  }

  if (url.pathname === USAGE_EVENTS_PATH) {
    // Flag off → the endpoint does not exist, same posture as the chatbot.
    if (!options.recordUsageEvents) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Usage analytics is not enabled", corsHeaders));
      return;
    }
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/usage/events", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    // Anonymous by design: no session lookup, no user id anywhere near the
    // rows. The insert is awaited so a failure surfaces as a 5xx the client
    // can retry instead of a silent drop.
    const { accepted, dropped } = parseUsageEventsBodyValue(request.body);
    await options.recordUsageEvents(accepted, dropped);
    sendApiResponse(response, toEmptyResponse(204, corsHeaders));
    return;
  }

  if (url.pathname === AUTH_REGISTER_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/register", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    const payload = parseAuthRegisterBodyValue(request.body);
    // Reject unknown terms versions outright; a listed grace version (a
    // bundle one bump behind, still showing the documents it names) is
    // accepted and recorded as-is — see GRACE_TERMS_VERSIONS.
    if (!isAcceptableTermsVersion(payload.accepted_terms_version)) {
      sendApiResponse(
        response,
        toErrorResponse(
          400,
          "invalid_request",
          `accepted_terms_version must be an accepted terms version (current: ${CURRENT_TERMS_VERSION})`,
          corsHeaders
        )
      );
      return;
    }
    if (!(await enforceAuthRateLimit(options, request, response, payload.email))) {
      return;
    }
    await options.authService.register({
      email: payload.email,
      password: payload.password,
      firstName: payload.first_name,
      acceptedTermsVersion: payload.accepted_terms_version,
    });
    sendApiResponse(response, toJsonResponse(200, { status: "ok" }, corsHeaders));
    return;
  }

  if (url.pathname === AUTH_VERIFY_EMAIL_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/verify-email", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    const payload = parseAuthVerifyEmailBodyValue(request.body);
    await options.authService.verifyEmail({
      token: payload.token,
    });
    sendApiResponse(response, toJsonResponse(200, { status: "ok" }, corsHeaders));
    return;
  }

  if (url.pathname === AUTH_VERIFY_EMAIL_CHANGE_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/verify-email-change", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    const payload = parseAuthVerifyEmailChangeBodyValue(request.body);
    await options.authService.verifyEmailChange({
      token: payload.token,
    });
    sendApiResponse(response, toJsonResponse(200, { status: "ok" }, corsHeaders));
    return;
  }

  if (url.pathname === AUTH_LOGOUT_ALL_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/logout-all", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId || !options.authService) {
      sendApiResponse(
        response,
        !options.resolveAuthenticatedUserId
          ? toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders)
          : toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders)
      );
      return;
    }

    // Needs a live session to know whose sessions to destroy; a caller with
    // a dead cookie is already logged out everywhere it matters.
    const userId = await resolveAuthenticatedUserId(options, request);
    if (!userId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    await options.authService.logoutAll({ userId });
    sendApiResponse(response, {
      ...toJsonResponse(200, { status: "ok" }, corsHeaders),
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
        "set-cookie": serializeClearedAuthSessionCookie({
          ...options.authSessionCookieOptions,
        }),
      },
      body: { status: "ok" },
      statusCode: 200,
    });
    return;
  }

  if (url.pathname === AUTH_RESEND_VERIFICATION_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/resend-verification", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    const payload = parseAuthResendVerificationBodyValue(request.body);
    if (!(await enforceAuthRateLimit(options, request, response, payload.email))) {
      return;
    }
    await options.authService.resendVerification({
      email: payload.email,
    });
    sendApiResponse(response, toJsonResponse(200, { status: "ok" }, corsHeaders));
    return;
  }

  if (url.pathname === AUTH_GOOGLE_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/google", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    // Configured-if-present: the method only exists on the service when
    // GOOGLE_OAUTH_CLIENT_ID was wired at boot.
    const loginWithGoogle = options.authService?.loginWithGoogle?.bind(options.authService);
    if (!loginWithGoogle) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Google sign-in is not configured", corsHeaders)
      );
      return;
    }

    const payload = parseAuthGoogleBodyValue(request.body);
    // Same dual-layer clickwrap rule as register: a stale frontend must be
    // refused before any token verification or DB work.
    if (
      payload.intent === "signup" &&
      (payload.accepted_terms_version === undefined || !isAcceptableTermsVersion(payload.accepted_terms_version))
    ) {
      sendApiResponse(
        response,
        toErrorResponse(
          400,
          "invalid_request",
          `accepted_terms_version must be an accepted terms version (current: ${CURRENT_TERMS_VERSION})`,
          corsHeaders
        )
      );
      return;
    }
    // Per-IP throttle only (email: null skips the per-identity bucket):
    // there is no password to brute-force behind this endpoint — a credential
    // is a Google-signed token — so the limiter's job here is only to cap
    // verification/DB work per caller, and the IP is the only stable key
    // available before verification.
    if (!(await enforceAuthRateLimit(options, request, response, null))) {
      return;
    }
    const currentSessionId = getAuthSessionId(request);
    const result = await loginWithGoogle({
      idToken: payload.credential,
      intent: payload.intent,
      ...(payload.accepted_terms_version === undefined
        ? {}
        : { acceptedTermsVersion: payload.accepted_terms_version }),
      currentSessionId,
    });
    // Identical transport branch to password login: mobile gets the id in
    // the body (Bearer use), web stays cookie-only.
    const googleMobileClient = isMobileClientRequest(request);
    sendApiResponse(response, {
      ...toJsonResponse(200, { status: "ok" }, corsHeaders),
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
        ...(googleMobileClient
          ? {}
          : {
              "set-cookie": serializeAuthSessionCookie(result.sessionId, {
                ...options.authSessionCookieOptions,
              }),
            }),
      },
      body: googleMobileClient ? { status: "ok", session_id: result.sessionId } : { status: "ok" },
      statusCode: 200,
    });
    return;
  }

  if (url.pathname === AUTH_LOGIN_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/login", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    const payload = parseAuthLoginBodyValue(request.body);
    if (!(await enforceAuthRateLimit(options, request, response, payload.email))) {
      return;
    }
    const currentSessionId = getAuthSessionId(request);
    const result = await options.authService.login({
      email: payload.email,
      password: payload.password,
      currentSessionId,
    });
    // Mobile gets the id in the body and no Set-Cookie: native cookie jars
    // store cookies automatically, and a jar copy of the session would later
    // be replayed alongside the Bearer header and diverge from it.
    const mobileClient = isMobileClientRequest(request);
    sendApiResponse(response, {
      ...toJsonResponse(200, { status: "ok" }, corsHeaders),
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
        ...(mobileClient
          ? {}
          : {
              "set-cookie": serializeAuthSessionCookie(result.sessionId, {
                ...options.authSessionCookieOptions,
              }),
            }),
      },
      body: mobileClient ? { status: "ok", session_id: result.sessionId } : { status: "ok" },
      statusCode: 200,
    });
    return;
  }

  if (url.pathname === AUTH_LOGOUT_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/logout", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    const currentSessionId = getAuthSessionId(request);
    await options.authService.logout({
      currentSessionId,
    });
    sendApiResponse(response, {
      ...toJsonResponse(200, { status: "ok" }, corsHeaders),
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
        "set-cookie": serializeClearedAuthSessionCookie({
          ...options.authSessionCookieOptions,
        }),
      },
      body: { status: "ok" },
      statusCode: 200,
    });
    return;
  }

  if (url.pathname === AUTH_FORGOT_PASSWORD_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/forgot-password", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    const payload = parseAuthForgotPasswordBodyValue(request.body);
    if (!(await enforceAuthRateLimit(options, request, response, payload.email))) {
      return;
    }
    await options.authService.forgotPassword({
      email: payload.email,
    });
    sendApiResponse(response, toJsonResponse(200, { status: "ok" }, corsHeaders));
    return;
  }

  if (url.pathname === AUTH_RESET_PASSWORD_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/auth/reset-password", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    const payload = parseAuthResetPasswordBodyValue(request.body);
    await options.authService.resetPassword({
      token: payload.token,
      password: payload.password,
    });
    sendApiResponse(response, toJsonResponse(200, { status: "ok" }, corsHeaders));
    return;
  }

  if (url.pathname === BALLOT_LOOKUP_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/ballot?district_ids=...", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.lookupBallotSummaries) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Ballot lookup is not configured", corsHeaders));
      return;
    }

    const districtIds = parseDistrictIds(url);
    const summaryOptions = parseBallotSummaryOptions(url);
    const result = await options.lookupBallotSummaries(districtIds, summaryOptions);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_BALLOT_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/me/ballot", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }
    if (!options.lookupAuthenticatedBallotSummaries) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Authenticated ballot lookup is not configured", corsHeaders)
      );
      return;
    }

    // Same verified-email gate as every other /api/me route: personalized
    // ballot data must not be readable by unverified accounts.
    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    // [ballot-personalized-ordering]
    // Explicit query params win; anything omitted falls back to the user's
    // saved ballot preferences (and the reader defaults below those).
    const summaryOptions = parseBallotSummaryOptions(url);
    if (options.getAuthenticatedBallotPreferences && (summaryOptions.sort === undefined || summaryOptions.followedFirst === undefined)) {
      const saved = await options.getAuthenticatedBallotPreferences(userId);
      summaryOptions.sort = summaryOptions.sort ?? saved.sort;
      summaryOptions.followedFirst = summaryOptions.followedFirst ?? saved.followed_first;
    }
    const result = await options.lookupAuthenticatedBallotSummaries(userId, summaryOptions);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_PATH) {
    if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET, PUT, or DELETE /api/me", {
          ...corsHeaders,
          allow: "GET, PUT, DELETE",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    // Deliberately not requireVerifiedAuthenticatedUser: the frontend calls
    // this to find out whether the user is verified, so the unverified state
    // must be readable, not a 403. Same logic for PUT (fix your name) and
    // DELETE (leave) — neither should demand a verified inbox.
    const userId = await resolveAuthenticatedUserId(options, request);
    if (!userId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    if (request.method === "GET") {
      if (!options.getAuthenticatedUser) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Authenticated user lookup is not configured", corsHeaders)
        );
        return;
      }

      const user = await options.getAuthenticatedUser(userId);
      sendApiResponse(response, toJsonResponse(200, { user }, corsHeaders));
      return;
    }

    if (request.method === "PUT") {
      if (!options.updateAuthenticatedUserFirstName) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Authenticated user update is not configured", corsHeaders)
        );
        return;
      }

      const payload = parseMeUpdateBodyValue(request.body);
      const user = await options.updateAuthenticatedUserFirstName(userId, payload.first_name);
      sendApiResponse(response, toJsonResponse(200, { user }, corsHeaders));
      return;
    }

    if (!options.authService) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders));
      return;
    }

    // Password-verifying endpoint: throttle per account (keyed by userId in
    // the shared auth buckets) so a hijacked session cannot brute-force the
    // re-entered password behind the per-IP cap alone.
    if (!(await enforceAuthRateLimit(options, request, response, userId))) {
      return;
    }

    const payload = parseMeDeleteBodyValue(request.body);
    await options.authService.deleteAccount({
      userId,
      password: payload.password,
    });
    sendApiResponse(response, {
      ...toJsonResponse(200, { status: "ok" }, corsHeaders),
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
        "set-cookie": serializeClearedAuthSessionCookie({
          ...options.authSessionCookieOptions,
        }),
      },
      body: { status: "ok" },
      statusCode: 200,
    });
    return;
  }

  if (url.pathname === ME_TERMS_ACCEPTANCE_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/me/terms-acceptance", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }
    if (!options.acceptAuthenticatedUserTerms) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Terms acceptance is not configured", corsHeaders)
      );
      return;
    }

    // Deliberately not requireVerifiedAuthenticatedUser: like GET /api/me,
    // re-acceptance after a terms bump must work before the inbox is
    // verified, or an unverified user is wedged behind two interstitials.
    const userId = await resolveAuthenticatedUserId(options, request);
    if (!userId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    const payload = parseMeTermsAcceptanceBodyValue(request.body);
    // Same clickwrap rule as registration: current or listed grace version
    // only, recorded as sent — a grace-version acceptance still re-gates on
    // the next fresh (current-version) load.
    if (!isAcceptableTermsVersion(payload.accepted_terms_version)) {
      sendApiResponse(
        response,
        toErrorResponse(
          422,
          "invalid_request",
          `accepted_terms_version must be an accepted terms version (current: ${CURRENT_TERMS_VERSION})`,
          corsHeaders
        )
      );
      return;
    }

    const user = await options.acceptAuthenticatedUserTerms(userId, payload.accepted_terms_version);
    sendApiResponse(response, toJsonResponse(200, { user }, corsHeaders));
    return;
  }

  if (url.pathname === ME_PASSWORD_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/me/password", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId || !options.authService) {
      sendApiResponse(
        response,
        !options.resolveAuthenticatedUserId
          ? toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders)
          : toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders)
      );
      return;
    }

    const userId = await resolveAuthenticatedUserId(options, request);
    if (!userId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    // Password-verifying endpoint: per-account throttle, see DELETE /api/me.
    if (!(await enforceAuthRateLimit(options, request, response, userId))) {
      return;
    }

    const payload = parseMePasswordBodyValue(request.body);
    // changePassword rotates every session; hand the fresh one back so the
    // caller stays logged in while any stolen session dies. Mobile callers
    // get it in the body (their Bearer id was just revoked) and no
    // Set-Cookie, so native cookie jars never hold a session copy that could
    // later diverge from the Bearer header.
    const result = await options.authService.changePassword({
      userId,
      currentPassword: payload.current_password,
      newPassword: payload.new_password,
    });
    const mobileClient = isMobileClientRequest(request);
    sendApiResponse(response, {
      ...toJsonResponse(200, { status: "ok" }, corsHeaders),
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
        ...(mobileClient
          ? {}
          : {
              "set-cookie": serializeAuthSessionCookie(result.sessionId, {
                ...options.authSessionCookieOptions,
              }),
            }),
      },
      body: mobileClient ? { status: "ok", session_id: result.sessionId } : { status: "ok" },
      statusCode: 200,
    });
    return;
  }

  if (url.pathname === ME_EMAIL_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/me/email", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId || !options.authService) {
      sendApiResponse(
        response,
        !options.resolveAuthenticatedUserId
          ? toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders)
          : toErrorResponse(500, "internal_error", "Authentication is not configured", corsHeaders)
      );
      return;
    }

    const userId = await resolveAuthenticatedUserId(options, request);
    if (!userId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    // Password-verifying endpoint: per-account throttle, see DELETE /api/me.
    if (!(await enforceAuthRateLimit(options, request, response, userId))) {
      return;
    }

    const payload = parseMeEmailBodyValue(request.body);
    await options.authService.requestEmailChange({
      userId,
      newEmail: payload.new_email,
      password: payload.password,
    });
    sendApiResponse(response, toJsonResponse(200, { status: "ok" }, corsHeaders));
    return;
  }

  if (url.pathname === ME_ADDRESS_PATH) {
    if (request.method !== "PUT") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use PUT /api/me/address", {
          ...corsHeaders,
          allow: "PUT",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }
    if (!options.updateAuthenticatedAddressDistricts) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Authenticated address update is not configured", corsHeaders)
      );
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    const payload = parseAuthenticatedAddressBodyValue(request.body);
    const result = await options.updateAuthenticatedAddressDistricts(userId, payload.address);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_CANDIDATE_FOLLOWS_PATH) {
    if (request.method !== "GET" && request.method !== "PUT") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET or PUT /api/me/candidate-follows", {
          ...corsHeaders,
          allow: "GET, PUT",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    if (request.method === "GET") {
      if (!options.listAuthenticatedCandidateFollows) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Authenticated candidate follow lookup is not configured", corsHeaders)
        );
        return;
      }

      const result = await options.listAuthenticatedCandidateFollows(userId);
      sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
      return;
    }

    if (!options.setAuthenticatedCandidateFollow) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Authenticated candidate follow storage is not configured", corsHeaders)
      );
      return;
    }

    const payload = parseCandidateFollowBodyValue(request.body);
    const result = await options.setAuthenticatedCandidateFollow(userId, payload);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_ELECTION_CHOICES_PATH) {
    if (request.method !== "GET" && request.method !== "PUT") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET or PUT /api/me/election-choices", {
          ...corsHeaders,
          allow: "GET, PUT",
        })
      );
      return;
    }
    // Not verification-gated (unlike follows): a planned vote is private to
    // the session holder and triggers no notifications, so any registered
    // session may read and write it.
    const userId = await resolveAuthenticatedUserId(options, request);
    if (!userId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    if (request.method === "GET") {
      if (!options.listAuthenticatedElectionChoices) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Authenticated election choice lookup is not configured", corsHeaders)
        );
        return;
      }

      const result = await options.listAuthenticatedElectionChoices(userId);
      sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
      return;
    }

    if (!options.setAuthenticatedElectionChoice) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Authenticated election choice storage is not configured", corsHeaders)
      );
      return;
    }

    const payload = parseElectionChoiceBodyValue(request.body);
    const result = await options.setAuthenticatedElectionChoice(userId, payload);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_AUTO_PICKS_PATH) {
    if (request.method !== "POST" && request.method !== "DELETE") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST or DELETE /api/me/auto-picks", {
          ...corsHeaders,
          allow: "POST, DELETE",
        })
      );
      return;
    }
    // Same auth posture as election choices: session required, no
    // verification gate — auto picks are private planning.
    const userId = await resolveAuthenticatedUserId(options, request);
    if (!userId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    if (request.method === "DELETE") {
      // Body-less: clears every auto pick on the user's upcoming elections
      // in one server-side statement (a per-row PUT loop would trip the
      // global per-IP rate limit and race stale client state).
      if (!options.clearAuthenticatedAutoPicks) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Auto-pick storage is not configured", corsHeaders)
        );
        return;
      }
      const result = await options.clearAuthenticatedAutoPicks(userId, parseAutoPicksClearQuery(url));
      sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
      return;
    }

    if (!options.applyAuthenticatedAutoPicks) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Auto-pick storage is not configured", corsHeaders)
      );
      return;
    }

    const payload = parseAutoPicksBodyValue(request.body);
    const result = await options.applyAuthenticatedAutoPicks(userId, payload);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_PICK_CARD_SHARES_PATH) {
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET, POST, or DELETE /api/me/pick-card-shares", {
          ...corsHeaders,
          allow: "GET, POST, DELETE",
        })
      );
      return;
    }
    // Same auth posture as election choices: session required, no
    // verification gate — sharing your own picks sends no notifications.
    const userId = await resolveAuthenticatedUserId(options, request);
    if (!userId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    if (request.method === "GET") {
      if (!options.listAuthenticatedPickCardShares) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Pick card share storage is not configured", corsHeaders)
        );
        return;
      }
      const result = await options.listAuthenticatedPickCardShares(userId);
      sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
      return;
    }

    if (request.method === "DELETE") {
      // Body-less revoke of one date's link, scoped by query so the request
      // needs no JSON content type (mirrors DELETE /api/me/auto-picks).
      if (!options.deleteAuthenticatedPickCardShare) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Pick card share storage is not configured", corsHeaders)
        );
        return;
      }
      const result = await options.deleteAuthenticatedPickCardShare(userId, parsePickCardShareDeleteQuery(url));
      sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
      return;
    }

    if (!options.createAuthenticatedPickCardShare) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Pick card share storage is not configured", corsHeaders)
      );
      return;
    }

    const payload = parsePickCardShareBodyValue(request.body);
    const result = await options.createAuthenticatedPickCardShare(userId, payload.electionDate);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (isPickCardPath(url.pathname)) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/pick-cards/:token", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.lookupPublicPickCard) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Pick card lookup is not configured", corsHeaders)
      );
      return;
    }

    // The share-link preview image (og:image target). Checked before the
    // plain token parse because the JSON route's parser rejects any extra
    // path segment.
    if (isPickCardImagePath(url.pathname)) {
      const token = parsePickCardImageToken(url);
      const card = await options.lookupPublicPickCard(token);
      if (!card) {
        sendApiResponse(response, toErrorResponse(404, "not_found", "Pick card not found", corsHeaders));
        return;
      }
      const png = await renderPickCardOgImage({ firstName: card.first_name, electionDate: card.election_date });
      // A day of caching is safe: the image carries only first name +
      // election date, both effectively fixed for the life of a share.
      sendApiResponse(
        response,
        toPngResponse(200, png, { ...corsHeaders, "cache-control": PICK_CARD_OG_IMAGE_CACHE_CONTROL })
      );
      return;
    }

    const token = parsePickCardToken(url);
    const card = await options.lookupPublicPickCard(token);
    if (!card) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Pick card not found", corsHeaders));
      return;
    }
    sendApiResponse(response, toJsonResponse(200, card, corsHeaders));
    return;
  }

  // [ballot-personalized-ordering]
  if (url.pathname === ME_BALLOT_PREFERENCES_PATH) {
    if (request.method !== "GET" && request.method !== "PUT") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET or PUT /api/me/ballot-preferences", {
          ...corsHeaders,
          allow: "GET, PUT",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    if (request.method === "GET") {
      if (!options.getAuthenticatedBallotPreferences) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Authenticated ballot preferences lookup is not configured", corsHeaders)
        );
        return;
      }

      const result = await options.getAuthenticatedBallotPreferences(userId);
      sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
      return;
    }

    if (!options.setAuthenticatedBallotPreferences) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Authenticated ballot preference storage is not configured", corsHeaders)
      );
      return;
    }

    const preferences = parseBallotPreferencesBodyValue(request.body);
    const result = await options.setAuthenticatedBallotPreferences(userId, preferences);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_EMAIL_PREFERENCES_PATH) {
    if (request.method !== "GET" && request.method !== "PUT") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET or PUT /api/me/email-preferences", {
          ...corsHeaders,
          allow: "GET, PUT",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    if (request.method === "GET") {
      if (!options.getAuthenticatedEmailPreferences) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Authenticated email preferences lookup is not configured", corsHeaders)
        );
        return;
      }

      const result = await options.getAuthenticatedEmailPreferences(userId);
      sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
      return;
    }

    if (!options.setAuthenticatedEmailPreferences) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Authenticated email preference storage is not configured", corsHeaders)
      );
      return;
    }

    const preferences = parseEmailPreferencesBodyValue(request.body);
    const result = await options.setAuthenticatedEmailPreferences(userId, preferences);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_MEMBERSHIP_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/me/membership", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    // Verified-email gate like the other account-settings reads: payment
    // state belongs to a confirmed inbox.
    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    // Not the 500 the other unwired options answer: Stripe unconfigured is a
    // normal deployment state, and { enabled: false } is how the frontend
    // knows to hide the whole support section.
    if (!options.getAuthenticatedMembership) {
      sendApiResponse(response, toJsonResponse(200, { enabled: false }, corsHeaders));
      return;
    }

    const result = await options.getAuthenticatedMembership(userId);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_MEMBERSHIP_CHECKOUT_PATH) {
    // Unwired → 404 before the method check, like the chatbot paths: without
    // Stripe config the mutating endpoints stay hidden entirely.
    if (!options.createAuthenticatedMembershipCheckout) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", corsHeaders));
      return;
    }
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/me/membership/checkout", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    const payload = parseMembershipCheckoutBodyValue(request.body);
    const result = await options.createAuthenticatedMembershipCheckout(userId, payload);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_MEMBERSHIP_PORTAL_PATH) {
    // Same isolation contract as the checkout path: unwired → 404.
    if (!options.createAuthenticatedMembershipPortal) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", corsHeaders));
      return;
    }
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/me/membership/portal", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    const payload = parseMembershipPortalBodyValue(request.body);
    const result = await options.createAuthenticatedMembershipPortal(userId, payload);
    if (!result) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "No billing account", corsHeaders));
      return;
    }
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_MEMBERSHIP_CANCEL_PATH || url.pathname === ME_MEMBERSHIP_RESUME_PATH) {
    // Manage-page actions (docs/plans/membership-manage-page.md). Same
    // isolation contract as checkout/portal: unwired → 404. Both answer the
    // fresh membership status so the client replaces its cache in one step.
    const action =
      url.pathname === ME_MEMBERSHIP_CANCEL_PATH
        ? options.cancelAuthenticatedMembership
        : options.resumeAuthenticatedMembership;
    if (!action) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", corsHeaders));
      return;
    }
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", `Use POST ${url.pathname}`, {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    const result = await action(userId);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_MEMBERSHIP_AMOUNT_PATH) {
    // Amount change (docs/plans/membership-manage-page.md): same contract as
    // cancel/resume, plus a validated body.
    if (!options.changeAuthenticatedMembershipAmount) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", corsHeaders));
      return;
    }
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/me/membership/amount", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    const payload = parseMembershipAmountBodyValue(request.body);
    const result = await options.changeAuthenticatedMembershipAmount(userId, payload);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === STRIPE_WEBHOOK_PATH) {
    // Unwired → 404 before the method check: without Stripe config nothing
    // should suggest the endpoint exists.
    if (!options.handleStripeWebhookEvent) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", corsHeaders));
      return;
    }
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/stripe/webhook", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }

    // No session auth: the signature check inside the handler is the
    // authentication. Response policy (the delivery guarantee): 400 bad
    // signature, 2xx committed-or-ignored, thrown errors → 5xx → Stripe
    // retries for ~3 days.
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      sendApiResponse(response, toErrorResponse(400, "invalid_request", "Missing request body", corsHeaders));
      return;
    }
    const signatureHeader = readHeader(request.headers, "stripe-signature")?.trim() || null;
    const result = await options.handleStripeWebhookEvent({ rawBody, signatureHeader });
    if (result === "bad_signature") {
      sendApiResponse(response, toErrorResponse(400, "invalid_request", "Invalid webhook signature", corsHeaders));
      return;
    }
    sendApiResponse(response, toJsonResponse(200, { received: true }, corsHeaders));
    return;
  }

  if (url.pathname === ME_PUSH_TOKENS_PATH) {
    if (request.method !== "POST" && request.method !== "DELETE") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST or DELETE /api/me/push-tokens", {
          ...corsHeaders,
          allow: "POST, DELETE",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    // Same verified-email gate as the other notification preferences: the
    // senders only ever deliver to verified accounts, so an unverified
    // registration would be a dead row.
    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    if (request.method === "POST") {
      if (!options.registerAuthenticatedPushToken) {
        sendApiResponse(
          response,
          toErrorResponse(500, "internal_error", "Push token registration is not configured", corsHeaders)
        );
        return;
      }

      const input = parsePushTokenRegisterBodyValue(request.body);
      await options.registerAuthenticatedPushToken(userId, input);
      sendApiResponse(response, toJsonResponse(200, { status: "registered" }, corsHeaders));
      return;
    }

    if (!options.revokeAuthenticatedPushToken) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Push token revocation is not configured", corsHeaders)
      );
      return;
    }

    const { expoPushToken } = parsePushTokenDeleteBodyValue(request.body);
    await options.revokeAuthenticatedPushToken(userId, expoPushToken);
    sendApiResponse(response, toJsonResponse(200, { status: "revoked" }, corsHeaders));
    return;
  }

  if (url.pathname === EMAIL_UNSUBSCRIBE_PATH) {
    // GET serves the human click from the email footer; POST serves RFC 8058
    // one-click unsubscribes from mailbox providers. Both are token-authorized
    // and session-free, and answer with a tiny standalone HTML page.
    if (request.method !== "GET" && request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET or POST /api/email/unsubscribe", {
          ...corsHeaders,
          allow: "GET, POST",
        })
      );
      return;
    }
    if (!options.unsubscribeFromEmailNotifications) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Email unsubscribe is not configured", corsHeaders)
      );
      return;
    }

    const token = url.searchParams.get("token")?.trim() ?? "";
    const settingsUrl = buildEmailSettingsUrl(options.publicSiteOrigin);
    const htmlHeaders = {
      ...corsHeaders,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": EMAIL_UNSUBSCRIBE_PAGE_CSP,
    };
    const sendInvalidPage = () => {
      response.status(400).set(htmlHeaders).send(renderEmailUnsubscribeInvalidPage({ settingsUrl }));
    };
    // GET must not mutate: mail security gateways, previewers, and prefetchers
    // GET every link in an email body, which would silently unsubscribe users.
    // GET renders a confirmation form that POSTs back here; POST (the form and
    // RFC 8058 one-click) performs the unsubscribe.
    const mode = request.method === "GET" ? ("confirm" as const) : ("execute" as const);
    // The opt-in(s) the link advertised. Unknown values 400 rather than
    // falling back: a mangled link must not flip a different opt-in than the
    // email advertised. A link without pref is a legacy digest link.
    const parsedLinked = parseEmailUnsubscribePreferences(url.searchParams.getAll("pref"));
    const linkedPreferences = parsedLinked && parsedLinked.length === 0 ? (["digest"] as const) : parsedLinked;
    // The confirmation form posts its checkbox choices in the body (marked
    // form=1) so the user can widen or narrow the selection; without the
    // marker (one-click and bodiless POSTs) exactly the advertised opt-ins
    // are unsubscribed.
    const form = parseEmailUnsubscribeFormBody(request.body);
    const selectedPreferences =
      mode === "execute" && form.isForm ? parseEmailUnsubscribePreferences(form.preferenceValues) : linkedPreferences;
    if (!token || !linkedPreferences || !selectedPreferences) {
      sendInvalidPage();
      return;
    }
    // The form action keeps the link's own scope: after an empty submit the
    // retry page must pre-check the same opt-in the email advertised, not
    // fall back to the legacy digest default.
    const formAction =
      `${EMAIL_UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}` +
      linkedPreferences.map((preference) => `&pref=${encodeURIComponent(preference)}`).join("");
    if (selectedPreferences.length === 0) {
      // Form submitted with nothing checked: change nothing, ask again. Still
      // verify the token first so a garbage link gets the invalid page.
      const outcome = await options.unsubscribeFromEmailNotifications(token, "confirm", linkedPreferences);
      if (outcome !== "ok") {
        sendInvalidPage();
        return;
      }
      response.status(400).set(htmlHeaders).send(
        renderEmailUnsubscribeConfirmPage({
          formAction,
          selected: linkedPreferences,
          settingsUrl,
          notice: "Choose at least one kind of email to unsubscribe from.",
        })
      );
      return;
    }
    const outcome = await options.unsubscribeFromEmailNotifications(token, mode, selectedPreferences);
    if (outcome !== "ok") {
      sendInvalidPage();
      return;
    }
    response
      .status(200)
      .set(htmlHeaders)
      .send(
        mode === "confirm"
          ? renderEmailUnsubscribeConfirmPage({ formAction, selected: selectedPreferences, settingsUrl })
          : renderEmailUnsubscribeDonePage({ preferences: selectedPreferences, settingsUrl })
      );
    return;
  }

  if (url.pathname === ME_RESEARCH_AREA_PREFERENCES_PATH) {
    if (request.method !== "GET" && request.method !== "PUT") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET or PUT /api/me/research-area-preferences", {
          ...corsHeaders,
          allow: "GET, PUT",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    if (request.method === "GET") {
      if (!options.listAuthenticatedResearchAreaPreferences) {
        sendApiResponse(
          response,
          toErrorResponse(
            500,
            "internal_error",
            "Authenticated research area preferences lookup is not configured",
            corsHeaders
          )
        );
        return;
      }

      const result = await options.listAuthenticatedResearchAreaPreferences(userId);
      sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
      return;
    }

    if (!options.replaceAuthenticatedResearchAreaPreferences) {
      sendApiResponse(
        response,
        toErrorResponse(
          500,
          "internal_error",
          "Authenticated research area preference storage is not configured",
          corsHeaders
        )
      );
      return;
    }

    const payload = parseResearchAreaPreferencesBodyValue(request.body);
    const result = await options.replaceAuthenticatedResearchAreaPreferences(userId, payload.preferences);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  // Before the candidate-detail branch: the search path shares its prefix,
  // and parseCandidateId rejects "search" as an invalid UUID.
  if (url.pathname === CANDIDATE_SEARCH_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/candidates/search", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.searchCandidates) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Candidate search is not configured", corsHeaders)
      );
      return;
    }

    const searchQuery = parseCandidateSearchQuery(url);
    const result = await options.searchCandidates(searchQuery);
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (isCandidateDetailPath(url.pathname)) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/candidates/:candidate_id", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.lookupCandidateDetail) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Candidate detail lookup is not configured", corsHeaders)
      );
      return;
    }

    const candidateId = parseCandidateId(url);
    const userId = await resolveAuthenticatedUserId(options, request);
    const result = await options.lookupCandidateDetail(candidateId, userId);
    if (!result) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Candidate not found", corsHeaders));
      return;
    }
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  // Before the election-detail branch: the finance path shares its prefix,
  // and parseElectionId rejects any path with extra segments.
  if (isCandidateElectionFinancePath(url.pathname)) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(
          405,
          "method_not_allowed",
          "Use GET /api/elections/:election_id/candidates/:candidate_id/finance",
          {
            ...corsHeaders,
            allow: "GET",
          }
        )
      );
      return;
    }
    if (!options.lookupCandidateElectionFinance) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Candidate election finance lookup is not configured", corsHeaders)
      );
      return;
    }

    const { electionId, candidateId } = parseCandidateElectionFinancePath(url);
    const result = await options.lookupCandidateElectionFinance(electionId, candidateId);
    if (!result) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Candidate election not found", corsHeaders));
      return;
    }
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (isElectionDetailPath(url.pathname)) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/elections/:election_id", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.lookupElectionDetail) {
      sendApiResponse(response, toErrorResponse(500, "internal_error", "Election detail lookup is not configured", corsHeaders));
      return;
    }

    const electionId = parseElectionId(url);
    const result = await options.lookupElectionDetail(electionId);
    if (!result) {
      sendApiResponse(response, toErrorResponse(404, "not_found", "Election not found", corsHeaders));
      return;
    }
    sendApiResponse(response, toJsonResponse(200, result, corsHeaders));
    return;
  }

  if (url.pathname === ME_DISTRICTS_PATH) {
    if (request.method !== "GET") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use GET /api/me/districts", {
          ...corsHeaders,
          allow: "GET",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }
    if (!options.listAuthenticatedDistrictIds) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Authenticated district lookup is not configured", corsHeaders)
      );
      return;
    }

    // Same verified-email gate as GET /api/me/ballot: district ids are
    // personal location data.
    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    const districtIds = await options.listAuthenticatedDistrictIds(userId);
    sendApiResponse(response, toJsonResponse(200, { district_ids: districtIds }, corsHeaders));
    return;
  }

  if (url.pathname === ME_DISTRICTS_INITIALIZE_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/me/districts/initialize", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.resolveAuthenticatedUserId) {
      sendApiResponse(response, toErrorResponse(401, "unauthorized", "Authentication is required", corsHeaders));
      return;
    }
    if (!options.initializeUserDistricts) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "User district initialization is not configured", corsHeaders)
      );
      return;
    }

    const userId = await requireVerifiedAuthenticatedUser(options, request, response);
    if (!userId) {
      return;
    }

    const payload = parseInitializeUserDistrictsBodyValue(request.body);
    const result = await options.initializeUserDistricts({
      userId,
      districtIds: payload.district_ids,
    });
    sendApiResponse(
      response,
      toJsonResponse(
        200,
        {
          status: result.status,
          district_count: result.districtCount,
        },
        corsHeaders
      )
    );
    return;
  }

  if (url.pathname === ADDRESS_AUTOCOMPLETE_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/address/autocomplete", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.suggestAddresses) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Address autocomplete is not configured", corsHeaders)
      );
      return;
    }

    const payload = parseAutocompleteSuggestBodyValue(request.body);
    const suggestions = await options.suggestAddresses({
      input: payload.input,
      sessionToken: payload.session_token,
    });
    sendApiResponse(response, toJsonResponse(200, { suggestions }, corsHeaders));
    return;
  }

  if (url.pathname === ADDRESS_AUTOCOMPLETE_RETRIEVE_PATH) {
    if (request.method !== "POST") {
      sendApiResponse(
        response,
        toErrorResponse(405, "method_not_allowed", "Use POST /api/address/autocomplete/retrieve", {
          ...corsHeaders,
          allow: "POST",
        })
      );
      return;
    }
    if (!options.retrieveSuggestedAddress) {
      sendApiResponse(
        response,
        toErrorResponse(500, "internal_error", "Address autocomplete is not configured", corsHeaders)
      );
      return;
    }

    const payload = parseAutocompleteRetrieveBodyValue(request.body);
    const result = await options.retrieveSuggestedAddress({
      placeId: payload.place_id,
      sessionToken: payload.session_token,
    });
    sendApiResponse(
      response,
      toJsonResponse(
        200,
        {
          address: result.address,
          location: result.location,
          granularity: result.granularity,
          postal_code: result.postal_code,
          state: result.state,
          locality: result.locality,
        },
        corsHeaders
      )
    );
    return;
  }

  // Address resolve is the last route, and it is gated explicitly: a path
  // that isKnownApiPath recognizes but no branch above handles must answer
  // 404, not fall through into an address lookup. Nothing advertised falls
  // through today; this keeps a future recognition/dispatch mismatch from
  // silently becoming a resolve request.
  if (url.pathname !== ADDRESS_RESOLVE_PATH) {
    sendApiResponse(response, toErrorResponse(404, "not_found", "Not found", corsHeaders));
    return;
  }

  if (request.method !== "POST") {
    sendApiResponse(
      response,
      toErrorResponse(405, "method_not_allowed", "Use POST /api/address/resolve", {
        ...corsHeaders,
        allow: "POST",
      })
    );
    return;
  }

  const payload = parsePublicAddressResolveBodyValue(request.body);
  // The clickwrap is enforced here, not only in the browser: a search is the
  // act the terms gate, so the endpoint refuses to perform one without a
  // current-version acceptance. Nothing about the acceptance is stored — the
  // visitor is anonymous, and the evidence that matters (what the gate said,
  // and that it could not be bypassed) lives in this code and in
  // docs/legal/, not in a row naming their IP address.
  // An unknown version is refused outright, the same rule registration
  // follows; a listed grace version (stale bundle showing the documents it
  // names) is accepted — see GRACE_TERMS_VERSIONS.
  if (!isAcceptableTermsVersion(payload.accepted_terms_version)) {
    sendApiResponse(
      response,
      toErrorResponse(
        400,
        "invalid_request",
        `accepted_terms_version must be an accepted terms version (current: ${CURRENT_TERMS_VERSION})`,
        corsHeaders
      )
    );
    return;
  }

  const result = await options.resolveAddress(
    payload.address,
    payload.coordinates,
    payload.allow_partial,
    payload.region_state,
    payload.region_locality
  );
  if (options.logDiagnostics) {
    try {
      options.logDiagnostics(toAddressResolutionDiagnostics(result));
    } catch {
      // Diagnostics are best-effort; do not fail an otherwise successful request.
    }
  }

  sendApiResponse(response, toJsonResponse(200, toPublicAddressResolution(result), corsHeaders));
}

function mapExpressErrorToResponse(error: unknown): ApiResponse {
  const bodyParserError = error as ExpressBodyParserError;
  if (bodyParserError?.type === "entity.too.large" || bodyParserError?.status === 413 || bodyParserError?.statusCode === 413) {
    return toErrorResponse(413, "invalid_request", `request body exceeds ${MAX_ADDRESS_REQUEST_BODY_BYTES} bytes`);
  }
  if (bodyParserError?.type === "entity.parse.failed") {
    return toErrorResponse(400, "invalid_json", "Request body must be valid JSON");
  }

  const mapped = mapErrorToResponse(error);
  return toErrorResponse(mapped.statusCode, mapped.code, mapped.message);
}

function createApiErrorMiddleware(options: AddressApiServerOptions) {
  return (
    error: unknown,
    request: Request,
    response: Response<unknown, ApiResponseLocals>,
    next: NextFunction
  ): void => {
    if (response.headersSent) {
      next(error);
      return;
    }

    let mapped = mapExpressErrorToResponse(error);
    // 500 only: 502/503 are recognized upstream failures with meaningful
    // bodies (and would flood the log during an outage), but a mapped 500
    // means "we don't know what this is".
    if (mapped.statusCode === 500) {
      // Unexpected failure: without this line the error vanishes — the
      // response body is a generic "Internal error" by design. The id ties
      // a user report ("I saw an error") to this log entry. Method + path
      // only; request bodies can carry addresses and credentials.
      const requestId = randomUUID();
      // describeError: stack string only (never the object, whose enumerable
      // custom properties can carry payloads), with emails and query strings
      // masked — local logs get the same scrubbing as Sentry events.
      console.error(
        `[api] unexpected error request_id=${requestId} ${request.method} ${request.path}`,
        describeError(error)
      );
      // Error-monitoring hook (Sentry in production). Failure here must
      // never break the response.
      try {
        options.captureUnexpectedError?.(error, {
          requestId,
          method: request.method,
          path: request.path,
        });
      } catch {
        // Monitoring is best-effort by definition.
      }
      const body = mapped.body as ApiErrorBody;
      mapped = {
        ...mapped,
        body: { error: { ...body.error, request_id: requestId } } satisfies ApiErrorBody,
      };
    }
    sendApiResponse(response, {
      ...mapped,
      headers: {
        ...mapped.headers,
        ...getCorsHeaders(response),
      },
    });
  };
}

export function createApiApp(options: AddressApiServerOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // Everything this API serves is dynamic and often personalized (/api/me,
  // ballot, auth, unsubscribe pages), so default every response to no-store
  // and keep heuristic/shared caches out. Handlers with genuinely cacheable
  // output (the sitemap) overwrite it per-response via their own headers.
  app.use((_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  // Ordering is load-bearing:
  // - CORS/preflight and unknown-path handling run before rate limiting.
  // - Rate limiting runs before JSON body parsing so oversized POSTs cannot bypass it.
  // - Method checks happen in dispatch so known-path wrong methods can still be rate limited.
  app.use(createClientIpMiddleware(options));
  app.use(createCorsAndPreflightMiddleware(options));
  app.use(createRateLimitMiddleware(options));
  app.use(createContentReportRateLimitMiddleware(options));
  app.use(createStripeWebhookBodyParser());
  app.use(createJsonBodyParser());
  app.use(createEmailUnsubscribeFormBodyParser());
  app.use((request, response, next) => {
    void dispatchApiRequest(request, response, options).catch(next);
  });
  app.use(createApiErrorMiddleware(options));

  return app;
}

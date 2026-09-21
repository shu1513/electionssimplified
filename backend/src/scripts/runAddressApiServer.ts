import type { Server } from "node:http";
import { Pool } from "pg";
import { createClient } from "redis";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import Stripe from "stripe";

import {
  createInMemoryAuthApiRateLimiter,
  DEFAULT_AUTH_API_RATE_LIMIT_MAX_BUCKETS,
  DEFAULT_AUTH_API_RATE_LIMIT_MAX_REQUESTS_PER_EMAIL,
  DEFAULT_AUTH_API_RATE_LIMIT_MAX_REQUESTS_PER_IP,
  DEFAULT_AUTH_API_RATE_LIMIT_WINDOW_MS,
} from "../api/authApiRateLimiter.js";
import type { AuthSessionCookieOptions } from "../auth/authCookies.js";
import { createConsoleAuthMailer, createSesAuthMailer } from "../auth/authMailer.js";
import {
  createAuthService,
  DEFAULT_AUTH_EMAIL_VERIFICATION_TTL_SECONDS,
  DEFAULT_AUTH_PASSWORD_RESET_TTL_SECONDS,
  DEFAULT_AUTH_SESSION_TTL_SECONDS,
} from "../auth/authService.js";
import { createGoogleIdTokenVerifier } from "../auth/googleIdToken.js";
import {
  assertTrustedUserIdHeaderConfigIsSafe,
  createSessionAwareTrustedUserIdResolver,
  createTrustedUserIdResolver,
} from "../api/addressApiAuth.js";
import { createTrustedClientIpResolver } from "../api/addressApiClientIp.js";
import { toAddressResolutionDiagnostics, type AddressResolutionDiagnostics } from "../api/addressApiResponses.js";
import { buildAllowedOrigins } from "../api/apiCors.js";
import { createApiApp } from "../api/apiServer.js";
import { attachApiDbPoolErrorHandler, buildApiDbPoolConfig, createApiDbPoolHealthCheck } from "../api/apiDbPool.js";
import {
  createInMemoryContentReportRateLimiter,
  DEFAULT_CONTENT_REPORT_RATE_LIMIT_MAX_BUCKETS,
  DEFAULT_CONTENT_REPORT_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_CONTENT_REPORT_RATE_LIMIT_WINDOW_MS,
} from "../api/contentReportRateLimiter.js";
import { createAskService } from "../chatbot/askService.js";
import { createFeedbackTokens, submitAnswerFeedback, type FeedbackVerdict } from "../chatbot/feedback.js";
import { readChatbotConfigFromEnv } from "../chatbot/chatbotConfig.js";
import { maybeRunQuestionRetention } from "../chatbot/maintenance.js";
import { insertUsageEvents } from "../usage/events.js";
import { maybeRunUsageRetention } from "../usage/maintenance.js";
import { createEmbeddingsClient } from "../chatbot/embeddingsClient.js";
import { createOpenAiResponsesClient } from "../chatbot/llm/openaiResponses.js";
import type { LlmAnswering } from "../chatbot/answer.js";
import { loadProjectEnv } from "../config/env.js";
import { captureError, describeError, flushSentry, initSentryFromEnv } from "../observability/sentry.js";
import {
  createInMemoryAddressApiRateLimiter,
  DEFAULT_ADDRESS_API_RATE_LIMIT_MAX_BUCKETS,
  DEFAULT_ADDRESS_API_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_ADDRESS_API_RATE_LIMIT_WINDOW_MS,
} from "../api/addressApiRateLimiter.js";
import {
  lookupBallotSummariesByDistrictIds,
  lookupCandidateElectionFinanceSummaryById,
  lookupElectionDetailById,
} from "../pipeline/address/ballotLookup.js";
import { lookupCandidateStockTradesById } from "../pipeline/stockTrades/stockTradesReader.js";
// [ballot-personalized-ordering]
import { applyBallotElectionOrdering } from "../pipeline/address/ballotElectionOrdering.js";
import { resolveAddressToDistricts } from "../pipeline/address/addressResolverService.js";
import { createAutoDistrictResearchTrigger } from "../pipeline/address/autoDistrictResearch.js";
import {
  enqueueManualDistrictResearchRequestsForStaleDistricts,
  type ManualResearchTriggerSource,
} from "../pipeline/address/manualDistrictResearchRequests.js";
import { recordManualResearchDemandForDistricts } from "../pipeline/address/manualResearchDemand.js";
import { readAutoDistrictResearchMode } from "../config/featureFlags.js";
import {
  DEFAULT_ELECTIONS_SEARCH_COOLDOWN_DAYS,
  readElectionsSearchCooldownDaysFromEnv,
} from "../pipeline/elections/electionsSearchPolicy.js";
import {
  DEFAULT_GOOGLE_PLACES_TIMEOUT_MS,
  retrieveSuggestedAddressWithGooglePlaces,
  suggestAddressesWithGooglePlaces,
} from "../pipeline/address/googlePlacesAutocomplete.js";
import { lookupCandidateDetailById } from "../pipeline/candidates/candidateDetailReader.js";
import { searchCandidatesByName } from "../pipeline/candidates/candidateSearchReader.js";
import { DEFAULT_ADDRESS_LOOKUP_CACHE_TTL_SECONDS } from "../pipeline/address/addressResolutionCache.js";
import {
  DEFAULT_CENSUS_ADDRESS_GEOCODER_BENCHMARK,
  DEFAULT_CENSUS_ADDRESS_GEOCODER_LAYERS,
  DEFAULT_CENSUS_ADDRESS_GEOCODER_TIMEOUT_MS,
  DEFAULT_CENSUS_ADDRESS_GEOCODER_VINTAGE,
} from "../pipeline/address/censusAddressGeocoder.js";
import { updateAuthenticatedAddressDistricts } from "../pipeline/users/userAddressDistrictUpdater.js";
import { createContentReport } from "../pipeline/reports/contentReports.js";
import { listUserCandidateFollows, setUserCandidateFollow } from "../pipeline/users/userCandidateFollows.js";
import { applyAutoPicks, clearAutoPicks } from "../pipeline/users/autoPick.js";
import { listUserElectionChoices, setUserElectionChoice } from "../pipeline/users/userElectionChoices.js";
import {
  deleteUserPickCardShare,
  getOrCreateUserPickCardShare,
  listUserPickCardShares,
  lookupPublicPickCard,
} from "../pipeline/users/userPickCardShares.js";
import { getStateVotingResources } from "../api/stateVotingResources.js";
import { initializeUserDistricts } from "../pipeline/users/userDistrictInitializer.js";
import { listUserDistrictIds } from "../pipeline/users/userDistrictReader.js";
import { replaceUserDistricts } from "../pipeline/users/userDistrictReplacer.js";
import {
  listSelectableResearchAreas,
  listUserResearchAreaPreferences,
  replaceUserResearchAreaPreferences,
} from "../pipeline/users/userResearchAreaPreferences.js";
import { getUserBallotPreferences, setUserBallotPreferences } from "../pipeline/users/userBallotPreferences.js";
import {
  disableUserEmailPreferences,
  getUserEmailPreferences,
  setUserEmailPreferences,
  UserEmailPreferencesError,
} from "../pipeline/users/userEmailPreferences.js";
import { registerUserPushToken, revokeUserPushToken } from "../pipeline/users/userPushTokens.js";
import { EMAIL_UNSUBSCRIBE_PREFERENCE_COLUMNS, type EmailUnsubscribePreference } from "../api/apiValidation.js";
import { verifyEmailUnsubscribeToken } from "../pipeline/users/emailUnsubscribeToken.js";
import { acceptUserTerms, getUserIdentity, setUserFirstName } from "../pipeline/users/userIdentity.js";
import { createCachedSiteSitemap } from "../pipeline/sitemap/siteSitemap.js";
import { createMembershipService, type MembershipService } from "../api/membership/membershipService.js";
import {
  createConsoleMembershipChangedSender,
  createConsoleMembershipStartedSender,
  createSesMembershipChangedSender,
  createSesMembershipStartedSender,
} from "../api/membership/membershipMailer.js";
import { readBooleanEnv, readPositiveIntegerEnv } from "../config/envReaders.js";

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readPort(): number {
  const raw = process.env.ADDRESS_API_PORT ?? "3001";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid ADDRESS_API_PORT: ${raw}`);
  }
  return parsed;
}

function readAllowedOrigins(): string[] {
  // Same-origin browser POSTs still carry an Origin header, so the site's own
  // origin must always be in the allowlist even when no cross-origin frontend
  // exists; derive it from the public base URLs so an unset
  // ADDRESS_API_ALLOWED_ORIGINS cannot 403 all browser mutations.
  return buildAllowedOrigins(process.env.ADDRESS_API_ALLOWED_ORIGINS, [
    process.env.SITE_ORIGIN,
    process.env.AUTH_PUBLIC_BASE_URL,
  ]);
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function readAuthCookieSameSiteEnv(name: string, fallback: "lax" | "strict" | "none"): "lax" | "strict" | "none" {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === "lax" || raw === "strict" || raw === "none") {
    return raw;
  }
  throw new Error(`Invalid ${name}: ${process.env[name]}`);
}

function logAddressResolutionDiagnostics(diagnostics: AddressResolutionDiagnostics, source = "address_resolve"): void {
  if (diagnostics.missing_district_keys.length === 0 && diagnostics.warnings.length === 0) {
    return;
  }
  console.warn(
    JSON.stringify({
      type: "address_resolution_diagnostics",
      ts: new Date().toISOString(),
      source,
      address_match_count: diagnostics.address_match_count,
      district_key_count: diagnostics.district_keys.length,
      missing_district_keys: diagnostics.missing_district_keys,
      warnings: diagnostics.warnings,
    })
  );
}

async function main(): Promise<void> {
  loadProjectEnv();
  // Dark unless SENTRY_DSN is set (docs/plans/plan-error-monitoring.md Phase 2).
  if (initSentryFromEnv("api")) {
    console.log("error monitoring enabled (sentry)");
  }
  // API_DATABASE_URL (optional) carries the least-privilege voteapp_api
  // credentials (docs/postgres-api-role.md). It's a separate, Blueprint-
  // unmanaged variable because render.yaml pins DATABASE_URL to the owner
  // connection string via fromDatabase — a manual edit there would be
  // silently reverted by the next Blueprint sync. Workers and migrations
  // keep using DATABASE_URL (the owner role).
  // Bounded acquisition + server-side statement deadline (see apiDbPool.ts);
  // env-tunable so operators can adjust to measured latency without a
  // code change.
  const pool = new Pool(
    buildApiDbPoolConfig({
      connectionString:
        readOptionalEnv("API_DATABASE_URL") ?? readEnv("DATABASE_URL", "postgresql://localhost:5432/voteapp"),
      connectionTimeoutMs: readPositiveIntegerEnv("API_DB_CONNECTION_TIMEOUT_MS", 10_000),
      statementTimeoutMs: readPositiveIntegerEnv("API_DB_STATEMENT_TIMEOUT_MS", 30_000),
    })
  );
  attachApiDbPoolErrorHandler(pool, captureError);
  const host = process.env.ADDRESS_API_HOST?.trim() || "127.0.0.1";
  const port = readPort();
  const allowedOrigins = readAllowedOrigins();
  // Security boundary: only trust a client-IP header when a trusted proxy/gateway
  // owns that header and strips client-supplied copies. Otherwise rate limiting uses
  // the direct socket IP.
  const trustedClientIpHeader = readOptionalEnv("ADDRESS_API_TRUSTED_CLIENT_IP_HEADER");
  if (trustedClientIpHeader) {
    console.warn(
      `address API trusting client IP header "${trustedClientIpHeader}"; ensure the edge proxy strips client-supplied copies`
    );
  }
  // When set, the client-IP header is only trusted on requests carrying the
  // matching X-Edge-Secret header (attached by the Cloudflare Worker and the
  // SSR loaders). Closes the direct *.onrender.com spoofing bypass in
  // docs/deploy-render.md. Fail fast on a weak value, like the unsubscribe
  // secret above.
  const edgeSharedSecret = readOptionalEnv("EDGE_SHARED_SECRET");
  if (edgeSharedSecret && edgeSharedSecret.length < 32) {
    throw new Error("EDGE_SHARED_SECRET must be at least 32 characters");
  }
  if (edgeSharedSecret && !trustedClientIpHeader) {
    console.warn("EDGE_SHARED_SECRET is set but ADDRESS_API_TRUSTED_CLIENT_IP_HEADER is not; the secret has no effect");
  }
  // The custom client-IP header (X-Voteapp-Client-IP) is NOT protected by
  // any edge — anyone hitting the public *.onrender.com host directly can
  // send it — so in production trusting it without the secret gate hands
  // out per-IP rate-limit evasion. Fail fast instead of booting spoofable
  // (the reserved CF-Connecting-IP at least got 403'd by Render's own
  // Cloudflare; the custom name has no such accidental shield).
  if (trustedClientIpHeader && !edgeSharedSecret && process.env.DEPLOY_ENV?.trim() === "production") {
    throw new Error(
      "ADDRESS_API_TRUSTED_CLIENT_IP_HEADER is set but EDGE_SHARED_SECRET is not; production would blindly trust a client-spoofable header"
    );
  }
  // Security boundary: only trust a user-id header when an authenticated gateway
  // injects it and strips client-supplied copies. If unset, authenticated routes
  // fail closed with 401.
  const trustedUserIdHeader = readOptionalEnv("API_TRUSTED_USER_ID_HEADER");
  if (trustedUserIdHeader) {
    console.warn(
      `API trusting authenticated user header "${trustedUserIdHeader}"; ensure the edge proxy authenticates requests and strips client-supplied copies`
    );
  }
  const trustedUserIdResolver = createTrustedUserIdResolver(trustedUserIdHeader);
  // Enables GET/POST /api/email/unsubscribe. Must match the secret the digest
  // sender signs footer links with. Fail fast on a weak secret rather than
  // 500ing on every unsubscribe click.
  const unsubscribeSecret = readOptionalEnv("NOTIFICATIONS_UNSUBSCRIBE_SECRET");
  if (unsubscribeSecret && unsubscribeSecret.length < 32) {
    throw new Error("NOTIFICATIONS_UNSUBSCRIBE_SECRET must be at least 32 characters");
  }
  const addressCacheEnabled = readBooleanEnv("ADDRESS_LOOKUP_CACHE_ENABLED", true);
  const rateLimitEnabled = readBooleanEnv("ADDRESS_API_RATE_LIMIT_ENABLED", true);
  const rateLimitWindowMs = readPositiveIntegerEnv(
    "ADDRESS_API_RATE_LIMIT_WINDOW_MS",
    DEFAULT_ADDRESS_API_RATE_LIMIT_WINDOW_MS
  );
  const rateLimitMaxRequests = readPositiveIntegerEnv(
    "ADDRESS_API_RATE_LIMIT_MAX_REQUESTS",
    DEFAULT_ADDRESS_API_RATE_LIMIT_MAX_REQUESTS
  );
  const rateLimitMaxBuckets = readPositiveIntegerEnv(
    "ADDRESS_API_RATE_LIMIT_MAX_BUCKETS",
    DEFAULT_ADDRESS_API_RATE_LIMIT_MAX_BUCKETS
  );
  const authRateLimitEnabled = readBooleanEnv("AUTH_API_RATE_LIMIT_ENABLED", true);
  const authRateLimitWindowMs = readPositiveIntegerEnv(
    "AUTH_API_RATE_LIMIT_WINDOW_MS",
    DEFAULT_AUTH_API_RATE_LIMIT_WINDOW_MS
  );
  const authRateLimitMaxRequestsPerIp = readPositiveIntegerEnv(
    "AUTH_API_RATE_LIMIT_MAX_REQUESTS_PER_IP",
    DEFAULT_AUTH_API_RATE_LIMIT_MAX_REQUESTS_PER_IP
  );
  const authRateLimitMaxRequestsPerEmail = readPositiveIntegerEnv(
    "AUTH_API_RATE_LIMIT_MAX_REQUESTS_PER_EMAIL",
    DEFAULT_AUTH_API_RATE_LIMIT_MAX_REQUESTS_PER_EMAIL
  );
  const authRateLimitMaxBuckets = readPositiveIntegerEnv(
    "AUTH_API_RATE_LIMIT_MAX_BUCKETS",
    DEFAULT_AUTH_API_RATE_LIMIT_MAX_BUCKETS
  );
  const contentReportRateLimitEnabled = readBooleanEnv("CONTENT_REPORT_RATE_LIMIT_ENABLED", true);
  const contentReportRateLimitWindowMs = readPositiveIntegerEnv(
    "CONTENT_REPORT_RATE_LIMIT_WINDOW_MS",
    DEFAULT_CONTENT_REPORT_RATE_LIMIT_WINDOW_MS
  );
  const contentReportRateLimitMaxRequests = readPositiveIntegerEnv(
    "CONTENT_REPORT_RATE_LIMIT_MAX_REQUESTS",
    DEFAULT_CONTENT_REPORT_RATE_LIMIT_MAX_REQUESTS
  );
  const contentReportRateLimitMaxBuckets = readPositiveIntegerEnv(
    "CONTENT_REPORT_RATE_LIMIT_MAX_BUCKETS",
    DEFAULT_CONTENT_REPORT_RATE_LIMIT_MAX_BUCKETS
  );
  const siteOrigin = readOptionalEnv("SITE_ORIGIN");
  if (!siteOrigin) {
    console.warn("SITE_ORIGIN is unset; /sitemap.xml will return 404");
  }
  const getSitemapXml = siteOrigin ? createCachedSiteSitemap({ db: pool, siteOrigin }) : undefined;
  const rateLimit = rateLimitEnabled
    ? createInMemoryAddressApiRateLimiter({
        windowMs: rateLimitWindowMs,
        maxRequests: rateLimitMaxRequests,
        maxBuckets: rateLimitMaxBuckets,
      })
    : undefined;
  const contentReportRateLimit = contentReportRateLimitEnabled
    ? createInMemoryContentReportRateLimiter({
        windowMs: contentReportRateLimitWindowMs,
        maxRequests: contentReportRateLimitMaxRequests,
        maxBuckets: contentReportRateLimitMaxBuckets,
      })
    : undefined;
  const addressCacheTtlSeconds = readPositiveIntegerEnv(
    "ADDRESS_LOOKUP_CACHE_TTL_SECONDS",
    DEFAULT_ADDRESS_LOOKUP_CACHE_TTL_SECONDS
  );
  // Auth needs Redis for sessions independently of the address cache toggle:
  // do not let ADDRESS_LOOKUP_CACHE_ENABLED=false silently disable auth.
  const authConfigured = Boolean(readOptionalEnv("AUTH_PUBLIC_BASE_URL"));
  assertTrustedUserIdHeaderConfigIsSafe({
    sessionAuthIntended: authConfigured,
    trustedUserIdHeader,
    allowTrustedHeaderWithSessions: readBooleanEnv("API_TRUSTED_USER_ID_HEADER_ALLOW_WITH_SESSIONS", false),
  });
  // Exactly one auto district research behavior fires per stale district: "ai"
  // drops an election draft into the staging pipeline (needs Redis for the
  // draft stream), "manual" enqueues an agent research request (Postgres only),
  // "off" no-ops. Mode and cooldown are validated at startup so a malformed
  // value fails fast instead of being swallowed per-request.
  const autoDistrictResearchMode = readAutoDistrictResearchMode();
  const autoDistrictResearchCooldownDays =
    autoDistrictResearchMode === "off"
      ? DEFAULT_ELECTIONS_SEARCH_COOLDOWN_DAYS
      : readElectionsSearchCooldownDaysFromEnv();
  const autoDistrictResearchNeedsRedis = autoDistrictResearchMode === "ai";
  // Read once, up here, because the Phase 2 LLM path needs Redis too (per-
  // user cap + answer cache); the ask wiring further down reuses this value.
  const chatbotConfig = readChatbotConfigFromEnv();
  const chatbotNeedsRedis = chatbotConfig.enabled && chatbotConfig.llm !== null;
  // Usage analytics (docs/plans/usage-analytics.md): a write feature, default
  // off, enabled explicitly per environment once the privacy policy text is
  // live. Read here because its 90-day retention is Redis-elected — a
  // deployment where analytics is the only Redis consumer must still get a
  // client, or stored events would silently outlive the promise.
  const usageAnalyticsEnabled = readBooleanEnv("USAGE_ANALYTICS_ENABLED", false);
  const redis =
    addressCacheEnabled || authConfigured || autoDistrictResearchNeedsRedis || chatbotNeedsRedis || usageAnalyticsEnabled
      ? createClient({ url: readEnv("REDIS_URL", "redis://localhost:6379") })
      : null;
  const buildAddressResolverOptions = () => ({
    cache: addressCacheEnabled && redis?.isOpen ? redis : undefined,
    cacheTtlSeconds: addressCacheTtlSeconds,
    geocoderOptions: {
      benchmark: readEnv("CENSUS_ADDRESS_GEOCODER_BENCHMARK", DEFAULT_CENSUS_ADDRESS_GEOCODER_BENCHMARK),
      vintage: readEnv("CENSUS_ADDRESS_GEOCODER_VINTAGE", DEFAULT_CENSUS_ADDRESS_GEOCODER_VINTAGE),
      layers: readEnv("CENSUS_ADDRESS_GEOCODER_LAYERS", DEFAULT_CENSUS_ADDRESS_GEOCODER_LAYERS),
      timeoutMs: readPositiveIntegerEnv("CENSUS_ADDRESS_GEOCODER_TIMEOUT_MS", DEFAULT_CENSUS_ADDRESS_GEOCODER_TIMEOUT_MS),
    },
  });
  if (redis) {
    redis.on("error", (error) => {
      console.warn("Redis error (address cache/auth sessions/auto district research); continuing without failing requests", error);
    });
    try {
      // With the default reconnect strategy an unreachable Redis keeps this
      // await pending (retrying) until it connects, so a down Redis delays
      // boot rather than rejecting here.
      await redis.connect();
    } catch (error) {
      // A rejected connect() leaves the client permanently closed — node-redis
      // only auto-reconnects after a successful connect, and nothing re-calls
      // connect() — so continuing would run without auth sessions, the address
      // cache, and auto district research for the life of the process. Fail
      // the boot instead and let the process manager restart into a clean
      // retry.
      throw new Error(
        `Redis connection failed at startup: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  const triggerAutoDistrictResearchAi = createAutoDistrictResearchTrigger({
    db: pool,
    getRedis: () => (redis?.isOpen ? redis : null),
    config: { enabled: autoDistrictResearchMode === "ai", ttlDays: autoDistrictResearchCooldownDays },
  });
  // Fire-and-forget dispatch: research stale districts without delaying or
  // failing the address response. The two destinations are mutually exclusive
  // by mode; both share the same staleness cooldown.
  const dispatchAutoDistrictResearch = (
    districts: Awaited<ReturnType<typeof resolveAddressToDistricts>>["districts"],
    triggerSource: Exclude<ManualResearchTriggerSource, "manual_seed">
  ) => {
    if (autoDistrictResearchMode === "ai") {
      void triggerAutoDistrictResearchAi(districts).catch((error) => {
        console.warn("auto district research (ai) trigger failed; address response unaffected", error);
      });
    } else if (autoDistrictResearchMode === "manual") {
      void enqueueManualDistrictResearchRequestsForStaleDistricts(pool, {
        districts,
        triggerSource,
        cooldownDays: autoDistrictResearchCooldownDays,
      }).catch((error) => {
        console.warn("manual district research enqueue failed; address response unaffected", error);
      });
      // Finer-grained demand (empty rosters, missing profiles/records/results)
      // for districts the queue above considers fresh.
      void recordManualResearchDemandForDistricts(pool, { districts, triggerSource }).catch((error) => {
        console.warn("manual research demand record failed; address response unaffected", error);
      });
    }
  };
  const resolveAddressWithAutoResearch = async (
    inputAddress: string,
    triggerSource: Exclude<ManualResearchTriggerSource, "manual_seed"> = "address_resolve",
    coordinates?: { lat: number; lng: number },
    allowPartial?: boolean,
    regionState?: string,
    regionLocality?: string
  ) => {
    const result = await resolveAddressToDistricts(pool, inputAddress, {
      ...buildAddressResolverOptions(),
      coordinates,
      allowPartial,
      regionState,
      regionLocality,
    });
    dispatchAutoDistrictResearch(result.districts, triggerSource);
    return result;
  };

  const authPublicBaseUrl = readOptionalEnv("AUTH_PUBLIC_BASE_URL");
  const authFromEmailAddress = readOptionalEnv("AUTH_FROM_EMAIL");
  const authReplyToEmailAddress = readOptionalEnv("AUTH_REPLY_TO_EMAIL");
  const authSesRegion = readOptionalEnv("AUTH_SES_REGION") ?? readOptionalEnv("AWS_REGION") ?? readOptionalEnv("AWS_DEFAULT_REGION");
  const authSessionCookieSameSite = readAuthCookieSameSiteEnv("AUTH_SESSION_COOKIE_SAME_SITE", "lax");
  // Default Secure from the public base URL scheme; browsers reject
  // SameSite=None cookies without Secure, so fail fast on that combination.
  const authSessionCookieSecure = readBooleanEnv(
    "AUTH_SESSION_COOKIE_SECURE",
    authPublicBaseUrl?.startsWith("https://") ?? false
  );
  if (authSessionCookieSameSite === "none" && !authSessionCookieSecure) {
    throw new Error("AUTH_SESSION_COOKIE_SECURE=true is required when AUTH_SESSION_COOKIE_SAME_SITE=none");
  }
  const authSessionCookieOptions: Omit<AuthSessionCookieOptions, "maxAgeSeconds"> = {
    sameSite: authSessionCookieSameSite,
    secure: authSessionCookieSecure,
    domain: readOptionalEnv("AUTH_SESSION_COOKIE_DOMAIN"),
    path: readOptionalEnv("AUTH_SESSION_COOKIE_PATH") ?? "/",
  };
  // AUTH_MAILER=console prints verification/reset links to stdout for local
  // development instead of sending email. Anything else (default "ses") uses
  // SES and requires AUTH_FROM_EMAIL plus a region.
  const authMailerKind = (readOptionalEnv("AUTH_MAILER") ?? "ses").toLowerCase();
  const authMailer =
    authMailerKind === "console"
      ? createConsoleAuthMailer()
      : authFromEmailAddress && authSesRegion
        ? createSesAuthMailer({
            sesClient: new SESv2Client({ region: authSesRegion }),
            fromEmailAddress: authFromEmailAddress,
            ...(authReplyToEmailAddress ? { replyToEmailAddress: authReplyToEmailAddress } : {}),
          })
        : null;
  // Support payments / membership (docs/plans/membership-contributions.md):
  // presence of STRIPE_SECRET_KEY turns the feature on; the other settings
  // then become required so partial config crashes at boot instead of 500ing
  // at runtime. All absent = feature cleanly off (GET /api/me/membership
  // answers { enabled: false } and the frontend hides the section).
  const stripeSecretKey = readOptionalEnv("STRIPE_SECRET_KEY");
  let membershipServiceOrNull: MembershipService | null = null;
  if (stripeSecretKey) {
    const stripeWebhookSecret = readEnv("STRIPE_WEBHOOK_SECRET");
    const stripeMembershipProductId = readEnv("STRIPE_MEMBERSHIP_PRODUCT_ID");
    const membershipPublicBaseUrl = (siteOrigin ?? authPublicBaseUrl)?.replace(/\/+$/, "");
    if (!membershipPublicBaseUrl) {
      throw new Error(
        "STRIPE_SECRET_KEY is set but SITE_ORIGIN (or AUTH_PUBLIC_BASE_URL) is not; Checkout redirect URLs need the site origin"
      );
    }
    const manageMembershipUrl = `${membershipPublicBaseUrl}/me/membership`;
    const membershipTermsUrl = `${membershipPublicBaseUrl}/terms`;
    // The §17602 membership-started acknowledgment rides the same mailer
    // config as auth email, and it is a LEGAL requirement of taking the
    // first subscription — so a Stripe-on/mailer-off process fails at boot
    // like any other partial membership config, instead of quietly starting
    // billing it can't acknowledge.
    const membershipSesMailerOptions =
      authFromEmailAddress && authSesRegion
        ? {
            sesClient: new SESv2Client({ region: authSesRegion }),
            fromEmailAddress: authFromEmailAddress,
            ...(authReplyToEmailAddress ? { replyToEmailAddress: authReplyToEmailAddress } : {}),
            manageMembershipUrl,
            termsUrl: membershipTermsUrl,
          }
        : null;
    const sendMembershipStartedEmail =
      authMailerKind === "console"
        ? createConsoleMembershipStartedSender({ manageMembershipUrl, termsUrl: membershipTermsUrl })
        : membershipSesMailerOptions
          ? createSesMembershipStartedSender(membershipSesMailerOptions)
          : null;
    // Cancel / resume confirmations ride the same config; they are courtesy
    // notices (best-effort in the service), so they never gate boot.
    const sendMembershipChangedEmail =
      authMailerKind === "console"
        ? createConsoleMembershipChangedSender({ manageMembershipUrl, termsUrl: membershipTermsUrl })
        : membershipSesMailerOptions
          ? createSesMembershipChangedSender(membershipSesMailerOptions)
          : null;
    if (!sendMembershipStartedEmail) {
      throw new Error(
        "STRIPE_SECRET_KEY is set but no mailer is configured; the membership acknowledgment email requires AUTH_FROM_EMAIL + AUTH_SES_REGION/AWS_REGION (or AUTH_MAILER=console for local development)"
      );
    }
    membershipServiceOrNull = createMembershipService({
      db: pool,
      // Bounded per-attempt timeout instead of the SDK's 80s default: the
      // checkout/portal/deletion paths run inside user-facing HTTP requests.
      // Retried POSTs carry SDK-generated idempotency keys, so retries can't
      // duplicate customers or sessions.
      stripe: new Stripe(stripeSecretKey, {
        timeout: 15_000,
        maxNetworkRetries: 2,
      }),
      webhookSecret: stripeWebhookSecret,
      membershipProductId: stripeMembershipProductId,
      publicBaseUrl: membershipPublicBaseUrl,
      sendMembershipStartedEmail,
      sendMembershipChangedEmail,
    });
    console.log("membership support payments enabled (stripe)");
  }
  const membershipService = membershipServiceOrNull;

  // Sign in with Google (docs/plans/google-sign-in.md): configured-if-present.
  // Without the client ID the service method is absent and POST
  // /api/auth/google answers 500 not-configured; everything else is unchanged.
  const googleOauthClientId = readOptionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const authService =
    authPublicBaseUrl && authMailer && redis?.isOpen
      ? createAuthService({
          db: pool,
          redis,
          mailer: authMailer,
          publicBaseUrl: authPublicBaseUrl,
          sessionTtlSeconds: DEFAULT_AUTH_SESSION_TTL_SECONDS,
          emailVerificationTtlSeconds: DEFAULT_AUTH_EMAIL_VERIFICATION_TTL_SECONDS,
          passwordResetTtlSeconds: DEFAULT_AUTH_PASSWORD_RESET_TTL_SECONDS,
          ...(googleOauthClientId
            ? { verifyGoogleIdToken: createGoogleIdTokenVerifier(googleOauthClientId) }
            : {}),
          ...(membershipService
            ? {
                cancelMembershipForAccountDeletion: (userId: string) =>
                  membershipService.cancelSubscriptionsForAccountDeletion(userId),
                syncMembershipCustomerEmail: (userId: string) => membershipService.syncCustomerEmail(userId),
              }
            : {}),
        })
      : undefined;
  if (googleOauthClientId && !authService) {
    console.warn("GOOGLE_OAUTH_CLIENT_ID is set but authentication is not fully configured; Google sign-in stays off");
  }
  if (!authService && (authPublicBaseUrl || authFromEmailAddress || authSesRegion || authMailerKind === "console")) {
    console.warn(
      "authentication is partially configured but missing required settings or Redis; auth endpoints will return 500 until AUTH_PUBLIC_BASE_URL, Redis, and either AUTH_MAILER=console or AUTH_FROM_EMAIL + AUTH_SES_REGION/AWS_REGION are set"
    );
  }
  if (authService && authMailerKind === "console") {
    console.warn("auth mailer is in console mode: verification/reset links are printed to stdout; never use in production");
  }
  const authRateLimit =
    authService && authRateLimitEnabled
      ? createInMemoryAuthApiRateLimiter({
          windowMs: authRateLimitWindowMs,
          maxRequestsPerIp: authRateLimitMaxRequestsPerIp,
          maxRequestsPerEmail: authRateLimitMaxRequestsPerEmail,
          maxBuckets: authRateLimitMaxBuckets,
        })
      : undefined;

  const resolveAuthenticatedUserId = createSessionAwareTrustedUserIdResolver({
    redis: redis?.isOpen ? redis : null,
    trustedUserIdResolver,
    // Per-request epoch check: sessions created before a password
    // reset/change or logout-all carry an older epoch and stop
    // authenticating the moment the bump commits, regardless of Redis.
    lookupUserSessionEpoch: async (userId) => {
      const result = await pool.query<{ session_epoch: number }>(
        `
          SELECT session_epoch
          FROM public.users
          WHERE id = $1::uuid
            AND deleted_at IS NULL
        `,
        [userId]
      );
      const epoch = result.rows[0]?.session_epoch;
      return typeof epoch === "number" ? epoch : null;
    },
  });
  const lookupAuthenticatedUserEmailVerified = async (userId: string): Promise<boolean> => {
    const result = await pool.query<{ email_verified: boolean }>(
      `
        SELECT email_verified
        FROM public.users
        WHERE id = $1::uuid
          AND deleted_at IS NULL
      `,
      [userId]
    );
    return result.rows[0]?.email_verified ?? false;
  };

  // Google Places autocomplete proxy: enabled only when the API key is set.
  // Endpoints return 500 not-configured otherwise; the rest of the API is
  // unaffected.
  const googlePlacesApiKey = readOptionalEnv("GOOGLE_PLACES_API_KEY");
  const googlePlacesOptions = googlePlacesApiKey
    ? {
        apiKey: googlePlacesApiKey,
        timeoutMs: readPositiveIntegerEnv("GOOGLE_PLACES_TIMEOUT_MS", DEFAULT_GOOGLE_PLACES_TIMEOUT_MS),
      }
    : null;

  // Chatbot "Ask" (docs/plans/chatbot-rag.md): flag-guarded — when
  // CHATBOT_ENABLED is false (the default) askChatbot stays unset and
  // /api/chatbot/ask 404s like any unknown path. Embeddings are optional:
  // without CHATBOT_EMBEDDINGS_URL retrieval runs keyword-only (degraded).
  // Phase 2 LLM answers additionally need CHATBOT_LLM_ENABLED + key (money
  // off by default) AND the Redis client (per-user cap + answer cache);
  // anything missing → Phase 1 retrieval-card behavior, unchanged.
  // (chatbotConfig was read up by the Redis wiring.)
  let chatbotLlm: LlmAnswering | null = null;
  if (chatbotConfig.enabled && chatbotConfig.llm) {
    // isOpen like every other Redis consumer in this file: today connect()
    // either succeeded or the boot failed, but a future connect-policy change
    // must degrade this to retrieval-only, not hand a closed client to the
    // cap/cache path.
    if (redis?.isOpen) {
      chatbotLlm = {
        config: chatbotConfig.llm,
        client: createOpenAiResponsesClient({
          baseUrl: chatbotConfig.llm.baseUrl,
          apiKey: chatbotConfig.llm.apiKey,
          model: chatbotConfig.llm.model,
          reasoningEffort: chatbotConfig.llm.reasoningEffort,
          timeoutMs: chatbotConfig.llm.timeoutMs,
        }),
        redis,
      };
    } else {
      console.warn("chatbot LLM configured but Redis is not; LLM answers stay off (retrieval-only)");
    }
  }
  // Feedback tokens are signed with CHATBOT_FEEDBACK_SECRET (render.yaml
  // generates it): the free plan spins the process down when idle, so a
  // per-boot secret would invalidate tokens across every wake-up. Unset →
  // per-boot random fallback (dev), with a warning so prod misconfig is loud.
  const chatbotFeedbackSecret = process.env.CHATBOT_FEEDBACK_SECRET?.trim();
  const chatbotFeedbackTokens = chatbotConfig.enabled
    ? createFeedbackTokens(chatbotFeedbackSecret ? Buffer.from(chatbotFeedbackSecret, "utf8") : undefined)
    : null;
  if (chatbotConfig.enabled && !chatbotFeedbackSecret) {
    console.warn(
      "CHATBOT_FEEDBACK_SECRET is unset; feedback tokens will not survive a restart (votes on pre-restart answers are dropped)"
    );
  }
  const askChatbot = chatbotConfig.enabled
    ? createAskService({
        db: pool,
        embeddings: chatbotConfig.embeddingsUrl
          ? createEmbeddingsClient({
              baseUrl: chatbotConfig.embeddingsUrl,
              timeoutMs: chatbotConfig.embeddingsTimeoutMs,
            })
          : null,
        llm: chatbotLlm,
        feedbackTokens: chatbotFeedbackTokens,
      }).ask
    : undefined;
  const submitChatbotFeedback = chatbotFeedbackTokens
    ? (token: string, verdict: FeedbackVerdict) => submitAnswerFeedback(pool, chatbotFeedbackTokens, token, verdict)
    : undefined;
  // Daily question-log retention (90-day privacy promise): no cron on the
  // free plan, so the API runs it itself — once at boot (covers short-lived
  // processes that spin down before the first tick) plus an hourly re-check
  // (the Redis SET NX election inside makes at most one real run per UTC
  // day; a failed run releases the day so a later tick retries). unref():
  // the timer must never hold a draining process open.
  //
  // Deliberately NOT behind CHATBOT_ENABLED: the promise attaches to data
  // already collected, so turning the feature off must not stop retention on
  // rows logged while it was on (an empty/absent log makes this a daily
  // no-op). Full teardown per the isolation contract is DROP SCHEMA, which
  // removes the data and the obligation together.
  // Usage-events retention rides the same schedule and, like the chatbot
  // purge, runs regardless of USAGE_ANALYTICS_ENABLED — rows stored while
  // it was on still age out.
  const runRetention = () => {
    const maintenanceRedis = redis?.isOpen ? redis : null;
    void maybeRunQuestionRetention(pool, maintenanceRedis);
    void maybeRunUsageRetention(pool, maintenanceRedis);
  };
  runRetention();
  setInterval(runRetention, 3_600_000).unref();
  // Off → POST /api/usage/events is a 404 and the frontend module is inert
  // via its own VITE_USAGE_ANALYTICS_ENABLED flag.
  if (usageAnalyticsEnabled) {
    console.log("usage analytics intake enabled (POST /api/usage/events)");
  }
  if (chatbotConfig.enabled) {
    console.log(
      `chatbot ask enabled (embeddings: ${chatbotConfig.embeddingsUrl ? "configured" : "NOT configured — keyword-only retrieval"}; LLM: ${chatbotLlm ? `${chatbotConfig.llm?.model} (effort ${chatbotConfig.llm?.reasoningEffort})` : "off — retrieval-only"})`
    );
  }

  const app = createApiApp({
    allowedOrigins,
    authService,
    ...(askChatbot ? { askChatbot } : {}),
    ...(submitChatbotFeedback ? { submitChatbotFeedback } : {}),
    captureUnexpectedError: (error, context) =>
      captureError(error, {
        request_id: context.requestId,
        method: context.method,
        path: context.path,
      }),
    ...(googlePlacesOptions
      ? {
          suggestAddresses: (input: { input: string; sessionToken: string }) =>
            suggestAddressesWithGooglePlaces(input, googlePlacesOptions),
          retrieveSuggestedAddress: (input: { placeId: string; sessionToken: string }) =>
            retrieveSuggestedAddressWithGooglePlaces(input, googlePlacesOptions),
        }
      : {}),
    authRateLimit,
    contentReportRateLimit,
    authSessionCookieOptions,
    rateLimit,
    resolveClientIp: createTrustedClientIpResolver(trustedClientIpHeader, edgeSharedSecret),
    resolveAuthenticatedUserId,
    getSitemapXml,
    // Unsubscribe pages link back to /me/settings on the public site.
    ...(siteOrigin ?? authPublicBaseUrl ? { publicSiteOrigin: siteOrigin ?? authPublicBaseUrl ?? undefined } : {}),
    createContentReport: (input) => createContentReport(pool, input),
    ...(usageAnalyticsEnabled
      ? {
          recordUsageEvents: async (rows, dropped) => {
            if (dropped > 0) {
              // Count only — the rejected payloads are never logged.
              console.warn(`usage events: dropped ${dropped} invalid event(s) from one batch`);
            }
            await insertUsageEvents(pool, rows);
          },
        }
      : {}),
    logDiagnostics: logAddressResolutionDiagnostics,
    // [ballot-personalized-ordering]: the plain reader is decorated with the
    // sort/followed-first ordering; on feature removal call the reader alone.
    lookupBallotSummaries: async (districtIds, summaryOptions) =>
      applyBallotElectionOrdering(
        pool,
        await lookupBallotSummariesByDistrictIds(pool, districtIds, {
          includePreview: summaryOptions?.includePreview,
          electionDate: summaryOptions?.electionDate,
        }),
        summaryOptions
      ),
    lookupAuthenticatedBallotSummaries: async (userId, summaryOptions) => {
      const districtIds = await listUserDistrictIds(pool, userId);
      return applyBallotElectionOrdering(
        pool,
        await lookupBallotSummariesByDistrictIds(pool, districtIds, {
          includePreview: summaryOptions?.includePreview,
        }),
        {
          ...summaryOptions,
          userId,
        }
      );
    },
    lookupAuthenticatedUserEmailVerified,
    listAuthenticatedDistrictIds: (userId) => listUserDistrictIds(pool, userId),
    lookupCandidateDetail: (candidateId, userId) => lookupCandidateDetailById(pool, { candidateId, userId }),
    searchCandidates: (searchQuery) => searchCandidatesByName(pool, searchQuery),
    lookupElectionDetail: (electionId) => lookupElectionDetailById(pool, electionId),
    lookupCandidateElectionFinance: (electionId, candidateId) =>
      lookupCandidateElectionFinanceSummaryById(pool, electionId, candidateId),
    lookupCandidateStockTrades: (candidateId) => lookupCandidateStockTradesById(pool, candidateId),
    checkDatabaseHealth: createApiDbPoolHealthCheck(pool),
    listResearchAreas: () => listSelectableResearchAreas(pool),
    getStateVotingResources: (stateAbbreviation) => getStateVotingResources(pool, stateAbbreviation),
    listAuthenticatedCandidateFollows: (userId) => listUserCandidateFollows(pool, userId),
    setAuthenticatedCandidateFollow: (userId, input) => setUserCandidateFollow(pool, userId, input),
    listAuthenticatedElectionChoices: (userId) => listUserElectionChoices(pool, userId),
    setAuthenticatedElectionChoice: (userId, input) => setUserElectionChoice(pool, userId, input),
    applyAuthenticatedAutoPicks: (userId, input) => applyAutoPicks(pool, userId, input),
    clearAuthenticatedAutoPicks: (userId, electionDate) => clearAutoPicks(pool, userId, electionDate),
    createAuthenticatedPickCardShare: (userId, electionDate) =>
      getOrCreateUserPickCardShare(pool, userId, electionDate),
    listAuthenticatedPickCardShares: (userId) => listUserPickCardShares(pool, userId),
    deleteAuthenticatedPickCardShare: (userId, electionDate) => deleteUserPickCardShare(pool, userId, electionDate),
    lookupPublicPickCard: (token) => lookupPublicPickCard(pool, token),
    // [ballot-personalized-ordering]
    getAuthenticatedBallotPreferences: (userId) => getUserBallotPreferences(pool, userId),
    setAuthenticatedBallotPreferences: (userId, preferences) => setUserBallotPreferences(pool, userId, preferences),
    getAuthenticatedUser: (userId) => getUserIdentity(pool, userId),
    acceptAuthenticatedUserTerms: (userId, termsVersion) => acceptUserTerms(pool, userId, termsVersion),
    updateAuthenticatedUserFirstName: (userId, firstName) => setUserFirstName(pool, userId, firstName),
    getAuthenticatedEmailPreferences: (userId) => getUserEmailPreferences(pool, userId),
    setAuthenticatedEmailPreferences: (userId, preferences) => setUserEmailPreferences(pool, userId, preferences),
    registerAuthenticatedPushToken: (userId, input) => registerUserPushToken(pool, userId, input),
    revokeAuthenticatedPushToken: (userId, expoPushToken) => revokeUserPushToken(pool, userId, expoPushToken),
    ...(membershipService
      ? {
          getAuthenticatedMembership: (userId: string) => membershipService.getMembership(userId),
          createAuthenticatedMembershipCheckout: (userId: string, input: { kind: "one_time" | "monthly"; amount_cents: number }) =>
            membershipService.createCheckoutSession(userId, input),
          createAuthenticatedMembershipPortal: (userId: string, input: { flow: "payment_method_update" | null }) =>
            membershipService.createPortalSession(userId, input),
          cancelAuthenticatedMembership: (userId: string) => membershipService.cancelMembership(userId),
          resumeAuthenticatedMembership: (userId: string) => membershipService.resumeMembership(userId),
          changeAuthenticatedMembershipAmount: (userId: string, input: { amount_cents: number }) =>
            membershipService.changeMonthlyAmount(userId, input),
          handleStripeWebhookEvent: (input: { rawBody: Buffer; signatureHeader: string | null }) =>
            membershipService.handleWebhookEvent(input),
        }
      : {}),
    ...(unsubscribeSecret
      ? {
          unsubscribeFromEmailNotifications: async (
            token: string,
            mode: "confirm" | "execute",
            preferences: readonly EmailUnsubscribePreference[]
          ) => {
            const userId = verifyEmailUnsubscribeToken(token, unsubscribeSecret);
            if (!userId) {
              return "invalid_token" as const;
            }
            if (mode === "confirm") {
              return "ok" as const;
            }
            try {
              await disableUserEmailPreferences(
                pool,
                userId,
                preferences.map((preference) => EMAIL_UNSUBSCRIBE_PREFERENCE_COLUMNS[preference])
              );
            } catch (error) {
              // A valid token for a since-deleted account still reports
              // success so the page does not leak account state.
              if (!(error instanceof UserEmailPreferencesError && error.code === "user_not_found")) {
                throw error;
              }
            }
            return "ok" as const;
          },
        }
      : {}),
    listAuthenticatedResearchAreaPreferences: (userId) => listUserResearchAreaPreferences(pool, userId),
    replaceAuthenticatedResearchAreaPreferences: (userId, preferences) =>
      replaceUserResearchAreaPreferences(pool, userId, preferences),
    updateAuthenticatedAddressDistricts: (userId, address) =>
      updateAuthenticatedAddressDistricts(
        {
          // Unlike the anonymous resolve handler, this path has no
          // logDiagnostics hook, and the partial-resolution 503 it can turn
          // into is an expected error that never reaches Sentry — so log the
          // missing keys and warnings here or operators would have nothing
          // to repair the districts data from.
          resolveAddressToDistricts: async (inputAddress) => {
            const result = await resolveAddressWithAutoResearch(inputAddress, "me_address_update");
            try {
              logAddressResolutionDiagnostics(toAddressResolutionDiagnostics(result), "me_address_update");
            } catch {
              // Diagnostics are best-effort; never fail the update for them.
            }
            return result;
          },
          replaceUserDistricts: (inputUserId, districtIds) => replaceUserDistricts(pool, inputUserId, districtIds),
          lookupBallotSummariesByDistrictIds: (districtIds) =>
            lookupBallotSummariesByDistrictIds(pool, districtIds),
        },
        userId,
        address
      ),
    initializeUserDistricts: ({ userId, districtIds }) => initializeUserDistricts(pool, userId, districtIds),
    resolveAddress: (address, coordinates, allowPartial, regionState, regionLocality) =>
      resolveAddressWithAutoResearch(address, "address_resolve", coordinates, allowPartial, regionState, regionLocality),
  });

  let server: Server | null = null;
  await new Promise<void>((resolve, reject) => {
    const startedServer = app.listen(port, host, () => {
      startedServer.off("error", reject);
      resolve();
    });
    startedServer.once("error", reject);
    server = startedServer;
  });

  console.log(
    `address API server listening on http://${host}:${port} allowed_origins=${
      allowedOrigins.length > 0 ? allowedOrigins.join(",") : "none"
    }`
  );

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await pool.end();
    if (redis?.isOpen) {
      await redis.quit();
    }
  };

  // Idempotence guard: npm and the terminal's process group can each deliver
  // the same Ctrl-C SIGINT, and the second shutdown() then calls
  // server.close() on an already-closed listener — failing the whole
  // shutdown with ERR_SERVER_NOT_RUNNING even though the stop succeeded.
  let shuttingDown = false;
  const handleShutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdown()
      .then(() => {
        console.log(`address API server stopped after ${signal}`);
        process.exit(0);
      })
      .catch((error) => {
        console.error("address API server shutdown failed:", error);
        process.exit(1);
      });
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  // Replace Node's default crash handlers with labeled equivalents so the
  // process manager's log shows WHY the server died. Same exit-and-restart
  // semantics as the defaults — state after an uncaught error is unknown,
  // so limping on is worse than restarting.
  // describeError: stack string only with emails/query strings masked —
  // crash logs get the same scrubbing as the middleware and Sentry events.
  const crash = (label: string, cause: unknown): void => {
    console.error(`address API server ${label}:`, describeError(cause));
    captureError(cause, { crash: label.replaceAll(" ", "_") });
    void flushSentry().finally(() => {
      process.exit(1);
    });
  };
  process.on("unhandledRejection", (reason) => {
    crash("unhandled rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    crash("uncaught exception", error);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("address API server failed:", message);
  process.exitCode = 1;
});

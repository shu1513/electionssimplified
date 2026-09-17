import { FRONTIER_AI_CANDIDATES, type AiCandidate } from "./aiCandidates.js";
import { getPipelineEnv } from "../config/env.js";
import {
  callResearchProvider,
  trimDebugText,
  type ResearchErrorCode,
} from "./researchProviderClient.js";
import { normalizeHttpUrl } from "../utils/normalizeHttpUrl.js";
import type { AiProvider } from "./types.js";
import {
  BALLOT_MEASURE_SUMMARY_MAX_LENGTH,
  BALLOT_MEASURE_YES_NO_MAX_LENGTH,
  buildBallotMeasuresPrompt,
} from "./providers/ballotMeasuresPrompt.js";
import {
  isTlsCertificateReachabilityFailure,
  verifyHttpUrlReachability,
} from "./urlReachability.js";

type BallotMeasureErrorCode = ResearchErrorCode | "SCHEMA_MISMATCH";

type EnrichmentFailure = {
  ok: false;
  retryable: boolean;
  errorCode: BallotMeasureErrorCode;
  reason: string;
  failureDebug?: Record<string, unknown>;
};

type ProviderFailureAttempt = {
  provider: string;
  model: string;
  reason: string;
  errorCode: BallotMeasureErrorCode;
  retryable: boolean;
  failureDebug?: Record<string, unknown>;
};

type BallotMeasureValidationResult =
  | {
      ok: true;
      officialMeasureUrl: string;
      summary: string;
      whatYesMeans: string;
      whatNoMeans: string;
      researchAreaTags: BallotMeasureResearchAreaTag[];
      sources: string[];
      officialMeasureUrlVerification: {
        status: number;
      };
    }
  | {
      ok: false;
      reason: string;
      blockedUrls: string[];
      reviewFeedbackLines?: string[];
      failureDebug?: Record<string, unknown>;
    };

export type BallotMeasureAiInput = {
  districtName: string;
  districtType: string;
  state: string;
  electionDate: string;
  officialBallotTitle: string;
  seedUrls: readonly string[];
  allowedResearchAreaSlugs: readonly string[];
};

export type BallotMeasureAiConfig = {
  timeoutMs: number;
  anthropicWebSearchMaxUses?: number;
  openAiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
};

export type BallotMeasureResearchAreaTag = {
  researchAreaSlug: string;
  stance: "for" | "against";
};

export type BallotMeasureAiResult =
  | {
      ok: true;
      provider: AiProvider;
      model: string;
      officialMeasureUrl: string;
      summary: string;
      whatYesMeans: string;
      whatNoMeans: string;
      researchAreaTags: BallotMeasureResearchAreaTag[];
      researchUrls: string[];
      aiRawDebug: Record<string, unknown> | null;
    }
  | EnrichmentFailure;

const MAX_SOURCE_URLS_TO_VERIFY = 20;
const SOURCE_URL_VERIFY_CONCURRENCY = 4;
const CLAUDE_INTER_CALL_DELAY_MS = 20_000;

function parseResearchAreaTags(
  value: unknown,
  allowedResearchAreaSlugs: ReadonlySet<string>
): { ok: true; tags: BallotMeasureResearchAreaTag[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "research_area_tags must be array" };
  }

  const tags: BallotMeasureResearchAreaTag[] = [];
  const seenSlugs = new Set<string>();
  for (const rawTag of value) {
    if (typeof rawTag !== "object" || rawTag === null || Array.isArray(rawTag)) {
      return { ok: false, reason: "research_area_tags entries must be objects" };
    }
    const tag = rawTag as Record<string, unknown>;
    if (typeof tag.research_area_slug !== "string") {
      return { ok: false, reason: "research_area_tags[].research_area_slug must be string" };
    }
    const slug = tag.research_area_slug.trim().toLowerCase();
    if (slug.length === 0) {
      return { ok: false, reason: "research_area_tags[].research_area_slug must be non-empty" };
    }
    if (!allowedResearchAreaSlugs.has(slug)) {
      return { ok: false, reason: `research_area_slug '${slug}' is not allowed for ballot measures` };
    }
    if (tag.stance !== "for" && tag.stance !== "against") {
      return { ok: false, reason: "research_area_tags[].stance must be for or against" };
    }
    if (seenSlugs.has(slug)) {
      return { ok: false, reason: `research_area_tags has duplicate research_area_slug '${slug}'` };
    }
    seenSlugs.add(slug);
    tags.push({
      researchAreaSlug: slug,
      stance: tag.stance,
    });
  }

  return { ok: true, tags };
}

export function parseBallotMeasureAiPayload(payload: unknown, allowedResearchAreaSlugs: ReadonlySet<string>): {
  ok: true;
  officialMeasureUrl: string;
  summary: string;
  whatYesMeans: string;
  whatNoMeans: string;
  researchAreaTags: BallotMeasureResearchAreaTag[];
  sources: string[];
} | {
  ok: false;
  reason: string;
} {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be an object" };
  }

  const input = payload as Record<string, unknown>;
  if (typeof input.official_measure_url !== "string") {
    return { ok: false, reason: "official_measure_url must be string" };
  }
  if (typeof input.summary !== "string") {
    return { ok: false, reason: "summary must be string" };
  }
  if (typeof input.what_yes_means !== "string") {
    return { ok: false, reason: "what_yes_means must be string" };
  }
  if (typeof input.what_no_means !== "string") {
    return { ok: false, reason: "what_no_means must be string" };
  }
  if (!Array.isArray(input.sources)) {
    return { ok: false, reason: "sources must be array" };
  }
  const researchAreaTags = parseResearchAreaTags(input.research_area_tags, allowedResearchAreaSlugs);
  if (!researchAreaTags.ok) {
    return { ok: false, reason: researchAreaTags.reason };
  }

  const officialMeasureUrl = normalizeHttpUrl(input.official_measure_url);
  if (!officialMeasureUrl) {
    return { ok: false, reason: "official_measure_url must be valid http(s) URL" };
  }

  const summary = input.summary.trim();
  const whatYesMeans = input.what_yes_means.trim();
  const whatNoMeans = input.what_no_means.trim();
  if (summary.length === 0 || whatYesMeans.length === 0 || whatNoMeans.length === 0) {
    return { ok: false, reason: "summary/what_yes_means/what_no_means must be non-empty" };
  }
  if (summary.length > BALLOT_MEASURE_SUMMARY_MAX_LENGTH) {
    return {
      ok: false,
      reason: `summary is ${summary.length} characters (max ${BALLOT_MEASURE_SUMMARY_MAX_LENGTH}) — voters skim it. Rewrite as two short plain sentences: what the measure does, then how it affects the reader; cut everything else.`,
    };
  }
  if (whatYesMeans.length > BALLOT_MEASURE_YES_NO_MAX_LENGTH) {
    return {
      ok: false,
      reason: `what_yes_means is ${whatYesMeans.length} characters (max ${BALLOT_MEASURE_YES_NO_MAX_LENGTH}) — rewrite as 1-2 short plain sentences stating what concretely changes if YES wins.`,
    };
  }
  if (whatNoMeans.length > BALLOT_MEASURE_YES_NO_MAX_LENGTH) {
    return {
      ok: false,
      reason: `what_no_means is ${whatNoMeans.length} characters (max ${BALLOT_MEASURE_YES_NO_MAX_LENGTH}) — rewrite as 1-2 short plain sentences stating what concretely stays or changes if NO wins.`,
    };
  }

  const sources: string[] = [];
  const seenSourceUrls = new Set<string>();
  for (const raw of input.sources) {
    if (typeof raw !== "string") {
      return { ok: false, reason: "sources must contain URL strings" };
    }
    const normalized = normalizeHttpUrl(raw);
    if (!normalized) {
      return { ok: false, reason: "sources must contain valid http(s) URLs" };
    }
    if (seenSourceUrls.has(normalized)) {
      continue;
    }
    seenSourceUrls.add(normalized);
    sources.push(normalized);
  }
  if (sources.length === 0) {
    return { ok: false, reason: "sources must contain at least one URL" };
  }

  return {
    ok: true,
    officialMeasureUrl,
    summary,
    whatYesMeans,
    whatNoMeans,
    researchAreaTags: researchAreaTags.tags,
    sources,
  };
}

export async function validateBallotMeasureAiPayload(
  payload: unknown,
  timeoutMs: number,
  allowedResearchAreaSlugs: ReadonlySet<string>
): Promise<BallotMeasureValidationResult> {
  const parsed = parseBallotMeasureAiPayload(payload, allowedResearchAreaSlugs);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, blockedUrls: [] };
  }

  const verificationTimeoutMs = Math.min(timeoutMs, 15_000);
  const officialVerification = await verifyHttpUrlReachability(parsed.officialMeasureUrl, {
    timeoutMs: verificationTimeoutMs,
    allowStatusCodes: [403],
  });
  if (!officialVerification.ok) {
    if (isTlsCertificateReachabilityFailure(officialVerification.reason)) {
      return {
        ok: false,
        reason: "official_measure_url could not be verified due to TLS/certificate issue",
        blockedUrls: [],
        failureDebug: {
          failure_kind: "tls_certificate_verification",
          official_measure_url: parsed.officialMeasureUrl,
          official_measure_url_verification_reason: officialVerification.reason,
          suggested_operator_action:
            "Check whether the official site has a certificate problem. If this is a local trust-chain issue, configure NODE_EXTRA_CA_CERTS or repair the backend CA bundle, then retry.",
        },
      };
    }
    return {
      ok: false,
      reason: `official_measure_url is not reachable: ${officialVerification.reason}`,
      blockedUrls: [parsed.officialMeasureUrl],
      failureDebug: {
        official_measure_url: parsed.officialMeasureUrl,
        official_measure_url_verification_reason: officialVerification.reason,
      },
    };
  }
  if (officialVerification.status === 403) {
    const officialUrl = officialVerification.finalUrl;
    return {
      ok: false,
      reason: `official_measure_url returned HTTP 403 from automated verification: ${officialUrl}`,
      blockedUrls: [],
      reviewFeedbackLines: [
        "The previous official_measure_url returned HTTP 403 / AccessDenied from automated verification.",
        "Actively investigate that URL and related official election-authority pages.",
        "Do not return that URL again as official_measure_url.",
        "Use a directly reachable official full-text URL or official PDF instead.",
        "You may keep the 403 URL only in sources if it is official and useful, but official_measure_url must be directly reachable.",
        "Do not replace it with a non-official source unless no official source exists.",
      ],
      failureDebug: {
        official_measure_url: officialUrl,
        official_measure_url_verification_status: 403,
      },
    };
  }

  const uniqueSourceUrls = [...new Set(parsed.sources)];
  if (uniqueSourceUrls.length > MAX_SOURCE_URLS_TO_VERIFY) {
    return {
      ok: false,
      reason: `sources contains ${uniqueSourceUrls.length} URLs; at most ${MAX_SOURCE_URLS_TO_VERIFY} can be verified`,
      blockedUrls: [],
      failureDebug: {
        source_url_count: uniqueSourceUrls.length,
        max_source_urls_to_verify: MAX_SOURCE_URLS_TO_VERIFY,
      },
    };
  }
  type SourceCheck = {
    url: string;
    verification: Awaited<ReturnType<typeof verifyHttpUrlReachability>>;
  };
  const sourceChecks: SourceCheck[] = new Array(uniqueSourceUrls.length);
  const concurrency = Math.max(
    1,
    Math.min(SOURCE_URL_VERIFY_CONCURRENCY, uniqueSourceUrls.length)
  );
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= uniqueSourceUrls.length) {
          return;
        }

        const url = uniqueSourceUrls[index];
        sourceChecks[index] = {
          url,
          verification: await verifyHttpUrlReachability(url, {
            timeoutMs: Math.min(timeoutMs, 8_000),
            allowStatusCodes: [403],
          }),
        };
      }
    })
  );

  const badSourceChecks = sourceChecks.flatMap((check) =>
    check.verification.ok
      ? []
      : [
          {
            url: check.url,
            reason: check.verification.reason,
          },
        ]
  );
  if (badSourceChecks.length > 0) {
    const firstBad = badSourceChecks[0];
    const badUrls = badSourceChecks.map((check) => check.url);
    return {
      ok: false,
      reason: `source URL is not reachable: ${firstBad.url} (${firstBad.reason})`,
      blockedUrls: badUrls,
      failureDebug: {
        bad_source_urls: badSourceChecks.map((check) => ({
          url: check.url,
          reason: check.reason,
        })),
      },
    };
  }

  const normalizedSources = sourceChecks
    .map((check) => (check.verification.ok ? check.verification.finalUrl : null))
    .filter((url): url is string => typeof url === "string");

  return {
    ok: true,
    officialMeasureUrl: officialVerification.finalUrl,
    summary: parsed.summary,
    whatYesMeans: parsed.whatYesMeans,
    whatNoMeans: parsed.whatNoMeans,
    researchAreaTags: parsed.researchAreaTags,
    sources: [...new Set(normalizedSources)],
    officialMeasureUrlVerification: {
      status: officialVerification.status,
    },
  };
}

async function callProvider(
  candidate: AiCandidate,
  prompt: string,
  config: BallotMeasureAiConfig
): Promise<{ ok: true; parsed: unknown; rawText: string; debugMeta?: Record<string, unknown> } | EnrichmentFailure> {
  const providerResult = await callResearchProvider(candidate, prompt, {
    timeoutMs: config.timeoutMs,
    anthropicWebSearchMaxUses: config.anthropicWebSearchMaxUses,
    claudeInterCallDelayMs: CLAUDE_INTER_CALL_DELAY_MS,
    claudeRetryAfterBufferMs: 10_000,
    openAiApiKey: config.openAiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    geminiApiKey: config.geminiApiKey,
    geminiApiVersion: "v1beta",
    geminiResponseMimeTypeJson: true,
  });
  if (providerResult.ok) {
    return {
      ok: true,
      parsed: providerResult.parsed,
      rawText: providerResult.rawText,
      debugMeta: providerResult.debugMeta,
    };
  }
  return {
    ok: false,
    retryable: providerResult.retryable,
    errorCode: providerResult.errorCode,
    reason: providerResult.reason,
    failureDebug: providerResult.failureDebug,
  };
}

export function buildBallotMeasureAiConfigFromEnv(): BallotMeasureAiConfig {
  const env = getPipelineEnv();
  return {
    timeoutMs: env.AI_TIMEOUT_MS,
    anthropicWebSearchMaxUses: env.ANTHROPIC_WEB_SEARCH_MAX_USES,
    openAiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
  };
}

export async function enrichBallotMeasure(
  input: BallotMeasureAiInput,
  config: BallotMeasureAiConfig,
  candidates: readonly AiCandidate[] = FRONTIER_AI_CANDIDATES
): Promise<BallotMeasureAiResult> {
  const failures: ProviderFailureAttempt[] = [];
  const cumulativeBlockedUrlFeedback = new Set<string>();

  for (const candidate of candidates) {
    let reviewFeedbackLines: string[] = [...cumulativeBlockedUrlFeedback];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = buildBallotMeasuresPrompt({
        ...input,
        reviewFeedbackLines,
      });
      const generated = await callProvider(candidate, prompt, config);
      if (!generated.ok) {
        failures.push({
          provider: candidate.provider,
          model: candidate.model,
          reason: generated.reason,
          errorCode: generated.errorCode,
          retryable: generated.retryable,
          failureDebug: generated.failureDebug,
        });
        break;
      }

      const validation = await validateBallotMeasureAiPayload(
        generated.parsed,
        config.timeoutMs,
        new Set(input.allowedResearchAreaSlugs.map((slug) => slug.trim().toLowerCase()))
      );
      if (!validation.ok) {
        failures.push({
          provider: candidate.provider,
          model: candidate.model,
          reason: validation.reason,
          errorCode: "SCHEMA_MISMATCH",
          retryable: false,
          failureDebug: {
            provider_response_text: trimDebugText(generated.rawText),
            ...(validation.failureDebug ?? {}),
          },
        });
        const canRetrySameModel = attempt === 0;
        if (canRetrySameModel) {
          for (const blockedUrl of validation.blockedUrls) {
            cumulativeBlockedUrlFeedback.add(`Do not use or cite this URL: ${blockedUrl}`);
          }
          if (validation.reviewFeedbackLines && validation.reviewFeedbackLines.length > 0) {
            for (const line of validation.reviewFeedbackLines) {
              cumulativeBlockedUrlFeedback.add(line);
            }
          } else {
            cumulativeBlockedUrlFeedback.add(`Fix this validation issue: ${validation.reason}`);
          }
          reviewFeedbackLines = [...cumulativeBlockedUrlFeedback].slice(0, 20);
          continue;
        }
        break;
      }

      return {
        ok: true,
        provider: candidate.provider,
        model: candidate.model,
        officialMeasureUrl: validation.officialMeasureUrl,
        summary: validation.summary,
        whatYesMeans: validation.whatYesMeans,
        whatNoMeans: validation.whatNoMeans,
        researchAreaTags: validation.researchAreaTags,
        researchUrls: (() => {
          const urls = new Set<string>();
          for (const url of validation.sources) {
            urls.add(url);
          }
          if (generated.debugMeta && Array.isArray(generated.debugMeta.web_search_urls)) {
            for (const raw of generated.debugMeta.web_search_urls) {
              if (typeof raw !== "string") {
                continue;
              }
              const normalized = normalizeHttpUrl(raw);
              if (normalized) {
                urls.add(normalized);
              }
            }
          }
          urls.add(validation.officialMeasureUrl);
          return [...urls];
        })(),
        aiRawDebug: {
          provider_response_text: trimDebugText(generated.rawText),
          official_measure_url_verification: validation.officialMeasureUrlVerification,
          ...(generated.debugMeta ?? {}),
        },
      };
    }
  }

  const finalFailure = failures[failures.length - 1];
  const anyRetryable = failures.some((failure) => failure.retryable);
  const firstRetryable = failures.find((failure) => failure.retryable);
  const firstPermanent = failures.find((failure) => !failure.retryable);
  const selected = anyRetryable ? (firstRetryable ?? finalFailure) : (firstPermanent ?? finalFailure);

  return {
    ok: false,
    retryable: selected?.retryable ?? false,
    errorCode: selected?.errorCode ?? "TEMP_PROVIDER_ERROR",
    reason: selected?.reason ?? "No AI candidates available for ballot-measure enrichment",
    failureDebug: {
      attempts: failures,
      prompt_preview: trimDebugText(
        buildBallotMeasuresPrompt({
          ...input,
          reviewFeedbackLines: [],
        }),
        6000
      ),
      ...(selected?.failureDebug ?? {}),
    },
  };
}

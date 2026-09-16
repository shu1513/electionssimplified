// LlmClient implementation #1: OpenAI Responses API
// (docs/plans/chatbot-rag.md component 6). Provider quirks live HERE only:
// request shape, reasoning params, output array walking, usage field names.
//
// store:false — the response is not stored as retrievable API state, and
// under the API terms it is not used for training. It does NOT mean zero
// retention: OpenAI keeps abuse-monitoring logs for up to 30 days by
// default (https://platform.openai.com/docs/guides/your-data). The Privacy
// Policy says exactly that; do not restate it as "no retention".
// Strict structured output — the model must return the ANSWER_JSON_SCHEMA
// object; anything else is an LlmError and the caller falls back to cards.

import { LlmError, type GenerateAnswerResult, type LlmClient } from "./adapter.js";
import { ANSWER_JSON_SCHEMA, SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

// Hard output ceiling with reasoning headroom: verbosity is "low" and the
// prompt caps answers at ~90 words (~150 tokens); the rest is headroom for
// low-effort reasoning tokens, which bill as output. Also the budget
// reservation's worst case (limits.ts).
export const MAX_OUTPUT_TOKENS = 1_200;

export type OpenAiResponsesOptions = {
  /** e.g. https://api.openai.com/v1 (no trailing slash). */
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
};

type ParsedAnswer = {
  answer: string;
  citations: string[];
  refusal_reason: string | null;
};

function parseAnswerPayload(text: string): ParsedAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmError("model output was not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LlmError("model output was not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const answer = record.answer;
  const citations = record.citations;
  const refusalReason = record.refusal_reason;
  if (
    typeof answer !== "string" ||
    !Array.isArray(citations) ||
    citations.some((item) => typeof item !== "string") ||
    (refusalReason !== null && typeof refusalReason !== "string")
  ) {
    throw new LlmError("model output did not match the answer schema");
  }
  return { answer, citations: citations as string[], refusal_reason: refusalReason };
}

/** The Responses API returns an output ARRAY (reasoning items, then a
 * message); the answer text is the message item's output_text content. */
function extractOutputText(body: Record<string, unknown>): string {
  const output = body.output;
  if (!Array.isArray(output)) {
    throw new LlmError("response had no output array");
  }
  for (const item of output) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "message" || !Array.isArray(record.content)) {
      continue;
    }
    for (const part of record.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "output_text" &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        return (part as Record<string, unknown>).text as string;
      }
    }
    // A message item whose content is a refusal (provider-level) or
    // anything but output_text: fall through to the error below.
  }
  throw new LlmError("response contained no output_text message");
}

function extractUsage(body: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = body.usage;
  const record = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
  const inputTokens = typeof record.input_tokens === "number" ? record.input_tokens : 0;
  const outputTokens = typeof record.output_tokens === "number" ? record.output_tokens : 0;
  return { inputTokens, outputTokens };
}

export function createOpenAiResponsesClient(options: OpenAiResponsesOptions): LlmClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    async generateAnswer(input): Promise<GenerateAnswerResult> {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            store: false,
            reasoning: { effort: options.reasoningEffort },
            max_output_tokens: MAX_OUTPUT_TOKENS,
            ...(input.safetyIdentifier ? { safety_identifier: input.safetyIdentifier } : {}),
            text: {
              verbosity: "low",
              format: {
                type: "json_schema",
                name: "chatbot_answer",
                strict: true,
                schema: ANSWER_JSON_SCHEMA,
              },
            },
            input: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: buildUserMessage(input.question, input.chunks) },
            ],
          }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        throw new LlmError(
          `LLM service unreachable: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      if (!response.ok) {
        // Never echo the response body wholesale (may be large); the status
        // plus a clipped snippet is enough to diagnose.
        const bodyText = await response.text().catch(() => "");
        throw new LlmError(`LLM service returned ${response.status}: ${bodyText.slice(0, 200)}`);
      }
      const parsedBody: unknown = await response.json().catch((error: unknown) => {
        throw new LlmError("LLM service returned invalid JSON", { cause: error });
      });
      if (typeof parsedBody !== "object" || parsedBody === null) {
        throw new LlmError("LLM service returned a non-object body");
      }
      const body = parsedBody as Record<string, unknown>;
      const usage = extractUsage(body);
      // status "incomplete" = max_output_tokens hit or content filtered — a
      // truncated JSON answer must never be served. Usage is still real
      // spend; the caller reconciles with it before failing over.
      if (body.status !== "completed") {
        throw new LlmError(`LLM response status was ${String(body.status)}`, { usage });
      }
      try {
        const payload = parseAnswerPayload(extractOutputText(body));
        return {
          answer: payload.answer,
          citations: payload.citations,
          refusalReason: payload.refusal_reason,
          usage,
        };
      } catch (error) {
        // A completed-but-malformed response still billed tokens — keep the
        // usage on the error so the budget reconciles real spend.
        if (error instanceof LlmError && !error.usage) {
          error.usage = usage;
        }
        throw error;
      }
    },
  };
}

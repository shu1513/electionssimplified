import { isDeepStrictEqual } from "node:util";
import {
  buildDelawareCfrsUrl,
  buildDelawareCommitteeSearchFields,
  createDelawareCfrsSession,
  DELAWARE_CFRS_PAGES,
  DELAWARE_CFRS_THEME_QUERY,
  DelawareCfrsClientError,
  type DelawareCfrsResponseCapture,
  type DelawareCfrsSessionOptions,
} from "./delawareCfrsClient.js";
import {
  extractDelawareGridTotal,
  parseDelawareCommitteeGridJson,
} from "./delawareCfrsParsers.js";

export type DelawareCfrsCompleteCommitteeRegistryResult = {
  /** Full physical source rows, including repeated FF/SO identities and unknown classes. */
  rows?: readonly Readonly<Record<string, unknown>>[];
  declaredCount?: number;
  sourceCaptures: readonly DelawareCfrsResponseCapture[];
  diagnostics: readonly string[];
};

/** Full all-type source page. Blank type-05 names are retained, never assigned a legal donor identity. */
export function decodeDelawareCompleteCommitteeRegistryPage(text: string): {
  rows: Readonly<Record<string, unknown>>[];
  total: number;
} {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid Delaware broad registry envelope");
  const envelope = parsed as { data?: unknown; total?: unknown };
  if (
    !Array.isArray(envelope.data) ||
    !Number.isSafeInteger(envelope.total) ||
    (envelope.total as number) < 0
  )
    throw new Error("Invalid Delaware broad registry data/count");
  const ordinaryRows: Record<string, unknown>[] = [];
  const rows = envelope.data.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("Invalid Delaware broad registry row");
    const raw = row as Record<string, unknown>;
    const blankCertification =
      raw.CommitteeName === "" &&
      raw.CommitteeTypeCode === "05" &&
      raw.CommitteeType === "Certification of Intention" &&
      typeof raw.Committee_Id === "string" &&
      /^05\d{6}$/.test(raw.Committee_Id) &&
      typeof raw.MemberID === "number" &&
      Number.isSafeInteger(raw.MemberID) &&
      raw.MemberID > 0;
    if (!blankCertification) ordinaryRows.push(raw);
    return raw;
  });
  // Reuse the established identity validator for all other rows. This is only
  // a validation projection: returned data/count remain the complete original
  // physical source rows, including every unnamed certification and duplicate.
  parseDelawareCommitteeGridJson(
    JSON.stringify({ data: ordinaryRows, total: envelope.total }),
  );
  return { rows, total: envelope.total as number };
}

/** Source transport only: exhausts a blank-selector registry search; selects no legal/current identity. */
export async function fetchDelawareCfrsCompleteCommitteeRegistry(
  input: {
    sessionOptions?: DelawareCfrsSessionOptions;
    maxPages?: number;
  } = {},
): Promise<DelawareCfrsCompleteCommitteeRegistryResult> {
  const maxPages = input.maxPages ?? 40;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 40)
    throw new Error("Invalid Delaware registry page budget");
  const options = { ...input.sessionOptions };
  const observer = options.onResponseCapture;
  const sourceCaptures: DelawareCfrsResponseCapture[] = [];
  const session = createDelawareCfrsSession({
    ...options,
    onResponseCapture: async (capture) => {
      sourceCaptures.push({
        ...capture,
        body: Buffer.from(capture.body),
        financeFields:
          capture.financeFields === null ? null : { ...capture.financeFields },
      });
      await observer?.(capture);
    },
  });
  try {
    await session.get(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch),
    );
    const searched = await session.postForm(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearchPost, {
        ...DELAWARE_CFRS_THEME_QUERY,
      }),
      buildDelawareCommitteeSearchFields(),
    );
    const renderedCount = extractDelawareGridTotal(searched.text());
    if (
      renderedCount === null ||
      !Number.isSafeInteger(renderedCount) ||
      renderedCount < 0
    )
      throw new Error("Missing Delaware registry rendered count");
    const rows: Record<string, unknown>[] = [];
    const previousPages: Record<string, unknown>[][] = [];
    for (let page = 1; page <= maxPages; page++) {
      const response = await session.postForm(
        buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeGridJson, {
          ...DELAWARE_CFRS_THEME_QUERY,
        }),
        {
          page: String(page),
          size: "500",
          orderBy: "",
          groupBy: "",
          filter: "",
        },
        { xhr: true },
      );
      const parsed = decodeDelawareCompleteCommitteeRegistryPage(
        response.text(),
      );
      if (parsed.total !== renderedCount || parsed.rows.length > 500)
        throw new Error("Changed Delaware registry count");
      const raw = structuredClone(parsed.rows) as Record<string, unknown>[];
      if (
        raw.length &&
        previousPages.some((prior) => isDeepStrictEqual(prior, raw))
      )
        throw new Error("Repeated Delaware registry page");
      previousPages.push(raw);
      rows.push(...raw);
      if (rows.length > renderedCount)
        throw new Error("Excess Delaware registry rows");
      if (raw.length < 500) {
        if (rows.length !== renderedCount)
          throw new Error("Incomplete Delaware registry rows");
        return {
          rows,
          declaredCount: renderedCount,
          sourceCaptures,
          diagnostics: [],
        };
      }
    }
    throw new Error("Delaware registry page cap");
  } catch (error) {
    if (
      error instanceof DelawareCfrsClientError &&
      error.code === "capture_error"
    )
      throw error;
    // Never expose response bodies or a transport's untrusted error message.
    return {
      sourceCaptures,
      diagnostics: [
        error instanceof DelawareCfrsClientError
          ? `Delaware registry transport failed (${error.code})`
          : "Delaware registry scope/schema/count/exhaustion unavailable",
      ],
    };
  }
}

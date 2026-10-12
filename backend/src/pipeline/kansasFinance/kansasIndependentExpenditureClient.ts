import { createHash } from "node:crypto";

import {
  collectKansasCfrGridPages,
  createKansasCfrSession,
  KansasCfrClientError,
  KANSAS_CFR_VIEWER_PAGES,
  openKansasCfrCategory,
  postAndFollow,
  postbackAndFollow,
  type KansasCfrSession,
  type KansasCfrSessionOptions,
} from "./kansasCfrViewerClient.js";
import type { KansasCfrGridRow } from "./kansasCfrViewerParsers.js";

export const KANSAS_IE_GRID = "gvIndividualEntity";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_REQUESTS = 450;
export const KANSAS_IE_PAPER_URL_PATTERN =
  /^https:\/\/sos\.ks\.gov\/srvimages\/campaignfinance\/filings\/cy\d{4}\/cm(?:0[1-9]|1[0-2])\/\d+\.pdf$/;

export type KansasIEPaperDocument = {
  sourceUrl: string;
  body: Buffer;
  /** Actual GET observation; independent of any cache's first retrieval. */
  observation: {
    startedAt: string;
    endedAt: string;
    status: 200;
    sha256: string;
    byteSize: number;
  };
};

export type KansasIESearchedFiling = {
  row: KansasCfrGridRow;
  /** Opens this observed row, never derives a PDF ID from its position. */
  openPaperDocument: () => Promise<KansasIEPaperDocument>;
};

export async function getKansasIEPaperDocument(
  session: KansasCfrSession,
  sourceUrl: string,
  referer?: string,
): Promise<KansasIEPaperDocument> {
  // Apply the same URL allowlist to saved browser associations and native openers.
  if (!KANSAS_IE_PAPER_URL_PATTERN.test(sourceUrl))
    throw new KansasCfrClientError(
      "invalid_request",
      "Invalid official Kansas IE PDF URL",
    );
  const startedAt = new Date().toISOString();
  const response = await session.get(sourceUrl, { referer });
  const endedAt = new Date().toISOString();
  if (
    response.status !== 200 ||
    !/^application\/pdf(?:\s*;|$)/i.test(response.contentType ?? "") ||
    response.body.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new KansasCfrClientError(
      "bad_response",
      "Kansas IE document did not return a PDF",
      response.status,
    );
  }
  return {
    sourceUrl,
    body: response.body,
    observation: {
      startedAt,
      endedAt,
      status: 200,
      sha256: createHash("sha256").update(response.body).digest("hex"),
      byteSize: response.body.byteLength,
    },
  };
}

function requireDate(value: string): number {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match)
    throw new KansasCfrClientError(
      "invalid_request",
      "Invalid Kansas IE filed-date window",
    );
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    year > 2100 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new KansasCfrClientError(
      "invalid_request",
      "Invalid Kansas IE filed-date window",
    );
  }
  return date.getTime();
}

/** Only a literal, official PDF opener is authority for the document URL. */
export function parseKansasIEPaperUrl(html: string): string {
  const urls = [
    ...html.matchAll(/\bwindow\.open\s*\(\s*(['"])([^'"]+)\1/g),
  ].map((match) => match[2]!);
  const distinct = [...new Set(urls)];
  if (
    distinct.length !== 1 ||
    !KANSAS_IE_PAPER_URL_PATTERN.test(distinct[0]!)
  ) {
    throw new KansasCfrClientError(
      "bad_response",
      "Kansas IE row did not supply one official paper PDF opener",
    );
  }
  return distinct[0]!;
}

/**
 * Observed October 12, 2026: IndividualEntity has its own form and paper name
 * postback. This produces source documents only. Filed dates are not coverage
 * periods; neither count closure nor a PDF checksum establishes amendments,
 * complete candidate spending, legal payer identity, or candidate ownership.
 */
export async function searchKansasIndependentExpenditures(input: {
  startDate: string;
  endDate: string;
  filerName?: string;
  sessionOptions?: KansasCfrSessionOptions;
}): Promise<{ recordCount: number; filings: KansasIESearchedFiling[] }> {
  if (requireDate(input.startDate) > requireDate(input.endDate)) {
    throw new KansasCfrClientError(
      "invalid_request",
      "Reversed Kansas IE filed-date window",
    );
  }
  const original = createKansasCfrSession({
    ...input.sessionOptions,
    maxAttempts: 1,
    timeoutMs: Math.min(input.sessionOptions?.timeoutMs ?? 30_000, 30_000),
    maxResponseBytes: Math.min(
      input.sessionOptions?.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    ),
  });
  let requests = 0;
  let bytes = 0;
  const bounded = async (
    request: () => ReturnType<KansasCfrSession["get"]>,
  ) => {
    if (++requests > MAX_REQUESTS)
      throw new KansasCfrClientError(
        "bad_response",
        "Kansas IE request limit exceeded",
      );
    const response = await request();
    bytes += response.body.byteLength;
    if (bytes > MAX_TOTAL_BYTES)
      throw new KansasCfrClientError(
        "bad_response",
        "Kansas IE total byte limit exceeded",
      );
    return response;
  };
  const session: KansasCfrSession = {
    get: (url, options) => bounded(() => original.get(url, options)),
    postForm: (url, fields, options) =>
      bounded(() => original.postForm(url, fields, options)),
  };
  const form = await openKansasCfrCategory(session, "IndividualEntity");
  const results = await postAndFollow(session, form, {
    txtCommitteeName: input.filerName ?? "",
    drpdownFilingType: "Individual Expenditures",
    txtStartDate: input.startDate,
    txtEndDate: input.endDate,
    btnSearch: "Submit Search",
  });
  if (!results.url.endsWith(KANSAS_CFR_VIEWER_PAGES.searchResults)) {
    throw new KansasCfrClientError(
      "bad_response",
      "Kansas IE search did not reach results",
    );
  }
  const { recordCount, pages } = await collectKansasCfrGridPages(
    session,
    results,
    KANSAS_IE_GRID,
  );
  const filings = pages.flatMap(({ page, rows }) =>
    rows.map((row): KansasIESearchedFiling => ({
      row,
      openPaperDocument: async () => {
        if (
          row.channel !== "paper" ||
          !row.postbackTarget ||
          !row.name ||
          row.officeSought.trim().toUpperCase() !== "INDIVIDUAL ENTITY"
        ) {
          throw new KansasCfrClientError(
            "bad_response",
            "Kansas IE row is not an observed IndividualEntity paper filing",
          );
        }
        const opened = await postbackAndFollow(
          session,
          page,
          row.postbackTarget,
        );
        const sourceUrl = parseKansasIEPaperUrl(opened.html);
        return getKansasIEPaperDocument(session, sourceUrl, page.url);
      },
    })),
  );
  return { recordCount, filings };
}

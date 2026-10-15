import {
  buildMissouriMecUrl,
  createMissouriMecSession,
  MISSOURI_MEC_PAGES,
  MISSOURI_MEC_RESULTS_FIELD_PREFIX,
  MISSOURI_MEC_SEARCH_FIELD_PREFIX,
  parseMissouriMecHiddenFields,
  type MissouriMecResponse,
  type MissouriMecSession,
} from "./missouriMecClient.js";
import { storeMissouriMecArtifact, storeMissouriMecCandidateArtifactBundle, storeMissouriMecCommitteeReceiptArtifactBundle, storeMissouriMecOutsideSpendingArtifacts } from "./missouriMecArtifactCache.js";
import {
  MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER,
  MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER,
  parseMissouriMecCommitteeInfo,
  parseMissouriMecCommitteeIdentity,
  parseMissouriMecCommitteeActivityRows,
  parseMissouriMecContributionExport,
  parseMissouriMecFullDisclosureCount,
  parseMissouriMecExpenditureExport,
  parseMissouriMecOutsideSpendingExport,
  parseMissouriMecOutsideSpendingGridPage,
  parseMissouriMecReportInventory,
  parseMissouriMecReportYears,
} from "./missouriMecParsers.js";

const SEARCH = MISSOURI_MEC_SEARCH_FIELD_PREFIX;
const RESULTS = MISSOURI_MEC_RESULTS_FIELD_PREFIX;
const EMPTY_TRANSACTION_EXPORT_REDIRECT =
  "/mec/Error.aspx?aspxerrorpath=/MEC/Campaign_Finance/CF12_ContrExpendResults.aspx";

function hidden(html: string, url: string): Record<string, string> {
  const fields = parseMissouriMecHiddenFields(html);
  if (!fields.__VIEWSTATE) throw new Error(`Missouri MEC page has no __VIEWSTATE: ${url}`);
  return fields;
}

function requireHtml(response: MissouriMecResponse, label: string): string {
  if (response.status !== 200 || !(response.contentType ?? "text/html").includes("text/html")) {
    throw new Error(`Unexpected Missouri MEC ${label} response: HTTP ${response.status}, ${response.contentType}`);
  }
  return response.text();
}

function transactionExportCount(mode: "contributions" | "expenditures", body: string): number {
  try {
    return mode === "contributions" ? parseMissouriMecContributionExport(body).length
      : parseMissouriMecExpenditureExport(body).length;
  } catch {
    // Parser diagnostics can contain raw source cells; acquisition logs must not.
    throw new Error("Missouri MEC transaction export failed validation");
  }
}

function safeReportInventory(body: string): ReturnType<typeof parseMissouriMecReportInventory> {
  try { return parseMissouriMecReportInventory(body); }
  catch { throw new Error("Missouri MEC report inventory failed validation"); }
}

async function requireUnchangedClosingInventory(input: {
  session: MissouriMecSession;
  committeeUrl: string;
  year: number;
  opening: ReturnType<typeof parseMissouriMecReportInventory>;
}): Promise<string> {
  const page = requireHtml(await input.session.get(input.committeeUrl), "closing committee page");
  const tab = requireHtml(await input.session.postForm(input.committeeUrl, {
    ...hidden(page, "closing committee page"), __EVENTTARGET: `${SEARCH}lbtnReports`, __EVENTARGUMENT: "",
  }, { referer: input.committeeUrl }), "closing reports tab");
  let year;
  try { year = parseMissouriMecReportYears(tab).find((row) => row.year === input.year); }
  catch { throw new Error("Missouri MEC closing report year failed validation"); }
  if (!year) throw new Error("Missouri MEC closing report year unavailable");
  const body = requireHtml(await input.session.postForm(input.committeeUrl, {
    ...hidden(tab, "closing reports tab"),
    [`${SEARCH}${year.expandControlName}.x`]: "1", [`${SEARCH}${year.expandControlName}.y`]: "1",
  }, { referer: input.committeeUrl }), "closing report inventory");
  const canonical = (rows: ReturnType<typeof parseMissouriMecReportInventory>) =>
    rows.map((row) => JSON.stringify([row.reportId, row.report, row.dateFiled, row.isAmended, row.lineageKey])).sort();
  if (JSON.stringify(canonical(input.opening)) !== JSON.stringify(canonical(safeReportInventory(body)))) {
    throw new Error("Missouri MEC report inventory changed during acquisition");
  }
  return body;
}

async function fetchTransactionExport(input: {
  session: MissouriMecSession;
  mecid: string;
  year: number;
  mode: "contributions" | "expenditures";
}): Promise<{ body: string; sourceUrl: string; resultsBody: string }> {
  const searchUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch);
  const resultsUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionResults);
  let page = requireHtml(await input.session.get(searchUrl), "transaction-search page");
  const modeControl = input.mode === "contributions" ? "lbtnContr" : "lbtnExpend";
  page = requireHtml(await input.session.postForm(searchUrl, {
    ...hidden(page, searchUrl),
    __EVENTTARGET: `${SEARCH}${modeControl}`,
    __EVENTARGUMENT: "",
  }, { referer: searchUrl }), `${input.mode} mode`);
  page = requireHtml(await input.session.postForm(searchUrl, {
    ...hidden(page, searchUrl),
    __EVENTTARGET: `${SEARCH}lbtnAdvanced`,
    __EVENTARGUMENT: "",
  }, { referer: searchUrl }), `${input.mode} advanced search`);
  const search = await input.session.postForm(searchUrl, {
    ...hidden(page, searchUrl),
    [`${SEARCH}ddYear`]: String(input.year),
    [`${SEARCH}txtCommID`]: input.mecid,
    [`${SEARCH}btnSearch`]: "Search",
  }, { referer: searchUrl });
  if (!search.text().includes("CF12_ContrExpendResults.aspx")) {
    throw new Error(`Missouri MEC ${input.mode} search did not open results`);
  }
  const results = requireHtml(await input.session.get(resultsUrl, { referer: searchUrl }), `${input.mode} results`);
  const advertisedCount = parseMissouriMecFullDisclosureCount(results);
  const exported = await input.session.postForm(resultsUrl, {
    ...hidden(results, resultsUrl),
    [`${RESULTS}btnExport`]: "Export Results to Excel",
  }, { referer: resultsUrl });

  const gridName = input.mode === "contributions" ? "grvContrSearch" : "grvExpendSearch";
  const exportFilename = input.mode === "contributions" ? "Contribution_Search.xls" : "Expenditure_Search.xls";
  const header = input.mode === "contributions"
    ? MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER
    : MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER;
  const resultGridPresent = new RegExp(`\\bid="[^"]*${gridName}(?:"|_)`, "i").test(results);
  const knownEmptyExportFailure =
    advertisedCount === 0 &&
    !resultGridPresent &&
    exported.status === 302 &&
    (exported.contentType ?? "").toLowerCase().includes("text/html") &&
    (exported.contentDisposition ?? "").toLowerCase().includes(exportFilename.toLowerCase()) &&
    exported.redirectLocation?.toLowerCase() === EMPTY_TRANSACTION_EXPORT_REDIRECT.toLowerCase();
  if (knownEmptyExportFailure) {
    const body = `<table><tr>${header.map((value) => `<th>${value}</th>`).join("")}</tr></table>`;
    transactionExportCount(input.mode, body);
    return { body, sourceUrl: searchUrl, resultsBody: results };
  }
  if (exported.status !== 200 || !(exported.contentType ?? "").includes("application/vnd.ms-excel")) {
    throw new Error(`Unexpected Missouri MEC ${input.mode} export content type: ${exported.contentType}`);
  }
  const body = exported.text();
  if (transactionExportCount(input.mode, body) !== advertisedCount) {
    throw new Error("Missouri MEC transaction export count mismatch");
  }
  // Results are session-bound; the stable public search page is the useful
  // citation target after this acquisition session expires.
  return { body, sourceUrl: searchUrl, resultsBody: results };
}

function parseOutsideRecordCount(html: string): number {
  const match = /([\d,]+)\s+records found/i.exec(html.replace(/<[^>]+>/g, " "));
  if (!match) throw new Error("Missouri MEC outside-spending results have no record count");
  const count = Number.parseInt(match[1]!.replace(/,/g, ""), 10);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid Missouri MEC outside-spending record count");
  return count;
}

function normalizeOutsideCommitteeLookupName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");
}

function parseOutsideSpenderMecid(response: MissouriMecResponse): string {
  const match = /(?:^|\/)CommInfo\.aspx\?mecid=([A-Z]\d{6})(?:&|$)/i.exec(response.redirectLocation ?? "");
  if (response.status !== 302 || !match) {
    throw new Error(
      `Missouri MEC outside-spender link did not resolve: HTTP ${response.status}, location ${response.redirectLocation ?? "none"}`
    );
  }
  return match[1]!.toUpperCase();
}

export async function acquireMissouriMecOutsideSpendingArtifacts(input: {
  year: number;
  cacheDir?: string;
  session?: MissouriMecSession;
  now?: Date;
}): Promise<{ year: number; rowCount: number; spenderCount: number; unresolvedSpenderCount: number }> {
  if (!Number.isSafeInteger(input.year) || input.year < 2019 || input.year > 2100) {
    throw new Error(`Invalid Missouri MEC outside-spending year: ${input.year}`);
  }
  const session = input.session ?? createMissouriMecSession();
  const retrievedAt = input.now ?? new Date();
  if (Number.isNaN(retrievedAt.getTime())) throw new Error("Invalid Missouri MEC acquisition timestamp");
  const outsideUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.outsideSpendingSearch);
  const searchPage = requireHtml(await session.get(outsideUrl), "outside-spending search page");
  const resultsHtml = requireHtml(await session.postForm(outsideUrl, {
    ...hidden(searchPage, outsideUrl),
    [`${SEARCH}ddYear`]: String(input.year),
    [`${SEARCH}txtLastName`]: "",
    [`${SEARCH}txtOfficeSought`]: "",
    [`${SEARCH}SO`]: "",
    [`${SEARCH}btnSearch`]: "Search",
  }, { referer: outsideUrl }), "outside-spending results");
  const recordCount = parseOutsideRecordCount(resultsHtml);
  const exported = await session.postForm(outsideUrl, {
    ...hidden(resultsHtml, outsideUrl),
    [`${SEARCH}ddYear`]: String(input.year),
    [`${SEARCH}btnExport`]: "Export Results to Excel",
  }, { referer: outsideUrl });
  if (!(exported.contentType ?? "").includes("application/vnd.ms-excel")) {
    throw new Error(`Unexpected Missouri MEC outside-spending export content type: ${exported.contentType}`);
  }
  const exportBody = exported.text();
  const exportRows = parseMissouriMecOutsideSpendingExport(exportBody);
  if (exportRows.length !== recordCount) {
    throw new Error(`Missouri MEC outside-spending export count mismatch: export=${exportRows.length}, results=${recordCount}`);
  }

  const identities = new Map<string, string | null>();
  const directMecidsByName = new Map<string, Set<string>>();
  const directResolvedRowsByName = new Map<string, number>();
  const gridRowsByCommittee = new Map<string, number>();
  let pageHtml = resultsHtml;
  let gridRowCount = 0;
  let expectedPage = 1;
  const maxPages = Math.ceil(exportRows.length / 25) + 1;
  while (gridRowCount < exportRows.length) {
    if (expectedPage > maxPages) throw new Error("Missouri MEC outside-spending paging exceeded expected bound");
    const page = parseMissouriMecOutsideSpendingGridPage(pageHtml);
    if (page.currentPage !== expectedPage) {
      throw new Error(`Missouri MEC outside-spending page drift: expected=${expectedPage}, actual=${page.currentPage}`);
    }
    for (const row of page.rows) {
      gridRowsByCommittee.set(row.reportingCommittee, (gridRowsByCommittee.get(row.reportingCommittee) ?? 0) + 1);
      if (!identities.has(row.reportingCommittee)) identities.set(row.reportingCommittee, null);
      // Live 2026-08-19: committee-link postbacks on paged grid pages redirect
      // to MEC's error page. Page 1 links remain valid; later identities use
      // the official MECID/name activity table below.
      if (page.currentPage === 1) {
        const resolved = await session.postForm(outsideUrl, {
          ...hidden(pageHtml, outsideUrl),
          __EVENTTARGET: row.committeeEventTarget,
          __EVENTARGUMENT: "",
          [`${SEARCH}ddYear`]: String(input.year),
        }, { referer: outsideUrl });
        if (!(resolved.status === 302 && /(?:^|\/)mec\/Error\.aspx/i.test(resolved.redirectLocation ?? ""))) {
          const mecid = parseOutsideSpenderMecid(resolved);
          const directMecids = directMecidsByName.get(row.reportingCommittee) ?? new Set<string>();
          directMecids.add(mecid);
          directMecidsByName.set(row.reportingCommittee, directMecids);
          directResolvedRowsByName.set(
            row.reportingCommittee,
            (directResolvedRowsByName.get(row.reportingCommittee) ?? 0) + 1
          );
        }
      }
      gridRowCount += 1;
    }
    if (gridRowCount >= exportRows.length) break;
    if (!page.nextPageEventTarget) {
      throw new Error(`Missouri MEC outside-spending paging ended after ${gridRowCount} of ${exportRows.length} rows`);
    }
    pageHtml = requireHtml(await session.postForm(outsideUrl, {
      ...hidden(pageHtml, outsideUrl),
      __EVENTTARGET: page.nextPageEventTarget,
      __EVENTARGUMENT: "",
      [`${SEARCH}ddYear`]: String(input.year),
    }, { referer: outsideUrl }), "outside-spending next page");
    expectedPage += 1;
  }
  const exportRowsByCommittee = new Map<string, number>();
  for (const row of exportRows) {
    exportRowsByCommittee.set(row.reportingCommittee, (exportRowsByCommittee.get(row.reportingCommittee) ?? 0) + 1);
  }
  const committeeNames = new Set([...gridRowsByCommittee.keys(), ...exportRowsByCommittee.keys()]);
  const mismatchedCommittees = [...committeeNames].filter(
    (name) => gridRowsByCommittee.get(name) !== exportRowsByCommittee.get(name)
  );
  if (gridRowCount !== exportRows.length || mismatchedCommittees.length > 0) {
    throw new Error(
      `Missouri MEC outside-spending grid/export coverage mismatch: grid=${gridRowCount}, export=${exportRows.length}, committees=${mismatchedCommittees.length}`
    );
  }
  for (const [committeeName, directMecids] of directMecidsByName) {
    // A row link proves only that row. Use link evidence by committee name
    // only when every occurrence was reachable and all resolved identically.
    if (
      directMecids.size === 1 &&
      directResolvedRowsByName.get(committeeName) === gridRowsByCommittee.get(committeeName)
    ) {
      identities.set(committeeName, [...directMecids][0]!);
    }
  }
  if ([...identities.values()].some((mecid) => mecid === null)) {
    const activityUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.committeeActivity);
    const activityPage = requireHtml(await session.get(activityUrl), "committee-activity page");
    const advancedPage = requireHtml(await session.postForm(activityUrl, {
      ...hidden(activityPage, activityUrl),
      __EVENTTARGET: `${SEARCH}lbtnAdvanced`,
      __EVENTARGUMENT: "",
    }, { referer: activityUrl }), "committee-activity advanced search");
    const through = `${retrievedAt.getUTCMonth() + 1}/${retrievedAt.getUTCDate()}/${retrievedAt.getUTCFullYear()}`;
    const activityResults = requireHtml(await session.postForm(activityUrl, {
      ...hidden(advancedPage, activityUrl),
      [`${SEARCH}txtFromDate`]: "1/1/1900",
      [`${SEARCH}txtToDate`]: through,
      [`${SEARCH}ddCommType`]: "Select All",
      [`${SEARCH}btnSearch`]: "Search",
    }, { referer: activityUrl }), "committee-activity results");
    const activityMecidsByName = new Map<string, Set<string>>();
    for (const row of parseMissouriMecCommitteeActivityRows(activityResults)) {
      if (row.mecid === null) continue;
      const normalizedName = normalizeOutsideCommitteeLookupName(row.committeeName);
      const mecidSet = activityMecidsByName.get(normalizedName) ?? new Set<string>();
      mecidSet.add(row.mecid);
      activityMecidsByName.set(normalizedName, mecidSet);
    }
    for (const [committeeName, mecid] of identities) {
      if (mecid !== null) continue;
      const exactMecids = activityMecidsByName.get(normalizeOutsideCommitteeLookupName(committeeName));
      const directMecids = directMecidsByName.get(committeeName);
      if (
        exactMecids?.size === 1 &&
        (!directMecids || (directMecids.size === 1 && directMecids.has([...exactMecids][0]!)))
      ) {
        identities.set(committeeName, [...exactMecids][0]!);
      }
    }
  }
  await storeMissouriMecOutsideSpendingArtifacts({
    cacheDir: input.cacheDir,
    year: input.year,
    sourceUrl: outsideUrl,
    exportBody,
    identities: [...identities].map(([reportingCommittee, mecid]) => ({ reportingCommittee, mecid })),
    retrievedAt,
  });
  return {
    year: input.year,
    rowCount: exportRows.length,
    spenderCount: identities.size,
    unresolvedSpenderCount: [...identities.values()].filter((mecid) => mecid === null).length,
  };
}

export type MissouriMecCandidateFinanceArtifactAcquisitionResult = {
  mecid: string;
  year: number;
  reportCount: number;
  contributionCount: number;
  receiptArtifactsAvailable: true;
} & ({
  directArtifactsAvailable: true;
  expenditureCount: number;
} | {
  directArtifactsAvailable: false;
  expenditureCount: null;
  directArtifactsSkippedReason: "Missouri MEC direct artifacts unavailable after receipt capture";
});

export async function acquireMissouriMecCandidateFinanceArtifacts(input: {
  mecid: string;
  year: number;
  cacheDir?: string;
  session?: MissouriMecSession;
  now?: Date;
}): Promise<MissouriMecCandidateFinanceArtifactAcquisitionResult> {
  const mecid = input.mecid.trim().toUpperCase();
  if (!/^[A-Z]\d{6}$/.test(mecid)) throw new Error(`Invalid Missouri MECID: ${input.mecid}`);
  if (!Number.isSafeInteger(input.year) || input.year < 2002 || input.year > 2100) throw new Error(`Invalid Missouri MEC year: ${input.year}`);
  const session = input.session ?? createMissouriMecSession();
  const retrievedAt = input.now ?? new Date();
  if (Number.isNaN(retrievedAt.getTime())) throw new Error("Invalid Missouri MEC acquisition timestamp");
  const committeeUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.committeeInfo, { MECID: mecid });
  const committeeHtml = requireHtml(await session.get(committeeUrl), "committee-info page");
  const committeeInfo = parseMissouriMecCommitteeInfo(committeeHtml);
  if (committeeInfo.mecid !== mecid) throw new Error(`Missouri MEC committee profile mismatch: expected ${mecid}, got ${committeeInfo.mecid}`);

  const reportsTab = requireHtml(await session.postForm(committeeUrl, {
    ...hidden(committeeHtml, committeeUrl),
    __EVENTTARGET: `${SEARCH}lbtnReports`,
    __EVENTARGUMENT: "",
  }, { referer: committeeUrl }), "reports tab");
  const reportYear = parseMissouriMecReportYears(reportsTab).find((row) => row.year === input.year);
  if (!reportYear) throw new Error(`Missouri MEC committee ${mecid} has no report inventory for ${input.year}`);
  const reportHtml = requireHtml(await session.postForm(committeeUrl, {
    ...hidden(reportsTab, committeeUrl),
    [`${SEARCH}${reportYear.expandControlName}.x`]: "1",
    [`${SEARCH}${reportYear.expandControlName}.y`]: "1",
  }, { referer: committeeUrl }), "expanded report inventory");
  const inventory = safeReportInventory(reportHtml);
  const contributions = await fetchTransactionExport({ session, mecid, year: input.year, mode: "contributions" });
  const receiptClosingInventoryBody = await requireUnchangedClosingInventory({ session, committeeUrl, year: input.year, opening: inventory });
  const receiptArtifacts = [
    { type: "committee_info" as const, body: committeeHtml, sourceUrl: committeeUrl },
    { type: "report_inventory" as const, body: reportHtml, sourceUrl: committeeUrl },
    { type: "contributions" as const, ...contributions },
  ];
  await storeMissouriMecCommitteeReceiptArtifactBundle({
    cacheDir: input.cacheDir,
    mecid,
    year: input.year,
    retrievedAt,
    artifacts: receiptArtifacts,
    transactionResultBodies: { contributions: contributions.resultsBody },
    closingInventoryBody: receiptClosingInventoryBody,
  });
  // Availability describes this acquisition, never a prior cache generation.
  const receiptResult = {
    mecid,
    year: input.year,
    reportCount: inventory.length,
    contributionCount: transactionExportCount("contributions", contributions.body),
    receiptArtifactsAvailable: true as const,
  };
  try {
    const expenditures = await fetchTransactionExport({ session, mecid, year: input.year, mode: "expenditures" });
    const closingInventoryBody = await requireUnchangedClosingInventory({ session, committeeUrl, year: input.year, opening: inventory });
    await storeMissouriMecCandidateArtifactBundle({
      cacheDir: input.cacheDir,
      mecid,
      year: input.year,
      retrievedAt,
      artifacts: [...receiptArtifacts, { type: "expenditures" as const, ...expenditures }],
      transactionResultBodies: { contributions: contributions.resultsBody, expenditures: expenditures.resultsBody },
      closingInventoryBody,
    });
    return { ...receiptResult, directArtifactsAvailable: true,
      expenditureCount: transactionExportCount("expenditures", expenditures.body) };
  } catch {
    // A separately committed receipt source remains usable; no raw source diagnostics escape.
    return { ...receiptResult, directArtifactsAvailable: false, expenditureCount: null,
      directArtifactsSkippedReason: "Missouri MEC direct artifacts unavailable after receipt capture" };
  }
}

export async function acquireMissouriMecOutsideSpenderContributionArtifacts(input: {
  mecid: string;
  year: number;
  cacheDir?: string;
  session?: MissouriMecSession;
  now?: Date;
}): Promise<{ mecid: string; year: number; committeeName: string; reportCount: number; contributionCount: number }> {
  const mecid = input.mecid.trim().toUpperCase();
  if (!/^[A-Z]\d{6}$/.test(mecid)) throw new Error(`Invalid Missouri MECID: ${input.mecid}`);
  if (!Number.isSafeInteger(input.year) || input.year < 2002 || input.year > 2100) {
    throw new Error(`Invalid Missouri MEC year: ${input.year}`);
  }
  const session = input.session ?? createMissouriMecSession();
  const retrievedAt = input.now ?? new Date();
  if (Number.isNaN(retrievedAt.getTime())) throw new Error("Invalid Missouri MEC acquisition timestamp");
  const committeeUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.committeeInfo, { MECID: mecid });
  const committeeHtml = requireHtml(await session.get(committeeUrl), "outside-spender committee page");
  const identity = parseMissouriMecCommitteeIdentity(committeeHtml);
  if (identity.mecid !== mecid) {
    throw new Error(`Missouri MEC outside-spender profile mismatch: expected ${mecid}, got ${identity.mecid}`);
  }
  const reportsTab = requireHtml(await session.postForm(committeeUrl, {
    ...hidden(committeeHtml, committeeUrl),
    __EVENTTARGET: `${SEARCH}lbtnReports`,
    __EVENTARGUMENT: "",
  }, { referer: committeeUrl }), "outside-spender reports tab");
  const reportYear = parseMissouriMecReportYears(reportsTab).find((row) => row.year === input.year);
  if (!reportYear) throw new Error(`Missouri MEC outside spender ${mecid} has no report inventory for ${input.year}`);
  const reportHtml = requireHtml(await session.postForm(committeeUrl, {
    ...hidden(reportsTab, committeeUrl),
    [`${SEARCH}${reportYear.expandControlName}.x`]: "1",
    [`${SEARCH}${reportYear.expandControlName}.y`]: "1",
  }, { referer: committeeUrl }), "expanded outside-spender report inventory");
  const inventory = safeReportInventory(reportHtml);
  const contributions = await fetchTransactionExport({ session, mecid, year: input.year, mode: "contributions" });
  await requireUnchangedClosingInventory({ session, committeeUrl, year: input.year, opening: inventory });
  await Promise.all([
    storeMissouriMecArtifact({
      cacheDir: input.cacheDir,
      key: { type: "outside_spender_report_inventory", mecid, year: input.year },
      sourceUrl: committeeUrl,
      body: reportHtml,
      retrievedAt,
    }),
    storeMissouriMecArtifact({
      cacheDir: input.cacheDir,
      key: { type: "outside_spender_contributions", mecid, year: input.year },
      sourceUrl: contributions.sourceUrl,
      body: contributions.body,
      retrievedAt,
    }),
  ]);
  return {
    mecid,
    year: input.year,
    committeeName: identity.committeeName,
    reportCount: inventory.length,
    contributionCount: transactionExportCount("contributions", contributions.body),
  };
}

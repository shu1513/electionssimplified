// Montana CERS outside-spending acquisition (docs/plans/montana-finance.md,
// Phase 2b): one yearly sweep — the IE committee search, every matched
// committee's transaction rows, and the registration list that resolution
// runs against — stored as two same-vintage artifacts.
//
// Flow pinned live 2026-08-28:
// - The expenditure search form (search page `searchExpendituresForm`)
//   POSTs to searchResults/searchFinancials with financialSearchType=EXPEND,
//   expendSearchTypeCode=COMMITTEE, independentExpendSearch=true, an
//   electionYear, and EMPTY date/name fields; the `(searchResults)` title
//   marker guards the silent validation bounce.
// - Committee results: GET searchResults/listFinancialCommitteeResults
//   (DataTables; 49 committees for 2026).
// - Per committee: POST searchResults/viewFinancialEntities
//   {candidateId: 0, committeeId} (its resultCount is the row-count
//   cross-check), then GET searchResults/listViewFinancialEntityResults.
//   Transaction rows carry NO committee identity, so each committee gets a
//   FRESH session (the stale-session gotcha) and the artifact records the
//   requested committeeId + resultCount alongside the raw list.

import {
  assertMontanaCersPageTitle,
  buildMontanaCersDataTablesQuery,
  buildMontanaCersUrl,
  createMontanaCersSession,
  type MontanaCersSession,
  type MontanaCersSessionOptions,
} from "./montanaCersClient.js";
import { fetchMontanaCersCandidateSearchBodyByYear } from "./montanaCandidateCersResolver.js";
import { storeMontanaCersArtifact } from "./montanaCersArtifactCache.js";
import { createMontanaIeHttpArchive } from "./montanaNativeHttpArchive.js";
import {
  MontanaCersParseError,
  parseMontanaCersIeCommitteeResults,
  parseMontanaCersIeSweepArtifact,
} from "./montanaCersParsers.js";

export type MontanaOutsideSpendingAcquisitionResult = {
  year: number;
  committeeCount: number;
  transactionRowCount: number;
  registrationRowCount: number;
};

async function openIeCommitteeSearch(
  year: number,
  sessionOptions: MontanaCersSessionOptions | undefined
): Promise<MontanaCersSession> {
  const session = createMontanaCersSession(sessionOptions);
  await session.get(buildMontanaCersUrl("search/candidateSearch"));
  const search = await session.postForm(buildMontanaCersUrl("searchResults/searchFinancials"), {
    financialSearchType: "EXPEND",
    expendSearchTypeCode: "COMMITTEE",
    expendCanLastName: "",
    expendCanFirstName: "",
    expendCommitteeName: "",
    payeeLastName: "",
    payeeFirstName: "",
    independentExpendSearch: "true",
    electioneeringCommSearch: "false",
    electionYear: String(year),
    expendSearchFromDate: "",
    expendSearchToDate: "",
  });
  assertMontanaCersPageTitle(search.text(), "searchResults", `IE committee search ${year}`);
  return session;
}

export async function acquireMontanaCersOutsideSpendingArtifacts(input: {
  year: number;
  cacheDir?: string;
  now?: Date;
  sessionOptions?: MontanaCersSessionOptions;
}): Promise<MontanaOutsideSpendingAcquisitionResult> {
  if (!Number.isSafeInteger(input.year) || input.year < 2020 || input.year > 2100) {
    throw new Error(`Invalid Montana IE sweep year: ${input.year}`);
  }
  const retrievedAt = input.now ?? new Date();
  if (Number.isNaN(retrievedAt.getTime())) {
    throw new Error("Invalid Montana IE sweep timestamp");
  }

  const archive = await createMontanaIeHttpArchive(input.year,input.cacheDir,input.sessionOptions);
  const listSession = await openIeCommitteeSearch(input.year, archive.sessionOptions);
  const committeeBody = await listSession.get(
    buildMontanaCersUrl("searchResults/listFinancialCommitteeResults", buildMontanaCersDataTablesQuery(5_000))
  );
  const committees = parseMontanaCersIeCommitteeResults(committeeBody.text());

  const committeeTransactions: { committeeId: number; resultCount: number; list: unknown }[] = [];
  for (const committee of committees) {
    // Fresh session per committee: rows carry no committee identity, so the
    // session's entity selection is the only binding.
    const session = await openIeCommitteeSearch(input.year, archive.sessionOptions);
    const view = await session.postForm(buildMontanaCersUrl("searchResults/viewFinancialEntities"), {
      candidateId: "0",
      committeeId: String(committee.committeeId),
    });
    let resultCount: unknown;
    try {
      resultCount = (JSON.parse(view.text()) as { resultCount?: unknown }).resultCount;
    } catch {
      throw new MontanaCersParseError(
        `Montana CERS viewFinancialEntities did not answer JSON for committee ${committee.committeeId}`
      );
    }
    if (typeof resultCount !== "number" || !Number.isSafeInteger(resultCount) || resultCount < 0) {
      throw new MontanaCersParseError(
        `Montana CERS viewFinancialEntities returned no resultCount for committee ${committee.committeeId}`
      );
    }
    const list = await session.get(
      buildMontanaCersUrl("searchResults/listViewFinancialEntityResults", buildMontanaCersDataTablesQuery(5_000))
    );
    committeeTransactions.push({
      committeeId: committee.committeeId,
      resultCount,
      list: JSON.parse(list.text()) as unknown,
    });
  }

  const sweepBody = JSON.stringify({
    year: input.year,
    originalArchiveDirectory: archive.relativeDirectory,
    committeeSearch: JSON.parse(committeeBody.text()) as unknown,
    committeeTransactions,
  });
  // Full validation (committee-set coherence, resultCount cross-checks)
  // before anything is stored.
  const sweep = parseMontanaCersIeSweepArtifact(sweepBody);

  const registrationBody = await fetchMontanaCersCandidateSearchBodyByYear(input.year, archive.sessionOptions);
  const registrationManifest = await storeMontanaCersArtifact({
    cacheDir: input.cacheDir,
    key: { type: "ie_registration_list", year: input.year },
    sourceUrl: buildMontanaCersUrl("searchResults/listCandidateResults"),
    body: registrationBody,
    retrievedAt,
  });
  await storeMontanaCersArtifact({
    cacheDir: input.cacheDir,
    key: { type: "ie_sweep", year: input.year },
    sourceUrl: buildMontanaCersUrl("searchResults/listViewFinancialEntityResults"),
    body: sweepBody,
    retrievedAt,
  });

  return {
    year: input.year,
    committeeCount: sweep.committees.length,
    transactionRowCount: [...sweep.transactionsByCommitteeId.values()].reduce((sum, rows) => sum + rows.length, 0),
    registrationRowCount: registrationManifest.rowCount,
  };
}

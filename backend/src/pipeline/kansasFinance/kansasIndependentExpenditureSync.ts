import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

import {
  createKansasCfrSession,
  type KansasCfrSessionOptions,
} from "./kansasCfrViewerClient.js";
import {
  DEFAULT_KANSAS_FINANCE_CACHE_DIR,
  storeKansasFinanceArtifact,
} from "./kansasFinanceArtifactCache.js";
import {
  getKansasIEPaperDocument,
  KANSAS_IE_PAPER_URL_PATTERN,
  searchKansasIndependentExpenditures,
  type KansasIEPaperDocument,
} from "./kansasIndependentExpenditureClient.js";
import { replaceKansasIEDocument } from "./kansasIndependentExpenditureStore.js";
import {
  KANSAS_REVIEWED_IE_STATEMENTS,
  type KansasReviewedIEStatement,
} from "./kansasReviewedIEStatements.js";

export type KansasIEBrowserObservation = {
  version: 1;
  kind: "browser-rendered";
  observedAt: string;
  sourceUrl: string;
  recordCount: number;
  scope: {
    filerName: string;
    filingType: "Individual Expenditures";
    startDate: string;
    endDate: string;
  };
  filings: {
    name: string;
    fileDate: string;
    officeSought: string;
    district: string;
    filingType: string;
    paper: true;
    sourceUrl: string;
    openerObservedAt: string;
  }[];
};

export type KansasIESyncResult = {
  status: "observed" | "unavailable";
  recordCount: number | null;
  acquiredDocuments: number;
  acceptedDocuments: number;
  writtenRows: number;
  mappedRows: number;
  pendingDocuments: number;
  diagnostics: string[];
};

/** Rendered observations have no invented HTTP status or raw-response hash. */
export function validateKansasIEBrowserObservation(
  value: unknown,
  electionYear: number,
  now: Date,
): KansasIEBrowserObservation {
  const packet = value as KansasIEBrowserObservation;
  if (
    !packet ||
    packet.version !== 1 ||
    packet.kind !== "browser-rendered" ||
    packet.sourceUrl !==
      "https://sos.ks.gov/elections/cfr_viewer/cfr_examiner_search_results.aspx" ||
    !Number.isFinite(Date.parse(packet.observedAt)) ||
    Date.parse(packet.observedAt) > now.getTime() ||
    now.getTime() - Date.parse(packet.observedAt) > 36 * 60 * 60 * 1000 ||
    !packet.scope ||
    packet.scope.filingType !== "Individual Expenditures" ||
    packet.scope.startDate !== `01/01/${electionYear}` ||
    !/^\d{2}\/\d{2}\/\d{4}$/.test(packet.scope.endDate) ||
    !Array.isArray(packet.filings) ||
    packet.filings.length !== packet.recordCount ||
    packet.recordCount < 1 ||
    packet.recordCount > 450
  ) {
    throw new Error(
      "Invalid, stale or incomplete Kansas IE browser observation",
    );
  }
  const windowEnd = Date.parse(`${isoDate(packet.scope.endDate)}T00:00:00Z`);
  if (windowEnd < Date.UTC(electionYear, 0, 1) || windowEnd > now.getTime()) {
    throw new Error("Invalid Kansas IE filed-date window");
  }
  const urls = new Set<string>();
  for (const row of packet.filings) {
    if (
      !row ||
      row.name !== packet.scope.filerName ||
      row.officeSought !== "INDIVIDUAL ENTITY" ||
      row.district !== "" ||
      row.filingType !== "INDIVIDUAL EXPENDITURES" ||
      row.paper !== true ||
      !/^\d{2}\/\d{2}\/\d{4}$/.test(row.fileDate) ||
      !Number.isFinite(Date.parse(row.openerObservedAt)) ||
      Date.parse(row.openerObservedAt) > Date.parse(packet.observedAt) ||
      Date.parse(packet.observedAt) - Date.parse(row.openerObservedAt) >
        60 * 60 * 1000 ||
      urls.has(row.sourceUrl)
    ) {
      throw new Error("Invalid Kansas IE browser filing/PDF association");
    }
    if (!KANSAS_IE_PAPER_URL_PATTERN.test(row.sourceUrl))
      throw new Error("Invalid official Kansas IE PDF association");
    urls.add(row.sourceUrl);
  }
  return {
    version: 1,
    kind: "browser-rendered",
    observedAt: packet.observedAt,
    sourceUrl: packet.sourceUrl,
    recordCount: packet.recordCount,
    scope: {
      filerName: packet.scope.filerName,
      filingType: packet.scope.filingType,
      startDate: packet.scope.startDate,
      endDate: packet.scope.endDate,
    },
    filings: packet.filings.map((row) => ({
      name: row.name,
      fileDate: row.fileDate,
      officeSought: row.officeSought,
      district: row.district,
      filingType: row.filingType,
      paper: row.paper,
      sourceUrl: row.sourceUrl,
      openerObservedAt: row.openerObservedAt,
    })),
  };
}

export function acceptedKansasIEStatements(input: {
  electionYear: number;
  documents: readonly KansasIEPaperDocument[];
  filingFacts: ReadonlyMap<string, { payerName: string; filingDate: string }>;
  reviewed?: readonly KansasReviewedIEStatement[];
}): KansasReviewedIEStatement[] {
  const originals = new Map(
    input.documents.map((document) => [document.sourceUrl, document]),
  );
  const reviewed = input.reviewed ?? KANSAS_REVIEWED_IE_STATEMENTS;
  return reviewed.filter((statement) => {
    const facts = input.filingFacts.get(statement.sourceUrl);
    if (
      statement.electionYear !== input.electionYear ||
      facts?.payerName !== statement.payerName ||
      facts.filingDate !== statement.filingDate
    )
      return false;
    const companions = statement.controlDocumentUrls.map((url) =>
      reviewed.find((item) => item.sourceUrl === url),
    );
    if (
      companions.some(
        (item) =>
          !item ||
          originals.get(item.sourceUrl)?.observation.sha256 !== item.sha256 ||
          createHash("sha256")
            .update(originals.get(item.sourceUrl)!.body)
            .digest("hex") !== item.sha256 ||
          item.payerName !== statement.payerName ||
          item.periodDueKey !== statement.periodDueKey ||
          item.filingDate !== statement.filingDate ||
          item.statementTotalCents !== statement.statementTotalCents ||
          input.filingFacts.get(item.sourceUrl)?.payerName !== item.payerName ||
          input.filingFacts.get(item.sourceUrl)?.filingDate !== item.filingDate,
      )
    )
      return false;
    return (
      companions.reduce(
        (total, item) =>
          total + item!.rows.reduce((sum, row) => sum + row.amountCents, 0),
        0,
      ) === statement.statementTotalCents
    );
  });
}

function isoDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error("Kansas IE source omitted filed date");
  const date = `${match[3]}-${match[1]}-${match[2]}`;
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new Error("Invalid Kansas IE filed date");
  return date;
}

/** Independent of direct due-list eligibility, receiving links and receipts. */
export async function syncKansasIndependentExpenditures(input: {
  db: Pick<Pool, "connect">;
  electionYear: number;
  now?: Date;
  dryRun?: boolean;
  observationFile?: string;
  cacheDir?: string;
  sessionOptions?: KansasCfrSessionOptions;
  writeDocumentFn?: typeof replaceKansasIEDocument;
}): Promise<KansasIESyncResult> {
  const now = input.now ?? new Date();
  const result: KansasIESyncResult = {
    status: "unavailable",
    recordCount: null,
    acquiredDocuments: 0,
    acceptedDocuments: 0,
    writtenRows: 0,
    mappedRows: 0,
    pendingDocuments: 0,
    diagnostics: [],
  };
  const cacheDir = input.cacheDir ?? DEFAULT_KANSAS_FINANCE_CACHE_DIR;
  const captureDir = resolve(cacheDir, "ie-observations", randomUUID());
  const savedInventory = resolve(
    cacheDir,
    "ie-inventory",
    `${input.electionYear}.json`,
  );
  const documents: KansasIEPaperDocument[] = [];
  const facts = new Map<string, { payerName: string; filingDate: string }>();
  let sourceObservation: unknown;
  let totalBytes = 0;
  const retain = async (document: KansasIEPaperDocument) => {
    totalBytes += document.body.byteLength;
    if (totalBytes > 60 * 1024 * 1024)
      throw new Error("Kansas IE total PDF byte limit exceeded");
    documents.push(document);
    await storeKansasFinanceArtifact({
      cacheDir,
      key: {
        kind: "viewer_pdf",
        id: new URL(document.sourceUrl).pathname.slice(1),
      },
      sourceUrl: document.sourceUrl,
      body: document.body,
      retrievedAt: new Date(document.observation.endedAt),
    });
    result.acquiredDocuments = documents.length;
  };
  try {
    await mkdir(captureDir, { recursive: true, mode: 0o700 });
    await chmod(captureDir, 0o700);
    let packet: KansasIEBrowserObservation | undefined;
    try {
      packet = validateKansasIEBrowserObservation(
        JSON.parse(
          await readFile(input.observationFile ?? savedInventory, "utf8"),
        ),
        input.electionYear,
        now,
      );
    } catch (error) {
      if (input.observationFile) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        result.diagnostics.push(
          "Saved Kansas IE inventory is unavailable or expired; attempting fresh native search",
        );
    }
    if (packet) {
      sourceObservation = packet;
      result.recordCount = packet.recordCount;
      const session = createKansasCfrSession({
        ...input.sessionOptions,
        maxAttempts: 1,
        timeoutMs: 30_000,
        maxResponseBytes: 8 * 1024 * 1024,
      });
      for (const row of packet.filings) {
        const document = await getKansasIEPaperDocument(
          session,
          row.sourceUrl,
          packet.sourceUrl,
        );
        await retain(document);
        facts.set(row.sourceUrl, {
          payerName: row.name,
          filingDate: isoDate(row.fileDate),
        });
      }
    } else {
      const searched = await searchKansasIndependentExpenditures({
        startDate: `01/01/${input.electionYear}`,
        endDate: `${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}/${now.getUTCFullYear()}`,
        sessionOptions: input.sessionOptions,
      });
      result.recordCount = searched.recordCount;
      sourceObservation = {
        kind: "native-parsed",
        observedAt: new Date().toISOString(),
        recordCount: searched.recordCount,
        filings: searched.filings.map(({ row }) => row),
      };
      for (const filing of searched.filings) {
        const document = await filing.openPaperDocument();
        await retain(document);
        facts.set(document.sourceUrl, {
          payerName: filing.row.name,
          filingDate: isoDate(filing.row.fileDate),
        });
      }
    }
    // Every original was saved before any canonical acceptance, including
    // completed acquisitions preceding a later source failure.
    result.acquiredDocuments = documents.length;
    const accepted = acceptedKansasIEStatements({
      electionYear: input.electionYear,
      documents,
      filingFacts: facts,
    });
    result.acceptedDocuments = accepted.length;
    result.pendingDocuments = documents.length - accepted.length;
    for (const statement of accepted) {
      if (!input.dryRun) {
        const written = await (
          input.writeDocumentFn ?? replaceKansasIEDocument
        )({
          db: input.db,
          ...statement,
          observedAt: documents.find(
            (document) => document.sourceUrl === statement.sourceUrl,
          )!.observation.endedAt,
        });
        result.writtenRows += written.rowCount;
        result.mappedRows += written.mappedRowCount;
      }
    }
    result.status = "observed";
    if (packet) {
      // Keep the actual rendered observation time. Repeated PDF GETs do not
      // transform this saved inventory into a newly observed government page.
      await mkdir(resolve(cacheDir, "ie-inventory"), {
        recursive: true,
        mode: 0o700,
      });
      await chmod(resolve(cacheDir, "ie-inventory"), 0o700);
      const temporary = `${savedInventory}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(packet, null, 2), {
        mode: 0o600,
      });
      await rename(temporary, savedInventory);
    }
    if (result.pendingDocuments)
      result.diagnostics.push(
        `${result.pendingDocuments} acquired documents need complete reviewed financial mappings; prior evidence preserved`,
      );
  } catch (error) {
    result.diagnostics.push(
      error instanceof Error ? error.message : "Kansas IE source unavailable",
    );
  }
  // Original PDF GET facts remain separate from rendered inventory observations.
  await writeFile(
    resolve(captureDir, "observation.json"),
    JSON.stringify(
      {
        sourceObservation,
        pdfObservations: documents.map(({ sourceUrl, observation }) => ({
          sourceUrl,
          ...observation,
        })),
        result,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return result;
}

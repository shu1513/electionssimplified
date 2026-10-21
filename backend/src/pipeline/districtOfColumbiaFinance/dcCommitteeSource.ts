import fs from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as eq } from "node:util";
import {
  DC_COMMITTEE_ORIGIN,
  dcCheck,
  dcHold,
  dcObject,
  dcInteger,
  dcId,
  dcGridBody,
  dcRegistration,
  dcReceipt,
  dcCsv,
  dcCsvGridClosure,
  dcParentClosure,
  type DcCommitteeRegistration,
  type DcCommitteeReceipt,
} from "./dcCommitteeNative.js";
import {
  DC_COMMITTEE_CACHE,
  DcCommitteeOriginalSequence,
  dcPrivateDirectory,
  dcPrivateRead,
  dcSha,
  type DcCommitteeOriginal,
  type DcCommitteeManifest,
} from "./dcCommitteeOriginals.js";

export type DcCommitteeSourceFacts = {
  manifestSha256: string;
  observedAt: string;
  completedAt: string;
  registryRows: number;
  receiptRows: number;
  parentRows: number;
  observations: readonly Readonly<
    Omit<DcCommitteeOriginal, "requestFile" | "requestSha256" | "file">
  >[];
};
export type DcCommitteeDataset = {
  registrations: readonly DcCommitteeRegistration[];
  receipts: readonly DcCommitteeReceipt[];
  parentRows: number;
};
export type DcCommitteeSource = Readonly<
  DcCommitteeDataset & {
    year: number;
    source: Readonly<DcCommitteeSourceFacts>;
  }
>;
const verified = new WeakSet<object>();
export const isVerifiedDcCommitteeSource = (
  v: unknown,
): v is DcCommitteeSource => !!v && typeof v === "object" && verified.has(v);

const RECEIPT_COLUMNS = [
  "CommitteeName",
  "CandidateName",
  "ContributorName",
  "ContributorName",
  "Address",
  "Address",
  "ContributorType",
  "TransactionType",
  "TransactionDate",
  "PurposeType",
  "TransactionDate",
  "Amount",
  "Id",
];
const PARENT_COLUMNS = [
  "NameOfCommittee",
  "CandidateName",
  "CandidateKey",
  "CommitteeKey",
  "ReportName",
  "ReportStatus",
  "Section",
  "FilingYear",
  "SubmittedDate",
];
/** Complete native windows plus unchanged closing sweeps. No monetary row,
 * duplicate occurrence or historical registry entry is discarded. */
export async function runDcCommitteeProtocol(
  sequence: DcCommitteeOriginalSequence,
): Promise<DcCommitteeDataset> {
  async function grid(
    role: string,
    path: string,
    columns: readonly string[],
    length = 5000,
    orders: readonly (readonly [number, string])[] = [[0, "asc"]],
  ) {
    let rows: Record<string, unknown>[] = [],
      expected: number | undefined,
      page = 0;
    do {
      const raw = await sequence.request(
        `${role}_${++page}`,
        path,
        dcGridBody(columns, rows.length, length, page, orders),
      );
      const v = dcObject(JSON.parse(raw.toString("utf8"))),
        total = dcInteger(v.recordsTotal);
      dcCheck(
        total === dcInteger(v.recordsFiltered) &&
          total <= 100000 &&
          Array.isArray(v.data),
        "native_grid_scope",
      );
      if (expected === undefined) expected = total;
      dcCheck(
        total === expected &&
          v.data.length === Math.min(length, expected - rows.length),
        "native_page_population",
      );
      rows.push(...v.data.map(dcObject));
    } while (rows.length < expected);
    return rows;
  }
  async function registry(side: string) {
    const raw = await grid(
      `registry_${side}`,
      "/ContributionExpenditure/SearchRecipients/2",
      ["Id", "CandidateName", "CommitteeName", "ElectionYear"],
      100,
    );
    dcCheck(
      new Set(raw.map((r) => dcId(r.Id))).size === raw.length &&
        new Set(raw.map((r) => dcId(r.CommitteeId))).size === raw.length,
      "duplicate_registration_identity",
    );
    return raw;
  }
  async function submit(
    role: string,
    base: "/DataDownload" | "/FinancialReports",
    fields: Record<string, string>,
  ) {
    sequence.resetAnonymousSession();
    await sequence.request(`${role}_form`, base);
    await sequence.request(
      `${role}_submit`,
      `${base}/SubmitSearch`,
      new URLSearchParams(fields).toString(),
      302,
    );
    const record = sequence.lastOriginal!;
    const target = new URL(record.location!, record.url);
    dcCheck(
      target.origin === DC_COMMITTEE_ORIGIN &&
        target.pathname === `${base}/SearchResults` &&
        !target.search &&
        !target.hash,
      "public_search_redirect",
    );
    await sequence.request(`${role}_results`, target.pathname);
  }
  const openingRegistry = await registry("opening");
  await submit("receipts", "/DataDownload", {
    FilerTypeId: "2",
    SearchType: "Contributions",
    FromDate: `01/01/${sequence.year - 1}`,
    ToDate: `12/31/${sequence.year}`,
  });
  const opening = await grid(
    "receipts_opening",
    "/DataDownload/Search",
    RECEIPT_COLUMNS,
    5000,
    [
      [12, "asc"],
      [8, "desc"],
    ],
  );
  const csv = dcCsv(
    await sequence.request(
      "receipts_csv",
      "/DataDownload/Export?exportType=CSV",
    ),
  );
  dcCsvGridClosure(csv.rows, opening);
  const closing = await grid(
    "receipts_closing",
    "/DataDownload/Search",
    RECEIPT_COLUMNS,
    5000,
    [
      [12, "asc"],
      [8, "desc"],
    ],
  );
  dcCheck(eq(opening, closing), "receipt_source_changed");
  const receipts = opening.map((r) => dcReceipt(r, sequence.year));
  dcCheck(
    new Set(receipts.map((r) => r.id)).size === receipts.length,
    "duplicate_receipt_identity",
  );
  const parents: Record<string, unknown>[] = [];
  for (const year of [sequence.year - 1, sequence.year]) {
    await submit(`parents_${year}`, "/FinancialReports", {
      ReportName: "",
      FilerTypeId: "2",
      FilingYear: String(year),
      FilerTypeReportId: "",
      NameOfCommittee: "",
      FirstName: "",
      LastName: "",
    });
    const first = await grid(
        `parents_${year}_opening`,
        "/FinancialReports/Search",
        PARENT_COLUMNS,
      ),
      last = await grid(
        `parents_${year}_closing`,
        "/FinancialReports/Search",
        PARENT_COLUMNS,
      );
    dcCheck(
      eq(first, last) && first.every((r) => r.FilingYear === year),
      "parent_catalog_changed_or_scope",
    );
    parents.push(...first);
  }
  dcParentClosure(receipts, parents);
  const closingRegistry = await registry("closing");
  dcCheck(eq(openingRegistry, closingRegistry), "registry_source_changed");
  return {
    registrations: openingRegistry.map(dcRegistration),
    receipts,
    parentRows: parents.length,
  };
}
function seal(
  data: DcCommitteeDataset,
  manifest: DcCommitteeManifest,
  digest: string,
): DcCommitteeSource {
  dcCheck(manifest.records.length > 0, "empty_source_observations");
  const observations = manifest.records.map(
    ({
      requestFile: _request,
      requestSha256: _requestSha,
      file: _file,
      ...r
    }) => Object.freeze(r),
  );
  for (const rows of [data.registrations, data.receipts]) {
    rows.forEach(Object.freeze);
    Object.freeze(rows);
  }
  const source = Object.freeze({
    manifestSha256: digest,
    observedAt: observations[0]!.startedAt,
    completedAt: observations.at(-1)!.completedAt,
    registryRows: data.registrations.length,
    receiptRows: data.receipts.length,
    parentRows: data.parentRows,
    observations: Object.freeze(observations),
  });
  const packet = Object.freeze({ ...data, year: manifest.year, source });
  verified.add(packet);
  return packet;
}
async function replay(
  directory: string,
  manifest: DcCommitteeManifest,
  digest: string,
): Promise<DcCommitteeSource> {
  const sequence = await DcCommitteeOriginalSequence.reopen(
      directory,
      manifest,
    ),
    data = await runDcCommitteeProtocol(sequence);
  sequence.finish();
  return seal(data, manifest, digest);
}
async function saved(
  root: string,
  year: number,
): Promise<DcCommitteeSource | null> {
  try {
    const pointer = dcObject(
      JSON.parse(
        (
          await dcPrivateRead(resolve(root, `source-${year}.json`), 65536)
        ).toString("utf8"),
      ),
    );
    dcCheck(
      pointer.version === 1 &&
        pointer.year === year &&
        typeof pointer.directory === "string" &&
        /^packet-[a-f0-9-]{36}$/.test(pointer.directory) &&
        typeof pointer.manifestSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(pointer.manifestSha256),
      "source_pointer",
    );
    const directory = resolve(root, pointer.directory),
      raw = await dcPrivateRead(
        resolve(directory, "manifest.json"),
        16 * 1024 * 1024,
      );
    dcCheck(dcSha(raw) === pointer.manifestSha256, "source_manifest_integrity");
    const manifest = JSON.parse(raw.toString("utf8")) as DcCommitteeManifest;
    dcCheck(manifest.year === year, "source_year");
    return await replay(directory, manifest, pointer.manifestSha256);
  } catch {
    return null;
  }
}
/** A valid saved graph is replayed before network access. Parse successes,
 * pointer health and file mtimes cannot refresh monetary observations. */
export async function getDcCommitteeSource(input: {
  year: number;
  cacheDir?: string;
  refresh?: boolean;
  transport?: typeof fetch;
}): Promise<DcCommitteeSource> {
  dcCheck(
    Number.isSafeInteger(input.year) &&
      input.year >= 2021 &&
      input.year <= 2100,
    "source_year",
  );
  const root = resolve(input.cacheDir ?? DC_COMMITTEE_CACHE);
  await dcPrivateDirectory(root);
  if (!input.refresh) {
    const packet = await saved(root, input.year);
    if (
      packet &&
      Date.now() - Date.parse(packet.source.observedAt) <= 7 * 86400000
    )
      return packet;
  }
  const sequence = await DcCommitteeOriginalSequence.capture(
    input.year,
    root,
    input.transport,
  );
  try {
    await runDcCommitteeProtocol(sequence);
    const manifest = sequence.finish(),
      raw = Buffer.from(JSON.stringify(manifest) + "\n"),
      digest = dcSha(raw);
    await fs.writeFile(resolve(sequence.directory, "manifest.json"), raw, {
      mode: 0o600,
      flag: "wx",
    });
    const packet = await replay(sequence.directory, manifest, digest),
      temporary = resolve(root, `pointer-${randomUUID()}.json`);
    await fs.writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        year: input.year,
        directory: sequence.directory.split(/[\\/]/).at(-1),
        manifestSha256: digest,
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(temporary, resolve(root, `source-${input.year}.json`));
    return packet;
  } catch (e) {
    if (e instanceof Error && e.name === "DcCommitteeSourceError") throw e;
    return dcHold("native_acquisition_or_replay_failed");
  }
}

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  captureMarylandPublicReportInventoryPost,
  captureMarylandPublishedReportPdfPost,
  MarylandCurrentCycleExportError,
  type MarylandCurrentCycleCapture,
} from "./marylandCurrentCycleExportClient.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const guid = (value: unknown): value is string => typeof value === "string" && GUID.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 1_000 && !/[\x00-\x1f\x7f]/.test(value);
const fail = (): never => { throw new MarylandCurrentCycleExportError("invalid_report_inventory"); };

type Scope = { filerRegistrationGuid: string; electionCycleId: string; pageNumber: number };
/** Exact unrestricted public profile builder. Zero server echoes are advisory. */
export function buildMarylandPublicReportInventoryRequest(input: Scope) {
  if (!guid(input.filerRegistrationGuid) || typeof input.electionCycleId !== "string" ||
    !/^[1-9]\d*$/.test(input.electionCycleId) || !positiveInteger(input.pageNumber))
    throw new MarylandCurrentCycleExportError("invalid_request");
  return Object.freeze({ filerRegistrationGuid: input.filerRegistrationGuid,
    electionCycleId: input.electionCycleId, pageNumber: input.pageNumber,
    pageSize: 10 as const, sortBy: "End Of Period" as const, sortType: "desc" as const });
}
export type MarylandPublicReportInventoryRequest = ReturnType<typeof buildMarylandPublicReportInventoryRequest>;

function localDateTime(value: unknown, midnight = false): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(value) ||
    value.startsWith("0000") || (midnight && !value.endsWith("T00:00:00"))) return false;
  const parsed = new Date(`${value}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

export type MarylandPublishedReportChild = Readonly<{
  filerReportGuid: string; filerReportVersionID: number; totalRows: number;
  reportName: string; reportType: string; startDate: string; endDate: string;
  dueDate: string; filedDate: string; isCompleted: boolean;
  generateStatus: string; generateStatusCode: string; reportStatus: string;
  isPaperFile: boolean;
}>;
export type MarylandPublishedReport = Readonly<{
  reportGuid: string; reportVersionId: number; reportName: string;
  reportVersion: "Original" | "Amended"; reportVersionCode: "RPTFLD" | "RPTAMD";
  reportType: string; reportTypeCode: string; filingEntityId: number;
  filerRegistrationGuid: string; committeeType: string; committeeTypeCode: string;
  officeSought: string; officeSoughtId: number; jurisdiction: string; jurisdictionId: number;
  reportingCycle: string; reportingCycleId: number; reportingYear: number;
  startDate: string; endDate: string; dueDate: string; filedDate: string;
  zeroActivity: boolean; hasChild: boolean;
  childResults: readonly MarylandPublishedReportChild[] | null;
}>;

export function decodeMarylandPublishedReport(raw: unknown, request: MarylandPublicReportInventoryRequest): MarylandPublishedReport {
  if (!record(raw)) return fail();
  const r = raw;
  if (!guid(r.reportGuid) || !positiveInteger(r.reportVersionId) || !text(r.reportName) ||
    !((r.reportVersion === "Original" && r.reportVersionCode === "RPTFLD") ||
      (r.reportVersion === "Amended" && r.reportVersionCode === "RPTAMD")) ||
    !positiveInteger(r.filingEntityId) || !guid(r.filerRegistrationGuid) ||
    r.filerRegistrationGuid.toLowerCase() !== request.filerRegistrationGuid.toLowerCase() ||
    !positiveInteger(r.reportingCycleId) || String(r.reportingCycleId) !== request.electionCycleId ||
    !positiveInteger(r.officeSoughtId) || !positiveInteger(r.jurisdictionId) ||
    !positiveInteger(r.reportingYear) || r.reportingYear > 9999 ||
    ![r.reportType, r.reportTypeCode, r.committeeType, r.committeeTypeCode,
      r.officeSought, r.jurisdiction, r.reportingCycle].every(text) ||
    !localDateTime(r.startDate, true) || !localDateTime(r.endDate, true) ||
    r.startDate > r.endDate || !localDateTime(r.dueDate, true) || !localDateTime(r.filedDate) ||
    typeof r.zeroActivity !== "boolean" || typeof r.hasChild !== "boolean") return fail();
  let children: readonly MarylandPublishedReportChild[] | null = null;
  if (r.childResults !== null) {
    if (!Array.isArray(r.childResults) || !r.childResults.length || r.childResults.length > 1_000) return fail();
    const seen = new Set<string>();
    children = Object.freeze(r.childResults.map((child: unknown) => {
      if (!record(child) || !guid(child.filerReportGuid) || !positiveInteger(child.filerReportVersionID) ||
        child.totalRows !== (r.childResults as unknown[]).length ||
        ![child.reportName, child.reportType, child.generateStatus, child.generateStatusCode, child.reportStatus].every(text) ||
        !localDateTime(child.startDate, true) || !localDateTime(child.endDate, true) ||
        child.startDate > child.endDate || !localDateTime(child.dueDate, true) || !localDateTime(child.filedDate) ||
        typeof child.isCompleted !== "boolean" || typeof child.isPaperFile !== "boolean") return fail();
      const key = `${child.filerReportGuid.toLowerCase()}:${child.filerReportVersionID}`;
      if (seen.has(key)) return fail();
      seen.add(key);
      return Object.freeze({ filerReportGuid: child.filerReportGuid, filerReportVersionID: child.filerReportVersionID,
        totalRows: child.totalRows as number, reportName: child.reportName as string, reportType: child.reportType as string,
        startDate: child.startDate, endDate: child.endDate, dueDate: child.dueDate, filedDate: child.filedDate,
        isCompleted: child.isCompleted, isPaperFile: child.isPaperFile,
        generateStatus: child.generateStatus as string, generateStatusCode: child.generateStatusCode as string,
        reportStatus: child.reportStatus as string });
    }));
  }
  if (r.hasChild !== (children !== null) || (r.reportVersion === "Amended") !== (children !== null) ||
    (r.reportVersion === "Original" && Object.hasOwn(r, "filerReportVersionID"))) return fail();
  if (children) {
    const matches = children.filter(c => c.filerReportGuid.toLowerCase() === (r.reportGuid as string).toLowerCase() &&
      c.filerReportVersionID === r.reportVersionId);
    if (matches.length !== 1) return fail();
    const current = matches[0]!;
    // Parent and child intentionally use different published type labels.
    if (current.reportName !== r.reportName ||
      current.startDate !== r.startDate || current.endDate !== r.endDate || current.dueDate !== r.dueDate ||
      current.filedDate !== r.filedDate) return fail();
  }
  // Explicit projection excludes creator, IP, file path and unknown extras.
  return Object.freeze({ reportGuid: r.reportGuid, reportVersionId: r.reportVersionId, reportName: r.reportName,
    reportVersion: r.reportVersion as "Original" | "Amended", reportVersionCode: r.reportVersionCode as "RPTFLD" | "RPTAMD",
    reportType: r.reportType as string, reportTypeCode: r.reportTypeCode as string, filingEntityId: r.filingEntityId,
    filerRegistrationGuid: r.filerRegistrationGuid, committeeType: r.committeeType as string, committeeTypeCode: r.committeeTypeCode as string,
    officeSought: r.officeSought as string, officeSoughtId: r.officeSoughtId, jurisdiction: r.jurisdiction as string,
    jurisdictionId: r.jurisdictionId, reportingCycle: r.reportingCycle as string, reportingCycleId: r.reportingCycleId,
    reportingYear: r.reportingYear, startDate: r.startDate, endDate: r.endDate, dueDate: r.dueDate, filedDate: r.filedDate,
    zeroActivity: r.zeroActivity, hasChild: r.hasChild, childResults: children });
}

/** Structural acquisition only; no money, currentness or canonical authority. */
export function decodeMarylandPublicReportInventory(value: unknown, request: MarylandPublicReportInventoryRequest) {
  if (!record(value) || value.succeeded !== true || value.error !== null || !record(value.data)) return fail();
  const data = value.data;
  if (!Number.isSafeInteger(data.totalItems) || (data.totalItems as number) < 0 || !Array.isArray(data.items)) return fail();
  const offset = (request.pageNumber - 1) * request.pageSize;
  if (!Number.isSafeInteger(offset) || data.items.length !== Math.min(request.pageSize, Math.max(0, (data.totalItems as number) - offset))) return fail();
  const reports = Object.freeze(data.items.map(raw => decodeMarylandPublishedReport(raw, request)));
  if (new Set(reports.map(r => r.reportGuid.toLowerCase())).size !== reports.length) return fail();
  return Object.freeze({ reports, totalItems: data.totalItems as number });
}

export type MarylandPublishedReportPdfRequest = Readonly<{ documentGuid: string; fileName: string; openInNewTab: true }>;
/** Association follows the publisher's GUID/version equality, never maximum
 * version, array order, filePath or generation status. No extension is added. */
export function buildMarylandPublishedReportPdfRequest(report: MarylandPublishedReport): MarylandPublishedReportPdfRequest {
  if (!record(report)) return fail();
  const request = buildMarylandPublicReportInventoryRequest({ filerRegistrationGuid: report.filerRegistrationGuid,
    electionCycleId: String(report.reportingCycleId), pageNumber: 1 });
  const parent = decodeMarylandPublishedReport(report, request);
  const child = parent.childResults?.find(c => c.filerReportGuid.toLowerCase() === parent.reportGuid.toLowerCase() &&
    c.filerReportVersionID === parent.reportVersionId);
  // The observed Original parent lacks filerReportVersionID; its literal public
  // handler sends Vundefined. This is presentation, not a version assertion.
  return validateMarylandPublishedReportPdfRequest({ documentGuid: child?.filerReportGuid ?? parent.reportGuid,
    fileName: `${parent.reportName} V${child?.filerReportVersionID ?? "undefined"}`, openInNewTab: true });
}
/** Validates the published three-field download body; filename is presentation. */
export function validateMarylandPublishedReportPdfRequest(value: MarylandPublishedReportPdfRequest): MarylandPublishedReportPdfRequest {
  if (!record(value) || Reflect.ownKeys(value).length !== 3 ||
    !guid(value.documentGuid) || !text(value.fileName) || value.openInNewTab !== true ||
    Reflect.ownKeys(value).some(k => typeof k !== "string" || !["documentGuid", "fileName", "openInNewTab"].includes(k)))
    throw new MarylandCurrentCycleExportError("invalid_request");
  return Object.freeze({ documentGuid: value.documentGuid, fileName: value.fileName, openInNewTab: true });
}

type InventoryCapture = MarylandCurrentCycleCapture<MarylandPublicReportInventoryRequest>;
type CaptureOptions<T> = { outputPath: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number;
  onCapture?: (capture: MarylandCurrentCycleCapture<T>) => void | Promise<void> };
async function verifiedOriginal(capture: MarylandCurrentCycleCapture<unknown>) {
  const raw = await readFile(capture.outputPath);
  if (capture.httpStatus !== 200 || !capture.bodyComplete || capture.errorCode !== null || raw.length !== capture.byteCount ||
    createHash("sha256").update(raw).digest("hex") !== capture.sha256) throw Error("original_integrity");
  return raw;
}

/** Complete requested paging; result exposes aggregate facts and raw refs only. */
export async function fetchMarylandCurrentReportInventory(input: Omit<Scope, "pageNumber"> &
  Omit<CaptureOptions<MarylandPublicReportInventoryRequest>, "outputPath"> & { outputDirectory: string; maxPages?: number }) {
  const options = { ...input }, maxPages = options.maxPages ?? 100;
  const initial = buildMarylandPublicReportInventoryRequest({ ...options, pageNumber: 1 });
  if (!positiveInteger(maxPages) || maxPages > 100 || typeof options.outputDirectory !== "string" || !options.outputDirectory.trim())
    throw new MarylandCurrentCycleExportError("invalid_request");
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  if (((await stat(options.outputDirectory)).mode & 0o777) !== 0o700)
    throw new MarylandCurrentCycleExportError("output_error");
  const captures: Omit<InventoryCapture, "requestBody">[] = [], seen = new Set<string>(), lineage = new Set<string>();
  let totalItems: number | undefined, childCount = 0;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const request = buildMarylandPublicReportInventoryRequest({ ...initial, pageNumber });
    const capture = await captureMarylandPublicReportInventoryPost(request,
      { ...options, outputPath: join(options.outputDirectory, `page-${String(pageNumber).padStart(3, "0")}.original.json`) });
    try {
      const raw = await verifiedOriginal(capture);
      const page = decodeMarylandPublicReportInventory(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), request);
      if (totalItems !== undefined && totalItems !== page.totalItems) return fail();
      totalItems = page.totalItems;
      if (Math.ceil(totalItems / initial.pageSize) > maxPages) return fail();
      for (const report of page.reports) {
        const key = report.reportGuid.toLowerCase();
        if (seen.has(key)) return fail();
        seen.add(key); childCount += report.childResults?.length ?? 0;
        const editions = new Set([`${key}:${report.reportVersionId}`,
          ...(report.childResults ?? []).map(c => `${c.filerReportGuid.toLowerCase()}:${c.filerReportVersionID}`)]);
        for (const edition of editions) {
          if (lineage.has(edition)) return fail();
          lineage.add(edition);
        }
      }
      const { requestBody: _privateScope, ...metadata } = capture;
      captures.push(Object.freeze(metadata));
      if (seen.size === totalItems) return Object.freeze({ captures: Object.freeze(captures), totalItems,
        physicalCount: seen.size, childCount });
    } catch { throw new MarylandCurrentCycleExportError("invalid_report_inventory", capture); }
  }
  return fail();
}

/** Reopens the complete original inventory journal without making a request.
 * Private report metadata establishes source structure, not currentness or
 * financial authority. Do not serialize privateReports into ordinary logs. */
export async function readMarylandCurrentReportInventory(input: Omit<Scope,"pageNumber"> & {
  outputDirectory:string;
}) {
  try {
  const initial=buildMarylandPublicReportInventoryRequest({...input,pageNumber:1});
  if(typeof input.outputDirectory!=="string" || !input.outputDirectory.trim()) return fail();
  const directory=resolve(input.outputDirectory),journalPath=join(directory,"captures.private.jsonl");
  const privateFile=async(path:string,maximum:number)=>{
    const info=await lstat(path);
    if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o777)!==0o600 || info.size<1 || info.size>maximum) return fail();
    return readFile(path);
  };
  const directoryInfo=await lstat(directory);
  if(!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode&0o777)!==0o700) return fail();
  const lines=new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(journalPath,1024*1024));
  if(!lines.endsWith("\n") || lines.includes("\r")) return fail();
  const entries=lines.slice(0,-1).split("\n");
  if(entries.length<1 || entries.length>100 || entries.some(line=>!line)) return fail();
  const expectedFiles=new Set(["captures.private.jsonl"]),seen=new Set<string>(),lineage=new Set<string>();
  const reports:MarylandPublishedReport[]=[],captures:Omit<InventoryCapture,"requestBody">[]=[];
  const keys=["url","method","requestBody","outputPath","startedAt","completedAt","httpStatus","byteCount","sha256","bodyComplete","errorCode"];
  const timestamp=(value:unknown):value is string=>typeof value==="string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
  const json=(value:string):unknown=>{try{return JSON.parse(value);}catch{return fail();}};
  let totalItems:number|undefined,childCount=0,previousCompletedAt:string|undefined,capturedBytes=0;
  for(let index=0;index<entries.length;index++){
    const entry=json(entries[index]!);
    if(!record(entry) || Object.keys(entry).length!==keys.length || keys.some(key=>!Object.hasOwn(entry,key))) return fail();
    const request=buildMarylandPublicReportInventoryRequest({...initial,pageNumber:index+1});
    const retainedRequest=entry.requestBody;
    if(!record(retainedRequest) || Object.keys(retainedRequest).length!==Object.keys(request).length ||
      Object.entries(request).some(([key,value])=>retainedRequest[key]!==value)) return fail();
    const filename=`page-${String(index+1).padStart(3,"0")}.original.json`,path=join(directory,filename);
    expectedFiles.add(filename);
    if(entry.url!=="https://api-campaignfinance.maryland.gov/api/PublicFilerDetails/GetCfPublicProfileFiling" ||
      entry.method!=="POST" || entry.outputPath!==path || entry.httpStatus!==200 || entry.bodyComplete!==true || entry.errorCode!==null ||
      !timestamp(entry.startedAt) || !timestamp(entry.completedAt) || entry.completedAt<entry.startedAt ||
      (previousCompletedAt!==undefined && entry.startedAt<previousCompletedAt) ||
      !positiveInteger(entry.byteCount) || entry.byteCount>4*1024*1024 || typeof entry.sha256!=="string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) return fail();
    const raw=await privateFile(path,4*1024*1024);
    if(raw.byteLength!==entry.byteCount || createHash("sha256").update(raw).digest("hex")!==entry.sha256) return fail();
    const page=decodeMarylandPublicReportInventory(json(new TextDecoder("utf-8",{fatal:true}).decode(raw)),request);
    if(totalItems!==undefined && page.totalItems!==totalItems) return fail();
    totalItems=page.totalItems;
    if(entries.length!==Math.max(1,Math.ceil(totalItems/initial.pageSize))) return fail();
    for(const report of page.reports){
      const parent=report.reportGuid.toLowerCase();if(seen.has(parent)) return fail();seen.add(parent);
      const editions=new Set([`${parent}:${report.reportVersionId}`,...(report.childResults??[]).map(c=>`${c.filerReportGuid.toLowerCase()}:${c.filerReportVersionID}`)]);
      for(const edition of editions){if(lineage.has(edition)) return fail();lineage.add(edition);}
      childCount+=report.childResults?.length??0;reports.push(report);
    }
    const {requestBody:_privateScope,...metadata}=entry as InventoryCapture;
    captures.push(Object.freeze(metadata));previousCompletedAt=entry.completedAt;capturedBytes+=raw.byteLength;
  }
  const files=await readdir(directory);
  if(files.length!==expectedFiles.size || files.some(file=>!expectedFiles.has(file)) || reports.length!==totalItems) return fail();
  return Object.freeze({sourceFacts:Object.freeze({totalItems,physicalCount:reports.length,childCount,capturedBytes,
    startedAt:captures[0]!.startedAt,completedAt:captures.at(-1)!.completedAt}),
    captures:Object.freeze(captures),privateReports:Object.freeze(reports)});
  } catch {
    // Cache failures must not expose private paths, malformed source fragments
    // or underlying decoder/filesystem errors to ordinary sync logs.
    return fail();
  }
}

/** Private original-byte download, never a PDF text or donor derivative. */
export async function fetchMarylandPublishedReportPdf(input: CaptureOptions<MarylandPublishedReportPdfRequest> &
  { request: MarylandPublishedReportPdfRequest }) {
  const capture = await captureMarylandPublishedReportPdfPost(input.request, input);
  try {
    const raw = await verifiedOriginal(capture);
    if (raw.length < 8 || raw.subarray(0, 5).toString("ascii") !== "%PDF-") throw Error("not_pdf");
    const { requestBody: _privateScope, ...metadata } = capture;
    return Object.freeze({ capture: Object.freeze(metadata) });
  } catch { throw new MarylandCurrentCycleExportError("invalid_report_document", capture); }
}

import { parseMarylandCfsMoney } from "./marylandCfsArtifactReader.js";
import { marylandPublicContributionOccurrenceKey } from "./marylandPublicContributionClient.js";
import type { MarylandPdfReceiptOccurrence } from "./marylandReportPdfGeometry.js";
import type { bindMarylandNativeReportOccurrences } from "./marylandNativeReportBinding.js";
import type { MarylandLegacyReceiptOccurrence, readMarylandLegacyReceiptObservations } from "./marylandLegacyReportPdfParser.js";
import type { MarylandLegacyFinancialControls } from "./marylandLegacyReportFinancialControls.js";
import type { MarylandModernFinancialControls } from "./marylandReportFinancialControls.js";
import {projectMarylandLegacyNativeFullAddress,type MarylandSourceStateDisplayDictionary} from "./marylandSourceStateDisplay.js";

export class MarylandReceiptComparisonError extends Error {
  constructor(public readonly code: "invalid_native" | "invalid_pdf" | "duplicate_native" |
    "duplicate_pdf" | "unsafe_total" | "invalid_legacy" | "unknown_class" |
    "ambiguous_continuation" | "ambiguous_identity") { super(`Maryland receipt comparison: ${code}`); }
}
function fail(code: ConstructorParameters<typeof MarylandReceiptComparisonError>[0]): never {
  throw new MarylandReceiptComparisonError(code);
}
const guid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number)>0;
const normalize = (value: string) => value.trim().replace(/\s+/g," ").toLowerCase();
function calendarDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number(value.slice(0,4))>=1900 && Number(value.slice(0,4))<=2100 &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
}
function add(left: number, right: number) {
  const total=left+right; if (!Number.isSafeInteger(total)) fail("unsafe_total"); return total;
}
function nativeAddress(row: Readonly<Record<string,unknown>>) {
  const value=normalize(row.contributorFullAddress as string|null ?? "");
  const zip=(row.contributorZipCode as string|null ?? "").trim();
  const match=/(\d{5})\s*-\s*(\d{4})$/.exec(value);
  // The separate raw source ZIP must confirm every digit and the hyphen.
  // Street punctuation, locality, unit, ZIP5-only values and name order remain
  // literal; this is only assembly of a terminal printed/wrapped ZIP+4.
  return match && /^\d{5}-\d{4}$/.test(zip) && `${match[1]}-${match[2]}`===zip
    ? value.slice(0,match.index)+zip : value;
}

/** Whole supplied occurrence comparison facts, with multiplicity. This pure
 * function does not select editions or a subset, prove acquisition completeness,
 * establish anonymous itemization, or grant financial/publication authority.
 * Report inventory, complete collection scopes and PDF controls qualify outside
 * this primitive. Identity strings exist only in transient comparison maps;
 * the result contains aggregate counts and cents, never names or selectors. */
export function compareMarylandReceiptOccurrences(input: {
  nativeRows: readonly Readonly<Record<string,unknown>>[];
  pdfRows: readonly MarylandPdfReceiptOccurrence[];
}) {
  const expected=new Map<string,number>(), actual=new Map<string,number>();
  const confirmedPostalKeys=new Map<string,number>();
  const sourceIdentities=new Set<string>(), physicalIdentities=new Set<string>();
  const counts={nativeGifts:0,nativeReturns:0,pdfGifts:0,pdfReturns:0,
    nativeGiftCents:0,nativeReturnCents:0,pdfGiftCents:0,pdfReturnCents:0,
    anonymousOccurrences:0,anonymousCents:0,literalPostalLayoutAssemblies:0};
  function key(role: string,kind: string,date: string,cents: number,name: string) {
    return JSON.stringify([role,kind,date,cents,name]);
  }
  function occurrence(map: Map<string,number>, identity: string) {
    map.set(identity,(map.get(identity)??0)+1);
  }
  for (const row of input.nativeRows) {
    const dollars=typeof row.transactionAmount === "number" && Number.isFinite(row.transactionAmount)
      ? parseMarylandCfsMoney(String(row.transactionAmount)) : null;
    if (!guid(row.transactionGuid) || !positive(row.transactionVersionID) || !guid(row.reportGuid) ||
      !positive(row.reportVersionId) || typeof row.isReturn!=="boolean" ||
      row.transactionTypeCode!==(row.isReturn?"TRCON":"TCON") || dollars===null || dollars<=0 ||
      typeof row.transactionDate!=="string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.transactionDate) ||
      !calendarDate(row.transactionDate.slice(0,10))) fail("invalid_native");
    const identity=marylandPublicContributionOccurrenceKey(row);
    if (sourceIdentities.has(identity)) fail("duplicate_native");sourceIdentities.add(identity);
    const cents=Math.round(dollars*100);
    if (row.contributionTypeCode==="ANYMS") {
      // The actual anonymous aggregate displays "Anonymous" in the name
      // column, equal to its published mechanism label, with no donor class
      // or address. It is a display descriptor, not an itemized named donor.
      const descriptor=row.contributorName==="Anonymous" && row.contributionType==="Anonymous" &&
        row.contributorTypeCode===null && row.contributorFullAddress===null;
      if (row.isReturn || (row.contributorName!==null && row.contributorName!=="" && !descriptor)) fail("invalid_native");
      counts.anonymousOccurrences++;counts.anonymousCents=add(counts.anonymousCents,cents);continue;
    }
    if (typeof row.contributorName!=="string" || !row.contributorName.trim() ||
      !["CMONT","TRFR","OTHRINCM","CINKIND"].includes(row.contributionTypeCode as string) ||
      (row.contributorFullAddress!==null && typeof row.contributorFullAddress!=="string") ||
      (row.contributorZipCode!==null && typeof row.contributorZipCode!=="string")) fail("invalid_native");
    const role=row.isReturn?"return":"gift";
    const kind=row.isReturn && row.contributionTypeCode==="TRFR"?"transfer":row.contributionTypeCode==="CINKIND"?"in_kind":"cash";
    let name=normalize(`${row.contributorName} ${nativeAddress(row)}`);
    const postal=normalize(row.contributorZipCode as string|null ?? "");
    const terminal=/(\d{5})\s*-\s*([a-z]{4})$/.exec(name);
    // The actual publisher also supplies a nonstandard four-letter postal
    // suffix. Preserve its literal characters. Only the independently
    // published raw postal field can license hyphen-adjacent layout assembly.
    if (terminal && /^\d{5}-[a-z]{4}$/.test(postal) && `${terminal[1]}-${terminal[2]}`===postal) {
      name=name.slice(0,terminal.index)+postal;
      const identity=key(role,kind,row.transactionDate.slice(0,10),cents,name);
      confirmedPostalKeys.set(identity,(confirmedPostalKeys.get(identity)??0)+1);
    }
    occurrence(expected,key(role,kind,row.transactionDate.slice(0,10),cents,name));
    if (row.isReturn) {counts.nativeReturns++;counts.nativeReturnCents=add(counts.nativeReturnCents,cents);}
    else {counts.nativeGifts++;counts.nativeGiftCents=add(counts.nativeGiftCents,cents);}
  }
  for (const row of input.pdfRows) {
    if (!positive(row.pageNumber) || !Number.isSafeInteger(row.ordinal) || row.ordinal<0 ||
      !calendarDate(row.date) || !positive(row.amountCents) || typeof row.nameAddress!=="string" ||
      !row.nameAddress.trim() || !["gift_monetary","gift_in_kind","return_monetary","return_transfer","return_in_kind"].includes(row.schedule) ||
      row.role!==(row.schedule.startsWith("return")?"return":"gift")) fail("invalid_pdf");
    const identity=`${row.pageNumber}:${row.ordinal}`;
    if (physicalIdentities.has(identity)) fail("duplicate_pdf");physicalIdentities.add(identity);
    const kind=row.schedule==="return_transfer"?"transfer":row.schedule.endsWith("in_kind")?"in_kind":"cash";
    let name=normalize(row.nameAddress);
    const terminal=/(\d{5})\s*-\s*([a-z]{4})$/.exec(name);
    if (terminal) {
      const assembled=name.slice(0,terminal.index)+`${terminal[1]}-${terminal[2]}`;
      const identity=key(row.role,kind,row.date,row.amountCents,assembled);
      const available=confirmedPostalKeys.get(identity)??0;
      if (name!==assembled && available>0) {
        name=assembled;confirmedPostalKeys.set(identity,available-1);counts.literalPostalLayoutAssemblies++;
      }
    }
    occurrence(actual,key(row.role,kind,row.date,row.amountCents,name));
    if (row.role==="return") {counts.pdfReturns++;counts.pdfReturnCents=add(counts.pdfReturnCents,row.amountCents);}
    else {counts.pdfGifts++;counts.pdfGiftCents=add(counts.pdfGiftCents,row.amountCents);}
  }
  let matchedIdentityOccurrences=0,missingIdentityOccurrences=0,extraIdentityOccurrences=0;
  for (const [key,count] of expected) {
    const observed=actual.get(key)??0;matchedIdentityOccurrences+=Math.min(count,observed);
    missingIdentityOccurrences+=Math.max(0,count-observed);
  }
  for (const [key,count] of actual) extraIdentityOccurrences+=Math.max(0,count-(expected.get(key)??0));
  return {...counts,matchedIdentityOccurrences,missingIdentityOccurrences,extraIdentityOccurrences};
}

const legacyClasses = new Set(["TBSN", "TCC", "TFED", "TIND", "TLAB", "TNPO", "TPAC", "TPCC", "TPCLB", "TPOC", "TRNFC", "TSLATE", "TSPDC", "TUNFC"]);
const legacyCommitteeClasses = new Set(["TCC", "TFED", "TPAC", "TPCC", "TPCLB", "TPOC", "TRNFC", "TSLATE", "TUNFC"]);
type BoundReport = ReturnType<typeof bindMarylandNativeReportOccurrences>["reports"][number];
type LegacyObservations = Awaited<ReturnType<typeof readMarylandLegacyReceiptObservations>>;
type LegacyFamily = "monetary" | "in_kind" | "other_receipts" | "anonymous";

/** Complete supplied modern report facts. The caller must derive the physical
 * receipt extent from the whole original document and bind actual native
 * report membership. Only exact whole-contact occurrences project classes;
 * an eligible cash/other or cross-class identity collision remains held. */
export function compareMarylandModernCommitteeReceiptOccurrences(input:{
  boundReport:BoundReport;pdfRows:readonly MarylandPdfReceiptOccurrence[];controls:MarylandModernFinancialControls;
}) {
  const nativeRows=input.boundReport.rows;
  for(const r of nativeRows) {
    if(typeof r.isReturn!=="boolean" || r.transactionTypeCode!==(r.isReturn?"TRCON":"TCON") ||
      !["CMONT","TRFR","OTHRINCM","CINKIND","ANYMS"].includes(r.contributionTypeCode as string))fail("invalid_native");
    if(r.contributorTypeCode===null?r.contributionTypeCode!=="ANYMS":
      typeof r.contributorTypeCode!=="string" || !legacyClasses.has(r.contributorTypeCode))fail("unknown_class");
    if(r.contributionTypeCode==="ANYMS" && r.contributorTypeCode!==null)fail("unknown_class");
  }
  const gifts=nativeRows.filter(r=>!r.isReturn),pdfGifts=input.pdfRows.filter(r=>r.role==="gift");
  const giftComparison=compareMarylandReceiptOccurrences({nativeRows:gifts,pdfRows:pdfGifts});
  const cashNative=gifts.filter(r=>r.contributionTypeCode!=="CINKIND"),cashPdf=pdfGifts.filter(r=>r.schedule==="gift_monetary");
  const cashComparison=compareMarylandReceiptOccurrences({nativeRows:cashNative,pdfRows:cashPdf});
  const inKindComparison=compareMarylandReceiptOccurrences({nativeRows:gifts.filter(r=>r.contributionTypeCode==="CINKIND"),pdfRows:pdfGifts.filter(r=>r.schedule==="gift_in_kind")});
  const eligible=(r:Readonly<Record<string,unknown>>)=>legacyCommitteeClasses.has(r.contributorTypeCode as string);
  const cash=(r:Readonly<Record<string,unknown>>)=>["CMONT","TRFR"].includes(r.contributionTypeCode as string);
  const fiscal=(date:string,cents:number)=>JSON.stringify([date,cents]);
  const identity=(date:string,cents:number,name:string)=>JSON.stringify([date,cents,name]);
  const groups=new Map<string,{classes:Set<string>;cash:boolean;other:boolean}>(),eligibleFiscal=new Set<string>(),eligibleOtherFiscal=new Set<string>();
  const confirmedPostal=new Set<string>();
  for(const r of cashNative) {
    if(r.contributionTypeCode==="ANYMS")continue;
    const date=(r.transactionDate as string).slice(0,10),cents=Math.round((r.transactionAmount as number)*100);
    let name=normalize(`${r.contributorName} ${nativeAddress(r)}`);
    const postal=normalize(r.contributorZipCode as string|null??""),terminal=/(\d{5})\s*-\s*([a-z]{4})$/.exec(name);
    if(terminal && /^\d{5}-[a-z]{4}$/.test(postal) && `${terminal[1]}-${terminal[2]}`===postal){name=name.slice(0,terminal.index)+postal;confirmedPostal.add(identity(date,cents,name));}
    const key=identity(date,cents,name),group=groups.get(key)??{classes:new Set<string>(),cash:false,other:false};
    group.classes.add(r.contributorTypeCode as string);group.cash ||=cash(r);group.other ||=r.contributionTypeCode==="OTHRINCM";groups.set(key,group);
    if(eligible(r)){if(cash(r))eligibleFiscal.add(fiscal(date,cents));else eligibleOtherFiscal.add(fiscal(date,cents));}
  }
  const eligibleCashPdf:MarylandPdfReceiptOccurrence[]=[],eligibleOtherPdf:MarylandPdfReceiptOccurrence[]=[];
  let unresolvedEligibleFiscalPdfOccurrences=0,unresolvedEligibleOtherFiscalPdfOccurrences=0;
  for(const r of cashPdf) {
    let name=normalize(r.nameAddress);const terminal=/(\d{5})\s*-\s*([a-z]{4})$/.exec(name);
    if(terminal){const assembled=name.slice(0,terminal.index)+`${terminal[1]}-${terminal[2]}`;if(confirmedPostal.has(identity(r.date,r.amountCents,assembled)))name=assembled;}
    const group=groups.get(identity(r.date,r.amountCents,name));
    if(!group){if(eligibleFiscal.has(fiscal(r.date,r.amountCents)))unresolvedEligibleFiscalPdfOccurrences++;
      if(eligibleOtherFiscal.has(fiscal(r.date,r.amountCents)))unresolvedEligibleOtherFiscalPdfOccurrences++;continue;}
    if(![...group.classes].some(c=>legacyCommitteeClasses.has(c)))continue;
    if(group.classes.size!==1 || (group.cash&&group.other))fail("ambiguous_identity");
    if(group.cash)eligibleCashPdf.push(r);else eligibleOtherPdf.push(r);
  }
  const eligibleGiftComparison=compareMarylandReceiptOccurrences({nativeRows:gifts.filter(r=>eligible(r)&&cash(r)),pdfRows:eligibleCashPdf});
  const eligibleOtherReceiptComparison=compareMarylandReceiptOccurrences({nativeRows:gifts.filter(r=>eligible(r)&&r.contributionTypeCode==="OTHRINCM"),pdfRows:eligibleOtherPdf});
  const control=(n:number)=>{const matches=input.controls.controls.filter(c=>c.number===n);if(matches.length!==1 || !Number.isSafeInteger(matches[0]!.amountCents))fail("invalid_pdf");return matches[0]!.amountCents;};
  if(input.controls.schema!=="modern_numbered_26" || input.controls.controls.length!==26)fail("invalid_pdf");
  const cashReceiptControlCents=control(1),anonymousControlCents=control(2),inKindControlCents=add(control(19),control(20));
  return {giftComparison,cashComparison,inKindComparison,eligibleGiftComparison,eligibleOtherReceiptComparison,
    unresolvedEligibleFiscalPdfOccurrences,unresolvedEligibleOtherFiscalPdfOccurrences,
    cashReceiptControlCents,cashReceiptOccurrenceCents:cashComparison.pdfGiftCents,
    cashReceiptDifferenceCents:add(cashComparison.pdfGiftCents,-cashReceiptControlCents),
    anonymousControlCents,anonymousOccurrenceCents:cashComparison.anonymousCents,
    anonymousDifferenceCents:add(cashComparison.anonymousCents,-anonymousControlCents),
    inKindControlCents,inKindOccurrenceCents:inKindComparison.pdfGiftCents,
    inKindDifferenceCents:add(inKindComparison.pdfGiftCents,-inKindControlCents)};
}

/** Whole source report projection only. The packet reader must produce the
 * actual bound report, receipt observations and controls from complete genuine
 * inputs. Structural types do not authenticate those inputs. Unknown physical
 * continuations exclude their entire fiscal cohort from identity claims only
 * after all native gifts in that cohort prove committee-class disjointness.
 * Family/day/cents counts and controls always retain those occurrences. Other
 * receipts remain separate. This grants no full-cash, currentness, legal donor
 * identity, financial acceptance or publication authority. */
export function compareMarylandLegacyCommitteeReceiptOccurrences(input: {
  boundReport: BoundReport;
  pdfRows: readonly MarylandLegacyReceiptOccurrence[];
  observations: LegacyObservations;
  controls: MarylandLegacyFinancialControls;
  stateDisplayDictionary?:MarylandSourceStateDisplayDictionary;
}) {
  const {boundReport, pdfRows, observations, controls} = input;
  const facts = observations.sourceFacts, unknown = observations.privateUnknownContinuations;
  const inKindRows=observations.privateInKindFinancialOccurrences,
    inKindUncertainty=observations.privateInKindDescriptionUncertainty,inKindTotals=observations.privateInKindScheduleTotals;
  if (!facts || facts.scope !== "published_receipts" || !positive(observations.pageCount) ||
    facts.pageCount !== observations.pageCount || !/^[0-9a-f]{64}$/.test(observations.sha256) || !positive(observations.byteCount) ||
    !Array.isArray(unknown) || facts.unclassifiedContinuationCount !== unknown.length || controls.schema !== "legacy_parts_3_4_5_6" ||
    facts.inKindIdentityScope!=="unavailable" || !Array.isArray(inKindRows) || !Array.isArray(inKindUncertainty) || !Array.isArray(inKindTotals) ||
    facts.inKindFinancialOccurrenceCount!==inKindRows.length || facts.inKindDescriptionUncertaintyCount!==inKindUncertainty.length) fail("invalid_legacy");
  let stateDisplayProjectionCount=0;
  const nativeRows = boundReport.rows.filter(r => {
    if (typeof r.isReturn !== "boolean" || r.transactionTypeCode !== (r.isReturn ? "TRCON" : "TCON")) fail("invalid_native");
    return !r.isReturn;
  }).map(r=>{const projected=input.stateDisplayDictionary?projectMarylandLegacyNativeFullAddress(r,input.stateDisplayDictionary):null;
    if(projected===null)return r;stateDisplayProjectionCount++;return {...r,contributorFullAddress:projected};});
  for (const r of nativeRows) {
    if (r.contributorTypeCode === null ? r.contributionTypeCode !== "ANYMS" :
      typeof r.contributorTypeCode !== "string" || !legacyClasses.has(r.contributorTypeCode)) fail("unknown_class");
    if (r.contributionTypeCode === "ANYMS" && r.contributorTypeCode !== null) fail("unknown_class");
  }
  // Every source class and financial occurrence is validated before monetary
  // identity selection. In-kind identities are unavailable across all classes.
  const nativeIdentities=new Set<string>();
  for(const r of nativeRows) {
    const dollars=typeof r.transactionAmount==="number" && Number.isFinite(r.transactionAmount)?parseMarylandCfsMoney(String(r.transactionAmount)):null;
    if(!guid(r.transactionGuid) || !positive(r.transactionVersionID) || !guid(r.reportGuid) || !positive(r.reportVersionId) ||
      dollars===null || dollars<=0 || !["CMONT","TRFR","OTHRINCM","CINKIND","ANYMS"].includes(r.contributionTypeCode as string) ||
      typeof r.transactionDate!=="string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(r.transactionDate) || !calendarDate(r.transactionDate.slice(0,10)))fail("invalid_native");
    const key=marylandPublicContributionOccurrenceKey(r);if(nativeIdentities.has(key))fail("duplicate_native");nativeIdentities.add(key);
  }
  const wholeNative = compareMarylandReceiptOccurrences({nativeRows:nativeRows.filter(r=>r.contributionTypeCode!=="CINKIND"), pdfRows: []});
  const cents = (r: Readonly<Record<string, unknown>>) => Math.round((r.transactionAmount as number) * 100);
  const day = (r: Readonly<Record<string, unknown>>) => (r.transactionDate as string).slice(0, 10);
  const fiscalKey = (date: string, amount: number) => JSON.stringify([date, amount]);
  const nativeFamily = (r: Readonly<Record<string, unknown>>): LegacyFamily => r.contributionTypeCode === "CINKIND" ? "in_kind" :
    r.contributionTypeCode === "OTHRINCM" ? "other_receipts" : r.contributionTypeCode === "ANYMS" ? "anonymous" : "monetary";
  const pdfFamily = (r: MarylandLegacyReceiptOccurrence): LegacyFamily => r.tableKind === "in_kind" ? "in_kind" : r.tableKind === "other_receipts" ? "other_receipts" : "monetary";
  const eligible = (r: Readonly<Record<string, unknown>>) => legacyCommitteeClasses.has(r.contributorTypeCode as string);
  const nativeCohorts = new Map<string, typeof nativeRows>();
  for (const r of nativeRows) {const key = fiscalKey(day(r), cents(r)); const rows = nativeCohorts.get(key) ?? []; rows.push(r); nativeCohorts.set(key, rows);}
  const physical = new Map<string, MarylandLegacyReceiptOccurrence>();
  const sourceCounts = {contributions: 0, transfers_in: 0, other_receipts: 0, in_kind: 0};
  const sourceCents = {...sourceCounts};
  for (const r of pdfRows) {
    if (!positive(r.pageNumber) || r.pageNumber > observations.pageCount || !Number.isSafeInteger(r.ordinal) || r.ordinal < 0 ||
      !calendarDate(r.date) || !positive(r.amountCents) || !Object.hasOwn(sourceCounts, r.tableKind) || r.tableKind==="in_kind" ||
      r.role !== (r.tableKind === "other_receipts" ? "other" : "gift") || typeof r.nameAddress !== "string" || !r.nameAddress.trim() ||
      typeof r.sourceSection !== "string" || !r.sourceSection.trim() || typeof r.sourceCategory !== "string" || !r.sourceCategory.trim()) fail("invalid_pdf");
    const key = `${r.pageNumber}:${r.ordinal}`; if (physical.has(key)) fail("duplicate_pdf"); physical.set(key, r);
    sourceCounts[r.tableKind]++; sourceCents[r.tableKind] = add(sourceCents[r.tableKind], r.amountCents);
  }
  const inKindPhysical=new Set<string>();
  for(const r of inKindRows) {
    const key=`${r.pageNumber}:${r.top}:${r.bottom}`;
    if(!positive(r.pageNumber) || r.pageNumber>observations.pageCount || !Number.isSafeInteger(r.ordinal) || r.ordinal<0 ||
      !Number.isFinite(r.top) || !Number.isFinite(r.bottom) || r.top<75 || r.bottom>750 || r.top>=r.bottom ||
      r.tableKind!=="in_kind" || !calendarDate(r.date) || !Number.isSafeInteger(r.amountCents) || r.amountCents<0 ||
      !r.sourceSection || !r.sourceCategory || Object.hasOwn(r,"nameAddress") || inKindPhysical.has(key))fail("invalid_legacy");
    inKindPhysical.add(key);sourceCounts.in_kind++;sourceCents.in_kind=add(sourceCents.in_kind,r.amountCents);
  }
  for(const u of inKindUncertainty)if(!positive(u.pageNumber) || u.pageNumber>observations.pageCount ||
    !Number.isFinite(u.top) || !Number.isFinite(u.bottom) || u.top<75 || u.bottom>750 || u.top>=u.bottom || !positive(u.cellCount) ||
    !u.sourceSection || !u.sourceCategory || !["bounded_band","outside_closed_ledger"].includes(u.geometry) || Object.hasOwn(u,"parentPageNumber") || Object.hasOwn(u,"nameAddress"))fail("invalid_legacy");
  let totalInKindCents=0;
  for(const t of inKindTotals) {
    if(!positive(t.pageNumber) || t.pageNumber>observations.pageCount || !Number.isFinite(t.top) || !Number.isFinite(t.bottom) ||
      t.top<75 || t.bottom>750 || t.top>=t.bottom || !Number.isSafeInteger(t.amountCents) || t.amountCents<0)fail("invalid_legacy");
    totalInKindCents=add(totalInKindCents,t.amountCents);
  }
  if(totalInKindCents!==sourceCents.in_kind)fail("invalid_legacy");
  for (const kind of Object.keys(sourceCounts) as (keyof typeof sourceCounts)[]) {
    if (facts.counts[kind] !== sourceCounts[kind] || facts.totalsCents[kind] !== sourceCents[kind]) fail("invalid_legacy");
  }
  const held = new Set<string>(), unknownPhysical = new Set<string>();
  for (const u of unknown) {
    const parentKey = `${u.parentPageNumber}:${u.parentOrdinal}`, parent = physical.get(parentKey);
    if (!parent || !positive(u.pageNumber) || u.pageNumber > observations.pageCount || u.pageNumber <= u.parentPageNumber ||
      !Number.isFinite(u.top) || !Number.isFinite(u.bottom) || u.top >= u.bottom || !positive(u.cellCount) ||
      parent.date !== u.date || parent.amountCents !== u.amountCents || parent.tableKind !== u.tableKind ||
      parent.sourceSection !== u.sourceSection || parent.sourceCategory !== u.sourceCategory) fail("invalid_legacy");
    if (u.tableKind!=="contributions" || u.top < 75 || u.bottom > 750 ||
      pdfRows.some(r => r.pageNumber < u.pageNumber && (r.pageNumber > parent.pageNumber ||
        (r.pageNumber === parent.pageNumber && r.ordinal > parent.ordinal)))) fail("invalid_legacy");
    const reference = `${u.pageNumber}:${u.top}:${u.bottom}`; if (unknownPhysical.has(reference)) fail("invalid_legacy"); unknownPhysical.add(reference);
    const key = fiscalKey(parent.date, parent.amountCents), cohort = nativeCohorts.get(key);
    if (!cohort?.length || cohort.some(eligible)) fail("ambiguous_continuation");
    held.add(key);
  }
  const expected = new Map<string, number>(), actual = new Map<string, number>();
  const occurrence = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  // ANYMS is an opaque source aggregate, not an expected invented PDF item.
  // Legacy controls expose no separate printed anonymous control; that cash
  // comparison remains unevaluable whenever such an aggregate is present.
  for (const r of nativeRows) if (nativeFamily(r) !== "anonymous") occurrence(expected, JSON.stringify([nativeFamily(r), day(r), cents(r)]));
  for (const r of pdfRows) occurrence(actual, JSON.stringify([pdfFamily(r), r.date, r.amountCents]));
  for (const r of inKindRows) occurrence(actual, JSON.stringify(["in_kind",r.date,r.amountCents]));
  let matchedFiscalOccurrences = 0, missingFiscalOccurrences = 0, extraFiscalOccurrences = 0;
  for (const [key, n] of expected) {const observed = actual.get(key) ?? 0; matchedFiscalOccurrences += Math.min(n, observed); missingFiscalOccurrences += Math.max(0, n - observed);}
  for (const [key, n] of actual) extraFiscalOccurrences += Math.max(0, n - (expected.get(key) ?? 0));
  const knownNative = nativeRows.filter(r => !held.has(fiscalKey(day(r), cents(r))));
  const knownPdf = pdfRows.filter(r => !held.has(fiscalKey(r.date, r.amountCents)));
  const adapt = (r: MarylandLegacyReceiptOccurrence): MarylandPdfReceiptOccurrence => ({pageNumber: r.pageNumber, ordinal: r.ordinal,
    role: "gift", schedule: r.tableKind === "in_kind" ? "gift_in_kind" : "gift_monetary", date: r.date, amountCents: r.amountCents, nameAddress: r.nameAddress});
  const giftBase = compareMarylandReceiptOccurrences({nativeRows: knownNative.filter(r => !["other_receipts","in_kind"].includes(nativeFamily(r))), pdfRows: knownPdf.filter(r => r.tableKind !== "other_receipts").map(adapt)});
  const otherBase = compareMarylandReceiptOccurrences({nativeRows: knownNative.filter(r => nativeFamily(r) === "other_receipts"), pdfRows: knownPdf.filter(r => r.tableKind === "other_receipts").map(adapt)});
  const identityKey = (date: string, amount: number, text: string) => JSON.stringify([date, amount, text]);
  type IdentityRecord={row:typeof knownNative[number];family:LegacyFamily;group:string;contact:string|null;confirmedPostal:boolean;capacityKey:string;contactKey:string|null};
  const records:IdentityRecord[]=[],names=new Map<string,number[]>(),contacts=new Map<string,number[]>();
  const append=(index:Map<string,number[]>,key:string,value:number)=>{const values=index.get(key)??[];values.push(value);index.set(key,values);};
  for(const r of knownNative) {
    const family=nativeFamily(r);if(family==="anonymous" || family==="in_kind" || typeof r.contributorName!=="string" || !r.contributorName.trim())continue;
    const name=normalize(r.contributorName),group=JSON.stringify([r.contributorTypeCode,name,family]);
    let contact:string|null=null,confirmedPostal=false;
    if(typeof r.contributorFullAddress==="string" && r.contributorFullAddress.trim() &&
      (r.contributorZipCode===null || typeof r.contributorZipCode==="string")) {
      contact=normalize(`${r.contributorName} ${nativeAddress(r)}`);
      const postal=normalize(r.contributorZipCode as string|null??""),match=/(\d{5})\s*-\s*([a-z]{4})$/.exec(contact);
      if(match && /^\d{5}-[a-z]{4}$/.test(postal) && `${match[1]}-${match[2]}`===postal){contact=contact.slice(0,match.index)+postal;confirmedPostal=true;}
    }
    const capacityKey=JSON.stringify([day(r),cents(r),group]),contactKey=contact===null?null:JSON.stringify([capacityKey,contact]);
    const index=records.length;records.push({row:r,family,group,contact,confirmedPostal,capacityKey,contactKey});
    append(names,identityKey(day(r),cents(r),name),index);
    if(contact!==null)append(contacts,identityKey(day(r),cents(r),contact),index);
  }
  const eligiblePdf: MarylandLegacyReceiptOccurrence[] = [];
  let unresolvedEligibleFiscalPdfOccurrences = 0,unresolvedEligibleOtherFiscalPdfOccurrences=0;
  type SourceIdentity={row:MarylandLegacyReceiptOccurrence;key:string};
  const fullContactSources:SourceIdentity[]=[],wholeNameSources:SourceIdentity[]=[];
  for(const r of knownPdf) {
    const text=normalize(r.nameAddress),nameMatches=names.get(identityKey(r.date,r.amountCents,text))??[];
    const contactMatches=[...(contacts.get(identityKey(r.date,r.amountCents,text))??[])];
    const terminal=/(\d{5})\s*-\s*([a-z]{4})$/.exec(text);
    if(terminal){const compact=text.slice(0,terminal.index)+`${terminal[1]}-${terminal[2]}`;
      if(compact!==text)contactMatches.push(...(contacts.get(identityKey(r.date,r.amountCents,compact))??[]).filter(i=>records[i]!.confirmedPostal));}
    // Evaluate BOTH exact alternatives before allocating anything. Class alone
    // cannot resolve a complete name that equals another donor's full contact.
    const candidates=[...new Set([...nameMatches,...contactMatches])];
    if(new Set(candidates.map(i=>records[i]!.group)).size>1)fail("ambiguous_identity");
    const family=pdfFamily(r),sameFamily=candidates.filter(i=>records[i]!.family===family);
    if(!sameFamily.length){if(nativeCohorts.get(fiscalKey(r.date,r.amountCents))?.some(eligible)){
      if(family==="monetary")unresolvedEligibleFiscalPdfOccurrences++;else unresolvedEligibleOtherFiscalPdfOccurrences++;}continue;}
    if(eligible(records[sameFamily[0]!]!.row))eligiblePdf.push(r);
    const exactContacts=[...new Set(contactMatches)].filter(i=>records[i]!.family===family);
    if(exactContacts.length){const keys=new Set(exactContacts.map(i=>records[i]!.contactKey));
      if(keys.size!==1)fail("ambiguous_identity");fullContactSources.push({row:r,key:records[exactContacts[0]!]!.contactKey!});}
    else wholeNameSources.push({row:r,key:records[sameFamily[0]!]!.capacityKey});
  }
  // A field containing an address can consume only that exact contact's
  // physical capacity. Only an ENTIRE whole-name-only field may then consume
  // a remaining matching-name occurrence, never an unmatched contact field.
  const availableContacts=new Map<string,number[]>(),availableNames=new Map<string,number[]>(),used=new Set<number>();
  records.forEach((r,i)=>{if(!["monetary","other_receipts"].includes(r.family))return;
    append(availableNames,r.capacityKey,i);if(r.contactKey!==null)append(availableContacts,r.contactKey,i);});
  const matched={monetary:0,other_receipts:0,eligibleMonetary:0,eligibleOther:0};
  let fullContactIdentityMatches=0,wholeNameOnlyIdentityMatches=0;
  const allocate=(sources:SourceIdentity[],available:Map<string,number[]>,wholeName:boolean)=>{
    for(const source of sources){const capacity=available.get(source.key);while(capacity?.length && used.has(capacity.at(-1)!))capacity.pop();
      const index=capacity?.pop();if(index===undefined)continue;used.add(index);const record=records[index]!;
      if(record.family==="monetary"){matched.monetary++;if(eligible(record.row))matched.eligibleMonetary++;}
      else if(record.family==="other_receipts"){matched.other_receipts++;if(eligible(record.row))matched.eligibleOther++;}
      if(wholeName)wholeNameOnlyIdentityMatches++;else fullContactIdentityMatches++;}
  };
  allocate(fullContactSources,availableContacts,false);allocate(wholeNameSources,availableNames,true);
  const withAllocatedIdentities=(base:ReturnType<typeof compareMarylandReceiptOccurrences>,count:number)=>({...base,
    matchedIdentityOccurrences:count,missingIdentityOccurrences:base.nativeGifts-count,extraIdentityOccurrences:base.pdfGifts-count});
  const giftComparison=withAllocatedIdentities(giftBase,matched.monetary),otherReceiptComparison=withAllocatedIdentities(otherBase,matched.other_receipts);
  const eligibleNative = nativeRows.filter(eligible);
  const eligibleGiftComparison = withAllocatedIdentities(compareMarylandReceiptOccurrences({nativeRows: eligibleNative.filter(r => nativeFamily(r) === "monetary"), pdfRows: eligiblePdf.filter(r => r.tableKind !== "other_receipts").map(adapt)}),matched.eligibleMonetary);
  const eligibleOtherReceiptComparison = withAllocatedIdentities(compareMarylandReceiptOccurrences({nativeRows: eligibleNative.filter(r => nativeFamily(r) === "other_receipts"), pdfRows: eligiblePdf.filter(r => r.tableKind === "other_receipts").map(adapt)}),matched.eligibleOther);
  const cashControl = controls.receiptControls.filter(c => c.column !== "K").reduce((n, c) => add(n, c.amountCents), 0);
  const cashReceipts = add(add(sourceCents.contributions, sourceCents.transfers_in), sourceCents.other_receipts);
  return {nativeReportGifts: nativeRows.length, pdfReceiptOccurrences: pdfRows.length+inKindRows.length,stateDisplayProjectionCount,
    inKindIdentityScope:"unavailable" as const,inKindFinancialOccurrences:inKindRows.length,
    inKindDescriptionUncertaintyCount:inKindUncertainty.length,inKindScheduleTotalCents:totalInKindCents,
    itemizedNativeReceiptOccurrences: nativeRows.length - wholeNative.anonymousOccurrences,
    anonymousOccurrences: wholeNative.anonymousOccurrences, anonymousCents: wholeNative.anonymousCents,
    anonymousControlCents: controls.anonymousContributionsCents,
    uncontrolledAnonymousOccurrences: wholeNative.anonymousOccurrences, uncontrolledAnonymousCents: wholeNative.anonymousCents,
    sourceCounts, sourceCents, matchedFiscalOccurrences, missingFiscalOccurrences, extraFiscalOccurrences,
    unclassifiedContinuationCount: unknown.length, identityHeldFiscalCohorts: held.size,
    identityHeldNativeOccurrences: nativeRows.filter(r => held.has(fiscalKey(day(r), cents(r)))).length,
    identityHeldPdfOccurrences: pdfRows.filter(r => held.has(fiscalKey(r.date, r.amountCents))).length,
    unresolvedEligibleFiscalPdfOccurrences, unresolvedEligibleOtherFiscalPdfOccurrences,fullContactIdentityMatches,wholeNameOnlyIdentityMatches,
    giftComparison, otherReceiptComparison, eligibleGiftComparison, eligibleOtherReceiptComparison,
    cashReceiptControlCents: cashControl, cashReceiptOccurrenceCents: cashReceipts,
    cashReceiptDifferenceCents: wholeNative.anonymousOccurrences ? null : add(cashReceipts, -cashControl),
    inKindControlCents: controls.inKind.contributionsCents, inKindOccurrenceCents: sourceCents.in_kind,
    inKindDifferenceCents: add(sourceCents.in_kind, -controls.inKind.contributionsCents),
    loanReceiptControlCents: controls.receiptControls.filter(c => c.column === "K").reduce((n, c) => add(n, c.amountCents), 0)};
}

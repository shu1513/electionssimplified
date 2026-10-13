import { parseMarylandCfsMoney } from "./marylandCfsArtifactReader.js";
import { marylandPublicContributionOccurrenceKey } from "./marylandPublicContributionClient.js";
import type { MarylandPdfReceiptOccurrence } from "./marylandReportPdfGeometry.js";

export class MarylandReceiptComparisonError extends Error {
  constructor(public readonly code: "invalid_native" | "invalid_pdf" | "duplicate_native" |
    "duplicate_pdf" | "unsafe_total") { super(`Maryland receipt comparison: ${code}`); }
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

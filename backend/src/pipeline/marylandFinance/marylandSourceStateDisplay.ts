import {createHash} from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import {resolve} from "node:path";

export class MarylandSourceStateDisplayError extends Error {
  constructor(public readonly code:"invalid_capture"|"changed_original"|"dictionary"){super(`Maryland source state display: ${code}`);}
}
function fail(code:MarylandSourceStateDisplayError["code"]):never{throw new MarylandSourceStateDisplayError(code);}
const postalCodes=new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));

/** Decodes only the observed US map property schema, never executes source JS.
 * Every state/DC needs one consistent code/name/hc-key correspondence. */
export function decodeMarylandSourceStateDisplayDictionary(bytes:Uint8Array):Readonly<Record<string,string>> {
  if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>4*1024*1024)fail("dictionary");
  let source:string;try{source=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{fail("dictionary");}
  const labels=new Map<string,string>();
  for(const match of source!.matchAll(/properties:\{([^{}]{1,5000})\}/g)) {
    const text=match[1]!,postals=[...text.matchAll(/(?:"postal-code"|'postal-code')\s*:\s*["']([A-Z]{2})["']/g)];
    const names=[...text.matchAll(/(?:^|,)\s*(?:"name"|'name'|name)\s*:\s*["']([^"']+)["']/g)];
    const hcs=[...text.matchAll(/(?:"hc-key"|'hc-key')\s*:\s*["']us-([a-z]{2})["']/g)];
    if(!postals.length&&!hcs.length)continue;
    if(postals.length!==1||names.length!==1||hcs.length!==1||
      [...text.matchAll(/(?:"postal-code"|'postal-code')\s*:/g)].length!==1||
      [...text.matchAll(/(?:^|,)\s*(?:"name"|'name'|name)\s*:/g)].length!==1||
      [...text.matchAll(/(?:"hc-key"|'hc-key')\s*:/g)].length!==1)fail("dictionary");
    const postal=postals[0]!,name=names[0]!,hc=hcs[0]!;
    if(!postalCodes.has(postal[1]!)||hc[1]!==postal[1]!.toLowerCase()||
      !/^[A-Z][A-Za-z ]{2,30}$/.test(name[1]!)||name[1]!==name[1]!.trim())fail("dictionary");
    if(labels.has(postal[1]!)&&labels.get(postal[1]!)!==name[1])fail("dictionary");
    labels.set(postal[1]!,name[1]!);
  }
  if(labels.size!==51||[...postalCodes].some(code=>!labels.has(code))||new Set(labels.values()).size!==51)fail("dictionary");
  return Object.freeze(Object.fromEntries(labels));
}

/** Reopens the retained public static source and its original capture record.
 * No arbitrary replay map or caller success flag replaces those bytes. The
 * historical capture did not record EOF; none is invented here. */
export async function readMarylandSourceStateDisplayDictionary(input:{originalPath:string;captureJournalPath:string}) {
  try {
    const original=resolve(input.originalPath),journal=resolve(input.captureJournalPath);
    const [originalInfo,journalInfo]=await Promise.all([lstat(original),lstat(journal)]);
    if(!originalInfo.isFile()||originalInfo.isSymbolicLink()||originalInfo.size<1||originalInfo.size>4*1024*1024||
      !journalInfo.isFile()||journalInfo.isSymbolicLink()||journalInfo.size<1||journalInfo.size>10*1024*1024)fail("invalid_capture");
    const captures:unknown=JSON.parse(await readFile(journal,"utf8"));
    if(!Array.isArray(captures))fail("invalid_capture");
    const matches=captures.filter(c=>c&&typeof c==="object"&&c.rawPath===original);
    if(matches.length!==1)fail("invalid_capture");const capture=matches[0];
    const keys=["url","method","startedAt","completedAt","status","sha256","byteCount","rawPath"];
    if(Object.keys(capture).length!==keys.length||keys.some(k=>!Object.hasOwn(capture,k))||
      capture.url!=="https://campaignfinance.maryland.gov/chunk-G6IWTGO7.js"||capture.method!=="GET"||capture.status!==200||
      typeof capture.startedAt!=="string"||typeof capture.completedAt!=="string"||!Number.isFinite(Date.parse(capture.startedAt))||
      !Number.isFinite(Date.parse(capture.completedAt))||Date.parse(capture.completedAt)<Date.parse(capture.startedAt)||
      !Number.isSafeInteger(capture.byteCount)||capture.byteCount<1||typeof capture.sha256!=="string"||!/^[a-f0-9]{64}$/.test(capture.sha256))fail("invalid_capture");
    const bytes=await readFile(original),sha256=createHash("sha256").update(bytes).digest("hex");
    if(bytes.length!==capture.byteCount||sha256!==capture.sha256)fail("changed_original");
    const privateStateLabels=decodeMarylandSourceStateDisplayDictionary(bytes);
    return Object.freeze({sourceFacts:Object.freeze({sha256,byteCount:bytes.length,dictionaryEntries:Object.keys(privateStateLabels).length,
      originalStartedAt:capture.startedAt,originalCompletedAt:capture.completedAt}),privateStateLabels});
  }catch(error){if(error instanceof MarylandSourceStateDisplayError)throw error;return fail("invalid_capture");}
}
export type MarylandSourceStateDisplayDictionary=Awaited<ReturnType<typeof readMarylandSourceStateDisplayDictionary>>;

/** Changes only the exact terminal independently typed state + raw postal
 * component. Every other FullAddress character remains literal. Callers still
 * require equality of the complete printed name/address field. */
export function projectMarylandLegacyNativeFullAddress(row:Readonly<Record<string,unknown>>,dictionary:MarylandSourceStateDisplayDictionary):string|null {
  const {contributorState:code,contributorZipCode:zip,contributorFullAddress:raw}=row;
  if(typeof code!=="string"||!/^[A-Z]{2}$/.test(code)||typeof zip!=="string"||!zip||typeof raw!=="string")return null;
  const state=dictionary.privateStateLabels[code],suffix=` ${code} ${zip}`;
  if(!state||!raw.endsWith(suffix))return null;
  return raw.slice(0,-suffix.length)+` ${state} ${zip}`;
}

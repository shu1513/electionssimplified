import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, basename } from "node:path";
import { azHash, azHold, azIso, parseArizonaReportedJson } from "./arizonaReportedCore.js";

export const AZ_NATIVE_ORIGIN = "https://seethemoney.az.gov";
export type ArizonaOriginalCapture = {
  role: string; file: string; method: "GET" | "POST"; status: number; contentType: string | null;
  startedAt: string; completedAt: string; bytes: number; sha256: string; eof: boolean;
  declaredLength?: number | null; contentEncoding?: string | null;
};
export type ArizonaOriginal = { meta: ArizonaOriginalCapture; value: any };
export const azReportedCache = (cache?: string): string => resolve(cache ??
  process.env.ARIZONA_REPORTED_FINANCE_CACHE_DIR ?? "scratch/arizona-reported-finance");
const privateName = (path: string) => { if (basename(path).startsWith(".env")) azHold("private_path"); };
async function directory(path: string): Promise<void> {
  privateName(path);
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) azHold("private_original_directory");
}
async function privateBytes(path: string, max: number): Promise<Buffer> {
  privateName(path); const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.size > max) azHold("private_original");
  return readFile(path);
}
function validMeta(m: ArizonaOriginalCapture): boolean {
  return !!m && /^[a-z0-9_]{1,90}$/.test(m.role) && /^\d{4}\.original$/.test(m.file) &&
    ["GET", "POST"].includes(m.method) && m.status === 200 && m.eof === true &&
    !!m.contentType?.toLowerCase().includes("application/json") && azIso(m.startedAt) && azIso(m.completedAt) &&
    m.startedAt <= m.completedAt && Date.parse(m.completedAt) <= Date.now() + 300000 &&
    Number.isSafeInteger(m.bytes) && m.bytes > 0 && m.bytes <= 32 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(m.sha256) &&
    (!Object.hasOwn(m,"declaredLength") || m.declaredLength===null ||
      (Number.isSafeInteger(m.declaredLength) && m.declaredLength!>=0 && (!!m.contentEncoding || m.declaredLength===m.bytes)));
}
/** Only raw bodies and neutral capture metadata are persisted. Query selectors,
 * cookies and identities never become cache filenames or derived manifests. */
export async function savedArizonaOriginals(cache: string): Promise<ArizonaOriginal[]> {
  await mkdir(cache, { recursive: true, mode: 0o700 }); await directory(cache);
  const result: ArizonaOriginal[] = [];
  for (const name of (await readdir(cache)).filter(n => /^source-originals-[0-9a-f-]{36}$/.test(n))) {
    try {
      const path = resolve(cache, name); await directory(path);
      const records = (await privateBytes(resolve(path, "manifest.ndjson"), 2 * 1024 * 1024)).toString("utf8").trim().split("\n").map(x => JSON.parse(x));
      let previous = "";
      for (const [i,m] of records.entries()) {
        // Failed/partial responses are genuine originals but never authority.
        if (m.file !== String(i+1).padStart(4,"0")+".original" || !azIso(m.startedAt) || !azIso(m.completedAt) || m.startedAt < previous) break;
        previous = m.completedAt;
        if (!validMeta(m)) continue;
        const raw = await privateBytes(resolve(path, m.file), 32 * 1024 * 1024);
        if (raw.length !== m.bytes || azHash(raw) !== m.sha256) continue;
        result.push({ meta:m, value:parseArizonaReportedJson(new TextDecoder("utf-8",{fatal:true}).decode(raw)) });
      }
    } catch { /* An invalid saved directory cannot grant source authority. */ }
  }
  return result.sort((a,b)=>b.meta.completedAt.localeCompare(a.meta.completedAt));
}
export async function createArizonaOriginalCapture(cache: string) {
  await mkdir(cache, { recursive:true, mode:0o700 }); await directory(cache);
  const path = resolve(cache, `source-originals-${randomUUID()}`);
  await mkdir(path,{mode:0o700}); let count=0,total=0;
  async function capture(role: string, input: string, body: URLSearchParams): Promise<ArizonaOriginal> {
    if (!/^[a-z0-9_]{1,90}$/.test(role) || count >= 500) azHold("source_request_limit");
    const url = new URL(input);
    if (url.origin !== AZ_NATIVE_ORIGIN || url.username || url.password || url.hash ||
      !["/Reporting/AdvancedSearch/","/Reporting/ReportSearch/","/Reporting/GetDetailedInformation"].includes(url.pathname)) azHold("source_origin");
    const startedAt = new Date().toISOString();
    let response: Response;
    try { response = await fetch(url.href,{method:"POST",body,redirect:"error",credentials:"omit",
      headers:{Accept:"application/json","Content-Type":"application/x-www-form-urlencoded; charset=UTF-8","X-Requested-With":"XMLHttpRequest",
        "User-Agent":"Mozilla/5.0 VoteApp public campaign finance source sync"},signal:AbortSignal.timeout(45000)}); }
    catch { return azHold("source_unavailable"); }
    const chunks:Uint8Array[]=[],stream=response.body?.getReader(); let bytesRead=0,eof=false;
    try {
      if (!stream) azHold("source_body");
      while (true) { const next=await stream.read(); if(next.done){eof=true;break;}
        bytesRead+=next.value.byteLength;
        if(bytesRead>32*1024*1024 || total+bytesRead>256*1024*1024){await stream.cancel();azHold("source_byte_limit");}
        chunks.push(next.value);
      }
    } catch { /* Preserve partial original, with EOF false. */ }
    const raw=Buffer.concat(chunks),completedAt=new Date().toISOString(),file=String(++count).padStart(4,"0")+".original";
    total+=raw.length;
    const length=response.headers.get("content-length");
    const meta:ArizonaOriginalCapture={role,file,method:"POST",status:response.status,contentType:response.headers.get("content-type"),startedAt,completedAt,bytes:raw.length,sha256:azHash(raw),eof,
      declaredLength:length===null?null:Number(length),contentEncoding:response.headers.get("content-encoding")};
    await writeFile(resolve(path,file),raw,{mode:0o600,flag:"wx"});
    await appendFile(resolve(path,"manifest.ndjson"),JSON.stringify(meta)+"\n",{mode:0o600});
    if(!validMeta(meta) || (!response.headers.get("content-encoding") && length!==null && Number(length)!==raw.length)) azHold("source_status_or_eof");
    await new Promise(r=>setTimeout(r,250));
    try { return {meta,value:parseArizonaReportedJson(new TextDecoder("utf-8",{fatal:true}).decode(raw))}; }
    catch { return azHold("source_json"); }
  }
  return {capture};
}

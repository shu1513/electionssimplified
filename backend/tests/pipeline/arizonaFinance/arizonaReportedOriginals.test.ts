import { afterEach,describe,expect,it,vi } from "vitest";
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile,lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { createArizonaOriginalCapture,savedArizonaOriginals } from "../../../src/pipeline/arizonaFinance/arizonaReportedOriginals.js";
const roots:string[]=[];
async function cache(){const parent=resolve("scratch/arizona-reported-finance");await mkdir(parent,{recursive:true,mode:0o700});const path=await mkdtemp(resolve(parent,"unit-originals-"));roots.push(path);return path;}
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const url="https://seethemoney.az.gov/Reporting/AdvancedSearch/?CategoryType=Income";
describe("Arizona private untouched originals",()=>{
  it("saves raw numeric lexemes before parsing, with private modes and honest clocks",async()=>{
    const body='{"amount":90071992547409.91,"memo":"synthetic"}';
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(body,{headers:{"content-type":"application/json","content-length":String(Buffer.byteLength(body))}})));
    const root=await cache(),cap=await createArizonaOriginalCapture(root),o=await cap.capture("synthetic_receipt",url,new URLSearchParams());
    expect(o.value.amount).toBe("90071992547409.91");const dir=resolve(root,(await readdir(root))[0]!);
    expect((await readFile(resolve(dir,"0001.original"))).toString()).toBe(body);
    expect((await lstat(dir)).mode&0o077).toBe(0);expect((await lstat(resolve(dir,"0001.original"))).mode&0o077).toBe(0);
    const replay=await savedArizonaOriginals(root);expect(replay).toHaveLength(1);expect(replay[0]!.meta.completedAt).toBe(o.meta.completedAt);
    expect(await readFile(resolve(dir,"manifest.ndjson"),"utf8")).not.toContain("CategoryType");
  });
  it("does not admit a complete-looking body with a mismatched declared length on replay",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('{"data":[]}',{headers:{"content-type":"application/json","content-length":"999"}})));
    const root=await cache();await expect((await createArizonaOriginalCapture(root)).capture("synthetic_bad_length",url,new URLSearchParams())).rejects.toThrow("source_status_or_eof");
    expect(await savedArizonaOriginals(root)).toEqual([]);
  });
  it("keeps genuine partial bytes with EOF false and refuses their replay",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"data":'));},pull(c){c.error(Error("synthetic_truncation"));}}),{headers:{"content-type":"application/json"}})));
    const root=await cache();await expect((await createArizonaOriginalCapture(root)).capture("synthetic_partial",url,new URLSearchParams())).rejects.toThrow("source_status_or_eof");
    const dir=resolve(root,(await readdir(root))[0]!),meta=JSON.parse(await readFile(resolve(dir,"manifest.ndjson"),"utf8"));expect(meta.eof).toBe(false);
    expect(await savedArizonaOriginals(root)).toEqual([]);
  });
  it("rejects changed original bytes and source-origin/path substitutions",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('{"data":[]}',{headers:{"content-type":"application/json"}})));
    const root=await cache(),cap=await createArizonaOriginalCapture(root);await cap.capture("synthetic_integrity",url,new URLSearchParams());
    const dir=resolve(root,(await readdir(root))[0]!);await writeFile(resolve(dir,"0001.original"),'{"data":[1]}');expect(await savedArizonaOriginals(root)).toEqual([]);
    await expect(cap.capture("synthetic_scope","https://example.org/Reporting/AdvancedSearch/",new URLSearchParams())).rejects.toThrow("source_origin");
    await expect(cap.capture("synthetic_scope","https://seethemoney.az.gov/other",new URLSearchParams())).rejects.toThrow("source_origin");
  });
});

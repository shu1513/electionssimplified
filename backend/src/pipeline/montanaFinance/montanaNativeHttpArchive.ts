import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID,createHash } from "node:crypto";
import type { MontanaCersSessionOptions } from "./montanaCersClient.js";
import { DEFAULT_MONTANA_CERS_CACHE_DIR } from "./montanaCersArtifactCache.js";

/** Complete actual response bytes. Request/response headers are not archived. */
export type MontanaNativeCapture={ordinal:number;url:string;method:string;form:Record<string,string>|null;status:number;
  byteSize:number;sha256:string;capturedAt:string};
async function createDirectory(p:string):Promise<void>{
  try{await fs.mkdir(p,{mode:0o700});}catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT"){await createDirectory(path.dirname(p));await fs.mkdir(p,{mode:0o700});}
    else if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
    else if(!(await fs.lstat(p)).isDirectory())throw new Error("Invalid Montana native archive directory");
    else return;
  }
  await fs.chmod(p,0o700);
}
export async function createMontanaIeHttpArchive(year:number,cacheDir=DEFAULT_MONTANA_CERS_CACHE_DIR,options:MontanaCersSessionOptions={}){
  const cache=path.resolve(cacheDir),parent=path.join(cache,"http-originals"),leaf=`ie-${year}-${randomUUID()}`,dir=path.join(parent,leaf);
  for(const p of[cache,parent,dir]){await createDirectory(p);await fs.chmod(p,0o700);}
  const manifest=path.join(dir,"manifest.ndjson"),native:NonNullable<MontanaCersSessionOptions["fetchImpl"]>=options.fetchImpl??((url,init)=>fetch(url,init));
  let requests=0,bytes=0,last=0;const started=Date.now(),spacing=options.spacingMs??1000;
  const fetchImpl:NonNullable<MontanaCersSessionOptions["fetchImpl"]>=async(url,init)=>{
    if(requests>=600||Date.now()-started>20*60000)throw new Error("Montana IE acquisition request budget exceeded");
    if(last&&spacing)await new Promise(r=>setTimeout(r,Math.max(0,spacing-(Date.now()-last))));last=Date.now();const ordinal=++requests;
    const response=await native(url,init),consume=response.arrayBuffer.bind(response);
    response.arrayBuffer=async()=>{
      const buffer=await consume(),body=Buffer.from(buffer);bytes+=body.length;if(bytes>128*1024*1024)throw new Error("Montana IE acquisition byte budget exceeded");
      const entry:MontanaNativeCapture={ordinal,url,method:init.method,form:init.body?Object.fromEntries(new URLSearchParams(init.body)):null,
        status:response.status,byteSize:body.length,sha256:createHash("sha256").update(body).digest("hex"),capturedAt:new Date().toISOString()};
      const file=path.join(dir,String(entry.ordinal).padStart(4,"0")+".original");await fs.writeFile(file,body,{flag:"wx",mode:0o600});await fs.chmod(file,0o600);
      await fs.appendFile(manifest,JSON.stringify(entry)+"\n",{mode:0o600});await fs.chmod(manifest,0o600);return buffer;
    };return response;
  };
  return {relativeDirectory:"http-originals/"+leaf,sessionOptions:{...options,fetchImpl}};
}

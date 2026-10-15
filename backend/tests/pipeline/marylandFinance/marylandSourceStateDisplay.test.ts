import {afterEach,describe,expect,it} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {decodeMarylandSourceStateDisplayDictionary,readMarylandSourceStateDisplayDictionary,projectMarylandLegacyNativeFullAddress} from "../../../src/pipeline/marylandFinance/marylandSourceStateDisplay.js";
const states="AL=Alabama|AK=Alaska|AZ=Arizona|AR=Arkansas|CA=California|CO=Colorado|CT=Connecticut|DE=Delaware|DC=District of Columbia|FL=Florida|GA=Georgia|HI=Hawaii|ID=Idaho|IL=Illinois|IN=Indiana|IA=Iowa|KS=Kansas|KY=Kentucky|LA=Louisiana|ME=Maine|MD=Maryland|MA=Massachusetts|MI=Michigan|MN=Minnesota|MS=Mississippi|MO=Missouri|MT=Montana|NE=Nebraska|NV=Nevada|NH=New Hampshire|NJ=New Jersey|NM=New Mexico|NY=New York|NC=North Carolina|ND=North Dakota|OH=Ohio|OK=Oklahoma|OR=Oregon|PA=Pennsylvania|RI=Rhode Island|SC=South Carolina|SD=South Dakota|TN=Tennessee|TX=Texas|UT=Utah|VT=Vermont|VA=Virginia|WA=Washington|WV=West Virginia|WI=Wisconsin|WY=Wyoming".split("|").map(s=>s.split("="));
const source=()=>Buffer.from(states.map(([code,name])=>`properties:{'postal-code':'${code}',name:'${name}','hc-key':'us-${code!.toLowerCase()}'}`).join(","));
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function packet(){const dir=await mkdtemp(join(tmpdir(),"md-state-display-test-"));directories.push(dir);
  const originalPath=join(dir,"source.js"),captureJournalPath=join(dir,"captures.json"),bytes=source();
  const capture={url:"https://campaignfinance.maryland.gov/chunk-G6IWTGO7.js",method:"GET",startedAt:"2026-10-13T04:24:26.225723+00:00",completedAt:"2026-10-13T04:24:27.053872+00:00",status:200,sha256:createHash("sha256").update(bytes).digest("hex"),byteCount:bytes.length,rawPath:originalPath};
  await writeFile(originalPath,bytes);await writeFile(captureJournalPath,JSON.stringify([capture]));return {originalPath,captureJournalPath,capture};}
describe("source-licensed Maryland state display",()=>{
  it("reopens the original static capture and finite complete dictionary",async()=>{
    const p=await packet(),result=await readMarylandSourceStateDisplayDictionary(p);
    expect(Object.keys(result.privateStateLabels)).toHaveLength(51);expect(result.sourceFacts).toMatchObject({dictionaryEntries:51,sha256:p.capture.sha256});
    expect(Object.isFrozen(result.privateStateLabels)).toBe(true);
    expect(()=>{(result.privateStateLabels as Record<string,string>).MD="Changed";}).toThrow();
    expect(result.sourceFacts).not.toHaveProperty("bodyComplete");
  });
  it("holds missing, conflicting, unknown or uncorrelated state entries",()=>{
    for(const bytes of [Buffer.from(source().toString().replace("'MD'","'ZZ'")),Buffer.from(source().toString().replace("us-md","us-va")),
      Buffer.from(source().toString().replace("name:'Maryland'","name:'Virginia'")),Buffer.from(source().toString().replace(/properties:\{'postal-code':'MD'[^}]*\},?/,"")),
      Buffer.from(source().toString().replace("name:'Maryland'","name:'Maryland',name:'Changed'")),
      Buffer.from(source().toString().replace("name:'Maryland'","name:'Maryland',name:123")),
      Buffer.from(source().toString().replace("'postal-code':'MD'","'postal-code':'MD','postal-code':'VA'")),
      Buffer.from(source().toString().replace("'hc-key':'us-md'","'hc-key':'us-md','hc-key':'us-va'")),Buffer.from([0xff])])
      expect(()=>decodeMarylandSourceStateDisplayDictionary(bytes)).toThrow("dictionary");
  });
  it("holds changed originals and invalid capture metadata",async()=>{
    for(const mode of ["bytes","duplicate","status","url","time"]){const p=await packet();
      if(mode==="bytes")await writeFile(p.originalPath,Buffer.concat([source(),Buffer.from(" ")]));
      if(mode==="status")p.capture.status=500;if(mode==="url")p.capture.url="https://example.com/source.js";
      if(mode==="time")p.capture.completedAt="2020-01-01T00:00:00Z";
      await writeFile(p.captureJournalPath,JSON.stringify(mode==="duplicate"?[p.capture,p.capture]:[p.capture]));
      await expect(readMarylandSourceStateDisplayDictionary(p)).rejects.toThrow();}
  });
  it("changes only the exact explicit terminal state/postal component",async()=>{
    const p=await packet(),dictionary=await readMarylandSourceStateDisplayDictionary(p);
    const row={contributorState:"MD",contributorZipCode:"12345-6789",contributorFullAddress:"12 Example St, Unit 2 Example City MD 12345-6789"};
    expect(projectMarylandLegacyNativeFullAddress(row,dictionary)).toBe("12 Example St, Unit 2 Example City Maryland 12345-6789");
    for(const changed of [{contributorState:"VA"},{contributorZipCode:"12345"},{contributorState:null},{contributorFullAddress:"12 Example St, Unit 2 Example City MD 12345-6789 "},
      {contributorFullAddress:"12 Example St, Unit 2 Example City MD, 12345-6789"}])
      expect(projectMarylandLegacyNativeFullAddress({...row,...changed},dictionary)).toBeNull();
  });
});

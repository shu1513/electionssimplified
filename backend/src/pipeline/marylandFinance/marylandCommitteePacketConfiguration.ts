import {lstat,readFile} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import type {MarylandCommitteeMonetaryPacketConfiguration} from "./marylandCommitteeMonetarySync.js";

const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const uuid=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)&&
  value!=="00000000-0000-0000-0000-000000000000";
const keys=(value:unknown,allowed:readonly string[]):value is Record<string,unknown>=>object(value)&&
  Object.keys(value).length===allowed.length&&Object.keys(value).every(k=>allowed.includes(k));
const text=(value:unknown)=>typeof value==="string"&&Boolean(value.trim());
/** Private source descriptors only. The ordinary packet reader reopens and
 * verifies every original; no parsed money, approval or success flags belong
 * in this file. Canonical candidate context always comes from the database. */
export async function readMarylandCommitteePacketConfiguration(path:string):Promise<readonly MarylandCommitteeMonetaryPacketConfiguration[]> {
  try {
    const absolute=resolve(path),parent=await lstat(dirname(absolute)),info=await lstat(absolute);
    if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o777)!==0o700||
      !info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o600||info.size<1||info.size>16*1024*1024)throw Error();
    const raw=await readFile(absolute);if(raw.length!==info.size)throw Error();
    const file:unknown=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(raw));
    if(!object(file)||Object.keys(file).length!==2||file.version!==1||!Array.isArray(file.packets)||file.packets.length>1000)throw Error();
    const allowed=["candidateId","electionId","electionYear","committeeId","source","receivingSources"];
    for(const p of file.packets){
      if(!keys(p,allowed)||!uuid(p.candidateId)||!uuid(p.electionId)||!Number.isInteger(p.electionYear)||(p.electionYear as number)<2000||(p.electionYear as number)>2100||
        typeof p.committeeId!=="string"||!/^[1-9]\d*$/.test(p.committeeId)||!Number.isSafeInteger(Number(p.committeeId)))throw Error();
      const s=p.source,r=p.receivingSources;
      if(!keys(s,["currentCensusDirectory","priorCensusDirectory","priorCycle","inventoryDirectory","documents"])||
        ![s.currentCensusDirectory,s.priorCensusDirectory,s.priorCycle,s.inventoryDirectory].every(text)||!Array.isArray(s.documents))throw Error();
      for(const d of s.documents)if(!keys(d,["reportGuid","reportVersionId","originalPath","captureJournalPath"])||!uuid(d.reportGuid)||
        !Number.isSafeInteger(d.reportVersionId)||(d.reportVersionId as number)<1||![d.originalPath,d.captureJournalPath].every(text))throw Error();
      if(!keys(r,["numericRegistration","nameRegistration","rosterCapture","dateCapture","cycleCapture"])||
        !keys(r.numericRegistration,["captures"])||!Array.isArray(r.numericRegistration.captures)||
        !keys(r.nameRegistration,["captures"])||!Array.isArray(r.nameRegistration.captures)||
        ![r.rosterCapture,r.dateCapture,r.cycleCapture].every(object))throw Error();
    }
    return file.packets as MarylandCommitteeMonetaryPacketConfiguration[];
  } catch {throw new Error("invalid_maryland_committee_packet_configuration");}
}

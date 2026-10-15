import type {Pool,PoolClient} from "pg";
import {loadMarylandCommitteeMonetaryContext} from "./marylandCommitteeMonetaryContext.js";
import {loadMarylandCommitteeMonetaryPacket,type MarylandCommitteeMonetaryPacketSource} from "./marylandCommitteeMonetaryPacketLoader.js";
import {replaceMarylandCommitteeMonetarySnapshot} from "./marylandCommitteeMonetaryWriter.js";
import type {MarylandOutsideReceivingContextInput} from "./marylandOutsideReceivingContext.js";

type Scope={candidateId:string;electionId:string;electionYear:number;committeeId:string};
export type MarylandCommitteeMonetaryPacketConfiguration=Readonly<Scope&{
  source:MarylandCommitteeMonetaryPacketSource;
  receivingSources:Omit<MarylandOutsideReceivingContextInput,"canonical">;
}>;
export type MarylandCommitteeMonetarySyncResult={
  configuredPackets:number;selectedPackets:number;writtenCandidates:number;preservedCandidates:number;
  results:{dueIndex:number;status:"preserve"|"ready"|"written";diagnostics:string[];
    positionCount?:number;grossCents?:number;refundCents?:number;netCents?:number}[];
};
const scopeKey=(s:Scope)=>s&&typeof s.candidateId==="string"&&typeof s.electionId==="string"&&Number.isInteger(s.electionYear)&&typeof s.committeeId==="string"
  ?JSON.stringify([s.candidateId.toLowerCase(),s.electionId.toLowerCase(),s.electionYear,s.committeeId]):null;

/** Independent component pass. Source descriptors select originals to verify;
 * they grant no authority. A held packet never calls a writer or changes an
 * existing summary/freshness. Ordinary source and canonical readers recompute
 * the complete packet before the existing transactional component writer. */
export async function syncMarylandCommitteeMonetaryPackets(input:{
  db:Pick<Pool,"connect">&Pick<Pool|PoolClient,"query">;
  dueRows:readonly Scope[];packets:readonly MarylandCommitteeMonetaryPacketConfiguration[];
  dryRun:boolean;now:Date;
}):Promise<MarylandCommitteeMonetarySyncResult> {
  const {db}=input;
  const retained=structuredClone({dueRows:input.dueRows,packets:input.packets,dryRun:input.dryRun,now:input.now});
  const result:MarylandCommitteeMonetarySyncResult={configuredPackets:retained.packets.length,selectedPackets:0,writtenCandidates:0,preservedCandidates:0,results:[]};
  if(retained.packets.some(p=>scopeKey(p)===null)) {
    result.preservedCandidates=retained.dueRows.length;
    result.results=retained.dueRows.map((_,dueIndex)=>({dueIndex,status:"preserve",diagnostics:["invalid_packet_configuration"]}));
    return result;
  }
  for(const [dueIndex,row]of retained.dueRows.entries()) {
    const selected=retained.packets.filter(p=>scopeKey(p)===scopeKey(row));
    if(!selected.length)continue;
    result.selectedPackets++;
    const preserve=(diagnostics:string[])=>{result.preservedCandidates++;result.results.push({dueIndex,status:"preserve",diagnostics});};
    if(selected.length!==1){preserve(["ambiguous_packet_configuration"]);continue;}
    try {
      const canonical=await loadMarylandCommitteeMonetaryContext(db,row);
      if(!canonical){preserve(["receiving_context_unavailable"]);continue;}
      const packet=selected[0]!;
      const loaded=await loadMarylandCommitteeMonetaryPacket({source:packet.source,
        receivingContext:{...packet.receivingSources,canonical},now:retained.now});
      if(loaded.status!=="ready"){preserve([...loaded.diagnostics]);continue;}
      const a=loaded.privateSnapshot.aggregation;
      if(!retained.dryRun){await replaceMarylandCommitteeMonetarySnapshot({db,snapshot:loaded.privateSnapshot,syncedAt:retained.now});result.writtenCandidates++;}
      result.results.push({dueIndex,status:retained.dryRun?"ready":"written",diagnostics:[],
        positionCount:a.positions.length,grossCents:a.grossCents,refundCents:a.refundCents,netCents:a.netCents});
    } catch {preserve(["committee_component_unavailable"]);}
  }
  return result;
}

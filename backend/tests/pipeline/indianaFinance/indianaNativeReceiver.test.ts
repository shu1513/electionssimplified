import {describe,expect,it} from 'vitest';
import {qualifyIndianaNativeReceiver,type IndianaNativeReceiver} from '../../../src/pipeline/indianaFinance/indianaNativeReceiver.js';
import type {IndianaNativeCommittee} from '../../../src/pipeline/indianaFinance/indianaNativeProtocol.js';
const receiver:IndianaNativeReceiver={linkId:'synthetic-link',candidateId:'synthetic-candidate',electionId:'synthetic-election',electionYear:2026,electionDate:'2026-11-03',firstName:'Bill',lastName:'Example',candidateAliases:['Bill A Example','William A Example','Bill Example'],receivingId:'900000001',committeeName:'Synthetic Committee',officeScope:'state_lower',officeName:'State Lower Chamber Legislator',linkOfficeName:'State Lower Chamber Legislator',district:'99',canonicalDistrictName:'State House District 99; Indiana',canonicalDistrictType:'state_lower',activeOwnerCount:1};
const committee:IndianaNativeCommittee={file:'900000001',name:'Synthetic Committee',candidate:'Example, William A.',office:'State Representative',district:'99',committeeClass:'Candidate',status:'Active'};
describe('Indiana protected native receiving identity',()=>{
 it('uses existing one-sided nickname/middle evidence with exact office and seat',()=>{
  expect(()=>qualifyIndianaNativeReceiver(receiver,committee)).not.toThrow();
 });
 it('rejects a contradicting canonical alias even when another alias matches',()=>{
  expect(()=>qualifyIndianaNativeReceiver({...receiver,candidateAliases:[...receiver.candidateAliases,'Bill B Example']},committee)).toThrow('native_receiving_person');
 });
 it('rejects a different seat, office or newly nonexclusive owner',()=>{
  expect(()=>qualifyIndianaNativeReceiver(receiver,{...committee,district:'98'})).toThrow('native_receiving_district');
  expect(()=>qualifyIndianaNativeReceiver(receiver,{...committee,office:'State Senator'})).toThrow('native_receiving_office');
  expect(()=>qualifyIndianaNativeReceiver({...receiver,activeOwnerCount:2},committee)).toThrow('native_canonical_context');
 });
});

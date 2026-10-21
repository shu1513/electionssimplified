import {describe,expect,it} from 'vitest';
import {requireIndianaNativeOccurrenceClosure} from '../../../src/pipeline/indianaFinance/indianaNativeFinancialEvidence.js';
const row=(name:string,cents:number)=>({day:'2026-10-01',kind:'Direct',name,cents});
describe('Indiana full receiving occurrence closure',()=>{
 it('rejects swapped donor amounts even when count and total money still match',()=>{
  expect(()=>requireIndianaNativeOccurrenceClosure([row('Synthetic A',10000),row('Synthetic B',20000)],[row('Synthetic A',20000),row('Synthetic B',10000)])).toThrow('native_receipt_occurrence_conflict');
 });
 it('preserves repeated same-day gifts and signed credits without deduplication',()=>{
  const rows=[row('Synthetic A',10000),row('Synthetic A',10000),row('Synthetic A',-5000)];
  expect(()=>requireIndianaNativeOccurrenceClosure(rows,[...rows].reverse())).not.toThrow();
  expect(()=>requireIndianaNativeOccurrenceClosure(rows,rows.slice(1))).toThrow('native_receipt_occurrence_conflict');
 });
});

import { createHash } from "node:crypto";
export type OklahomaReportedKind = "committee" | "ie";
export const OK_REPORTED_REVISION = "ok-native-components-2-compound-target-office";
export const okHash = (v: Uint8Array|string): string => createHash("sha256").update(v).digest("hex");
export const okLiteral = (s: string): string => s.normalize("NFC").trim().replace(/\s+/g," ");
export const okCanonical = (v: unknown): string => JSON.stringify(v,(_,x)=>x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export class OklahomaReportedHold extends Error {constructor(public readonly code:string){super(`Oklahoma reported finance held: ${code}`);}}
export function okHold(code:string):never {throw new OklahomaReportedHold(code);}
export function okAdd(a:number,b:number):number {const n=a+b;if(![a,b,n].every(Number.isSafeInteger))okHold("unsafe_money");return n;}
export function okFreeze(v:any):void {if(v&&typeof v==="object"&&!Object.isFrozen(v)){Object.freeze(v);for(const x of Object.values(v))okFreeze(x);}}
export const okIso = (v:unknown):v is string => typeof v==="string"&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;

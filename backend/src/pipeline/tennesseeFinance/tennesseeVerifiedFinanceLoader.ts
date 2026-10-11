import { createTennesseeCurrentReportClient, type TennesseeCurrentReportClient,
  type TennesseeCurrentReportClientOptions, type TennesseeCurrentReportRawResponse,
  type TennesseeCurrentReport, type TennesseeCurrentReportManifest, type TennesseeCurrentReportManifestRow } from "./tennesseeCurrentReportClient.js";
import { createTennesseeVerifiedNativeClient, type TennesseeVerifiedNativeClient,
  type TennesseeVerifiedNativeClientOptions, type TennesseeNativeRawResponse, type TennesseeNativeResult,
  type TennesseeVerifiedNativeCandidateRow, type TennesseeVerifiedNativeContributionRow,
  type TennesseeVerifiedNativeIndependentExpenditureRow, type TennesseeVerifiedNativePacRegistryRow } from "./tennesseeVerifiedNativeClient.js";
import { resolveTennesseeOrdinaryReportPeriod, resolveTennesseeOrdinaryReportPeriodEnd,
  type TennesseeOrdinaryReportPeriodContext } from "./tennesseeOrdinaryReportPeriodResolver.js";
import { verifyTennesseeDirectEvidence, type TennesseeDirectSourceSnapshot } from "./tennesseeVerifiedDirectEvidence.js";
import { verifyTennesseeOutsideReport, resolveTennesseeVerifiedCandidateContext } from "./tennesseeVerifiedOutsideEvidence.js";
import { summarizeTennesseeOutsideReportProvenance, type TennesseeStoredOutsideReportEvidence,
  type TennesseeVerifiedOutsideReportEvidence } from "./tennesseeOutsideReportEvidence.js";
import { tennesseeCandidateSearchToken } from "./tennesseeVerifiedLocalName.js";
import type { TennesseeFinanceLinkInput, TennesseeVerifiedFinanceSnapshot } from "./tennesseeFinanceWriter.js";

export type TennesseeVerifiedFinanceLoadRequest = {
  link: TennesseeFinanceLinkInput;
  priorPacProvenance?: unknown;
  priorOutsideReportProvenance?: unknown;
};
export type TennesseeVerifiedFinancePreparedResult = TennesseeVerifiedFinanceSnapshot & {
  link: TennesseeFinanceLinkInput;
  coverage: {
    direct?: { windowStart: string; windowEnd: string; publishedThrough: string; reportIds: readonly string[]; grossCashRaisedAvailable: boolean };
    pac?: { windowStart: string; windowEnd: string; reportIds: readonly string[] };
    outside?: { stream: "ordinary"; verifiedReportIds: readonly string[]; allocationMethod: "contextual_exact_name" };
  };
};
type Phase = "before" | "after";
type Scope = "registry" | "ie" | "candidate_context" | "native_all" | "native_pac" | "manifest" | "report";
export type TennesseeVerifiedFinanceRawEvent = {
  phase: Phase; scope: Scope; campId?: string; reportYear?: number;
  raw: TennesseeNativeRawResponse | TennesseeCurrentReportRawResponse;
};
export type TennesseeVerifiedFinanceLoaderOptions = {
  clientOptions?: { fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number };
  createNativeClient?: (options: TennesseeVerifiedNativeClientOptions) => TennesseeVerifiedNativeClient;
  createReportClient?: (options: TennesseeCurrentReportClientOptions) => TennesseeCurrentReportClient;
  verifyDirect?: typeof verifyTennesseeDirectEvidence;
  verifyOutside?: typeof verifyTennesseeOutsideReport;
  onRawResponse?: (event: TennesseeVerifiedFinanceRawEvent) => void | Promise<void>;
};
type Candidate = {
  request: TennesseeVerifiedFinanceLoadRequest; diagnostics: string[];
  contextBefore?: TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>;
  contextAfter?: TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>;
  sourceOwnerName?: string;
  manifestBefore?: TennesseeCurrentReportManifest; manifestAfter?: TennesseeCurrentReportManifest;
  reportsBefore: TennesseeCurrentReport[]; reportsAfter: TennesseeCurrentReport[];
  allBefore: Map<number,TennesseeNativeResult<TennesseeVerifiedNativeContributionRow>>;
  allAfter: Map<number,TennesseeNativeResult<TennesseeVerifiedNativeContributionRow>>;
  pacBefore: Map<number,TennesseeNativeResult<TennesseeVerifiedNativeContributionRow>>;
  pacAfter: Map<number,TennesseeNativeResult<TennesseeVerifiedNativeContributionRow>>;
  periods: Map<string,NonNullable<TennesseeCurrentReport["period"]>>;
  directFailed: boolean; priorOutside: readonly TennesseeStoredOutsideReportEvidence[]; outsideFailed: boolean;
  payerPeriods: Set<string>;
};
type Payer = {
  campId: string; ownerName: string; manifestBefore?: TennesseeCurrentReportManifest; manifestAfter?: TennesseeCurrentReportManifest;
  reportsBefore: Map<string,TennesseeCurrentReport>; reportsAfter: Map<string,TennesseeCurrentReport>;
  diagnostics: string[]; failedPeriods: Set<string>; selected: Map<string,TennesseeCurrentReportManifestRow>;
  periods: Map<string,NonNullable<TennesseeCurrentReport["period"]>>;
};
const text = (s: string) => s.replace(/\s+/g," ").trim();
const person = (s: string) => { const parts = text(s).split(","); return text(parts.length === 2 ? parts[1] + " " + parts[0] : s).toUpperCase(); };
const exactId = (s: string) => /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s));
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function dollars(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw Error("Unsafe verified Tennessee cents");
  const result = cents / 100;
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(result));
  if (!parts || BigInt(parts[1]) * 100n + BigInt((parts[2] ?? "").padEnd(2,"0")) !== BigInt(cents)) throw Error("Tennessee dollar conversion loses cents");
  return result;
}
function candidateSource(context: TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>, link: TennesseeFinanceLinkInput) {
  const matches = context.rows.filter(row => person(row.name) === person(link.ownerName));
  const identities = new Set(matches.map(row => JSON.stringify([row.campId,row.officeSought,row.district,row.electionYear,row.closed])));
  const row = matches[0];
  const office = text(link.officeName).toUpperCase();
  const expected = office === "STATE SENATOR" ? ["SENATE"] :
    ["STATE REPRESENTATIVE","STATE LOWER CHAMBER LEGISLATOR"].includes(office) ? ["HOUSE","HOUSE OF REPRESENTATIVES"] :
    office === "GOVERNOR" ? ["GOVERNOR"] : [];
  const district = (s: string | null | undefined) => /^\d+$/.test(text(s ?? "")) ? String(Number(s)) : text(s ?? "");
  if (!context.complete || context.declaredCount !== context.rows.length || identities.size !== 1 ||
      !row || row.campId !== link.campCandidateId || row.electionYear !== link.electionYear || row.closed !== null ||
      !expected.includes(text(row.officeSought).toUpperCase()) || district(row.district) !== district(link.district)) {
    throw Error("Complete candidate campaign/office/year ownership unavailable");
  }
  // This selects source acquisition only. Both pure verifiers additionally bind the LOCAL person's name.
  return row;
}
function periodContext(link: TennesseeFinanceLinkInput, manifest: TennesseeCurrentReportManifest): TennesseeOrdinaryReportPeriodContext {
  return { filerType:"candidate",candidateElectionYear:link.electionYear,electionSchedule:"august-primary-november-general",
    participatesInAugustPrimary: manifest.rows.filter(row => row.electionYear === link.electionYear && row.reportName === "Pre-Primary 2026").length === 1 ? true : undefined,
    participatesInNovemberGeneral: manifest.rows.filter(row => row.electionYear === link.electionYear && row.reportName === "Pre-General 2026").length === 1 ? true : undefined };
}
function qualifiedPeriod(row: TennesseeCurrentReportManifestRow, manifest: TennesseeCurrentReportManifest,
  context: TennesseeOrdinaryReportPeriodContext): NonNullable<TennesseeCurrentReport["period"]> {
  if (manifest.rows.filter(r => r.campId === row.campId && r.electionYear === row.electionYear && r.reportName === row.reportName).length !== 1) {
    throw Error("Ambiguous current ordinary period " + row.reportName);
  }
  const matches = manifest.rows.filter(previous => previous.campId === row.campId &&
    previous.electionYear === row.electionYear && previous.reportId !== row.reportId).flatMap(previous => {
      const end = resolveTennesseeOrdinaryReportPeriodEnd({manifestRow:previous,context});
      if (!end) return [];
      const period = resolveTennesseeOrdinaryReportPeriod({manifestRow:row,context,
        continuingReportProof:{reportId:row.reportId,previousReportId:previous.reportId,previousPeriodEnd:end.end,
          completeManifestFingerprint:manifest.fingerprint}});
      return period ? [period] : [];
    });
  if (matches.length !== 1) throw Error("Unproven immediate ordinary predecessor/interval for " + row.reportName);
  return matches[0];
}

/** Source-only preparation: every opening read precedes the fresh closing round,
 * and no financial result escapes before global closing acquisitions finish. */
export function createTennesseeVerifiedFinanceLoader(options: TennesseeVerifiedFinanceLoaderOptions = {}) {
  const nativeFactory = options.createNativeClient ?? createTennesseeVerifiedNativeClient;
  const reportFactory = options.createReportClient ?? createTennesseeCurrentReportClient;
  const directVerifier = options.verifyDirect ?? verifyTennesseeDirectEvidence;
  const outsideVerifier = options.verifyOutside ?? verifyTennesseeOutsideReport;
  let queue: Promise<unknown> = Promise.resolve();
  async function prepare(requests: readonly TennesseeVerifiedFinanceLoadRequest[]): Promise<readonly TennesseeVerifiedFinancePreparedResult[]> {
    if (!requests.length) return Object.freeze([]);
    const copied = structuredClone(requests);
    const candidates: Candidate[] = copied.map(request => ({request,diagnostics:[],reportsBefore:[],reportsAfter:[],
      allBefore:new Map(),allAfter:new Map(),pacBefore:new Map(),pacAfter:new Map(),periods:new Map(),
      directFailed:false,priorOutside:[],outsideFailed:false,payerPeriods:new Set()}));
    const counts = new Map<string,number>();
    for (const {request} of candidates) {
      const l=request.link,key=[l.candidateId,l.electionId,l.campCandidateId].join(":");
      counts.set(key,(counts.get(key) ?? 0)+1);
    }
    for (const c of candidates) {
      const l = c.request.link, key = [l.candidateId,l.electionId,l.campCandidateId].join(":");
      if (counts.get(key)! > 1 || l.electionYear !== 2026 || !exactId(l.campCandidateId)) {
        c.directFailed = c.outsideFailed = true; c.diagnostics.push("Finance preserved: duplicate request or unsupported campaign/year"); continue;
      }
      if (c.request.priorOutsideReportProvenance != null) {
        const prior = summarizeTennesseeOutsideReportProvenance(c.request.priorOutsideReportProvenance);
        const ctx = prior.result?.provenance.candidateContext;
        if (!ctx || ctx.candidateId !== l.candidateId || ctx.electionId !== l.electionId || ctx.campCandidateId !== l.campCandidateId ||
            ctx.electionYear !== l.electionYear || ctx.officeName !== l.officeName || ctx.district !== (l.district ?? null)) {
          c.outsideFailed = true; c.diagnostics.push(...prior.diagnostics,"Outside preserved: prior authority incompatible with selected link");
        } else c.priorOutside = prior.result!.provenance.reports;
      }
    }
    const selected = candidates.filter(c => c.request.link.electionYear === 2026 && !c.directFailed);
    if (!selected.length) return freeze(candidates.map(c => ({link:c.request.link,diagnostics:c.diagnostics,coverage:{}})));
    async function journal(phase:Phase,scope:Scope,campId:string|undefined,reportYear:number|undefined,
      raw:TennesseeNativeRawResponse|TennesseeCurrentReportRawResponse) {
      // Whitelist fields and copy bytes: a journal consumer cannot alter client proof or receive cookie headers.
      await options.onRawResponse?.(Object.freeze({phase,scope,...(campId ? {campId}:{}),...(reportYear ? {reportYear}:{}),
        raw:Object.freeze({url:raw.url,method:raw.method,fetchedAt:raw.fetchedAt,bytes:raw.bytes.slice(),
          byteCount:raw.byteCount,sha256:raw.sha256,encoding:raw.encoding})}));
    }
    async function attempt<T>(diagnostics:string[],label:string,fn:()=>Promise<T>):Promise<T|undefined> {
      try { return await fn(); } catch(error) { diagnostics.push(label + ": " + (error instanceof Error ? error.message : String(error))); return undefined; }
    }
    function native(phase:Phase,scope:Scope,campId?:string,reportYear?:number) {
      return nativeFactory({...options.clientOptions,onRawResponse:raw=>journal(phase,scope,campId,reportYear,raw)});
    }
    function reports(phase:Phase,scope:"manifest"|"report",campId:string) {
      return reportFactory({...options.clientOptions,onRawResponse:raw=>journal(phase,scope,campId,undefined,raw)});
    }
    const years = [2024,2025,2026], registryErrors:string[] = [], ieErrors:string[] = [];
    async function registry(phase:Phase) {
      const result = await attempt(registryErrors,"PAC registry " + phase,()=>native(phase,"registry").fetchPacRegistry());
      if (result && (!result.complete || !result.rows.length || result.declaredCount !== result.rows.length)) {
        registryErrors.push("PAC registry " + phase + ": incomplete/empty"); return undefined;
      }
      return result;
    }
    async function independent(phase:Phase) {
      const result = new Map<number,TennesseeNativeResult<TennesseeVerifiedNativeIndependentExpenditureRow>>();
      for (const reportYear of years) {
        const data = await attempt(ieErrors,"IE " + phase + " " + reportYear,
          ()=>native(phase,"ie",undefined,reportYear).fetchIndependentExpenditures({reportYear}));
        if (data) result.set(reportYear,data);
      }
      return result;
    }
    const registryBefore = await registry("before"), ieBefore = await independent("before");
    for (const c of selected) {
      const l = c.request.link;
      c.contextBefore = await attempt(c.diagnostics,"Candidate context before",()=>native("before","candidate_context",l.campCandidateId).fetchCandidateContext({name:tennesseeCandidateSearchToken(l.ownerName),electionYear:l.electionYear}));
      if (!c.contextBefore) {c.directFailed=c.outsideFailed=true;continue;}
      const source = await attempt(c.diagnostics,"Candidate source identity",async()=>candidateSource(c.contextBefore!,l));
      if (!source) {c.directFailed=c.outsideFailed=true;continue;}
      // Native hrefs can contain trailing display whitespace. Normalize only the
      // request copy after exact source campaign ownership; leave raw rows/hash intact.
      c.sourceOwnerName=text(source.ownerName);
      c.manifestBefore = await attempt(c.diagnostics,"Candidate manifest before",()=>reports("before","manifest",l.campCandidateId).fetchManifest({campId:l.campCandidateId,ownerName:c.sourceOwnerName!}));
      if (!c.manifestBefore) c.directFailed=true;
      if (c.manifestBefore) {
        const manifest = c.manifestBefore, context = periodContext(l,manifest);
        try {
          const relevant = manifest.rows.filter(r => r.electionYear === l.electionYear && (r.reportYear === null || r.reportYear >= l.electionYear-2 && r.reportYear <= l.electionYear));
          for (const row of relevant) {
            const endpoint = resolveTennesseeOrdinaryReportPeriodEnd({manifestRow:row,context});
            if (endpoint && endpoint.end < "2025-01-01") continue;
            const period = qualifiedPeriod(row,manifest,context);
            if (period.start > "2026-12-31") continue;
            c.periods.set(row.reportId,period);
            const report = await reports("before","report",l.campCandidateId).fetchReport({manifestRow:row,expectedPeriod:period});
            c.reportsBefore.push(report);
          }
        } catch(error) { c.directFailed=true; c.diagnostics.push("Direct preserved: " + String(error)); }
      }
      if (!c.directFailed) for (const reportYear of years) {
        for (const donorScope of ["all","pac"] as const) {
          const data = await attempt(c.diagnostics,"Cash " + donorScope + " before " + reportYear,
            ()=>native("before",donorScope==="all"?"native_all":"native_pac",l.campCandidateId,reportYear)
              .fetchContributions({receiverName:tennesseeCandidateSearchToken(source.ownerName),recipientType:"candidate",reportYear,donorScope,electionYear:l.electionYear}));
          if (!data) c.directFailed=true; else (donorScope==="all"?c.allBefore:c.pacBefore).set(reportYear,data);
        }
      }
    }
    const payers = new Map<string,Payer>();
    const nativeRows = [...ieBefore.values()].flatMap(r=>r.rows);
    if (registryBefore && ieBefore.size === 3) for (const c of selected.filter(c=>!c.outsideFailed)) {
      const l=c.request.link;
      const discovery = nativeRows.filter(r=>person(r.targetName)===person(l.ownerName) && r.date>="2025-01-01" && r.date<="2026-12-31");
      const needs:{campId:string;periodIdentity?:string;reportId?:string}[]=[];
      for (const row of discovery) {
        const legal = registryBefore.rows.filter(r=>text(r.name)===text(row.payerName));
        const ids = new Set(legal.map(r=>r.campId));
        if (ids.size!==1) {c.diagnostics.push("Outside preserved: ambiguous/unavailable payer " + row.payerName);continue;}
        needs.push({campId:legal[0].campId,reportId:row.reportId});
      }
      needs.push(...c.priorOutside.map(r=>({campId:r.payerCampId,periodIdentity:r.periodIdentity})));
      for (const need of needs) {
        const legal=registryBefore.rows.filter(r=>r.campId===need.campId);
        if (!legal.length || new Set(legal.map(r=>JSON.stringify([r.name,r.ownerName,r.committeeType]))).size!==1) {
          c.diagnostics.push("Outside preserved: prior/current payer identity unavailable " + need.campId);continue;
        }
        let payer=payers.get(need.campId);
        if (!payer) {
          payer={campId:need.campId,ownerName:text(legal[0].ownerName),reportsBefore:new Map(),reportsAfter:new Map(),
            diagnostics:[],failedPeriods:new Set(),selected:new Map(),periods:new Map()};
          payers.set(need.campId,payer);
          payer.manifestBefore=await attempt(payer.diagnostics,"Payer manifest before",()=>reports("before","manifest",payer!.campId).fetchManifest({campId:payer!.campId,ownerName:payer!.ownerName}));
        }
        const manifest=payer.manifestBefore;
        if (!manifest) {
          // Failed manifests never add a verified period. Surface their acquisition
          // diagnostics for every affected candidate before skipping that period.
          c.diagnostics.push(...payer.diagnostics);
          continue;
        }
        const rows=manifest.rows.filter(r=>need.periodIdentity ? r.reportName===need.periodIdentity : r.reportId===need.reportId);
        if (rows.length!==1) {c.diagnostics.push("Outside preserved: prior/discovered current period unavailable");continue;}
        const row=rows[0], key=payer.campId+":"+row.reportName;
        c.payerPeriods.add(key);
        if (payer.selected.has(row.reportName) || payer.failedPeriods.has(row.reportName)) continue;
        payer.selected.set(row.reportName,row);
        try {
          const period=qualifiedPeriod(row,manifest,{filerType:"pac"});
          // Native labels omit the calendar year. Bind the actual ordinary interval too,
          // so a historical same-label report cannot contradict this current period.
          if (nativeRows.some(r=>text(r.payerName)===text(payer!.ownerName) &&
              text(r.reportName)===row.reportName.replace(/ \d{4}$/,"") &&
              r.date>=period.start && r.date<=period.end && r.reportId!==row.reportId)) {
            throw Error("Native source still exposes another report ID for current period");
          }
          payer.periods.set(row.reportName,period);
          payer.reportsBefore.set(row.reportName,await reports("before","report",payer.campId).fetchReport({manifestRow:row,expectedPeriod:period}));
        } catch(error) {payer.failedPeriods.add(row.reportName);payer.diagnostics.push("Outside period preserved: "+String(error));}
      }
    }
    // Nothing from the closing round is shared with another prepared batch.
    for (const c of selected) {
      const l=c.request.link;
      if (!c.directFailed) {
        for (const reportYear of years) for (const donorScope of ["all","pac"] as const) {
          const data=await attempt(c.diagnostics,"Cash "+donorScope+" after "+reportYear,
            ()=>native("after",donorScope==="all"?"native_all":"native_pac",l.campCandidateId,reportYear)
              .fetchContributions({receiverName:tennesseeCandidateSearchToken(c.sourceOwnerName!),recipientType:"candidate",reportYear,donorScope,electionYear:l.electionYear}));
          if (!data) c.directFailed=true; else (donorScope==="all"?c.allAfter:c.pacAfter).set(reportYear,data);
        }
        for (const report of c.reportsBefore) {
          const data=await attempt(c.diagnostics,"Candidate report after",()=>reports("after","report",l.campCandidateId).fetchReport({manifestRow:report.manifestRow,expectedPeriod:c.periods.get(report.manifestRow.reportId)}));
          if (!data) c.directFailed=true; else c.reportsAfter.push(data);
        }
      }
      if (c.manifestBefore) c.manifestAfter=await attempt(c.diagnostics,"Candidate manifest after",()=>reports("after","manifest",l.campCandidateId).fetchManifest({campId:l.campCandidateId,ownerName:c.sourceOwnerName!}));
      c.contextAfter=await attempt(c.diagnostics,"Candidate context after",()=>native("after","candidate_context",l.campCandidateId).fetchCandidateContext({name:tennesseeCandidateSearchToken(l.ownerName),electionYear:l.electionYear}));
    }
    for (const payer of payers.values()) {
      for (const [periodIdentity,report] of payer.reportsBefore) {
        const data=await attempt(payer.diagnostics,"Payer report after",()=>reports("after","report",payer.campId).fetchReport({manifestRow:report.manifestRow,expectedPeriod:payer.periods.get(periodIdentity)}));
        if (data) payer.reportsAfter.set(periodIdentity,data); else payer.failedPeriods.add(periodIdentity);
      }
      if (payer.manifestBefore) payer.manifestAfter=await attempt(payer.diagnostics,"Payer manifest after",()=>reports("after","manifest",payer.campId).fetchManifest({campId:payer.campId,ownerName:payer.ownerName}));
    }
    const ieAfter=await independent("after"),registryAfter=await registry("after");
    const results:TennesseeVerifiedFinancePreparedResult[]=[];
    for (const c of candidates) {
      const result:TennesseeVerifiedFinancePreparedResult={link:c.request.link,diagnostics:[],coverage:{}};
      const diagnostics=[...c.diagnostics];
      if (!c.directFailed && c.contextBefore && c.contextAfter && c.manifestBefore && c.manifestAfter && registryBefore && registryAfter) {
        const snapshot=(phase:Phase):TennesseeDirectSourceSnapshot=>({manifest:phase==="before"?c.manifestBefore!:c.manifestAfter!,reports:phase==="before"?c.reportsBefore:c.reportsAfter,
          nativeAll:phase==="before"?c.allBefore:c.allAfter,nativePac:phase==="before"?c.pacBefore:c.pacAfter,registry:phase==="before"?registryBefore:registryAfter});
        try {
          const verified=directVerifier({link:c.request.link,candidateContextBefore:c.contextBefore,candidateContextAfter:c.contextAfter,
            before:snapshot("before"),after:snapshot("after"),priorPacSourceProvenance:c.request.priorPacProvenance});
          diagnostics.push(...verified.diagnostics);
          if (verified.evidence) {
            const e=verified.evidence;
            result.summary={directContributionTotal:dollars(e.itemizedCashCents),sourceUrl:e.coverage.sourceUrl,
              ...(e.grossCashRaisedCents!==undefined?{totalReceipts:dollars(e.grossCashRaisedCents)}:{})};
            result.directBreakdowns=e.directBreakdowns;
            if (e.pacDonors!==undefined && e.pacProvenance) {result.pacDonors=e.pacDonors;result.pacSourceProvenance=e.pacProvenance;
              result.coverage.pac={windowStart:e.coverage.windowStart,windowEnd:e.coverage.windowEnd,reportIds:e.coverage.reportIds};}
            result.coverage.direct={...e.coverage,grossCashRaisedAvailable:e.grossCashRaisedCents!==undefined};
          }
        } catch(error) {diagnostics.push("Direct preserved: "+String(error));}
      } else diagnostics.push(...registryErrors,"Direct preserved: full cash/identity/registry bracket unavailable");
      if (!c.outsideFailed && c.contextBefore && c.contextAfter && registryBefore && registryAfter && ieBefore.size===3 && ieAfter.size===3) {
        const verifiedReports:TennesseeVerifiedOutsideReportEvidence[]=[];
        for (const key of c.payerPeriods) {
          const payer=payers.get(key.slice(0,key.indexOf(":")))!,periodIdentity=key.slice(key.indexOf(":")+1);
          diagnostics.push(...payer.diagnostics);
          const before=payer.reportsBefore.get(periodIdentity),after=payer.reportsAfter.get(periodIdentity);
          if (!before || !after || !payer.manifestBefore || !payer.manifestAfter || payer.failedPeriods.has(periodIdentity)) continue;
          try {
            const verified=outsideVerifier({link:c.request.link,candidateContextBefore:c.contextBefore,candidateContextAfter:c.contextAfter,
              registryBefore,registryAfter,manifestBefore:payer.manifestBefore,manifestAfter:payer.manifestAfter,reportBefore:before,reportAfter:after,
              nativeBefore:years.map(y=>ieBefore.get(y)!),nativeAfter:years.map(y=>ieAfter.get(y)!)});
            diagnostics.push(...verified.diagnostics);if(verified.evidence)verifiedReports.push(verified.evidence);
          } catch(error) {diagnostics.push("Outside preserved: "+String(error));}
        }
        const candidateContext=resolveTennesseeVerifiedCandidateContext({link:c.request.link,nativeContext:c.contextBefore,reportedTargetName:c.request.link.ownerName});
        if (verifiedReports.length && candidateContext) {
          result.outsideReportEvidence={candidateContext,verifiedReports};
          result.coverage.outside={stream:"ordinary",verifiedReportIds:verifiedReports.map(r=>r.reportId),allocationMethod:"contextual_exact_name"};
        }
      } else diagnostics.push(...ieErrors,...registryErrors,"Outside preserved: full native/registry/context bracket unavailable");
      result.diagnostics=[...new Set(diagnostics)];
      results.push(result);
    }
    return freeze(results);
  }
  return {loadBatch(requests:readonly TennesseeVerifiedFinanceLoadRequest[]) {
    const task=queue.then(()=>prepare(requests));
    queue=task.then(()=>undefined,()=>undefined);
    return task;
  }};
}

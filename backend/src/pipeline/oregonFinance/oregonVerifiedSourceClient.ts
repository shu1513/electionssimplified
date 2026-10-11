import type { OregonPacRawEvidence } from "./oregonVerifiedPacSource.js";
import { getOregonOrestarSearchForm } from "./oregonOrestarClient.js";
import {
    decodeOregonVerifiedHtmlBytes,
    decodeOregonVerifiedTransactionSearch,
    decodeOregonVerifiedTransactionWorkbook,
    decodeOregonVerifiedTransactionDetail,
    decodeOregonVerifiedTransactionHistory,
    decodeOregonVerifiedSoo,
    decodeOregonVerifiedCandidateDirectory,
    hashOregonVerifiedBytes
} from "./oregonVerifiedSourceDecoders.js";
export type OregonVerifiedFetchResponse = Pick<Response, "ok" | "status" | "headers" | "body">;
export type OregonVerifiedFetch = (url: string, init: RequestInit) => Promise<OregonVerifiedFetchResponse>;
type FailedRequest = Omit<OregonPacRawEvidence["request"], "status"> & {
    status: number | null;
};
export type OregonVerifiedRawCapture = {
    kind: "public_response";
    outcome: "complete";
    evidence: OregonPacRawEvidence;
} | {
    kind: "failed_response";
    outcome: "failed";
    bytes: Uint8Array;
    request: FailedRequest;
    failureKind: string;
} | {
    kind: "credential_metadata";
    outcome: "complete" | "failed";
    request: FailedRequest;
    failureKind?: string;
};
export type OregonVerifiedSourceClientOptions = {
    fetchFn?: OregonVerifiedFetch;
    userAgent?: string;
    timeoutMs?: number;
    maxHtmlBytes?: number;
    maxWorkbookBytes?: number;
    /** Budgets cover this client instance's entire sequential generation, including bootstraps. */
    maxRequests?: number;
    maxTotalBytes?: number;
    onRawResponse?: (capture: OregonVerifiedRawCapture) => void | Promise<void>;
};
export type OregonVerifiedLedgerInput = {
    committeeId?: string;
    electionYear: number;
    transactionType: "C" | "OD" | "E";
    independentOnly?: true;
};
const ORIGIN = "https://secure.sos.state.or.us";
const ROOT = ORIGIN + "/orestar/";
const transactionForm = ROOT + "gotoPublicTransactionSearch.do";
const candidateForm = ROOT + "GotoSearchByElection.do";
const allowedPaths = new Set([
    "gotoPublicTransactionSearch.do",
    "gotoPublicTransactionSearchResults.do",
    "JavaScriptServlet",
    "GotoSearchByElection.do",
    "CommitteeSearchSecondPage.do",
    "XcelCNESearch",
    "gotoPublicTransactionDetail.do",
    "ceTransactionHistory.do",
    "sooDetail.do"
]);
const err = (reason: string) => new Error(`ORESTAR verified client: ${reason}`);
function positive(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw err(`invalid ${label}`);
    return value;
}
function numericId(value: string): string {
    if (!/^[1-9]\d*$/.test(value))
        throw err("invalid source ID");
    return value;
}
function year(value: number): number {
    if (!Number.isInteger(value) || value < 2000 || value > 2100)
        throw err("invalid source year");
    return value;
}
function url(raw: string): URL {
    const u = new URL(raw, ROOT);
    const path = u.pathname.replace(/;JSESSIONID(?:_ORESTAR)?=[^/;]+/gi, "");
    if (u.origin !== ORIGIN || u.username || u.password || !allowedPaths.has(path.replace(/^\/orestar\//, "")))
        throw err("unsupported source URL");
    return u;
}
function publicUrl(raw: string): string {
    const u = url(raw);
    u.pathname = u.pathname.replace(/;JSESSIONID(?:_ORESTAR)?=[^/;]+/gi, "");
    for (const k of [...u.searchParams.keys()])
        if (/csrf|token|cookie|authorization|session/i.test(k))
            u.searchParams.delete(k);
    return u.toString();
}
function requestFields(body: BodyInit | null | undefined): Readonly<Record<string, string>> {
    if (body == null)
        return Object.freeze({});
    if (typeof body !== "string" && !(body instanceof URLSearchParams))
        throw err("unsupported request body");
    const fields: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(String(body))) {
        if (/csrf|token|cookie|authorization|session/i.test(k))
            continue;
        if (Object.hasOwn(fields, k))
            throw err("duplicate semantic request field");
        fields[k] = v;
    }
    return Object.freeze(fields);
}
function attribute(tag: string, name: string): string | null {
    const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([^]*?)\\1`, "i").exec(tag);
    return m?.[2].replace(/&amp;/gi, "&").replace(/&quot;/gi, '"') ?? null;
}
const normalized = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
function exactFinancialCriteria(criteria: string, expected: Record<string, string>): void {
    const fields: Record<string, string> = {};
    for (const clause of criteria.split(",").map(x => x.trim()).filter(Boolean)) {
        const m = /^([^=]+)=([^=]+)$/.exec(clause);
        if (!m)
            throw err("unrecognized published financial criteria");
        const key = m[1].trim();
        if (Object.hasOwn(fields, key))
            throw err("duplicate published financial criteria");
        fields[key] = m[2].trim();
    }
    if (Object.keys(fields).length !== Object.keys(expected).length || Object.entries(expected).some(([k, v]) => fields[k] !== v))
        throw err("published financial criteria contradict request scope");
}
export function createOregonVerifiedSourceClient(options: OregonVerifiedSourceClientOptions = {}) {
    const timeoutMs = positive(options.timeoutMs ?? 90000, "timeoutMs");
    const htmlCap = positive(options.maxHtmlBytes ?? 8 * 1024 * 1024, "maxHtmlBytes");
    const workbookCap = positive(options.maxWorkbookBytes ?? 16 * 1024 * 1024, "maxWorkbookBytes");
    const requestCap = positive(options.maxRequests ?? 1000, "maxRequests");
    const totalCap = positive(options.maxTotalBytes ?? 128 * 1024 * 1024, "maxTotalBytes");
    const fetchFn = options.fetchFn ?? ((u: string, i: RequestInit) => fetch(u, i));
    const userAgent = options.userAgent ?? "Mozilla/5.0 (compatible; voteApp public campaign finance research)";
    if (!userAgent.trim())
        throw err("invalid User-Agent");
    let requestCount = 0;
    let totalBytes = 0;
    let busy = false;
    async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
        if (busy)
            throw err("concurrent methods require separate clients");
        busy = true;
        try {
            return await fn();
        }
        finally {
            busy = false;
        }
    }
    async function request(rawUrl: string, init: RequestInit = {}, workbook = false): Promise<{
        evidence: OregonPacRawEvidence;
        headers: Headers;
    }> {
        const source = url(rawUrl);
        const method = init.method ?? "GET";
        if (method !== "GET" && method !== "POST")
            throw err("unsupported request method");
        const fields = requestFields(init.body);
        if (method === "GET" && Object.keys(fields).length)
            throw err("GET must not carry body fields");
        if (requestCount >= requestCap || totalBytes >= totalCap)
            throw err("generation request/byte budget exhausted");
        requestCount++;
        const headers = new Headers(init.headers);
        headers.set("user-agent", userAgent);
        if (!headers.has("accept"))
            headers.set("accept", workbook ? "application/vnd.ms-excel,*/*" : "text/html,application/xhtml+xml");
        const controller = new AbortController();
        const startedAt = new Date().toISOString();
        const chunks: Uint8Array[] = [];
        let response: OregonVerifiedFetchResponse | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let byteCount = 0;
        let stopped = false;
        let failureKind = "transport";
        const cap = Math.min(workbook ? workbookCap : htmlCap, totalCap - totalBytes);
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                failureKind = "timeout";
                controller.abort();
                reject(err("request/body timed out"));
            }, timeoutMs);
        });
        const work = (async () => {
            response = await fetchFn(source.toString(), {
                ...init,
                method,
                headers,
                redirect: "manual",
                signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
            });
            if (stopped) {
                void response.body?.cancel();
                throw err("request stopped");
            }
            if (!response.body)
                throw err("missing response body");
            reader = response.body.getReader();
            while (true) {
                const part = await reader.read();
                if (stopped)
                    throw err("request stopped");
                if (part.done)
                    break;
                if (!(part.value instanceof Uint8Array))
                    throw err("non-byte response stream");
                totalBytes += part.value.byteLength;
                const available = cap - byteCount;
                if (part.value.byteLength > available) {
                    if (available > 0) {
                        chunks.push(part.value.slice(0, available));
                        byteCount += available;
                    }
                    failureKind = "byte_cap";
                    throw err("response byte cap exceeded");
                }
                chunks.push(part.value.slice());
                byteCount += part.value.byteLength;
            }
            if (!response.ok || response.status !== 200) {
                failureKind = "http";
                throw err("HTTP request failed");
            }
        })();
        let failure: unknown;
        try {
            await Promise.race([work, deadline]);
        }
        catch (e) {
            failure = e;
            stopped = true;
            controller.abort();
            void reader?.cancel().catch(() => {
            });
        }
        finally {
            clearTimeout(timer!);
        }
        const bytes = new Uint8Array(byteCount);
        let offset = 0;
        for (const c of chunks) {
            bytes.set(c, offset);
            offset += c.byteLength;
        }
        const metadata = Object.freeze({
            url: publicUrl(source.toString()),
            method: method as "GET" | "POST",
            requestFields: fields,
            startedAt,
            endedAt: new Date().toISOString(),
            status: response?.status ?? null,
            byteCount,
            sha256: hashOregonVerifiedBytes(bytes)
        });
        const credential = source.pathname.replace(/;JSESSIONID(?:_ORESTAR)?=[^/;]+/gi, "").endsWith("/JavaScriptServlet");
        if (credential)
            await options.onRawResponse?.(Object.freeze({
                kind: "credential_metadata",
                outcome: failure ? "failed" : "complete",
                request: metadata,
                ...(failure ? { failureKind } : {})
            }));
        else if (failure)
            await options.onRawResponse?.(Object.freeze({
                kind: "failed_response",
                outcome: "failed",
                bytes: bytes.slice(),
                request: metadata,
                failureKind
            }));
        else
            await options.onRawResponse?.(Object.freeze({
                kind: "public_response",
                outcome: "complete",
                evidence: Object.freeze({ bytes: bytes.slice(), request: metadata as OregonPacRawEvidence["request"] })
            }));
        if (failure)
            throw err(failureKind === "timeout" ? "request/body timed out" : failureKind === "byte_cap" ? "response byte cap exceeded" : failureKind === "http" ? `HTTP ${response?.status} failed` : "transport failed");
        return { evidence: { bytes, request: metadata as OregonPacRawEvidence["request"] }, headers: response!.headers };
    }
    function bootstrapFetch() {
        return async (u: string, i?: RequestInit) => {
            const r = await request(u, i);
            return {
                ok: true,
                status: 200,
                headers: r.headers,
                text: async () => decodeOregonVerifiedHtmlBytes(r.evidence.bytes),
                arrayBuffer: async () => r.evidence.bytes.slice().buffer
            };
        };
    }
    async function candidateBootstrap(): Promise<{
        actionUrl: string;
        csrfToken: string;
        cookieHeader: string | null;
    }> {
        const r = await request(candidateForm);
        const html = decodeOregonVerifiedHtmlBytes(r.evidence.bytes);
        const forms = [...html.matchAll(/<form\b[^>]*>/gi)].filter(m => attribute(m[0], "name") === "CommitteeSearchDynaFormSecond");
        if (forms.length !== 1)
            throw err("missing unique candidate search form");
        const action = attribute(forms[0][0], "action");
        if (!action)
            throw err("missing candidate form action");
        const actionUrl = url(new URL(action, candidateForm).toString());
        if (!actionUrl.pathname.startsWith("/orestar/CommitteeSearchSecondPage.do"))
            throw err("wrong candidate form action");
        const cookieValues = r.headers.getSetCookie?.() ?? (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")!] : []);
        const cookieHeader = cookieValues.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ") || null;
        const tokens = [...html.matchAll(/<input\b[^>]*>/gi)].filter(m => attribute(m[0], "name") === "OWASP_CSRFTOKEN");
        if (tokens.length > 1)
            throw err("ambiguous candidate token controls");
        let csrfToken = tokens.length ? attribute(tokens[0][0], "value") : null;
        if (!csrfToken) {
            const token = await request(ROOT + "JavaScriptServlet", { method: "POST", headers: {
                    "FETCH-CSRF-TOKEN": "1",
                    referer: candidateForm,
                    ...(cookieHeader ? { cookie: cookieHeader } : {})
                } });
            const text = decodeOregonVerifiedHtmlBytes(token.evidence.bytes).trim();
            const m = /^OWASP_CSRFTOKEN:\s*([^\s]+)\s*$/.exec(text);
            if (!m)
                throw err("invalid candidate bootstrap token");
            csrfToken = m[1];
        }
        return {
            actionUrl: actionUrl.toString(),
            csrfToken,
            cookieHeader
        };
    }
    async function fetchCurrentTransactionLedger(input: OregonVerifiedLedgerInput): Promise<{
        pages: OregonPacRawEvidence[];
        workbook?: OregonPacRawEvidence;
    }> {
        return exclusive(async () => {
            const y = year(input.electionYear);
            const committeeId = input.committeeId === undefined ? "" : numericId(input.committeeId);
            if (!["C", "OD", "E"].includes(input.transactionType) || input.transactionType === "E" && input.independentOnly !== true || input.transactionType !== "E" && input.independentOnly !== undefined)
                throw err("invalid transaction query mode");
            const form = await getOregonOrestarSearchForm({
                fetchFn: bootstrapFetch(),
                timeoutMs,
                userAgent
            });
            if (!form.csrfToken)
                throw err("missing transaction bootstrap token");
            const body = new URLSearchParams({
                cneSearchButtonName: "search",
                cneSearchPageIdx: "0",
                cneSearchFilerCommitteeId: committeeId,
                cneSearchFilerCommitteeTxtSearchType: "C",
                cneSearchContributorTxtSearchType: "C",
                cneSearchTranStartDate: `01/01/${y - 1}`,
                cneSearchTranEndDate: `12/31/${y}`,
                cneSearchTranType: input.transactionType,
                OWASP_CSRFTOKEN: form.csrfToken,
                ...(input.independentOnly ? { cneSearchIndependentInd: "I" } : {})
            });
            const pages: OregonPacRawEvidence[] = [];
            const native: ReturnType<typeof decodeOregonVerifiedTransactionSearch>["rows"] = [];
            const ids = new Set<string>();
            let declared: number | undefined;
            let criteria: string | undefined;
            let exportUrl: string | null = null;
            for (let index = 0; index < 100; index++) {
                body.set("cneSearchPageIdx", String(index));
                body.set("cneSearchButtonName", index ? "next" : "search");
                const r = await request(form.actionUrl, {
                    method: "POST",
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        referer: transactionForm,
                        ...(form.cookieHeader ? { cookie: form.cookieHeader } : {})
                    },
                    body: body.toString()
                });
                const p = decodeOregonVerifiedTransactionSearch(decodeOregonVerifiedHtmlBytes(r.evidence.bytes));
                pages.push(r.evidence);
                exactFinancialCriteria(p.projectedCriteria, {
                    "Tran Start Date": `01/01/${y - 1}`,
                    "Tran End Date": `12/31/${y}`,
                    ...(committeeId ? { "Filer/Committee ID": committeeId } : {})
                });
                if (p.declaredCount >= 5000 || p.displayedLimit !== null && p.declaredCount >= p.displayedLimit)
                    throw err("transaction query hit source cap");
                if (declared !== undefined && (declared !== p.declaredCount || criteria !== p.criteria))
                    throw err("changing native count/criteria");
                declared = p.declaredCount;
                criteria = p.criteria;
                if (index === 0)
                    exportUrl = p.exportUrl;
                for (const row of p.rows) {
                    if (ids.has(row.transactionId))
                        throw err("repeated native transaction ID/page");
                    ids.add(row.transactionId);
                    if (row.date < `${y - 1}-01-01` || row.date > `${y}-12-31` || row.expired || row.deleted || committeeId && row.filerCommitteeId !== null && row.filerCommitteeId !== committeeId)
                        throw err("native row contradicts current query");
                    native.push(row);
                }
                if (native.length === declared)
                    break;
                if (!p.rows.length || !p.hasNextPage || native.length > declared)
                    throw err("incomplete native transaction pages");
            }
            if (native.length !== declared)
                throw err("incomplete native transaction scope");
            if (declared === 0 && !exportUrl)
                return { pages };
            if (!exportUrl)
                throw err("missing complete transaction workbook");
            const raw = await request(exportUrl, { headers: {
                    accept: "application/vnd.ms-excel,*/*",
                    referer: form.actionUrl,
                    ...(form.cookieHeader ? { cookie: form.cookieHeader } : {})
                } }, true);
            const w = decodeOregonVerifiedTransactionWorkbook(raw.evidence.bytes, { mode: "current", ...(committeeId ? { expectedCommitteeId: committeeId } : {}) });
            if (w.rows.length !== declared || new Set(w.rows.map(x => x.transactionId)).size !== w.rows.length)
                throw err("workbook count/ID mismatch");
            const map = new Map(w.rows.map(r => [r.transactionId, r]));
            for (const n of native) {
                const r = map.get(n.transactionId);
                if (!r || r.date !== n.date || r.amountCents !== n.amountCents || r.status !== n.status || r.subType !== n.subType || normalized(r.rawFields.Filer) !== normalized(n.filerName) || normalized(r.rawFields["Contributor/Payee"]) !== normalized(n.projectedName) || n.filerCommitteeId !== null && r.filerCommitteeId !== n.filerCommitteeId)
                    throw err("native/workbook full identity mismatch");
            }
            return { pages, workbook: raw.evidence };
        });
    }
    async function fetchCandidateDirectory(input: {
        yearActive: number;
    }): Promise<{
        pages: OregonPacRawEvidence[];
    }> {
        return exclusive(async () => {
            const y = year(input.yearActive);
            const form = await candidateBootstrap();
            const body = new URLSearchParams({
                yearActive: String(y),
                election: "",
                filerType: "CANDALL",
                committeeOffice: "",
                locationLevel: "",
                partyAffiliation: "",
                controlledCommCanLastName: "",
                discontinuedSOO: "on",
                approvedSOO: "on",
                pendingApprovalSOO: "on",
                insufficientSOO: "on",
                resolvedSOO: "on",
                rejectedSOO: "on",
                buttonName: "electionSearch",
                search: "Submit",
                OWASP_CSRFTOKEN: form.csrfToken
            });
            const r = await request(form.actionUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    referer: candidateForm,
                    ...(form.cookieHeader ? { cookie: form.cookieHeader } : {})
                },
                body: body.toString()
            });
            const p = decodeOregonVerifiedCandidateDirectory(decodeOregonVerifiedHtmlBytes(r.evidence.bytes));
            const canonical = (s: string) => normalized(s).replace(/\s*([,=])\s*/g, "$1");
            const expected = `Election Year=${y}, Type of Commitee=Candidate Committee (All), Discontinued, Approved, Pending Approval, Pending Insufficient, Pending Resolved, Rejected Filings`;
            if (canonical(p.criteria) !== canonical(expected))
                throw err("published candidate criteria contradict all-status scope");
            if (p.declaredCount >= 999 || p.hasNextPage || p.rows.length !== p.declaredCount || new Set(p.rows.map(x => x.committeeId)).size !== p.rows.length)
                throw err("candidate directory capped/incomplete/ambiguous capture");
            return { pages: [r.evidence] };
        });
    }
    async function fetchTransactionDetail(input: {
        transactionId: string;
    }): Promise<OregonPacRawEvidence> {
        return exclusive(async () => {
            const id = numericId(input.transactionId);
            const r = await request(ROOT + "gotoPublicTransactionDetail.do?tranRsn=" + id);
            if (decodeOregonVerifiedTransactionDetail(decodeOregonVerifiedHtmlBytes(r.evidence.bytes)).transactionId !== id)
                throw err("wrong transaction detail identity");
            return r.evidence;
        });
    }
    async function fetchTransactionHistory(input: {
        transactionId: string;
    }): Promise<OregonPacRawEvidence> {
        return exclusive(async () => {
            const id = numericId(input.transactionId);
            const r = await request(ROOT + "ceTransactionHistory.do?tranRsn=" + id);
            if (decodeOregonVerifiedTransactionHistory(decodeOregonVerifiedHtmlBytes(r.evidence.bytes)).transactionId !== id)
                throw err("wrong transaction history identity");
            return r.evidence;
        });
    }
    async function fetchSoo(input: {
        publicCommitteeId: string;
        qualifiedSooRsn?: never;
    } | {
        qualifiedSooRsn: string;
        publicCommitteeId?: never;
    }): Promise<OregonPacRawEvidence> {
        return exclusive(async () => {
            if (Boolean(input.publicCommitteeId) === Boolean(input.qualifiedSooRsn))
                throw err("SOO requires one exact reference");
            const field = input.publicCommitteeId ? "cneCommitteeId" : "sooRsn";
            const id = numericId(input.publicCommitteeId ?? input.qualifiedSooRsn!);
            const r = await request(ROOT + `sooDetail.do?${field}=${id}`);
            const s = decodeOregonVerifiedSoo(decodeOregonVerifiedHtmlBytes(r.evidence.bytes));
            if (field === "cneCommitteeId" && s.committeeId !== id || field === "sooRsn" && s.sourceSooRsn !== null && s.sourceSooRsn !== id)
                throw err("wrong SOO identity");
            return r.evidence;
        });
    }
    return {
        fetchCurrentTransactionLedger,
        fetchCandidateDirectory,
        fetchTransactionDetail,
        fetchTransactionHistory,
        fetchSoo
    };
}

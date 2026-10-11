import { oregonVerifiedCandidateOfficeLine } from "./oregonVerifiedCandidateContext.js";
import { decodeOregonVerifiedTransactionWorkbook, decodeOregonVerifiedTransactionSearch, decodeOregonVerifiedTransactionDetail, decodeOregonVerifiedSoo, fingerprintOregonVerifiedRows, hashOregonVerifiedBytes, type OregonVerifiedTransactionRow, type OregonVerifiedDetail, type OregonVerifiedSoo, } from "./oregonVerifiedSourceDecoders.js";
export type OregonPacRawEvidence = {
    bytes: Uint8Array;
    request: {
        url: string;
        method: "GET" | "POST";
        requestFields: Readonly<Record<string, string>>;
        startedAt: string;
        endedAt: string;
        status: number;
        byteCount: number;
        sha256: string;
    };
};
export type OregonPacCandidateContext = {
    candidateId: string;
    electionId: string;
    committeeId: string;
    candidateName: string;
    electionYear: number;
    electionType: "General";
    officeName: string;
    district: string | null;
};
export type OregonPacSnapshot = {
    contributions: {
        pages: readonly OregonPacRawEvidence[];
        workbook: OregonPacRawEvidence;
    };
    otherDisbursements: {
        pages: readonly OregonPacRawEvidence[];
    };
    receivingSoo: OregonPacRawEvidence;
    typedCashDetails: readonly OregonPacRawEvidence[];
    donorSoos: readonly OregonPacRawEvidence[];
};
export type OregonVerifiedPacGift = {
    transactionId: string;
    originalId: string;
    donorCommitteeId: string;
    date: string;
    amountCents: number;
    identityFingerprint: string;
};
export type OregonVerifiedPacProvenance = {
    version: 1;
    candidateContext: OregonPacCandidateContext;
    windowStart: string;
    windowEnd: string;
    scope: "current_named_registered_pac_cash";
    unclassifiedMiscCashAmountCents: number;
    unclassifiedMiscCashCount: number;
    fullCurrentCashFingerprint: string;
    gifts: readonly OregonVerifiedPacGift[];
    sourceHashes: readonly string[];
};
export type OregonVerifiedPacDonor = {
    committeeId: string;
    committeeName: string;
    committeeType: "Political Action Committee";
    amount: number;
    contributionCount: number;
    sourceUrl: string;
};
export type OregonVerifiedPacInput = {
    candidateContext: OregonPacCandidateContext;
    windowStart: string;
    windowEnd: string;
    before: OregonPacSnapshot;
    after: OregonPacSnapshot;
    priorProvenance?: unknown;
};
const ORIGIN = "https://secure.sos.state.or.us";
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const norm = (s: string): string => s.normalize("NFKC").toUpperCase().replace(/\s+/gu, " ").trim();
const canonical = (v: unknown): string => fingerprintOregonVerifiedRows([v]);
function fail(message: string): never { throw new Error(`Oregon PAC source: ${message}`); }
function positiveId(v: unknown): v is string { return typeof v === "string" && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)); }
function iso(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        fail("invalid scope date");
    const d = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
        fail("invalid calendar scope date");
    return value;
}
function sameName(a: string, b: string): boolean {
    const display = (s: string): string => { const p = s.split(","); return p.length === 2 ? norm(`${p[1]} ${p[0]}`) : norm(s); };
    return display(a) === display(b);
}
function evidence(e: OregonPacRawEvidence, path: string, method: "GET" | "POST", query?: Record<string, string>): string {
    if (!e || !(e.bytes instanceof Uint8Array))
        fail("missing genuine raw evidence");
    const r = e.request, u = new URL(r.url);
    if (u.origin !== ORIGIN || u.username || u.password || u.hash || u.pathname !== `/orestar/${path}` || r.method !== method || r.status !== 200 ||
        !HASH.test(r.sha256) || hashOregonVerifiedBytes(e.bytes) !== r.sha256 || r.byteCount !== e.bytes.byteLength ||
        r.byteCount < 1 || r.byteCount > 64 * 1024 * 1024)
        fail("invalid request-bound raw evidence");
    if (!r.requestFields || Object.entries(r.requestFields).some(([k, v]) => /cookie|token|authorization/i.test(k) || typeof v !== "string"))
        fail("credential-bearing source metadata");
    if (!Number.isFinite(Date.parse(r.startedAt)) || !Number.isFinite(Date.parse(r.endedAt)) || Date.parse(r.startedAt) > Date.parse(r.endedAt))
        fail("invalid capture interval");
    if (query) {
        if ([...u.searchParams.keys()].length !== Object.keys(query).length || Object.entries(query).some(([k, v]) => u.searchParams.getAll(k).length !== 1 || u.searchParams.get(k) !== v))
            fail("wrong exact source URL identity");
    }
    else if (u.search)
        fail("unexpected source URL query");
    return path === "XcelCNESearch" ? "" : new TextDecoder("utf-8", { fatal: true }).decode(e.bytes);
}
function allEvidence(s: OregonPacSnapshot): OregonPacRawEvidence[] {
    return [...s.contributions.pages, s.contributions.workbook, ...s.otherDisbursements.pages, s.receivingSoo, ...s.typedCashDetails, ...s.donorSoos];
}
function ledger(s: OregonPacSnapshot, input: OregonVerifiedPacInput) {
    const committeeId = input.candidateContext.committeeId;
    const parsePages = (pages: readonly OregonPacRawEvidence[], type: "C" | "OD") => {
        if (!pages.length)
            fail(`missing ${type} current native pages`);
        let declared: number | undefined, criteria: string | undefined, projectedCriteria: string | undefined;
        const rows: ReturnType<typeof decodeOregonVerifiedTransactionSearch>["rows"] = [];
        for (let i = 0; i < pages.length; i++) {
            const e = pages[i], fields = e.request.requestFields;
            const expected = { cneSearchFilerCommitteeId: committeeId, cneSearchTranType: type, cneSearchTranStartDate: us(input.windowStart), cneSearchTranEndDate: us(input.windowEnd), cneSearchPageIdx: String(i), cneSearchButtonName: i ? "next" : "search" };
            if (Object.entries(expected).some(([k, v]) => fields[k] !== v))
                fail(`wrong ${type} financial request scope`);
            const allowed = new Set([...Object.keys(expected), "cneSearchFilerCommitteeTxtSearchType", "cneSearchContributorTxtSearchType"]);
            for (const [k, v] of Object.entries(fields))
                if (!allowed.has(k) && v !== "")
                    fail(`unproved ${type} restrictive request field`);
            if (["cneSearchFilerCommitteeTxtSearchType", "cneSearchContributorTxtSearchType"].some(k => fields[k] !== undefined && fields[k] !== "C"))
                fail("unsupported name search scope");
            const p = decodeOregonVerifiedTransactionSearch(evidence(e, "gotoPublicTransactionSearchResults.do", "POST"));
            if (p.declaredCount >= 5000 || p.displayedLimit !== null && p.declaredCount >= p.displayedLimit)
                fail(`capped/partial ${type} native search`);
            if (declared !== undefined && (declared !== p.declaredCount || criteria !== p.criteria))
                fail(`changing ${type} native pages`);
            declared = p.declaredCount;
            criteria = p.criteria;
            projectedCriteria = p.projectedCriteria;
            rows.push(...p.rows);
        }
        const published = (projectedCriteria ?? "").split(",").map(v => v.trim()).filter(Boolean).map(v => {
            const at = v.indexOf("=");
            return [v.slice(0, at).trim(), v.slice(at + 1).trim()] as const;
        });
        const values = new Map(published);
        if (published.length !== 3 || values.size !== 3 || values.get("Tran Start Date") !== us(input.windowStart) || values.get("Tran End Date") !== us(input.windowEnd) || values.get("Filer/Committee ID") !== committeeId)
            fail("native response query mismatch");
        if (rows.length !== declared || new Set(rows.map(r => r.transactionId)).size !== rows.length)
            fail(`duplicate/incomplete ${type} native IDs`);
        for (const r of rows)
            if (!positiveId(r.transactionId) || r.filerCommitteeId !== committeeId || r.sourceFilerReference.kind !== "public_committee" || r.sourceFilerReference.id !== committeeId || r.expired || r.deleted || r.date < input.windowStart || r.date > input.windowEnd || !Number.isSafeInteger(r.amountCents) || r.amountCents < 0)
                fail(`invalid current ${type} native identity`);
        return { rows, criteria };
    };
    const native = parsePages(s.contributions.pages, "C"), od = parsePages(s.otherDisbursements.pages, "OD");
    if (od.rows.length)
        fail("nonempty OtherDisbursement coverage preserves PAC");
    evidence(s.contributions.workbook, "XcelCNESearch", "GET");
    const workbook = decodeOregonVerifiedTransactionWorkbook(s.contributions.workbook.bytes, { expectedCommitteeId: committeeId, mode: "current" });
    if (workbook.rows.length !== native.rows.length || new Set(workbook.rows.map(r => r.transactionId)).size !== workbook.rows.length)
        fail("duplicate/incomplete workbook occurrence IDs");
    const byId = new Map(workbook.rows.map(r => [r.transactionId, r]));
    for (const n of native.rows) {
        const w = byId.get(n.transactionId);
        if (!w || w.date !== n.date || w.status !== n.status || w.subType !== n.subType || w.amountCents !== n.amountCents ||
            norm(String(w.rawFields["Contributor/Payee"] ?? "")) !== norm(n.projectedName) || norm(String(w.rawFields.Filer ?? "")) !== norm(n.filerName) ||
            !["Cash Contribution", "In-Kind Contribution", "In-Kind/Forgiven Personal Expenditures"].includes(w.subType) || w.expired || w.deleted || !Number.isSafeInteger(w.amountCents) || w.amountCents < 0)
            fail(`native/workbook identity mismatch ${n.transactionId}`);
    }
    return { rows: workbook.rows, nativeFingerprint: canonical(native), odFingerprint: canonical(od), rawFingerprint: fingerprintOregonVerifiedRows(workbook.rows.map(r => r.rawFields)) };
}
function us(s: string): string { return `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`; }
function soo(e: OregonPacRawEvidence, id: string): OregonVerifiedSoo {
    const s = decodeOregonVerifiedSoo(evidence(e, "sooDetail.do", "GET", { cneCommitteeId: id }));
    if (s.committeeId !== id)
        fail("wrong SOO public committee ID");
    return s;
}
function semanticSoo(s: OregonVerifiedSoo): string { const { sha256, ...identity } = s; return canonical(identity); }
function semanticDetail(s: OregonVerifiedDetail): string { const { sha256, ...identity } = s; return canonical(identity); }
function receiving(s: OregonVerifiedSoo, c: OregonPacCandidateContext): void {
    const office = oregonVerifiedCandidateOfficeLine(c);
    if (office === null)
        fail("unsupported receiving office/seat");
    if (s.committeeType !== "Candidate Committee" || !s.candidateName || !sameName(s.candidateName, c.candidateName) ||
        norm(s.electionOfficeLines.join(" ")) !== norm(`${c.electionYear} ${c.electionType} Election ${office}`))
        fail("receiving candidate/election/office/seat SOO mismatch");
}
function detailMap(rows: readonly OregonPacRawEvidence[]): Map<string, OregonVerifiedDetail> {
    const m = new Map<string, OregonVerifiedDetail>();
    for (const e of rows) {
        const u = new URL(e.request.url), id = u.searchParams.get("tranRsn");
        if (!positiveId(id))
            fail("missing financial detail source ID");
        const d = decodeOregonVerifiedTransactionDetail(evidence(e, "gotoPublicTransactionDetail.do", "GET", { tranRsn: id }));
        if (d.transactionId !== id || m.has(id))
            fail("duplicate/wrong detail ID");
        m.set(id, d);
    }
    return m;
}
function donorMap(rows: readonly OregonPacRawEvidence[]): Map<string, OregonVerifiedSoo> {
    const m = new Map<string, OregonVerifiedSoo>();
    for (const e of rows) {
        const id = new URL(e.request.url).searchParams.get("cneCommitteeId");
        if (!positiveId(id) || m.has(id))
            fail("duplicate/invalid donor SOO");
        m.set(id, soo(e, id));
    }
    return m;
}
function address(w: OregonVerifiedTransactionRow): readonly string[] {
    const r = w.rawFields;
    const country = norm(String(r.Country ?? "")), foreign = String(r["Foreign Postal Code"] ?? "").trim();
    if (country !== "" && country !== "UNITED STATES" || foreign !== "")
        fail("unsupported foreign donor address projection");
    const rawZip = String(r.Zip ?? "").trim(), plus = String(r["Zip Plus Four"] ?? "").trim();
    if (!/^\d{1,5}$/.test(rawZip) || plus !== "" && !/^\d{4}$/.test(plus))
        fail("unsupported domestic ZIP projection");
    const zip = rawZip.padStart(5, "0");
    const city = String(r.City ?? "").trim(), state = String(r.State ?? "").trim();
    const postal = `${zip}${plus ? `-${plus}` : ""}`;
    // The official detail publishes space-separated locality; retain the existing comma presentation too.
    // Only these separators vary. Every street/address2/city/state/postal component keeps its punctuation.
    return [`${city}, ${state} ${postal}`, `${city} ${state} ${postal}`].map(locality =>
        norm([r["Addr Line1"], r["Addr Line2"], locality].map(v => String(v ?? "")).join(" ")));
}
function bindDetail(w: OregonVerifiedTransactionRow, d: OregonVerifiedDetail): void {
    if (d.filerCommitteeId !== w.filerCommitteeId || d.transactionId !== w.transactionId || d.date !== w.date || d.amountCents !== w.amountCents ||
        d.transactionType !== "Contribution" || d.subType !== "Cash Contribution" || d.bookType !== "Political Committee" || !d.name ||
        norm(d.name) !== norm(String(w.rawFields["Contributor/Payee"] ?? "")) || norm(d.filerName) !== norm(String(w.rawFields.Filer ?? "")) ||
        !address(w).includes(norm(d.addressLines.join(" "))) || d.expired || d.deleted || d.processStatus !== "Complete" || d.versionStatus !== w.status ||
        d.mechanisms.length || d.refundAssociations.length)
        fail(`typed cash detail/full workbook mismatch ${w.transactionId}`);
}
function validProvenance(value: unknown, expected: OregonPacCandidateContext): value is OregonVerifiedPacProvenance {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return false;
        const p = value as OregonVerifiedPacProvenance, c = p.candidateContext;
        if (!c || !UUID.test(c.candidateId) || !UUID.test(c.electionId) || !positiveId(c.committeeId) || typeof c.candidateName !== "string" || !c.candidateName.trim() || !Number.isInteger(c.electionYear) || c.electionYear < 1900 || c.electionYear > 2100 || c.electionType !== "General" || oregonVerifiedCandidateOfficeLine(c) === null || canonical(c) !== canonical(expected))
            return false;
        if (p.version !== 1 || p.scope !== "current_named_registered_pac_cash" || iso(p.windowStart) > iso(p.windowEnd) || typeof p.fullCurrentCashFingerprint !== "string" || !HASH.test(p.fullCurrentCashFingerprint) || !Number.isSafeInteger(p.unclassifiedMiscCashAmountCents) || p.unclassifiedMiscCashAmountCents < 0 || !Number.isSafeInteger(p.unclassifiedMiscCashCount) || p.unclassifiedMiscCashCount < 0 || p.unclassifiedMiscCashCount > 2147483647 || p.unclassifiedMiscCashCount === 0 && p.unclassifiedMiscCashAmountCents !== 0 || !Array.isArray(p.sourceHashes) || !p.sourceHashes.length || p.sourceHashes.some(h => typeof h !== "string" || !HASH.test(h)) || !Array.isArray(p.gifts) || !p.gifts.length && p.unclassifiedMiscCashAmountCents > 0)
            return false;
        const seen = new Set<string>();
        let total = 0;
        for (const g of p.gifts) {
            if (!g || !positiveId(g.transactionId) || g.originalId !== g.transactionId || seen.has(g.transactionId) || !positiveId(g.donorCommitteeId) || g.donorCommitteeId === c.committeeId || !Number.isSafeInteger(g.amountCents) || g.amountCents < 1 || typeof g.identityFingerprint !== "string" || !HASH.test(g.identityFingerprint) || iso(g.date) < p.windowStart || g.date > p.windowEnd)
                return false;
            seen.add(g.transactionId);
            total += g.amountCents;
            if (!Number.isSafeInteger(total) || seen.size > 2147483647)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
/** Persistence validates materialized money against source gift authority, never a legacy snapshot. */
export function validateOregonVerifiedPacProvenance(input: {
    provenance: unknown;
    donors: unknown;
    expectedContext: OregonPacCandidateContext;
}): boolean {
    try {
        if (!validProvenance(input.provenance, input.expectedContext) || !Array.isArray(input.donors))
            return false;
        const groups = new Map<string, {
            cents: number;
            count: number;
        }>();
        for (const g of input.provenance.gifts) {
            const a = groups.get(g.donorCommitteeId) ?? { cents: 0, count: 0 };
            a.cents += g.amountCents;
            a.count++;
            if (!Number.isSafeInteger(a.cents) || a.count > 2147483647)
                return false;
            groups.set(g.donorCommitteeId, a);
        }
        if (input.donors.length !== groups.size)
            return false;
        const seen = new Set<string>();
        for (const d of input.donors) {
            if (!d || !positiveId(d.committeeId) || seen.has(d.committeeId) || typeof d.committeeName !== "string" || !d.committeeName.trim() || d.committeeType !== "Political Action Committee" || typeof d.amount !== "number" || !Number.isFinite(d.amount) || d.amount <= 0 || !Number.isInteger(d.contributionCount) || d.contributionCount < 1 || d.contributionCount > 2147483647 || d.sourceUrl !== `${ORIGIN}/orestar/sooDetail.do?cneCommitteeId=${d.committeeId}`)
                return false;
            const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(d.amount)), g = groups.get(d.committeeId);
            if (!parts || !g)
                return false;
            const cents = Number(parts[1]) * 100 + Number((parts[2] ?? "").padEnd(2, "0"));
            if (!Number.isSafeInteger(cents) || cents / 100 !== d.amount || g.cents !== cents || g.count !== d.contributionCount)
                return false;
            seen.add(d.committeeId);
        }
        return true;
    }
    catch {
        return false;
    }
}
function prior(p: unknown, input: OregonVerifiedPacInput, gifts: readonly OregonVerifiedPacGift[]): void {
    if (p === undefined || p === null)
        return;
    if (!p || typeof p !== "object" || Array.isArray(p))
        fail("invalid prior PAC authority");
    if (!validProvenance(p, input.candidateContext))
        fail("invalid prior PAC authority");
    const x = p as OregonVerifiedPacProvenance;
    if (x.windowStart !== input.windowStart || x.windowEnd !== input.windowEnd)
        fail("incompatible prior PAC scope");
    const current = new Map(gifts.map(g => [g.transactionId, g])), seen = new Set<string>();
    for (const g of x.gifts) {
        if (!g || !positiveId(g.transactionId) || g.originalId !== g.transactionId || !positiveId(g.donorCommitteeId) || seen.has(g.transactionId) ||
            !Number.isSafeInteger(g.amountCents) || g.amountCents < 1 || !HASH.test(g.identityFingerprint) || iso(g.date) < input.windowStart || g.date > input.windowEnd ||
            canonical(current.get(g.transactionId)) !== canonical(g))
            fail(`prior accepted gift disappeared/changed ${g?.transactionId ?? "unknown"}`);
        seen.add(g.transactionId);
    }
}
export function verifyOregonCurrentPacSource(input: OregonVerifiedPacInput): {
    pacDonors?: readonly OregonVerifiedPacDonor[];
    provenance?: OregonVerifiedPacProvenance;
    diagnostics: readonly string[];
} {
    try {
        const c = input.candidateContext;
        if (!UUID.test(c.candidateId) || !UUID.test(c.electionId) || !positiveId(c.committeeId) || !c.candidateName.trim() || !Number.isInteger(c.electionYear) || c.electionType !== "General" || !c.officeName.trim() || c.district !== null && !positiveId(c.district))
            fail("invalid local receiving context");
        iso(input.windowStart);
        iso(input.windowEnd);
        if (input.windowStart > input.windowEnd)
            fail("reversed current cash window");
        const before = ledger(input.before, input), after = ledger(input.after, input);
        if (before.rawFingerprint !== after.rawFingerprint || before.nativeFingerprint !== after.nativeFingerprint || before.odFingerprint !== after.odFingerprint)
            fail("current whole cash publication changed");
        const rb = soo(input.before.receivingSoo, c.committeeId), ra = soo(input.after.receivingSoo, c.committeeId);
        receiving(rb, c);
        receiving(ra, c);
        if (semanticSoo(rb) !== semanticSoo(ra))
            fail("receiving SOO changed");
        const db = detailMap(input.before.typedCashDetails), da = detailMap(input.after.typedCashDetails), sb = donorMap(input.before.donorSoos), sa = donorMap(input.after.donorSoos);
        const groups = new Map<string, {
            name: string;
            cents: number;
            count: number;
        }>(), gifts: OregonVerifiedPacGift[] = [];
        const typed = before.rows.filter(w => w.subType === "Cash Contribution" && w.bookType === "Political Committee");
        let unclassifiedMiscCashAmountCents = 0, unclassifiedMiscCashCount = 0;
        for (const w of before.rows)
            if (w.subType === "Cash Contribution") {
                if (w.bookType === null && w.payeeCommitteeId === null && String(w.rawFields["Contributor/Payee"] ?? "").trim() === "Miscellaneous Cash Contributions $100 and under") {
                    unclassifiedMiscCashAmountCents += w.amountCents;
                    unclassifiedMiscCashCount++;
                    if (!Number.isSafeInteger(unclassifiedMiscCashAmountCents) || unclassifiedMiscCashCount > 2147483647)
                        fail("unsafe unclassified miscellaneous cash");
                }
                else if (!["Individual", "Business Entity", "Political Committee"].includes(w.bookType ?? ""))
                    fail(`unknown cash source class ${w.transactionId}`);
            }
        if (db.size !== typed.length || da.size !== typed.length)
            fail("missing/extraneous closing typed cash detail evidence");
        const used = new Set<string>();
        let totalCents = 0;
        for (const w of typed) {
            if (!w.payeeCommitteeId || !positiveId(w.payeeCommitteeId))
                fail(`missing explicit typed donor ID ${w.transactionId}`);
            const b = db.get(w.transactionId), a = da.get(w.transactionId);
            if (!b || !a)
                fail(`missing closing detail ${w.transactionId}`);
            bindDetail(w, b);
            bindDetail(w, a);
            if (semanticDetail(b) !== semanticDetail(a))
                fail(`financial detail changed ${w.transactionId}`);
            const donorBefore = sb.get(w.payeeCommitteeId), donorAfter = sa.get(w.payeeCommitteeId);
            if (!donorBefore || !donorAfter || semanticSoo(donorBefore) !== semanticSoo(donorAfter))
                fail(`missing/changed donor SOO ${w.payeeCommitteeId}`);
            used.add(w.payeeCommitteeId);
            if (w.payeeCommitteeId === c.committeeId || donorBefore.committeeType === "Candidate Committee" || donorBefore.committeeType === "Political Party Committee")
                continue;
            if (donorBefore.committeeType !== "Political Action Committee")
                fail(`unsupported donor SOO class ${w.payeeCommitteeId}`);
            if (w.status !== "Original" || w.originalId !== w.transactionId || w.amountCents < 1)
                fail(`unsupported PAC current lineage/amount ${w.transactionId}`);
            totalCents += w.amountCents;
            if (!Number.isSafeInteger(totalCents))
                fail("unsafe total PAC cents");
            gifts.push({ transactionId: w.transactionId, originalId: w.originalId, donorCommitteeId: w.payeeCommitteeId, date: w.date, amountCents: w.amountCents, identityFingerprint: canonical([w.rawFields, { ...b, sha256: undefined }]) });
            const g = groups.get(w.payeeCommitteeId) ?? { name: donorBefore.committeeName, cents: 0, count: 0 };
            g.cents += w.amountCents;
            g.count++;
            if (!Number.isSafeInteger(g.cents) || g.count > 2147483647)
                fail("unsafe PAC amount/count");
            groups.set(w.payeeCommitteeId, g);
        }
        if (sb.size !== used.size || sa.size !== used.size)
            fail("extraneous/duplicate donor SOO scope");
        const opening = allEvidence(input.before), closing = allEvidence(input.after);
        if (Math.max(...opening.map(e => Date.parse(e.request.endedAt))) > Math.min(...closing.map(e => Date.parse(e.request.startedAt))))
            fail("source opening/closing interval overlaps");
        prior(input.priorProvenance, input, gifts);
        const diagnostics = unclassifiedMiscCashCount ? [`Known named registered PAC cash only; ${unclassifiedMiscCashCount} unclassified miscellaneous cash occurrences / ${unclassifiedMiscCashAmountCents} cents retained without donor attribution`] : [];
        if (!gifts.length && unclassifiedMiscCashAmountCents > 0)
            return { diagnostics: [...diagnostics, "Anonymous-only cash cannot prove an empty PAC snapshot"] };
        const pacDonors = [...groups].map(([committeeId, g]) => {
            const amount = g.cents / 100;
            if (Math.round(amount * 100) !== g.cents)
                fail("lossy PAC dollar conversion");
            return { committeeId, committeeName: g.name, committeeType: "Political Action Committee" as const, amount, contributionCount: g.count, sourceUrl: `${ORIGIN}/orestar/sooDetail.do?cneCommitteeId=${committeeId}` };
        });
        const provenance: OregonVerifiedPacProvenance = { version: 1, candidateContext: { ...c }, windowStart: input.windowStart, windowEnd: input.windowEnd, scope: "current_named_registered_pac_cash", unclassifiedMiscCashAmountCents, unclassifiedMiscCashCount, fullCurrentCashFingerprint: before.rawFingerprint, gifts, sourceHashes: [...new Set([...opening, ...closing].map(e => e.request.sha256))] };
        if (!validateOregonVerifiedPacProvenance({ provenance, donors: pacDonors, expectedContext: c }))
            fail("invalid constructed PAC authority");
        return { pacDonors, provenance, diagnostics };
    }
    catch (error) {
        return { diagnostics: [error instanceof Error ? error.message : String(error)] };
    }
}

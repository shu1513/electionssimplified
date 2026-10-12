import { createHash } from "node:crypto";
import { read, utils } from "xlsx";
/** Decoding only: query membership, currentness and financial acceptance belong to the verifier. */
export type OregonVerifiedRawValue = string | number | boolean | null;
export type OregonVerifiedRawFields = Record<string, OregonVerifiedRawValue>;
export const OREGON_VERIFIED_TRANSACTION_HEADERS = [
    "Tran Id",
    "Original Id",
    "Tran Date",
    "Tran Status",
    "Filer",
    "Contributor/Payee",
    "Sub Type",
    "Payer of Personal Expenditure",
    "Amount",
    "Aggregate Amount",
    "Contributor/Payee Committee ID",
    "Filer Id",
    "Attest By Name",
    "Attest Date",
    "Review By Name",
    "Review Date",
    "Due Date",
    "Occptn Ltr Date",
    "Pymt Sched Txt",
    "Purp Desc",
    "Intrst Rate",
    "Check Nbr",
    "Tran Stsfd Ind",
    "Filed By Name",
    "Filed Date",
    "Addr book Agent Name",
    "Book Type",
    "Title Txt",
    "Occptn Txt",
    "Emp Name",
    "Emp City",
    "Emp State",
    "Employ Ind",
    "Self Employ Ind",
    "Addr Line1",
    "Addr Line2",
    "City",
    "State",
    "Zip",
    "Zip Plus Four",
    "County",
    "Country",
    "Foreign Postal Code",
    "Purpose Codes",
    "Exp Date",
] as const;
export type OregonVerifiedTransactionRow = {
    occurrence: number;
    transactionId: string;
    originalId: string;
    filerCommitteeId: string;
    payeeCommitteeId: string | null;
    date: string;
    status: string;
    subType: string;
    bookType: string | null;
    amountCents: number;
    expired: true | null;
    deleted: true | null;
    rawFields: OregonVerifiedRawFields;
};
export type OregonVerifiedMechanism = {
    occurrence: number;
    mechanism: "independent" | "in_kind";
    supportOppose: "support" | "oppose" | null;
    targetName: string;
    targetCommitteeId: string | null;
    amountCents: number;
    rawText: string;
};
export type OregonVerifiedRefundAssociation = {
    occurrence: number;
    transactionId: string;
    amountCents: number;
    date: string;
    donorName: string;
    status: string;
    rawText: string;
};
export type OregonVerifiedDetail = {
    sha256: string;
    transactionId: string;
    filerCommitteeId: string;
    filerName: string;
    date: string;
    amountCents: number;
    transactionType: string;
    subType: string;
    versionStatus: string;
    processStatus: string;
    expired: true | null;
    deleted: true | null;
    bookType: string | null;
    name: string | null;
    addressLines: string[];
    mechanisms: OregonVerifiedMechanism[];
    refundAssociations: OregonVerifiedRefundAssociation[];
    rawFields: Record<string, string[]>;
};
export type OregonVerifiedSearchRow = {
    occurrence: number;
    transactionId: string;
    date: string;
    status: string;
    expired: true | null;
    deleted: true | null;
    filerCommitteeId: string | null;
    sourceFilerReference: {
        kind: "public_committee" | "internal_filer";
        id: string;
        url: string;
    };
    filerName: string;
    name: string;
    projectedName: string;
    nameDisplayAnnotation: "in_kind" | "out_of_state" | null;
    subType: string;
    amountCents: number;
    detailUrl: string;
    rawCells: string[];
};
export type OregonVerifiedSearchPage = {
    sha256: string;
    criteria: string;
    projectedCriteria: string;
    declaredCount: number;
    displayedLimit: number | null;
    hasNextPage: boolean;
    exportUrl: string | null;
    rows: OregonVerifiedSearchRow[];
};
export type OregonVerifiedHistoryRow = {
    occurrence: number;
    transactionId: string;
    status: string;
    date: string;
    filedDate: string;
    subType: string;
    name: string;
    filedBy: string;
    amountCents: number;
    rawCells: string[];
};
export type OregonVerifiedSoo = {
    sha256: string;
    committeeId: string;
    sourceSooRsn: string | null;
    committeeType: string;
    committeeName: string;
    candidateName: string | null;
    electionOfficeLines: string[];
    rawFields: Record<string, string[]>;
    rawFieldOccurrences: {
        label: string;
        valueLines: string[];
    }[];
    semanticText: string;
};
export type OregonVerifiedCandidateContext = {
    occurrence: number;
    committeeId: string;
    sourceSooRsn: string;
    candidateName: string;
    committeeName: string;
    officePartyLines: string[];
    sourceUrl: string;
    rawCells: string[];
};
export type OregonVerifiedCandidateDirectory = {
    sha256: string;
    criteria: string;
    declaredCount: number;
    hasNextPage: boolean;
    rows: OregonVerifiedCandidateContext[];
};
export type OregonVerifiedDirectoryRequestScope = {
    yearActive: number;
    filerType: "CANDALL";
    discontinued: boolean;
    approved: boolean;
    pendingApproval: boolean;
    pendingInsufficient: boolean;
    pendingResolved: boolean;
    rejected: boolean;
};
const origin = "https://secure.sos.state.or.us";
function fail(message: string): never {
    throw new Error(`ORESTAR verified decoder: ${message}`);
}
const text = (v: unknown): string => v == null ? "" : String(v).trim();
const compact = (v: string): string => v.replace(/\s+/g, " ").trim();
/** Observed public pages declare UTF-8. Never guess another encoding or replace invalid bytes. */
export function decodeOregonVerifiedHtmlBytes(bytes: Uint8Array): string {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const charset = /charset\s*=\s*["']?([a-z0-9-]+)/i.exec(html)?.[1].toLowerCase();
    if (charset && charset !== "utf-8" && charset !== "utf8")
        fail("unsupported declared HTML charset");
    return html;
}
export function hashOregonVerifiedBytes(bytes: Uint8Array | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}
/** Full supplied-value multiset, retaining repeats. Callers project response hashes/ordinal positions out explicitly; no financial identity field is ignored here. */
export function fingerprintOregonVerifiedRows(rows: readonly unknown[]): string {
    const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
    return hashOregonVerifiedBytes(JSON.stringify(rows.map(r => JSON.stringify(canonical(r))).sort()));
}
export function parseOregonVerifiedCents(value: unknown): number {
    if (typeof value === "number") {
        const cents = value * 100;
        if (!Number.isFinite(cents) || !Number.isSafeInteger(Math.round(cents)) || Math.abs(cents - Math.round(cents)) > 1e-7)
            fail("non-exact monetary value");
        return Math.round(cents);
    }
    let s = text(value);
    let negative = false;
    if (/^\(.*\)$/.test(s)) {
        negative = true;
        s = s.slice(1, -1);
    }
    s = s.replace(/^\$/, "");
    if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s))
        fail("invalid monetary value");
    const [whole, fraction = ""] = s.replace(/,/g, "").replace(/^-/, "").split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents))
        fail("unsafe monetary value");
    return negative || s.startsWith("-") ? -cents : cents;
}
export function parseOregonVerifiedDate(value: unknown): string {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text(value));
    if (!match)
        return fail("invalid transaction date");
    const [, mm, dd, yyyy] = match;
    const iso = `${yyyy}-${mm}-${dd}`;
    const date = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
        fail("invalid calendar date");
    return iso;
}
function id(value: unknown, label: string): string {
    const s = text(value);
    if (!/^[1-9]\d*$/.test(s))
        fail(`invalid ${label}`);
    return s;
}
function required(value: unknown, label: string): string {
    const s = text(value);
    if (!s)
        fail(`missing ${label}`);
    return s;
}
function entity(s: string): string {
    const c1: Record<number, number> = {
        128: 8364,
        130: 8218,
        131: 402,
        132: 8222,
        133: 8230,
        134: 8224,
        135: 8225,
        136: 710,
        137: 8240,
        138: 352,
        139: 8249,
        140: 338,
        142: 381,
        145: 8216,
        146: 8217,
        147: 8220,
        148: 8221,
        149: 8226,
        150: 8211,
        151: 8212,
        152: 732,
        153: 8482,
        154: 353,
        155: 8250,
        156: 339,
        158: 382,
        159: 376
    };
    return s.replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => {
        let code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
        code = c1[code] ?? code;
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff)
            return fail("invalid HTML entity");
        return String.fromCodePoint(code);
    }).replace(/&nbsp;/gi, " ").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
}
function lines(s: string): string[] {
    return entity(s.replace(/<!--[^]*?-->/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " "))
        .split(/\n+/).map(compact).filter(Boolean);
}
function visible(s: string): string {
    return compact(lines(s.replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi, "")).join(" "));
}
function attr(s: string, name: string): string | null {
    const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([^]*?)\\1`, "i").exec(s);
    return m ? entity(m[2]) : null;
}
function input(s: string, name: string): string | null {
    const matches = [...s.matchAll(/<input\b[^>]*>/gi)].filter(m => attr(m[0], "name") === name);
    if (matches.length > 1)
        fail(`duplicate hidden ${name}`);
    return matches.length ? attr(matches[0][0], "value") : null;
}
function cells(s: string): {
    html: string;
    lines: string[];
    text: string;
    label: boolean;
}[] {
    return [...s.matchAll(/<t[dh]\b([^>]*)>([^]*?)<\/t[dh]>/gi)].map(m => ({
        html: m[2],
        lines: lines(m[2]),
        text: visible(m[2]),
        label: /\blabel\b/.test(attr(m[1], "class") ?? "")
    }));
}
function fields(s: string): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const row of s.matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)) {
        const c = cells(row[1]);
        for (let i = 0; i < c.length; i++)
            if (c[i].label && c[i].text) {
                const label = c[i].text.replace(/:$/, "").trim();
                let j = i + 1;
                if (c[j]?.text === ":")
                    j++;
                if (!c[j] || c[j].label)
                    fail(`missing value cell for ${label}`);
                if (Object.hasOwn(result, label))
                    fail(`duplicate field ${label}`);
                result[label] = c[j].lines;
            }
    }
    return result;
}
function value(f: Record<string, string[]>, key: string, allowBlank = false): string {
    if (!Object.hasOwn(f, key))
        fail(`missing field ${key}`);
    const v = f[key].join("\n");
    return allowBlank ? v : required(v, key);
}
function href(s: string, pattern: RegExp): string | null {
    const links = [...s.matchAll(/<a\b[^>]*>/gi)].map(m => attr(m[0], "href")).filter((v): v is string => v !== null && pattern.test(v));
    if (!links.length)
        return null;
    const url = new URL(links[0], `${origin}/orestar/`);
    if (url.origin !== origin)
        fail("foreign source URL");
    // Sessions/CSRF are acquisition metadata, not public identity or persisted source URLs.
    url.pathname = url.pathname.replace(/;JSESSIONID_ORESTAR=[^/]+/i, "");
    url.searchParams.delete("OWASP_CSRFTOKEN");
    return url.toString();
}
function next(s: string): boolean {
    return [...s.matchAll(/<input\b[^>]*>/gi)].some(m => attr(m[0], "value") === "Next" && !/\bdisabled\b/i.test(m[0]));
}
function count(s: string): number {
    const matches = [...visible(s).matchAll(/\b([\d,]+)\s+(?:records\s+)?found for the above search criteria/gi)];
    if (matches.length !== 1)
        fail("missing or ambiguous declared result count");
    const n = Number(matches[0][1].replace(/,/g, ""));
    if (!Number.isSafeInteger(n) || n < 0)
        fail("invalid declared count");
    return n;
}
function criteria(s: string): string {
    const m = /Search Criteria\s*:\s*([^]*?)\s*(?:Export To Excel Format\s*)?Results\s*:/i.exec(visible(s));
    return required(m?.[1], "search criteria");
}
function projectedCriteria(html: string, raw: string): string {
    const matches: string[] = [];
    for (const row of html.matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)) {
        const c = cells(row[1]);
        for (let i = 0; i < c.length; i++)
            if (/^Search Criteria\s*:$/.test(c[i].text)) {
                if (!c[i + 1])
                    fail("missing exact criteria value cell");
                const projected = c[i + 1].html.replace(/<font\b([^>]*)>([^]*?)<\/font>/gi, (whole, attributes: string, body: string) => {
                    const color = attr(attributes, "color")?.toLowerCase();
                    const text = visible(body);
                    return color === "green" && text === "*in-kind expenditure" || color === "red" && text === "**out-of-state contributor" ? "" : whole;
                });
                matches.push(required(visible(projected), "criteria value"));
            }
    }
    if (matches.length > 1)
        fail("ambiguous exact criteria value cells");
    return matches[0] ?? raw;
}
function status(s: string): {
    expired: true | null;
    deleted: true | null;
} {
    return { expired: s.includes("*") ? true : null, deleted: /^Deleted\b/i.test(s) ? true : null };
}
export function decodeOregonVerifiedTransactionWorkbook(data: Uint8Array, options: {
    expectedCommitteeId?: string;
    mode: "current" | "historical";
}) {
    if (!(data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4) && !(data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0))
        fail("response is not a workbook");
    const wb = read(new Uint8Array(data), { type: "array", raw: true });
    if (wb.SheetNames.length !== 1)
        fail("unexpected workbook sheets");
    const table = utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
        header: 1,
        raw: true,
        defval: null,
        blankrows: true
    });
    const headers = table.shift();
    if (!headers || headers.length !== OREGON_VERIFIED_TRANSACTION_HEADERS.length || headers.some((h, i) => h !== OREGON_VERIFIED_TRANSACTION_HEADERS[i]))
        fail("unexpected transaction workbook headers");
    const providerNotes: {
        rowNumber: number;
        rawCells: unknown[];
    }[] = [];
    const historicalNote = "You have included expired transactions (i.e., transactions that have been subsequently amended or deleted) in your search.  They are identified by an * in the status column.";
    for (let i = table.length - 1; i >= 0; i--)
        if (table[i][0] === historicalNote) {
            if (options.mode !== "historical" || providerNotes.length || table[i].slice(1).some(v => v !== null))
                fail("unexpected historical explanatory note");
            providerNotes.push({ rowNumber: i + 2, rawCells: [...table[i]] });
            table.splice(i, 1);
        }
    const rows: OregonVerifiedTransactionRow[] = table.map((r, i) => {
        if (r.length > headers.length || r.every(v => v == null))
            fail(`invalid workbook row ${i + 2}`);
        const rawFields: OregonVerifiedRawFields = {};
        headers.forEach((h, j) => {
            const v = r[j] ?? null;
            if (!["string", "number", "boolean"].includes(typeof v) && v !== null)
                fail("non-scalar workbook field");
            rawFields[String(h)] = v as OregonVerifiedRawValue;
        });
        const s = required(rawFields["Tran Status"], "Tran Status");
        const filer = id(rawFields["Filer Id"], "Filer Id");
        if (options.expectedCommitteeId && filer !== options.expectedCommitteeId)
            fail("wrong requested filer");
        if (options.mode === "current" && s.includes("*"))
            fail("expired indicator in current workbook");
        return {
            occurrence: i,
            transactionId: id(rawFields["Tran Id"], "Tran Id"),
            originalId: id(rawFields["Original Id"], "Original Id"),
            filerCommitteeId: filer,
            payeeCommitteeId: text(rawFields["Contributor/Payee Committee ID"]) ? id(rawFields["Contributor/Payee Committee ID"], "payee committee ID") : null,
            date: parseOregonVerifiedDate(rawFields["Tran Date"]),
            status: s,
            subType: required(rawFields["Sub Type"], "Sub Type"),
            bookType: text(rawFields["Book Type"]) || null,
            amountCents: parseOregonVerifiedCents(rawFields.Amount),
            ...status(s),
            rawFields
        };
    });
    return {
        sha256: hashOregonVerifiedBytes(data),
        headers: [...OREGON_VERIFIED_TRANSACTION_HEADERS],
        providerNotes,
        rows
    };
}
export function decodeOregonVerifiedTransactionSearch(html: string): OregonVerifiedSearchPage {
    const declaredCount = count(html);
    const rows: OregonVerifiedSearchRow[] = [];
    const headers = [...html.matchAll(/<th\b[^>]*>([^]*?)<\/th>/gi)].map(m => visible(m[1]));
    if (JSON.stringify(headers) !== JSON.stringify([
        "Tran ID",
        "Tran Date",
        "Status",
        "Filer/Committee",
        "Contributor/Payee",
        "Sub Type",
        "Amount"
    ]))
        fail("unexpected native transaction headers");
    for (const tr of html.matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)) {
        const c = cells(tr[1]);
        const url = href(tr[1], /gotoPublicTransactionDetail\.do/i);
        if (!url) {
            if (c.length === 7 && /^\d+$/.test(c[0].text))
                fail("native row missing detail link");
            continue;
        }
        if (c.length !== 7)
            fail("wrong native transaction row width");
        const transactionId = id(c[0].text, "native Tran ID");
        const s = required(c[2].text, "native status");
        const filerUrl = href(c[3].html, /(?:sooDetail|displayFiler)\.do/i);
        if (new URL(url).searchParams.get("tranRsn") !== transactionId || !filerUrl)
            fail("native transaction link mismatch");
        const filer = new URL(filerUrl);
        const internal = filer.pathname.endsWith("/displayFiler.do");
        const sourceFilerReference = {
            kind: internal ? "internal_filer" as const : "public_committee" as const,
            id: id(filer.searchParams.get(internal ? "filerRsn" : "cneCommitteeId"), "native filer reference"),
            url: filerUrl
        };
        let projectedName = c[4].text;
        let nameDisplayAnnotation: "in_kind" | "out_of_state" | null = null;
        const suffix = /^(.*?)\s+(\*{1,2})$/.exec(c[4].text);
        if (suffix) {
            const kind = suffix[2] === "**" ? "out_of_state" : "in_kind";
            const legend = kind === "in_kind" ? "*in-kind expenditure" : "**out-of-state contributor";
            const color = kind === "in_kind" ? "green" : "red";
            const fonts = [...c[4].html.matchAll(/<font\b([^>]*)>([^]*?)<\/font>/gi)];
            if ([...html.matchAll(/<font\b([^>]*)>([^]*?)<\/font>/gi)].some(f => visible(f[2]) === legend && attr(f[1], "color")?.toLowerCase() === color) && fonts.length === 1 && attr(fonts[0][1], "color")?.toLowerCase() === color && visible(fonts[0][2]) === c[4].text) {
                projectedName = required(suffix[1], "annotated payee name");
                nameDisplayAnnotation = kind;
            }
        }
        rows.push({
            occurrence: rows.length,
            transactionId,
            date: parseOregonVerifiedDate(c[1].text),
            status: s,
            ...status(s),
            filerCommitteeId: internal ? null : sourceFilerReference.id,
            sourceFilerReference,
            filerName: c[3].text,
            name: c[4].text,
            projectedName,
            nameDisplayAnnotation,
            subType: required(c[5].text, "native subtype"),
            amountCents: parseOregonVerifiedCents(c[6].text),
            detailUrl: url,
            rawCells: c.map(x => x.text)
        });
    }
    const displayed = /(?:maximum\s+([\d,]+)\s+records?\s+are\s+displayed|displaying (?:the )?first\s*([\d,]+))/i.exec(visible(html));
    if (rows.length > declaredCount || declaredCount > 0 && rows.length === 0)
        fail("native row/count mismatch");
    if (declaredCount === 0 && !/No data found matching your search criteria/i.test(visible(html)))
        fail("missing explicit native empty result");
    return {
        sha256: hashOregonVerifiedBytes(html),
        criteria: criteria(html),
        projectedCriteria: projectedCriteria(html, criteria(html)),
        declaredCount,
        displayedLimit: displayed ? Number((displayed[1] ?? displayed[2]).replace(/,/g, "")) : null,
        hasNextPage: next(html),
        exportUrl: href(html, /XcelCNESearch/i),
        rows
    };
}
function mechanisms(raw: string[]): OregonVerifiedMechanism[] {
    return raw.map((s, i) => {
        const m = /^(Independent Expenditure in (Support|Opposition|Oppose|Against)|In-Kind Expenditure)\s*-\s*(.*?)\s*-\s*(\$[\d,]+(?:\.\d{1,2})?)$/i.exec(s);
        if (!m)
            return fail("unrecognized expenditure association");
        const target = /^(.*?)\s*\((\d+)\)$/.exec(m[3]);
        return {
            occurrence: i,
            mechanism: m[2] ? "independent" : "in_kind",
            supportOppose: m[2] ? (/Support/i.test(m[2]) ? "support" : "oppose") : null,
            targetName: required(target?.[1] ?? m[3], "association target"),
            targetCommitteeId: target?.[2] ?? null,
            amountCents: parseOregonVerifiedCents(m[4]),
            rawText: s
        };
    });
}
export function decodeOregonVerifiedTransactionDetail(html: string): OregonVerifiedDetail {
    const f = fields(html);
    const txValue = /^([1-9]\d*)(?:\s+History)?$/.exec(value(f, "Transaction ID"));
    if (!txValue)
        fail("invalid Transaction ID");
    const tx = txValue[1];
    if (/History/.test(value(f, "Transaction ID"))) {
        const h = href(html, /ceTransactionHistory\.do/i);
        if (!h || new URL(h).searchParams.get("tranRsn") !== tx)
            fail("transaction history link mismatch");
    }
    const titles = [...html.matchAll(/<div\b[^>]*\bid=["']header2["'][^>]*>([^]*?)<\/div>/gi)].map(m => visible(m[1])).map(s => /^(.*?)\s*\((\d+)\)$/.exec(s)).filter(m => m !== null);
    if (titles.length !== 1)
        fail("missing unique filer heading");
    const version = /Transaction Information\s*\(([^)]+)\)/i.exec(visible(html));
    if (!version)
        fail("missing transaction version status");
    const rawAssociation = value(f, "Associations", true);
    const refundAssociations: OregonVerifiedRefundAssociation[] = [];
    if (/Return.*Refund/i.test(value(f, "Transaction Sub Type")) && rawAssociation) {
        for (const s of f.Associations) {
            const m = /^Cash Contribution for (\$[\d,]+(?:\.\d{1,2})?) from (.*?) on (\d{2}\/\d{2}\/\d{4}) \((\d+)\) (Complete|Associate)$/.exec(s);
            if (!m)
                fail("unrecognized refund association");
            refundAssociations.push({
                occurrence: refundAssociations.length,
                transactionId: m[4],
                amountCents: parseOregonVerifiedCents(m[1]),
                date: parseOregonVerifiedDate(m[3]),
                donorName: m[2],
                status: m[5],
                rawText: s
            });
        }
    }
    const expired = /This transaction[^.]*expired|expired transaction/i.test(visible(html)) ? true : null;
    return {
        sha256: hashOregonVerifiedBytes(html),
        transactionId: tx,
        filerCommitteeId: titles[0]![2],
        filerName: titles[0]![1],
        date: parseOregonVerifiedDate(value(f, "Transaction Date")),
        amountCents: parseOregonVerifiedCents(value(f, "Amount")),
        transactionType: value(f, "Transaction Type"),
        subType: value(f, "Transaction Sub Type"),
        versionStatus: version[1],
        processStatus: value(f, "Process Status"),
        expired,
        deleted: /Deleted/i.test(version[1]) ? true : null,
        bookType: value(f, "Address Book Type", true) || null,
        name: value(f, "Name", true) || null,
        addressLines: f.Address ?? fail("missing Address"),
        mechanisms: mechanisms(f["In-Kind/Independent Expenditures"] ?? fail("missing mechanism field")),
        refundAssociations,
        rawFields: f
    };
}
export function decodeOregonVerifiedTransactionHistory(html: string): {
    sha256: string;
    transactionId: string;
    rows: OregonVerifiedHistoryRow[];
} {
    const transactionId = id(input(html, "tranRsn"), "history transaction ID");
    const rows: OregonVerifiedHistoryRow[] = [];
    if (!visible(html).includes("Only versions of this transaction that are public record will display."))
        fail("missing history scope statement");
    for (const tr of html.matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)) {
        const c = cells(tr[1]);
        const url = href(tr[1], /transactionHistPubDetail\.do/i);
        if (!url) {
            if (c.length === 8 && /^\d+$/.test(c[0].text))
                fail("history row missing detail link");
            continue;
        }
        if (c.length !== 8)
            fail("wrong history row width");
        const rowId = id(c[0].text, "history row ID");
        if (new URL(url).searchParams.get("tranRsn") !== rowId)
            fail("history link mismatch");
        rows.push({
            occurrence: rows.length,
            transactionId: rowId,
            status: required(c[1].text, "history status"),
            date: parseOregonVerifiedDate(c[2].text),
            filedDate: required(c[3].text, "history filedDate"),
            subType: required(c[4].text, "history subtype"),
            name: c[5].text,
            filedBy: c[6].text,
            amountCents: parseOregonVerifiedCents(c[7].text),
            rawCells: c.map(x => x.text)
        });
    }
    if (!rows.length || !rows.some(r => r.transactionId === transactionId))
        fail("history does not contain requested transaction");
    return {
        sha256: hashOregonVerifiedBytes(html),
        transactionId,
        rows
    };
}
export function decodeOregonVerifiedSoo(html: string): OregonVerifiedSoo {
    const m = /Statement of Organization for\s+([^]*?)<\/h1>/i.exec(html);
    if (!m)
        fail("missing SOO class heading");
    const committeeType = visible(m[1]);
    const committee = html.split(/<!--\s*#+\s*Committee Information \(b\)[^]*?-->/i)[1]?.split(/<!--\s*#+\s*Committee Information \(e\)/i)[0];
    if (!committee)
        fail("missing Committee Information section");
    // The committee table ends before financial-activity history; retain every field without mixing unrelated Name labels.
    const cf = fields(committee.slice(0, committee.indexOf("</table>") + 8));
    const candidateSection = html.split(/<!--\s*#+\s*Candidate Information \(b\)[^]*?-->/i)[1];
    const candidate = candidateSection ? fields(candidateSection.slice(0, candidateSection.indexOf("</table>") + 8)) : {};
    const rawFieldOccurrences: {
        label: string;
        valueLines: string[];
    }[] = [];
    for (const row of html.matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)) {
        const c = cells(row[1]);
        for (let i = 0; i < c.length; i++)
            if (c[i].label && c[i].text) {
                let j = i + 1;
                if (c[j]?.text === ":")
                    j++;
                if (c[j] && !c[j].label)
                    rawFieldOccurrences.push({ label: c[i].text.replace(/:$/, ""), valueLines: c[j].lines });
            }
    }
    const sourceRefs = [...html.matchAll(/<input\b[^>]*>/gi)].filter(m => attr(m[0], "name") === "sooRsn").map(m => attr(m[0], "value"));
    if (sourceRefs.length > 1)
        fail("ambiguous SOO reference");
    return {
        sha256: hashOregonVerifiedBytes(html),
        committeeId: id(value(cf, "ID"), "SOO public ID"),
        sourceSooRsn: sourceRefs.length ? id(sourceRefs[0], "SOO reference") : null,
        committeeType,
        committeeName: value(cf, "Name"),
        candidateName: candidate.Name?.join(" ") || null,
        electionOfficeLines: candidate["Election/Office"] ?? [],
        rawFields: { ...Object.fromEntries(Object.entries(cf).map(([k, v]) => [`committee.${k}`, v])), ...Object.fromEntries(Object.entries(candidate).map(([k, v]) => [`candidate.${k}`, v])) },
        rawFieldOccurrences,
        semanticText: visible(html)
    };
}
export function decodeOregonVerifiedCandidateDirectory(html: string): OregonVerifiedCandidateDirectory {
    const table = /<table\b[^>]*\bid=["']committeeSearchResults["'][^>]*>([^]*?)<\/table>/i.exec(html);
    if (!table)
        fail("missing native candidate results table");
    const rows: OregonVerifiedCandidateContext[] = [];
    for (const tr of table[1].matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)) {
        const publicId = input(tr[1], "committeeId");
        if (publicId === null) {
            if (href(tr[1], /sooDetail\.do/i))
                fail("candidate row missing public ID");
            continue;
        }
        const c = cells(tr[1]);
        if (c.length !== 4)
            fail("wrong native candidate row width");
        const committeeId = id(publicId, "directory public ID");
        const sourceSooRsn = id(input(tr[1], "sooRsn"), "directory SOO reference");
        const sourceUrl = href(tr[1], /sooDetail\.do/i);
        const names = lines(required(input(tr[1], "committeeName"), "directory name"));
        if (names.length !== 2 || !sourceUrl || new URL(sourceUrl).searchParams.get("sooRsn") !== sourceSooRsn || id(c[1].text, "visible public ID") !== committeeId || fingerprintOregonVerifiedRows(names) !== fingerprintOregonVerifiedRows(c[0].lines))
            fail("directory hidden/visible identity mismatch");
        rows.push({
            occurrence: rows.length,
            committeeId,
            sourceSooRsn,
            candidateName: names[0],
            committeeName: names[1],
            officePartyLines: c[2].lines,
            sourceUrl,
            rawCells: c.map(x => x.text)
        });
    }
    const declaredCount = count(html);
    const hasNextPage = next(html);
    if (rows.length > declaredCount || !hasNextPage && rows.length !== declaredCount)
        fail("incomplete native candidate directory");
    return {
        sha256: hashOregonVerifiedBytes(html),
        criteria: criteria(html),
        declaredCount,
        hasNextPage,
        rows
    };
}

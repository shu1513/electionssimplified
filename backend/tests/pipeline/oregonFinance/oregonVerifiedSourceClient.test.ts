import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import { utils, write } from "xlsx";
import { createOregonVerifiedSourceClient as create, type OregonVerifiedRawCapture, type OregonVerifiedFetch } from "../../../src/pipeline/oregonFinance/oregonVerifiedSourceClient.js";
import { OREGON_VERIFIED_TRANSACTION_HEADERS as columns, hashOregonVerifiedBytes as hash } from "../../../src/pipeline/oregonFinance/oregonVerifiedSourceDecoders.js";
const ROOT = "https://secure.sos.state.or.us/orestar/";
const form = `<form name="cneSearchForm" action="gotoPublicTransactionSearchResults.do;JSESSIONID_ORESTAR=SECRETSESSION"><input name="OWASP_CSRFTOKEN" value="SECRETCSRF"></form>`;
const candidateForm = `<form name="CommitteeSearchDynaFormSecond" action="CommitteeSearchSecondPage.do;JSESSIONID_ORESTAR=SECRETSESSION"><input name="OWASP_CSRFTOKEN" value="SECRETCSRF"></form>`;
const headers = [
    "Tran ID",
    "Tran Date",
    "Status",
    "Filer/Committee",
    "Contributor/Payee",
    "Sub Type",
    "Amount"
].map(x => `<th>${x}</th>`).join("");
const row = (id = "5853252", name = "Source PAC", filer = "sooDetail.do?cneCommitteeId=21892", amount = "$500.00") => `<tr><td><a href="gotoPublicTransactionDetail.do?tranRsn=${id}">${id}</a></td><td>10/02/2026</td><td>Original</td><td><a href="${filer}">Adam4Oregon</a></td><td>${name}</td><td>Cash Contribution</td><td>${amount}</td></tr>`;
const page = (rows = row(), count = 1, extra = "") => `Search Criteria : Tran Start Date = 01/01/2025, Tran End Date = 12/31/2026, Filer/Committee ID = 21892, Results : ${count} records found for the above search criteria<table><tr>${headers}</tr>${rows}</table>${extra}<a href="XcelCNESearch">Export</a>`;
const zero = page("", 0, "No data found matching your search criteria").replace('<a href="XcelCNESearch">Export</a>', "");
function workbook(ids = ["5853252"], values: Record<string, unknown> = {}) {
    const w = utils.book_new();
    const r: Record<string, unknown> = {
        "Original Id": "5853252",
        "Tran Date": "10/02/2026",
        "Tran Status": "Original",
        "Filer": "Adam4Oregon",
        "Contributor/Payee": "Source PAC",
        "Sub Type": "Cash Contribution",
        "Filer Id": "21892",
        "Amount": 500,
        ...values
    };
    utils.book_append_sheet(w, utils.aoa_to_sheet([[...columns], ...ids.map(id => columns.map(h => h === "Tran Id" || h === "Original Id" ? id : r[h] ?? null))]), "Sheet1");
    return new Uint8Array(write(w, { bookType: "xlsx", type: "buffer" }));
}
const label = (k: string, v: string) => `<tr><td class="label">${k}</td><td>:</td><td>${v}</td></tr>`;
const soo = (id = "21892") => '<h1>Statement of Organization for Candidate Committee</h1><!-- #### Committee Information (b) #### --><table>' + label("Name", "Adam4Oregon") + label("ID", id) + '</table>';
const detail = `<div id="header2">Adam4Oregon (21892)</div><h5>Transaction Information (Original)</h5><table>${[
    ["Transaction ID", "5853252"],
    ["Transaction Date", "10/02/2026"],
    ["Transaction Type", "Contribution"],
    ["Transaction Sub Type", "Cash Contribution"],
    ["Amount", "$500.00"],
    ["Process Status", "Filed"],
    ["Address Book Type", "Political Committee"],
    ["Name", "Source PAC"],
    ["Address", "10 Test Street<br>Salem, OR 97301"],
    ["Associations", ""],
    ["In-Kind/Independent Expenditures", ""]
].map(([k, v]) => label(k, v)).join("")}</table>`;
const history = '<input name="tranRsn" value="5853252">Only versions of this transaction that are public record will display.<table><tr><td><a href="transactionHistPubDetail.do?tranRsn=5853252">5853252</a></td><td>Original</td><td>10/02/2026</td><td>10/02/2026 04:18 PM</td><td>Cash Contribution</td><td>Source PAC</td><td>Filer</td><td>$500.00</td></tr></table>';
const context = (id = "16508") => `<tr><td><input name="committeeName" value="Evans, Paul&lt;BR /&gt;Friends of Paul Evans"><input name="committeeId" value="${id}"><input name="sooRsn" value="107100"><a href="sooDetail.do?sooRsn=107100">Evans, Paul<br>Friends of Paul Evans</a></td><td>${id}</td><td>State Representative,20th District<br>Democrat</td><td>History</td></tr>`;
const directory = (rows = context(), n = 1) => `Search Criteria : Election Year=2026, Type of Commitee=Candidate Committee (All), Discontinued, Approved, Pending Approval, Pending Insufficient, Pending Resolved, Rejected Filings Results : ${n} found for the above search criteria<table id="committeeSearchResults">${rows}</table>`;
function sequence(bodies: (string | Uint8Array | Response)[]) {
    return vi.fn<OregonVerifiedFetch>().mockImplementation(async () => {
        const body = bodies.shift();
        if (body === undefined)
            throw Error("unexpected mock request");
        return body instanceof Response ? body : new Response(body, { status: 200, headers: { "set-cookie": "JSESSIONID_ORESTAR=COOKIESECRET; HttpOnly" } });
    });
}
const input = {
    committeeId: "21892",
    electionYear: 2026,
    transactionType: "C" as const
};
describe("complete raw current ledger", () => {
    it("captures all bootstrap/pages/workbook with source POST fields, untouched bytes and no credential metadata", async () => {
        const captures: OregonVerifiedRawCapture[] = [];
        const wb = workbook();
        const fetch = sequence([form, page(), wb]);
        const client = create({ fetchFn: fetch, onRawResponse: c => {
                captures.push(c);
            } });
        const r = await client.fetchCurrentTransactionLedger(input);
        expect(r.pages).toHaveLength(1);
        expect(r.workbook?.request.requestFields).toEqual({});
        expect(r.workbook?.bytes).toEqual(wb);
        expect(captures).toHaveLength(3);
        const fields = r.pages[0].request.requestFields;
        expect(fields).toMatchObject({
            cneSearchTranStartDate: "01/01/2025",
            cneSearchTranEndDate: "12/31/2026",
            cneSearchTranType: "C",
            cneSearchFilerCommitteeId: "21892",
            cneSearchPageIdx: "0"
        });
        expect(JSON.stringify(captures.map(c => c.kind === "public_response" ? c.evidence.request : c.request))).not.toMatch(/SECRET|Cookie|CSRF|JSESSION/);
        expect(r.pages[0].request.sha256).toBe(hash(r.pages[0].bytes));
        expect(Date.parse(r.pages[0].request.startedAt)).toBeLessThanOrEqual(Date.parse(r.pages[0].request.endedAt));
        expect(new Headers(fetch.mock.calls[1][1].headers).get("cookie")).toContain("COOKIESECRET");
    });
    it("closes declared IDs despite last-page enabled Next and retains same-value distinct IDs", async () => {
        const fetch = sequence([
            form,
            page(row(), 2, '<input value="Next">'),
            page(row("5853253"), 2, '<input value="Next">'),
            workbook(["5853252", "5853253"])
        ]);
        const r = await create({ fetchFn: fetch }).fetchCurrentTransactionLedger(input);
        expect(r.pages).toHaveLength(2);
        expect(r.pages[1].request.requestFields).toMatchObject({ cneSearchPageIdx: "1", cneSearchButtonName: "next" });
        expect(fetch).toHaveBeenCalledTimes(4);
    });
    it("accepts genuine OD0 raw search scope without synthesized workbook", async () => {
        const r = await create({ fetchFn: sequence([form, zero]) }).fetchCurrentTransactionLedger({ ...input, transactionType: "OD" });
        expect(r.workbook).toBeUndefined();
        expect(r.pages).toHaveLength(1);
    });
    it("requires exact IE mode and captures Independent selector without electiontarget filter", async () => {
        const fetch = sequence([form, page(), workbook()]);
        await create({ fetchFn: fetch }).fetchCurrentTransactionLedger({
            ...input,
            transactionType: "E",
            independentOnly: true
        });
        const body = new URLSearchParams(String(fetch.mock.calls[1][1].body));
        expect(body.get("cneSearchIndependentInd")).toBe("I");
        expect(body.has("electionYear")).toBe(false);
    });
    it("rejects a stable but restricted visiblefinancialscope", async () => {
        const restricted = page().replace("Filer/Committee ID = 21892,", "Filer/Committee ID = 21892, Donor Type = Restricted,");
        await expect(create({ fetchFn: sequence([form, restricted, workbook()]) }).fetchCurrentTransactionLedger(input)).rejects.toThrow(/criteria/);
    });
    it("keeps nativeinternalRSN ratherthan replacing it with publicID", async () => {
        const r = await create({ fetchFn: sequence([form, page(row("5853252", "Source PAC", "displayFiler.do?filerRsn=53853")), workbook()]) }).fetchCurrentTransactionLedger(input);
        expect(Buffer.from(r.pages[0].bytes).toString()).toContain("filerRsn=53853");
    });
    it("accepts only published nameannotation projection", async () => {
        const p = page(row("5853252", '<font color="green">Source PAC *</font>'), 1, '<font color="Green">*in-kind expenditure</font>');
        await expect(create({ fetchFn: sequence([form, p, workbook()]) }).fetchCurrentTransactionLedger(input)).resolves.toBeDefined();
        await expect(create({ fetchFn: sequence([form, p.replace('*in-kind expenditure', '*in-kind expenditures'), workbook()]) }).fetchCurrentTransactionLedger(input)).rejects.toThrow(/identity/);
    });
    it.each([
        "repeated",
        "countchange",
        "criterchange",
        "cap",
        "missingexport",
        "identity"
    ])("rejects incomplete %s publication", async (kind) => {
        let bodies: (string | Uint8Array)[];
        if (kind === "repeated")
            bodies = [form, page(row(), 2, '<input value="Next">'), page(row(), 2)];
        else if (kind === "countchange")
            bodies = [form, page(row(), 2, '<input value="Next">'), page(row("5853253"), 3)];
        else if (kind === "criterchange")
            bodies = [form, page(row(), 2, '<input value="Next">'), page(row("5853253"), 2).replace("Filer/Committee ID = 21892", "Filer/Committee ID = 999")];
        else if (kind === "cap")
            bodies = [form, page(row(), 5000)];
        else if (kind === "missingexport")
            bodies = [form, page().replace('<a href="XcelCNESearch">Export</a>', "")];
        else
            bodies = [form, page(), workbook(["5853252"], { "Contributor/Payee": "Other PAC" })];
        await expect(create({ fetchFn: sequence(bodies) }).fetchCurrentTransactionLedger(input)).rejects.toThrow();
    });
});
describe("candidate/public GET acquisition", () => {
    it("requests exact allstatuses and native result without exportfallback", async () => {
        const f = sequence([candidateForm, directory()]);
        const r = await create({ fetchFn: f }).fetchCandidateDirectory({ yearActive: 2026 });
        expect(r.pages[0].request.requestFields).toMatchObject({
            yearActive: "2026",
            filerType: "CANDALL",
            discontinuedSOO: "on",
            approvedSOO: "on",
            pendingApprovalSOO: "on",
            insufficientSOO: "on",
            resolvedSOO: "on",
            rejectedSOO: "on"
        });
        expect(f).toHaveBeenCalledTimes(2);
    });
    it("rejects response whose published directoryscope omits a requestedstatus", async () => await expect(create({ fetchFn: sequence([candidateForm, directory().replace(", Rejected Filings", "")]) }).fetchCandidateDirectory({ yearActive: 2026 })).rejects.toThrow(/criteria/));
    it("retains complete740nativecontexts without first-row exportdedupe", async () => {
        const rows = Array.from({ length: 740 }, (_, i) => context(String(1000 + i))).join("");
        const f = sequence([candidateForm, directory(rows, 740)]);
        const r = await create({ fetchFn: f }).fetchCandidateDirectory({ yearActive: 2026 });
        expect(r.pages).toHaveLength(1);
        expect(f).toHaveBeenCalledTimes(2);
        expect(Buffer.from(r.pages[0].bytes).toString()).toContain('value="1739"');
    });
    it("journals standalone bootstrap token metadata without serializing reusable token", async () => {
        const captures: OregonVerifiedRawCapture[] = [];
        const f = sequence([candidateForm.replace('<input name="OWASP_CSRFTOKEN" value="SECRETCSRF">', ""), "OWASP_CSRFTOKEN:REUSABLESECRET", directory()]);
        await create({ fetchFn: f, onRawResponse: c => {
                captures.push(c);
            } }).fetchCandidateDirectory({ yearActive: 2026 });
        const token = captures.find(c => c.kind === "credential_metadata");
        expect(token).toBeDefined();
        expect(token).not.toHaveProperty("bytes");
        expect(JSON.stringify(token)).not.toContain("REUSABLESECRET");
        expect(new URLSearchParams(String(f.mock.calls[2][1].body)).get("OWASP_CSRFTOKEN")).toBe("REUSABLESECRET");
    });
    it("also journals transaction tokenbootstrap without raw token persistence", async () => {
        const c: OregonVerifiedRawCapture[] = [];
        const f = sequence([form.replace('<input name="OWASP_CSRFTOKEN" value="SECRETCSRF">', ""), "OWASP_CSRFTOKEN:REUSABLESECRET", zero]);
        await create({ fetchFn: f, onRawResponse: x => {
                c.push(x);
            } }).fetchCurrentTransactionLedger({ ...input, transactionType: "OD" });
        expect(c.map(x => x.kind)).toEqual(["public_response", "credential_metadata", "public_response"]);
    });
    it.each([directory(context(), 999), directory(context() + context(), 2), "<html>Login</html>"])("rejects capped/duplicated/degraded native candidate result", async (p) => await expect(create({ fetchFn: sequence([candidateForm, p]) }).fetchCandidateDirectory({ yearActive: 2026 })).rejects.toThrow());
    it("keeps qualifiedSOOreference distinct and validates publicdetail/history identity", async () => {
        const f = sequence([
            soo(),
            detail,
            history,
            soo()
        ]);
        const c = create({ fetchFn: f });
        const s = await c.fetchSoo({ qualifiedSooRsn: "107100" });
        expect(s.request.url).toBe(ROOT + "sooDetail.do?sooRsn=107100");
        await c.fetchTransactionDetail({ transactionId: "5853252" });
        await c.fetchTransactionHistory({ transactionId: "5853252" });
        await c.fetchSoo({ publicCommitteeId: "21892" });
    });
    it("rejects wrongrequestedidentity and foreignformaction", async () => {
        await expect(create({ fetchFn: sequence([soo("999")]) }).fetchSoo({ publicCommitteeId: "21892" })).rejects.toThrow(/identity/);
        await expect(create({ fetchFn: sequence([form.replace("gotoPublicTransactionSearchResults.do;JSESSIONID_ORESTAR=SECRETSESSION", "https://evil.example/search")]) }).fetchCurrentTransactionLedger(input)).rejects.toThrow();
    });
});
describe("bounded streaming and immutable journal", () => {
    it.each([
        0,
        -1,
        NaN,
        Infinity,
        1.5
    ])("fails bounds beforefetch %s", v => {
        const f = sequence([]);
        expect(() => create({ fetchFn: f, maxRequests: v })).toThrow();
        expect(f).not.toHaveBeenCalled();
    });
    it("limits wholeclientgeneration requests includingbootstrap", async () => {
        const f = sequence([form, page(), workbook()]);
        await expect(create({ fetchFn: f, maxRequests: 2 }).fetchCurrentTransactionLedger(input)).rejects.toThrow(/budget/);
        expect(f).toHaveBeenCalledTimes(2);
    });
    it("captures partialbody on perresponse cap, cancels and rejects", async () => {
        const captures: OregonVerifiedRawCapture[] = [];
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ start(c) {
                c.enqueue(new TextEncoder().encode("12345678"));
            }, cancel });
        await expect(create({
            fetchFn: sequence([new Response(body)]),
            maxHtmlBytes: 4,
            onRawResponse: c => {
                captures.push(c);
            }
        }).fetchSoo({ publicCommitteeId: "21892" })).rejects.toThrow(/cap/);
        expect(captures[0]).toMatchObject({
            kind: "failed_response",
            failureKind: "byte_cap",
            request: { byteCount: 4, status: 200 }
        });
        expect(cancel).toHaveBeenCalled();
    });
    it("limits totalbytes across separate publicoperations", async () => {
        const b = soo();
        const f = sequence([b, b]);
        const c = create({ fetchFn: f, maxTotalBytes: Buffer.byteLength(b) });
        await c.fetchSoo({ publicCommitteeId: "21892" });
        await expect(c.fetchSoo({ publicCommitteeId: "21892" })).rejects.toThrow(/budget/);
        expect(f).toHaveBeenCalledTimes(1);
    });
    it("timeout covers body afterheaders and captures genuinepartialbytes", async () => {
        const captures: OregonVerifiedRawCapture[] = [];
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ start(c) {
                c.enqueue(new TextEncoder().encode("partial"));
            }, cancel });
        await expect(create({
            fetchFn: sequence([new Response(body)]),
            timeoutMs: 10,
            onRawResponse: c => {
                captures.push(c);
            }
        }).fetchSoo({ publicCommitteeId: "21892" })).rejects.toThrow(/timed out/);
        expect(captures[0]).toMatchObject({
            kind: "failed_response",
            failureKind: "timeout",
            request: { byteCount: 7, status: 200 }
        });
        expect(cancel).toHaveBeenCalled();
    });
    it("timeout beforeheaders recordsnullstatus and never returns sourceevidence", async () => {
        const captures: OregonVerifiedRawCapture[] = [];
        await expect(create({
            fetchFn: () => new Promise(() => {
            }),
            timeoutMs: 10,
            onRawResponse: c => {
                captures.push(c);
            }
        }).fetchSoo({ publicCommitteeId: "21892" })).rejects.toThrow(/timed out/);
        expect(captures[0]).toMatchObject({ kind: "failed_response", request: { status: null, byteCount: 0 } });
    });
    it("HTTP failures journal exactbody but reject; redirects are not hidden", async () => {
        const captures: OregonVerifiedRawCapture[] = [];
        const f = sequence([new Response("denied", { status: 403 })]);
        await expect(create({ fetchFn: f, onRawResponse: c => {
                captures.push(c);
            } }).fetchSoo({ publicCommitteeId: "21892" })).rejects.toThrow(/403/);
        expect(captures[0]).toMatchObject({ kind: "failed_response", request: { status: 403, byteCount: 6 } });
        expect(f.mock.calls[0][1].redirect).toBe("manual");
    });
    it("callbackmutation cannot change returnedrawbytes and awaited sinkfailure rejects", async () => {
        const c = create({ fetchFn: sequence([soo()]), onRawResponse: x => {
                if (x.kind === "public_response")
                    x.evidence.bytes.fill(0);
            } });
        const r = await c.fetchSoo({ publicCommitteeId: "21892" });
        expect(hash(r.bytes)).toBe(r.request.sha256);
        await expect(create({ fetchFn: sequence([soo()]), onRawResponse: async () => {
                throw Error("sinkfailed");
            } }).fetchSoo({ publicCommitteeId: "21892" })).rejects.toThrow(/sinkfailed/);
    });
    it("rejects concurrentmethods without cross-session capture", async () => {
        let done!: () => void;
        const f: OregonVerifiedFetch = () => new Promise(r => {
            done = () => r(new Response(soo()));
        });
        const c = create({ fetchFn: f });
        const a = c.fetchSoo({ publicCommitteeId: "21892" });
        await expect(c.fetchSoo({ publicCommitteeId: "21892" })).rejects.toThrow(/concurrent/);
        done();
        await a;
    });
    it("invalid sourcearguments fail beforefetch", async () => {
        const f = sequence([]);
        const c = create({ fetchFn: f });
        await expect(c.fetchCurrentTransactionLedger({ ...input, transactionType: "E" })).rejects.toThrow(/mode/);
        await expect(c.fetchTransactionDetail({ transactionId: "1&token=secret" })).rejects.toThrow(/ID/);
        await expect(c.fetchCandidateDirectory({ yearActive: 2026.5 })).rejects.toThrow(/year/);
        expect(f).not.toHaveBeenCalled();
    });
});

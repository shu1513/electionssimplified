import { describe, it, expect } from "vitest";
import { utils, write } from "xlsx";
import { OREGON_VERIFIED_TRANSACTION_HEADERS as H, hashOregonVerifiedBytes } from "../../../src/pipeline/oregonFinance/oregonVerifiedSourceDecoders.js";
import { verifyOregonCurrentPacSource as verify, validateOregonVerifiedPacProvenance as validate, type OregonVerifiedPacInput, type OregonPacRawEvidence } from "../../../src/pipeline/oregonFinance/oregonVerifiedPacSource.js";
const origin = "https://secure.sos.state.or.us/orestar/";
const context = { candidateId: "d2b276e7-3e86-4574-beaa-532f26f31392", electionId: "4f0dfc81-9e92-4163-8521-b37b6e12ee68", committeeId: "21892", candidateName: "Adam Baker", electionYear: 2026, electionType: "General" as const, officeName: "State Representative", district: "40" };
type Row = Record<string, string | number | null>;
const esc = (s: unknown) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const field = (k: string, v: string) => `<tr><td class="label">${k}</td><td>${v}</td></tr>`;
function raw(path: string, body: string | Uint8Array, after = false, fields: Record<string, string> = {}): OregonPacRawEvidence {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return { bytes, request: { url: origin + path, method: path === "gotoPublicTransactionSearchResults.do" ? "POST" : "GET", requestFields: fields, startedAt: after ? "2026-10-11T20:01:00Z" : "2026-10-11T20:00:00Z", endedAt: after ? "2026-10-11T20:01:01Z" : "2026-10-11T20:00:01Z", status: 200, byteCount: bytes.length, sha256: hashOregonVerifiedBytes(bytes) } };
}
function row(id: string, donor: string | null, amount: number, name: string, book = "Political Committee"): Row { return Object.assign(Object.fromEntries(H.map(h => [h, null])), { "Tran Id": id, "Original Id": id, "Tran Date": "06/01/2026", "Tran Status": "Original", "Filer": "Adam4Oregon", "Contributor/Payee": name, "Sub Type": "Cash Contribution", "Amount": amount, "Aggregate Amount": amount, "Contributor/Payee Committee ID": donor, "Filer Id": "21892", "Book Type": book, "Addr Line1": "1 Example Street", "Addr Line2": "Suite 2", "City": "Salem", "State": "OR", "Zip": "97301", "Country": "United States" }); }
function workbook(rows: Row[], after: boolean) { const wb = utils.book_new(); utils.book_append_sheet(wb, utils.aoa_to_sheet([Array.from(H), ...rows.map(r => H.map(k => r[k]))]), "Transactions"); return raw("XcelCNESearch", new Uint8Array(write(wb, { type: "array", bookType: "xlsx" })), after); }
function native(rows: Row[], after: boolean, type = "C") {
    const headers = ["Tran ID", "Tran Date", "Status", "Filer/Committee", "Contributor/Payee", "Sub Type", "Amount"].map(h => `<th>${h}</th>`).join("");
    const content = rows.map(r => `<tr><td><a href="gotoPublicTransactionDetail.do?tranRsn=${r["Tran Id"]}">${r["Tran Id"]}</a></td><td>${r["Tran Date"]}</td><td>${r["Tran Status"]}</td><td><a href="sooDetail.do?cneCommitteeId=21892">Adam4Oregon</a></td><td>${esc(r["Contributor/Payee"])}</td><td>${r["Sub Type"]}</td><td>$${Number(r.Amount).toFixed(2)}</td></tr>`).join("");
    return raw("gotoPublicTransactionSearchResults.do", `<div>Search Criteria: Tran Start Date = 01/01/2025, Tran End Date = 12/31/2026, Filer/Committee ID = 21892 Results: ${rows.length} records found for the above search criteria</div>${rows.length ? `<table><tr>${headers}</tr>${content}</table>` : `<table><tr>${headers}</tr></table>No data found matching your search criteria`}`, after, { cneSearchFilerCommitteeId: "21892", cneSearchTranType: type, cneSearchTranStartDate: "01/01/2025", cneSearchTranEndDate: "12/31/2026", cneSearchPageIdx: "0", cneSearchButtonName: "search" });
}
function soo(id: string, name: string, type: string, after: boolean, candidate = false) { return raw(`sooDetail.do?cneCommitteeId=${id}`, `<h1>Statement of Organization for ${type}</h1><!-- ######## Committee Information (b) --><table>${field("ID", id)}${field("Name", esc(name))}${field("Filing Type", "Amendment")}</table><!-- ######## Committee Information (e) -->${candidate ? `<!-- ######## Candidate Information (b) --><table>${field("Name", "Adam Baker")}${field("Election/Office", "2026 General Election<br>State Representative,<br>40th District")}</table>` : ""}${id === "23238" ? "Candidate Controlled Caucus" : ""}`, after); }
function detail(r: Row, after: boolean) { return raw(`gotoPublicTransactionDetail.do?tranRsn=${r["Tran Id"]}`, `<div id="header2">Adam4Oregon (21892)</div><div>Transaction Information (${r["Tran Status"]})</div><table>${field("Transaction ID", String(r["Tran Id"]))}${field("Transaction Date", String(r["Tran Date"]))}${field("Amount", `$${Number(r.Amount).toFixed(2)}`)}${field("Transaction Type", "Contribution")}${field("Transaction Sub Type", "Cash Contribution")}${field("Process Status", "Complete")}${field("Address Book Type", String(r["Book Type"]))}${field("Name", esc(r["Contributor/Payee"]))}${field("Address", "1 Example Street<br>Suite 2<br>Salem, OR 97301")}${field("Associations", "")}${field("In-Kind/Independent Expenditures", "")}</table>`, after); }
const originalGifts = () => [row("5853252", "169", 500, "Housing PAC"), row("5808440", "23238", 10000, "EvergreenPAC"), row("5770979", "18385", 2500, "Law Enforcement PAC"), row("5641098", "18385", 2500, "Law Enforcement PAC"), row("5629783", "16428", 1500, "Jobs PAC")];
function fixture(gifts = originalGifts(), miscLabel = "Miscellaneous Cash Contributions $100 and under", miscDonor: string | null = null, miscCount = 23): OregonVerifiedPacInput {
    const candidates = [row("5601330", "20272", 2000, "Friends of Bobby Levy"), row("5573110", "20022", 1500, "Friends of Vikki"), row("5528753", "20022", 1000, "Friends of Vikki"), row("5452293", "20022", 2000, "Friends of Vikki"), row("5442585", "20217", 3000, "Mark Owens for Oregon"), row("5635241", "20272", 2000, "Friends of Bobby Levy")], all = [...gifts, ...candidates];
    for (let i = 0; i < 18; i++)
        all.push(row(String(6000000 + i), null, 150, `Example Individual ${i}`, "Individual"));
    for (let i = 0; i < miscCount; i++) {
        const r = row(String(6200000 + i), miscDonor, 100, miscLabel, "Individual");
        r["Book Type"] = null;
        all.push(r);
    }
    const unrelated = all[gifts.length + candidates.length];
    unrelated["Tran Id"] = "5770977";
    unrelated["Original Id"] = "5768320";
    unrelated["Tran Status"] = "Amended";
    for (let i = 0; i < 7; i++) {
        const r = row(String(6100000 + i), null, 50, `Example Inkind ${i}`, "Individual");
        r["Sub Type"] = "In-Kind/Forgiven Personal Expenditures";
        all.push(r);
    }
    const snapshot = (after: boolean) => ({ contributions: { pages: [native(all, after)], workbook: workbook(all, after) }, otherDisbursements: { pages: [native([], after, "OD")] }, receivingSoo: soo("21892", "Adam4Oregon", "Candidate Committee", after, true), typedCashDetails: all.filter(r => r["Book Type"] === "Political Committee").map(r => detail(r, after)), donorSoos: [...new Map(all.filter(r => r["Book Type"] === "Political Committee").map(r => [String(r["Contributor/Payee Committee ID"]), r])).values()].map(r => soo(String(r["Contributor/Payee Committee ID"]), String(r["Contributor/Payee"]), ["20272", "20022", "20217"].includes(String(r["Contributor/Payee Committee ID"])) ? "Candidate Committee" : "Political Action Committee", after)) });
    return { candidateContext: { ...context }, windowStart: "2025-01-01", windowEnd: "2026-12-31", before: snapshot(false), after: snapshot(true) };
}
function edit(e: OregonPacRawEvidence, fn: (s: string) => string) { e.bytes = new TextEncoder().encode(fn(new TextDecoder().decode(e.bytes))); e.request.byteCount = e.bytes.length; e.request.sha256 = hashOregonVerifiedBytes(e.bytes); }
describe("Oregon pure PAC source (synthetic fresh closure protocol)", () => {
    it("closes all59 current occurrences including Individual amendment and11 typedcash, showing4 PACgroups/$17k/5giftIDs", () => { const r = verify(fixture()); expect(r.diagnostics[0]).toContain("23 unclassified"); expect(r.provenance).toMatchObject({ scope: "current_named_registered_pac_cash", unclassifiedMiscCashCount: 23, unclassifiedMiscCashAmountCents: 230000 }); expect(r.pacDonors).toHaveLength(4); expect(r.pacDonors?.reduce((s, d) => s + d.amount, 0)).toBe(17000); expect(r.provenance?.gifts).toHaveLength(5); expect(r.pacDonors?.find(d => d.committeeId === "23238")?.amount).toBe(10000); expect(r.pacDonors?.find(d => d.committeeId === "18385")?.contributionCount).toBe(2); });
    it.each(["missing_detail", "missing_soo", "nonempty_OD", "wrong_seat", "changed_name", "changed_address", "changed_class", "unknown_class", "expired", "changed_raw", "capped", "partial", "duplicate", "scope", "hash", "interval"])("preserves whole component: %s", reason => {
        const x = fixture();
        switch (reason) {
            case "missing_detail":
                x.after.typedCashDetails = [];
                break;
            case "missing_soo":
                x.after.donorSoos = [];
                break;
            case "nonempty_OD":
                x.after.otherDisbursements.pages = [native([row("6200000", null, 20, "Anonymous Refund", "Individual")], true, "OD")];
                break;
            case "wrong_seat":
                x.candidateContext.district = "41";
                break;
            case "changed_name":
                for (const s of [x.before, x.after])
                    edit(s.typedCashDetails[0], v => v.replaceAll("Housing PAC", "Different PAC"));
                break;
            case "changed_address":
                for (const s of [x.before, x.after])
                    edit(s.typedCashDetails[0], v => v.replaceAll("Suite 2", "Suite 3"));
                break;
            case "changed_class":
                edit(x.after.donorSoos[0], v => v.replace("Political Action Committee", "Candidate Committee"));
                break;
            case "unknown_class":
                for (const s of [x.before, x.after])
                    edit(s.donorSoos[0], v => v.replace("Political Action Committee", "Unknown Committee"));
                break;
            case "expired":
                edit(x.after.typedCashDetails[0], v => v + "This transaction has expired.");
                break;
            case "changed_raw":
                edit(x.after.typedCashDetails[0], v => v + field("Purpose", "Changed same-money purpose"));
                break;
            case "capped":
                edit(x.before.contributions.pages[0], v => v.replace("59 records found", "5000 records found"));
                break;
            case "partial":
                edit(x.before.contributions.pages[0], v => v.replace("59 records found", "60 records found"));
                break;
            case "duplicate":
                x.before.typedCashDetails.push(x.before.typedCashDetails[0]);
                break;
            case "scope":
                x.before.contributions.pages[0].request.requestFields = { ...x.before.contributions.pages[0].request.requestFields, cneSearchContributorTxt: "Only Selected PAC" };
                break;
            case "hash":
                x.before.receivingSoo.request.sha256 = "a".repeat(64);
                break;
            case "interval":
                x.after.receivingSoo.request.startedAt = "2026-10-11T19:00:00Z";
                break;
        }
        expect(verify(x).pacDonors).toBeUndefined();
        expect(verify(x).diagnostics.length).toBeGreaterThan(0);
    });
    it("accepts complete unique count+workbook closure even source lastpage Next stays enabled", () => {
        const x = fixture();
        for (const s of [x.before, x.after])
            edit(s.contributions.pages[0], v => v + `<input value="Next">`);
        expect(verify(x).pacDonors).toHaveLength(4);
    });
    it("uses explicit public donorID despite reported name variation without alias guesses", () => {
        const x = fixture();
        for (const s of [x.before, x.after])
            edit(s.donorSoos[0], v => v.replace("Housing PAC", "Registered Legal PAC Name"));
        expect(verify(x).pacDonors?.find(d => d.committeeId === "169")?.committeeName).toBe("Registered Legal PAC Name");
    });
    it("excludes stable Candidate Committee without confusing candidate-controlled PAC", () => {
        const x = fixture();
        for (const s of [x.before, x.after])
            edit(s.donorSoos[0], v => v.replace("Political Action Committee", "Candidate Committee"));
        expect(verify(x).pacDonors?.reduce((s, d) => s + d.amount, 0)).toBe(16500);
    });
    it("retains equal gifts with differentIDs, rejecting malicious duplicate occurrence IDs", () => { const equal = [row("7000001", "169", 500, "Same PAC"), row("7000002", "169", 500, "Same PAC")]; expect(verify(fixture(equal)).pacDonors?.find(d => d.committeeId === "169")).toMatchObject({ amount: 1000, contributionCount: 2 }); expect(verify(fixture([equal[0], equal[0]])).pacDonors).toBeUndefined(); });
    it("accepts appended Original while prior exact identities remain and rejects disappeared prior gift", () => { const base = verify(fixture()).provenance; expect(base).toBeDefined(); const x = fixture([...originalGifts(), row("7000003", "169", 300, "Housing PAC")]); x.priorProvenance = JSON.parse(JSON.stringify(base)); expect(verify(x).pacDonors?.reduce((s, d) => s + d.amount, 0)).toBe(17300); const removed = fixture([row("7000004", "169", 300, "New PAC")]); removed.priorProvenance = base; expect(verify(removed).diagnostics[0]).toContain("disappeared/changed"); });
    it("does not conflate punctuation or dropped address2 in otherwise closed detail identities", () => {
        for (const transform of [(v: string) => v.replaceAll("Housing PAC", "Housing-PAC"), (v: string) => v.replaceAll("1 Example Street", "1 Example-Street"), (v: string) => v.replaceAll("Suite 2<br>", "")]) {
            const x = fixture();
            for (const s of [x.before, x.after])
                edit(s.typedCashDetails[0], transform);
            expect(verify(x).diagnostics[0]).toContain("detail/full workbook mismatch");
        }
    });
    it("preserves prior same-ID same-money name change even when fresh publication independently agrees", () => { const old = verify(fixture()).provenance; const gifts = originalGifts(); gifts[0]["Contributor/Payee"] = "New Reported Name"; const x = fixture(gifts); x.priorProvenance = old; expect(verify(x).diagnostics[0]).toContain("disappeared/changed"); });
    it("preserves unsupported amended PAC lineage without blocking the unrelated Individual amendment", () => { const gifts = originalGifts(); gifts[0]["Tran Status"] = "Amended"; gifts[0]["Original Id"] = "5000000"; expect(verify(fixture(gifts)).diagnostics[0]).toContain("lineage"); });
    it.each(["Miscellaneous Cash Contributions $200 and under", "Miscellaneous Cash Contribution $100 and under", ""])("rejects missing class near-label %s", label => { expect(verify(fixture(originalGifts(), label)).pacDonors).toBeUndefined(); });
    it("rejects miscellaneous unknown class when an explicit donorID contradicts anonymous policy", () => { expect(verify(fixture(originalGifts(), "Miscellaneous Cash Contributions $100 and under", "169")).pacDonors).toBeUndefined(); });
    it("does not turn anonymous-only cash into verified PAC zero", () => { const r = verify(fixture([])); expect(r.pacDonors).toBeUndefined(); expect(r.provenance).toBeUndefined(); expect(r.diagnostics.at(-1)).toContain("cannot prove an empty"); });
    it("allows empty known named PAC only with full cash/OD0 coverage and no positive anonymous uncertainty", () => { const r = verify(fixture([], "Miscellaneous Cash Contributions $100 and under", null, 0)); expect(r.pacDonors).toEqual([]); expect(r.provenance?.gifts).toEqual([]); });
    it("preserves changed empty OD scope even if both snapshots declare zero", () => { const x = fixture(); edit(x.after.otherDisbursements.pages[0], s => s.replace("Filer/Committee ID = 21892", "Filer/Committee ID = 999")); expect(verify(x).diagnostics[0]).toContain("native response query mismatch"); });
    it("keeps published ZIP4 exact rather than guessing truncated digits", () => { const gifts = originalGifts(); gifts[0]["Zip Plus Four"] = "12"; expect(verify(fixture(gifts)).diagnostics[0]).toContain("ZIP projection"); });
    it("does not promote Business Entity names containing PAC and preserves future unknown cash classes", () => { const g = originalGifts(); g[0]["Book Type"] = "Business Entity"; g[0]["Contributor/Payee"] = "Generic Super PAC LLC"; expect(verify(fixture(g)).pacDonors?.reduce((s, d) => s + d.amount, 0)).toBe(16500); g[0]["Book Type"] = "Future Unknown Class"; expect(verify(fixture(g)).diagnostics[0]).toContain("unknown cash source class"); });
    it("preserves unknown contribution subtype rather than treating possible refund as irrelevant", () => { const g = originalGifts(); g[0]["Sub Type"] = "Future Returned Cash"; expect(verify(fixture(g)).pacDonors).toBeUndefined(); });
    it("projects only exact published out-of-state annotation with matching red markup, retaining raw proof identity", () => {
        const x = fixture();
        for (const s of [x.before, x.after])
            edit(s.contributions.pages[0], v => `<font color="Red">**out-of-state contributor</font>` + v.replace("<td>Housing PAC</td>", "<td><font color=\"red\">Housing PAC **</font></td>"));
        expect(verify(x).pacDonors).toHaveLength(4);
    });
    it.each(["missing_legend", "near_legend", "wrong_color"])("preserves unproved source annotation %s", reason => {
        const x = fixture();
        for (const s of [x.before, x.after])
            edit(s.contributions.pages[0], v => (reason === "missing_legend" ? "" : `<font color="Red">${reason === "near_legend" ? "**out of state contributor" : "**out-of-state contributor"}</font>`) + v.replace("<td>Housing PAC</td>", `<td><font color="${reason === "wrong_color" ? "green" : "red"}">Housing PAC **</font></td>`));
        expect(verify(x).pacDonors).toBeUndefined();
    });
    it("binds exact local Lower Chamber office via shared finite source projection", () => { const x = fixture(); x.candidateContext.officeName = "State Lower Chamber Legislator"; expect(verify(x).pacDonors).toHaveLength(4); });
    it("validates runtime materialized donor money/counts and JSONB key ordering against authority", () => {
        const r = verify(fixture());
        expect(validate({ provenance: r.provenance, donors: r.pacDonors, expectedContext: context })).toBe(true);
        const reversed = Object.fromEntries(Object.entries(r.provenance!).reverse());
        expect(validate({ provenance: reversed, donors: r.pacDonors, expectedContext: context })).toBe(true);
        const donors = structuredClone(r.pacDonors!);
        donors[0].amount += 1;
        expect(validate({ provenance: r.provenance, donors, expectedContext: context })).toBe(false);
        donors[0].amount -= 1;
        donors[0].contributionCount++;
        expect(validate({ provenance: r.provenance, donors, expectedContext: context })).toBe(false);
    });
    it.each(["duplicate_gift", "missing_anonymous", "unsafe_money", "bad_hash", "wrong_context", "wrong_date", "empty_positive"])("rejects malformed runtime authority %s", reason => {
        const r = verify(fixture()), p = structuredClone(r.provenance!) as any;
        let expected = context;
        if (reason === "duplicate_gift")
            p.gifts.push(p.gifts[0]);
        if (reason === "missing_anonymous")
            delete p.unclassifiedMiscCashCount;
        if (reason === "unsafe_money")
            p.gifts[0].amountCents = Number.MAX_SAFE_INTEGER + 1;
        if (reason === "bad_hash")
            p.gifts[0].identityFingerprint = "bad";
        if (reason === "wrong_context")
            expected = { ...context, district: "41" };
        if (reason === "wrong_date")
            p.gifts[0].date = "2026-02-30";
        if (reason === "empty_positive")
            p.gifts = [];
        expect(validate({ provenance: p, donors: reason === "empty_positive" ? [] : r.pacDonors, expectedContext: expected })).toBe(false);
    });
    it("runtime empty named authority requires complete anonymous-zero fields", () => { const r = verify(fixture([], "Miscellaneous Cash Contributions $100 and under", null, 0)); expect(validate({ provenance: r.provenance, donors: [], expectedContext: context })).toBe(true); });
    it("honestly preserves once-captured exploratory detail evidence", () => { const x = fixture(); x.after.typedCashDetails = []; expect(verify(x).provenance).toBeUndefined(); expect(verify(x).diagnostics[0]).toContain("closing typed cash detail"); });
});

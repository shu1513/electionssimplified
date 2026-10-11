import { describe, expect, it, vi } from "vitest";
import { createTennesseeVerifiedNativeClient, parseTennesseeVerifiedNativeCsv, TENNESSEE_NATIVE_CONTRIBUTION_HEADERS as headers, TENNESSEE_NATIVE_IE_HEADERS as ieHeaders } from "../../../src/pipeline/tennesseeFinance/tennesseeVerifiedNativeClient.js";
const input = { receiverName: "Crowe", recipientType: "candidate" as const, reportYear: 2026, electionYear: 2026, donorScope: "all" as const };
const landing = '<html><form><input name="searchType"><select name="electionYearSelection"><option value="234">2026</option></select></form></html>';
const pacHeaders = ["Salutation", "First Name", "Last Name", "Committee Affiliation", "Created", "Closed"];
const candHeaders = ["Salutation", "First Name", "Last Name", "Office Sought", "District", "Election Year", "Committee Affiliation", "Created", "Closed"];
const pacHtmlHeaders = ["Name", "Committee Affiliation", "Created", "Closed", "Report List"];
function csv(h: readonly string[], rows: string[][]): string { return [h, ...rows].map(r => r.map(v => '"' + v.replace(/"/g, '""') + '"').join(',')).join('\n') + '\n'; }
function cash(name = 'REPORTED PAC', amount = '$1,000.00'): string[] { return ['Monetary', 'N', amount, '05/14/2026', '2026', '2nd Quarter', 'CROWE, RUSTY', name, '10 MAIN ST,TOWN, TN, 37000', '', '', 'source description']; }
function cashHtml(r: string[], report = '126857'): string[] { return r.map((v, i) => i === 5 ? `<a href="/tncamp/search/pub/report_full.htm?reportId=${report}">${v}</a>` : i === 8 ? v.replace('ST,', 'ST<br>') : v); }
function page(h: readonly string[], rows: string[][], total = rows.length, n = 1, kind = 'ce', more = false): string {
  const end = (n - 1) * 50 + rows.length;
  const banner = total === 1 ? 'One result found.' : total <= 50 ? `${total} results found, displaying all results.` : `${total} results found, displaying ${(n - 1) * 50 + 1} to ${end}.`;
  return '<html><body><span class="pagebanner">' + banner + '</span><table id="results"><thead><tr>' + h.map(v => '<th>' + v + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(v => '<td>' + v + '</td>').join('') + '</tr>').join('') + '</tbody></table>' +
    (end < total ? `<a href="/tncamp/public/${kind}results.htm?d-1341904-p=${n + 1}">Next</a>` : '') +
    `<a href="/tncamp/public/${kind}results.htm?d-1341904-e=1${n > 1 ? "&amp;d-1341904-p=" + n : ""}&amp;6578706f7274=1">CSV</a>` +
    (more ? `More records available. Click 'More' to retrieve.<a href="../public/${kind}resultsnext.htm">More</a>` : '') + '</body></html>';
}
function queue(bodies: (string | Uint8Array)[]) {
  const mock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => { const b = bodies.shift(); if (b === undefined) throw Error('Unexpected request'); return new Response(b as BodyInit, { headers: { 'set-cookie': 'PUBLIC_SESSION=synthetic; Path=/' } }); });
  return { fetchImpl: mock as unknown as typeof fetch, mock };
}
function registryHtml(r: string[], id: string): string[] { const name = r.slice(0, 3).filter(Boolean).join(' '); return [name, r[3], r[4], r[5], `<a href="/tncamp/public/replist.htm?id=${id}&amp;owner=${encodeURIComponent(name)}">Report List</a>`]; }
describe('verified Tennessee native acquisition', () => {
  it('retains equal occurrences, all raw fields, observed report IDs and cookie-free raw metadata', async () => {
    const r = cash(); const q = queue([landing, page(headers, [cashHtml(r), cashHtml(r)]), csv(headers, [r, r])]); const raw: unknown[] = [];
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl, onRawResponse: r => { raw.push(r); } }).fetchContributions(input);
    expect(result.rows.map(r => r.occurrence)).toEqual([0, 1]); expect(result.rows[0]).toMatchObject({ date: '2026-05-14', amountCents: 100000, reportId: '126857', electionYear: 2026, contributorAddress: r[8] });
    expect(Object.keys(result.rows[0].rawFields)).toEqual([...headers]); expect(result.declaredCount).toBe(2); expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(raw).toHaveLength(3); expect(JSON.stringify(result.requests)).not.toContain('PUBLIC_SESSION');
    const form = new URLSearchParams(q.mock.mock.calls[1][1]!.body as string);
    for (const k of ['fromPAC', 'fromCandidate', 'fromIndividual', 'fromOrganization']) expect(form.get(k)).toBe('true');
    expect(form.get('electionYearSelection')).toBe('234'); expect(form.get('contributorAddressField')).toBe('true');
    expect(new Headers(q.mock.mock.calls[1][1]!.headers).get('cookie')).toBe('PUBLIC_SESSION=synthetic');
  });
  it('PAC-only excludes every other class selector, retains signed/in-kind rows and boundary report year', async () => {
    const r = cash('REPORTED PAC', '-$5.25'); r[3] = '01/06/2025'; r[0] = 'InKind'; const q = queue([landing, page(headers, [cashHtml(r)]), csv(headers, [r])]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions({ ...input, reportYear: 2024, donorScope: 'pac' });
    expect(result.rows[0]).toMatchObject({ amountCents: -525, type: 'InKind', date: '2025-01-06' });
    const form = new URLSearchParams(q.mock.mock.calls[1][1]!.body as string); expect(form.get('yearSelection')).toBe('2024'); expect(form.get('fromPAC')).toBe('true');
    for (const k of ['fromCandidate', 'fromIndividual', 'fromOrganization']) expect(form.has(k)).toBe(false);
  });
  it('closes ordinary pages and More chunks without deduplicating equal receipts', async () => {
    const r = cash(); const rows = Array.from({ length: 51 }, () => [...r]); const q = queue([landing,
      page(headers, rows.slice(0, 50).map(r => cashHtml(r)), 51, 1, 'ce', true), page(headers, rows.slice(50).map(r => cashHtml(r)), 51, 2, 'ce', true), csv(headers, rows), page(headers, [cashHtml(r)]), csv(headers, [r])]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input);
    expect(result.rows).toHaveLength(52); expect(result.rows[51].occurrence).toBe(51); expect(result.chunks.map(c => [c.declaredCount, c.pages, c.more])).toEqual([[51, 2, true], [1, 1, false]]);
  });
  it('accepts only literal official empty search, without claiming financial zero', async () => {
    const q = queue([landing, '<html><body>No results matched your criteria.</body></html>']); const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input);
    expect(result.rows).toEqual([]); expect(result.chunks[0]).toMatchObject({ declaredCount: 0, csvSha256: null });
    const unknown = queue([landing, '<html><body>Search Results</body></html>']); await expect(createTennesseeVerifiedNativeClient({ fetchImpl: unknown.fetchImpl }).fetchContributions(input)).rejects.toThrow('Missing Tennessee native result table');
  });
  it('retains CP1252 punctuation and native-only address line two', async () => {
    const r = cash('DONOR’S PAC'); r[8] = '10 MAIN ST,SUITE 200,TOWN, TN, 37000'; const h = cashHtml(r); h[8] = '10 MAIN ST<br>SUITE 200<br>TOWN, TN, 37000';
    const encode = (v: string) => Uint8Array.from([...v].map(c => c === '’' ? 0x92 : c.charCodeAt(0))); const q = queue([landing, encode(page(headers, [h])), encode(csv(headers, [r]))]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input);
    expect(result.rows[0].contributorName).toBe('DONOR’S PAC'); expect(result.rows[0].rawFields['Contributor Address']).toContain('SUITE 200'); expect(result.rows[0].contributorAddressLines).toEqual(['10 MAIN ST', 'SUITE 200', 'TOWN, TN, 37000']); expect(result.requests[2].encoding).toBe('windows-1252');
  });
  it.each([1, 4])('retains unsupported %i-line raw address layout for relevant verifier preservation', async lines => {
    const r = cash(); const h = cashHtml(r);
    if (lines === 1) h[8] = r[8];
    else { r[8] = '10 MAIN ST,SUITE 200,EXTRA,TOWN, TN, 37000'; h[8] = '10 MAIN ST<br>SUITE 200<br>EXTRA<br>TOWN, TN, 37000'; }
    const q = queue([landing, page(headers, [h]), csv(headers, [r])]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input); expect(result.rows[0].contributorAddressLines).toHaveLength(lines);
  });
  it('keeps suite text embedded in the street intact rather than treating it as Address2', async () => {
    const r = cash(); r[8] = '10 MAIN ST SUITE 200,TOWN, TN, 37000'; const q = queue([landing, page(headers, [cashHtml(r).map((v, i) => i === 8 ? '10 MAIN ST SUITE 200<br>TOWN, TN, 37000' : v)]), csv(headers, [r])]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input);
    expect(result.rows[0].contributorAddressLines).toEqual(['10 MAIN ST SUITE 200', 'TOWN, TN, 37000']);
  });
  it.each([['date', '02/30/2026'], ['money', '$1.001'], ['money', '$900719925474099.99']])('rejects invalid %s instead of silently dropping rows', async (kind, value) => {
    const r = cash(); r[kind === 'date' ? 3 : 2] = value; const q = queue([landing, page(headers, [cashHtml(r)]), csv(headers, [r])]);
    await expect(createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input)).rejects.toThrow(/date|money|cents/);
  });
  it('rejects same-dollar name replacement, lost occurrence and ambiguous report identity', async () => {
    const r = cash(); const variants: [string[][], string[][]][] = [[[cashHtml(r)], [cash('OTHER PAC')]], [[cashHtml(r), cashHtml(r)], [r]], [[cashHtml(r, '126857'), cashHtml(r, '128008')], [r, r]]];
    for (const [native, exported] of variants) { const q = queue([landing, page(headers, native), csv(headers, exported)]); await expect(createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input)).rejects.toThrow(/mismatch|Ambiguous/); }
  });
  it('rejects page overlap, missing More anchor and exceeded continuation bound', async () => {
    const r = cash(); const first = page(headers, Array.from({ length: 50 }, () => cashHtml(r)), 51); const q = queue([landing, first, first]);
    await expect(createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input)).rejects.toThrow('page range');
    const more = page(headers, [cashHtml(r)], 1, 1, 'ce', true); const missing = queue([landing, more.replace(/<a[^>]*>More<\/a>/, '')]);
    await expect(createTennesseeVerifiedNativeClient({ fetchImpl: missing.fetchImpl }).fetchContributions(input)).rejects.toThrow('More continuation');
    const bounded = queue([landing, more, csv(headers, [r]), more]); await expect(createTennesseeVerifiedNativeClient({ fetchImpl: bounded.fetchImpl, maxChunks: 1 }).fetchContributions(input)).rejects.toThrow('More continuation bound');
  });
  it('rejects login200, incomplete HTML, foreign export and stream byte cap', async () => {
    for (const html of ['<html><input type="password"></html>', '<html>Search Results', page(headers, [cashHtml(cash())]).replace('/tncamp/public/ceresults.htm?d-1341904-e=1', 'https://example.com/tncamp/public/ceresults.htm?d-1341904-e=1')]) {
      const q = queue([landing, html]); await expect(createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchContributions(input)).rejects.toThrow();
    }
    const q = queue([landing]); await expect(createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl, maxResponseBytes: 10 }).fetchContributions(input)).rejects.toThrow('byte bound');
  });
  it('retains closed PAC metadata, duplicate IDs and all continuation chunks', async () => {
    const a = ['', '', 'REPORTED PAC', '', '01/04/2008', '']; const b = ['', '', 'CLOSED PAC', 'AFFILIATION', '01/01/2000', '06/30/2015'];
    const q = queue([landing, page(pacHtmlHeaders, [registryHtml(a, '64'), registryHtml(b, '261')], 2, 1, 'cp', true), csv(pacHeaders, [a, b]), page(pacHtmlHeaders, [registryHtml(a, '64')], 1, 1, 'cp'), csv(pacHeaders, [a])]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchPacRegistry(); expect(result.rows.map(r => r.campId)).toEqual(['64', '261', '64']); expect(result.rows[1]).toMatchObject({ closed: '2015-06-30', committeeAffiliation: 'AFFILIATION', committeeType: 'PAC' });
    const form = new URLSearchParams(q.mock.mock.calls[1][1]!.body as string); expect(form.get('searchType')).toBe('pac'); for (const k of ['name', 'closed', 'electionYearSelection']) expect(form.has(k)).toBe(false);
  });
  it('retains official unescaped ampersands in legal owner names and encodes the safe request', async () => {
    const r = ['', '', "EXAMPLE & ASSOCIATES’ PAC", '', '01/04/2008', ''];
    const h = registryHtml(r, '64'); h[4] = '<a href="/tncamp/public/replist.htm?id=64&owner=EXAMPLE & ASSOCIATES&#146; PAC">Report List</a>';
    const q = queue([landing, page(pacHtmlHeaders, [h], 1, 1, 'cp'), csv(pacHeaders, [r])]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchPacRegistry();
    expect(result.rows[0].ownerName).toBe("EXAMPLE & ASSOCIATES’ PAC");
    const url = new URL(result.rows[0].reportListUrl); expect(url.searchParams.size).toBe(2); expect(url.searchParams.get('owner')).toBe("EXAMPLE & ASSOCIATES’ PAC");
  });
  it('retains same-name different IDs; rejects registry metadata loss and absent IDs', async () => {
    const r = ['', '', 'REPORTED PAC', '', '01/04/2008', '']; const q = queue([landing, page(pacHtmlHeaders, [registryHtml(r, '64'), registryHtml(r, '261')], 2, 1, 'cp'), csv(pacHeaders, [r, r])]);
    expect((await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchPacRegistry()).rows.map(r => r.campId)).toEqual(['64', '261']);
    const changed = [...r]; changed[5] = '01/01/2025'; const bad = queue([landing, page(pacHtmlHeaders, [registryHtml(r, '64')], 1, 1, 'cp'), csv(pacHeaders, [changed])]);
    await expect(createTennesseeVerifiedNativeClient({ fetchImpl: bad.fetchImpl }).fetchPacRegistry()).rejects.toThrow('identity mismatch');
    const h = registryHtml(r, '64'); h[4] = 'Report List'; const missing = queue([landing, page(pacHtmlHeaders, [h], 1, 1, 'cp'), csv(pacHeaders, [r])]);
    await expect(createTennesseeVerifiedNativeClient({ fetchImpl: missing.fetchImpl }).fetchPacRegistry()).rejects.toThrow('registry identity');
  });
  it('retains complete candidate context across offices and closed statuses', async () => {
    const r = ['Ms.', 'FULL MIDDLE', 'NAME', 'Senate', '03', '2026', '', '01/01/2010', '01/01/2025'];
    const h = ['NAME, FULL MIDDLE', ...r.slice(3), '<a href="/tncamp/public/replist.htm?id=794&amp;owner=NAME%2C%20FULL%20MIDDLE">Report List</a>'];
    const hs = ['Name', 'Office Sought', 'District', 'Election Year', 'Committee Affiliation', 'Created', 'Closed', 'Report List']; const q = queue([landing, page(hs, [h], 1, 1, 'cp'), csv(candHeaders, [r])]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchCandidateContext({ name: 'NAME', electionYear: 2026 });
    expect(result.rows[0]).toMatchObject({ campId: '794', name: 'NAME, FULL MIDDLE', officeSought: 'Senate', district: '03', closed: '2025-01-01', electionYear: 2026 }); expect(result.rows[0].rawFields.Salutation).toBe('Ms.');
    const form = new URLSearchParams(q.mock.mock.calls[1][1]!.body as string); expect(form.has('officeSelection')).toBe(false); expect(form.has('status')).toBe(false); expect(form.get('closedField')).toBe('true');
  });
  it('isolates concurrent sessions and does not impose an absent election filter', async () => {
    const calls: RequestInit[] = []; const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => { calls.push(init); return new Response(init.method === 'POST' ? '<html>No results matched your criteria.</html>' : landing, { headers: { 'set-cookie': 'PUBLIC_SESSION=synthetic' } }); }) as unknown as typeof fetch;
    const client = createTennesseeVerifiedNativeClient({ fetchImpl }); await Promise.all([client.fetchContributions({ ...input, electionYear: undefined }), client.fetchPacRegistry()]);
    const contribution = calls.find(c => String(c.body).includes('searchType=contributions'))!; expect(new URLSearchParams(contribution.body as string).has('electionYearSelection')).toBe(false); expect(calls.filter(c => c.method === 'GET').every(c => !new Headers(c.headers).has('cookie'))).toBe(true);
  });
});
describe('complete native independent expenditure acquisition', () => {
  function ieRow(amount = '$20,307.51', stance = 'S'): string[] {
    return ['Independent', 'N', amount, '07/27/2026', '', 'Pre-Primary', 'STUDENT SUCCESS ACTION', 'VENDOR', '10 MAIN ST,TOWN, TN, 37000', 'CONTRIBUTION', 'CROWE, RUSTY', stance];
  }
  function ieHtml(r: string[]): string[] { return r.map((v, i) => i === 5 ? '<a href="/tncamp/search/pub/report_full.htm?reportId=127862">' + v + '</a>' : i === 8 ? v.replace('ST,', 'ST<br>') : v); }
  it('queries Independent with no election filter and retains full identity and repeated source occurrences', async () => {
    const r = ieRow(); const q = queue([landing, page(ieHeaders, [ieHtml(r), ieHtml(r), ieHtml(r)]), csv(ieHeaders, [r, r, r])]);
    const result = await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchIndependentExpenditures({ reportYear: 2026 });
    expect(result.rows.map(r => r.occurrence)).toEqual([0, 1, 2]);
    expect(result.rows[0]).toMatchObject({ type: 'Independent', amountCents: 2030751, electionYear: null, purpose: 'CONTRIBUTION', payerName: 'STUDENT SUCCESS ACTION', targetName: 'CROWE, RUSTY', supportOpposeCode: 'S', reportId: '127862' });
    expect(Object.keys(result.rows[0].rawFields)).toEqual([...ieHeaders]); expect(result.rows[0].vendorAddressLines).toEqual(['10 MAIN ST', 'TOWN, TN, 37000']);
    const form = new URLSearchParams(q.mock.mock.calls[1][1]!.body as string);
    expect(form.get('searchType')).toBe('expenditures'); expect(form.get('typeOf')).toBe('independent'); expect(form.get('toType')).toBe('both');
    for (const k of ['toCandidate', 'toPac', 'toOther', 'vendorAddressField']) expect(form.get(k)).toBe('true');
    expect(form.has('electionYearSelection')).toBe(false);
  });
  it('retains signed amounts and blank target/direction without guessing an allocation', async () => {
    const r = ieRow('-$5.25', ''); r[10] = ''; const q = queue([landing, page(ieHeaders, [ieHtml(r)]), csv(ieHeaders, [r])]);
    expect((await createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchIndependentExpenditures({ reportYear: 2025 })).rows[0]).toMatchObject({ amountCents: -525, supportOpposeCode: '', targetName: '' });
  });
  it.each(['type', 'stance', 'target', 'vendorAddress', 'report'])('rejects unexplained %s source changes', async kind => {
    const r = ieRow(); const native = ieHtml(r); const exported = [...r];
    if (kind === 'type') { native[0] = 'Monetary'; exported[0] = 'Monetary'; }
    if (kind === 'stance') { native[11] = 'ASSIST'; exported[11] = 'ASSIST'; }
    if (kind === 'target') exported[10] = 'OTHER, PERSON';
    if (kind === 'vendorAddress') exported[8] = 'DIFFERENT STREET,TOWN, TN, 37000';
    if (kind === 'report') native[5] = 'Pre-Primary';
    const q = queue([landing, page(ieHeaders, [native]), csv(ieHeaders, [exported])]);
    await expect(createTennesseeVerifiedNativeClient({ fetchImpl: q.fetchImpl }).fetchIndependentExpenditures({ reportYear: 2026 })).rejects.toThrow();
  });
});
describe('strict Tennessee CSV', () => {
  it.each(['Type,Type\nMonetary,Monetary\n', csv(headers, [cash().slice(0, 11)]), csv(headers, [cash()]).slice(0, -1), csv(headers, [cash()]) + '\n', csv(headers, [cash()]).replace('"Monetary"', '"Monetary"x'), csv(headers, [cash()]).slice(0, -2) + '\n', '<html>login</html>\n'])('rejects malformed headers, width, EOF and quotes', value => { expect(() => parseTennesseeVerifiedNativeCsv(value, headers)).toThrow(); });
});

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFloridaFinanceRawSourceClient,
  type FloridaFinanceRawRequest,
} from "../../../src/pipeline/floridaFinance/floridaFinanceRawSourceClient.js";
import {
  createFloridaProcessedExpenseSourceLoader,
  type FloridaProcessedExpenseRequest,
} from "../../../src/pipeline/floridaFinance/floridaProcessedExpenseSourceLoader.js";
import {
  verifyFloridaProcessedExpenseSource,
  type FloridaProcessedExpenseContext,
} from "../../../src/pipeline/floridaFinance/floridaProcessedExpenseSource.js";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

// Synthetic complete current protocol. These do not claim real candidate money.
const DOS = "https://dos.elections.myflorida.com";
const context: FloridaProcessedExpenseContext = {
  payerAccount: "93271",
  payerName: "Example IE Organization",
  payerType: "IXO",
  electionYear: 2026,
  electionType: "general",
  electionDescription: "2026 General Election",
  electionSelector: "20261103-GEN",
  genericPayerLabel: "Example IE Organization (IXO)",
};
const wrap = (body: string) => `<html><body>${body}</body></html>`;
const owner = () =>
  wrap(`<h2>Committee Tracking System</h2><table><tr><td colspan=2><font size=+1>${context.payerName}</font></td></tr>
<tr><td>Type:</td><td>Independent Expenditures Organization</td></tr><tr><td>Status:</td><td>Active</td></tr>
<tr><td>Address:</td><td>1 Legal St<br>City, FL 12345</td></tr></table><input type=hidden name=account value="93271">`);
function cover() {
  const row = (
    selector: string,
    period: string,
    expense: string,
    receipts = "0.00",
  ) =>
    `<tr><td>${selector}</td><td>${period}</td><td>${receipts}</td><td>0.00</td><td>0.00</td><td>${expense}</td><td>0.00</td><td>0.00</td></tr>`;
  return wrap(`<input name="account" value="93271"><table><tr><th></th><th>Filing Period</th><th>Contributions</th><th>Expend</th><th>Other</th><th>Transfers</th></tr><tr><th>Monetary</th><th>Loans</th><th>InKind</th></tr>
${row("W", "07/01/2026 - 07/31/2026", "0.00")}${row('<input type="radio" name="seqnum" value="2">', "08/01/2026 - 08/13/2026", "700.00", "999.00")}
${row("W", "08/14/2026 - 08/14/2026", "0.00")}${row('<input type="radio" name="seqnum" value="0">', "All Dates (Totals)", "700.00", "999.00")}</table>`);
}
const financial = [
  [
    "08/02/2026",
    "500.00",
    "Example Vendor",
    "1 Vendor St",
    "City FL 12345",
    "TEXT MESSAGES; PRO-FULL PERSON, HD-80",
    "IEC",
  ],
  [
    "08/03/2026",
    "100.00",
    "Example Vendor",
    "1 Vendor St",
    "City FL 12345",
    "Ordinary expense",
    "MON",
  ],
  [
    "08/03/2026",
    "100.00",
    "Example Vendor",
    "1 Vendor St",
    "City FL 12345",
    "Ordinary expense",
    "MON",
  ],
];
const native = () =>
  "Rpt Yr\tRpt Type\tDate\tAmount\tExpense Paid To\tAddress\tCity State Zip\tPurpose\tTyp Reimb\n" +
  financial.map((row) => ["2026", "P7", ...row].join("\t")).join("\n") +
  "\n";
const generic = () =>
  "Candidate/Committee\tDate\tAmount\tPayee Name\tAddress\tCity State Zip\tPurpose\tType\n" +
  financial
    .map((row) => [context.genericPayerLabel, ...row].join("\t"))
    .join("\n") +
  "\n";
function efs(sequence: number): string {
  const waiver = sequence === 1 || sequence === 4;
  const fields = {
    lblID: "93271",
    lblFullName: context.payerName,
    lblElectionID: "2026 General Election",
    lblReportIdentifier: `Report: 2026 - ${sequence === 1 ? "P6" : sequence === 3 ? "P7" : sequence === 4 ? "P7A" : "G1"} - ${sequence}`,
    lblCoveragePeriod:
      sequence === 1
        ? "7/1/2026-7/31/2026"
        : sequence === 3
          ? "8/1/2026-8/13/2026"
          : sequence === 4
            ? "8/14/2026-8/14/2026"
            : "8/15/2026-8/21/2026",
    lblFileStatus: sequence === 2 ? "Data Entry" : "Filed Report",
    lblReviewStatus: "Reviewed",
    lblCompletenessStatus:
      sequence === 3 ? "Complete Detail Records" : "No Detail Records Found",
    lblQueuedItems: "0",
    lblCntExp: sequence === 3 ? "3" : "0",
    lblCntCon: "0",
    lblCntXfr: "0",
    lblCntOth: "0",
  };
  return wrap(
    Object.entries(fields)
      .map(([key, value]) => `<span id="${key}">${value}</span>`)
      .join("") +
      `<input id="chkAmended" type="checkbox" ${sequence === 3 ? "checked" : ""}><input id="chkWaiver" type="checkbox" ${waiver ? "checked" : ""}>`,
  );
}
function bodyFor(request: FloridaFinanceRawRequest): {
  body: string;
  status: number;
  contentType: string;
} {
  const url = new URL(request.url),
    sequence = Number(url.searchParams.get("SeqNum"));
  if (url.pathname.endsWith("ComDetail.asp"))
    return { body: owner(), status: 200, contentType: "text/html" };
  if (url.pathname.endsWith("TreSel.exe"))
    return { body: cover(), status: 200, contentType: "text/html" };
  if (url.pathname.endsWith("TreFin.exe"))
    return {
      body: native(),
      status: 200,
      contentType: "text/tab-separated-values",
    };
  if (url.pathname.endsWith("expend.exe"))
    return {
      body: generic(),
      status: 200,
      contentType: "text/tab-separated-values",
    };
  return sequence <= 4
    ? { body: efs(sequence), status: 200, contentType: "text/html" }
    : { body: wrap("No report found"), status: 404, contentType: "text/html" };
}
type Call = {
  request: FloridaFinanceRawRequest;
  savedFirst?: boolean;
  closing: boolean;
};
function mock(
  transform?: (body: string, call: Call) => string,
  change?: (raw: FloridaProcessedRawEvidence, call: Call) => void,
) {
  const calls: Call[] = [];
  const captures: FloridaProcessedRawEvidence[] = [];
  let owners = 0;
  const request: FloridaProcessedExpenseRequest = async (req, options) => {
    if (req.url.includes("ComDetail.asp")) owners++;
    const call = {
      request: structuredClone(req),
      savedFirst: options?.savedFirst,
      closing: owners > 1,
    };
    calls.push(call);
    const packet = bodyFor(req),
      bytesRaw = new TextEncoder().encode(
        transform?.(packet.body, call) ?? packet.body,
      );
    const raw: FloridaProcessedRawEvidence = {
      ...structuredClone(req),
      bytesRaw,
      sha256: createHash("sha256").update(bytesRaw).digest("hex"),
      status: packet.status,
      contentType: packet.contentType,
      startedAt: `2026-10-11T21:${call.closing ? "42" : "40"}:00Z`,
      completedAt: `2026-10-11T21:${call.closing ? "42" : "40"}:01Z`,
    };
    change?.(raw, call);
    captures.push(raw);
    return raw;
  };
  return { request, calls, captures };
}
const dirs: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "florida-expense-loader-"));
  dirs.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Florida current expense packet loader", () => {
  it("closes trailing waivers and independent native/EFS keys with real pure verification", async () => {
    const m = mock();
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load({ context });
    expect(result.proof?.rows).toHaveLength(3);
    expect(
      result.proof?.rows.reduce((sum, row) => sum + row.amountCents, 0),
    ).toBe(70000);
    expect(
      result.proof?.reports.map((r) => [
        r.cover.nativeSequence,
        r.current.sequence,
        r.current.waiver,
      ]),
    ).toEqual([
      [null, 1, true],
      [2, 3, false],
      [null, 4, true],
    ]);
    expect(result.proof?.candidateWideZeroAuthority).toBe(false);
    expect(
      m.calls.filter((c) => !c.closing).every((c) => c.savedFirst === true),
    ).toBe(true);
    expect(
      m.calls.filter((c) => c.closing).every((c) => c.savedFirst === false),
    ).toBe(true);
    expect(
      m.calls
        .filter((c) => c.request.url.includes("TreFin.exe"))
        .map((c) => c.request.financeFields?.seqnum),
    ).toEqual(["0", "2", "0", "2"]);
    expect(
      m.calls.filter((c) => c.request.url.includes("SeqNum=")),
    ).toHaveLength(10);
    expect(
      result.source && verifyFloridaProcessedExpenseSource(result.source).proof,
    ).toEqual(result.proof);
  });
  it("refresh bypasses every opening and fresh closing still uses no saved data", async () => {
    const m = mock();
    await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
      refresh: true,
    }).load({ context });
    expect(m.calls.every((c) => c.savedFirst === false)).toBe(true);
  });
  it("real cache keeps original opening times and live fallback/closing captures stay genuine", async () => {
    const cacheDir = await directory();
    const fetchFn = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const req: FloridaFinanceRawRequest = {
          url: String(url),
          method: init?.method as "POST" | "GET",
          financeFields: init?.body
            ? Object.fromEntries(new URLSearchParams(String(init.body)))
            : null,
        };
        const packet = bodyFor(req);
        return new Response(packet.body, {
          status: packet.status,
          headers: { "content-type": packet.contentType },
        });
      },
    );
    const first = await createFloridaProcessedExpenseSourceLoader({
      request: createFloridaFinanceRawSourceClient({
        cacheDir,
        fetchFn,
        minIntervalMs: 0,
      }).request,
    }).load({ context });
    expect(first.proof).toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(20);
    const second = await createFloridaProcessedExpenseSourceLoader({
      request: createFloridaFinanceRawSourceClient({
        cacheDir,
        fetchFn,
        minIntervalMs: 0,
      }).request,
    }).load({ context });
    expect(second.proof).toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(31);
    const oldClosing = first
      .proof!.sourceMetadata.filter((r) => r.phase === "after")
      .map(({ phase: _, ...r }) => r);
    const savedOpening = second
      .proof!.sourceMetadata.filter((r) => r.phase === "before")
      .map(({ phase: _, ...r }) => r);
    expect(savedOpening).toEqual(oldClosing);
  });
  it("missing trailing W status preserves instead of accepting only positive periods", async () => {
    const m = mock(undefined, (r, c) => {
      if (c.request.url.endsWith("SeqNum=4")) r.status = 404;
    });
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load({ context });
    expect(result.proof).toBeUndefined();
    expect(result.source).toBeUndefined();
    expect(result.diagnostics.join()).toContain("2026-08-14/2026-08-14 has 0");
  });
  it("does not turn unfiled Data Entry into an empty/waived report", async () => {
    const m = mock();
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load({ context });
    expect(result.proof?.reports.some((r) => r.current.sequence === 2)).toBe(
      false,
    );
    expect(result.diagnostics.join()).toContain("unused status candidates");
  });
  it("an extra filed report absent from the native activity preserves", async () => {
    const m = mock((body, c) =>
      c.request.url.endsWith("SeqNum=2")
        ? body.replace("Data Entry", "Filed Report")
        : body,
    );
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load({ context });
    expect(result.proof).toBeUndefined();
    expect(result.diagnostics.join()).toContain("absent from native activity");
  });
  it("ambiguous returned coverage does not pick a latest sequence", async () => {
    const m = mock((body, c) =>
      c.request.url.endsWith("SeqNum=2")
        ? efs(3).replace("P7 - 3", "P7 - 2")
        : body,
    );
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load({ context });
    expect(result.proof).toBeUndefined();
    expect(result.diagnostics.join()).toContain("2 EFS matches");
  });
  it("only explicit complete waiver/count metadata can close W", async () => {
    const m = mock((body, c) =>
      c.request.url.endsWith("SeqNum=4")
        ? body.replace('<span id="lblCntCon">0</span>', "")
        : body,
    );
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load({ context });
    expect(result.proof).toBeUndefined();
    expect(result.source).toBeUndefined();
  });
  it("retains context/raw packets before caller or returned evidence mutations", async () => {
    const input = { context: { ...context } };
    const m = mock(undefined, (_r, c) => {
      if (c.request.url.includes("ComDetail.asp"))
        input.context.payerAccount = "99999";
    });
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load(input);
    expect(result.source?.context.payerAccount).toBe("93271");
    for (const raw of m.captures) raw.bytesRaw.fill(0);
    expect(
      result.source && verifyFloridaProcessedExpenseSource(result.source).proof,
    ).toEqual(result.proof);
    result.source!.before.allDatesExport.bytesRaw.fill(0);
    expect(result.proof?.rows[0]?.purpose).toBe(financial[0]![5]);
  });
  const mutations: [string, (body: string, c: Call) => string][] = [
    [
      "changed current amendment",
      (b, c) =>
        c.closing && c.request.url.endsWith("SeqNum=3")
          ? b.replace('type="checkbox" checked', 'type="checkbox"')
          : b,
    ],
    [
      "changed complete payer fields",
      (b, c) =>
        c.closing && c.request.url.includes("ComDetail.asp")
          ? b.replace("1 Legal St", "2 Legal St")
          : b,
    ],
    [
      "coherent same-dollar changed vendor",
      (b, c) =>
        c.closing ? b.replaceAll("Example Vendor", "Different Vendor") : b,
    ],
    [
      "wrong payer name",
      (b, c) =>
        c.request.url.includes("ComDetail.asp")
          ? b.replace(context.payerName, "Other Organization")
          : b,
    ],
    [
      "wrong current EFS account",
      (b, c) =>
        c.request.url.endsWith("SeqNum=3")
          ? b.replace('id="lblID">93271', 'id="lblID">99999')
          : b,
    ],
    [
      "wrong current EFS sequence",
      (b, c) =>
        c.request.url.endsWith("SeqNum=3") ? b.replace("P7 - 3", "P7 - 41") : b,
    ],
    [
      "missing full generic occurrence",
      (b, c) =>
        c.request.url.endsWith("expend.exe")
          ? b.split("\n").slice(0, -2).join("\n") + "\n"
          : b,
    ],
    [
      "error HTML instead of native export",
      (b, c) =>
        c.request.url.endsWith("TreFin.exe")
          ? wrap("Invalid Date Range Entered")
          : b,
    ],
  ];
  it.each(mutations)("preserves on %s", async (_label, transform) => {
    const m = mock(transform);
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load({ context });
    expect(result.proof).toBeUndefined();
    expect(result.source).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it("wrong query metadata/hash/time are not accepted as raw authority", async () => {
    for (const change of [
      (r: FloridaProcessedRawEvidence) => {
        if (r.financeFields) r.financeFields = {};
      },
      (r: FloridaProcessedRawEvidence) => {
        r.sha256 = "a".repeat(64);
      },
      (r: FloridaProcessedRawEvidence) => {
        r.completedAt = "2026-01-01T00:00:00Z";
      },
    ]) {
      const m = mock(undefined, change);
      expect(
        (
          await createFloridaProcessedExpenseSourceLoader({
            request: m.request,
          }).load({ context })
        ).proof,
      ).toBeUndefined();
    }
  });
  it("generic cap, discovery slot cap and request budget preserve", async () => {
    for (const bounds of [
      { rowLimit: 3 },
      { maxReportSlots: 2 },
      { maxRequests: 12 },
    ]) {
      const m = mock();
      const result = await createFloridaProcessedExpenseSourceLoader({
        request: m.request,
        ...bounds,
      }).load({ context });
      expect(result.proof).toBeUndefined();
      expect(result.source).toBeUndefined();
    }
  });
  it("transport failure remains omission even during an unused sequence probe", async () => {
    const m = mock();
    const request: FloridaProcessedExpenseRequest = async (q, o) => {
      if (q.url.endsWith("SeqNum=5")) throw new Error("transport failed");
      return m.request(q, o);
    };
    const result = await createFloridaProcessedExpenseSourceLoader({
      request,
    }).load({ context });
    expect(result).toMatchObject({ diagnostics: ["transport failed"] });
    expect(result).not.toHaveProperty("source");
  });
  it("stale closing capture cannot masquerade as fresh closure", async () => {
    const m = mock(undefined, (r, c) => {
      if (c.closing) r.startedAt = "2026-10-11T21:39:00Z";
    });
    const result = await createFloridaProcessedExpenseSourceLoader({
      request: m.request,
    }).load({ context });
    expect(result.proof).toBeUndefined();
    expect(result.diagnostics.join()).toContain("closing predates");
  });
  it.each([
    { payerAccount: "0" },
    { payerType: "ECO" },
    { electionYear: 2028 },
    { electionSelector: "All" },
    { genericPayerLabel: "Another Organization (IXO)" },
    { electionDescription: "2026 Primary Election" },
  ])("unsupported input scope rejects before acquisition", async (change) => {
    const request = vi.fn();
    const result = await createFloridaProcessedExpenseSourceLoader({
      request,
    }).load({
      context: { ...context, ...change } as FloridaProcessedExpenseContext,
    });
    expect(result.proof).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

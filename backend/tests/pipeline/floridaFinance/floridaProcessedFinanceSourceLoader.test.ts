import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FloridaFinanceRawRequest } from "../../../src/pipeline/floridaFinance/floridaFinanceRawSourceClient.js";
import {
  createFloridaProcessedFinanceSourceLoader,
  type FloridaProcessedSourceRequest,
} from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSourceLoader.js";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

// Synthetic complete publication protocol, not a claim about real accepted funds.
const context = {
  sourceAccount: "88807",
  candidateName: "Example Candidate",
  electionYear: 2026,
  officeName: "State Representative",
  district: "80",
  genericRecipientName: "Candidate, Example  (REP)(STR)",
};
const input = () => ({
  context: { ...context },
  windowStart: "2025-01-01",
  windowEnd: "2026-10-11",
});
const nativeHeader =
  "Rpt Yr\tRpt Type\tDate\tAmount\tContributor Name\tAddress\tCity State Zip\tOccupation\tTyp\tInKind Desc";
const genericHeader =
  "Candidate/Committee\tDate\tAmount\tTyp\tContributor Name\tAddress\tCity State Zip\tOccupation\tInkind Desc";
const fields = {
  account: "88807",
  candname: "Example Candidate (REP)",
  elecdesc: "2026 General Election",
  office: "State Representative",
  CanCom: "Cand",
};
const wrap = (body: string) => `<html><body>${body}</body></html>`;
const hidden = () =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
    .join("");
const owner = () =>
  wrap(
    `Candidate Tracking System Example Candidate 2026 General Election State Representative District 80 ${hidden()} Address`,
  );
const financial = [
  [
    "2026",
    "Q1",
    "01/05/2026",
    "1000.00",
    "EXAMPLE PAC",
    "1 Main St.",
    "City FL 12345",
    "",
    "CHE",
    "",
  ],
  [
    "2026",
    "Q1",
    "01/05/2026",
    "1000.00",
    "EXAMPLE PAC",
    "1 Main St.",
    "City FL 12345",
    "",
    "CHE",
    "",
  ],
  [
    "2026",
    "Q1",
    "03/30/2026",
    "-500.00",
    "EXAMPLE PAC",
    "1 Main St.",
    "City FL 12345",
    "",
    "REF",
    "",
  ],
  [
    "2026",
    "Q3",
    "07/05/2026",
    "100.00",
    "EXAMPLE DONOR",
    "2 Main St.",
    "City FL 12345",
    "",
    "CHE",
    "",
  ],
];
const native = (sequence: number) =>
  `${nativeHeader}\n${financial
    .filter(
      (r) => sequence === 0 || (sequence === 1 ? r[1] === "Q1" : r[1] === "Q3"),
    )
    .map((r) => r.join("\t"))
    .join("\n")}\n`;
const generic = () =>
  `${genericHeader}\n${financial.map((r) => [context.genericRecipientName, r[2], r[3], r[8], r[4], r[5], r[6], r[7], r[9]].join("\t")).join("\n")}\n`;
function activity(trailingWaiver = false) {
  const row = (selector: string, period: string, cash: string) =>
    `<tr><td>${selector}</td><td>${period}</td><td>${cash}</td><td>0.00</td><td>0.00</td><td>0.00</td><td>0.00</td><td>0.00</td></tr>`;
  return wrap(
    `${hidden()}<table>${row('<input name="seqnum" value="1">', "01/01/2026 - 03/31/2026", "1,500.00")}${row("W", "04/01/2026 - 06/30/2026", "0.00")}${row('<input name="seqnum" value="3">', "07/01/2026 - 09/30/2026", "100.00")}${trailingWaiver ? row("W", "10/01/2026 - 10/11/2026", "0.00") : ""}</table>`,
  );
}
function efs(
  sequence: number,
  overrides: Record<string, string> = {},
  waiver = sequence === 2,
) {
  const period =
    sequence === 1
      ? "1/1/2026-3/31/2026"
      : sequence === 2
        ? "4/1/2026-6/30/2026"
        : "7/1/2026-9/30/2026";
  const metadata = {
    lblID: "88807",
    lblFullName: "Example Candidate",
    lblElectionID: "2026 General Election",
    lblReportIdentifier: `Report: 2026 - Q${sequence} - ${sequence}`,
    lblCoveragePeriod: period,
    lblReportDue: "10/10/2026",
    lblDateFiled: "10/9/2026 8:47:24 PM",
    lblDateReviewed: "10/10/2026",
    lblFileStatus: "Filed Report",
    lblReviewStatus: "Reviewed",
    lblCompletenessStatus: waiver
      ? "No Detail Records Found"
      : "Complete Detail Records",
    lblQueuedItems: "0",
    lblCntCon: String(sequence === 1 ? 3 : sequence === 2 ? 0 : 1),
    lblCntExp: "0",
    lblCntXfr: "0",
    lblCntOth: "0",
    ...overrides,
  };
  return wrap(
    `${Object.entries(metadata)
      .map(([k, v]) => `<span id="${k}">${v}</span>`)
      .join(
        "",
      )}<input id="chkAmended" type="checkbox" checked="checked"><input id="chkWaiver" type="checkbox" ${waiver ? 'checked="checked"' : ""}>`,
  );
}
type Call = {
  request: FloridaFinanceRawRequest;
  savedFirst: boolean | undefined;
  closing: boolean;
};
function fixture(transform?: (body: string, call: Call) => string) {
  const calls: Call[] = [];
  let ownershipCalls = 0;
  const request: FloridaProcessedSourceRequest = async (request, options) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("CanDetail.asp")) ownershipCalls++;
    const closing = ownershipCalls > 1;
    const call = {
      request: structuredClone(request),
      savedFirst: options?.savedFirst,
      closing,
    };
    calls.push(call);
    let body: string;
    if (url.pathname.endsWith("CanDetail.asp")) body = owner();
    else if (url.pathname.endsWith("TreSel.exe")) body = activity();
    else if (url.hostname === "efs.dos.state.fl.us")
      body = efs(Number(url.searchParams.get("SeqNum")));
    else if (url.pathname.endsWith("TreFin.exe"))
      body = native(Number(request.financeFields?.seqnum));
    else if (url.pathname.endsWith("contrib.exe")) body = generic();
    else throw new Error("unexpected fixture request");
    body = transform?.(body, call) ?? body;
    const bytesRaw = new TextEncoder().encode(body);
    const second = calls.length * 2;
    const raw: FloridaProcessedRawEvidence = {
      bytesRaw,
      sha256: createHash("sha256").update(bytesRaw).digest("hex"),
      ...structuredClone(request),
      status: 200,
      contentType: body.startsWith("<html>")
        ? "text/html; charset=utf-8"
        : "text/tab-separated-values",
      startedAt: new Date(Date.UTC(2026, 9, 11, 20, 0, second)).toISOString(),
      completedAt: new Date(
        Date.UTC(2026, 9, 11, 20, 0, second + 1),
      ).toISOString(),
    };
    return raw;
  };
  return { calls, request };
}
const load = (source: ReturnType<typeof fixture>, options = {}) =>
  createFloridaProcessedFinanceSourceLoader({
    request: source.request,
    ...options,
  }).load(input());

describe("Florida processed source loader (synthetic publication protocol)", () => {
  it("composes real source decoders and verifier, allowing current amended and independently proven waiver", async () => {
    const source = fixture();
    const result = await load(source);
    expect(result.diagnostics).toEqual([]);
    expect(
      result.proof?.reports.map((r) => [
        r.sequence,
        r.nativeSequence,
        r.waiver,
      ]),
    ).toEqual([
      [1, 1, false],
      [2, null, true],
      [3, 3, false],
    ]);
    expect(result.proof?.rows).toHaveLength(4);
    expect(
      result.proof?.rows.filter((r) => r.amount === "1000.00"),
    ).toHaveLength(2);
    expect(
      result.proof?.nativeRows.filter((r) => r.transactionType === "REF")[0]
        .amountCents,
    ).toBe(-50000);
    expect(
      source.calls
        .filter((c) => c.request.url.includes("TreFin.exe"))
        .map((c) => c.request.financeFields?.seqnum),
    ).toEqual(["1", "3", "0", "1", "3", "0"]);
    expect(source.calls).toHaveLength(18);
    expect(
      source.calls
        .filter((c) => !c.closing)
        .every((c) => c.savedFirst === true),
    ).toBe(true);
    expect(
      source.calls
        .filter((c) => c.closing)
        .every((c) => c.savedFirst === false),
    ).toBe(true);
  });
  it("refresh bypasses every saved opening while closings remain fresh", async () => {
    const source = fixture();
    expect((await load(source, { refresh: true })).proof).toBeDefined();
    expect(source.calls.every((c) => c.savedFirst === false)).toBe(true);
  });
  it("retains cached original capture times instead of retiming openings", async () => {
    const source = fixture();
    const request: FloridaProcessedSourceRequest = async (req, options) => {
      const raw = await source.request(req, options);
      return options?.savedFirst
        ? {
            ...raw,
            startedAt: "2026-10-10T00:00:00Z",
            completedAt: "2026-10-10T00:00:01Z",
          }
        : raw;
    };
    const result = await createFloridaProcessedFinanceSourceLoader({
      request,
    }).load(input());
    expect(
      result.proof?.sourceMetadata
        .filter((r) => r.phase === "before")
        .every((r) => r.startedAt === "2026-10-10T00:00:00Z"),
    ).toBe(true);
    expect(
      result.proof?.sourceMetadata
        .filter((r) => r.phase === "after")
        .every((r) => r.startedAt.startsWith("2026-10-11")),
    ).toBe(true);
  });
  it("never invents a waived zero from a missing trailing EFS status", async () => {
    const source = fixture((body, c) =>
      c.request.url.includes("TreSel.exe") ? activity(true) : body,
    );
    const result = await load(source);
    expect(result.proof).toBeUndefined();
    expect(result.diagnostics[0]).toContain("coverage missing");
    expect(source.calls.some((c) => c.request.url.includes("SeqNum=4"))).toBe(
      false,
    );
  });
  it.each([
    ["lblID", "88808", "account/coverage"],
    ["lblCoveragePeriod", "4/2/2026-6/30/2026", "account/coverage"],
    ["lblReportIdentifier", "Report: 2026 - Q2 - 3", "account/coverage"],
    ["lblFullName", "Different Candidate", "account/coverage"],
  ])(
    "rejects discovered status with contradictory %s",
    async (key, value, message) => {
      const source = fixture((body, c) =>
        c.request.url.includes("SeqNum=2") ? efs(2, { [key]: value }) : body,
      );
      expect((await load(source)).diagnostics[0]).toContain(message);
    },
  );
  it.each([
    "Amending Report",
    "Updated - Needs Review",
    "Incomplete Detail Records",
  ])("omits monetary proof for unfinished current state %s", async (state) => {
    const key =
      state === "Amending Report"
        ? "lblFileStatus"
        : state.includes("Review")
          ? "lblReviewStatus"
          : "lblCompletenessStatus";
    const source = fixture((body, c) =>
      c.request.url.includes("SeqNum=1") ? efs(1, { [key]: state }) : body,
    );
    expect((await load(source)).diagnostics[0]).toContain(
      "not filed/reviewed/complete",
    );
  });
  it("preserves when checked waiver status is absent despite zero native cover", async () => {
    const source = fixture((body, c) =>
      c.request.url.includes("SeqNum=2")
        ? efs(2, { lblCompletenessStatus: "Complete Detail Records" }, false)
        : body,
    );
    expect((await load(source)).diagnostics[0]).toContain(
      "unproved omitted period",
    );
  });
  it("omits source on missing status body rather than partial cycle acceptance", async () => {
    const source = fixture((body, c) =>
      c.request.url.includes("SeqNum=2") ? wrap("No report found") : body,
    );
    expect((await load(source)).proof).toBeUndefined();
  });
  it("rejects changed coherent closing identities even when cents and counts agree", async () => {
    const source = fixture((body, c) =>
      c.closing ? body.replace(/EXAMPLE PAC/g, "RENAMED PAC") : body,
    );
    expect((await load(source)).diagnostics[0]).toContain(
      "changed between captures",
    );
  });
  it.each(["EXAMPLE PAC", "1 Main St."])(
    "rejects same-money full-field generic mismatch in %s",
    async (field) => {
      const source = fixture((body, c) =>
        c.request.url.includes("contrib.exe")
          ? body.replaceAll(field, "CHANGED")
          : body,
      );
      expect((await load(source)).diagnostics[0]).toContain(
        "full financial multiset mismatch",
      );
    },
  );
  it("does not economically deduplicate a lost equal occurrence", async () => {
    const source = fixture((body, c) =>
      c.request.url.includes("contrib.exe")
        ? body
            .split("\n")
            .filter((_, i) => i !== 2)
            .join("\n")
        : body,
    );
    expect((await load(source)).diagnostics[0]).toContain("multiset mismatch");
  });
  it("retains context and request fields across caller mutation", async () => {
    const source = fixture();
    const bag = input();
    let once = false;
    const request: FloridaProcessedSourceRequest = async (req, options) => {
      if (!once) {
        once = true;
        bag.context.sourceAccount = "88773";
        bag.context.candidateName = "Changed";
        bag.windowStart = "2026-01-01";
      }
      return source.request(req, options);
    };
    const result = await createFloridaProcessedFinanceSourceLoader({
      request,
    }).load(bag);
    expect(result.proof?.context).toEqual(context);
    expect(result.proof?.windowStart).toBe("2025-01-01");
    expect(
      source.calls.find((c) => c.request.url.includes("contrib.exe"))?.request
        .financeFields,
    ).toMatchObject({
      CanFName: "Example",
      CanLName: "Candidate",
      cdatefrom: "01/01/2025",
      election: "20261103-GEN",
    });
  });
  it("stops wrong ownership before native queries", async () => {
    const source = fixture((body, c) =>
      c.request.url.includes("CanDetail.asp")
        ? body.replaceAll("88807", "88773")
        : body,
    );
    expect((await load(source)).diagnostics[0]).toContain("owner mismatch");
    expect(source.calls).toHaveLength(1);
  });
  it("bounded status discovery and total request budget preserve without truncating", async () => {
    const first = fixture();
    expect((await load(first, { maxReportSlots: 2 })).diagnostics[0]).toContain(
      "over bound",
    );
    expect(first.calls).toHaveLength(2);
    const second = fixture();
    expect((await load(second, { maxRequests: 9 })).diagnostics[0]).toContain(
      "budget exhausted",
    );
    expect(second.calls).toHaveLength(9);
  });
  it("rejects capped generic output and partial TSV rather than zero", async () => {
    expect((await load(fixture(), { rowLimit: 4 })).diagnostics[0]).toContain(
      "capped",
    );
    const source = fixture((body, c) =>
      c.request.url.includes("TreFin.exe") ? body + "partial\n" : body,
    );
    expect((await load(source)).diagnostics[0]).toContain("partial TSV");
  });
  it("retains source failure diagnostics without returning partial proof", async () => {
    const source = fixture();
    const request: FloridaProcessedSourceRequest = async (req, options) => {
      if (req.url.includes("contrib.exe"))
        throw new Error("public source timed out");
      return source.request(req, options);
    };
    const result = await createFloridaProcessedFinanceSourceLoader({
      request,
    }).load(input());
    expect(result).toEqual({ diagnostics: ["public source timed out"] });
  });
  it("rejects unsupported election/name/window before making any requests", async () => {
    const source = fixture();
    for (const change of [
      { context: { ...context, electionYear: 2028 } },
      {
        context: {
          ...context,
          genericRecipientName: "Different, Person  (REP)(STR)",
        },
      },
      { windowStart: "2026-02-30" },
    ])
      expect(
        (
          await createFloridaProcessedFinanceSourceLoader({
            request: source.request,
          }).load({ ...input(), ...change })
        ).proof,
      ).toBeUndefined();
    expect(source.calls).toHaveLength(0);
  });
});

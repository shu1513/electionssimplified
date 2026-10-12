import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeFloridaEfsCurrentReport,
  decodeFloridaNativeActivity,
  decodeFloridaNativeContributionTsv,
  verifyFloridaProcessedFinanceSource,
  type FloridaProcessedRawEvidence,
  type FloridaProcessedSourcePacket,
} from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

import { buildFloridaVerifiedCommitteeDonors } from "../../../src/pipeline/floridaFinance/floridaVerifiedCommitteeDonorSource.js";

// Synthetic current-publication fixtures. They make no claim that source funds were accepted.
const context = {
  sourceAccount: "88807",
  candidateName: "Example Candidate",
  electionYear: 2026,
  officeName: "State Representative",
  district: "80",
  genericRecipientName: "Candidate, Example  (REP)(STR)",
};
const nativeHeader =
  "Rpt Yr\tRpt Type\tDate\tAmount\tContributor Name\tAddress\tCity State Zip\tOccupation\tTyp\tInKind Desc";
const genericHeader =
  "Candidate/Committee\tDate\tAmount\tTyp\tContributor Name\tAddress\tCity State Zip\tOccupation\tInkind Desc";
const financial = [
  [
    "01/05/2026",
    "500.00",
    "EXAMPLE PAC",
    "1 Main St.",
    "City FL 12345",
    "",
    "CHE",
    "",
  ],
  [
    "01/06/2026",
    "1000.00",
    "EXAMPLE PAC",
    "1 Main St.",
    "City FL 12345",
    "",
    "CHE",
    "",
  ],
  [
    "01/06/2026",
    "1000.00",
    "EXAMPLE PAC",
    "1 Main St.",
    "City FL 12345",
    "",
    "CHE",
    "",
  ],
  [
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
    "03/30/2026",
    "750.00",
    "EXAMPLE ENTITY",
    "2 Main St.",
    "City FL 12345",
    "",
    "INK",
    "Services",
  ],
  [
    "03/30/2026",
    "100.00",
    "EXAMPLE LENDER",
    "2 Main St.",
    "City FL 12345",
    "",
    "LOA",
    "",
  ],
];
const wrap = (body: string) => `<html><body>${body}</body></html>`;
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${value}">`;
const ownerFields = {
  account: "88807",
  candname: "Example Candidate (REP)",
  elecdesc: "2026 General Election",
  office: "State Representative",
  CanCom: "Cand",
};
const owner = wrap(
  `Candidate Tracking System <b>2026 General Election</b> State Representative District 80 Example Candidate ${Object.entries(
    ownerFields,
  )
    .map(([k, v]) => hidden(k, v))
    .join("")} Address`,
);
const cover = () =>
  wrap(
    `${Object.entries(ownerFields)
      .map(([k, v]) => hidden(k, v))
      .join(
        "",
      )}<table><tr><td><input type="radio" name="seqnum" value="6"></td><td>01/01/2026 - 03/31/2026</td><td>2,000.00</td><td>100.00</td><td>750.00</td><td>0.00</td><td>0.00</td><td>0.00</td></tr></table>`,
  );
function efs(
  overrides: Record<string, string> = {},
  amended = true,
  waiver = false,
): string {
  const fields = {
    lblID: "88807",
    lblFullName: "Example Candidate",
    lblElectionID: "2026 General Election",
    lblReportIdentifier: "Report: 2026 - Q1 - 6",
    lblCoveragePeriod: "1/1/2026-3/31/2026",
    lblReportDue: "4/10/2026",
    lblDateFiled: "4/10/2026 8:47:24 PM",
    lblDateReviewed: "4/10/2026",
    lblFileStatus: "Filed Report",
    lblReviewStatus: "Reviewed",
    lblCompletenessStatus: "Complete Detail Records",
    lblQueuedItems: "0",
    lblCntCon: "6",
    lblCntExp: "0",
    lblCntXfr: "0",
    lblCntOth: "0",
    lblPrintDate: "10/11/2026 4:30:00 PM",
    ...overrides,
  };
  return wrap(
    `${Object.entries(fields)
      .map(([k, v]) => `<span id="${k}">${v}</span>`)
      .join(
        "",
      )}<input id="chkAmended" type="checkbox" ${amended ? 'checked="checked"' : ""}><input id="chkWaiver" type="checkbox" ${waiver ? 'checked="checked"' : ""}>`,
  );
}
function native(rows = financial): string {
  return `${nativeHeader}\n${rows.map((r) => ["2026", "Q1", ...r].join("\t")).join("\n")}\n`;
}
function generic(rows = financial): string {
  return `${genericHeader}\n${rows.map((r) => [context.genericRecipientName, r[0], r[1], r[6], r[2], r[3], r[4], r[5], r[7]].join("\t")).join("\n")}\n`;
}
function raw(
  body: string,
  path: string,
  fields: Record<string, string> | null,
  closing: boolean,
): FloridaProcessedRawEvidence {
  const bytesRaw = new TextEncoder().encode(body);
  return {
    bytesRaw,
    sha256: createHash("sha256").update(bytesRaw).digest("hex"),
    url: `https://${path}`,
    method: fields ? "POST" : "GET",
    financeFields: fields,
    status: 200,
    contentType:
      path.includes("TreFin.exe") || path.includes("contrib.exe")
        ? "text/tab-separated-values"
        : "text/html; charset=utf-8",
    startedAt: `2026-10-11T20:${closing ? "32" : "30"}:00Z`,
    completedAt: `2026-10-11T20:${closing ? "32" : "30"}:01Z`,
  };
}
function packet(closing: boolean): FloridaProcessedSourcePacket {
  const fields = {
    account: "88807",
    seqnum: "6",
    queryfor: "1",
    queryorder: "DAT",
    queryoutput: "2",
    query: "Submit Query Now",
  };
  return {
    ownership: raw(
      owner,
      "dos.elections.myflorida.com/candidates/CanDetail.asp?account=88807",
      null,
      closing,
    ),
    activity: raw(
      cover(),
      "dos.elections.myflorida.com/cgi-bin/TreSel.exe",
      { ...ownerFields, generate: "Campaign Finance Activity" },
      closing,
    ),
    currentReports: [
      raw(
        efs({
          lblPrintDate: closing
            ? "10/11/2026 4:32:00 PM"
            : "10/11/2026 4:30:00 PM",
        }),
        "efs.dos.state.fl.us/PrintReportSubmitted.aspx?AcctNum=88807&SeqNum=6",
        null,
        closing,
      ),
    ],
    periodExports: [
      raw(
        native(),
        "dos.elections.myflorida.com/cgi-bin/TreFin.exe",
        fields,
        closing,
      ),
    ],
    allDatesExport: raw(
      native(),
      "dos.elections.myflorida.com/cgi-bin/TreFin.exe",
      { ...fields, seqnum: "0" },
      closing,
    ),
    genericExport: raw(
      generic(),
      "dos.elections.myflorida.com/cgi-bin/contrib.exe",
      {
        election: "20261103-GEN",
        search_on: "2",
        CanNameSrch: "2",
        CanFName: "Example",
        CanLName: "Candidate",
        queryformat: "2",
        cdatefrom: "01/01/2025",
        cdateto: "10/11/2026",
        rowlimit: "10000",
      },
      closing,
    ),
  };
}
function input() {
  return {
    context,
    windowStart: "2025-01-01",
    windowEnd: "2026-10-11",
    before: packet(false),
    after: packet(true),
  };
}
function change(
  r: FloridaProcessedRawEvidence,
  fn: (s: string) => string,
): FloridaProcessedRawEvidence {
  const bytesRaw = new TextEncoder().encode(
    fn(new TextDecoder().decode(r.bytesRaw)),
  );
  return {
    ...r,
    bytesRaw,
    sha256: createHash("sha256").update(bytesRaw).digest("hex"),
  };
}
const absent = (i: ReturnType<typeof input>, message: string) => {
  const r = verifyFloridaProcessedFinanceSource(i);
  expect(r.proof).toBeUndefined();
  expect(r.diagnostics.join(" ")).toContain(message);
};

describe("Florida current processed source", () => {
  it("accepts a filed amended current snapshot with signed covers and genuine duplicate occurrences", () => {
    const r = verifyFloridaProcessedFinanceSource(input());
    expect(r.diagnostics).toEqual([]);
    expect(r.proof?.rows).toHaveLength(6);
    expect(r.proof?.reports[0]).toMatchObject({
      amended: true,
      contributionCount: 6,
      monetaryCents: 200000,
      loanCents: 10000,
      inKindCents: 75000,
    });
    expect(r.proof?.rows.filter((x) => x.amount === "1000.00")).toHaveLength(2);
    expect(r.proof?.rows[3].amount).toBe("-500.00");
    expect(r.proof?.nativeRows[0]).not.toHaveProperty("recipientName");
  });
  it("passes grouped amounts and signed refunds through committee proof validation", async () => {
    const i = input();
    for (const packet of [i.before, i.after]) {
      packet.genericExport = change(packet.genericExport, text => text.replaceAll("\t1000.00\t", "\t1,000.00\t"));
    }
    const result = verifyFloridaProcessedFinanceSource(i);
    expect(result.diagnostics).toEqual([]);
    expect(result.proof).toBeDefined();
    const finance = await buildFloridaVerifiedCommitteeDonors({ proof: result.proof!, lookupDonor: async receipt => ({
      status: "resolved", diagnostics: [], sourceHashes: Array(6).fill("a".repeat(64)),
      identity: { committeeId: "64858", committeeName: receipt.reportedName, committeeType: "PAC",
        sourceUrl: "https://dos.elections.myflorida.com/committees/ComDetail.asp?account=64858",
        includedInCommitteeDonorScope: true, resolution: "unique_exact_name" },
    }) });
    expect(finance).toMatchObject({ status: "accepted", netCommitteeAmount: 2000 });
    expect(result.proof!.rows.filter(row => row.amount === "1000.00")).toHaveLength(2);
    expect(result.proof!.rows[3].amount).toBe("-500.00");
  });
  it.each(["Amending", "Pending Report"])(
    "preserves %s despite stable current money",
    (state) => {
      const i = input();
      i.before.currentReports = [
        change(i.before.currentReports[0], (s) =>
          s.replace("Filed Report", state),
        ),
      ];
      absent(i, "not filed/reviewed/complete");
    },
  );
  it.each([
    [
      'id="lblReviewStatus">Reviewed',
      'id="lblReviewStatus">Updated - Needs Review',
    ],
    ["Complete Detail Records", "Incomplete Detail Records"],
    ['id="lblQueuedItems">0', 'id="lblQueuedItems">1'],
  ])("rejects current incomplete metadata %s", (a, b) => {
    const i = input();
    i.before.currentReports = [
      change(i.before.currentReports[0], (s) => s.replace(a, b)),
    ];
    absent(i, "not filed/reviewed/complete");
  });
  it("rejects same signed money with current count mismatch", () => {
    const i = input();
    i.before.currentReports = [
      change(i.before.currentReports[0], (s) =>
        s.replace('id="lblCntCon">6', 'id="lblCntCon">8'),
      ),
    ];
    absent(i, "count/report key");
  });
  it("rejects missing and duplicate status records", () => {
    const i = input();
    i.before.currentReports = [];
    absent(i, "missing/duplicate");
    i.before.currentReports = [
      packet(false).currentReports[0],
      packet(false).currentReports[0],
    ];
    absent(i, "missing/duplicate");
  });
  it("rejects missing native period and same total collapsed occurrence", () => {
    const i = input();
    i.before.periodExports = [];
    absent(i, "missing/duplicate native period");
    const j = input();
    j.before.allDatesExport = change(j.before.allDatesExport, () =>
      native(financial.filter((_, n) => n !== 2)),
    );
    absent(j, "whole/period multiset");
  });
  it("rejects same-dollar changed donor/address/occupation in generic export", () => {
    for (const [a, b] of [
      ["EXAMPLE PAC", "OTHER PAC"],
      ["1 Main St.", "1 Main St"],
      ["City FL 12345", "Other FL 12345"],
    ]) {
      const i = input();
      i.before.genericExport = change(i.before.genericExport, (s) =>
        s.replace(a, b),
      );
      absent(i, "full financial multiset");
    }
  });
  it("retains and rejects literal redaction-width disagreement", () => {
    const i = input();
    i.before.genericExport = change(i.before.genericExport, (s) =>
      s.replace("City FL 12345", "***************"),
    );
    absent(i, "full financial multiset");
  });
  it("rejects changed coherent closing money even when all current sums match", () => {
    const i = input();
    for (const p of [
      i.after.periodExports[0],
      i.after.allDatesExport,
      i.after.genericExport,
    ]) {
      Object.assign(
        p,
        change(p, (s) => s.replace(/EXAMPLE PAC/g, "DIFFERENT PAC")),
      );
    }
    absent(i, "changed between captures");
  });
  it("rejects signed cover mismatch without net guessing", () => {
    const i = input();
    i.before.activity = change(i.before.activity, (s) =>
      s.replace("2,000.00", "2,500.00"),
    );
    absent(i, "cover reconciliation");
  });
  it.each([
    ["REF", "CHE"],
    ["-500.00", "500.00"],
  ])("rejects inconsistent cash/refund sign", (a, b) => {
    const i = input();
    i.before.periodExports = [
      change(i.before.periodExports[0], (s) => s.replace(a, b)),
    ];
    absent(i, "cash/refund sign");
  });
  it("rejects unknown types, unsafe cents, malformed widths and wrong schema", () => {
    expect(() =>
      decodeFloridaNativeContributionTsv(native().replace("500.00", "500.001")),
    ).toThrow("exact cents");
    expect(() =>
      decodeFloridaNativeContributionTsv(
        native().replace("500.00", "9007199254740992.00"),
      ),
    ).toThrow("unsafe");
    expect(() =>
      decodeFloridaNativeContributionTsv(native() + "HTML error\n"),
    ).toThrow("partial");
    expect(() =>
      decodeFloridaNativeContributionTsv("<html>no results</html>"),
    ).toThrow("schema");
    const i = input();
    i.before.periodExports = [
      change(i.before.periodExports[0], (s) => s.replace("CHE", "RCT")),
    ];
    absent(i, "unknown current");
  });
  it("binds source-shaped title/h2 and nbsp district to the exact visible seat", () => {
    const i = input();
    const shape = (s: string) =>
      s
        .replace(
          "<html>",
          "<html><head><title>Candidate Tracking system - Florida Division of Elections</title></head>",
        )
        .replace(
          "Candidate Tracking System",
          '<h2 class="center">Candidate Tracking System</h2>',
        )
        .replace("District 80", "District &nbsp;80");
    i.before.ownership = change(i.before.ownership, shape);
    i.after.ownership = change(i.after.ownership, shape);
    expect(verifyFloridaProcessedFinanceSource(i).proof).toBeDefined();
    const wrong = input();
    wrong.before.ownership = change(wrong.before.ownership, (s) =>
      shape(s).replace("&nbsp;80", "&nbsp;81"),
    );
    absent(wrong, "district mismatch");
  });
  it("rejects missing, repeated, or extended district identities", () => {
    for (const label of [
      "No seat published",
      "District 80 District 81",
      "District 800",
    ]) {
      const i = input();
      i.before.ownership = change(i.before.ownership, (s) =>
        s.replace("District 80", label),
      );
      absent(i, "district mismatch");
    }
  });
  it("accepts only receiving-label whitespace projection and retains the raw source label", () => {
    const i = input();
    i.context.genericRecipientName = "Candidate, Example (REP)(STR)";
    const result = verifyFloridaProcessedFinanceSource(i);
    expect(result.proof?.context.genericRecipientName).toBe(
      "Candidate, Example (REP)(STR)",
    );
    expect(result.proof?.rows[0].recipientName).toBe(
      "Candidate, Example  (REP)(STR)",
    );
    expect(result.proof?.sourceHashes).toContain(i.before.genericExport.sha256);
    for (const wrong of [
      "Candidate, Example (DEM)(STR)",
      "Candidate, Example (REP)(STS)",
    ]) {
      const j = input();
      j.context.genericRecipientName = wrong;
      absent(j, "generic owner/window mismatch");
    }
  });
  it("requires exact account, official seat, and generic recipient", () => {
    const i = input();
    i.context = { ...context, district: "81" };
    absent(i, "district");
    const j = input();
    j.before.periodExports[0].financeFields = {
      ...j.before.periodExports[0].financeFields,
      account: "88808",
    };
    absent(j, "native export request");
    const k = input();
    k.context = { ...context, genericRecipientName: "Another Candidate" };
    absent(k, "generic owner");
  });
  it("rejects capped generic exports and missing current coverage", () => {
    const i = input();
    i.before.genericExport.financeFields = {
      ...i.before.genericExport.financeFields,
      rowlimit: "6",
    };
    absent(i, "capped");
  });
  it("rejects malformed generic election dates or other election years", () => {
    for (const election of [
      "20250000-GEN",
      "20261131-GEN",
      "20251103-GEN",
      "20261103-PRI",
    ]) {
      const i = input();
      i.before.genericExport.financeFields = {
        ...i.before.genericExport.financeFields,
        election,
      };
      expect(verifyFloridaProcessedFinanceSource(i).proof).toBeUndefined();
    }
  });
  it("requires genuine independent capture intervals, raw hashes and official paths", () => {
    const i = input();
    i.after.activity.startedAt = "2026-10-11T20:29:00Z";
    absent(i, "not independently");
    const j = input();
    j.before.allDatesExport.sha256 = "0".repeat(64);
    absent(j, "raw envelope");
    const k = input();
    k.before.allDatesExport.url = "https://example.org/cgi-bin/TreFin.exe";
    absent(k, "endpoint");
  });
  it("rejects duplicate EFS fields and overlapping or unreleased native periods", () => {
    expect(() =>
      decodeFloridaEfsCurrentReport(
        efs().replace("</body>", '<span id="lblCntCon">6</span></body>'),
      ),
    ).toThrow("duplicate");
    expect(() =>
      decodeFloridaNativeActivity(
        cover().replace(
          "</table>",
          cover().match(/<tr>[\s\S]*?<\/tr>/)![0] + "</table>",
        ),
      ),
    ).toThrow("duplicate");
    expect(() =>
      decodeFloridaNativeActivity(
        cover().replace("<td><input", "<td>X <input"),
      ),
    ).toThrow("unreleased");
  });
  it("accepts the actual explicit-waiver status while rejecting unchecked no-detail status", () => {
    const i = input();
    for (const p of [i.before, i.after]) {
      p.activity = change(p.activity, (s) =>
        s
          .replace('<input type="radio" name="seqnum" value="6">', "W")
          .replace("2,000.00", "0.00")
          .replace("100.00", "0.00")
          .replace("750.00", "0.00"),
      );
      p.currentReports = [
        change(p.currentReports[0], () =>
          efs(
            {
              lblCntCon: "0",
              lblCompletenessStatus: "No Detail Records Found",
            },
            false,
            true,
          ),
        ),
      ];
      p.periodExports = [];
      p.allDatesExport = change(p.allDatesExport, () => native([]));
      p.genericExport = change(p.genericExport, () => generic([]));
    }
    expect(verifyFloridaProcessedFinanceSource(i).proof?.rows).toEqual([]);
    i.before.currentReports = [
      change(i.before.currentReports[0], (s) =>
        s.replace(
          '<input id="chkWaiver" type="checkbox" checked="checked">',
          '<input id="chkWaiver" type="checkbox">',
        ),
      ),
    ];
    absent(i, "not filed/reviewed/complete");
  });
  it("authorizes recognized empty only with explicit completed zero-count cover and independent closure", () => {
    const i = input();
    for (const p of [i.before, i.after]) {
      p.activity = change(p.activity, (s) =>
        s
          .replace("2,000.00", "0.00")
          .replace("100.00", "0.00")
          .replace("750.00", "0.00"),
      );
      p.currentReports = [
        change(p.currentReports[0], (s) =>
          s.replace('id="lblCntCon">6', 'id="lblCntCon">0'),
        ),
      ];
      p.periodExports = [change(p.periodExports[0], () => native([]))];
      p.allDatesExport = change(p.allDatesExport, () => native([]));
      p.genericExport = change(p.genericExport, () => generic([]));
    }
    expect(verifyFloridaProcessedFinanceSource(i).proof?.rows).toEqual([]);
    i.before.currentReports = [];
    absent(i, "missing/duplicate");
  });
});

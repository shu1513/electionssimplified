import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  writeFloridaOutsideAllocations,
  type FloridaOutsideAllocationWriteInput,
} from "../../../src/pipeline/floridaFinance/floridaOutsideAllocationWriter.js";
import { buildFloridaCommitteeDonorPrefixes } from "../../../src/pipeline/floridaFinance/floridaCommitteeRegistrySource.js";
import {
  buildFloridaVerifiedOutsideAllocations,
  type FloridaOutsideAllocationSource,
} from "../../../src/pipeline/floridaFinance/floridaVerifiedOutsideAllocations.js";
import type { FloridaLocalFinanceContext } from "../../../src/pipeline/floridaFinance/floridaLocalFinanceContext.js";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

// Synthetic protocol fixtures, never evidence of an accepted real candidate.
const DOS = "https://dos.elections.myflorida.com";
const local: FloridaLocalFinanceContext = {
  candidateId: "11111111-1111-1111-1111-111111111111",
  candidateElectionId: "33333333-3333-3333-3333-333333333333",
  electionId: "22222222-2222-2222-2222-222222222222",
  candidateName: "John Example",
  electionYear: 2026,
  electionDate: "2026-11-03",
  officeScope: "state_lower",
  officeCanonicalName: "State Lower Chamber Legislator",
  district: "87",
  committeeId: "LOCAL_EXAMPLE",
  genericRecipientName: "Example, John (REP)(STR)",
};
const context = {
  payerAccount: "90001",
  payerName: "Example Committee",
  payerType: "PAC" as const,
  electionYear: 2026,
  electionType: "general" as const,
  electionDescription: "2026 General Election",
  electionSelector: "20261103-GEN",
  genericPayerLabel: "Example Committee (PAC)",
};
const rows = [
  [
    "09/30/2026",
    "525.00",
    "Example Vendor",
    "Vendor address",
    "Vendor city",
    "TEXT MESSAGES; PRO-JOHN EXAMPLE, HD-87",
    "IEC",
  ],
  [
    "09/30/2026",
    "525.00",
    "Example Vendor",
    "Vendor address",
    "Vendor city",
    "TEXT MESSAGES; PRO-JOHN EXAMPLE, HD-87",
    "IEC",
  ],
  [
    "09/30/2026",
    "100.00",
    "Example Vendor",
    "Vendor address",
    "Vendor city",
    "Ordinary expense",
    "MON",
  ],
];
const html = (body: string) => `<html><body>${body}</body></html>`;
function raw(
  body: string,
  url: string,
  fields: Record<string, string> | null,
  close: boolean,
): FloridaProcessedRawEvidence {
  const bytesRaw = Buffer.from(body);
  return {
    bytesRaw,
    sha256: createHash("sha256").update(bytesRaw).digest("hex"),
    url,
    method: fields ? "POST" : "GET",
    financeFields: fields,
    status: 200,
    contentType: "text/html",
    startedAt: `2026-10-11T21:${close ? "42" : "40"}:00Z`,
    completedAt: `2026-10-11T21:${close ? "42" : "40"}:01Z`,
  };
}
function packet(close: boolean) {
  const native =
    "Rpt Yr\tRpt Type\tDate\tAmount\tExpense Paid To\tAddress\tCity State Zip\tPurpose\tTyp Reimb\n" +
    rows.map((row) => ["2026", "G4", ...row].join("\t")).join("\n") +
    "\n";
  const generic =
    "Candidate/Committee\tDate\tAmount\tPayee Name\tAddress\tCity State Zip\tPurpose\tType\n" +
    rows
      .map((row) => [context.genericPayerLabel, ...row].join("\t"))
      .join("\n") +
    "\n";
  const nativeFields = (seqnum: string) => ({
    account: context.payerAccount,
    seqnum,
    queryfor: "2",
    queryorder: "DAT",
    queryoutput: "2",
    query: "Submit Query Now",
  });
  const metadata = {
    lblID: "90001",
    lblFullName: context.payerName,
    lblElectionID: context.electionDescription,
    lblReportIdentifier: "Report: 2026 - G4 - 41",
    lblCoveragePeriod: "9/26/2026-10/2/2026",
    lblFileStatus: "Filed Report",
    lblReviewStatus: "Reviewed",
    lblCompletenessStatus: "Complete Detail Records",
    lblQueuedItems: "0",
    lblCntExp: "3",
    lblCntCon: "0",
    lblCntXfr: "0",
    lblCntOth: "0",
  };
  return {
    ownership: raw(
      html(
        `<h2>Committee Tracking System</h2><table><tr><td colspan=2><font size=+1><b>${context.payerName}</b></font></td></tr><tr><td>Type:</td><td>Political Committee</td></tr><tr><td>Status:</td><td>Active</td></tr><tr><td>Address:</td><td>Legal address<br>Legal city</td></tr></table><input name=account value="90001">`,
      ),
      `${DOS}/committees/ComDetail.asp?account=90001`,
      null,
      close,
    ),
    activity: raw(
      html(
        `<input name=account value="90001"><table><tr><th></th><th>Filing Period</th><th>Contributions</th><th>Expend</th><th>Other</th><th>Transfers</th></tr><tr><th>Monetary</th><th>Loans</th><th>InKind</th></tr><tr><td><input type=radio name=seqnum value=2></td><td>09/26/2026 - 10/02/2026</td><td>0.00</td><td>0.00</td><td>0.00</td><td>1150.00</td><td>0.00</td><td>0.00</td></tr><tr><td><input type=radio name=seqnum value=0></td><td>All Dates (Totals)</td><td>0.00</td><td>0.00</td><td>0.00</td><td>1150.00</td><td>0.00</td><td>0.00</td></tr></table>`,
      ),
      `${DOS}/cgi-bin/TreSel.exe`,
      {
        account: "90001",
        election: "All",
        submit: "Campaign Finance Activity",
      },
      close,
    ),
    currentReports: [
      raw(
        html(
          Object.entries(metadata)
            .map(([key, value]) => `<span id="${key}">${value}</span>`)
            .join("") +
            "<input type=checkbox id=chkWaiver><input type=checkbox id=chkAmended checked>",
        ),
        "https://efs.dos.state.fl.us/PrintReportSubmitted.aspx?AcctNum=90001&SeqNum=41",
        null,
        close,
      ),
    ],
    periodExports: [
      raw(native, `${DOS}/cgi-bin/TreFin.exe`, nativeFields("2"), close),
    ],
    allDatesExport: raw(
      native,
      `${DOS}/cgi-bin/TreFin.exe`,
      nativeFields("0"),
      close,
    ),
    genericExport: raw(
      generic,
      `${DOS}/cgi-bin/expend.exe`,
      {
        election: context.electionSelector,
        search_on: "4",
        CanFName: "",
        CanLName: "",
        CanNameSrch: "2",
        office: "All",
        cdistrict: "",
        cgroup: "",
        party: "All",
        ComName: context.payerName,
        ComNameSrch: "2",
        committee: "All",
        cfname: "",
        clname: "",
        namesearch: "2",
        ccity: "",
        cstate: "",
        czipcode: "",
        cpurpose: "",
        cdollar_minimum: "",
        cdollar_maximum: "",
        rowlimit: "1000",
        csort1: "DAT",
        csort2: "CAN",
        cdatefrom: "",
        cdateto: "",
        queryformat: "2",
        Submit: "Submit",
      },
      close,
    ),
  };
}
function source(): FloridaOutsideAllocationSource {
  return {
    context: { ...context },
    before: packet(false),
    after: packet(true),
  };
}

const linkId = "44444444-4444-4444-4444-444444444444";
function payerIdentity() {
  const prefixes = buildFloridaCommitteeDonorPrefixes(context.payerName);
  const search = (prefix: string) =>
    html(
      `Search for Committee by Name<input name=ComName value="${prefix}"><table><tr><td>Committee</td><td>Type</td><td>Status</td></tr><tr><td><a href="ComDetail.asp?account=90001">${context.payerName}</a></td><td>PAC</td><td>Active</td></tr></table>`,
    );
  const records = [
    ...prefixes.map((prefix) => ({
      body: search(prefix),
      url: `${DOS}/committees/ComLkupByName.asp`,
      fields: {
        searchtype: "1",
        comName: prefix,
        LkupTypeName: "L",
        NameSearchBtn: "Search by Name",
      },
    })),
    ...[false, true].map((close) => {
      const r = packet(close).ownership;
      return {
        body: Buffer.from(r.bytesRaw).toString(),
        url: r.url,
        fields: null,
      };
    }),
    ...prefixes.map((prefix) => ({
      body: search(prefix),
      url: `${DOS}/committees/ComLkupByName.asp`,
      fields: {
        searchtype: "1",
        comName: prefix,
        LkupTypeName: "L",
        NameSearchBtn: "Search by Name",
      },
    })),
  ];
  return {
    payerLabel: context.genericPayerLabel,
    rawSource: records.map((record, index) => {
      const r = raw(record.body, record.url, record.fields, false);
      r.startedAt = new Date(
        Date.UTC(2026, 9, 11, index < 3 ? 20 : 23, 0, index),
      ).toISOString();
      r.completedAt = new Date(
        Date.UTC(2026, 9, 11, index < 3 ? 20 : 23, 0, index, 500),
      ).toISOString();
      return r;
    }),
  };
}
function actualRow() {
  return {
    candidate_id: local.candidateId,
    candidate_election_id: local.candidateElectionId,
    election_id: local.electionId,
    candidate_name: local.candidateName,
    candidate_status: "declared",
    election_date: local.electionDate,
    election_stage: "general",
    race_type: "office",
    state: "FL",
    office_scope: local.officeScope,
    office_canonical_name: local.officeCanonicalName,
    district_type: "state_lower",
    geoid_compact: "12087",
    committee_id: local.committeeId,
    committee_name: local.genericRecipientName,
    election_year: 2026,
  };
}
function database(
  options: {
    localChange?: Record<string, unknown>;
    legacySupport?: number | null;
    legacyOppose?: number | null;
    legacyGroup?: boolean;
    failAt?: "insert" | "commit";
    connectMutation?: () => void;
    linkCount?: number;
  } = {},
) {
  const otherKey = `${local.candidateElectionId}/90002/2026`;
  let stored = new Map<string, unknown>([
      [otherKey, { support_amount: "25.00", unrelated: true }],
    ]),
    beginState = structuredClone(stored);
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN") {
      beginState = structuredClone(stored);
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      stored = structuredClone(beginState);
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      if (options.failAt === "commit")
        throw new Error("commit failed after finance insert");
      return { rows: [] };
    }
    if (sql.includes("candidate_election.status AS candidate_status"))
      return { rows: [{ ...actualRow(), ...options.localChange }] };
    if (sql.includes("SELECT id::text FROM public.fl_candidate_finance_links"))
      return {
        rows: Array.from({ length: options.linkCount ?? 1 }, () => ({
          id: linkId,
        })),
      };
    if (sql.includes("AS has_legacy_scalar"))
      return {
        rows: [
          {
            has_legacy_scalar:
              (options.legacySupport !== undefined &&
                options.legacySupport !== null) ||
              (options.legacyOppose !== undefined &&
                options.legacyOppose !== null),
            has_legacy_group: options.legacyGroup === true,
          },
        ],
      };
    if (
      sql.includes("FROM public.fl_candidate_finance_ie_sources") &&
      sql.includes("FOR UPDATE")
    ) {
      const old = stored.get(`${values![0]}/${values![1]}/${values![2]}`);
      return { rows: old ? [old] : [] };
    }
    if (sql.includes("INSERT INTO public.fl_candidate_finance_ie_sources")) {
      const key = `${values![0]}/${values![1]}/${values![2]}`;
      const old = stored.get(key) as
        { verified_source_at?: string } | undefined;
      if (
        old?.verified_source_at &&
        Date.parse(String(values![12])) < Date.parse(old.verified_source_at)
      )
        return { rows: [] };
      stored.set(key, {
        support_amount: values![6],
        verified_source_at: values![12],
        expenditure_count: values![7],
        current_report_count: values![8],
        payer_name: values![4],
        payer_type: values![5],
        source_url: values![9],
        provenance: JSON.parse(String(values![10])),
      });
      if (options.failAt === "insert") throw new Error("insert failure");
      return { rows: [{ payer_account: String(values![1]) }] };
    }
    return { rows: [] };
  });
  const release = vi.fn(),
    client = { query, release };
  const connect = vi.fn(async () => {
    options.connectMutation?.();
    return client;
  });
  return {
    db: { connect } as unknown as FloridaOutsideAllocationWriteInput["db"],
    connect,
    query,
    release,
    state: () => structuredClone(stored),
    otherKey,
    setOld: (value: unknown) =>
      stored.set(`${local.candidateElectionId}/90001/2026`, value),
  };
}
function input(
  db: FloridaOutsideAllocationWriteInput["db"],
): FloridaOutsideAllocationWriteInput {
  return {
    db,
    localContext: { ...local },
    payerIdentity: payerIdentity(),
    source: source(),
    now: new Date("2026-10-11T22:00:00Z"),
  };
}
function updateRaw(
  r: FloridaProcessedRawEvidence,
  change: (text: string) => string,
) {
  r.bytesRaw = Buffer.from(change(Buffer.from(r.bytesRaw).toString()));
  r.sha256 = createHash("sha256").update(r.bytesRaw).digest("hex");
}

async function acceptedPrior(i?: FloridaOutsideAllocationWriteInput) {
  const d = database();
  const value = i ? { ...i, db: d.db } : input(d.db);
  const result = await writeFloridaOutsideAllocations(value);
  expect(result.status, result.diagnostics.join()).toBe("written");
  return d.state().get(`${local.candidateElectionId}/90001/2026`) as any;
}

// A second ordinary period lets tests distinguish missing old scope from a proved same-period waiver.
function twoPeriods(
  removeFirst = false,
  waiveFirst = false,
): FloridaOutsideAllocationSource {
  const result = source();
  for (const packet of [result.before, result.after]) {
    const oldReport = packet.currentReports[0]!;
    const nextReport = structuredClone(oldReport);
    nextReport.url = nextReport.url.replace("SeqNum=41", "SeqNum=42");
    updateRaw(nextReport, (s) =>
      s
        .replace("2026 - G4 - 41", "2026 - G5 - 42")
        .replace("9/26/2026-10/2/2026", "10/3/2026-10/9/2026")
        .replace('id="lblCntExp">3', 'id="lblCntExp">1'),
    );
    const nextExport = structuredClone(packet.allDatesExport);
    nextExport.financeFields = { ...nextExport.financeFields!, seqnum: "3" };
    const nextRow = [
      "2026",
      "G5",
      "10/05/2026",
      "200.00",
      "Example Vendor",
      "Vendor address",
      "Vendor city",
      "Ordinary expense",
      "MON",
    ].join("\t");
    updateRaw(nextExport, (s) => s.split("\n")[0] + "\n" + nextRow + "\n");
    const periodRow =
      "<tr><td><input type=radio name=seqnum value=3></td><td>10/03/2026 - 10/09/2026</td><td>0.00</td><td>0.00</td><td>0.00</td><td>200.00</td><td>0.00</td><td>0.00</td></tr>";
    updateRaw(packet.activity, (s) => {
      if (removeFirst)
        s = s.replace(
          /<tr><td><input type=radio name=seqnum value=2>[\s\S]*?<\/tr>/,
          "",
        );
      if (waiveFirst)
        s = s
          .replace("1150.00", "0.00")
          .replace("<input type=radio name=seqnum value=2>", "W");
      return s
        .replace(
          "<tr><td><input type=radio name=seqnum value=0>",
          periodRow + "<tr><td><input type=radio name=seqnum value=0>",
        )
        .replace(
          /(<tr><td><input type=radio name=seqnum value=0>[\s\S]*?)1150\.00/,
          "$1" + (removeFirst || waiveFirst ? "200.00" : "1350.00"),
        );
    });
    if (waiveFirst)
      updateRaw(oldReport, (s) =>
        s
          .replace('id="lblCntExp">3', 'id="lblCntExp">0')
          .replace("Complete Detail Records", "No Detail Records Found")
          .replace("id=chkWaiver>", "id=chkWaiver checked>"),
      );
    packet.currentReports = removeFirst
      ? [nextReport]
      : [oldReport, nextReport];
    packet.periodExports =
      removeFirst || waiveFirst
        ? [nextExport]
        : [...packet.periodExports, nextExport];
    updateRaw(
      packet.allDatesExport,
      (s) =>
        (removeFirst || waiveFirst ? s.split("\n")[0] + "\n" : s) +
        nextRow +
        "\n",
    );
    updateRaw(
      packet.genericExport,
      (s) =>
        (removeFirst || waiveFirst ? s.split("\n")[0] + "\n" : s) +
        [context.genericPayerLabel, ...nextRow.split("\t").slice(2)].join(
          "\t",
        ) +
        "\n",
    );
  }
  return result;
}

describe("Florida scoped outside authority transaction", () => {
  it.each(["DATA", "MAILER & PHONE BANKS"])("persists %s Senate amounts and can replace a prior false zero", async prefix => {
    const d = database({ localChange: {
      office_scope: "state_upper", office_canonical_name: "State Senator",
      district_type: "state_upper", geoid_compact: "12039",
    } });
    const value = input(d.db);
    value.localContext = { ...value.localContext, officeScope: "state_upper",
      officeCanonicalName: "State Senator", district: "39" };
    for (const packet of [value.source!.before, value.source!.after]) {
      for (const evidence of [...packet.periodExports, packet.allDatesExport, packet.genericExport]) {
        updateRaw(evidence, text => text.replaceAll(
          "TEXT MESSAGES; PRO-JOHN EXAMPLE, HD-87", `${prefix} SUPPORTING JOHN EXAMPLE (SD-39)`,
        ));
      }
    }
    const before = d.state();
    expect(await writeFloridaOutsideAllocations(value)).toMatchObject({ status: "written", supportCents: 105000 });
    const key = `${local.candidateElectionId}/90001/2026`;
    const stored = d.state().get(key) as any;
    expect(stored).toMatchObject({ support_amount: "1050.00", expenditure_count: 2,
      provenance: { candidateWideZeroAuthority: false, supportCents: 105000, unmatchedExpenseCount: 1,
        allocations: [
          { occurrence: 0, reportSequence: 41, amountCents: 52500 },
          { occurrence: 1, reportSequence: 41, amountCents: 52500 },
        ],
      },
    });
    expect(d.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(d.state().get(d.otherKey)).toEqual(before.get(d.otherKey));

    // Reproduce the old House-only matcher: valid full-source authority but
    // every Senate expense excluded from the stored allocation.
    const falseZero = structuredClone(stored);
    falseZero.support_amount = "0.00";
    falseZero.expenditure_count = 0;
    falseZero.provenance.supportCents = 0;
    falseZero.provenance.allocations = [];
    falseZero.provenance.unmatchedExpenseCount = 3;
    d.setOld(falseZero);
    expect(await writeFloridaOutsideAllocations(value)).toMatchObject({ status: "written", supportCents: 105000 });
    expect(d.state().get(key)).toEqual(stored);
    expect(d.state().get(d.otherKey)).toEqual(before.get(d.otherKey));
  });
  it("stores duplicate explicit allocations and metadata atomically without legacy/global writes", async () => {
    const d = database();
    const result = await writeFloridaOutsideAllocations(input(d.db));
    expect(result).toMatchObject({ status: "written", supportCents: 105000 });
    const sql = d.query.mock.calls.map((c) => c[0]);
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(sql[2]).toContain("FOR SHARE OF");
    expect(sql.at(-1)).toBe("COMMIT");
    const insert = d.query.mock.calls.find((c) =>
      c[0].includes("INSERT INTO public.fl_candidate_finance_ie_sources"),
    )!;
    expect(insert[1]!.slice(0, 10)).toEqual([
      local.candidateElectionId,
      "90001",
      2026,
      linkId,
      context.payerName,
      "PAC",
      "1050.00",
      2,
      1,
      "https://efs.dos.state.fl.us/PrintReportSubmitted.aspx?AcctNum=90001&SeqNum=41",
    ]);
    const p = JSON.parse(String(insert[1]![10]));
    expect(p).toMatchObject({
      version: 1,
      authority: "current_processed_expense_ledger",
      candidateWideZeroAuthority: false,
      supportCents: 105000,
    });
    expect(
      p.allocations.map((a: any) => [
        a.occurrence,
        a.reportSequence,
        a.amountCents,
      ]),
    ).toEqual([
      [0, 41, 52500],
      [1, 41, 52500],
    ]);
    expect(p.allocations[0].rowSha256).toBe(p.allocations[1].rowSha256);
    expect(JSON.stringify(p)).not.toContain("bytesRaw");
    expect(JSON.stringify(p)).not.toContain("Vendor address");
    expect(JSON.stringify(p)).not.toContain("Legal address");
    expect(sql.some((s) => /^\s*(?:DELETE|UPDATE)\b/i.test(s))).toBe(false);
    expect(sql.filter((s) => /^\s*INSERT/i.test(s))).toHaveLength(1);
    expect(d.state().get(d.otherKey)).toEqual({
      support_amount: "25.00",
      unrelated: true,
    });
    expect(d.release).toHaveBeenCalledTimes(1);
  });
  it("runtime envelope extras never become stored provenance fields", async () => {
    const d = database(),
      i = input(d.db);
    Object.assign(i.source!.before.genericExport, {
      vendorAddress: "Unstored extra address",
      rawHtml: "Unstored raw HTML",
    });
    Object.assign(i.payerIdentity!.rawSource[0], {
      phase: "Unstored extra address",
      rawHtml: "Unstored raw HTML",
    });
    expect((await writeFloridaOutsideAllocations(i)).status).toBe("written");
    const insert = d.query.mock.calls.find((c) =>
      c[0].includes("INSERT INTO"),
    )!;
    expect(String(insert[1]![10])).not.toContain("Unstored");
  });
  it("complete empty target updates this payer only and cannot set a candidate scalar zero", async () => {
    const d = database({ localChange: { candidate_name: "John Other" } });

    const i = input(d.db);
    i.localContext.candidateName = "John Other";
    const result = await writeFloridaOutsideAllocations(i);
    expect(result).toMatchObject({ status: "written", supportCents: 0 });
    const insert = d.query.mock.calls.find((c) =>
      c[0].includes("INSERT INTO public.fl_candidate_finance_ie_sources"),
    )!;
    expect(insert[1]![6]).toBe("0.00");
    expect(insert[1]![7]).toBe(0);
    expect(d.state().get(d.otherKey)).toEqual({
      support_amount: "25.00",
      unrelated: true,
    });
    expect(
      d.query.mock.calls.some((c) => /^\s*(DELETE|UPDATE)\b/.test(c[0])),
    ).toBe(false);
  });
  it.each(["source", "payer"])(
    "omitted %s makes no connection or mutation",
    async (kind) => {
      const d = database(),
        i = input(d.db);
      if (kind === "source") i.source = undefined;
      else i.payerIdentity = undefined;
      expect((await writeFloridaOutsideAllocations(i)).status).toBe("preserve");
      expect(d.connect).not.toHaveBeenCalled();
      expect(d.query).not.toHaveBeenCalled();
    },
  );
  it.each([
    "source_hash",
    "payer_hash",
    "payer_order",
    "special",
    "owner_mismatch",
    "bad_uuid",
  ])("invalid raw authority %s preserves before connection", async (kind) => {
    const d = database(),
      i = input(d.db);
    if (kind === "source_hash")
      i.source!.before.genericExport.sha256 = "a".repeat(64);
    if (kind === "payer_hash")
      i.payerIdentity!.rawSource[0].sha256 = "a".repeat(64);
    if (kind === "payer_order")
      i.payerIdentity!.rawSource = [...i.payerIdentity!.rawSource].reverse();
    if (kind === "special")
      i.source!.context = {
        ...i.source!.context,
        electionType: "special",
        electionSelector: "20260324-S01",
        electionDescription: "2026 Special Election - Senate 14 & House 87",
      };
    if (kind === "owner_mismatch")
      for (const r of i.payerIdentity!.rawSource.filter(
        (r) => r.method === "GET",
      ))
        updateRaw(r, (s) =>
          s.replace("Legal address", "Different legal address"),
        );
    if (kind === "bad_uuid") i.localContext.candidateId = "not-a-uuid";
    expect((await writeFloridaOutsideAllocations(i)).status).toBe("preserve");
    expect(d.connect).not.toHaveBeenCalled();
  });
  it.each([
    { candidate_name: "Other Person" },
    { candidate_election_id: "55555555-5555-5555-5555-555555555555" },
    { geoid_compact: "12088" },
    { election_stage: "primary" },
    { candidate_status: "withdrawn" },
    { committee_name: "Different Source Label" },
  ])(
    "actual local drift rolls back before finance insert",
    async (localChange) => {
      const d = database({ localChange });
      const result = await writeFloridaOutsideAllocations(input(d.db));
      expect(result.status).toBe("preserve");
      expect(d.query.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
      expect(d.query.mock.calls.some((c) => c[0].includes("INSERT INTO"))).toBe(
        false,
      );
      expect(d.release).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { legacySupport: 0 },
    { legacySupport: 1000 },
    { legacyOppose: 0 },
    { legacyOppose: 1000 },
    { legacyGroup: true },
  ])(
    "legacy amount/group %# preserves rather than mixing authorities",
    async (options) => {
      const d = database(options);
      const result = await writeFloridaOutsideAllocations(input(d.db));
      expect(result.status).toBe("preserve");
      expect(result.diagnostics.join()).toContain("legacy outside");
      const legacy = d.query.mock.calls.find((c) =>
        c[0].includes("AS has_legacy_scalar"),
      )![0];
      expect(legacy).toContain("outside_support_total IS NOT NULL");
      expect(legacy).toContain("outside_oppose_total IS NOT NULL");
      expect(d.query.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
      expect(d.query.mock.calls.some((c) => c[0].includes("INSERT INTO"))).toBe(
        false,
      );
    },
  );
  it.each(["insert", "commit"] as const)(
    "failure at %s restores prior payer and releases connection",
    async (failAt) => {
      const d = database({ failAt });
      d.setOld(await acceptedPrior());
      const prior = d.state();
      const result = await writeFloridaOutsideAllocations(input(d.db));
      expect(result.status).toBe("preserve");
      expect(d.state()).toEqual(prior);
      expect(d.query.mock.calls.some((c) => c[0].includes("INSERT INTO"))).toBe(
        true,
      );
      expect(d.query.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
      expect(d.release).toHaveBeenCalledTimes(1);
    },
  );
  it("caller mutation during connection cannot substitute another retained financial/local generation", async () => {
    let i: FloridaOutsideAllocationWriteInput;
    const d = database({
      connectMutation: () => {
        i.localContext.candidateName = "Other Person";
        i.localContext.candidateId = "55555555-5555-5555-5555-555555555555";
        i.source!.before.allDatesExport.bytesRaw.fill(0);
        i.payerIdentity!.rawSource[0].bytesRaw.fill(0);
        i.now!.setFullYear(2000);
      },
    });
    i = input(d.db);
    const result = await writeFloridaOutsideAllocations(i);
    expect(result).toMatchObject({ status: "written", supportCents: 105000 });
    const insert = d.query.mock.calls.find((c) =>
      c[0].includes("INSERT INTO"),
    )!;
    expect(JSON.parse(String(insert[1]![10])).localContext.candidateName).toBe(
      "John Example",
    );
    expect(insert[1]![11]).toBe("2026-10-11T22:00:00.000Z");
  });
  it("nonunique link and missing transaction Pool preserve", async () => {
    const d = database({ linkCount: 2 });
    expect((await writeFloridaOutsideAllocations(input(d.db))).status).toBe(
      "preserve",
    );
    expect(d.query.mock.calls.some((c) => c[0].includes("INSERT INTO"))).toBe(
      false,
    );
    const i = input({} as FloridaOutsideAllocationWriteInput["db"]);
    expect((await writeFloridaOutsideAllocations(i)).status).toBe("preserve");
  });
  it("an older genuine source cannot replace a newer accepted payer even with a future sync clock", async () => {
    const d = database();
    const newer = input(database().db);
    for (const r of Object.values(
      newer.source!.after,
    ).flat() as FloridaProcessedRawEvidence[]) {
      r.startedAt = "2026-10-11T21:43:00Z";
      r.completedAt = "2026-10-11T21:43:01Z";
    }
    d.setOld(await acceptedPrior(newer));
    const before = d.state();
    const i = input(d.db);
    i.now = new Date("2030-01-01T00:00:00Z");
    const result = await writeFloridaOutsideAllocations(i);
    expect(result.status).toBe("preserve");
    expect(result.diagnostics.join()).toContain("newer accepted");
    expect(d.state()).toEqual(before);
    expect(d.query.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
    const insert = d.query.mock.calls.find((c) =>
      c[0].includes("INSERT INTO"),
    )!;
    expect(insert[0]).toContain(
      "EXCLUDED.verified_source_at >= fl_candidate_finance_ie_sources.verified_source_at",
    );
    expect(insert[1]![12]).toBe("2026-10-11T21:42:01Z");
    expect(insert[1]![11]).toBe("2030-01-01T00:00:00.000Z");
  });
  it("a newer closing source replaces this payer while an identical source replay remains idempotent", async () => {
    const d = database();
    const older = input(database().db);
    for (const r of Object.values(
      older.source!.after,
    ).flat() as FloridaProcessedRawEvidence[]) {
      r.startedAt = "2026-10-11T21:41:00Z";
      r.completedAt = "2026-10-11T21:41:01Z";
    }
    d.setOld(await acceptedPrior(older));
    expect((await writeFloridaOutsideAllocations(input(d.db))).status).toBe(
      "written",
    );
    const after = d.state();
    expect((await writeFloridaOutsideAllocations(input(d.db))).status).toBe(
      "written",
    );
    expect(d.state()).toEqual(after);
  });
  it.each([
    "missing_period",
    "malformed",
    "context",
    "money",
    "count",
    "source_metadata",
  ])("prior %s preserves under the scoped row lock", async (kind) => {
    const d = database(),
      prior = await acceptedPrior();
    if (kind === "malformed") prior.provenance = {};
    if (kind === "context")
      prior.provenance.localContext.candidateName = "Different Person";
    if (kind === "money") prior.support_amount = "1050.01";
    if (kind === "count") prior.expenditure_count = 1;
    if (kind === "source_metadata") delete prior.provenance.payerSourceMetadata;
    d.setOld(prior);
    const before = d.state(),
      i = input(d.db);
    if (kind === "missing_period") i.source = twoPeriods(true);
    const result = await writeFloridaOutsideAllocations(i);
    expect(result.status).toBe("preserve");
    expect(result.diagnostics.join()).toContain("prior");
    expect(d.state()).toEqual(before);
    expect(d.query.mock.calls.some((c) => c[0].includes("FOR UPDATE"))).toBe(
      true,
    );
    expect(d.query.mock.calls.some((c) => c[0].includes("INSERT INTO"))).toBe(
      false,
    );
  });
  it("appended periods retain prior coverage while same-period amendments may replace current occurrences", async () => {
    const d = database();
    d.setOld(await acceptedPrior());
    const i = input(d.db);
    i.source = twoPeriods();
    const checked = await writeFloridaOutsideAllocations(i);
    expect(checked, checked.diagnostics.join()).toMatchObject({
      status: "written",
      supportCents: 105000,
    });
    // Genuine current amended records may change the old period's allocation, without losing its authority.
    const changed = input(d.db);
    changed.source = twoPeriods();
    for (const p of [changed.source.before, changed.source.after])
      for (const r of [p.periodExports[0]!, p.allDatesExport, p.genericExport])
        updateRaw(r, (s) => s.replaceAll("PRO-JOHN EXAMPLE", "PRO-JOHN OTHER"));
    expect(await writeFloridaOutsideAllocations(changed)).toMatchObject({
      status: "written",
      supportCents: 0,
    });
  });
  it("an independently verified same-period waiver permits scoped zero without losing other payer data", async () => {
    const d = database();
    d.setOld(await acceptedPrior());
    const i = input(d.db);
    i.source = twoPeriods(false, true);
    const checked = await writeFloridaOutsideAllocations(i);
    expect(checked, checked.diagnostics.join()).toMatchObject({
      status: "written",
      supportCents: 0,
    });
    expect(d.state().get(d.otherKey)).toEqual({
      support_amount: "25.00",
      unrelated: true,
    });
  });
  it.each(["late_opening", "early_closing"])(
    "%s registry bracket cannot certify financial source",
    async (kind) => {
      const d = database(),
        i = input(d.db);
      const r = i.payerIdentity!.rawSource[kind === "late_opening" ? 2 : 3];
      r.startedAt = "2026-10-11T21:41:00Z";
      r.completedAt = "2026-10-11T21:41:01Z";
      const result = await writeFloridaOutsideAllocations(i);
      expect(result.status).toBe("preserve");
      expect(d.connect).not.toHaveBeenCalled();
    },
  );
  it("migration stays isolated, constrained and uses valid PostgreSQL identifiers", () => {
    const sql = readFileSync(
      new URL(
        "../../../../db/migrations/333_add_florida_finance_ie_sources.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain(
      "PRIMARY KEY (candidate_election_id, payer_account, election_year)",
    );
    expect(sql).toContain("support_amount >= 0");
    expect(sql).toContain("candidateWideZeroAuthority");
    expect(sql).toContain("'false'::jsonb");
    expect(sql).not.toMatch(
      /ALTER TABLE|DROP TABLE|UPDATE public|DELETE FROM/i,
    );
    for (const match of sql.matchAll(
      /CREATE (?:TABLE IF NOT EXISTS|INDEX IF NOT EXISTS|TRIGGER)\s+(?:public\.)?([a-z_]+)/g,
    ))
      expect(match[1].length).toBeLessThanOrEqual(63);
  });
});

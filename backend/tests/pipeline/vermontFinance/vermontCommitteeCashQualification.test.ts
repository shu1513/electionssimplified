import { describe, expect, it } from "vitest";
import {
  qualifyVermontCommitteeCash,
  type VermontCommitteeCashQualificationInput,
  type VermontCommitteeCashPhase,
  type VermontCommitteeCashPdfObservation,
} from "../../../src/pipeline/vermontFinance/vermontCommitteeCashQualification.js";

// Synthetic protocol policy fixtures. These amounts are not official-source evidence.
function fixture(): VermontCommitteeCashQualificationInput {
  const context = {
    linkId: "link",
    candidateId: "candidate",
    electionId: "election",
    electionYear: 2026,
    candidateName: "Jane Doe",
    receivingFilerName: "DOE, JANE",
    filerRegistrationGuid: "receiver",
    entityId: 91,
    officeId: 19,
    officeName: "Governor",
    electionDate: "2026-11-03",
    electionType: "general" as const,
    sourceElectionId: 45,
    sourceElection: { electionId: 45, name: "2026  Nov 03 - General Election" },
  };
  const report = {
    filerReportGuid: "report",
    filerReportVersionID: 2,
    filerFilingCalendarGuid: "calendar",
    reportName: "2026 Oct 1 - Disclosures",
    reportType: "Campaign Finance Disclosure Report",
    reportStatus: "Amended",
    reportVersion: "Amendment 1",
    startDate: "2025-01-01T00:00:00",
    endDate: "2026-09-28T00:00:00",
    dueDate: "2026-10-01T00:00:00",
    filedDate: "2026-10-01T12:00:00",
    hasChild: false,
    isPaperFile: false,
  };
  const receipt = (id: number, amount: number, code: string) => ({
    transactionID: id,
    transactionVersionID: 1,
    guid: `gift-${id}`,
    filerRegistrationGuid: "receiver",
    entityId: 91,
    filerName: "DOE, JANE",
    officeID: 19,
    electionId: 45,
    filerTypeCode: "CAN",
    transactionTypeCode: "TCON",
    transactionSubTypeCode: "ITMY",
    transactionSourceTypeCode: code,
    sourceName: "Example PAC",
    transactionAmount: amount,
    transactionDate: "09/22/2026",
    filerReportGuid: "report",
    hasChild: false,
    timedFiledReportGuid: null,
    retainedSourceField: "full identity",
  });
  const facts: VermontCommitteeCashPdfObservation["facts"] = {
    receivingFilerName: "DOE, JANE",
    candidateFullName: "JANE DOE",
    officeName: "Governor",
    electionLabel: "2026 Nov 03 - General Election",
    reportName: report.reportName,
    periodStart: "2025-01-01",
    periodEnd: "2026-09-28",
    dueDate: "2026-10-01",
    originalFiledDate: null,
    summary: {
      beginningBalanceCents: 0,
      surplusPreviousCampaignCents: 0,
      monetaryContributionsPeriodCents: 20000,
      monetaryContributionsCycleCents: 20000,
      monetaryExpendituresPeriodCents: 40000,
      monetaryExpendituresCycleCents: 40000,
      endingBalanceCents: -20000,
    },
    controls: {
      cashOver100Cents: 20000,
      cash100OrLessCents: 0,
      loansReceivedCents: 0,
      refundedContributionsCents: 0,
      totalMonetaryContributionsCents: 20000,
      monetaryExpendituresCents: 40000,
      loanPaymentsCents: 0,
      refundedExpendituresCents: 0,
      totalMonetaryExpendituresCents: 40000,
      massMediaExpendituresCents: 0,
      refundedMassMediaExpendituresCents: 0,
      totalMassMediaExpendituresCents: null,
      loanOutstandingBeginningCents: 0,
      loanReceivedSummaryCents: 0,
      loanSubtotalCents: 0,
      loanPaymentsSummaryCents: 0,
      loanForgivenCents: 0,
      loanOutstandingEndingCents: 0,
      inKindContributionsCents: 0,
      refundedInKindContributionsCents: 0,
      totalInKindContributionsCents: 0,
      inKindExpendituresCents: 0,
      refundedInKindExpendituresCents: 0,
      totalInKindExpendituresCents: 0,
      inKindTransactionBalanceCents: 0,
    },
    counts: {
      cashOver100: null,
      cash100OrLess: null,
      loansReceived: 0,
      monetaryExpenditures: null,
      massMediaExpenditures: null,
    },
    pdfSha256: "a".repeat(64),
    byteCount: 100,
    pageCount: 3,
  };
  const makePhase = (day: string): VermontCommitteeCashPhase => {
    const capture = {
      startedAt: `2026-10-${day}T00:00:00Z`,
      completedAt: `2026-10-${day}T00:00:01Z`,
      httpStatus: 200,
      sha256: "a".repeat(64),
      byteCount: 100,
    };
    const page = (
      endpoint: string,
      items: Record<string, unknown>[],
      type?: string,
    ) => ({
      request: {
        endpoint,
        body: {
          filerRegistrationGuid: "receiver",
          pageNumber: 1,
          pageSize: 1000,
          sortBy: type ? "TransactionDate" : "",
          sortType: type ? "desc" : "",
          ...(type
            ? {
                filerName: "DOE, JANE",
                electionID: 45,
                transactionTypeCode: type,
              }
            : {}),
        },
      },
      response: { items, totalItems: items.length },
      capture: { ...capture },
    });
    return {
      queries: {
        reports: [
          page("PublicFilerDetails/GetPublicFilerProfileFiling", [report]),
        ],
        contributions: [
          page(
            "PublicTransactionDetails/GetContributionsDetails",
            [receipt(1, 100, "TPAC"), receipt(2, 100, "TIND")],
            "TCON",
          ),
        ],
        expenditures: [
          page(
            "PublicTransactionDetails/GetExpenditureDetails",
            [
              {
                ...receipt(3, 400, "TBSN"),
                transactionTypeCode: "TEXP",
                transactionCategoryCode: "OPER",
                expenditurePurpose: "ordinary expense",
              },
            ],
            "TEXP",
          ),
        ],
      },
      reports: [
        {
          request: {
            endpoint: "PublicFiledReportAndDownload/DownloadDocument",
            body: {
              filerReportGuid: "report",
              fileName: `${report.reportName} V2`,
              openInNewTab: true,
            },
          },
          capture: { ...capture },
          facts: structuredClone(facts),
        },
      ],
    };
  };
  return {
    context,
    before: structuredClone(makePhase("11")),
    after: structuredClone(makePhase("12")),
  };
}
function each(
  input: VermontCommitteeCashQualificationInput,
  fn: (p: VermontCommitteeCashPhase) => void,
) {
  fn(input.before);
  fn(input.after);
}
function receipts(p: VermontCommitteeCashPhase) {
  return p.queries.contributions[0]!.response.items as Record<
    string,
    unknown
  >[];
}
function inventory(p: VermontCommitteeCashPhase) {
  return p.queries.reports[0]!.response.items as Record<string, unknown>[];
}
function cash(p: VermontCommitteeCashPhase, cents: number) {
  const f = p.reports[0]!.facts;
  f.controls.cashOver100Cents = cents;
  f.controls.totalMonetaryContributionsCents = cents;
  f.summary.monetaryContributionsPeriodCents = cents;
  f.summary.monetaryContributionsCycleCents = cents;
}
function held(input: VermontCommitteeCashQualificationInput, why?: RegExp) {
  const r = qualifyVermontCommitteeCash(input);
  expect(r.status).toBe("held");
  if (why) expect(r.diagnostics.join(" ")).toMatch(why);
  expect(r).not.toHaveProperty("positions");
  expect(r).not.toHaveProperty("monetaryCashCents");
}

describe("Vermont source-typed committee cash qualification", () => {
  it("accepts a singleton amended financial edition and full literal election label, independently of ordinary expense controls", () => {
    const r = qualifyVermontCommitteeCash(fixture());
    expect(r.status).toBe("qualified");
    if (r.status !== "qualified") return;
    expect(r.monetaryCashCents).toBe(20000);
    expect(r.positions).toMatchObject([
      {
        committeeId: "reported:EXAMPLE PAC",
        amountCents: 10000,
        contributionCount: 1,
      },
    ]);
    expect(r.reportPeriods[0]!.filerReportVersionId).toBe(2);
    expect(r.periodStart).toBe("2025-01-01");
    expect(r.captureDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    "2026 GENERAL",
    "2026 Nov 04 - General Election",
    "2026 Nov 03 - Primary Election",
    "2026 Primary and General",
  ])("refuses altered printed election context %s", (label) => {
    const x = fixture();
    each(x, (p) => {
      p.reports[0]!.facts.electionLabel = label;
    });
    held(x, /PDF owner\/election\/period/);
  });
  it("validates native MM/DD/YYYY as civil dates and retains earlier-year published membership", () => {
    const x = fixture();
    each(x, (p) => {
      receipts(p)[0]!.transactionDate = "01/02/2025";
    });
    const r = qualifyVermontCommitteeCash(x);
    expect(r.status).toBe("qualified");
    if (r.status === "qualified")
      expect(r.positions[0]!.giftTransactions[0]!.date).toBe("2025-01-02");
  });
  it.each(["02/30/2026", "9/22/2026", "2026-09-22T12:00:00", "12/31/2024"])(
    "refuses invalid/unsupported/out-of-period cash date %s",
    (date) => {
      const x = fixture();
      each(x, (p) => {
        receipts(p)[0]!.transactionDate = date;
      });
      held(x);
    },
  );
  it("retains physical equal-dollar gifts and signed reported positions", () => {
    const x = fixture();
    each(x, (p) => {
      const a = receipts(p);
      a[1]!.transactionSourceTypeCode = "TPAC";
      a.push({
        ...a[0],
        transactionID: 4,
        guid: "gift-4",
        transactionAmount: -50,
      });
      p.queries.contributions[0]!.response.totalItems = 3;
      cash(p, 15000);
    });
    const r = qualifyVermontCommitteeCash(x);
    expect(r.status).toBe("qualified");
    if (r.status === "qualified") {
      expect(r.positions[0]!.amountCents).toBe(15000);
      expect(r.positions[0]!.contributionCount).toBe(2);
      expect(r.positions[0]!.giftTransactions).toHaveLength(3);
    }
  });
  it("groups case and whitespace but retains punctuation distinctions", () => {
    const x = fixture();
    each(x, (p) => {
      receipts(p)[1]!.transactionSourceTypeCode = "TPAC";
      receipts(p)[1]!.sourceName = " EXAMPLE  pac ";
    });
    const r = qualifyVermontCommitteeCash(x);
    expect(r.status).toBe("qualified");
    if (r.status === "qualified") expect(r.positions).toHaveLength(1);
    each(x, (p) => {
      receipts(p)[1]!.sourceName = "Example-PAC";
    });
    const q = qualifyVermontCommitteeCash(x);
    if (q.status !== "qualified") throw Error("Expected qualified");
    expect(q.positions).toHaveLength(2);
  });
  it.each(["TCAN", "TPP", "TBSN", "TIEPAC", "TLLPAC"])(
    "does not promote %s by donor name",
    (code) => {
      const x = fixture();
      each(x, (p) => {
        receipts(p)[1]!.transactionSourceTypeCode = code;
      });
      const r = qualifyVermontCommitteeCash(x);
      expect(r.status).toBe("qualified");
      if (r.status === "qualified") expect(r.positions).toHaveLength(1);
    },
  );
  it("retains unknown class money without inventing named PAC or zero", () => {
    const x = fixture();
    each(x, (p) => {
      receipts(p)[1]!.transactionSourceTypeCode = "";
    });
    const r = qualifyVermontCommitteeCash(x);
    expect(r.status).toBe("qualified");
    if (r.status === "qualified") expect(r.unclassifiedCashCents).toBe(10000);
    each(x, (p) => {
      receipts(p)[0]!.transactionSourceTypeCode = "";
    });
    held(x, /zero authority/);
  });
  it("accepts row order differences but refuses every changed full source field", () => {
    const x = fixture();
    (x.after.queries.contributions[0]!.response.items as unknown[]).reverse();
    expect(qualifyVermontCommitteeCash(x).status).toBe("qualified");
    receipts(x.after)[0]!.retainedSourceField = "changed";
    held(x, /Changed full published/);
  });
  it("refuses duplicate occurrence IDs even when controls and cardinality still close", () => {
    const x = fixture();
    each(x, (p) => {
      receipts(p)[1]!.transactionID = 1;
    });
    held(x, /Duplicate/);
  });
  it("refuses alternate versions of one current transaction", () => {
    const x = fixture();
    each(x, (p) => {
      receipts(p)[1]!.transactionID = 1;
      receipts(p)[1]!.transactionVersionID = 2;
    });
    held(x, /Duplicate/);
  });
  it.each([
    "loansReceivedCents",
    "refundedContributionsCents",
    "inKindContributionsCents",
    "loanPaymentsCents",
    "loanForgivenCents",
  ])("holds unresolved %s scope", (key) => {
    const x = fixture();
    each(x, (p) => {
      (p.reports[0]!.facts.controls as unknown as Record<string, number>)[key] =
        1;
    });
    held(x, /loan\/return\/in-kind/);
  });
  it("holds any actual own PURC while allowing unrelated foreign raw rows", () => {
    const x = fixture();
    each(x, (p) => {
      const rows = p.queries.expenditures[0]!.response.items as Record<
        string,
        unknown
      >[];
      rows[0]!.transactionCategoryCode = "PURC";
    });
    held(x, /returned contribution/);
    each(x, (p) => {
      const r = p.queries.expenditures[0]!.response.items[0] as Record<
        string,
        unknown
      >;
      r.filerRegistrationGuid = "foreign";
      r.entityId = 92;
    });
    expect(qualifyVermontCommitteeCash(x).status).toBe("qualified");
  });
  it("refuses partial recipient identity contradictions", () => {
    const x = fixture();
    each(x, (p) => {
      receipts(p)[1]!.entityId = 92;
    });
    held(x, /partial receiving identity/);
  });
  it.each(["candidateFullName", "receivingFilerName", "officeName"])(
    "refuses altered PDF %s",
    (key) => {
      const x = fixture();
      each(x, (p) => {
        (p.reports[0]!.facts as unknown as Record<string, unknown>)[key] =
          "Wrong context";
      });
      held(x, /PDF owner/);
    },
  );
  it("requires exactGUID election role and no narrowed source selectors", () => {
    const x = fixture();
    each(x, (p) => {
      const b = p.queries.contributions[0]!.request.body as Record<
        string,
        unknown
      >;
      delete b.filerRegistrationGuid;
    });
    held(x, /query account/);
    const y = fixture();
    each(y, (p) => {
      (
        p.queries.contributions[0]!.request.body as Record<string, unknown>
      ).sourceName = "Example PAC";
    });
    held(y, /narrowing/);
  });
  it("rejects a narrowing inventory owner-name selector despite a matching GUID", () => {
    const x = fixture();
    each(x, (p) => {
      (
        p.queries.reports[0]!.request.body as Record<string, unknown>
      ).filerName = "OTHER, CANDIDATE";
    });
    held(x, /Conflicting query filer name/);
  });
  it("requires matching actual native date/type election lookup", () => {
    const x = fixture();
    x.context.sourceElection.name = "2026 Primary and General";
    held(x, /exact date\/type/);
    const y = fixture();
    y.context.sourceElection.electionId = 46;
    held(y, /Conflicting local/);
  });
  it("requires full declared physical count", () => {
    const x = fixture();
    each(x, (p) => {
      p.queries.contributions[0]!.response.totalItems = 3;
    });
    held(x, /census/);
  });
  it("accepts genuinely complete multi-page cash census and refuses a missing page", () => {
    const x = fixture();
    each(x, (p) => {
      const first = p.queries.contributions[0]!;
      const second = structuredClone(first);
      (first.request.body as Record<string, unknown>).pageSize = 1;
      (second.request.body as Record<string, unknown>).pageSize = 1;
      (second.request.body as Record<string, unknown>).pageNumber = 2;
      first.response.items = [first.response.items[0]!];
      second.response.items = [second.response.items[1]!];
      p.queries.contributions = [first, second];
    });
    expect(qualifyVermontCommitteeCash(x).status).toBe("qualified");
    x.after.queries.contributions = x.after.queries.contributions.slice(0, 1);
    held(x, /census/);
  });
  it("refuses unresolved report siblings and duplicate-period editions", () => {
    const x = fixture();
    each(x, (p) => {
      inventory(p)[0]!.hasChild = true;
    });
    held(x, /edition/);
    const y = fixture();
    each(y, (p) => {
      inventory(p).push({
        ...inventory(p)[0],
        filerReportGuid: "other-report",
      });
      p.queries.reports[0]!.response.totalItems = 2;
      const pdf = structuredClone(p.reports[0]!);
      pdf.request.body.filerReportGuid = "other-report";
      p.reports = [...p.reports, pdf];
    });
    held(y, /Overlapping/);
  });
  it("refuses contradictory published entity field aliases instead of picking one", () => {
    const x = fixture();
    each(x, (p) => {
      receipts(p)[0]!.entityID = 92;
    });
    held(x, /Conflicting published entity fields/);
  });
  it("requires every cash-bound PDF and exact returned raw hash binding", () => {
    const x = fixture();
    x.after.reports = [];
    held(x, /Missing/);
    const y = fixture();
    y.after.reports[0]!.facts.pdfSha256 = "b".repeat(64);
    held(y, /PDF binding/);
  });
  it("does not accept changed PDF cash controls even when both cash amounts match", () => {
    const x = fixture();
    x.after.reports[0]!.facts.originalFiledDate = "2026-09-30";
    held(x, /Changed report\/PDF/);
  });
  it("rejects future/missing previous accepted coverage and overlapping observation phases", () => {
    const x = fixture();
    x.priorReportPeriods = [
      { periodStart: "2024-01-01", periodEnd: "2024-12-31" },
    ];
    held(x, /disappeared/);
    const y = fixture();
    y.after.reports[0]!.capture.startedAt = "2026-10-10T00:00:00Z";
    y.after.reports[0]!.capture.completedAt = "2026-10-10T00:00:01Z";
    held(y, /independently ordered/);
  });
  it("holds future report coverage before a dry run can call it qualified", () => {
    const x = fixture();
    each(x, (p) => {
      inventory(p)[0]!.endDate = "2026-10-20T00:00:00";
      p.reports[0]!.facts.periodEnd = "2026-10-20";
    });
    held(x, /report period.*observation/i);
  });
  it("accepts coverage ending on the closing observation date", () => {
    const x = fixture();
    each(x, (p) => {
      inventory(p)[0]!.endDate = "2026-10-12T00:00:00";
      p.reports[0]!.facts.periodEnd = "2026-10-12";
    });
    expect(qualifyVermontCommitteeCash(x).status).toBe("qualified");
  });
  it.each(["8.005", "90071992547409.92"])(
    "rejects unsafe exact source cents %s",
    (amount) => {
      const x = fixture();
      each(x, (p) => {
        receipts(p)[0]!.transactionAmount = amount;
      });
      held(x);
    },
  );
  it("does not infer an omitted receipt from matching unrelated financial controls", () => {
    const x = fixture();
    each(x, (p) => {
      receipts(p).pop();
      p.queries.contributions[0]!.response.totalItems = 1;
    });
    held(x, /cash\/report/);
  });
});

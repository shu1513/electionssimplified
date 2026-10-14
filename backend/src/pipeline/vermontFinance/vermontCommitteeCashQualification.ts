import { createHash } from "node:crypto";
import { mapVermontOfficeSought } from "./vermontFinanceEligibleOffices.js";
import { resolveVermontElectionLookup } from "./vermontCampaignFinanceClient.js";
import type { VermontCommitteeCashContext } from "./vermontCommitteeCashContext.js";
import type { readVermontReportControlPdf } from "./vermontReportControlPdfParser.js";

export type VermontCommitteeCashCapture = {
  startedAt: string;
  completedAt: string;
  httpStatus: number;
  sha256: string;
  byteCount: number;
};
export type VermontCommitteeCashQueryPage = {
  request: { endpoint: string; body: Readonly<Record<string, unknown>> };
  response: {
    items: readonly Readonly<Record<string, unknown>>[];
    totalItems: number;
  };
  capture: VermontCommitteeCashCapture;
};
export type VermontCommitteeCashPdfObservation = {
  request: {
    endpoint: string;
    body: { filerReportGuid: string; fileName: string; openInNewTab: true };
  };
  capture: VermontCommitteeCashCapture;
  facts: Awaited<ReturnType<typeof readVermontReportControlPdf>>;
};
export type VermontCommitteeCashPhase = {
  queries: {
    reports: readonly VermontCommitteeCashQueryPage[];
    contributions: readonly VermontCommitteeCashQueryPage[];
    expenditures: readonly VermontCommitteeCashQueryPage[];
  };
  reports: readonly VermontCommitteeCashPdfObservation[];
};
export type VermontCommitteeCashQualificationInput = {
  context: VermontCommitteeCashContext;
  before: VermontCommitteeCashPhase;
  after: VermontCommitteeCashPhase;
  priorReportPeriods?: readonly { periodStart: string; periodEnd: string }[];
};
export type VermontCommitteeCashPosition = {
  committeeId: string;
  committeeName: string;
  committeeType: "Political Action Committee";
  amountCents: number;
  contributionCount: number;
  giftTransactions: {
    transactionId: number;
    transactionVersionId: number;
    guid: string;
    reportGuid: string;
    date: string;
    amountCents: number;
  }[];
  sourceUrl: string;
};

const ENDPOINTS = {
  reports: "PublicFilerDetails/GetPublicFilerProfileFiling",
  contributions: "PublicTransactionDetails/GetContributionsDetails",
  expenditures: "PublicTransactionDetails/GetExpenditureDetails",
  pdf: "PublicFiledReportAndDownload/DownloadDocument",
};
const METHOD = "vt-explicit-tpac-cash-2026.1";
const norm = (s: string) =>
  s.normalize("NFKC").toUpperCase().replace(/\s+/gu, " ").trim();
function hold(reason: string): never {
  throw new Error(reason);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) hold(`Missing ${label}`);
  return value.trim();
}
function integer(value: unknown, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    hold(`Invalid ${label}`);
  return value as number;
}
function money(value: unknown): number {
  const token =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(token);
  if (!match) hold("Invalid source monetary value");
  const amount =
    (BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"))) *
    (match[1] ? -1n : 1n);
  if (
    amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    amount < -BigInt(Number.MAX_SAFE_INTEGER)
  )
    hold("Unsafe source cents");
  return Number(amount);
}
function add(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n)) hold("Unsafe monetary sum");
  return n;
}
function civil(value: unknown): string {
  const literal = text(value, "source date");
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(literal);
  const raw = us ? `${us[3]}-${us[1]}-${us[2]}` : literal;
  if (!/^\d{4}-\d{2}-\d{2}(?:T00:00:00)?$/.test(raw))
    hold("Unsupported source civil date");
  const day = raw.slice(0, 10),
    time = Date.parse(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== day
  )
    hold("Invalid source civil date");
  return day;
}
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return hold("Unsupported full source field");
}
const multiset = (rows: readonly unknown[]) =>
  JSON.stringify(rows.map(canonical).sort());
function capture(value: VermontCommitteeCashCapture): void {
  if (
    value.httpStatus !== 200 ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.byteCount) ||
    value.byteCount <= 0 ||
    value.byteCount > 20 * 1024 * 1024 ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    Date.parse(value.startedAt) > Date.parse(value.completedAt)
  )
    hold("Invalid original capture metadata");
}
function queryRows(
  phase: VermontCommitteeCashPhase,
  kind: keyof VermontCommitteeCashPhase["queries"],
  context: VermontCommitteeCashContext,
): readonly Readonly<Record<string, unknown>>[] {
  const pages = phase.queries[kind];
  if (!pages?.length) hold("Missing complete source query");
  const rows: Readonly<Record<string, unknown>>[] = [];
  let declared: number | undefined, size: number | undefined;
  for (const [index, page] of pages.entries()) {
    capture(page.capture);
    const body = page.request.body;
    if (
      page.request.endpoint !== ENDPOINTS[kind] ||
      body.filerRegistrationGuid !== context.filerRegistrationGuid ||
      body.pageNumber !== index + 1
    )
      hold("Wrong source query account/route/page");
    const pageSize = integer(body.pageSize, "requested page size");
    if (pageSize > 1000 || (size !== undefined && size !== pageSize))
      hold("Changed requested page size");
    size = pageSize;
    const allowed = new Set([
      "filerRegistrationGuid",
      "filerName",
      "pageNumber",
      "pageSize",
      "sortBy",
      "sortType",
      ...(kind === "reports"
        ? []
        : ["electionID", "electionYear", "transactionTypeCode"]),
    ]);
    if (
      Object.entries(body).some(
        ([key, value]) => !allowed.has(key) && value !== null && value !== "",
      )
    )
      hold("Unexpected source narrowing selector");
    if (
      body.filerName !== undefined &&
      norm(text(body.filerName, "query filer name")) !==
        norm(context.receivingFilerName)
    )
      hold("Conflicting query filer name");
    if (kind !== "reports") {
      if (
        body.electionID !== context.sourceElectionId ||
        body.transactionTypeCode !==
          (kind === "contributions" ? "TCON" : "TEXP") ||
        body.sortBy !== "TransactionDate" ||
        body.sortType !== "desc" ||
        (body.electionYear !== undefined &&
          body.electionYear !== context.electionYear)
      )
        hold("Wrong actual election/role/query context");
    } else if (body.sortBy !== "" || body.sortType !== "")
      hold("Unsupported report inventory sort");
    const total = integer(page.response.totalItems, "declared source count", 0);
    if (declared !== undefined && declared !== total)
      hold("Changed declared source count");
    declared = total;
    if (
      !Array.isArray(page.response.items) ||
      page.response.items.length > pageSize ||
      (index < pages.length - 1 && page.response.items.length !== pageSize)
    )
      hold("Incomplete physical source page");
    for (const row of page.response.items) {
      canonical(row);
      rows.push(row);
    }
  }
  if (
    rows.length !== declared ||
    (pages.length > 1 && pages.at(-1)!.response.items.length === 0)
  )
    hold("Incomplete declared source census");
  return rows;
}
function owned(
  row: Readonly<Record<string, unknown>>,
  context: VermontCommitteeCashContext,
): boolean {
  const guid = text(row.filerRegistrationGuid, "source filer GUID");
  const entity = integer(row.entityId ?? row.entityID, "source entity ID");
  if (
    row.entityId !== undefined &&
    row.entityID !== undefined &&
    integer(row.entityId, "source entity ID") !==
      integer(row.entityID, "source entity ID")
  )
    hold("Conflicting published entity fields");
  if (
    (guid === context.filerRegistrationGuid) !==
    (entity === context.entityId)
  )
    hold("Conflicting partial receiving identity");
  if (guid !== context.filerRegistrationGuid) return false;
  if (
    norm(text(row.filerName, "source filer name")) !==
      norm(context.receivingFilerName) ||
    row.officeID !== context.officeId ||
    row.electionId !== context.sourceElectionId ||
    row.filerTypeCode !== "CAN"
  )
    hold("Conflicting exact receiving identity");
  return true;
}

type BoundReport = {
  row: Readonly<Record<string, unknown>>;
  pdf: VermontCommitteeCashPdfObservation;
  guid: string;
  version: number;
  start: string;
  end: string;
};
function phaseFacts(
  phase: VermontCommitteeCashPhase,
  context: VermontCommitteeCashContext,
) {
  const inventory = queryRows(phase, "reports", context),
    receipts = queryRows(phase, "contributions", context),
    expenses = queryRows(phase, "expenditures", context);
  const regular = inventory.filter(
    (row) => row.reportType === "Campaign Finance Disclosure Report",
  );
  if (
    !regular.length ||
    inventory.some(
      (row) =>
        row.reportType !== "Campaign Finance Disclosure Report" &&
        row.reportType !== "Mass Media Activity Report",
    )
  )
    hold("Missing or unsupported public report inventory");
  const bound: BoundReport[] = [];
  const seen = new Set<string>();
  for (const row of regular) {
    const guid = text(row.filerReportGuid, "regular report GUID"),
      version = integer(row.filerReportVersionID, "report version ID");
    if (seen.has(guid) || row.hasChild !== false || row.isPaperFile !== false)
      hold("Ambiguous regular report edition");
    seen.add(guid);
    text(row.reportStatus, "literal report status");
    text(row.reportVersion, "literal report version");
    text(row.filedDate, "literal filed date");
    text(row.filerFilingCalendarGuid, "filing calendar GUID");
    const start = civil(row.startDate),
      end = civil(row.endDate);
    if (start > end) hold("Reversed report period");
    const pdfs = phase.reports.filter(
      (pdf) => pdf.request.body.filerReportGuid === guid,
    );
    if (pdfs.length !== 1) hold("Missing or duplicate report PDF");
    const pdf = pdfs[0]!;
    capture(pdf.capture);
    if (
      pdf.request.endpoint !== ENDPOINTS.pdf ||
      pdf.request.body.fileName !==
        `${text(row.reportName, "report name")} V${version}` ||
      pdf.request.body.openInNewTab !== true ||
      pdf.capture.sha256 !== pdf.facts.pdfSha256 ||
      pdf.capture.byteCount !== pdf.facts.byteCount ||
      !Number.isSafeInteger(pdf.facts.pageCount) ||
      pdf.facts.pageCount < 3
    )
      hold("Wrong exact report/PDF binding");
    const f = pdf.facts,
      c = f.controls;
    if (
      norm(f.receivingFilerName) !== norm(context.receivingFilerName) ||
      norm(f.candidateFullName) !== norm(context.candidateName) ||
      norm(f.officeName) !== norm(context.officeName) ||
      norm(f.electionLabel) !== norm(context.sourceElection.name) ||
      f.reportName !== row.reportName ||
      f.periodStart !== start ||
      f.periodEnd !== end ||
      f.dueDate !== civil(row.dueDate)
    )
      hold("PDF owner/election/period context mismatch");
    if (
      [
        c.cashOver100Cents,
        c.cash100OrLessCents,
        c.totalMonetaryContributionsCents,
        f.summary.monetaryContributionsPeriodCents,
        f.summary.monetaryContributionsCycleCents,
      ].some((n) => !Number.isSafeInteger(n))
    )
      hold("Unsafe report cash control");
    if (
      [
        c.loansReceivedCents,
        c.refundedContributionsCents,
        c.inKindContributionsCents,
        c.refundedInKindContributionsCents,
        c.totalInKindContributionsCents,
        c.loanPaymentsCents,
        c.loanReceivedSummaryCents,
        c.loanPaymentsSummaryCents,
        c.loanForgivenCents,
      ].some((n) => n !== 0)
    )
      hold("Unresolved loan/return/in-kind cash scope");
    if (
      add(c.cashOver100Cents, c.cash100OrLessCents) !==
        c.totalMonetaryContributionsCents ||
      c.totalMonetaryContributionsCents !==
        f.summary.monetaryContributionsPeriodCents
    )
      hold("Unreconciled monetary cash controls");
    bound.push({ row, pdf, guid, version, start, end });
  }
  if (phase.reports.length !== bound.length)
    hold("Unqualified additional PDF observation");
  bound.sort(
    (a, b) => a.start.localeCompare(b.start) || a.guid.localeCompare(b.guid),
  );
  for (let i = 1; i < bound.length; i++) {
    const prior = bound[i - 1]!,
      current = bound[i]!;
    const next = new Date(Date.parse(`${prior.end}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    if (current.start !== next)
      hold("Overlapping or uncovered regular report periods");
  }
  const byGuid = new Map(bound.map((report) => [report.guid, report]));
  const totals = new Map<string, number>();
  const own: Readonly<Record<string, unknown>>[] = [];
  const ids = new Set<string>(),
    guids = new Set<string>();
  for (const row of receipts) {
    if (!owned(row, context)) continue;
    const id = integer(row.transactionID, "transaction ID"),
      version = integer(row.transactionVersionID, "transaction version ID"),
      guid = text(row.guid, "transaction GUID");
    if (ids.has(String(id)) || guids.has(guid))
      hold("Duplicate or ambiguous current cash occurrence");
    ids.add(String(id));
    guids.add(guid);
    if (
      row.transactionTypeCode !== "TCON" ||
      row.transactionSubTypeCode !== "ITMY" ||
      row.hasChild !== false ||
      (row.timedFiledReportGuid !== undefined &&
        row.timedFiledReportGuid !== null &&
        row.timedFiledReportGuid !== "")
    )
      hold("Unqualified receipt role/lineage");
    const report = byGuid.get(text(row.filerReportGuid, "cash report GUID"));
    if (!report) hold("Receipt lacks current regular report");
    const day = civil(row.transactionDate);
    if (day < report.start || day > report.end)
      hold("Cash occurrence outside source report period");
    const amount = money(row.transactionAmount);
    totals.set(report.guid, add(totals.get(report.guid) ?? 0, amount));
    own.push(row);
    void version;
  }
  for (const row of expenses) {
    if (!owned(row, context)) continue;
    if (row.transactionTypeCode !== "TEXP") hold("Unknown expenditure role");
    money(row.transactionAmount);
    // Ordinary/media editions need not be selected to scan the complete actual
    // recipient ledger. Any published return remains unknown until association.
    if (
      row.transactionCategoryCode === "PURC" ||
      row.expenditurePurpose === "PURC" ||
      /RETURNED CONTRIBUTION TO CONTRIBUTOR/.test(
        norm(String(row.expenditurePurpose ?? "")),
      )
    )
      hold("Unresolved published returned contribution");
  }
  let cash = 0;
  for (const report of bound) {
    if (
      (totals.get(report.guid) ?? 0) !==
      report.pdf.facts.controls.totalMonetaryContributionsCents
    )
      hold("Whole cash/report control mismatch");
    cash = add(cash, report.pdf.facts.controls.totalMonetaryContributionsCents);
    if (report.pdf.facts.summary.monetaryContributionsCycleCents !== cash)
      hold("Unreconciled published cycle cash control");
  }
  return { inventory, receipts, expenses, bound, own, cash };
}

export type VermontCommitteeCashQualificationResult =
  | { status: "held"; diagnostics: string[] }
  | {
      status: "qualified";
      positions: VermontCommitteeCashPosition[];
      periodStart: string;
      periodEnd: string;
      reportPeriods: {
        filerReportGuid: string;
        filerReportVersionId: number;
        periodStart: string;
        periodEnd: string;
        pdfSha256: string;
      }[];
      sourceElectionId: number;
      monetaryCashCents: number;
      unclassifiedCashCents: number;
      unclassifiedCashCount: number;
      captureDigest: string;
      diagnostics: string[];
    };

/** Pure evidence composition, not a latest-edition or whole-cycle assertion.
 * The producer supplies authentic original capture facts and parsed PDFs;
 * hashes provide integrity checks, not authentication of an arbitrary caller. */
export function qualifyVermontCommitteeCash(
  input: VermontCommitteeCashQualificationInput,
): VermontCommitteeCashQualificationResult {
  try {
    const context = input.context;
    if (
      context.sourceElectionId !== context.sourceElection.electionId ||
      context.electionYear !== Number(civil(context.electionDate).slice(0, 4))
    )
      hold("Conflicting local/source election context");
    resolveVermontElectionLookup([context.sourceElection], {
      electionDate: context.electionDate,
      electionType: context.electionType,
    });
    integer(context.entityId, "context entity");
    integer(context.officeId, "context office");
    const mappedOffice = mapVermontOfficeSought({ officeId: context.officeId });
    if (
      !mappedOffice ||
      norm(mappedOffice.officeName) !== norm(context.officeName)
    )
      hold("Conflicting mapped source office");
    text(context.filerRegistrationGuid, "context filer GUID");
    text(context.candidateName, "context candidate name");
    text(context.receivingFilerName, "context filer name");
    text(context.officeName, "context office");
    const captures = (phase: VermontCommitteeCashPhase) => [
      ...Object.values(phase.queries)
        .flat()
        .map((page) => page.capture),
      ...phase.reports.map((pdf) => pdf.capture),
    ];
    const beforeCaptures = captures(input.before),
      afterCaptures = captures(input.after);
    beforeCaptures.forEach(capture);
    afterCaptures.forEach(capture);
    if (
      !beforeCaptures.length ||
      !afterCaptures.length ||
      Math.max(...beforeCaptures.map((c) => Date.parse(c.completedAt))) >
        Math.min(...afterCaptures.map((c) => Date.parse(c.startedAt)))
    )
      hold("Financial capture phases not independently ordered");
    const before = phaseFacts(input.before, context),
      after = phaseFacts(input.after, context);
    const observedDay = new Date(
      Math.max(...afterCaptures.map((c) => Date.parse(c.completedAt))),
    )
      .toISOString()
      .slice(0, 10);
    if (after.bound.at(-1)!.end > observedDay)
      hold("Report period extends beyond the closing source observation");
    for (const key of ["inventory", "receipts", "expenses"] as const)
      if (multiset(before[key]) !== multiset(after[key]))
        hold("Changed full published financial source");
    for (const report of before.bound) {
      const closing = after.bound.find((r) => r.guid === report.guid);
      if (
        !closing ||
        canonical(report.row) !== canonical(closing.row) ||
        canonical(report.pdf.facts) !== canonical(closing.pdf.facts)
      )
        hold("Changed report/PDF financial publication");
    }
    for (const period of input.priorReportPeriods ?? [])
      if (
        !after.bound.some(
          (r) =>
            r.start === civil(period.periodStart) &&
            r.end === civil(period.periodEnd),
        )
      )
        hold("Prior accepted report period disappeared");
    const positions = new Map<string, VermontCommitteeCashPosition>();
    let unclassifiedCashCents = 0,
      unclassifiedCashCount = 0;
    const known = new Set([
      "TPAC",
      "TIEPAC",
      "TLLPAC",
      "TPP",
      "TCAN",
      "TSELF",
      "TIND",
      "TBSN",
      "TPQ",
    ]);
    for (const row of after.own) {
      const amount = money(row.transactionAmount),
        code =
          typeof row.transactionSourceTypeCode === "string"
            ? row.transactionSourceTypeCode.trim()
            : "";
      if (!known.has(code)) {
        unclassifiedCashCents = add(unclassifiedCashCents, amount);
        unclassifiedCashCount++;
      }
      if (code !== "TPAC") continue;
      const raw = text(row.sourceName, "literal PAC reported name"),
        key = norm(raw);
      const position = positions.get(key) ?? {
        committeeId: `reported:${key}`,
        committeeName: raw,
        committeeType: "Political Action Committee",
        amountCents: 0,
        contributionCount: 0,
        giftTransactions: [],
        sourceUrl: "https://campaignfinance.vermont.gov/",
      };
      position.amountCents = add(position.amountCents, amount);
      if (amount > 0) position.contributionCount++;
      position.giftTransactions.push({
        transactionId: integer(row.transactionID, "gift ID"),
        transactionVersionId: integer(row.transactionVersionID, "gift version"),
        guid: text(row.guid, "gift GUID"),
        reportGuid: text(row.filerReportGuid, "gift report GUID"),
        date: civil(row.transactionDate),
        amountCents: amount,
      });
      positions.set(key, position);
    }
    if (!positions.size && unclassifiedCashCount)
      hold(
        "No explicit PAC positions with unresolved source classes; no zero authority",
      );
    const periods = after.bound.map((r) => ({
      filerReportGuid: r.guid,
      filerReportVersionId: r.version,
      periodStart: r.start,
      periodEnd: r.end,
      pdfSha256: r.pdf.facts.pdfSha256,
    }));
    const captureDigest = createHash("sha256")
      .update(METHOD)
      .update(
        canonical({
          context: input.context,
          before: input.before,
          after: input.after,
          priorReportPeriods: input.priorReportPeriods ?? [],
        }),
      )
      .digest("hex");
    return {
      status: "qualified",
      positions: [...positions.values()].sort((a, b) =>
        a.committeeId.localeCompare(b.committeeId),
      ),
      periodStart: periods[0]!.periodStart,
      periodEnd: periods.at(-1)!.periodEnd,
      reportPeriods: periods,
      sourceElectionId: context.sourceElectionId,
      monetaryCashCents: after.cash,
      unclassifiedCashCents,
      unclassifiedCashCount,
      captureDigest,
      diagnostics: [
        "Explicit reported TPAC monetary positions within the complete observed regular-report cash ledger. Other source classes are not promoted; reported names do not establish legal registry identity. Coverage ends at the last published period; complete election-cycle activity and independently allocated outside spending remain unknown.",
      ],
    };
  } catch (error) {
    return {
      status: "held",
      diagnostics: [
        error instanceof Error
          ? error.message
          : "Unresolved Vermont published cash evidence",
      ],
    };
  }
}

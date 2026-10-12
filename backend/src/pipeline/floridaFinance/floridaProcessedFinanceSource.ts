import { createHash } from "node:crypto";
import type { FloridaContributionRow } from "./floridaCampaignFinanceRows.js";

export type FloridaProcessedRawEvidence = {
  bytesRaw: Uint8Array;
  sha256: string;
  url: string;
  method: "GET" | "POST";
  financeFields: Readonly<Record<string, string>> | null;
  status: number;
  contentType: string;
  startedAt: string;
  completedAt: string;
};
export type FloridaProcessedCandidateContext = {
  sourceAccount: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district: string | null;
  genericRecipientName: string;
};
export type FloridaProcessedSourcePacket = {
  ownership: FloridaProcessedRawEvidence;
  activity: FloridaProcessedRawEvidence;
  currentReports: readonly FloridaProcessedRawEvidence[];
  periodExports: readonly FloridaProcessedRawEvidence[];
  allDatesExport: FloridaProcessedRawEvidence;
  genericExport: FloridaProcessedRawEvidence;
};
export type FloridaNativeContribution = {
  reportYear: number;
  reportType: string;
  date: string;
  amountCents: number;
  contributorName: string;
  address: string;
  cityStateZip: string;
  occupation: string;
  transactionType: string;
  inKindDescription: string;
};
export type FloridaEfsCurrentReport = {
  account: string;
  candidateName: string;
  electionYear: number;
  sequence: number;
  reportYear: number;
  reportType: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  filedAt: string;
  reviewedAt: string;
  fileStatus: string;
  reviewStatus: string;
  completeness: string;
  queued: number;
  contributionCount: number;
  amended: boolean;
  waiver: boolean;
  fullMetadata: Readonly<Record<string, string | boolean>>;
};
export type FloridaNativeActivityPeriod = {
  nativeSequence: number | null;
  periodStart: string;
  periodEnd: string;
  monetaryCents: number;
  loanCents: number;
  inKindCents: number;
  waiver: boolean;
  sourceCoverCells: readonly string[];
};
export type FloridaProcessedReportProof = FloridaEfsCurrentReport & {
  nativeSequence: number | null;
  monetaryCents: number;
  loanCents: number;
  inKindCents: number;
  financialFingerprint: string;
};
export type FloridaProcessedFinanceProof = {
  version: 1;
  authority: "current_processed";
  context: FloridaProcessedCandidateContext;
  windowStart: string;
  windowEnd: string;
  rows: readonly FloridaContributionRow[];
  nativeRows: readonly FloridaNativeContribution[];
  reports: readonly FloridaProcessedReportProof[];
  financialFingerprint: string;
  sourceHashes: readonly string[];
  sourceMetadata: readonly (Omit<FloridaProcessedRawEvidence, "bytesRaw"> & {
    phase: "before" | "after";
    byteCount: number;
  })[];
};

const nativeHeaders = [
  "Rpt Yr",
  "Rpt Type",
  "Date",
  "Amount",
  "Contributor Name",
  "Address",
  "City State Zip",
  "Occupation",
  "Typ",
  "InKind Desc",
];
const genericHeaders = [
  "Candidate/Committee",
  "Date",
  "Amount",
  "Typ",
  "Contributor Name",
  "Address",
  "City State Zip",
  "Occupation",
  "Inkind Desc",
];
const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const display = (value: string): string => value.trim().replace(/\s+/g, " ");
function fail(message: string): never {
  throw new Error(`Florida processed source: ${message}`);
}
function integer(raw: string, label: string): number {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    fail(`invalid ${label}`);
  return Number(raw);
}
function account(raw: string): string {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    fail("invalid source account");
  return raw;
}
function date(raw: string): string {
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  const iso = slash
    ? `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`
    : raw;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(iso) ||
    new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso
  )
    fail("invalid civil date");
  return iso;
}
function amount(raw: string): number {
  const text = raw.trim();
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))
    fail("invalid exact cents");
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text
    .replace(/^-/, "")
    .replace(/,/g, "")
    .split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) fail("unsafe exact cents");
  return negative ? -result : result;
}
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next)) fail("unsafe summed cents");
    return next;
  }, 0);
}
function entity(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi,
    (token) => {
      const literal: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&nbsp;": " ",
      };
      return (
        literal[token.toLowerCase()] ??
        String.fromCodePoint(
          token.toLowerCase().startsWith("&#x")
            ? parseInt(token.slice(3, -1), 16)
            : Number(token.slice(2, -1)),
        )
      );
    },
  );
}
const text = (html: string): string =>
  display(entity(html.replace(/<[^>]*>/g, " ")));
function attrs(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  )) {
    const key = match[1].toLowerCase();
    if (key in result) fail("duplicate HTML attribute");
    result[key] = entity(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}
function inputFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    if (
      a.type?.toLowerCase() !== "hidden" ||
      !a.name ||
      a.name.startsWith("__")
    )
      continue;
    if (a.name in fields) fail("duplicate source hidden field");
    fields[a.name] = a.value ?? "";
  }
  return fields;
}
function requireHtml(html: string): void {
  if (!/<\/html\s*>/i.test(html) || !/<\/body\s*>/i.test(html))
    fail("incomplete HTML");
}
function tsv(raw: string, expected: readonly string[]): string[][] {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (!lines.length || lines[0].split("\t").join("\t") !== expected.join("\t"))
    fail("wrong TSV schema");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    if (
      cells.length !== expected.length ||
      cells.some((cell) => /[\x00\r\n]/.test(cell))
    )
      fail("partial TSV row");
    return cells;
  });
}
export function decodeFloridaNativeContributionTsv(
  raw: string,
): FloridaNativeContribution[] {
  return tsv(raw, nativeHeaders).map((cells) => {
    if (
      !cells[4].trim() ||
      !/^[A-Z0-9]+$/.test(cells[1]) ||
      !/^[A-Z]+$/.test(cells[8])
    )
      fail("missing native identity");
    return {
      reportYear: integer(cells[0], "report year"),
      reportType: cells[1],
      date: date(cells[2]),
      amountCents: amount(cells[3]),
      contributorName: cells[4],
      address: cells[5],
      cityStateZip: cells[6],
      occupation: cells[7],
      transactionType: cells[8],
      inKindDescription: cells[9],
    };
  });
}
function decodeGeneric(raw: string): FloridaContributionRow[] {
  return tsv(raw, genericHeaders).map((c) => {
    if (!c[0].trim() || !c[4].trim() || !/^[A-Z]+$/.test(c[3]))
      fail("missing generic identity");
    const cents = amount(c[2]);
    const absolute = Math.abs(cents);
    const canonicalAmount = `${cents < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
    return {
      recipientName: c[0],
      contributionDate: date(c[1]),
      amount: canonicalAmount,
      transactionType: c[3],
      contributorName: c[4],
      address: c[5],
      city: "",
      state: "",
      zip: "",
      cityStateZip: c[6],
      occupation: c[7],
      inKindDescription: c[8],
    };
  });
}
export function decodeFloridaEfsCurrentReport(
  html: string,
): FloridaEfsCurrentReport {
  requireHtml(html);
  const metadata: Record<string, string | boolean> = {};
  for (const m of html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)) {
    const id = attrs(m[1]).id;
    if (!id?.startsWith("lbl") || id === "lblPrintDate") continue;
    if (id in metadata) fail("duplicate EFS field");
    metadata[id] = text(m[2]);
  }
  for (const id of ["chkWaiver", "chkAmended"]) {
    const tags = (html.match(/<input\b[^>]*>/gi) ?? []).filter(
      (tag) => attrs(tag).id === id,
    );
    if (tags.length !== 1 || attrs(tags[0]).type !== "checkbox")
      fail("missing EFS checkbox");
    metadata[id] = /\bchecked(?:\s*=|\s|>)/i.test(tags[0]);
  }
  const get = (key: string): string => {
    const v = metadata[key];
    if (typeof v !== "string" || !v) fail(`missing EFS ${key}`);
    return v;
  };
  const report = /^Report: (\d{4}) - ([A-Z0-9]+) - (\d+)$/.exec(
    get("lblReportIdentifier"),
  );
  const election = /^(\d{4}) General Election$/.exec(get("lblElectionID"));
  const coverage = get("lblCoveragePeriod").split("-");
  if (!report || !election || coverage.length !== 2)
    fail("wrong EFS report identity");
  return {
    account: account(get("lblID")),
    candidateName: get("lblFullName"),
    electionYear: Number(election[1]),
    sequence: integer(report[3], "report sequence"),
    reportYear: Number(report[1]),
    reportType: report[2],
    periodStart: date(coverage[0]),
    periodEnd: date(coverage[1]),
    dueDate: date(get("lblReportDue")),
    filedAt: get("lblDateFiled"),
    reviewedAt: get("lblDateReviewed"),
    fileStatus: get("lblFileStatus"),
    reviewStatus: get("lblReviewStatus"),
    completeness: get("lblCompletenessStatus"),
    queued: integer(get("lblQueuedItems"), "queued"),
    contributionCount: integer(get("lblCntCon"), "contribution count"),
    amended: metadata.chkAmended === true,
    waiver: metadata.chkWaiver === true,
    fullMetadata: metadata,
  };
}
export function decodeFloridaProcessedCandidateOwnership(
  html: string,
): Readonly<Record<string, string>> {
  requireHtml(html);
  const fields = inputFields(html);
  for (const key of ["account", "candname", "elecdesc", "office", "CanCom"]) {
    if (!fields[key]) fail(`missing candidate ownership ${key}`);
  }
  account(fields.account);
  if (fields.CanCom !== "Cand") fail("noncandidate ownership page");
  return fields;
}

export function decodeFloridaNativeActivity(html: string): {
  fields: Record<string, string>;
  periods: FloridaNativeActivityPeriod[];
} {
  requireHtml(html);
  const fields = inputFields(html);
  const periods: FloridaNativeActivityPeriod[] = [];
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      text(c[1]),
    );
    const coverage =
      /^(\d{1,2}\/\d{1,2}\/\d{4}) - (\d{1,2}\/\d{1,2}\/\d{4})$/.exec(
        cells[1] ?? "",
      );
    if (!coverage) continue;
    if (cells.length !== 8 || /\bX\b/.test(cells[0]))
      fail("unreleased/invalid native cover");
    const inputs = [...m[1].matchAll(/<input\b[^>]*>/gi)]
      .map((i) => attrs(i[0]))
      .filter((i) => i.name === "seqnum");
    const waiver = /\bW\b/.test(cells[0]);
    if (inputs.length > 1 || (!inputs.length && !waiver))
      fail("missing native period selector");
    const period = {
      nativeSequence: inputs.length
        ? integer(inputs[0].value, "native sequence")
        : null,
      periodStart: date(coverage[1]),
      periodEnd: date(coverage[2]),
      monetaryCents: amount(cells[2]),
      loanCents: amount(cells[3]),
      inKindCents: amount(cells[4]),
      waiver,
      sourceCoverCells: cells,
    };
    if (
      period.periodStart > period.periodEnd ||
      [period.loanCents, period.inKindCents].some((v) => v < 0)
    )
      fail("invalid cover period/money");
    periods.push(period);
  }
  if (
    !periods.length ||
    new Set(periods.map((p) => `${p.periodStart}/${p.periodEnd}`)).size !==
      periods.length ||
    new Set(
      periods
        .filter((p) => p.nativeSequence !== null)
        .map((p) => p.nativeSequence),
    ).size !== periods.filter((p) => p.nativeSequence !== null).length
  )
    fail("missing/duplicate native periods");
  const sorted = [...periods].sort((a, b) =>
    a.periodStart.localeCompare(b.periodStart),
  );
  if (sorted.some((p, i) => i > 0 && p.periodStart <= sorted[i - 1].periodEnd))
    fail("overlapping native periods");
  return { fields, periods };
}
function identity(
  row: FloridaNativeContribution | FloridaContributionRow,
): unknown[] {
  return "date" in row
    ? [
        row.date,
        row.amountCents,
        row.contributorName,
        row.address,
        row.cityStateZip,
        row.occupation,
        row.transactionType,
        row.inKindDescription,
      ]
    : [
        row.contributionDate,
        amount(row.amount),
        row.contributorName,
        row.address,
        row.cityStateZip,
        row.occupation,
        row.transactionType,
        row.inKindDescription,
      ];
}
function multiset(rows: readonly unknown[]): string {
  return JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());
}
function evidence(
  raw: FloridaProcessedRawEvidence,
  path: string,
  method: "GET" | "POST",
): string {
  if (
    raw.status !== 200 ||
    raw.method !== method ||
    !/^[a-f0-9]{64}$/.test(raw.sha256) ||
    sha(raw.bytesRaw) !== raw.sha256 ||
    !raw.bytesRaw.length
  )
    fail("invalid raw envelope");
  const url = new URL(raw.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    `${url.hostname}${url.pathname}` !== path
  )
    fail("wrong official source endpoint");
  const start = Date.parse(raw.startedAt),
    end = Date.parse(raw.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    fail("invalid request capture interval");
  if (method === "POST" && url.search) fail("unexpected POST query");
  if (
    raw.financeFields &&
    Object.keys(raw.financeFields).some((key) =>
      /token|password|secret|cookie|authorization|viewstate|validation/i.test(
        key,
      ),
    )
  )
    fail("credential-bearing finance metadata");
  if (method === "GET" && raw.financeFields !== null)
    fail("invented GET finance fields");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
    raw.bytesRaw,
  );
  const expectedType =
    path.includes("TreFin.exe") || path.includes("contrib.exe")
      ? "tab-separated"
      : "html";
  if (!raw.contentType.toLowerCase().includes(expectedType))
    fail("wrong source content type");
  return decoded;
}
function packetRaws(
  packet: FloridaProcessedSourcePacket,
): FloridaProcessedRawEvidence[] {
  return [
    packet.ownership,
    packet.activity,
    ...packet.currentReports,
    ...packet.periodExports,
    packet.allDatesExport,
    packet.genericExport,
  ];
}
function verifyPacket(
  packet: FloridaProcessedSourcePacket,
  context: FloridaProcessedCandidateContext,
  windowStart: string,
  windowEnd: string,
) {
  const ownership = evidence(
    packet.ownership,
    "dos.elections.myflorida.com/candidates/CanDetail.asp",
    "GET",
  );
  if (
    new URL(packet.ownership.url).search !== `?account=${context.sourceAccount}`
  )
    fail("wrong ownership account request");
  requireHtml(ownership);
  const ownerFields = decodeFloridaProcessedCandidateOwnership(ownership);
  if (
    ownerFields.account !== context.sourceAccount ||
    ownerFields.elecdesc !== `${context.electionYear} General Election` ||
    display(ownerFields.office ?? "") !== context.officeName ||
    !display(ownerFields.candname ?? "").startsWith(
      `${context.candidateName} (`,
    ) ||
    ownerFields.CanCom !== "Cand"
  )
    fail("official ownership context mismatch");
  // The native page repeats this phrase in its document title before the
  // actual h2. Bind the district to the visible tracking heading, not title/CSS.
  const trackingHeading =
    /<h2\b[^>]*>\s*Candidate Tracking System\s*<\/h2>/i.exec(ownership);
  const headingBody = trackingHeading
    ? ownership.slice(trackingHeading.index + trackingHeading[0].length)
    : (ownership.split(/Candidate Tracking System/i)[1] ?? "");
  const heading = text(headingBody.split(/Address/i)[0]);
  const districts = [...heading.matchAll(/\bDistrict ([1-9]\d*)\b/g)].map(
    (m) => m[1],
  );
  if (
    context.district !== null
      ? districts.length !== 1 || districts[0] !== context.district
      : /\bDistrict\b/.test(heading)
  )
    fail("official ownership district mismatch");
  const activity = decodeFloridaNativeActivity(
    evidence(
      packet.activity,
      "dos.elections.myflorida.com/cgi-bin/TreSel.exe",
      "POST",
    ),
  );
  const activityFields = packet.activity.financeFields;
  if (
    !activityFields ||
    ["account", "candname", "elecdesc", "office", "CanCom"].some(
      (k) =>
        display(activityFields[k] ?? "") !== display(ownerFields[k] ?? "") ||
        display(activity.fields[k] ?? "") !== display(ownerFields[k] ?? ""),
    )
  )
    fail("native activity owner request mismatch");
  if (activityFields.generate !== "Campaign Finance Activity")
    fail("wrong activity action");
  const reports = packet.currentReports.map((raw) => {
    const decoded = decodeFloridaEfsCurrentReport(
      evidence(raw, "efs.dos.state.fl.us/PrintReportSubmitted.aspx", "GET"),
    );
    if (
      new URL(raw.url).search !==
        `?AcctNum=${context.sourceAccount}&SeqNum=${decoded.sequence}` ||
      decoded.account !== context.sourceAccount ||
      decoded.candidateName !== context.candidateName ||
      decoded.electionYear !== context.electionYear
    )
      fail("EFS ownership/request mismatch");
    if (
      decoded.periodStart > decoded.periodEnd ||
      decoded.fileStatus !== "Filed Report" ||
      decoded.reviewStatus !== "Reviewed" ||
      !(
        decoded.completeness === "Complete Detail Records" ||
        (decoded.waiver &&
          decoded.completeness === "No Detail Records Found" &&
          decoded.contributionCount === 0 &&
          ["lblCntExp", "lblCntXfr", "lblCntOth"].every(
            (k) => decoded.fullMetadata[k] === "0",
          ))
      ) ||
      decoded.queued !== 0
    )
      fail("current report not filed/reviewed/complete");
    return decoded;
  });
  if (
    reports.length !== activity.periods.length ||
    new Set(reports.map((r) => r.sequence)).size !== reports.length
  )
    fail("missing/duplicate current report status");
  const nativeExport = (raw: FloridaProcessedRawEvidence, sequence: number) => {
    const rows = decodeFloridaNativeContributionTsv(
      evidence(raw, "dos.elections.myflorida.com/cgi-bin/TreFin.exe", "POST"),
    );
    const f = raw.financeFields;
    if (
      !f ||
      f.account !== context.sourceAccount ||
      f.seqnum !== String(sequence) ||
      f.queryfor !== "1" ||
      f.queryorder !== "DAT" ||
      f.queryoutput !== "2" ||
      f.query !== "Submit Query Now"
    )
      fail("wrong native export request");
    return rows;
  };
  const unused = new Set(packet.periodExports);
  const allPeriodRows: FloridaNativeContribution[] = [];
  const reportProofs: FloridaProcessedReportProof[] = [];
  for (const p of activity.periods) {
    const matches = reports.filter(
      (r) => r.periodStart === p.periodStart && r.periodEnd === p.periodEnd,
    );
    if (matches.length !== 1) fail("ambiguous native/EFS coverage binding");
    const r = matches[0];
    let rows: FloridaNativeContribution[] = [];
    if (p.nativeSequence !== null) {
      const exports = packet.periodExports.filter(
        (e) => e.financeFields?.seqnum === String(p.nativeSequence),
      );
      if (exports.length !== 1) fail("missing/duplicate native period export");
      unused.delete(exports[0]);
      rows = nativeExport(exports[0], p.nativeSequence);
    } else if (!p.waiver || !r.waiver) fail("unproved omitted period");
    if (
      rows.length !== r.contributionCount ||
      rows.some(
        (row) =>
          row.reportYear !== r.reportYear || row.reportType !== r.reportType,
      )
    )
      fail("current count/report key mismatch");
    const monetary: number[] = [],
      loans: number[] = [],
      ink: number[] = [];
    for (const row of rows) {
      if (
        row.transactionType === "REF"
          ? row.amountCents >= 0
          : row.amountCents < 0
      )
        fail("invalid cash/refund sign");
      if (
        ["CHE", "CAS", "MO", "REF", "COF", "INT"].includes(row.transactionType)
      )
        monetary.push(row.amountCents);
      else if (row.transactionType === "LOA") loans.push(row.amountCents);
      else if (row.transactionType === "INK") ink.push(row.amountCents);
      else fail(`unknown current contribution type ${row.transactionType}`);
    }
    if (
      sum(monetary) !== p.monetaryCents ||
      sum(loans) !== p.loanCents ||
      sum(ink) !== p.inKindCents
    )
      fail("signed cover reconciliation mismatch");
    if (
      (r.waiver || p.waiver) &&
      (!r.waiver ||
        rows.length ||
        p.monetaryCents ||
        p.loanCents ||
        p.inKindCents)
    )
      fail("invalid waiver activity");
    allPeriodRows.push(...rows);
    reportProofs.push({
      ...r,
      nativeSequence: p.nativeSequence,
      monetaryCents: p.monetaryCents,
      loanCents: p.loanCents,
      inKindCents: p.inKindCents,
      financialFingerprint: sha(multiset(rows)),
    });
  }
  if (unused.size) fail("unbound extra native period export");
  const nativeRows = nativeExport(packet.allDatesExport, 0);
  if (multiset(nativeRows) !== multiset(allPeriodRows))
    fail("native whole/period multiset mismatch");
  const rows = decodeGeneric(
    evidence(
      packet.genericExport,
      "dos.elections.myflorida.com/cgi-bin/contrib.exe",
      "POST",
    ),
  );
  const g = packet.genericExport.financeFields;
  const genericElection = /^(\d{4})(\d{2})(\d{2})-GEN$/.exec(g?.election ?? "");
  if (
    !g ||
    !genericElection ||
    Number(genericElection[1]) !== context.electionYear ||
    g.search_on !== "2" ||
    g.CanNameSrch !== "2" ||
    g.queryformat !== "2" ||
    date(g.cdatefrom) !== windowStart ||
    date(g.cdateto) !== windowEnd ||
    integer(g.rowlimit, "row limit") <= rows.length
  )
    fail("wrong/capped generic scope");
  date(`${genericElection[1]}-${genericElection[2]}-${genericElection[3]}`);
  if (
    rows.some(
      (row) =>
        display(row.recipientName) !== display(context.genericRecipientName) ||
        row.contributionDate < windowStart ||
        row.contributionDate > windowEnd,
    )
  )
    fail("generic owner/window mismatch");
  const windowRows = nativeRows.filter(
    (r) => r.date >= windowStart && r.date <= windowEnd,
  );
  if (multiset(rows.map(identity)) !== multiset(windowRows.map(identity)))
    fail("generic/native full financial multiset mismatch");
  return {
    rows,
    nativeRows,
    reports: reportProofs,
    activity,
    ownerFields,
    financialFingerprint: sha(multiset(rows.map(identity))),
  };
}
export function verifyFloridaProcessedFinanceSource(input: {
  context: FloridaProcessedCandidateContext;
  windowStart: string;
  windowEnd: string;
  before: FloridaProcessedSourcePacket;
  after: FloridaProcessedSourcePacket;
}): { proof?: FloridaProcessedFinanceProof; diagnostics: string[] } {
  try {
    const context = input.context;
    account(context.sourceAccount);
    if (
      !context.candidateName.trim() ||
      !context.genericRecipientName.trim() ||
      !context.officeName.trim() ||
      !Number.isInteger(context.electionYear) ||
      context.electionYear < 1996 ||
      context.electionYear > 2100 ||
      (context.district !== null && !/^[1-9]\d*$/.test(context.district))
    )
      fail("invalid candidate context");
    const windowStart = date(input.windowStart),
      windowEnd = date(input.windowEnd);
    if (windowStart > windowEnd) fail("invalid window");
    const beforeRaws = packetRaws(input.before),
      afterRaws = packetRaws(input.after);
    if (
      Math.max(...beforeRaws.map((r) => Date.parse(r.completedAt))) >
      Math.min(...afterRaws.map((r) => Date.parse(r.startedAt)))
    )
      fail("opening/closing captures not independently bracketed");
    const before = verifyPacket(input.before, context, windowStart, windowEnd),
      after = verifyPacket(input.after, context, windowStart, windowEnd);
    const materialized = (p: ReturnType<typeof verifyPacket>) =>
      JSON.stringify({
        ownerFields: p.ownerFields,
        activity: p.activity,
        reports: [...p.reports].sort((a, b) => a.sequence - b.sequence),
        nativeRows: multiset(p.nativeRows),
        rows: multiset(p.rows),
      });
    if (
      input.before.ownership.sha256 !== input.after.ownership.sha256 ||
      materialized(before) !== materialized(after)
    )
      fail("current publication changed between captures");
    return {
      proof: {
        version: 1,
        authority: "current_processed",
        context: { ...context },
        windowStart,
        windowEnd,
        rows: before.rows,
        nativeRows: before.nativeRows,
        reports: before.reports,
        financialFingerprint: before.financialFingerprint,
        sourceHashes: [...beforeRaws, ...afterRaws].map((r) => r.sha256),
        sourceMetadata: (
          [
            { phase: "before", raws: beforeRaws },
            { phase: "after", raws: afterRaws },
          ] as const
        ).flatMap(({ phase, raws }) =>
          raws.map(({ bytesRaw, ...metadata }) => ({
            ...metadata,
            financeFields: metadata.financeFields && {
              ...metadata.financeFields,
            },
            phase,
            byteCount: bytesRaw.length,
          })),
        ),
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      diagnostics: [
        error instanceof Error
          ? error.message
          : "Florida processed source unavailable",
      ],
    };
  }
}

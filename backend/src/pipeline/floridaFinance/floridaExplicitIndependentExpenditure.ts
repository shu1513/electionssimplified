/**
 * Source decoding and explicit target matching only. A match does not prove a
 * complete/current financial snapshot or authorize a replacement/zero write.
 */
export const FLORIDA_NATIVE_EXPENDITURE_HEADERS = [
  "Rpt Yr",
  "Rpt Type",
  "Date",
  "Amount",
  "Expense Paid To",
  "Address",
  "City State Zip",
  "Purpose",
  "Typ Reimb",
] as const;

type NativeHeader = (typeof FLORIDA_NATIVE_EXPENDITURE_HEADERS)[number];
export type FloridaNativeExpenditure = {
  /** Zero-based source occurrence; identical rows remain separate occurrences. */
  occurrence: number;
  reportYear: number;
  reportType: string;
  date: string;
  amountCents: number;
  payeeName: string;
  address: string;
  cityStateZip: string;
  purpose: string;
  typeAndReimbursement: string;
  rawFields: Readonly<Record<NativeHeader, string>>;
};
export type FloridaExplicitIeTarget = {
  candidateName: string;
  supportOppose: "support";
  officeScope: "state_lower" | "county_school_board";
  officeName: "State Lower Chamber Legislator" | "School Board";
  district: string | null;
  county: string | null;
  grammar: "pro_house" | "support_school_board";
};
export type FloridaExplicitIeTargetResult =
  | { status: "parsed"; target: FloridaExplicitIeTarget }
  | { status: "unmatched"; reason: string };
export type FloridaEfsExpenditureElectionContext = {
  account: string;
  sequence: number;
  reportYear: number;
  reportType: string;
  electionYear: number;
  electionType: "general" | "special";
  electionDescription: string;
  periodStart: string;
  periodEnd: string;
  expenseCount: number;
  fileStatus: string;
  reviewStatus: string;
  completeness: string;
  queued: number;
  amended: boolean;
  waiver: boolean;
  fullMetadata: Readonly<Record<string, string | boolean>>;
};
/** Caller must independently corroborate these local/source target identities. */
export type FloridaVerifiedExplicitIeTarget = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionType: "general" | "primary" | "special";
  electionDescription: string;
  officeScope: string;
  officeName: string;
  district: string | null;
};
export type FloridaExplicitIeMatch =
  | {
      status: "matched";
      candidateId: string;
      electionId: string;
      target: FloridaExplicitIeTarget;
      amountCents: number;
      row: FloridaNativeExpenditure;
    }
  | { status: "unmatched"; reason: string };

function fail(message: string): never {
  throw new Error(`Florida explicit IE: ${message}`);
}
function display(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
function nameKey(value: string): string {
  // Case/spacing only: preserve all middle names, suffixes, accents and punctuation.
  return display(value).toUpperCase();
}
function integer(value: string, label: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    fail(`invalid ${label}`);
  }
  return Number(value);
}
function civilDate(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) fail("invalid civil date");
  const date = `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    fail("invalid civil date");
  }
  return date;
}
function cents(value: string): number {
  const raw = value.trim();
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(raw)) {
    fail("invalid exact cents");
  }
  const [whole, fraction] = raw.replace(/^-/, "").replace(/,/g, "").split(".");
  const result = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(result)) fail("unsafe exact cents");
  return raw.startsWith("-") ? -result : result;
}

export function decodeFloridaNativeExpenditureTsv(raw: string): FloridaNativeExpenditure[] {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (lines[0] !== FLORIDA_NATIVE_EXPENDITURE_HEADERS.join("\t")) {
    fail("wrong native expenditure TSV schema");
  }
  return lines.slice(1).map((line, occurrence) => {
    const cells = line.split("\t");
    if (cells.length !== FLORIDA_NATIVE_EXPENDITURE_HEADERS.length ||
        cells.some((cell) => /[\x00-\x08\x0b-\x1f\x7f]/.test(cell))) {
      fail("invalid native expenditure TSV width/characters");
    }
    if (!/^[A-Z][A-Z0-9]{0,15}$/.test(cells[1]) || !cells[4].trim() ||
        !/^[A-Z]+(?: [A-Z]+)?$/.test(cells[8])) {
      fail("missing native expenditure identity");
    }
    const reportYear = integer(cells[0], "report year");
    if (reportYear < 1900 || reportYear > 9999) fail("invalid report year");
    const rawFields = Object.fromEntries(FLORIDA_NATIVE_EXPENDITURE_HEADERS.map(
      (header, index) => [header, cells[index]],
    )) as Record<NativeHeader, string>;
    return {
      occurrence,
      reportYear,
      reportType: cells[1],
      date: civilDate(cells[2]),
      amountCents: cents(cells[3]),
      payeeName: cells[4],
      address: cells[5],
      cityStateZip: cells[6],
      purpose: cells[7],
      typeAndReimbursement: cells[8],
      rawFields,
    };
  });
}

function fullPerson(value: string): boolean {
  return /^[\p{L}][\p{L}.'’-]*(?: [\p{L}][\p{L}.'’-]*)+$/u.test(value) &&
    !/\b(?:AND|OR|WITH|VERSUS|VS|SUPPORT|OPPOSE|PRO)\b/.test(value.toUpperCase());
}
/** Only source-witnessed single-target grammar; no substring/fuzzy target inference. */
export function parseFloridaExplicitIndependentExpenditureTarget(
  row: FloridaNativeExpenditure,
): FloridaExplicitIeTargetResult {
  const reject = (reason: string): FloridaExplicitIeTargetResult => ({ status: "unmatched", reason });
  if (row.typeAndReimbursement !== "IEC") return reject("not_unqualified_candidate_ie");
  if (!Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) {
    return reject("not_positive_ie_occurrence");
  }
  return parseFloridaExplicitIePurpose(row.purpose);
}

/** Purpose-only discovery lead. Supplies no report identity, allocation or money authority. */
export function parseFloridaExplicitIePurpose(rawPurpose: string): FloridaExplicitIeTargetResult {
  const reject = (reason: string): FloridaExplicitIeTargetResult => ({ status: "unmatched", reason });
  const purpose = display(rawPurpose);
  const house = /^TEXT MESSAGES; PRO-(.+), HD-([1-9]\d{0,2})$/i.exec(purpose);
  if (house && fullPerson(house[1]) && Number(house[2]) <= 120) {
    return {
      status: "parsed",
      target: {
        candidateName: house[1], supportOppose: "support", officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator", district: String(Number(house[2])),
        county: null, grammar: "pro_house",
      },
    };
  }
  const school = /^(?:DIGITAL ADVERTISING TO SUPPORT|EMAIL MESSAGING IN SUPPORT OF) (.+) (OSCEOLA|DUVAL|ORANGE) COUNTY SCHOOL BOARD (?:DISTRICT ([1-9]\d?)|(AT-LARGE))$/i.exec(purpose);
  if (school && fullPerson(school[1])) {
    return {
      status: "parsed",
      target: {
        candidateName: school[1], supportOppose: "support", officeScope: "county_school_board",
        officeName: "School Board", district: school[3] ?? null, county: school[2].toUpperCase(),
        grammar: "support_school_board",
      },
    };
  }
  return reject("purpose_not_witnessed_unambiguous_single_target");
}

function entity(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (token) => {
    const literals: Record<string, string> = {
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ",
    };
    if (literals[token.toLowerCase()] !== undefined) return literals[token.toLowerCase()];
    const code = token.toLowerCase().startsWith("&#x")
      ? parseInt(token.slice(3, -1), 16) : Number(token.slice(2, -1));
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) fail("invalid HTML entity");
    return String.fromCodePoint(code);
  });
}
function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/(?:^|\s)([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const key = match[1].toLowerCase();
    if (key in result) fail("duplicate HTML attribute");
    result[key] = entity(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}
/** Decodes context/status, not expense completeness or amendment/supersession policy. */
export function decodeFloridaEfsExpenditureElectionContext(
  html: string,
): FloridaEfsExpenditureElectionContext {
  if (!/<\/body\s*>/i.test(html) || !/<\/html\s*>/i.test(html)) fail("incomplete EFS HTML");
  const metadata: Record<string, string | boolean> = {};
  for (const match of html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)) {
    const id = attributes(match[1]).id;
    if (!id?.startsWith("lbl") || id === "lblPrintDate") continue;
    if (id in metadata) fail("duplicate EFS field");
    metadata[id] = display(entity(match[2].replace(/<[^>]*>/g, " ")));
  }
  for (const id of ["chkAmended", "chkWaiver"]) {
    const tags = (html.match(/<input\b[^>]*>/gi) ?? []).filter((tag) => attributes(tag).id === id);
    if (tags.length !== 1 || attributes(tags[0]).type !== "checkbox") fail("missing EFS checkbox");
    metadata[id] = "checked" in attributes(tags[0]);
  }
  const get = (key: string): string => {
    const value = metadata[key];
    if (typeof value !== "string" || !value) fail(`missing EFS ${key}`);
    return value;
  };
  const report = /^Report: (\d{4}) - ([A-Z][A-Z0-9]{0,15}) - (\d+)$/.exec(get("lblReportIdentifier"));
  const electionDescription = get("lblElectionID");
  const general = /^(\d{4}) General Election$/.exec(electionDescription);
  // This full special-election label is witnessed; do not guess other special contexts.
  const special = /^(2026) Special Election - Senate 14 & House 87$/.exec(electionDescription);
  const election = general ?? special;
  const coverage = get("lblCoveragePeriod").split("-");
  if (!report || !election || coverage.length !== 2) fail("unsupported EFS election/report identity");
  const account = get("lblID");
  if (!/^[1-9]\d*$/.test(account) || !Number.isSafeInteger(Number(account))) fail("invalid EFS account");
  const periodStart = civilDate(coverage[0]);
  const periodEnd = civilDate(coverage[1]);
  if (periodStart > periodEnd) fail("reversed EFS coverage period");
  return {
    account, sequence: integer(report[3], "report sequence"), reportYear: Number(report[1]),
    reportType: report[2], electionYear: Number(election[1]),
    electionType: general ? "general" : "special", electionDescription, periodStart, periodEnd,
    expenseCount: integer(get("lblCntExp"), "expense count"), fileStatus: get("lblFileStatus"),
    reviewStatus: get("lblReviewStatus"), completeness: get("lblCompletenessStatus"),
    queued: integer(get("lblQueuedItems"), "queued"), amended: metadata.chkAmended === true,
    waiver: metadata.chkWaiver === true, fullMetadata: metadata,
  };
}

/** Positive classification only; source snapshot reconciliation belongs to the caller. */
export function matchFloridaExplicitIndependentExpenditure(input: {
  row: FloridaNativeExpenditure;
  reportContext: FloridaEfsExpenditureElectionContext;
  verifiedTarget: FloridaVerifiedExplicitIeTarget;
}): FloridaExplicitIeMatch {
  const reject = (reason: string): FloridaExplicitIeMatch => ({ status: "unmatched", reason });
  const { row, reportContext: context, verifiedTarget: target } = input;
  const parsed = parseFloridaExplicitIndependentExpenditureTarget(row);
  if (parsed.status !== "parsed") return parsed;
  if (row.reportYear !== context.reportYear || row.reportType !== context.reportType) {
    return reject("row_report_identity_mismatch");
  }
  if (context.fileStatus !== "Filed Report" || context.reviewStatus !== "Reviewed" ||
      context.completeness !== "Complete Detail Records" || context.queued !== 0 ||
      context.expenseCount <= 0 || context.waiver) {
    return reject("unusable_current_report_status");
  }
  if (context.electionType !== target.electionType || context.electionYear !== target.electionYear ||
      context.electionDescription !== target.electionDescription) {
    return reject("source_target_election_context_mismatch");
  }
  if (!target.candidateId || !target.electionId || !nameKey(target.candidateName)) {
    return reject("invalid_verified_target_identity");
  }
  if (parsed.target.officeScope !== "state_lower") return reject("noneligible_source_target_office");
  if (target.officeScope !== parsed.target.officeScope || target.officeName !== parsed.target.officeName ||
      target.district !== parsed.target.district) {
    return reject("source_target_office_or_seat_mismatch");
  }
  if (nameKey(target.candidateName) !== nameKey(parsed.target.candidateName)) {
    return reject("source_target_full_name_mismatch");
  }
  return {
    status: "matched", candidateId: target.candidateId, electionId: target.electionId,
    target: parsed.target, amountCents: row.amountCents, row,
  };
}
